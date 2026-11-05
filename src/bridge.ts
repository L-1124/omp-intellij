#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import type net from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AndroidNavigation } from './android/navigation.js';
import {
  loadDefaultPluginSettings,
  loadProjectConfiguration,
  recordConfigurationItems,
  saveProjectConfiguration,
  updateProjectSettings,
} from './project/configuration.js';
import {
  connectionCloseState,
  createConnectionState,
  type StateRecord,
} from './project/connection-state.js';
import { IndexBarrier } from './project/index-barrier.js';
import {
  canonicalizeProject,
  type LeaseHandle,
  recordConnection,
  recordReadiness,
  replaceLease,
} from './project/metadata.js';
import { applyWorkspaceOptions } from './project/workspace.js';
import { connectWithLease, settings } from './server/service.js';
import { NavigationRelay } from './shared/navigation-relay.js';
import { asyncFramedStream, encode } from './shared/protocol.js';
import { type FailureDetail, sanitizeStatus, sanitizeString } from './shared/runtime-status.js';

export async function saveInitializeParams(
  params: unknown,
  options?: { rawInitializationOptions?: Record<string, unknown> },
): Promise<void> {
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
  const sanitized = sanitizeStatus(params) as Record<string, unknown>;
  if (options?.rawInitializationOptions) {
    sanitized.rawInitializationOptions = sanitizeStatus(options.rawInitializationOptions);
  }
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

  let closing = false;
  let barrier: IndexBarrier;
  let leaseHandle: LeaseHandle | null = null;
  let projectPath = process.cwd();
  let initializeTimer: NodeJS.Timeout | null = null;

  const pendingConfigRequests = new Map<unknown, Array<{ scopeUri?: string; section?: string }>>();
  const navigationRelay = new NavigationRelay({
    sendServer: (message, frame) => barrier.fromClient(message, frame),
    sendClient: (frame) => downstream.push(frame),
    resolve: (input) =>
      navigation.resolve({
        ...input,
        projectRoot: canonicalizeProject(projectPath).nativePath,
      }),
    invalidate: () => navigation.invalidate(),
    timeoutMs: requestWaitTimeoutMs,
  });
  const navigation = new AndroidNavigation(
    navigationRelay.request,
    navigationRelay.readDocument,
    navigationRelay.documentPaths,
  );

  let socket: net.Socket;
  try {
    const session = await connectWithLease({
      systemPath: settings.systemPath,
      kind: 'bridge',
      projectPath,
    });
    socket = session.socket;
    leaseHandle = session.lease;
  } catch (error: unknown) {
    await connState.update({ root: process.cwd() });
    await connState.close(
      connectionCloseState(error instanceof Error ? error : new Error(String(error)), {
        stage: 'connect',
        systemPath: settings.systemPath,
      }),
    );
    throw error;
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
        replaceLease(settings.systemPath, leaseHandle, { kind: 'bridge', projectPath })
          .then((newLease) => {
            if (closing) {
              void newLease.release().catch(() => {});
              return;
            }
            leaseHandle = newLease;
          })
          .catch(() => {});
      }

      let rawInitializationOptions: Record<string, unknown> | undefined;
      try {
        message.params = message.params || {};
        const paramsObj = message.params as Record<string, unknown>;
        const caps = (paramsObj.capabilities as Record<string, unknown>) || {};
        const exp = (caps.experimental as Record<string, unknown>) || {};
        exp.licensingUi = true;
        caps.experimental = exp;

        // Enable workDoneProgress so server-initiated progress is emitted.
        const windowCaps = (caps.window as Record<string, unknown>) || {};
        windowCaps.workDoneProgress = true;
        caps.window = windowCaps;

        paramsObj.capabilities = caps;

        const initializationOptions =
          (paramsObj.initializationOptions as Record<string, unknown>) || {};
        delete initializationOptions.eulaHash;

        // Opt in to intellijExtensions and lazyIntentions so ModCommand quickfixes
        // are converted to executable LSP commands rather than dropped to null.
        if (initializationOptions.intellijExtensions === undefined) {
          initializationOptions.intellijExtensions = true;
        }
        if (initializationOptions.lazyIntentions === undefined) {
          initializationOptions.lazyIntentions = true;
        }
        rawInitializationOptions = JSON.parse(JSON.stringify(initializationOptions));
        paramsObj.initializationOptions = await applyWorkspaceOptions(
          projectPath,
          initializationOptions,
          { systemPath: settings.systemPath },
        );
      } catch (err: unknown) {
        close(err instanceof Error ? err : new Error(String(err)), {
          kind: 'import',
          stage: 'initialize',
        });
        return;
      }

      if (uri) {
        const { id, nativePath, rootUri: canonicalRootUri } = canonicalizeProject(uri);
        try {
          const existingConfig = await loadProjectConfiguration(settings.systemPath, id);
          if (!existingConfig) {
            const defaults = await loadDefaultPluginSettings();
            const params = message.params;
            let hostSettings: Record<string, unknown> | undefined;
            if (
              params &&
              typeof params === 'object' &&
              'settings' in params &&
              params.settings &&
              typeof params.settings === 'object'
            ) {
              hostSettings = params.settings as Record<string, unknown>;
            } else if (
              rawInitializationOptions &&
              'settings' in rawInitializationOptions &&
              rawInitializationOptions.settings &&
              typeof rawInitializationOptions.settings === 'object'
            ) {
              hostSettings = rawInitializationOptions.settings as Record<string, unknown>;
            }
            const merged = hostSettings ? { ...defaults, ...hostSettings } : defaults;
            await saveProjectConfiguration(settings.systemPath, {
              id,
              projectPath: nativePath,
              rootUri: canonicalRootUri,
              updatedAt: Date.now(),
              settings: merged,
              rawInitializationOptions,
            });
          } else {
            existingConfig.projectPath = nativePath;
            existingConfig.rootUri = canonicalRootUri;
            existingConfig.rawInitializationOptions = rawInitializationOptions;
            existingConfig.updatedAt = Date.now();
            await saveProjectConfiguration(settings.systemPath, existingConfig);
          }
          await saveInitializeParams(message.params, { rawInitializationOptions });
        } catch (err: unknown) {
          const safeMsg = sanitizeString(err instanceof Error ? err.message : String(err));
          console.error(`intellij: failed to persist initialize configuration: ${safeMsg}`);
          close(err instanceof Error ? err : new Error(String(err)), {
            kind: 'rpc',
            stage: 'initialize',
          });
          return;
        }
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

    if (message?.method === 'workspace/didChangeConfiguration') {
      const params = message.params;
      if (
        params &&
        typeof params === 'object' &&
        'settings' in params &&
        params.settings &&
        typeof params.settings === 'object'
      ) {
        const { id, nativePath, rootUri: canonicalRootUri } = canonicalizeProject(projectPath);
        try {
          await updateProjectSettings(
            settings.systemPath,
            id,
            params.settings as Record<string, unknown>,
            {
              projectPath: nativePath,
              rootUri: canonicalRootUri,
            },
          );
        } catch (err: unknown) {
          const safeMsg = sanitizeString(err instanceof Error ? err.message : String(err));
          console.error(`intellij-bridge: failed to save updated settings: ${safeMsg}`);
          throw err;
        }
      }
    } else if (
      message &&
      message.id !== undefined &&
      !message.method &&
      pendingConfigRequests.has(message.id)
    ) {
      const items = pendingConfigRequests.get(message.id);
      pendingConfigRequests.delete(message.id);
      if (items && Array.isArray(message.result)) {
        const { id } = canonicalizeProject(projectPath);
        await recordConfigurationItems(settings.systemPath, id, items, message.result);
      }
    }
    if (message) await navigationRelay.fromClient(message);

    if (message) {
      barrier.fromClient(message, frame);
    }
  });

  const downstream = asyncFramedStream(async (messageRaw: unknown, frame: Buffer) => {
    const message = messageRaw as Record<string, unknown> | null;
    if (!message) return;

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
    if (message.method === 'workspace/configuration' && message.id !== undefined) {
      const params = message.params;
      if (
        params &&
        typeof params === 'object' &&
        'items' in params &&
        Array.isArray(params.items)
      ) {
        pendingConfigRequests.set(message.id, params.items);
      }
    }
    barrier.fromServer(message, frame);
  });

  barrier = new IndexBarrier({
    requestWaitTimeoutMs,
    sendServer: (frame: Buffer) => upstream.push(frame),
    sendClient: (frame: Buffer) => navigationRelay.receive(frame),
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
    navigationRelay.close();

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
      console.error(`intellij-bridge: ${safeMsg}`);
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
