import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  extractVsixConfig,
  LATEST_VERSION_URL,
  latestServerVersion,
  mergeMarketplaceConfig,
  parseLatestVersionFromLua,
  parseSha256Sidecar,
  updateServerBundle,
  validateServerVersion,
} from '../scripts/update-server-bundle.mjs';

const oversizedEntry =
  'UEsDBBQAAAAIAJFTY10oSGHFVQAAAHARAQAcAAAAZXh0ZW5zaW9uL3NlcnZlci1idW5kbGUuanNvbu3BMQEAAADCoNqLbwlPoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAzgZQSwECFAAUAAAACACRU2NdKEhhxVUAAABwEQEAHAAAAAAAAAAAAAAAgAEAAAAAZXh0ZW5zaW9uL3NlcnZlci1idW5kbGUuanNvblBLBQYAAAAAAQABAEoAAACPAAAAAAA=';

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

function sources(lua, vsix = validVsix) {
  return async (input) => {
    const url = String(input);
    if (url === LATEST_VERSION_URL) {
      if (lua === null) return new Response('Not found', { status: 404 });
      return new Response(`M.version = '${lua}'`);
    }
    if (url === `${base}/win32-x64/latest`) {
      return Response.json(metadata);
    }
    if (url === download) {
      return new Response(Buffer.from(vsix, 'base64'));
    }
    throw new Error(`Unexpected request to ${url}`);
  };
}

test('validateServerVersion accepts 3 or 4 segments and rejects invalid inputs', () => {
  assert.equal(validateServerVersion('271.2085.0'), '271.2085.0');
  assert.equal(validateServerVersion('271.2085.0.1'), '271.2085.0.1');
  assert.throws(() => validateServerVersion('latest'), /Invalid server version "latest"/);
  assert.throws(() => validateServerVersion('invalid'), /Invalid server version "invalid"/);
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

test('parseSha256Sidecar handles standard sha256sum outputs and normalizes lowercase', () => {
  const hash = 'd84629cbdd79d58f021a15a75f05018518398906519a0e830df6f8a8d515e286';
  const name = 'intellij-server-263.7084.0.win.zip';

  assert.equal(parseSha256Sidecar(`${hash} *${name}`, name), hash);
  assert.equal(parseSha256Sidecar(`${hash}  ${name}`, name), hash);
  assert.equal(parseSha256Sidecar(hash, name), hash);
  assert.equal(parseSha256Sidecar(hash.toUpperCase(), name), hash);
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

test('latestServerVersion compares numeric builds and detects a reachable stale Lua manifest', async () => {
  for (const [lua, expected] of [
    ['263.999.0', '263.9000.0'],
    ['263.9000.0', '263.9000.0'],
    ['263.10000.0', '263.10000.0'],
    ['263.9000.0.1', '263.9000.0.1'],
  ]) {
    assert.equal(await latestServerVersion({ ...options, fetch: sources(lua) }), expected);
  }
});

test('latestServerVersion survives Lua failure when Open VSX succeeds', async () => {
  assert.equal(await latestServerVersion({ ...options, fetch: sources(null) }), '263.9000.0');
});

test('invalid registry and archive metadata cannot override a valid Lua source', async () => {
  const lua = '263.8000.0';
  assert.equal(await latestServerVersion({ ...options, fetch: sources(lua, unsafeVsix) }), lua);
  await assert.rejects(
    latestServerVersion({ ...options, fetch: sources(null, unsafeVsix) }),
    /Invalid server version|Invalid Open VSX/,
  );
});

test('archive size and decompression output are bounded and malformed ZIPs fail explicitly', async () => {
  for (const response of [
    () => new Response('x', { headers: { 'content-length': String(5 * 1024 * 1024) } }),
    () => new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
    () => new Response('not a zip'),
    () => new Response(Buffer.from(oversizedEntry, 'base64')),
  ]) {
    const fallback = sources(null);
    const fetchFn = (input, init) =>
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
  const fetchFn = async (input, init) => {
    if (String(input) === download) controller.abort(new Error('user cancelled'));
    return fallback(input, init);
  };
  await assert.rejects(
    latestServerVersion({ ...options, fetch: fetchFn, signal: controller.signal }),
    /user cancelled/,
  );
});

test('only the matching Eclipse storage redirect is followed', async () => {
  const storage =
    'https://openvsx.eclipsecontent.org/JetBrains/intellij-server/win32-x64/1.0.27/JetBrains.intellij-server-1.0.27@win32-x64.vsix';
  for (const target of [storage, 'https://untrusted.example/ext.vsix']) {
    const fallback = sources(null);
    const requested = [];
    const fetchFn = async (input, init) => {
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

function createMockCdnFetch({ failOnUrl = null, missingLength = false } = {}) {
  return async (input, init) => {
    const url = String(input);
    if (failOnUrl && url.includes(failOnUrl)) {
      return new Response('Not found', { status: 404, statusText: 'Not Found' });
    }
    if (url.endsWith('.sha256')) {
      const filename = url.slice(url.lastIndexOf('/') + 1, -'.sha256'.length);
      const fakeHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      return new Response(`${fakeHash} *${filename}\n`, { status: 200 });
    }
    if (init?.method === 'HEAD') {
      if (missingLength) {
        return new Response(null, { status: 200 });
      }
      return new Response(null, {
        status: 200,
        headers: { 'content-length': '123456789' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

test('updateServerBundle generates correct content and atomically writes file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-bundle-test-'));
  const targetFile = join(dir, 'bundle-metadata.ts');
  try {
    const fetchFn = createMockCdnFetch();
    const code = await updateServerBundle({
      version: '271.2085.0',
      fetch: fetchFn,
      outputPath: targetFile,
    });
    assert.equal(code, 0);

    const content = await readFile(targetFile, 'utf8');
    assert.match(content, /export const DEFAULT_SERVER_VERSION = '271\.2085\.0';/);
    assert.match(content, /darwin:\s*{\s*extension:\s*'sit',/);
    assert.match(content, /linux:\s*{\s*extension:\s*'tar\.gz',/);
    assert.match(content, /win32:\s*{\s*extension:\s*'win\.zip',/);
    assert.match(content, /1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef/);
    assert.match(content, /123456789/);

    // Running check against identical file returns 0
    const checkCode = await updateServerBundle({
      version: '271.2085.0',
      check: true,
      fetch: fetchFn,
      outputPath: targetFile,
    });
    assert.equal(checkCode, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('updateServerBundle check returns 1 when metadata differs or file is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-bundle-test-diff-'));
  const targetFile = join(dir, 'bundle-metadata.ts');
  try {
    const fetchFn = createMockCdnFetch();

    // File missing
    const missingCode = await updateServerBundle({
      version: '271.2085.0',
      check: true,
      fetch: fetchFn,
      outputPath: targetFile,
    });
    assert.equal(missingCode, 1);

    // Write older version
    await writeFile(targetFile, "export const DEFAULT_SERVER_VERSION = '263.7084.0';", 'utf8');
    const diffCode = await updateServerBundle({
      version: '271.2085.0',
      check: true,
      fetch: fetchFn,
      outputPath: targetFile,
    });
    assert.equal(diffCode, 1);
    const content = await readFile(targetFile, 'utf8');
    assert.equal(content, "export const DEFAULT_SERVER_VERSION = '263.7084.0';");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('updateServerBundle leaves target untouched if any platform fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-bundle-fail-'));
  const targetFile = join(dir, 'bundle-metadata.ts');
  const initialContent = '// initial untouched content';
  await writeFile(targetFile, initialContent, 'utf8');
  try {
    // Fail on linux-x64 sha256
    const fetchFn = createMockCdnFetch({
      failOnUrl: 'intellij-server-271.2085.0.tar.gz.sha256',
    });
    await assert.rejects(
      () =>
        updateServerBundle({
          version: '271.2085.0',
          fetch: fetchFn,
          outputPath: targetFile,
        }),
      /Failed to fetch SHA-256/,
    );
    const content = await readFile(targetFile, 'utf8');
    assert.equal(content, initialContent);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('updateServerBundle fails if HEAD response is missing Content-Length', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-bundle-cl-'));
  const targetFile = join(dir, 'bundle-metadata.ts');
  try {
    const fetchFn = createMockCdnFetch({
      missingLength: true,
    });
    await assert.rejects(
      () =>
        updateServerBundle({
          version: '271.2085.0',
          fetch: fetchFn,
          outputPath: targetFile,
        }),
      /Missing Content-Length header/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractVsixConfig parses activationEvents, markers, fileTypes, and inlay hints', () => {
  const samplePackageJson = {
    activationEvents: [
      'onLanguage:java',
      'workspaceContains:*/BUILD.bazel',
      'workspaceContains:MODULE.bazel',
      'workspaceContains:build.gradle',
      'workspaceContains:pom.xml',
    ],
    contributes: {
      configuration: [
        {
          properties: {
            'jetbrains.java.hints.collapse complex types': { default: true },
            'jetbrains.java.hints.unused': { default: false },
            'jetbrains.kotlin.hints.settings.types.property': { default: true },
            'jetbrains.kotlin.hints.lambda.receivers.parameters': { default: true },
            'jetbrains.kotlin.hints.call.chains': { default: false },
          },
        },
      ],
    },
  };

  const config = extractVsixConfig(samplePackageJson);
  assert.ok(config.rootMarkers.includes('BUILD.bazel'));
  assert.ok(config.rootMarkers.includes('MODULE.bazel'));
  assert.ok(config.rootMarkers.includes('WORKSPACE'));
  assert.ok(config.rootMarkers.includes('.bazelproject'));
  assert.ok(config.fileTypes.includes('.properties'));
  assert.ok(config.fileTypes.includes('.bazelproject'));
  assert.equal(config.settings['jetbrains.java']['hints.collapse complex types'], true);
  assert.equal(config.settings['jetbrains.java']['hints.unused'], undefined);
  assert.equal(config.settings['jetbrains.kotlin']['hints.settings.types.property'], true);
  assert.equal(config.settings['jetbrains.kotlin']['hints.lambda.receivers.parameters'], true);
  assert.equal(config.settings['jetbrains.kotlin']['hints.call.chains'], undefined);
});

test('mergeMarketplaceConfig merges LSP and DAP configurations correctly', () => {
  const baseMarketplace = {
    name: 'omp-intellij',
    plugins: [
      {
        name: 'omp-intellij',
        lspServers: {
          'intellij-server': {
            fileTypes: ['.java'],
            rootMarkers: ['pom.xml'],
            settings: {},
          },
        },
        dapAdapters: {
          intellij: { rootMarkers: ['pom.xml'] },
          'intellij-test': { rootMarkers: ['pom.xml'] },
        },
      },
    ],
  };

  const extracted = {
    rootMarkers: ['pom.xml', 'BUILD.bazel', '*.iml'],
    fileTypes: ['.java', '.kt', '.bazelproject'],
    settings: {
      'jetbrains.java': { 'hints.types.local variable': true },
    },
  };

  const merged = mergeMarketplaceConfig(baseMarketplace, extracted);
  assert.deepEqual(merged.plugins[0].lspServers['intellij-server'].fileTypes, [
    '.java',
    '.kt',
    '.bazelproject',
  ]);
  assert.deepEqual(merged.plugins[0].lspServers['intellij-server'].rootMarkers, [
    'pom.xml',
    'BUILD.bazel',
    '*.iml',
  ]);
  assert.deepEqual(merged.plugins[0].lspServers['intellij-server'].settings['jetbrains.java'], {
    'hints.types.local variable': true,
  });
  // DAP adapters filter out *.iml
  assert.deepEqual(merged.plugins[0].dapAdapters.intellij.rootMarkers, ['pom.xml', 'BUILD.bazel']);
  assert.deepEqual(merged.plugins[0].dapAdapters['intellij-test'].rootMarkers, [
    'pom.xml',
    'BUILD.bazel',
  ]);
});
