#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  connectionCloseState,
  createConnectionState,
  type StateRecord,
} from './connection-state.js';
import { IndexBarrier } from './index-barrier.js';
import {
  canonicalizeProject,
  createLease,
  type LeaseHandle,
  recordConnection,
  recordReadiness,
} from './metadata.js';
import { asyncFramedStream, encode, frameParser } from './protocol.js';
import { type FailureDetail, sanitizeStatus, sanitizeString } from './runtime-status.js';
import { ensureServer, settings } from './service.js';
import { applyWorkspaceOptions } from './workspace.js';

export async function saveInitializeParams(params: unknown): Promise<void> {
  const p = params as {
    rootUri?: string;
    rootPath?: string;
    workspaceFolders?: Array<{ uri: string }>;
  } | null;
  const uri = p?.rootUri || p?.workspaceFolders?.[0]?.uri || p?.rootPath;
  if (!uri) return;
  const dir = join(settings.systemPath, 'plugin-metadata');
  await mkdir(dir, { recursive: true });
  const { id } = canonicalizeProject(uri);
  const target = join(dir, `initialize-${id}.json`);
  const temp = `${target}.${randomUUID()}.tmp`;
  const sanitized = sanitizeStatus(params);
  await writeFile(temp, JSON.stringify(sanitized), 'utf8');
  await rename(temp, target);
}

export async function startBridge(): Promise<void> {
  const initializeTimeoutMs = settings.initializeTimeoutMs ?? settings.initTimeoutMs ?? 30000;
  const requestWaitTimeoutMs =
    settings.requestWaitTimeoutMs ?? settings.indexWaitTimeoutMs ?? 300000;
  if (!Number.isFinite(initializeTimeoutMs) || initializeTimeoutMs <= 0) {
    throw new Error('initializeTimeoutMs must be positive');
  }
  if (!Number.isFinite(requestWaitTimeoutMs) || requestWaitTimeoutMs <= 0) {
    throw new Error('requestWaitTimeoutMs must be positive');
  }

  const connState = createConnectionState({
    systemPath: settings.systemPath,
    kind: 'bridge',
  });

  const socket = await ensureServer().catch(async (error: unknown) => {
    await connState.update({ root: process.cwd() });
    await connState.close(
      connectionCloseState(error instanceof Error ? error : new Error(String(error)), {
        stage: 'connect',
        systemPath: settings.systemPath,
      }),
    );
    throw error;
  });
  let closing = false;
  let barrier: IndexBarrier;
  let leaseHandle: LeaseHandle | null = null;
  let projectPath = process.cwd();
  let initializeTimer: NodeJS.Timeout | null = null;

  try {
    leaseHandle = await createLease(settings.systemPath, { kind: 'bridge', projectPath });
  } catch {}

  function framedStream(receive: (msg: Record<string, unknown>, frame: Buffer) => void) {
    const parse = frameParser((message, frame) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Error('Expected a JSON-RPC object');
      }
      receive(message as Record<string, unknown>, frame);
    });
    return new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
        try {
          parse(chunk);
          done();
        } catch (error: unknown) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
  }

  const upstream = asyncFramedStream(async (messageRaw: unknown, frame: Buffer) => {
    const message = messageRaw as Record<string, unknown> | null;
    if (message?.method === 'initialize') {
      const p = message.params as
        | { rootUri?: string; rootPath?: string; workspaceFolders?: Array<{ uri: string }> }
        | undefined;
      const uri = p?.rootUri || p?.workspaceFolders?.[0]?.uri || p?.rootPath;
      if (uri) {
        projectPath = uri;
        connState
          .update({ root: projectPath, phase: 'connecting', detail: 'Initializing connection' })
          .catch(() => {});
        recordConnection(settings.systemPath, projectPath, Date.now()).catch(() => {});
        createLease(settings.systemPath, { kind: 'bridge', projectPath })
          .then((newLease) => {
            if (closing) {
              void newLease.release().catch(() => {});
              return;
            }
            leaseHandle?.release().catch(() => {});
            leaseHandle = newLease;
          })
          .catch(() => {});
      }

      try {
        message.params = message.params || {};
        const paramsObj = message.params as Record<string, unknown>;
        const caps = (paramsObj.capabilities as Record<string, unknown>) || {};
        const exp = (caps.experimental as Record<string, unknown>) || {};
        exp.licensingUi = true;
        caps.experimental = exp;
        paramsObj.capabilities = caps;
        const initializationOptions =
          (paramsObj.initializationOptions as Record<string, unknown>) || {};
        delete initializationOptions.eulaHash;
        paramsObj.initializationOptions = await applyWorkspaceOptions(
          projectPath,
          initializationOptions,
          { systemPath: settings.systemPath },
        );
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? sanitizeString(err.message) : sanitizeString(String(err));
        console.error('intellij: failed to apply workspace options: ' + msg);
      }

      if (uri) {
        await saveInitializeParams(message.params).catch(() => {});
      }

      initializeTimer = setTimeout(() => {
        close(
          Object.assign(
            new Error(`IntelliJ initialize handshake timed out after ${initializeTimeoutMs}ms`),
            { code: 'ETIMEDOUT' },
          ),
          { kind: 'timeout', stage: 'initialize' },
        );
      }, initializeTimeoutMs);
      initializeTimer.unref();

      const newFrame = encode(message);
      barrier.fromClient(message, newFrame);
      return;
    }

    if (message) {
      barrier.fromClient(message, frame);
    }
  });

  const downstream = framedStream((message: Record<string, unknown>, frame: Buffer) => {
    if (
      initializeTimer &&
      message.id === barrier.initializeRequestId &&
      (message.result !== undefined || message.error !== undefined) &&
      !message.method
    ) {
      clearTimeout(initializeTimer);
      initializeTimer = null;
    }
    if (message.method === 'intellij/ready-for-test') {
      recordReadiness(settings.systemPath, projectPath, Date.now()).catch(() => {});
    }
    barrier.fromServer(message, frame);
  });

  barrier = new IndexBarrier({
    requestWaitTimeoutMs,
    sendServer: (frame: Buffer) => upstream.push(frame),
    sendClient: (frame: Buffer) => downstream.push(frame),
    onStateChange: (state: StateRecord) => {
      connState
        .update({
          phase: state.phase,
          detail: state.detail,
          progress: state.progress,
          rootUri: state.rootUri ?? undefined,
          failure: state.failure ?? null,
          license: state.license ?? { status: 'unknown' },
        })
        .catch(() => {});
    },
  });

  function close(
    error?: Error,
    closeOpts?: { kind?: FailureDetail['kind']; stage?: FailureDetail['stage'] },
  ) {
    if (closing) return;
    closing = true;

    if (initializeTimer) {
      clearTimeout(initializeTimer);
      initializeTimer = null;
    }
    connState
      .close(
        connectionCloseState(error, {
          kind: closeOpts?.kind,
          stage: closeOpts?.stage,
          systemPath: settings.systemPath,
        }),
      )
      .catch(() => {});

    if (leaseHandle) {
      leaseHandle.release().catch(() => {});
      leaseHandle = null;
    }

    if (error) {
      const safeMsg = sanitizeString(error.message);
      console.error('intellij-bridge: ' + safeMsg);
      process.exitCode = 1;
    }

    const failureDetail: FailureDetail | undefined = error
      ? {
          kind: closeOpts?.kind ?? 'connection',
          stage: closeOpts?.stage ?? 'connect',
          message: error.message,
          logPath: join(settings.systemPath, 'launcher.log'),
        }
      : undefined;

    barrier.fail(
      error?.message ?? 'IntelliJ connection closed before queued requests completed',
      failureDetail,
    );
    barrier.dispose();

    process.stdin.unpipe(upstream);
    process.stdin.pause();
    upstream.unpipe(socket);
    upstream.destroy();
    socket.unpipe(downstream);
    socket.destroy();
    downstream.end();
  }

  socket.on('error', (err: Error) => close(err));
  socket.on('end', () => close());
  upstream.on('error', (err: Error) => close(err));
  downstream.on('error', (err: Error) => close(err));
  process.stdin.on('error', (err: Error) => close(err));
  process.stdout.on('error', (err: Error) => close(err));
  process.stdin.on('end', () => close());
  process.on('SIGTERM', () => close(undefined, { kind: 'cancelled', stage: 'connect' }));
  process.on('SIGINT', () => close(undefined, { kind: 'cancelled', stage: 'connect' }));

  process.stdin.pipe(upstream).pipe(socket);
  socket.pipe(downstream).pipe(process.stdout);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBridge().catch((error: unknown) => {
    const safeMsg =
      error instanceof Error ? sanitizeString(error.message) : sanitizeString(String(error));
    console.error(safeMsg);
    process.exit(1);
  });
}
