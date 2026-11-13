import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
// Real platform delays for hardware/AVD adb polling and socket EOF cleanup.
// Deterministic fake timers cannot control external OS process and network states.
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_SERVER_VERSION } from '../../src/server/bundle-metadata.js';
import {
  copyCachedDependencies,
  copyWorkspaceFixture,
  createDapClientDriver,
  createIntegrationSandbox,
  createLspClientDriver,
  type DapClientDriver,
  type IntegrationPrerequisites,
  type IntegrationSandbox,
  isProcessAlive,
  killProcessSafely,
  type LspClientDriver,
  seedSandboxProjectConfig,
  verifyPrerequisites,
} from './fixture.js';
import {
  createNativeAndroidClient,
  type NativeAndroidClient,
  type NativeMessage,
  type NativePeer,
} from './native-android-client.js';
import { createOmpHostDriver, type OmpHostDriver } from './omp-host-client.js';
import { createRunArtifactStore } from './run-artifact.js';

const TEST_PACKAGE = 'com.example.ompattachfixture';
const TEST_ACTIVITY = 'com.example.ompattachfixture/.MainActivity';
const TEST_WORKER_PROCESS = 'com.example.ompattachfixture:worker';
const INCLUDED_PACKAGE = 'com.example.ompattachincluded';
const INCLUDED_PROCESS = 'com.example.ompattachincluded.appproc';

interface StoppedEventBody {
  reason?: string;
  threadId?: number;
}

interface SourceBody {
  name?: string;
  path?: string;
  sourceReference?: number;
}

interface StackFrameEntry {
  id: number;
  name?: string;
  line?: number;
  column?: number;
  source?: SourceBody;
}

interface StackTraceResponse {
  stackFrames?: StackFrameEntry[];
}

interface ScopeEntry {
  name: string;
  variablesReference: number;
  source?: SourceBody;
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

interface BreakpointEntry {
  id?: number;
  verified?: boolean;
  line?: number;
  column?: number;
  message?: string;
  source?: SourceBody;
}

interface SetBreakpointsResponse {
  breakpoints?: BreakpointEntry[];
}

interface TargetsDeviceEntry {
  deviceId: string;
  state: string;
  abis: string[];
}

interface TargetsVariantEntry {
  name: string;
  assembleTask: string | null;
  listingFile: string | null;
  abiFilters: string[] | null;
}

interface TargetsModuleEntry {
  buildRoot: string;
  module: string;
  variants: TargetsVariantEntry[];
}

interface TargetsResponse {
  devices: TargetsDeviceEntry[];
  modules: TargetsModuleEntry[];
  includedBuilds?: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseStoppedBody(body: unknown): StoppedEventBody {
  return asRecord(body) as StoppedEventBody;
}

function parseStackTraceResponse(body: unknown): StackTraceResponse {
  return asRecord(body) as StackTraceResponse;
}

function parseScopesResponse(body: unknown): ScopesResponse {
  return asRecord(body) as ScopesResponse;
}

function parseVariablesResponse(body: unknown): VariablesResponse {
  return asRecord(body) as VariablesResponse;
}

export interface AndroidAttachPrerequisites extends IntegrationPrerequisites {
  androidHome: string;
  deviceId: string;
}

export async function verifyAndroidAttachPrerequisites(): Promise<AndroidAttachPrerequisites> {
  const prereqs = await verifyPrerequisites();
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk || !existsSync(sdk)) {
    throw new Error(
      'Android attach suite missing valid ANDROID_HOME or ANDROID_SDK_ROOT directory',
    );
  }
  const deviceId = getTestDevice();
  if (!deviceId) {
    throw new Error(
      'Android attach suite missing required OMP_INTELLIJ_TEST_ANDROID_DEVICE environment variable',
    );
  }
  if (!isDeviceOnline(deviceId)) {
    throw new Error(`Android attach suite required Android device ${deviceId} is not online`);
  }
  return {
    ...prereqs,
    androidHome: sdk,
    deviceId,
  };
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

const prerequisites = await verifyAndroidAttachPrerequisites();
const deviceId = prerequisites.deviceId;

async function findAapt2Executable(androidHome: string): Promise<string | undefined> {
  const buildToolsDir = join(androidHome, 'build-tools');
  if (!existsSync(buildToolsDir)) return undefined;
  const entries = (await readdir(buildToolsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const binary = process.platform === 'win32' ? 'aapt2.exe' : 'aapt2';
  for (const version of entries) {
    const candidate = join(buildToolsDir, version, binary);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function getAdbForwardList(deviceId: string): string {
  const res = runAdb(['-s', deviceId, 'forward', '--list'], 5000);
  return res.stdout.trim();
}

function getCurrentUserId(deviceId: string): number {
  const res = runAdb(['-s', deviceId, 'shell', 'am', 'get-current-user'], 10000);
  assert.equal(res.status, 0, `Failed to query current user: ${res.stderr || res.stdout}`);
  const parsed = Number.parseInt(res.stdout.trim(), 10);
  assert.ok(Number.isInteger(parsed) && parsed >= 0, `Invalid user id: ${res.stdout}`);
  return parsed;
}

function stopPackage(deviceId: string, pkg = TEST_PACKAGE): void {
  runAdb(['-s', deviceId, 'shell', 'am', 'force-stop', pkg], 10000);
}

function stopFixture(deviceId: string): void {
  stopPackage(deviceId, TEST_PACKAGE);
}

function startActivity(
  deviceId: string,
  component = TEST_ACTIVITY,
  waitForDebugger = false,
): void {
  const args = ['-s', deviceId, 'shell', 'am', 'start'];
  if (waitForDebugger) {
    args.push('-D');
  }
  args.push('-n', component);
  const res = runAdb(args, 15000);
  assert.equal(res.status, 0, `Failed to start ${component}: ${res.stderr || res.stdout}`);
}

function startFixture(deviceId: string, waitForDebugger = false): void {
  startActivity(deviceId, TEST_ACTIVITY, waitForDebugger);
}

function installFixture(deviceId: string, apkPath: string): void {
  const res = runAdb(['-s', deviceId, 'install', '-r', '-t', apkPath], 60000);
  assert.equal(res.status, 0, `Failed to install APK ${apkPath}: ${res.stderr || res.stdout}`);
}

function getPidOfProcess(deviceId: string, processName: string): number | null {
  const res = runAdb(['-s', deviceId, 'shell', 'pidof', processName], 5000);
  if (res.status !== 0 || res.stdout.trim().length === 0) return null;
  const parts = res.stdout.trim().split(/\s+/);
  const pid = Number.parseInt(parts[0], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function getPackagePid(
  deviceId: string,
  processName = TEST_PACKAGE,
  timeoutMs = 15000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = getPidOfProcess(deviceId, processName);
    if (pid !== null) {
      return pid;
    }
    await sleep(200);
  }
  throw new Error(
    `Process ${processName} was not detected on device ${deviceId} within ${timeoutMs}ms`,
  );
}

async function getFixturePid(deviceId: string, timeoutMs = 15000): Promise<number> {
  return getPackagePid(deviceId, TEST_PACKAGE, timeoutMs);
}

async function waitForProcessGone(
  deviceId: string,
  processName = TEST_PACKAGE,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getPidOfProcess(deviceId, processName) === null) return;
    await sleep(150);
  }
  assert.equal(
    getPidOfProcess(deviceId, processName),
    null,
    `Process ${processName} was expected to be stopped on ${deviceId}`,
  );
}

async function getAmsProcessIdentity(
  deviceId: string,
  pkg = TEST_PACKAGE,
): Promise<{ record: string; startSeq: string | null; pid: number }> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const pid = getPidOfProcess(deviceId, pkg);
    const dumpRes = runAdb(['-s', deviceId, 'shell', 'dumpsys', 'activity', 'processes', pkg], 10000);
    const escapedPkg = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const recordMatch = dumpRes.stdout.match(
      new RegExp(`ProcessRecord\\{([^}]*${escapedPkg}[^}]*)\\}`),
    );
    if (pid !== null && recordMatch?.[1]) {
      const startSeq = dumpRes.stdout.match(/startSeq=(\d+)/)?.[1] ?? null;
      return { record: recordMatch[1], startSeq, pid };
    }
    await sleep(100);
  }
  throw new Error(`AMS process record for ${pkg} did not appear on ${deviceId}`);
}

function getActiveInstallSessionsSection(deviceId: string): string {
  const res = runAdb(['-s', deviceId, 'shell', 'dumpsys', 'package', 'installs'], 10000);
  assert.equal(res.status, 0, `dumpsys package installs failed: ${res.stderr || res.stdout}`);
  const match = res.stdout.match(
    /Active install sessions:\s*([\s\S]*?)Finalized install sessions:/,
  );
  return match?.[1]?.trim() ?? res.stdout.trim();
}

async function startNativeClient(
  projectDirectory: string,
  sandbox: IntegrationSandbox,
  jdkOverride?: string,
): Promise<NativeAndroidClient> {
  return createNativeAndroidClient({
    serverExecutable: sandbox.prerequisites.serverExecutable,
    acceptedEulaHash: sandbox.prerequisites.acceptedEulaHash,
    projectDirectory,
    jdk: jdkOverride ?? sandbox.prerequisites.jdk21Path,
    sandboxDirectory: sandbox.sandboxDir,
    extensionDirectory: resolve('resources', 'ils', DEFAULT_SERVER_VERSION, 'android.lsp'),
    env: sandbox.env,
    trackProcess: sandbox.trackProcess,
    trackSocket: sandbox.trackSocket,
  });
}

async function attachNativeAndroidDap(
  native: NativeAndroidClient,
  options: {
    clientID: string;
    deviceId: string;
    packageName?: string;
    userId?: number;
    pid?: number;
    processName?: string;
    breakpointFile?: string;
    breakpointLine?: number;
    pathFormat?: 'path' | 'uri';
    linesStartAt1?: boolean;
    columnsStartAt1?: boolean;
  },
): Promise<{ dap: NativePeer; attachResponse: NativeMessage }> {
  const dap = await native.connectDap();
  try {
    const initResp = await dap.request('initialize', {
      clientID: options.clientID,
      adapterID: 'android',
      linesStartAt1: options.linesStartAt1 ?? true,
      columnsStartAt1: options.columnsStartAt1 ?? true,
      pathFormat: options.pathFormat ?? 'path',
      supportsProgressReporting: true,
    });
    assert.equal(initResp.success, true, JSON.stringify(initResp));

    const androidArgs: Record<string, unknown> = {
      deviceId: options.deviceId,
      packageName: options.packageName ?? TEST_PACKAGE,
    };
    if (options.userId !== undefined) androidArgs.userId = options.userId;
    if (options.pid !== undefined) androidArgs.pid = options.pid;
    if (options.processName !== undefined) androidArgs.processName = options.processName;

    const attachReq = dap.sendRequest('attach', { android: androidArgs });
    const initializedPromise = dap.waitFor(
      (message) => message.type === 'event' && message.event === 'initialized',
      0,
      120000,
    );
    const earlyOrInit = await Promise.race([
      initializedPromise.then(() => 'initialized' as const),
      attachReq.response.then((resp) => ({ kind: 'early-response' as const, resp })),
    ]);
    if (earlyOrInit !== 'initialized') {
      assert.fail(
        `attach completed before initialized event: ${JSON.stringify(earlyOrInit.resp)}`,
      );
    }

    if (options.breakpointFile && options.breakpointLine !== undefined) {
      const bpResp = await dap.request('setBreakpoints', {
        source: { path: options.breakpointFile },
        breakpoints: [{ line: options.breakpointLine }],
      });
      assert.equal(bpResp.success, true, JSON.stringify(bpResp));
    }

    const cfgResp = await dap.request('configurationDone', {});
    assert.equal(cfgResp.success, true, JSON.stringify(cfgResp));

    const attachResponse = await attachReq.response;
    assert.equal(attachResponse.success, true, JSON.stringify(attachResponse));
    return { dap, attachResponse };
  } catch (error) {
    dap.close();
    throw error;
  }
}

async function launchNativeAndroidDap(
  native: NativeAndroidClient,
  options: {
    clientID: string;
    android: Record<string, unknown>;
    noDebug?: boolean;
    cwd?: string;
    program?: string;
    pathFormat?: 'path' | 'uri';
    linesStartAt1?: boolean;
    columnsStartAt1?: boolean;
    breakpoints?: Array<{ path: string; lines: number[] }>;
    timeoutMs?: number;
  },
): Promise<{ dap: NativePeer; initResponse: NativeMessage; launchResponse: NativeMessage }> {
  const dap = await native.connectDap();
  try {
    const initResponse = await dap.request('initialize', {
      clientID: options.clientID,
      adapterID: 'android',
      linesStartAt1: options.linesStartAt1 ?? true,
      columnsStartAt1: options.columnsStartAt1 ?? true,
      pathFormat: options.pathFormat ?? 'path',
      supportsProgressReporting: true,
    });
    assert.equal(initResponse.success, true, JSON.stringify(initResponse));

    const launchBody: Record<string, unknown> = {
      android: options.android,
    };
    if (options.noDebug !== undefined) launchBody.noDebug = options.noDebug;
    if (options.cwd !== undefined) launchBody.cwd = options.cwd;
    if (options.program !== undefined) launchBody.program = options.program;

    const launchReq = dap.sendRequest('launch', launchBody, options.timeoutMs ?? 150000);
    const initializedPromise = dap.waitFor(
      (message) => message.type === 'event' && message.event === 'initialized',
      0,
      options.timeoutMs ?? 150000,
    );
    const earlyOrInit = await Promise.race([
      initializedPromise.then(() => 'initialized' as const),
      launchReq.response.then((resp) => ({ kind: 'early-response' as const, resp })),
    ]);
    if (earlyOrInit !== 'initialized') {
      throw new Error(
        `launch completed before initialized event: ${JSON.stringify(earlyOrInit.resp)}`,
      );
    }

    for (const entry of options.breakpoints ?? []) {
      const bpResp = await dap.request('setBreakpoints', {
        source: { path: entry.path },
        breakpoints: entry.lines.map((line) => ({ line })),
      });
      assert.equal(bpResp.success, true, JSON.stringify(bpResp));
    }

    const cfgResp = await dap.request('configurationDone', {});
    assert.equal(cfgResp.success, true, JSON.stringify(cfgResp));

    const launchResponse = await launchReq.response;
    assert.equal(launchResponse.success, true, JSON.stringify(launchResponse));
    return { dap, initResponse, launchResponse };
  } catch (error) {
    dap.close();
    throw error;
  }
}

async function evaluateNative(
  dap: NativePeer,
  expression: string,
  frameId: number,
): Promise<unknown> {
  const resp = await dap.request('evaluate', { expression, frameId, context: 'repl' }, 15000);
  assert.equal(resp.success, true, JSON.stringify(resp));
  return resp.body?.result;
}

async function closeNativePeerAndWait(dap: NativePeer): Promise<void> {
  if (dap.socket.destroyed || dap.socket.closed) return;
  const closed = Promise.withResolvers<void>();
  dap.socket.once('close', () => closed.resolve());
  dap.close();
  await closed.promise;
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

async function findFileRecursive(rootDir: string, fileName: string): Promise<string | undefined> {
  if (!existsSync(rootDir)) return undefined;
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFileRecursive(fullPath, fileName);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
  }
  return undefined;
}

function normalizePathForCompare(pathValue: string): string {
  return resolve(pathValue).replace(/\\/g, '/').toLowerCase();
}

async function verifyTickBreakpointAndStep(
  dap: NativePeer,
  afterMessageIndex = 0,
  fieldToCheck = 'counter',
): Promise<void> {
  const stopped = await dap.waitFor(
    (message) => message.type === 'event' && message.event === 'stopped',
    afterMessageIndex,
    30000,
  );
  const stoppedBody = parseStoppedBody(stopped.body);
  assert.equal(stoppedBody.reason, 'breakpoint', 'Should stop at breakpoint');
  assert.ok(stoppedBody.threadId !== undefined, 'Stopped event must contain threadId');
  const threadId = stoppedBody.threadId;

  const stackResp = await dap.request('stackTrace', { threadId });
  assert.equal(stackResp.success, true, JSON.stringify(stackResp));
  const stackBody = parseStackTraceResponse(stackResp.body);
  assert.ok(stackBody.stackFrames && stackBody.stackFrames.length > 0, 'Stack must return frames');
  const frameId = stackBody.stackFrames[0].id;

  const scopesResp = await dap.request('scopes', { frameId });
  assert.equal(scopesResp.success, true, JSON.stringify(scopesResp));
  const scopesBody = parseScopesResponse(scopesResp.body);
  assert.ok(scopesBody.scopes && scopesBody.scopes.length > 0, 'Scopes must return scopes list');
  const localScope =
    scopesBody.scopes.find((s) => s.name.toLowerCase().includes('local')) ?? scopesBody.scopes[0];

  const varsResp = await dap.request('variables', {
    variablesReference: localScope.variablesReference,
  });
  assert.equal(varsResp.success, true, JSON.stringify(varsResp));
  const varsBody = parseVariablesResponse(varsResp.body);
  assert.ok(varsBody.variables, 'Variables response must contain variables array');

  const beforeVar = varsBody.variables.find((v) => v.name === 'before');
  const afterVar = varsBody.variables.find((v) => v.name === 'after');
  assert.ok(beforeVar, 'Variables must include "before"');
  assert.ok(afterVar, 'Variables must include "after"');

  const beforeNum = Number.parseInt(beforeVar.value, 10);
  const afterNum = Number.parseInt(afterVar.value, 10);
  assert.equal(afterNum, beforeNum + 1);

  const afterNextIndex = dap.messages.length;
  const nextResp = await dap.request('next', { threadId });
  assert.equal(nextResp.success, true, JSON.stringify(nextResp));
  const stepStopped = await dap.waitFor(
    (message) => message.type === 'event' && message.event === 'stopped',
    afterNextIndex,
    15000,
  );
  const stepThread = parseStoppedBody(stepStopped.body).threadId;
  assert.ok(stepThread !== undefined);
  const stepStackResp = await dap.request('stackTrace', { threadId: stepThread });
  assert.equal(stepStackResp.success, true, JSON.stringify(stepStackResp));
  const stepStack = parseStackTraceResponse(stepStackResp.body);
  assert.ok(stepStack.stackFrames?.[0]);
  const evaluated = await evaluateNative(dap, fieldToCheck, stepStack.stackFrames[0].id);
  assert.equal(Number(evaluated), afterNum);
}

const APK_ARTIFACT = 'app-debug.apk';
const GENERATED_COUNTER_ARTIFACT = 'GeneratedCounter.java';
let generatedCounterRelPath: string | undefined;

// Each scenario deletes its sandbox; the APK belongs to the run.
const artifactStore = await createRunArtifactStore('omp-intellij-android-attach-apk-');
const realBuilds: { sandboxDir: string; status: number | null }[] = [];

test.after(async () => {
  try {
    const successful = realBuilds.filter((build) => build.status === 0).length;
    console.error(
      `[integration android-attach] apk-builds: ${successful}, attempts: ${realBuilds.length}`,
    );
    const builtIn = realBuilds.map((build) => build.sandboxDir).join(', ');
    assert.ok(
      successful <= 1,
      `APK must be built at most once per suite, saw ${successful} builds in: ${builtIn}`,
    );
  } finally {
    await artifactStore.dispose();
    assert.equal(
      existsSync(artifactStore.dir),
      false,
      'Run artifact directory must be removed after the suite',
    );
  }
});

async function copyAndroidAttachFixture(sandbox: IntegrationSandbox): Promise<{
  targetDir: string;
  apkPath: string;
  releaseApkPath: string;
  includedDir: string;
  includedApkPath: string;
  mainActivityPath: string;
  processActivityPath: string;
  libHelperPath: string;
  includedMainActivityPath: string;
}> {
  const sourceDir = resolve('test-fixtures', 'android-attach');
  const targetDir = join(sandbox.workspacesDir, 'android-attach');
  const generated = new Set([
    join(sourceDir, 'app', 'build'),
    join(sourceDir, 'lib', 'build'),
    join(sourceDir, 'unrelated', 'build'),
    join(sourceDir, 'included', 'app', 'build'),
    join(sourceDir, 'included', 'build'),
    join(sourceDir, 'included', '.gradle'),
    join(sourceDir, 'build'),
    join(sourceDir, '.gradle'),
  ]);
  // Source fixtures may carry stale APKs and Gradle state from local builds.
  await cp(sourceDir, targetDir, { recursive: true, filter: (source) => !generated.has(source) });

  const androidSdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!androidSdk || !existsSync(androidSdk)) {
    throw new Error('ANDROID_HOME or ANDROID_SDK_ROOT must be set to a valid directory');
  }

  const localProperties = `sdk.dir=${androidSdk.replace(/\\/g, '/')}\n`;
  await writeFile(join(targetDir, 'local.properties'), localProperties, 'utf8');
  await writeFile(join(targetDir, 'included', 'local.properties'), localProperties, 'utf8');

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
  await writeFile(join(targetDir, 'included', 'gradle.properties'), gradleProps, 'utf8');

  await copyCachedDependencies(sandbox);

  const wrapperJarSrc = resolve(
    'test-fixtures',
    'android-attach',
    'gradle',
    'wrapper',
    'gradle-wrapper.jar',
  );
  for (const wrapperDir of [
    join(targetDir, 'gradle', 'wrapper'),
    join(targetDir, 'included', 'gradle', 'wrapper'),
  ]) {
    await mkdir(wrapperDir, { recursive: true });
    await cp(wrapperJarSrc, join(wrapperDir, 'gradle-wrapper.jar'));
  }

  const apkPath = join(targetDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  const releaseApkPath = join(
    targetDir,
    'app',
    'build',
    'outputs',
    'apk',
    'release',
    'app-release.apk',
  );
  const includedDir = join(targetDir, 'included');
  const includedApkPath = join(
    includedDir,
    'app',
    'build',
    'outputs',
    'apk',
    'debug',
    'app-debug.apk',
  );
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
  const processActivityPath = join(
    targetDir,
    'app',
    'src',
    'main',
    'java',
    'com',
    'example',
    'ompattachfixture',
    'ProcessActivity.java',
  );
  const libHelperPath = join(
    targetDir,
    'lib',
    'src',
    'main',
    'java',
    'com',
    'example',
    'ompattachfixture',
    'lib',
    'LibHelper.java',
  );
  const includedMainActivityPath = join(
    includedDir,
    'app',
    'src',
    'main',
    'java',
    'com',
    'example',
    'ompattachincluded',
    'MainActivity.java',
  );

  await seedSandboxProjectConfig(targetDir, sandbox);
  return {
    targetDir,
    apkPath,
    releaseApkPath,
    includedDir,
    includedApkPath,
    mainActivityPath,
    processActivityPath,
    libHelperPath,
    includedMainActivityPath,
  };
}

async function captureDebugArtifacts(
  targetDir: string,
  sandbox: IntegrationSandbox,
  apkPath: string,
): Promise<void> {
  assert.ok(existsSync(apkPath), `Built APK not found at ${apkPath}`);
  realBuilds.push({ sandboxDir: sandbox.sandboxDir, status: 0 });
  await artifactStore.capture(APK_ARTIFACT, apkPath);
  const generatedPath = await findFileRecursive(
    join(targetDir, 'app', 'build', 'generated'),
    'GeneratedCounter.java',
  );
  if (generatedPath) {
    generatedCounterRelPath = relative(targetDir, generatedPath);
    await artifactStore.capture(GENERATED_COUNTER_ARTIFACT, generatedPath);
  }
}

async function materializeGeneratedCounterIfAvailable(targetDir: string): Promise<string | undefined> {
  if (!generatedCounterRelPath) return undefined;
  const destination = join(targetDir, generatedCounterRelPath);
  const ok = await artifactStore.materialize(GENERATED_COUNTER_ARTIFACT, destination);
  return ok ? destination : undefined;
}

async function reportNativeLogs(native: NativeAndroidClient): Promise<void> {
  for (const directory of [native.runtimeDirectory, join(native.runtimeDirectory, 'log')]) {
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.log')) {
          const content = await readFile(join(directory, entry.name), 'utf8');
          console.error(`[native ${entry.name}]\n${content.slice(-32768)}`);
        }
      }
    } catch (logError) {
      console.error(`[native logs] ${String(logError)}`);
    }
  }
}

async function ensureApkBuilt(
  targetDir: string,
  sandbox: IntegrationSandbox,
  apkPath: string,
): Promise<string> {
  if (await artifactStore.materialize(APK_ARTIFACT, apkPath)) {
    await materializeGeneratedCounterIfAvailable(targetDir);
    console.error(`[integration ${sandbox.sandboxDir}] apk-cache: hit`);
    return apkPath;
  }

  const started = performance.now();
  console.error(`[integration ${sandbox.sandboxDir}] apk-build (native DAP gradle launch): start`);
  const native = await startNativeClient(targetDir, sandbox);
  let dap: NativePeer | undefined;
  try {
    const launched = await launchNativeAndroidDap(native, {
      clientID: 'native-android-apk-producer',
      noDebug: true,
      android: {
        deviceId,
        target: { kind: 'gradle', module: ':app', variant: 'debug', build: true },
        restartApp: true,
      },
    });
    dap = launched.dap;
    const discResp = await dap.request('disconnect', { terminateDebuggee: true });
    assert.equal(discResp.success, true, JSON.stringify(discResp));
    await dap.waitFor(
      (message) => message.type === 'event' && message.event === 'terminated',
      0,
      15000,
    );
    await captureDebugArtifacts(targetDir, sandbox, apkPath);
    console.error(
      `[integration ${sandbox.sandboxDir}] apk-build (native DAP gradle launch): ok ${Math.round(performance.now() - started)}ms`,
    );
    return apkPath;
  } catch (error) {
    realBuilds.push({ sandboxDir: sandbox.sandboxDir, status: 1 });
    await reportNativeLogs(native);
    throw error;
  } finally {
    if (dap) await closeNativePeerAndWait(dap);
    await native.close();
    stopFixture(deviceId);
  }
}

async function waitForFileOnDisk(filePath: string, timeoutMs = 60000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const content = (await readFile(filePath, 'utf8')).trim();
      if (content.length > 0) return content;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for gate file ${filePath}`);
}

async function waitForProcessDead(pid: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await sleep(100);
  }
  assert.equal(isProcessAlive(pid), false, `Expected process ${pid} to terminate`);
}

function appendBuildGateHook(
  originalContent: string,
  daemonPidFile: string,
  gateStartedFile: string,
  gateReleaseFile: string,
  gateCompletedFile: string,
): string {
  const norm = (value: string) => value.replace(/\\/g, '/');
  return [
    originalContent,
    '',
    'val ompGateTask = tasks.register("ompBuildGate", org.gradle.api.tasks.Exec::class.java) {',
    '    doFirst {',
    `        file(${JSON.stringify(norm(daemonPidFile))}).writeText(ProcessHandle.current().pid().toString())`,
    '    }',
    '    commandLine(',
    `        ${JSON.stringify(norm(process.execPath))},`,
    '        "-e",',
    '        "const fs=require(\'fs\');fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{if(fs.existsSync(process.argv[2])){fs.writeFileSync(process.argv[3],\'completed\');process.exit(0);}},50);",',
    `        ${JSON.stringify(norm(gateStartedFile))},`,
    `        ${JSON.stringify(norm(gateReleaseFile))},`,
    `        ${JSON.stringify(norm(gateCompletedFile))},`,
    '    )',
    '}',
    // Native ILS imports also execute preDebugBuild without an assemble request.
    'if (gradle.startParameter.taskNames.contains(":app:assembleDebug")) {',
    '    tasks.matching { it.name == "preDebugBuild" }.configureEach {',
    '        dependsOn(ompGateTask)',
    '    }',
    '}',
    '',
  ].join('\n');
}

async function waitForStartupProgressEnd(dap: NativePeer): Promise<void> {
  await dap.waitFor(
    (message) =>
      message.type === 'event' &&
      message.event === 'progressEnd' &&
      asRecord(message.body).progressId === 'org.intellij.android.launch',
  );
}

test('native Android DAP without OMP: Gradle launch builds once, targets query, build=false, and owned stop vs keep', async () => {
  assert.ok(isDeviceOnline(deviceId));
  const sandbox = await createIntegrationSandbox(prerequisites);
  let native: NativeAndroidClient | undefined;

  try {
    const { targetDir, apkPath, mainActivityPath } = await copyAndroidAttachFixture(sandbox);
    stopFixture(deviceId);
    native = await startNativeClient(targetDir, sandbox);

    const targetsResult = (await native.lsp.lspRequest('workspace/executeCommand', {
      command: 'org.intellij.android.run.targets',
      arguments: [{}],
    })) as TargetsResponse;

    const matchedDevice = targetsResult.devices.find((d) => d.deviceId === deviceId);
    assert.ok(matchedDevice, `targets must include ${deviceId}: ${JSON.stringify(targetsResult)}`);
    assert.equal(matchedDevice.state, 'online');
    assert.ok(matchedDevice.abis.length > 0, 'Device ABIs must be populated');

    const rootAppModule = targetsResult.modules.find(
      (m) =>
        m.module === ':app' &&
        normalizePathForCompare(m.buildRoot) === normalizePathForCompare(targetDir),
    );
    assert.ok(rootAppModule, `targets must include root :app: ${JSON.stringify(targetsResult)}`);
    const debugVariant = rootAppModule.variants.find((v) => v.name === 'debug');
    assert.ok(debugVariant, 'Debug variant must be present in targets');
    assert.equal(debugVariant.assembleTask, ':app:assembleDebug');
    assert.ok(debugVariant.listingFile && debugVariant.listingFile.length > 0);
    assert.ok(rootAppModule.variants.some((v) => v.name === 'release'));
    assert.ok(
      Array.isArray(targetsResult.includedBuilds) &&
        targetsResult.includedBuilds.some(
          (p) => normalizePathForCompare(p) === normalizePathForCompare(join(targetDir, 'included')),
        ),
      `targets must include includedBuilds: ${JSON.stringify(targetsResult)}`,
    );
    assert.equal(existsSync(apkPath), false, 'targets query must not build APK');

    await assert.rejects(
      native.lsp.lspRequest('workspace/executeCommand', {
        command: 'org.intellij.android.run.targets',
        arguments: [{ deviceId: 'omp-absent-target-device' }],
      }),
      /\[device_offline\]/,
    );

    const noBuildDap = await native.connectDap();
    try {
      const initResp = await noBuildDap.request('initialize', {
        clientID: 'neutral-gradle-nobuild-before',
        adapterID: 'android',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsProgressReporting: true,
      });
      assert.equal(initResp.success, true);
      const failResp = await noBuildDap.request('launch', {
        android: {
          deviceId,
          target: { kind: 'gradle', module: ':app', variant: 'debug', build: false },
        },
      });
      assert.equal(failResp.success, false, JSON.stringify(failResp));
      assert.match(failResp.message ?? '', /^\[artifact_invalid\]/);
      await noBuildDap.request('disconnect', { terminateDebuggee: false });
    } finally {
      await closeNativePeerAndWait(noBuildDap);
    }

    const forwardBefore = getAdbForwardList(deviceId);
    const breakLine = findSourceLine(mainActivityPath, 'counter = after;');
    const { dap } = await launchNativeAndroidDap(native, {
      clientID: 'neutral-gradle-launch-client',
      android: {
        deviceId,
        target: { kind: 'gradle', module: ':app', variant: 'debug', build: true },
        restartApp: true,
      },
      breakpoints: [{ path: mainActivityPath, lines: [breakLine] }],
    });
    try {
      await captureDebugArtifacts(targetDir, sandbox, apkPath);
      await waitForStartupProgressEnd(dap);
      const initializedCount = dap.messages.filter(
        (m) => m.type === 'event' && m.event === 'initialized',
      ).length;
      assert.equal(initializedCount, 1, 'initialized must be emitted exactly once');

      const progressStarts = dap.messages.filter(
        (m) => m.type === 'event' && m.event === 'progressStart',
      );
      const progressUpdates = dap.messages
        .filter((m) => m.type === 'event' && m.event === 'progressUpdate')
        .map((m) => String(asRecord(m.body).message ?? ''));
      const progressEnds = dap.messages.filter(
        (m) => m.type === 'event' && m.event === 'progressEnd',
      );
      assert.equal(progressStarts.length, 1);
      assert.equal(progressEnds.length, 1);
      for (const stage of ['building', 'installing', 'starting', 'attaching']) {
        assert.ok(progressUpdates.includes(stage), `Expected stage ${stage} in ${progressUpdates}`);
      }

      const processEvent = await dap.waitFor(
        (m) => m.type === 'event' && m.event === 'process',
        0,
        15000,
      );
      assert.equal(asRecord(processEvent.body).isLocalProcess, false);
      assert.equal(asRecord(processEvent.body).name, TEST_PACKAGE);

      await verifyTickBreakpointAndStep(dap, 0, 'counter');

      const discResp = await dap.request('disconnect', {});
      assert.equal(discResp.success, true, JSON.stringify(discResp));
      await dap.waitFor(
        (message) => message.type === 'event' && message.event === 'terminated',
        0,
        15000,
      );
      assert.equal(
        dap.messages.filter((m) => m.type === 'event' && m.event === 'terminated').length,
        1,
      );
    } finally {
      await closeNativePeerAndWait(dap);
    }

    await waitForProcessGone(deviceId, TEST_PACKAGE);
    assert.equal(getAdbForwardList(deviceId), forwardBefore);

    const { dap: buildFalseDap } = await launchNativeAndroidDap(native, {
      clientID: 'neutral-gradle-build-false',
      android: {
        deviceId,
        target: { kind: 'gradle', module: ':app', variant: 'debug', build: false },
      },
      breakpoints: [{ path: mainActivityPath, lines: [breakLine] }],
    });
    let keptPid: number;
    try {
      await verifyTickBreakpointAndStep(buildFalseDap, 0, 'counter');
      keptPid = await getFixturePid(deviceId);
      const keepResp = await buildFalseDap.request('disconnect', { terminateDebuggee: false });
      assert.equal(keepResp.success, true, JSON.stringify(keepResp));
      await buildFalseDap.waitFor(
        (message) => message.type === 'event' && message.event === 'terminated',
        0,
        15000,
      );
    } finally {
      await closeNativePeerAndWait(buildFalseDap);
    }

    assert.equal(await getFixturePid(deviceId), keptPid, 'terminateDebuggee=false must keep PID');
    const { dap: reattachDap } = await attachNativeAndroidDap(native, {
      clientID: 'neutral-gradle-reattach',
      deviceId,
      pid: keptPid,
    });
    try {
      const disc = await reattachDap.request('disconnect', { terminateDebuggee: false });
      assert.equal(disc.success, true, JSON.stringify(disc));
    } finally {
      await closeNativePeerAndWait(reattachDap);
    }
    assert.equal(getAdbForwardList(deviceId), forwardBefore);
  } finally {
    await native?.close();
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('native Android DAP without OMP: Scenario 1: normal launch -> startServer -> standard DAP attach -> tick breakpoint -> frame variables (after = before + 1) -> step counter -> detach (original PID survives, terminateDebuggee=true rejected) -> re-attach & adb forward unchanged [smoke]', async () => {
  assert.ok(
    isDeviceOnline(deviceId),
    `Android device ${deviceId} must remain online during acceptance`,
  );
  const sandbox = await createIntegrationSandbox(prerequisites);
  let native: NativeAndroidClient | undefined;

  try {
    const { targetDir, apkPath, mainActivityPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);

    installFixture(deviceId, apkPath);

    const forwardBefore = getAdbForwardList(deviceId);

    stopFixture(deviceId);
    startFixture(deviceId, false);
    const originalPid = await getFixturePid(deviceId);
    assert.ok(originalPid > 0, 'Original PID must be a positive integer');

    native = await startNativeClient(targetDir, sandbox);
    const breakLine = findSourceLine(mainActivityPath, 'counter = after;');
    const { dap } = await attachNativeAndroidDap(native, {
      clientID: 'native-android-scenario-1',
      deviceId,
      breakpointFile: mainActivityPath,
      breakpointLine: breakLine,
    });

    try {
      const forwardAfterAttach = getAdbForwardList(deviceId);
      assert.equal(
        forwardAfterAttach,
        forwardBefore,
        'adb forward --list must remain unchanged after attach (no forward leaks)',
      );

      const stopped = await dap.waitFor(
        (message) => message.type === 'event' && message.event === 'stopped',
        0,
        30000,
      );
      const stoppedBody = parseStoppedBody(stopped.body);
      assert.equal(stoppedBody.reason, 'breakpoint', 'Should stop at breakpoint');
      assert.ok(stoppedBody.threadId !== undefined, 'Stopped event must contain threadId');
      const threadId = stoppedBody.threadId;

      const stackResp = await dap.request('stackTrace', { threadId });
      assert.equal(stackResp.success, true, JSON.stringify(stackResp));
      const stackBody = parseStackTraceResponse(stackResp.body);
      assert.ok(
        stackBody.stackFrames && stackBody.stackFrames.length > 0,
        'Stack trace must return frames',
      );
      const frameId = stackBody.stackFrames[0].id;

      const scopesResp = await dap.request('scopes', { frameId });
      assert.equal(scopesResp.success, true, JSON.stringify(scopesResp));
      const scopesBody = parseScopesResponse(scopesResp.body);
      assert.ok(scopesBody.scopes && scopesBody.scopes.length > 0, 'Scopes must return scopes list');
      const localScope =
        scopesBody.scopes.find((s) => s.name.toLowerCase().includes('local')) ??
        scopesBody.scopes[0];

      const varsResp = await dap.request('variables', {
        variablesReference: localScope.variablesReference,
      });
      assert.equal(varsResp.success, true, JSON.stringify(varsResp));
      const varsBody = parseVariablesResponse(varsResp.body);
      assert.ok(varsBody.variables, 'Variables response must contain variables array');

      const beforeVar = varsBody.variables.find((v) => v.name === 'before');
      const afterVar = varsBody.variables.find((v) => v.name === 'after');
      assert.ok(beforeVar, 'Variables must include "before"');
      assert.ok(afterVar, 'Variables must include "after"');

      const beforeNum = Number.parseInt(beforeVar.value, 10);
      const afterNum = Number.parseInt(afterVar.value, 10);
      assert.equal(
        afterNum,
        beforeNum + 1,
        `Expected after (${afterNum}) to equal before + 1 (${beforeNum + 1})`,
      );

      const thisVar = varsBody.variables.find((variable) => variable.name === 'this');
      assert.ok(thisVar && thisVar.variablesReference > 0, 'Activity object must be expandable');
      const fieldsResp = await dap.request('variables', {
        variablesReference: thisVar.variablesReference,
      });
      assert.equal(fieldsResp.success, true, JSON.stringify(fieldsResp));
      const fields = parseVariablesResponse(fieldsResp.body).variables;
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

      const afterNextIndex = dap.messages.length;
      const nextResp = await dap.request('next', { threadId });
      assert.equal(nextResp.success, true, JSON.stringify(nextResp));
      const stepStopped = await dap.waitFor(
        (message) => message.type === 'event' && message.event === 'stopped',
        afterNextIndex,
        15000,
      );
      const stepThread = parseStoppedBody(stepStopped.body).threadId;
      assert.ok(stepThread !== undefined);
      const stepStackResp = await dap.request('stackTrace', { threadId: stepThread });
      assert.equal(stepStackResp.success, true, JSON.stringify(stepStackResp));
      const stepStack = parseStackTraceResponse(stepStackResp.body);
      assert.ok(stepStack.stackFrames?.[0]);
      const counterEval = await evaluateNative(dap, 'counter', stepStack.stackFrames[0].id);
      assert.equal(
        Number(counterEval),
        afterNum,
        'Field counter must be updated to after value after step execution',
      );

      const disconnectResp = await dap.request('disconnect', { terminateDebuggee: false });
      assert.equal(disconnectResp.success, true, JSON.stringify(disconnectResp));
      await dap.waitFor(
        (message) => message.type === 'event' && message.event === 'terminated',
        0,
        15000,
      );
    } finally {
      await closeNativePeerAndWait(dap);
    }

    const pidAfter = await getFixturePid(deviceId);
    assert.equal(pidAfter, originalPid, 'Original target PID must survive after DAP disconnect');

    const { dap: reattachDap } = await attachNativeAndroidDap(native, {
      clientID: 'native-android-scenario-1-reattach',
      deviceId,
      pid: originalPid,
    });
    try {
      const rejectTerminate = await reattachDap.request('disconnect', { terminateDebuggee: true });
      assert.equal(rejectTerminate.success, false, JSON.stringify(rejectTerminate));
      assert.match(
        rejectTerminate.message ?? '',
        /^\[invalid_params\].*terminateDebuggee=true is not permitted for external attach/,
      );
      await reattachDap.waitFor(
        (message) => message.type === 'event' && message.event === 'terminated',
        0,
        15000,
      );
    } finally {
      await closeNativePeerAndWait(reattachDap);
    }

    const pidAfterRejectedTerminate = await getFixturePid(deviceId);
    assert.equal(
      pidAfterRejectedTerminate,
      originalPid,
      'External attach must keep target process alive even when terminateDebuggee=true is rejected',
    );

    const forwardFinal = getAdbForwardList(deviceId);
    assert.equal(
      forwardFinal,
      forwardBefore,
      'adb forward --list must be completely unchanged throughout',
    );
  } catch (error) {
    if (native) await reportNativeLogs(native);
    throw error;
  } finally {
    await native?.close();
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('native Android DAP without OMP: Scenario 2: am start -D (Waiting for Debugger) -> standard DAP attach -> dismiss waiting dialog -> tick breakpoint hit -> frame variables -> step -> detach', async () => {
  assert.ok(
    isDeviceOnline(deviceId),
    `Android device ${deviceId} must remain online during acceptance`,
  );
  const sandbox = await createIntegrationSandbox(prerequisites);
  let native: NativeAndroidClient | undefined;

  try {
    const { targetDir, apkPath, mainActivityPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);

    installFixture(deviceId, apkPath);

    stopFixture(deviceId);
    startFixture(deviceId, true);
    const originalPid = await getFixturePid(deviceId);
    assert.ok(originalPid > 0, 'Original PID must be a positive integer');

    native = await startNativeClient(targetDir, sandbox);
    const breakLine = findSourceLine(mainActivityPath, 'counter = after;');
    const { dap } = await attachNativeAndroidDap(native, {
      clientID: 'native-android-scenario-2',
      deviceId,
      breakpointFile: mainActivityPath,
      breakpointLine: breakLine,
    });

    try {
      await verifyTickBreakpointAndStep(dap, 0, 'counter');

      const disconnectResp = await dap.request('disconnect', { terminateDebuggee: false });
      assert.equal(disconnectResp.success, true, JSON.stringify(disconnectResp));
      await dap.waitFor(
        (message) => message.type === 'event' && message.event === 'terminated',
        0,
        15000,
      );
    } finally {
      await closeNativePeerAndWait(dap);
    }

    const pidAfter = await getFixturePid(deviceId);
    assert.equal(pidAfter, originalPid, 'Target PID must survive after disconnect');
  } finally {
    await native?.close();
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('native Android DAP without OMP: Scenario 3: abrupt DAP socket EOF -> auto JDWP recovery -> sibling project unaffected -> re-attach succeeds', async () => {
  assert.ok(
    isDeviceOnline(deviceId),
    `Android device ${deviceId} must remain online during acceptance`,
  );
  const sandbox = await createIntegrationSandbox(prerequisites);
  let native: NativeAndroidClient | undefined;
  let siblingNative: NativeAndroidClient | undefined;

  try {
    const { targetDir, apkPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);

    installFixture(deviceId, apkPath);

    stopFixture(deviceId);
    startFixture(deviceId, false);
    const originalPid = await getFixturePid(deviceId);

    native = await startNativeClient(targetDir, sandbox);
    const jdk21Dir = await copyWorkspaceFixture('jdk21', sandbox);
    siblingNative = await startNativeClient(jdk21Dir, sandbox);

    const { dap } = await attachNativeAndroidDap(native, {
      clientID: 'native-android-scenario-3',
      deviceId,
    });

    await closeNativePeerAndWait(dap);
    await sleep(500);

    const { dap: recoveredDap } = await attachNativeAndroidDap(native, {
      clientID: 'native-android-scenario-3-recovered',
      deviceId,
      pid: originalPid,
    });
    try {
      const disconnectResp = await recoveredDap.request('disconnect', {
        terminateDebuggee: false,
      });
      assert.equal(disconnectResp.success, true, JSON.stringify(disconnectResp));
      await recoveredDap.waitFor(
        (message) => message.type === 'event' && message.event === 'terminated',
        0,
        15000,
      );
    } finally {
      await closeNativePeerAndWait(recoveredDap);
    }

    const symResult = await siblingNative.lsp.lspRequest('workspace/symbol', { query: 'App' });
    assert.ok(Array.isArray(symResult), 'Sibling LSP session must remain fully operational');
  } finally {
    await siblingNative?.close();
    await native?.close();
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('native Android DAP without OMP: Scenario 4: target process exit on device -> emits terminated without fake exited(0) -> re-launch attach succeeds', async () => {
  assert.ok(
    isDeviceOnline(deviceId),
    `Android device ${deviceId} must remain online during acceptance`,
  );
  const sandbox = await createIntegrationSandbox(prerequisites);
  let native: NativeAndroidClient | undefined;

  try {
    const { targetDir, apkPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);

    installFixture(deviceId, apkPath);

    stopFixture(deviceId);
    startFixture(deviceId, false);
    await getFixturePid(deviceId);

    native = await startNativeClient(targetDir, sandbox);
    const { dap } = await attachNativeAndroidDap(native, {
      clientID: 'native-android-scenario-4',
      deviceId,
    });

    try {
      stopFixture(deviceId);

      await dap.waitFor(
        (message) => message.type === 'event' && message.event === 'terminated',
        0,
        15000,
      );
      const fabricatedExit = dap.messages.some(
        (message) =>
          message.type === 'event' &&
          message.event === 'exited' &&
          message.body?.exitCode === 0,
      );
      assert.equal(fabricatedExit, false, 'Unknown target exit must not fabricate exited(0)');
    } finally {
      await closeNativePeerAndWait(dap);
    }

    startFixture(deviceId, false);
    const relaunchedPid = await getFixturePid(deviceId);
    const { dap: reattachDap } = await attachNativeAndroidDap(native, {
      clientID: 'native-android-scenario-4-reattach',
      deviceId,
      pid: relaunchedPid,
    });
    try {
      const disconnectResp = await reattachDap.request('disconnect', {
        terminateDebuggee: false,
      });
      assert.equal(disconnectResp.success, true, JSON.stringify(disconnectResp));
    } finally {
      await closeNativePeerAndWait(reattachDap);
    }
  } finally {
    await native?.close();
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('native Android DAP without OMP: Scenario 5: startServer bootstrap validation, initialize and disconnect without attach, terminate unsupported, and subsequent attach succeeds', async () => {
  assert.ok(
    isDeviceOnline(deviceId),
    `Android device ${deviceId} must remain online during acceptance`,
  );
  const sandbox = await createIntegrationSandbox(prerequisites);
  let native: NativeAndroidClient | undefined;

  try {
    const { targetDir, apkPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);

    installFixture(deviceId, apkPath);

    stopFixture(deviceId);
    startFixture(deviceId, false);
    const originalPid = await getFixturePid(deviceId);

    native = await startNativeClient(targetDir, sandbox);

    for (const bootstrap of [{ nativePort: 1234 }, { host: '127.0.0.1' }, { unknown: true }]) {
      await assert.rejects(native.connectDap(bootstrap));
    }

    const dap = await native.connectDap();
    try {
      const initResp = await dap.request('initialize', {
        clientID: 'native-android-scenario-5',
        adapterID: 'android',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsProgressReporting: true,
      });
      assert.equal(initResp.success, true, JSON.stringify(initResp));

      const terminateResp = await dap.request('terminate', {});
      assert.equal(terminateResp.success, false, JSON.stringify(terminateResp));

      const disconnectResp = await dap.request('disconnect', { terminateDebuggee: false });
      assert.equal(disconnectResp.success, true, JSON.stringify(disconnectResp));
    } finally {
      await closeNativePeerAndWait(dap);
    }

    const { dap: followUpDap } = await attachNativeAndroidDap(native, {
      clientID: 'native-android-scenario-5-followup',
      deviceId,
      pid: originalPid,
    });
    try {
      const disconnectResp = await followUpDap.request('disconnect', {
        terminateDebuggee: false,
      });
      assert.equal(disconnectResp.success, true, JSON.stringify(disconnectResp));
    } finally {
      await closeNativePeerAndWait(followUpDap);
    }
  } finally {
    await native?.close();
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('native Android DAP without OMP: Scenario 6: offline device prerequisite and cancelling pending DAP attach preserve subsequent device use', async () => {
  assert.ok(
    isDeviceOnline(deviceId),
    `Android device ${deviceId} must remain online during acceptance`,
  );
  const sandbox = await createIntegrationSandbox(prerequisites);
  let native: NativeAndroidClient | undefined;

  try {
    const { targetDir, apkPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);
    installFixture(deviceId, apkPath);
    stopFixture(deviceId);
    startFixture(deviceId);
    const pid = await getFixturePid(deviceId);
    const forwards = getAdbForwardList(deviceId);

    native = await startNativeClient(targetDir, sandbox);

    const offlineDap = await native.connectDap();
    try {
      const initResp = await offlineDap.request('initialize', {
        clientID: 'native-android-scenario-6-offline',
        adapterID: 'android',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsProgressReporting: true,
      });
      assert.equal(initResp.success, true, JSON.stringify(initResp));
      const offlineResp = await offlineDap.request('attach', {
        android: { deviceId: 'omp-attach-cancel-absent', packageName: TEST_PACKAGE },
      });
      assert.equal(offlineResp.success, false, JSON.stringify(offlineResp));
      assert.match(offlineResp.message ?? '', /^\[device_offline\]/);
      const discResp = await offlineDap.request('disconnect', { terminateDebuggee: false });
      assert.equal(discResp.success, true, JSON.stringify(discResp));
    } finally {
      await closeNativePeerAndWait(offlineDap);
    }

    const cancelDap = await native.connectDap();
    try {
      const initResp = await cancelDap.request('initialize', {
        clientID: 'native-android-scenario-6-cancel',
        adapterID: 'android',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsProgressReporting: true,
      });
      assert.equal(initResp.success, true, JSON.stringify(initResp));

      const attachReq = cancelDap.sendRequest('attach', {
        android: { deviceId, packageName: TEST_PACKAGE, pid },
      });
      const initializedPromise = cancelDap.waitFor(
        (message) => message.type === 'event' && message.event === 'initialized',
        0,
        120000,
      );
      const earlyOrInit = await Promise.race([
        initializedPromise.then(() => 'initialized' as const),
        attachReq.response.then((resp) => ({ kind: 'early-response' as const, resp })),
      ]);
      if (earlyOrInit !== 'initialized') {
        assert.fail(
          `attach completed before initialized event: ${JSON.stringify(earlyOrInit.resp)}`,
        );
      }

      const cancelResp = await cancelDap.request('cancel', { requestId: attachReq.id });
      assert.equal(cancelResp.success, true, JSON.stringify(cancelResp));

      const attachResp = await attachReq.response;
      assert.equal(attachResp.success, false, JSON.stringify(attachResp));
      assert.match(attachResp.message ?? '', /^\[cancelled\]/);

      const progressStarts = cancelDap.messages.filter(
        (message) => message.type === 'event' && message.event === 'progressStart',
      ).length;
      if (progressStarts > 0) {
        await waitForStartupProgressEnd(cancelDap);
      }
      const progressEnds = cancelDap.messages.filter(
        (message) => message.type === 'event' && message.event === 'progressEnd',
      ).length;
      assert.ok(progressEnds <= 1, `Expected at most 1 progressEnd event, got ${progressEnds}`);
      if (progressStarts > 0) {
        assert.equal(progressEnds, 1, 'Started progress must emit exactly one progressEnd');
      }

      const discResp = await cancelDap.request('disconnect', { terminateDebuggee: false });
      assert.equal(discResp.success, true, JSON.stringify(discResp));
    } finally {
      await closeNativePeerAndWait(cancelDap);
    }

    const { dap: followUpDap } = await attachNativeAndroidDap(native, {
      clientID: 'native-android-scenario-6-followup',
      deviceId,
      pid,
    });
    try {
      const discResp = await followUpDap.request('disconnect', { terminateDebuggee: false });
      assert.equal(discResp.success, true, JSON.stringify(discResp));
    } finally {
      await closeNativePeerAndWait(followUpDap);
    }

    assert.equal(await getFixturePid(deviceId), pid);
    assert.equal(getAdbForwardList(deviceId), forwards);
  } finally {
    await native?.close();
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('native Android DAP without OMP: apks, installed, artifact validation, restartApp=false target_running vs restartApp=true', async () => {
  assert.ok(isDeviceOnline(deviceId));
  const sandbox = await createIntegrationSandbox(prerequisites);
  let native: NativeAndroidClient | undefined;

  try {
    const { targetDir, apkPath, mainActivityPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);
    stopFixture(deviceId);

    native = await startNativeClient(targetDir, sandbox);

    const aabPath = join(sandbox.sandboxDir, 'fake.aab');
    const otherApkPath = join(sandbox.sandboxDir, 'other.apk');
    await writeFile(aabPath, 'not-an-aab', 'utf8');
    await writeFile(otherApkPath, 'not-an-apk', 'utf8');

    for (const invalidCase of [
      {
        body: { android: { deviceId, target: { kind: 'apks', files: [aabPath] } } },
        pattern: /^\[unsupported_artifact\]/,
      },
      {
        body: {
          android: {
            deviceId,
            target: { kind: 'apks', files: [join(sandbox.sandboxDir, 'missing.apk')] },
          },
        },
        pattern: /^\[artifact_invalid\]/,
      },
      {
        body: {
          program: otherApkPath,
          android: { deviceId, target: { kind: 'apks', files: [apkPath] } },
        },
        pattern: /^\[invalid_params\]/,
      },
      {
        body: { android: { deviceId, target: { kind: 'apks' } } },
        pattern: /^\[invalid_params\]/,
      },
    ]) {
      const badDap = await native.connectDap();
      try {
        await badDap.request('initialize', {
          clientID: 'android-invalid-artifact',
          adapterID: 'android',
          linesStartAt1: true,
          columnsStartAt1: true,
          pathFormat: 'path',
        });
        const resp = await badDap.request('launch', invalidCase.body);
        assert.equal(resp.success, false, JSON.stringify(resp));
        assert.match(resp.message ?? '', invalidCase.pattern);
        await badDap.request('disconnect', { terminateDebuggee: false });
      } finally {
        await closeNativePeerAndWait(badDap);
      }
    }

    const breakLine = findSourceLine(mainActivityPath, 'counter = after;');
    const { dap: apksProgramDap } = await launchNativeAndroidDap(native, {
      clientID: 'android-apks-program',
      program: apkPath,
      android: {
        deviceId,
        target: { kind: 'apks' },
      },
      breakpoints: [{ path: mainActivityPath, lines: [breakLine] }],
    });
    let firstPid: number;
    try {
      await verifyTickBreakpointAndStep(apksProgramDap, 0, 'counter');
      firstPid = await getFixturePid(deviceId);
      const disc = await apksProgramDap.request('disconnect', { terminateDebuggee: false });
      assert.equal(disc.success, true, JSON.stringify(disc));
      await apksProgramDap.waitFor((m) => m.type === 'event' && m.event === 'terminated', 0, 15000);
    } finally {
      await closeNativePeerAndWait(apksProgramDap);
    }
    assert.equal(await getFixturePid(deviceId), firstPid);

    const runningDap = await native.connectDap();
    try {
      await runningDap.request('initialize', {
        clientID: 'android-target-running',
        adapterID: 'android',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
      });
      const resp = await runningDap.request('launch', {
        android: {
          deviceId,
          target: { kind: 'apks', files: [apkPath] },
          restartApp: false,
        },
      });
      assert.equal(resp.success, false, JSON.stringify(resp));
      assert.match(resp.message ?? '', /^\[target_running\]/);
      await runningDap.request('disconnect', { terminateDebuggee: false });
    } finally {
      await closeNativePeerAndWait(runningDap);
    }
    assert.equal(await getFixturePid(deviceId), firstPid, 'target_running must preserve PID');

    const { dap: restartDap } = await launchNativeAndroidDap(native, {
      clientID: 'android-restart-true',
      android: {
        deviceId,
        target: { kind: 'apks', files: [apkPath] },
        restartApp: true,
      },
      breakpoints: [{ path: mainActivityPath, lines: [breakLine] }],
    });
    try {
      await verifyTickBreakpointAndStep(restartDap, 0, 'counter');
      const restartedPid = await getFixturePid(deviceId);
      assert.notEqual(restartedPid, firstPid, 'restartApp=true must start a new process PID');
      const disc = await restartDap.request('disconnect', {});
      assert.equal(disc.success, true, JSON.stringify(disc));
      await restartDap.waitFor((m) => m.type === 'event' && m.event === 'terminated', 0, 15000);
    } finally {
      await closeNativePeerAndWait(restartDap);
    }
    await waitForProcessGone(deviceId, TEST_PACKAGE);

    const userId = getCurrentUserId(deviceId);
    const { dap: installedDap } = await launchNativeAndroidDap(native, {
      clientID: 'android-installed-launch',
      android: {
        deviceId,
        userId,
        target: { kind: 'installed', packageName: TEST_PACKAGE },
      },
      breakpoints: [{ path: mainActivityPath, lines: [breakLine] }],
    });
    try {
      await verifyTickBreakpointAndStep(installedDap, 0, 'counter');
      const disc = await installedDap.request('disconnect', {});
      assert.equal(disc.success, true, JSON.stringify(disc));
      await installedDap.waitFor((m) => m.type === 'event' && m.event === 'terminated', 0, 15000);
    } finally {
      await closeNativePeerAndWait(installedDap);
    }
    await waitForProcessGone(deviceId, TEST_PACKAGE);
  } finally {
    await native?.close();
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('native Android DAP without OMP: noDebug debuggable and non-debuggable release, capability whitelist, and stale identity preserve', async () => {
  assert.ok(isDeviceOnline(deviceId));
  const sandbox = await createIntegrationSandbox(prerequisites);
  let native: NativeAndroidClient | undefined;

  try {
    const { targetDir, apkPath, releaseApkPath, mainActivityPath } =
      await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);
    stopFixture(deviceId);

    native = await startNativeClient(targetDir, sandbox);
    const forwardBefore = getAdbForwardList(deviceId);
    const breakLine = findSourceLine(mainActivityPath, 'counter = after;');

    const noDebugDap = await native.connectDap();
    try {
      const initResp = await noDebugDap.request('initialize', {
        clientID: 'android-nodebug-debuggable',
        adapterID: 'android',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsProgressReporting: true,
      });
      assert.equal(initResp.success, true, JSON.stringify(initResp));

      const launchReq = noDebugDap.sendRequest('launch', {
        noDebug: true,
        android: {
          deviceId,
          target: { kind: 'apks', files: [apkPath] },
        },
      });
      await noDebugDap.waitFor(
        (m) => m.type === 'event' && m.event === 'initialized',
        0,
        120000,
      );
      const bpResp = await noDebugDap.request('setBreakpoints', {
        source: { path: mainActivityPath },
        breakpoints: [{ line: breakLine }],
      });
      assert.equal(bpResp.success, true, JSON.stringify(bpResp));
      const bpEntry = (asRecord(bpResp.body) as SetBreakpointsResponse).breakpoints?.[0];
      assert.equal(bpEntry?.verified, false);
      assert.match(bpEntry?.message ?? '', /noDebug/i);

      const excResp = await noDebugDap.request('setExceptionBreakpoints', { filters: [] });
      assert.equal(excResp.success, true, JSON.stringify(excResp));
      const cfgResp = await noDebugDap.request('configurationDone', {});
      assert.equal(cfgResp.success, true, JSON.stringify(cfgResp));

      const launchResp = await launchReq.response;
      assert.equal(launchResp.success, true, JSON.stringify(launchResp));
      assert.equal(getAdbForwardList(deviceId), forwardBefore, 'noDebug must not prepare JDWP');
      await getFixturePid(deviceId);

      for (const [blockedCmd, args] of [
        ['threads', {}],
        ['stackTrace', { threadId: 1 }],
        ['evaluate', { expression: '1' }],
      ] as const) {
        const blockedResp = await noDebugDap.request(blockedCmd, args);
        assert.equal(blockedResp.success, false, JSON.stringify(blockedResp));
        assert.match(blockedResp.message ?? '', /^\[invalid_params\]/);
      }
      const termResp = await noDebugDap.request('terminate', {});
      assert.equal(termResp.success, false, JSON.stringify(termResp));

      const discResp = await noDebugDap.request('disconnect', {});
      assert.equal(discResp.success, true, JSON.stringify(discResp));
      await noDebugDap.waitFor((m) => m.type === 'event' && m.event === 'terminated', 0, 15000);
    } finally {
      await closeNativePeerAndWait(noDebugDap);
    }
    await waitForProcessGone(deviceId, TEST_PACKAGE);

    const { dap: releaseGradleDap } = await launchNativeAndroidDap(native, {
      clientID: 'android-nodebug-release-build',
      noDebug: true,
      android: {
        deviceId,
        target: { kind: 'gradle', module: ':app', variant: 'release', build: true },
        restartApp: true,
      },
    });
    try {
      assert.ok(existsSync(releaseApkPath), `Release APK must exist at ${releaseApkPath}`);
      const aapt2 = await findAapt2Executable(prerequisites.androidHome);
      if (aapt2) {
        const badging = spawnSync(aapt2, ['dump', 'badging', releaseApkPath], {
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
        });
        assert.equal(badging.status, 0, badging.stderr);
        assert.equal(
          badging.stdout.includes('application-debuggable'),
          false,
          'Release APK must not be debuggable',
        );
        const xmlTree = spawnSync(
          aapt2,
          ['dump', 'xmltree', releaseApkPath, '--file', 'AndroidManifest.xml'],
          { encoding: 'utf8', timeout: 15000, windowsHide: true },
        );
        assert.equal(xmlTree.status, 0, xmlTree.stderr);
        assert.equal(
          xmlTree.stdout.includes('E: profileable'),
          false,
          'Release APK must not declare profileable',
        );
      }

      const firstIdentity = await getAmsProcessIdentity(deviceId, TEST_PACKAGE);
      stopFixture(deviceId);
      await waitForProcessGone(deviceId, TEST_PACKAGE);
      startFixture(deviceId, false);
      const secondIdentity = await getAmsProcessIdentity(deviceId, TEST_PACKAGE);
      assert.notEqual(
        secondIdentity.pid,
        firstIdentity.pid,
        'External restart must create a new PID',
      );
      assert.notEqual(
        secondIdentity.record,
        firstIdentity.record,
        'External restart must create a new AMS ProcessRecord',
      );

      const staleDisc = await releaseGradleDap.request('disconnect', { terminateDebuggee: true });
      assert.equal(staleDisc.success, true, JSON.stringify(staleDisc));
      await releaseGradleDap.waitFor(
        (m) => m.type === 'event' && m.event === 'terminated',
        0,
        15000,
      );
      assert.equal(
        await getFixturePid(deviceId),
        secondIdentity.pid,
        'Stale handle disconnect must preserve externally restarted process',
      );
    } finally {
      await closeNativePeerAndWait(releaseGradleDap);
    }

    stopFixture(deviceId);
    await waitForProcessGone(deviceId, TEST_PACKAGE);

    const notDebuggableDap = await native.connectDap();
    try {
      await notDebuggableDap.request('initialize', {
        clientID: 'android-release-debug-refused',
        adapterID: 'android',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
      });
      const failResp = await notDebuggableDap.request('launch', {
        noDebug: false,
        android: {
          deviceId,
          target: { kind: 'apks', files: [releaseApkPath] },
        },
      });
      assert.equal(failResp.success, false, JSON.stringify(failResp));
      assert.match(failResp.message ?? '', /^\[not_debuggable\]/);
      await notDebuggableDap.request('disconnect', { terminateDebuggee: false });
    } finally {
      await closeNativePeerAndWait(notDebuggableDap);
    }
  } finally {
    await native?.close();
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('native Android DAP without OMP: explicit userId, activity-alias, custom activity process, and ambiguous_process attach', async () => {
  assert.ok(isDeviceOnline(deviceId));
  const sandbox = await createIntegrationSandbox(prerequisites);
  let native: NativeAndroidClient | undefined;

  try {
    const { targetDir, apkPath, mainActivityPath, processActivityPath } =
      await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);
    stopFixture(deviceId);

    native = await startNativeClient(targetDir, sandbox);
    const userId = getCurrentUserId(deviceId);
    const mainBreakLine = findSourceLine(mainActivityPath, 'counter = after;');
    const workerBreakLine = findSourceLine(processActivityPath, 'workerCounter = after;');

    const { dap: aliasDap } = await launchNativeAndroidDap(native, {
      clientID: 'android-alias-main',
      android: {
        deviceId,
        userId,
        activity: '.AliasActivity',
        target: { kind: 'apks', files: [apkPath] },
      },
      breakpoints: [{ path: mainActivityPath, lines: [mainBreakLine] }],
    });
    try {
      const procEvent = await aliasDap.waitFor(
        (m) => m.type === 'event' && m.event === 'process',
        0,
        15000,
      );
      assert.equal(asRecord(procEvent.body).name, TEST_PACKAGE);
      await verifyTickBreakpointAndStep(aliasDap, 0, 'counter');
      const disc = await aliasDap.request('disconnect', { terminateDebuggee: false });
      assert.equal(disc.success, true, JSON.stringify(disc));
      await aliasDap.waitFor((m) => m.type === 'event' && m.event === 'terminated', 0, 15000);
    } finally {
      await closeNativePeerAndWait(aliasDap);
    }
    const mainPid = await getFixturePid(deviceId);

    const { dap: workerAliasDap } = await launchNativeAndroidDap(native, {
      clientID: 'android-worker-alias',
      android: {
        deviceId,
        userId,
        activity: '.WorkerAliasActivity',
        restartApp: true,
        target: { kind: 'installed', packageName: TEST_PACKAGE },
      },
      breakpoints: [{ path: processActivityPath, lines: [workerBreakLine] }],
    });
    try {
      const procEvent = await workerAliasDap.waitFor(
        (m) => m.type === 'event' && m.event === 'process',
        0,
        15000,
      );
      assert.equal(asRecord(procEvent.body).name, TEST_WORKER_PROCESS);
      await verifyTickBreakpointAndStep(workerAliasDap, 0, 'workerCounter');
      const disc = await workerAliasDap.request('disconnect', { terminateDebuggee: false });
      assert.equal(disc.success, true, JSON.stringify(disc));
      await workerAliasDap.waitFor(
        (m) => m.type === 'event' && m.event === 'terminated',
        0,
        15000,
      );
    } finally {
      await closeNativePeerAndWait(workerAliasDap);
    }

    const workerPid = await getPackagePid(deviceId, TEST_WORKER_PROCESS);
    assert.notEqual(workerPid, mainPid);
    assert.equal(getPidOfProcess(deviceId, TEST_PACKAGE), null);
    startFixture(deviceId, false);
    const restartedMainPid = await getFixturePid(deviceId);
    assert.notEqual(workerPid, restartedMainPid);

    const ambiguousDap = await native.connectDap();
    try {
      await ambiguousDap.request('initialize', {
        clientID: 'android-ambiguous-process',
        adapterID: 'android',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
      });
      const failAttach = await ambiguousDap.request('attach', {
        android: {
          deviceId,
          userId,
          packageName: TEST_PACKAGE,
        },
      });
      assert.equal(failAttach.success, false, JSON.stringify(failAttach));
      assert.match(failAttach.message ?? '', /^\[ambiguous_process\]/);
      assert.match(failAttach.message ?? '', /ompattachfixture:worker/);
      await ambiguousDap.request('disconnect', { terminateDebuggee: false });
    } finally {
      await closeNativePeerAndWait(ambiguousDap);
    }

    assert.equal(await getPackagePid(deviceId, TEST_WORKER_PROCESS), workerPid);

    const { dap: explicitWorkerAttach } = await attachNativeAndroidDap(native, {
      clientID: 'android-explicit-process-attach',
      deviceId,
      userId,
      processName: TEST_WORKER_PROCESS,
      breakpointFile: processActivityPath,
      breakpointLine: workerBreakLine,
    });
    try {
      await verifyTickBreakpointAndStep(explicitWorkerAttach, 0, 'workerCounter');
      const disc = await explicitWorkerAttach.request('disconnect', { terminateDebuggee: false });
      assert.equal(disc.success, true, JSON.stringify(disc));
    } finally {
      await closeNativePeerAndWait(explicitWorkerAttach);
    }
  } finally {
    await native?.close();
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('native Android DAP without OMP: path 1-based vs file URI 0-based, library and generated-source breakpoints', async () => {
  assert.ok(isDeviceOnline(deviceId));
  const sandbox = await createIntegrationSandbox(prerequisites);
  let native: NativeAndroidClient | undefined;

  try {
    const {
      targetDir,
      apkPath,
      mainActivityPath,
      libHelperPath,
    } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);
    const generatedCounterPath = await materializeGeneratedCounterIfAvailable(targetDir);
    assert.ok(
      generatedCounterPath && existsSync(generatedCounterPath),
      'GeneratedCounter.java must be materialized before opening ILS',
    );
    stopFixture(deviceId);

    native = await startNativeClient(targetDir, sandbox);

    const mainLine1 = findSourceLine(mainActivityPath, 'counter = after;');
    const libLine1 = findSourceLine(libHelperPath, 'lastCount = computed;');
    const genLine1 = findSourceLine(generatedCounterPath, 'lastRecorded = doubled;');

    const { dap: pathDap } = await launchNativeAndroidDap(native, {
      clientID: 'android-path-1based',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
      android: {
        deviceId,
        target: { kind: 'apks', files: [apkPath] },
      },
      breakpoints: [{ path: libHelperPath, lines: [libLine1] }],
    });
    try {
      const stopped = await pathDap.waitFor(
        (m) => m.type === 'event' && m.event === 'stopped',
        0,
        30000,
      );
      const threadId = parseStoppedBody(stopped.body).threadId;
      assert.ok(threadId !== undefined, 'Stopped event must include threadId');
      const stackResp = await pathDap.request('stackTrace', { threadId });
      assert.equal(stackResp.success, true, JSON.stringify(stackResp));
      const topFrame = parseStackTraceResponse(stackResp.body).stackFrames?.[0];
      assert.ok(topFrame?.source?.path, '1-based path frame must include source path');
      assert.equal(topFrame.source.path.startsWith('file:'), false);
      assert.equal(
        normalizePathForCompare(topFrame.source.path),
        normalizePathForCompare(libHelperPath),
      );
      assert.equal(topFrame.line, libLine1);

      const disc = await pathDap.request('disconnect', {});
      assert.equal(disc.success, true, JSON.stringify(disc));
      await pathDap.waitFor((m) => m.type === 'event' && m.event === 'terminated', 0, 15000);
    } finally {
      await closeNativePeerAndWait(pathDap);
    }
    await waitForProcessGone(deviceId, TEST_PACKAGE);

    const mainUri = pathToFileURL(mainActivityPath).href;
    const libUri = pathToFileURL(libHelperPath).href;
    const genUri = pathToFileURL(generatedCounterPath).href;

    const { dap: uriDap } = await launchNativeAndroidDap(native, {
      clientID: 'android-uri-0based',
      pathFormat: 'uri',
      linesStartAt1: false,
      columnsStartAt1: false,
      android: {
        deviceId,
        target: { kind: 'apks', files: [apkPath] },
      },
      breakpoints: [
        { path: mainUri, lines: [mainLine1 - 1] },
      ],
    });
    try {
      const mainBpMsg = uriDap.messages.find(
        (m) => m.type === 'response' && m.command === 'setBreakpoints' && m.success === true,
      );
      const mainBp = (asRecord(mainBpMsg?.body) as SetBreakpointsResponse).breakpoints?.[0];
      if (mainBp?.source?.path) {
        assert.match(mainBp.source.path, /^file:\/\//);
      }

      const stoppedMain = await uriDap.waitFor(
        (m) => m.type === 'event' && m.event === 'stopped',
        0,
        30000,
      );
      const mainThreadId = parseStoppedBody(stoppedMain.body).threadId;
      assert.ok(mainThreadId !== undefined, 'Main stopped event must include threadId');
      const mainStackResp = await uriDap.request('stackTrace', { threadId: mainThreadId });
      assert.equal(mainStackResp.success, true, JSON.stringify(mainStackResp));
      const mainTop = parseStackTraceResponse(mainStackResp.body).stackFrames?.[0];
      assert.ok(mainTop?.source?.path);
      assert.ok(mainTop.source.path.startsWith('file://'));
      assert.equal(
        normalizePathForCompare(fileURLToPath(mainTop.source.path)),
        normalizePathForCompare(mainActivityPath),
      );
      assert.equal(mainTop.line, mainLine1 - 1);

      await uriDap.request('setBreakpoints', { source: { path: mainUri }, breakpoints: [] });
      const libBpResp = await uriDap.request('setBreakpoints', {
        source: { path: libUri },
        breakpoints: [{ line: libLine1 - 1 }],
      });
      assert.equal(libBpResp.success, true, JSON.stringify(libBpResp));

      const afterLibContinue = uriDap.messages.length;
      await uriDap.request('continue', { threadId: mainThreadId });
      const stoppedLib = await uriDap.waitFor(
        (m) => m.type === 'event' && m.event === 'stopped',
        afterLibContinue,
        30000,
      );
      const libThreadId = parseStoppedBody(stoppedLib.body).threadId;
      assert.ok(libThreadId !== undefined, 'Lib stopped event must include threadId');
      const libStackResp = await uriDap.request('stackTrace', { threadId: libThreadId });
      assert.equal(libStackResp.success, true, JSON.stringify(libStackResp));
      const libTop = parseStackTraceResponse(libStackResp.body).stackFrames?.[0];
      assert.ok(libTop?.source?.path);
      assert.ok(libTop.source.path.startsWith('file://'));
      assert.equal(
        normalizePathForCompare(fileURLToPath(libTop.source.path)),
        normalizePathForCompare(libHelperPath),
      );
      assert.equal(libTop.line, libLine1 - 1);

      await uriDap.request('setBreakpoints', { source: { path: libUri }, breakpoints: [] });
      const genBpResp = await uriDap.request('setBreakpoints', {
        source: { path: genUri },
        breakpoints: [{ line: genLine1 - 1 }],
      });
      assert.equal(genBpResp.success, true, JSON.stringify(genBpResp));

      const afterGenContinue = uriDap.messages.length;
      await uriDap.request('continue', { threadId: libThreadId });
      const stoppedGen = await uriDap.waitFor(
        (m) => m.type === 'event' && m.event === 'stopped',
        afterGenContinue,
        30000,
      );
      const genThreadId = parseStoppedBody(stoppedGen.body).threadId;
      assert.ok(genThreadId !== undefined, 'Generated stopped event must include threadId');
      const genStackResp = await uriDap.request('stackTrace', { threadId: genThreadId });
      assert.equal(genStackResp.success, true, JSON.stringify(genStackResp));
      const genTop = parseStackTraceResponse(genStackResp.body).stackFrames?.[0];
      assert.ok(genTop?.source?.path);
      assert.ok(genTop.source.path.startsWith('file://'));
      assert.equal(
        normalizePathForCompare(fileURLToPath(genTop.source.path)),
        normalizePathForCompare(generatedCounterPath),
      );
      assert.equal(genTop.line, genLine1 - 1);

      const bpEventWithSource = uriDap.messages.find(
        (m) =>
          m.type === 'event' &&
          m.event === 'breakpoint' &&
          Boolean(asRecord(asRecord(m.body).breakpoint).source),
      );
      if (bpEventWithSource) {
        const bpSourcePath = String(
          asRecord(asRecord(asRecord(bpEventWithSource.body).breakpoint).source).path ?? '',
        );
        assert.match(bpSourcePath, /^file:\/\//);
      }

      const disc = await uriDap.request('disconnect', {});
      assert.equal(disc.success, true, JSON.stringify(disc));
      await uriDap.waitFor((m) => m.type === 'event' && m.event === 'terminated', 0, 15000);
    } finally {
      await closeNativePeerAndWait(uriDap);
    }
    await waitForProcessGone(deviceId, TEST_PACKAGE);
  } finally {
    await native?.close();
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('native Android DAP without OMP: included build root disambiguation, multi-launcher candidates, application-level process, and JDK preflight', async () => {
  assert.ok(isDeviceOnline(deviceId));
  const sandbox = await createIntegrationSandbox(prerequisites);
  let jbrNative: NativeAndroidClient | undefined;
  let native: NativeAndroidClient | undefined;

  try {
    const { targetDir, includedDir, includedMainActivityPath } =
      await copyAndroidAttachFixture(sandbox);
    stopPackage(deviceId, INCLUDED_PACKAGE);

    const serverRoot = dirname(dirname(prerequisites.serverExecutable));
    const jbrDir = join(serverRoot, 'jbr');
    let incompleteJdk = jbrDir;
    if (!existsSync(jbrDir)) {
      incompleteJdk = join(sandbox.sandboxDir, 'incomplete-jdk');
      await mkdir(join(incompleteJdk, 'bin'), { recursive: true });
    }

    jbrNative = await startNativeClient(targetDir, sandbox, incompleteJdk);
    await assert.rejects(
      jbrNative.lsp.lspRequest('workspace/executeCommand', {
        command: 'org.intellij.android.run.targets',
        arguments: [{}],
      }),
      /\[prerequisite_missing\]/,
    );
    const jbrDap = await jbrNative.connectDap();
    try {
      await jbrDap.request('initialize', {
        clientID: 'android-jdk-preflight',
        adapterID: 'android',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
      });
      const failResp = await jbrDap.request('launch', {
        android: {
          deviceId,
          target: { kind: 'gradle', module: ':app', variant: 'debug', build: true },
        },
      });
      assert.equal(failResp.success, false, JSON.stringify(failResp));
      assert.match(failResp.message ?? '', /^\[prerequisite_missing\]/);
      await jbrDap.request('disconnect', { terminateDebuggee: false });
    } finally {
      await closeNativePeerAndWait(jbrDap);
    }
    await jbrNative.close();
    jbrNative = undefined;

    native = await startNativeClient(targetDir, sandbox);

    const includedTargets = (await native.lsp.lspRequest('workspace/executeCommand', {
      command: 'org.intellij.android.run.targets',
      arguments: [{ buildRoot: 'included' }],
    })) as TargetsResponse;
    const includedApp = includedTargets.modules.find(
      (m) =>
        m.module === ':app' &&
        normalizePathForCompare(m.buildRoot) === normalizePathForCompare(includedDir),
    );
    assert.ok(includedApp, `targets(included) must resolve included :app: ${JSON.stringify(includedTargets)}`);

    const multiLauncherDap = await native.connectDap();
    try {
      await multiLauncherDap.request('initialize', {
        clientID: 'android-included-multilauncher',
        adapterID: 'android',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsProgressReporting: true,
      });
      const failResp = await multiLauncherDap.request('launch', {
        android: {
          deviceId,
          target: {
            kind: 'gradle',
            buildRoot: 'included',
            module: ':app',
            variant: 'debug',
            build: true,
          },
        },
      });
      assert.equal(failResp.success, false, JSON.stringify(failResp));
      assert.match(failResp.message ?? '', /^\[artifact_invalid\]/);
      assert.match(failResp.message ?? '', /MainActivity/);
      assert.match(failResp.message ?? '', /SecondLauncherActivity/);
      await multiLauncherDap.request('disconnect', { terminateDebuggee: false });
    } finally {
      await closeNativePeerAndWait(multiLauncherDap);
    }

    const includedBreakLine = findSourceLine(includedMainActivityPath, 'counter = after;');
    const { dap: includedDap } = await launchNativeAndroidDap(native, {
      clientID: 'android-included-explicit-activity',
      android: {
        deviceId,
        activity: '.MainActivity',
        target: {
          kind: 'gradle',
          buildRoot: 'included',
          module: ':app',
          variant: 'debug',
          build: false,
        },
      },
      breakpoints: [{ path: includedMainActivityPath, lines: [includedBreakLine] }],
    });
    try {
      const procEvent = await includedDap.waitFor(
        (m) => m.type === 'event' && m.event === 'process',
        0,
        15000,
      );
      assert.equal(asRecord(procEvent.body).name, INCLUDED_PROCESS);
      await verifyTickBreakpointAndStep(includedDap, 0, 'counter');
      const disc = await includedDap.request('disconnect', {});
      assert.equal(disc.success, true, JSON.stringify(disc));
      await includedDap.waitFor((m) => m.type === 'event' && m.event === 'terminated', 0, 15000);
    } finally {
      await closeNativePeerAndWait(includedDap);
    }
    await waitForProcessGone(deviceId, INCLUDED_PROCESS);
  } finally {
    await jbrNative?.close();
    await native?.close();
    stopPackage(deviceId, INCLUDED_PACKAGE);
    await sandbox.cleanup();
  }
});

test('native Android DAP without OMP: deterministic real build gate cancel stops child while sibling LSP and shared daemon survive', async () => {
  assert.ok(isDeviceOnline(deviceId));
  const sandbox = await createIntegrationSandbox(prerequisites);
  let native: NativeAndroidClient | undefined;
  let siblingNative: NativeAndroidClient | undefined;

  try {
    const { targetDir, apkPath } = await copyAndroidAttachFixture(sandbox);
    stopFixture(deviceId);

    const appBuildGradlePath = join(targetDir, 'app', 'build.gradle.kts');
    const originalBuildGradle = await readFile(appBuildGradlePath, 'utf8');
    const daemonPidFile = join(sandbox.sandboxDir, 'daemon.pid');
    const gateStartedFile = join(sandbox.sandboxDir, 'gate.started');
    const gateReleaseFile = join(sandbox.sandboxDir, 'gate.release');
    const gateCompletedFile = join(sandbox.sandboxDir, 'gate.completed');

    await writeFile(
      appBuildGradlePath,
      appendBuildGateHook(
        originalBuildGradle,
        daemonPidFile,
        gateStartedFile,
        gateReleaseFile,
        gateCompletedFile,
      ),
      'utf8',
    );

    native = await startNativeClient(targetDir, sandbox);
    const jdk21Dir = await copyWorkspaceFixture('jdk21', sandbox);
    siblingNative = await startNativeClient(jdk21Dir, sandbox);

    const dap = await native.connectDap();
    try {
      const initResp = await dap.request('initialize', {
        clientID: 'android-build-gate-cancel',
        adapterID: 'android',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsProgressReporting: true,
      });
      assert.equal(initResp.success, true, JSON.stringify(initResp));

      const launchReq = dap.sendRequest('launch', {
        android: {
          deviceId,
          target: { kind: 'gradle', module: ':app', variant: 'debug', build: true },
        },
      });

      const childPidText = await waitForFileOnDisk(gateStartedFile, 90000);
      const daemonPidText = await waitForFileOnDisk(daemonPidFile, 15000);
      const childPid = Number.parseInt(childPidText, 10);
      const daemonPid = Number.parseInt(daemonPidText, 10);
      assert.ok(Number.isInteger(childPid) && childPid > 0);
      assert.ok(Number.isInteger(daemonPid) && daemonPid > 0);
      assert.equal(isProcessAlive(childPid), true);
      assert.equal(isProcessAlive(daemonPid), true);

      const cancelResp = await dap.request('cancel', { requestId: launchReq.id });
      assert.equal(cancelResp.success, true, JSON.stringify(cancelResp));

      const launchResp = await launchReq.response;
      assert.equal(launchResp.success, false, JSON.stringify(launchResp));
      assert.match(launchResp.message ?? '', /^\[cancelled\]/);

      await waitForProcessDead(childPid, 10000);
      assert.equal(existsSync(gateCompletedFile), false, 'Cancelled gate must not complete');
      assert.equal(existsSync(apkPath), false, 'Cancelled build must not produce APK');
      assert.equal(isProcessAlive(daemonPid), true, 'Shared Gradle daemon must survive cancel');

      await waitForStartupProgressEnd(dap);
      const stages = dap.messages
        .filter((m) => m.type === 'event' && m.event === 'progressUpdate')
        .map((m) => String(asRecord(m.body).message ?? ''));
      assert.equal(stages.includes('installing'), false, 'Cancelled build must not enter install');
      assert.equal(stages.includes('starting'), false, 'Cancelled build must not enter starting');
      assert.equal(
        dap.messages.filter((m) => m.type === 'event' && m.event === 'progressEnd').length,
        1,
      );

      const discResp = await dap.request('disconnect', { terminateDebuggee: false });
      assert.equal(discResp.success, true, JSON.stringify(discResp));
    } finally {
      await closeNativePeerAndWait(dap);
    }

    const symResult = await siblingNative.lsp.lspRequest('workspace/symbol', { query: 'App' });
    assert.ok(Array.isArray(symResult), 'Sibling LSP must remain responsive after build cancel');

    const ownSymbols = await native.lsp.lspRequest('workspace/symbol', { query: 'MainActivity' });
    assert.ok(Array.isArray(ownSymbols), 'Owning LSP must remain responsive after DAP disconnect');

    await writeFile(appBuildGradlePath, originalBuildGradle, 'utf8');
    const targetsAfter = (await native.lsp.lspRequest('workspace/executeCommand', {
      command: 'org.intellij.android.run.targets',
      arguments: [{}],
    })) as TargetsResponse;
    assert.ok(targetsAfter.modules.some((m) => m.module === ':app'));
  } catch (error) {
    if (native) await reportNativeLogs(native);
    throw error;
  } finally {
    await siblingNative?.close();
    await native?.close();
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('native Android DAP without OMP: install cancel inspects PM state and blocks next stage, target_busy lock, and configurationDone cancel', async () => {
  assert.ok(isDeviceOnline(deviceId));
  const sandbox = await createIntegrationSandbox(prerequisites);
  let native: NativeAndroidClient | undefined;

  try {
    const { targetDir, apkPath, mainActivityPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);
    stopFixture(deviceId);
    runAdb(['-s', deviceId, 'shell', 'pm', 'uninstall', '--user', '0', TEST_PACKAGE], 15000);

    native = await startNativeClient(targetDir, sandbox);

    const installCancelDap = await native.connectDap();
    try {
      await installCancelDap.request('initialize', {
        clientID: 'android-install-cancel',
        adapterID: 'android',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsProgressReporting: true,
      });

      const launchReq = installCancelDap.sendRequest('launch', {
        android: {
          deviceId,
          target: { kind: 'apks', files: [apkPath] },
        },
      });
      await installCancelDap.waitFor(
        (m) =>
          m.type === 'event' &&
          m.event === 'progressUpdate' &&
          asRecord(m.body).message === 'installing',
        0,
        30000,
      );

      const cancelResp = await installCancelDap.request('cancel', {
        progressId: 'org.intellij.android.launch',
      });
      assert.equal(cancelResp.success, true, JSON.stringify(cancelResp));

      const launchResp = await launchReq.response;
      assert.equal(launchResp.success, false, JSON.stringify(launchResp));
      assert.match(launchResp.message ?? '', /^\[(cancelled|install_failed)\]/);

      await waitForStartupProgressEnd(installCancelDap);
      const stages = installCancelDap.messages
        .filter((m) => m.type === 'event' && m.event === 'progressUpdate')
        .map((m) => String(asRecord(m.body).message ?? ''));
      assert.equal(stages.includes('starting'), false, 'Cancelled install must not enter starting');
      assert.equal(stages.includes('attaching'), false, 'Cancelled install must not enter attaching');
      assert.equal(getPidOfProcess(deviceId, TEST_PACKAGE), null, 'App must not be started');
      assert.equal(
        installCancelDap.messages.filter((m) => m.type === 'event' && m.event === 'progressEnd')
          .length,
        1,
      );

      const activeSessions = getActiveInstallSessionsSection(deviceId);
      assert.equal(
        activeSessions.includes('SessionInfo{'),
        false,
        `Active PM install sessions must be abandoned after cancel, saw: ${activeSessions}`,
      );

      await installCancelDap.request('disconnect', { terminateDebuggee: false });
    } finally {
      await closeNativePeerAndWait(installCancelDap);
    }

    const heldDap = await native.connectDap();
    const busyDap = await native.connectDap();
    try {
      await heldDap.request('initialize', {
        clientID: 'android-held-launch',
        adapterID: 'android',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsProgressReporting: true,
      });
      const heldLaunchReq = heldDap.sendRequest('launch', {
        android: {
          deviceId,
          target: { kind: 'apks', files: [apkPath] },
          restartApp: true,
        },
      });
      await heldDap.waitFor((m) => m.type === 'event' && m.event === 'initialized', 0, 60000);

      await busyDap.request('initialize', {
        clientID: 'android-busy-launch',
        adapterID: 'android',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
      });
      const busyResp = await busyDap.request('launch', {
        android: {
          deviceId,
          target: { kind: 'apks', files: [apkPath] },
        },
      });
      assert.equal(busyResp.success, false, JSON.stringify(busyResp));
      assert.match(busyResp.message ?? '', /^\[target_busy\]/);
      await busyDap.request('disconnect', { terminateDebuggee: false });

      const cancelHeld = await heldDap.request('cancel', {
        progressId: 'org.intellij.android.launch',
      });
      assert.equal(cancelHeld.success, true, JSON.stringify(cancelHeld));
      const heldResp = await heldLaunchReq.response;
      assert.equal(heldResp.success, false, JSON.stringify(heldResp));
      assert.match(heldResp.message ?? '', /^\[cancelled\]/);
      await heldDap.request('disconnect', { terminateDebuggee: false });
    } finally {
      await closeNativePeerAndWait(busyDap);
      await closeNativePeerAndWait(heldDap);
    }

    const breakLine = findSourceLine(mainActivityPath, 'counter = after;');
    const { dap: followUpDap } = await launchNativeAndroidDap(native, {
      clientID: 'android-install-followup',
      android: {
        deviceId,
        target: { kind: 'apks', files: [apkPath] },
        restartApp: true,
      },
      breakpoints: [{ path: mainActivityPath, lines: [breakLine] }],
    });
    try {
      await verifyTickBreakpointAndStep(followUpDap, 0, 'counter');
      const disc = await followUpDap.request('disconnect', {});
      assert.equal(disc.success, true, JSON.stringify(disc));
      await followUpDap.waitFor((m) => m.type === 'event' && m.event === 'terminated', 0, 15000);
    } finally {
      await closeNativePeerAndWait(followUpDap);
    }
    await waitForProcessGone(deviceId, TEST_PACKAGE);
  } finally {
    await native?.close();
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('OMP host DapSessionManager: Android owned launch, external attach, and startup cancellation', async () => {
  assert.ok(isDeviceOnline(deviceId));
  const sandbox = await createIntegrationSandbox(prerequisites);
  let hostLaunch: OmpHostDriver | undefined;
  let hostAttach: OmpHostDriver | undefined;
  let hostCancel: OmpHostDriver | undefined;

  try {
    const { targetDir, apkPath, mainActivityPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);
    stopFixture(deviceId);

    const forwardBefore = getAdbForwardList(deviceId);
    const breakLine = findSourceLine(mainActivityPath, 'counter = after;');

    hostLaunch = createOmpHostDriver(
      {
        mode: 'launch',
        cwd: targetDir,
        program: mainActivityPath,
        launchDefaults: {
          android: {
            deviceId,
            target: { kind: 'apks', files: [apkPath] },
          },
        },
        breakpoint: { file: mainActivityPath, line: breakLine },
      },
      sandbox,
    );
    await hostLaunch.starting;
    const launchReady = await hostLaunch.ready;
    assert.equal(asRecord(launchReady.capabilities).supportsTerminateRequest, false);
    assert.equal(asRecord(launchReady.capabilities).supportsCancelRequest, false);
    assert.ok(Array.isArray(launchReady.threads) && launchReady.threads.length > 0);
    await getFixturePid(deviceId);

    await hostLaunch.close();
    const launchClosed = await hostLaunch.closed;
    assert.deepEqual(launchClosed.sessions, []);
    await hostLaunch.exited;
    hostLaunch = undefined;

    await waitForProcessGone(deviceId, TEST_PACKAGE);
    assert.equal(getAdbForwardList(deviceId), forwardBefore);

    startFixture(deviceId, false);
    const originalPid = await getFixturePid(deviceId);
    hostAttach = createOmpHostDriver(
      {
        mode: 'attach',
        cwd: targetDir,
        attachDefaults: {
          android: {
            deviceId,
            packageName: TEST_PACKAGE,
            pid: originalPid,
          },
        },
        breakpoint: { file: mainActivityPath, line: breakLine },
      },
      sandbox,
    );
    await hostAttach.starting;
    const attachReady = await hostAttach.ready;
    assert.equal(asRecord(attachReady.capabilities).supportsTerminateRequest, false);
    assert.equal(asRecord(attachReady.capabilities).supportsCancelRequest, false);

    await hostAttach.close();
    const attachClosed = await hostAttach.closed;
    assert.deepEqual(attachClosed.sessions, []);
    await hostAttach.exited;
    hostAttach = undefined;

    assert.equal(
      await getFixturePid(deviceId),
      originalPid,
      'OMP host external attach must keep target PID alive on terminate',
    );
    stopFixture(deviceId);
    await waitForProcessGone(deviceId, TEST_PACKAGE);

    await rm(apkPath, { force: true });
    const appBuildGradlePath = join(targetDir, 'app', 'build.gradle.kts');
    const originalBuildGradle = await readFile(appBuildGradlePath, 'utf8');
    const daemonPidFile = join(sandbox.sandboxDir, 'host-daemon.pid');
    const gateStartedFile = join(sandbox.sandboxDir, 'host-gate.started');
    const gateReleaseFile = join(sandbox.sandboxDir, 'host-gate.release');
    const gateCompletedFile = join(sandbox.sandboxDir, 'host-gate.completed');
    await writeFile(
      appBuildGradlePath,
      appendBuildGateHook(
        originalBuildGradle,
        daemonPidFile,
        gateStartedFile,
        gateReleaseFile,
        gateCompletedFile,
      ),
      'utf8',
    );

    hostCancel = createOmpHostDriver(
      {
        mode: 'launch',
        cwd: targetDir,
        program: mainActivityPath,
        launchDefaults: {
          android: {
            deviceId,
            target: { kind: 'gradle', module: ':app', variant: 'debug', build: true },
          },
        },
      },
      sandbox,
    );
    await hostCancel.starting;
    const childPidText = await waitForFileOnDisk(gateStartedFile, 90000);
    const daemonPidText = await waitForFileOnDisk(daemonPidFile, 15000);
    const childPid = Number.parseInt(childPidText, 10);
    const daemonPid = Number.parseInt(daemonPidText, 10);
    assert.equal(isProcessAlive(childPid), true);
    assert.equal(isProcessAlive(daemonPid), true);

    hostCancel.cancel();
    await assert.rejects(hostCancel.ready);
    await assert.rejects(hostCancel.exited);
    hostCancel = undefined;

    await waitForProcessDead(childPid, 10000);
    assert.equal(existsSync(gateCompletedFile), false);
    assert.equal(existsSync(apkPath), false);
    assert.equal(isProcessAlive(daemonPid), true);
    assert.equal(getPidOfProcess(deviceId, TEST_PACKAGE), null);
    assert.equal(getAdbForwardList(deviceId), forwardBefore);
  } finally {
    await hostLaunch?.close().catch(() => {});
    await hostAttach?.close().catch(() => {});
    await hostCancel?.close().catch(() => {});
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});

test('OMP dap-proxy Android attach: standard attach({ android }) over dap-proxy -> breakpoint hit -> proxy SIGKILL EOF releases JDWP -> sibling LSP unaffected -> re-attach succeeds', async () => {
  assert.ok(
    isDeviceOnline(deviceId),
    `Android device ${deviceId} must remain online during acceptance`,
  );
  const sandbox = await createIntegrationSandbox(prerequisites);
  let dap: DapClientDriver | undefined;
  let followUpDap: DapClientDriver | undefined;
  let siblingLsp: LspClientDriver | undefined;
  try {
    const { targetDir, apkPath, mainActivityPath } = await copyAndroidAttachFixture(sandbox);
    await ensureApkBuilt(targetDir, sandbox, apkPath);

    installFixture(deviceId, apkPath);

    stopFixture(deviceId);
    startFixture(deviceId, false);
    const originalPid = await getFixturePid(deviceId);

    const initialDap = createDapClientDriver(targetDir, sandbox);
    dap = initialDap;
    await dap.request('initialize', {
      clientID: 'test-omp-android-attach',
      adapterID: 'intellij',
    });

    const breakLine = findSourceLine(mainActivityPath, 'counter = after;');
    await dap.request('setBreakpoints', {
      source: { path: mainActivityPath },
      breakpoints: [{ line: breakLine }],
    });

    await Promise.all([
      dap.request(
        'attach',
        { android: { deviceId, packageName: TEST_PACKAGE } },
        60000,
      ),
      initialDap.waitForEvent('initialized', 60000).then(() => initialDap.request('configurationDone')),
    ]);

    const stopped = await dap.waitForEvent('stopped', 30000);
    assert.equal(parseStoppedBody(stopped.body).reason, 'breakpoint');

    const jdk21Dir = await copyWorkspaceFixture('jdk21', sandbox);
    siblingLsp = createLspClientDriver(jdk21Dir, sandbox);
    await siblingLsp.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(jdk21Dir).href,
      capabilities: {},
    });
    siblingLsp.notify('initialized', {});

    const dapPid = dap.process.pid;
    assert.ok(dapPid !== undefined && dapPid > 0, 'DAP process PID must be defined');
    killProcessSafely(dapPid, sandbox);
    await dap.waitForExit(15000);
    await sleep(500);

    const symResult = await siblingLsp.request('workspace/symbol', { query: 'App' });
    assert.ok(Array.isArray(symResult), 'Sibling LSP session must remain fully operational');
    await siblingLsp.close();
    siblingLsp = undefined;

    const nextDap = createDapClientDriver(targetDir, sandbox);
    followUpDap = nextDap;
    await followUpDap.request('initialize', {
      clientID: 'test-omp-android-attach-followup',
      adapterID: 'intellij',
    });
    await Promise.all([
      followUpDap.request(
        'attach',
        { android: { deviceId, packageName: TEST_PACKAGE, pid: originalPid } },
        60000,
      ),
      nextDap.waitForEvent('initialized', 60000).then(() => nextDap.request('configurationDone')),
    ]);
    await followUpDap.request('disconnect', { terminateDebuggee: false });
    await followUpDap.waitForExit(15000);

    assert.equal(await getFixturePid(deviceId), originalPid);
  } finally {
    await followUpDap?.close();
    await dap?.close();
    await siblingLsp?.close();
    stopFixture(deviceId);
    await sandbox.cleanup();
  }
});
