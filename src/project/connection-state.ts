import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  type FileHandle,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { getProcessInfo, type ProcessIdentity } from '../server/service.js';
import { replaceFile } from '../shared/atomic-file.js';
import {
  type FailureDetail,
  LICENSE_RECOVERY_GUIDANCE,
  type LicenseSummary,
  projectLicenseState,
  sanitizeStatus,
  sanitizeString,
} from '../shared/runtime-status.js';
import { canonicalizeProject } from './metadata.js';

// Invariant boundaries for connection record retention and concurrency protection
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEAD_NON_FAILURE_RETENTION_MS = 60 * 60 * 1000;
export const ORPHAN_RETENTION_MS = 60 * 60 * 1000;
export const CONCURRENT_WRITE_GRACE_MS = 15 * 1000;
export const CORRUPT_GRACE_MS = 5 * 1000;
let currentProcessStartTime: number | undefined;

const processInfoCache = new Map<number, { info: ProcessIdentity | null; expiresAt: number }>();
async function getCachedProcessInfo(pid: number): Promise<ProcessIdentity | null> {
  const now = Date.now();
  const cached = processInfoCache.get(pid);
  if (cached && now < cached.expiresAt) {
    return cached.info;
  }
  const info = await getProcessInfo(pid).catch(() => null);
  processInfoCache.set(pid, { info, expiresAt: now + 5000 });
  if (processInfoCache.size > 100) {
    const first = processInfoCache.keys().next().value;
    if (first !== undefined) processInfoCache.delete(first);
  }
  return info;
}

async function safeUnlinkRecord(
  file: string,
  expectedStat: Stats,
  isAlive?: boolean,
  pidExists?: boolean,
  pidReused?: boolean,
): Promise<void> {
  // Never delete records for live processes or existing external PIDs that cannot be proven reused
  if (isAlive || (pidExists && !pidReused)) return;

  try {
    const cur = await stat(file);
    // Ensure the file on disk has not been atomically replaced by a concurrent writer
    if (
      cur.ino !== expectedStat.ino ||
      cur.mtimeMs !== expectedStat.mtimeMs ||
      cur.size !== expectedStat.size
    ) {
      return;
    }
    const removed = `${file}.${randomUUID()}.gc`;
    await rename(file, removed);
    const moved = await stat(removed);
    if (
      moved.ino !== expectedStat.ino ||
      moved.mtimeMs !== expectedStat.mtimeMs ||
      moved.size !== expectedStat.size
    ) {
      // A replacement that won the race must be restored without overwriting a later publication.
      await link(removed, file);
    }
    await unlink(removed);
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    recordWriteErrorLog(
      file,
      sanitizeString(error instanceof Error ? error.message : String(error)),
    );
  }
}
const lastWriteErrorByPath = new Map<
  string,
  { message: string; count: number; lastLogTime: number }
>();
const warnedCorruptFiles = new Set<string>();

function recordWriteErrorLog(filePath: string, message: string): void {
  const now = Date.now();
  const prev = lastWriteErrorByPath.get(filePath);
  if (prev && prev.message === message && now - prev.lastLogTime < 5000) {
    prev.count++;
    return;
  }
  const countSuffix = prev && prev.count > 1 ? ` (suppressed ${prev.count - 1} duplicates)` : '';
  console.error(`intellij connection-state write error: ${message}${countSuffix}`);
  lastWriteErrorByPath.set(filePath, { message, count: 1, lastLogTime: now });
  if (lastWriteErrorByPath.size > 50) {
    const firstKey = lastWriteErrorByPath.keys().next().value;
    if (firstKey) lastWriteErrorByPath.delete(firstKey);
  }
}

function recordCorruptedRecordDiagnostic(file: string, error: unknown): void {
  if (warnedCorruptFiles.has(file)) return;
  warnedCorruptFiles.add(file);
  if (warnedCorruptFiles.size > 100) {
    const first = warnedCorruptFiles.values().next().value;
    if (first) warnedCorruptFiles.delete(first);
  }
  const rawMsg = error instanceof Error ? error.message : String(error);
  const safeMsg = sanitizeString(rawMsg);
  console.warn(`[intellij] Corrupted connection record quarantined: ${file} (${safeMsg})`);
}
export interface ProgressPayload {
  token?: unknown;
  title?: string;
  message?: string;
  percentage?: number;
}

export interface StateRecord {
  phase: string;
  detail: string;
  progress: ProgressPayload | null;
  rootUri: string | null;
  initializeRequestId: unknown;
  generation: number;
  indexReadySeen?: boolean;
  indexingTokens?: unknown[];
  failure?: FailureDetail;
  license?: LicenseSummary;
  systemPath?: string;
}

export interface ConnectionRecord extends StateRecord {
  connectionId: string;
  kind: string;
  pid: number;
  processStartTime?: number;
  startedAt: number;
  updatedAt: number;
  seq: number;
  canonicalPath: string | null;
  closed: boolean;
  isAlive?: boolean;
}

export interface ProjectStateResult {
  phase: string;
  detail: string;
  live?: boolean;
  progress?: ProgressPayload | null;
  connectionId?: string;
  startedAt?: number;
  updatedAt?: number;
  rootUri?: string | null;
  canonicalPath?: string | null;
  pid?: number;
  seq?: number;
  failure?: FailureDetail;
  license?: LicenseSummary;
}

export function connectionCloseState(
  error?: { code?: string; message?: string; name?: string },
  options?:
    | {
        kind?: FailureDetail['kind'];
        stage?: FailureDetail['stage'];
        systemPath?: string;
      }
    | string,
): {
  phase: string;
  detail: string;
  failure?: FailureDetail;
} {
  const opts = typeof options === 'string' ? { systemPath: options } : (options ?? {});
  const connectionLost = !error || error.code === 'ECONNRESET' || error.code === 'EPIPE';
  const detail = error?.message ?? 'IntelliJ bridge connection closed';
  let failure: FailureDetail | undefined;

  if (error) {
    let kind: FailureDetail['kind'] = opts.kind ?? 'connection';
    const stage: FailureDetail['stage'] = opts.stage ?? 'connect';

    if (!opts.kind) {
      if (error.code === 'ETIMEDOUT') {
        kind = 'timeout';
      } else if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        kind = 'cancelled';
      } else {
        kind = 'connection';
      }
    }

    failure = {
      kind,
      stage,
      message: error.message || 'Connection failed',
      code: error.code,
      logPath: opts.systemPath ? join(opts.systemPath, 'launcher.log') : undefined,
    };
  }

  return {
    phase: connectionLost ? 'disconnected' : 'failed',
    detail,
    ...(failure ? { failure } : {}),
  };
}

export function reduceConnectionState(
  state: StateRecord | null | undefined,
  message: Record<string, unknown> | null | undefined,
  direction: 'upstream' | 'client' | 'downstream' | 'server' = 'downstream',
): StateRecord {
  const current: StateRecord = state || {
    phase: 'connecting',
    detail: '',
    progress: null,
    rootUri: null,
    initializeRequestId: null,
    generation: 0,
  };
  const next: StateRecord = { ...current };

  const isUpstream = direction === 'upstream' || direction === 'client';
  const isDownstream = direction === 'downstream' || direction === 'server';

  if (isUpstream && message) {
    if (message.method === 'initialize') {
      const params = message.params as
        | { rootUri?: string; rootPath?: string; workspaceFolders?: Array<{ uri: string }> }
        | undefined;
      const rootUri =
        params?.rootUri || params?.workspaceFolders?.[0]?.uri || params?.rootPath || null;
      next.phase = 'connecting';
      next.detail = 'Initializing connection';
      next.indexReadySeen = false;
      next.indexingTokens = [];
      delete next.failure;
      delete next.license;
      if (message.id !== undefined) {
        next.initializeRequestId = message.id;
      }
      if (rootUri) next.rootUri = rootUri;
    } else if (
      message.method === 'workspace/didChangeWorkspaceFolders' ||
      message.method === 'intellij/reloadWorkspace'
    ) {
      next.generation = (next.generation || 0) + 1;
      next.phase = 'importing';
      next.detail = 'Workspace folders changed; reimporting';
      next.indexingTokens = [];
      if (next.failure?.kind === 'import' || next.failure?.kind === 'cancelled') {
        delete next.failure;
      }
    } else if (message.method === 'shutdown' || message.method === 'exit') {
      next.phase = 'disconnected';
      next.detail = 'IntelliJ connection is shutting down';
    }
    return next;
  }

  if (isDownstream && message) {
    const isInitResponse =
      current.initializeRequestId !== undefined &&
      current.initializeRequestId !== null &&
      message.id === current.initializeRequestId &&
      !message.method;

    if (
      isInitResponse &&
      message.result !== undefined &&
      (current.phase === 'connecting' || current.phase === 'not-started')
    ) {
      next.phase = 'importing';
      next.detail = 'Project import in progress';
      if (next.failure?.kind !== 'authorization') delete next.failure;
    } else if (isInitResponse && message.error && current.phase === 'connecting') {
      const errObj =
        typeof message.error === 'object' && message.error !== null
          ? (message.error as { code?: number | string; message?: unknown; data?: unknown })
          : undefined;
      const errMsg = typeof errObj?.message === 'string' ? errObj.message : 'unknown error';
      next.phase = 'failed';
      next.detail = `Initialize failed: ${errMsg}`;
      next.failure = {
        kind: 'rpc',
        stage: 'initialize',
        message: errMsg,
        code: errObj?.code,
        data: errObj?.data,
        logPath: current.systemPath ? join(current.systemPath, 'launcher.log') : undefined,
      };
    } else if (message.method === 'intellij/workspaceImportState') {
      const params =
        message.params && typeof message.params === 'object'
          ? (message.params as Record<string, unknown>)
          : undefined;
      const rawFolders = Array.isArray(params?.folders) ? params.folders : [];
      const folders = rawFolders
        .filter((f): f is Record<string, unknown> => f !== null && typeof f === 'object')
        .map((f) => ({
          status: typeof f.status === 'string' ? f.status : '',
          folderUri: typeof f.folderUri === 'string' ? f.folderUri : undefined,
          uri: typeof f.uri === 'string' ? f.uri : undefined,
          tool: typeof f.tool === 'string' ? f.tool : undefined,
          message: typeof f.message === 'string' ? f.message : undefined,
          errorMessage: typeof f.errorMessage === 'string' ? f.errorMessage : undefined,
          statusText: typeof f.statusText === 'string' ? f.statusText : undefined,
        }));

      const failedFolders = folders.filter((f) =>
        ['FAILURE', 'FAILED', 'ERROR', 'BLOCKED'].includes(f.status),
      );
      const phase = typeof params?.phase === 'string' ? params.phase : undefined;
      const paramErrorMsg =
        typeof params?.errorMessage === 'string' ? params.errorMessage : undefined;
      const paramStatusText =
        typeof params?.statusText === 'string' ? params.statusText : undefined;

      const isFailed = phase === 'FAILED' || phase === 'CANCELLED' || failedFolders.length > 0;

      if (isFailed) {
        next.phase = 'failed';
        const firstFailedWithMsg = failedFolders.find(
          (f) => f.message || f.errorMessage || f.statusText,
        );
        const folderMsg =
          firstFailedWithMsg?.message ||
          firstFailedWithMsg?.errorMessage ||
          firstFailedWithMsg?.statusText;
        const directMsg = paramErrorMsg || paramStatusText || folderMsg;
        if (directMsg) {
          next.detail = directMsg;
        } else if (failedFolders.length > 0) {
          const firstFailedFolder = failedFolders[0];
          const folderUri =
            firstFailedFolder.folderUri ?? firstFailedFolder.uri ?? 'unknown folder';
          const tool = firstFailedFolder.tool ?? 'tool';
          next.detail = `${tool} (${firstFailedFolder.status}) at ${folderUri}`;
        } else {
          next.detail =
            phase === 'CANCELLED'
              ? 'Workspace import cancelled'
              : 'IntelliJ project import failed; inspect the server import log';
        }
        next.failure = {
          kind: phase === 'CANCELLED' ? 'cancelled' : 'import',
          stage: 'import',
          message: next.detail,
          folders: failedFolders.map((f) => ({
            uri: f.folderUri ?? f.uri,
            tool: f.tool,
            status: f.status,
            message: f.message ?? f.errorMessage ?? f.statusText,
          })),
          logPath: current.systemPath ? join(current.systemPath, 'launcher.log') : undefined,
        };
      } else if (phase === 'FINISHED' || phase === 'SUCCESS') {
        next.phase = 'indexing';
        next.detail = 'Import finished; indexing project';
        if (next.failure?.stage === 'import') delete next.failure;
      } else {
        next.phase = 'importing';
        next.detail = phase ? `Importing workspace (${phase})` : 'Importing workspace folders';
        if (next.failure?.kind === 'import' || next.failure?.kind === 'cancelled') {
          delete next.failure;
        }
      }
    } else if (message.method === 'jetbrains/licensing/state') {
      const summary = projectLicenseState(message.params ?? message);
      next.license = summary;
      if (
        summary.featuresDeclined ||
        summary.status === 'needs-activation' ||
        summary.status === 'expired'
      ) {
        const reason = summary.reason || LICENSE_RECOVERY_GUIDANCE;
        // Do not overwrite prior non-auth failure (like import/rpc failures)
        if (!next.failure || next.failure.kind === 'authorization') {
          next.failure = {
            kind: 'authorization',
            stage: 'initialize',
            message: reason,
          };
        }
        if (next.phase === 'ready') {
          next.phase = 'indexing';
        }
      } else if (summary.status === 'valid') {
        if (next.failure?.kind === 'authorization') {
          delete next.failure;
        }
      }
    } else if (message.method === '$/progress') {
      const params = message.params as
        | {
            token?: unknown;
            value?: { kind: string; title?: string; message?: string; percentage?: number };
          }
        | undefined;
      const token = params?.token;
      const value = params?.value;
      if (value) {
        const { kind, title, message: progMsg, percentage } = value;
        const indexingTokens = current.indexingTokens ?? [];
        if (kind === 'begin' && title === 'Indexing' && next.phase !== 'failed') {
          next.indexingTokens = [...new Set([...indexingTokens, token])];
          next.phase = 'indexing';
        } else if (kind === 'end' && indexingTokens.includes(token)) {
          next.indexingTokens = indexingTokens.filter((active) => active !== token);
          if (
            next.indexReadySeen &&
            next.indexingTokens.length === 0 &&
            next.phase !== 'failed' &&
            next.failure?.kind !== 'authorization'
          ) {
            next.phase = 'ready';
            next.detail = 'IntelliJ index ready';
            delete next.failure;
          }
        }
        if (kind === 'begin' || kind === 'report') {
          next.progress = { token, title, message: progMsg, percentage };
          const parts = [title, progMsg].filter(Boolean);
          if (parts.length > 0) {
            next.detail = parts.join(': ');
          }
        } else if (kind === 'end') {
          next.progress = null;
        }
      }
    } else if (message.method === 'intellij/ready-for-test') {
      next.indexReadySeen = true;
      next.indexingTokens = [];
      if (next.phase !== 'failed' && next.failure?.kind !== 'authorization') {
        next.phase = 'ready';
        next.detail = 'IntelliJ index ready';
        next.progress = null;
        delete next.failure;
      }
    }
    return next;
  }

  return next;
}

export function createConnectionState(options: {
  systemPath: string;
  kind?: string;
  pid?: number;
  connectionId?: string;
  onWriteError?: (error: unknown) => void;
  root?: string;
  rootUri?: string;
  projectPath?: string;
}) {
  const {
    systemPath,
    kind = 'bridge',
    pid = process.pid,
    connectionId = randomUUID(),
    onWriteError,
  } = options;

  if (!systemPath) throw new Error('systemPath is required');
  const dir = join(systemPath, 'plugin-metadata', 'connections');
  const filePath = join(dir, `${connectionId}.json`);

  const startedAt = Date.now();
  let seq = 0;
  let closed = false;

  let initialCanonical: string | null = null;
  let initialRootUri: string | null = null;
  const initialRoot = options.root ?? options.rootUri ?? options.projectPath;
  if (initialRoot) {
    try {
      const canonical = canonicalizeProject(initialRoot);
      initialCanonical = canonical.canonicalPath;
      initialRootUri = canonical.rootUri;
    } catch {}
  }

  const processStartTimePromise: Promise<number | undefined> =
    pid === process.pid && currentProcessStartTime !== undefined
      ? Promise.resolve(currentProcessStartTime)
      : getCachedProcessInfo(pid)
          .then((info) => {
            if (info && typeof info.startTime === 'number' && info.startTime > 0) {
              if (pid === process.pid) currentProcessStartTime = info.startTime;
              return info.startTime;
            }
            return undefined;
          })
          .catch(() => undefined);

  let currentRecord: ConnectionRecord = {
    connectionId,
    kind,
    pid,
    processStartTime: pid === process.pid ? currentProcessStartTime : undefined,
    startedAt,
    updatedAt: startedAt,
    seq: 0,
    phase: 'connecting',
    detail: '',
    progress: null,
    rootUri: initialRootUri,
    canonicalPath: initialCanonical,
    closed: false,
    initializeRequestId: null,
    generation: 0,
    systemPath,
  };

  let writeQueue = Promise.resolve();

  function enqueueWrite(snapshot: ConnectionRecord, isClose = false): Promise<void> {
    writeQueue = writeQueue.then(async () => {
      if (closed && !isClose) return;
      if (currentRecord.processStartTime === undefined) {
        const st = await processStartTimePromise;
        if (typeof st === 'number' && st > 0) {
          currentRecord.processStartTime = st;
          snapshot.processStartTime = st;
        }
      }
      const tempPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await mkdir(dir, { recursive: true });
        const sanitizedSnapshot = sanitizeStatus(snapshot);
        await writeFile(tempPath, JSON.stringify(sanitizedSnapshot, null, 2), 'utf8');
        await replaceFile(tempPath, filePath);
      } catch (err: unknown) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const message = sanitizeString(rawMsg);
        recordWriteErrorLog(filePath, message);
        if (onWriteError) {
          try {
            onWriteError(err);
          } catch {}
        }
        if (isClose) throw err;
      } finally {
        await rm(tempPath, { force: true }).catch(() => {});
      }
    });
    return writeQueue;
  }

  return {
    connectionId,
    startedAt,
    getState: () => ({ ...currentRecord }),
    flush: () => writeQueue,
    async update(
      updateOpts: {
        root?: string;
        rootUri?: string;
        phase?: string;
        detail?: string;
        progress?: ProgressPayload | null;
        failure?: FailureDetail | null;
        license?: LicenseSummary;
      } = {},
    ) {
      if (closed) return;
      seq++;
      const updatedAt = Date.now();
      let canonicalPath = currentRecord.canonicalPath;
      let resolvedRootUri = updateOpts.rootUri ?? currentRecord.rootUri;
      if (updateOpts.root || updateOpts.rootUri) {
        try {
          const canonical = canonicalizeProject(updateOpts.root || updateOpts.rootUri || '');
          canonicalPath = canonical.canonicalPath;
          resolvedRootUri = canonical.rootUri;
        } catch {}
      }

      let failure = currentRecord.failure;
      if (updateOpts.failure === null) {
        failure = undefined;
      } else if (updateOpts.failure !== undefined) {
        failure = updateOpts.failure;
      }

      currentRecord = {
        ...currentRecord,
        updatedAt,
        seq,
        phase: updateOpts.phase ?? currentRecord.phase,
        detail: updateOpts.detail !== undefined ? updateOpts.detail : currentRecord.detail,
        progress: updateOpts.progress !== undefined ? updateOpts.progress : currentRecord.progress,
        rootUri: resolvedRootUri,
        canonicalPath,
        failure,
        license: updateOpts.license !== undefined ? updateOpts.license : currentRecord.license,
      };

      const snapshot = { ...currentRecord };
      return enqueueWrite(snapshot, false);
    },
    async close(closeOpts: { phase?: string; detail?: string; failure?: FailureDetail } = {}) {
      if (closed) return;
      closed = true;
      seq++;
      const updatedAt = Date.now();

      const priorFailure = currentRecord.failure;
      const isPriorRootFailure = Boolean(priorFailure && priorFailure.kind !== 'authorization');

      let failure = priorFailure;
      if (!isPriorRootFailure && closeOpts.failure !== undefined) {
        failure = closeOpts.failure;
      }

      let detail = currentRecord.detail;
      if (isPriorRootFailure) {
        detail = currentRecord.detail;
      } else if (closeOpts.detail !== undefined) {
        detail = closeOpts.detail;
      } else if (currentRecord.phase === 'ready') {
        detail = 'Session ended after the index was ready';
      } else {
        detail = currentRecord.detail || 'Connection closed';
      }

      const phase =
        currentRecord.phase === 'failed' ? 'failed' : (closeOpts.phase ?? 'disconnected');

      currentRecord = {
        ...currentRecord,
        updatedAt,
        seq,
        phase,
        detail,
        closed: true,
        failure,
        license: { status: 'unknown' },
      };

      const snapshot = { ...currentRecord };
      return enqueueWrite(snapshot, true);
    },
  };
}

export async function readProjectState(
  systemPath: string,
  projectPath?: string,
): Promise<ProjectStateResult> {
  if (!projectPath) {
    const emptyResult: ProjectStateResult = {
      phase: 'not-started',
      detail: 'No project path specified',
      license: { status: 'unknown' },
    };
    return sanitizeStatus(emptyResult) as ProjectStateResult;
  }
  let targetCanonical: string;
  let targetId: string;
  let caseSensitive: boolean;
  try {
    const target = canonicalizeProject(projectPath);
    targetCanonical = target.canonicalPath;
    targetId = target.id;
    caseSensitive = target.isCaseSensitive ?? false;
  } catch {
    const invalidResult: ProjectStateResult = {
      phase: 'not-started',
      detail: 'Invalid project path',
      license: { status: 'unknown' },
    };
    return sanitizeStatus(invalidResult) as ProjectStateResult;
  }

  const dir = join(systemPath, 'plugin-metadata', 'connections');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
      const noFoundResult: ProjectStateResult = {
        phase: 'not-started',
        detail: 'No active or previous IntelliJ connection found',
        license: { status: 'unknown' },
      };
      return sanitizeStatus(noFoundResult) as ProjectStateResult;
    }
    const message = e instanceof Error ? e.message : String(e);
    const readErrResult: ProjectStateResult = {
      phase: 'not-started',
      detail: `Failed to read connection metadata: ${message}`,
      license: { status: 'unknown' },
    };
    return sanitizeStatus(readErrResult) as ProjectStateResult;
  }

  const now = Date.now();
  const matchingConnections: ConnectionRecord[] = [];
  const closedByProject = new Map<
    string,
    Array<{
      file: string;
      record: ConnectionRecord;
      stat: Stats;
      pidExists: boolean;
      pidReused: boolean;
    }>
  >();

  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      if (entry.endsWith('.corrupt') || entry.endsWith('.gc')) {
        try {
          const st = await stat(join(dir, entry));
          if (now - st.mtimeMs > 24 * 60 * 60 * 1000) {
            await unlink(join(dir, entry)).catch(() => {});
          }
        } catch {}
      }
      continue;
    }
    const file = join(dir, entry);
    let fileHandle: FileHandle | null = null;
    let statWhenRead: Stats;
    let content: string;
    try {
      fileHandle = await open(file, 'r');
      statWhenRead = await fileHandle.stat();
      content = await fileHandle.readFile({ encoding: 'utf8' });
    } catch (readErr: unknown) {
      if (
        readErr &&
        typeof readErr === 'object' &&
        'code' in readErr &&
        (readErr.code === 'ENOENT' || readErr.code === 'EBUSY')
      ) {
        continue;
      }
      recordCorruptedRecordDiagnostic(file, readErr);
      continue;
    } finally {
      await fileHandle?.close().catch(() => {});
    }

    let record: ConnectionRecord;
    try {
      record = JSON.parse(content) as ConnectionRecord;
    } catch (parseErr: unknown) {
      if (now - statWhenRead.mtimeMs < CORRUPT_GRACE_MS) {
        continue;
      }

      // Re-verify the file identity on disk before attempting quarantine
      try {
        const cur = await stat(file);
        if (
          cur.ino !== statWhenRead.ino ||
          cur.mtimeMs !== statWhenRead.mtimeMs ||
          cur.size !== statWhenRead.size
        ) {
          continue;
        }
      } catch {
        continue;
      }

      recordCorruptedRecordDiagnostic(file, parseErr);
      const corruptTarget = `${file}.${randomUUID()}.corrupt`;
      try {
        await rename(file, corruptTarget);
      } catch {
        // Never unlink the source file on rename failure to prevent deleting newly placed files
        continue;
      }

      // Post-rename verification to guarantee the quarantined file matches the observed content
      try {
        const quarantinedContent = await readFile(corruptTarget, 'utf8');
        if (quarantinedContent !== content) {
          // Restore without replacing a newer record published by another writer.
          await link(corruptTarget, file);
          await unlink(corruptTarget);
        }
      } catch {}
      continue;
    }

    if (!record || typeof record !== 'object') {
      await safeUnlinkRecord(file, statWhenRead);
      continue;
    }
    if (record.canonicalPath != null && typeof record.canonicalPath !== 'string') {
      await safeUnlinkRecord(file, statWhenRead);
      continue;
    }

    let isAlive = false;
    let pidExists = false;
    let pidReused = false;
    if (!record.closed && Number.isSafeInteger(record.pid) && record.pid > 0) {
      if (record.pid === process.pid) {
        pidExists = true;
      } else {
        try {
          process.kill(record.pid, 0);
          pidExists = true;
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'code' in err && err.code !== 'ESRCH') {
            pidExists = true;
          }
        }
      }

      if (pidExists) {
        if (typeof record.processStartTime === 'number' && record.processStartTime > 0) {
          const info = await getCachedProcessInfo(record.pid);
          if (info && typeof info.startTime === 'number' && info.startTime > 0) {
            const isMatch =
              process.platform === 'linux'
                ? info.startTime === record.processStartTime
                : Math.abs(info.startTime - record.processStartTime) <= 3000;
            if (isMatch) {
              isAlive = true;
            } else {
              isAlive = false;
              pidReused = true;
            }
          } else {
            isAlive = true;
          }
        } else {
          isAlive = true;
        }
      }
    }

    if (!isAlive && record.closed) {
      record.isAlive = false;
    } else if (!isAlive) {
      const lastPhase = record.phase || 'unknown';
      if (record.phase === 'failed' || record.failure) {
        record.isAlive = false;
      } else {
        record.phase = 'disconnected';
        record.detail = pidReused
          ? `Connection process exited (PID ${record.pid} reused by another process)`
          : lastPhase === 'ready'
            ? 'Connection process exited after the index was ready'
            : `Connection process exited (last phase: ${lastPhase})`;
        record.isAlive = false;
      }
    } else {
      record.isAlive = true;
    }

    const recordAge = now - (record.updatedAt || record.startedAt || 0);
    if (!record.isAlive || record.closed) {
      if (recordAge > CONCURRENT_WRITE_GRACE_MS) {
        if (recordAge > RETENTION_MS) {
          await safeUnlinkRecord(file, statWhenRead, record.isAlive, pidExists, pidReused);
          continue;
        }
        if (!record.canonicalPath && recordAge > ORPHAN_RETENTION_MS) {
          await safeUnlinkRecord(file, statWhenRead, record.isAlive, pidExists, pidReused);
          continue;
        }
        if (
          !record.closed &&
          !record.failure &&
          record.phase !== 'failed' &&
          recordAge > DEAD_NON_FAILURE_RETENTION_MS
        ) {
          await safeUnlinkRecord(file, statWhenRead, record.isAlive, pidExists, pidReused);
          continue;
        }
      }

      if (record.canonicalPath) {
        let key: string;
        try {
          key = canonicalizeProject(record.canonicalPath).id;
        } catch {
          key = caseSensitive ? record.canonicalPath : record.canonicalPath.toLowerCase();
        }
        const list = closedByProject.get(key) || [];
        list.push({ file, record, stat: statWhenRead, pidExists, pidReused });
        closedByProject.set(key, list);
      }
    }

    let matches = false;
    if (record.canonicalPath) {
      let recordId: string | null = null;
      let recordCanonical = record.canonicalPath;
      try {
        const c = canonicalizeProject(record.canonicalPath);
        recordId = c.id;
        recordCanonical = c.canonicalPath;
      } catch {}

      if (recordId !== null && recordId === targetId) {
        matches = true;
      } else {
        const a = caseSensitive ? targetCanonical : targetCanonical.toLowerCase();
        const b = caseSensitive ? recordCanonical : recordCanonical.toLowerCase();
        if (a === b) {
          matches = true;
        } else if (a.startsWith(b.endsWith('/') ? b : `${b}/`)) {
          matches = true;
        }
      }
    }

    if (matches) {
      matchingConnections.push(record);
    }
  }

  for (const list of closedByProject.values()) {
    if (list.length > 1) {
      list.sort(
        (a, b) =>
          (b.record.updatedAt || b.record.startedAt || 0) -
          (a.record.updatedAt || a.record.startedAt || 0),
      );
      for (let i = 1; i < list.length; i++) {
        const itemAge = now - (list[i].record.updatedAt || list[i].record.startedAt || 0);
        if (itemAge > CONCURRENT_WRITE_GRACE_MS) {
          await safeUnlinkRecord(
            list[i].file,
            list[i].stat,
            false,
            list[i].pidExists,
            list[i].pidReused,
          );
        }
      }
    }
  }

  if (matchingConnections.length === 0) {
    const noConnResult: ProjectStateResult = {
      phase: 'not-started',
      detail: 'No active or previous IntelliJ connection found',
      license: { status: 'unknown' },
    };
    return sanitizeStatus(noConnResult) as ProjectStateResult;
  }

  const liveBridges = matchingConnections.filter(
    (c) => c.kind === 'bridge' && c.isAlive && !c.closed && c.phase !== 'disconnected',
  );
  const otherLive = matchingConnections.filter(
    (c) => c.kind !== 'bridge' && c.isAlive && !c.closed && c.phase !== 'disconnected',
  );

  let chosen: ConnectionRecord;
  if (liveBridges.length > 0) {
    liveBridges.sort((a, b) => {
      const diff = (b.startedAt || 0) - (a.startedAt || 0);
      if (diff !== 0) return diff;
      return (b.seq || 0) - (a.seq || 0);
    });
    chosen = liveBridges[0];
  } else if (otherLive.length > 0) {
    otherLive.sort((a, b) => {
      const diff = (b.startedAt || 0) - (a.startedAt || 0);
      if (diff !== 0) return diff;
      return (b.seq || 0) - (a.seq || 0);
    });
    chosen = otherLive[0];
  } else {
    matchingConnections.sort((a, b) => {
      const diff = (b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0);
      if (diff !== 0) return diff;
      if (a.kind === 'bridge' && b.kind !== 'bridge') return -1;
      if (b.kind === 'bridge' && a.kind !== 'bridge') return 1;
      return (b.seq || 0) - (a.seq || 0);
    });
    chosen = matchingConnections[0];
  }

  const live = Boolean(chosen.isAlive && !chosen.closed && chosen.phase !== 'disconnected');
  const failure = chosen.failure ? (chosen.failure as FailureDetail) : undefined;
  const license: LicenseSummary =
    live && chosen.license ? (chosen.license as LicenseSummary) : { status: 'unknown' };

  const outbound: ProjectStateResult = {
    phase: chosen.phase || 'not-started',
    live,
    detail: chosen.detail || '',
    progress: chosen.progress || null,
    connectionId: chosen.connectionId,
    startedAt: chosen.startedAt,
    updatedAt: chosen.updatedAt,
    rootUri: chosen.rootUri,
    canonicalPath: chosen.canonicalPath,
    pid: chosen.pid,
    seq: chosen.seq,
    failure,
    license,
  };

  return sanitizeStatus(outbound) as ProjectStateResult;
}
