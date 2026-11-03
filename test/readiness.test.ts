import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { detectProjectRoot } from '../src/debug/run-core.js';
import type { ProjectStateResult } from '../src/project/connection-state.js';
import { findProjectRoot, watchIndex } from '../src/project/readiness.js';

test('findProjectRoot searches upward for project markers', async () => {
  const base = join(tmpdir(), `omp-test-find-root-${Math.random().toString(36).slice(2)}`);
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
  const randomDir = join(tmpdir(), `omp-no-marker-${Math.random().toString(36).slice(2)}`);
  const res = findProjectRoot(randomDir);
  assert.equal(res.toLowerCase(), randomDir.toLowerCase());
});

test('findProjectRoot prefers nearest build marker over outer unrelated .git in monorepo', async () => {
  const base = join(tmpdir(), `omp-test-monorepo-${Math.random().toString(36).slice(2)}`);
  const gitDir = join(base, '.git');
  const childMaven = join(base, 'packages', 'child-maven');
  const childSrc = join(childMaven, 'src', 'main', 'java');
  const sourceFile = join(childSrc, 'App.java');

  await mkdir(gitDir, { recursive: true });
  await mkdir(childSrc, { recursive: true });
  await writeFile(join(childMaven, 'pom.xml'), '<project></project>', 'utf8');
  await writeFile(sourceFile, 'public class App {}', 'utf8');

  try {
    const fromDir = findProjectRoot(childSrc);
    const fromFile = findProjectRoot(sourceFile);
    const fromUri = findProjectRoot(pathToFileURL(sourceFile).href);

    assert.equal(fromDir.toLowerCase(), childMaven.toLowerCase());
    assert.equal(fromFile.toLowerCase(), childMaven.toLowerCase());
    assert.equal(fromUri.toLowerCase(), childMaven.toLowerCase());

    assert.equal(detectProjectRoot(sourceFile).toLowerCase(), childMaven.toLowerCase());
    assert.equal(detectProjectRoot(childSrc).toLowerCase(), childMaven.toLowerCase());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('findProjectRoot identifies sibling Maven and Gradle child projects in same monorepo', async () => {
  const base = join(tmpdir(), `omp-test-siblings-${Math.random().toString(36).slice(2)}`);
  const gitDir = join(base, '.git');
  const mavenSvc = join(base, 'services', 'maven-svc');
  const mavenSrc = join(mavenSvc, 'src', 'main', 'java');
  const gradleSvc = join(base, 'services', 'gradle-svc');
  const gradleSrc = join(gradleSvc, 'src', 'main', 'kotlin');

  await mkdir(gitDir, { recursive: true });
  await mkdir(mavenSrc, { recursive: true });
  await mkdir(gradleSrc, { recursive: true });
  await writeFile(join(mavenSvc, 'pom.xml'), '<project></project>', 'utf8');
  await writeFile(join(gradleSvc, 'build.gradle.kts'), '// kotlin dsl', 'utf8');

  try {
    const mavenRoot = findProjectRoot(mavenSrc);
    const gradleRoot = findProjectRoot(gradleSrc);

    assert.equal(mavenRoot.toLowerCase(), mavenSvc.toLowerCase());
    assert.equal(gradleRoot.toLowerCase(), gradleSvc.toLowerCase());

    assert.equal(detectProjectRoot(mavenSrc).toLowerCase(), mavenSvc.toLowerCase());
    assert.equal(detectProjectRoot(gradleSrc).toLowerCase(), gradleSvc.toLowerCase());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('findProjectRoot falls back to .git only when no supported build/project marker exists', async () => {
  const base = join(tmpdir(), `omp-test-fallback-${Math.random().toString(36).slice(2)}`);
  const gitDir = join(base, '.git');
  const nested = join(base, 'tools', 'scripts');
  const scriptFile = join(nested, 'run.sh');

  await mkdir(gitDir, { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(scriptFile, '#!/bin/sh', 'utf8');

  try {
    const resDir = findProjectRoot(nested);
    const resFile = findProjectRoot(scriptFile);

    assert.equal(resDir.toLowerCase(), base.toLowerCase());
    assert.equal(resFile.toLowerCase(), base.toLowerCase());

    assert.equal(detectProjectRoot(scriptFile).toLowerCase(), base.toLowerCase());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('findProjectRoot recognizes IntelliJ .idea and .iml module markers', async () => {
  const base = join(tmpdir(), `omp-test-idea-${Math.random().toString(36).slice(2)}`);
  const gitDir = join(base, '.git');
  const ideaProject = join(base, 'apps', 'idea-app');
  const imlProject = join(base, 'apps', 'iml-app');
  const ideaSrc = join(ideaProject, 'src');
  const imlSrc = join(imlProject, 'src');

  await mkdir(gitDir, { recursive: true });
  await mkdir(join(ideaProject, '.idea'), { recursive: true });
  await mkdir(ideaSrc, { recursive: true });
  await mkdir(imlSrc, { recursive: true });
  await writeFile(join(imlProject, 'custom-module.iml'), '<module/>', 'utf8');

  try {
    const resIdea = findProjectRoot(ideaSrc);
    const resIml = findProjectRoot(imlSrc);

    assert.equal(resIdea.toLowerCase(), ideaProject.toLowerCase());
    assert.equal(resIml.toLowerCase(), imlProject.toLowerCase());

    assert.equal(detectProjectRoot(ideaSrc).toLowerCase(), ideaProject.toLowerCase());
    assert.equal(detectProjectRoot(imlSrc).toLowerCase(), imlProject.toLowerCase());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('findProjectRoot returns nearest nested module root rather than outer aggregator', async () => {
  const base = join(tmpdir(), `omp-test-multimodule-${Math.random().toString(36).slice(2)}`);
  const subModule = join(base, 'sub-module');
  const subSrc = join(subModule, 'src', 'main', 'java');

  await mkdir(subSrc, { recursive: true });
  await writeFile(
    join(base, 'pom.xml'),
    '<project><modules><module>sub-module</module></modules></project>',
    'utf8',
  );
  await writeFile(join(subModule, 'pom.xml'), '<project></project>', 'utf8');

  try {
    const res = findProjectRoot(subSrc);
    assert.equal(res.toLowerCase(), subModule.toLowerCase());
    assert.equal(detectProjectRoot(subSrc).toLowerCase(), subModule.toLowerCase());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
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
    return { phase: 'indexing', detail: `Step ${callCount}`, connectionId: 'c1' };
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

test('watchIndex fires onState when failure or license changes in stable phase', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const snapshots: ProjectStateResult[] = [
    {
      phase: 'ready',
      detail: '',
      connectionId: 'c1',
      license: { status: 'valid' },
    },
    {
      phase: 'ready',
      detail: '',
      connectionId: 'c1',
      license: { status: 'needs-activation', featuresDeclined: true, reason: 'License expired' },
    },
    {
      phase: 'ready',
      detail: '',
      connectionId: 'c1',
      license: { status: 'valid' },
      failure: {
        kind: 'rpc',
        stage: 'request',
        message: 'Compilation warning',
      },
    },
  ];
  let callCount = 0;
  const receivedLicenses: Array<string | undefined> = [];
  const receivedFailures: Array<string | undefined> = [];

  const readState = async (): Promise<ProjectStateResult> => {
    const s = snapshots[callCount] || snapshots[snapshots.length - 1];
    callCount++;
    return s;
  };

  const stop = watchIndex(
    '/fake/project',
    (s) => {
      receivedLicenses.push(s.license?.status);
      receivedFailures.push(s.failure?.message);
    },
    {
      readState,
      intervalMs: 10,
      systemPath: '/fake/system',
    },
  );

  await Promise.resolve();
  t.mock.timers.tick(10);
  await Promise.resolve();
  t.mock.timers.tick(10);
  await Promise.resolve();
  stop();

  assert.equal(receivedLicenses.length, 3);
  assert.deepEqual(receivedLicenses, ['valid', 'needs-activation', 'valid']);
  assert.equal(receivedFailures[2], 'Compilation warning');
});

test('watchIndex dedups identical failure and license updates without repeated onState calls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixedSnapshot: ProjectStateResult = {
    phase: 'indexing',
    detail: 'Building index',
    connectionId: 'c1',
    license: { status: 'needs-activation', featuresDeclined: true },
    failure: {
      kind: 'authorization',
      stage: 'initialize',
      message: 'Features declined',
    },
  };
  let onStateCalls = 0;

  const readState = async (): Promise<ProjectStateResult> => fixedSnapshot;

  const stop = watchIndex(
    '/fake/project',
    () => {
      onStateCalls++;
    },
    {
      readState,
      intervalMs: 10,
      systemPath: '/fake/system',
    },
  );

  await Promise.resolve();
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(10);
    await Promise.resolve();
  }
  stop();

  assert.equal(onStateCalls, 1, 'identical failure and license updates must be deduped');
});
