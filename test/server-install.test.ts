import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { ServerBundle } from '../src/server/bundles.js';
import {
  ensureInstalled,
  findInstalled,
  type InstallState,
  listInstalledVersions,
  readInstallState,
  validateArchiveEntry,
} from '../src/server/install.js';

const execFileAsync = promisify(execFile);
const LAUNCHER_NAME =
  process.platform === 'win32' ? 'bin/intellij-server.exe' : 'bin/intellij-server';

interface MockServer {
  server: http.Server;
  url: string;
  port: number;
  requestCount: () => number;
  close: () => Promise<void>;
}

async function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<MockServer> {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    handler(req, res);
  });

  const { promise, resolve: resPromise, reject: rejPromise } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => resPromise());
  server.on('error', (err) => rejPromise(err));
  await promise;

  const addr = server.address();
  if (!addr || typeof addr !== 'object') {
    throw new Error('Failed to obtain server address');
  }

  const port = addr.port;
  const url = `http://127.0.0.1:${port}`;

  return {
    server,
    url,
    port,
    requestCount: () => count,
    close: async () => {
      const {
        promise: closePromise,
        resolve: resClose,
        reject: rejClose,
      } = Promise.withResolvers<void>();
      server.close((err) => {
        if (err) rejClose(err);
        else resClose();
      });
      await closePromise;
    },
  };
}

async function createTestArchive(options: {
  dir: string;
  name: string;
  kind: 'zip' | 'tar.gz';
  wrapFolder?: string;
  files?: Record<string, string>;
}): Promise<{ archivePath: string; sha256: string; size: number }> {
  const staging = join(options.dir, `archive_stage_${options.name}`);
  await mkdir(staging, { recursive: true });

  const baseDir = options.wrapFolder ? join(staging, options.wrapFolder) : staging;
  const files = options.files ?? {
    [LAUNCHER_NAME]: 'mock-intellij-server-binary-content',
  };

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(baseDir, relPath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
  }

  const archivePath = join(options.dir, options.name);
  if (options.kind === 'tar.gz') {
    await execFileAsync('tar', ['-czf', archivePath, '-C', staging, '.']);
  } else {
    if (process.platform === 'linux') {
      try {
        await execFileAsync('zip', ['-r', archivePath, '.'], { cwd: staging });
      } catch {
        await execFileAsync('tar', ['--format=zip', '-cf', archivePath, '-C', staging, '.']);
      }
    } else {
      await execFileAsync('tar', ['--format=zip', '-cf', archivePath, '-C', staging, '.']);
    }
  }

  const content = await readFile(archivePath);
  const hash = createHash('sha256').update(content).digest('hex');
  return { archivePath, sha256: hash, size: content.length };
}

test('streamed download and install succeeds with progress, receipt, and fast path reuse', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const archiveInfo = await createTestArchive({
    dir: tempRoot,
    name: 'bundle.zip',
    kind: 'zip',
  });

  const mockServer = await startMockServer(async (_req, res) => {
    const buf = await readFile(archiveInfo.archivePath);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': buf.length.toString(),
    });
    res.end(buf);
  });
  t.after(() => mockServer.close());

  const bundle: ServerBundle = {
    version: '1.0.0-test',
    url: `${mockServer.url}/bundle.zip`,
    sha256: archiveInfo.sha256,
    size: archiveInfo.size,
    archive: 'zip',
  };

  const installDir = join(tempRoot, 'install dir with spaces');
  const observedPhases: string[] = [];

  const result = await ensureInstalled(installDir, {
    bundle,
    onProgress: (state: InstallState) => {
      observedPhases.push(state.phase);
    },
  });

  assert.equal(result.version, '1.0.0-test');
  assert.equal(result.installDir, resolve(installDir));
  assert.ok(result.executable.includes('1.0.0-test'));

  const exeStat = await stat(result.executable);
  assert.ok(exeStat.isFile());
  const exeContent = await readFile(result.executable, 'utf8');
  assert.equal(exeContent, 'mock-intellij-server-binary-content');

  const state = await readInstallState(installDir);
  assert.equal(state?.phase, 'ready');
  assert.equal(state?.executable, result.executable);
  assert.equal(state?.version, '1.0.0-test');
  assert.ok(observedPhases.includes('downloading'));
  assert.ok(observedPhases.includes('verifying'));
  assert.ok(observedPhases.includes('extracting'));
  assert.ok(observedPhases.includes('ready'));

  const reqsBefore = mockServer.requestCount();
  const cachedResult = await ensureInstalled(installDir, { bundle });
  assert.deepEqual(cachedResult, result);
  assert.equal(mockServer.requestCount(), reqsBefore);
});

test('installing another version retains usable older versions and a checksum failure cannot replace them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'omp-version-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await createTestArchive({
    dir: root,
    name: 'first.zip',
    kind: 'zip',
    files: { [LAUNCHER_NAME]: 'first-version-launcher' },
  });
  const second = await createTestArchive({
    dir: root,
    name: 'second.zip',
    kind: 'zip',
    files: { [LAUNCHER_NAME]: 'second-version-launcher' },
  });
  const server = await startMockServer(async (request, response) => {
    const archive = request.url === '/first.zip' ? first : second;
    response.end(await readFile(archive.archivePath));
  });
  t.after(() => server.close());
  const installDir = join(root, 'installed');
  const descriptor = (version: string, archive: typeof first, path: string): ServerBundle => ({
    version,
    url: `${server.url}/${path}`,
    sha256: archive.sha256,
    archive: 'zip',
  });
  await ensureInstalled(installDir, { bundle: descriptor('263.1000.0', first, 'first.zip') });
  await ensureInstalled(installDir, { bundle: descriptor('263.2000.0', second, 'second.zip') });
  await assert.rejects(
    ensureInstalled(installDir, {
      bundle: { ...descriptor('263.3000.0', second, 'second.zip'), sha256: '0'.repeat(64) },
    }),
    /checksum|sha-?256/i,
  );
  assert.deepEqual(
    (await listInstalledVersions(installDir)).map((entry) => entry.version),
    ['263.2000.0', '263.1000.0'],
  );
  // The rejected version must not be activated, and the failure must be recorded.
  await assert.rejects(stat(join(installDir, 'versions', '263.3000.0')), (err: unknown) =>
    Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT'),
  );
  const failedState = await readInstallState(installDir);
  assert.equal(failedState?.phase, 'failed');
  assert.match(failedState?.error ?? '', /checksum|sha-?256/i);
  const previous = await findInstalled(installDir, { version: '263.1000.0' });
  assert.ok(previous);
  assert.equal(await readFile(previous.executable, 'utf8'), 'first-version-launcher');
  const current = await findInstalled(installDir, { version: '263.2000.0' });
  assert.ok(current);
  assert.equal(await readFile(current.executable, 'utf8'), 'second-version-launcher');
});

test('archive with single top-level wrapper directory is normalized correctly', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const archiveInfo = await createTestArchive({
    dir: tempRoot,
    name: 'wrapped-bundle.zip',
    kind: 'zip',
    wrapFolder: 'intellij-server-263.7084.0',
    files: {
      [LAUNCHER_NAME]: 'wrapped-binary',
    },
  });

  const mockServer = await startMockServer(async (_req, res) => {
    const buf = await readFile(archiveInfo.archivePath);
    res.writeHead(200, {
      'Content-Length': buf.length.toString(),
    });
    res.end(buf);
  });
  t.after(() => mockServer.close());

  const bundle: ServerBundle = {
    version: '263.7084.0',
    url: `${mockServer.url}/wrapped.zip`,
    sha256: archiveInfo.sha256,
    size: archiveInfo.size,
    archive: 'zip',
  };

  const installDir = join(tempRoot, 'install_wrapped');
  const result = await ensureInstalled(installDir, { bundle });

  assert.equal(result.version, '263.7084.0');
  const content = await readFile(result.executable, 'utf8');
  assert.equal(content, 'wrapped-binary');

  const receiptPath = join(installDir, 'versions', '263.7084.0', 'receipt.json');
  const receiptJson = JSON.parse(await readFile(receiptPath, 'utf8')) as {
    version?: string;
    sha256?: string;
    launcher?: string;
  };
  assert.equal(receiptJson.version, '263.7084.0');
  assert.equal(receiptJson.sha256, archiveInfo.sha256.toLowerCase());
  assert.equal(receiptJson.launcher, LAUNCHER_NAME);
});

test('HTTP failure (404) fails gracefully with explicit error and cleans up temp files', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const mockServer = await startMockServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
  });
  t.after(() => mockServer.close());

  const installDir = join(tempRoot, 'install_404');
  const bundle: ServerBundle = {
    version: '404-test',
    url: `${mockServer.url}/nonexistent.zip`,
    sha256: 'a'.repeat(64),
    archive: 'zip',
  };

  await assert.rejects(() => ensureInstalled(installDir, { bundle }), /HTTP 404/);

  const state = await readInstallState(installDir);
  assert.equal(state?.phase, 'failed');
  assert.ok(state?.error?.includes('HTTP 404'));

  await assert.rejects(stat(join(installDir, 'install.lock')), (err: unknown) =>
    Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT'),
  );
});

test('extraction failure when launcher is missing rejects without activating version', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const archiveInfo = await createTestArchive({
    dir: tempRoot,
    name: 'missing-launcher.zip',
    kind: 'zip',
    files: {
      'bin/unrelated-helper.txt': 'not a launcher',
    },
  });

  const mockServer = await startMockServer(async (_req, res) => {
    const buf = await readFile(archiveInfo.archivePath);
    res.writeHead(200, { 'Content-Length': buf.length.toString() }).end(buf);
  });
  t.after(() => mockServer.close());

  const installDir = join(tempRoot, 'install_no_launcher');
  const bundle: ServerBundle = {
    version: 'missing-launcher-version',
    url: `${mockServer.url}/missing.zip`,
    sha256: archiveInfo.sha256,
    archive: 'zip',
  };

  await assert.rejects(
    () => ensureInstalled(installDir, { bundle }),
    /does not contain the expected IntelliJ launcher/,
  );

  await assert.rejects(
    stat(join(installDir, 'versions', 'missing-launcher-version')),
    (err: unknown) =>
      Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT'),
  );

  const state = await readInstallState(installDir);
  assert.equal(state?.phase, 'failed');
});

test('validateArchiveEntry rejects traversing and absolute paths', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const stagingDir = join(tempRoot, 'staging');
  await mkdir(stagingDir, { recursive: true });

  assert.throws(() => validateArchiveEntry('../escape.txt', stagingDir), /traversing path segment/);
  assert.throws(() => validateArchiveEntry('foo/../../bar', stagingDir), /traversing path segment/);
  assert.throws(() => validateArchiveEntry('/etc/passwd', stagingDir), /unsafe absolute entry/);
  assert.throws(
    () => validateArchiveEntry('\\windows\\system32', stagingDir),
    /unsafe absolute entry/,
  );
  assert.throws(() => validateArchiveEntry('C:\\foo', stagingDir), /unsafe absolute entry/);
});

test('bundle version validation rejects path separators, dots, and traversal segments', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  for (const badVersion of ['.', '..', '.hidden', '../escape', 'foo/bar', 'foo\\bar', ' ']) {
    const bundle: ServerBundle = {
      version: badVersion,
      url: 'http://127.0.0.1:9999/test.zip',
      sha256: 'a'.repeat(64),
      archive: 'zip',
    };

    await assert.rejects(
      () => ensureInstalled(tempRoot, { bundle }),
      /must be a safe single path segment|must not be empty/,
    );
  }
});

test('corrupted archive bytes with valid checksum fails extraction and cleans up', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const corruptBuf = Buffer.from('corrupted-archive-header-and-body-not-valid-archive');
  const corruptHash = createHash('sha256').update(corruptBuf).digest('hex');

  const mockServer = await startMockServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': corruptBuf.length.toString(),
    });
    res.end(corruptBuf);
  });
  t.after(() => mockServer.close());

  const installDir = join(tempRoot, 'install_corrupt');
  const bundle: ServerBundle = {
    version: 'corrupt-bytes-v1',
    url: `${mockServer.url}/corrupt.zip`,
    sha256: corruptHash,
    size: corruptBuf.length,
    archive: 'zip',
  };

  await assert.rejects(() => ensureInstalled(installDir, { bundle }));

  await assert.rejects(stat(join(installDir, 'versions', 'corrupt-bytes-v1')), (err: unknown) =>
    Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT'),
  );

  const state = await readInstallState(installDir);
  assert.equal(state?.phase, 'failed');
});

test('waiter cancellation in separate process exits cleanly without timer leak', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const installDir = join(tempRoot, 'child_timer_leak');
  const lockDir = join(installDir, 'install.lock');
  await mkdir(lockDir, { recursive: true });

  await writeFile(
    join(lockDir, 'owner.json'),
    JSON.stringify({
      token: 'held-token',
      pid: process.pid,
      installId: 'held-job',
      createdAt: Date.now(),
    }),
    'utf8',
  );

  const moduleUrl = new URL('../src/server/install.js', import.meta.url).href;
  const script = `
    import { ensureInstalled } from ${JSON.stringify(moduleUrl)};
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('waiter cancelled')), 20);
    try {
      await ensureInstalled(${JSON.stringify(installDir)}, {
        bundle: {
          version: 'timer-check-v1',
          url: 'http://127.0.0.1:9999/bundle.zip',
          sha256: 'a'.repeat(64),
          archive: 'zip',
        },
        signal: controller.signal,
        timeoutMs: 600000,
      });
      process.exit(1);
    } catch {
      process.exit(0);
    }
  `;

  const startTime = Date.now();
  await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 5000,
    cwd: process.cwd(),
  });
  const elapsed = Date.now() - startTime;
  assert.ok(
    elapsed < 4500,
    `Child process should exit cleanly without hanging on timer (took ${elapsed}ms)`,
  );
});

test('refuses to overwrite an existing unowned version directory', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const archiveInfo = await createTestArchive({
    dir: tempRoot,
    name: 'test.zip',
    kind: 'zip',
  });

  const mockServer = await startMockServer(async (_req, res) => {
    const buf = await readFile(archiveInfo.archivePath);
    res.writeHead(200, { 'Content-Length': buf.length.toString() }).end(buf);
  });
  t.after(() => mockServer.close());

  const installDir = join(tempRoot, 'install_unowned');
  const targetDir = join(installDir, 'versions', 'unowned-version');
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, 'foreign.txt'), 'do-not-delete-me', 'utf8');

  const bundle: ServerBundle = {
    version: 'unowned-version',
    url: `${mockServer.url}/test.zip`,
    sha256: archiveInfo.sha256,
    archive: 'zip',
  };

  await assert.rejects(
    () => ensureInstalled(installDir, { bundle }),
    /already exists and is not an active owned installation/,
  );

  assert.equal(await readFile(join(targetDir, 'foreign.txt'), 'utf8'), 'do-not-delete-me');
});

test('invalid platform, architecture or escaping launcher receipts are never reused', async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'omp receipt check '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installDir = join(root, 'managed');
  const versionDir = join(installDir, 'versions', 'receipt-check');
  await mkdir(join(versionDir, 'bin'), { recursive: true });
  await writeFile(join(versionDir, LAUNCHER_NAME), 'existing launcher');
  const outside = join(root, 'outside-executable');
  await writeFile(outside, 'must not be selected');
  const bundle: ServerBundle = {
    version: 'receipt-check',
    url: 'http://127.0.0.1:1/must-not-download',
    sha256: 'a'.repeat(64),
    archive: 'zip',
  };
  for (const invalid of [
    { platform: 'unsupported-os' },
    { arch: 'unsupported-arch' },
    { launcher: '../../../outside-executable' },
    { launcher: outside },
  ]) {
    await writeFile(
      join(versionDir, 'receipt.json'),
      JSON.stringify({
        version: bundle.version,
        sha256: bundle.sha256,
        platform: process.platform,
        arch: process.arch,
        launcher: LAUNCHER_NAME,
        ...invalid,
      }),
    );
    await assert.rejects(
      ensureInstalled(installDir, { bundle }),
      /version directory already exists/,
    );
  }
  assert.equal(await readFile(outside, 'utf8'), 'must not be selected');
  assert.equal(await readFile(join(versionDir, LAUNCHER_NAME), 'utf8'), 'existing launcher');
});

test('cancellation via AbortSignal aborts download, cleans temporary files, and releases lock', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const { promise: canFinishPromise, resolve: finishStream } = Promise.withResolvers<void>();

  const mockServer = await startMockServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': '1000000',
    });
    res.write(Buffer.alloc(1000, 1));
    canFinishPromise.then(() => {
      res.end(Buffer.alloc(999000, 2));
    });
  });
  t.after(async () => {
    finishStream();
    await mockServer.close();
  });

  const installDir = join(tempRoot, 'install_cancel');
  const controller = new AbortController();

  let aborted = false;
  const installPromise = ensureInstalled(installDir, {
    bundle: {
      version: 'cancel-version',
      url: `${mockServer.url}/slow.zip`,
      sha256: 'b'.repeat(64),
      archive: 'zip',
    },
    signal: controller.signal,
    onProgress: (state: InstallState) => {
      if (state.phase === 'downloading' && !aborted) {
        aborted = true;
        controller.abort();
      }
    },
  });

  await assert.rejects(
    () => installPromise,
    (err: unknown) => {
      if (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))) {
        return true;
      }
      return false;
    },
  );

  finishStream();

  const lockDir = join(installDir, 'install.lock');
  await assert.rejects(stat(lockDir), (err: unknown) =>
    Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT'),
  );
});

test('download timeout cancels stalled download and cleans up resources', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const mockServer = await startMockServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': '1000000',
    });
    res.write(Buffer.alloc(100, 1));
    // Intentionally never close/end response
  });
  t.after(() => mockServer.close());

  const installDir = join(tempRoot, 'install_timeout');
  const bundle: ServerBundle = {
    version: 'timeout-v1',
    url: `${mockServer.url}/stalled.zip`,
    sha256: 'a'.repeat(64),
    archive: 'zip',
  };

  await assert.rejects(
    () => ensureInstalled(installDir, { bundle, timeoutMs: 150 }),
    /Timed out waiting for IntelliJ installation/,
  );

  const lockDir = join(installDir, 'install.lock');
  await assert.rejects(stat(lockDir), (err: unknown) =>
    Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT'),
  );
});

test('lock waiter cancellation does not delete another active process lock', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const installDir = join(tempRoot, 'install_waiter_cancel');
  const lockDir = join(installDir, 'install.lock');
  await mkdir(lockDir, { recursive: true });

  const owner = {
    token: 'active-owner-token',
    pid: process.pid,
    installId: 'active-install',
    createdAt: Date.now(),
  };
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify(owner), 'utf8');

  const waiterController = new AbortController();
  const bundle: ServerBundle = {
    version: 'waiter-cancel-v1',
    url: 'http://127.0.0.1:9999/bundle.zip',
    sha256: 'a'.repeat(64),
    archive: 'zip',
  };

  const waiterPromise = ensureInstalled(installDir, {
    bundle,
    signal: waiterController.signal,
    timeoutMs: 5000,
  });

  waiterController.abort(new Error('Waiter cancelled'));

  await assert.rejects(() => waiterPromise, /Waiter cancelled/);

  const lockStat = await stat(lockDir);
  assert.ok(lockStat.isDirectory());
  const ownerOnDisk = JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8')) as {
    token?: string;
  };
  assert.equal(ownerOnDisk.token, 'active-owner-token');
});

test('concurrent callers in same process share install without duplicate network download', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const archiveInfo = await createTestArchive({
    dir: tempRoot,
    name: 'concurrent.zip',
    kind: 'zip',
  });

  const { promise: proceedPromise, resolve: proceed } = Promise.withResolvers<void>();

  const mockServer = await startMockServer(async (_req, res) => {
    const buf = await readFile(archiveInfo.archivePath);
    res.writeHead(200, { 'Content-Length': buf.length.toString() });
    res.write(buf.subarray(0, 10));
    await proceedPromise;
    res.end(buf.subarray(10));
  });
  t.after(() => mockServer.close());

  const installDir = join(tempRoot, 'install_concurrent');
  const bundle: ServerBundle = {
    version: 'concurrent-v1',
    url: `${mockServer.url}/concurrent.zip`,
    sha256: archiveInfo.sha256,
    archive: 'zip',
  };

  const started = Promise.withResolvers<void>();
  const caller1Promise = ensureInstalled(installDir, {
    bundle,
    onProgress: (state: InstallState) => {
      if (state.phase === 'downloading') started.resolve();
    },
  });
  await started.promise;
  const caller2Promise = ensureInstalled(installDir, { bundle });
  proceed();
  const [res1, res2] = await Promise.all([caller1Promise, caller2Promise]);
  assert.deepEqual(res1, res2);
  assert.equal(mockServer.requestCount(), 1);
});

test('stale lock recovery cleans up dead owner lock and completes installation', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const archiveInfo = await createTestArchive({
    dir: tempRoot,
    name: 'stale.zip',
    kind: 'zip',
  });

  const mockServer = await startMockServer(async (_req, res) => {
    const buf = await readFile(archiveInfo.archivePath);
    res.writeHead(200, { 'Content-Length': buf.length.toString() }).end(buf);
  });
  t.after(() => mockServer.close());

  const installDir = join(tempRoot, 'install_stale');
  const lockDir = join(installDir, 'install.lock');
  await mkdir(lockDir, { recursive: true });

  const deadOwner = {
    token: 'dead-owner-token',
    pid: 99999999, // Unlikely to exist
    installId: 'dead-install',
    createdAt: Date.now() - 15000,
  };
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify(deadOwner), 'utf8');

  const bundle: ServerBundle = {
    version: 'stale-recovery-v1',
    url: `${mockServer.url}/stale.zip`,
    sha256: archiveInfo.sha256,
    archive: 'zip',
  };

  const result = await ensureInstalled(installDir, { bundle });
  assert.equal(result.version, 'stale-recovery-v1');
  const state = await readInstallState(installDir);
  assert.equal(state?.phase, 'ready');
});

test('readInstallState treats active dead-owner state as failed without mutating disk file', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const installDir = join(tempRoot, 'install_dead_state');
  await mkdir(installDir, { recursive: true });

  const originalState: InstallState = {
    installId: 'dead-owner-job',
    pid: 99999999,
    installDir,
    version: '1.2.3',
    phase: 'downloading',
    downloadedBytes: 500,
    totalBytes: 1000,
    updatedAt: Date.now() - 10000,
  };

  const statePath = join(installDir, 'install-state.json');
  await writeFile(statePath, JSON.stringify(originalState, null, 2), 'utf8');

  const observed = await readInstallState(installDir);
  assert.ok(observed);
  assert.equal(observed.phase, 'failed');
  assert.ok(observed.error?.includes('exited before completing'));

  const onDisk = JSON.parse(await readFile(statePath, 'utf8')) as { phase?: string };
  assert.equal(onDisk.phase, 'downloading');
});

test('unknown-total progress streams correctly without Content-Length', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'omp server install test '));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const archiveInfo = await createTestArchive({
    dir: tempRoot,
    name: 'chunked.zip',
    kind: 'zip',
  });

  const mockServer = await startMockServer(async (_req, res) => {
    const buf = await readFile(archiveInfo.archivePath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Transfer-Encoding': 'chunked',
    });
    const half = Math.floor(buf.length / 2);
    res.write(buf.subarray(0, half));
    res.write(buf.subarray(half));
    res.end();
  });
  t.after(() => mockServer.close());

  const installDir = join(tempRoot, 'install_chunked');
  const observedTotals: Array<number | undefined> = [];

  const bundle: ServerBundle = {
    version: 'chunked-v1',
    url: `${mockServer.url}/chunked.zip`,
    sha256: archiveInfo.sha256,
    archive: 'zip',
  };

  const result = await ensureInstalled(installDir, {
    bundle,
    onProgress: (state: InstallState) => {
      if (state.phase === 'downloading') {
        observedTotals.push(state.totalBytes);
      }
    },
  });

  assert.equal(result.version, 'chunked-v1');
  assert.ok(observedTotals.includes(undefined));
});
