import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProjectStateResult } from '../src/connection-state.js';
import { findProjectRoot, watchIndex } from '../src/readiness.js';

test('findProjectRoot searches upward for project markers', async () => {
  const base = join(tmpdir(), 'omp-test-find-root-' + Math.random().toString(36).slice(2));
  const sub = join(base, 'module-a', 'src', 'main', 'java');
  await mkdir(sub, { recursive: true });
  await writeFile(join(base, 'pom.xml'), '<project></project>', 'utf8');

  try {
    const res = findProjectRoot(sub);
    assert.equal(res.toLowerCase(), base.toLowerCase());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('findProjectRoot returns cwd or startPath when no marker found', () => {
  const randomDir = join(tmpdir(), 'omp-no-marker-' + Math.random().toString(36).slice(2));
  const res = findProjectRoot(randomDir);
  assert.equal(res.toLowerCase(), randomDir.toLowerCase());
});

test('watchIndex polls state and fires onState on phase transitions', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const states: ProjectStateResult[] = [
    { phase: 'connecting', detail: 'Connecting to server', connectionId: 'c1' },
    { phase: 'importing', detail: 'Syncing Maven', connectionId: 'c1' },
    { phase: 'indexing', detail: 'Indexing source roots', connectionId: 'c1' },
    { phase: 'ready', detail: '', connectionId: 'c1' },
  ];
  let index = 0;
  const received: string[] = [];

  const readState = async (): Promise<ProjectStateResult> => {
    const s = states[index] || states[states.length - 1];
    index++;
    return s;
  };

  const stop = watchIndex(
    '/fake/project',
    (snapshot) => {
      received.push(snapshot.phase);
    },
    {
      readState,
      intervalMs: 10,
      systemPath: '/fake/system',
    },
  );

  await Promise.resolve();
  for (let index = 0; index < 3; index++) {
    t.mock.timers.tick(10);
    await Promise.resolve();
  }
  stop();

  assert.ok(received.includes('connecting'));
  assert.ok(received.includes('importing'));
  assert.ok(received.includes('indexing'));
  assert.ok(received.includes('ready'));
});

test('watchIndex preserves distinct detail and progress updates within same phase', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const snapshots: ProjectStateResult[] = [
    {
      phase: 'indexing',
      detail: 'Scanning files',
      progress: { percentage: 10 },
      connectionId: 'c1',
    },
    {
      phase: 'indexing',
      detail: 'Scanning files',
      progress: { percentage: 10 },
      connectionId: 'c1',
    },
    { phase: 'indexing', detail: 'Building AST', progress: { percentage: 50 }, connectionId: 'c1' },
    { phase: 'indexing', detail: 'Building AST', progress: { percentage: 80 }, connectionId: 'c1' },
  ];
  let callCount = 0;
  const receivedDetails: string[] = [];
  const receivedPercentages: Array<number | undefined> = [];

  const readState = async (): Promise<ProjectStateResult> => {
    const s = snapshots[callCount] || snapshots[snapshots.length - 1];
    callCount++;
    return s;
  };

  const stop = watchIndex(
    '/fake/project',
    (s) => {
      receivedDetails.push(s.detail);
      receivedPercentages.push(s.progress?.percentage);
    },
    {
      readState,
      intervalMs: 10,
      systemPath: '/fake/system',
    },
  );

  await Promise.resolve();
  for (let index = 0; index < 3; index++) {
    t.mock.timers.tick(10);
    await Promise.resolve();
  }
  stop();

  assert.deepEqual(receivedDetails, ['Scanning files', 'Building AST', 'Building AST']);
  assert.deepEqual(receivedPercentages, [10, 50, 80]);
});

test('watchIndex cleanup stops polling and rejects stale async callbacks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let callCount = 0;
  const received: string[] = [];
  const delayed = Promise.withResolvers<ProjectStateResult>();

  const readState = async (): Promise<ProjectStateResult> => {
    callCount++;
    if (callCount === 2) {
      return delayed.promise;
    }
    return { phase: 'indexing', detail: 'Step ' + callCount, connectionId: 'c1' };
  };

  const stopFn = watchIndex(
    '/fake/project',
    (snapshot) => {
      received.push(snapshot.detail);
    },
    {
      readState,
      intervalMs: 10,
      systemPath: '/fake/system',
    },
  );

  await Promise.resolve();
  t.mock.timers.tick(10);
  stopFn();
  delayed.resolve({ phase: 'ready', detail: 'stale completion', connectionId: 'c1' });
  await delayed.promise;
  await Promise.resolve();
  t.mock.timers.tick(100);
  assert.equal(callCount, 2);
  assert.deepEqual(received, ['Step 1']);
});

test('watchIndex stops polling on AbortSignal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let calls = 0;

  const readState = async (): Promise<ProjectStateResult> => {
    calls++;
    if (calls === 1) {
      controller.abort();
    }
    return { phase: 'connecting', detail: '', connectionId: 'c1' };
  };

  watchIndex('/fake/project', () => {}, {
    readState,
    intervalMs: 10,
    signal: controller.signal,
    systemPath: '/fake/system',
  });

  await Promise.resolve();
  const callsAtAbort = calls;
  t.mock.timers.tick(100);
  await Promise.resolve();

  assert.equal(calls, callsAtAbort);
});
