import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import extension, { parseJdkPath } from '../src/extension.js';
import type { SelectItem } from '../src/extension-types.js';
import { canonicalizeProject } from '../src/metadata.js';
import type { DiscoveredJdkItem, WorkspaceInfo } from '../src/workspace.js';
import { createMockCtx, createMockPi } from './helpers.js';

test('parseJdkPath handles unquoted and quoted paths with spaces', () => {
  assert.equal(parseJdkPath('C:/tools/jdk-21'), 'C:/tools/jdk-21');
  assert.equal(parseJdkPath('C:\\Program Files\\Java\\jdk-21'), 'C:\\Program Files\\Java\\jdk-21');
  assert.equal(
    parseJdkPath('"C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.4"'),
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.4',
  );
  assert.equal(parseJdkPath("'D:\\Toolchains\\Java 21\\store'"), 'D:\\Toolchains\\Java 21\\store');
  assert.equal(parseJdkPath('  "F:/tools/jdk with spaces"  '), 'F:/tools/jdk with spaces');
  assert.equal(parseJdkPath(null), '');
  assert.equal(parseJdkPath(undefined), '');
  assert.equal(parseJdkPath(123), '');
});

test('/intellij workspace (default) and status report project JDK and applied state', async () => {
  const pi = createMockPi();
  const mockApi = {
    async getWorkspaceInfo(root: string) {
      return {
        projectRoot: root,
        canonicalPath: 'f:/projects/app',
        nativePath: root,
        rootUri: `file:///${root}`,
        lastReady: null,
        lastConnected: null,
        hasLspRecorded: false,
        projectType: 'maven',
        savedJdk: 'F:/toolchains/jvms/store/21.0.4',
        savedVersion: '21.0.4',
        appliedJdk: 'F:/toolchains/jvms/store/21.0.4',
        isApplied: true,
      };
    },
  };
  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);

  const ctx1 = createMockCtx('F:/projects/app');
  await cmd.handler('workspace', ctx1);
  assert.equal(ctx1.notifications.length, 1);
  assert.match(ctx1.notifications[0].msg, /IntelliJ workspace: f:\/projects\/app \(maven\)/);
  assert.match(ctx1.notifications[0].msg, /21\.0\.4.*\[applied\]/);
  assert.equal(ctx1.notifications[0].level, 'info');

  const ctx2 = createMockCtx('F:/projects/app');
  await cmd.handler('workspace status', ctx2);
  assert.equal(ctx2.notifications.length, 1);
  assert.match(ctx2.notifications[0].msg, /IntelliJ workspace: f:\/projects\/app/);
});

test('/intellij workspace status clearly reports saved but not yet applied JDK', async () => {
  const pi = createMockPi();
  const mockApi = {
    async getWorkspaceInfo(root: string) {
      return {
        projectRoot: root,
        canonicalPath: 'f:/projects/app',
        nativePath: root,
        rootUri: `file:///${root}`,
        lastReady: null,
        lastConnected: null,
        hasLspRecorded: false,
        projectType: 'gradle',
        savedJdk: 'F:/toolchains/jvms/store/21.0.4',
        savedVersion: '21.0.4',
        appliedJdk: 'F:/toolchains/jvms/store/17.0.2',
        isApplied: false,
      };
    },
  };
  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);
  const ctx = createMockCtx('F:/projects/app');

  await cmd.handler('workspace status', ctx);
  assert.equal(ctx.notifications.length, 1);
  assert.match(ctx.notifications[0].msg, /saved, not applied - run \/intellij workspace reload/);
});

test('/intellij workspace list formats configured workspaces and handles empty state', async () => {
  const pi = createMockPi();
  let listReturn: WorkspaceInfo[] = [];
  const mockApi = {
    async listWorkspaces() {
      return listReturn;
    },
  };
  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);

  const ctxEmpty = createMockCtx('F:/projects/app');
  await cmd.handler('workspace list', ctxEmpty);
  assert.equal(ctxEmpty.notifications.length, 1);
  assert.match(ctxEmpty.notifications[0].msg, /No configured IntelliJ workspaces found/);

  listReturn = [
    { canonicalPath: 'f:/app-a', projectType: 'maven', savedJdk: 'F:/jdk-21', isApplied: true },
    {
      canonicalPath: 'f:/app-b',
      projectType: 'gradle',
      savedJdk: null,
      isApplied: false,
    },
  ].map((row) => ({
    projectRoot: row.canonicalPath,
    nativePath: row.canonicalPath,
    rootUri: `file:///${row.canonicalPath}`,
    savedVersion: null,
    appliedJdk: null,
    lastReady: null,
    lastConnected: null,
    hasLspRecorded: false,
    ...row,
  }));
  const ctxPopulated = createMockCtx('F:/projects/app');
  await cmd.handler('workspace list', ctxPopulated);
  assert.equal(ctxPopulated.notifications.length, 1);
  assert.match(ctxPopulated.notifications[0].msg, /IntelliJ workspaces \(2\):/);
  assert.match(
    ctxPopulated.notifications[0].msg,
    /f:\/app-a \(maven, JDK: F:\/jdk-21 \[applied\]\)/,
  );
  assert.match(ctxPopulated.notifications[0].msg, /f:\/app-b \(gradle, JDK: default\)/);
});

test('/intellij workspace jdks discovers candidates and formats vendor/version', async () => {
  const pi = createMockPi();
  const mockApi = {
    async discoverJdks(): Promise<DiscoveredJdkItem[]> {
      return [
        {
          javaHome: 'F:/toolchains/jvms/store/21.0.4',
          version: '21.0.4',
          vendor: 'Eclipse Adoptium',
          majorVersion: 21,
          source: 'test',
        },
        {
          javaHome: 'C:/Program Files/Java/jdk-17',
          version: '17.0.10',
          vendor: 'Oracle Corporation',
          majorVersion: 17,
          source: 'test',
        },
      ];
    },
  };
  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);
  const ctx = createMockCtx('F:/projects/app');

  await cmd.handler('workspace jdks', ctx);
  assert.equal(ctx.notifications.length, 1);
  assert.match(ctx.notifications[0].msg, /Discovered JDKs \(2\):/);
  assert.match(
    ctx.notifications[0].msg,
    /v21\.0\.4 \(Eclipse Adoptium\): F:\/toolchains\/jvms\/store\/21\.0\.4/,
  );
  assert.match(
    ctx.notifications[0].msg,
    /v17\.0\.10 \(Oracle Corporation\): C:\/Program Files\/Java\/jdk-17/,
  );
});

test('/intellij workspace jdk <path> with spaces saves and reimports successfully', async () => {
  const pi = createMockPi();
  let savedPath: string | null = null;
  let reimportedRoot: string | null = null;

  const mockApi = {
    async setWorkspaceJdk(root: string, jdkPath: string) {
      savedPath = jdkPath;
      return {
        projectRoot: root,
        canonicalPath: root,
        nativePath: root,
        rootUri: `file:///${root}`,
        javaHome: jdkPath,
        javaVersion: '21',
      };
    },
    async reimportWorkspace(root: string) {
      reimportedRoot = root;
      return {
        ready: true,
        projectRoot: root,
        canonicalPath: root,
        appliedJdk: null,
        elapsedMs: 142,
      };
    },
  };
  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);
  const ctx = createMockCtx('F:/projects/app');

  await cmd.handler('workspace jdk "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.4"', ctx);
  assert.equal(savedPath, 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.4');
  assert.ok(reimportedRoot);
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].level, 'info');
  assert.match(
    ctx.notifications[0].msg,
    /Workspace JDK saved and applied: C:\\Program Files\\Eclipse Adoptium\\jdk-21\.0\.4 \(142ms\)\./,
  );
});

test('/intellij workspace jdk reports saved-but-not-applied when reimport times out', async () => {
  const pi = createMockPi();
  const mockApi = {
    async setWorkspaceJdk(root: string, jdkPath: string) {
      return {
        projectRoot: root,
        canonicalPath: root,
        nativePath: root,
        rootUri: `file:///${root}`,
        javaHome: jdkPath,
        javaVersion: '21',
      };
    },
    async reimportWorkspace() {
      const err = Object.assign(new Error('Reimport timed out after 300000ms'), {
        code: 'ETIMEDOUT',
      });
      throw err;
    },
  };
  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);
  const ctx = createMockCtx('F:/projects/app');

  await cmd.handler('workspace jdk C:\\Program Files\\Java\\jdk-21', ctx);
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].level, 'warning');
  assert.match(
    ctx.notifications[0].msg,
    /Workspace JDK saved \(C:\\Program Files\\Java\\jdk-21\), but reimport timed out/,
  );
  assert.match(ctx.notifications[0].msg, /Settings are saved but not yet fully applied\./);
});

test('/intellij workspace jdk reports saved-but-not-applied when reimport fails', async () => {
  const pi = createMockPi();
  const mockApi = {
    async setWorkspaceJdk(root: string, jdkPath: string) {
      return {
        projectRoot: root,
        canonicalPath: root,
        nativePath: root,
        rootUri: `file:///${root}`,
        javaHome: jdkPath,
        javaVersion: '21',
      };
    },
    async reimportWorkspace() {
      throw new Error('Connection refused to LSP server');
    },
  };
  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);
  const ctx = createMockCtx('F:/projects/app');

  await cmd.handler('workspace jdk F:/Java/jdk-21', ctx);
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].level, 'warning');
  assert.match(
    ctx.notifications[0].msg,
    /Workspace JDK saved \(F:\/Java\/jdk-21\), but reimport failed/,
  );
  assert.match(ctx.notifications[0].msg, /Settings are saved but not applied to active session\./);
});

test('/intellij workspace jdk reports error and does not reimport on invalid JDK', async () => {
  const pi = createMockPi();
  let reimportCalled = false;
  const mockApi = {
    async setWorkspaceJdk() {
      throw new Error('Invalid JDK at F:/bogus: missing bin/java or bin/javac');
    },
    async reimportWorkspace() {
      reimportCalled = true;
      return {
        ready: true,
        projectRoot: '/fake',
        canonicalPath: '/fake',
        appliedJdk: null,
        elapsedMs: 0,
      };
    },
  };
  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);
  const ctx = createMockCtx('F:/projects/app');

  await cmd.handler('workspace jdk F:/bogus', ctx);
  assert.equal(reimportCalled, false);
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].level, 'warning');
  assert.match(ctx.notifications[0].msg, /Failed to save workspace JDK: Invalid JDK at F:\/bogus/);
});

test('/intellij workspace jdk without path uses ctx.ui.select when available', async () => {
  const pi = createMockPi();
  let selectTitle = '';
  let selectItems: SelectItem[] = [];
  let savedPath: string | null = null;

  const mockApi = {
    async discoverJdks(): Promise<DiscoveredJdkItem[]> {
      return [
        {
          javaHome: 'F:/toolchains/jvms/store/21.0.4',
          version: '21.0.4',
          vendor: 'Adoptium',
          majorVersion: 21,
          source: 'test',
        },
        {
          javaHome: 'C:/Program Files/Java/jdk-17',
          version: '17.0.2',
          vendor: 'Oracle',
          majorVersion: 17,
          source: 'test',
        },
      ];
    },
    async setWorkspaceJdk(root: string, path: string) {
      savedPath = path;
      return {
        projectRoot: root,
        canonicalPath: root,
        nativePath: root,
        rootUri: `file:///${root}`,
        javaHome: path,
        javaVersion: '21',
      };
    },
    async reimportWorkspace(root: string) {
      return {
        ready: true,
        projectRoot: root,
        canonicalPath: root,
        appliedJdk: null,
        elapsedMs: 50,
      };
    },
  };
  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);

  const ctx = createMockCtx('F:/projects/app', {
    async select(title: string, items: SelectItem[]) {
      selectTitle = title;
      selectItems = items;
      return items[0].value;
    },
  });

  await cmd.handler('workspace jdk', ctx);
  assert.equal(selectTitle, 'Select JDK for workspace:');
  assert.equal(selectItems.length, 2);
  assert.equal(savedPath, 'F:/toolchains/jvms/store/21.0.4');
  assert.match(
    ctx.notifications[0].msg,
    /Workspace JDK saved and applied: F:\/toolchains\/jvms\/store\/21\.0\.4/,
  );
});

test('/intellij workspace jdk without path handles user cancellation in ctx.ui.select', async () => {
  const pi = createMockPi();
  let setCalled = false;
  const mockApi = {
    async discoverJdks(): Promise<DiscoveredJdkItem[]> {
      return [
        { javaHome: 'F:/jdk-21', version: '21', vendor: '', majorVersion: 21, source: 'test' },
      ];
    },
    async setWorkspaceJdk() {
      setCalled = true;
      return {
        projectRoot: '/fake',
        canonicalPath: '/fake',
        nativePath: '/fake',
        rootUri: `file:///${'/fake'}`,
        javaHome: '/fake',
        javaVersion: '21',
      };
    },
  };
  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);

  const ctx = createMockCtx('F:/projects/app', {
    async select() {
      return null;
    },
  });

  await cmd.handler('workspace jdk', ctx);
  assert.equal(setCalled, false);
  assert.equal(ctx.notifications.length, 1);
  assert.match(ctx.notifications[0].msg, /JDK selection cancelled\./);
});

test('/intellij workspace jdk without path warns when ctx.ui.select is not available', async () => {
  const pi = createMockPi();
  const mockApi = {
    async discoverJdks(): Promise<DiscoveredJdkItem[]> {
      return [];
    },
  };
  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);

  const ctx = createMockCtx('F:/projects/app');
  await cmd.handler('workspace jdk', ctx);

  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].level, 'warning');
  assert.match(
    ctx.notifications[0].msg,
    /No interactive UI available\. Run \/intellij workspace jdks/,
  );
});

test('/intellij workspace reload triggers reimport and reports outcome', async () => {
  const pi = createMockPi();
  let reimported = false;
  const mockApi = {
    async reimportWorkspace(root: string) {
      reimported = true;
      return {
        ready: true,
        projectRoot: root,
        canonicalPath: root,
        appliedJdk: null,
        elapsedMs: 88,
      };
    },
  };
  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);

  const ctx = createMockCtx('F:/projects/app');
  await cmd.handler('workspace reload', ctx);

  assert.equal(reimported, true);
  assert.equal(ctx.notifications.length, 1);
  assert.match(
    ctx.notifications[0].msg,
    /Workspace reimported successfully: index ready \(88ms\)\./,
  );
});

test('/intellij workspace status surfaces sanitized failure and license state along with workspace info without starting LSP', async () => {
  const tempSystemPath = join(tmpdir(), 'omp-ws-status-sys-' + Math.random().toString(36).slice(2));
  const connDir = join(tempSystemPath, 'plugin-metadata', 'connections');
  await mkdir(connDir, { recursive: true });

  const projectRoot = 'F:/projects/app';
  const { canonicalPath } = canonicalizeProject(projectRoot);

  const connRecord = {
    connectionId: 'conn-ws-test',
    kind: 'bridge',
    pid: process.pid,
    startedAt: Date.now() - 5000,
    updatedAt: Date.now(),
    seq: 1,
    phase: 'indexing',
    detail: 'Syncing Gradle model',
    canonicalPath,
    closed: false,
    license: {
      status: 'needs-activation',
      featuresDeclined: true,
      reason: 'License expired token=secret-tok-999',
    },
    failure: {
      kind: 'import',
      stage: 'import',
      message: 'Failed to fetch https://user:secretpass@repo.example.com/lib',
      code: -32001,
      folders: [
        {
          uri: 'file:///projects/app',
          tool: 'gradle',
          status: 'FAILED',
          message: 'token=mykey',
        },
      ],
      logPath: join(tempSystemPath, 'launcher.log'),
    },
  };
  await writeFile(join(connDir, 'conn-ws-test.json'), JSON.stringify(connRecord), 'utf8');

  try {
    const pi = createMockPi();
    const mockApi = {
      async getWorkspaceInfo(root: string) {
        return {
          projectRoot: root,
          canonicalPath: 'f:/projects/app',
          nativePath: root,
          rootUri: `file:///${root}`,
          lastReady: null,
          lastConnected: null,
          hasLspRecorded: false,
          projectType: 'gradle',
          savedJdk: 'F:/toolchains/jvms/store/21.0.4',
          savedVersion: '21.0.4',
          appliedJdk: 'F:/toolchains/jvms/store/21.0.4',
          isApplied: true,
        };
      },
    };

    extension(pi, {
      workspaceApi: mockApi,
      systemPath: tempSystemPath,
      readinessApi: {
        findProjectRoot: () => projectRoot,
      },
    });

    const cmd = pi.getCommand('intellij');
    assert.ok(cmd);
    const ctx = createMockCtx(projectRoot);

    await cmd.handler('workspace status', ctx);
    assert.equal(ctx.notifications.length, 1);
    const msg = ctx.notifications[0].msg;

    assert.match(
      msg,
      /IntelliJ workspace: f:\/projects\/app \(gradle\); JDK: F:\/toolchains\/jvms\/store\/21\.0\.4/,
    );
    assert.match(msg, /index: indexing \(Syncing Gradle model\)/);
    assert.match(msg, /license: needs-activation; features declined/);
    assert.match(msg, /failure: import \(import\) - Failed to fetch/);
    assert.match(msg, /code: -32001/);
    assert.match(msg, /file:\/\/\/projects\/app\[FAILED\]/);
    assert.match(msg, /recovery: 在受支持的 JetBrains 客户端中显式完成授权/);

    // Ensure credentials were not leaked
    assert.equal(msg.includes('secretpass'), false);
    assert.equal(msg.includes('secret-tok-999'), false);
    assert.equal(msg.includes('mykey'), false);
    assert.match(msg, /\[REDACTED\]/);
  } finally {
    await rm(tempSystemPath, { recursive: true, force: true });
  }
});

test('/intellij workspace env (view) handles empty and configured env safely', async () => {
  const pi = createMockPi();
  let mockInfo: Partial<WorkspaceInfo> = {
    canonicalPath: 'f:/projects/demo',
    savedEnvKeys: [],
    maskedEnv: {},
  };

  const mockApi = {
    async getWorkspaceInfo() {
      return mockInfo as WorkspaceInfo;
    },
  };

  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);

  // 1. Empty env
  const ctx1 = createMockCtx('F:/projects/demo');
  await cmd.handler('workspace env', ctx1);
  assert.equal(ctx1.notifications.length, 1);
  assert.match(ctx1.notifications[0].msg, /no custom environment variables configured/i);
  assert.equal(ctx1.notifications[0].level, 'info');

  // 2. Configured env (masked)
  mockInfo = {
    canonicalPath: 'f:/projects/demo',
    savedEnvKeys: ['API_KEY', 'GRADLE_OPTS'],
    maskedEnv: {
      API_KEY: '***',
      GRADLE_OPTS: '***',
    },
  };

  const ctx2 = createMockCtx('F:/projects/demo');
  await cmd.handler('workspace env view', ctx2);
  assert.equal(ctx2.notifications.length, 1);
  const msg = ctx2.notifications[0].msg;
  assert.match(msg, /env \(2\): API_KEY=\*\*\*, GRADLE_OPTS=\*\*\*/);
  assert.match(msg, /configured JDK java-home takes precedence over env\.JAVA_HOME/);
  assert.equal(ctx2.notifications[0].level, 'info');
});

test('/intellij workspace env set validates syntax, preserves spaces/quotes, and triggers reimport', async () => {
  const pi = createMockPi();
  let savedName = '';
  let savedVal = '';
  let reimportCalled = false;

  const mockApi = {
    async setWorkspaceEnvVar(_root: string, name: string, value: string) {
      savedName = name;
      savedVal = value;
      return {
        projectRoot: _root,
        canonicalPath: _root,
        nativePath: _root,
        rootUri: `file:///${_root}`,
        name,
        maskedValue: '***',
        savedEnvKeys: [name],
      };
    },
    async reimportWorkspace(root: string) {
      reimportCalled = true;
      return {
        ready: true,
        projectRoot: root,
        canonicalPath: root,
        appliedJdk: null,
        elapsedMs: 42,
      };
    },
  };

  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);

  // Set with quotes and spaces in value
  const ctx = createMockCtx('F:/projects/demo');
  await cmd.handler('workspace env set GRADLE_OPTS "-Dorg.gradle.daemon=true -Xmx2g"', ctx);

  assert.equal(savedName, 'GRADLE_OPTS');
  assert.equal(savedVal, '-Dorg.gradle.daemon=true -Xmx2g');
  assert.equal(reimportCalled, true);
  assert.equal(ctx.notifications.length, 1);
  assert.match(
    ctx.notifications[0].msg,
    /Workspace environment variable GRADLE_OPTS saved and reload submitted: index ready \(42ms\)\./,
  );
  assert.equal(ctx.notifications[0].level, 'info');

  // Set JAVA_HOME notes precedence
  const ctxJdk = createMockCtx('F:/projects/demo');
  await cmd.handler('workspace env set JAVA_HOME "C:\\Program Files\\Java\\jdk-21"', ctxJdk);
  assert.equal(savedName, 'JAVA_HOME');
  assert.equal(savedVal, 'C:\\Program Files\\Java\\jdk-21');
  assert.match(
    ctxJdk.notifications[0].msg,
    /configured workspace JDK takes precedence over env\.JAVA_HOME/,
  );
});

test('/intellij workspace env set validates invalid names and missing values', async () => {
  const pi = createMockPi();
  let setCalled = false;
  const mockApi = {
    async setWorkspaceEnvVar(_root: string) {
      setCalled = true;
      return {
        projectRoot: _root,
        canonicalPath: _root,
        nativePath: _root,
        rootUri: `file:///${_root}`,
        name: '',
        maskedValue: '',
        savedEnvKeys: [],
      };
    },
  };

  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);

  // Missing value
  const ctx1 = createMockCtx('F:/projects/demo');
  await cmd.handler('workspace env set FOO', ctx1);
  assert.equal(setCalled, false);
  assert.equal(ctx1.notifications.length, 1);
  assert.match(ctx1.notifications[0].msg, /Usage: \/intellij workspace env set <NAME> <VALUE>/);
  assert.equal(ctx1.notifications[0].level, 'warning');

  // Invalid identifier name
  const ctx2 = createMockCtx('F:/projects/demo');
  await cmd.handler('workspace env set "INVALID=NAME" "val"', ctx2);
  assert.equal(setCalled, false);
  assert.equal(ctx2.notifications.length, 1);
  assert.match(ctx2.notifications[0].msg, /Invalid environment variable name "INVALID=NAME"/);
  assert.equal(ctx2.notifications[0].level, 'warning');
});

test('/intellij workspace env unset removes variable and reports whether it existed', async () => {
  const pi = createMockPi();
  let unsetTarget = '';
  let reimportCalled = false;
  let wasSetReturn = true;

  const mockApi = {
    async unsetWorkspaceEnvVar(_root: string, name: string) {
      unsetTarget = name;
      return {
        projectRoot: _root,
        canonicalPath: _root,
        nativePath: _root,
        rootUri: `file:///${_root}`,
        name,
        wasSet: wasSetReturn,
        savedEnvKeys: [],
      };
    },
    async reimportWorkspace(root: string) {
      reimportCalled = true;
      return {
        ready: true,
        projectRoot: root,
        canonicalPath: root,
        appliedJdk: null,
        elapsedMs: 15,
      };
    },
  };
  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);

  // Unset existing
  const ctx1 = createMockCtx('F:/projects/demo');
  await cmd.handler('workspace env unset HTTP_PROXY', ctx1);
  assert.equal(unsetTarget, 'HTTP_PROXY');
  assert.equal(reimportCalled, true);
  assert.match(
    ctx1.notifications[0].msg,
    /Workspace environment variable HTTP_PROXY unset and reload submitted: index ready \(15ms\)\./,
  );
  assert.equal(ctx1.notifications[0].level, 'info');

  // Unset non-existing
  reimportCalled = false;
  wasSetReturn = false;
  const ctx2 = createMockCtx('F:/projects/demo');
  await cmd.handler('workspace env unset UNKNOWN_VAR', ctx2);
  assert.equal(unsetTarget, 'UNKNOWN_VAR');
  assert.equal(reimportCalled, false);
  assert.match(
    ctx2.notifications[0].msg,
    /Environment variable "UNKNOWN_VAR" is not set in workspace configuration\./,
  );
  assert.equal(ctx2.notifications[0].level, 'info');
});

test('/intellij workspace env set honest error reporting on reimport failure and timeout', async () => {
  const pi = createMockPi();
  let timeoutMode = true;

  const mockApi = {
    async setWorkspaceEnvVar(_root: string) {
      return {
        projectRoot: _root,
        canonicalPath: _root,
        nativePath: _root,
        rootUri: `file:///${_root}`,
        name: 'FAIL_VAR',
        maskedValue: '***',
        savedEnvKeys: ['FAIL_VAR'],
      };
    },
    async reimportWorkspace() {
      if (timeoutMode) {
        const err = new Error('Reimport deadline exceeded');
        (err as unknown as { code: string }).code = 'ETIMEDOUT';
        throw err;
      }
      throw new Error('Connection reset by LSP peer');
    },
  };

  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);

  // Timeout
  const ctx1 = createMockCtx('F:/projects/demo');
  await cmd.handler('workspace env set FAIL_VAR test', ctx1);
  assert.equal(ctx1.notifications.length, 1);
  assert.match(
    ctx1.notifications[0].msg,
    /Workspace environment variable FAIL_VAR saved, but reimport timed out: Reimport deadline exceeded\. Settings are saved but not yet fully applied\./,
  );
  assert.equal(ctx1.notifications[0].level, 'warning');

  // Network / peer failure
  timeoutMode = false;
  const ctx2 = createMockCtx('F:/projects/demo');
  await cmd.handler('workspace env set FAIL_VAR test', ctx2);
  assert.equal(ctx2.notifications.length, 1);
  assert.match(
    ctx2.notifications[0].msg,
    /Workspace environment variable FAIL_VAR saved, but reimport failed: Connection reset by LSP peer\. Settings are saved but not applied to active session\./,
  );
  assert.equal(ctx2.notifications[0].level, 'warning');
});

test('/intellij workspace status displays structured importStatus without leaking secret values', async () => {
  const pi = createMockPi();
  const mockInfo: Partial<WorkspaceInfo> = {
    canonicalPath: 'f:/projects/demo',
    projectType: 'maven',
    savedJdk: null,
    appliedJdk: null,
    isApplied: false,
    savedEnvKeys: ['APP_SECRET', 'GRADLE_OPTS'],
    importStatus: {
      status: 'failed',
      stage: 'connect',
      failure: {
        stage: 'connect',
        message: 'server failed with secret [REDACTED]',
      },
    },
  };

  const mockApi = {
    async getWorkspaceInfo() {
      return mockInfo as WorkspaceInfo;
    },
  };

  extension(pi, { workspaceApi: mockApi });
  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);

  const ctx = createMockCtx('F:/projects/demo');
  await cmd.handler('workspace status', ctx);
  assert.equal(ctx.notifications.length, 1);
  const msg = ctx.notifications[0].msg;

  assert.match(msg, /env: 2 configured \(APP_SECRET, GRADLE_OPTS\)/);
  assert.match(msg, /import: failed \(connect\) - server failed with secret \[REDACTED\]/);

  // Pending status
  mockInfo.importStatus = {
    status: 'pending',
    stage: 'saved',
  };
  const ctxPending = createMockCtx('F:/projects/demo');
  await cmd.handler('workspace status', ctxPending);
  assert.match(
    ctxPending.notifications[0].msg,
    /import: saved, not applied - run \/intellij workspace reload/,
  );

  // Succeeded status
  mockInfo.importStatus = {
    status: 'applied',
    stage: 'ready',
  };
  const ctxApplied = createMockCtx('F:/projects/demo');
  await cmd.handler('workspace status', ctxApplied);
  assert.match(ctxApplied.notifications[0].msg, /import: reload succeeded/);
});
