import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { terminateMarkedProcess } from '../../src/debug/run-core.js';
import { saveProjectConfiguration } from '../../src/project/configuration.js';
import { canonicalizeProject, getActiveLeases } from '../../src/project/metadata.js';
import { setWorkspaceJdk } from '../../src/project/workspace.js';
import { DEFAULT_SERVER_VERSION } from '../../src/server/bundle-metadata.js';
import { acceptServerEula, type EulaDocument, readServerEula } from '../../src/server/eula.js';
import { encode, frameParser } from '../../src/shared/protocol.js';
import { sanitizeString } from '../../src/shared/runtime-status.js';

export { readServerEula };

const initialGradleUserHome = process.env.GRADLE_USER_HOME;

export interface IntegrationPrerequisites {
  serverExecutable: string;
  jdk17Path: string;
  jdk21Path: string;
  acceptedEulaHash: string;
  eulaDoc: EulaDocument;
}

export async function verifyPrerequisites(): Promise<IntegrationPrerequisites> {
  const missing: string[] = [];
  const server = process.env.OMP_INTELLIJ_TEST_SERVER;
  const jdk17 = process.env.OMP_INTELLIJ_TEST_JDK17;
  const jdk21 = process.env.OMP_INTELLIJ_TEST_JDK21;
  const eulaHash = process.env.OMP_INTELLIJ_TEST_ACCEPTED_EULA_HASH;

  if (!server) missing.push('OMP_INTELLIJ_TEST_SERVER');
  if (!jdk17) missing.push('OMP_INTELLIJ_TEST_JDK17');
  if (!jdk21) missing.push('OMP_INTELLIJ_TEST_JDK21');
  if (!eulaHash) missing.push('OMP_INTELLIJ_TEST_ACCEPTED_EULA_HASH');

  if (missing.length > 0 || !server || !jdk17 || !jdk21 || !eulaHash) {
    throw new Error(
      `Integration suite missing required environment prerequisites: ${missing.join(', ')}. ` +
        'All 4 prerequisites must be provided; skipping is not permitted.',
    );
  }

  const resolvedServer = resolve(server);
  const resolvedJdk17 = resolve(jdk17);
  const resolvedJdk21 = resolve(jdk21);

  if (!existsSync(resolvedServer)) {
    throw new Error(`OMP_INTELLIJ_TEST_SERVER executable not found on disk: ${resolvedServer}`);
  }
  if (!existsSync(resolvedJdk17)) {
    throw new Error(`OMP_INTELLIJ_TEST_JDK17 directory not found on disk: ${resolvedJdk17}`);
  }
  if (!existsSync(resolvedJdk21)) {
    throw new Error(`OMP_INTELLIJ_TEST_JDK21 directory not found on disk: ${resolvedJdk21}`);
  }

  const eulaDoc = await readServerEula(resolvedServer);
  const normalizedHash = eulaHash.trim().toLowerCase();
  if (eulaDoc.hash !== normalizedHash) {
    throw new Error(
      `EULA hash mismatch: expected accepted hash ${normalizedHash}, but server hash is ${eulaDoc.hash}`,
    );
  }

  return {
    serverExecutable: resolvedServer,
    jdk17Path: resolvedJdk17,
    jdk21Path: resolvedJdk21,
    acceptedEulaHash: normalizedHash,
    eulaDoc,
  };
}

export interface IntegrationSandbox {
  sandboxDir: string;
  systemPath: string;
  configDir: string;
  logDir: string;
  gradleUserHome: string;
  workspacesDir: string;
  configFile: string;
  settingsFile: string;
  env: NodeJS.ProcessEnv;
  prerequisites: IntegrationPrerequisites;
  ownedProcesses: Set<ChildProcess>;
  ownedSockets: Set<net.Socket>;
  ownedServers: Set<net.Server>;
  ownedMarkers: Set<string>;
  trackProcess(child: ChildProcess): void;
  trackSocket(socket: net.Socket): void;
  trackServer(server: net.Server): void;
  cleanup(): Promise<void>;
}

function waitForProcessExit(child: ChildProcess, timeoutMs = 15000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  const { promise, resolve, reject } = Promise.withResolvers<number | null>();
  const onExit = (code: number | null) => {
    clearTimeout(timer);
    resolve(code);
  };
  const timer = setTimeout(() => {
    child.off('exit', onExit);
    reject(new Error(`Owned process ${child.pid} did not exit within ${timeoutMs}ms`));
  }, timeoutMs);
  child.once('exit', onExit);
  return promise;
}

function waitForMessage<T>(
  child: ChildProcess,
  emitter: EventEmitter,
  messages: T[],
  predicate: (message: T) => boolean,
  timeoutMs: number,
  after = 0,
): Promise<T> {
  const found = messages.find((message, index) => index >= after && predicate(message));
  if (found) return Promise.resolve(found);
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return Promise.reject(new Error(`Protocol process ${child.pid} is no longer running`));
  }
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const onMessage = (message: T) => {
    if (predicate(message)) resolve(message);
  };
  const onExit = () => reject(new Error(`Protocol process ${child.pid} exited`));
  const timer = setTimeout(
    () => reject(new Error(`Protocol deadline exceeded after ${timeoutMs}ms`)),
    timeoutMs,
  );
  emitter.on('message', onMessage);
  child.once('exit', onExit);
  child.once('error', reject);
  return promise.finally(() => {
    clearTimeout(timer);
    emitter.off('message', onMessage);
    child.off('exit', onExit);
    child.off('error', reject);
  });
}

export async function createIntegrationSandbox(
  prerequisites: IntegrationPrerequisites,
): Promise<IntegrationSandbox> {
  const sandboxDir = await mkdtemp(join(tmpdir(), 'omp-intellij-integration-'));

  const systemPath = join(sandboxDir, 'system');
  const configDir = join(sandboxDir, 'config');
  const logDir = join(sandboxDir, 'log');
  const gradleUserHome = join(sandboxDir, 'gradle-home');
  const workspacesDir = join(sandboxDir, 'workspaces');
  const workspaceConfigPath = join(configDir, 'workspaces');

  await mkdir(systemPath, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(gradleUserHome, { recursive: true });
  await mkdir(workspacesDir, { recursive: true });
  await mkdir(workspaceConfigPath, { recursive: true });

  const configFile = join(configDir, 'intellij.json');
  const settingsFile = join(configDir, 'settings.json');

  await writeFile(
    configFile,
    JSON.stringify(
      { server: { mode: 'external', executable: prerequisites.serverExecutable } },
      null,
      2,
    ),
    'utf8',
  );

  await writeFile(
    settingsFile,
    JSON.stringify(
      {
        executable: prerequisites.serverExecutable,
        systemPath,
        host: '127.0.0.1',
        startupTimeoutMs: 60000,
        idleTimeout: '10m',
        workspaceConfigPath,
        cachePolicy: {
          retentionDays: 7,
          warnAboveGiB: 10,
          automaticDeletion: false,
        },
        initializeTimeoutMs: 60000,
        requestWaitTimeoutMs: 120000,
      },
      null,
      2,
    ),
    'utf8',
  );

  await acceptServerEula(prerequisites.eulaDoc, { configFile });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OMP_INTELLIJ_CONFIG: configFile,
    OMP_INTELLIJ_SETTINGS: settingsFile,
    OMP_ANDROID_LS_EXTENSION_DIR: resolve(
      'resources',
      'ils',
      DEFAULT_SERVER_VERSION,
      'android.lsp',
    ),
    GRADLE_USER_HOME: gradleUserHome,
    JAVA_HOME: prerequisites.jdk21Path,
    IJ_JAVA_OPTIONS: `-Dintellij.server.eula.persistence=false -Didea.config.path=${configDir.replace(/\\/g, '/')} -Didea.log.path=${logDir.replace(/\\/g, '/')}`,
  };
  const previousEnvironment = {
    OMP_INTELLIJ_CONFIG: process.env.OMP_INTELLIJ_CONFIG,
    OMP_INTELLIJ_SETTINGS: process.env.OMP_INTELLIJ_SETTINGS,
    GRADLE_USER_HOME: process.env.GRADLE_USER_HOME,
    OMP_ANDROID_LS_EXTENSION_DIR: process.env.OMP_ANDROID_LS_EXTENSION_DIR,
    JAVA_HOME: process.env.JAVA_HOME,
    IJ_JAVA_OPTIONS: process.env.IJ_JAVA_OPTIONS,
  };
  process.env.OMP_INTELLIJ_CONFIG = configFile;
  process.env.OMP_INTELLIJ_SETTINGS = settingsFile;
  process.env.OMP_ANDROID_LS_EXTENSION_DIR = env.OMP_ANDROID_LS_EXTENSION_DIR;
  process.env.GRADLE_USER_HOME = gradleUserHome;
  process.env.JAVA_HOME = prerequisites.jdk21Path;
  process.env.IJ_JAVA_OPTIONS = env.IJ_JAVA_OPTIONS;

  const ownedProcesses = new Set<ChildProcess>();
  const ownedSockets = new Set<net.Socket>();
  const ownedServers = new Set<net.Server>();
  const ownedMarkers = new Set<string>();

  const trackProcess = (child: ChildProcess) => {
    ownedProcesses.add(child);
    child.once('exit', () => ownedProcesses.delete(child));
  };

  const trackSocket = (socket: net.Socket) => {
    ownedSockets.add(socket);
    socket.once('close', () => ownedSockets.delete(socket));
  };

  const trackServer = (server: net.Server) => {
    ownedServers.add(server);
    server.once('close', () => ownedServers.delete(server));
  };

  const cleanup = async () => {
    for (const child of Array.from(ownedProcesses)) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      if (child.stdin?.writable) child.stdin.end();
      else child.kill();
      await waitForProcessExit(child);
    }
    for (const marker of ownedMarkers) {
      await terminateMarkedProcess(
        marker,
        join(prerequisites.jdk21Path, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
      );
    }
    for (const socket of ownedSockets) socket.destroy();
    for (const server of Array.from(ownedServers)) {
      if (server.listening) {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        server.close((error) => (error ? reject(error) : resolve()));
        await promise;
      }
    }
    const serverOwnerFile = join(systemPath, 'omp-server.json');
    if (existsSync(serverOwnerFile)) {
      const owner = JSON.parse(await readFile(serverOwnerFile, 'utf8')) as { pid: number };
      if (isProcessAlive(owner.pid)) {
        killProcessSafely(owner.pid, sandbox);
        const deadline = Date.now() + 5000;
        while (isProcessAlive(owner.pid) && Date.now() < deadline) {
          await sleep(100);
        }
        if (isProcessAlive(owner.pid))
          throw new Error(`Sandbox server ${owner.pid} survived termination`);
      }
    }
    if (existsSync(join(gradleUserHome, 'daemon'))) {
      const stopped = spawnSync(
        join(prerequisites.jdk21Path, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
        [
          '-cp',
          resolve('test-fixtures/concurrency/jdk21/gradle/wrapper/gradle-wrapper.jar'),
          'org.gradle.wrapper.GradleWrapperMain',
          '--stop',
        ],
        {
          cwd: resolve('test-fixtures/concurrency/jdk21'),
          env: {
            ...env,
            GRADLE_USER_HOME: gradleUserHome,
          },
          encoding: 'utf8',
          timeout: 30000,
          windowsHide: true,
        },
      );
      if (stopped.status !== 0)
        throw new Error(`Sandbox Gradle shutdown failed: ${sanitizeString(stopped.stderr || '')}`);
    }
    if ((await getActiveLeases(systemPath)).length)
      throw new Error('Sandbox has active leases after cleanup');
    if (existsSync(join(systemPath, 'omp-start.lock')))
      throw new Error('Sandbox lifecycle lock remains');
    await rm(sandboxDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    for (const [key, val] of Object.entries(previousEnvironment)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  };

  const sandbox: IntegrationSandbox = {
    sandboxDir,
    systemPath,
    configDir,
    logDir,
    gradleUserHome,
    workspacesDir,
    configFile,
    settingsFile,
    env,
    prerequisites,
    ownedProcesses,
    ownedSockets,
    ownedServers,
    ownedMarkers,
    trackProcess,
    trackSocket,
    trackServer,
    cleanup,
  };
  await copyCachedWrapper(sandbox);
  return sandbox;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isSandboxServerProcess(pid: number, expectedSystemPath: string): boolean {
  try {
    if (process.platform === 'win32') {
      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference = 'Stop'; (Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ];
      let res = spawnSync('pwsh.exe', args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        res = spawnSync('powershell.exe', args, {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        });
      }
      return res.status === 0 && res.stdout.includes(`--system-path=${expectedSystemPath}`);
    }
    const res = spawnSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const cmd = res.stdout || '';
    return cmd.includes(expectedSystemPath);
  } catch {
    return false;
  }
}

export function killProcessSafely(pid: number, sandbox: IntegrationSandbox): void {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid owned process PID');
  const child = Array.from(sandbox.ownedProcesses).find(
    (child) => child.pid === pid && child.exitCode === null && child.signalCode === null,
  );
  if (!child && !isSandboxServerProcess(pid, sandbox.systemPath)) {
    throw new Error(`Refusing termination: PID ${pid} is not owned by this sandbox`);
  }
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/F', '/PID', String(pid)], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.status !== 0 && isProcessAlive(pid))
      throw new Error(`Failed to terminate owned PID ${pid}`);
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

async function copyGradleCache(source: string, target: string): Promise<void> {
  const entries = await readdir(source, { recursive: true, withFileTypes: true });
  let next = 0;
  // Bound disk concurrency while avoiding serial copies of every cached artifact.
  await Promise.all(
    Array.from({ length: 32 }, async () => {
      while (next < entries.length) {
        const entry = entries[next++];
        if (!entry || /(?:\.(?:lock|lck|part)$|^gc\.properties$)/.test(entry.name)) continue;
        const input = join(entry.parentPath, entry.name);
        const output = join(target, relative(source, input));
        if (entry.isDirectory()) {
          await mkdir(output, { recursive: true });
        } else {
          await mkdir(dirname(output), { recursive: true });
          if (entry.isFile()) await copyFile(input, output);
          else await cp(input, output);
        }
      }
    }),
  );
}

export async function copyCachedDependencies(sandbox: IntegrationSandbox): Promise<void> {
  const candidates = [
    process.env.OMP_INTELLIJ_TEST_GRADLE_CACHE,
    initialGradleUserHome,
    join(homedir(), '.gradle'),
  ].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
  const relativePath = join('caches', 'modules-2');
  const cache = candidates.find(
    (dir) =>
      resolve(dir) !== resolve(sandbox.gradleUserHome) && existsSync(join(dir, relativePath)),
  );
  if (cache) {
    await copyGradleCache(join(cache, relativePath), join(sandbox.gradleUserHome, relativePath));
  }
}

async function copyCachedWrapper(sandbox: IntegrationSandbox): Promise<void> {
  const candidates = [
    process.env.OMP_INTELLIJ_TEST_GRADLE_CACHE,
    initialGradleUserHome,
    join(homedir(), '.gradle'),
  ].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
  const relativePath = join('wrapper', 'dists', 'gradle-9.8.0-bin');
  const cache = candidates.find((dir) => existsSync(join(dir, relativePath)));
  if (!cache) return;
  await copyGradleCache(join(cache, relativePath), join(sandbox.gradleUserHome, relativePath));
}
export async function seedSandboxProjectConfig(
  projectPath: string,
  sandbox: IntegrationSandbox,
  rawInitializationOptions: Record<string, unknown> = {},
  javaHome = sandbox.prerequisites.jdk21Path,
): Promise<void> {
  const canonical = canonicalizeProject(projectPath);
  const indexDir = join(sandbox.sandboxDir, 'index', canonical.id);
  await saveProjectConfiguration(sandbox.systemPath, {
    id: canonical.id,
    projectPath: canonical.nativePath,
    rootUri: canonical.rootUri,
    updatedAt: Date.now(),
    settings: {},
    rawInitializationOptions: {
      indexDir,
      ...rawInitializationOptions,
    },
  });
  await setWorkspaceJdk(projectPath, javaHome, {
    systemPath: sandbox.systemPath,
    configDir: sandbox.configDir,
  });
}

export async function copyWorkspaceFixture(
  fixtureName: 'jdk17' | 'jdk21',
  sandbox: IntegrationSandbox,
): Promise<string> {
  const sourceDir = resolve('test-fixtures', 'concurrency', fixtureName);
  const targetDir = join(sandbox.workspacesDir, fixtureName);
  await cp(sourceDir, targetDir, { recursive: true });

  const propPath = join(targetDir, 'gradle.properties');
  const jdk17Normalized = sandbox.prerequisites.jdk17Path.replace(/\\/g, '/');
  const jdk21Normalized = sandbox.prerequisites.jdk21Path.replace(/\\/g, '/');

  const content = [
    'org.gradle.java.installations.auto-download=false',
    'org.gradle.java.installations.auto-detect=false',
    `org.gradle.java.installations.paths=${jdk17Normalized},${jdk21Normalized}`,
    `org.gradle.java.home=${jdk21Normalized}`,
    '',
  ].join('\n');

  await writeFile(propPath, content, 'utf8');
  await seedSandboxProjectConfig(
    targetDir,
    sandbox,
    {},
    fixtureName === 'jdk17' ? sandbox.prerequisites.jdk17Path : sandbox.prerequisites.jdk21Path,
  );
  return targetDir;
}

export async function generateLargeJavaProject(
  targetDir: string,
  classCount = 5000,
): Promise<void> {
  const srcDir = join(targetDir, 'src', 'main', 'java', 'com', 'example', 'bigtree');
  await mkdir(srcDir, { recursive: true });

  const classes: string[] = [];
  for (let i = 1; i <= classCount; i++) {
    const pad = String(i).padStart(5, '0');
    const className = `BigClass${pad}`;
    classes.push(
      `package com.example.bigtree;\n\npublic class ${className} {\n    public static int value() { return ${i}; }\n}\n`,
    );
  }

  const batchSize = 100;
  for (let b = 0; b < classCount; b += batchSize) {
    await Promise.all(
      classes.slice(b, b + batchSize).map((src, idx) => {
        const fileNum = String(b + idx + 1).padStart(5, '0');
        return writeFile(join(srcDir, `BigClass${fileNum}.java`), src, 'utf8');
      }),
    );
  }

  await writeFile(
    join(targetDir, 'settings.gradle'),
    "rootProject.name = 'indexing-large-project'\n",
    'utf8',
  );
  await writeFile(
    join(targetDir, 'build.gradle'),
    `plugins { id 'java' }\njava { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\n`,
    'utf8',
  );
}

function resolveScript(name: 'bridge' | 'dap-proxy'): string {
  const script = name === 'dap-proxy' ? join('debug', `${name}.js`) : `${name}.js`;
  const testDist = resolve('dist-test', 'src', script);
  return existsSync(testDist) ? testDist : resolve('dist', script);
}

export interface LspMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface LspClientDriver {
  process: ChildProcess;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  waitFor(predicate: (m: LspMessage) => boolean, timeoutMs?: number): Promise<LspMessage>;
  waitForExit(timeoutMs?: number): Promise<number | null>;
  close(): Promise<void>;
}

export function createLspClientDriver(
  projectPath: string,
  sandbox: IntegrationSandbox,
): LspClientDriver {
  const script = resolveScript('bridge');
  const child = spawn(process.execPath, [script], {
    cwd: projectPath,
    env: sandbox.env,
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });

  sandbox.trackProcess(child);

  let nextId = 1;
  const messages: LspMessage[] = [];
  const emitter = new EventEmitter();

  child.stdin?.on('error', () => {});
  child.stdout?.on('error', () => {});

  child.on('error', () => {});

  child.stdout?.on(
    'data',
    frameParser((raw: unknown) => {
      if (raw && typeof raw === 'object') {
        const msg = raw as LspMessage;
        if (msg.method && msg.id !== undefined) {
          const response: Record<string, unknown> = { jsonrpc: '2.0', id: msg.id };
          if (msg.method === 'workspace/configuration') {
            const items = msg.params?.items;
            response.result = Array.isArray(items) ? items.map(() => null) : [];
          } else if (
            [
              'client/registerCapability',
              'client/unregisterCapability',
              'window/workDoneProgress/create',
            ].includes(msg.method)
          ) {
            response.result = null;
          } else if (msg.method === 'workspace/applyEdit') {
            response.result = {
              applied: false,
              failureReason: 'Read-only integration protocol client',
            };
          } else {
            response.error = { code: -32601, message: `Unsupported client method: ${msg.method}` };
          }
          child.stdin?.write(encode(response));
        }
        messages.push(msg);
        emitter.emit('message', msg);
      }
    }),
  );

  const notify = (method: string, params?: unknown) => {
    if (child.stdin?.writable) {
      child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
    }
  };

  const waitFor = (predicate: (message: LspMessage) => boolean, timeoutMs = 30000) =>
    waitForMessage(child, emitter, messages, predicate, timeoutMs);

  const request = async (
    method: string,
    params?: unknown,
    timeoutMs = method === 'initialize' ? 60000 : 30000,
  ): Promise<unknown> => {
    let finalParams = params;
    if (method === 'initialize') {
      const initParams =
        params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
      const existingOptions =
        initParams.initializationOptions && typeof initParams.initializationOptions === 'object'
          ? (initParams.initializationOptions as Record<string, unknown>)
          : {};
      finalParams = {
        ...initParams,
        initializationOptions: {
          indexDir: join(sandbox.sandboxDir, 'index', canonicalizeProject(projectPath).id),
          ...existingOptions,
        },
      };
    }
    const id = nextId++;
    child.stdin?.write(encode({ jsonrpc: '2.0', id, method, params: finalParams }));
    const resp = await waitFor((message) => message.id === id && !message.method, timeoutMs);
    if (resp.error) {
      throw new Error(
        `RPC Error [${resp.error.code}]: ${sanitizeString(resp.error.message || '')}`,
      );
    }
    return resp.result;
  };

  const waitForExit = (timeoutMs = 15000) => waitForProcessExit(child, timeoutMs);

  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.end();
    await waitForExit();
  };

  return { process: child, request, notify, waitFor, waitForExit, close };
}

export interface DapMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: unknown;
  [key: string]: unknown;
}

export interface DapClientDriver {
  process: ChildProcess;
  send(command: string, args?: Record<string, unknown>): number;
  request(command: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<DapMessage>;
  waitFor(predicate: (m: DapMessage) => boolean, timeoutMs?: number): Promise<DapMessage>;
  waitForEvent(event: string, timeoutMs?: number): Promise<DapMessage>;
  waitForOutputSubstring(sub: string, timeoutMs?: number): Promise<string>;
  waitForExit(timeoutMs?: number): Promise<number | null>;
  evaluate(expression: string, frameId?: number, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

export function createDapClientDriver(
  projectPath: string,
  sandbox: IntegrationSandbox,
): DapClientDriver {
  const script = resolveScript('dap-proxy');
  const child = spawn(process.execPath, [script], {
    cwd: projectPath,
    env: sandbox.env,
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });

  sandbox.trackProcess(child);

  let seq = 1;
  const messages: DapMessage[] = [];
  const emitter = new EventEmitter();

  child.stdin?.on('error', () => {});
  child.stdout?.on('error', () => {});

  child.on('error', () => {});

  child.stdout?.on(
    'data',
    frameParser((raw: unknown) => {
      if (raw && typeof raw === 'object') {
        const msg = raw as DapMessage;
        if (
          msg.type === 'event' &&
          msg.event === 'output' &&
          msg.body &&
          typeof msg.body === 'object' &&
          'output' in msg.body
        ) {
          for (const match of String(msg.body.output).matchAll(/RUN_MARKER=([0-9a-f-]{36})/g)) {
            sandbox.ownedMarkers.add(match[1]);
          }
        }
        messages.push(msg);
        emitter.emit('message', msg);
      }
    }),
  );

  const send = (command: string, args: Record<string, unknown> = {}): number => {
    const s = seq++;
    child.stdin?.write(encode({ seq: s, type: 'request', command, arguments: args }));
    return s;
  };

  const waitFor = (predicate: (message: DapMessage) => boolean, timeoutMs = 30000, after = 0) =>
    waitForMessage(child, emitter, messages, predicate, timeoutMs, after);

  const waitForEvent = (event: string, timeoutMs = 30000): Promise<DapMessage> => {
    return waitFor((m) => m.type === 'event' && m.event === event, timeoutMs);
  };

  const waitForOutputSubstring = (sub: string, timeoutMs = 30000): Promise<string> => {
    let output = '';
    return waitFor(
      (message) => {
        if (message.type !== 'event' || message.event !== 'output') return false;
        output += (message.body as { output?: string })?.output || '';
        return output.includes(sub);
      },
      timeoutMs,
      messages.length,
    ).then(() => output);
  };

  const request = async (
    command: string,
    args: Record<string, unknown> = {},
    timeoutMs = command === 'launch' ? 120000 : 30000,
  ): Promise<DapMessage> => {
    const s = send(command, args);
    const resp = await waitFor((m) => m.type === 'response' && m.request_seq === s, timeoutMs);
    if (resp.success === false) {
      throw new Error(`DAP command '${command}' failed: ${resp.message || 'unknown error'}`);
    }
    return resp;
  };

  const evaluate = async (
    expression: string,
    frameId?: number,
    timeoutMs = 15000,
  ): Promise<unknown> => {
    const resp = await request('evaluate', { expression, frameId, context: 'repl' }, timeoutMs);
    const body = resp.body;
    if (body && typeof body === 'object' && 'result' in body) {
      return (body as Record<string, unknown>).result;
    }
    return undefined;
  };

  const waitForExit = (timeoutMs = 15000) => waitForProcessExit(child, timeoutMs);

  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.end();
    await waitForExit();
  };

  return {
    process: child,
    send,
    request,
    waitFor,
    waitForEvent,
    waitForOutputSubstring,
    waitForExit,
    evaluate,
    close,
  };
}

export interface TcpGate {
  gatePort: number;
  waitForBytesObserved(timeoutMs?: number): Promise<void>;
  release(): void;
  close(): Promise<void>;
}

export async function createTcpGate(
  targetPort: number,
  sandbox: IntegrationSandbox,
): Promise<TcpGate> {
  let holdBytes = true;
  let buffered: Buffer[] = [];
  let upstreamSocket: net.Socket | null = null;
  const bytesEmitter = new EventEmitter();
  let bytesObserved = false;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((clientSocket) => {
    sandbox.trackSocket(clientSocket);
    const upstream = net.createConnection({ host: '127.0.0.1', port: targetPort });
    sandbox.trackSocket(upstream);
    upstreamSocket = upstream;
    for (const socket of [clientSocket, upstream]) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    }

    clientSocket.on('data', (chunk) => {
      if (!bytesObserved) {
        bytesObserved = true;
        bytesEmitter.emit('bytes');
      }
      if (holdBytes) {
        buffered.push(chunk);
      } else {
        upstream.write(chunk);
      }
    });

    upstream.on('data', (chunk) => {
      clientSocket.write(chunk);
    });

    clientSocket.on('close', () => upstream.destroy());
    upstream.on('close', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
    upstream.on('error', () => clientSocket.destroy());
  });

  sandbox.trackServer(server);
  const { promise: listening, resolve: resolveListening } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => resolveListening());
  await listening;
  const gatePort = (server.address() as net.AddressInfo).port;

  const waitForBytesObserved = (timeoutMs = 15000): Promise<void> => {
    if (bytesObserved) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const onBytes = () => resolve();
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for gate bytes after ${timeoutMs}ms`)),
      timeoutMs,
    );
    bytesEmitter.once('bytes', onBytes);
    return promise.finally(() => {
      clearTimeout(timer);
      bytesEmitter.off('bytes', onBytes);
    });
  };

  const release = () => {
    holdBytes = false;
    if (upstreamSocket && !upstreamSocket.destroyed) {
      for (const b of buffered) {
        upstreamSocket.write(b);
      }
      buffered = [];
    }
  };

  const close = async () => {
    for (const socket of sockets) socket.destroy();
    if (!server.listening) return;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => reject(new Error('TCP gate cleanup exceeded 15000ms')), 15000);
    server.close((error) => (error ? reject(error) : resolve()));
    try {
      await promise;
    } finally {
      clearTimeout(timer);
    }
  };

  return { gatePort, waitForBytesObserved, release, close };
}

export interface ExternalAttachTarget {
  process: ChildProcess;
  jdwpPort: number;
  heartbeats: number;
  close(): void;
}

export async function startExternalAttachTarget(
  jdk21Path: string,
  workDir: string,
  sandbox: IntegrationSandbox,
): Promise<ExternalAttachTarget> {
  const javaExe = join(jdk21Path, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const targetSource = resolve(
    'test-fixtures',
    'jvm-hybrid-app',
    'src',
    'main',
    'java',
    'com',
    'example',
    'AttachTarget.java',
  );
  const targetDir = join(workDir, 'attach-target-bin');
  await mkdir(targetDir, { recursive: true });

  const javacExe = join(jdk21Path, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
  const compileResult = spawnSync(javacExe, ['-d', targetDir, targetSource], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (compileResult.status !== 0) {
    throw new Error(`Failed to compile AttachTarget: ${compileResult.stderr}`);
  }

  const child = spawn(
    javaExe,
    [
      '-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:0',
      '-cp',
      targetDir,
      'com.example.AttachTarget',
    ],
    {
      cwd: workDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  sandbox.trackProcess(child);

  let jdwpPort = 0;
  let heartbeats = 0;
  const {
    promise: portReady,
    resolve: resolvePort,
    reject: rejectPort,
  } = Promise.withResolvers<number>();

  const buffers = { out: '', err: '' };
  const checkOutput = (stream: 'out' | 'err', data: Buffer) => {
    const text = buffers[stream] + data.toString('utf8');
    const end = text.lastIndexOf('\n') + 1;
    const lines = text.slice(0, end);
    buffers[stream] = text.slice(end);
    for (const match of lines.matchAll(/address:\s*(\d+)/gi)) {
      jdwpPort = Number(match[1]);
      resolvePort(jdwpPort);
    }
    heartbeats += lines.match(/ATTACH_HEARTBEAT=\d+/g)?.length ?? 0;
  };

  child.stdout?.on('data', (data: Buffer) => checkOutput('out', data));
  child.stderr?.on('data', (data: Buffer) => checkOutput('err', data));

  child.once('error', rejectPort);
  child.once('exit', (code) => {
    if (!jdwpPort) rejectPort(new Error(`AttachTarget exited early with code ${code}`));
  });

  const timer = setTimeout(() => {
    if (!jdwpPort) rejectPort(new Error('Timeout waiting for AttachTarget JDWP port announcement'));
  }, 15000);

  await portReady;
  clearTimeout(timer);

  return {
    process: child,
    get jdwpPort() {
      return jdwpPort;
    },
    get heartbeats() {
      return heartbeats;
    },
    close() {
      child.kill();
    },
  };
}
