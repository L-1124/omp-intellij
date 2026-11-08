import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encode, frameParser } from '../src/shared/protocol.js';

test('cancelled requests stay cancelled after indexing completes and the bridge exits on EOF', {
  timeout: 15000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'omp-bridge-cancel-'));
  const systemPath = join(root, 'system');
  const project = join(root, 'project');
  await mkdir(systemPath);
  await mkdir(project);
  const sockets = new Set<net.Socket>();
  let serverSocket: net.Socket | undefined;
  let semanticRequests = 0;
  let child: ChildProcessWithoutNullStreams | undefined;
  let exited: Promise<unknown> | undefined;
  const server = net.createServer((socket) => {
    serverSocket = socket;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on(
      'data',
      frameParser((raw) => {
        const message = raw as Record<string, unknown>;
        if (message.method === 'initialize') {
          socket.write(encode({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }));
        } else if (message.method === 'workspace/symbol') {
          semanticRequests++;
        } else if (message.id !== undefined) {
          socket.write(encode({ jsonrpc: '2.0', id: message.id, result: null }));
        }
      }),
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
  await writeFile(
    join(systemPath, 'omp-server.json'),
    JSON.stringify({ pid: globalThis.process.pid }),
  );
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
  const process = spawn(
    globalThis.process.execPath,
    [fileURLToPath(new URL('../src/bridge.js', import.meta.url))],
    {
      cwd: project,
      env: { ...globalThis.process.env, OMP_INTELLIJ_SETTINGS: config },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child = process;
  exited = once(process, 'exit');
  let stderr = '';
  process.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const initialized = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<Record<string, unknown>>();
  const fence = Promise.withResolvers<void>();
  process.stdout.on(
    'data',
    frameParser((raw) => {
      const message = raw as Record<string, unknown>;
      if (message.id === 1) initialized.resolve();
      if (message.id === 2) cancelled.resolve(message);
      if (message.id === 3) fence.resolve();
    }),
  );
  process.once('exit', () => {
    const error = new Error(stderr || 'Bridge exited before a protocol response');
    initialized.reject(error);
    cancelled.reject(error);
    fence.reject(error);
  });
  initialized.promise.catch(() => {});
  cancelled.promise.catch(() => {});
  fence.promise.catch(() => {});
  process.stdin.write(
    encode({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { rootUri: pathToFileURL(project).href, capabilities: {} },
    }),
  );
  await initialized.promise;
  process.stdin.write(
    Buffer.concat([
      encode({ jsonrpc: '2.0', id: 2, method: 'workspace/symbol', params: { query: 'Queued' } }),
      encode({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 2 } }),
    ]),
  );
  const response = await cancelled.promise;
  assert.ok(response.error && typeof response.error === 'object' && 'code' in response.error);
  assert.equal(response.error.code, -32800);
  assert.ok(serverSocket);
  serverSocket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));
  process.stdin.write(encode({ jsonrpc: '2.0', id: 3, method: 'custom/fence', params: {} }));
  await fence.promise;
  process.stdin.end();
  const [code] = (await exited) as [number | null];
  assert.equal(code, 0, stderr);
  assert.equal(semanticRequests, 0);
});
