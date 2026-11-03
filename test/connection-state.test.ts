import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createConnectionState,
  readProjectState,
  reduceConnectionState,
} from '../src/project/connection-state.js';
import { canonicalizeProject } from '../src/project/metadata.js';

test('concurrent status reads preserve the final closed record and leave no temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-record-read-close-'));
  const errors: unknown[] = [];
  const state = createConnectionState({
    systemPath: root,
    onWriteError: (error) => errors.push(error),
  });
  let reading = true;
  await state.update({ root, phase: 'indexing' });
  const dir = join(root, 'plugin-metadata', 'connections');
  const file = join(dir, `${state.connectionId}.json`);
  const reader = (async () => {
    while (reading) {
      const snapshot = await readProjectState(root, root);
      assert.equal(snapshot.connectionId, state.connectionId);
    }
  })();
  try {
    for (let i = 0; i < 20; i++) await state.update({ detail: `Index batch ${i}` });
    await state.close();
    const record = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(record.closed, true);
    assert.deepEqual(record.license, { status: 'unknown' });
    assert.deepEqual(errors, []);
    assert.deepEqual(await readdir(dir), [`${state.connectionId}.json`]);
  } finally {
    reading = false;
    await reader;
    await rm(root, { recursive: true, force: true });
  }
});

test('newer conn wins: newest-started live bridge overrides older ready connection', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-conn-test-'));
  try {
    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    await mkdir(connDir, { recursive: true });

    const projectPath = join(tempDir, 'workspace', 'my-project');
    const { canonicalPath } = canonicalizeProject(projectPath);

    const conn1 = {
      connectionId: 'conn-old',
      kind: 'bridge',
      pid: process.pid,
      startedAt: 100000,
      updatedAt: 150000,
      seq: 5,
      phase: 'ready',
      detail: 'Old ready index',
      canonicalPath,
      closed: false,
    };
    await writeFile(join(connDir, 'conn-old.json'), JSON.stringify(conn1, null, 2), 'utf8');

    const conn2 = {
      connectionId: 'conn-new',
      kind: 'bridge',
      pid: process.pid,
      startedAt: 200000,
      updatedAt: 205000,
      seq: 3,
      phase: 'indexing',
      detail: 'New indexing in progress',
      canonicalPath,
      closed: false,
    };
    await writeFile(join(connDir, 'conn-new.json'), JSON.stringify(conn2, null, 2), 'utf8');

    const snapshot = await readProjectState(tempDir, projectPath);
    assert.equal(snapshot.connectionId, 'conn-new');
    assert.equal(snapshot.phase, 'indexing');
    assert.equal(snapshot.detail, 'New indexing in progress');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('late writes after close: updates after close do not overwrite closed record', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-conn-test-'));
  try {
    const projectPath = join(tempDir, 'workspace', 'my-project');
    const state = createConnectionState({
      systemPath: tempDir,
      kind: 'bridge',
      pid: process.pid,
    });

    await state.update({
      root: projectPath,
      phase: 'importing',
      detail: 'Importing workspace',
    });

    await state.close({
      phase: 'disconnected',
      detail: 'Bridge closed cleanly',
    });

    await state.update({
      phase: 'indexing',
      detail: 'Late write that must be discarded',
    });

    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    const filePath = join(connDir, `${state.connectionId}.json`);
    const written = JSON.parse(await readFile(filePath, 'utf8'));

    assert.equal(written.closed, true);
    assert.equal(written.phase, 'disconnected');
    assert.equal(written.detail, 'Bridge closed cleanly');
    assert.ok(!written.detail.includes('Late write'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('detail changes: distinct detail and progress updates within same phase are preserved', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-conn-test-'));
  try {
    const projectPath = join(tempDir, 'workspace', 'my-project');
    const state = createConnectionState({
      systemPath: tempDir,
      kind: 'bridge',
      pid: process.pid,
    });

    await state.update({
      root: projectPath,
      phase: 'indexing',
      detail: 'Step 1: scanning files',
      progress: { title: 'Indexing', message: 'Scanning files', percentage: 10 },
    });

    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    const filePath = join(connDir, `${state.connectionId}.json`);
    const snap1 = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(snap1.phase, 'indexing');
    assert.equal(snap1.detail, 'Step 1: scanning files');
    assert.equal(snap1.progress?.percentage, 10);

    await state.update({
      phase: 'indexing',
      detail: 'Step 2: resolving symbols',
      progress: { title: 'Indexing', message: 'Resolving symbols', percentage: 50 },
    });

    const snap2 = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(snap2.phase, 'indexing');
    assert.equal(snap2.detail, 'Step 2: resolving symbols');
    assert.equal(snap2.progress?.percentage, 50);
    assert.ok(snap2.seq > snap1.seq);

    await state.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('dead PID: dead connection process is treated as disconnected, avoiding false ready', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-conn-test-'));
  try {
    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    await mkdir(connDir, { recursive: true });

    const projectPath = join(tempDir, 'workspace', 'my-project');
    const { canonicalPath } = canonicalizeProject(projectPath);

    let deadPid = 999999;
    for (let p = 999999; p > 900000; p--) {
      try {
        process.kill(p, 0);
      } catch (e: unknown) {
        if (e && typeof e === 'object' && 'code' in e && e.code === 'ESRCH') {
          deadPid = p;
          break;
        }
      }
    }

    const deadConn = {
      connectionId: 'conn-dead',
      kind: 'bridge',
      pid: deadPid,
      startedAt: Date.now() - 60000,
      updatedAt: Date.now() - 30000,
      seq: 2,
      phase: 'ready',
      detail: 'Old ready before crash',
      canonicalPath,
      closed: false,
    };
    await writeFile(join(connDir, 'conn-dead.json'), JSON.stringify(deadConn, null, 2), 'utf8');

    const snapshot = await readProjectState(tempDir, projectPath);
    assert.equal(snapshot.phase, 'disconnected');
    assert.notEqual(snapshot.phase, 'ready');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('metadata errors: corrupt files or missing dirs do not throw and yield safe fallback', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-conn-test-'));
  try {
    const projectPath = join(tempDir, 'workspace', 'my-project');

    const missingSnapshot = await readProjectState(tempDir, projectPath);
    assert.equal(missingSnapshot.phase, 'not-started');

    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    await mkdir(connDir, { recursive: true });
    await writeFile(join(connDir, 'broken.json'), '{ invalid json @@ syntax', 'utf8');

    const corruptSnapshot = await readProjectState(tempDir, projectPath);
    assert.equal(corruptSnapshot.phase, 'not-started');
    assert.notEqual(corruptSnapshot.phase, 'ready');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('reduceConnectionState: correlates initialize response id and ignores random responses', () => {
  const state = reduceConnectionState(
    null,
    { id: 42, method: 'initialize', params: { rootUri: 'file:///project' } },
    'client',
  );
  assert.equal(state.phase, 'connecting');
  assert.equal(state.initializeRequestId, 42);

  const randomResponse = { id: 99, result: { capabilities: {} } };
  const unchangedState = reduceConnectionState(state, randomResponse, 'server');
  assert.equal(unchangedState.phase, 'connecting');

  const matchingResponse = { id: 42, result: { capabilities: {} } };
  const nextState = reduceConnectionState(state, matchingResponse, 'server');
  assert.equal(nextState.phase, 'importing');
  assert.equal(nextState.detail, 'Project import in progress');
});

test('reduceConnectionState: ignores task finish ($/progress kind end) and only ready-for-test sets ready', () => {
  let state = reduceConnectionState(
    null,
    { id: 1, method: 'initialize', params: { rootUri: 'file:///project' } },
    'client',
  );
  assert.equal(state.phase, 'connecting');

  state = reduceConnectionState(state, { id: 1, result: { capabilities: {} } }, 'server');
  assert.equal(state.phase, 'importing');

  state = reduceConnectionState(
    state,
    { method: 'intellij/workspaceImportState', params: { phase: 'FINISHED', folders: [] } },
    'server',
  );
  assert.equal(state.phase, 'indexing');

  state = reduceConnectionState(
    state,
    {
      method: '$/progress',
      params: {
        token: 't1',
        value: { kind: 'begin', title: 'Indexing', message: 'Scanning files', percentage: 10 },
      },
    },
    'server',
  );
  assert.equal(state.phase, 'indexing');
  assert.equal(state.detail, 'Indexing: Scanning files');

  state = reduceConnectionState(
    state,
    {
      method: '$/progress',
      params: { token: 't1', value: { kind: 'end', message: 'Done' } },
    },
    'server',
  );
  assert.equal(state.phase, 'indexing');
  assert.notEqual(state.phase, 'ready');

  state = reduceConnectionState(state, { method: 'intellij/ready-for-test', params: {} }, 'server');
  assert.equal(state.phase, 'ready');
  assert.equal(state.detail, 'IntelliJ index ready');
});

test('enqueueWrite error reporting: notifies onWriteError on failure and close() rejects', async () => {
  const invalidPath = join('Z:', 'nonexistent-drive-12345', 'path');
  const errors: unknown[] = [];
  const state = createConnectionState({
    systemPath: invalidPath,
    kind: 'bridge',
    pid: process.pid,
    onWriteError: (err) => errors.push(err),
  });

  await state.update({ phase: 'importing', detail: 'test' });
  assert.ok(errors.length > 0);

  await assert.rejects(state.close(), /ENOENT|ENOTDIR|EPERM|EINVAL/);
});

test('pruning of closed records: deletes stale closed records and older closed duplicates, preserves live records', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-conn-test-'));
  try {
    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    await mkdir(connDir, { recursive: true });

    const projectPath = join(tempDir, 'workspace', 'my-project');
    const { canonicalPath } = canonicalizeProject(projectPath);

    const liveConn = {
      connectionId: 'conn-live',
      kind: 'bridge',
      pid: process.pid,
      startedAt: Date.now() - 100000,
      updatedAt: Date.now() - 50000,
      phase: 'ready',
      canonicalPath,
      closed: false,
    };
    await writeFile(join(connDir, 'conn-live.json'), JSON.stringify(liveConn, null, 2), 'utf8');

    const staleClosed = {
      connectionId: 'conn-stale',
      kind: 'bridge',
      pid: 999999,
      startedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
      updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      phase: 'disconnected',
      canonicalPath,
      closed: true,
    };
    await writeFile(join(connDir, 'conn-stale.json'), JSON.stringify(staleClosed, null, 2), 'utf8');

    const otherProject = join(tempDir, 'workspace', 'other-project');
    const otherCanonical = canonicalizeProject(otherProject).canonicalPath;
    const closedNew = {
      connectionId: 'conn-closed-new',
      kind: 'bridge',
      pid: 999999,
      startedAt: Date.now() - 60000,
      updatedAt: Date.now() - 30000,
      phase: 'disconnected',
      canonicalPath: otherCanonical,
      closed: true,
    };
    await writeFile(
      join(connDir, 'conn-closed-new.json'),
      JSON.stringify(closedNew, null, 2),
      'utf8',
    );

    const closedOld = {
      connectionId: 'conn-closed-old',
      kind: 'bridge',
      pid: 999999,
      startedAt: Date.now() - 120000,
      updatedAt: Date.now() - 90000,
      phase: 'disconnected',
      canonicalPath: otherCanonical,
      closed: true,
    };
    await writeFile(
      join(connDir, 'conn-closed-old.json'),
      JSON.stringify(closedOld, null, 2),
      'utf8',
    );

    await readProjectState(tempDir, projectPath);

    const remaining = await readdir(connDir);
    assert.ok(remaining.includes('conn-live.json'), 'Live record was preserved');
    assert.ok(!remaining.includes('conn-stale.json'), 'Stale record > 7 days was pruned');
    assert.ok(remaining.includes('conn-closed-new.json'), 'Newest closed record was kept');
    assert.ok(!remaining.includes('conn-closed-old.json'), 'Older closed duplicate was pruned');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('dead connections preserve root cause failure without overwriting detail', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-conn-dead-'));
  try {
    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    await mkdir(connDir, { recursive: true });
    const projectPath = join(tempDir, 'workspace', 'my-project');
    const { canonicalPath } = canonicalizeProject(projectPath);

    const failedDead = {
      connectionId: 'conn-dead-failed',
      kind: 'bridge',
      pid: 999999,
      startedAt: Date.now() - 50000,
      updatedAt: Date.now() - 10000,
      seq: 2,
      phase: 'failed',
      detail: 'Project import failed: broken build.gradle',
      failure: {
        kind: 'import',
        stage: 'import',
        message: 'broken build.gradle',
      },
      canonicalPath,
      closed: false,
    };
    await writeFile(
      join(connDir, 'conn-dead-failed.json'),
      JSON.stringify(failedDead, null, 2),
      'utf8',
    );

    const snapshot = await readProjectState(tempDir, projectPath);
    assert.equal(snapshot.phase, 'failed');
    assert.equal(snapshot.detail, 'Project import failed: broken build.gradle');
    assert.ok(snapshot.failure);
    assert.equal(snapshot.failure?.kind, 'import');
    assert.equal(snapshot.failure?.message, 'broken build.gradle');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('live bridge is strictly preferred over live runner for same project', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-conn-bridge-pref-'));
  try {
    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    await mkdir(connDir, { recursive: true });
    const projectPath = join(tempDir, 'workspace', 'my-project');
    const { canonicalPath } = canonicalizeProject(projectPath);

    const runnerConn = {
      connectionId: 'conn-runner',
      kind: 'runner',
      pid: process.pid,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      seq: 1,
      phase: 'indexing',
      detail: 'Runner indexing',
      canonicalPath,
      closed: false,
    };
    await writeFile(join(connDir, 'conn-runner.json'), JSON.stringify(runnerConn, null, 2), 'utf8');

    const bridgeConn = {
      connectionId: 'conn-bridge',
      kind: 'bridge',
      pid: process.pid,
      startedAt: Date.now() - 10000,
      updatedAt: Date.now() - 5000,
      seq: 1,
      phase: 'ready',
      detail: 'Bridge ready',
      canonicalPath,
      closed: false,
    };
    await writeFile(join(connDir, 'conn-bridge.json'), JSON.stringify(bridgeConn, null, 2), 'utf8');

    const snapshot = await readProjectState(tempDir, projectPath);
    assert.equal(snapshot.connectionId, 'conn-bridge');
    assert.equal(snapshot.phase, 'ready');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('closed connections downgrade license to unknown; disk writes are sanitized', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-conn-sanitize-'));
  try {
    const projectPath = join(tempDir, 'workspace', 'my-project');
    const state = createConnectionState({
      systemPath: tempDir,
      kind: 'bridge',
    });

    await state.update({
      root: projectPath,
      phase: 'connecting',
      license: { status: 'valid', source: 'JetBrains Account' },
      failure: {
        kind: 'rpc',
        stage: 'request',
        message: 'Bearer secret_token_xyz failed',
        data: { token: 'secret-auth-token', password: 'my-password', module: ':app' },
      },
    });

    // Check disk content directly
    const connFile = join(tempDir, 'plugin-metadata', 'connections', `${state.connectionId}.json`);
    const diskContent = JSON.parse(await readFile(connFile, 'utf8')) as Record<string, unknown>;
    const failureOnDisk = diskContent.failure as Record<string, unknown>;
    const dataOnDisk = failureOnDisk.data as Record<string, unknown>;
    assert.equal(dataOnDisk.token, '[REDACTED]');
    assert.equal(dataOnDisk.password, '[REDACTED]');
    assert.equal(dataOnDisk.module, ':app');
    assert.ok(!String(failureOnDisk.message).includes('secret_token_xyz'));

    // Close connection
    await state.close({ phase: 'disconnected', detail: 'Closed' });
    const snapshot = await readProjectState(tempDir, projectPath);
    assert.equal(snapshot.license?.status, 'unknown');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
