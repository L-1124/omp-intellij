import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encode, frameParser } from '../src/shared/protocol.js';

type Message = Record<string, unknown> & {
  error?: { code?: number; data?: { failure?: { kind?: string } } };
};

async function bridgeFixture(
  t: TestContext,
  onServerMessage: (message: Message, socket: net.Socket) => void,
  options: { blockMetadata?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'omp-bridge-'));
  const systemPath = join(root, 'system');
  const project = join(root, 'project');
  await mkdir(systemPath);
  await mkdir(project);
  if (options.blockMetadata) await writeFile(join(systemPath, 'plugin-metadata'), 'blocked');
  const sockets = new Set<net.Socket>();
  const messages: Message[] = [];
  const pending = new Set<{
    predicate: (message: Message) => boolean;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  }>();
  let child: ChildProcessWithoutNullStreams | undefined;
  let exited: Promise<unknown> | undefined;
  let stderr = '';
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on(
      'data',
      frameParser((raw) => onServerMessage(raw as Message, socket)),
    );
  });
  t.after(async () => {
    if (child) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await writeFile(join(systemPath, 'server.port'), String(address.port));
  await writeFile(join(systemPath, 'omp-server.json'), JSON.stringify({ pid: process.pid }));
  const config = join(root, 'settings.json');
  await writeFile(
    config,
    JSON.stringify({
      host: '127.0.0.1',
      executable: 'unused-existing-server',
      systemPath,
      startupTimeoutMs: 1000,
      initializeTimeoutMs: 1000,
      requestWaitTimeoutMs: 2000,
      idleTimeout: '30m',
      workspaceConfigPath: join(root, 'profiles'),
      cachePolicy: { retentionDays: 30, warnAboveGiB: 5, automaticDeletion: false },
    }),
  );
  const bridge = spawn(
    process.execPath,
    [fileURLToPath(new URL('../src/bridge.js', import.meta.url))],
    {
      cwd: project,
      env: { ...process.env, OMP_INTELLIJ_SETTINGS: config },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child = bridge;
  exited = once(bridge, 'close');
  bridge.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  bridge.stdout.on(
    'data',
    frameParser((raw) => {
      const message = raw as Message;
      messages.push(message);
      for (const waiter of pending) {
        if (waiter.predicate(message)) {
          pending.delete(waiter);
          waiter.resolve(message);
        }
      }
    }),
  );
  bridge.once('close', () => {
    for (const waiter of pending)
      waiter.reject(new Error(stderr || 'Bridge closed before response'));
    pending.clear();
  });
  return {
    messages,
    send(message: Message) {
      bridge.stdin.write(encode(message));
    },
    initialize(capabilities: Message = {}) {
      bridge.stdin.write(
        encode({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { rootUri: pathToFileURL(project).href, capabilities },
        }),
      );
    },
    waitFor(predicate: (message: Message) => boolean): Promise<Message> {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      if (bridge.exitCode !== null || bridge.signalCode !== null) {
        return Promise.reject(new Error(stderr || 'Bridge already closed'));
      }
      const result = Promise.withResolvers<Message>();
      pending.add({ predicate, resolve: result.resolve, reject: result.reject });
      return result.promise;
    },
    async close() {
      bridge.stdin.end();
      return exited;
    },
    exited,
  };
}

test('cancelled requests stay cancelled after indexing completes and initialize responds once', {
  timeout: 15000,
}, async (t) => {
  let serverSocket: net.Socket | undefined;
  let semanticRequests = 0;
  const h = await bridgeFixture(t, (message, socket) => {
    serverSocket = socket;
    if (message.method === 'initialize') {
      socket.write(encode({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }));
    } else if (message.method === 'workspace/symbol') {
      semanticRequests++;
    } else if (message.id !== undefined) {
      socket.write(encode({ jsonrpc: '2.0', id: message.id, result: null }));
    }
  });
  h.initialize();
  await h.waitFor((m) => m.id === 1);
  h.send({ jsonrpc: '2.0', id: 2, method: 'workspace/symbol', params: { query: 'Queued' } });
  h.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 2 } });
  const response = await h.waitFor((m) => m.id === 2);
  assert.equal(response.error?.code, -32800);
  assert.ok(serverSocket);
  serverSocket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));
  h.send({ jsonrpc: '2.0', id: 3, method: 'custom/fence', params: {} });
  await h.waitFor((m) => m.id === 3);
  assert.deepEqual(await h.close(), [0, null]);
  assert.equal(semanticRequests, 0);
  assert.equal(h.messages.filter((m) => m.id === 1).length, 1);
});

for (const failure of ['timeout', 'disconnect', 'configuration'] as const) {
  test(`initialize returns one error before EOF on ${failure}`, { timeout: 15000 }, async (t) => {
    const h = await bridgeFixture(
      t,
      (message, socket) => {
        if (message.method === 'initialize' && failure === 'disconnect') socket.end();
      },
      { blockMetadata: failure === 'configuration' },
    );
    h.initialize();
    const response = await h.waitFor((m) => m.id === 1);
    assert.equal(response.error?.code, -32803);
    assert.equal('result' in response, false);
    if (failure === 'timeout') {
      assert.equal(response.error?.data?.failure?.kind, 'timeout');
    }
    await h.exited;
    assert.equal(h.messages.filter((m) => m.id === 1).length, 1);
  });
}

test('backend initialize errors are forwarded without a second response on close', {
  timeout: 15000,
}, async (t) => {
  const h = await bridgeFixture(t, (message, socket) => {
    if (message.method === 'initialize') {
      socket.write(
        encode({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32002, message: 'Initialization failed' },
        }),
      );
    }
  });
  h.initialize();
  const response = await h.waitFor((m) => m.id === 1);
  assert.equal(response.error?.code, -32002);
  await h.close();
  assert.equal(h.messages.filter((m) => m.id === 1).length, 1);
});

test('bridge owns server progress for clients without progress support and preserves partial results', {
  timeout: 15000,
}, async (t) => {
  let progressAccepted = false;
  const h = await bridgeFixture(t, (message, socket) => {
    if (message.method === 'initialize') {
      socket.write(encode({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
      socket.write(
        encode({
          jsonrpc: '2.0',
          id: 80,
          method: 'window/workDoneProgress/create',
          params: { token: 'index' },
        }),
      );
    } else if (message.id === 80 && !message.method) {
      progressAccepted = message.result === null;
      socket.write(
        encode({
          jsonrpc: '2.0',
          method: '$/progress',
          params: {
            token: 'index',
            value: { kind: 'begin', title: 'Indexing' },
          },
        }),
      );
      socket.write(
        encode({
          jsonrpc: '2.0',
          method: '$/progress',
          params: {
            token: 'index',
            value: { kind: 'end' },
          },
        }),
      );
      socket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));
    } else if (message.method === 'workspace/symbol') {
      socket.write(
        encode({
          jsonrpc: '2.0',
          method: '$/progress',
          params: {
            token: 'symbols',
            value: [{ name: 'Example' }],
          },
        }),
      );
      socket.write(encode({ jsonrpc: '2.0', id: message.id, result: null }));
    }
  });
  h.initialize();
  await h.waitFor((m) => m.id === 1);
  h.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'workspace/symbol',
    params: {
      query: 'Example',
      partialResultToken: 'symbols',
    },
  });
  await h.waitFor((m) => m.id === 2);
  assert.equal(progressAccepted, true);
  assert.equal(
    h.messages.some((m) => m.method === 'window/workDoneProgress/create'),
    false,
  );
  assert.deepEqual(
    h.messages.filter((m) => m.method === '$/progress').map((m) => m.params),
    [{ token: 'symbols', value: [{ name: 'Example' }] }],
  );
  await h.close();
});

test('bridge leaves progress negotiation with clients that support it', {
  timeout: 15000,
}, async (t) => {
  let progressAccepted = false;
  const h = await bridgeFixture(t, (message, socket) => {
    if (message.method === 'initialize') {
      socket.write(encode({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
      socket.write(
        encode({
          jsonrpc: '2.0',
          id: 80,
          method: 'window/workDoneProgress/create',
          params: { token: 0 },
        }),
      );
    } else if (message.id === 80 && !message.method) {
      progressAccepted = message.result === null;
      socket.write(
        encode({
          jsonrpc: '2.0',
          method: '$/progress',
          params: {
            token: 0,
            value: { kind: 'begin', title: 'Indexing' },
          },
        }),
      );
    }
  });
  h.initialize({ window: { workDoneProgress: true } });
  const create = await h.waitFor((m) => m.id === 80);
  assert.equal(create.method, 'window/workDoneProgress/create');
  h.send({ jsonrpc: '2.0', id: 80, result: null });
  const progress = await h.waitFor((m) => m.method === '$/progress');
  assert.deepEqual(progress.params, { token: 0, value: { kind: 'begin', title: 'Indexing' } });
  assert.equal(progressAccepted, true);
  await h.close();
});
