import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SERVER_VERSION,
  LATEST_VERSION_URL,
  latestServerVersion,
  parseLatestVersionFromLua,
  parseSha256Sidecar,
  resolveServerBundle,
  serverBundle,
  validateServerVersion,
} from '../src/server/bundles.js';

test('validateServerVersion accepts 3 or 4 dot-separated numeric segments', () => {
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

test('parseSha256Sidecar handles standard sha256sum outputs and normalizes lowercase', () => {
  const hash = 'd84629cbdd79d58f021a15a75f05018518398906519a0e830df6f8a8d515e286';
  const name = 'intellij-server-263.7084.0.win.zip';

  // Binary mode with asterisk
  assert.equal(parseSha256Sidecar(`${hash} *${name}`, name), hash);
  // Text mode with double space
  assert.equal(parseSha256Sidecar(`${hash}  ${name}`, name), hash);
  // Hash only
  assert.equal(parseSha256Sidecar(hash, name), hash);
  // Uppercase normalized
  assert.equal(parseSha256Sidecar(hash.toUpperCase(), name), hash);
  // Trailing newline
  assert.equal(parseSha256Sidecar(`${hash} *${name}\r\n`, name), hash);
});

test('parseSha256Sidecar rejects mismatched filename, extra tokens, and malformed files', () => {
  const hash = 'd84629cbdd79d58f021a15a75f05018518398906519a0e830df6f8a8d515e286';
  const name = 'intellij-server-263.7084.0.win.zip';

  assert.throws(() => parseSha256Sidecar(`${hash} *other.zip`, name), /archive basename mismatch/);
  assert.throws(
    () => parseSha256Sidecar(`${hash} *${name} extra_garbage`, name),
    /trailing garbage/,
  );
  assert.throws(() => parseSha256Sidecar(`${hash} *`, name), /trailing asterisk without filename/);
  assert.throws(
    () => parseSha256Sidecar(`${hash}\n${hash}`, name),
    /expected exactly 1 non-empty line/,
  );
  assert.throws(
    () => parseSha256Sidecar('d84629cb not-enough-hex', name),
    /expected 64-hex SHA-256 hash/,
  );
  assert.throws(() => parseSha256Sidecar('', name), /expected exactly 1 non-empty line/);
});

test('parseLatestVersionFromLua extracts single M.version assignment', () => {
  const lua = `
local M = {}
M.version = '263.7084.0'
return M
`;
  assert.equal(parseLatestVersionFromLua(lua), '263.7084.0');

  const luaDoubleQuotes = 'M.version = "263.8000.1" -- comment';
  assert.equal(parseLatestVersionFromLua(luaDoubleQuotes), '263.8000.1');

  const luaCrlf = "local M = {}\r\n  M.version = '263.7084.0' -- comment\r\nreturn M\r\n";
  assert.equal(parseLatestVersionFromLua(luaCrlf), '263.7084.0');
  assert.throws(
    () => parseLatestVersionFromLua('local M = {}\nreturn M'),
    /expected exactly one M\.version assignment, found 0/,
  );
  assert.throws(
    () => parseLatestVersionFromLua("M.version = '1.0.0'\nM.version = '2.0.0'"),
    /expected exactly one M\.version assignment, found 2/,
  );
});

test('latestServerVersion fails explicitly without fallback on network or parse error', async () => {
  const notFoundFetch: typeof fetch = async () => new Response('Not found', { status: 404 });
  await assert.rejects(() => latestServerVersion({ fetch: notFoundFetch }), /HTTP 404/);

  const invalidVersionFetch: typeof fetch = async () =>
    new Response("M.version = 'unsafe/version'", { status: 200 });
  await assert.rejects(
    () => latestServerVersion({ fetch: invalidVersionFetch }),
    /Invalid server version "unsafe\/version"/,
  );

  const oversizedFetch: typeof fetch = async () =>
    new Response('x'.repeat(70 * 1024), { status: 200 });
  await assert.rejects(
    () => latestServerVersion({ fetch: oversizedFetch }),
    /exceeded maximum allowed size/,
  );
});

test('bounded read and HTTP failure cancel response body stream', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(10));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(stream, { status: 500, statusText: 'Server Error' });
  const failingFetch: typeof fetch = async () => response;
  await assert.rejects(() => latestServerVersion({ fetch: failingFetch }), /HTTP 500/);
  assert.equal(cancelled, true);
});

test('resolveServerBundle returns offline default bundle without network', async () => {
  let called = false;
  const failingFetch: typeof fetch = async () => {
    called = true;
    throw new Error('Network should not be touched');
  };

  const bundle = await resolveServerBundle(DEFAULT_SERVER_VERSION, {
    platform: 'win32',
    arch: 'x64',
    fetch: failingFetch,
  });
  assert.equal(called, false);
  assert.equal(bundle.version, DEFAULT_SERVER_VERSION);
});

test('resolveServerBundle throws if caller signal already aborted even for offline default', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Pre-aborted'));
  await assert.rejects(
    () =>
      resolveServerBundle(DEFAULT_SERVER_VERSION, {
        signal: controller.signal,
      }),
    /Pre-aborted/,
  );
});

test('resolveServerBundle fails unsupported platform/arch and unsafe version before fetch', async () => {
  let called = false;
  const guardFetch: typeof fetch = async () => {
    called = true;
    throw new Error('Should not be called');
  };

  await assert.rejects(
    () => resolveServerBundle('263.7084.0', { platform: 'unsupported', fetch: guardFetch }),
    /No IntelliJ server bundle for unsupported/,
  );
  assert.equal(called, false);

  await assert.rejects(
    () =>
      resolveServerBundle('../traversal', { platform: 'win32', arch: 'x64', fetch: guardFetch }),
    /Invalid server version "\.\.\/traversal"/,
  );
  assert.equal(called, false);

  await assert.rejects(
    () => resolveServerBundle('latest', { platform: 'unknown-os', fetch: guardFetch }),
    /No IntelliJ server bundle for unknown-os/,
  );
  assert.equal(called, false);
});

test('resolveServerBundle latest reuses pinned bundle if resolved version matches default', async () => {
  const manifestFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr === LATEST_VERSION_URL) {
      return new Response(`M.version = '${DEFAULT_SERVER_VERSION}'`, { status: 200 });
    }
    throw new Error(`Unexpected request to ${urlStr}`);
  };

  const bundle = await resolveServerBundle('latest', {
    platform: 'win32',
    arch: 'x64',
    fetch: manifestFetch,
  });
  assert.equal(bundle.version, DEFAULT_SERVER_VERSION);
  assert.equal(bundle.sha256, serverBundle('win32', 'x64').sha256);
});

test('resolveServerBundle fetches sidecar from CDN for new version and verifies checksum', async () => {
  const newVersion = '263.8000.0';
  const expectedHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  let sidecarRequested = false;

  const mockFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.endsWith(`intellij-server-${newVersion}.win.zip.sha256`)) {
      sidecarRequested = true;
      return new Response(`${expectedHash} *intellij-server-${newVersion}.win.zip\n`, {
        status: 200,
      });
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  };

  const bundle = await resolveServerBundle(newVersion, {
    platform: 'win32',
    arch: 'x64',
    fetch: mockFetch,
  });

  assert.equal(sidecarRequested, true);
  assert.equal(bundle.version, newVersion);
  assert.equal(bundle.sha256, expectedHash);
  assert.equal(bundle.archive, 'zip');
  assert.match(bundle.url, new RegExp(`intellij-server-${newVersion}\\.win\\.zip$`));
});

test('resolveServerBundle latest with new version queries manifest then sidecar', async () => {
  const newVersion = '263.9000.1';
  const expectedHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  const mockFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr === LATEST_VERSION_URL) {
      return new Response(`M.version = '${newVersion}'`, { status: 200 });
    }
    if (urlStr.endsWith(`intellij-server-${newVersion}.tar.gz.sha256`)) {
      return new Response(`${expectedHash} *intellij-server-${newVersion}.tar.gz\n`, {
        status: 200,
      });
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  };

  const bundle = await resolveServerBundle('latest', {
    platform: 'linux',
    arch: 'x64',
    fetch: mockFetch,
  });

  assert.equal(bundle.version, newVersion);
  assert.equal(bundle.sha256, expectedHash);
  assert.equal(bundle.archive, 'tar.gz');
});

test('resolveServerBundle rejects mismatched sidecar basename or missing file', async () => {
  const newVersion = '263.8000.0';
  const hash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

  const wrongNameFetch: typeof fetch = async () =>
    new Response(`${hash} *wrong-archive-name.zip`, { status: 200 });

  await assert.rejects(
    () =>
      resolveServerBundle(newVersion, {
        platform: 'win32',
        arch: 'x64',
        fetch: wrongNameFetch,
      }),
    /archive basename mismatch/,
  );

  const notFoundFetch: typeof fetch = async () => new Response('Not Found', { status: 404 });
  await assert.rejects(
    () =>
      resolveServerBundle(newVersion, {
        platform: 'win32',
        arch: 'x64',
        fetch: notFoundFetch,
      }),
    /Failed to fetch SHA-256 for 263\.8000\.0/,
  );
});
