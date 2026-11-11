import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import test from 'node:test';
// Real platform delays for hardware/AVD adb polling and loopback socket release.
// Deterministic fake timers cannot control external OS process and network states.
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { PreparedAndroidDebug } from '../../src/android/debug-attach.js';
import { encode } from '../../src/shared/protocol.js';
import {
  copyCachedWrapper,
  copyWorkspaceFixture,
  createDapClientDriver,
  createIntegrationSandbox,
  createLspClientDriver,
  type IntegrationSandbox,
  killProcessSafely,
  type LspClientDriver,
  verifyPrerequisites,
} from './fixture.js';

const TEST_PACKAGE = 'com.example.ompattachfixture';
const TEST_ACTIVITY = 'com.example.ompattachfixture/.MainActivity';

interface StoppedEventBody {
  reason?: string;
  threadId?: number;
}

interface StackFrameEntry {
  id: number;
  name?: string;
  line?: number;
}

interface StackTraceResponse {
  stackFrames?: StackFrameEntry[];
}

interface ScopeEntry {
  name: string;
  variablesReference: number;
}

interface ScopesResponse {
  scopes?: ScopeEntry[];
}

interface VariableEntry {
  name: string;
  value: string;
  variablesReference: number;
}

interface VariablesResponse {
  variables?: VariableEntry[];
}

function parseStoppedBody(body: unknown): StoppedEventBody {
  if (body && typeof body === 'object') {
    return body as StoppedEventBody;
  }
  return {};
}

function parseStackTraceResponse(body: unknown): StackTraceResponse {
  if (body && typeof body === 'object') {
    return body as StackTraceResponse;
  }
  return {};
}

function parseScopesResponse(body: unknown): ScopesResponse {
  if (body && typeof body === 'object') {
    return body as ScopesResponse;
  }
  return {};
}

function parseVariablesResponse(body: unknown): VariablesResponse {
  if (body && typeof body === 'object') {
    return body as VariablesResponse;
  }
  return {};
}

function hasPrerequisitesEnvironment(): boolean {
  return Boolean(
    process.env.OMP_INTELLIJ_TEST_SERVER &&
      process.env.OMP_INTELLIJ_TEST_JDK17 &&
      process.env.OMP_INTELLIJ_TEST_JDK21 &&
      process.env.OMP_INTELLIJ_TEST_ACCEPTED_EULA_HASH &&
      (process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT),
  );
}

function getTestDevice(): string | undefined {
  const serial = process.env.OMP_INTELLIJ_TEST_ANDROID_DEVICE?.trim();
  return serial && serial.length > 0 ? serial : undefined;
}

function getAdbExecutable(): string {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('ANDROID_HOME or ANDROID_SDK_ROOT is required');
  const adbName = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const adbInSdk = join(sdk, 'platform-tools', adbName);
  if (existsSync(adbInSdk)) return adbInSdk;
  return 'adb';
}

function runAdb(
  args: string[],
  timeoutMs = 30000,
): { stdout: string; stderr: string; status: number | null } {
  const adb = getAdbExecutable();
  return spawnSync(adb, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
}

function isDeviceOnline(deviceId: string): boolean {
  const res = runAdb(['-s', deviceId, 'get-state'], 5000);
  return res.status === 0 && res.stdout.trim() === 'device';
}

function getAdbForwardList(deviceId: string): string {
  const res = runAdb(['-s', deviceId, 'forward', '--list'], 5000);
  return res.stdout.trim();
}

function stopFixture(deviceId: string): void {
  runAdb(['-s', deviceId, 'shell', 'am', 'force-stop', TEST_PACKAGE], 10000);
}

function startFixture(deviceId: string, waitForDebugger = false): void {
  const args = ['-s', deviceId, 'shell', 'am', 'start'];
  if (waitForDebugger) {
    args.push('-D');
  }
  args.push('-n', TEST_ACTIVITY);
  const res = runAdb(args, 15000);
  assert.equal(res.status, 0, `Failed to start ${TEST_ACTIVITY}: ${res.stderr || res.stdout}`);
}

function installFixture(deviceId: string, apkPath: string): void {
  const res = runAdb(['-s', deviceId, 'install', '-r', '-t', apkPath], 60000);
  assert.equal(res.status, 0, `Failed to install APK ${apkPath}: ${res.stderr || res.stdout}`);
}

async function getFixturePid(deviceId: string, timeoutMs = 15000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = runAdb(['-s', deviceId, 'shell', 'pidof', TEST_PACKAGE], 5000);
    if (res.status === 0 && res.stdout.trim().length > 0) {
      const parts = res.stdout.trim().split(/\s+/);
      const pid = parseInt(parts[0], 10);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }
    await sleep(200);
  }
  throw new Error(
    `Process ${TEST_PACKAGE} was not detected on device ${deviceId} within ${timeoutMs}ms`,
  );
}

function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  const probe = net.createServer();
  // Binding checks ownership without consuming the target's single JDWP connection.
  probe.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') resolve(true);
    else reject(error);
  });
  probe.listen({ host, port, exclusive: true }, () => {
    probe.close((error) => {
      if (error) reject(error);
      else resolve(false);
    });
  });
  return promise;
}

async function waitForPortReleased(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listening = await isPortListening(port, host);
    if (!listening) return;
    await sleep(150);
  }
  throw new Error(`Port ${port} was not released within ${timeoutMs}ms`);
}

function resolveCliScript(): string {
  const rel = join('android', 'debug-attach-cli.js');
  const testDist = resolve('dist-test', 'src', rel);
  return existsSync(testDist) ? testDist : resolve('dist', rel);
}

function runPrepareCli(
  args: {
    package?: string;
    pid?: number;
    device?: string;
    adb?: string;
    timeoutMs?: number;
    timeout?: number;
  },
  cwd: string,
  sandbox: IntegrationSandbox,
  timeoutMs = 180000,
): { status: number | null; stdout: string; stderr: string; data?: PreparedAndroidDebug } {
  const cliScript = resolveCliScript();
  const cliArgs = ['prepare'];
  if (args.package) cliArgs.push('--package', args.package);
  if (args.pid) cliArgs.push('--pid', String(args.pid));
  if (args.device) cliArgs.push('--device', args.device);
  if (args.adb) cliArgs.push('--adb', args.adb);
  if (args.timeoutMs) cliArgs.push('--timeout-ms', String(args.timeoutMs));
  if (args.timeout) cliArgs.push('--timeout', String(args.timeout));

  const res = spawnSync(process.execPath, [cliScript, ...cliArgs], {
    cwd,
    env: sandbox.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });

  let data: PreparedAndroidDebug | undefined;
  if (res.stdout.trim()) {
    const lines = res.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, `CLI stdout must be one JSON line: ${res.stdout}`);
    data = JSON.parse(lines[0]);
  }

  return { status: res.status, stdout: res.stdout, stderr: res.stderr, data };
}

function runCleanupCli(
  key: string,
  cwd: string,
  sandbox: IntegrationSandbox,
  timeoutMs = 30000,
): {
  status: number | null;
  stdout: string;
  stderr: string;
  data?: { success: boolean; cleaned: boolean; reason?: string };
} {
  const cliScript = resolveCliScript();
  const res = spawnSync(process.execPath, [cliScript, 'cleanup', '--key', key], {
    cwd,
    env: sandbox.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });

  let data: { success: boolean; cleaned: boolean; reason?: string } | undefined;
  if (res.stdout.trim()) {
    const lines = res.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, `CLI stdout must be one JSON line: ${res.stdout}`);
    data = JSON.parse(lines[0]);
  }

  return { status: res.status, stdout: res.stdout, stderr: res.stderr, data };
}

function findSourceLine(filePath: string, needle: string): number {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) {
      return i + 1;
    }
  }
  throw new Error(`Needle "${needle}" not found in source file: ${filePath}`);
}

let cachedBuiltApkPath: string | null = null;

async function copyAndroidAttachFixture(sandbox: IntegrationSandbox): Promise<{
  targetDir: string;
  apkPath: string;
  mainActivityPath: string;
}> {
  sandbox.env.OMP_ANDROID_LS_EXTENSION_DIR = resolve('resources/ils/271.2085.0/android.lsp');
  const sourceDir = resolve('test-fixtures', 'android-attach');
  const targetDir = join(sandbox.workspacesDir, 'android-attach');
  await cp(sourceDir, targetDir, { recursive: true });

  const androidSdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!androidSdk || !existsSync(androidSdk)) {
    throw new Error('ANDROID_HOME or ANDROID_SDK_ROOT must be set to a valid directory');
  }

  await writeFile(
    join(targetDir, 'local.properties'),
    `sdk.dir=${androidSdk.replace(/\\/g, '/')}\n`,
    'utf8',
  );

  const jdk21Normalized = sandbox.prerequisites.jdk21Path.replace(/\\/g, '/');
  const gradleProps = [
    'org.gradle.java.installations.auto-download=false',
    'org.gradle.java.installations.auto-detect=false',
    `org.gradle.java.installations.paths=${jdk21Normalized}`,
    `org.gradle.java.home=${jdk21Normalized}`,
    'org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8',
    'android.useAndroidX=false',
    'android.nonTransitiveRClass=true',
    '',
  ].join('\n');
  await writeFile(join(targetDir, 'gradle.properties'), gradleProps, 'utf8');

  const cache = process.env.OMP_INTELLIJ_TEST_GRADLE_CACHE;
  if (cache && existsSync(cache)) {
    sandbox.gradleUserHome = resolve(cache);
    sandbox.env.GRADLE_USER_HOME = sandbox.gradleUserHome;
  } else {
    await copyCachedWrapper(sandbox);
  }

  const wrapperJarSrc = resolve(
    'test-fixtures',
    'android-attach',
    'gradle',
    'wrapper',
    'gradle-wrapper.jar',
  );
  const targetWrapperDir = join(targetDir, 'gradle', 'wrapper');
  await mkdir(targetWrapperDir, { recursive: true });
  await cp(wrapperJarSrc, join(targetWrapperDir, 'gradle-wrapper.jar'));

  const apkPath = join(targetDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  const mainActivityPath = join(
    targetDir,
    'app',
    'src',
    'main',
    'java',
    'com',
    'example',
    'ompattachfixture',
    'MainActivity.java',
  );

  return { targetDir, apkPath, mainActivityPath };
}

async function ensureApkBuilt(
  targetDir: string,
  sandbox: IntegrationSandbox,
  apkPath: string,
): Promise<string> {
  if (cachedBuiltApkPath && existsSync(cachedBuiltApkPath)) {
    await mkdir(join(targetDir, 'app', 'build', 'outputs', 'apk', 'debug'), { recursive: true });
    await cp(cachedBuiltApkPath, apkPath);
    return apkPath;
  }

  const javaExe = join(
    sandbox.prerequisites.jdk21Path,
    'bin',
    process.platform === 'win32' ? 'java.exe' : 'java',
  );
  const wrapperJar = join(targetDir, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  const gradleResult = spawnSync(
    javaExe,
    [
      '-cp',
      wrapperJar,
      'org.gradle.wrapper.GradleWrapperMain',
      ':app:assembleDebug',
      '--no-daemon',
      '--stacktrace',
    ],
    {
      cwd: targetDir,
      env: {
        ...sandbox.env,
        GRADLE_USER_HOME: sandbox.gradleUserHome,
        JAVA_HOME: sandbox.prerequisites.jdk21Path,
      },
      encoding: 'utf8',
      timeout: 300000,
      windowsHide: true,
    },
  );

  assert.equal(
    gradleResult.status,
    0,
    `Gradle build failed: ${gradleResult.error ?? ''}\n${gradleResult.stdout}\n${gradleResult.stderr}`,
  );
  assert.ok(existsSync(apkPath), `Built APK not found at ${apkPath}`);
  cachedBuiltApkPath = apkPath;
  return apkPath;
}

test('CLI parameter validation: rejects invalid args, selector conflicts, and bad UUIDs with code 2', async () => {
  const cliScript = resolveCliScript();

  // Missing subcommand
  const noArgs = spawnSync(process.execPath, [cliScript], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(noArgs.status, 2);
  const parsedNoArgs = JSON.parse(noArgs.stdout.trim());
  assert.equal(parsedNoArgs.success, false);
  assert.equal(parsedNoArgs.error.code, 'INVALID_ARGUMENTS');

  // Both package and pid specified
  const bothSelectors = spawnSync(
    process.execPath,
    [cliScript, 'prepare', '--package', TEST_PACKAGE, '--pid', '1234'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true },
  );
  assert.equal(bothSelectors.status, 2);
  const parsedBoth = JSON.parse(bothSelectors.stdout.trim());
  assert.equal(parsedBoth.success, false);
  assert.equal(parsedBoth.error.code, 'INVALID_ARGUMENTS');

  // Missing package value
  const missingPkg = spawnSync(process.execPath, [cliScript, 'prepare', '--package'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(missingPkg.status, 2);
  const parsedMissingPkg = JSON.parse(missingPkg.stdout.trim());
  assert.equal(parsedMissingPkg.success, false);
  assert.equal(parsedMissingPkg.error.code, 'INVALID_ARGUMENTS');

  // Both timeout and timeout-ms
  const bothTimeouts = spawnSync(
    process.execPath,
    [cliScript, 'prepare', '--package', TEST_PACKAGE, '--timeout', '10', '--timeout-ms', '10000'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true },
  );
  assert.equal(bothTimeouts.status, 2);
  const parsedTimeouts = JSON.parse(bothTimeouts.stdout.trim());
  assert.equal(parsedTimeouts.success, false);
  assert.equal(parsedTimeouts.error.code, 'INVALID_ARGUMENTS');

  // Unknown flag
  const unknownFlag = spawnSync(
    process.execPath,
    [cliScript, 'prepare', '--package', TEST_PACKAGE, '--bogus'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true },
  );
  assert.equal(unknownFlag.status, 2);
  const parsedUnknown = JSON.parse(unknownFlag.stdout.trim());
  assert.equal(parsedUnknown.success, false);
  assert.equal(parsedUnknown.error.code, 'INVALID_ARGUMENTS');

  // Cleanup with invalid UUID
  const badUuid = spawnSync(process.execPath, [cliScript, 'cleanup', '--key', 'not-a-valid-uuid'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(badUuid.status, 2);
  const parsedBadUuid = JSON.parse(badUuid.stdout.trim());
  assert.equal(parsedBadUuid.success, false);
  assert.equal(parsedBadUuid.error.code, 'INVALID_ARGUMENTS');
});

test('Scenario 1: normal launch -> CLI prepare -> DAP attach -> tick breakpoint -> frame variables (after = before + 1) -> step counter -> detach (original PID survives) -> release & idempotence -> adb forward unchanged', async (t) => {
  if (!hasPrerequisitesEnvironment()) {
    t.skip('Missing general integration suite prerequisites (server, JDKs, EULA)');
    return;
  }
  const deviceId = getTestDevice();
  if (!deviceId) {
    console.warn(
      'SKIPPED: OMP_INTELLIJ_TEST_ANDROID_DEVICE not set; Android device acceptance incomplete',
    );
    t.skip('OMP_INTELLIJ_TEST_ANDROID_DEVICE not set; Android device acceptance incomplete');
    return;
  }
  if (!isDeviceOnline(deviceId)) {
    console.warn(
      `SKIPPED: Android device ${deviceId} is not online; Android device acceptance incomplete`,
    );
    t.skip(`Android device ${deviceId} is not online; Android device acceptance incomplete`);
    return;
  }

  const prerequisites = await verifyPrerequisites();
  const sandbox = await createIntegrationSandbox(prerequisites);

  try {
    const { targetDir, apkPath, mainActivityPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);

    installFixture(deviceId, apkPath);

    const forwardBefore = getAdbForwardList(deviceId);

    stopFixture(deviceId);
    startFixture(deviceId, false);
    const originalPid = await getFixturePid(deviceId);
    assert.ok(originalPid > 0, 'Original PID must be a positive integer');

    const prep = runPrepareCli({ package: TEST_PACKAGE, device: deviceId }, targetDir, sandbox);
    assert.equal(prep.status, 0, `prepare CLI failed: ${prep.stderr}\n${prep.stdout}`);
    assert.ok(prep.data, 'prepare CLI must return JSON on stdout');
    const prepared = prep.data;
    assert.equal(prepared.success, true);
    assert.equal(prepared.pid, originalPid);
    assert.equal(prepared.deviceId, deviceId);
    assert.equal(prepared.host, '127.0.0.1');
    assert.ok(prepared.port > 0, 'Prepared debug port must be > 0');
    assert.ok(prepared.cleanupKey, 'Prepared debug info must include cleanupKey');

    const forwardAfterPrep = getAdbForwardList(deviceId);
    assert.equal(
      forwardAfterPrep,
      forwardBefore,
      'adb forward --list must remain unchanged after prepare (no forward leaks)',
    );

    const dap = createDapClientDriver(targetDir, sandbox);
    await dap.request('initialize', {
      clientID: 'test-scenario-1',
      adapterID: 'intellij',
    });

    const breakLine = findSourceLine(mainActivityPath, 'counter = after;');
    await dap.request('setBreakpoints', {
      source: { path: mainActivityPath },
      breakpoints: [{ line: breakLine }],
    });

    await dap.request('attach', {
      host: prepared.host,
      port: prepared.port,
      timeout: 15000,
    });
    await dap.request('configurationDone');

    const stopped = await dap.waitForEvent('stopped', 30000);
    const stoppedBody = parseStoppedBody(stopped.body);
    assert.equal(stoppedBody.reason, 'breakpoint', 'Should stop at breakpoint');
    assert.ok(stoppedBody.threadId !== undefined, 'Stopped event must contain threadId');
    const threadId = stoppedBody.threadId;

    const stackResp = await dap.request('stackTrace', { threadId });
    const stackBody = parseStackTraceResponse(stackResp.body);
    assert.ok(
      stackBody.stackFrames && stackBody.stackFrames.length > 0,
      'Stack trace must return frames',
    );
    const topFrame = stackBody.stackFrames[0];
    const frameId = topFrame.id;

    const scopesResp = await dap.request('scopes', { frameId });
    const scopesBody = parseScopesResponse(scopesResp.body);
    assert.ok(scopesBody.scopes && scopesBody.scopes.length > 0, 'Scopes must return scopes list');
    const localScope =
      scopesBody.scopes.find((s) => s.name.toLowerCase().includes('local')) ?? scopesBody.scopes[0];

    const varsResp = await dap.request('variables', {
      variablesReference: localScope.variablesReference,
    });
    const varsBody = parseVariablesResponse(varsResp.body);
    assert.ok(varsBody.variables, 'Variables response must contain variables array');

    const beforeVar = varsBody.variables.find((v) => v.name === 'before');
    const afterVar = varsBody.variables.find((v) => v.name === 'after');
    assert.ok(beforeVar, 'Variables must include "before"');
    assert.ok(afterVar, 'Variables must include "after"');

    const beforeNum = parseInt(beforeVar.value, 10);
    const afterNum = parseInt(afterVar.value, 10);
    assert.equal(
      afterNum,
      beforeNum + 1,
      `Expected after (${afterNum}) to equal before + 1 (${beforeNum + 1})`,
    );

    const thisVar = varsBody.variables.find((variable) => variable.name === 'this');
    assert.ok(thisVar && thisVar.variablesReference > 0, 'Activity object must be expandable');
    const fields = parseVariablesResponse(
      (await dap.request('variables', { variablesReference: thisVar.variablesReference })).body,
    ).variables;
    const counterField = fields?.find((variable) => variable.name === 'counter');
    assert.ok(counterField, 'Activity fields must include counter');
    assert.equal(
      Number(counterField.value),
      beforeNum,
      'Object field must reflect the suspended VM',
    );
    assert.ok(
      fields?.every((field) => !['shadow$_klass_', 'shadow$_monitor_'].includes(field.name)),
      'ART shadow fields must remain hidden',
    );

    // Step over
    await dap.request('next', { threadId });
    const stepStopped = await dap.waitFor(
      (event) => event.type === 'event' && event.event === 'stopped' && event.seq > stopped.seq,
      15000,
    );
    const stepThread = parseStoppedBody(stepStopped.body).threadId;
    assert.ok(stepThread !== undefined);
    const stepStack = parseStackTraceResponse(
      (await dap.request('stackTrace', { threadId: stepThread })).body,
    );
    assert.ok(stepStack.stackFrames?.[0]);
    const counterEval = await dap.evaluate('counter', stepStack.stackFrames[0].id);
    assert.equal(
      Number(counterEval),
      afterNum,
      'Field counter must be updated to after value after step execution',
    );

    // Detach with terminateDebuggee=false
    await dap.request('disconnect', { terminateDebuggee: false });
    await dap.waitForExit(15000);

    // Verify original PID survives on device
    const pidAfter = await getFixturePid(deviceId);
    assert.equal(pidAfter, originalPid, 'Original target PID must survive after DAP disconnect');

    // Port release and cleanup idempotence
    await waitForPortReleased(prepared.port);

    const cleanup = runCleanupCli(prepared.cleanupKey, targetDir, sandbox);
    assert.equal(cleanup.status, 0, `${cleanup.stderr}\n${cleanup.stdout}`);
    assert.equal(cleanup.data?.success, true);
    assert.equal(
      cleanup.data?.cleaned,
      false,
      'Already claimed and released handle should return cleaned: false',
    );
    assert.equal(cleanup.data?.reason, 'already_cleaned', 'Should report reason: already_cleaned');

    const forwardFinal = getAdbForwardList(deviceId);
    assert.equal(
      forwardFinal,
      forwardBefore,
      'adb forward --list must be completely unchanged throughout',
    );
  } finally {
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('Scenario 2: am start -D (Waiting for Debugger) -> prepare & attach -> dismiss waiting dialog -> tick breakpoint hit -> frame variables -> step -> detach', async (t) => {
  if (!hasPrerequisitesEnvironment()) {
    t.skip('Missing general integration suite prerequisites (server, JDKs, EULA)');
    return;
  }
  const deviceId = getTestDevice();
  if (!deviceId) {
    console.warn(
      'SKIPPED: OMP_INTELLIJ_TEST_ANDROID_DEVICE not set; Android device acceptance incomplete',
    );
    t.skip('OMP_INTELLIJ_TEST_ANDROID_DEVICE not set; Android device acceptance incomplete');
    return;
  }
  if (!isDeviceOnline(deviceId)) {
    console.warn(
      `SKIPPED: Android device ${deviceId} is not online; Android device acceptance incomplete`,
    );
    t.skip(`Android device ${deviceId} is not online; Android device acceptance incomplete`);
    return;
  }

  const prerequisites = await verifyPrerequisites();
  const sandbox = await createIntegrationSandbox(prerequisites);

  try {
    const { targetDir, apkPath, mainActivityPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);

    installFixture(deviceId, apkPath);

    stopFixture(deviceId);
    // Start with -D: Waiting for Debugger
    startFixture(deviceId, true);
    const originalPid = await getFixturePid(deviceId);
    assert.ok(originalPid > 0, 'Original PID must be a positive integer');

    const prep = runPrepareCli({ package: TEST_PACKAGE, device: deviceId }, targetDir, sandbox);
    assert.equal(prep.status, 0, `prepare CLI failed: ${prep.stderr}\n${prep.stdout}`);
    assert.ok(prep.data, 'prepare CLI must return JSON on stdout');
    const prepared = prep.data;
    assert.equal(prepared.success, true);
    assert.equal(prepared.pid, originalPid);

    const dap = createDapClientDriver(targetDir, sandbox);
    await dap.request('initialize', {
      clientID: 'test-scenario-2',
      adapterID: 'intellij',
    });

    const breakLine = findSourceLine(mainActivityPath, 'counter = after;');
    await dap.request('setBreakpoints', {
      source: { path: mainActivityPath },
      breakpoints: [{ line: breakLine }],
    });

    await dap.request('attach', {
      host: prepared.host,
      port: prepared.port,
      timeout: 15000,
    });
    await dap.request('configurationDone');

    // Attaching resumes Waiting for Debugger and hits the tick breakpoint
    const stopped = await dap.waitForEvent('stopped', 30000);
    const stoppedBody = parseStoppedBody(stopped.body);
    assert.equal(stoppedBody.reason, 'breakpoint');
    assert.ok(stoppedBody.threadId !== undefined, 'Stopped event must contain threadId');
    const threadId = stoppedBody.threadId;

    const stackResp = await dap.request('stackTrace', { threadId });
    const stackBody = parseStackTraceResponse(stackResp.body);
    assert.ok(
      stackBody.stackFrames && stackBody.stackFrames.length > 0,
      'Stack trace must return frames',
    );
    const topFrame = stackBody.stackFrames[0];

    const scopesResp = await dap.request('scopes', { frameId: topFrame.id });
    const scopesBody = parseScopesResponse(scopesResp.body);
    assert.ok(scopesBody.scopes && scopesBody.scopes.length > 0, 'Scopes must return scopes list');
    const localScope =
      scopesBody.scopes.find((s) => s.name.toLowerCase().includes('local')) ?? scopesBody.scopes[0];

    const varsResp = await dap.request('variables', {
      variablesReference: localScope.variablesReference,
    });
    const varsBody = parseVariablesResponse(varsResp.body);
    assert.ok(varsBody.variables, 'Variables response must contain variables array');
    const beforeVar = varsBody.variables.find((v) => v.name === 'before');
    const afterVar = varsBody.variables.find((v) => v.name === 'after');
    assert.ok(beforeVar, 'Variables must include "before"');
    assert.ok(afterVar, 'Variables must include "after"');

    const beforeNum = parseInt(beforeVar.value, 10);
    const afterNum = parseInt(afterVar.value, 10);
    assert.equal(afterNum, beforeNum + 1);

    await dap.request('next', { threadId });
    const stepStopped = await dap.waitFor(
      (event) => event.type === 'event' && event.event === 'stopped' && event.seq > stopped.seq,
      15000,
    );
    const stepThread = parseStoppedBody(stepStopped.body).threadId;
    assert.ok(stepThread !== undefined);
    const stepStack = parseStackTraceResponse(
      (await dap.request('stackTrace', { threadId: stepThread })).body,
    );
    assert.ok(stepStack.stackFrames?.[0]);
    const counterVal = await dap.evaluate('counter', stepStack.stackFrames[0].id);
    assert.equal(Number(counterVal), afterNum);

    await dap.request('disconnect', { terminateDebuggee: false });
    await dap.waitForExit(15000);

    const pidAfter = await getFixturePid(deviceId);
    assert.equal(pidAfter, originalPid, 'Target PID must survive after disconnect');

    await waitForPortReleased(prepared.port);
  } finally {
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('Scenario 3: strong proxy kill (SIGKILL) -> LSP EOF auto resource recovery without subsequent prepare -> port freed -> sibling project unaffected -> new prepare succeeds', async (t) => {
  if (!hasPrerequisitesEnvironment()) {
    t.skip('Missing general integration suite prerequisites (server, JDKs, EULA)');
    return;
  }
  const deviceId = getTestDevice();
  if (!deviceId) {
    console.warn(
      'SKIPPED: OMP_INTELLIJ_TEST_ANDROID_DEVICE not set; Android device acceptance incomplete',
    );
    t.skip('OMP_INTELLIJ_TEST_ANDROID_DEVICE not set; Android device acceptance incomplete');
    return;
  }
  if (!isDeviceOnline(deviceId)) {
    console.warn(
      `SKIPPED: Android device ${deviceId} is not online; Android device acceptance incomplete`,
    );
    t.skip(`Android device ${deviceId} is not online; Android device acceptance incomplete`);
    return;
  }

  const prerequisites = await verifyPrerequisites();
  const sandbox = await createIntegrationSandbox(prerequisites);

  try {
    const { targetDir, apkPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);

    installFixture(deviceId, apkPath);

    stopFixture(deviceId);
    startFixture(deviceId, false);
    const originalPid = await getFixturePid(deviceId);

    const prep = runPrepareCli({ package: TEST_PACKAGE, device: deviceId }, targetDir, sandbox);
    assert.equal(prep.status, 0, `${prep.stderr}\n${prep.stdout}`);
    assert.ok(prep.data, 'prepare CLI must return JSON on stdout');
    const prepared = prep.data;

    const dap = createDapClientDriver(targetDir, sandbox);
    await dap.request('initialize', {
      clientID: 'test-scenario-3',
      adapterID: 'intellij',
    });
    await dap.request('attach', {
      host: prepared.host,
      port: prepared.port,
      timeout: 15000,
    });
    await dap.request('configurationDone');

    // Create a sibling session in a separate project
    const jdk21Dir = await copyWorkspaceFixture('jdk21', sandbox);
    const siblingLsp = createLspClientDriver(jdk21Dir, sandbox);
    await siblingLsp.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(jdk21Dir).href,
      capabilities: {},
    });
    siblingLsp.notify('initialized', {});

    // Strongly kill the DAP proxy process to cause LSP EOF
    const dapPid = dap.process.pid;
    assert.ok(dapPid !== undefined && dapPid > 0, 'DAP process PID must be defined');
    killProcessSafely(dapPid, sandbox);
    await dap.waitForExit(15000);

    // Verify proxy port is freed automatically on LSP EOF without requiring subsequent prepare
    await waitForPortReleased(prepared.port);

    // Verify that a new prepare on the target succeeds immediately
    const newPrep = runPrepareCli({ package: TEST_PACKAGE, device: deviceId }, targetDir, sandbox);
    assert.equal(newPrep.status, 0, `New prepare after proxy kill must succeed: ${newPrep.stderr}`);
    assert.ok(newPrep.data?.cleanupKey);
    assert.equal(newPrep.data?.pid, originalPid);

    // Clean up the newly prepared handle
    runCleanupCli(newPrep.data.cleanupKey, targetDir, sandbox);

    // Verify sibling project LSP is still fully responsive
    const symResult = await siblingLsp.request('workspace/symbol', { query: 'App' });
    assert.ok(Array.isArray(symResult), 'Sibling LSP session must remain fully operational');
    await siblingLsp.close();
  } finally {
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('Scenario 4: target cancellation & exit -> stopping app on device releases proxy port & handle closes cleanly', async (t) => {
  if (!hasPrerequisitesEnvironment()) {
    t.skip('Missing general integration suite prerequisites (server, JDKs, EULA)');
    return;
  }
  const deviceId = getTestDevice();
  if (!deviceId) {
    console.warn(
      'SKIPPED: OMP_INTELLIJ_TEST_ANDROID_DEVICE not set; Android device acceptance incomplete',
    );
    t.skip('OMP_INTELLIJ_TEST_ANDROID_DEVICE not set; Android device acceptance incomplete');
    return;
  }
  if (!isDeviceOnline(deviceId)) {
    console.warn(
      `SKIPPED: Android device ${deviceId} is not online; Android device acceptance incomplete`,
    );
    t.skip(`Android device ${deviceId} is not online; Android device acceptance incomplete`);
    return;
  }

  const prerequisites = await verifyPrerequisites();
  const sandbox = await createIntegrationSandbox(prerequisites);

  try {
    const { targetDir, apkPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);

    installFixture(deviceId, apkPath);

    stopFixture(deviceId);
    startFixture(deviceId, false);
    await getFixturePid(deviceId);

    const prep = runPrepareCli({ package: TEST_PACKAGE, device: deviceId }, targetDir, sandbox);
    assert.equal(prep.status, 0, `${prep.stderr}\n${prep.stdout}`);
    assert.ok(prep.data, 'prepare CLI must return JSON on stdout');
    const prepared = prep.data;

    // Proxy port should be listening
    const listening = await isPortListening(prepared.port);
    assert.equal(listening, true, 'Proxy port should be actively listening');

    // Force stop the fixture app on device to simulate target exit
    stopFixture(deviceId);

    // Port should be released within a short timeout as adblib detects process exit
    await waitForPortReleased(prepared.port, '127.0.0.1', 15000);

    // Cleanup should report successful closure
    const cleanup = runCleanupCli(prepared.cleanupKey, targetDir, sandbox);
    assert.equal(cleanup.status, 0, `${cleanup.stderr}\n${cleanup.stdout}`);
    assert.equal(cleanup.data?.success, true);
  } finally {
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('Scenario 5: prepare and release without DAP -> port released, cleanup is idempotent, and second release returns already_cleaned', async (t) => {
  if (!hasPrerequisitesEnvironment()) {
    t.skip('Missing general integration suite prerequisites (server, JDKs, EULA)');
    return;
  }
  const deviceId = getTestDevice();
  if (!deviceId) {
    console.warn(
      'SKIPPED: OMP_INTELLIJ_TEST_ANDROID_DEVICE not set; Android device acceptance incomplete',
    );
    t.skip('OMP_INTELLIJ_TEST_ANDROID_DEVICE not set; Android device acceptance incomplete');
    return;
  }
  if (!isDeviceOnline(deviceId)) {
    console.warn(
      `SKIPPED: Android device ${deviceId} is not online; Android device acceptance incomplete`,
    );
    t.skip(`Android device ${deviceId} is not online; Android device acceptance incomplete`);
    return;
  }

  const prerequisites = await verifyPrerequisites();
  const sandbox = await createIntegrationSandbox(prerequisites);

  try {
    const { targetDir, apkPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);

    installFixture(deviceId, apkPath);

    stopFixture(deviceId);
    startFixture(deviceId, false);
    await getFixturePid(deviceId);

    const prep = runPrepareCli({ package: TEST_PACKAGE, device: deviceId }, targetDir, sandbox);
    assert.equal(prep.status, 0, `${prep.stderr}\n${prep.stdout}`);
    assert.ok(prep.data, 'prepare CLI must return JSON on stdout');
    const prepared = prep.data;

    const listening = await isPortListening(prepared.port);
    assert.equal(listening, true, 'Proxy port should be listening before release');

    // First cleanup: should actively clean and close port
    const cleanup1 = runCleanupCli(prepared.cleanupKey, targetDir, sandbox);
    assert.equal(cleanup1.status, 0, `${cleanup1.stderr}\n${cleanup1.stdout}`);
    assert.equal(cleanup1.data?.success, true);
    assert.equal(cleanup1.data?.cleaned, true);

    await waitForPortReleased(prepared.port);

    // Second cleanup: idempotent, reports already_cleaned
    const cleanup2 = runCleanupCli(prepared.cleanupKey, targetDir, sandbox);
    assert.equal(cleanup2.status, 0, `${cleanup2.stderr}\n${cleanup2.stdout}`);
    assert.equal(cleanup2.data?.success, true);
    assert.equal(cleanup2.data?.cleaned, false);
    assert.equal(cleanup2.data?.reason, 'already_cleaned');
  } finally {
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('cancelling a real pending prepare releases its child and preserves subsequent device use', async (t) => {
  const deviceId = getTestDevice();
  if (!hasPrerequisitesEnvironment() || !deviceId || !isDeviceOnline(deviceId)) {
    t.skip(
      'Explicit online Android device and integration prerequisites required; device acceptance incomplete',
    );
    return;
  }
  const sandbox = await createIntegrationSandbox(await verifyPrerequisites());
  let lsp: LspClientDriver | undefined;
  try {
    const { targetDir, apkPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);
    installFixture(deviceId, apkPath);
    stopFixture(deviceId);
    startFixture(deviceId);
    const pid = await getFixturePid(deviceId);
    const forwards = getAdbForwardList(deviceId);
    lsp = createLspClientDriver(targetDir, sandbox);
    await lsp.request(
      'initialize',
      {
        processId: process.pid,
        rootUri: pathToFileURL(targetDir).href,
        capabilities: { experimental: { licensingUi: true } },
      },
      180000,
    );
    lsp.notify('initialized', {});
    await lsp.request('workspace/symbol', { query: 'MainActivity' }, 180000);
    const id = 900001;
    lsp.process.stdin?.write(
      encode({
        jsonrpc: '2.0',
        id,
        method: 'workspace/executeCommand',
        params: {
          command: 'omp.android.debug.prepare',
          arguments: [{ pid, deviceId: 'omp-attach-cancel-absent', timeoutMs: 300000 }],
        },
      }),
    );
    // A completed independent request establishes a live, ready connection before cancellation.
    await lsp.request('workspace/symbol', { query: 'MainActivity' }, 30000);
    lsp.notify('$/cancelRequest', { id });
    const cancelled = await lsp.waitFor((message) => message.id === id && !message.method, 30000);
    assert.equal(cancelled.error?.code, -32800, JSON.stringify(cancelled));
    await lsp.close();
    lsp = undefined;
    const prepared = runPrepareCli({ pid, device: deviceId }, targetDir, sandbox);
    assert.equal(prepared.status, 0, `${prepared.stderr}\n${prepared.stdout}`);
    assert.ok(prepared.data);
    const released = runCleanupCli(prepared.data.cleanupKey, targetDir, sandbox);
    assert.equal(released.status, 0, `${released.stderr}\n${released.stdout}`);
    await waitForPortReleased(prepared.data.port);
    assert.equal(getAdbForwardList(deviceId), forwards);
  } finally {
    await lsp?.close();
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});
