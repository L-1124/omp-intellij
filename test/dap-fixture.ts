import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { TestContext } from 'node:test';
import { type DapProxySession, startDapProxy } from '../src/debug/dap-proxy.js';
import {
  type CreateLspSessionOptions,
  type LspSession,
  createLspSession as runCoreCreateLspSession,
} from '../src/debug/run-core.js';
import { encode, frameParser } from '../src/shared/protocol.js';

export interface DapRequest {
  seq: number;
  type: 'request';
  command: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DapResponse {
  seq: number;
  type: 'response';
  request_seq: number;
  command: string;
  success: boolean;
  message?: string;
  body?: unknown;
  [key: string]: unknown;
}

export interface DapEvent {
  seq: number;
  type: 'event';
  event: string;
  body?: unknown;
  [key: string]: unknown;
}

export type DapMessage = DapRequest | DapResponse | DapEvent;

export interface DapHarnessOptions {
  onDapRequest?: (request: DapRequest) => boolean | undefined;
  onLspRequest?: (method: string, params: unknown) => unknown;
  onLspClose?: () => void;
  capabilities?: Record<string, unknown>;
  defaultMainClass?: string;
  fakeJavaExec?: string;
  keepBackendAfterDisconnect?: boolean;
}

export interface DapTestHarness {
  proxy: DapProxySession;
  stdin: PassThrough;
  messages: DapMessage[];
  backendRequests: DapRequest[];
  lspRequests: Array<{ method: string; params: unknown; id?: number }>;
  closed: Promise<number>;
  send: (command: string, args?: Record<string, unknown>) => number;
  request: (
    command: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<DapResponse>;
  waitFor: (predicate: (m: DapMessage) => boolean, timeoutMs?: number) => Promise<DapMessage>;
  emit: (event: string, body?: unknown) => void;
  respond: (request: DapRequest, body?: unknown, success?: boolean, message?: string) => void;
  closeBackend: (reset?: boolean) => void;
  lspPort: number;
  dapPort: number;
  systemPath: string;
}

async function listenAndGetPort(server: net.Server): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => resolve());
  await promise;
  return (server.address() as net.AddressInfo).port;
}

export async function createDapTestHarness(
  t: TestContext,
  options: DapHarnessOptions = {},
): Promise<DapTestHarness> {
  const systemPath = await mkdtemp(join(tmpdir(), 'omp-intellij-harness-'));
  const sockets = new Set<net.Socket>();
  const backendSockets = new Set<net.Socket>();
  const backendRequests: DapRequest[] = [];
  const lspRequests: Array<{ method: string; params: unknown; id?: number }> = [];
  const messages: DapMessage[] = [];
  const messageEmitter = new EventEmitter();

  let clientSeq = 1;
  let backendSeq = 1;
  let pendingAttach = false;

  const emit = (event: string, body: unknown = {}) => {
    const buf = encode({ seq: backendSeq++, type: 'event', event, body });
    for (const s of backendSockets) {
      if (!s.destroyed) {
        try {
          s.write(buf);
        } catch {}
      }
    }
  };

  const respond = (req: DapRequest, body: unknown = {}, success = true, message?: string) => {
    const resp: DapResponse = {
      seq: backendSeq++,
      type: 'response',
      request_seq: req.seq,
      command: req.command,
      success,
      ...(message !== undefined ? { message } : {}),
      body,
    };
    const buf = encode(resp);
    for (const s of backendSockets) {
      if (!s.destroyed) {
        try {
          if (req.command === 'disconnect' && success && !options.keepBackendAfterDisconnect) {
            s.end(buf);
          } else {
            s.write(buf);
          }
        } catch {}
      }
    }
  };

  const dapServer = net.createServer((socket) => {
    sockets.add(socket);
    backendSockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      backendSockets.delete(socket);
    });
    socket.on('error', () => {});

    socket.on(
      'data',
      frameParser((raw: unknown) => {
        if (!raw || typeof raw !== 'object') return;
        const msg = raw as DapMessage;
        if (msg.type !== 'request') return;
        const req = msg as DapRequest;
        backendRequests.push(req);

        if (options.onDapRequest?.(req) === true) return;

        switch (req.command) {
          case 'initialize': {
            respond(req, {
              supportsFunctionBreakpoints: true,
              supportsConfigurationDoneRequest: true,
              supportsConditionalBreakpoints: true,
              supportsHitConditionalBreakpoints: true,
              supportsEvaluateForHovers: true,
              supportsExceptionInfoRequest: true,
              supportsThreadDumpRequest: true,
              ...options.capabilities,
            });
            setImmediate(() => emit('initialized'));
            break;
          }
          case 'setBreakpoints': {
            const rawBps = Array.isArray(req.arguments?.breakpoints)
              ? req.arguments.breakpoints
              : [];
            respond(req, {
              breakpoints: rawBps.map((b: unknown, i: number) => {
                const line =
                  b && typeof b === 'object' && 'line' in b && typeof b.line === 'number'
                    ? b.line
                    : 1;
                return { id: i + 1, verified: true, line };
              }),
            });
            break;
          }
          case 'setFunctionBreakpoints': {
            const rawBps = Array.isArray(req.arguments?.breakpoints)
              ? req.arguments.breakpoints
              : [];
            respond(req, {
              breakpoints: rawBps.map((b: unknown, i: number) => {
                const name =
                  b && typeof b === 'object' && 'name' in b && typeof b.name === 'string'
                    ? b.name
                    : undefined;
                return { id: i + 1, verified: true, name };
              }),
            });
            break;
          }
          case 'attach': {
            pendingAttach = options.capabilities?.supportsConfigurationDoneRequest !== false;
            respond(req);
            break;
          }
          case 'configurationDone': {
            if (pendingAttach) {
              pendingAttach = false;
              emit('output', {
                category: 'console',
                output: "Connected to the target VM, address: 'test', transport: 'socket'\n",
              });
            }
            respond(req);
            break;
          }
          case 'intellij/threadDump': {
            respond(req, {
              text: pendingAttach
                ? ''
                : '"main" RUNNABLE\n at com.example.AttachTarget.main(AttachTarget.java:7)',
            });
            break;
          }
          case 'threads': {
            respond(req, { threads: [{ id: 1, name: 'main' }] });
            break;
          }
          case 'stackTrace': {
            respond(req, {
              stackFrames: [
                {
                  id: 1,
                  name: 'main',
                  line: 1,
                  column: 1,
                  source: { name: 'AttachTarget.java' },
                },
              ],
              totalFrames: 1,
            });
            break;
          }
          case 'continue': {
            respond(req, { allThreadsContinued: true });
            break;
          }
          default: {
            respond(req, {});
            break;
          }
        }
      }),
    );
  });

  const dapPort = await listenAndGetPort(dapServer);

  const sendLsp = (payload: Record<string, unknown>, s: net.Socket) => {
    if (!s.destroyed) {
      try {
        s.write(encode({ jsonrpc: '2.0', ...payload }));
      } catch {}
    }
  };

  const lspServer = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      options.onLspClose?.();
    });
    socket.on('error', () => {});

    socket.on(
      'data',
      frameParser((raw: unknown) => {
        if (!raw || typeof raw !== 'object') return;
        const msg = raw as { id?: number; method?: string; params?: unknown };
        if (!msg.method) return;
        lspRequests.push({ method: msg.method, params: msg.params, id: msg.id });

        if (msg.id === undefined) return;

        if (options.onLspRequest) {
          const custom = options.onLspRequest(msg.method, msg.params);
          if (custom !== undefined) {
            void Promise.resolve(custom).then(
              (result) => {
                sendLsp({ id: msg.id, result }, socket);
                if (msg.method === 'initialize') {
                  setImmediate(() => {
                    sendLsp({ method: 'intellij/ready-for-test', params: {} }, socket);
                  });
                }
              },
              (error: unknown) => {
                const failure = error instanceof Error ? error : new Error(String(error));
                sendLsp(
                  {
                    id: msg.id,
                    error: { code: -32803, message: failure.message },
                  },
                  socket,
                );
              },
            );
            return;
          }
        }

        if (msg.method === 'initialize') {
          sendLsp(
            {
              id: msg.id,
              result: { capabilities: { codeLensProvider: { resolveProvider: false } } },
            },
            socket,
          );
          setImmediate(() => {
            sendLsp({ method: 'intellij/ready-for-test', params: {} }, socket);
          });
          return;
        }

        if (msg.method === 'textDocument/codeLens') {
          sendLsp(
            {
              id: msg.id,
              result: [
                {
                  range: { start: { line: 7, character: 0 }, end: { line: 7, character: 0 } },
                  command: {
                    command: 'intellij.jvm.runMain',
                    title: 'Run',
                    arguments: [
                      { mainClass: options.defaultMainClass ?? 'com.example.JavaGreeter' },
                    ],
                  },
                },
              ],
            },
            socket,
          );
          return;
        }

        if (msg.method === 'workspace/executeCommand') {
          const rawParams = msg.params;
          const paramObj =
            rawParams && typeof rawParams === 'object'
              ? (rawParams as Record<string, unknown>)
              : {};
          const cmd = typeof paramObj.command === 'string' ? paramObj.command : undefined;
          const cmdArgs = Array.isArray(paramObj.arguments) ? paramObj.arguments : [];

          if (cmd === 'start_debug_server') {
            sendLsp({ id: msg.id, result: dapPort }, socket);
            return;
          }
          if (cmd === 'omp.jvm.resolveBuildCommand') {
            sendLsp(
              {
                id: msg.id,
                result: {
                  supported: true,
                  command: [process.execPath, '-e', 'process.exit(0)'],
                  cwd: process.cwd(),
                  tool: 'fake',
                },
              },
              socket,
            );
            return;
          }
          if (cmd === 'omp.jvm.resolveLaunch') {
            sendLsp(
              {
                id: msg.id,
                result: {
                  javaExec:
                    options.fakeJavaExec ??
                    (process.platform === 'win32' ? 'C:\\fake\\java.exe' : '/fake/java'),
                  classpath: ['target/classes'],
                  modulePath: [],
                  vmArgs: [],
                },
              },
              socket,
            );
            return;
          }
          if (cmd === 'intellij.jvm.discoverTestsInFile') {
            sendLsp(
              {
                id: msg.id,
                result: [
                  { id: 'com.example.JavaGreeterTest', kind: 'CLASS', runnable: true },
                  {
                    id: 'com.example.JavaGreeterTest#testGreeting',
                    kind: 'METHOD',
                    runnable: true,
                  },
                ],
              },
              socket,
            );
            return;
          }
          if (cmd === 'intellij.jvm.resolveTestLaunch') {
            const firstArg =
              cmdArgs.length > 0 && typeof cmdArgs[0] === 'object' && cmdArgs[0] !== null
                ? (cmdArgs[0] as Record<string, unknown>)
                : {};
            const testIds = Array.isArray(firstArg.testIds)
              ? firstArg.testIds.filter((id): id is string => typeof id === 'string')
              : ['com.example.JavaGreeterTest'];
            sendLsp(
              {
                id: msg.id,
                result: [
                  {
                    mainClass: 'com.intellij.rt.junit.JUnitStarter',
                    args: ['-junit5', ...testIds],
                    runtimeClasspath: ['target/test-classes'],
                  },
                ],
              },
              socket,
            );
            return;
          }
          sendLsp({ id: msg.id, result: {} }, socket);
          return;
        }

        sendLsp({ id: msg.id, result: {} }, socket);
      }),
    );
  });

  const lspPort = await listenAndGetPort(lspServer);

  const createLspSession = async (
    projectRoot: string,
    opts: CreateLspSessionOptions = {},
  ): Promise<LspSession> => {
    const clientSocket = net.createConnection({ host: '127.0.0.1', port: lspPort });
    sockets.add(clientSocket);
    clientSocket.on('close', () => sockets.delete(clientSocket));
    clientSocket.on('error', () => {});
    await once(clientSocket, 'connect');
    return await runCoreCreateLspSession(projectRoot, {
      ...opts,
      socket: clientSocket,
      systemPath,
    });
  };

  const stdin = new PassThrough();
  const stdout = new PassThrough();

  stdout.on(
    'data',
    frameParser((raw: unknown) => {
      const msg = raw as DapMessage;
      messages.push(msg);
      messageEmitter.emit('message', msg);
    }),
  );

  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<number>();

  const proxy = startDapProxy({
    stdin,
    stdout,
    createLspSession,
    systemPath,
    onExit: (code) => resolveClosed(code),
  });

  const send = (command: string, args: Record<string, unknown> = {}): number => {
    const seq = clientSeq++;
    stdin.write(encode({ seq, type: 'request', command, arguments: args }));
    return seq;
  };

  const waitFor = (
    predicate: (m: DapMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<DapMessage> => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    const { promise, resolve, reject } = Promise.withResolvers<DapMessage>();
    const timer = setTimeout(() => {
      messageEmitter.off('message', listener);
      reject(new Error(`Timeout after ${timeoutMs}ms waiting for matching DAP message`));
    }, timeoutMs);

    const listener = (m: DapMessage) => {
      if (predicate(m)) {
        clearTimeout(timer);
        messageEmitter.off('message', listener);
        resolve(m);
      }
    };
    messageEmitter.on('message', listener);
    return promise;
  };

  const request = async (
    command: string,
    args: Record<string, unknown> = {},
    timeoutMs = 5000,
  ): Promise<DapResponse> => {
    const seq = send(command, args);
    return (await waitFor(
      (m) => m.type === 'response' && (m as DapResponse).request_seq === seq,
      timeoutMs,
    )) as DapResponse;
  };

  const closeBackend = (reset = false) => {
    for (const s of backendSockets) {
      try {
        if (reset) s.resetAndDestroy();
        else s.destroy();
      } catch {}
    }
    backendSockets.clear();
  };

  t.after(async () => {
    try {
      stdin.end();
    } catch {}
    for (const s of sockets) {
      try {
        s.destroy();
      } catch {}
    }
    sockets.clear();
    backendSockets.clear();

    await proxy.shutdown(0).catch(() => {});

    const close = async (srv: net.Server) => {
      if (!srv.listening) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      srv.close(() => resolve());
      await promise;
    };
    await Promise.all([close(dapServer), close(lspServer)]);
    await rm(systemPath, { recursive: true, force: true }).catch(() => {});
  });

  return {
    proxy,
    stdin,
    messages,
    backendRequests,
    lspRequests,
    closed,
    send,
    request,
    waitFor,
    emit,
    respond,
    closeBackend,
    lspPort,
    dapPort,
    systemPath,
  };
}
