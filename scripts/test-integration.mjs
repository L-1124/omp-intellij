#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSmokeTests } from './integration-smoke.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = ['engineering', 'stability'];

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
  const target = args[0] && !args[0].startsWith('-') ? args.shift() : 'all';
  const smoke = target === 'smoke';
  if (target !== 'all' && !SUITES.includes(target) && !smoke) {
    throw new Error(
      `Unknown integration target "${target}". Expected all, ${SUITES.join(', ')}, smoke.`,
    );
  }
  if (smoke && args.length) {
    throw new Error(
      'Smoke selection is fixed; use test:integration -- <suite> for custom Node filters',
    );
  }
  const suites = target === 'all' || smoke ? SUITES : [target];
  const files = suites.map((suite) => join('dist-test', 'test', 'integration', `${suite}.test.js`));
  const required = [
    'OMP_INTELLIJ_TEST_SERVER',
    'OMP_INTELLIJ_TEST_JDK17',
    'OMP_INTELLIJ_TEST_JDK21',
    'OMP_INTELLIJ_TEST_ACCEPTED_EULA_HASH',
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing integration prerequisites: ${missing.join(', ')}`);

  const compileStatus = compileTests();
  if (compileStatus !== 0) return compileStatus;
  const previousReadOnlyCache = process.env.GRADLE_RO_DEP_CACHE;
  let dependencyCache;
  try {
    const { createRunDependencyCache } = await import('../dist-test/test/integration/fixture.js');
    dependencyCache = await createRunDependencyCache();
    if (dependencyCache) process.env.GRADLE_RO_DEP_CACHE = dependencyCache.dir;
    if (smoke) return await runSmokeTests(files);
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
  } finally {
    if (previousReadOnlyCache === undefined) delete process.env.GRADLE_RO_DEP_CACHE;
    else process.env.GRADLE_RO_DEP_CACHE = previousReadOnlyCache;
    await dependencyCache?.dispose();
  }
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
