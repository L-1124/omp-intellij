import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { executeBuild } from '../src/debug/run-core.js';
import {
  canonicalizeProject,
  getProjectLedger,
  migrateProjectMetadata,
  pathsEqual,
  recordReadiness,
} from '../src/project/metadata.js';
import {
  applyWorkspaceOptions,
  cleanPath,
  detectProjectType,
  discoverJdks,
  getWorkspaceInfo,
  maskConfiguredSecrets,
  maskEnvValue,
  readWorkspaceConfig,
  setWorkspaceEnvVar,
  setWorkspaceJdk,
  unsetWorkspaceEnvVar,
  validateEnvMap,
  validateJdk,
} from '../src/project/workspace.js';
import { reimportWorkspace } from '../src/project/workspace-reimport.js';
import { asyncFramedStream, encode } from '../src/shared/protocol.js';

async function createMockJdk(
  dir: string,
  options: {
    version?: string;
    implementor?: string;
    skipJava?: boolean;
    skipJavac?: boolean;
    skipRelease?: boolean;
    malformedVersion?: boolean;
  } = {},
) {
  const {
    version = '21.0.4',
    implementor = 'Eclipse Adoptium',
    skipJava = false,
    skipJavac = false,
    skipRelease = false,
    malformedVersion = false,
  } = options;

  await mkdir(join(dir, 'bin'), { recursive: true });
  const isWin = process.platform === 'win32';
  const javaFile = join(dir, 'bin', isWin ? 'java.exe' : 'java');
  const javacFile = join(dir, 'bin', isWin ? 'javac.exe' : 'javac');

  if (!skipJava) await writeFile(javaFile, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (!skipJavac) await writeFile(javacFile, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (!skipRelease) {
    const ver = malformedVersion ? 'not-a-number' : version;
    const releaseContent = `${[
      `IMPLEMENTOR="${implementor}"`,
      `JAVA_VERSION="${ver}"`,
      'OS_ARCH="x86_64"',
      `OS_NAME="${process.platform === 'win32' ? 'Windows' : 'Linux'}"`,
    ].join('\n')}\n`;
    await writeFile(join(dir, 'release'), releaseContent, 'utf8');
  }
}

test('cleanPath removes surrounding quotes and whitespace', () => {
  assert.equal(cleanPath('  "C:/Program Files/Java"  '), 'C:/Program Files/Java');
  assert.equal(cleanPath("  'F:/toolchains/jdk'  "), 'F:/toolchains/jdk');
  assert.equal(cleanPath('/plain/path'), '/plain/path');
});

test('validateJdk verifies bin/java, bin/javac, and release file', async () => {
  const tmp = join(tmpdir(), `omp-test-jdk-${Math.random().toString(36).slice(2)}`);
  try {
    await createMockJdk(tmp, { version: '21.0.4', implementor: 'Eclipse Adoptium' });
    const validated = validateJdk(tmp);
    assert.equal(validated.javaVersion, '21.0.4');
    assert.equal(resolve(validated.javaHome).toLowerCase(), resolve(tmp).toLowerCase());
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

for (const [label, options, expected] of [
  ['bin/java', { skipJava: true }, /missing bin\/java/],
  ['bin/javac', { skipJavac: true }, /missing bin\/javac/],
  ['release file', { skipRelease: true }, /missing release file/],
] as const) {
  test(`validateJdk rejects a JDK missing ${label}`, async () => {
    const tmp = join(tmpdir(), `omp-test-jdk-missing-${Math.random().toString(36).slice(2)}`);
    try {
      await createMockJdk(tmp, options);
      assert.throws(() => validateJdk(tmp), expected);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
}

test('validateJdk rejects malformed JAVA_VERSION in release file', async () => {
  const tmp = join(tmpdir(), `omp-test-jdk-malformed-${Math.random().toString(36).slice(2)}`);
  try {
    await createMockJdk(tmp, { malformedVersion: true });
    assert.throws(() => validateJdk(tmp), /malformed JAVA_VERSION/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('validateJdk accepts path with spaces', async () => {
  const tmp = join(tmpdir(), `omp test jdk ${Math.random().toString(36).slice(2)}`);
  try {
    await createMockJdk(tmp, { version: '17.0.2', implementor: 'Oracle Corporation' });
    const validated = validateJdk(`"${tmp}"`);
    assert.equal(validated.javaVersion, '17.0.2');
    assert.equal(resolve(validated.javaHome).toLowerCase(), resolve(tmp).toLowerCase());
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('validateJdk allows symlink paths', async () => {
  const realDir = join(tmpdir(), `omp-test-jdk-real-${Math.random().toString(36).slice(2)}`);
  const linkDir = join(tmpdir(), `omp-test-jdk-link-${Math.random().toString(36).slice(2)}`);
  try {
    await createMockJdk(realDir, { version: '21.0.1' });
    try {
      await symlink(realDir, linkDir, 'junction');
    } catch {
      return;
    }
    const validated = validateJdk(linkDir);
    assert.equal(validated.javaVersion, '21.0.1');
  } finally {
    await rm(linkDir, { recursive: true, force: true });
    await rm(realDir, { recursive: true, force: true });
  }
});

test('detectProjectType identifies maven and gradle projects', async () => {
  const tmp = join(tmpdir(), `omp-test-proj-${Math.random().toString(36).slice(2)}`);
  try {
    await mkdir(tmp, { recursive: true });
    assert.equal(detectProjectType(tmp), 'unknown');

    await writeFile(join(tmp, 'pom.xml'), '<project></project>', 'utf8');
    assert.equal(detectProjectType(tmp), 'maven');

    await rm(join(tmp, 'pom.xml'));
    await writeFile(join(tmp, 'build.gradle.kts'), '', 'utf8');
    assert.equal(detectProjectType(tmp), 'gradle');

    await rm(join(tmp, 'build.gradle.kts'));
    await writeFile(join(tmp, 'settings.gradle'), '', 'utf8');
    assert.equal(detectProjectType(tmp), 'gradle');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('setWorkspaceJdk persists atomically and does not write on invalid JDK', async () => {
  const configDir = join(tmpdir(), `omp-test-cfg-${Math.random().toString(36).slice(2)}`);
  const projDir = join(tmpdir(), `omp test proj ${Math.random().toString(36).slice(2)}`);
  const validJdk = join(tmpdir(), `omp-valid-jdk-${Math.random().toString(36).slice(2)}`);
  const invalidJdk = join(tmpdir(), `omp-invalid-jdk-${Math.random().toString(36).slice(2)}`);

  try {
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'pom.xml'), '<project></project>', 'utf8');
    await createMockJdk(validJdk, { version: '21.0.4' });
    await mkdir(invalidJdk, { recursive: true });

    await assert.rejects(() => setWorkspaceJdk(projDir, invalidJdk, { configDir }), /missing/i);

    const result = await setWorkspaceJdk(projDir, validJdk, { configDir });
    assert.equal(result.javaVersion, '21.0.4');
    assert.equal(resolve(result.javaHome).toLowerCase(), resolve(validJdk).toLowerCase());

    const info = await getWorkspaceInfo(projDir, { configDir });
    assert.equal(info.projectType, 'maven');
    assert.equal(resolve(info.savedJdk || '').toLowerCase(), resolve(validJdk).toLowerCase());
    assert.equal(info.savedVersion, '21.0.4');
    assert.equal(info.appliedJdk, null);
    assert.equal(info.isApplied, false);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
    await rm(validJdk, { recursive: true, force: true });
    await rm(invalidJdk, { recursive: true, force: true });
  }
});

test('getWorkspaceInfo distinguishes savedJdk from verified runtime receipt', async () => {
  const configDir = join(tmpdir(), `omp-test-cfg2-${Math.random().toString(36).slice(2)}`);
  const systemPath = join(tmpdir(), `omp-test-sys2-${Math.random().toString(36).slice(2)}`);
  const projDir = join(tmpdir(), `omp-test-proj2-${Math.random().toString(36).slice(2)}`);
  const jdk21 = join(tmpdir(), `omp-test-jdk21-${Math.random().toString(36).slice(2)}`);

  try {
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'pom.xml'), '<project></project>', 'utf8');
    await createMockJdk(jdk21, { version: '21.0.4' });

    await setWorkspaceJdk(projDir, jdk21, { configDir, systemPath });

    const { canonicalizeProject } = await import('../src/project/metadata.js');
    const { id } = canonicalizeProject(projDir);
    const receiptDir = join(systemPath, 'plugin-metadata', 'receipts');
    await mkdir(receiptDir, { recursive: true });

    const deadReceipt = {
      id,
      pid: 99999999,
      javaHome: jdk21,
      appliedAt: Date.now(),
      verified: true,
    };
    await writeFile(join(receiptDir, `${id}.applied.json`), JSON.stringify(deadReceipt), 'utf8');

    const infoDead = await getWorkspaceInfo(projDir, { configDir, systemPath });
    assert.equal(infoDead.appliedJdk, null);
    assert.equal(infoDead.isApplied, false);

    await writeFile(
      join(systemPath, 'omp-server.json'),
      JSON.stringify({ pid: process.pid }),
      'utf8',
    );

    const liveReceipt = {
      id,
      pid: process.pid,
      javaHome: jdk21,
      appliedAt: Date.now(),
      verified: true,
    };
    await writeFile(join(receiptDir, `${id}.applied.json`), JSON.stringify(liveReceipt), 'utf8');

    const infoLive = await getWorkspaceInfo(projDir, { configDir, systemPath });
    assert.equal(resolve(infoLive.appliedJdk || '').toLowerCase(), resolve(jdk21).toLowerCase());
    assert.equal(infoLive.isApplied, true);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(systemPath, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
    await rm(jdk21, { recursive: true, force: true });
  }
});

test('applyWorkspaceOptions returns original options untouched when no profile saved', async () => {
  const configDir = join(tmpdir(), `omp-test-cfg-unconf-${Math.random().toString(36).slice(2)}`);
  const projDir = join(tmpdir(), `omp-test-proj-unconf-${Math.random().toString(36).slice(2)}`);

  try {
    await mkdir(projDir, { recursive: true });
    const originalOptions = {
      eulaHash: 'abc',
      projects: [{ type: 'custom', path: 'file:///custom/path' }],
    };

    const result = await applyWorkspaceOptions(projDir, originalOptions, { configDir });
    assert.deepEqual(result, originalOptions);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
  }
});

test('applyWorkspaceOptions throws if project type cannot be determined for saved profile', async () => {
  const configDir = join(tmpdir(), `omp-test-cfg-unk-${Math.random().toString(36).slice(2)}`);
  const projDir = join(tmpdir(), `omp-test-proj-unk-${Math.random().toString(36).slice(2)}`);
  const jdk21 = join(tmpdir(), `omp-test-jdk-unk-${Math.random().toString(36).slice(2)}`);

  try {
    await mkdir(projDir, { recursive: true });
    await createMockJdk(jdk21, { version: '21.0.4' });
    await setWorkspaceJdk(projDir, jdk21, { configDir });

    await assert.rejects(
      () => applyWorkspaceOptions(projDir, {}, { configDir }),
      /Cannot determine supported project type/i,
    );
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
    await rm(jdk21, { recursive: true, force: true });
  }
});

test('applyWorkspaceOptions merges managed JDK and preserves unrelated native options', async () => {
  const configDir = join(tmpdir(), `omp-test-cfg3-${Math.random().toString(36).slice(2)}`);
  const projDir = join(tmpdir(), `omp-test-proj3-${Math.random().toString(36).slice(2)}`);
  const jdk21 = join(tmpdir(), `omp-test-jdk21-3-${Math.random().toString(36).slice(2)}`);

  try {
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'pom.xml'), '<project></project>', 'utf8');
    await createMockJdk(jdk21, { version: '21.0.4' });
    await setWorkspaceJdk(projDir, jdk21, { configDir });

    const initialOptions = {
      eulaHash: 'cd82e6cdaf2790f1',
      runMainCodeLens: true,
      defaultSdk: 'F:/fallback/jdk',
      projects: [
        {
          type: 'gradle',
          path: 'file:///c:/other/project',
          'java-home': 'C:/other/jdk',
          customProperty: 'preserve-me',
        },
      ],
    };

    const merged = await applyWorkspaceOptions(projDir, initialOptions, { configDir });
    assert.equal(merged.eulaHash, 'cd82e6cdaf2790f1');
    assert.equal(merged.runMainCodeLens, true);
    assert.equal(merged.defaultSdk, 'F:/fallback/jdk');

    const projects = merged.projects;
    assert.ok(Array.isArray(projects));
    assert.equal(projects.length, 2);
    const otherProj = projects.find((p) => p.path === 'file:///c:/other/project');
    assert.ok(otherProj);
    assert.equal(otherProj.customProperty, 'preserve-me');

    const curProj = projects.find((p) => p.path !== 'file:///c:/other/project');
    assert.ok(curProj);
    assert.equal(curProj.type, 'maven');
    assert.equal(typeof curProj.path, 'string');
    assert.ok(curProj.path.startsWith('file:'));
    assert.equal(typeof curProj['java-home'], 'string');
    assert.equal(resolve(curProj['java-home']).toLowerCase(), resolve(jdk21).toLowerCase());
    assert.equal(typeof curProj.env.JAVA_HOME, 'string');
    assert.equal(resolve(curProj.env.JAVA_HOME).toLowerCase(), resolve(jdk21).toLowerCase());
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
    await rm(jdk21, { recursive: true, force: true });
  }
});

test('discoverJdks finds bounded candidate JDKs and deduplicates', async () => {
  const root = join(tmpdir(), `omp-test-store-${Math.random().toString(36).slice(2)}`);
  const subJdk1 = join(root, 'jdk-21');
  const subJdk2 = join(root, 'jdk-17');
  const nonJdk = join(root, 'not-a-jdk');

  try {
    await createMockJdk(subJdk1, { version: '21.0.4', implementor: 'Eclipse Adoptium' });
    await createMockJdk(subJdk2, { version: '17.0.9', implementor: 'Oracle Corporation' });
    await mkdir(nonJdk, { recursive: true });

    const jdks = await discoverJdks('/any/project', {
      candidateRoots: [root],
      includeDefaultRoots: false,
      env: {},
    });
    assert.ok(jdks.length >= 2);

    const v21 = jdks.find(
      (j) => resolve(j.javaHome).toLowerCase() === resolve(subJdk1).toLowerCase(),
    );
    const v17 = jdks.find(
      (j) => resolve(j.javaHome).toLowerCase() === resolve(subJdk2).toLowerCase(),
    );
    assert.ok(v21);
    assert.ok(v17);
    assert.equal(v21.vendor, 'Eclipse Adoptium');
    assert.equal(v17.vendor, 'Oracle Corporation');
    assert.equal(v21.majorVersion, 21);
    assert.equal(v17.majorVersion, 17);
    const idx21 = jdks.indexOf(v21);
    const idx17 = jdks.indexOf(v17);
    assert.ok(idx21 < idx17);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discoverJdks combines injected and configured JDKs', async () => {
  const tempDir = join(tmpdir(), `omp-test-jdk-disc-${Math.random().toString(36).slice(2)}`);
  const configDir = join(tempDir, 'config');
  const candidateDir = join(tempDir, 'candidate');
  const injectedJdk = join(candidateDir, 'jdk-21');
  const configJdk = join(tempDir, 'config-jdk-17');

  try {
    await createMockJdk(injectedJdk, { version: '21.0.4', implementor: 'Eclipse Adoptium' });
    await createMockJdk(configJdk, { version: '17.0.9', implementor: 'Oracle Corporation' });
    await mkdir(configDir, { recursive: true });

    const configPath = join(configDir, 'test-proj.json');
    await writeFile(configPath, JSON.stringify({ javaHome: configJdk }), 'utf8');

    const jdks = await discoverJdks(tempDir, {
      configDir,
      candidateRoots: [candidateDir],
      includeDefaultRoots: false,
      env: {},
    });

    const foundInjected = jdks.find(
      (j) => resolve(j.javaHome).toLowerCase() === resolve(injectedJdk).toLowerCase(),
    );
    const foundConfig = jdks.find(
      (j) => resolve(j.javaHome).toLowerCase() === resolve(configJdk).toLowerCase(),
    );
    assert.ok(foundInjected, 'injected candidateRoot JDK should be found');
    assert.equal(foundInjected.source, 'injected');
    assert.ok(foundConfig, 'configDir JDK should be found');
    assert.equal(foundConfig.source, 'config');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('executeBuild integrates managed JDK and prepends effective JAVA_HOME to PATH', async () => {
  const configDir = join(tmpdir(), `omp-test-cfg-eb-${Math.random().toString(36).slice(2)}`);
  const projDir = join(tmpdir(), `omp-test-proj-eb-${Math.random().toString(36).slice(2)}`);
  const jdk21 = join(tmpdir(), `omp-test-jdk21-eb-${Math.random().toString(36).slice(2)}`);

  try {
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'pom.xml'), '<project></project>', 'utf8');
    await createMockJdk(jdk21, { version: '21.0.4' });
    await setWorkspaceJdk(projDir, jdk21, { configDir });

    const originalEnvJavaHome = process.env.JAVA_HOME;

    const isWin = process.platform === 'win32';
    const command = isWin
      ? ['cmd.exe', '/c', 'echo %JAVA_HOME%']
      : ['/bin/sh', '-c', 'echo $JAVA_HOME'];

    const res = await executeBuild(
      { command, cwd: projDir, tool: 'test' },
      { projectRoot: projDir, configDir },
    );

    const normOut = res.buildOutput.replace(/\\/g, '/').toLowerCase();
    const normExpected = resolve(jdk21).replace(/\\/g, '/').toLowerCase();
    assert.ok(normOut.includes(normExpected), `Expected ${normOut} to include ${normExpected}`);
    assert.equal(process.env.JAVA_HOME, originalEnvJavaHome);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
    await rm(jdk21, { recursive: true, force: true });
  }
});

test('asyncFramedStream from protocol.ts gates frames in strict FIFO order', async () => {
  const events: string[] = [];

  const stream = asyncFramedStream(async (msgRaw, _frame) => {
    const msg = msgRaw as { method?: string; id?: unknown };
    if (msg.method === 'initialize') {
      events.push('initialize-start');
      await Promise.resolve();
      events.push('initialize-end');
      return;
    }
    events.push(msg.method || `res-${msg.id}`);
  });

  const chunk = Buffer.concat([
    encode({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    encode({ jsonrpc: '2.0', method: 'initialized', params: {} }),
    encode({ jsonrpc: '2.0', id: 2, method: 'workspace/executeCommand', params: {} }),
  ]);

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  stream.write(chunk, (err) => {
    if (err) reject(err);
    else resolve();
  });
  await promise;

  assert.deepEqual(events, [
    'initialize-start',
    'initialize-end',
    'initialized',
    'workspace/executeCommand',
  ]);
});

test('validateEnvMap validates keys, values, and boundary restrictions', () => {
  assert.deepEqual({ ...validateEnvMap({ FOO: 'bar', BAZ: '123' }) }, { FOO: 'bar', BAZ: '123' });
  assert.deepEqual({ ...validateEnvMap({ '  TRIMMED  ': 'val' }) }, { TRIMMED: 'val' });
  const protoMap = validateEnvMap(JSON.parse('{"__proto__": "safe_val"}'));
  assert.equal(Object.hasOwn(protoMap, '__proto__'), true);
  assert.equal(Object.getOwnPropertyDescriptor(protoMap, '__proto__')?.value, 'safe_val');
  assert.throws(() => validateEnvMap(null), /must be a non-null object/);
  assert.throws(() => validateEnvMap('string'), /must be a non-null object/);
  assert.throws(() => validateEnvMap([]), /must be a non-null object/);
  assert.throws(() => validateEnvMap({ '': 'val' }), /empty key is not allowed/);
  assert.throws(() => validateEnvMap({ 'FOO=BAR': 'val' }), /cannot contain '='/);
  assert.throws(() => validateEnvMap({ 'FOO\0': 'val' }), /cannot contain null bytes/);
  assert.throws(() => validateEnvMap({ FOO: 123 as unknown as string }), /must be a string/);
  assert.throws(() => validateEnvMap({ FOO: 'val\0' }), /cannot contain null bytes/);
});

test('maskEnvValue masks sensitive values without data leakage', () => {
  assert.equal(maskEnvValue(''), '""');
  assert.equal(maskEnvValue('secret'), '***');
  assert.equal(maskEnvValue('http://user:password@proxy:8080'), '***');
  assert.equal(maskEnvValue(123 as unknown as string), '');
});

test('maskConfiguredSecrets strips literal configured env values from echoed error strings', () => {
  const env = {
    CUSTOM_SECRET: 'my_top_secret_token_12345',
    SAFE_KEY: 'abc',
    SHORT: 'xy',
  };
  const echoed =
    'LSP Error: Failed to authenticate with my_top_secret_token_12345 and token xy on remote server';
  const masked = maskConfiguredSecrets(echoed, env);
  assert.equal(masked.includes('my_top_secret_token_12345'), false);
  assert.equal(masked.includes('xy'), false);
  assert.match(
    masked,
    /Failed to authenticate with \[REDACTED\] and token \[REDACTED\] on remote server/,
  );
});

test('setWorkspaceEnvVar, unsetWorkspaceEnvVar and setWorkspaceJdk preserve unrelated fields and each other', async () => {
  const configDir = join(tmpdir(), `omp-test-ws-env-${Math.random().toString(36).slice(2)}`);
  const projDir = join(tmpdir(), `omp-test-ws-proj-${Math.random().toString(36).slice(2)}`);
  const jdk21 = join(tmpdir(), `omp-test-jdk-${Math.random().toString(36).slice(2)}`);

  try {
    await mkdir(configDir, { recursive: true });
    await mkdir(projDir, { recursive: true });
    await createMockJdk(jdk21, { version: '21.0.4' });

    // 1. Set JDK first
    await setWorkspaceJdk(projDir, jdk21, { configDir });

    // 2. Set an environment variable; verify JDK and custom fields are preserved
    const envRes1 = await setWorkspaceEnvVar(projDir, 'HTTP_PROXY', 'http://127.0.0.1:8080', {
      configDir,
    });
    assert.equal(envRes1.name, 'HTTP_PROXY');
    assert.equal(envRes1.maskedValue, '***');
    assert.deepEqual(envRes1.savedEnvKeys, ['HTTP_PROXY']);

    let info = await getWorkspaceInfo(projDir, { configDir });
    assert.equal(resolve(info.savedJdk || '').toLowerCase(), resolve(jdk21).toLowerCase());
    assert.equal(info.savedVersion, '21.0.4');
    assert.deepEqual(info.savedEnvKeys, ['HTTP_PROXY']);
    assert.deepEqual(info.maskedEnv, { HTTP_PROXY: '***' });

    // 3. Add second env variable
    await setWorkspaceEnvVar(projDir, 'GRADLE_OPTS', '-Dorg.gradle.daemon=true', { configDir });
    info = await getWorkspaceInfo(projDir, { configDir });
    assert.deepEqual(info.savedEnvKeys, ['GRADLE_OPTS', 'HTTP_PROXY']);

    // 4. Update JDK; verify env is preserved!
    await setWorkspaceJdk(projDir, jdk21, { configDir });
    info = await getWorkspaceInfo(projDir, { configDir });
    assert.deepEqual(info.savedEnvKeys, ['GRADLE_OPTS', 'HTTP_PROXY']);
    assert.equal(resolve(info.savedJdk || '').toLowerCase(), resolve(jdk21).toLowerCase());

    // 5. Unset one env var
    const unsetRes = await unsetWorkspaceEnvVar(projDir, 'HTTP_PROXY', { configDir });
    assert.equal(unsetRes.wasSet, true);
    assert.deepEqual(unsetRes.savedEnvKeys, ['GRADLE_OPTS']);

    info = await getWorkspaceInfo(projDir, { configDir });
    assert.deepEqual(info.savedEnvKeys, ['GRADLE_OPTS']);
    assert.equal(resolve(info.savedJdk || '').toLowerCase(), resolve(jdk21).toLowerCase());

    // 6. Unset non-existent env var
    const unsetRes2 = await unsetWorkspaceEnvVar(projDir, 'NON_EXISTENT', { configDir });
    assert.equal(unsetRes2.wasSet, false);
    assert.deepEqual(unsetRes2.savedEnvKeys, ['GRADLE_OPTS']);

    // 7. Unset the remaining env var; the saved JDK must survive an empty env map
    const unsetLast = await unsetWorkspaceEnvVar(projDir, 'GRADLE_OPTS', { configDir });
    assert.equal(unsetLast.wasSet, true);
    assert.deepEqual(unsetLast.savedEnvKeys, []);
    info = await getWorkspaceInfo(projDir, { configDir });
    assert.deepEqual(info.savedEnvKeys, []);
    assert.equal(resolve(info.savedJdk || '').toLowerCase(), resolve(jdk21).toLowerCase());
    assert.equal(info.savedVersion, '21.0.4');
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
    await rm(jdk21, { recursive: true, force: true });
  }
});

test('applyWorkspaceOptions applies env-only configuration without saved JDK and never mutates process.env', async () => {
  const configDir = join(tmpdir(), `omp-test-ws-env-only-${Math.random().toString(36).slice(2)}`);
  const projDir = join(
    tmpdir(),
    `omp-test-ws-proj-env-only-${Math.random().toString(36).slice(2)}`,
  );

  try {
    await mkdir(configDir, { recursive: true });
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'pom.xml'), '<project></project>', 'utf8');

    // Only set env, NO JDK configured
    await setWorkspaceEnvVar(projDir, 'MAVEN_OPTS', '-Xmx2g', { configDir });

    const envKeysBefore = Object.keys(process.env).sort();
    const envHashBefore = JSON.stringify(Object.entries(process.env).sort());

    const initialOptions = {
      eulaHash: 'cd82e6cdaf2790f1',
      projects: [
        {
          path: projDir,
          type: 'maven',
          env: { HOST_VAR: 'host_val' },
        },
      ],
    };

    const result = await applyWorkspaceOptions(projDir, initialOptions, { configDir });
    const projects = result.projects as Array<Record<string, unknown>>;
    assert.equal(projects.length, 1);
    const p = projects[0];
    assert.equal(p['java-home'], undefined); // No saved JDK, so java-home remains untouched
    assert.deepEqual(p.env, {
      HOST_VAR: 'host_val',
      MAVEN_OPTS: '-Xmx2g',
    });

    // Ensure process.env was NEVER mutated (using keys and hash comparison, no credential dumping)
    const envKeysAfter = Object.keys(process.env).sort();
    const envHashAfter = JSON.stringify(Object.entries(process.env).sort());
    assert.deepEqual(envKeysAfter, envKeysBefore);
    assert.equal(envHashAfter === envHashBefore, true);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
  }
});

test('applyWorkspaceOptions isolates multiple projects and prevents cross-project env pollution', async () => {
  const configDir = join(tmpdir(), `omp-test-ws-iso-${Math.random().toString(36).slice(2)}`);
  const projA = join(tmpdir(), `omp-test-proj-a-${Math.random().toString(36).slice(2)}`);
  const projB = join(tmpdir(), `omp-test-proj-b-${Math.random().toString(36).slice(2)}`);

  try {
    await mkdir(configDir, { recursive: true });
    await mkdir(projA, { recursive: true });
    await mkdir(projB, { recursive: true });
    await writeFile(join(projA, 'pom.xml'), '<project></project>', 'utf8');
    await writeFile(join(projB, 'build.gradle'), '', 'utf8');

    await setWorkspaceEnvVar(projA, 'PROJECT_SCOPE', 'scope_a', { configDir });
    await setWorkspaceEnvVar(projB, 'PROJECT_SCOPE', 'scope_b', { configDir });

    const initialOptions = {
      projects: [
        { path: projA, type: 'maven', env: { DEFAULT_KEY: 'shared' } },
        { path: projB, type: 'gradle', env: { DEFAULT_KEY: 'shared' } },
      ],
    };

    // Apply options for Project A only
    const resA = await applyWorkspaceOptions(projA, initialOptions, { configDir });
    const projsA = resA.projects as Array<Record<string, unknown>>;

    assert.deepEqual(projsA[0].env, {
      DEFAULT_KEY: 'shared',
      PROJECT_SCOPE: 'scope_a',
    });
    // Project B must NOT have Project A's env
    assert.deepEqual(projsA[1].env, {
      DEFAULT_KEY: 'shared',
    });

    // Apply options for Project B
    const resB = await applyWorkspaceOptions(projB, resA, { configDir });
    const projsB = resB.projects as Array<Record<string, unknown>>;

    assert.deepEqual(projsB[0].env, {
      DEFAULT_KEY: 'shared',
      PROJECT_SCOPE: 'scope_a',
    });
    assert.deepEqual(projsB[1].env, {
      DEFAULT_KEY: 'shared',
      PROJECT_SCOPE: 'scope_b',
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(projA, { recursive: true, force: true });
    await rm(projB, { recursive: true, force: true });
  }
});

test('applyWorkspaceOptions enforces JDK authoritative precedence over conflicting env JAVA_HOME', async () => {
  const configDir = join(tmpdir(), `omp-test-ws-prec-${Math.random().toString(36).slice(2)}`);
  const projDir = join(tmpdir(), `omp-test-proj-prec-${Math.random().toString(36).slice(2)}`);
  const validJdk = join(tmpdir(), `omp-test-jdk-valid-${Math.random().toString(36).slice(2)}`);

  try {
    await mkdir(configDir, { recursive: true });
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'pom.xml'), '<project></project>', 'utf8');
    await createMockJdk(validJdk, { version: '21.0.4' });

    await setWorkspaceJdk(projDir, validJdk, { configDir });
    // Attempt to set conflicting JAVA_HOME in env
    await setWorkspaceEnvVar(projDir, 'JAVA_HOME', '/conflicting/env/jdk', { configDir });
    await setWorkspaceEnvVar(projDir, 'CUSTOM_VAR', 'hello', { configDir });

    const initialOptions = {
      projects: [{ path: projDir, type: 'maven', env: { JAVA_HOME: '/host/jdk' } }],
    };

    const result = await applyWorkspaceOptions(projDir, initialOptions, { configDir });
    const projects = result.projects as Array<Record<string, unknown>>;
    const p = projects[0];

    // Configured JDK must win over env JAVA_HOME
    assert.equal(resolve(p['java-home'] as string).toLowerCase(), resolve(validJdk).toLowerCase());
    const env = p.env as Record<string, string>;
    assert.equal(resolve(env.JAVA_HOME).toLowerCase(), resolve(validJdk).toLowerCase());
    assert.equal(env.CUSTOM_VAR, 'hello');
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
    await rm(validJdk, { recursive: true, force: true });
  }
});

test('applyWorkspaceOptions with raw host options cleans up unset env vars', async () => {
  const configDir = join(tmpdir(), `omp-test-ws-unset-${Math.random().toString(36).slice(2)}`);
  const projDir = join(tmpdir(), `omp-test-ws-proj-unset-${Math.random().toString(36).slice(2)}`);

  try {
    await mkdir(configDir, { recursive: true });
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'pom.xml'), '<project></project>', 'utf8');

    const rawHostOptions = {
      projects: [
        {
          path: projDir,
          type: 'maven',
          env: {
            HOST_STATIC: 'keep_me',
          },
        },
      ],
    };

    // 1. Set env
    await setWorkspaceEnvVar(projDir, 'DYNAMIC_OPT', 'value-1', { configDir });
    const firstPass = await applyWorkspaceOptions(projDir, rawHostOptions, { configDir });
    const firstProj = (firstPass.projects as Array<Record<string, unknown>>)[0];
    const firstEnv = firstProj.env as Record<string, string>;
    assert.equal(firstEnv.DYNAMIC_OPT, 'value-1');
    assert.equal(firstEnv.HOST_STATIC, 'keep_me');

    // 2. Unset DYNAMIC_OPT
    await unsetWorkspaceEnvVar(projDir, 'DYNAMIC_OPT', { configDir });

    // 3. Reapply using raw host options
    const secondPass = await applyWorkspaceOptions(projDir, rawHostOptions, { configDir });
    const secondProj = (secondPass.projects as Array<Record<string, unknown>>)[0];
    const secondEnv = secondProj.env as Record<string, string>;

    // DYNAMIC_OPT must be gone!
    assert.equal(secondEnv.DYNAMIC_OPT, undefined);
    assert.equal(secondEnv.HOST_STATIC, 'keep_me');
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
  }
});

test('getWorkspaceInfo accurately tracks persistent importStatus receipt and marks pending if config changed', async () => {
  const configDir = join(tmpdir(), `omp-test-ws-status-${Math.random().toString(36).slice(2)}`);
  const systemPath = join(tmpdir(), `omp-test-sys-status-${Math.random().toString(36).slice(2)}`);
  const projDir = join(tmpdir(), `omp-test-proj-status-${Math.random().toString(36).slice(2)}`);

  try {
    await mkdir(configDir, { recursive: true });
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'pom.xml'), '<project></project>', 'utf8');

    // 1. Save config; initially no receipt exists -> status: 'pending'
    await setWorkspaceEnvVar(projDir, 'HTTP_PROXY', 'http://127.0.0.1:8080', { configDir });
    let info = await getWorkspaceInfo(projDir, { configDir, systemPath });
    assert.equal(info.importStatus?.status, 'pending');
    assert.equal(info.importStatus?.stage, 'saved');

    // 2. Simulate successful reload receipt matching config revision
    const receiptsDir = join(systemPath, 'plugin-metadata', 'receipts');
    await mkdir(receiptsDir, { recursive: true });
    const { canonicalizeProject } = await import('../src/project/metadata.js');
    const { id } = canonicalizeProject(projDir);
    const importReceiptPath = join(receiptsDir, `${id}.import-status.json`);

    const receiptDoc = {
      id,
      canonicalPath: projDir,
      status: 'applied',
      stage: 'ready',
      revision: info.importStatus?.updatedAt || Date.now(),
      submittedEnvKeys: ['HTTP_PROXY'],
      appliedJdk: null,
      verifiedJdk: false,
      failure: null,
      timestamp: Date.now(),
    };
    await writeFile(importReceiptPath, JSON.stringify(receiptDoc), 'utf8');

    info = await getWorkspaceInfo(projDir, { configDir, systemPath });
    assert.equal(info.importStatus?.status, 'applied');
    assert.equal(info.importStatus?.stage, 'ready');
    assert.deepEqual(info.importStatus?.submittedEnvKeys, ['HTTP_PROXY']);

    // 3. Simulate config updated after receipt (receipt revision is older than saved.updatedAt) -> status: 'pending'
    const olderReceiptDoc = {
      ...receiptDoc,
      revision: receiptDoc.revision - 100,
    };
    await writeFile(importReceiptPath, JSON.stringify(olderReceiptDoc), 'utf8');
    info = await getWorkspaceInfo(projDir, { configDir, systemPath });
    assert.equal(info.importStatus?.status, 'pending');
    assert.equal(info.importStatus?.stage, 'saved');

    // 4. Simulate failed reload receipt at connect stage matching current config revision
    const failDoc = {
      id,
      canonicalPath: projDir,
      status: 'failed',
      stage: 'connect',
      revision: receiptDoc.revision,
      submittedEnvKeys: [],
      appliedJdk: null,
      verifiedJdk: false,
      failure: { stage: 'connect', message: 'connection refused to server PID 9999' },
      timestamp: Date.now(),
    };
    await writeFile(importReceiptPath, JSON.stringify(failDoc), 'utf8');

    info = await getWorkspaceInfo(projDir, { configDir, systemPath });
    assert.equal(info.importStatus?.status, 'failed');
    assert.equal(info.importStatus?.stage, 'connect');
    assert.equal(info.importStatus?.failure?.message, 'connection refused to server PID 9999');
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(systemPath, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
  }
});
test('canonicalizeProject respects case sensitivity options and platform semantics', () => {
  const projUpper = '/repo/MyProject';
  const projLower = '/repo/myproject';

  const sensUpper = canonicalizeProject(projUpper, { caseSensitive: true });
  const sensLower = canonicalizeProject(projLower, { caseSensitive: true });
  assert.notEqual(sensUpper.id, sensLower.id);
  assert.equal(sensUpper.legacyId, sensLower.legacyId);
  assert.equal(pathsEqual(projUpper, projLower, { caseSensitive: true }), false);

  const insensUpper = canonicalizeProject(projUpper, { caseSensitive: false });
  const insensLower = canonicalizeProject(projLower, { caseSensitive: false });
  assert.equal(insensUpper.id, insensLower.id);
  assert.equal(pathsEqual(projUpper, projLower, { caseSensitive: false }), true);
});

test('readWorkspaceConfig migrates legacy lowercase config when path attribution matches', async () => {
  const configDir = join(tmpdir(), `omp-cfg-mig-${Math.random().toString(36).slice(2)}`);
  await mkdir(configDir, { recursive: true });
  const projPath = '/repo/TargetApp';
  const canonical = canonicalizeProject(projPath, { caseSensitive: true });

  try {
    const legacyFile = join(configDir, `${canonical.legacyId}.json`);
    const legacyData = {
      id: canonical.legacyId,
      canonicalPath: canonical.canonicalPath,
      nativePath: canonical.nativePath,
      rootUri: canonical.rootUri,
      javaHome: '/opt/jdks/jdk-21',
      env: { MIGRATED_KEY: 'migrated_val' },
      updatedAt: 1000,
    };
    await writeFile(legacyFile, JSON.stringify(legacyData), 'utf8');

    const result = await readWorkspaceConfig(configDir, canonical);
    assert.ok(result);
    assert.equal(result?.id, canonical.id);
    assert.equal(result?.canonicalPath, canonical.canonicalPath);
    assert.equal(result?.env?.MIGRATED_KEY, 'migrated_val');

    const migratedFile = join(configDir, `${canonical.id}.json`);
    const rawMigrated = await readFile(migratedFile, 'utf8');
    const parsedMigrated = JSON.parse(rawMigrated) as { id: string; env?: Record<string, string> };
    assert.equal(parsedMigrated.id, canonical.id);
    assert.equal(parsedMigrated.env?.MIGRATED_KEY, 'migrated_val');
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('readWorkspaceConfig isolates legacy lowercase config when path belongs to different casing', async () => {
  const configDir = join(tmpdir(), `omp-cfg-iso-${Math.random().toString(36).slice(2)}`);
  await mkdir(configDir, { recursive: true });
  const targetProject = '/repo/caseproject';
  const otherProject = '/repo/CaseProject';

  const targetCanonical = canonicalizeProject(targetProject, { caseSensitive: true });
  const otherCanonical = canonicalizeProject(otherProject, { caseSensitive: true });

  try {
    const legacyFile = join(configDir, `${targetCanonical.legacyId}.json`);
    const legacyData = {
      id: targetCanonical.legacyId,
      canonicalPath: otherCanonical.canonicalPath,
      nativePath: otherCanonical.nativePath,
      rootUri: otherCanonical.rootUri,
      javaHome: '/opt/jdks/other-jdk',
      env: { OTHER_KEY: 'other_val' },
      updatedAt: 1000,
    };
    await writeFile(legacyFile, JSON.stringify(legacyData), 'utf8');

    const result = await readWorkspaceConfig(configDir, targetCanonical);
    assert.equal(result, null);

    const otherResult = await readWorkspaceConfig(configDir, otherCanonical);
    assert.ok(otherResult);
    assert.equal(otherResult?.canonicalPath, otherCanonical.canonicalPath);
    assert.equal(otherResult?.env?.OTHER_KEY, 'other_val');
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('project ledgers migrate by recorded ownership and preserve filesystem case semantics', async () => {
  const systemPath = join(tmpdir(), `omp-ledger-migrate-${Math.random().toString(36).slice(2)}`);
  const projectsDir = join(systemPath, 'plugin-metadata', 'projects');
  const projectUpper = join(systemPath, 'LedgerProject');
  const projectLower = join(systemPath, 'ledgerproject');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(projectUpper, { recursive: true });
  await mkdir(projectLower, { recursive: true });
  const canonicalUpper = canonicalizeProject(projectUpper);
  try {
    await writeFile(
      join(projectsDir, `${canonicalUpper.legacyId}.events.jsonl`),
      `${JSON.stringify({
        id: canonicalUpper.legacyId,
        canonicalPath: canonicalUpper.canonicalPath,
        nativePath: canonicalUpper.nativePath,
        rootUri: canonicalUpper.rootUri,
        kind: 'connection',
        at: 5000,
      })}\n`,
    );
    const ledgerUpper = await getProjectLedger(systemPath, projectUpper);
    assert.equal(ledgerUpper?.canonicalPath, canonicalUpper.canonicalPath);
    assert.equal(ledgerUpper?.lastConnected, 5000);
    const ledgerLower = await getProjectLedger(systemPath, projectLower);
    if (pathsEqual(projectUpper, projectLower)) {
      assert.equal(ledgerLower?.lastConnected, 5000);
    } else {
      assert.equal(ledgerLower, null);
    }
  } finally {
    await rm(systemPath, { recursive: true, force: true });
  }
});
test('migrateProjectMetadata safely migrates raw-config, initialize, receipts and events on path attribution match', async () => {
  const systemPath = join(tmpdir(), `omp-meta-mig-${Math.random().toString(36).slice(2)}`);
  const metaDir = join(systemPath, 'plugin-metadata');
  const rawConfigDir = join(metaDir, 'raw-config');
  const receiptsDir = join(metaDir, 'receipts');

  await mkdir(rawConfigDir, { recursive: true });
  await mkdir(receiptsDir, { recursive: true });

  const proj = '/repo/TargetService';
  const canonical = canonicalizeProject(proj, { caseSensitive: true });
  const legacyId = canonical.legacyId ?? 'legacy-id';

  await writeFile(
    join(rawConfigDir, `${legacyId}.json`),
    JSON.stringify({
      id: legacyId,
      projectPath: canonical.nativePath,
      __metadata: { id: legacyId, canonicalPath: canonical.canonicalPath },
      settings: { 'java.home': '/opt/jdk' },
    }),
    'utf8',
  );

  await writeFile(
    join(metaDir, `initialize-${legacyId}.json`),
    JSON.stringify({
      id: legacyId,
      rootUri: canonical.rootUri,
      initializationOptions: { test: true },
    }),
    'utf8',
  );

  await writeFile(
    join(receiptsDir, `${legacyId}.applied.json`),
    JSON.stringify({
      id: legacyId,
      canonicalPath: canonical.canonicalPath,
      appliedJdk: '/opt/jdk',
    }),
    'utf8',
  );

  await writeFile(
    join(receiptsDir, `${legacyId}.import-status.json`),
    JSON.stringify({
      id: legacyId,
      status: 'applied',
    }),
    'utf8',
  );

  try {
    await migrateProjectMetadata(systemPath, canonical);

    const rawTarget = await readFile(join(rawConfigDir, `${canonical.id}.json`), 'utf8');
    const parsedRaw = JSON.parse(rawTarget) as { id: string; __metadata?: { id?: string } };
    assert.equal(parsedRaw.id, canonical.id);
    assert.equal(parsedRaw.__metadata?.id, canonical.id);

    const initTarget = await readFile(join(metaDir, `initialize-${canonical.id}.json`), 'utf8');
    const parsedInit = JSON.parse(initTarget) as { id: string };
    assert.equal(parsedInit.id, canonical.id);

    const receiptTarget = await readFile(join(receiptsDir, `${canonical.id}.applied.json`), 'utf8');
    const parsedReceipt = JSON.parse(receiptTarget) as { id: string };
    assert.equal(parsedReceipt.id, canonical.id);

    const importTargetExists = existsSync(join(receiptsDir, `${canonical.id}.import-status.json`));
    assert.equal(importTargetExists, false);

    assert.ok(existsSync(join(rawConfigDir, `${legacyId}.json`)));
  } finally {
    await rm(systemPath, { recursive: true, force: true });
  }
});

test('linked worktrees only inherit an attributed ready source URI and preserve explicit options', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'omp-worktree-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  const linked = join(root, 'linked');
  const systemPath = join(root, 'system');
  const configDir = join(root, 'profiles');
  await mkdir(main);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', main, ...args], { encoding: 'utf8', windowsHide: true });
  git('init', '--quiet');
  await writeFile(join(main, 'marker'), 'worktree fixture');
  git('add', 'marker');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@localhost',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  git('worktree', 'add', '--quiet', '-b', 'linked', linked);
  const options = { systemPath, configDir };
  assert.equal((await applyWorkspaceOptions(linked, {}, options)).fromWorkspace, undefined);
  const source = canonicalizeProject(main);
  const metadata = join(systemPath, 'plugin-metadata');
  await mkdir(metadata, { recursive: true });
  const record = join(metadata, `initialize-${source.id}.json`);
  const originalUri = pathToFileURL(main).href;
  await writeFile(record, JSON.stringify({ rootUri: originalUri }));
  assert.equal((await applyWorkspaceOptions(linked, {}, options)).fromWorkspace, undefined);
  await recordReadiness(systemPath, main);
  assert.equal((await applyWorkspaceOptions(linked, {}, options)).fromWorkspace, originalUri);
  assert.equal((await applyWorkspaceOptions(main, {}, options)).fromWorkspace, undefined);
  assert.equal(
    (await applyWorkspaceOptions(linked, { fromWorkspace: null }, options)).fromWorkspace,
    null,
  );
  const explicit = 'file:///explicit-source';
  assert.equal(
    (await applyWorkspaceOptions(linked, { fromWorkspace: explicit }, options)).fromWorkspace,
    explicit,
  );
  await writeFile(record, JSON.stringify({ rootUri: pathToFileURL(linked).href }));
  assert.equal((await applyWorkspaceOptions(linked, {}, options)).fromWorkspace, undefined);
});

test('process exit releases only this process leases across multiple registered system paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-exit-lease-'));
  const sys1 = join(root, 'sys1');
  const sys2 = join(root, 'sys2');
  const sys1Leases = join(sys1, 'plugin-metadata', 'leases');
  const sys2Leases = join(sys2, 'plugin-metadata', 'leases');

  await mkdir(sys1Leases, { recursive: true });
  await mkdir(sys2Leases, { recursive: true });

  const foreignLease = join(sys1Leases, 'foreign.json');
  await writeFile(foreignLease, JSON.stringify({ id: 'foreign', pid: 999999 }), 'utf8');

  const workspaceModuleUrl = new URL('../src/project/workspace.js', import.meta.url).href;

  const childScript = `
    import { registerSystemPath } from ${JSON.stringify(workspaceModuleUrl)};
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';

    const sys1 = ${JSON.stringify(sys1)};
    const sys2 = ${JSON.stringify(sys2)};

    registerSystemPath(sys1);
    registerSystemPath(sys2);
    ${process.platform === 'win32' ? `registerSystemPath(sys1.toUpperCase());` : ''}

    writeFileSync(join(sys1, 'plugin-metadata', 'leases', 'child1.json'), JSON.stringify({ id: 'c1', pid: process.pid }), 'utf8');
    writeFileSync(join(sys2, 'plugin-metadata', 'leases', 'child2.json'), JSON.stringify({ id: 'c2', pid: process.pid }), 'utf8');

    process.exit(0);
  `;

  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', childScript], {
      windowsHide: true,
      encoding: 'utf8',
    });

    const child1Lease = join(sys1Leases, 'child1.json');
    const child2Lease = join(sys2Leases, 'child2.json');

    assert.equal(existsSync(child1Lease), false, 'sys1 child lease must be cleaned up on exit');
    assert.equal(existsSync(child2Lease), false, 'sys2 child lease must be cleaned up on exit');
    assert.equal(existsSync(foreignLease), true, 'foreign lease must be preserved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace operations register systemPath for child process exit cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-op-exit-lease-'));
  const sys = join(root, 'sys');
  const leasesDir = join(sys, 'plugin-metadata', 'leases');
  await mkdir(leasesDir, { recursive: true });

  const workspaceModuleUrl = new URL('../src/project/workspace.js', import.meta.url).href;

  const childScript = `
    import { getWorkspaceInfo } from ${JSON.stringify(workspaceModuleUrl)};
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';

    const sys = ${JSON.stringify(sys)};

    await getWorkspaceInfo('F:/fake/project', { systemPath: sys }).catch(() => {});

    writeFileSync(join(sys, 'plugin-metadata', 'leases', 'child.json'), JSON.stringify({ id: 'child-lease', pid: process.pid }), 'utf8');

    process.exit(0);
  `;

  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', childScript], {
      windowsHide: true,
      encoding: 'utf8',
    });

    const childLease = join(leasesDir, 'child.json');
    assert.equal(
      existsSync(childLease),
      false,
      'lease in workspace-registered systemPath must be cleaned up on exit',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reimportWorkspace validates project root and records failed connection receipt on unreachable server', async () => {
  await assert.rejects(async () => reimportWorkspace(''), /Project root is required/);

  const tmpRoot = await mkdtemp(join(tmpdir(), 'omp-reimport-test-'));
  try {
    const systemPath = join(tmpRoot, 'system');
    const projectRoot = join(tmpRoot, 'proj');
    await mkdir(systemPath, { recursive: true });
    await mkdir(projectRoot, { recursive: true });

    await assert.rejects(async () =>
      reimportWorkspace(projectRoot, {
        systemPath,
        timeoutMs: 500,
      }),
    );

    const receiptsDir = join(systemPath, 'plugin-metadata', 'receipts');
    const canonical = canonicalizeProject(cleanPath(projectRoot));
    const receiptFile = join(receiptsDir, `${canonical.id}.import-status.json`);
    assert.equal(existsSync(receiptFile), true);
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.stage, 'connect');
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
