import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  detectServerVersion,
  formatPluginOption,
  mergeIjJavaOptions,
  resolveAndroidExtension,
} from '../src/server/android-extension.js';

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
      /Android extension requires ILS 271\.2085\.0; detected 263\.7084\.0/,
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
    await writeFile(join(dir, 'build.txt'), 'ILS-271.2085.0\n', 'utf8');
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

test('resolveAndroidExtension rejects missing manifest or asset file', async () => {
  const ilsDir = await mkdtemp(join(tmpdir(), 'omp-ils-'));
  const extDir = await mkdtemp(join(tmpdir(), 'omp-ext-'));
  const originalEnv = process.env.OMP_ANDROID_LS_EXTENSION_DIR;
  try {
    await writeFile(join(ilsDir, 'build.txt'), 'ILS-271.2085.0\n', 'utf8');
    const executable = join(ilsDir, 'bin', 'intellij-server');
    process.env.OMP_ANDROID_LS_EXTENSION_DIR = extDir;

    // Missing manifest.json
    const resNoManifest = await resolveAndroidExtension(executable);
    assert.equal(resNoManifest.pluginPath, undefined);
    assert.match(resNoManifest.reason ?? '', /Android extension unavailable/);

    // Manifest present, but lib/android-ls-extension.jar missing
    const manifest = {
      serverVersion: '271.2085.0',
      classFileVersion: 69,
      targetJavaVersion: 25,
      assets: [
        {
          name: 'android-ls-extension.jar',
          path: 'lib/android-ls-extension.jar',
          sha256: 'a'.repeat(64),
          size: 100,
        },
      ],
    };
    await writeFile(join(extDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    const resNoJar = await resolveAndroidExtension(executable);
    assert.equal(resNoJar.pluginPath, undefined);
    assert.match(resNoJar.reason ?? '', /Android extension unavailable/);
  } finally {
    if (originalEnv !== undefined) {
      process.env.OMP_ANDROID_LS_EXTENSION_DIR = originalEnv;
    } else {
      delete process.env.OMP_ANDROID_LS_EXTENSION_DIR;
    }
    await rm(ilsDir, { recursive: true, force: true });
    await rm(extDir, { recursive: true, force: true });
  }
});

test('resolveAndroidExtension rejects SHA-256 or size mismatch', async () => {
  const ilsDir = await mkdtemp(join(tmpdir(), 'omp-ils-'));
  const extDir = await mkdtemp(join(tmpdir(), 'omp-ext-'));
  const originalEnv = process.env.OMP_ANDROID_LS_EXTENSION_DIR;
  try {
    await writeFile(join(ilsDir, 'build.txt'), 'ILS-271.2085.0\n', 'utf8');
    const executable = join(ilsDir, 'bin', 'intellij-server');
    process.env.OMP_ANDROID_LS_EXTENSION_DIR = extDir;

    const libDir = join(extDir, 'lib');
    await mkdir(libDir, { recursive: true });
    const jarBytes = Buffer.from('test-jar-bytes-content');
    await writeFile(join(libDir, 'android-ls-extension.jar'), jarBytes);

    // Wrong SHA-256
    const manifestWrongSha = {
      serverVersion: '271.2085.0',
      classFileVersion: 69,
      assets: [
        {
          name: 'android-ls-extension.jar',
          path: 'lib/android-ls-extension.jar',
          sha256: '0'.repeat(64),
          size: jarBytes.length,
        },
      ],
    };
    await writeFile(join(extDir, 'manifest.json'), JSON.stringify(manifestWrongSha), 'utf8');
    const resSha = await resolveAndroidExtension(executable);
    assert.equal(resSha.pluginPath, undefined);
    assert.equal(resSha.reason, 'Android extension asset SHA-256 mismatch');

    // Correct SHA but wrong size
    const actualSha = createHash('sha256').update(jarBytes).digest('hex');
    const manifestWrongSize = {
      serverVersion: '271.2085.0',
      classFileVersion: 69,
      assets: [
        {
          name: 'android-ls-extension.jar',
          path: 'lib/android-ls-extension.jar',
          sha256: actualSha,
          size: jarBytes.length + 999,
        },
      ],
    };
    await writeFile(join(extDir, 'manifest.json'), JSON.stringify(manifestWrongSize), 'utf8');
    const resSize = await resolveAndroidExtension(executable);
    assert.equal(resSize.pluginPath, undefined);
    assert.equal(resSize.reason, 'Android extension asset SHA-256 mismatch');
  } finally {
    if (originalEnv !== undefined) {
      process.env.OMP_ANDROID_LS_EXTENSION_DIR = originalEnv;
    } else {
      delete process.env.OMP_ANDROID_LS_EXTENSION_DIR;
    }
    await rm(ilsDir, { recursive: true, force: true });
    await rm(extDir, { recursive: true, force: true });
  }
});

test('resolveAndroidExtension rejects manifest ABI or version mismatch', async () => {
  const ilsDir = await mkdtemp(join(tmpdir(), 'omp-ils-'));
  const extDir = await mkdtemp(join(tmpdir(), 'omp-ext-'));
  const originalEnv = process.env.OMP_ANDROID_LS_EXTENSION_DIR;
  try {
    await writeFile(join(ilsDir, 'build.txt'), 'ILS-271.2085.0\n', 'utf8');
    const executable = join(ilsDir, 'bin', 'intellij-server');
    process.env.OMP_ANDROID_LS_EXTENSION_DIR = extDir;

    // Wrong serverVersion in manifest
    await writeFile(
      join(extDir, 'manifest.json'),
      JSON.stringify({ serverVersion: '263.7084.0', classFileVersion: 69, assets: [{}] }),
      'utf8',
    );
    const resVer = await resolveAndroidExtension(executable);
    assert.equal(resVer.reason, 'Android extension manifest version or ABI mismatch');

    // Wrong classFileVersion in manifest
    await writeFile(
      join(extDir, 'manifest.json'),
      JSON.stringify({ serverVersion: '271.2085.0', classFileVersion: 65, assets: [{}] }),
      'utf8',
    );
    const resClass = await resolveAndroidExtension(executable);
    assert.equal(resClass.reason, 'Android extension manifest version or ABI mismatch');

    // Unexpected assets count in manifest
    await writeFile(
      join(extDir, 'manifest.json'),
      JSON.stringify({
        serverVersion: '271.2085.0',
        classFileVersion: 69,
        assets: [{ name: 'a' }, { name: 'b' }],
      }),
      'utf8',
    );
    const resCount = await resolveAndroidExtension(executable);
    assert.equal(resCount.reason, 'Android extension manifest version or ABI mismatch');

    // Invalid asset name in manifest
    await writeFile(
      join(extDir, 'manifest.json'),
      JSON.stringify({
        serverVersion: '271.2085.0',
        classFileVersion: 69,
        assets: [
          {
            name: 'other.jar',
            path: 'lib/android-ls-extension.jar',
            sha256: 'a'.repeat(64),
            size: 10,
          },
        ],
      }),
      'utf8',
    );
    const resName = await resolveAndroidExtension(executable);
    assert.equal(resName.reason, 'Invalid Android extension asset manifest');
  } finally {
    if (originalEnv !== undefined) {
      process.env.OMP_ANDROID_LS_EXTENSION_DIR = originalEnv;
    } else {
      delete process.env.OMP_ANDROID_LS_EXTENSION_DIR;
    }
    await rm(ilsDir, { recursive: true, force: true });
    await rm(extDir, { recursive: true, force: true });
  }
});

test('resolveAndroidExtension rejects asset path escaping extension directory', async () => {
  const ilsDir = await mkdtemp(join(tmpdir(), 'omp-ils-'));
  const extDir = await mkdtemp(join(tmpdir(), 'omp-ext-'));
  const originalEnv = process.env.OMP_ANDROID_LS_EXTENSION_DIR;
  try {
    await writeFile(join(ilsDir, 'build.txt'), 'ILS-271.2085.0\n', 'utf8');
    const executable = join(ilsDir, 'bin', 'intellij-server');
    process.env.OMP_ANDROID_LS_EXTENSION_DIR = extDir;

    await writeFile(
      join(extDir, 'manifest.json'),
      JSON.stringify({
        serverVersion: '271.2085.0',
        classFileVersion: 69,
        assets: [
          {
            name: 'android-ls-extension.jar',
            path: '../../secret.jar',
            sha256: 'a'.repeat(64),
            size: 10,
          },
        ],
      }),
      'utf8',
    );
    const resEscape = await resolveAndroidExtension(executable);
    assert.equal(resEscape.pluginPath, undefined);
    assert.equal(resEscape.reason, 'Invalid Android extension asset manifest');
  } finally {
    if (originalEnv !== undefined) {
      process.env.OMP_ANDROID_LS_EXTENSION_DIR = originalEnv;
    } else {
      delete process.env.OMP_ANDROID_LS_EXTENSION_DIR;
    }
    await rm(ilsDir, { recursive: true, force: true });
    await rm(extDir, { recursive: true, force: true });
  }
});

test('resolveAndroidExtension accepts exact identity with matching assets and companion SHA', async () => {
  const ilsDir = await mkdtemp(join(tmpdir(), 'omp-ils-'));
  const extDir = await mkdtemp(join(tmpdir(), 'omp-ext-'));
  const originalEnv = process.env.OMP_ANDROID_LS_EXTENSION_DIR;
  try {
    await writeFile(join(ilsDir, 'build.txt'), 'ILS-271.2085.0\n', 'utf8');
    const executable = join(ilsDir, 'bin', 'intellij-server');
    process.env.OMP_ANDROID_LS_EXTENSION_DIR = extDir;

    const libDir = join(extDir, 'lib');
    await mkdir(libDir, { recursive: true });
    const jarBytes = Buffer.from('exact-identity-test-bytes');
    const jarSha = createHash('sha256').update(jarBytes).digest('hex');
    await writeFile(join(libDir, 'android-ls-extension.jar'), jarBytes);
    await writeFile(
      join(libDir, 'android-ls-extension.jar.sha256'),
      `${jarSha} *android-ls-extension.jar\n`,
      'utf8',
    );

    const manifest = {
      serverVersion: '271.2085.0',
      classFileVersion: 69,
      targetJavaVersion: 25,
      assets: [
        {
          name: 'android-ls-extension.jar',
          path: 'lib/android-ls-extension.jar',
          sha256: jarSha,
          size: jarBytes.length,
        },
      ],
    };
    await writeFile(join(extDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    const res = await resolveAndroidExtension(executable);
    assert.equal(res.reason, undefined);
    assert.equal(res.pluginPath, extDir);
  } finally {
    if (originalEnv !== undefined) {
      process.env.OMP_ANDROID_LS_EXTENSION_DIR = originalEnv;
    } else {
      delete process.env.OMP_ANDROID_LS_EXTENSION_DIR;
    }
    await rm(ilsDir, { recursive: true, force: true });
    await rm(extDir, { recursive: true, force: true });
  }
});

test('resolveAndroidExtension rejects mismatched companion SHA file', async () => {
  const ilsDir = await mkdtemp(join(tmpdir(), 'omp-ils-'));
  const extDir = await mkdtemp(join(tmpdir(), 'omp-ext-'));
  const originalEnv = process.env.OMP_ANDROID_LS_EXTENSION_DIR;
  try {
    await writeFile(join(ilsDir, 'build.txt'), 'ILS-271.2085.0\n', 'utf8');
    const executable = join(ilsDir, 'bin', 'intellij-server');
    process.env.OMP_ANDROID_LS_EXTENSION_DIR = extDir;

    const libDir = join(extDir, 'lib');
    await mkdir(libDir, { recursive: true });
    const jarBytes = Buffer.from('exact-identity-test-bytes');
    const jarSha = createHash('sha256').update(jarBytes).digest('hex');
    await writeFile(join(libDir, 'android-ls-extension.jar'), jarBytes);
    await writeFile(
      join(libDir, 'android-ls-extension.jar.sha256'),
      `badbadbad${'0'.repeat(55)} *android-ls-extension.jar\n`,
      'utf8',
    );

    const manifest = {
      serverVersion: '271.2085.0',
      classFileVersion: 69,
      targetJavaVersion: 25,
      assets: [
        {
          name: 'android-ls-extension.jar',
          path: 'lib/android-ls-extension.jar',
          sha256: jarSha,
          size: jarBytes.length,
        },
      ],
    };
    await writeFile(join(extDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    const res = await resolveAndroidExtension(executable);
    assert.equal(res.pluginPath, undefined);
    assert.equal(res.reason, 'Android extension asset companion SHA-256 mismatch');
  } finally {
    if (originalEnv !== undefined) {
      process.env.OMP_ANDROID_LS_EXTENSION_DIR = originalEnv;
    } else {
      delete process.env.OMP_ANDROID_LS_EXTENSION_DIR;
    }
    await rm(ilsDir, { recursive: true, force: true });
    await rm(extDir, { recursive: true, force: true });
  }
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
