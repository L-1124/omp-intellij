import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';
import { type ServerBundle, serverBundle } from './server-bundles.js';

const execFileAsync = promisify(execFile);
const MISSING_OWNER_GRACE_MS = 10_000;
const MAX_BUFFER = 10 * 1024 * 1024;
const EXPECTED_LAUNCHER =
  process.platform === 'win32' ? 'bin/intellij-server.exe' : 'bin/intellij-server';

export type InstallPhase = 'downloading' | 'verifying' | 'extracting' | 'ready' | 'failed';

export interface InstallState {
  installId: string;
  pid: number;
  installDir: string;
  version: string;
  phase: InstallPhase;
  downloadedBytes: number;
  totalBytes?: number;
  updatedAt: number;
  error?: string;
  executable?: string;
}

export interface InstallResult {
  executable: string;
  version: string;
  installDir: string;
}

interface InstallReceipt {
  version: string;
  sha256: string;
  platform: string;
  arch: string;
  launcher: string;
  installedAt: number;
}

interface LockOwner {
  token: string;
  pid: number;
  installId: string;
  createdAt: number;
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isSafeInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function validateBundleVersion(version: string): void {
  if (!version?.trim()) {
    throw new Error('Server bundle version must not be empty');
  }
  if (
    version === '.' ||
    version === '..' ||
    version.startsWith('.') ||
    version.includes('/') ||
    version.includes('\\') ||
    !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(version)
  ) {
    throw new Error(
      `Invalid server bundle version (must be a safe single path segment): ${version}`,
    );
  }
}

function isValidInstallState(value: unknown): value is InstallState {
  if (!value || typeof value !== 'object') return false;
  if (!('installId' in value) || typeof value.installId !== 'string' || !value.installId.trim())
    return false;
  if (
    !('pid' in value) ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0
  )
    return false;
  if (!('installDir' in value) || typeof value.installDir !== 'string' || !value.installDir.trim())
    return false;
  if (!('version' in value) || typeof value.version !== 'string' || !value.version.trim())
    return false;
  if (!('phase' in value)) return false;
  if (
    value.phase !== 'downloading' &&
    value.phase !== 'verifying' &&
    value.phase !== 'extracting' &&
    value.phase !== 'ready' &&
    value.phase !== 'failed'
  ) {
    return false;
  }
  if (
    !('downloadedBytes' in value) ||
    typeof value.downloadedBytes !== 'number' ||
    !Number.isFinite(value.downloadedBytes) ||
    value.downloadedBytes < 0
  ) {
    return false;
  }
  if (
    'totalBytes' in value &&
    value.totalBytes !== undefined &&
    (typeof value.totalBytes !== 'number' ||
      !Number.isFinite(value.totalBytes) ||
      value.totalBytes < 0)
  ) {
    return false;
  }
  if (
    !('updatedAt' in value) ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt)
  )
    return false;
  if ('error' in value && value.error !== undefined && typeof value.error !== 'string')
    return false;
  if (
    'executable' in value &&
    value.executable !== undefined &&
    typeof value.executable !== 'string'
  )
    return false;
  return true;
}

export async function readInstallState(installDir: string): Promise<InstallState | null> {
  if (!installDir?.trim()) return null;
  const stateFile = join(installDir, 'install-state.json');
  let text: string;
  try {
    text = await readFile(stateFile, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isValidInstallState(parsed)) {
    return null;
  }

  if (
    parsed.phase === 'downloading' ||
    parsed.phase === 'verifying' ||
    parsed.phase === 'extracting'
  ) {
    if (!isProcessAlive(parsed.pid)) {
      return {
        ...parsed,
        phase: 'failed',
        error:
          parsed.error ?? `Install process ${parsed.pid} exited before completing installation`,
      };
    }
  }

  return parsed;
}

async function writeStateAtomically(installDir: string, state: InstallState): Promise<void> {
  await mkdir(installDir, { recursive: true });
  const tmpFile = join(installDir, `install-state.json.tmp.${state.installId}.${randomUUID()}`);
  const targetFile = join(installDir, 'install-state.json');
  try {
    const json = JSON.stringify(state, null, 2);
    await writeFile(tmpFile, json, 'utf8');
    await rename(tmpFile, targetFile);
  } catch (err) {
    await rm(tmpFile, { force: true }).catch(() => {});
    throw err;
  }
}

async function findInstalled(
  installDir: string,
  bundle: ServerBundle,
): Promise<InstallResult | null> {
  const versionDir = resolve(installDir, 'versions', bundle.version);
  const receiptFile = join(versionDir, 'receipt.json');
  try {
    const text = await readFile(receiptFile, 'utf8');
    const receipt: unknown = JSON.parse(text);
    if (
      receipt &&
      typeof receipt === 'object' &&
      'version' in receipt &&
      receipt.version === bundle.version &&
      'sha256' in receipt &&
      typeof receipt.sha256 === 'string' &&
      receipt.sha256.toLowerCase() === bundle.sha256.toLowerCase() &&
      'platform' in receipt &&
      receipt.platform === process.platform &&
      'arch' in receipt &&
      receipt.arch === process.arch &&
      'launcher' in receipt &&
      typeof receipt.launcher === 'string' &&
      receipt.launcher.trim().length > 0
    ) {
      const launcherTrimmed = receipt.launcher.trim();
      if (
        launcherTrimmed.startsWith('/') ||
        launcherTrimmed.startsWith('\\') ||
        /^[a-zA-Z]:/.test(launcherTrimmed) ||
        launcherTrimmed.split(/[/\\]+/).includes('..')
      ) {
        return null;
      }

      const launcherPath = resolve(versionDir, launcherTrimmed);
      if (!launcherPath.startsWith(versionDir + sep)) {
        return null;
      }

      const s = await stat(launcherPath);
      if (s.isFile()) {
        return {
          executable: launcherPath,
          version: bundle.version,
          installDir: resolve(installDir),
        };
      }
    }
  } catch {}
  return null;
}

function validateBundleUrl(urlStr: string): void {
  const parsed = new URL(urlStr);
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
      throw new Error(`Insecure HTTP download is only permitted for localhost in tests: ${urlStr}`);
    }
  } else if (parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol for server bundle: ${parsed.protocol}`);
  }
}

async function isLockStale(lockDir: string): Promise<boolean> {
  const ownerFile = join(lockDir, 'owner.json');
  let content: string | null = null;
  try {
    content = await readFile(ownerFile, 'utf8');
  } catch {
    // owner.json not yet written or read error
  }

  if (!content) {
    try {
      const s = await stat(lockDir);
      return Date.now() - s.mtimeMs > MISSING_OWNER_GRACE_MS;
    } catch {
      return false;
    }
  }

  try {
    const owner: unknown = JSON.parse(content);
    if (
      owner &&
      typeof owner === 'object' &&
      'pid' in owner &&
      typeof owner.pid === 'number' &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0
    ) {
      if (owner.pid === process.pid) {
        return false;
      }
      return !isProcessAlive(owner.pid);
    }
  } catch {
    try {
      const s = await stat(lockDir);
      return Date.now() - s.mtimeMs > MISSING_OWNER_GRACE_MS;
    } catch {
      return false;
    }
  }

  return false;
}

async function attemptStaleLockRecovery(lockDir: string, installDir: string): Promise<boolean> {
  const markerDir = join(lockDir, 'reclaim.marker');
  try {
    await mkdir(markerDir);
  } catch {
    return false;
  }

  try {
    if (!(await isLockStale(lockDir))) {
      await rm(markerDir, { recursive: true, force: true }).catch(() => {});
      return false;
    }

    const quarantine = join(installDir, `install.lock.quarantine-${randomUUID()}`);
    await rename(lockDir, quarantine);
    await rm(quarantine, { recursive: true, force: true }).catch(() => {});
    return true;
  } catch {
    await rm(markerDir, { recursive: true, force: true }).catch(() => {});
    return false;
  }
}

async function releaseLock(lockDir: string, token: string): Promise<void> {
  try {
    const ownerFile = join(lockDir, 'owner.json');
    const text = await readFile(ownerFile, 'utf8');
    const owner: unknown = JSON.parse(text);
    if (owner && typeof owner === 'object' && 'token' in owner && owner.token === token) {
      await rm(lockDir, { recursive: true, force: true });
    }
  } catch {
    // Lock might have already been released or overwritten
  }
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve: res, reject: rej } = Promise.withResolvers<void>();
  if (signal.aborted) {
    rej(
      signal.reason instanceof Error
        ? signal.reason
        : new Error(String(signal.reason ?? 'Aborted')),
    );
    return promise;
  }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    res();
  }, ms);
  function onAbort() {
    clearTimeout(timer);
    rej(
      signal.reason instanceof Error
        ? signal.reason
        : new Error(String(signal.reason ?? 'Aborted')),
    );
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return promise;
}

export function validateArchiveEntry(entry: string, stagingDir: string): void {
  const trimmed = entry.trim();
  if (!trimmed) return;

  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/.test(trimmed)) {
    throw new Error(`Archive contains unsafe absolute entry: ${trimmed}`);
  }

  const segments = trimmed.split(/[/\\]+/);
  for (const seg of segments) {
    if (seg === '..') {
      throw new Error(`Archive entry contains traversing path segment ('..'): ${trimmed}`);
    }
  }

  const resolvedStaging = resolve(stagingDir);
  const resolvedTarget = resolve(stagingDir, trimmed);
  if (!resolvedTarget.startsWith(resolvedStaging + sep) && resolvedTarget !== resolvedStaging) {
    throw new Error(`Archive entry escapes staging directory: ${trimmed}`);
  }
}

async function listArchiveEntries(
  archivePath: string,
  archiveKind: 'zip' | 'tar.gz',
  signal: AbortSignal,
): Promise<string[]> {
  if (archiveKind === 'tar.gz') {
    const { stdout } = await execFileAsync('tar', ['-tf', archivePath], {
      signal,
      maxBuffer: MAX_BUFFER,
    });
    return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  }

  if (process.platform === 'linux') {
    const { stdout } = await execFileAsync('unzip', ['-Z1', archivePath], {
      signal,
      maxBuffer: MAX_BUFFER,
    });
    return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  }

  const { stdout } = await execFileAsync('tar', ['-tf', archivePath], {
    signal,
    maxBuffer: MAX_BUFFER,
  });
  return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

async function extractArchive(
  archivePath: string,
  stagingDir: string,
  archiveKind: 'zip' | 'tar.gz',
  signal: AbortSignal,
): Promise<void> {
  const entries = await listArchiveEntries(archivePath, archiveKind, signal);
  for (const entry of entries) {
    validateArchiveEntry(entry, stagingDir);
  }

  if (archiveKind === 'tar.gz') {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', stagingDir], {
      signal,
      maxBuffer: MAX_BUFFER,
    });
  } else if (process.platform === 'linux') {
    await execFileAsync('unzip', ['-q', archivePath, '-d', stagingDir], {
      signal,
      maxBuffer: MAX_BUFFER,
    });
  } else {
    await execFileAsync('tar', ['-xf', archivePath, '-C', stagingDir], {
      signal,
      maxBuffer: MAX_BUFFER,
    });
  }
}

async function findAndPromoteLauncher(stagingDir: string): Promise<string> {
  const directPath = join(stagingDir, EXPECTED_LAUNCHER);
  try {
    const s = await stat(directPath);
    if (s.isFile()) {
      if (process.platform !== 'win32') {
        await chmod(directPath, 0o755);
      }
      return EXPECTED_LAUNCHER;
    }
  } catch {}

  const topEntries = await readdir(stagingDir);
  for (const entry of topEntries) {
    const childPath = join(stagingDir, entry);
    try {
      const s = await stat(childPath);
      if (s.isDirectory()) {
        const nestedPath = join(childPath, EXPECTED_LAUNCHER);
        try {
          const nestedStat = await stat(nestedPath);
          if (nestedStat.isFile()) {
            const innerItems = await readdir(childPath);
            for (const item of innerItems) {
              await rename(join(childPath, item), join(stagingDir, item));
            }
            await rm(childPath, { recursive: true, force: true });

            const promotedPath = join(stagingDir, EXPECTED_LAUNCHER);
            if (process.platform !== 'win32') {
              await chmod(promotedPath, 0o755);
            }
            return EXPECTED_LAUNCHER;
          }
        } catch {}
      }
    } catch {}
  }

  throw new Error(
    `Extracted bundle at ${stagingDir} does not contain the expected IntelliJ launcher at ${EXPECTED_LAUNCHER}`,
  );
}

export async function ensureInstalled(
  installDir: string,
  options?: {
    bundle?: ServerBundle;
    signal?: AbortSignal;
    onProgress?: (state: InstallState) => void;
    timeoutMs?: number;
  },
): Promise<InstallResult> {
  if (options?.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error(String(options.signal.reason ?? 'Aborted'));
  }

  if (!installDir?.trim()) {
    throw new Error('IntelliJ installDir must not be empty');
  }

  const timeoutMs = options?.timeoutMs ?? 600_000;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive finite number');
  }

  const resolvedInstallDir = resolve(installDir);
  const bundle = options?.bundle ?? serverBundle();
  validateBundleVersion(bundle.version);
  validateBundleUrl(bundle.url);

  const alreadyInstalled = await findInstalled(resolvedInstallDir, bundle);
  if (alreadyInstalled) {
    return alreadyInstalled;
  }

  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => {
    timeoutController.abort(
      new Error(`Timed out waiting for IntelliJ installation after ${timeoutMs}ms`),
    );
  }, timeoutMs);

  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const deadline = Date.now() + timeoutMs;
    const installId = randomUUID();
    const lockDir = join(resolvedInstallDir, 'install.lock');

    await mkdir(resolvedInstallDir, { recursive: true });

    let lockToken: string | null = null;
    const THROTTLE_MS = 150;
    let lastProgressTime = 0;

    async function reportProgress(state: InstallState, force = false): Promise<void> {
      const now = Date.now();
      if (!force && now - lastProgressTime < THROTTLE_MS) {
        return;
      }
      lastProgressTime = now;
      await writeStateAtomically(resolvedInstallDir, state);
      options?.onProgress?.(state);
    }

    while (Date.now() < deadline) {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? 'Aborted'));
      }

      const installed = await findInstalled(resolvedInstallDir, bundle);
      if (installed) {
        return installed;
      }

      let dirCreated = false;
      try {
        await mkdir(lockDir);
        dirCreated = true;
        lockToken = randomUUID();
        const owner: LockOwner = {
          token: lockToken,
          pid: process.pid,
          installId,
          createdAt: Date.now(),
        };
        await writeFile(join(lockDir, 'owner.json'), JSON.stringify(owner, null, 2), 'utf8');
        break;
      } catch (err: unknown) {
        if (dirCreated) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => {});
          lockToken = null;
          throw err;
        }

        if (!err || typeof err !== 'object' || !('code' in err) || err.code !== 'EEXIST') {
          throw err;
        }

        if (await isLockStale(lockDir)) {
          await attemptStaleLockRecovery(lockDir, resolvedInstallDir);
          continue;
        }

        if (options?.onProgress) {
          const observed = await readInstallState(resolvedInstallDir);
          if (observed) {
            options.onProgress(observed);
          }
        }

        await sleepWithSignal(100, signal);
      }
    }

    if (!lockToken) {
      const finalInstalled = await findInstalled(resolvedInstallDir, bundle);
      if (finalInstalled) {
        return finalInstalled;
      }
      throw new Error(
        `Timed out waiting for IntelliJ install lock after ${timeoutMs}ms: ${lockDir}`,
      );
    }

    const tempDir = join(resolvedInstallDir, '.tmp');
    const tempArchive = join(tempDir, `download-${installId}.archive`);
    const stagingDir = join(tempDir, `stage-${installId}`);

    let downloadedBytes = 0;
    let totalBytes: number | undefined = bundle.size && bundle.size > 0 ? bundle.size : undefined;

    try {
      const targetVersionDir = join(resolvedInstallDir, 'versions', bundle.version);
      if (await pathExists(targetVersionDir)) {
        throw new Error(
          `Cannot activate IntelliJ server: version directory already exists and is not an active owned installation: ${targetVersionDir}`,
        );
      }
      await mkdir(tempDir, { recursive: true });

      await reportProgress(
        {
          installId,
          pid: process.pid,
          installDir: resolvedInstallDir,
          version: bundle.version,
          phase: 'downloading',
          downloadedBytes: 0,
          totalBytes,
          updatedAt: Date.now(),
        },
        true,
      );

      const response = await fetch(bundle.url, {
        redirect: 'follow',
        signal,
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(
          `Failed to download IntelliJ server from ${bundle.url}: HTTP ${response.status} ${response.statusText}`,
        );
      }

      if (!response.body) {
        throw new Error(
          `Failed to download IntelliJ server from ${bundle.url}: empty response body`,
        );
      }

      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const parsedLength = Number.parseInt(contentLengthHeader, 10);
        if (Number.isFinite(parsedLength) && parsedLength > 0) {
          totalBytes = parsedLength;
        }
      }

      const hash = createHash('sha256');
      const fileStream = createWriteStream(tempArchive);

      const hashingTransform = new Transform({
        async transform(chunk: Buffer, _encoding, callback) {
          try {
            hash.update(chunk);
            downloadedBytes += chunk.byteLength;
            await reportProgress({
              installId,
              pid: process.pid,
              installDir: resolvedInstallDir,
              version: bundle.version,
              phase: 'downloading',
              downloadedBytes,
              totalBytes,
              updatedAt: Date.now(),
            });
            callback(null, chunk);
          } catch (err) {
            callback(err instanceof Error ? err : new Error(String(err)));
          }
        },
      });

      const webStream = response.body;
      const nodeStream = Readable.fromWeb(webStream as WebReadableStream<Uint8Array>);
      await pipeline(nodeStream, hashingTransform, fileStream, { signal });

      await reportProgress(
        {
          installId,
          pid: process.pid,
          installDir: resolvedInstallDir,
          version: bundle.version,
          phase: 'downloading',
          downloadedBytes,
          totalBytes: totalBytes ?? downloadedBytes,
          updatedAt: Date.now(),
        },
        true,
      );

      await reportProgress(
        {
          installId,
          pid: process.pid,
          installDir: resolvedInstallDir,
          version: bundle.version,
          phase: 'verifying',
          downloadedBytes,
          totalBytes: totalBytes ?? downloadedBytes,
          updatedAt: Date.now(),
        },
        true,
      );

      const actualHash = hash.digest('hex').toLowerCase();
      const expectedHash = bundle.sha256.toLowerCase();
      if (actualHash !== expectedHash) {
        throw new Error(
          `Checksum mismatch for IntelliJ server bundle: expected ${expectedHash}, got ${actualHash}`,
        );
      }

      await reportProgress(
        {
          installId,
          pid: process.pid,
          installDir: resolvedInstallDir,
          version: bundle.version,
          phase: 'extracting',
          downloadedBytes,
          totalBytes: totalBytes ?? downloadedBytes,
          updatedAt: Date.now(),
        },
        true,
      );

      await mkdir(stagingDir, { recursive: true });
      await extractArchive(tempArchive, stagingDir, bundle.archive, signal);

      const launcherRelative = await findAndPromoteLauncher(stagingDir);

      const receipt: InstallReceipt = {
        version: bundle.version,
        sha256: expectedHash,
        platform: process.platform,
        arch: process.arch,
        launcher: launcherRelative,
        installedAt: Date.now(),
      };
      await writeFile(join(stagingDir, 'receipt.json'), JSON.stringify(receipt, null, 2), 'utf8');

      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? 'Aborted'));
      }

      const versionsDir = join(resolvedInstallDir, 'versions');
      await mkdir(versionsDir, { recursive: true });

      if (await pathExists(targetVersionDir)) {
        throw new Error(
          `Cannot activate IntelliJ server: version directory already exists and is not an active owned installation: ${targetVersionDir}`,
        );
      }

      await rename(stagingDir, targetVersionDir);

      const finalExecutable = resolve(targetVersionDir, launcherRelative);

      const readyState: InstallState = {
        installId,
        pid: process.pid,
        installDir: resolvedInstallDir,
        version: bundle.version,
        phase: 'ready',
        downloadedBytes,
        totalBytes: totalBytes ?? downloadedBytes,
        updatedAt: Date.now(),
        executable: finalExecutable,
      };
      await reportProgress(readyState, true);

      return {
        executable: finalExecutable,
        version: bundle.version,
        installDir: resolvedInstallDir,
      };
    } catch (error: unknown) {
      const failure =
        error instanceof Error && error.name === 'AbortError' && signal.reason instanceof Error
          ? signal.reason
          : error;
      try {
        const failedState: InstallState = {
          installId,
          pid: process.pid,
          installDir: resolvedInstallDir,
          version: bundle.version,
          phase: 'failed',
          downloadedBytes,
          totalBytes,
          updatedAt: Date.now(),
          error: failure instanceof Error ? failure.message : String(failure),
        };
        await writeStateAtomically(resolvedInstallDir, failedState);
        options?.onProgress?.(failedState);
      } catch {
        // Failed-state persistence must not mask the installation error.
      }
      throw failure;
    } finally {
      await rm(tempArchive, { force: true }).catch(() => {});
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      if (lockToken) {
        await releaseLock(lockDir, lockToken);
      }
    }
  } finally {
    clearTimeout(timeoutTimer);
  }
}
