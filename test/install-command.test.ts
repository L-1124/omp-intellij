import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProjectStateResult } from '../src/connection-state.js';
import extension from '../src/extension.js';
import {
  formatInstallDescription,
  formatInstallStatusText,
  parseInstallArgs,
} from '../src/install-status.js';
import type { ServerConfiguration } from '../src/server-config.js';
import type { InstallResult, InstallState } from '../src/server-install.js';
import { createMockCtx, createMockPi } from './helpers.js';

test('parseInstallArgs preserves paths with spaces across quoting styles', () => {
  assert.deepEqual(parseInstallArgs(''), {});
  assert.deepEqual(parseInstallArgs('   '), {});
  assert.deepEqual(parseInstallArgs('--dir "C:\\Program Files\\JetBrains\\IntelliJ"'), {
    dir: 'C:\\Program Files\\JetBrains\\IntelliJ',
  });
  assert.deepEqual(parseInstallArgs("--dir 'D:/My Tools/IntelliJ Server'"), {
    dir: 'D:/My Tools/IntelliJ Server',
  });
  assert.deepEqual(parseInstallArgs('--dir F:\\path with spaces\\custom'), {
    dir: 'F:\\path with spaces\\custom',
  });
  assert.deepEqual(parseInstallArgs('--dir="C:\\Program Files\\Managed"'), {
    dir: 'C:\\Program Files\\Managed',
  });
  assert.deepEqual(parseInstallArgs('--dir=F:/unquoted with spaces/dir'), {
    dir: 'F:/unquoted with spaces/dir',
  });

  const emptyDir = parseInstallArgs('--dir');
  assert.equal(typeof emptyDir.error, 'string');
  assert.match(emptyDir.error ?? '', /empty/i);

  const emptyQuotes = parseInstallArgs('--dir ""');
  assert.equal(typeof emptyQuotes.error, 'string');
  assert.match(emptyQuotes.error ?? '', /empty/i);

  const unknownFlag = parseInstallArgs('--unknown-flag');
  assert.equal(typeof unknownFlag.error, 'string');
  assert.match(unknownFlag.error ?? '', /Usage/i);
});

test('formatInstallStatusText and formatInstallDescription format known vs unknown totalBytes', () => {
  const withTotal: InstallState = {
    installId: 'inst-1',
    pid: 1234,
    installDir: '/opt/intellij',
    version: '263.7084.0',
    phase: 'downloading',
    downloadedBytes: 150 * 1024 * 1024,
    totalBytes: 300 * 1024 * 1024,
    updatedAt: Date.now(),
  };

  const statusWithTotal = formatInstallStatusText(withTotal);
  assert.match(statusWithTotal, /^IntelliJ downloading/);
  assert.match(statusWithTotal, /50%/);
  assert.match(statusWithTotal, /150\.0 MiB \/ 300\.0 MiB/);

  const descWithTotal = formatInstallDescription(withTotal);
  assert.match(descWithTotal, /^install: downloading \(50% - 150\.0 MiB \/ 300\.0 MiB\)$/);

  const withoutTotal: InstallState = {
    ...withTotal,
    totalBytes: undefined,
  };

  const statusWithoutTotal = formatInstallStatusText(withoutTotal);
  assert.match(statusWithoutTotal, /^IntelliJ downloading/);
  assert.equal(statusWithoutTotal.includes('%'), false);
  assert.match(statusWithoutTotal, /150\.0 MiB/);

  const descWithoutTotal = formatInstallDescription(withoutTotal);
  assert.equal(descWithoutTotal.includes('%'), false);
  assert.match(descWithoutTotal, /^install: downloading \(150\.0 MiB\)$/);

  const extractingState: InstallState = { ...withTotal, phase: 'extracting' };
  assert.equal(formatInstallStatusText(extractingState), 'IntelliJ extracting');
  assert.equal(formatInstallDescription(extractingState), 'install: extracting');

  const verifyingState: InstallState = { ...withTotal, phase: 'verifying' };
  assert.equal(formatInstallStatusText(verifyingState), 'IntelliJ verifying (verifying checksum)');
  assert.equal(formatInstallDescription(verifyingState), 'install: verifying');

  const failedState: InstallState = { ...withTotal, phase: 'failed', error: 'archive corrupted' };
  assert.equal(formatInstallStatusText(failedState), 'IntelliJ failed (archive corrupted)');
  assert.equal(formatInstallDescription(failedState), 'install: failed (archive corrupted)');
});

test('install command parses custom directory with spaces, calls trackInstallation before ensureInstalled, and saves managed config on success', async () => {
  const callOrder: string[] = [];
  let trackedDir = '';
  let savedConfig: ServerConfiguration | null = null;
  const customTargetDir = 'F:\\managed storage\\custom intellij';

  const pi = createMockPi();
  extension(pi, {
    serverConfigApi: {
      async readServerConfig(): Promise<ServerConfiguration> {
        return { mode: 'external', executable: 'F:\\fallback\\server.bat' };
      },
      async trackInstallation(dir: string): Promise<void> {
        callOrder.push('trackInstallation');
        trackedDir = dir;
      },
      async saveServerConfig(config: ServerConfiguration): Promise<void> {
        callOrder.push('saveServerConfig');
        savedConfig = config;
      },
      defaultInstallDir(): string {
        return 'F:\\default\\intellij';
      },
      async readObservedInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
    serverInstallApi: {
      async ensureInstalled(dir: string): Promise<InstallResult> {
        callOrder.push('ensureInstalled');
        return {
          installDir: dir,
          version: '263.7084.0',
          executable: `${dir}\\bin\\intellij.bat`,
        };
      },
      async readInstallState(dir: string): Promise<InstallState | null> {
        return {
          installId: 'real-install-id',
          pid: process.pid,
          installDir: dir,
          version: '263.7084.0',
          phase: 'ready',
          downloadedBytes: 100,
          totalBytes: 100,
          updatedAt: Date.now(),
          executable: `${dir}\\bin\\intellij.bat`,
        };
      },
    },
  });

  try {
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx('F:\\my-project');

    await cmd.handler(`install --dir "${customTargetDir}"`, ctx);

    assert.equal(trackedDir, customTargetDir);
    assert.deepEqual(callOrder, ['trackInstallation', 'ensureInstalled', 'saveServerConfig']);
    assert.deepEqual(savedConfig, {
      mode: 'managed',
      installDir: customTargetDir,
    });
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].level, 'info');
    assert.match(ctx.notifications[0].msg, /IntelliJ server installed: 263\.7084\.0 at/);
    assert.ok(ctx.notifications[0].msg.includes(customTargetDir));
  } finally {
    pi.emit('session_shutdown');
  }
});

test('corrupt config propagates explicit error and aborts install without saving config or starting download', async () => {
  let downloadStarted = false;
  let saveConfigCalled = false;

  const pi = createMockPi();
  extension(pi, {
    serverConfigApi: {
      async readServerConfig(): Promise<ServerConfiguration> {
        throw new Error('Invalid IntelliJ configuration: ~/.omp/agent/intellij.json is corrupt');
      },
      async trackInstallation(): Promise<void> {},
      async saveServerConfig(): Promise<void> {
        saveConfigCalled = true;
      },
      defaultInstallDir(): string {
        return 'F:\\default';
      },
      async readObservedInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
    serverInstallApi: {
      async ensureInstalled(): Promise<InstallResult> {
        downloadStarted = true;
        return {
          installDir: 'F:\\default',
          version: '263.7084.0',
          executable: 'F:\\default\\bin\\intellij.bat',
        };
      },
      async readInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
  });

  try {
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx('F:\\my-project');

    await cmd.handler('install', ctx);

    assert.equal(downloadStarted, false, 'Download must not start on corrupt config');
    assert.equal(saveConfigCalled, false, 'saveServerConfig must not be called on corrupt config');
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].level, 'error');
    assert.match(ctx.notifications[0].msg, /is corrupt/);
  } finally {
    pi.emit('session_shutdown');
  }
});

test('install command without --dir uses current managed installDir if mode is managed', async () => {
  let installedDir = '';
  const currentManagedDir = 'F:\\servers\\managed-int';

  const pi = createMockPi();
  extension(pi, {
    serverConfigApi: {
      async readServerConfig(): Promise<ServerConfiguration> {
        return { mode: 'managed', installDir: currentManagedDir };
      },
      async trackInstallation(): Promise<void> {},
      async saveServerConfig(): Promise<void> {},
      defaultInstallDir(): string {
        return 'F:\\servers\\default';
      },
      async readObservedInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
    serverInstallApi: {
      async ensureInstalled(dir: string): Promise<InstallResult> {
        installedDir = dir;
        return {
          installDir: dir,
          version: '263.7084.0',
          executable: `${dir}\\bin\\intellij.bat`,
        };
      },
      async readInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
  });

  try {
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx('F:\\my-project');

    await cmd.handler('install', ctx);
    assert.equal(installedDir, currentManagedDir);
  } finally {
    pi.emit('session_shutdown');
  }
});

test('install command without --dir falls back to defaultInstallDir if mode is external', async () => {
  let installedDir = '';
  const expectedDefault = 'F:\\default\\managed-int';

  const pi = createMockPi();
  extension(pi, {
    serverConfigApi: {
      async readServerConfig(): Promise<ServerConfiguration> {
        return { mode: 'external', executable: 'F:\\external\\intellij.exe' };
      },
      async trackInstallation(): Promise<void> {},
      async saveServerConfig(): Promise<void> {},
      defaultInstallDir(): string {
        return expectedDefault;
      },
      async readObservedInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
    serverInstallApi: {
      async ensureInstalled(dir: string): Promise<InstallResult> {
        installedDir = dir;
        return {
          installDir: dir,
          version: '263.7084.0',
          executable: `${dir}\\bin\\intellij.bat`,
        };
      },
      async readInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
  });

  try {
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx('F:\\my-project');

    await cmd.handler('install', ctx);
    assert.equal(installedDir, expectedDefault);
  } finally {
    pi.emit('session_shutdown');
  }
});

test('install command failure explicitly notifies and leaves server config selection unchanged', async () => {
  let saveConfigCalled = false;
  const pi = createMockPi();
  extension(pi, {
    serverConfigApi: {
      async readServerConfig(): Promise<ServerConfiguration> {
        return { mode: 'external', executable: 'F:\\existing\\server.bat' };
      },
      async trackInstallation(): Promise<void> {},
      async saveServerConfig(): Promise<void> {
        saveConfigCalled = true;
      },
      defaultInstallDir(): string {
        return 'F:\\servers\\default';
      },
      async readObservedInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
    serverInstallApi: {
      async ensureInstalled(): Promise<InstallResult> {
        throw new Error('Checksum verification failed');
      },
      async readInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
  });

  try {
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx('F:\\my-project');

    await cmd.handler('install --dir "F:\\bad-dir"', ctx);

    assert.equal(saveConfigCalled, false, 'saveServerConfig must NOT be called on failure');
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].level, 'error');
    assert.match(ctx.notifications[0].msg, /Checksum verification failed/);
  } finally {
    pi.emit('session_shutdown');
  }
});

test('deterministic fake state transitions: downloading -> extracting -> ready restore or clear statusline', async () => {
  const entered = Promise.withResolvers<void>();
  const canFinish = Promise.withResolvers<void>();
  let progressCb: ((state: InstallState) => void) | undefined;

  const pi = createMockPi();
  extension(pi, {
    serverConfigApi: {
      async readServerConfig(): Promise<ServerConfiguration> {
        return { mode: 'external', executable: 'F:\\bin\\server.bat' };
      },
      async trackInstallation(): Promise<void> {},
      async saveServerConfig(): Promise<void> {},
      defaultInstallDir(): string {
        return 'F:\\servers\\default';
      },
      async readObservedInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
    serverInstallApi: {
      async ensureInstalled(
        dir: string,
        opts?: { onProgress?: (state: InstallState) => void },
      ): Promise<InstallResult> {
        progressCb = opts?.onProgress;
        entered.resolve();
        await canFinish.promise;
        return {
          installDir: dir,
          version: '263.7084.0',
          executable: `${dir}\\bin\\intellij.bat`,
        };
      },
      async readInstallState(dir: string): Promise<InstallState | null> {
        return {
          installId: 'test-inst',
          pid: process.pid,
          installDir: dir,
          version: '263.7084.0',
          phase: 'ready',
          downloadedBytes: 100 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
          updatedAt: Date.now(),
          executable: `${dir}\\bin\\intellij.bat`,
        };
      },
    },
  });

  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);
  const ctx = createMockCtx('F:\\my-project');

  const installPromise = cmd.handler('install --dir "F:\\managed"', ctx);

  try {
    await entered.promise;
    assert.ok(progressCb, 'onProgress callback must be captured after entering ensureInstalled');

    progressCb({
      installId: 'test-inst',
      pid: process.pid,
      installDir: 'F:\\managed',
      version: '263.7084.0',
      phase: 'downloading',
      downloadedBytes: 50 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      updatedAt: Date.now(),
    });
    const downloadingCall = ctx.statusCalls[ctx.statusCalls.length - 1];
    assert.equal(downloadingCall.key, 'intellij-index');
    assert.match(downloadingCall.value, /^IntelliJ downloading/);
    assert.match(downloadingCall.value, /50%/);

    progressCb({
      installId: 'test-inst',
      pid: process.pid,
      installDir: 'F:\\managed',
      version: '263.7084.0',
      phase: 'extracting',
      downloadedBytes: 100 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      updatedAt: Date.now(),
    });
    const extractingCall = ctx.statusCalls[ctx.statusCalls.length - 1];
    assert.equal(extractingCall.value, 'IntelliJ extracting');

    canFinish.resolve();
    await installPromise;

    const readyCall = ctx.statusCalls[ctx.statusCalls.length - 1];
    assert.equal(readyCall.value, '', 'Terminal success clears statusline when no indexing active');
  } finally {
    canFinish.resolve();
    pi.emit('session_shutdown');
  }
});

test('indexing update cannot overwrite active download progress and terminal success restores indexing', async () => {
  const entered = Promise.withResolvers<void>();
  const canFinish = Promise.withResolvers<void>();
  let progressCb: ((state: InstallState) => void) | undefined;
  let indexCb: ((state: ProjectStateResult) => void) | undefined;

  const pi = createMockPi();
  extension(pi, {
    pollIntervalMs: 500,
    readinessApi: {
      findProjectRoot: () => join(process.cwd(), 'test-fixtures', 'jvm-hybrid-app'),
      watchIndex: (_root, onState) => {
        indexCb = onState;
        return () => {};
      },
    },
    serverConfigApi: {
      async readServerConfig(): Promise<ServerConfiguration> {
        return { mode: 'managed', installDir: 'F:\\managed' };
      },
      async trackInstallation(): Promise<void> {},
      async saveServerConfig(): Promise<void> {},
      defaultInstallDir(): string {
        return 'F:\\managed';
      },
      async readObservedInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
    serverInstallApi: {
      async ensureInstalled(
        dir: string,
        opts?: { onProgress?: (state: InstallState) => void },
      ): Promise<InstallResult> {
        progressCb = opts?.onProgress;
        entered.resolve();
        await canFinish.promise;
        return {
          installDir: dir,
          version: '263.7084.0',
          executable: `${dir}\\bin\\intellij.bat`,
        };
      },
      async readInstallState(dir: string): Promise<InstallState | null> {
        return {
          installId: 'active-inst',
          pid: 9999,
          installDir: dir,
          version: '263.7084.0',
          phase: 'ready',
          downloadedBytes: 100,
          totalBytes: 100,
          updatedAt: Date.now(),
          executable: `${dir}\\bin\\intellij.bat`,
        };
      },
    },
  });

  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);
  const ctx = createMockCtx('F:\\my-project');

  const installPromise = cmd.handler('install', ctx);

  try {
    await entered.promise;
    assert.ok(progressCb);

    progressCb({
      installId: 'active-inst',
      pid: 9999,
      installDir: 'F:\\managed',
      version: '263.7084.0',
      phase: 'downloading',
      downloadedBytes: 80 * 1024 * 1024,
      totalBytes: 200 * 1024 * 1024,
      updatedAt: Date.now(),
    });

    const activeCall = ctx.statusCalls[ctx.statusCalls.length - 1];
    assert.match(activeCall.value, /^IntelliJ downloading.*40%/);

    assert.ok(indexCb);
    indexCb({
      phase: 'indexing',
      detail: 'scanning symbols',
      live: true,
    });

    const afterIndexCall = ctx.statusCalls[ctx.statusCalls.length - 1];
    assert.match(afterIndexCall.value, /^IntelliJ downloading/);
    assert.equal(afterIndexCall.value.includes('scanning symbols'), false);

    canFinish.resolve();
    await installPromise;

    const restoredCall = ctx.statusCalls[ctx.statusCalls.length - 1];
    assert.match(restoredCall.value, /^IntelliJ indexing/);
    assert.match(restoredCall.value, /scanning symbols/);

    indexCb({ phase: 'ready', detail: '', live: true });
    const finalCall = ctx.statusCalls[ctx.statusCalls.length - 1];
    assert.equal(finalCall.value, '');
  } finally {
    canFinish.resolve();
    pi.emit('session_shutdown');
  }
});

test('shutdown suppresses stale progress callbacks and cancels active command abort controller', async () => {
  const entered = Promise.withResolvers<void>();
  const canFinish = Promise.withResolvers<void>();
  let progressCb: ((state: InstallState) => void) | undefined;
  let abortSignal: AbortSignal | undefined;

  const pi = createMockPi();
  extension(pi, {
    pollIntervalMs: 20,
    serverConfigApi: {
      async readServerConfig(): Promise<ServerConfiguration> {
        return { mode: 'managed', installDir: 'F:\\managed' };
      },
      async trackInstallation(): Promise<void> {},
      async saveServerConfig(): Promise<void> {},
      defaultInstallDir(): string {
        return 'F:\\managed';
      },
      async readObservedInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
    serverInstallApi: {
      async ensureInstalled(
        dir: string,
        opts?: { signal?: AbortSignal; onProgress?: (state: InstallState) => void },
      ): Promise<InstallResult> {
        progressCb = opts?.onProgress;
        abortSignal = opts?.signal;
        entered.resolve();
        await canFinish.promise;
        return {
          installDir: dir,
          version: '263.7084.0',
          executable: `${dir}\\bin\\intellij.bat`,
        };
      },
      async readInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
  });

  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);
  const ctx = createMockCtx('F:\\my-project');

  const installPromise = cmd.handler('install', ctx);

  try {
    await entered.promise;
    assert.ok(progressCb);
    assert.ok(abortSignal);

    progressCb({
      installId: 'inst-1',
      pid: process.pid,
      installDir: 'F:\\managed',
      version: '263.7084.0',
      phase: 'downloading',
      downloadedBytes: 10 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      updatedAt: Date.now(),
    });

    pi.emit('session_shutdown');
    assert.equal(abortSignal?.aborted, true, 'Shutdown must abort owned command signal');

    const callsAfterShutdown = ctx.statusCalls.length;
    const lastCall = ctx.statusCalls[ctx.statusCalls.length - 1];
    assert.equal(lastCall.value, '', 'Shutdown must clear statusline');

    progressCb({
      installId: 'inst-1',
      pid: process.pid,
      installDir: 'F:\\managed',
      version: '263.7084.0',
      phase: 'extracting',
      downloadedBytes: 100 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      updatedAt: Date.now(),
    });

    assert.equal(
      ctx.statusCalls.length,
      callsAfterShutdown,
      'Post-shutdown callbacks must not modify statusline',
    );
  } finally {
    canFinish.resolve();
    await installPromise;
    pi.emit('session_shutdown');
  }
});

test('shutdown then session restart guards against delayed callback from prior session', async () => {
  const entered = Promise.withResolvers<void>();
  const canFinish = Promise.withResolvers<void>();
  let oldProgressCb: ((state: InstallState) => void) | undefined;

  const pi = createMockPi();
  extension(pi, {
    serverConfigApi: {
      async readServerConfig(): Promise<ServerConfiguration> {
        return { mode: 'managed', installDir: 'F:\\managed' };
      },
      async trackInstallation(): Promise<void> {},
      async saveServerConfig(): Promise<void> {},
      defaultInstallDir(): string {
        return 'F:\\managed';
      },
      async readObservedInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
    serverInstallApi: {
      async ensureInstalled(
        dir: string,
        opts?: { onProgress?: (state: InstallState) => void },
      ): Promise<InstallResult> {
        oldProgressCb = opts?.onProgress;
        entered.resolve();
        await canFinish.promise;
        return {
          installDir: dir,
          version: '263.7084.0',
          executable: `${dir}\\bin\\intellij.bat`,
        };
      },
      async readInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
  });

  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);
  const ctx1 = createMockCtx('F:\\my-project');

  const p1 = cmd.handler('install', ctx1);
  let restarted: void | Promise<void> | null = null;

  try {
    await entered.promise;
    assert.ok(oldProgressCb);
    const lateProgress = oldProgressCb;

    pi.emit('session_shutdown');

    const ctx2 = createMockCtx('F:\\my-project-2');
    restarted = cmd.handler('install --dir "F:\\managed-next"', ctx2);
    const ctx2CallsBefore = ctx2.statusCalls.length;
    const ctx1CallsBefore = ctx1.statusCalls.length;

    lateProgress({
      installId: 'old-inst',
      pid: process.pid,
      installDir: 'F:\\managed',
      version: '263.7084.0',
      phase: 'downloading',
      downloadedBytes: 50 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      updatedAt: Date.now(),
    });

    assert.equal(
      ctx2.statusCalls.length,
      ctx2CallsBefore,
      'Old session callback must not affect new session',
    );
    assert.equal(ctx1.statusCalls.length, ctx1CallsBefore);
  } finally {
    canFinish.resolve();
    await p1;
    await restarted;
    pi.emit('session_shutdown');
  }
});

test('polling preserves in-flight active install when observed state is null or older snapshot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let pollReads = 0;
  let observedState: InstallState | null = null;
  const entered = Promise.withResolvers<void>();
  const canFinish = Promise.withResolvers<void>();
  let progressCb: ((state: InstallState) => void) | undefined;

  const pi2 = createMockPi();
  extension(pi2, {
    pollIntervalMs: 500,
    serverConfigApi: {
      async readServerConfig(): Promise<ServerConfiguration> {
        return { mode: 'managed', installDir: 'F:\\managed' };
      },
      async trackInstallation(): Promise<void> {},
      async saveServerConfig(): Promise<void> {},
      defaultInstallDir(): string {
        return 'F:\\managed';
      },
      async readObservedInstallState(): Promise<InstallState | null> {
        pollReads++;
        return observedState;
      },
    },
    serverInstallApi: {
      async ensureInstalled(
        dir: string,
        opts?: { onProgress?: (state: InstallState) => void },
      ): Promise<InstallResult> {
        progressCb = opts?.onProgress;
        entered.resolve();
        await canFinish.promise;
        return {
          installDir: dir,
          version: '263.7084.0',
          executable: `${dir}\\bin\\intellij.bat`,
        };
      },
      async readInstallState(): Promise<InstallState | null> {
        return null;
      },
    },
  });

  const cmd2 = pi2.getCommand('intellij');
  assert.ok(cmd2);
  const ctx2 = createMockCtx('F:\\my-project');

  const p2 = cmd2.handler('install', ctx2);

  try {
    await entered.promise;
    assert.ok(progressCb);

    progressCb({
      installId: 'in-flight-id',
      pid: 1234,
      installDir: 'F:\\managed',
      version: '263.7084.0',
      phase: 'downloading',
      downloadedBytes: 80 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      updatedAt: 2000,
    });

    const activeCall = ctx2.statusCalls[ctx2.statusCalls.length - 1];
    assert.match(activeCall.value, /^IntelliJ downloading.*80%/);

    observedState = {
      installId: 'in-flight-id',
      pid: 1234,
      installDir: 'F:\\managed',
      version: '263.7084.0',
      phase: 'downloading',
      downloadedBytes: 20 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      updatedAt: 1000,
    };
    const readsBefore = pollReads;
    t.mock.timers.tick(500);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(pollReads, readsBefore + 1);

    const lastCall = ctx2.statusCalls[ctx2.statusCalls.length - 1];
    assert.match(lastCall.value, /80%/);

    observedState = null;
    t.mock.timers.tick(500);
    await Promise.resolve();
    await Promise.resolve();
    const stillActive = ctx2.statusCalls[ctx2.statusCalls.length - 1];
    assert.match(stillActive.value, /80%/);
  } finally {
    canFinish.resolve();
    await p2;
    pi2.emit('session_shutdown');
  }
});

test('stale historical install state does not trigger completion notification', async () => {
  const staleTime = Date.now() - 60000;
  const observedState: InstallState = {
    installId: 'old-inst',
    pid: 1111,
    installDir: 'F:\\managed',
    version: '263.7084.0',
    phase: 'ready',
    downloadedBytes: 100,
    totalBytes: 100,
    updatedAt: staleTime,
  };

  const pi = createMockPi();
  extension(pi, {
    pollIntervalMs: 500,
    serverConfigApi: {
      async readServerConfig(): Promise<ServerConfiguration> {
        return { mode: 'managed', installDir: 'F:\\managed' };
      },
      async trackInstallation(): Promise<void> {},
      async saveServerConfig(): Promise<void> {},
      defaultInstallDir(): string {
        return 'F:\\managed';
      },
      async readObservedInstallState(): Promise<InstallState | null> {
        return observedState;
      },
    },
  });

  try {
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx('F:\\my-project');

    await cmd.handler('status', ctx);

    const readyNotifs = ctx.notifications.filter((n) =>
      n.msg.includes('IntelliJ server installed'),
    );
    assert.equal(readyNotifs.length, 0, 'Stale historical state must not notify ready');
  } finally {
    pi.emit('session_shutdown');
  }
});

test('/intellij status displays selected mode, path, install info with percent only when total known', async () => {
  const observedWithTotal: InstallState = {
    installId: 'inst-status',
    pid: 2222,
    installDir: 'F:\\managed\\server',
    version: '263.7084.0',
    phase: 'downloading',
    downloadedBytes: 60 * 1024 * 1024,
    totalBytes: 120 * 1024 * 1024,
    updatedAt: Date.now(),
  };

  const pi = createMockPi();
  extension(pi, {
    serverConfigApi: {
      async readServerConfig(): Promise<ServerConfiguration> {
        return { mode: 'managed', installDir: 'F:\\managed\\server' };
      },
      async trackInstallation(): Promise<void> {},
      async saveServerConfig(): Promise<void> {},
      defaultInstallDir(): string {
        return 'F:\\managed\\server';
      },
      async readObservedInstallState(): Promise<InstallState | null> {
        return observedWithTotal;
      },
    },
  });

  try {
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx('F:\\my-project');

    await cmd.handler('status', ctx);
    assert.equal(ctx.notifications.length, 1);
    const msg = ctx.notifications[0].msg;

    assert.match(msg, /server \(managed\): F:\\managed\\server/);
    assert.match(msg, /install: downloading \(50% - 60\.0 MiB \/ 120\.0 MiB\)/);
  } finally {
    pi.emit('session_shutdown');
  }
});

test('/intellij install never implicitly accepts EULA or writes eula acceptance file', async () => {
  const confDir = join(tmpdir(), 'omp-install-no-eula-conf-' + Math.random().toString(36).slice(2));
  const installDir = join(
    tmpdir(),
    'omp-install-no-eula-target-' + Math.random().toString(36).slice(2),
  );
  await mkdir(confDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  const configFile = join(confDir, 'intellij.json');
  await writeFile(
    configFile,
    JSON.stringify({
      mode: 'managed',
      installDir,
    }),
    'utf8',
  );
  const eulaStoreFile = join(confDir, 'intellij-eula.json');

  const fakeResult: InstallResult = {
    executable: join(installDir, 'bin', 'intellij-server.exe'),
    version: '263.7084.0',
    installDir,
  };
  const fakeState: InstallState = {
    installId: 'inst-never-eula',
    pid: process.pid,
    installDir,
    version: '263.7084.0',
    phase: 'ready',
    downloadedBytes: 100,
    executable: fakeResult.executable,
    updatedAt: Date.now(),
  };

  try {
    const pi = createMockPi();
    extension(pi, {
      configFile,
      serverInstallApi: {
        async ensureInstalled(): Promise<InstallResult> {
          return fakeResult;
        },
        async readInstallState(): Promise<InstallState> {
          return fakeState;
        },
      },
    });

    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx('F:\\my-project');

    await cmd.handler('install', ctx);
    assert.ok(ctx.notifications.some((n) => n.msg.includes('IntelliJ server installed')));

    // Crucial check: intellij-eula.json must NOT exist or be created by install
    await assert.rejects(readFile(eulaStoreFile, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(confDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  }
});
