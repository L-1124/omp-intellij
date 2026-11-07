import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SERVER_VERSION,
  serverBundle,
  validateServerVersion,
} from '../src/server/bundles.js';

test('validateServerVersion accepts 3 or 4 dot-separated numeric segments', () => {
  assert.equal(validateServerVersion('271.2085.0'), '271.2085.0');
  assert.equal(validateServerVersion('263.7084.0'), '263.7084.0');
  assert.equal(validateServerVersion('243.21565.193'), '243.21565.193');
  assert.equal(validateServerVersion('243.21565.193.1'), '243.21565.193.1');
});

test('validateServerVersion rejects latest, whitespace, paths, and malformed versions', () => {
  assert.throws(() => validateServerVersion('latest'), /Invalid server version "latest"/);
  assert.throws(() => validateServerVersion(' 263.7084.0'), /Invalid server version/);
  assert.throws(() => validateServerVersion('263.7084.0 '), /Invalid server version/);
  assert.throws(() => validateServerVersion('../../etc/passwd'), /Invalid server version/);
  assert.throws(() => validateServerVersion('263.7084.0?tag=1'), /Invalid server version/);
  assert.throws(() => validateServerVersion('263.7084.0-SNAPSHOT'), /Invalid server version/);
  assert.throws(() => validateServerVersion('263.7084'), /Invalid server version/);
  assert.throws(() => validateServerVersion('1.2.3.4.5'), /Invalid server version/);
  assert.throws(() => validateServerVersion(''), /Invalid server version/);
});

test('serverBundle returns offline metadata for all supported platform and arch targets', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const arch of ['arm64', 'x64']) {
      const bundle = serverBundle(platform, arch);
      assert.equal(bundle.version, DEFAULT_SERVER_VERSION);
      assert.equal(typeof bundle.sha256, 'string');
      assert.equal(bundle.sha256.length, 64);
      assert.equal(typeof bundle.size, 'number');
      assert.ok((bundle.size ?? 0) > 0);
      assert.match(
        bundle.url,
        new RegExp(`^https://download\\.jetbrains\\.com/.*${DEFAULT_SERVER_VERSION}`),
      );
      if (platform === 'linux') {
        assert.equal(bundle.archive, 'tar.gz');
      } else {
        assert.equal(bundle.archive, 'zip');
      }
    }
  }
});

test('serverBundle rejects unsupported platforms and architectures', () => {
  assert.throws(() => serverBundle('freebsd', 'x64'), /No IntelliJ server bundle for freebsd\/x64/);
  assert.throws(() => serverBundle('win32', 'ia32'), /No IntelliJ server bundle for win32\/ia32/);
  assert.throws(
    () => serverBundle('linux', 'riscv64'),
    /No IntelliJ server bundle for linux\/riscv64/,
  );
});
