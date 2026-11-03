import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LATEST_VERSION_URL,
  latestServerVersion,
  resolveServerBundle,
} from '../src/server/bundles.js';

const oversizedEntry =
  'UEsDBBQAAAAIAJFTY10oSGHFVQAAAHARAQAcAAAAZXh0ZW5zaW9uL3NlcnZlci1idW5kbGUuanNvbu3BMQEAAADCoNqLbwlPoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAzgZQSwECFAAUAAAACACRU2NdKEhhxVUAAABwEQEAHAAAAAAAAAAAAAAAgAEAAAAAZXh0ZW5zaW9uL3NlcnZlci1idW5kbGUuanNvblBLBQYAAAAAAQABAEoAAACPAAAAAAA=';

// Minimal ZIPs containing a valid bundle and a bundle with an off-origin URL.
const validVsix =
  'UEsDBBQAAAAIAGBTY10b59EegAAAABMBAAAcAAAAZXh0ZW5zaW9uL3NlcnZlci1idW5kbGUuanNvbqVNSwqDMBC9isy6ToKlQj1E7zDVQUdiIpMYoaV3L1kUoatC3+79n5BZowQPXQVNe8artRYtnCrY1BVxSmmNnTFD2L0LNODM6a4kPmIfFuPIjxuNXEfWzGrEJ3ZO5g8/Nr+t+rBwF48PWcstaT9J5hstXO5/K8WJmktb8vQn4PUGUEsBAhQAFAAAAAgAYFNjXRvn0R6AAAAAEwEAABwAAAAAAAAAAAAAAIABAAAAAGV4dGVuc2lvbi9zZXJ2ZXItYnVuZGxlLmpzb25QSwUGAAAAAAEAAQBKAAAAugAAAAAA';
const unsafeVsix =
  'UEsDBBQAAAAIAGBTY12wiybJcgAAAMsAAAAcAAAAZXh0ZW5zaW9uL3NlcnZlci1idW5kbGUuanNvbqWMUQoCMQwFr7Lk203LigvuIbxD0EAj3VqStiuKd5ci4gF8n8PMe0JjNbklWAaY5j0evffoYTdA1dhhKCXb4lxNRasVviDfac2RnbE2VnxI7jrpOUjjE63cM0mFY5Tr+LHG3zdukr6RBZoOc/fpz8HrDVBLAQIUABQAAAAIAGBTY12wiybJcgAAAMsAAAAcAAAAAAAAAAAAAACAAQAAAABleHRlbnNpb24vc2VydmVyLWJ1bmRsZS5qc29uUEsFBgAAAAABAAEASgAAAKwAAAAAAA==';
const base = 'https://open-vsx.org/api/JetBrains/intellij-server';
const download = `${base}/win32-x64/1.0.27/file/JetBrains.intellij-server-1.0.27@win32-x64.vsix`;
const metadata = {
  namespace: 'JetBrains',
  name: 'intellij-server',
  targetPlatform: 'win32-x64',
  version: '1.0.27',
  files: { download },
};
const options = { platform: 'win32', arch: 'x64' };

function sources(lua: string | null, vsix = validVsix): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url === LATEST_VERSION_URL) {
      return lua === null
        ? new Response('', { status: 503 })
        : new Response(`M.version = '${lua}'`);
    }
    if (url === `${base}/win32-x64/latest`) return Response.json(metadata);
    if (url === download) return new Response(Buffer.from(vsix, 'base64'));
    if (url.endsWith('/intellij-server-263.9000.0.win.zip.sha256')) {
      return new Response(`${'a'.repeat(64)} *intellij-server-263.9000.0.win.zip`);
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

test('remote discovery compares numeric builds and detects a reachable stale Lua manifest', async () => {
  for (const [lua, expected] of [
    ['263.999.0', '263.9000.0'],
    ['263.9000.0', '263.9000.0'],
    ['263.10000.0', '263.10000.0'],
    ['263.9000.0.1', '263.9000.0.1'],
  ]) {
    assert.equal(await latestServerVersion({ ...options, fetch: sources(lua) }), expected);
  }
});

test('Open VSX survives Lua failure and latest install resolves the discovered build', async () => {
  assert.equal(await latestServerVersion({ ...options, fetch: sources(null) }), '263.9000.0');
  const bundle = await resolveServerBundle('latest', { ...options, fetch: sources(null) });
  assert.equal(bundle.version, '263.9000.0');
  assert.equal(bundle.sha256, 'a'.repeat(64));
  assert.equal(
    bundle.url,
    'https://download.jetbrains.com/language-server/intellij-server/263.9000.0/intellij-server-263.9000.0.win.zip',
  );
});

test('invalid registry and archive metadata cannot override a valid Lua source', async () => {
  const lua = '263.8000.0';
  assert.equal(await latestServerVersion({ ...options, fetch: sources(lua, unsafeVsix) }), lua);
  await assert.rejects(
    latestServerVersion({ ...options, fetch: sources(null, unsafeVsix) }),
    /Invalid Open VSX server bundle/,
  );
  for (const changed of [
    { namespace: 'attacker' },
    { targetPlatform: 'linux-x64' },
    { preRelease: true },
    { version: '../bad' },
    { files: { download: 'https://untrusted.example/ext.vsix' } },
  ]) {
    const fallback = sources(null);
    const fetchFn: typeof fetch = (input, init) =>
      String(input) === `${base}/win32-x64/latest`
        ? Promise.resolve(Response.json({ ...metadata, ...changed }))
        : fallback(input, init);
    await assert.rejects(
      latestServerVersion({ ...options, fetch: fetchFn }),
      /Invalid Open VSX|Unexpected Open VSX/,
    );
  }
});

test('archive size and decompression output are bounded and malformed ZIPs fail explicitly', async () => {
  for (const response of [
    () => new Response('x', { headers: { 'content-length': String(5 * 1024 * 1024) } }),
    () => new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
    () => new Response('not a zip'),
    () => new Response(Buffer.from(oversizedEntry, 'base64')),
  ]) {
    const fallback = sources(null);
    const fetchFn: typeof fetch = (input, init) =>
      String(input) === download ? Promise.resolve(response()) : fallback(input, init);
    await assert.rejects(
      latestServerVersion({ ...options, fetch: fetchFn }),
      /maximum allowed size|Command failed|maxBuffer/,
    );
  }
});

test('both remote failures remain explicit and caller cancellation is never a successful fallback', async () => {
  await assert.rejects(
    latestServerVersion({ ...options, fetch: async () => new Response('', { status: 503 }) }),
    /Lua manifest: HTTP 503.*Open VSX metadata: HTTP 503/,
  );
  const controller = new AbortController();
  const fallback = sources('263.8000.0');
  const fetchFn: typeof fetch = async (input, init) => {
    if (String(input) === download) controller.abort(new Error('user cancelled'));
    return fallback(input, init);
  };
  await assert.rejects(
    latestServerVersion({ ...options, fetch: fetchFn, signal: controller.signal }),
    /user cancelled/,
  );
  let requested = false;
  await assert.rejects(
    latestServerVersion({
      ...options,
      signal: controller.signal,
      fetch: async () => {
        requested = true;
        throw new Error('unexpected request');
      },
    }),
    /user cancelled/,
  );
  assert.equal(requested, false);
});

test('only the matching Eclipse storage redirect is followed', async () => {
  const storage =
    'https://openvsx.eclipsecontent.org/JetBrains/intellij-server/win32-x64/1.0.27/JetBrains.intellij-server-1.0.27@win32-x64.vsix';
  for (const target of [storage, 'https://untrusted.example/ext.vsix']) {
    const fallback = sources(null);
    const requested: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      requested.push(url);
      if (url === download)
        return new Response(null, { status: 302, headers: { location: target } });
      if (url === storage) return new Response(Buffer.from(validVsix, 'base64'));
      return fallback(input, init);
    };
    if (target === storage) {
      assert.equal(await latestServerVersion({ ...options, fetch: fetchFn }), '263.9000.0');
    } else {
      await assert.rejects(
        latestServerVersion({ ...options, fetch: fetchFn }),
        /Unexpected Open VSX storage redirect/,
      );
      assert.equal(requested.includes(target), false);
    }
  }
});
