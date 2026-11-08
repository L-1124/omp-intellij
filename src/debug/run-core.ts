import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  getHostInitializationOptions,
  resolveConfigurationItems,
  stripRedactedPlaceholders,
} from '../project/configuration.js';
import {
  connectionCloseState,
  createConnectionState,
  reduceConnectionState,
  type StateRecord,
} from '../project/connection-state.js';
import {
  canonicalizeProject,
  type LeaseHandle,
  migrateProjectMetadata,
  recordConnection,
  recordReadiness,
} from '../project/metadata.js';
import { findProjectRoot } from '../project/readiness.js';
import { applyWorkspaceOptions, getWorkspaceInfo } from '../project/workspace.js';
import { connectWithLease, settings } from '../server/service.js';
import { encode, frameParser } from '../shared/protocol.js';
import {
  type FailureDetail,
  LICENSE_RECOVERY_GUIDANCE,
  RpcResponseError,
  sanitizeString,
} from '../shared/runtime-status.js';

export function findMainMethodLine(fileContent: string): number | null {
  const lines = fileContent.split(/\r?\n/);
  let inMain = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inMain) {
      if (/\b(?:public\s+static\s+void\s+main|fun\s+main)\b/.test(line)) {
        if (line.includes('{')) {
          const afterBrace = line.slice(line.indexOf('{') + 1).trim();
          if (afterBrace && !afterBrace.startsWith('//') && !afterBrace.startsWith('/*')) {
            return i + 1;
          }
          inMain = true;
        } else {
          inMain = true;
        }
      }
    } else {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
      if (trimmed === '{') continue;
      return i + 1;
    }
  }
  return null;
}

export function detectProjectRoot(filePath: string, explicitProject?: string): string {
  if (explicitProject) {
    return resolve(explicitProject);
  }
  return findProjectRoot(filePath);
}

export function toLspFileUri(filePath: string, rootUri?: string): string {
  const resolved = resolve(filePath);
  let uri = pathToFileURL(resolved).href;
  if (!rootUri) return uri;

  const rootMatch = rootUri.match(/^file:\/\/\/([a-zA-Z]):/);
  const fileMatch = uri.match(/^file:\/\/\/([a-zA-Z]):/);
  if (rootMatch && fileMatch) {
    const rootDrive = rootMatch[1];
    uri = uri.replace(/^file:\/\/\/[a-zA-Z]:/, `file:///${rootDrive}:`);
  }
  return uri;
}

export function toggleDriveCase(uri: unknown): string {
  if (typeof uri !== 'string') return '';
  const match = uri.match(/^file:\/\/\/([a-zA-Z]):/);
  if (!match) return uri;
  const current = match[1];
  const toggled = current === current.toLowerCase() ? current.toUpperCase() : current.toLowerCase();
  return uri.replace(/^file:\/\/\/[a-zA-Z]:/, `file:///${toggled}:`);
}

export function prepareBuildCommand(executable: string, args: string[]) {
  if (process.platform !== 'win32') {
    return { cmd: executable, argv: args, shell: false, windowsVerbatimArguments: false };
  }

  const isBatch = /\.(cmd|bat)$/i.test(executable) || !/\.[a-zA-Z0-9]+$/i.test(executable);
  if (!isBatch) {
    return { cmd: executable, argv: args, shell: false, windowsVerbatimArguments: false };
  }

  const dangerousRegex = /[&|<>^%]/;
  for (const arg of args) {
    if (dangerousRegex.test(arg)) {
      throw new Error(`Unsafe character in build argument: ${arg}`);
    }
  }

  const quotedArgs = args.map((arg) => {
    if (/[\s"]/.test(arg)) {
      return `"${arg.replace(/"/g, '""')}"`;
    }
    return arg;
  });

  const comspec = process.env.COMSPEC || 'cmd.exe';
  return {
    cmd: comspec,
    argv: ['/d', '/s', '/c', `"${[executable, ...quotedArgs].join(' ')}"`],
    shell: false,
    windowsVerbatimArguments: true,
  };
}

export interface LspSession {
  rootUri: string;
  nativePath: string;
  serverCapabilities?: Record<string, unknown>;
  request: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
  notify: (method: string, params: unknown) => void;
  isReady: () => boolean;
  reloadWorkspace: (options?: {
    initializationOptions?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<{ ready: boolean }>;
  close: () => Promise<void>;
}

export async function resolveMainFromLsp(
  lspSession: LspSession,
  fileUri: string,
): Promise<{ mainClass: string; line: number } | null> {
  try {
    const lenses = await lspSession.request(
      'textDocument/codeLens',
      {
        textDocument: { uri: fileUri },
      },
      5000,
    );

    if (Array.isArray(lenses)) {
      const candidates = new Map<string, number>();
      for (const lens of lenses) {
        if (
          lens &&
          typeof lens === 'object' &&
          'command' in lens &&
          lens.command &&
          typeof lens.command === 'object'
        ) {
          const cmd = lens.command as {
            command?: string;
            arguments?: Array<{ mainClass?: string }>;
          };
          if (cmd.command === 'intellij.jvm.runMain') {
            const args = cmd.arguments?.[0];
            if (args?.mainClass) {
              const range = (lens as { range?: { start?: { line?: number } } }).range;
              const line = (range?.start?.line ?? 0) + 1;
              candidates.set(args.mainClass, line);
            }
          }
        }
      }
      if (candidates.size === 1) {
        const [mainClass, line] = Array.from(candidates.entries())[0];
        return { mainClass, line };
      }
      if (candidates.size > 1) {
        const list = Array.from(candidates.keys()).join(', ');
        throw new Error(
          `Multiple main entry points found (${list}); please specify mainClass explicitly`,
        );
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('Multiple main entry points')) throw err;
  }
  return null;
}

export function findProcessByMarker(marker: string, javaExec?: string): number | null {
  if (!/^[0-9a-f-]{36}$/i.test(marker ?? '')) throw new Error('Invalid run ownership marker');
  const jpsExec = javaExec
    ? join(dirname(javaExec), process.platform === 'win32' ? 'jps.exe' : 'jps')
    : 'jps';

  try {
    const res = spawnSync(jpsExec, ['-l', '-v'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    if (res.status === 0 && res.stdout) {
      const regex = new RegExp(`^(\\d+)\\s+.*-Domp\\.intellij\\.run\\.id=${marker}`, 'm');
      const match = res.stdout.match(regex);
      if (match) {
        return Number(match[1]);
      }
      return null;
    }
  } catch {}

  if (process.platform === 'win32') {
    try {
      const ps = spawnSync(
        'pwsh.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name = 'java.exe' AND CommandLine LIKE '%-Domp.intellij.run.id=${marker}%'" | Select-Object -ExpandProperty ProcessId`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 3000 },
      );
      if (ps.status !== 0) throw new Error('Cannot inspect JVM process ownership');
      const pid = Number(ps.stdout?.trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {}
  }

  return null;
}

export async function terminateMarkedProcess(
  marker: string,
  javaExec?: string,
  deadlineMs: number = 3000,
): Promise<boolean> {
  if (!marker) return false;
  const deadline = Date.now() + deadlineMs;

  while (Date.now() < deadline) {
    const pid = findProcessByMarker(marker, javaExec);
    if (!pid) return true;

    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {}

    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 100);
    await promise;
  }

  const remaining = findProcessByMarker(marker, javaExec);
  if (remaining) throw new Error(`Failed to terminate owned JVM PID ${remaining}`);
  return true;
}

export interface CreateLspSessionOptions {
  signal?: AbortSignal;
  initializeTimeoutMs?: number;
  requestWaitTimeoutMs?: number;
  initTimeoutMs?: number;
  indexWaitTimeoutMs?: number;
  systemPath?: string;
  configDir?: string;
  socket?: net.Socket;
}

export async function createLspSession(
  projectRoot: string,
  options: CreateLspSessionOptions = {},
): Promise<LspSession> {
  const project = canonicalizeProject(findProjectRoot(projectRoot));
  const { id, nativePath } = project;

  const rawInitTimeout = options.initializeTimeoutMs ?? options.initTimeoutMs;
  if (rawInitTimeout !== undefined && (!Number.isFinite(rawInitTimeout) || rawInitTimeout <= 0)) {
    throw new Error('initializeTimeoutMs must be a positive finite number');
  }
  const initTimeout =
    rawInitTimeout ?? settings.initializeTimeoutMs ?? settings.initTimeoutMs ?? 30000;
  if (!Number.isFinite(initTimeout) || initTimeout <= 0) {
    throw new Error('initializeTimeoutMs must be a positive finite number');
  }

  const rawRequestTimeout = options.requestWaitTimeoutMs ?? options.indexWaitTimeoutMs;
  if (
    rawRequestTimeout !== undefined &&
    (!Number.isFinite(rawRequestTimeout) || rawRequestTimeout <= 0)
  ) {
    throw new Error('requestWaitTimeoutMs must be a positive finite number');
  }
  const requestTimeout =
    rawRequestTimeout ?? settings.requestWaitTimeoutMs ?? settings.indexWaitTimeoutMs ?? 300000;
  if (!Number.isFinite(requestTimeout) || requestTimeout <= 0) {
    throw new Error('requestWaitTimeoutMs must be a positive finite number');
  }

  const systemPath = options.systemPath ?? settings.systemPath;
  const configDir = options.configDir;
  const signal = options.signal;
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('LSP session aborted');
  }
  await migrateProjectMetadata(systemPath, project);

  const { socket, lease } = await connectWithLease({
    systemPath,
    kind: 'runner',
    projectPath: nativePath,
    socket: options.socket,
  });
  const connState = createConnectionState({
    systemPath,
    kind: 'runner',
    root: nativePath,
  });
  let leaseHandle: LeaseHandle | null = lease;
  recordConnection(systemPath, nativePath, Date.now()).catch(() => {});

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  let isClosed = false;
  let serverReady = false;

  const readinessWaiters = new Set<{ resolve: () => void; reject: (err: Error) => void }>();
  let fatalError: Error | null = null;
  let closePromise: Promise<void> | undefined;
  let protocolState: StateRecord = {
    phase: 'connecting',
    detail: '',
    progress: null,
    rootUri: null,
    initializeRequestId: null,
    generation: 0,
    systemPath,
  };

  function readinessError(): Error | undefined {
    if (fatalError) return fatalError;
    if (protocolState.failure && protocolState.failure.stage !== 'request') {
      const prefix =
        protocolState.failure.kind === 'authorization' ? 'IntelliJ authorization denied: ' : '';
      return new Error(prefix + sanitizeString(protocolState.failure.message));
    }
    if (
      protocolState.license?.featuresDeclined ||
      protocolState.license?.status === 'needs-activation' ||
      protocolState.license?.status === 'expired'
    ) {
      return new Error(LICENSE_RECOVERY_GUIDANCE);
    }
    return undefined;
  }

  function applyState(message: Record<string, unknown>, direction: 'client' | 'server') {
    const previous = protocolState;
    protocolState = reduceConnectionState(previous, message, direction);
    serverReady = protocolState.phase === 'ready' && !readinessError();
    if (
      previous.phase !== protocolState.phase ||
      previous.detail !== protocolState.detail ||
      previous.rootUri !== protocolState.rootUri ||
      previous.failure !== protocolState.failure ||
      previous.license !== protocolState.license ||
      previous.progress !== protocolState.progress
    ) {
      void connState.update({
        rootUri: protocolState.rootUri ?? undefined,
        phase: protocolState.phase,
        detail: protocolState.detail,
        progress: protocolState.progress,
        failure: protocolState.failure ?? null,
        license: protocolState.license ?? { status: 'unknown' },
      });
    }
    const error = readinessError();
    if (error || serverReady) {
      for (const waiter of readinessWaiters) {
        if (error) waiter.reject(error);
        else waiter.resolve();
      }
      readinessWaiters.clear();
    }
    if (serverReady && previous.phase !== 'ready') {
      void recordReadiness(systemPath, nativePath, Date.now()).catch(() => {});
    }
  }

  function waitForReady(timeoutMs: number, abortSignal?: AbortSignal): Promise<void> {
    const error = readinessError();
    if (error) return Promise.reject(error);
    if (serverReady) return Promise.resolve();

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter = { resolve, reject };
    readinessWaiters.add(waiter);

    const timer = setTimeout(() => {
      readinessWaiters.delete(waiter);
      const err = new Error(`IntelliJ readiness timed out after ${timeoutMs}ms`);
      (err as Error & { code?: string }).code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
    timer.unref();

    let abortHandler: (() => void) | undefined;
    if (abortSignal) {
      abortHandler = () => {
        readinessWaiters.delete(waiter);
        clearTimeout(timer);
        reject(
          abortSignal.reason instanceof Error
            ? abortSignal.reason
            : new Error(String(abortSignal.reason || 'Cancelled')),
        );
      };
      if (abortSignal.aborted) {
        abortHandler();
        return promise;
      }
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }

    return promise.finally(() => {
      clearTimeout(timer);
      if (abortSignal && abortHandler) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
    });
  }

  function send(msg: Record<string, unknown>) {
    if (isClosed || socket.destroyed) return;
    applyState(msg, 'client');
    socket.write(encode({ jsonrpc: '2.0', ...msg }));
  }

  function notify(method: string, params: unknown) {
    if (isClosed || socket.destroyed) return;
    send({ method, params });
  }

  function cleanup(
    error?: Error,
    closeOpts?: { kind?: FailureDetail['kind']; stage?: FailureDetail['stage'] },
  ): Promise<void> {
    if (closePromise) return closePromise;
    isClosed = true;
    const lease = leaseHandle;
    leaseHandle = null;
    const err = error || new Error('LSP connection closed');
    fatalError = err;
    for (const handler of pending.values()) {
      clearTimeout(handler.timer);
      handler.reject(err);
    }
    pending.clear();
    for (const waiter of readinessWaiters) waiter.reject(err);
    readinessWaiters.clear();
    closePromise = Promise.all([
      connState.close(connectionCloseState(error, { ...closeOpts, systemPath })),
      lease?.release(),
    ]).then(() => {});
    socket.destroy();
    return closePromise;
  }

  function handleMessage(messageRaw: unknown) {
    const message = messageRaw as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message?: string };
    } | null;

    if (!message) return;
    applyState(message as Record<string, unknown>, 'server');

    if (message.id !== undefined && !message.method) {
      const handler = pending.get(message.id);
      if (handler) {
        pending.delete(message.id);
        clearTimeout(handler.timer);
        if (message.error) {
          const error = new RpcResponseError(
            message.error as { code?: number | string; message?: string; data?: unknown },
          );
          if (
            message.id !== protocolState.initializeRequestId &&
            error.code !== -32800 &&
            (!protocolState.failure || protocolState.failure.stage === 'request')
          ) {
            protocolState.failure = {
              kind: 'rpc',
              stage: 'request',
              message: error.message,
              code: error.code,
              data: error.data,
              logPath: join(systemPath, 'launcher.log'),
            };
            void connState.update({ failure: protocolState.failure }).then(
              () => handler.reject(error),
              () => handler.reject(error),
            );
          } else {
            handler.reject(error);
          }
        } else {
          if (protocolState.failure?.stage === 'request') {
            delete protocolState.failure;
            void connState.update({ failure: null });
          }
          handler.resolve(message.result);
        }
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      if (message.method === 'workspace/configuration') {
        const params = message.params;
        const items =
          params && typeof params === 'object' && 'items' in params && Array.isArray(params.items)
            ? (params.items as Array<{ scopeUri?: string; section?: string }>)
            : [];
        void resolveConfigurationItems(systemPath, id, items)
          .then((results) => {
            send({ id: message.id, result: results });
          })
          .catch((err: unknown) => {
            send({
              id: message.id,
              error: {
                code: -32603,
                message: `Failed to resolve configuration: ${err instanceof Error ? err.message : String(err)}`,
              },
            });
          });
      } else if (
        [
          'client/registerCapability',
          'client/unregisterCapability',
          'window/workDoneProgress/create',
        ].includes(message.method)
      ) {
        send({ id: message.id, result: null });
      } else if (message.method === 'workspace/applyEdit') {
        send({
          id: message.id,
          result: { applied: false, failureReason: 'Run core client does not apply edits' },
        });
      } else {
        send({
          id: message.id,
          error: { code: -32601, message: `Method ${message.method} not implemented by runner` },
        });
      }
      return;
    }
  }

  socket.on('data', frameParser(handleMessage));
  socket.once('error', (err: Error) => void cleanup(err).catch(() => {}));
  socket.once('close', () => void cleanup().catch(() => {}));

  const onAbort = () => {
    void cleanup(
      signal?.reason instanceof Error
        ? signal.reason
        : new Error(String(signal?.reason || 'LSP session cancelled')),
      { kind: 'cancelled', stage: 'request' },
    ).catch(() => {});
  };
  if (signal?.aborted) {
    await cleanup(new Error('LSP session cancelled'), { kind: 'cancelled', stage: 'connect' });
    throw fatalError;
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    let initParams: Record<string, unknown> | null = null;
    try {
      const recordedPath = join(systemPath, 'plugin-metadata', `initialize-${id}.json`);
      const recorded = JSON.parse(await readFile(recordedPath, 'utf8')) as Record<string, unknown>;
      const recordedFolders = recorded?.workspaceFolders as Array<{ uri?: string }> | undefined;
      const recordedUri =
        (typeof recorded?.rootUri === 'string' ? recorded.rootUri : undefined) ??
        recordedFolders?.[0]?.uri;
      if (
        recordedUri &&
        canonicalizeProject(recordedUri).canonicalPath ===
          canonicalizeProject(nativePath).canonicalPath
      ) {
        initParams = recorded;
      }
    } catch {}

    const normPath = nativePath
      .replace(/\\/g, '/')
      .replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`);
    const normRootUri = pathToFileURL(normPath).href;
    connState
      .update({
        root: nativePath,
        rootUri: normRootUri,
        phase: 'connecting',
        detail: 'Initializing runner connection',
      })
      .catch(() => {});

    const rawHostOpts = await getHostInitializationOptions(systemPath, id);
    if (!initParams) {
      initParams = {
        processId: process.pid,
        rootUri: normRootUri,
        rootPath: nativePath,
        workspaceFolders: [{ uri: normRootUri, name: basename(nativePath) }],
        capabilities: {
          experimental: {
            licensingUi: true,
          },
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: false },
            hover: { contentFormat: ['markdown', 'plaintext'], dynamicRegistration: false },
            definition: { dynamicRegistration: false, linkSupport: true },
            typeDefinition: { dynamicRegistration: false, linkSupport: true },
            implementation: { dynamicRegistration: false, linkSupport: true },
            references: { dynamicRegistration: false },
            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
            codeLens: { dynamicRegistration: false },
          },
          window: { workDoneProgress: true },
          workspace: {
            configuration: true,
            workspaceFolders: true,
            symbol: { dynamicRegistration: false },
          },
        },
        initializationOptions: {
          ...rawHostOpts,
          runMainCodeLens: true,
        },
      };
    } else {
      if (!rawHostOpts) {
        initParams = stripRedactedPlaceholders(initParams);
      }
      delete initParams.rawInitializationOptions;
      const existingOpts =
        rawHostOpts ??
        (initParams.initializationOptions && typeof initParams.initializationOptions === 'object'
          ? (initParams.initializationOptions as Record<string, unknown>)
          : {});
      if ('eulaHash' in existingOpts) {
        delete (existingOpts as Record<string, unknown>).eulaHash;
      }
      initParams.initializationOptions = {
        ...existingOpts,
        runMainCodeLens: true,
      };
      const capabilities = (initParams.capabilities as Record<string, unknown>) || {};
      const exp = (capabilities.experimental as Record<string, unknown>) || {};
      exp.licensingUi = true;
      capabilities.experimental = exp;
      const textDocument = capabilities.textDocument as Record<string, unknown> | undefined;
      if (textDocument) {
        textDocument.codeLens = { dynamicRegistration: false };
      }
      initParams.capabilities = capabilities;
    }

    const folders = initParams.workspaceFolders as Array<{ uri?: string }> | undefined;
    const effectiveRootUri =
      (typeof initParams.rootUri === 'string' ? initParams.rootUri : undefined) ||
      folders?.[0]?.uri ||
      normRootUri;

    initParams.processId = process.pid;
    initParams.initializationOptions = await applyWorkspaceOptions(
      nativePath,
      (initParams.initializationOptions as Record<string, unknown>) || {},
      { systemPath, configDir },
    );

    function request(
      method: string,
      params: unknown,
      timeoutMs: number = requestTimeout,
    ): Promise<unknown> {
      if (isClosed) return Promise.reject(new Error('LSP session is closed'));
      const reqId = nextId++;
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const timer = setTimeout(() => {
        pending.delete(reqId);
        const err = new Error(`LSP request ${method} timed out after ${timeoutMs}ms`);
        (err as Error & { code?: string }).code = 'ETIMEDOUT';
        reject(err);
      }, timeoutMs);
      pending.set(reqId, { resolve, reject, timer });
      send({ id: reqId, method, params });
      return promise;
    }

    const initResult = await request('initialize', initParams, initTimeout);
    const serverCapabilities =
      initResult &&
      typeof initResult === 'object' &&
      'capabilities' in initResult &&
      initResult.capabilities &&
      typeof initResult.capabilities === 'object' &&
      !Array.isArray(initResult.capabilities)
        ? (initResult.capabilities as Record<string, unknown>)
        : undefined;
    send({ method: 'initialized', params: {} });

    await waitForReady(requestTimeout, signal);
    await connState.flush();
    if (fatalError) throw fatalError;

    async function reloadWorkspace(
      reloadOpts: {
        initializationOptions?: unknown;
        timeoutMs?: number;
        signal?: AbortSignal;
      } = {},
    ): Promise<{ ready: boolean }> {
      if (isClosed) throw new Error('LSP session is closed');
      const opTimeout = reloadOpts.timeoutMs ?? requestTimeout;
      if (!Number.isFinite(opTimeout) || opTimeout <= 0) {
        throw new Error('timeoutMs must be a positive finite number');
      }

      const effectiveSignal = reloadOpts.signal || signal;
      if (effectiveSignal?.aborted) {
        throw new Error(
          effectiveSignal.reason instanceof Error
            ? effectiveSignal.reason.message
            : String(effectiveSignal.reason || 'Reload cancelled'),
        );
      }

      applyState({ method: 'intellij/reloadWorkspace' }, 'client');
      const waitPromise = waitForReady(opTimeout, effectiveSignal);

      await Promise.all([
        request(
          'intellij/reloadWorkspace',
          { initializationOptions: reloadOpts.initializationOptions },
          opTimeout,
        ),
        waitPromise,
      ]);
      await connState.flush();
      return { ready: true };
    }

    return {
      rootUri: effectiveRootUri,
      nativePath,
      serverCapabilities,
      request,
      notify,
      isReady: () => serverReady,
      reloadWorkspace,
      close: async () => {
        signal?.removeEventListener('abort', onAbort);
        await cleanup();
      },
    };
  } catch (err: unknown) {
    signal?.removeEventListener('abort', onAbort);
    await cleanup(err instanceof Error ? err : new Error(String(err)), {
      stage:
        protocolState.failure?.stage ??
        (protocolState.phase === 'connecting' ? 'initialize' : 'index'),
    });
    throw err;
  }
}

export async function resolveBuildCommand(
  lspSession: LspSession,
  fileUri: string,
): Promise<{ supported: boolean; command: string[]; cwd: string; tool: string; reason?: string }> {
  try {
    return (await lspSession.request('workspace/executeCommand', {
      command: 'intellij.java.resolveBuildCommand',
      arguments: [{ uri: fileUri }],
    })) as { supported: boolean; command: string[]; cwd: string; tool: string; reason?: string };
  } catch (err: unknown) {
    const altUri = toggleDriveCase(fileUri);
    if (altUri && altUri !== fileUri) {
      try {
        return (await lspSession.request('workspace/executeCommand', {
          command: 'intellij.java.resolveBuildCommand',
          arguments: [{ uri: altUri }],
        })) as {
          supported: boolean;
          command: string[];
          cwd: string;
          tool: string;
          reason?: string;
        };
      } catch {}
    }
    throw err;
  }
}

export interface LaunchPaths {
  javaExec: string;
  classpath?: string[];
  modulePath?: string[];
  moduleName?: string;
  moduleContentPaths?: string[];
  workingDirectory?: string;
  vmArgs?: string[];
}

export async function resolveLaunch(lspSession: LspSession, fileUri: string): Promise<LaunchPaths> {
  try {
    return (await lspSession.request('workspace/executeCommand', {
      command: 'intellij.java.resolveLaunch',
      arguments: [{ uri: fileUri }],
    })) as LaunchPaths;
  } catch (err: unknown) {
    const altUri = toggleDriveCase(fileUri);
    if (altUri && altUri !== fileUri) {
      try {
        return (await lspSession.request('workspace/executeCommand', {
          command: 'intellij.java.resolveLaunch',
          arguments: [{ uri: altUri }],
        })) as LaunchPaths;
      } catch {}
    }
    throw err;
  }
}

export async function startDebugServer(lspSession: LspSession, rootUri: string): Promise<number> {
  const result = await lspSession.request('workspace/executeCommand', {
    command: 'start_debug_server',
    arguments: [rootUri],
  });
  const port = Number(result);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid debug server port returned: ${JSON.stringify(result)}`);
  }
  return port;
}

export async function executeBuild(
  buildCommand: { command: string[]; cwd?: string; tool?: string; env?: Record<string, string> },
  options: {
    signal?: AbortSignal;
    onOutput?: (e: { output: string; category: string }) => void;
    projectRoot?: string;
    configDir?: string;
  } = {},
): Promise<{ exitCode: number; buildOutput: string }> {
  const { command, cwd, tool } = buildCommand;
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error('Empty build command');
  }

  const label = tool || 'build tool';
  const startMsg = `--- ${label}: building: ${command.join(' ')} ---\n`;
  if (options.onOutput) options.onOutput({ output: startMsg, category: 'console' });

  const executable = command[0];
  const args = command.slice(1);
  const prep = prepareBuildCommand(executable, args);

  const targetRoot = options.projectRoot || cwd || process.cwd();
  let managedJdk: string | null = null;
  const info = await getWorkspaceInfo(targetRoot, { configDir: options.configDir });
  if (info?.savedJdk) {
    managedJdk = info.savedJdk;
  }

  function findPathKey(env: NodeJS.ProcessEnv): string {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') return key;
    }
    return process.platform === 'win32' ? 'Path' : 'PATH';
  }

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(buildCommand.env || {}),
  };

  const effectiveJavaHome = buildCommand.env?.JAVA_HOME || managedJdk;
  if (effectiveJavaHome) {
    baseEnv.JAVA_HOME = effectiveJavaHome;
    const pathKey = findPathKey(baseEnv);
    const currentPath = baseEnv[pathKey] || '';
    const binDir = join(effectiveJavaHome, 'bin');
    baseEnv[pathKey] = currentPath ? `${binDir}${delimiter}${currentPath}` : binDir;
  }
  baseEnv.JAVA_TOOL_OPTIONS = `${baseEnv.JAVA_TOOL_OPTIONS ? `${baseEnv.JAVA_TOOL_OPTIONS} ` : ''}-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8`;

  const {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  } = Promise.withResolvers<{ exitCode: number; buildOutput: string }>();
  let captured = '';
  let killed = false;

  const proc = spawn(prep.cmd, prep.argv, {
    cwd: cwd || process.cwd(),
    shell: prep.shell,
    windowsVerbatimArguments: prep.windowsVerbatimArguments,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: baseEnv,
  });

  const handleAbort = () => {
    killed = true;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
      } else {
        proc.kill('SIGTERM');
      }
    } catch {}
    const stopMsg = `--- ${label}: build stopped ---\n`;
    if (options.onOutput) options.onOutput({ output: stopMsg, category: 'console' });
    rejectPromise(new Error(`Build cancelled: ${label}`));
  };

  if (options.signal?.aborted) {
    handleAbort();
    return promise;
  }
  options.signal?.addEventListener('abort', handleAbort, { once: true });

  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (text: string) => {
    captured += text;
    if (options.onOutput) options.onOutput({ output: text, category: 'stdout' });
  });

  proc.stderr.on('data', (text: string) => {
    captured += text;
    if (options.onOutput) options.onOutput({ output: text, category: 'stderr' });
  });

  proc.on('error', (err: Error) => {
    options.signal?.removeEventListener('abort', handleAbort);
    const errMsg = `--- ${label}: build failed to start: ${err.message} ---\n`;
    if (options.onOutput) options.onOutput({ output: errMsg, category: 'console' });
    rejectPromise(new Error(`Failed to start build tool (${label}): ${err.message}`));
  });

  proc.on('close', (code: number | null) => {
    options.signal?.removeEventListener('abort', handleAbort);
    if (killed) return;
    if (code === 0) {
      const succMsg = `--- ${label}: build succeeded ---\n`;
      if (options.onOutput) options.onOutput({ output: succMsg, category: 'console' });
      resolvePromise({ exitCode: 0, buildOutput: captured });
    } else {
      const failMsg = `--- ${label}: build failed, exit ${code} ---\n`;
      if (options.onOutput) options.onOutput({ output: failMsg, category: 'console' });
      const tail = captured.length > 4000 ? captured.slice(-4000) : captured;
      rejectPromise(new Error(`Build failed with exit code ${code} (${label}):\n${tail.trim()}`));
    }
  });

  return promise;
}

export async function runViaDap(options: {
  port: number;
  launchConfig: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (e: { output: string; category: string }) => void;
  runMarker?: string;
  javaExec?: string;
}): Promise<{ exitCode: number; output: string }> {
  const { port, launchConfig, timeoutMs = 60000, signal, onOutput, runMarker, javaExec } = options;
  const {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  } = Promise.withResolvers<{ exitCode: number; output: string }>();

  const socket = net.createConnection({ host: '127.0.0.1', port });
  let seq = 1;
  let programOutput = '';
  let exitCode: number | null = null;
  let finished = false;
  let isTerminating = false;
  let ownedTargetPid: number | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let terminationReason: Error | null = null;

  function sendDap(msg: Record<string, unknown>) {
    if (socket.destroyed) return;
    socket.write(encode(msg));
  }

  function finish(err: Error | null, result?: { exitCode: number; output: string }) {
    if (finished) return;
    finished = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    signal?.removeEventListener('abort', handleAbort);
    try {
      socket.destroy();
    } catch {}

    const finalError = terminationReason || err;
    if (finalError) rejectPromise(finalError);
    else if (result) resolvePromise(result);
  }

  async function performTermination(reasonError: Error) {
    if (!terminationReason) {
      terminationReason = reasonError;
    }
    if (isTerminating) return;
    isTerminating = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    signal?.removeEventListener('abort', handleAbort);

    try {
      sendDap({
        seq: seq++,
        type: 'request',
        command: 'terminate',
        arguments: {},
      });
    } catch {}

    try {
      sendDap({
        seq: seq++,
        type: 'request',
        command: 'disconnect',
        arguments: { terminateDebuggee: true },
      });
    } catch {}

    if (runMarker) {
      await terminateMarkedProcess(runMarker, javaExec, 3000);
    } else if (ownedTargetPid) {
      let alive = false;
      try {
        process.kill(ownedTargetPid, 0);
        alive = true;
      } catch (e: unknown) {
        if (e && typeof e === 'object' && 'code' in e && e.code !== 'ESRCH') alive = true;
      }
      if (alive) {
        try {
          if (process.platform === 'win32') {
            spawnSync('taskkill', ['/pid', String(ownedTargetPid), '/T', '/F'], {
              windowsHide: true,
            });
          } else {
            process.kill(ownedTargetPid, 'SIGKILL');
          }
        } catch {}
      }
    }

    finish(terminationReason);
  }

  const handleAbort = () => {
    const abortErr =
      signal?.reason instanceof Error
        ? signal.reason
        : new Error(String(signal?.reason || 'IntelliJ run cancelled'));
    terminationReason = abortErr;
    performTermination(abortErr);
  };

  if (signal?.aborted) {
    handleAbort();
    return promise;
  }
  signal?.addEventListener('abort', handleAbort, { once: true });

  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      const timeoutErr = new Error(`IntelliJ run timed out after ${timeoutMs / 1000}s`);
      terminationReason = timeoutErr;
      performTermination(timeoutErr);
    }, timeoutMs);
    timeoutTimer.unref();
  }

  function onDapMessage(messageRaw: unknown) {
    const message = messageRaw as {
      type?: string;
      command?: string;
      success?: boolean;
      message?: string;
      event?: string;
      body?: {
        systemProcessId?: number;
        output?: string;
        category?: string;
        exitCode?: number;
      };
    } | null;

    if (!message) return;

    if (message.type === 'response') {
      if (message.command === 'initialize') {
        if (!message.success) {
          finish(new Error(`DAP initialize failed: ${message.message || 'unknown error'}`));
          return;
        }
        sendDap({
          seq: seq++,
          type: 'request',
          command: 'launch',
          arguments: launchConfig,
        });
      } else if (message.command === 'launch') {
        if (!message.success) {
          finish(new Error(`DAP launch failed: ${message.message || 'unknown error'}`));
          return;
        }
      }
    } else if (message.type === 'event') {
      if (message.event === 'process') {
        if (
          Number.isSafeInteger(message.body?.systemProcessId) &&
          (message.body?.systemProcessId ?? 0) > 0
        ) {
          ownedTargetPid = message.body?.systemProcessId ?? null;
        }
      } else if (message.event === 'initialized') {
        sendDap({
          seq: seq++,
          type: 'request',
          command: 'configurationDone',
          arguments: {},
        });
      } else if (message.event === 'output') {
        const text = message.body?.output ?? '';
        const category = message.body?.category ?? 'stdout';
        programOutput += text;
        if (onOutput) {
          try {
            onOutput({ output: text, category });
          } catch (outputErr: unknown) {
            performTermination(
              outputErr instanceof Error ? outputErr : new Error(String(outputErr)),
            );
            return;
          }
        }
      } else if (message.event === 'exited') {
        exitCode = Number(message.body?.exitCode ?? 0);
      } else if (message.event === 'terminated') {
        if (!isTerminating && !terminationReason) {
          if (exitCode === null) {
            finish(
              new Error(
                'DAP session terminated unexpectedly before debuggee exit code was reported',
              ),
            );
          } else {
            finish(null, { exitCode, output: programOutput });
          }
        }
      }
    }
  }

  socket.on('data', frameParser(onDapMessage));

  socket.once('connect', () => {
    sendDap({
      seq: seq++,
      type: 'request',
      command: 'initialize',
      arguments: {
        clientID: 'omp',
        clientName: 'OMP',
        adapterID: 'intellij_jvm',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsRunInTerminalRequest: false,
      },
    });
  });

  socket.once('error', (err: Error) => {
    if (!isTerminating) {
      finish(new Error(`DAP connection error: ${err.message}`));
    }
  });

  socket.once('close', () => {
    if (!finished && !isTerminating && !terminationReason) {
      if (exitCode !== null) {
        finish(null, { exitCode, output: programOutput });
      } else {
        finish(
          new Error('DAP connection closed unexpectedly before debuggee exit code was reported'),
        );
      }
    }
  });

  return promise;
}

export interface RunMainOptions {
  file: string;
  project?: string;
  mainClass?: string;
  args?: string[];
  vmArgs?: string[];
  env?: Record<string, string>;
  cwd?: string;
  build?: boolean;
  timeout?: number;
  noDebug?: boolean;
}

export interface RunMainResult {
  exitCode: number;
  mainClass: string;
  cwd: string;
  javaExec: string;
  buildOutput: string;
  output: string;
}

export async function runMain(
  options: RunMainOptions,
  events: {
    signal?: AbortSignal;
    onOutput?: (e: { output: string; category: string }) => void;
  } = {},
): Promise<RunMainResult> {
  let resolvedFile = options.file;
  if (typeof resolvedFile === 'string' && resolvedFile.startsWith('file://')) {
    resolvedFile = fileURLToPath(resolvedFile);
  }
  resolvedFile = resolve(resolvedFile);

  const projectRoot = detectProjectRoot(resolvedFile, options.project);

  let fileContent: string;
  try {
    fileContent = await readFile(resolvedFile, 'utf8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to read source file at ${resolvedFile}: ${msg}`);
  }

  const timeoutSec = Math.min(Math.max(options.timeout || 60, 1), 300);
  const timeoutMs = timeoutSec * 1000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = events.signal
    ? AbortSignal.any([events.signal, timeoutSignal])
    : timeoutSignal;

  const lspSession = await createLspSession(projectRoot, { signal: combinedSignal });
  let buildOutput = '';
  let runMarker: string | null = null;
  let paths: LaunchPaths | null = null;

  try {
    const fileUri = toLspFileUri(resolvedFile, lspSession.rootUri);

    try {
      lspSession.notify('textDocument/didOpen', {
        textDocument: {
          uri: fileUri,
          languageId: resolvedFile.endsWith('.kt') ? 'kotlin' : 'java',
          version: 1,
          text: fileContent,
        },
      });
    } catch {}

    let mainClass = options.mainClass;
    if (!mainClass) {
      const lspMain = await resolveMainFromLsp(lspSession, fileUri);
      if (lspMain?.mainClass) {
        mainClass = lspMain.mainClass;
      }
    }
    if (!mainClass) {
      throw new Error(
        `Could not determine JVM mainClass from ${resolvedFile}; please specify mainClass explicitly`,
      );
    }

    if (options.build !== false) {
      let resolvedBuild: {
        supported: boolean;
        command: string[];
        cwd: string;
        tool: string;
        reason?: string;
      };
      try {
        resolvedBuild = await resolveBuildCommand(lspSession, fileUri);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Build resolution failed for ${resolvedFile}: ${msg}`);
      }

      if (!resolvedBuild || resolvedBuild.supported === false) {
        throw new Error(
          `Build unsupported for ${resolvedFile}: ${resolvedBuild?.reason || 'Server reports build unsupported for this module'}`,
        );
      }
      if (!Array.isArray(resolvedBuild.command) || resolvedBuild.command.length === 0) {
        throw new Error(
          `Build command empty for ${resolvedFile}: ${resolvedBuild?.reason || 'No compile command returned by server'}`,
        );
      }

      const buildRes = await executeBuild(resolvedBuild, {
        signal: combinedSignal,
        onOutput: events.onOutput,
        projectRoot,
      });
      buildOutput = buildRes.buildOutput;
    }

    try {
      paths = await resolveLaunch(lspSession, fileUri);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Launch resolution failed for ${resolvedFile}: ${msg}`);
    }

    if (!paths?.javaExec) {
      throw new Error(
        `Launch resolution returned no java executable for ${resolvedFile} (no project JDK configured?): ${JSON.stringify(paths)}`,
      );
    }

    const port = await startDebugServer(lspSession, lspSession.rootUri);

    runMarker = randomUUID();
    const effectiveCwd = options.cwd ? resolve(options.cwd) : paths.workingDirectory || projectRoot;
    const vmArgs = [
      ...(paths.vmArgs || []),
      ...(options.vmArgs || []),
      `-Domp.intellij.run.id=${runMarker}`,
    ];

    const launchConfig: Record<string, unknown> = {
      type: 'intellij_jvm',
      request: 'launch',
      name: mainClass,
      mainClass,
      classPaths: paths.classpath || [],
      modulePaths: paths.modulePath || [],
      moduleName: paths.moduleName,
      moduleContentPaths: paths.moduleContentPaths || [],
      javaExec: paths.javaExec,
      vmArgs,
      args: options.args || [],
      env: options.env || {},
      cwd: effectiveCwd,
      console: 'internalConsole',
      noDebug: options.noDebug !== false,
      stopOnEntry: false,
    };

    const dapRes = await runViaDap({
      port,
      launchConfig,
      timeoutMs,
      signal: combinedSignal,
      onOutput: events.onOutput,
      runMarker,
      javaExec: paths.javaExec,
    });

    if (combinedSignal.aborted) {
      if (timeoutSignal.aborted) {
        throw new Error(`IntelliJ run timed out after ${timeoutSec}s`);
      }
      throw new Error(
        events.signal?.reason instanceof Error
          ? events.signal.reason.message
          : String(events.signal?.reason || 'IntelliJ run cancelled'),
      );
    }

    return {
      exitCode: dapRes.exitCode,
      mainClass,
      cwd: effectiveCwd,
      javaExec: paths.javaExec,
      buildOutput,
      output: dapRes.output,
    };
  } catch (err: unknown) {
    if (timeoutSignal.aborted) {
      throw new Error(`IntelliJ run timed out after ${timeoutSec}s`);
    }
    if (events.signal?.aborted) {
      throw new Error(
        events.signal.reason instanceof Error
          ? events.signal.reason.message
          : String(events.signal.reason || 'IntelliJ run cancelled'),
      );
    }
    throw err;
  } finally {
    if (runMarker) {
      await terminateMarkedProcess(runMarker, paths?.javaExec, 2000).catch(() => {});
    }
    await lspSession.close().catch(() => {});
  }
}
