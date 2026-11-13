import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  detectServerVersion,
  formatPluginOption,
  getIjPluginPaths,
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

async function extensionFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-assets-'));
  const extension = join(directory, 'extension');
  const originalEnv = process.env.OMP_ANDROID_LS_EXTENSION_DIR;
  t.after(async () => {
    if (originalEnv === undefined) delete process.env.OMP_ANDROID_LS_EXTENSION_DIR;
    else process.env.OMP_ANDROID_LS_EXTENSION_DIR = originalEnv;
    await rm(directory, { recursive: true, force: true });
  });
  await cp(`resources/ils/${DEFAULT_SERVER_VERSION}/android.lsp`, extension, {
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

test('extension rejects missing nested implementation module', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await rm(join(extension, 'lib', 'modules', 'language-server.api.features.impl.android.jar'));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects tampered nested implementation module', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await writeFile(
    join(extension, 'lib', 'modules', 'language-server.api.features.impl.android.jar'),
    'tampered bytecode',
  );
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects missing companion sha256 for nested module', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await rm(
    join(extension, 'lib', 'modules', 'language-server.api.features.impl.android.jar.sha256'),
  );
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects malformed companion sha256 for nested module', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await writeFile(
    join(extension, 'lib', 'modules', 'language-server.api.features.impl.android.jar.sha256'),
    'invalid checksum',
  );
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects companion sha256 mismatch for nested module', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await writeFile(
    join(extension, 'lib', 'modules', 'language-server.api.features.impl.android.jar.sha256'),
    `${'0'.repeat(64)} *language-server.api.features.impl.android.jar\n`,
  );
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects missing nested dap implementation module', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await rm(join(extension, 'lib', 'modules', 'language-server.api.features.impl.android.dap.jar'));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects tampered nested dap implementation module', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await writeFile(
    join(extension, 'lib', 'modules', 'language-server.api.features.impl.android.dap.jar'),
    'tampered dap bytecode',
  );
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects missing companion sha256 for nested dap module', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await rm(
    join(extension, 'lib', 'modules', 'language-server.api.features.impl.android.dap.jar.sha256'),
  );
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects missing builder-model upstream library', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await rm(join(extension, 'lib', 'builder-model-9.4.1.jar'));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects missing descriptor jar', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await rm(join(extension, 'lib', 'language-server-plugins-android-lsp.jar'));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects tampered descriptor jar', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await writeFile(join(extension, 'lib', 'language-server-plugins-android-lsp.jar'), 'tampered');
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects missing companion sha256 for descriptor jar', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await rm(join(extension, 'lib', 'language-server-plugins-android-lsp.jar.sha256'));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects missing upstream library', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await rm(join(extension, 'lib', 'lint-api-32.4.1.jar'));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects tampered upstream library', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await writeFile(join(extension, 'lib', 'lint-api-32.4.1.jar'), 'tampered upstream');
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects flattened implementation module in lib', async (t) => {
  const { extension, executable, manifestPath } = await extensionFixture(t);
  const nestedJar = join(
    extension,
    'lib',
    'modules',
    'language-server.api.features.impl.android.jar',
  );
  const flattenedJar = join(extension, 'lib', 'language-server.api.features.impl.android.jar');
  const nestedSha = `${nestedJar}.sha256`;
  const flattenedSha = `${flattenedJar}.sha256`;

  await cp(nestedJar, flattenedJar);
  await cp(nestedSha, flattenedSha);
  await rm(join(extension, 'lib', 'modules'), { recursive: true, force: true });

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const asset = manifest.assets.find(
    (a: { name: string }) => a.name === 'language-server.api.features.impl.android.jar',
  );
  if (asset) {
    asset.path = 'lib/language-server.api.features.impl.android.jar';
  }
  await writeFile(manifestPath, JSON.stringify(manifest));

  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects flattened dap implementation module in lib', async (t) => {
  const { extension, executable, manifestPath } = await extensionFixture(t);
  const nestedJar = join(
    extension,
    'lib',
    'modules',
    'language-server.api.features.impl.android.dap.jar',
  );
  const flattenedJar = join(extension, 'lib', 'language-server.api.features.impl.android.dap.jar');
  const nestedSha = `${nestedJar}.sha256`;
  const flattenedSha = `${flattenedJar}.sha256`;

  await cp(nestedJar, flattenedJar);
  await cp(nestedSha, flattenedSha);
  await rm(nestedJar);
  await rm(nestedSha);

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const asset = manifest.assets.find(
    (a: { name: string }) => a.name === 'language-server.api.features.impl.android.dap.jar',
  );
  if (asset) {
    asset.path = 'lib/language-server.api.features.impl.android.dap.jar';
  }
  await writeFile(manifestPath, JSON.stringify(manifest));

  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects unexpected nested asset in lib/modules', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await writeFile(join(extension, 'lib', 'modules', 'unexpected.jar'), 'extra nested jar');
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects additional runtime libraries in lib', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await writeFile(join(extension, 'lib', 'unexpected.jar'), 'extra');
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects unexpected subdirectory in lib', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await mkdir(join(extension, 'lib', 'unexpected_dir'), { recursive: true });
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects unexpected subdirectory in lib/modules', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  await mkdir(join(extension, 'lib', 'modules', 'unexpected_sub'), { recursive: true });
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects symbolic link in lib directory', async (t) => {
  const { extension, executable } = await extensionFixture(t);
  try {
    await symlink(
      join(extension, 'lib', 'common-32.4.1.jar'),
      join(extension, 'lib', 'symlink.jar'),
    );
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'EPERM' || error.code === 'ENOSYS')
    ) {
      t.skip('Symbolic links are not supported without elevated privileges on this system');
      return;
    }
    throw error;
  }
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects a missing manifest', async (t) => {
  const { executable, manifestPath } = await extensionFixture(t);
  await rm(manifestPath);
  assert.equal((await resolveAndroidExtension(executable)).pluginPath, undefined);
});

test('extension rejects manifest duplicate asset name', async (t) => {
  const { executable, manifestPath } = await extensionFixture(t);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.assets[1].name = manifest.assets[0].name;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects manifest duplicate asset path', async (t) => {
  const { executable, manifestPath } = await extensionFixture(t);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.assets[1].path = manifest.assets[0].path;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects manifest path traversal', async (t) => {
  const { executable, manifestPath } = await extensionFixture(t);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.assets[0].path = '../../secret.jar';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects manifest mismatched asset name and path', async (t) => {
  const { executable, manifestPath } = await extensionFixture(t);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.assets[0].name = 'unexpected.jar';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects manifest wrong serverVersion', async (t) => {
  const { executable, manifestPath } = await extensionFixture(t);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.serverVersion = '263.7084.0';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects manifest wrong extensionId', async (t) => {
  const { executable, manifestPath } = await extensionFixture(t);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.extensionId = 'com.other.plugin';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects manifest wrong targetJavaVersion', async (t) => {
  const { executable, manifestPath } = await extensionFixture(t);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.targetJavaVersion = 21;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects manifest wrong classFileVersion', async (t) => {
  const { executable, manifestPath } = await extensionFixture(t);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.classFileVersion = 65;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects manifest wrong asset size', async (t) => {
  const { executable, manifestPath } = await extensionFixture(t);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.assets[0].size++;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects manifest missing asset entries', async (t) => {
  const { executable, manifestPath } = await extensionFixture(t);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.assets.pop();
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
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

test('mergeIjJavaOptions preserves options and normalizes plugin paths', () => {
  for (const [label, existing, pluginPath, expected] of [
    ['absent options', undefined, 'C:\\ext', '-Dplugin.path="C:/ext"'],
    ['empty options', '', 'C:\\ext', '-Dplugin.path="C:/ext"'],
    ['whitespace-only options', '   ', 'C:\\ext', '-Dplugin.path="C:/ext"'],
    ['other VM options', '-Xmx2048m -ea', 'C:\\ext', '-Xmx2048m -ea -Dplugin.path="C:/ext"'],
    [
      'other VM options with a POSIX extension path',
      '-Xmx4g -Didea.is.internal=true',
      '/opt/android-ext',
      '-Xmx4g -Didea.is.internal=true -Dplugin.path="/opt/android-ext"',
    ],
    ['unquoted plugin path', '-Dplugin.path=/opt/p1', 'C:\\ext', '-Dplugin.path="/opt/p1,C:/ext"'],
    [
      'unquoted plugin path among options',
      '-Xmx1g -Dplugin.path=/opt/p1 -ea',
      'C:\\ext',
      '-Xmx1g -ea -Dplugin.path="/opt/p1,C:/ext"',
    ],
    [
      'quoted plugin path with spaces',
      '-Dplugin.path="/Existing Plugins/p1"',
      'C:\\ext',
      '-Dplugin.path="/Existing Plugins/p1,C:/ext"',
    ],
    [
      'fully quoted option token',
      '"-Dplugin.path=/Existing Plugins/p1"',
      'C:\\ext',
      '-Dplugin.path="/Existing Plugins/p1,C:/ext"',
    ],
    [
      'comma-separated plugin paths',
      '-Dplugin.path="/opt/p1,/opt/p2"',
      'C:\\ext',
      '-Dplugin.path="/opt/p1,/opt/p2,C:/ext"',
    ],
    [
      'repeated plugin path options',
      '-Dplugin.path=/opt/p1 -Xmx2g -Dplugin.path="/opt/p2"',
      'C:\\ext',
      '-Xmx2g -Dplugin.path="/opt/p1,/opt/p2,C:/ext"',
    ],
    ['already present plugin path', '-Dplugin.path="/p1,/ext"', '/ext', '-Dplugin.path="/p1,/ext"'],
    ['single existing plugin path', '-Dplugin.path="/ext"', '/ext', '-Dplugin.path="/ext"'],
    [
      'other quoted option with spaces',
      '-Xmx2g -Dtitle="Hello   World" -ea',
      'C:\\ext',
      '-Xmx2g -Dtitle="Hello   World" -ea -Dplugin.path="C:/ext"',
    ],
    [
      'plugin path containing spaces',
      '-Xmx2g',
      'C:/Program Files/Android LS Extension',
      '-Xmx2g -Dplugin.path="C:/Program Files/Android LS Extension"',
    ],
    [
      'native list separator',
      `-Dplugin.path="/one${process.platform === 'win32' ? ';' : ':'}/two" -ea`,
      '/two',
      '-ea -Dplugin.path="/one,/two"',
    ],
  ] as const) {
    assert.equal(mergeIjJavaOptions(existing, pluginPath), expected, label);
  }
});

test('mergeIjJavaOptions normalizes Windows backslashes in existing paths', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(
    mergeIjJavaOptions('-Dplugin.path="C:\\p1\\dir,D:\\p2\\dir"', 'C:\\ext'),
    '-Dplugin.path="C:/p1/dir,D:/p2/dir,C:/ext"',
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

test('Windows plugin paths retain filesystem case-insensitive identity', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(
    mergeIjJavaOptions('-Dplugin.path="c:/Existing;C:/EXT"', 'C:\\ext'),
    '-Dplugin.path="c:/Existing,C:/EXT"',
  );
});

test('extension rejects substituted upstream dependency even with a self-consistent manifest', async (t) => {
  const { extension, executable, manifestPath } = await extensionFixture(t);
  const name = 'lint-api-32.4.1.jar';
  const bytes = Buffer.from('substituted dependency');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(extension, 'lib', name), bytes);
  await writeFile(join(extension, 'lib', `${name}.sha256`), `${sha256} *${name}\n`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const asset = manifest.assets.find((item: { name: string }) => item.name === name);
  asset.sha256 = sha256;
  asset.size = bytes.length;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('extension rejects substituted builder-model dependency even with a self-consistent manifest', async (t) => {
  const { extension, executable, manifestPath } = await extensionFixture(t);
  const name = 'builder-model-9.4.1.jar';
  const bytes = Buffer.from('substituted builder-model');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(extension, 'lib', name), bytes);
  await writeFile(join(extension, 'lib', `${name}.sha256`), `${sha256} *${name}\n`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const asset = manifest.assets.find((item: { name: string }) => item.name === name);
  asset.sha256 = sha256;
  asset.size = bytes.length;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await resolveAndroidExtension(executable);
  assert.equal(result.pluginPath, undefined);
});

test('getIjPluginPaths parses supported option forms', () => {
  for (const [label, options, expected] of [
    ['undefined options', undefined, []],
    ['empty options', '', []],
    ['whitespace-only options', '   ', []],
    ['no plugin.path among other flags', '-Xmx2048m -ea -Dfoo=bar', []],
    ['single unquoted plugin path', '-Dplugin.path=/opt/p1', ['/opt/p1']],
    ['unquoted plugin path among options', '-Xmx1g -Dplugin.path=/opt/p1 -ea', ['/opt/p1']],
    [
      'quoted plugin path with spaces',
      '-Dplugin.path="/Program Files/My Plugins/p1"',
      ['/Program Files/My Plugins/p1'],
    ],
    [
      'fully quoted option token',
      '"-Dplugin.path=/Program Files/My Plugins/p1"',
      ['/Program Files/My Plugins/p1'],
    ],
    ['comma-separated plugin paths', '-Dplugin.path="/opt/p1,/opt/p2"', ['/opt/p1', '/opt/p2']],
    [
      'native list-separated plugin paths',
      `-Dplugin.path="/opt/p1${process.platform === 'win32' ? ';' : ':'}/opt/p2"`,
      ['/opt/p1', '/opt/p2'],
    ],
    [
      'repeated plugin path options',
      '-Dplugin.path=/opt/p1 -Xmx2g -Dplugin.path="/opt/p2"',
      ['/opt/p1', '/opt/p2'],
    ],
  ] as const) {
    assert.deepEqual(getIjPluginPaths(options), expected, label);
  }
});

test('getIjPluginPaths normalizes Windows backslashes in extracted paths', {
  skip: process.platform !== 'win32',
}, () => {
  assert.deepEqual(getIjPluginPaths('-Dplugin.path="C:\\p1\\dir,D:\\p2\\dir"'), [
    'C:/p1/dir',
    'D:/p2/dir',
  ]);
});

test('getIjPluginPaths merges and deduplicates additional plugin path', () => {
  assert.deepEqual(getIjPluginPaths(undefined, 'C:\\ext'), ['C:/ext']);
  assert.deepEqual(getIjPluginPaths('-Dplugin.path=/opt/p1', 'C:\\ext'), ['/opt/p1', 'C:/ext']);
  assert.deepEqual(getIjPluginPaths('-Dplugin.path="/opt/p1,/ext"', '/ext'), ['/opt/p1', '/ext']);
});

test('getIjPluginPaths deduplicates case-insensitively on Windows', {
  skip: process.platform !== 'win32',
}, () => {
  assert.deepEqual(getIjPluginPaths('-Dplugin.path="c:/existing;C:/EXT"', 'C:\\ext'), [
    'c:/existing',
    'C:/EXT',
  ]);
});

test('getIjPluginPaths throws on invalid characters in additional plugin path', () => {
  assert.throws(
    () => getIjPluginPaths(undefined, 'C:/bad"path'),
    /Invalid characters in plugin\.path/,
  );
  assert.throws(
    () => getIjPluginPaths(undefined, 'C:/bad,path'),
    /Invalid characters in plugin\.path/,
  );
  assert.throws(
    () => getIjPluginPaths(undefined, 'C:/bad\npath'),
    /Invalid characters in plugin\.path/,
  );
});

test('getIjPluginPaths resolves relative paths to absolute paths when baseDir is specified', () => {
  const base = process.platform === 'win32' ? 'C:/workspace' : '/workspace';
  const resolved = getIjPluginPaths(
    '-Dplugin.path="relative/plugin1,./relative/plugin2"',
    'relative/plugin3',
    base,
  );
  assert.deepEqual(resolved, [
    `${base}/relative/plugin1`,
    `${base}/relative/plugin2`,
    `${base}/relative/plugin3`,
  ]);

  // Relative duplicate deduplicates against absolute
  const deduplicated = getIjPluginPaths(
    `-Dplugin.path="${base}/relative/plugin1,./relative/plugin1"`,
    undefined,
    base,
  );
  assert.deepEqual(deduplicated, [`${base}/relative/plugin1`]);
});
