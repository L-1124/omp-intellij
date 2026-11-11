import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isValidJavaHome, resolveGradleEnvironment } from '../scripts/run-gradle.mjs';
import { parseArgs, resolveIlsJbr, verifyIlsHome } from '../scripts/setup-dev-env.mjs';

test('parseArgs separates --ils-home options from remaining Gradle arguments', () => {
  const result1 = parseArgs(['--ils-home', '/custom/ils', 'test', '--no-daemon']);
  assert.equal(result1.explicitHome, '/custom/ils');
  assert.deepEqual(result1.remaining, ['test', '--no-daemon']);

  const result2 = parseArgs(['--ils-home=/opt/ils-sdk', 'stageExtension']);
  assert.equal(result2.explicitHome, '/opt/ils-sdk');
  assert.deepEqual(result2.remaining, ['stageExtension']);

  const result3 = parseArgs(['--info', 'build']);
  assert.equal(result3.explicitHome, null);
  assert.deepEqual(result3.remaining, ['--info', 'build']);

  assert.throws(() => parseArgs(['--ils-home']), /Missing value for --ils-home/);
  assert.throws(() => parseArgs(['--ils-home', '--other']), /Missing value for --ils-home/);
});

test('verifyIlsHome validates build.txt existence and version matching', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-ils-verify-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  assert.equal(verifyIlsHome(dir, '271.2085.0'), false);

  await writeFile(join(dir, 'build.txt'), 'ILS-271.2085.0\n');
  assert.equal(verifyIlsHome(dir, '271.2085.0'), true);
  assert.equal(verifyIlsHome(dir, '271.9999.0'), false);
});

test('resolveIlsJbr discovers bundled JBR directory', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-jbr-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  assert.equal(resolveIlsJbr(dir), null);

  const isWin = process.platform === 'win32';
  const javaBinary = isWin ? 'java.exe' : 'java';
  await mkdir(join(dir, 'jbr', 'bin'), { recursive: true });
  await writeFile(join(dir, 'jbr', 'bin', javaBinary), 'stub');

  assert.equal(resolveIlsJbr(dir), join(dir, 'jbr'));
});

test('isValidJavaHome validates directory contains platform java binary', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-valid-java-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  assert.equal(isValidJavaHome(dir), false);
  assert.equal(isValidJavaHome(null), false);

  const isWin = process.platform === 'win32';
  const javaBinary = isWin ? 'java.exe' : 'java';
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(join(dir, 'bin', javaBinary), 'stub');
  assert.equal(isValidJavaHome(dir), true);
});

test('resolveGradleEnvironment selects bundled JBR over invalid host JAVA_HOME', async (t) => {
  const ilsDir = await mkdtemp(join(tmpdir(), 'omp-ils-env-'));
  t.after(async () => {
    await rm(ilsDir, { recursive: true, force: true });
  });
  const javaBinary = process.platform === 'win32' ? 'java.exe' : 'java';
  const jbrHome = join(ilsDir, 'jbr');
  await mkdir(join(jbrHome, 'bin'), { recursive: true });
  await writeFile(join(jbrHome, 'bin', javaBinary), 'stub');
  const hostEnv = { JAVA_HOME: '/invalid/host/path/to/java', PATH: '/usr/bin' };

  const selected = resolveGradleEnvironment(ilsDir, hostEnv);
  assert.equal(selected.ilsHome, ilsDir);
  assert.equal(selected.jbrHome, jbrHome);
  assert.equal(selected.env.JAVA_HOME, jbrHome);
  assert.equal(selected.javaExe, join(jbrHome, 'bin', javaBinary));
  assert.equal(hostEnv.JAVA_HOME, '/invalid/host/path/to/java');
});

test('resolveGradleEnvironment throws descriptive error when JBR is missing and JAVA_HOME is invalid', async (t) => {
  const ilsDir = await mkdtemp(join(tmpdir(), 'omp-ils-nojbr-'));
  t.after(async () => {
    await rm(ilsDir, { recursive: true, force: true });
  });

  assert.throws(
    () => resolveGradleEnvironment(ilsDir, { JAVA_HOME: '/invalid/nonexistent' }),
    /No valid Java 25 \/ JBR runtime found at ILS installation/,
  );
});
