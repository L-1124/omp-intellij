import { resolve } from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

export async function runSmokeTests(files) {
  if (files.length === 0) throw new Error('Smoke selection requires at least one test file');
  const expected = new Set(files.map((file) => resolve(file)));
  const passed = new Set();
  let failed = false;
  const tests = run({
    files: [...expected],
    concurrency: 1,
    timeout: 180000,
    testNamePatterns: [/\[smoke\]/],
  });
  tests.on('test:fail', () => {
    failed = true;
  });
  tests.on('test:pass', (result) => {
    if (result.name.includes('[smoke]') && result.file && !result.skip && !result.todo) {
      passed.add(resolve(result.file));
    }
  });
  for await (const chunk of tests.compose(spec)) process.stdout.write(chunk);
  // Node can report a file as passing even when its name filter matched no actual test.
  const missing = [...expected].filter((file) => !passed.has(file));
  if (missing.length) console.error(`Smoke coverage missing in: ${missing.join(', ')}`);
  return failed || missing.length > 0 ? 1 : 0;
}
