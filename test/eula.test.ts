import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  acceptServerEula,
  EulaNotAcceptedError,
  readEulaAcceptance,
  readServerEula,
  requireAcceptedEula,
} from '../src/server/eula.js';

interface TestEnv {
  root: string;
  configFile: string;
  eulaFile: string;
}

async function temporaryTestEnv(t: { after(fn: () => Promise<void>): void }): Promise<TestEnv> {
  const root = await mkdtemp(join(tmpdir(), 'omp-eula-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configFile = join(root, 'agent', 'intellij.json');
  const eulaFile = join(root, 'agent', 'intellij-eula.json');
  return { root, configFile, eulaFile };
}

interface FakeBundle {
  serverRoot: string;
  binDir: string;
  launcher: string;
  eulaPath: string;
}

async function createFakeBundle(
  dir: string,
  eulaContent = 'Fake IntelliJ Server EULA Content\nCopyright (c) JetBrains',
): Promise<FakeBundle> {
  const serverRoot = join(dir, 'server');
  const binDir = join(serverRoot, 'bin');
  await mkdir(binDir, { recursive: true });
  const launcher = join(binDir, 'intellij-server.exe');
  await writeFile(launcher, '#!/bin/sh\necho "fake server"\n');
  const eulaPath = join(serverRoot, 'EULA.txt');
  await writeFile(eulaPath, eulaContent);
  return { serverRoot, binDir, launcher, eulaPath };
}

test('readServerEula reads EULA document and computes correct 16-char lowercase hex hash from raw bytes', async (t) => {
  const env = await temporaryTestEnv(t);
  const bundle = await createFakeBundle(join(env.root, 'bundle'));
  const doc = await readServerEula(bundle.launcher);

  assert.equal(doc.executable, bundle.launcher);
  assert.equal(doc.path, bundle.eulaPath);
  assert.equal(doc.text, 'Fake IntelliJ Server EULA Content\nCopyright (c) JetBrains');

  const expectedBytes = Buffer.from('Fake IntelliJ Server EULA Content\nCopyright (c) JetBrains');
  const expectedHash = createHash('sha256')
    .update(expectedBytes)
    .digest('hex')
    .toLowerCase()
    .slice(0, 16);

  assert.equal(doc.hash, expectedHash);
  assert.match(doc.hash, /^[0-9a-f]{16}$/);
});

test('readServerEula hash changes when EULA bytes change even slightly', async (t) => {
  const env = await temporaryTestEnv(t);
  const bundle = await createFakeBundle(join(env.root, 'bundle'), 'Version 1.0.0');
  const doc1 = await readServerEula(bundle.launcher);

  await writeFile(bundle.eulaPath, 'Version 1.0.1');
  const doc2 = await readServerEula(bundle.launcher);

  assert.notEqual(doc1.hash, doc2.hash);
  assert.match(doc1.hash, /^[0-9a-f]{16}$/);
  assert.match(doc2.hash, /^[0-9a-f]{16}$/);
});

test('readServerEula fails when EULA.txt is missing in bundle with path and code', async (t) => {
  const env = await temporaryTestEnv(t);
  const bundle = await createFakeBundle(join(env.root, 'bundle'));
  await rm(bundle.eulaPath);

  await assert.rejects(
    async () => readServerEula(bundle.launcher),
    (err: unknown) => {
      assert(err instanceof Error);
      assert.match(err.message, /Failed to read EULA at/);
      assert.match(err.message, /EULA\.txt/);
      if ('code' in err) {
        assert.equal(err.code, 'ENOENT');
      }
      return true;
    },
  );
});

test('readServerEula fails when executable cannot be resolved with path and code', async (t) => {
  const env = await temporaryTestEnv(t);
  const nonExistent = join(env.root, 'nonexistent', 'bin', 'launcher.exe');

  await assert.rejects(
    async () => readServerEula(nonExistent),
    (err: unknown) => {
      assert(err instanceof Error);
      assert.match(err.message, /Failed to resolve server executable at/);
      if ('code' in err) {
        assert.equal(err.code, 'ENOENT');
      }
      return true;
    },
  );
});

test('readServerEula resolves symlinked launcher to real bundle EULA.txt if symlinks supported', async (t) => {
  const env = await temporaryTestEnv(t);
  const bundle = await createFakeBundle(join(env.root, 'real'));
  const linkDir = join(env.root, 'links');
  await mkdir(linkDir, { recursive: true });
  const linkPath = join(linkDir, 'launcher-link.exe');

  let symlinkCreated = false;
  try {
    await symlink(bundle.launcher, linkPath);
    symlinkCreated = true;
  } catch {
    // Unprivileged symlink creation on Windows without Developer Mode
  }

  if (symlinkCreated) {
    const doc = await readServerEula(linkPath);
    assert.equal(doc.path, bundle.eulaPath);
  }
});

test('readEulaAcceptance returns empty list when file is missing', async (t) => {
  const env = await temporaryTestEnv(t);
  const acceptance = await readEulaAcceptance({ configFile: env.configFile });
  assert.deepEqual(acceptance, { acceptedHashes: [] });
});

test('readEulaAcceptance reads valid version 1 acceptance file with sorted unique hashes', async (t) => {
  const env = await temporaryTestEnv(t);
  await mkdir(dirname(env.eulaFile), { recursive: true });
  await writeFile(
    env.eulaFile,
    JSON.stringify({
      version: 1,
      acceptedHashes: ['0123456789abcdef', 'abcdef0123456789'],
    }),
  );

  const acceptance = await readEulaAcceptance({ configFile: env.configFile });
  assert.deepEqual(acceptance, {
    acceptedHashes: ['0123456789abcdef', 'abcdef0123456789'],
  });
});

test('readEulaAcceptance rejects malformed or invalid acceptance schemas', async (t) => {
  const env = await temporaryTestEnv(t);
  await mkdir(dirname(env.eulaFile), { recursive: true });

  const malformedCases: Record<string, string> = {
    'empty-file': '',
    'syntax-error': '{"version": 1, "acceptedHashes":',
    'primitive-number': '42',
    'primitive-string': '"accepted"',
    'primitive-null': 'null',
    'array-root': '[]',
    'missing-version': '{"acceptedHashes": []}',
    'unsupported-version-2': '{"version": 2, "acceptedHashes": []}',
    'unsupported-version-string': '{"version": "1", "acceptedHashes": []}',
    'non-array-hashes': '{"version": 1, "acceptedHashes": "0123456789abcdef"}',
    'hash-too-short': '{"version": 1, "acceptedHashes": ["0123456789abcde"]}',
    'hash-too-long': '{"version": 1, "acceptedHashes": ["0123456789abcdef0"]}',
    'hash-uppercase': '{"version": 1, "acceptedHashes": ["0123456789ABCDEF"]}',
    'hash-non-hex': '{"version": 1, "acceptedHashes": ["0123456789ghijkl"]}',
    'hash-not-string': '{"version": 1, "acceptedHashes": [1234567890123456]}',
    'duplicate-hashes':
      '{"version": 1, "acceptedHashes": ["0123456789abcdef", "0123456789abcdef"]}',
    'unsorted-hashes': '{"version": 1, "acceptedHashes": ["b000000000000000", "a000000000000000"]}',
    'unexpected-property': '{"version": 1, "acceptedHashes": [], "secretToken": "confidential"}',
    'prototype-property': '{"version": 1, "acceptedHashes": [], "toString": "injected"}',
  };

  for (const [name, content] of Object.entries(malformedCases)) {
    await writeFile(env.eulaFile, content);
    await assert.rejects(
      async () => readEulaAcceptance({ configFile: env.configFile }),
      /Invalid EULA acceptance file/,
      `Expected rejection for malformed case: ${name}`,
    );
  }
});

test('acceptServerEula writes atomic sibling intellij-eula.json with version 1 and sorted hash', async (t) => {
  const env = await temporaryTestEnv(t);
  const bundle = await createFakeBundle(join(env.root, 'bundle'));
  const doc = await readServerEula(bundle.launcher);

  await acceptServerEula(doc, { configFile: env.configFile });

  const acceptance = await readEulaAcceptance({ configFile: env.configFile });
  assert.deepEqual(acceptance, { acceptedHashes: [doc.hash] });

  const raw = JSON.parse(await readFile(env.eulaFile, 'utf8')) as {
    version: number;
    acceptedHashes: string[];
  };
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.acceptedHashes, [doc.hash]);
});

test('acceptServerEula is idempotent for repeat acceptance of the same document', async (t) => {
  const env = await temporaryTestEnv(t);
  const bundle = await createFakeBundle(join(env.root, 'bundle'));
  const doc = await readServerEula(bundle.launcher);

  await acceptServerEula(doc, { configFile: env.configFile });
  await acceptServerEula(doc, { configFile: env.configFile });

  const acceptance = await readEulaAcceptance({ configFile: env.configFile });
  assert.deepEqual(acceptance.acceptedHashes, [doc.hash]);
});

test('acceptServerEula merges multiple accepted documents into unique sorted list', async (t) => {
  const env = await temporaryTestEnv(t);
  const bundleA = await createFakeBundle(join(env.root, 'bundle-a'), 'Bundle A agreement');
  const bundleB = await createFakeBundle(join(env.root, 'bundle-b'), 'Bundle B agreement');

  const docA = await readServerEula(bundleA.launcher);
  const docB = await readServerEula(bundleB.launcher);

  await acceptServerEula(docA, { configFile: env.configFile });
  await acceptServerEula(docB, { configFile: env.configFile });

  const acceptance = await readEulaAcceptance({ configFile: env.configFile });
  const expectedSorted = [docA.hash, docB.hash].sort();
  assert.deepEqual(acceptance.acceptedHashes, expectedSorted);
});

test('acceptServerEula rejects if EULA content has changed on disk before acceptance', async (t) => {
  const env = await temporaryTestEnv(t);
  const bundle = await createFakeBundle(join(env.root, 'bundle'), 'Initial terms');
  const staleDoc = await readServerEula(bundle.launcher);

  await writeFile(bundle.eulaPath, 'Changed terms before acceptance');

  await assert.rejects(
    async () => acceptServerEula(staleDoc, { configFile: env.configFile }),
    /EULA document for .* has changed/,
  );

  const acceptance = await readEulaAcceptance({ configFile: env.configFile });
  assert.deepEqual(acceptance.acceptedHashes, []);
});

test('acceptServerEula rejects if document path does not match launcher bundle', async (t) => {
  const env = await temporaryTestEnv(t);
  const bundle = await createFakeBundle(join(env.root, 'bundle'));
  const doc = await readServerEula(bundle.launcher);

  const alteredDoc = {
    ...doc,
    path: join(bundle.serverRoot, 'TAMPERED_EULA.txt'),
  };

  await assert.rejects(
    async () => acceptServerEula(alteredDoc, { configFile: env.configFile }),
    /EULA document for .* has changed/,
  );
});

test('acceptServerEula rejects if document hash format is invalid', async (t) => {
  const env = await temporaryTestEnv(t);
  const bundle = await createFakeBundle(join(env.root, 'bundle'));
  const doc = await readServerEula(bundle.launcher);

  const badDoc = { ...doc, hash: 'invalid-hash' };
  await assert.rejects(
    async () => acceptServerEula(badDoc, { configFile: env.configFile }),
    /Invalid EULA hash format/,
  );
});

test('acceptServerEula does not overwrite malformed existing acceptance file', async (t) => {
  const env = await temporaryTestEnv(t);
  await mkdir(dirname(env.eulaFile), { recursive: true });
  await writeFile(env.eulaFile, '{ corrupt-json');

  const bundle = await createFakeBundle(join(env.root, 'bundle'));
  const doc = await readServerEula(bundle.launcher);

  await assert.rejects(
    async () => acceptServerEula(doc, { configFile: env.configFile }),
    /Invalid EULA acceptance file/,
  );

  const rawContent = await readFile(env.eulaFile, 'utf8');
  assert.equal(rawContent, '{ corrupt-json');
});

test('requireAcceptedEula throws EulaNotAcceptedError when unaccepted with guidance and document', async (t) => {
  const env = await temporaryTestEnv(t);
  const bundle = await createFakeBundle(join(env.root, 'bundle'));
  const doc = await readServerEula(bundle.launcher);

  await assert.rejects(
    async () => requireAcceptedEula(bundle.launcher, { configFile: env.configFile }),
    (err: unknown) => {
      assert(err instanceof EulaNotAcceptedError);
      assert.equal(err.code, 'EULA_NOT_ACCEPTED');
      assert.equal(err.name, 'EulaNotAcceptedError');
      assert.match(err.message, /\/intellij eula view/);
      assert.match(err.message, new RegExp(`/intellij eula accept ${doc.hash}`));
      assert.deepEqual(err.document, doc);
      return true;
    },
  );
});

test('requireAcceptedEula succeeds and returns EulaDocument after acceptance', async (t) => {
  const env = await temporaryTestEnv(t);
  const bundle = await createFakeBundle(join(env.root, 'bundle'));
  const doc = await readServerEula(bundle.launcher);

  await acceptServerEula(doc, { configFile: env.configFile });
  const result = await requireAcceptedEula(bundle.launcher, { configFile: env.configFile });

  assert.deepEqual(result, doc);
});

test('requireAcceptedEula re-throws EulaNotAcceptedError if EULA is modified after acceptance', async (t) => {
  const env = await temporaryTestEnv(t);
  const bundle = await createFakeBundle(join(env.root, 'bundle'), 'Initial accepted terms');
  const doc = await readServerEula(bundle.launcher);

  await acceptServerEula(doc, { configFile: env.configFile });
  assert.deepEqual(await requireAcceptedEula(bundle.launcher, { configFile: env.configFile }), doc);

  await writeFile(bundle.eulaPath, 'Updated unaccepted terms');

  await assert.rejects(
    async () => requireAcceptedEula(bundle.launcher, { configFile: env.configFile }),
    (err: unknown) => {
      assert(err instanceof EulaNotAcceptedError);
      assert.equal(err.code, 'EULA_NOT_ACCEPTED');
      assert.notEqual(err.document.hash, doc.hash);
      return true;
    },
  );
});
