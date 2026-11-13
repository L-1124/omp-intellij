import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, open, readFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { encode, frameParser } from '../../src/shared/protocol.js';

export interface NativeMessage {
  [key: string]: unknown;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  type?: string;
  seq?: number;
  request_seq?: number;
  event?: string;
  success?: boolean;
  message?: string;
  body?: Record<string, unknown>;
}

export class NativePeer {
  readonly messages: NativeMessage[] = [];
  private readonly events = new EventEmitter();
  private readonly pending = new Map<number, {
    resolve: (message: NativeMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private sequence = 0;
  private closed = false;

  constructor(readonly socket: net.Socket, private readonly protocol: 'lsp' | 'dap') {
    socket.on('data', frameParser((raw) => {
      if (!raw || typeof raw !== 'object') return;
      const message = raw as NativeMessage;
      this.messages.push(message);
      if (protocol === 'lsp' && message.method && message.id !== undefined) {
        const response: NativeMessage = { jsonrpc: '2.0', id: message.id };
        if (message.method === 'workspace/configuration') {
          const items = message.params?.items;
          response.result = Array.isArray(items) ? items.map(() => null) : [];
        } else if (['client/registerCapability', 'client/unregisterCapability',
          'window/workDoneProgress/create', 'workspace/workspaceFolders'].includes(message.method)) {
          response.result = null;
        } else if (message.method === 'workspace/applyEdit') {
          response.result = { applied: false, failureReason: 'Read-only integration client' };
        } else {
          response.error = { code: -32601, message: 'Unsupported client request' };
        }
        socket.write(encode(response));
      } else {
        const id = protocol === 'dap' ? message.request_seq : message.id;
        const entry = typeof id === 'number' ? this.pending.get(id) : undefined;
        if (entry && typeof id === 'number') {
          this.pending.delete(id);
          clearTimeout(entry.timer);
          entry.resolve(message);
        }
      }
      this.events.emit('message', message);
    }));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error(`${protocol.toUpperCase()} socket closed`)));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.events.emit('closed', error);
  }

  sendRequest(command: string, args: unknown = {}, timeoutMs = 120000, fragmented = false): {
    id: number;
    response: Promise<NativeMessage>;
  } {
    const id = ++this.sequence;
    const { promise: response, resolve, reject } = Promise.withResolvers<NativeMessage>();
    if (this.closed) {
      reject(new Error('Protocol socket is closed'));
      return { id, response };
    }
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`Protocol timeout: ${command}`));
    }, timeoutMs);
    this.pending.set(id, { resolve, reject, timer });
    const frame = encode(this.protocol === 'dap'
      ? { seq: id, type: 'request', command, arguments: args }
      : { jsonrpc: '2.0', id, method: command, params: args });
    if (fragmented) {
      this.socket.write(frame.subarray(0, 13));
      this.socket.write(frame.subarray(13));
    } else this.socket.write(frame);
    return { id, response };
  }

  request(command: string, args: unknown = {}, timeoutMs = 120000): Promise<NativeMessage> {
    return this.sendRequest(command, args, timeoutMs).response;
  }

  async lspRequest(method: string, params: unknown = {}, timeoutMs = 120000): Promise<unknown> {
    const response = await this.request(method, params, timeoutMs);
    if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    return response.result;
  }

  notify(method: string, params: unknown = {}): void {
    this.socket.write(encode({ jsonrpc: '2.0', method, params }));
  }

  waitFor(predicate: (message: NativeMessage) => boolean, after = 0, timeoutMs = 120000): Promise<NativeMessage> {
    const found = this.messages.slice(after).find(predicate);
    if (found) return Promise.resolve(found);
    if (this.closed) return Promise.reject(new Error('Protocol socket is closed'));
    const { promise, resolve, reject } = Promise.withResolvers<NativeMessage>();
    const finish = (message?: NativeMessage, error?: Error) => {
      clearTimeout(timer);
      this.events.off('message', onMessage);
      this.events.off('closed', onClosed);
      if (message) resolve(message);
      else reject(error);
    };
    const onMessage = (message: NativeMessage) => { if (predicate(message)) finish(message); };
    const onClosed = (error: Error) => finish(undefined, error);
    const timer = setTimeout(() => finish(undefined, new Error('Protocol event timeout')), timeoutMs);
    this.events.on('message', onMessage);
    this.events.once('closed', onClosed);
    return promise;
  }

  close(): void {
    this.socket.destroy();
  }
}

export interface NativeAndroidClientOptions {
  serverExecutable: string;
  acceptedEulaHash: string;
  projectDirectory: string;
  jdk: string;
  sandboxDirectory: string;
  extensionDirectory: string;
  env: NodeJS.ProcessEnv;
  trackProcess(child: ChildProcess): void;
  trackSocket(socket: net.Socket): void;
}

export interface NativeAndroidClient {
  process: ChildProcess;
  runtimeDirectory: string;
  lsp: NativePeer;
  connectDap(bootstrap?: unknown): Promise<NativePeer>;
  close(): Promise<void>;
}

export async function createNativeAndroidClient(options: NativeAndroidClientOptions): Promise<NativeAndroidClient> {
  const root = await mkdtemp(join(options.sandboxDirectory, 'native-'));
  for (const part of ['config', 'log', 'index']) await mkdir(join(root, part), { recursive: true });
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(options.env).filter(([key]) => !key.startsWith('OMP_')),
  );
  env.JAVA_HOME = options.jdk;
  env.IJ_JAVA_OPTIONS = [
    '-Dintellij.server.eula.persistence=false',
    `-Didea.config.path="${join(root, 'config').replace(/\\/g, '/')}"`,
    `-Didea.log.path="${join(root, 'log').replace(/\\/g, '/')}"`,
    `-Dplugin.path="${options.extensionDirectory.replace(/\\/g, '/')}"`,
  ].join(' ');
  const portFile = join(root, 'server.port');
  const log = await open(join(root, 'ils.log'), 'a');
  let child: ChildProcess;
  try {
    child = spawn(options.serverExecutable, [
      '--socket=127.0.0.1:0', `--port-file=${portFile}`, '--multi-client',
      `--system-path=${root}`, '--idle-timeout=60s', '--data-sharing=none',
      `--eula=${options.acceptedEulaHash}`,
    ], { cwd: options.projectDirectory, env, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
    options.trackProcess(child);
    const spawned = Promise.withResolvers<void>();
    child.once('spawn', spawned.resolve);
    child.once('error', spawned.reject);
    await spawned.promise;
  } finally {
    await log.close();
  }
  const sockets = new Set<net.Socket>();
  const connect = async (port: number, protocol: 'lsp' | 'dap') => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    options.trackSocket(socket);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const connected = Promise.withResolvers<void>();
    socket.once('connect', connected.resolve);
    socket.once('error', connected.reject);
    await connected.promise;
    return new NativePeer(socket, protocol);
  };
  let port = 0;
  const deadline = Date.now() + 90000;
  while (!port && Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Native ILS exited: ${child.exitCode}; log: ${join(root, 'ils.log')}`);
    }
    try {
      const candidate = Number((await readFile(portFile, 'utf8')).split(/\r?\n/, 1)[0]);
      if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65535) port = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!port) await sleep(100);
  }
  if (!port) throw new Error(`Native ILS did not publish its port; log: ${join(root, 'ils.log')}`);
  const lsp = await connect(port, 'lsp');
  const rootUri = pathToFileURL(options.projectDirectory).href;
  await lsp.lspRequest('initialize', {
    processId: process.pid,
    clientInfo: { name: 'native-android-integration', version: '1' },
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: 'fixture' }],
    capabilities: { window: { workDoneProgress: true }, workspace: {}, textDocument: {} },
    initializationOptions: {
      indexDir: join(root, 'index'),
      projects: [{ type: 'gradle', path: rootUri, 'java-home': options.jdk,
        env: { JAVA_HOME: options.jdk, ANDROID_HOME: env.ANDROID_HOME,
          ANDROID_SDK_ROOT: env.ANDROID_SDK_ROOT, GRADLE_USER_HOME: env.GRADLE_USER_HOME } }],
    },
  }, 150000);
  lsp.notify('initialized');
  return {
    process: child,
    runtimeDirectory: root,
    lsp,
    async connectDap(bootstrap: unknown = {}) {
      const result = await lsp.lspRequest('workspace/executeCommand', {
        command: 'org.intellij.android.debug.startServer', arguments: [bootstrap],
      });
      const dapPort = (result as { port?: unknown } | null)?.port;
      if (typeof dapPort !== 'number' || !Number.isInteger(dapPort) || dapPort < 1 || dapPort > 65535) {
        throw new Error(`Invalid Android DAP endpoint: ${JSON.stringify(result)}`);
      }
      return connect(dapPort, 'dap');
    },
    async close() {
      try {
        await lsp.lspRequest('shutdown', null, 10000);
        lsp.notify('exit');
      } finally {
        for (const socket of sockets) socket.destroy();
      }
    },
  };
}
