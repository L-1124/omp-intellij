import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { ServerBundle } from '../src/server/bundles.js';
import { readInstallState } from '../src/server/install.js';

interface WorkerEvent {
  type: string;
  pid?: number;
  state?: { pid: number; phase: string };
  result?: { executable: string };
  message?: string;
}

interface InstallerWorker {
  child: ChildProcess;
  closed: Promise<unknown>;
}

async function installFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'omp install process '));
  const workers: InstallerWorker[] = [];
  const source = join(root, 'source');
  await mkdir(join(source, 'bin'), { recursive: true });
  await writeFile(
    join(source, 'bin', process.platform === 'win32' ? 'intellij-server.exe' : 'intellij-server'),
    'fixture launcher',
  );
  const archive = join(root, 'bundle.tar.gz');
  await promisify(execFile)('tar', ['-czf', archive, '-C', source, '.']);
  const bytes = await readFile(archive);
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Length': bytes.length });
    res.write(bytes.subarray(0, 16));
    requested.resolve();
    void release.promise.then(() => {
      if (!res.destroyed) res.end(bytes.subarray(16));
    });
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const bundle: ServerBundle = {
    version: 'process-test-v1',
    url: `http://127.0.0.1:${address.port}/bundle`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    archive: 'tar.gz',
  };
  t.after(async () => {
    release.resolve();
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    }
    await Promise.all(workers.map((worker) => worker.closed));
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    workers,
    bundle,
    requested: requested.promise,
    release: release.resolve,
    requests: () => requests,
  };
}

function installWorker(dir: string, bundle: ServerBundle, workers: InstallerWorker[]) {
  const module = new URL('../src/server/install.js', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {ensureInstalled} from ${JSON.stringify(module)};
    const controller = new AbortController();
    process.on('message', value => { if (value === 'abort') controller.abort(new Error('waiter cancelled')); });
    try {
      const result = await ensureInstalled(${JSON.stringify(dir)}, {
        bundle: ${JSON.stringify(bundle)}, signal: controller.signal, timeoutMs: 15000,
        onProgress: state => process.send({type:'progress', pid:process.pid, state}),
      });
      process.send({type:'done', pid:process.pid, result});
    } catch(error) {
      process.send({type:'error', pid:process.pid, message:error.message});
    } finally { process.disconnect(); }
  `,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const events: WorkerEvent[] = [];
  const listeners = new Set<{
    predicate: (event: WorkerEvent) => boolean;
    resolve: (event: WorkerEvent) => void;
    reject: (error: Error) => void;
  }>();
  const closed = once(child, 'close');
  workers.push({ child, closed });
  child.on('message', (raw: unknown) => {
    const event = raw as WorkerEvent;
    events.push(event);
    for (const waiter of listeners) {
      if (waiter.predicate(event)) {
        listeners.delete(waiter);
        waiter.resolve(event);
      }
    }
  });
  child.once('close', (code) => {
    for (const waiter of listeners)
      waiter.reject(new Error(`Installer worker exited ${code}: ${stderr}`));
    listeners.clear();
  });
  function waitFor(predicate: (event: WorkerEvent) => boolean): Promise<WorkerEvent> {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    const deferred = Promise.withResolvers<WorkerEvent>();
    listeners.add({ predicate, resolve: deferred.resolve, reject: deferred.reject });
    return deferred.promise;
  }
  return { child, closed, waitFor };
}

for (const cancelWaiter of [false, true]) {
  test(`separate processes ${cancelWaiter ? 'cancel only the waiter' : 'reuse one streamed download'}`, {
    timeout: 20000,
  }, async (t) => {
    const fixture = await installFixture(t);
    const dir = join(fixture.root, 'managed server with spaces');
    const owner = installWorker(dir, fixture.bundle, fixture.workers);
    await fixture.requested;
    const waiter = installWorker(dir, fixture.bundle, fixture.workers);
    const observed = await waiter.waitFor(
      (event) => event.type === 'progress' && event.state?.pid === owner.child.pid,
    );
    assert.equal(observed.state?.phase, 'downloading');
    assert.notEqual(owner.child.pid, waiter.child.pid);
    if (cancelWaiter) {
      waiter.child.send('abort');
      const error = await waiter.waitFor((event) => event.type === 'error');
      assert.match(error.message ?? '', /waiter cancelled/);
      await waiter.closed;
      const lock = JSON.parse(await readFile(join(dir, 'install.lock', 'owner.json'), 'utf8')) as {
        pid: number;
      };
      assert.equal(lock.pid, owner.child.pid);
      assert.equal((await readInstallState(dir))?.phase, 'downloading');
    }
    fixture.release();
    const result = await owner.waitFor((event) => event.type === 'done');
    if (!cancelWaiter) {
      const second = await waiter.waitFor((event) => event.type === 'done');
      assert.equal(second.result?.executable, result.result?.executable);
      await waiter.closed;
    }
    await owner.closed;
    assert.equal(fixture.requests(), 1);
    assert.equal((await readInstallState(dir))?.phase, 'ready');
  });
}
