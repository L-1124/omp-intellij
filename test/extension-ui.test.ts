import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import extension from '../src/extension/extension.js';
import { formatStatusText, sanitizeDetail } from '../src/extension/install-status.js';
import type { ProjectStateResult } from '../src/project/connection-state.js';
import { canonicalizeProject } from '../src/project/metadata.js';
import type { ExtensionContext } from '../src/shared/extension-types.js';
import { settings } from '../src/server/service.js';
import { readServerEula } from '../src/server/eula.js';
import { createMockCtx, createMockPi } from './helpers.js';

test('session_start ignores subagents', async () => {
  const pi = createMockPi();
  extension(pi);

  const ctx = createMockCtx('/fake/dir', { agent: { kind: 'sub' } });
  pi.emit('session_start', {}, ctx);

  assert.equal(ctx.statusCalls.length, 0);
  assert.equal(ctx.notifications.length, 0);
});

test('status text stays single-line, bounded, and undecorated', () => {
  const text = formatStatusText('indexing', 'Project import in progress\nsecond line\tthird', {
    percentage: 42.4,
  });
  assert.equal(text.includes('\n'), false);
  assert.equal(text.includes('\t'), false);
  assert.match(text, /^IntelliJ indexing/);
  assert.match(text, /42%/);
  assert.ok(text.length < 130);
  assert.equal(text.includes(`${String.fromCharCode(27)}[`), false);
});

test('long details are truncated and whitespace collapsed', () => {
  const longText = 'a'.repeat(200);
  const sanitized = sanitizeDetail(longText, 50);
  assert.equal(sanitized.length, 50);
  assert.ok(sanitized.endsWith('…'));

  const withSpaces = sanitizeDetail('  hello   world  \n\t next  ');
  assert.equal(withSpaces, 'hello world next');
});

test('formatStatusText avoids duplicate percentage prefix', () => {
  const textWithDup = formatStatusText('indexing', '42% - indexing symbols', { percentage: 42 });
  assert.equal(textWithDup.includes('42% - 42%'), false);
  assert.match(textWithDup, /IntelliJ indexing \(42% - indexing symbols\)/);

  const textWithoutDup = formatStatusText('indexing', 'indexing symbols', { percentage: 42 });
  assert.match(textWithoutDup, /IntelliJ indexing \(42% - indexing symbols\)/);
});

test('extension startup and shutdown are idempotent without noisy status writes', async () => {
  const pi = createMockPi();
  extension(pi);
  const base = join(tmpdir(), `omp-ui-idem-${Math.random().toString(36).slice(2)}`);
  await mkdir(base, { recursive: true });
  await writeFile(join(base, 'pom.xml'), '<project></project>', 'utf8');
  try {
    const ctx = createMockCtx(base);
    pi.emit('session_start', {}, ctx);
    pi.emit('session_start', {}, ctx);
    const beforeShutdown = ctx.statusCalls.length;
    pi.emit('session_shutdown');
    pi.emit('session_shutdown');
    const after = ctx.statusCalls.slice(beforeShutdown);

    for (const call of after) {
      assert.equal(call.key, 'intellij-index');
      assert.equal(typeof call.value, 'string');
    }
    assert.equal(
      after.filter((c) => c.value !== '').length,
      0,
      'shutdown must leave no visible status text',
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
test('/intellij eula (default) and status report real document hash, path, and acceptance', async () => {
  const baseDir = join(tmpdir(), `omp-real-eula-${Math.random().toString(36).slice(2)}`);
  const binDir = join(baseDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const launcherName = process.platform === 'win32' ? 'intellij-server.exe' : 'intellij-server';
  const launcherPath = join(binDir, launcherName);
  await writeFile(launcherPath, '#!/bin/sh\nexit 0', { mode: 0o755 });
  const eulaPath = join(baseDir, 'EULA.txt');
  await writeFile(eulaPath, 'Official JetBrains EULA text for testing', 'utf8');
  const doc = await readServerEula(launcherPath);

  const confDir = join(tmpdir(), `omp-real-conf-${Math.random().toString(36).slice(2)}`);
  await mkdir(confDir, { recursive: true });
  const configFile = join(confDir, 'intellij.json');
  await writeFile(
    configFile,
    JSON.stringify({
      server: { mode: 'external', executable: launcherPath },
      customField: 'preserved-value-1',
    }),
    'utf8',
  );

  try {
    const pi = createMockPi();
    extension(pi, { configFile, systemPath: join(confDir, 'system') });
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx(baseDir);

    // Default /intellij eula calls status
    await cmd.handler('eula', ctx);
    assert.equal(ctx.notifications.length, 1);
    assert.match(ctx.notifications[0].msg, /IntelliJ EULA: not accepted/);
    assert.match(ctx.notifications[0].msg, new RegExp(`hash: ${doc.hash}`));
    assert.match(ctx.notifications[0].msg, new RegExp(`Run /intellij eula accept ${doc.hash}`));

    // /intellij eula status
    ctx.notifications.length = 0;
    await cmd.handler('eula status', ctx);
    assert.equal(ctx.notifications.length, 1);
    assert.match(ctx.notifications[0].msg, /IntelliJ EULA: not accepted/);
    assert.match(ctx.notifications[0].msg, new RegExp(`hash: ${doc.hash}`));
  } finally {
    await rm(baseDir, { recursive: true, force: true });
    await rm(confDir, { recursive: true, force: true });
  }
});

test('/intellij eula status when managed server is absent warns to install without downloading', async () => {
  const confDir = join(tmpdir(), `omp-managed-absent-${Math.random().toString(36).slice(2)}`);
  await mkdir(confDir, { recursive: true });
  const configFile = join(confDir, 'intellij.json');
  const emptyInstallDir = join(confDir, 'nonexistent-install');
  await writeFile(
    configFile,
    JSON.stringify({
      server: { mode: 'managed', installDir: emptyInstallDir },
    }),
    'utf8',
  );

  let ensureInstalledCalled = false;
  try {
    const pi = createMockPi();
    extension(pi, {
      configFile,
      serverInstallApi: {
        async ensureInstalled() {
          ensureInstalledCalled = true;
          throw new Error('Must not be called');
        },
      },
    });
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx(confDir);

    await cmd.handler('eula status', ctx);
    assert.equal(ensureInstalledCalled, false, 'must not trigger server download');
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].level, 'warning');
    assert.match(
      ctx.notifications[0].msg,
      /Managed IntelliJ server is not installed.*Run \/intellij install/,
    );
  } finally {
    await rm(confDir, { recursive: true, force: true });
  }
});

test('/intellij eula view reads real document text and path from launcher', async () => {
  const baseDir = join(tmpdir(), `omp-real-view-${Math.random().toString(36).slice(2)}`);
  const binDir = join(baseDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const launcherName = process.platform === 'win32' ? 'intellij-server.exe' : 'intellij-server';
  const launcherPath = join(binDir, launcherName);
  await writeFile(launcherPath, '#!/bin/sh\nexit 0', { mode: 0o755 });
  const uniqueEulaContent = 'PROPRIETARY JETBRAINS TERMS AND CONDITIONS VERBATIM SPECIFIC 99';
  const eulaPath = join(baseDir, 'EULA.txt');
  await writeFile(eulaPath, uniqueEulaContent, 'utf8');
  const doc = await readServerEula(launcherPath);

  const confDir = join(tmpdir(), `omp-real-view-conf-${Math.random().toString(36).slice(2)}`);
  await mkdir(confDir, { recursive: true });
  const configFile = join(confDir, 'intellij.json');
  await writeFile(
    configFile,
    JSON.stringify({
      server: { mode: 'external', executable: launcherPath },
    }),
    'utf8',
  );

  try {
    const pi = createMockPi();
    extension(pi, { configFile, systemPath: join(confDir, 'system') });
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx(baseDir);

    await cmd.handler('eula view', ctx);
    assert.equal(ctx.notifications.length, 1);
    assert.match(ctx.notifications[0].msg, new RegExp(`hash: ${doc.hash}`));
    assert.match(ctx.notifications[0].msg, /PROPRIETARY JETBRAINS TERMS AND CONDITIONS VERBATIM/);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
    await rm(confDir, { recursive: true, force: true });
  }
});

test('/intellij eula accept validates format and mismatch with real files and no writes', async () => {
  const baseDir = join(tmpdir(), `omp-real-mismatch-${Math.random().toString(36).slice(2)}`);
  const binDir = join(baseDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const launcherName = process.platform === 'win32' ? 'intellij-server.exe' : 'intellij-server';
  const launcherPath = join(binDir, launcherName);
  await writeFile(launcherPath, '#!/bin/sh\nexit 0', { mode: 0o755 });
  const eulaPath = join(baseDir, 'EULA.txt');
  await writeFile(eulaPath, 'Official EULA text', 'utf8');

  const confDir = join(tmpdir(), `omp-real-mismatch-conf-${Math.random().toString(36).slice(2)}`);
  await mkdir(confDir, { recursive: true });
  const configFile = join(confDir, 'intellij.json');
  await writeFile(
    configFile,
    JSON.stringify({
      server: { mode: 'external', executable: launcherPath },
    }),
    'utf8',
  );
  const eulaStoreFile = join(confDir, 'intellij-eula.json');

  try {
    const pi = createMockPi();
    extension(pi, { configFile, systemPath: join(confDir, 'system') });
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);

    // 1. Invalid hash format
    let confirmCalled = false;
    const ctx1 = createMockCtx(baseDir, {
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    });
    await cmd.handler('eula accept invalid-hash', ctx1);
    assert.equal(confirmCalled, false);
    assert.equal(ctx1.notifications[0].level, 'warning');
    assert.match(
      ctx1.notifications[0].msg,
      /Usage: \/intellij eula accept <16-character lowercase hex hash>/,
    );
    await assert.rejects(readFile(eulaStoreFile, 'utf8'), { code: 'ENOENT' });
    const uppercase = createMockCtx(baseDir, {
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    });
    await cmd.handler('eula accept ABCDEF0123456789', uppercase);
    assert.equal(confirmCalled, false);
    await assert.rejects(readFile(eulaStoreFile, 'utf8'), { code: 'ENOENT' });

    // 2. Hash mismatch
    const ctx2 = createMockCtx(baseDir, {
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    });
    await cmd.handler('eula accept 0000000000000000', ctx2);
    assert.equal(confirmCalled, false);
    assert.equal(ctx2.notifications[0].level, 'warning');
    assert.match(ctx2.notifications[0].msg, /EULA hash mismatch/);
    await assert.rejects(readFile(eulaStoreFile, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
    await rm(confDir, { recursive: true, force: true });
  }
});

test('/intellij eula accept writes actual acceptance file and preserves other config fields', async () => {
  const baseDir = join(tmpdir(), `omp-real-accept-${Math.random().toString(36).slice(2)}`);
  const binDir = join(baseDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const launcherName = process.platform === 'win32' ? 'intellij-server.exe' : 'intellij-server';
  const launcherPath = join(binDir, launcherName);
  await writeFile(launcherPath, '#!/bin/sh\nexit 0', { mode: 0o755 });
  const eulaPath = join(baseDir, 'EULA.txt');
  await writeFile(eulaPath, 'Official EULA text for acceptance test', 'utf8');
  const doc = await readServerEula(launcherPath);

  const confDir = join(tmpdir(), `omp-real-accept-conf-${Math.random().toString(36).slice(2)}`);
  await mkdir(confDir, { recursive: true });
  const configFile = join(confDir, 'intellij.json');
  await writeFile(
    configFile,
    JSON.stringify({
      server: { mode: 'external', executable: launcherPath },
      customUserProperty: 'must-be-preserved-42',
    }),
    'utf8',
  );
  const eulaStoreFile = join(confDir, 'intellij-eula.json');

  try {
    const pi = createMockPi();
    extension(pi, { configFile, systemPath: join(confDir, 'system') });
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);

    // 1. Absent UI confirm -> no write
    const ctxNoConfirm = createMockCtx(baseDir);
    delete ctxNoConfirm.ui.confirm;
    await cmd.handler(`eula accept ${doc.hash}`, ctxNoConfirm);
    assert.equal(ctxNoConfirm.notifications[0].level, 'warning');
    assert.match(ctxNoConfirm.notifications[0].msg, /confirmation UI unavailable/);
    await assert.rejects(readFile(eulaStoreFile, 'utf8'), { code: 'ENOENT' });

    // 2. User refusal -> no write
    const ctxRefused = createMockCtx(baseDir, {
      confirm: async (msg: string) => {
        assert.match(msg, new RegExp(doc.hash));
        assert.match(msg, /By accepting, you agree to JetBrains EULA terms/);
        return false;
      },
    });
    await cmd.handler(`eula accept ${doc.hash}`, ctxRefused);
    assert.match(ctxRefused.notifications[0].msg, /cancelled by user/);
    await assert.rejects(readFile(eulaStoreFile, 'utf8'), { code: 'ENOENT' });

    // 3. User accepts -> actual file write on disk
    const ctxAccepted = createMockCtx(baseDir, {
      confirm: async () => true,
    });
    await cmd.handler(`eula accept ${doc.hash}`, ctxAccepted);
    assert.match(ctxAccepted.notifications[0].msg, /IntelliJ EULA accepted/);

    // Verify intellij-eula.json on disk
    const eulaContent = JSON.parse(await readFile(eulaStoreFile, 'utf8'));
    assert.equal(eulaContent.version, 1);
    assert.deepEqual(eulaContent.acceptedHashes, [doc.hash]);

    // Verify intellij.json preserved custom properties
    const confContent = JSON.parse(await readFile(configFile, 'utf8'));
    assert.equal(confContent.customUserProperty, 'must-be-preserved-42');

    // Verify subsequent status reports accepted
    ctxAccepted.notifications.length = 0;
    await cmd.handler('eula status', ctxAccepted);
    assert.match(ctxAccepted.notifications[0].msg, /IntelliJ EULA: accepted/);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
    await rm(confDir, { recursive: true, force: true });
  }
});

test('/intellij eula accept in managed mode binds acceptance to the selected installed version', async () => {
  const installDir = join(tmpdir(), `omp-real-managed-${Math.random().toString(36).slice(2)}`);
  const version = '263.1000.0';
  const versionDir = join(installDir, 'versions', version);
  const binDir = join(versionDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const launcherName = process.platform === 'win32' ? 'intellij-server.exe' : 'intellij-server';
  const launcherPath = join(binDir, launcherName);
  await writeFile(launcherPath, '#!/bin/sh\nexit 0', { mode: 0o755 });
  const eulaPath = join(versionDir, 'EULA.txt');
  await writeFile(eulaPath, 'Managed IntelliJ EULA content', 'utf8');
  const doc = await readServerEula(launcherPath);

  // Write valid ready install-state.json
  const installState = {
    installId: 'managed-test-1',
    pid: process.pid,
    installDir,
    version,
    phase: 'ready',
    downloadedBytes: 1000,
    executable: launcherPath,
    updatedAt: Date.now(),
  };
  await writeFile(join(installDir, 'install-state.json'), JSON.stringify(installState), 'utf8');
  await writeFile(
    join(versionDir, 'receipt.json'),
    JSON.stringify({
      version,
      sha256: 'a'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      launcher: `bin/${launcherName}`,
      installedAt: Date.now(),
    }),
  );

  const confDir = join(tmpdir(), `omp-real-managed-conf-${Math.random().toString(36).slice(2)}`);
  await mkdir(confDir, { recursive: true });
  const configFile = join(confDir, 'intellij.json');
  await writeFile(
    configFile,
    JSON.stringify({
      server: { mode: 'managed', installDir, version },
      managedExtraField: 'preserveManagedConfig',
    }),
    'utf8',
  );
  const eulaStoreFile = join(confDir, 'intellij-eula.json');

  try {
    const pi = createMockPi();
    extension(pi, { configFile, systemPath: join(confDir, 'system') });
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx(installDir, {
      confirm: async () => true,
    });

    await cmd.handler(`eula accept ${doc.hash}`, ctx);
    assert.match(ctx.notifications[0].msg, /IntelliJ EULA accepted/);

    const eulaContent = JSON.parse(await readFile(eulaStoreFile, 'utf8'));
    assert.deepEqual(eulaContent.acceptedHashes, [doc.hash]);

    const confContent = JSON.parse(await readFile(configFile, 'utf8'));
    assert.equal(confContent.managedExtraField, 'preserveManagedConfig');
  } finally {
    await rm(installDir, { recursive: true, force: true });
    await rm(confDir, { recursive: true, force: true });
  }
});

test('/intellij eula accept aborts and does not write old acceptance if file changes during confirmation', async () => {
  const baseDir = join(tmpdir(), `omp-real-stale-${Math.random().toString(36).slice(2)}`);
  const binDir = join(baseDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const launcherName = process.platform === 'win32' ? 'intellij-server.exe' : 'intellij-server';
  const launcherPath = join(binDir, launcherName);
  await writeFile(launcherPath, '#!/bin/sh\nexit 0', { mode: 0o755 });
  const eulaPath = join(baseDir, 'EULA.txt');
  await writeFile(eulaPath, 'Original initial EULA content before confirm', 'utf8');
  const initialDoc = await readServerEula(launcherPath);

  const confDir = join(tmpdir(), `omp-real-stale-conf-${Math.random().toString(36).slice(2)}`);
  await mkdir(confDir, { recursive: true });
  const configFile = join(confDir, 'intellij.json');
  await writeFile(
    configFile,
    JSON.stringify({
      server: { mode: 'external', executable: launcherPath },
    }),
    'utf8',
  );
  const eulaStoreFile = join(confDir, 'intellij-eula.json');

  try {
    const pi = createMockPi();
    extension(pi, { configFile, systemPath: join(confDir, 'system') });
    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);

    // In confirm callback, modify the EULA.txt file on disk before returning true
    const ctx = createMockCtx(baseDir, {
      confirm: async () => {
        await writeFile(eulaPath, 'MODIFIED EULA content during confirmation window', 'utf8');
        return true;
      },
    });

    await cmd.handler(`eula accept ${initialDoc.hash}`, ctx);
    assert.equal(ctx.notifications[0].level, 'warning');
    assert.match(ctx.notifications[0].msg, /EULA document changed during confirmation/);

    // Verify that intellij-eula.json was NOT written with the initial stale hash
    await assert.rejects(readFile(eulaStoreFile, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
    await rm(confDir, { recursive: true, force: true });
  }
});

test('watchIndex observer notifies on auth denial once and notifies once on recovery', async () => {
  const pi = createMockPi();
  let listener!: (state: ProjectStateResult) => void;
  let sessionStartHandler: ((event: unknown, ctx: ExtensionContext) => Promise<void> | void) | undefined;
  const originalOn = pi.on.bind(pi);
  pi.on = ((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'session_start') {
      sessionStartHandler = handler as (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
    }
    originalOn(event, handler);
  }) as typeof pi.on;

  const notifications: Array<{ msg: string; level?: string }> = [];
  const base = join(tmpdir(), `omp-auth-obs-${Math.random().toString(36).slice(2)}`);
  const customSystemPath = join(base, 'system');
  await mkdir(customSystemPath, { recursive: true });
  await writeFile(join(base, 'pom.xml'), '<project></project>', 'utf8');

  try {
    extension(pi, {
      systemPath: customSystemPath,
      readinessApi: {
        watchIndex: (_root, onState) => {
          listener = onState as (state: ProjectStateResult) => void;
          return () => {};
        },
      },
    });

    const javaCtx = createMockCtx(base);
    javaCtx.ui = {
      notify(msg: string, level: string = 'info') {
        notifications.push({ msg, level });
      },
      setStatus() {},
    };

    assert.ok(sessionStartHandler, 'session_start handler must be registered');
    await sessionStartHandler({}, javaCtx);
    assert.ok(listener, 'watchIndex must be registered for Java workspace');
    // 1. Initial indexing with unknown license
    if (listener) {
      listener({
        phase: 'indexing',
        detail: 'Parsing',
        live: true,
        license: { status: 'unknown' },
      });
    }
    assert.equal(notifications.length, 0);

    // 2. Auth denied (featuresDeclined)
    if (listener) {
      listener({
        phase: 'indexing',
        detail: 'Declined',
        live: true,
        license: {
          status: 'needs-activation',
          featuresDeclined: true,
          reason: 'License not found',
        },
      });
    }
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, 'warning');
    assert.match(notifications[0].msg, /IntelliJ authorization required: License not found/);
    assert.match(notifications[0].msg, /在受支持的 JetBrains 客户端中显式完成授权/);

    // 3. Repeat identical auth denial poll -> NO SPAM
    if (listener) {
      listener({
        phase: 'indexing',
        detail: 'Declined',
        live: true,
        license: {
          status: 'needs-activation',
          featuresDeclined: true,
          reason: 'License not found',
        },
      });
    }
    assert.equal(notifications.length, 1, 'identical auth denial must not spam');

    // 4. License restored to valid -> Recovery notified ONCE
    if (listener) {
      listener({
        phase: 'indexing',
        detail: 'Parsing again',
        live: true,
        license: { status: 'valid' },
      });
    }
    assert.equal(notifications.length, 2);
    assert.equal(notifications[1].level, 'info');
    assert.match(notifications[1].msg, /IntelliJ authorization restored/);

    // 5. Subsequent valid poll -> NO REPEAT
    if (listener) {
      listener({
        phase: 'ready',
        detail: '',
        live: true,
        license: { status: 'valid' },
        connectionId: 'c1',
      });
    }
    const readyNotifs = notifications.filter((n) => n.msg.includes('IntelliJ index ready'));
    assert.equal(readyNotifs.length, 1);
    const restoredNotifs = notifications.filter((n) =>
      n.msg.includes('IntelliJ authorization restored'),
    );
    assert.equal(restoredNotifs.length, 1, 'recovery notification must not repeat');
  } finally {
    pi.emit('session_shutdown');
    await rm(base, { recursive: true, force: true });
  }
});

test('session_start writes connection record to activeSystemPath override', async () => {
  const pi = createMockPi();
  let sessionStartHandler: ((event: unknown, ctx: ExtensionContext) => Promise<void> | void) | undefined;
  const originalOn = pi.on.bind(pi);
  pi.on = ((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'session_start') {
      sessionStartHandler = handler as (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
    }
    originalOn(event, handler);
  }) as typeof pi.on;

  const customSystemPath = join(tmpdir(), `omp-custom-sys-start-${Math.random().toString(36).slice(2)}`);
  const projectDir = join(tmpdir(), `omp-proj-start-${Math.random().toString(36).slice(2)}`);
  await mkdir(customSystemPath, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'pom.xml'), '<project></project>', 'utf8');

  const { id, canonicalPath } = canonicalizeProject(projectDir);
  const defaultEventsPath = join(settings.systemPath, 'plugin-metadata', 'projects', `${id}.events.jsonl`);
  const initialDefaultExists = existsSync(defaultEventsPath);

  try {
    extension(pi, { systemPath: customSystemPath });
    const ctx = createMockCtx(projectDir);
    assert.ok(sessionStartHandler, 'session_start handler must be registered');
    await sessionStartHandler({}, ctx);

    const eventsPath = join(customSystemPath, 'plugin-metadata', 'projects', `${id}.events.jsonl`);
    assert.ok(existsSync(eventsPath), 'project events file must exist under activeSystemPath');

    const content = (await readFile(eventsPath, 'utf8')).trim();
    const parsed = JSON.parse(content.split('\n')[0]) as {
      id?: string;
      canonicalPath?: string;
      kind?: string;
      at?: number;
    };
    assert.equal(parsed.id, id);
    assert.equal(parsed.canonicalPath, canonicalPath);
    assert.equal(parsed.kind, 'connection');
    assert.ok(typeof parsed.at === 'number' && parsed.at > 0);

    if (!initialDefaultExists) {
      assert.equal(
        existsSync(defaultEventsPath),
        false,
        'no connection event record must be written under default systemPath',
      );
    }
  } finally {
    pi.emit('session_shutdown');
    await rm(customSystemPath, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('watchIndex observer notifies on fresh structured import failure once and deduplicates progress details', async () => {
  const pi = createMockPi();
  let listener!: (state: ProjectStateResult) => void;
  let sessionStartHandler: ((event: unknown, ctx: ExtensionContext) => Promise<void> | void) | undefined;
  const originalOn = pi.on.bind(pi);
  pi.on = ((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'session_start') {
      sessionStartHandler = handler as (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
    }
    originalOn(event, handler);
  }) as typeof pi.on;

  const notifications: Array<{ msg: string; level?: string }> = [];
  const base = join(tmpdir(), `omp-fail-obs-${Math.random().toString(36).slice(2)}`);
  const customSystemPath = join(base, 'system');
  await mkdir(customSystemPath, { recursive: true });
  await writeFile(join(base, 'pom.xml'), '<project></project>', 'utf8');

  try {
    extension(pi, {
      systemPath: customSystemPath,
      readinessApi: {
        watchIndex: (_root, onState) => {
          listener = onState as (state: ProjectStateResult) => void;
          return () => {};
        },
      },
    });

    const javaCtx = createMockCtx(base);
    javaCtx.ui = {
      notify(msg: string, level: string = 'info') {
        notifications.push({ msg, level });
      },
      setStatus() {},
    };

    assert.ok(sessionStartHandler, 'session_start handler must be registered');
    await sessionStartHandler({}, javaCtx);
    assert.ok(listener, 'watchIndex must be registered for Java workspace');

    const now = Date.now();
    listener({
      phase: 'failed',
      detail: 'Import step 1/3: resolving dependencies',
      updatedAt: now,
      failure: {
        kind: 'import',
        stage: 'import',
        message: 'Maven sync failed: unresolved dependency',
      },
    });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, 'warning');
    assert.match(notifications[0].msg, /Maven sync failed: unresolved dependency/);
    assert.match(notifications[0].msg, /\/intellij workspace reload/);
    assert.doesNotMatch(notifications[0].msg, /\/intellij restart/);

    listener({
      phase: 'failed',
      detail: 'Import step 2/3: downloading plugins',
      updatedAt: now + 100,
      failure: {
        kind: 'import',
        stage: 'import',
        message: 'Maven sync failed: unresolved dependency',
      },
    });
    assert.equal(notifications.length, 1, 'same structured failure with different detail must not re-notify');

    listener({
      phase: 'failed',
      detail: 'Import step 3/3: indexing failed',
      updatedAt: now + 200,
      failure: {
        kind: 'import',
        stage: 'import',
        message: 'POM parse error: invalid XML',
      },
    });
    assert.equal(notifications.length, 2);
    assert.equal(notifications[1].level, 'warning');
    assert.match(notifications[1].msg, /POM parse error: invalid XML/);
    assert.match(notifications[1].msg, /\/intellij workspace reload/);

    listener({
      phase: 'importing',
      detail: 'Retrying Maven sync',
      updatedAt: now + 300,
    });
    assert.equal(notifications.length, 2);

    listener({
      phase: 'failed',
      detail: 'Import failed again',
      updatedAt: now + 400,
      failure: {
        kind: 'import',
        stage: 'import',
        message: 'POM parse error: invalid XML',
      },
    });
    assert.equal(notifications.length, 3, 'new failure after importing phase must notify even with same failure content');
    assert.equal(notifications[2].level, 'warning');
    assert.match(notifications[2].msg, /POM parse error: invalid XML/);
  } finally {
    pi.emit('session_shutdown');
    await rm(base, { recursive: true, force: true });
  }
});

test('watchIndex observer failure action guidance distinguishes import vs non-import', async () => {
  const pi = createMockPi();
  let listener!: (state: ProjectStateResult) => void;
  let sessionStartHandler: ((event: unknown, ctx: ExtensionContext) => Promise<void> | void) | undefined;
  const originalOn = pi.on.bind(pi);
  pi.on = ((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'session_start') {
      sessionStartHandler = handler as (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
    }
    originalOn(event, handler);
  }) as typeof pi.on;

  const notifications: Array<{ msg: string; level?: string }> = [];
  const base = join(tmpdir(), `omp-guidance-obs-${Math.random().toString(36).slice(2)}`);
  const customSystemPath = join(base, 'system');
  await mkdir(customSystemPath, { recursive: true });
  await writeFile(join(base, 'pom.xml'), '<project></project>', 'utf8');

  try {
    extension(pi, {
      systemPath: customSystemPath,
      readinessApi: {
        watchIndex: (_root, onState) => {
          listener = onState as (state: ProjectStateResult) => void;
          return () => {};
        },
      },
    });

    const javaCtx = createMockCtx(base);
    javaCtx.ui = {
      notify(msg: string, level: string = 'info') {
        notifications.push({ msg, level });
      },
      setStatus() {},
    };

    assert.ok(sessionStartHandler, 'session_start handler must be registered');
    await sessionStartHandler({}, javaCtx);
    assert.ok(listener, 'watchIndex must be registered for Java workspace');

    const now = Date.now();
    listener({
      phase: 'failed',
      detail: 'Bridge failed',
      updatedAt: now,
      failure: {
        kind: 'connection',
        stage: 'connect',
        message: 'Socket reset by peer',
      },
    });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, 'warning');
    assert.match(notifications[0].msg, /\/intellij restart/);
    assert.doesNotMatch(notifications[0].msg, /\/intellij workspace reload/);

    listener({
      phase: 'failed',
      detail: 'Import failed',
      updatedAt: now + 100,
      failure: {
        kind: 'import',
        stage: 'import',
        message: 'Gradle sync failed',
      },
    });
    assert.equal(notifications.length, 2);
    assert.equal(notifications[1].level, 'warning');
    assert.match(notifications[1].msg, /\/intellij workspace reload/);
    assert.doesNotMatch(notifications[1].msg, /\/intellij restart/);
  } finally {
    pi.emit('session_shutdown');
    await rm(base, { recursive: true, force: true });
  }
});

test('watchIndex observer unstructured failure falls back to phase and detail changes', async () => {
  const pi = createMockPi();
  let listener!: (state: ProjectStateResult) => void;
  let sessionStartHandler: ((event: unknown, ctx: ExtensionContext) => Promise<void> | void) | undefined;
  const originalOn = pi.on.bind(pi);
  pi.on = ((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'session_start') {
      sessionStartHandler = handler as (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
    }
    originalOn(event, handler);
  }) as typeof pi.on;

  const notifications: Array<{ msg: string; level?: string }> = [];
  const base = join(tmpdir(), `omp-unstructured-obs-${Math.random().toString(36).slice(2)}`);
  const customSystemPath = join(base, 'system');
  await mkdir(customSystemPath, { recursive: true });
  await writeFile(join(base, 'pom.xml'), '<project></project>', 'utf8');

  try {
    extension(pi, {
      systemPath: customSystemPath,
      readinessApi: {
        watchIndex: (_root, onState) => {
          listener = onState as (state: ProjectStateResult) => void;
          return () => {};
        },
      },
    });

    const javaCtx = createMockCtx(base);
    javaCtx.ui = {
      notify(msg: string, level: string = 'info') {
        notifications.push({ msg, level });
      },
      setStatus() {},
    };

    assert.ok(sessionStartHandler, 'session_start handler must be registered');
    await sessionStartHandler({}, javaCtx);
    assert.ok(listener, 'watchIndex must be registered for Java workspace');

    const now = Date.now();
    listener({
      phase: 'failed',
      detail: 'Process exited unexpectedly',
      updatedAt: now,
    });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, 'warning');
    assert.match(notifications[0].msg, /Process exited unexpectedly/);
    assert.match(notifications[0].msg, /\/intellij restart/);

    listener({
      phase: 'failed',
      detail: 'Process exited unexpectedly',
      updatedAt: now + 50,
    });
    assert.equal(notifications.length, 1, 'identical unstructured failure must not re-notify');

    listener({
      phase: 'failed',
      detail: 'Process core dumped',
      updatedAt: now + 100,
    });
    assert.equal(notifications.length, 2, 'unstructured failure with new detail must notify');
    assert.match(notifications[1].msg, /Process core dumped/);

    listener({
      phase: 'failed',
      detail: 'Very old error',
      updatedAt: now - 100000,
    });
    assert.equal(notifications.length, 2, 'stale failure must be ignored');
  } finally {
    pi.emit('session_shutdown');
    await rm(base, { recursive: true, force: true });
  }
});
