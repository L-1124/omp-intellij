import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import extension from '../src/extension/extension.js';
import type { ProjectStateResult } from '../src/project/connection-state.js';
import { canonicalizeProject } from '../src/project/metadata.js';
import type { InstallResult } from '../src/server/install.js';
import { createMockCtx, createMockPi } from './helpers.js';

test('restart completion requires a flag prefix and nested keywords are case-insensitive', () => {
  const pi = createMockPi();
  extension(pi);
  const complete = pi.getCommand('intellij')?.getArgumentCompletions;
  assert.ok(complete);
  assert.equal(complete('restart '), null);
  assert.equal(complete('restart --f')?.[0]?.value, 'restart --force');
  assert.equal(complete('workspace ENV UN')?.[0]?.value, 'workspace env unset');
  assert.equal(complete('debug ST')?.[0]?.value, 'debug status');
  assert.equal(complete('eula VI')?.[0]?.value, 'eula view');
  assert.equal(complete('WORKSPACE ENV '), null);
  assert.equal(complete('restart --F'), null);
});

test('JDK selection saves exactly the selected host label and cancellation leaves it unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-jdk-select-'));
  const javaHome = join(root, 'Java 21 (Azul)');
  const project = canonicalizeProject(root);
  const saved: string[] = [];
  const pi = createMockPi();
  extension(pi, {
    systemPath: root,
    readinessApi: { findProjectRoot: () => root },
    workspaceApi: {
      discoverJdks: async () => [
        { javaHome, version: '21', vendor: 'Azul', majorVersion: 21, source: 'fixture' },
      ],
      setWorkspaceJdk: async (projectRoot, path) => {
        saved.push(path);
        return { ...project, projectRoot, javaHome: path, javaVersion: '21' };
      },
      reimportWorkspace: async () => ({
        ready: true,
        projectRoot: root,
        canonicalPath: project.canonicalPath,
        appliedJdk: null,
        verifiedJdk: false,
      }),
    },
  });
  const command = pi.getCommand('intellij');
  assert.ok(command);
  const ctx = createMockCtx(root, {
    select: async (_title, [item]) => {
      assert.deepEqual(item, { label: javaHome, description: 'Java 21 (Azul)' });
      return typeof item === 'string' ? item : item.label;
    },
  });
  try {
    await command.handler('workspace jdk', ctx);
    assert.deepEqual(saved, [javaHome]);
    assert.match(ctx.notifications.at(-1)?.msg ?? '', /JAVA_HOME was not verified/);
    ctx.ui.select = async () => undefined;
    await command.handler('workspace jdk', ctx);
    assert.deepEqual(saved, [javaHome]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session switch unregisters the old status while preserving its in-flight install', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-observer-switch-'));
  const pi = createMockPi();
  const previous = createMockCtx(root);
  const next = createMockCtx(root);
  const watches: Array<(state: ProjectStateResult) => void> = [];
  let stopped = 0;
  const result = { executable: join(root, 'launcher'), installDir: root, version: 'test-version' };
  const install = Promise.withResolvers<InstallResult>();
  const installing = Promise.withResolvers<AbortSignal>();
  extension(pi, {
    systemPath: root,
    workspaceApi: { registerSystemPath: () => {} },
    readinessApi: {
      findProjectRoot: () => root,
      watchIndex(_path, onState) {
        watches.push(onState);
        return () => {
          stopped++;
        };
      },
    },
    serverConfigApi: {
      readServerConfig: async () => ({ mode: 'managed', installDir: root }),
      readObservedInstallState: async () => null,
      trackInstallation: async () => {},
    },
    serverInstallApi: {
      findInstalled: async () => null,
      ensureInstalled: async (_dir, options) => {
        assert.ok(options?.signal);
        options.onProgress?.({
          ...result,
          installId: 'fixture',
          phase: 'downloading',
          downloadedBytes: 1,
          updatedAt: Date.now(),
          pid: process.pid,
        });
        installing.resolve(options.signal);
        return install.promise;
      },
      readInstallState: async () => null,
    },
    versionApi: { selectServerVersion: async () => result },
  });
  let pending: Promise<void> | undefined;
  try {
    await writeFile(join(root, 'pom.xml'), '<project/>');
    await pi.emit('session_start', { type: 'session_start' }, previous);
    const command = pi.getCommand('intellij');
    assert.ok(command);
    pending = command.handler('install', previous);
    const signal = await Promise.race([
      installing.promise,
      pending.then(() => assert.fail('install finished without starting')),
    ]);
    assert.equal(typeof previous.statusCalls.at(-1)?.value, 'string');

    await pi.emit(
      'session_switch',
      { type: 'session_switch', reason: 'resume', previousSessionFile: undefined },
      next,
    );
    assert.equal(signal.aborted, false);
    assert.equal(previous.statusCalls.at(-1)?.value, undefined);
    assert.equal(typeof next.statusCalls.at(-1)?.value, 'string');
    assert.equal(stopped, 2);
    const oldStatusCount = previous.statusCalls.length;
    watches.at(-2)?.({ phase: 'ready', detail: 'stale' });
    install.resolve(result);
    await pending;
    assert.equal(previous.statusCalls.length, oldStatusCount);
    assert.deepEqual(previous.notifications, []);
    assert.match(next.notifications.at(-1)?.msg ?? '', /configured\/selected/);

    watches.at(-1)?.({ phase: 'indexing', detail: 'current project' });
    await pi.emit('session_shutdown', { type: 'session_shutdown' }, next);
    assert.equal(next.statusCalls.at(-1)?.value, undefined);
    assert.equal(stopped, 3);
  } finally {
    install.resolve(result);
    await pending;
    await pi.emit('session_shutdown', { type: 'session_shutdown' }, next);
    await rm(root, { recursive: true, force: true });
  }
});
