import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encode, frameParser } from '../src/shared/protocol.js';

test('bridge executable answers initialize and forwards semantic requests', {
  timeout: 15000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'omp-intellij-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const systemPath = join(root, 'system');
  const project = join(root, 'project');
  await mkdir(systemPath);
  await mkdir(project);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on(
      'data',
      frameParser((raw) => {
        assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
        assert.ok('method' in raw);
        if (raw.method === 'initialize') {
          assert.ok('id' in raw);
          socket.write(
            encode({
              jsonrpc: '2.0',
              id: raw.id,
              result: { capabilities: { hoverProvider: true } },
            }),
          );
          socket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));
        } else if (raw.method === 'textDocument/hover') {
          assert.ok('id' in raw);
          socket.write(
            encode({ jsonrpc: '2.0', id: raw.id, result: { contents: 'bridge-protocol-ok' } }),
          );
        }
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
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
      requestWaitTimeoutMs: 1000,
      idleTimeout: '30m',
      workspaceConfigPath: join(root, 'profiles'),
      cachePolicy: { retentionDays: 30, warnAboveGiB: 5, automaticDeletion: false },
    }),
  );
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../src/bridge.js', import.meta.url))],
    {
      cwd: project,
      env: { ...process.env, OMP_INTELLIJ_SETTINGS: config },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await closed;
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const received: unknown[] = [];
  const ready = Promise.withResolvers<void>();
  const hover = Promise.withResolvers<unknown>();
  child.stdout.on(
    'data',
    frameParser((raw) => {
      received.push(raw);
      if (!raw || typeof raw !== 'object') return;
      if ('method' in raw && raw.method === 'intellij/ready-for-test') ready.resolve();
      if ('id' in raw && raw.id === 2 && 'result' in raw) hover.resolve(raw.result);
    }),
  );
  child.once('close', (code) => {
    const error = new Error(`Bridge exited before response (${code}): ${stderr}`);
    ready.reject(error);
    hover.reject(error);
  });
  ready.promise.catch(() => {});
  hover.promise.catch(() => {});
  child.stdin.write(
    encode({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { rootUri: pathToFileURL(project).href, capabilities: {} },
    }),
  );
  await ready.promise;
  child.stdin.write(
    encode({
      jsonrpc: '2.0',
      id: 2,
      method: 'textDocument/hover',
      params: {
        textDocument: { uri: pathToFileURL(join(project, 'Example.java')).href },
        position: { line: 0, character: 0 },
      },
    }),
  );
  assert.deepEqual(await hover.promise, { contents: 'bridge-protocol-ok' });
  assert.ok(
    received.some((value) => value && typeof value === 'object' && 'id' in value && value.id === 1),
  );
  child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 0, stderr);
});
