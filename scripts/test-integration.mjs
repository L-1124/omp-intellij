#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGradle } from './run-gradle.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = {
  android: ['android-attach'],
  xml: ['android-xml'],
  engineering: ['engineering'],
  stability: ['stability'],
};

function compileTests() {
  const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.test.json'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function main() {
  const args = process.argv.slice(2);
  let noPrepare = args[0] === '--no-prepare';
  if (noPrepare) args.shift();
  const target = args[0] && !args[0].startsWith('-') ? args.shift() : 'all';
  if (args[0] === '--no-prepare') {
    noPrepare = true;
    args.shift();
  }
  if (target !== 'all' && !Object.hasOwn(TARGETS, target)) {
    throw new Error(
      `Unknown integration target "${target}". Expected all, ${Object.keys(TARGETS).join(', ')}.`,
    );
  }
  const files =
    target === 'all'
      ? [join('dist-test', 'test', 'integration', '*.test.js')]
      : TARGETS[target].map((name) => join('dist-test', 'test', 'integration', `${name}.test.js`));
  const required = [
    'OMP_INTELLIJ_TEST_SERVER',
    'OMP_INTELLIJ_TEST_JDK17',
    'OMP_INTELLIJ_TEST_JDK21',
    'OMP_INTELLIJ_TEST_ACCEPTED_EULA_HASH',
  ];
  if (target === 'all' || target === 'android') required.push('OMP_INTELLIJ_TEST_ANDROID_DEVICE');
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (
    (target === 'all' || target === 'android' || target === 'xml') &&
    !process.env.ANDROID_HOME?.trim() &&
    !process.env.ANDROID_SDK_ROOT?.trim()
  ) {
    missing.push('ANDROID_HOME or ANDROID_SDK_ROOT');
  }
  if (missing.length) throw new Error(`Missing integration prerequisites: ${missing.join(', ')}`);

  if (!noPrepare) {
    const compileStatus = compileTests();
    if (compileStatus !== 0) return compileStatus;
    const stageStatus = await runGradle(['stageExtension', '--no-daemon']);
    if (stageStatus !== 0) return stageStatus;
  }
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', '--test-timeout=180000', ...args, ...files],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status === null) {
    throw new Error(
      `Node test runner terminated without an exit code (${result.signal ?? 'unknown signal'})`,
    );
  }
  return result.status;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[test-integration] ${error.message}`);
      process.exitCode = 1;
    });
}
