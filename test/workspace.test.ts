import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { asyncFramedStream, encode } from '../src/protocol.js';
import { executeBuild } from '../src/run-core.js';
import {
  applyWorkspaceOptions,
  cleanPath,
  detectProjectType,
  discoverJdks,
  getWorkspaceInfo,
  setWorkspaceJdk,
  validateJdk,
} from '../src/workspace.js';

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

    const { canonicalizeProject } = await import('../src/metadata.js');
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
