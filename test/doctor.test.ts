import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatDoctorReport, inspectDoctor } from '../src/extension/doctor.js';
import extension from '../src/extension/extension.js';
import { canonicalizeProject } from '../src/project/metadata.js';
import { createMockCtx, createMockPi } from './helpers.js';

interface TestFixtureEnv {
  root: string;
  configDir: string;
  systemPath: string;
  configFile: string;
  eulaConfigFile: string;
  projectDir: string;
}

async function createTestEnv(t: { after(fn: () => Promise<void>): void }): Promise<TestFixtureEnv> {
  const root = await mkdtemp(join(tmpdir(), 'omp-doctor-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const configDir = join(root, 'agent', 'intellij-workspaces');
  const systemPath = join(root, 'system');
  const configFile = join(root, 'agent', 'intellij.json');
  const eulaConfigFile = join(root, 'agent', 'intellij-eula.json');
  const projectDir = join(root, 'my-project');

  await mkdir(configDir, { recursive: true });
  await mkdir(systemPath, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'pom.xml'), '<project></project>', 'utf8');

  return { root, configDir, systemPath, configFile, eulaConfigFile, projectDir };
}

test('inspectDoctor: missing managed install reports install error, unknown EULA, and failing summary', async (t) => {
  const env = await createTestEnv(t);
  const installDir = join(env.root, 'empty-install');
  await mkdir(installDir, { recursive: true });

  await writeFile(
    env.configFile,
    JSON.stringify({
      server: {
        mode: 'managed',
        installDir,
        version: '263.7084.0',
      },
    }),
    'utf8',
  );

  const report = await inspectDoctor(undefined, {
    systemPath: env.systemPath,
    configFile: env.configFile,
    configDir: env.configDir,
  });

  assert.equal(report.selectedVersion, '263.7084.0');
  assert.equal(report.executable, undefined);

  const configCheck = report.checks.find((c) => c.id === 'config');
  assert.ok(configCheck);
  assert.equal(configCheck.severity, 'ok');

  const installCheck = report.checks.find((c) => c.id === 'install');
  assert.ok(installCheck);
  assert.equal(installCheck.severity, 'error');
  assert.match(installCheck.message, /\/intellij install/);

  const eulaCheck = report.checks.find((c) => c.id === 'eula');
  assert.ok(eulaCheck);
  assert.equal(eulaCheck.severity, 'unknown');

  // summary.ok is false because missing install is an error
  assert.equal(report.summary.ok, false);
  assert.equal(report.summary.counts.error, 1);
});

test('inspectDoctor: invalid config triggers error but other independent checks still run', async (t) => {
  const env = await createTestEnv(t);

  // Corrupt JSON configuration
  await writeFile(env.configFile, '{ "server": { "mode": "unsupported_value" } }', 'utf8');

  const report = await inspectDoctor(undefined, {
    systemPath: env.systemPath,
    configFile: env.configFile,
    configDir: env.configDir,
  });

  const configCheck = report.checks.find((c) => c.id === 'config');
  assert.ok(configCheck);
  assert.equal(configCheck.severity, 'error');

  // Other independent checks did not abort
  const installCheck = report.checks.find((c) => c.id === 'install');
  assert.ok(installCheck);
  assert.equal(installCheck.severity, 'unknown');

  const serverCheck = report.checks.find((c) => c.id === 'server');
  assert.ok(serverCheck);
  assert.equal(serverCheck.severity, 'ok');

  const logsCheck = report.checks.find((c) => c.id === 'logs');
  assert.ok(logsCheck);
  assert.equal(logsCheck.severity, 'ok');

  // Error count >= 1 means summary.ok is false
  assert.equal(report.summary.ok, false);
  assert.ok(report.summary.counts.error >= 1);
});

test('inspectDoctor: external server fixture and EULA states (unaccepted, accepted, missing)', async (t) => {
  const env = await createTestEnv(t);

  const serverRoot = join(env.root, 'external-server');
  const binDir = join(serverRoot, 'bin');
  await mkdir(binDir, { recursive: true });
  const launcher = join(binDir, process.platform === 'win32' ? 'idea.bat' : 'idea.sh');
  await writeFile(launcher, '#!/bin/sh\necho "server"\n');

  const eulaText = 'Sample JetBrains User Agreement Fixture Text for OMP Doctor\n';
  const eulaPath = join(serverRoot, 'EULA.txt');
  await writeFile(eulaPath, eulaText, 'utf8');

  const expectedHash = createHash('sha256')
    .update(Buffer.from(eulaText, 'utf8'))
    .digest('hex')
    .toLowerCase()
    .slice(0, 16);

  await writeFile(
    env.configFile,
    JSON.stringify({
      server: {
        mode: 'external',
        executable: launcher,
      },
    }),
    'utf8',
  );

  // 1. Unaccepted EULA
  const report1 = await inspectDoctor(undefined, {
    systemPath: env.systemPath,
    configFile: env.configFile,
    configDir: env.configDir,
  });

  assert.equal(report1.executable, launcher);
  const eulaCheck1 = report1.checks.find((c) => c.id === 'eula');
  assert.ok(eulaCheck1);
  assert.equal(eulaCheck1.severity, 'warning');
  assert.match(eulaCheck1.message, new RegExp(expectedHash));
  assert.match(eulaCheck1.message, new RegExp(`/intellij eula accept ${expectedHash}`));

  // 2. Accepted EULA
  await writeFile(
    env.eulaConfigFile,
    JSON.stringify({
      version: 1,
      acceptedHashes: [expectedHash],
    }),
    'utf8',
  );

  const report2 = await inspectDoctor(undefined, {
    systemPath: env.systemPath,
    configFile: env.configFile,
    configDir: env.configDir,
  });

  const eulaCheck2 = report2.checks.find((c) => c.id === 'eula');
  assert.ok(eulaCheck2);
  assert.equal(eulaCheck2.severity, 'ok');
  assert.match(eulaCheck2.message, new RegExp(expectedHash));

  // 3. Missing EULA file
  await rm(eulaPath);
  const report3 = await inspectDoctor(undefined, {
    systemPath: env.systemPath,
    configFile: env.configFile,
    configDir: env.configDir,
  });

  const eulaCheck3 = report3.checks.find((c) => c.id === 'eula');
  assert.ok(eulaCheck3);
  assert.equal(eulaCheck3.severity, 'error');
});

test('inspectDoctor: server stopped vs unknown ownership', async (t) => {
  const env = await createTestEnv(t);

  // 1. Normal clean stopped state
  const report1 = await inspectDoctor(undefined, {
    systemPath: env.systemPath,
    configFile: env.configFile,
    configDir: env.configDir,
  });
  const serverCheck1 = report1.checks.find((c) => c.id === 'server');
  assert.ok(serverCheck1);
  assert.equal(serverCheck1.severity, 'ok');

  // 2. Dead PID in owner record
  const ownerFile = join(env.systemPath, 'omp-server.json');
  await writeFile(
    ownerFile,
    JSON.stringify({
      pid: 99999999,
      token: 'some-token',
      systemPath: env.systemPath,
      processStartTime: 123456,
      executable: 'some-exec',
    }),
    'utf8',
  );

  const report2 = await inspectDoctor(undefined, {
    systemPath: env.systemPath,
    configFile: env.configFile,
    configDir: env.configDir,
  });
  const serverCheck2 = report2.checks.find((c) => c.id === 'server');
  assert.ok(serverCheck2);
  assert.equal(serverCheck2.severity, 'ok');

  // 3. Corrupt owner file
  await writeFile(ownerFile, 'corrupt non-json content', 'utf8');

  const report3 = await inspectDoctor(undefined, {
    systemPath: env.systemPath,
    configFile: env.configFile,
    configDir: env.configDir,
  });
  const serverCheck3 = report3.checks.find((c) => c.id === 'server');
  assert.ok(serverCheck3);
  assert.equal(serverCheck3.severity, 'warning');
});

test('inspectDoctor: bad saved JDK explains failure vs unconfigured JDK is model default unknown', async (t) => {
  const env = await createTestEnv(t);
  const { id } = canonicalizeProject(env.projectDir);
  const wsConfigFile = join(env.configDir, `${id}.json`);

  // 1. Bad saved JDK (points to non-existent directory)
  const badJdkPath = join(env.root, 'nonexistent-jdk-dir-999');
  await writeFile(
    wsConfigFile,
    JSON.stringify({
      projectPath: env.projectDir,
      javaHome: badJdkPath,
      updatedAt: Date.now(),
    }),
    'utf8',
  );

  const report1 = await inspectDoctor(env.projectDir, {
    systemPath: env.systemPath,
    configFile: env.configFile,
    configDir: env.configDir,
  });

  const jdkCheck1 = report1.checks.find((c) => c.id === 'workspace-jdk');
  assert.ok(jdkCheck1);
  assert.equal(jdkCheck1.severity, 'error');
  assert.match(jdkCheck1.detail || '', new RegExp(badJdkPath.replace(/\\/g, '\\\\')));

  // 2. Unconfigured JDK
  await rm(wsConfigFile);

  const report2 = await inspectDoctor(env.projectDir, {
    systemPath: env.systemPath,
    configFile: env.configFile,
    configDir: env.configDir,
  });

  const jdkCheck2 = report2.checks.find((c) => c.id === 'workspace-jdk');
  assert.ok(jdkCheck2);
  assert.equal(jdkCheck2.severity, 'unknown');
});

test('inspectDoctor: secrets masking and no leak of sensitive tokens or env values', async (t) => {
  const env = await createTestEnv(t);
  const { id } = canonicalizeProject(env.projectDir);
  const wsConfigFile = join(env.configDir, `${id}.json`);

  const secretToken = 'ultra-secret-token-abcdef123456';
  const secretLicense = 'INTELLIJ_SERVER_LICENSE_secret_value_987';

  await writeFile(
    wsConfigFile,
    JSON.stringify({
      projectPath: env.projectDir,
      javaHome: join(env.root, `invalid-jdk-with-${secretToken}`),
      env: {
        SUPER_SECRET_VAR: secretToken,
        INTELLIJ_SERVER_LICENSE: secretLicense,
      },
      updatedAt: Date.now(),
    }),
    'utf8',
  );

  const report = await inspectDoctor(env.projectDir, {
    systemPath: env.systemPath,
    configFile: env.configFile,
    configDir: env.configDir,
  });

  const formatted = formatDoctorReport(report);
  const serialized = JSON.stringify(report);

  assert.equal(serialized.includes(secretToken), false);
  assert.equal(serialized.includes(secretLicense), false);
  assert.equal(formatted.includes(secretToken), false);
  assert.equal(formatted.includes(secretLicense), false);
});

test('inspectDoctor: read-only operation does not mutate filesystem', async (t) => {
  const env = await createTestEnv(t);

  const beforeFiles = await readdir(env.systemPath);
  assert.equal(beforeFiles.length, 0);

  await inspectDoctor(env.projectDir, {
    systemPath: env.systemPath,
    configFile: env.configFile,
    configDir: env.configDir,
  });

  const afterFiles = await readdir(env.systemPath);
  // No files or leases were created in systemPath
  assert.equal(afterFiles.length, 0);
});

test('/intellij doctor: command executes, notifies diagnostics, and handles errors', async (t) => {
  const env = await createTestEnv(t);
  const pi = createMockPi();
  extension(pi, {
    systemPath: env.systemPath,
    configFile: env.configFile,
    configDir: env.configDir,
  });

  const cmd = pi.getCommand('intellij');
  assert.ok(cmd);

  // 1. Success execution
  const ctx1 = createMockCtx(env.projectDir);
  await cmd.handler('doctor', ctx1);

  assert.equal(ctx1.notifications.length, 1);

  // 2. Extra arguments show usage warning
  const ctx2 = createMockCtx(env.projectDir);
  await cmd.handler('doctor --json', ctx2);

  assert.equal(ctx2.notifications.length, 1);
  assert.equal(ctx2.notifications[0].level, 'warning');

  // 4. Doctor failure is caught and notified with error level
  const piFail = createMockPi();
  extension(piFail, {
    doctorApi: {
      async inspectDoctor() {
        throw new Error('Doctor unexpected internal crash');
      },
    },
  });
  const cmdFail = piFail.getCommand('intellij');
  assert.ok(cmdFail);

  const ctxFail = createMockCtx(env.projectDir);
  await cmdFail.handler('doctor', ctxFail);

  assert.equal(ctxFail.notifications.length, 1);
  assert.match(
    ctxFail.notifications[0].msg,
    /IntelliJ doctor failed: Doctor unexpected internal crash/,
  );
  assert.equal(ctxFail.notifications[0].level, 'error');
});
