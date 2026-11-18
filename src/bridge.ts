#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import type net from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  migrateProjectMetadata,
  recordConnection,
  recordReadiness,
} from './project/metadata.js';
import { findBuildRoot } from './project/readiness.js';
import { applyWorkspaceOptions, workspaceImportOptions } from './project/workspace.js';
import { connectWithLease, settings } from './server/service.js';
import { DocumentSymbolAdapter } from './shared/document-symbols.js';
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

  let projectPath = findBuildRoot(process.cwd());
  const connState = createConnectionState({
    systemPath: settings.systemPath,
    kind: 'bridge',
    root: projectPath,
  });

  let closing = false;
  let barrier: IndexBarrier;
  let leaseHandle: LeaseHandle | null = null;
  let initializeTimer: NodeJS.Timeout | null = null;
  let pendingInitialize: { id: unknown } | null = null;
  let clientWorkDoneProgress = false;
  const ownedProgressTokens = new Set<unknown>();

  const pendingConfigRequests = new Map<unknown, Array<{ scopeUri?: string; section?: string }>>();
  const documentSymbols = new DocumentSymbolAdapter();

  // The request whose applyModCommand the server interrupted to ask for a variant choice.
  // Map from server request id to the choice title and its entries; the response is rewritten
  // once the server treats the fix as applied.
  const pendingChoices = new Map<
    unknown,
    { id: unknown; title: string; entries: Array<{ name: string; command: unknown }> }
  >();
  // The most recent applyModCommand whose answer may still be in flight, keyed by server id.
  let activeModCommandId: unknown = null;

  let socket: net.Socket | null = null;

  const upstream = asyncFramedStream(async (messageRaw: unknown, frame: Buffer) => {
    if (closing) return;
    const message = messageRaw as Record<string, unknown> | null;
    if (message) documentSymbols.fromClient(message);
    if (message?.method === 'exit') {
      close();
      return;
    }
    if (message?.method === 'initialize') {
      if (socket || pendingInitialize) {
        throw new Error('Bridge already received initialize');
      }
      pendingInitialize = { id: message.id };
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
      const p = message.params as
        | { rootUri?: string; rootPath?: string; workspaceFolders?: Array<{ uri: string }> }
        | undefined;
      let uri = p?.rootUri || p?.workspaceFolders?.[0]?.uri || p?.rootPath;
      if (p && uri) {
        const project = canonicalizeProject(findBuildRoot(uri));
        projectPath = project.nativePath;
        if (canonicalizeProject(uri).id !== project.id) {
          uri = project.rootUri;
          p.rootUri = project.rootUri;
          if (p.rootPath) p.rootPath = project.nativePath;
        }
        if (p.workspaceFolders) {
          p.workspaceFolders = [
            ...new Map(
              p.workspaceFolders.map((folder) => {
                const root = canonicalizeProject(findBuildRoot(folder.uri));
                return [
                  root.id,
                  canonicalizeProject(folder.uri).id === root.id
                    ? folder
                    : { ...folder, uri: root.rootUri },
                ] as const;
              }),
            ).values(),
          ];
        }
        await migrateProjectMetadata(settings.systemPath, project);
        connState
          .update({ root: projectPath, phase: 'connecting', detail: 'Initializing connection' })
          .catch(() => {});
        recordConnection(settings.systemPath, projectPath, Date.now()).catch(() => {});
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
        clientWorkDoneProgress = windowCaps.workDoneProgress === true;
        windowCaps.workDoneProgress = true;
        caps.window = windowCaps;

        paramsObj.capabilities = caps;

        const initializationOptions =
          (paramsObj.initializationOptions as Record<string, unknown>) || {};
        delete initializationOptions.eulaHash;

        rawInitializationOptions = JSON.parse(JSON.stringify(initializationOptions));
        paramsObj.initializationOptions = await applyWorkspaceOptions(
          projectPath,
          initializationOptions,
          { systemPath: settings.systemPath },
        );
        const workspace = caps.workspace as
          | { workspaceEdit?: { documentChanges?: unknown; resourceOperations?: unknown } }
          | undefined;
        const workspaceEdit = workspace?.workspaceEdit;
        (paramsObj.initializationOptions as Record<string, unknown>).ompAndroidCreateLintXml =
          workspaceEdit?.documentChanges === true &&
          Array.isArray(workspaceEdit.resourceOperations) &&
          workspaceEdit.resourceOperations.includes('create');
        await connState.update({
          workspaceImportOptions: workspaceImportOptions(
            [projectPath, ...(p?.workspaceFolders?.map((folder) => folder.uri) ?? [])],
            paramsObj.initializationOptions as Record<string, unknown>,
          ),
        });
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

      if (closing) return;
      try {
        const session = await connectWithLease({
          systemPath: settings.systemPath,
          kind: 'bridge',
          projectPath,
        });
        if (closing) {
          session.socket.destroy();
          await session.lease.release();
          return;
        }
        socket = session.socket;
        leaseHandle = session.lease;
        socket.on('error', (err: Error) => close(err));
        socket.on('end', () => close());
        upstream.pipe(socket);
        socket.pipe(downstream);
      } catch (error: unknown) {
        close(error instanceof Error ? error : new Error(String(error)), {
          kind: 'connection',
          stage: 'connect',
        });
        return;
      }

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

    if (message) {
      if (closing) return;
      const params = message.params;
      if (
        message.method === 'window/workDoneProgress/cancel' &&
        params &&
        typeof params === 'object' &&
        'token' in params &&
        ownedProgressTokens.has(params.token)
      ) {
        return;
      }
      if (
        message.method === 'workspace/executeCommand' &&
        message.id !== undefined &&
        params &&
        typeof params === 'object' &&
        'command' in params &&
        (params.command === 'applyModCommand' || params.command === 'resolveModCommand')
      ) {
        activeModCommandId = message.id;
      }
      barrier.fromClient(message, frame);
    }
  });

  const downstream = asyncFramedStream(async (messageRaw: unknown, frame: Buffer) => {
    const message = messageRaw as Record<string, unknown> | null;
    if (!message || closing) return;

    if (
      pendingInitialize &&
      message.id === pendingInitialize.id &&
      (message.result !== undefined || message.error !== undefined) &&
      !message.method
    ) {
      pendingInitialize = null;
      clearTimeout(initializeTimer ?? undefined);
      initializeTimer = null;
    }
    if (message.method === 'intellij/chooseAction') {
      // The server asks which variant to apply and then reports success without editing anything.
      // Record the entries so the response to the triggering request can explain that instead of
      // claiming the fix was applied.
      const params = message.params;
      const record =
        params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
      const entries = Array.isArray(record.entries)
        ? record.entries.flatMap((entry) => {
            if (!entry || typeof entry !== 'object') return [];
            const candidate = entry as Record<string, unknown>;
            if (typeof candidate.name !== 'string' || candidate.name.length === 0) return [];
            // The command is the variant's handle; it is forwarded untouched because only the
            // server can interpret its arguments.
            return [{ name: candidate.name, command: candidate.command }];
          })
        : [];
      const title = typeof record.title === 'string' ? record.title : '';
      if (activeModCommandId !== null) {
        pendingChoices.set(activeModCommandId, { id: activeModCommandId, title, entries });
      } else {
        console.error(
          `intellij-bridge: a fix needs a variant choice with no request in flight${title ? ` (${title})` : ''}`,
        );
      }
      return;
    }
    if (message.method === 'intellij/showConflicts' && message.id !== undefined) {
      // The server blocks this request until answered; only a client UI can decide. Removing
      // references is destructive, so the bridge declines instead of guessing.
      upstream.push(
        encode({
          jsonrpc: '2.0',
          id: message.id,
          result: { decision: 'cancel' },
        }),
      );
      const params = message.params;
      const conflicts =
        params &&
        typeof params === 'object' &&
        'conflicts' in params &&
        Array.isArray(params.conflicts)
          ? params.conflicts.length
          : 0;
      console.error(
        `intellij-bridge: declined a refactor with ${conflicts} conflict(s); apply it from an IDE or reduce the change`,
      );
      return;
    }
    if (
      message.method === 'window/workDoneProgress/create' &&
      message.id !== undefined &&
      !clientWorkDoneProgress
    ) {
      const params = message.params;
      const token =
        params && typeof params === 'object' && 'token' in params ? params.token : undefined;
      if (typeof token !== 'string' && typeof token !== 'number') {
        upstream.push(
          encode({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32602, message: 'Progress token must be a string or number' },
          }),
        );
      } else {
        ownedProgressTokens.add(token);
        upstream.push(encode({ jsonrpc: '2.0', id: message.id, result: null }));
      }
      return;
    }
    const params = message.params;
    const progress =
      message.method === '$/progress' && params && typeof params === 'object' && 'token' in params
        ? params
        : undefined;
    const ownedProgress = progress !== undefined && ownedProgressTokens.has(progress.token);
    if (
      ownedProgress &&
      progress &&
      'value' in progress &&
      progress.value &&
      typeof progress.value === 'object' &&
      'kind' in progress.value &&
      progress.value.kind === 'end'
    ) {
      ownedProgressTokens.delete(progress.token);
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
    // A fix that needed a variant choice never edited anything, yet the server answers success.
    // Rewrite that answer so the caller does not build on a change that did not happen.
    let outgoing = frame;
    const responseId = !message.method && message.id !== undefined ? message.id : undefined;
    const interrupted = responseId === undefined ? undefined : pendingChoices.get(responseId);
    if (interrupted !== undefined && responseId !== undefined) {
      pendingChoices.delete(responseId);
      if (activeModCommandId === responseId) activeModCommandId = null;
      const title = interrupted.title.length > 0 ? interrupted.title : 'choose an action';
      delete message.result;
      message.error = {
        code: -32803,
        message: `Fix was not applied: the server requires a variant choice (${title}). Execute one of data.choices[].command to apply it; a choice can expire, so re-request code actions rather than retrying a rejected handle.`,
        data: {
          reason: 'variant-choice',
          title,
          choices: interrupted.entries,
        },
      };
      outgoing = encode(message);
    } else if (responseId !== undefined && activeModCommandId === responseId) {
      activeModCommandId = null;
    }
    barrier.fromServer(
      message,
      documentSymbols.fromServer(message) ? encode(message) : outgoing,
      !ownedProgress,
    );
  });

  barrier = new IndexBarrier({
    requestWaitTimeoutMs,
    sendServer: (frame: Buffer) => upstream.push(frame),
    sendClient: (frame: Buffer) => downstream.push(frame),
    onRequestRejected: (id) => documentSymbols.discard(id),
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
    documentSymbols.close();

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

    if (pendingInitialize) {
      downstream.push(
        encode({
          jsonrpc: '2.0',
          id: pendingInitialize.id,
          error: {
            code: -32803,
            message: sanitizeString(
              error?.message ?? 'IntelliJ connection closed during initialize',
            ),
            data: failureDetail ? { failure: sanitizeStatus(failureDetail) } : undefined,
          },
        }),
      );
      pendingInitialize = null;
    }
    ownedProgressTokens.clear();

    barrier.fail(
      error?.message ?? 'IntelliJ connection closed before queued requests completed',
      failureDetail,
    );
    barrier.dispose();

    process.stdin.unpipe(upstream);
    process.stdin.destroy();
    if (socket) {
      upstream.unpipe(socket);
      socket.unpipe(downstream);
      socket.destroy();
    }
    upstream.destroy();
    downstream.end();
  }

  upstream.on('error', (err: Error) => close(err));
  downstream.on('error', (err: Error) => close(err));
  process.stdin.on('error', (err: Error) => close(err));
  process.stdout.on('error', (err: Error) => close(err));
  process.stdin.on('end', () => close());
  process.on('SIGTERM', () => close(undefined, { kind: 'cancelled', stage: 'connect' }));
  process.on('SIGINT', () => close(undefined, { kind: 'cancelled', stage: 'connect' }));

  downstream.pipe(process.stdout);
  process.stdin.pipe(upstream);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBridge().catch((error: unknown) => {
    const safeMsg =
      error instanceof Error ? sanitizeString(error.message) : sanitizeString(String(error));
    console.error(safeMsg);
    process.exit(1);
  });
}
