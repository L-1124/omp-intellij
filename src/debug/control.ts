import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { canonicalizeProject } from '../project/metadata.js';

export type DebugPhase =
  | 'connecting-lsp'
  | 'connecting-dap'
  | 'connecting-jvm'
  | 'running'
  | 'stopped'
  | 'cleaning'
  | 'closed'
  | 'failed';

export interface DebugSnapshot {
  phase: DebugPhase;
  mode: 'launch' | 'attach';
  projectRoot: string;
  backendPort?: number;
  error?: string;
  cleanupError?: string;
  pendingRequests: number;
}

export interface DebugMetadataRecord {
  id: string;
  pid: number;
  canonical: string;
  hash: string;
  projectRoot: string;
  port: number;
  token: string;
  snapshot: DebugSnapshot;
  createdAt: number;
  updatedAt: number;
  closed?: boolean;
}

export interface DebugControlOptions {
  systemPath: string;
  projectRoot: string;
  getStatus: () => DebugSnapshot;
  recover: () => Promise<void>;
  onRecovered?: () => void;
}

export interface DebugControlHandle {
  id: string;
  port: number;
  token: string;
  metadataPath: string;
  close(retainFailed?: boolean): Promise<void>;
}

export interface DebugSessionInfo {
  id: string;
  pid: number;
  live: boolean;
  snapshot?: DebugSnapshot;
  detail: string;
}

const DEBUG_PHASES: Record<string, true> = {
  'connecting-lsp': true,
  'connecting-dap': true,
  'connecting-jvm': true,
  running: true,
  stopped: true,
  cleaning: true,
  closed: true,
  failed: true,
};

const DEBUG_MODES: Record<string, true> = {
  launch: true,
  attach: true,
};
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_TOKEN_REGEX = /^[0-9a-f]+$/i;

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function parseDebugSnapshot(obj: unknown): DebugSnapshot | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;

  if (typeof rec.phase !== 'string' || !DEBUG_PHASES[rec.phase]) {
    return null;
  }
  if (typeof rec.mode !== 'string' || !DEBUG_MODES[rec.mode]) {
    return null;
  }
  if (typeof rec.projectRoot !== 'string' || rec.projectRoot.length === 0) {
    return null;
  }
  if (!Number.isInteger(rec.pendingRequests) || (rec.pendingRequests as number) < 0) {
    return null;
  }
  if (rec.backendPort !== undefined) {
    if (
      !Number.isInteger(rec.backendPort) ||
      (rec.backendPort as number) < 1 ||
      (rec.backendPort as number) > 65535
    ) {
      return null;
    }
  }
  if (rec.error !== undefined && typeof rec.error !== 'string') {
    return null;
  }
  if (rec.cleanupError !== undefined && typeof rec.cleanupError !== 'string') {
    return null;
  }

  return {
    phase: rec.phase as DebugPhase,
    mode: rec.mode as DebugSnapshot['mode'],
    projectRoot: rec.projectRoot,
    pendingRequests: rec.pendingRequests as number,
    ...(rec.backendPort !== undefined ? { backendPort: rec.backendPort as number } : {}),
    ...(rec.error !== undefined ? { error: rec.error } : {}),
    ...(rec.cleanupError !== undefined ? { cleanupError: rec.cleanupError } : {}),
  };
}

function parseDebugMetadataRecord(raw: string): DebugMetadataRecord | null {
  const obj = parseJsonObject(raw);
  if (!obj) return null;

  if (typeof obj.id !== 'string' || !UUID_REGEX.test(obj.id)) {
    return null;
  }
  if (!Number.isSafeInteger(obj.pid) || (obj.pid as number) <= 0) {
    return null;
  }
  if (typeof obj.canonical !== 'string' || obj.canonical.length === 0) {
    return null;
  }
  if (typeof obj.hash !== 'string' || obj.hash.length === 0) {
    return null;
  }
  if (typeof obj.projectRoot !== 'string' || obj.projectRoot.length === 0) {
    return null;
  }

  const isClosed = obj.closed === true;
  if (isClosed) {
    if (obj.port !== 0) return null;
    if (typeof obj.token !== 'string') return null;
  } else {
    if (!Number.isInteger(obj.port) || (obj.port as number) < 1 || (obj.port as number) > 65535) {
      return null;
    }
    if (
      typeof obj.token !== 'string' ||
      obj.token.length === 0 ||
      !HEX_TOKEN_REGEX.test(obj.token)
    ) {
      return null;
    }
  }

  const snapshot = parseDebugSnapshot(obj.snapshot);
  if (!snapshot) return null;

  if (!Number.isSafeInteger(obj.createdAt) || (obj.createdAt as number) <= 0) {
    return null;
  }
  if (!Number.isSafeInteger(obj.updatedAt) || (obj.updatedAt as number) <= 0) {
    return null;
  }

  return {
    id: obj.id,
    pid: obj.pid as number,
    canonical: obj.canonical,
    hash: obj.hash,
    projectRoot: obj.projectRoot,
    port: obj.port as number,
    token: obj.token,
    snapshot,
    createdAt: obj.createdAt as number,
    updatedAt: obj.updatedAt as number,
    ...(isClosed ? { closed: true } : {}),
  };
}

function extractErrorMessage(obj: unknown): string | null {
  if (obj && typeof obj === 'object' && 'error' in obj && typeof obj.error === 'string') {
    return obj.error;
  }
  return null;
}

export function getDebugSessionsDir(systemPath: string, projectRoot: string): string {
  const canonical = canonicalizeProject(projectRoot);
  return join(systemPath, 'plugin-metadata', 'debug-sessions', canonical.id);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

export async function createDebugControl(
  options: DebugControlOptions,
): Promise<DebugControlHandle> {
  const { systemPath, projectRoot, getStatus, recover, onRecovered } = options;
  const canonical = canonicalizeProject(projectRoot);
  const dir = getDebugSessionsDir(systemPath, projectRoot);
  const sessionId = randomUUID();
  const metadataPath = join(dir, `${sessionId}.json`);
  const token = randomBytes(24).toString('hex');

  await mkdir(dir, { recursive: true });

  let server: Server | null = null;
  let isClosed = false;
  let isRecovering = false;

  const {
    promise: portPromise,
    resolve: resolvePort,
    reject: rejectPort,
  } = Promise.withResolvers<number>();

  const s = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (isClosed) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'server closed' }));
        return;
      }

      const hostHeader = (req.headers.host || '').trim();
      const hostWithoutPort = hostHeader.split(':')[0].toLowerCase();
      if (hostWithoutPort !== '127.0.0.1' && hostWithoutPort !== 'localhost') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden: loopback host required' }));
        return;
      }

      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      let pathname = '';
      try {
        const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
        pathname = parsedUrl.pathname;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid url' }));
        return;
      }

      if (pathname !== '/status' && pathname !== '/recover') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      const contentLength = req.headers['content-length'];
      if (contentLength && parseInt(contentLength, 10) > 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        return;
      }

      let bodyLength = 0;
      let tooLarge = false;
      const { promise: bodyEnded, resolve: resolveBody } = Promise.withResolvers<void>();

      const onData = (chunk: Buffer) => {
        bodyLength += chunk.length;
        if (bodyLength > 1024 && !tooLarge) {
          tooLarge = true;
          if (!res.headersSent) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'payload too large' }));
          }
          req.destroy();
          resolveBody();
        }
      };

      const cleanupListeners = () => {
        req.off('data', onData);
        req.off('end', resolveBody);
        req.off('close', resolveBody);
        req.off('error', resolveBody);
      };

      req.on('data', onData);
      req.once('end', resolveBody);
      req.once('close', resolveBody);
      req.once('error', resolveBody);

      if (req.readableEnded || req.destroyed) {
        resolveBody();
      }

      await bodyEnded;
      cleanupListeners();

      if (tooLarge || res.headersSent) return;

      if (pathname === '/status') {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'method not allowed' }));
          return;
        }
        const snap = getStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(snap));
        return;
      }

      if (pathname === '/recover') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'method not allowed' }));
          return;
        }

        if (isRecovering) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'recovery already in progress' }));
          return;
        }
        isRecovering = true;

        let onRecoveredFired = false;
        const fireOnRecovered = () => {
          if (!onRecoveredFired) {
            onRecoveredFired = true;
            try {
              onRecovered?.();
            } catch {}
          }
        };

        try {
          await recover();
          const snap = getStatus();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.on('finish', fireOnRecovered);
          res.on('close', fireOnRecovered);
          res.end(JSON.stringify({ success: true, snapshot: snap }));
        } catch (err: unknown) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.on('finish', fireOnRecovered);
          res.on('close', fireOnRecovered);
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        } finally {
          if (res.destroyed || res.writableFinished) fireOnRecovered();
        }
        return;
      }
    } catch (err: unknown) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    }
  });

  s.setTimeout(20000);
  s.requestTimeout = 20000;
  s.once('error', rejectPort);
  s.listen(0, '127.0.0.1', () => {
    const addr = s.address();
    if (addr && typeof addr === 'object' && typeof addr.port === 'number') {
      server = s;
      resolvePort(addr.port);
    } else {
      rejectPort(new Error('Failed to bind debug control loopback port'));
    }
  });

  let controlPort = 0;
  try {
    controlPort = await portPromise;
  } catch (err: unknown) {
    try {
      s.close();
    } catch {}
    server = null;
    throw err;
  }

  const record: DebugMetadataRecord = {
    id: sessionId,
    pid: process.pid,
    canonical: canonical.canonicalPath,
    hash: canonical.id,
    projectRoot: canonical.nativePath,
    port: controlPort,
    token,
    snapshot: getStatus(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const tmpFile = `${metadataPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpFile, JSON.stringify(record, null, 2), 'utf8');
    await rename(tmpFile, metadataPath);
  } catch (err: unknown) {
    try {
      s.close();
    } catch {}
    server = null;
    await unlink(tmpFile).catch(() => {});
    throw err;
  }

  return {
    id: sessionId,
    port: controlPort,
    token,
    metadataPath,
    async close(retainFailed = false) {
      if (isClosed) return;
      isClosed = true;

      if (server) {
        const currentServer = server;
        server = null;
        try {
          currentServer.close();
        } catch {}
        if (typeof currentServer.closeIdleConnections === 'function') {
          try {
            currentServer.closeIdleConnections();
          } catch {}
        }
      }

      if (!retainFailed) {
        try {
          await unlink(metadataPath);
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'code' in err && err.code !== 'ENOENT') {
            throw err;
          }
        }
      } else {
        const latestSnapshot = getStatus();
        const updatedRecord: DebugMetadataRecord = {
          ...record,
          token: '',
          port: 0,
          closed: true,
          snapshot: latestSnapshot,
          updatedAt: Date.now(),
        };
        const tmp = `${metadataPath}.${randomUUID()}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify(updatedRecord, null, 2), 'utf8');
          await rename(tmp, metadataPath);
        } catch (err: unknown) {
          await unlink(tmp).catch(() => {});
          throw err;
        }
      }
    },
  };
}

export async function listDebugSessions(options: {
  systemPath: string;
  projectRoot: string;
}): Promise<DebugSessionInfo[]> {
  const canonical = canonicalizeProject(options.projectRoot);
  const dir = getDebugSessionsDir(options.systemPath, options.projectRoot);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results: DebugSessionInfo[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const metaPath = join(dir, entry);
    let raw: string;
    try {
      raw = await readFile(metaPath, 'utf8');
    } catch {
      continue;
    }

    const record = parseDebugMetadataRecord(raw);
    if (!record) continue;

    if (record.hash !== canonical.id || record.canonical !== canonical.canonicalPath) {
      continue;
    }

    if (record.closed) {
      results.push({
        id: record.id,
        pid: record.pid,
        live: false,
        snapshot: record.snapshot,
        detail: record.snapshot.error || record.snapshot.cleanupError || record.snapshot.phase,
      });
      continue;
    }

    if (!isProcessAlive(record.pid)) {
      results.push({
        id: record.id,
        pid: record.pid,
        live: false,
        snapshot: record.snapshot,
        detail: `unrecoverable (proxy PID ${record.pid} exited; backend connection lost)`,
      });
      continue;
    }

    if (!record.port || !record.token) {
      results.push({
        id: record.id,
        pid: record.pid,
        live: false,
        snapshot: record.snapshot,
        detail: 'unrecoverable (missing control endpoint)',
      });
      continue;
    }

    try {
      const res = await fetch(`http://127.0.0.1:${record.port}/status`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${record.token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const bodyText = await res.text();
        const json = parseJsonObject(bodyText);
        const snap = parseDebugSnapshot(json);
        if (snap) {
          const errPart = snap.error ? `; error: ${snap.error}` : '';
          const pendingPart = snap.pendingRequests > 0 ? `; pending: ${snap.pendingRequests}` : '';
          results.push({
            id: record.id,
            pid: record.pid,
            live: true,
            snapshot: snap,
            detail: `${snap.mode} (${snap.phase})${errPart}${pendingPart}`,
          });
        } else {
          results.push({
            id: record.id,
            pid: record.pid,
            live: false,
            snapshot: record.snapshot,
            detail: 'invalid snapshot response',
          });
        }
      } else {
        results.push({
          id: record.id,
          pid: record.pid,
          live: false,
          snapshot: record.snapshot,
          detail: `stale (HTTP ${res.status})`,
        });
      }
    } catch {
      results.push({
        id: record.id,
        pid: record.pid,
        live: false,
        snapshot: record.snapshot,
        detail: `stale (port ${record.port} unreachable)`,
      });
    }
  }

  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}

export async function recoverDebugSession(options: {
  systemPath: string;
  projectRoot: string;
  id?: string;
}): Promise<DebugSnapshot> {
  const canonical = canonicalizeProject(options.projectRoot);
  const dir = getDebugSessionsDir(options.systemPath, options.projectRoot);

  let targetId = options.id;

  if (!targetId) {
    const sessions = await listDebugSessions({
      systemPath: options.systemPath,
      projectRoot: options.projectRoot,
    });
    const liveSessions = sessions.filter((s) => s.live);

    if (liveSessions.length === 0) {
      if (sessions.length === 0) {
        throw new Error('No active IntelliJ debug session found for current project.');
      }
      throw new Error(
        `No recoverable IntelliJ debug session found (${sessions.length} inactive or unrecoverable session(s)).`,
      );
    }

    if (liveSessions.length > 1) {
      const ids = liveSessions.map((s) => s.id.slice(0, 8)).join(', ');
      throw new Error(
        `Multiple active debug sessions found (${ids}). Please specify session ID: /intellij debug recover <id>`,
      );
    }

    targetId = liveSessions[0].id;
  }

  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {}

  let matchedFile: string | null = null;
  if (entries.includes(`${targetId}.json`)) {
    matchedFile = `${targetId}.json`;
  } else {
    const candidates = entries.filter((e) => e.endsWith('.json') && e.startsWith(targetId));
    if (candidates.length === 1) {
      matchedFile = candidates[0];
    } else if (candidates.length > 1) {
      throw new Error(`Ambiguous debug session ID prefix '${targetId}' matches multiple sessions.`);
    }
  }

  if (!matchedFile) {
    throw new Error(`Debug session '${targetId}' not found for current project.`);
  }

  const metaPath = join(dir, matchedFile);
  const raw = await readFile(metaPath, 'utf8');
  const record = parseDebugMetadataRecord(raw);

  if (!record) {
    throw new Error(`Debug session '${targetId}' metadata is corrupted.`);
  }

  if (record.hash !== canonical.id || record.canonical !== canonical.canonicalPath) {
    throw new Error(
      `Debug session '${record.id}' does not belong to project ${canonical.canonicalPath}`,
    );
  }

  if (record.closed) {
    throw new Error(`Debug session '${record.id}' is closed and unrecoverable.`);
  }

  if (!isProcessAlive(record.pid)) {
    throw new Error(
      `Debug session '${record.id}' is unrecoverable (proxy PID ${record.pid} exited; backend connection lost).`,
    );
  }

  if (!record.port || !record.token) {
    throw new Error(`Debug session '${record.id}' is unrecoverable (missing control endpoint).`);
  }

  const res = await fetch(`http://127.0.0.1:${record.port}/recover`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${record.token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(20000),
  });

  const resText = await res.text();
  const parsedData = parseJsonObject(resText);

  if (!res.ok) {
    const errorDetail = extractErrorMessage(parsedData);
    const msg = errorDetail || `HTTP ${res.status}`;
    throw new Error(`Debug recovery failed on session '${record.id}': ${msg}`);
  }

  const errorInBody = extractErrorMessage(parsedData);
  if (errorInBody) {
    throw new Error(`Debug recovery failed on session '${record.id}': ${errorInBody}`);
  }

  if (parsedData?.success !== true) {
    throw new Error(
      `Debug recovery failed on session '${record.id}': response indicated failure or corrupt payload`,
    );
  }

  const snap = parseDebugSnapshot(parsedData.snapshot);
  if (!snap) {
    throw new Error(
      `Debug recovery failed on session '${record.id}': response missing valid snapshot`,
    );
  }

  if (snap.phase !== 'closed' || snap.pendingRequests !== 0 || snap.cleanupError) {
    throw new Error(
      `Debug recovery incomplete on session '${record.id}': ${snap.cleanupError ?? snap.phase}`,
    );
  }
  return snap;
}
