import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { executeBuild } from '../src/debug/run-core.js';
import {
  applyWorkspaceOptions,
  cleanPath,
  detectProjectType,
  discoverJdks,
  getWorkspaceInfo,
  maskConfiguredSecrets,
  maskEnvValue,
  setWorkspaceEnvVar,
  setWorkspaceJdk,
  unsetWorkspaceEnvVar,
  validateEnvMap,
  validateJdk,
} from '../src/project/workspace.js';
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
    const releaseContent =
      [
        `IMPLEMENTOR="${implementor}"`,
        `JAVA_VERSION="${ver}"`,
        'OS_ARCH="x86_64"',
        `OS_NAME="${process.platform === 'win32' ? 'Windows' : 'Linux'}"`,
      ].join('\n') + '\n';
    await writeFile(join(dir, 'release'), releaseContent, 'utf8');
  }
}

test('cleanPath removes surrounding quotes and whitespace', () => {
  assert.equal(cleanPath('  "C:/Program Files/Java"  '), 'C:/Program Files/Java');
  assert.equal(cleanPath("  'F:/toolchains/jdk'  "), 'F:/toolchains/jdk');
  assert.equal(cleanPath('/plain/path'), '/plain/path');
});

test('validateJdk verifies bin/java, bin/javac, and release file', async () => {
  const tmp = join(tmpdir(), 'omp-test-jdk-' + Math.random().toString(36).slice(2));
  try {
    await createMockJdk(tmp, { version: '21.0.4', implementor: 'Eclipse Adoptium' });
    const validated = validateJdk(tmp);
    assert.equal(validated.javaVersion, '21.0.4');
    assert.equal(resolve(validated.javaHome).toLowerCase(), resolve(tmp).toLowerCase());
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('validateJdk rejects malformed JAVA_VERSION in release file', async () => {
  const tmp = join(tmpdir(), 'omp-test-jdk-malformed-' + Math.random().toString(36).slice(2));
  try {
    await createMockJdk(tmp, { malformedVersion: true });
    assert.throws(() => validateJdk(tmp), /malformed JAVA_VERSION/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('validateJdk accepts path with spaces', async () => {
  const tmp = join(tmpdir(), 'omp test jdk ' + Math.random().toString(36).slice(2));
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
  const realDir = join(tmpdir(), 'omp-test-jdk-real-' + Math.random().toString(36).slice(2));
  const linkDir = join(tmpdir(), 'omp-test-jdk-link-' + Math.random().toString(36).slice(2));
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
  const tmp = join(tmpdir(), 'omp-test-proj-' + Math.random().toString(36).slice(2));
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
  const configDir = join(tmpdir(), 'omp-test-cfg-' + Math.random().toString(36).slice(2));
  const projDir = join(tmpdir(), 'omp test proj ' + Math.random().toString(36).slice(2));
  const validJdk = join(tmpdir(), 'omp-valid-jdk-' + Math.random().toString(36).slice(2));
  const invalidJdk = join(tmpdir(), 'omp-invalid-jdk-' + Math.random().toString(36).slice(2));

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
  const configDir = join(tmpdir(), 'omp-test-cfg2-' + Math.random().toString(36).slice(2));
  const systemPath = join(tmpdir(), 'omp-test-sys2-' + Math.random().toString(36).slice(2));
  const projDir = join(tmpdir(), 'omp-test-proj2-' + Math.random().toString(36).slice(2));
  const jdk21 = join(tmpdir(), 'omp-test-jdk21-' + Math.random().toString(36).slice(2));

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
  const configDir = join(tmpdir(), 'omp-test-cfg-unconf-' + Math.random().toString(36).slice(2));
  const projDir = join(tmpdir(), 'omp-test-proj-unconf-' + Math.random().toString(36).slice(2));

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
  const configDir = join(tmpdir(), 'omp-test-cfg-unk-' + Math.random().toString(36).slice(2));
  const projDir = join(tmpdir(), 'omp-test-proj-unk-' + Math.random().toString(36).slice(2));
  const jdk21 = join(tmpdir(), 'omp-test-jdk-unk-' + Math.random().toString(36).slice(2));

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
  const configDir = join(tmpdir(), 'omp-test-cfg3-' + Math.random().toString(36).slice(2));
  const projDir = join(tmpdir(), 'omp-test-proj3-' + Math.random().toString(36).slice(2));
  const jdk21 = join(tmpdir(), 'omp-test-jdk21-3-' + Math.random().toString(36).slice(2));

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
  const root = join(tmpdir(), 'omp-test-store-' + Math.random().toString(36).slice(2));
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

test('executeBuild integrates managed JDK and prepends effective JAVA_HOME to PATH', async () => {
  const configDir = join(tmpdir(), 'omp-test-cfg-eb-' + Math.random().toString(36).slice(2));
  const projDir = join(tmpdir(), 'omp-test-proj-eb-' + Math.random().toString(36).slice(2));
  const jdk21 = join(tmpdir(), 'omp-test-jdk21-eb-' + Math.random().toString(36).slice(2));

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
  const configDir = join(tmpdir(), 'omp-test-ws-env-' + Math.random().toString(36).slice(2));
  const projDir = join(tmpdir(), 'omp-test-ws-proj-' + Math.random().toString(36).slice(2));
  const jdk21 = join(tmpdir(), 'omp-test-jdk-' + Math.random().toString(36).slice(2));

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
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
    await rm(jdk21, { recursive: true, force: true });
  }
});

test('applyWorkspaceOptions applies env-only configuration without saved JDK and never mutates process.env', async () => {
  const configDir = join(tmpdir(), 'omp-test-ws-env-only-' + Math.random().toString(36).slice(2));
  const projDir = join(
    tmpdir(),
    'omp-test-ws-proj-env-only-' + Math.random().toString(36).slice(2),
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
  const configDir = join(tmpdir(), 'omp-test-ws-iso-' + Math.random().toString(36).slice(2));
  const projA = join(tmpdir(), 'omp-test-proj-a-' + Math.random().toString(36).slice(2));
  const projB = join(tmpdir(), 'omp-test-proj-b-' + Math.random().toString(36).slice(2));

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
  const configDir = join(tmpdir(), 'omp-test-ws-prec-' + Math.random().toString(36).slice(2));
  const projDir = join(tmpdir(), 'omp-test-proj-prec-' + Math.random().toString(36).slice(2));
  const validJdk = join(tmpdir(), 'omp-test-jdk-valid-' + Math.random().toString(36).slice(2));

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
  const configDir = join(tmpdir(), 'omp-test-ws-unset-' + Math.random().toString(36).slice(2));
  const projDir = join(tmpdir(), 'omp-test-ws-proj-unset-' + Math.random().toString(36).slice(2));

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

test('unsetWorkspaceEnvVar cleans up env while preserving JDK and other fields', async () => {
  const configDir = join(tmpdir(), 'omp-test-ws-reset-' + Math.random().toString(36).slice(2));
  const projDir = join(tmpdir(), 'omp-test-ws-proj-reset-' + Math.random().toString(36).slice(2));
  const jdk21 = join(tmpdir(), 'omp-test-jdk-reset-' + Math.random().toString(36).slice(2));

  try {
    await mkdir(configDir, { recursive: true });
    await mkdir(projDir, { recursive: true });
    await createMockJdk(jdk21, { version: '21.0.4' });

    await setWorkspaceJdk(projDir, jdk21, { configDir });
    await setWorkspaceEnvVar(projDir, 'A', '1', { configDir });
    await setWorkspaceEnvVar(projDir, 'B', '2', { configDir });

    let info = await getWorkspaceInfo(projDir, { configDir });
    assert.deepEqual(info.savedEnvKeys, ['A', 'B']);
    assert.equal(resolve(info.savedJdk || '').toLowerCase(), resolve(jdk21).toLowerCase());

    await unsetWorkspaceEnvVar(projDir, 'A', { configDir });
    const unsetRes = await unsetWorkspaceEnvVar(projDir, 'B', { configDir });
    assert.deepEqual(unsetRes.savedEnvKeys, []);

    info = await getWorkspaceInfo(projDir, { configDir });
    assert.deepEqual(info.savedEnvKeys, []);
    assert.equal(resolve(info.savedJdk || '').toLowerCase(), resolve(jdk21).toLowerCase());
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
    await rm(jdk21, { recursive: true, force: true });
  }
});

test('getWorkspaceInfo accurately tracks persistent importStatus receipt and marks pending if config changed', async () => {
  const configDir = join(tmpdir(), 'omp-test-ws-status-' + Math.random().toString(36).slice(2));
  const systemPath = join(tmpdir(), 'omp-test-sys-status-' + Math.random().toString(36).slice(2));
  const projDir = join(tmpdir(), 'omp-test-proj-status-' + Math.random().toString(36).slice(2));

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
