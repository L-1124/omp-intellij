import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createConnectionState,
  readProjectState,
  reduceConnectionState,
} from '../src/project/connection-state.js';
import { canonicalizeProject } from '../src/project/metadata.js';
import { getProcessInfo } from '../src/server/service.js';

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

    const now = Date.now();
    const oldConnRecord = {
      connectionId: 'conn-old',
      kind: 'bridge',
      pid: process.pid,
      startedAt: now - 5000,
      updatedAt: now - 3000,
      seq: 5,
      phase: 'ready',
      detail: 'Old ready index',
      canonicalPath,
      closed: false,
    };
    await writeFile(join(connDir, 'conn-old.json'), JSON.stringify(oldConnRecord, null, 2), 'utf8');

    const newConnRecord = {
      connectionId: 'conn-new',
      kind: 'bridge',
      pid: process.pid,
      startedAt: now - 2000,
      updatedAt: now - 1000,
      seq: 3,
      phase: 'indexing',
      detail: 'New indexing in progress',
      canonicalPath,
      closed: false,
    };
    await writeFile(join(connDir, 'conn-new.json'), JSON.stringify(newConnRecord, null, 2), 'utf8');

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
    const firstSnapshot = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(firstSnapshot.phase, 'indexing');
    assert.equal(firstSnapshot.detail, 'Step 1: scanning files');
    assert.equal(firstSnapshot.progress?.percentage, 10);

    await state.update({
      phase: 'indexing',
      detail: 'Step 2: resolving symbols',
      progress: { title: 'Indexing', message: 'Resolving symbols', percentage: 50 },
    });

    const secondSnapshot = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(secondSnapshot.phase, 'indexing');
    assert.equal(secondSnapshot.detail, 'Step 2: resolving symbols');
    assert.equal(secondSnapshot.progress?.percentage, 50);
    assert.ok(secondSnapshot.seq > firstSnapshot.seq);

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

test('reduceConnectionState: maintains progress but preserves failed detail and failure on $/progress begin/report/end', () => {
  const failedImportMessage = {
    method: 'intellij/workspaceImportState',
    params: {
      phase: 'FAILED',
      errorMessage: 'Gradle sync failed',
      folders: [{ uri: 'file:///project', status: 'FAILED', errorMessage: 'Gradle sync failed' }],
    },
  };
  let state = reduceConnectionState(null, failedImportMessage, 'server');
  assert.equal(state.phase, 'failed');
  assert.equal(state.detail, 'Gradle sync failed');
  assert.equal(state.failure?.message, 'Gradle sync failed');
  const originalFailure = state.failure;

  const progressSteps = [
    { kind: 'begin', title: 'Indexing', message: 'Scanning files', percentage: 10 },
    { kind: 'report', title: 'Indexing', message: 'Resolving dependencies', percentage: 50 },
  ] as const;

  for (const step of progressSteps) {
    state = reduceConnectionState(
      state,
      {
        method: '$/progress',
        params: {
          token: 'task-token',
          value: step,
        },
      },
      'server',
    );
    assert.equal(state.phase, 'failed');
    assert.equal(state.detail, 'Gradle sync failed');
    assert.deepEqual(state.failure, originalFailure);
    assert.deepEqual(state.progress, {
      token: 'task-token',
      title: step.title,
      message: step.message,
      percentage: step.percentage,
    });
  }

  state = reduceConnectionState(
    state,
    {
      method: '$/progress',
      params: {
        token: 'task-token',
        value: { kind: 'end', message: 'Finished' },
      },
    },
    'server',
  );
  assert.equal(state.phase, 'failed');
  assert.equal(state.detail, 'Gradle sync failed');
  assert.deepEqual(state.failure, originalFailure);
  assert.equal(state.progress, null);

  state = reduceConnectionState(state, { method: 'intellij/ready-for-test', params: {} }, 'server');
  assert.equal(state.phase, 'failed');
  assert.equal(state.detail, 'Gradle sync failed');
  assert.deepEqual(state.failure, originalFailure);
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
test('stale failure does not pollute newly started live connection', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-stale-live-'));
  try {
    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    await mkdir(connDir, { recursive: true });
    const projectPath = join(tempDir, 'workspace', 'my-project');
    const { canonicalPath } = canonicalizeProject(projectPath);

    // Stale failure from an hour ago with dead PID
    const staleFailed = {
      connectionId: 'conn-stale-fail',
      kind: 'bridge',
      pid: 999999,
      startedAt: Date.now() - 3600000,
      updatedAt: Date.now() - 3500000,
      seq: 5,
      phase: 'failed',
      detail: 'Stale Gradle sync failure from previous crash',
      failure: {
        kind: 'import',
        stage: 'import',
        message: 'Stale Gradle error',
      },
      canonicalPath,
      closed: false,
    };
    await writeFile(
      join(connDir, 'conn-stale-fail.json'),
      JSON.stringify(staleFailed, null, 2),
      'utf8',
    );

    // New live connection currently connecting
    const liveConnecting = {
      connectionId: 'conn-live-new',
      kind: 'bridge',
      pid: process.pid,
      startedAt: Date.now() - 1000,
      updatedAt: Date.now() - 500,
      seq: 1,
      phase: 'connecting',
      detail: 'Initializing connection',
      canonicalPath,
      closed: false,
    };
    await writeFile(
      join(connDir, 'conn-live-new.json'),
      JSON.stringify(liveConnecting, null, 2),
      'utf8',
    );

    const snapshot = await readProjectState(tempDir, projectPath);
    assert.equal(snapshot.connectionId, 'conn-live-new');
    assert.equal(snapshot.phase, 'connecting');
    assert.equal(snapshot.live, true);
    assert.equal(snapshot.failure, undefined, 'Stale failure must not pollute live connection');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('stale failure does not pollute subsequent cleanly closed connection', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-stale-close-'));
  try {
    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    await mkdir(connDir, { recursive: true });
    const projectPath = join(tempDir, 'workspace', 'my-project');
    const { canonicalPath } = canonicalizeProject(projectPath);

    // Old failed connection from 2 hours ago
    const oldFailure = {
      connectionId: 'conn-old-fail',
      kind: 'bridge',
      pid: 999999,
      startedAt: Date.now() - 7200000,
      updatedAt: Date.now() - 7100000,
      seq: 2,
      phase: 'failed',
      detail: 'Old failure',
      failure: { kind: 'import', message: 'Old failure' },
      canonicalPath,
      closed: false,
    };
    await writeFile(
      join(connDir, 'conn-old-fail.json'),
      JSON.stringify(oldFailure, null, 2),
      'utf8',
    );

    // Subsequent connection that ran and cleanly disconnected
    const cleanClose = {
      connectionId: 'conn-clean-close',
      kind: 'bridge',
      pid: 999999,
      startedAt: Date.now() - 1800000,
      updatedAt: Date.now() - 1200000,
      seq: 10,
      phase: 'disconnected',
      detail: 'Session ended after the index was ready',
      canonicalPath,
      closed: true,
    };
    await writeFile(
      join(connDir, 'conn-clean-close.json'),
      JSON.stringify(cleanClose, null, 2),
      'utf8',
    );

    const snapshot = await readProjectState(tempDir, projectPath);
    assert.equal(snapshot.connectionId, 'conn-clean-close');
    assert.equal(snapshot.phase, 'disconnected');
    assert.equal(snapshot.live, false);
    assert.equal(
      snapshot.failure,
      undefined,
      'Prior failure must not pollute subsequent clean close',
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('corrupted json records are quarantined to .corrupt with bounded diagnostics', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-corrupt-quarantine-'));
  try {
    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    await mkdir(connDir, { recursive: true });
    const projectPath = join(tempDir, 'workspace', 'my-project');

    const badFile = join(connDir, 'bad-record.json');
    await writeFile(badFile, '<<< NOT VALID JSON >>>', 'utf8');

    // Backdate mtime beyond CORRUPT_GRACE_MS (e.g. 10 seconds ago)
    const tenSecondsAgo = new Date(Date.now() - 10000);
    await utimes(badFile, tenSecondsAgo, tenSecondsAgo);

    // Capture warnings
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      const snapshot = await readProjectState(tempDir, projectPath);
      assert.equal(snapshot.phase, 'not-started');

      const files = await readdir(connDir);
      assert.ok(!files.includes('bad-record.json'), 'Original broken .json was moved');
      assert.ok(
        files.some((f) => f.startsWith('bad-record.json') && f.endsWith('.corrupt')),
        'Quarantined file .corrupt was created',
      );
      assert.ok(
        warnings.some((w) => w.includes('bad-record.json')),
        'Diagnostic was logged',
      );

      // Second read should ignore .corrupt and not log new warnings
      const warningsBeforeSecondRead = warnings.length;
      await readProjectState(tempDir, projectPath);
      assert.equal(
        warnings.length,
        warningsBeforeSecondRead,
        'No duplicate log spam on subsequent poll',
      );
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('concurrent write grace period protects recently closed duplicates from premature pruning', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-grace-protect-'));
  try {
    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    await mkdir(connDir, { recursive: true });
    const projectPath = join(tempDir, 'workspace', 'my-project');
    const { canonicalPath } = canonicalizeProject(projectPath);

    // Newer closed record updated 1 second ago
    const closedNew = {
      connectionId: 'conn-closed-new',
      kind: 'bridge',
      pid: 999999,
      startedAt: Date.now() - 2000,
      updatedAt: Date.now() - 1000,
      phase: 'disconnected',
      canonicalPath,
      closed: true,
    };
    await writeFile(
      join(connDir, 'conn-closed-new.json'),
      JSON.stringify(closedNew, null, 2),
      'utf8',
    );

    // Older closed record updated 3 seconds ago (within CONCURRENT_WRITE_GRACE_MS = 15s)
    const closedOlder = {
      connectionId: 'conn-closed-older',
      kind: 'bridge',
      pid: 999999,
      startedAt: Date.now() - 5000,
      updatedAt: Date.now() - 3000,
      phase: 'disconnected',
      canonicalPath,
      closed: true,
    };
    await writeFile(
      join(connDir, 'conn-closed-older.json'),
      JSON.stringify(closedOlder, null, 2),
      'utf8',
    );

    await readProjectState(tempDir, projectPath);

    const remaining = await readdir(connDir);
    assert.ok(
      remaining.includes('conn-closed-older.json'),
      'Older record updated < 15s ago must NOT be pruned immediately (concurrent write grace)',
    );
    assert.ok(remaining.includes('conn-closed-new.json'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('orphan dead records without project path are cleaned up after retention window', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-orphan-clean-'));
  try {
    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    await mkdir(connDir, { recursive: true });
    const projectPath = join(tempDir, 'workspace', 'my-project');

    // Dead orphan record with no canonicalPath updated 2 hours ago (> ORPHAN_RETENTION_MS)
    const orphanRecord = {
      connectionId: 'conn-orphan',
      kind: 'bridge',
      pid: 999999,
      startedAt: Date.now() - 2 * 3600000,
      updatedAt: Date.now() - 2 * 3600000,
      phase: 'connecting',
      canonicalPath: null,
      closed: false,
    };
    const orphanFile = join(connDir, 'conn-orphan.json');
    await writeFile(orphanFile, JSON.stringify(orphanRecord, null, 2), 'utf8');

    await readProjectState(tempDir, projectPath);

    const remaining = await readdir(connDir);
    assert.ok(!remaining.includes('conn-orphan.json'), 'Orphaned dead record > 1h was cleaned up');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('dead unclosed records without failure are recycled after DEAD_NON_FAILURE_RETENTION_MS', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-dead-recycle-'));
  try {
    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    await mkdir(connDir, { recursive: true });
    const projectPath = join(tempDir, 'workspace', 'my-project');
    const { canonicalPath } = canonicalizeProject(projectPath);

    // Dead unclosed record without failure updated 2 hours ago (> 1 hour)
    const deadUnclosed = {
      connectionId: 'conn-dead-non-fail',
      kind: 'bridge',
      pid: 999999,
      startedAt: Date.now() - 2 * 3600000,
      updatedAt: Date.now() - 2 * 3600000,
      phase: 'connecting',
      canonicalPath,
      closed: false,
    };
    const file = join(connDir, 'conn-dead-non-fail.json');
    await writeFile(file, JSON.stringify(deadUnclosed, null, 2), 'utf8');

    await readProjectState(tempDir, projectPath);

    const remaining = await readdir(connDir);
    assert.ok(
      !remaining.includes('conn-dead-non-fail.json'),
      'Dead unclosed non-failure record was recycled',
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
test('quarantine and interrupted cleanup files expire after a day while recent files remain', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-quarantine-retention-'));
  try {
    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    await mkdir(connDir, { recursive: true });
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const suffix of ['corrupt', 'gc']) {
      const freshFile = join(connDir, `recent.json.${suffix}`);
      const oldFile = join(connDir, `expired.json.${suffix}`);
      await writeFile(freshFile, 'retained');
      await writeFile(oldFile, 'expired');
      await utimes(freshFile, recent, recent);
      await utimes(oldFile, expired, expired);
    }
    await readProjectState(tempDir, join(tempDir, 'project'));
    assert.deepEqual((await readdir(connDir)).sort(), ['recent.json.corrupt', 'recent.json.gc']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('external process identity: real spawned child process validates liveness and detects PID reuse without mock time units', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'omp-real-proc-'));
  // Spawn a real long-running child process kept alive by stdin without wall-clock timers
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  assert.ok(child.pid && child.pid > 0, 'Child process must have valid PID');

  try {
    const connDir = join(tempDir, 'plugin-metadata', 'connections');
    await mkdir(connDir, { recursive: true });
    const projectPath = join(tempDir, 'workspace', 'my-project');
    const { canonicalPath } = canonicalizeProject(projectPath);

    // Query real homologous process info from OS
    const realInfo = await getProcessInfo(child.pid);
    assert.ok(realInfo && typeof realInfo.startTime === 'number' && realInfo.startTime > 0);

    // Case 1: Long idle connection for 4 hours with matching homologous processStartTime remains live
    const idleRecord = {
      connectionId: 'conn-real-idle',
      kind: 'bridge',
      pid: child.pid,
      processStartTime: realInfo.startTime,
      startedAt: Date.now() - 4 * 3600000,
      updatedAt: Date.now() - 4 * 3600000,
      seq: 1,
      phase: 'ready',
      detail: 'IntelliJ index ready',
      canonicalPath,
      closed: false,
    };
    const idleFile = join(connDir, 'conn-real-idle.json');
    await writeFile(idleFile, JSON.stringify(idleRecord, null, 2), 'utf8');

    const liveSnapshot = await readProjectState(tempDir, projectPath);
    assert.equal(liveSnapshot.connectionId, 'conn-real-idle');
    assert.equal(liveSnapshot.phase, 'ready');
    assert.equal(
      liveSnapshot.live,
      true,
      'Real child process with matching startTime must remain live even after hours of inactivity',
    );

    // Case 2: Mismatched processStartTime detects PID reuse and does not treat as live
    const reusedRecord = {
      connectionId: 'conn-real-reused',
      kind: 'bridge',
      pid: child.pid,
      processStartTime: realInfo.startTime + 999999,
      startedAt: Date.now() - 60000,
      updatedAt: Date.now() - 60000,
      seq: 2,
      phase: 'ready',
      detail: 'Reused record',
      canonicalPath,
      closed: false,
    };
    await writeFile(idleFile, JSON.stringify(reusedRecord, null, 2), 'utf8');

    const reusedSnapshot = await readProjectState(tempDir, projectPath);
    assert.equal(
      reusedSnapshot.live,
      false,
      'Mismatched startTime on real PID must be identified as reused',
    );
    assert.equal(reusedSnapshot.phase, 'disconnected');
    assert.match(reusedSnapshot.detail, /reused/);
  } finally {
    try {
      child.stdin?.end();
      child.kill('SIGKILL');
    } catch {}
    await rm(tempDir, { recursive: true, force: true });
  }
});
