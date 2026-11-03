import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import extension from '../src/extension/extension.js';
import {
  formatInstallDescription,
  formatInstallStatusText,
  parseInstallArgs,
} from '../src/extension/install-status.js';
import type { ProjectStateResult } from '../src/project/connection-state.js';
import type { ServerConfiguration } from '../src/server/config.js';
import type { InstallResult, InstallState } from '../src/server/install.js';
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

  // Both flag orders and version parsing
  assert.deepEqual(parseInstallArgs('--version 263.7084.0 --dir "C:\\Program Files\\IntelliJ"'), {
    version: '263.7084.0',
    dir: 'C:\\Program Files\\IntelliJ',
  });
  assert.deepEqual(parseInstallArgs('--dir "C:\\Program Files\\IntelliJ" --version 263.7084.0'), {
    version: '263.7084.0',
    dir: 'C:\\Program Files\\IntelliJ',
  });
  assert.deepEqual(parseInstallArgs('--version=263.7084.0 --dir="D:/tools"'), {
    version: '263.7084.0',
    dir: 'D:/tools',
  });
  assert.deepEqual(parseInstallArgs('--version 263.7084.0 --dir F:\\path with spaces\\dir'), {
    version: '263.7084.0',
    dir: 'F:\\path with spaces\\dir',
  });
  assert.deepEqual(parseInstallArgs('--dir F:\\path with spaces\\dir --version 263.7084.0'), {
    version: '263.7084.0',
    dir: 'F:\\path with spaces\\dir',
  });
  assert.deepEqual(parseInstallArgs('--version latest'), {
    version: 'latest',
  });
  assert.match(parseInstallArgs('--version').error ?? '', /version must not be empty/i);
  assert.match(parseInstallArgs('--version ""').error ?? '', /version must not be empty/i);
  assert.match(
    parseInstallArgs('--version --dir "D:/tools"').error ?? '',
    /version must not be empty/i,
  );
  assert.match(
    parseInstallArgs('--dir --version 263.7084.0').error ?? '',
    /directory must not be empty/i,
  );
  assert.match(
    parseInstallArgs('--version 1.0.0 --version 2.0.0').error ?? '',
    /duplicate --version/i,
  );
  assert.match(parseInstallArgs('--dir /a --dir /b').error ?? '', /duplicate --dir/i);
  assert.match(
    parseInstallArgs('--version 263.7084.0 extra').error ?? '',
    /unexpected argument: extra/i,
  );
  assert.match(parseInstallArgs('--dir "C:/dir" extra').error ?? '', /unexpected argument: extra/i);
  assert.ok(parseInstallArgs('--dir "unfinished directory').error);
  assert.ok(parseInstallArgs("--version '263.7084.0").error);
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
      versionApi: {
        async selectServerVersion() {
          return fakeResult;
        },
      },
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

test('/intellij install --version resolves bundle, passes it to ensureInstalled, and pins version', async () => {
  let resolvedVersionArg = '';
  let installedBundleVersion = '';
  let selectedVersion = '';
  const fakeTargetDir = 'F:\\managed\\intellij';

  const pi = createMockPi();
  extension(pi, {
    serverConfigApi: {
      async readServerConfig() {
        return { mode: 'managed', installDir: fakeTargetDir };
      },
      async trackInstallation() {},
      async saveServerConfig() {},
      defaultInstallDir: () => fakeTargetDir,
      async readObservedInstallState() {
        return null;
      },
    },
    versionApi: {
      async resolveServerBundle(version) {
        resolvedVersionArg = version;
        return {
          version,
          url: `https://download.jetbrains.com/test/${version}.zip`,
          sha256: 'a'.repeat(64),
          archive: 'zip',
        };
      },
      async selectServerVersion(version) {
        selectedVersion = version;
        return {
          installDir: fakeTargetDir,
          version,
          executable: `${fakeTargetDir}\\bin\\intellij.bat`,
        };
      },
    },
    serverInstallApi: {
      async ensureInstalled(dir, opts) {
        installedBundleVersion = opts?.bundle?.version ?? '';
        return {
          installDir: dir,
          version: opts?.bundle?.version ?? '263.7084.0',
          executable: `${dir}\\bin\\intellij.bat`,
        };
      },
      async readInstallState(dir) {
        return {
          installId: 'inst-custom-ver',
          pid: process.pid,
          installDir: dir,
          version: '263.8000.0',
          phase: 'ready',
          downloadedBytes: 100,
          totalBytes: 100,
          updatedAt: Date.now(),
        };
      },
    },
  });

  try {
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx('F:\\my-project');

    await cmd.handler('install --version 263.8000.0', ctx);

    assert.equal(resolvedVersionArg, '263.8000.0');
    assert.equal(installedBundleVersion, '263.8000.0');
    assert.equal(selectedVersion, '263.8000.0');
    assert.equal(ctx.notifications.length, 1);
    assert.match(ctx.notifications[0].msg, /IntelliJ server installed: 263\.8000\.0/);
    assert.match(ctx.notifications[0].msg, /configured\/selected; start explicitly/);
  } finally {
    pi.emit('session_shutdown');
  }
});

test('/intellij install without --version defaults to existing managed pin rather than bundled default', async () => {
  let resolvedVersionArg = '';
  let installedBundleVersion = '';
  const fakeTargetDir = 'F:\\managed\\intellij';

  const pi = createMockPi();
  extension(pi, {
    serverConfigApi: {
      async readServerConfig() {
        return { mode: 'managed', installDir: fakeTargetDir, version: '263.9999.0' };
      },
      async trackInstallation() {},
      async saveServerConfig() {},
      defaultInstallDir: () => fakeTargetDir,
      async readObservedInstallState() {
        return null;
      },
    },
    versionApi: {
      async resolveServerBundle(version) {
        resolvedVersionArg = version;
        return {
          version,
          url: `https://download.jetbrains.com/test/${version}.zip`,
          sha256: 'b'.repeat(64),
          archive: 'zip',
        };
      },
      async selectServerVersion(version) {
        return {
          installDir: fakeTargetDir,
          version,
          executable: `${fakeTargetDir}\\bin\\intellij.bat`,
        };
      },
    },
    serverInstallApi: {
      async ensureInstalled(dir, opts) {
        installedBundleVersion = opts?.bundle?.version ?? '';
        return {
          installDir: dir,
          version: opts?.bundle?.version ?? '263.9999.0',
          executable: `${dir}\\bin\\intellij.bat`,
        };
      },
      async readInstallState(dir) {
        return {
          installId: 'inst-pin-preserve',
          pid: process.pid,
          installDir: dir,
          version: '263.9999.0',
          phase: 'ready',
          downloadedBytes: 100,
          totalBytes: 100,
          updatedAt: Date.now(),
        };
      },
    },
  });

  try {
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx('F:\\my-project');

    await cmd.handler('install', ctx);

    assert.equal(resolvedVersionArg, '263.9999.0', 'Must resolve existing pinned version');
    assert.equal(installedBundleVersion, '263.9999.0');
  } finally {
    pi.emit('session_shutdown');
  }
});

test('/intellij install when selectServerVersion is blocked notifies installed-but-not-selected and does not claim install failed', async () => {
  let savedConfigCalled = false;
  const fakeTargetDir = 'F:\\managed\\custom-dir';

  const pi = createMockPi();
  extension(pi, {
    serverConfigApi: {
      async readServerConfig() {
        return { mode: 'managed', installDir: 'F:\\managed\\old-dir', version: '263.7084.0' };
      },
      async trackInstallation() {},
      async saveServerConfig() {
        savedConfigCalled = true;
      },
      defaultInstallDir: () => 'F:\\managed\\old-dir',
      async readObservedInstallState() {
        return null;
      },
    },
    versionApi: {
      async selectServerVersion() {
        throw new Error(
          'Cannot select IntelliJ version while the shared server is running or its ownership is unverified. Run /intellij stop first.',
        );
      },
    },
    serverInstallApi: {
      async ensureInstalled(dir) {
        return {
          installDir: dir,
          version: '263.7084.0',
          executable: `${dir}\\bin\\intellij.bat`,
        };
      },
      async readInstallState(dir) {
        return {
          installId: 'inst-blocked',
          pid: process.pid,
          installDir: dir,
          version: '263.7084.0',
          phase: 'ready',
          downloadedBytes: 100,
          totalBytes: 100,
          updatedAt: Date.now(),
        };
      },
    },
  });

  try {
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx('F:\\my-project');

    await cmd.handler(`install --dir "${fakeTargetDir}"`, ctx);

    assert.equal(savedConfigCalled, false, 'Config must not be updated when selection is blocked');
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].level, 'warning');
    // Must NOT say installation failed
    assert.equal(ctx.notifications[0].msg.includes('installation failed'), false);
    // Must report installed, but not selected with guidance
    assert.match(ctx.notifications[0].msg, /IntelliJ server installed: 263\.7084\.0 at/);
    assert.match(ctx.notifications[0].msg, /not selected/);
    assert.match(ctx.notifications[0].msg, /Run \/intellij stop first/);
    assert.match(ctx.notifications[0].msg, /re-run \/intellij install --version/);
  } finally {
    pi.emit('session_shutdown');
  }
});

test('/intellij versions lists installed, selected version, path, running status, and avoids network without --remote', async () => {
  let latestCalled = false;
  const fakeDir = 'F:\\managed\\store';

  const pi = createMockPi();
  extension(pi, {
    serverConfigApi: {
      async readServerConfig() {
        return { mode: 'managed', installDir: fakeDir, version: '263.7084.0' };
      },
    },
    serverInstallApi: {
      async listInstalledVersions() {
        return [
          {
            version: '263.7084.0',
            installDir: fakeDir,
            executable: `${fakeDir}\\bin\\intellij.bat`,
          },
          {
            version: '263.7083.0',
            installDir: fakeDir,
            executable: `${fakeDir}\\bin\\intellij.bat`,
          },
        ];
      },
    },
    versionApi: {
      async latestServerVersion() {
        latestCalled = true;
        return '263.9000.0';
      },
    },
  });

  try {
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx('F:\\my-project');

    await cmd.handler('versions', ctx);

    assert.equal(latestCalled, false, 'latestServerVersion must NOT be called without --remote');
    assert.equal(ctx.notifications.length, 1);
    const msg = ctx.notifications[0].msg;
    assert.match(msg, /Selected version: 263\.7084\.0/);
    assert.match(msg, /Installed versions: 263\.7084\.0 \(selected\), 263\.7083\.0/);
    assert.match(msg, /Server status: stopped/);
  } finally {
    pi.emit('session_shutdown');
  }
});

test('/intellij versions --remote explicitly queries remote latest version', async () => {
  let latestCalled = false;
  const fakeDir = 'F:\\managed\\store';

  const pi = createMockPi();
  extension(pi, {
    serverConfigApi: {
      async readServerConfig() {
        return { mode: 'managed', installDir: fakeDir, version: '263.7084.0' };
      },
    },
    serverInstallApi: {
      async listInstalledVersions() {
        return [
          {
            version: '263.7084.0',
            installDir: fakeDir,
            executable: `${fakeDir}\\bin\\intellij.bat`,
          },
        ];
      },
    },
    versionApi: {
      async latestServerVersion() {
        latestCalled = true;
        return '263.9000.0';
      },
    },
  });

  try {
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx('F:\\my-project');

    await cmd.handler('versions --remote', ctx);

    assert.equal(latestCalled, true);
    assert.equal(ctx.notifications.length, 1);
    assert.match(ctx.notifications[0].msg, /Latest remote version: 263\.9000\.0/);
  } finally {
    pi.emit('session_shutdown');
  }
});

test('/intellij use <version> validates arguments, invokes selectServerVersion, reports EULA gate, and never starts server', async () => {
  let selectedVersion = '';
  const baseDir = join(tmpdir(), 'omp-use-test-' + Math.random().toString(36).slice(2));
  const binDir = join(baseDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const launcherName = process.platform === 'win32' ? 'intellij-server.exe' : 'intellij-server';
  const launcherPath = join(binDir, launcherName);
  await writeFile(launcherPath, '#!/bin/sh\nexit 0', { mode: 0o755 });
  await writeFile(join(baseDir, 'EULA.txt'), 'Sample terms', 'utf8');

  const confDir = join(tmpdir(), 'omp-use-conf-' + Math.random().toString(36).slice(2));
  await mkdir(confDir, { recursive: true });
  const configFile = join(confDir, 'intellij.json');

  const pi = createMockPi();
  extension(pi, {
    configFile,
    versionApi: {
      async selectServerVersion(ver) {
        selectedVersion = ver;
        return {
          version: ver,
          installDir: baseDir,
          executable: launcherPath,
        };
      },
    },
  });

  try {
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx('F:\\my-project');

    // Missing version
    await cmd.handler('use', ctx);
    assert.match(
      ctx.notifications[ctx.notifications.length - 1].msg,
      /Usage: \/intellij use <version>/,
    );

    // Latest rejected
    await cmd.handler('use latest', ctx);
    assert.match(
      ctx.notifications[ctx.notifications.length - 1].msg,
      /requires an explicit numeric build version/,
    );

    // Valid version
    await cmd.handler('use 263.7084.0', ctx);
    assert.equal(selectedVersion, '263.7084.0');
    const successMsg = ctx.notifications[ctx.notifications.length - 1].msg;
    assert.match(successMsg, /Selected IntelliJ server 263\.7084\.0/);
    assert.match(successMsg, /EULA not accepted/);
    assert.match(successMsg, /Run \/intellij eula accept/);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
    await rm(confDir, { recursive: true, force: true });
    pi.emit('session_shutdown');
  }
});

test('EULA commands verify chosen configured version via findInstalled rather than last readInstallState', async () => {
  let findInstalledVersionChecked = '';
  const confDir = join(tmpdir(), 'omp-eula-ver-conf-' + Math.random().toString(36).slice(2));
  await mkdir(confDir, { recursive: true });
  const configFile = join(confDir, 'intellij.json');
  await writeFile(
    configFile,
    JSON.stringify({
      server: { mode: 'managed', installDir: 'F:\\managed\\server', version: '263.8888.0' },
    }),
    'utf8',
  );

  const pi = createMockPi();
  extension(pi, {
    configFile,
    serverInstallApi: {
      async readInstallState() {
        return {
          installId: 'old-inst',
          pid: 1234,
          installDir: 'F:\\managed\\server',
          version: '263.7084.0',
          phase: 'ready',
          downloadedBytes: 100,
          totalBytes: 100,
          updatedAt: Date.now(),
          executable: 'F:\\managed\\server\\bin\\old-intellij.bat',
        };
      },
      async findInstalled(_dir, bundle) {
        findInstalledVersionChecked = bundle?.version ?? '';
        return null;
      },
    },
  });

  try {
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx('F:\\my-project');

    await cmd.handler('eula status', ctx);

    assert.equal(
      findInstalledVersionChecked,
      '263.8888.0',
      'findInstalled must check the configured version',
    );
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].level, 'warning');
    assert.match(
      ctx.notifications[0].msg,
      /Managed IntelliJ server is not installed \(263\.8888\.0\)/,
    );
  } finally {
    await rm(confDir, { recursive: true, force: true });
    pi.emit('session_shutdown');
  }
});

test('cached installation and rollback commands preserve selected receipts offline without accepting EULA', async (t) => {
  const root = join(tmpdir(), `omp-offline-version-command-${Math.random().toString(36).slice(2)}`);
  const installDir = join(root, 'installation');
  const systemPath = join(root, 'system');
  const configFile = join(root, 'intellij.json');
  const versions = ['263.3000.0', '263.4000.0'];
  const launcherName = process.platform === 'win32' ? 'intellij-server.exe' : 'intellij-server';
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const version of versions) {
    const versionDir = join(installDir, 'versions', version);
    await mkdir(join(versionDir, 'bin'), { recursive: true });
    await writeFile(join(versionDir, 'bin', launcherName), `Local fixture ${version}`);
    await writeFile(join(versionDir, 'EULA.txt'), `Local fixture document ${version}`);
    await writeFile(
      join(versionDir, 'receipt.json'),
      JSON.stringify({
        version,
        sha256: 'a'.repeat(64),
        platform: process.platform,
        arch: process.arch,
        launcher: `bin/${launcherName}`,
        installedAt: 1,
      }),
    );
  }
  await writeFile(
    configFile,
    JSON.stringify({
      server: { mode: 'managed', installDir, version: versions[0] },
      unrelated: { preserve: true },
    }),
  );
  const pi = createMockPi();
  extension(pi, {
    configFile,
    systemPath,
    versionApi: {
      async resolveServerBundle() {
        throw new Error('Cached install must remain offline');
      },
      async latestServerVersion() {
        throw new Error('Local listing must remain offline');
      },
    },
    serverInstallApi: {
      async ensureInstalled() {
        throw new Error('An installed version must not be downloaded again');
      },
    },
  });
  t.after(() => pi.emit('session_shutdown'));
  const command = pi.getCommand('intellij');
  assert.ok(command);
  const ctx = createMockCtx(root);
  await command.handler('install', ctx);
  assert.equal(ctx.notifications.at(-1)?.level, 'info');
  const afterInstall = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(afterInstall.server.version, versions[0]);
  assert.deepEqual(afterInstall.unrelated, { preserve: true });
  for (const version of [versions[1], versions[0]]) {
    await command.handler(`use ${version}`, ctx);
    assert.equal(ctx.notifications.at(-1)?.level, 'info');
    const selected = JSON.parse(await readFile(configFile, 'utf8'));
    assert.equal(selected.server.version, version);
    const beforeInvalid = await readFile(configFile, 'utf8');
    await command.handler('use 263.9999.0', ctx);
    assert.equal(await readFile(configFile, 'utf8'), beforeInvalid);
  }
  await command.handler('versions', ctx);
  const listing = ctx.notifications.at(-1)?.msg ?? '';
  for (const version of versions) assert.ok(listing.includes(version));
  await assert.rejects(readFile(join(root, 'intellij-eula.json')), { code: 'ENOENT' });
});
