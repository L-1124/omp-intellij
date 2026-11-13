#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { settings } from '../server/service.js';
import { encode, frameParser } from '../shared/protocol.js';
import {
  createDebugControl,
  type DebugControlHandle,
  type DebugPhase,
  type DebugSnapshot,
  isLoopbackIPv6,
} from './control.js';
import {
  createLspSession,
  detectProjectRoot,
  findMainMethodLine,
  type LspSession,
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

export function normalizeSourcePaths(obj: unknown, format: 'path' | 'uri' = 'path'): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) normalizeSourcePaths(item, format);
    return obj;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (key === 'path' && typeof value === 'string') {
      if (format === 'path' && value.startsWith('file://')) {
        try {
          record[key] = fileURLToPath(value.replace(/%3A/gi, ':'));
        } catch {
          // Preserve non-file sources and malformed URIs for the adapter.
        }
      } else if (format === 'uri' && isAbsolute(value)) {
        record[key] = pathToFileURL(value).href;
      }
    } else if (value && typeof value === 'object' && key !== 'adapterData' && key !== 'data') {
      normalizeSourcePaths(value, format);
    }
  }
  return obj;
}

function convertPositions(value: unknown, lineDelta: number, columnDelta: number): void {
  if (!value || typeof value !== 'object' || (!lineDelta && !columnDelta)) return;
  if (Array.isArray(value)) {
    for (const item of value) convertPositions(item, lineDelta, columnDelta);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const position = record[key];
    const delta =
      key === 'line' || key === 'endLine'
        ? lineDelta
        : key === 'column' || key === 'endColumn'
          ? columnDelta
          : 0;
    if (delta && typeof position === 'number' && (delta > 0 || position > 0)) {
      record[key] = position + delta;
    } else if (key === 'lines' && Array.isArray(position) && lineDelta) {
      record[key] = position.map((line) =>
        typeof line === 'number' && (lineDelta > 0 || line > 0) ? line + lineDelta : line,
      );
    } else if (
      key === 'breakpoints' ||
      key === 'breakpoint' ||
      key === 'stackFrames' ||
      key === 'targets' ||
      key === 'instructions' ||
      key === 'scopes' ||
      key === 'source' ||
      key === 'sources' ||
      key === 'locations' ||
      key === 'location'
    ) {
      convertPositions(position, lineDelta, columnDelta);
    }
  }
}

const PROXY_INITIAL_CAPABILITIES = {
  supportsConfigurationDoneRequest: true,
  supportsTerminateRequest: false,
  supportTerminateDebuggee: false,
  supportSuspendDebuggee: false,
  supportsCancelRequest: false,
};

const BREAKPOINT_FEATURES = [
  ['condition', 'supportsConditionalBreakpoints'],
  ['hitCondition', 'supportsHitConditionalBreakpoints'],
  ['logMessage', 'supportsLogPoints'],
] as const;

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
  let isAndroidSession = false;
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
  let hasClientBreakpoints = false;
  let isTestLaunch = false;
  let supportsFunctionBreakpoints = false;
  let entryFunctionBreakpointOwned = false;
  let supportsThreadDump = false;
  let supportsConfigurationDone = false;
  let clientInitializeArgs: Record<string, unknown> | null = null;
  let clientPathFormat: 'path' | 'uri' = 'path';
  let clientLineDelta = 0;
  let clientColumnDelta = 0;
  let clientVariableType = false;
  const nativeCapabilities: Record<string, unknown> = {};
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
      clientSeq?: number;
    }
  >();
  const nativeSeqToClientSeq = new Map<number, DapRequestMessage>();
  const clientSeqToNativeSeq = new Map<number, number>();
  const bufferedBreakpoints = new Map<string, { args: Record<string, unknown>; ids: number[] }>();
  const nativeBreakpointIds = new Map<number, number>();
  const deferredBreakpointEvents: Record<string, unknown>[] = [];
  let nextBreakpointId = 1;
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
    if (msg && typeof msg === 'object' && 'body' in msg) {
      convertPositions(msg.body, -clientLineDelta, -clientColumnDelta);
      if (
        !clientVariableType &&
        'command' in msg &&
        msg.command === 'variables' &&
        msg.body &&
        typeof msg.body === 'object' &&
        'variables' in msg.body &&
        Array.isArray(msg.body.variables)
      ) {
        for (const variable of msg.body.variables) {
          if (variable && typeof variable === 'object' && 'type' in variable) delete variable.type;
        }
      }
    }
    stdout.write(encode(normalizeSourcePaths(msg, clientPathFormat)));
  }

  function updateCapabilities(body: unknown): Record<string, unknown> {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      Object.assign(nativeCapabilities, body);
    }
    supportsFunctionBreakpoints = nativeCapabilities.supportsFunctionBreakpoints === true;
    supportsThreadDump = nativeCapabilities.supportsThreadDumpRequest === true;
    supportsConfigurationDone = nativeCapabilities.supportsConfigurationDoneRequest === true;
    return {
      ...PROXY_INITIAL_CAPABILITIES,
      ...nativeCapabilities,
      supportsConfigurationDoneRequest: true,
      supportSuspendDebuggee: false,
    };
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
    clientSeq?: number,
  ): Promise<DapResponseMessage> {
    if (!dapSocket || dapSocket.destroyed) {
      return Promise.reject(new Error(`Cannot send ${command}: debug server socket closed`));
    }
    const seq = nextNativeSeq++;
    const { promise, resolve, reject } = Promise.withResolvers<DapResponseMessage>();
    const timer = setTimeout(() => {
      nativePending.delete(seq);
      if (clientSeq !== undefined) clientSeqToNativeSeq.delete(clientSeq);
      reject(new Error(`Native DAP request ${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    nativePending.set(seq, { command, resolve, reject, timer, clientSeq });
    if (clientSeq !== undefined) clientSeqToNativeSeq.set(clientSeq, seq);
    try {
      sendToDebugServer({ seq, type: 'request', command, arguments: args });
    } catch (error: unknown) {
      nativePending.delete(seq);
      if (clientSeq !== undefined) clientSeqToNativeSeq.delete(clientSeq);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  function forwardClientRequest(
    req: DapRequestMessage,
    forwardedArgs?: Record<string, unknown>,
  ): void {
    const nativeSeq = nextNativeSeq++;
    nativeSeqToClientSeq.set(nativeSeq, req);
    clientSeqToNativeSeq.set(req.seq, nativeSeq);
    try {
      sendToDebugServer({
        ...req,
        seq: nativeSeq,
        ...(forwardedArgs !== undefined ? { arguments: forwardedArgs } : {}),
      });
    } catch (error: unknown) {
      nativeSeqToClientSeq.delete(nativeSeq);
      clientSeqToNativeSeq.delete(req.seq);
      throw error;
    }
  }
  function shutdown(
    exitCode = 0,
    closingRequest?: DapRequestMessage,
    disconnectArgs?: Record<string, unknown>,
  ): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    isShuttingDown = true;
    phase = 'cleaning';
    shutdownPromise = (async () => {
      clearTimeout(shutdownTimer);
      sessionAbortController.abort(new Error('Session shutdown'));
      if (!lspSession) lspInitializationController.abort(new Error('Session shutdown'));
      connectingSocket?.destroy();
      for (const pending of nativePending.values()) {
        clearTimeout(pending.timer);
        if (pending.clientSeq !== undefined) clientSeqToNativeSeq.delete(pending.clientSeq);
        pending.reject(new Error('Session shutdown'));
      }
      nativePending.clear();
      for (const request of nativeSeqToClientSeq.values()) {
        clientSeqToNativeSeq.delete(request.seq);
        respond(request, false, undefined, 'Debug session closed');
      }
      nativeSeqToClientSeq.clear();
      clientSeqToNativeSeq.clear();

      if (dapSocket && !dapSocket.destroyed && backendInitialized) {
        if (isAndroidSession) {
          if (closingRequest?.command === 'disconnect') {
            try {
              // AndroidDapSession completes cleanup before responding and keeps the socket open until client EOF.
              await sendNativeRequest('disconnect', disconnectArgs ?? {}, 15000);
            } catch (error: unknown) {
              if (!(error instanceof NativeDisconnectCompleted)) {
                cleanupError = error instanceof Error ? error.message : String(error);
                output(`Android debugger cleanup failed: ${cleanupError}\n`);
                exitCode = 1;
              }
            }
          }
        } else {
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
              if (!transportClosed) {
                throw new Error('IntelliJ debugger transport closed abnormally');
              }
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
      }
      if (sessionMode === 'launch' && activeRunMarker) {
        try {
          await terminateMarkedProcess(activeRunMarker, undefined, 3000);
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
        if (pending.clientSeq !== undefined) clientSeqToNativeSeq.delete(pending.clientSeq);
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
        clientSeqToNativeSeq.delete(request.seq);
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
        if (request.command.startsWith('set') && request.command.endsWith('Breakpoints')) {
          mapNativeBreakpointBody(msg.body);
        }
        sendToClient({ ...msg, seq: proxySeq++, request_seq: request.seq });
      }
    } else if (msg.type === 'event') {
      if (isShuttingDown) return;
      if (msg.event === 'breakpoint') {
        if (!backendInitialized) {
          deferredBreakpointEvents.push(msg);
          return;
        }
        mapNativeBreakpointBody(msg.body);
      }
      if (msg.event === 'stopped' && msg.body && typeof msg.body === 'object') {
        const body = msg.body as Record<string, unknown>;
        if (Array.isArray(body.hitBreakpointIds)) {
          body.hitBreakpointIds = body.hitBreakpointIds.map((id) =>
            typeof id === 'number' ? mapNativeBreakpointId(id) : id,
          );
        }
      }
      if (msg.event === 'capabilities' && msg.body && typeof msg.body === 'object') {
        const body = msg.body as Record<string, unknown>;
        body.capabilities = updateCapabilities(body.capabilities);
        flushConfigurationDone();
      }
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

  async function startAndroidDebugServer(session: LspSession, signal: AbortSignal): Promise<number> {
    const result = await session.request(
      'workspace/executeCommand',
      {
        command: 'org.intellij.android.debug.startServer',
        arguments: [{}],
      },
      undefined,
      signal,
    );
    const rawPort =
      result && typeof result === 'object' && !Array.isArray(result) && 'port' in result
        ? result.port
        : undefined;
    if (
      typeof rawPort !== 'number' ||
      !Number.isSafeInteger(rawPort) ||
      rawPort < 1 ||
      rawPort > 65535
    ) {
      throw new Error(`Invalid Android debug server port returned: ${JSON.stringify(result)}`);
    }
    return rawPort;
  }

  async function connectBackend(isAndroid = false): Promise<void> {
    if (!lspSession) throw new Error('LSP session not active');
    const startCommand = isAndroid ? 'org.intellij.android.debug.startServer' : 'start_debug_server';
    const provider = lspSession.serverCapabilities?.executeCommandProvider;
    const commands =
      provider && typeof provider === 'object' && !Array.isArray(provider) && 'commands' in provider
        ? provider.commands
        : undefined;
    if (Array.isArray(commands) && !commands.includes(startCommand)) {
      throw new Error(`IntelliJ server does not support ${startCommand}`);
    }
    phase = 'connecting-dap';
    const port = isAndroid
      ? await startAndroidDebugServer(lspSession, sessionAbortController.signal)
      : await startDebugServer(lspSession, lspSession.rootUri);
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
        if (pending.clientSeq !== undefined) clientSeqToNativeSeq.delete(pending.clientSeq);
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
      ...clientInitializeArgs,
      clientID: 'omp',
      clientName: 'OMP',
      adapterID: 'intellij_jvm',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: clientVariableType,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: false,
    });
    sendToClient({
      seq: proxySeq++,
      type: 'event',
      event: 'capabilities',
      body: { capabilities: updateCapabilities(initialized.body) },
    });
  }

  function mapNativeBreakpointId(nativeId: number, preferredId?: number): number {
    const id = preferredId ?? nativeBreakpointIds.get(nativeId) ?? nextBreakpointId++;
    nativeBreakpointIds.set(nativeId, id);
    return id;
  }

  function mapNativeBreakpoint(breakpoint: unknown, preferredId?: number): void {
    if (!breakpoint || typeof breakpoint !== 'object') return;
    const record = breakpoint as Record<string, unknown>;
    record.id =
      typeof record.id === 'number'
        ? mapNativeBreakpointId(record.id, preferredId)
        : (preferredId ?? nextBreakpointId++);
  }

  function mapNativeBreakpointBody(body: unknown): void {
    if (!body || typeof body !== 'object') return;
    if ('breakpoint' in body) mapNativeBreakpoint(body.breakpoint);
    if ('breakpoints' in body && Array.isArray(body.breakpoints)) {
      for (const breakpoint of body.breakpoints) mapNativeBreakpoint(breakpoint);
    }
  }

  function emitBreakpoints(response: DapResponseMessage, reason: string, ids?: number[]): void {
    if (!response.body || typeof response.body !== 'object' || !('breakpoints' in response.body)) {
      if (ids) throw new Error('Native debugger returned no breakpoint results');
      return;
    }
    if (!Array.isArray(response.body.breakpoints)) {
      if (ids) throw new Error('Native debugger returned invalid breakpoint results');
      return;
    }
    if (ids && response.body.breakpoints.length !== ids.length) {
      throw new Error('Native debugger returned a different number of breakpoints');
    }
    for (const [index, breakpoint] of response.body.breakpoints.entries()) {
      mapNativeBreakpoint(breakpoint, ids?.[index]);
      sendToClient({
        seq: proxySeq++,
        type: 'event',
        event: 'breakpoint',
        body: { reason, breakpoint },
      });
    }
  }

  function unsupportedBreakpointFeature(args: Record<string, unknown>): string | undefined {
    if (!Array.isArray(args.breakpoints)) return;
    for (const breakpoint of args.breakpoints) {
      if (!breakpoint || typeof breakpoint !== 'object') continue;
      for (const [field, capability] of BREAKPOINT_FEATURES) {
        if (
          typeof breakpoint[field] === 'string' &&
          breakpoint[field].length > 0 &&
          nativeCapabilities[capability] !== true
        )
          return `Native debugger does not support breakpoint ${field}`;
      }
    }
  }

  async function replayBreakpoints(): Promise<void> {
    while (bufferedBreakpoints.size > 0) {
      const first = bufferedBreakpoints.entries().next().value;
      if (!first) break;
      const [sourceKey, pending] = first;
      bufferedBreakpoints.delete(sourceKey);
      const unsupported = unsupportedBreakpointFeature(pending.args);
      if (unsupported) throw new Error(unsupported);
      emitBreakpoints(
        await sendNativeRequest('setBreakpoints', pending.args, 10000),
        'changed',
        pending.ids,
      );
    }
    while (bufferedExceptionBreakpoints) {
      const args = bufferedExceptionBreakpoints;
      bufferedExceptionBreakpoints = null;
      await sendNativeRequest('setExceptionBreakpoints', args, 10000);
    }
    backendInitialized = true;
    for (const event of deferredBreakpointEvents) handleDebugServerMessage(event);
    deferredBreakpointEvents.length = 0;
  }

  function flushConfigurationDone(): void {
    if (
      !supportsConfigurationDone ||
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
    const response = sendNativeRequest(command, args, timeoutMs, startupRequest?.seq);
    flushConfigurationDone();
    const result = await response;
    if (command === 'attach' && !isAndroidSession) await waitForJvm(deadline);
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
      if (clientInitializeArgs || isStarting || backendInitialized) {
        respond(request, false, undefined, 'Debug adapter already initialized');
        return;
      }
      if (
        args.pathFormat !== undefined &&
        args.pathFormat !== 'path' &&
        args.pathFormat !== 'uri'
      ) {
        respond(request, false, undefined, 'Unsupported path format');
        return;
      }
      clientInitializeArgs = args;
      clientPathFormat = args.pathFormat === 'uri' ? 'uri' : 'path';
      clientLineDelta = args.linesStartAt1 === false ? 1 : 0;
      clientColumnDelta = args.columnsStartAt1 === false ? 1 : 0;
      clientVariableType = args.supportsVariableType === true;
      respond(request, true, PROXY_INITIAL_CAPABILITIES);
      return;
    }
    if (command === 'cancel') {
      const rawRequestId = args.requestId;
      const hasRequestId = typeof rawRequestId === 'number' && Number.isInteger(rawRequestId);
      const hasProgressId = typeof args.progressId === 'string' && args.progressId.length > 0;
      if (
        isStarting &&
        startupRequest &&
        hasRequestId &&
        rawRequestId === startupRequest.seq &&
        !clientSeqToNativeSeq.has(startupRequest.seq)
      ) {
        respond(request, true);
        debugError = 'Startup cancelled';
        sessionAbortController.abort(new Error(debugError));
        if (!lspSession) lspInitializationController.abort(new Error(debugError));
        void shutdown(1);
        return;
      }
      if (hasRequestId) {
        const nativeRequestId = clientSeqToNativeSeq.get(rawRequestId);
        if (nativeRequestId !== undefined && backendInitialized && dapSocket && !dapSocket.destroyed) {
          forwardClientRequest(request, { ...args, requestId: nativeRequestId });
          return;
        }
        if (!hasProgressId) {
          respond(request, true);
          return;
        }
        if (backendInitialized && dapSocket && !dapSocket.destroyed) {
          const { requestId: _ignored, ...forwardedArgs } = args;
          forwardClientRequest(request, forwardedArgs);
          return;
        }
        respond(request, true);
        return;
      }
      if (hasProgressId && backendInitialized && dapSocket && !dapSocket.destroyed) {
        if (rawRequestId !== undefined) {
          const { requestId: _ignored, ...forwardedArgs } = args;
          forwardClientRequest(request, forwardedArgs);
        } else {
          forwardClientRequest(request, args);
        }
        return;
      }
      respond(request, true);
      return;
    }
    if (
      command === 'setBreakpoints' ||
      command === 'breakpointLocations' ||
      command === 'gotoTargets' ||
      command === 'source'
    ) {
      normalizeSourcePaths(args);
      convertPositions(args, clientLineDelta, clientColumnDelta);
    }
    if (command === 'setBreakpoints' && backendInitialized) {
      const unsupported = unsupportedBreakpointFeature(args);
      if (unsupported) {
        respond(request, false, undefined, unsupported);
        return;
      }
    }
    if (command === 'setBreakpoints' && !backendInitialized) {
      const source =
        args.source && typeof args.source === 'object' && !Array.isArray(args.source)
          ? (args.source as Record<string, unknown>)
          : undefined;
      const sourceKey =
        typeof source?.path === 'string'
          ? `path:${source.path}`
          : typeof source?.sourceReference === 'number' && source.sourceReference > 0
            ? `reference:${source.sourceReference}`
            : undefined;
      if (!sourceKey) {
        respond(request, false, undefined, 'Breakpoint source requires a path or sourceReference');
        return;
      }
      const breakpoints = Array.isArray(args.breakpoints)
        ? args.breakpoints
        : Array.isArray(args.lines)
          ? args.lines.map((line) => ({ line }))
          : [];
      const ids = breakpoints.map(() => nextBreakpointId++);
      bufferedBreakpoints.set(sourceKey, { args, ids });
      hasClientBreakpoints ||= breakpoints.length > 0;
      respond(request, true, {
        breakpoints: breakpoints.map((breakpoint: unknown, index: number) => ({
          id: ids[index],
          verified: false,
          line:
            breakpoint && typeof breakpoint === 'object' && 'line' in breakpoint
              ? breakpoint.line
              : 0,
          ...(breakpoint && typeof breakpoint === 'object' && 'column' in breakpoint
            ? { column: breakpoint.column }
            : {}),
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
    if (command === 'disconnect') {
      void shutdown(0, request, args);
      return;
    }
    if (command === 'launch' || command === 'attach') {
      if (isStarting || dapSocket) {
        respond(request, false, undefined, 'Debug session already starting or active');
        return;
      }
      const explicitCwd = typeof args.cwd === 'string' && args.cwd ? resolve(args.cwd) : undefined;
      const targetCwd = explicitCwd ?? process.cwd();
      const isAndroid = Object.hasOwn(args, 'android') && args.android !== undefined;
      let resolvedFile: string | null = null;
      let hostName = '127.0.0.1';
      let attachTimeout = 30000;
      if (!isAndroid) {
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
        for (const field of ['testMode', 'build', 'stopOnEntry', 'noDebug']) {
          if (args[field] !== undefined && typeof args[field] !== 'boolean') {
            respond(request, false, undefined, `${field} must be a boolean`);
            return;
          }
        }
        if (args.build === false) {
          respond(
            request,
            false,
            undefined,
            'build: false is not supported: the IntelliJ debug adapter always builds before launching a JVM program',
          );
          return;
        }
        for (const field of ['args', 'vmArgs', 'gradleArgs']) {
          const value = args[field];
          if (
            value !== undefined &&
            (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
          ) {
            respond(request, false, undefined, `${field} must be an array of strings`);
            return;
          }
        }
        if (args.buildTool !== undefined && args.buildTool !== 'gradle') {
          respond(request, false, undefined, 'buildTool must be "gradle" or omitted');
          return;
        }
        if (args.buildTool === 'gradle' && args.testMode === true) {
          respond(
            request,
            false,
            undefined,
            'Gradle launch expects a main class, not a test target',
          );
          return;
        }
        for (const field of ['gradleArgs', 'projectPath', 'sourceSet']) {
          if (args[field] === undefined) continue;
          if (args.buildTool !== 'gradle') {
            respond(request, false, undefined, `${field} requires buildTool: "gradle"`);
            return;
          }
          if (field !== 'gradleArgs' && (typeof args[field] !== 'string' || !args[field].trim())) {
            respond(request, false, undefined, `${field} must be a non-empty string`);
            return;
          }
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
      }
      isStarting = true;
      isAndroidSession = isAndroid;
      sessionMode = command;
      startupRequest = request;
      isTestLaunch = !isAndroid && command === 'launch' && args.testMode === true;
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
        if (isAndroid) {
          await openProject(projectRoot);
          sessionAbortController.signal.throwIfAborted();
          await connectBackend(true);
          await replayBreakpoints();
          const androidTimeout =
            typeof args.timeout === 'number' && Number.isFinite(args.timeout) && args.timeout > 0
              ? args.timeout <= 300
                ? Math.round(args.timeout * 1000)
                : Math.round(args.timeout)
              : (settings.requestWaitTimeoutMs ?? 300000);
          await startNative(command, args, androidTimeout);
          return;
        }
        if (command === 'attach') {
          await openProject(projectRoot);
          sessionAbortController.signal.throwIfAborted();
          await connectBackend(false);
          if (!supportsThreadDump) {
            throw new Error('IntelliJ backend does not support threadDump readiness checks');
          }
          await replayBreakpoints();
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
        sessionAbortController.signal.throwIfAborted();
        let applicationArgs = (args.args ?? []) as string[];
        let additionalClassPaths: string[] = [];
        let additionalModulePaths: string[] = [];
        if (isTestLaunch) {
          const target = await resolveTestTarget(session, fileUri, applicationArgs);
          mainClass = target.mainClass;
          applicationArgs = target.args;
          additionalClassPaths = target.additionalClassPaths;
          additionalModulePaths = target.additionalModulePaths;
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
        const extraVmArgs = (args.vmArgs ?? []) as string[];
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
            additionalClassPaths,
            additionalModulePaths,
            vmArgs: [...extraVmArgs, `-Domp.intellij.run.id=${activeRunMarker}`],
            args: applicationArgs,
            env:
              args.env && typeof args.env === 'object' && !Array.isArray(args.env) ? args.env : {},
            cwd: explicitCwd,
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
      forwardClientRequest(request);
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
