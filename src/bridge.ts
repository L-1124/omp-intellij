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
  await writeFile(temp, JSON.stringify(params), 'utf8');
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

  const socket = await ensureServer();
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
            leaseHandle?.release().catch(() => {});
            leaseHandle = newLease;
          })
          .catch(() => {});
      }

      try {
        message.params = message.params || {};
        const paramsObj = message.params as Record<string, unknown>;
        paramsObj.initializationOptions = await applyWorkspaceOptions(
          projectPath,
          (paramsObj.initializationOptions as Record<string, unknown>) || {},
          { systemPath: settings.systemPath },
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('intellij: failed to apply workspace options:', msg);
      }

      if (uri) {
        await saveInitializeParams(message.params).catch(() => {});
      }

      initializeTimer = setTimeout(() => {
        close(new Error(`IntelliJ initialize handshake timed out after ${initializeTimeoutMs}ms`));
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
        })
        .catch(() => {});
    },
  });

  function close(error?: Error) {
    if (closing) return;
    closing = true;

    if (initializeTimer) {
      clearTimeout(initializeTimer);
      initializeTimer = null;
    }
    connState.close(connectionCloseState(error)).catch(() => {});

    if (leaseHandle) {
      leaseHandle.release().catch(() => {});
      leaseHandle = null;
    }

    if (error) {
      console.error('intellij-bridge: ' + error.message);
      process.exitCode = 1;
    }

    barrier.fail(error?.message ?? 'IntelliJ connection closed before queued requests completed');
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
  process.on('SIGTERM', () => close());
  process.on('SIGINT', () => close());

  process.stdin.pipe(upstream).pipe(socket);
  socket.pipe(downstream).pipe(process.stdout);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBridge().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
