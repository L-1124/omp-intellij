import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyPrune, computePruneCandidates, getCacheInventory } from '../src/cache-manager.js';
import {
  createLease,
  getActiveLeases,
  getProjectLedger,
  recordConnection,
  recordReadiness,
} from '../src/metadata.js';
import { acquireLifecycleLock, isServerAlive, releaseLifecycleLock } from '../src/service.js';

test('lifecycle lock: stale observer with invalid token cannot delete new owner lock (ABA prevention)', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lock-test-'));
  try {
    const handleA = await acquireLifecycleLock({ timeoutMs: 1000, systemPath: tempRoot });
    assert.ok(handleA.token);
    assert.ok(handleA.lock);

    const staleReleased = await releaseLifecycleLock(handleA.lock, 'stale-token-uuid-1234');
    assert.equal(staleReleased, false);

    const legitReleased = await handleA.release();
    assert.equal(legitReleased, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('lifecycle lock: inactive dead PID lock throws explicit maintenance error without silent deletion', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lock-dead-'));
  try {
    const lockDir = join(tempRoot, 'omp-start.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 99999998, token: 'dead-token', createdAt: Date.now() - 50000 }),
    );

    await assert.rejects(
      () => acquireLifecycleLock({ timeoutMs: 300, systemPath: tempRoot }),
      /locked by inactive process/,
    );

    const { stat } = await import('node:fs/promises');
    await assert.doesNotReject(async () => {
      await stat(lockDir);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('metadata ledger: concurrent writes do not lose data or regress lastUsed timestamp', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-meta-test-'));
  try {
    const project = 'F:/source/test-project-alpha';

    await Promise.all([
      recordConnection(tempRoot, project, 1000),
      recordConnection(tempRoot, project, 3000),
      recordConnection(tempRoot, project, 2000),
      recordReadiness(tempRoot, project, 1500),
      recordReadiness(tempRoot, project, 3500),
      recordReadiness(tempRoot, project, 2500),
    ]);

    const ledger = await getProjectLedger(tempRoot, project);
    assert.ok(ledger);
    assert.equal(ledger.lastConnected, 3000);
    assert.equal(ledger.lastReady, 3500);
    assert.equal(ledger.connectionsCount, 3);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('leases: active live PID protects lease; dead PID cleans up', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lease-test-'));
  try {
    const project = 'F:/source/test-lease-project';

    const liveLease = await createLease(tempRoot, {
      kind: 'bridge',
      projectPath: project,
      pid: process.pid,
    });
    await createLease(tempRoot, { kind: 'observer', projectPath: project, pid: 99999999 });

    const active = await getActiveLeases(tempRoot);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, liveLease.id);

    await liveLease.release();
    const afterRelease = await getActiveLeases(tempRoot);
    assert.equal(afterRelease.length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('cache safety: unknown workspace mapping is protected and never pruned', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-unknown-test-'));
  try {
    const wsDir = join(tempRoot, 'workspaces', 'unknown1234567890abcdef12345678');
    await mkdir(join(wsDir, 'index', 'intellij-server'), { recursive: true });
    await writeFile(join(wsDir, 'index', 'intellij-server', 'unrelated.bin'), 'some data');

    const inv = await getCacheInventory(tempRoot);
    assert.equal(inv.workspaces.length, 1);
    assert.equal(inv.workspaces[0].mapping.status, 'unknown');

    const plan = computePruneCandidates(inv, {
      retentionDays: 0,
      automaticDeletion: false,
      warnAboveGiB: 5,
    });
    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.skipped.unknownCount, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('cache safety: prune refuses deletion when shared server PID is alive', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-server-alive-'));
  try {
    await writeFile(join(tempRoot, 'omp-server.json'), JSON.stringify({ pid: process.pid }));

    const serverStatus = await isServerAlive(tempRoot);
    assert.equal(serverStatus.alive, true);

    const candidate = {
      hash: 'testhash',
      path: join(tempRoot, 'workspaces', 'testhash'),
      logicalBytes: 100,
      lastUsed: Date.now(),
    };

    await assert.rejects(
      () => applyPrune([candidate], tempRoot),
      /Cannot prune cache while shared IntelliJ server is running/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('cache safety: active lease prevents workspace from becoming prune candidate', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-lease-cand-'));
  try {
    const project = 'F:/source/active-leased-project';
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const wsDir = join(tempRoot, 'workspaces', hash, 'index', 'intellij-server');
    await mkdir(wsDir, { recursive: true });

    await writeFile(
      join(wsDir, 'workspace-model-v2.cache'),
      Buffer.from('file:///F:/source/active-leased-project/ '),
    );
    await recordReadiness(tempRoot, project, Date.now() - 40 * 86400 * 1000);

    const lease = await createLease(tempRoot, {
      kind: 'bridge',
      projectPath: project,
      pid: process.pid,
    });

    const inv = await getCacheInventory(tempRoot);
    assert.equal(inv.workspaces[0].hasActiveLease, true);

    const plan = computePruneCandidates(inv, {
      retentionDays: 30,
      automaticDeletion: false,
      warnAboveGiB: 5,
    });
    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.skipped.activeLeaseCount, 1);

    await lease.release();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('cache TTL: retention based strictly on ledger use, folder mtime is ignored', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-ttl-test-'));
  try {
    const projectA = 'F:/source/old-project';
    const hashA = '11111111111111111111111111111111';
    const wsA = join(tempRoot, 'workspaces', hashA, 'index', 'intellij-server');
    await mkdir(wsA, { recursive: true });
    await writeFile(
      join(wsA, 'workspace-model-v2.cache'),
      Buffer.from('file:///F:/source/old-project/ '),
    );
    await recordReadiness(tempRoot, projectA, Date.now() - 45 * 86400 * 1000);

    const projectB = 'F:/source/recent-project';
    const hashB = '22222222222222222222222222222222';
    const wsB = join(tempRoot, 'workspaces', hashB, 'index', 'intellij-server');
    await mkdir(wsB, { recursive: true });
    await writeFile(
      join(wsB, 'workspace-model-v2.cache'),
      Buffer.from('file:///F:/source/recent-project/ '),
    );
    await recordReadiness(tempRoot, projectB, Date.now() - 2 * 86400 * 1000);

    const inv = await getCacheInventory(tempRoot);
    const plan = computePruneCandidates(inv, {
      retentionDays: 30,
      automaticDeletion: false,
      warnAboveGiB: 5,
    });

    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].hash, hashA);
    assert.equal(plan.skipped.retainedCount, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('cache safety: traversal and symlink targets are refused', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp-symlink-test-'));
  try {
    const outsideTarget = join(tempRoot, 'important-data');
    await mkdir(outsideTarget);
    await writeFile(join(outsideTarget, 'secret.txt'), 'do not delete');

    const wsDir = join(tempRoot, 'workspaces');
    await mkdir(wsDir);
    const symlinkPath = join(wsDir, 'symlink-workspace');
    await symlink(outsideTarget, symlinkPath, 'junction');

    const inv = await getCacheInventory(tempRoot);
    assert.equal(inv.workspaces.length, 0);

    const traversalCandidate = {
      hash: 'fake',
      path: join(wsDir, '..', 'important-data'),
      logicalBytes: 10,
      lastUsed: Date.now(),
    };
    const res = await applyPrune([traversalCandidate], tempRoot);
    assert.equal(res.failures.length, 1);
    assert.match(res.failures[0].error, /outside workspaces directory/);

    const { readFile: rf } = await import('node:fs/promises');
    const content = await rf(join(outsideTarget, 'secret.txt'), 'utf8');
    assert.equal(content, 'do not delete');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
