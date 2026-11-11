#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveIlsJbr, setupDevEnvironment } from './setup-dev-env.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const GRADLE_PROJECT_DIR = join(REPO_ROOT, 'jvm', 'intellij-android');

export function isValidJavaHome(dir) {
  if (!dir || typeof dir !== 'string') return false;
  const isWin = process.platform === 'win32';
  const javaExe = join(dir, 'bin', isWin ? 'java.exe' : 'java');
  try {
    return existsSync(javaExe) && statSync(javaExe).isFile();
  } catch {
    return false;
  }
}

export function resolveGradleEnvironment(ilsHome, env = process.env) {
  const jbrHome = resolveIlsJbr(ilsHome);
  const targetEnv = { ...env };

  let javaExe = null;
  if (jbrHome) {
    targetEnv.JAVA_HOME = jbrHome;
    const binDir = join(jbrHome, 'bin');
    const pathKey =
      process.platform === 'win32'
        ? Object.keys(targetEnv).find((k) => k.toLowerCase() === 'path') || 'Path'
        : 'PATH';
    const currentPath = targetEnv[pathKey] || '';
    targetEnv[pathKey] = currentPath ? `${binDir}${delimiter}${currentPath}` : binDir;
    javaExe = join(binDir, process.platform === 'win32' ? 'java.exe' : 'java');
  } else if (isValidJavaHome(targetEnv.JAVA_HOME)) {
    javaExe = join(targetEnv.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  } else {
    throw new Error(
      `No valid Java 25 / JBR runtime found at ILS installation (${ilsHome}) and environment JAVA_HOME (${targetEnv.JAVA_HOME}) is invalid.`,
    );
  }

  return { env: targetEnv, javaExe, ilsHome, jbrHome };
}

export async function runGradle(args = [], { explicitHome } = {}) {
  const { ilsHome } = await setupDevEnvironment({ explicitHome });
  const { env: gradleEnv, javaExe } = resolveGradleEnvironment(ilsHome);
  const wrapperJar = join(GRADLE_PROJECT_DIR, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  const childArgs = ['-Dorg.gradle.appname=gradlew', '-jar', wrapperJar, ...args];

  const res = spawnSync(javaExe, childArgs, {
    cwd: GRADLE_PROJECT_DIR,
    env: gradleEnv,
    stdio: 'inherit',
  });

  if (res.error) {
    console.error(`[run-gradle] Failed to execute Gradle: ${res.error.message}`);
    return 1;
  }

  if (res.status === null) {
    console.error(
      `[run-gradle] Gradle terminated without exit code${res.signal ? ` (signal: ${res.signal})` : ''}`,
    );
    return 1;
  }

  return res.status;
}

export async function main(argv = process.argv.slice(2)) {
  const { explicitHome, remaining } = parseArgs(argv);
  const args = remaining.length > 0 ? remaining : ['stageExtension', '--no-daemon'];
  const exitCode = await runGradle(args, { explicitHome });
  return exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error(`[run-gradle] ERROR: ${err.message}`);
      process.exit(1);
    });
}
