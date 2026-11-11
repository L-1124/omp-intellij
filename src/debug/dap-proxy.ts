#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  ANDROID_DEBUG_COMMANDS,
  claimAndroidDebug,
  releaseAndroidDebug,
  supportsAndroidDebugCommand,
} from '../android/debug-attach.js';
import { settings } from '../server/service.js';
import { encode, frameParser } from '../shared/protocol.js';
import {
  createDebugControl,
  type DebugControlHandle,
  type DebugPhase,
  type DebugSnapshot,
  isLoopbackHost,
  isLoopbackIPv6,
} from './control.js';
import {
  createLspSession,
  detectProjectRoot,
  executeBuild,
  findMainMethodLine,
  type LaunchPaths,
  type LspSession,
  resolveBuildCommand,
  resolveLaunch,
  resolveMainFromLsp,
  runMain,
  startDebugServer,
  terminateMarkedProcess,
  toLspFileUri,
} from './run-core.js';
import { resolveTestTarget } from './test-launch.js';

export interface DapBaseMessage {
  seq: number;
  type: string;
}

export interface DapRequestMessage extends DapBaseMessage {
  type: 'request';
  command: string;
  arguments?: Record<string, unknown>;
}

export interface DapResponseMessage extends DapBaseMessage {
  type: 'response';
  request_seq: number;
  command: string;
  success: boolean;
  message?: string;
  body?: unknown;
}

export interface DapEventMessage extends DapBaseMessage {
  type: 'event';
  event: string;
  body?: unknown;
}

export type DapMessage = DapRequestMessage | DapResponseMessage | DapEventMessage;

const EVAL_ERROR_SENTINELS: Record<string, true> = {
  'Evaluation is supported for stack frames only': true,
  'No active suspend context': true,
};

class NativeDisconnectCompleted extends Error {}

/**
 * Searches for a source file given a path, relative path, or qualified class name.
 */
export function resolveSourceFile(cwd: string, program?: string): string | null {
  if (!program) return null;
  const direct = resolve(cwd, program);
  if (existsSync(direct)) return direct;

  const relPath = program.replace(/\./g, '/');
  const candidates = [
    join(cwd, `${relPath}.java`),
    join(cwd, `${relPath}.kt`),
    join(cwd, 'src', 'main', 'java', `${relPath}.java`),
    join(cwd, 'src', 'main', 'kotlin', `${relPath}.kt`),
    join(cwd, 'src', `${relPath}.java`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return direct;
}

/**
 * Normalizes all file:// URIs in DAP response/event bodies to local filesystem paths for OMP.
 */
export function normalizeSourcePaths(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      obj[i] = normalizeSourcePaths(obj[i]);
    }
    return obj;
  }
  const record = obj as Record<string, unknown>;
  for (const [key, val] of Object.entries(record)) {
    if ((key === 'source' || key === 'sources') && val && typeof val === 'object') {
      if (Array.isArray(val)) {
        for (const item of val) {
          if (
            item &&
            typeof item === 'object' &&
            'path' in item &&
            typeof item.path === 'string' &&
            item.path.startsWith('file://')
          ) {
            try {
              item.path = fileURLToPath(item.path.replace(/%3A/gi, ':'));
            } catch {
              // ignore invalid file URI
            }
          }
        }
      } else if ('path' in val && typeof val.path === 'string' && val.path.startsWith('file://')) {
        try {
          const valRecord = val as Record<string, unknown>;
          valRecord.path = fileURLToPath(val.path.replace(/%3A/gi, ':'));
        } catch {
          // ignore invalid file URI
        }
      }
    } else if (key === 'path' && typeof val === 'string' && val.startsWith('file://')) {
      try {
        record[key] = fileURLToPath(val.replace(/%3A/gi, ':'));
      } catch {
        // ignore invalid file URI
      }
    } else if (typeof val === 'object' && val !== null) {
      normalizeSourcePaths(val);
    }
  }
  return obj;
}

/**
 * Checks whether this module is executed directly as a script vs imported by another module.
 */
export function isDirectExecution(
  entryScript: string | undefined = process.argv[1],
  importMetaUrl = import.meta.url,
): boolean {
  if (!entryScript) return false;
  try {
    const scriptPath = resolve(entryScript);
    const modulePath = fileURLToPath(importMetaUrl);
    if (scriptPath === modulePath) return true;

    if (process.platform === 'win32') {
      const lowerScript = scriptPath.toLowerCase();
      const lowerModule = modulePath.toLowerCase();
      if (lowerScript === lowerModule) return true;
      if (`${lowerScript}.js` === lowerModule || `${lowerScript}.ts` === lowerModule) return true;
    } else {
      if (`${scriptPath}.js` === modulePath || `${scriptPath}.ts` === modulePath) return true;
    }

    try {
      if (existsSync(scriptPath) && existsSync(modulePath)) {
        const realScript = realpathSync(scriptPath);
        const realModule = realpathSync(modulePath);
        if (process.platform === 'win32') {
          if (realScript.toLowerCase() === realModule.toLowerCase()) return true;
        } else {
          if (realScript === realModule) return true;
        }
      }
    } catch {
      // ignore realpath errors
    }

    return false;
  } catch {
    return false;
  }
}

export function normalizeAttachHost(rawHost: string): { host: string } | { error: string } {
  const trimmed = rawHost.trim();
  if (!trimmed) {
    return { error: 'IntelliJ attach requires a non-empty host' };
  }
  if (trimmed.startsWith('[') || trimmed.endsWith(']')) {
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
      return { error: `Malformed bracketed IPv6 host: ${rawHost}` };
    }
    const inner = trimmed.slice(1, -1);
    if (inner.includes('[') || inner.includes(']')) {
      return { error: `Malformed bracketed IPv6 host: ${rawHost}` };
    }
    if (!net.isIPv6(inner)) {
      return { error: `Malformed bracketed IPv6 host: ${rawHost}` };
    }
    if (isLoopbackIPv6(inner)) {
      return { host: '::1' };
    }
    return { host: inner };
  }
  if (trimmed.includes('[') || trimmed.includes(']')) {
    return { error: `Malformed host: ${rawHost}` };
  }
  if (isLoopbackIPv6(trimmed)) {
    return { host: '::1' };
  }
  return { host: trimmed };
}

export interface DapProxyOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  onExit?: (code: number) => void;
  args?: string[];
  createLspSession?: typeof createLspSession;
  systemPath?: string;
}

export interface DapProxySession {
  shutdown: (exitCode?: number) => Promise<void>;
  abortController: AbortController;
  getProxySeq: () => number;
  isShuttingDown: () => boolean;
}

/**
 * Starts the DAP Stdio Proxy server.
 */
export function startDapProxy(options: DapProxyOptions = {}): DapProxySession {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const onExit = options.onExit ?? ((code: number) => process.stdout.end(() => process.exit(code)));
  const openLspSession = options.createLspSession ?? createLspSession;
  const sessionAbortController = new AbortController();
  const lspInitializationController = new AbortController();
  let androidClaim: Promise<void> | null = null;
  let androidCleanupKey: string | null = null;
  let lspSession: LspSession | null = null;
  let dapSocket: net.Socket | null = null;
  let backendClosed: Promise<boolean> | null = null;
  let connectingSocket: net.Socket | null = null;
  let sessionMode: 'launch' | 'attach' | null = null;
  let isStarting = false;
  let isShuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let backendInitialized = false;
  let nativeInitializedEvent = false;
  let startupSent = false;
  let startupRequest: DapRequestMessage | null = null;
  let clientConfigurationDone = false;
  let configurationForwarded = false;
  let terminatedSent = false;
  let backendTerminated = false;
  let shutdownTimer: NodeJS.Timeout | undefined;
  let proxySeq = 1;
  let nextNativeSeq = 1;
  let activeRunMarker: string | null = null;
  let activeJavaExec: string | null = null;
  let hasClientBreakpoints = false;
  let isTestLaunch = false;
  let supportsFunctionBreakpoints = false;
  let entryFunctionBreakpointOwned = false;
  let supportsThreadDump = false;
  let phase: DebugPhase = 'closed';
  let projectRoot = process.cwd();
  let backendPort: number | undefined;
  let debugError: string | undefined;
  let cleanupError: string | undefined;
  let debugControl: DebugControlHandle | undefined;
  let deferExit = false;
  let finalExitCode = 0;
  const nativePending = new Map<
    number,
    {
      resolve: (value: DapResponseMessage) => void;
      command: string;
      reject: (reason: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const nativeSeqToClientSeq = new Map<number, DapRequestMessage>();
  const bufferedBreakpoints = new Map<string, Record<string, unknown>>();
  let bufferedExceptionBreakpoints: Record<string, unknown> | null = null;

  function snapshot(): DebugSnapshot {
    return {
      phase,
      mode: sessionMode ?? 'launch',
      projectRoot,
      backendPort,
      error: debugError,
      cleanupError,
      pendingRequests: nativePending.size + nativeSeqToClientSeq.size,
    };
  }

  function markRunning(): void {
    if (phase !== 'stopped') phase = 'running';
  }

  function sendToClient(msg: unknown): void {
    stdout.write(encode(normalizeSourcePaths(msg)));
  }

  function respond(
    request: DapRequestMessage,
    success: boolean,
    body?: unknown,
    message?: string,
  ): void {
    sendToClient({
      seq: proxySeq++,
      type: 'response',
      request_seq: request.seq,
      command: request.command,
      success,
      body,
      message,
    });
  }

  function output(message: string, category = 'stderr'): void {
    sendToClient({
      seq: proxySeq++,
      type: 'event',
      event: 'output',
      body: { category, output: message },
    });
  }

  function finishStartup(success: boolean, body?: unknown, message?: string): void {
    if (!startupRequest) return;
    respond(startupRequest, success, body, message);
    startupRequest = null;
    isStarting = false;
  }

  function sendTerminated(): void {
    if (terminatedSent) return;
    terminatedSent = true;
    sendToClient({ seq: proxySeq++, type: 'event', event: 'terminated', body: {} });
  }

  function sendToDebugServer(message: unknown): void {
    if (!dapSocket || dapSocket.destroyed) throw new Error('Debug server socket closed');
    dapSocket.write(encode(message));
  }

  function sendNativeRequest(
    command: string,
    args: Record<string, unknown> = {},
    timeoutMs = 15000,
  ): Promise<DapResponseMessage> {
    if (!dapSocket || dapSocket.destroyed) {
      return Promise.reject(new Error(`Cannot send ${command}: debug server socket closed`));
    }
    const seq = nextNativeSeq++;
    const { promise, resolve, reject } = Promise.withResolvers<DapResponseMessage>();
    const timer = setTimeout(() => {
      nativePending.delete(seq);
      reject(new Error(`Native DAP request ${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    nativePending.set(seq, { command, resolve, reject, timer });
    try {
      sendToDebugServer({ seq, type: 'request', command, arguments: args });
    } catch (error: unknown) {
      nativePending.delete(seq);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  function shutdown(exitCode = 0, closingRequest?: DapRequestMessage): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    isShuttingDown = true;
    phase = 'cleaning';
    shutdownPromise = (async () => {
      clearTimeout(shutdownTimer);
      sessionAbortController.abort(new Error('Session shutdown'));
      if (!lspSession) lspInitializationController.abort(new Error('Session shutdown'));
      // A claim owns resources even when shutdown wins the response race.
      await androidClaim?.catch(() => {});
      connectingSocket?.destroy();
      for (const pending of nativePending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Session shutdown'));
      }
      nativePending.clear();
      for (const request of nativeSeqToClientSeq.values()) {
        respond(request, false, undefined, 'Debug session closed');
      }
      nativeSeqToClientSeq.clear();

      if (dapSocket && !dapSocket.destroyed && backendInitialized) {
        if (sessionMode === 'launch' && !backendTerminated) {
          try {
            await sendNativeRequest('terminate', {}, 3000);
          } catch {
            // The target may have already exited.
          }
        }
        try {
          const cleanupDeadline = Date.now() + 15000;
          if (!dapSocket.destroyed) {
            await sendNativeRequest(
              'disconnect',
              {
                terminateDebuggee: sessionMode === 'launch',
                suspendDebuggee: false,
              },
              15000,
            );
          }
          const deadline = Promise.withResolvers<never>();
          const timer = setTimeout(
            () => deadline.reject(new Error('IntelliJ debugger teardown timed out')),
            Math.max(1, cleanupDeadline - Date.now()),
          );
          try {
            const transportClosed = await Promise.race([backendClosed, deadline.promise]);
            if (!transportClosed) throw new Error('IntelliJ debugger transport closed abnormally');
          } finally {
            clearTimeout(timer);
          }
        } catch (error: unknown) {
          // IntelliJ may close its DAP transport after teardown before flushing the response.
          if (!(error instanceof NativeDisconnectCompleted)) {
            cleanupError = `IntelliJ debugger cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
            output(`${cleanupError}\n`);
            exitCode = 1;
          }
        }
      }
      if (sessionMode === 'launch' && activeRunMarker) {
        try {
          await terminateMarkedProcess(activeRunMarker, activeJavaExec ?? undefined, 3000);
        } catch (error: unknown) {
          cleanupError = error instanceof Error ? error.message : String(error);
          console.error(
            `Failed to terminate owned JVM: ${error instanceof Error ? error.message : String(error)}`,
          );
          exitCode = 1;
        }
      }
      dapSocket?.destroy();
      entryFunctionBreakpointOwned = false;
      backendInitialized = false;
      if (lspSession && androidCleanupKey) {
        const key = androidCleanupKey;
        androidCleanupKey = null;
        try {
          await releaseAndroidDebug(lspSession, key, 10000);
        } catch (error: unknown) {
          cleanupError = `Android debugger cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
          output(`${cleanupError}\n`);
          exitCode = 1;
        }
      }
      if (lspSession) {
        const session = lspSession;
        lspSession = null;
        try {
          await session.close();
        } catch (error: unknown) {
          console.error(`Failed to close LSP session: ${String(error)}`);
        }
      }
      cleanupListeners();
      phase = debugError || cleanupError ? 'failed' : 'closed';
      await debugControl?.close(Boolean(debugError || cleanupError)).catch((error: unknown) => {
        cleanupError = `Unable to close debugger control: ${String(error)}`;
        phase = 'failed';
        exitCode = 1;
      });
      finalExitCode = exitCode;
      finishStartup(
        false,
        undefined,
        debugError ?? cleanupError ?? 'Debug session closed before startup completed',
      );
      if (closingRequest) respond(closingRequest, !cleanupError, undefined, cleanupError);
      if (!deferExit) {
        if (sessionMode) sendTerminated();
        onExit(exitCode);
      }
    })();
    return shutdownPromise;
  }

  function scheduleShutdown(exitCode = 0): void {
    if (shutdownTimer || isShuttingDown) return;
    shutdownTimer = setTimeout(() => void shutdown(exitCode), 200);
  }

  const onStdinEnd = () => void shutdown(0);
  const onStdinClose = () => void shutdown(0);
  const onSigint = () => void shutdown(0);
  const onSigterm = () => void shutdown(0);
  const isProcessStdin = stdin === process.stdin;
  stdin.on('end', onStdinEnd);
  stdin.on('close', onStdinClose);
  if (isProcessStdin) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  }

  function cleanupListeners(): void {
    stdin.off('end', onStdinEnd);
    stdin.off('close', onStdinClose);
    stdin.off('data', onData);
    if (isProcessStdin) {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    }
  }

  function handleDebugServerMessage(rawMessage: unknown): void {
    if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) return;
    const msg = rawMessage as Record<string, unknown>;
    if (msg.type === 'response') {
      const requestSeq = typeof msg.request_seq === 'number' ? msg.request_seq : -1;
      const pending = nativePending.get(requestSeq);
      if (pending) {
        nativePending.delete(requestSeq);
        clearTimeout(pending.timer);
        if (msg.success === true) {
          pending.resolve({
            seq: typeof msg.seq === 'number' ? msg.seq : 0,
            type: 'response',
            request_seq: requestSeq,
            command: typeof msg.command === 'string' ? msg.command : '',
            success: true,
            body: msg.body,
          });
        } else {
          pending.reject(
            new Error(
              typeof msg.message === 'string'
                ? msg.message
                : `Native ${String(msg.command)} failed`,
            ),
          );
        }
        return;
      }
      const request = nativeSeqToClientSeq.get(requestSeq);
      if (request) {
        nativeSeqToClientSeq.delete(requestSeq);
        if (
          request.command === 'evaluate' &&
          msg.success === true &&
          msg.body &&
          typeof msg.body === 'object' &&
          'result' in msg.body &&
          typeof (msg.body as Record<string, unknown>).result === 'string' &&
          EVAL_ERROR_SENTINELS[(msg.body as Record<string, unknown>).result as string]
        ) {
          msg.success = false;
          msg.message = (msg.body as Record<string, unknown>).result as string;
        }
        sendToClient({ ...msg, seq: proxySeq++, request_seq: request.seq });
      }
    } else if (msg.type === 'event') {
      if (isShuttingDown) return;
      if (msg.event === 'stopped') phase = 'stopped';
      if (msg.event === 'continued') phase = 'running';
      if (msg.event === 'initialized') {
        nativeInitializedEvent = true;
        flushConfigurationDone();
      }
      if (msg.event === 'stopped' && entryFunctionBreakpointOwned) {
        entryFunctionBreakpointOwned = false;
        void sendNativeRequest('setFunctionBreakpoints', { breakpoints: [] }).catch(
          (error: unknown) => {
            output(`Unable to remove test entry breakpoint: ${String(error)}\n`);
          },
        );
      }
      if (
        isTestLaunch &&
        msg.event === 'exited' &&
        msg.body &&
        typeof msg.body === 'object' &&
        'exitCode' in msg.body &&
        typeof msg.body.exitCode === 'number'
      ) {
        output(`IntelliJ tests exited with code ${msg.body.exitCode}\n`, 'console');
      }
      if (msg.event === 'terminated') {
        if (backendTerminated) return;
        if (sessionMode === 'attach' && startupRequest) {
          debugError = 'JDWP connection ended before attach completed';
        }
        backendTerminated = true;
        scheduleShutdown();
        return;
      }
      sendToClient({ ...msg, seq: proxySeq++ });
    } else if (msg.type === 'request') {
      sendToDebugServer({
        seq: nextNativeSeq++,
        type: 'response',
        request_seq: typeof msg.seq === 'number' ? msg.seq : 0,
        command: typeof msg.command === 'string' ? msg.command : '',
        success: false,
        message: 'Reverse request not supported by proxy',
      });
    }
  }

  async function openProject(projectRoot: string): Promise<LspSession> {
    const session = await openLspSession(projectRoot, {
      signal: lspInitializationController.signal,
    });
    if (isShuttingDown) {
      await session.close();
      throw new Error('Session shutdown');
    }
    lspSession = session;
    return session;
  }

  async function connectBackend(): Promise<void> {
    if (!lspSession) throw new Error('LSP session not active');
    const provider = lspSession.serverCapabilities?.executeCommandProvider;
    const commands =
      provider && typeof provider === 'object' && !Array.isArray(provider) && 'commands' in provider
        ? provider.commands
        : undefined;
    if (Array.isArray(commands) && !commands.includes('start_debug_server')) {
      throw new Error('IntelliJ server does not support start_debug_server');
    }
    phase = 'connecting-dap';
    const port = await startDebugServer(lspSession, lspSession.rootUri);
    backendPort = port;
    const signal = sessionAbortController.signal;
    signal.throwIfAborted();
    const socket = net.createConnection({ host: '127.0.0.1', port });
    connectingSocket = socket;
    const {
      promise: connected,
      resolve: resolveSocket,
      reject: rejectSocket,
    } = Promise.withResolvers<void>();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
      socket.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      cleanup();
      socket.destroy();
      rejectSocket(error);
    };
    const onConnect = () => {
      cleanup();
      resolveSocket();
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Error('Debug server closed before connection completed'));
    const onAbort = () => fail(new Error('Debug server connection cancelled'));
    const timer = setTimeout(
      () =>
        fail(
          new Error(`Connecting to native debug server on 127.0.0.1:${port} timed out after 10s`),
        ),
      10000,
    );
    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    await connected;
    connectingSocket = null;
    signal.throwIfAborted();
    dapSocket = socket;
    const closure = Promise.withResolvers<boolean>();
    backendClosed = closure.promise;
    socket.on('data', frameParser(handleDebugServerMessage));
    let backendEndedCleanly = false;
    socket.once('end', () => {
      backendEndedCleanly = true;
    });
    socket.once('close', (hadError) => {
      closure.resolve(backendEndedCleanly && !hadError);
      for (const pending of nativePending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          isShuttingDown && backendEndedCleanly && !hadError && pending.command === 'disconnect'
            ? new NativeDisconnectCompleted(
                'IntelliJ closed the debugger transport after disconnect',
              )
            : new Error('Debug server socket closed'),
        );
      }
      nativePending.clear();
      if (!isShuttingDown) {
        debugError ??= startupRequest
          ? 'Debug server closed before startup completed'
          : backendTerminated
            ? undefined
            : 'IntelliJ debugger connection closed unexpectedly';
        void shutdown(debugError ? 1 : 0);
      }
    });
    socket.on('error', (error: Error) => {
      if (isShuttingDown) return;
      debugError ??= error.message;
      void shutdown(1);
    });
    const initialized = await sendNativeRequest('initialize', {
      clientID: 'omp',
      clientName: 'OMP',
      adapterID: 'intellij_jvm',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsRunInTerminalRequest: false,
    });
    supportsFunctionBreakpoints =
      !!initialized.body &&
      typeof initialized.body === 'object' &&
      'supportsFunctionBreakpoints' in initialized.body &&
      initialized.body.supportsFunctionBreakpoints === true;
    supportsThreadDump =
      !!initialized.body &&
      typeof initialized.body === 'object' &&
      'supportsThreadDumpRequest' in initialized.body &&
      initialized.body.supportsThreadDumpRequest === true;
    if (initialized.body) {
      sendToClient({
        seq: proxySeq++,
        type: 'event',
        event: 'capabilities',
        body: { capabilities: initialized.body },
      });
    }
  }

  function emitBreakpoints(response: DapResponseMessage, reason: string): void {
    if (!response.body || typeof response.body !== 'object' || !('breakpoints' in response.body)) {
      return;
    }
    if (!Array.isArray(response.body.breakpoints)) return;
    for (const breakpoint of response.body.breakpoints) {
      sendToClient({
        seq: proxySeq++,
        type: 'event',
        event: 'breakpoint',
        body: { reason, breakpoint },
      });
    }
  }

  async function replayBreakpoints(): Promise<void> {
    while (bufferedBreakpoints.size > 0) {
      const first = bufferedBreakpoints.entries().next().value;
      if (!first) break;
      const [sourcePath, args] = first;
      bufferedBreakpoints.delete(sourcePath);
      emitBreakpoints(await sendNativeRequest('setBreakpoints', args, 10000), 'changed');
    }
    while (bufferedExceptionBreakpoints) {
      const args = bufferedExceptionBreakpoints;
      bufferedExceptionBreakpoints = null;
      await sendNativeRequest('setExceptionBreakpoints', args, 10000);
    }
    backendInitialized = true;
  }

  function flushConfigurationDone(): void {
    if (
      !backendInitialized ||
      !nativeInitializedEvent ||
      !startupSent ||
      !clientConfigurationDone ||
      configurationForwarded
    ) {
      return;
    }
    configurationForwarded = true;
    void sendNativeRequest('configurationDone').catch((error: unknown) => {
      if (isShuttingDown) return;
      const reason = error instanceof Error ? error.message : String(error);
      finishStartup(false, undefined, reason);
      output(`Configuration error: ${reason}\n`);
      void shutdown(1);
    });
  }

  async function waitForJvm(deadline: number): Promise<void> {
    if (!supportsThreadDump) {
      throw new Error('IntelliJ backend does not support threadDump readiness checks');
    }
    while (!isShuttingDown && !backendTerminated) {
      sessionAbortController.signal.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const response = await sendNativeRequest('intellij/threadDump', {}, remaining);
        if (
          response.body &&
          typeof response.body === 'object' &&
          'text' in response.body &&
          typeof response.body.text === 'string' &&
          response.body.text.trim().length > 0
        ) {
          return;
        }
      } catch (error: unknown) {
        // The backend publishes its session asynchronously after acknowledging attach.
        if (!(error instanceof Error) || error.message !== 'No debug session is attached') {
          throw error;
        }
      }
      await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, {
        signal: sessionAbortController.signal,
      });
    }
    throw new Error('JDWP connection did not become ready before the deadline or target exit');
  }

  async function startNative(
    command: 'launch' | 'attach',
    args: Record<string, unknown>,
    timeoutMs = 15000,
  ): Promise<void> {
    sessionAbortController.signal.throwIfAborted();
    phase = 'connecting-jvm';
    startupSent = true;
    const deadline = Date.now() + timeoutMs;
    const response = sendNativeRequest(command, args, timeoutMs);
    flushConfigurationDone();
    const result = await response;
    if (command === 'attach') await waitForJvm(deadline);
    if (!isShuttingDown) markRunning();
    if (!isShuttingDown) finishStartup(true, result.body);
  }

  async function handleClientMessage(rawMessage: unknown): Promise<void> {
    if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) return;
    const raw = rawMessage as Record<string, unknown>;
    if (raw.type !== 'request') return;
    const command = typeof raw.command === 'string' ? raw.command : '';
    const args =
      raw.arguments && typeof raw.arguments === 'object' && !Array.isArray(raw.arguments)
        ? (raw.arguments as Record<string, unknown>)
        : {};
    const request: DapRequestMessage = {
      seq: typeof raw.seq === 'number' ? raw.seq : 0,
      type: 'request',
      command,
      arguments: args,
    };
    if (command === 'omp/intellij/status') {
      respond(request, true, snapshot());
      return;
    }
    if (isShuttingDown) {
      respond(request, false, undefined, 'Debug session closed');
      return;
    }
    if (command === 'initialize') {
      respond(request, true, {
        supportsConfigurationDoneRequest: true,
        supportsConditionalBreakpoints: true,
        supportsDelayedStackTraceLoading: true,
        supportTerminateDebuggee: true,
        supportsTerminateRequest: true,
      });
      return;
    }
    if (command === 'setBreakpoints' && !backendInitialized) {
      const source =
        args.source && typeof args.source === 'object' && !Array.isArray(args.source)
          ? (args.source as Record<string, unknown>)
          : undefined;
      if (typeof source?.path === 'string') bufferedBreakpoints.set(source.path, args);
      const breakpoints = Array.isArray(args.breakpoints) ? args.breakpoints : [];
      hasClientBreakpoints ||= breakpoints.length > 0;
      respond(request, true, {
        breakpoints: breakpoints.map((breakpoint: unknown) => ({
          verified: false,
          line:
            breakpoint && typeof breakpoint === 'object' && 'line' in breakpoint
              ? breakpoint.line
              : 0,
          message: 'Pending native debug server initialization',
        })),
      });
      return;
    }
    if (command === 'setExceptionBreakpoints' && !backendInitialized) {
      bufferedExceptionBreakpoints = args;
      respond(request, true);
      return;
    }
    if (command === 'configurationDone') {
      clientConfigurationDone = true;
      respond(request, true);
      flushConfigurationDone();
      return;
    }
    if (command === 'setFunctionBreakpoints') entryFunctionBreakpointOwned = false;
    if (command === 'terminate' || command === 'disconnect') {
      void shutdown(0, request);
      return;
    }
    if (command === 'launch' || command === 'attach') {
      if (isStarting || dapSocket) {
        respond(request, false, undefined, 'Debug session already starting or active');
        return;
      }
      const explicitCwd = typeof args.cwd === 'string' && args.cwd ? resolve(args.cwd) : undefined;
      const targetCwd = explicitCwd ?? process.cwd();
      let resolvedFile: string | null = null;
      let hostName = '127.0.0.1';
      let attachTimeout = 30000;
      if (command === 'attach') {
        if (
          !Number.isSafeInteger(args.port) ||
          Number(args.port) < 1 ||
          Number(args.port) > 65535
        ) {
          respond(
            request,
            false,
            undefined,
            'IntelliJ attach requires a JDWP port between 1 and 65535',
          );
          return;
        }
        const rawHost = args.host ?? args.hostName ?? '127.0.0.1';
        if (typeof rawHost !== 'string' || !rawHost.trim()) {
          respond(request, false, undefined, 'IntelliJ attach requires a non-empty host');
          return;
        }
        const hostResult = normalizeAttachHost(rawHost);
        if ('error' in hostResult) {
          respond(request, false, undefined, hostResult.error);
          return;
        }
        hostName = hostResult.host;
        if (args.timeout !== undefined) {
          if (
            typeof args.timeout !== 'number' ||
            !Number.isFinite(args.timeout) ||
            args.timeout <= 0
          ) {
            respond(request, false, undefined, 'IntelliJ attach timeout must be a positive number');
            return;
          }
          attachTimeout =
            args.timeout <= 300 ? Math.round(args.timeout * 1000) : Math.round(args.timeout);
        }
      } else {
        if (
          args.timeout !== undefined &&
          (typeof args.timeout !== 'number' || !Number.isFinite(args.timeout) || args.timeout <= 0)
        ) {
          respond(request, false, undefined, 'IntelliJ launch timeout must be a positive number');
          return;
        }
        const program =
          typeof args.program === 'string'
            ? args.program
            : typeof args.file === 'string'
              ? args.file
              : undefined;
        if (!program) {
          respond(request, false, undefined, 'DAP launch requires program or file parameter');
          return;
        }
        resolvedFile = resolveSourceFile(targetCwd, program);
        if (!resolvedFile) {
          respond(request, false, undefined, `Unable to resolve source file for ${program}`);
          return;
        }
      }
      isStarting = true;
      sessionMode = command;
      startupRequest = request;
      isTestLaunch = command === 'launch' && args.testMode === true;
      try {
        const explicitProject = typeof args.project === 'string' ? args.project : undefined;
        projectRoot = detectProjectRoot(resolvedFile ?? targetCwd, explicitProject);
        phase = 'connecting-lsp';
        debugControl = await createDebugControl({
          systemPath: options.systemPath ?? settings.systemPath,
          projectRoot,
          getStatus: snapshot,
          recover: async () => {
            deferExit = true;
            await shutdown();
            if (cleanupError) throw new Error(cleanupError);
          },
          onRecovered: () => {
            if (sessionMode) sendTerminated();
            onExit(finalExitCode);
          },
        });
        if (isShuttingDown) {
          await debugControl.close();
          return;
        }
        if (command === 'attach') {
          const session = await openProject(projectRoot);
          if (
            isLoopbackHost(hostName) &&
            supportsAndroidDebugCommand(session, ANDROID_DEBUG_COMMANDS.claim)
          ) {
            androidClaim = claimAndroidDebug(session, {
              host: hostName,
              port: Number(args.port),
            }).then((result) => {
              if (result.claimed) androidCleanupKey = result.cleanupKey;
            });
            await androidClaim;
          }
          sessionAbortController.signal.throwIfAborted();
          await connectBackend();
          if (!supportsThreadDump) {
            throw new Error('IntelliJ backend does not support threadDump readiness checks');
          }
          await replayBreakpoints();
          // OMP sends configurationDone after attach replies; JDWP needs it before confirming.
          clientConfigurationDone = true;
          await startNative(
            'attach',
            {
              type: 'intellij_jvm',
              request: 'attach',
              hostName,
              port: args.port,
              timeout: attachTimeout,
            },
            attachTimeout + 5000,
          );
          return;
        }
        if (!resolvedFile) throw new Error('Launch source file is missing');
        let fileContent: string;
        try {
          fileContent = await readFile(resolvedFile, 'utf8');
        } catch (error: unknown) {
          throw new Error(`Unable to read source file at ${resolvedFile}: ${String(error)}`);
        }
        const session = await openProject(projectRoot);
        const fileUri = toLspFileUri(resolvedFile, session.rootUri);
        session.notify('textDocument/didOpen', {
          textDocument: {
            uri: fileUri,
            languageId: resolvedFile.endsWith('.kt') ? 'kotlin' : 'java',
            version: 1,
            text: fileContent,
          },
        });
        let mainClass = typeof args.mainClass === 'string' ? args.mainClass : undefined;
        let mainLine: number | null = null;
        if (!isTestLaunch && !mainClass) {
          const main = await resolveMainFromLsp(session, fileUri);
          mainClass = main?.mainClass;
          mainLine = main?.line ?? null;
        }
        if (!isTestLaunch && !mainClass) {
          throw new Error(
            `Could not determine JVM mainClass from ${resolvedFile}; please specify mainClass explicitly`,
          );
        }
        const isGradleLaunch = args.buildTool === 'gradle';
        const gradleArgs = args.gradleArgs ?? [];
        if (isGradleLaunch) {
          if (isTestLaunch)
            throw new Error('Gradle launch expects a main class, not a test target');
          if (!Array.isArray(gradleArgs) || !gradleArgs.every((arg) => typeof arg === 'string')) {
            throw new Error('gradleArgs must be an array of strings');
          }
        }
        if (args.build !== false && !isGradleLaunch) {
          output(`--- IntelliJ: resolving build for ${basename(resolvedFile)} ---\n`, 'console');
          const build = await resolveBuildCommand(session, fileUri);
          if (!build || build.supported === false) {
            throw new Error(
              `Build unsupported for ${resolvedFile}: ${build?.reason || 'Server reports build unsupported for this module'}`,
            );
          }
          if (!Array.isArray(build.command) || build.command.length === 0) {
            throw new Error(`Build command empty for ${resolvedFile}`);
          }
          await executeBuild(build, {
            signal: sessionAbortController.signal,
            onOutput: (event) => output(event.output, event.category),
          });
        }
        sessionAbortController.signal.throwIfAborted();
        let paths: LaunchPaths;
        let applicationArgs: unknown[] = Array.isArray(args.args) ? args.args : [];
        if (isTestLaunch) {
          const testIds = args.args ?? [];
          if (
            !Array.isArray(testIds) ||
            !testIds.every((id): id is string => typeof id === 'string')
          ) {
            throw new Error('Test IDs must be an array of strings');
          }
          const target = await resolveTestTarget(session, fileUri, testIds);
          mainClass = target.mainClass;
          applicationArgs = target.args;
          paths = target.paths;
        } else {
          paths = await resolveLaunch(session, fileUri);
        }
        if (!paths?.javaExec) {
          throw new Error(`Launch resolution returned no java executable for ${resolvedFile}`);
        }
        await connectBackend();
        await replayBreakpoints();
        const stopOnEntry =
          args.stopOnEntry !== undefined ? Boolean(args.stopOnEntry) : args.noDebug !== true;
        if (isTestLaunch && stopOnEntry && args.noDebug !== true) {
          if (!supportsFunctionBreakpoints) {
            throw new Error('Unable to pause test runner at entry');
          }
          try {
            await sendNativeRequest('setFunctionBreakpoints', {
              breakpoints: [{ name: `${mainClass}.main` }],
            });
            entryFunctionBreakpointOwned = true;
          } catch (error: unknown) {
            throw new Error('Unable to pause test runner at entry', { cause: error });
          }
        } else if (!isTestLaunch && !hasClientBreakpoints && stopOnEntry) {
          const entryLine = mainLine || findMainMethodLine(fileContent);
          if (entryLine) {
            emitBreakpoints(
              await sendNativeRequest(
                'setBreakpoints',
                { source: { path: resolvedFile }, breakpoints: [{ line: entryLine }] },
                10000,
              ),
              'new',
            );
          }
        }
        activeRunMarker = randomUUID();
        activeJavaExec = paths.javaExec;
        const extraVmArgs = Array.isArray(args.vmArgs)
          ? args.vmArgs.filter((arg): arg is string => typeof arg === 'string')
          : [];
        if (args.noDebug === true) clientConfigurationDone = true;
        await startNative(
          'launch',
          {
            type: isGradleLaunch ? 'intellij_gradle' : 'intellij_jvm',
            request: 'launch',
            name: mainClass,
            mainClass,
            file: fileUri,
            tool: isGradleLaunch ? 'gradle' : 'java',
            ...(isGradleLaunch
              ? {
                  projectPath: typeof args.projectPath === 'string' ? args.projectPath : undefined,
                  sourceSet: typeof args.sourceSet === 'string' ? args.sourceSet : undefined,
                  toolArgs: gradleArgs,
                }
              : {}),
            classPaths: paths.classpath || [],
            modulePaths: paths.modulePath || [],
            moduleContentPaths: paths.moduleContentPaths || [],
            javaExec: paths.javaExec,
            vmArgs: [
              ...(paths.vmArgs || []),
              ...extraVmArgs,
              `-Domp.intellij.run.id=${activeRunMarker}`,
            ],
            args: applicationArgs,
            env:
              args.env && typeof args.env === 'object' && !Array.isArray(args.env) ? args.env : {},
            cwd: explicitCwd ?? paths.workingDirectory ?? projectRoot,
            console: 'internalConsole',
            noDebug: args.noDebug === true,
            stopOnEntry,
          },
          typeof args.timeout === 'number' && Number.isFinite(args.timeout) && args.timeout > 0
            ? args.timeout <= 300
              ? Math.round(args.timeout * 1000)
              : Math.round(args.timeout)
            : isGradleLaunch
              ? (settings.requestWaitTimeoutMs ?? 300000)
              : 15000,
        );
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!isShuttingDown) {
          debugError = reason;
          output(`${command === 'attach' ? 'Attach' : 'Launch'} error: ${reason}\n`);
          void shutdown(1);
        }
      }
      return;
    }
    if (backendInitialized && dapSocket && !dapSocket.destroyed) {
      const nativeSeq = nextNativeSeq++;
      nativeSeqToClientSeq.set(nativeSeq, request);
      sendToDebugServer({ ...raw, seq: nativeSeq });
    } else {
      respond(request, false, undefined, 'Debug session not active');
    }
  }

  const onData = frameParser((message: unknown) => {
    void handleClientMessage(message).catch((error: unknown) => {
      console.error(`DAP client request failed: ${String(error)}`);
      void shutdown(1);
    });
  });
  stdin.on('data', onData);
  return {
    shutdown,
    abortController: sessionAbortController,
    getProxySeq: () => proxySeq,
    isShuttingDown: () => isShuttingDown,
  };
}

/**
 * CLI runner for dap-proxy.
 */
export function startDapProxyCli(): void {
  if (process.argv.includes('--run')) {
    const fileIdx = process.argv.indexOf('--file');
    let file = fileIdx !== -1 ? process.argv[fileIdx + 1] : undefined;
    if (!file) {
      file = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
    }
    if (!file || file.startsWith('--')) {
      console.error('Usage: omp-intellij-dap --run --file <path>');
      process.exit(1);
    }
    runMain(
      { file: resolve(process.cwd(), file) },
      {
        onOutput: (e) => process.stdout.write(e.output),
      },
    )
      .then((res) => process.exit(res.exitCode))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Run failed: ${msg}`);
        process.exit(1);
      });
    return;
  }

  startDapProxy();
}

if (isDirectExecution()) {
  startDapProxyCli();
}
