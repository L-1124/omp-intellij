import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  detectServerVersion,
  formatPluginOption,
  mergeIjJavaOptions,
  resolveAndroidExtension,
} from '../src/server/android-extension.js';
import { DEFAULT_SERVER_VERSION } from '../src/server/bundle-metadata.js';

test('detectServerVersion extracts exact version from build.txt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-detect-'));
  try {
    const binDir = join(dir, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(join(dir, 'build.txt'), 'ILS-271.2085.0\n', 'utf8');

    // Executable in bin/
    const fromBin = await detectServerVersion(join(binDir, 'intellij-server.exe'));
    assert.equal(fromBin, '271.2085.0');

    // Executable in root
    const fromRoot = await detectServerVersion(join(dir, 'server.bat'));
    assert.equal(fromRoot, '271.2085.0');

    // Executable pointing to ILS root directory
    const fromDir = await detectServerVersion(dir);
    assert.equal(fromDir, '271.2085.0');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detectServerVersion handles bare version without ILS- prefix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-detect-'));
  try {
    await writeFile(join(dir, 'build.txt'), '271.2085.0\r\n', 'utf8');
    const ver = await detectServerVersion(join(dir, 'bin', 'server'));
    assert.equal(ver, '271.2085.0');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detectServerVersion returns null when build.txt is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-detect-'));
  try {
    const ver = await detectServerVersion(join(dir, 'bin', 'server'));
    assert.equal(ver, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveAndroidExtension rejects wrong ILS version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-res-'));
  try {
    await writeFile(join(dir, 'build.txt'), 'ILS-263.7084.0\n', 'utf8');
    const executable = join(dir, 'bin', 'intellij-server');
    const res = await resolveAndroidExtension(executable);
    assert.equal(res.pluginPath, undefined);
    assert.match(
      res.reason ?? '',
      new RegExp(
        `Android extension requires ILS ${DEFAULT_SERVER_VERSION.replace(/\./g, '\\.')}; detected 263\\.7084\\.0`,
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveAndroidExtension handles missing ILS build.txt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-res-'));
  try {
    const executable = join(dir, 'bin', 'intellij-server');
    const res = await resolveAndroidExtension(executable);
    assert.equal(res.pluginPath, undefined);
    assert.match(res.reason ?? '', /detected unknown/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveAndroidExtension rejects invalid characters in extension directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-res-'));
  const originalEnv = process.env.OMP_ANDROID_LS_EXTENSION_DIR;
  try {
    await writeFile(join(dir, 'build.txt'), `ILS-${DEFAULT_SERVER_VERSION}\n`, 'utf8');
    const executable = join(dir, 'bin', 'intellij-server');

    process.env.OMP_ANDROID_LS_EXTENSION_DIR = 'C:/path,with,comma';
    const resComma = await resolveAndroidExtension(executable);
    assert.equal(resComma.pluginPath, undefined);
    assert.match(resComma.reason ?? '', /Extension path contains invalid characters/);

    process.env.OMP_ANDROID_LS_EXTENSION_DIR = 'C:/path"with"quotes';
    const resQuote = await resolveAndroidExtension(executable);
    assert.equal(resQuote.pluginPath, undefined);
    assert.match(resQuote.reason ?? '', /Extension path contains invalid characters/);

    process.env.OMP_ANDROID_LS_EXTENSION_DIR = 'C:/path\nwith\nnewline';
    const resNewline = await resolveAndroidExtension(executable);
    assert.equal(resNewline.pluginPath, undefined);
    assert.match(resNewline.reason ?? '', /Extension path contains invalid characters/);
  } finally {
    if (originalEnv !== undefined) {
      process.env.OMP_ANDROID_LS_EXTENSION_DIR = originalEnv;
    } else {
      delete process.env.OMP_ANDROID_LS_EXTENSION_DIR;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

const assetNames = [
  'intellij-android.jar',
  'adblib-9.4.1.jar',
  'adblib-tools-9.4.1.jar',
  'lint-api-32.4.1.jar',
  'lint-checks-32.4.1.jar',
  'lint-model-32.4.1.jar',
  'common-32.4.1.jar',
  'sdklib-32.4.1.jar',
  'kxml2-2.3.0.jar',
  'sdk-common-32.4.1.jar',
  'layoutlib-api-32.4.1.jar',
];

async function extensionFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-assets-'));
  const extension = join(directory, 'extension');
  const originalEnv = process.env.OMP_ANDROID_LS_EXTENSION_DIR;
  t.after(async () => {
    if (originalEnv === undefined) delete process.env.OMP_ANDROID_LS_EXTENSION_DIR;
    else process.env.OMP_ANDROID_LS_EXTENSION_DIR = originalEnv;
    await rm(directory, { recursive: true, force: true });
  });
  await cp(`resources/ils/${DEFAULT_SERVER_VERSION}/intellij-android`, extension, {
    recursive: true,
  });
  await writeFile(join(directory, 'build.txt'), `ILS-${DEFAULT_SERVER_VERSION}\n`);
  process.env.OMP_ANDROID_LS_EXTENSION_DIR = extension;
  const executable = join(directory, 'bin', 'intellij-server');
  const manifestPath = join(extension, 'manifest.json');
  return { extension, executable, manifestPath };
}

test('matching published extension assets resolve for the exact ILS build', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  assert.deepEqual(await resolveAndroidExtension(executable), { pluginPath: extension });
});

for (const name of assetNames) {
  for (const mutation of [
    'missing',
    'tampered',
    'companion-missing',
    'companion-malformed',
    'companion-wrong',
  ] as const) {
    test(`extension rejects ${name} ${mutation}`, async (t) => {
      const { extension, executable } = await extensionFixture(t);
      const asset = join(extension, 'lib', name);
      if (mutation === 'missing') await rm(asset);
      else if (mutation === 'tampered') await writeFile(asset, 'tampered');
      else if (mutation === 'companion-missing') await rm(`${asset}.sha256`);
      else if (mutation === 'companion-malformed')
        await writeFile(`${asset}.sha256`, 'invalid checksum');
      else await writeFile(`${asset}.sha256`, `${'0'.repeat(64)} *${name}\n`);
      const result = await resolveAndroidExtension(executable);
      assert.equal(result.pluginPath, undefined);
      assert.equal(typeof result.reason, 'string');
    });
  }
}

test('extension rejects additional runtime libraries', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await writeFile(join(extension, 'lib', 'unexpected.jar'), 'extra');
  assert.equal((await resolveAndroidExtension(executable)).pluginPath, undefined);
});

for (const mutation of [
  'missing',
  'duplicate',
  'traversal',
  'wrong-name',
  'wrong-version',
  'wrong-java',
  'wrong-abi',
  'wrong-size',
] as const) {
  test(`extension rejects manifest ${mutation}`, async (t) => {
    const { executable, manifestPath } = await extensionFixture(t);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (mutation === 'missing') manifest.assets.pop();
    else if (mutation === 'duplicate') manifest.assets[1] = manifest.assets[0];
    else if (mutation === 'traversal') manifest.assets[0].path = '../../secret.jar';
    else if (mutation === 'wrong-name') manifest.assets[0].name = 'unexpected.jar';
    else if (mutation === 'wrong-version') manifest.serverVersion = '263.7084.0';
    else if (mutation === 'wrong-java') manifest.targetJavaVersion = 21;
    else if (mutation === 'wrong-abi') manifest.classFileVersion = 65;
    else manifest.assets[1].size++;
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.equal((await resolveAndroidExtension(executable)).pluginPath, undefined);
  });
}

test('extension rejects a missing manifest', async (t) => {
  const { executable, manifestPath } = await extensionFixture(t);
  await rm(manifestPath);
  assert.equal((await resolveAndroidExtension(executable)).pluginPath, undefined);
});

test('formatPluginOption normalizes slashes and quotes path', () => {
  assert.equal(formatPluginOption('C:\\my\\path'), '-Dplugin.path="C:/my/path"');
  assert.equal(formatPluginOption('/opt/my/path'), '-Dplugin.path="/opt/my/path"');
  assert.equal(
    formatPluginOption('C:/Path With Spaces/ext'),
    '-Dplugin.path="C:/Path With Spaces/ext"',
  );
  assert.equal(formatPluginOption('C:/path1,D:/path2'), '-Dplugin.path="C:/path1,D:/path2"');
});

test('formatPluginOption rejects invalid option characters', () => {
  assert.throws(() => formatPluginOption('C:/bad"path'), /Invalid characters in plugin\.path/);
  assert.throws(() => formatPluginOption('C:/bad\npath'), /Invalid characters in plugin\.path/);
  assert.throws(() => formatPluginOption('C:/bad\rpath'), /Invalid characters in plugin\.path/);
  assert.throws(() => formatPluginOption('C:/bad\0path'), /Invalid characters in plugin\.path/);
});

test('mergeIjJavaOptions formats plugin path when existing options are undefined or empty', () => {
  assert.equal(mergeIjJavaOptions(undefined, 'C:\\ext'), '-Dplugin.path="C:/ext"');
  assert.equal(mergeIjJavaOptions('', 'C:\\ext'), '-Dplugin.path="C:/ext"');
  assert.equal(mergeIjJavaOptions('   ', 'C:\\ext'), '-Dplugin.path="C:/ext"');
});

test('mergeIjJavaOptions appends plugin path and preserves other VM options', () => {
  assert.equal(
    mergeIjJavaOptions('-Xmx2048m -ea', 'C:\\ext'),
    '-Xmx2048m -ea -Dplugin.path="C:/ext"',
  );
  assert.equal(
    mergeIjJavaOptions('-Xmx4g -Didea.is.internal=true', '/opt/android-ext'),
    '-Xmx4g -Didea.is.internal=true -Dplugin.path="/opt/android-ext"',
  );
});

test('mergeIjJavaOptions merges with existing unquoted -Dplugin.path', () => {
  assert.equal(
    mergeIjJavaOptions('-Dplugin.path=/opt/p1', 'C:\\ext'),
    '-Dplugin.path="/opt/p1,C:/ext"',
  );
  assert.equal(
    mergeIjJavaOptions('-Xmx1g -Dplugin.path=/opt/p1 -ea', 'C:\\ext'),
    '-Xmx1g -ea -Dplugin.path="/opt/p1,C:/ext"',
  );
});

test('mergeIjJavaOptions merges with existing quoted -Dplugin.path', () => {
  assert.equal(
    mergeIjJavaOptions('-Dplugin.path="/Existing Plugins/p1"', 'C:\\ext'),
    '-Dplugin.path="/Existing Plugins/p1,C:/ext"',
  );
  assert.equal(
    mergeIjJavaOptions('"-Dplugin.path=/Existing Plugins/p1"', 'C:\\ext'),
    '-Dplugin.path="/Existing Plugins/p1,C:/ext"',
  );
});

test('mergeIjJavaOptions merges with existing comma-separated plugin paths', () => {
  assert.equal(
    mergeIjJavaOptions('-Dplugin.path="/opt/p1,/opt/p2"', 'C:\\ext'),
    '-Dplugin.path="/opt/p1,/opt/p2,C:/ext"',
  );
});

test('mergeIjJavaOptions combines multiple -Dplugin.path occurrences into one', () => {
  assert.equal(
    mergeIjJavaOptions('-Dplugin.path=/opt/p1 -Xmx2g -Dplugin.path="/opt/p2"', 'C:\\ext'),
    '-Xmx2g -Dplugin.path="/opt/p1,/opt/p2,C:/ext"',
  );
});

test('mergeIjJavaOptions is idempotent when extension path is already present', () => {
  assert.equal(mergeIjJavaOptions('-Dplugin.path="/p1,/ext"', '/ext'), '-Dplugin.path="/p1,/ext"');
  assert.equal(mergeIjJavaOptions('-Dplugin.path="/ext"', '/ext'), '-Dplugin.path="/ext"');
});

test('mergeIjJavaOptions normalizes Windows backslashes in existing paths', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(
    mergeIjJavaOptions('-Dplugin.path="C:\\p1\\dir,D:\\p2\\dir"', 'C:\\ext'),
    '-Dplugin.path="C:/p1/dir,D:/p2/dir,C:/ext"',
  );
});

test('mergeIjJavaOptions preserves other quoted options with spaces', () => {
  assert.equal(
    mergeIjJavaOptions('-Xmx2g -Dtitle="Hello   World" -ea', 'C:\\ext'),
    '-Xmx2g -Dtitle="Hello   World" -ea -Dplugin.path="C:/ext"',
  );
});

test('mergeIjJavaOptions handles path with spaces', () => {
  assert.equal(
    mergeIjJavaOptions('-Xmx2g', 'C:/Program Files/Android LS Extension'),
    '-Xmx2g -Dplugin.path="C:/Program Files/Android LS Extension"',
  );
});

test('mergeIjJavaOptions rejects invalid characters in plugin path', () => {
  assert.throws(
    () => mergeIjJavaOptions('-Xmx2g', 'C:/bad"path'),
    /Invalid characters in plugin\.path/,
  );
  assert.throws(
    () => mergeIjJavaOptions('-Xmx2g', 'C:/bad,path'),
    /Invalid characters in plugin\.path/,
  );
  assert.throws(
    () => mergeIjJavaOptions('-Xmx2g', 'C:/bad\npath'),
    /Invalid characters in plugin\.path/,
  );
});

test('native path separators merge without duplicating an existing extension', () => {
  const separator = process.platform === 'win32' ? ';' : ':';
  assert.equal(
    mergeIjJavaOptions(`-Dplugin.path="/one${separator}/two" -ea`, '/two'),
    '-ea -Dplugin.path="/one,/two"',
  );
});

test('Windows plugin paths retain filesystem case-insensitive identity', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(
    mergeIjJavaOptions('-Dplugin.path="c:/Existing;C:/EXT"', 'C:\\ext'),
    '-Dplugin.path="c:/Existing,C:/EXT"',
  );
});

for (const name of [
  'adblib-9.4.1.jar',
  'adblib-tools-9.4.1.jar',
  'lint-api-32.4.1.jar',
  'lint-checks-32.4.1.jar',
  'lint-model-32.4.1.jar',
  'common-32.4.1.jar',
  'sdklib-32.4.1.jar',
  'kxml2-2.3.0.jar',
  'sdk-common-32.4.1.jar',
  'layoutlib-api-32.4.1.jar',
]) {
  test(`extension rejects substituted ${name} even with a self-consistent manifest`, async (t) => {
    const { extension, executable, manifestPath } = await extensionFixture(t);
    const bytes = Buffer.from('substituted dependency');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(extension, 'lib', name), bytes);
    await writeFile(join(extension, 'lib', `${name}.sha256`), `${sha256} *${name}\n`);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const asset = manifest.assets.find((item: { name: string }) => item.name === name);
    asset.sha256 = sha256;
    asset.size = bytes.length;
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.equal((await resolveAndroidExtension(executable)).pluginPath, undefined);
  });
}
