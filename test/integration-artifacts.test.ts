import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRunArtifactStore } from './integration/run-artifact.js';

const APK_BYTES = Buffer.from('PK\u0003\u0004 fixture apk payload', 'utf8');

test('a captured artifact survives deletion of the sandbox that produced it', async (t) => {
  const store = await createRunArtifactStore();
  const root = await mkdtemp(join(tmpdir(), 'omp-intellij-artifact-reuse-'));
  t.after(async () => {
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const producerSandbox = join(root, 'sandbox-1');
  const producerApk = join(producerSandbox, 'app', 'build', 'outputs', 'apk', 'debug', 'app.apk');
  await mkdir(join(producerSandbox, 'app', 'build', 'outputs', 'apk', 'debug'), {
    recursive: true,
  });
  await writeFile(producerApk, APK_BYTES);
  await store.capture('app-debug.apk', producerApk);

  // The real suite deletes each scenario sandbox before the next scenario runs.
  await rm(producerSandbox, { recursive: true, force: true });
  assert.equal(existsSync(producerApk), false, 'Producer sandbox must be gone before reuse');

  const consumerApk = join(root, 'sandbox-2', 'app', 'build', 'outputs', 'apk', 'debug', 'app.apk');
  assert.equal(
    await store.materialize('app-debug.apk', consumerApk),
    true,
    'A later scenario must be able to materialize the artifact from the store',
  );
  assert.deepEqual(await readFile(consumerApk), APK_BYTES);
  assert.equal(existsSync(store.dir), true, 'Store outlives the producing sandbox');
});

test('an artifact is never served when it was not captured', async (t) => {
  const store = await createRunArtifactStore();
  const root = await mkdtemp(join(tmpdir(), 'omp-intellij-artifact-missing-'));
  t.after(async () => {
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const target = join(root, 'sandbox', 'app', 'build', 'outputs', 'apk', 'debug', 'app.apk');
  assert.equal(
    await store.materialize('app-debug.apk', target),
    false,
    'A missing artifact must report a miss instead of producing a file',
  );
  assert.equal(existsSync(target), false, 'A miss must not create a placeholder APK');
});

test('a failed capture cannot become a cache hit or destroy an earlier artifact', async (t) => {
  const store = await createRunArtifactStore();
  const root = await mkdtemp(join(tmpdir(), 'omp-intellij-artifact-failure-'));
  t.after(async () => {
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const target = join(root, 'sandbox', 'app.apk');
  await assert.rejects(
    store.capture('app-debug.apk', join(root, 'never-built.apk')),
    /ENOENT/,
    'Capturing an APK that was never produced must fail',
  );
  assert.equal(
    await store.materialize('app-debug.apk', target),
    false,
    'A failed capture must not be reusable by later scenarios',
  );
  assert.deepEqual(await readdir(store.dir), [], 'A failed capture must not leave staged files');

  const goodApk = join(root, 'good.apk');
  await writeFile(goodApk, APK_BYTES);
  await store.capture('app-debug.apk', goodApk);
  await assert.rejects(
    store.capture('app-debug.apk', join(root, 'never-built.apk')),
    /ENOENT/,
    'Replacing an artifact from a missing source must fail',
  );
  assert.equal(await store.materialize('app-debug.apk', target), true);
  assert.deepEqual(
    await readFile(target),
    APK_BYTES,
    'A rejected replacement must leave the previously captured artifact intact',
  );
});

test('disposing the store removes every artifact it held', async () => {
  const store = await createRunArtifactStore();
  const root = await mkdtemp(join(tmpdir(), 'omp-intellij-artifact-dispose-'));
  try {
    const apk = join(root, 'app.apk');
    await writeFile(apk, APK_BYTES);
    await store.capture('app-debug.apk', apk);
    assert.equal(existsSync(store.dir), true);

    await store.dispose();
    assert.equal(existsSync(store.dir), false, 'Run artifacts must not leak past the run');
    assert.equal(
      await store.materialize('app-debug.apk', join(root, 'after-dispose.apk')),
      false,
      'A disposed store must not serve artifacts',
    );
  } finally {
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
