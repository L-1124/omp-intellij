import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalizeProject } from './metadata.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
}

export interface ConnectionRecord extends StateRecord {
  connectionId: string;
  kind: string;
  pid: number;
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
}
export function connectionCloseState(error?: { code?: string; message?: string }): {
  phase: string;
  detail: string;
} {
  const connectionLost = !error || error.code === 'ECONNRESET' || error.code === 'EPIPE';
  return {
    phase: connectionLost ? 'disconnected' : 'failed',
    detail: error?.message ?? 'IntelliJ bridge connection closed',
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
      if (message.id !== undefined) {
        next.initializeRequestId = message.id;
      }
      if (rootUri) next.rootUri = rootUri;
    } else if (message.method === 'workspace/didChangeWorkspaceFolders') {
      next.generation = (next.generation || 0) + 1;
      next.phase = 'importing';
      next.detail = 'Workspace folders changed; reimporting';
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
    } else if (isInitResponse && message.error && current.phase === 'connecting') {
      const errMsg =
        typeof message.error === 'object' && message.error !== null && 'message' in message.error
          ? String((message.error as { message?: unknown }).message)
          : 'unknown error';
      next.phase = 'failed';
      next.detail = 'Initialize failed: ' + errMsg;
    } else if (message.method === 'intellij/workspaceImportState') {
      const params = message.params as
        | { folders?: Array<{ status: string }>; phase?: string }
        | undefined;
      const folders = params?.folders ?? [];
      const hasFailure = folders.some((f) => ['FAILURE', 'FAILED', 'ERROR'].includes(f.status));
      if (hasFailure) {
        next.phase = 'failed';
        next.detail = 'IntelliJ project import failed; inspect the server import log';
      } else if (params?.phase === 'FINISHED') {
        next.phase = 'indexing';
        next.detail = 'Import finished; indexing project';
      } else {
        next.phase = 'importing';
        next.detail = params?.phase
          ? `Importing workspace (${params.phase})`
          : 'Importing workspace folders';
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
          if (next.indexReadySeen && next.indexingTokens.length === 0 && next.phase !== 'failed') {
            next.phase = 'ready';
            next.detail = 'IntelliJ index ready';
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
      if (next.phase !== 'failed') {
        next.phase = 'ready';
        next.indexReadySeen = true;
        next.indexingTokens = [];
        next.detail = 'IntelliJ index ready';
        next.progress = null;
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

  let currentRecord: ConnectionRecord = {
    connectionId,
    kind,
    pid,
    startedAt,
    updatedAt: startedAt,
    seq: 0,
    phase: 'connecting',
    detail: '',
    progress: null,
    rootUri: null,
    canonicalPath: null,
    closed: false,
    initializeRequestId: null,
    generation: 0,
  };

  let writeQueue = Promise.resolve();

  function enqueueWrite(snapshot: ConnectionRecord, isClose = false): Promise<void> {
    writeQueue = writeQueue.then(async () => {
      if (closed && !isClose) return;
      try {
        await mkdir(dir, { recursive: true });
        const tempPath = `${filePath}.${randomUUID()}.tmp`;
        await writeFile(tempPath, JSON.stringify(snapshot, null, 2), 'utf8');
        await rename(tempPath, filePath);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('intellij connection-state write error: ' + message);
        if (onWriteError) {
          try {
            onWriteError(err);
          } catch {}
        }
        if (isClose) throw err;
      }
    });
    return writeQueue;
  }

  return {
    connectionId,
    startedAt,
    getState: () => ({ ...currentRecord }),
    async update(
      updateOpts: {
        root?: string;
        rootUri?: string;
        phase?: string;
        detail?: string;
        progress?: ProgressPayload | null;
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

      currentRecord = {
        ...currentRecord,
        updatedAt,
        seq,
        phase: updateOpts.phase ?? currentRecord.phase,
        detail: updateOpts.detail !== undefined ? updateOpts.detail : currentRecord.detail,
        progress: updateOpts.progress !== undefined ? updateOpts.progress : currentRecord.progress,
        rootUri: resolvedRootUri,
        canonicalPath,
      };

      const snapshot = { ...currentRecord };
      return enqueueWrite(snapshot, false);
    },
    async close(closeOpts: { phase?: string; detail?: string } = {}) {
      if (closed) return;
      closed = true;
      seq++;
      const updatedAt = Date.now();
      currentRecord = {
        ...currentRecord,
        updatedAt,
        seq,
        phase: closeOpts.phase ?? 'disconnected',
        detail:
          closeOpts.detail !== undefined
            ? closeOpts.detail
            : currentRecord.phase === 'ready'
              ? 'Session ended after the index was ready'
              : currentRecord.detail || 'Connection closed',
        closed: true,
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
    return { phase: 'not-started', detail: 'No project path specified' };
  }
  let targetCanonical: string;
  try {
    targetCanonical = canonicalizeProject(projectPath).canonicalPath.toLowerCase();
  } catch {
    return { phase: 'not-started', detail: 'Invalid project path' };
  }

  const dir = join(systemPath, 'plugin-metadata', 'connections');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
      return { phase: 'not-started', detail: 'No active or previous IntelliJ connection found' };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { phase: 'not-started', detail: 'Failed to read connection metadata: ' + message };
  }

  const now = Date.now();
  const matchingConnections: ConnectionRecord[] = [];
  const closedByProject = new Map<string, Array<{ file: string; record: ConnectionRecord }>>();

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = join(dir, entry);
    let record: ConnectionRecord;
    try {
      const content = await readFile(file, 'utf8');
      record = JSON.parse(content) as ConnectionRecord;
    } catch {
      continue;
    }

    if (!record || typeof record !== 'object') continue;

    let isAlive = false;
    if (!record.closed && Number.isSafeInteger(record.pid) && record.pid > 0) {
      try {
        process.kill(record.pid, 0);
        isAlive = true;
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && err.code !== 'ESRCH') isAlive = true;
      }
    }

    if (!isAlive && record.closed) {
      record.isAlive = false;
    } else if (!isAlive) {
      const lastPhase = record.phase || 'unknown';
      record.phase = 'disconnected';
      record.detail =
        lastPhase === 'ready'
          ? 'Connection process exited after the index was ready'
          : `Connection process exited (last phase: ${lastPhase})`;
    } else {
      record.isAlive = true;
    }

    if (!record.isAlive || record.closed) {
      const age = now - (record.updatedAt || record.startedAt || 0);
      if (age > RETENTION_MS) {
        await unlink(file).catch(() => {});
        continue;
      }
      if (record.canonicalPath) {
        const key = record.canonicalPath.toLowerCase();
        const list = closedByProject.get(key) || [];
        list.push({ file, record });
        closedByProject.set(key, list);
      }
    }

    let matches = false;
    if (record.canonicalPath) {
      const connCanonical = record.canonicalPath.toLowerCase();
      if (connCanonical === targetCanonical) {
        matches = true;
      } else if (
        targetCanonical.startsWith(
          connCanonical.endsWith('/') ? connCanonical : connCanonical + '/',
        )
      ) {
        matches = true;
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
        await unlink(list[i].file).catch(() => {});
      }
    }
  }

  if (matchingConnections.length === 0) {
    return { phase: 'not-started', detail: 'No active or previous IntelliJ connection found' };
  }

  const liveBridges = matchingConnections.filter(
    (c) => c.isAlive && !c.closed && c.phase !== 'disconnected',
  );

  let chosen: ConnectionRecord;
  if (liveBridges.length > 0) {
    liveBridges.sort((a, b) => {
      const diff = (b.startedAt || 0) - (a.startedAt || 0);
      if (diff !== 0) return diff;
      return (b.seq || 0) - (a.seq || 0);
    });
    chosen = liveBridges[0];
  } else {
    matchingConnections.sort((a, b) => {
      const diff = (b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0);
      if (diff !== 0) return diff;
      return (b.seq || 0) - (a.seq || 0);
    });
    chosen = matchingConnections[0];
  }

  const live = Boolean(chosen.isAlive && !chosen.closed && chosen.phase !== 'disconnected');

  return {
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
  };
}
