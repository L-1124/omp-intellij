import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLeaseUnlocked, getActiveLeases, type LeaseHandle } from '../project/metadata.js';
import { getIjPluginPaths, mergeIjJavaOptions, resolveAndroidExtension } from './android-extension.js';
import { DEFAULT_SERVER_VERSION } from './bundles.js';
import { readServerConfig, trackInstallation } from './config.js';
import { requireAcceptedEula } from './eula.js';
import { findInstalled } from './install.js';
import {
  type LockHandle,
  acquireLifecycleLock as rawAcquireLifecycleLock,
  withLifecycleLock as rawWithLifecycleLock,
  releaseLifecycleLock,
} from './lifecycle-lock.js';

export { type LockHandle, releaseLifecycleLock };

import type { PluginSettings } from '../shared/types.js';

async function loadSettings(): Promise<PluginSettings> {
  const configuredPath = process.env.OMP_INTELLIJ_SETTINGS;
  const candidates: Array<URL | string> = configuredPath
    ? [configuredPath]
    : [
        new URL('../../settings.json', import.meta.url),
        new URL('../../../settings.json', import.meta.url),
      ];
  for (const url of candidates) {
    try {
      const document: unknown = JSON.parse(await readFile(url, 'utf8'));
      const parsed: unknown =
        document && typeof document === 'object' && !Array.isArray(document)
          ? {
              executable: '',
              systemPath: join(homedir(), '.omp', 'cache', 'intellij', 'shared'),
              ...document,
            }
          : document;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('executable' in parsed) ||
        typeof parsed.executable !== 'string' ||
        !('systemPath' in parsed) ||
        typeof parsed.systemPath !== 'string' ||
        !parsed.systemPath.trim() ||
        !('host' in parsed) ||
        parsed.host !== '127.0.0.1' ||
        !('startupTimeoutMs' in parsed) ||
        typeof parsed.startupTimeoutMs !== 'number' ||
        !('idleTimeout' in parsed) ||
        typeof parsed.idleTimeout !== 'string'
      ) {
        throw new Error('Invalid IntelliJ service settings');
      }
      if (!Number.isFinite(parsed.startupTimeoutMs) || parsed.startupTimeoutMs <= 0) {
        throw new Error('startupTimeoutMs must be positive');
      }
      const cachePolicy = 'cachePolicy' in parsed ? parsed.cachePolicy : undefined;
      if (
        !cachePolicy ||
        typeof cachePolicy !== 'object' ||
        !('retentionDays' in cachePolicy) ||
        typeof cachePolicy.retentionDays !== 'number' ||
        !('warnAboveGiB' in cachePolicy) ||
        typeof cachePolicy.warnAboveGiB !== 'number' ||
        !('automaticDeletion' in cachePolicy) ||
        cachePolicy.automaticDeletion !== false
      ) {
        throw new Error('Invalid IntelliJ cache policy; automatic deletion must be disabled');
      }
      const record = parsed as Record<string, unknown>;
      for (const key of [
        'initializeTimeoutMs',
        'requestWaitTimeoutMs',
        'initTimeoutMs',
        'indexWaitTimeoutMs',
      ]) {
        const value = record[key];
        if (
          value !== undefined &&
          (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        ) {
          throw new Error(`${key} must be positive`);
        }
      }
      if ('workspaceConfigPath' in parsed && typeof parsed.workspaceConfigPath !== 'string') {
        throw new Error('workspaceConfigPath must be a string');
      }
      return parsed as PluginSettings;
    } catch (error: unknown) {
      if (
        configuredPath ||
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }
  }
  throw new Error('Unable to locate settings.json');
}

export const settings: PluginSettings = await loadSettings();

if (settings.host !== '127.0.0.1') throw new Error('Shared server must bind to loopback');

export interface ServerEndpoint {
  host: string;
  port: number;
}

/**
 * ILS 263 publishes the port alone; ILS 271 publishes port, PID, then build id.
 * Only the first line is the port in both formats.
 */
export function parsePortFile(text: string): number | null {
  const first = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!/^\d+$/.test(first)) return null;
  const port = Number(first);
  return port >= 1 && port <= 65535 ? port : null;
}

export async function endpoint(systemPath: string = settings.systemPath): Promise<ServerEndpoint> {
  const currentPortFile = join(systemPath, 'server.port');
  const currentOwnerFile = join(systemPath, 'omp-server.json');
  const port = parsePortFile(await readFile(currentPortFile, 'utf8'));
  if (port === null) throw new Error('Invalid shared server port file');
  const ownerRaw: unknown = JSON.parse(await readFile(currentOwnerFile, 'utf8'));
  const pid =
    ownerRaw && typeof ownerRaw === 'object' && 'pid' in ownerRaw ? (ownerRaw.pid as number) : NaN;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid shared server PID');
  process.kill(pid, 0);
  return { host: settings.host, port };
}

export async function connect(
  timeout: number = 1000,
  systemPath: string = settings.systemPath,
): Promise<net.Socket> {
  const address = await endpoint(systemPath);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    const failed = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once('error', failed);
    socket.setTimeout(timeout, () => failed(new Error('Connection timed out')));
    socket.once('connect', () => {
      socket.removeListener('error', failed);
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

export async function status(systemPath: string = settings.systemPath): Promise<boolean> {
  try {
    const socket = await connect(1000, systemPath);
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function isServerAlive(
  systemPath: string = settings.systemPath,
): Promise<{ alive: boolean; pid: number | null }> {
  let pid: number | null = null;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(systemPath, 'omp-server.json'), 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      'pid' in parsed &&
      typeof parsed.pid === 'number' &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0
    ) {
      pid = parsed.pid;
    }
  } catch {}
  if (pid) {
    try {
      process.kill(pid, 0);
      return { alive: true, pid };
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'code' in e && e.code !== 'ESRCH')
        return { alive: true, pid };
    }
  }
  try {
    const port = parsePortFile(await readFile(join(systemPath, 'server.port'), 'utf8'));
    if (port === null) return { alive: false, pid };
    const listening = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: settings.host, port });
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(500, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
    return { alive: listening, pid };
  } catch {
    return { alive: false, pid };
  }
}

export async function acquireLifecycleLock(
  options: {
    timeoutMs?: number;
    systemPath?: string;
    onPoll?: (() => Promise<net.Socket | null>) | null;
  } = {},
): Promise<LockHandle> {
  const timeoutMs = options.timeoutMs ?? settings.startupTimeoutMs;
  const systemPath = options.systemPath ?? settings.systemPath;
  return rawAcquireLifecycleLock({ timeoutMs, systemPath, onPoll: options.onPoll });
}

export async function withLifecycleLock<T>(
  action: (handle: LockHandle) => Promise<T>,
  options: {
    timeoutMs?: number;
    systemPath?: string;
    onPoll?: (() => Promise<net.Socket | null>) | null;
  } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? settings.startupTimeoutMs;
  const systemPath = options.systemPath ?? settings.systemPath;
  return rawWithLifecycleLock(action, { timeoutMs, systemPath, onPoll: options.onPoll });
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

function normalizePathForPlatform(p: string): string {
  const resolved = resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export interface ProcessIdentity {
  pid: number;
  startTime: number;
  executable: string;
  commandLine: string;
}

export async function getProcessInfo(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!isProcessAlive(pid)) return null;

  try {
    if (process.platform === 'win32') {
      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { $ms = [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds(); "$ms\`t$($p.ExecutablePath)\`t$($p.CommandLine)" }`,
      ];
      let res = spawnSync('pwsh.exe', args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        res = spawnSync('powershell.exe', args, {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        });
      }
      if (res.status === 0 && res.stdout) {
        const text = res.stdout.trim();
        const firstTab = text.indexOf('\t');
        const secondTab = firstTab !== -1 ? text.indexOf('\t', firstTab + 1) : -1;
        if (firstTab !== -1 && secondTab !== -1) {
          const startTime = Number(text.slice(0, firstTab).trim());
          const executable = text.slice(firstTab + 1, secondTab).trim();
          const commandLine = text.slice(secondTab + 1).trim();
          if (Number.isFinite(startTime) && startTime > 0) {
            return {
              pid,
              startTime,
              executable,
              commandLine,
            };
          }
        }
      }
      return null;
    }

    if (process.platform === 'linux') {
      try {
        const statRaw = await readFile(`/proc/${pid}/stat`, 'utf8');
        const rparen = statRaw.lastIndexOf(')');
        let startTime = 0;
        if (rparen !== -1) {
          const fields = statRaw.slice(rparen + 2).split(' ');
          startTime = Number(fields[19]) || 0;
        }
        let executable = '';
        try {
          executable = await readlink(`/proc/${pid}/exe`);
        } catch {}
        const cmdRaw = await readFile(`/proc/${pid}/cmdline`, 'utf8');
        const commandLine = cmdRaw.replace(/\0/g, ' ').trim();
        return { pid, startTime, executable, commandLine };
      } catch {}
    }

    const res = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=,comm=,args='], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (res.status === 0 && res.stdout) {
      const line = res.stdout.trim();
      const match =
        /^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.*)$/.exec(
          line,
        );
      if (match) {
        const startTime = Date.parse(match[1]) || 0;
        return {
          pid,
          startTime,
          executable: match[2],
          commandLine: match[3],
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

export interface ServerOwnerRecord {
  pid: number;
  token?: string;
  systemPath?: string;
  createdAt?: number;
  processStartTime?: number;
  executable?: string;
  pluginPaths?: string[];
}

export interface ServerOwnershipVerification {
  status: 'running-owned' | 'running-unverified' | 'dead' | 'not-found';
  pid: number | null;
  owner?: ServerOwnerRecord;
  reason?: string;
}

async function isPortListening(systemPath: string): Promise<boolean> {
  try {
    const port = parsePortFile(await readFile(join(systemPath, 'server.port'), 'utf8'));
    if (port === null) return false;
    const { promise, resolve: resolvePromise } = Promise.withResolvers<boolean>();
    const socket = net.createConnection({ host: settings.host, port });
    const done = (value: boolean) => {
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    return await promise;
  } catch {
    return false;
  }
}

export async function verifyServerOwnership(
  systemPath: string,
): Promise<ServerOwnershipVerification> {
  const currentOwnerFile = join(systemPath, 'omp-server.json');

  let ownerRaw: string;
  try {
    ownerRaw = await readFile(currentOwnerFile, 'utf8');
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      const listening = await isPortListening(systemPath);
      if (listening) {
        return {
          status: 'running-unverified',
          pid: null,
          reason: 'Active server listening on server.port but omp-server.json is missing',
        };
      }
      return { status: 'not-found', pid: null, reason: 'Owner file does not exist' };
    }
    return {
      status: 'running-unverified',
      pid: null,
      reason: `Failed to read owner file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let owner: ServerOwnerRecord;
  try {
    const parsed = JSON.parse(ownerRaw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        status: 'running-unverified',
        pid: null,
        reason: 'Corrupt owner file (JSON root is not an object)',
      };
    }
    owner = parsed as ServerOwnerRecord;
  } catch (err: unknown) {
    return {
      status: 'running-unverified',
      pid: null,
      reason: `Corrupt owner file (malformed JSON): ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0) {
    const listening = await isPortListening(systemPath);
    if (listening) {
      return {
        status: 'running-unverified',
        pid: null,
        reason: 'Active server listening on server.port but owner PID is invalid',
      };
    }
    return {
      status: 'running-unverified',
      pid: null,
      reason: 'Invalid or missing PID in owner record',
    };
  }

  const pid = owner.pid;
  const alive = isProcessAlive(pid);

  if (!alive) {
    const listening = await isPortListening(systemPath);
    if (listening) {
      return {
        status: 'running-unverified',
        pid,
        owner,
        reason: `Server PID ${pid} is dead but server.port is still actively listening`,
      };
    }
    return { status: 'dead', pid, owner, reason: `Process PID ${pid} is not alive` };
  }

  if (
    typeof owner.token !== 'string' ||
    !owner.token.trim() ||
    typeof owner.systemPath !== 'string' ||
    !owner.systemPath.trim() ||
    typeof owner.processStartTime !== 'number' ||
    !Number.isFinite(owner.processStartTime) ||
    typeof owner.executable !== 'string' ||
    !owner.executable.trim()
  ) {
    return {
      status: 'running-unverified',
      pid,
      owner,
      reason:
        'Server owner record lacks ownership token, processStartTime, executable, or systemPath (legacy PID-only record)',
    };
  }
  if (
    owner.pluginPaths !== undefined &&
    (!Array.isArray(owner.pluginPaths) ||
      owner.pluginPaths.some((p) => typeof p !== 'string'))
  ) {
    return {
      status: 'running-unverified',
      pid,
      owner,
      reason: 'Server owner record contains invalid pluginPaths (expected string array)',
    };
  }


  const expectedSystemPath = normalizePathForPlatform(systemPath);
  const ownerSystemPath = normalizePathForPlatform(owner.systemPath);
  if (ownerSystemPath !== expectedSystemPath) {
    return {
      status: 'running-unverified',
      pid,
      owner,
      reason: `Owner systemPath "${owner.systemPath}" does not match requested systemPath "${systemPath}"`,
    };
  }

  const procInfo = await getProcessInfo(pid);
  if (!procInfo) {
    return {
      status: 'running-unverified',
      pid,
      owner,
      reason: `Cannot inspect live OS process identity for PID ${pid}`,
    };
  }

  if (procInfo.startTime !== owner.processStartTime) {
    return {
      status: 'running-unverified',
      pid,
      owner,
      reason: `Live process start time (${procInfo.startTime}) does not match owner start time (${owner.processStartTime}) - detected PID reuse`,
    };
  }

  const expectedExecutable = normalizePathForPlatform(owner.executable);
  const liveExecutable = normalizePathForPlatform(procInfo.executable);
  if (liveExecutable !== expectedExecutable) {
    return {
      status: 'running-unverified',
      pid,
      owner,
      reason: `Live process executable "${procInfo.executable}" does not match owner executable "${owner.executable}"`,
    };
  }

  const liveCmd =
    process.platform === 'win32' ? procInfo.commandLine.toLowerCase() : procInfo.commandLine;
  const normalizedCmd = liveCmd.replace(/\\/g, '/');
  const hasExactSystemPath =
    normalizedCmd.includes(`--system-path=${expectedSystemPath}`) ||
    normalizedCmd.includes(`--system-path="${expectedSystemPath}"`) ||
    normalizedCmd.includes(`--system-path='${expectedSystemPath}'`);

  if (!hasExactSystemPath) {
    return {
      status: 'running-unverified',
      pid,
      owner,
      reason: `Live process command line does not contain exact --system-path parameter matching "${systemPath}"`,
    };
  }

  return {
    status: 'running-owned',
    pid,
    owner,
  };
}

export interface ActiveDebugSessionSummary {
  id: string;
  pid: number;
  canonical: string;
  hash: string;
  mode?: string;
  phase?: string;
}

export async function listAllActiveDebugSessions(
  systemPath: string,
): Promise<ActiveDebugSessionSummary[]> {
  const baseDir = join(systemPath, 'plugin-metadata', 'debug-sessions');
  let projectDirs: string[] = [];
  try {
    projectDirs = await readdir(baseDir);
  } catch {
    return [];
  }

  const activeSessions: ActiveDebugSessionSummary[] = [];

  for (const projectDir of projectDirs) {
    const fullProjectDir = join(baseDir, projectDir);
    let sessionFiles: string[] = [];
    try {
      sessionFiles = await readdir(fullProjectDir);
    } catch {
      continue;
    }

    for (const sessionFile of sessionFiles) {
      if (!sessionFile.endsWith('.json')) continue;
      const metaPath = join(fullProjectDir, sessionFile);
      try {
        const raw = await readFile(metaPath, 'utf8');
        const record = JSON.parse(raw) as {
          id?: string;
          pid?: number;
          canonical?: string;
          hash?: string;
          closed?: boolean;
          port?: number;
          token?: string;
        };
        if (!record || typeof record !== 'object') continue;
        if (record.closed === true) continue;
        if (!record.pid || !isProcessAlive(record.pid)) continue;
        if (!record.port || !record.token) continue;

        try {
          const res = await fetch(`http://127.0.0.1:${record.port}/status`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${record.token}` },
            signal: AbortSignal.timeout(1000),
          });
          if (res.ok) {
            const snap = (await res.json()) as { mode?: string; phase?: string };
            activeSessions.push({
              id: record.id || sessionFile.replace(/\.json$/, ''),
              pid: record.pid,
              canonical: record.canonical || '',
              hash: record.hash || projectDir,
              mode: snap.mode,
              phase: snap.phase,
            });
          }
        } catch {}
      } catch {}
    }
  }

  return activeSessions;
}

async function terminateVerifiedServer(pid: number, timeoutMs: number = 3000): Promise<void> {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(pid)], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 3000,
      });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {}

  const deadline = Date.now() + Math.min(timeoutMs, 2000);
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await pause(100);
  }

  if (isProcessAlive(pid)) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 3000,
        });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {}

    const forceDeadline = Date.now() + 2000;
    while (isProcessAlive(pid) && Date.now() < forceDeadline) {
      await pause(100);
    }
  }

  if (isProcessAlive(pid)) {
    throw new Error(`Failed to terminate verified server process (PID ${pid})`);
  }
}

export interface StopServerOptions {
  systemPath?: string;
  timeoutMs?: number;
  inspectCommandLine?: (pid: number) => Promise<string | null>;
}

export interface StopServerResult {
  stopped: boolean;
  pid: number | null;
  detail?: string;
}

export interface RestartServerOptions {
  systemPath?: string;
  timeoutMs?: number;
  executable?: string;
}

export interface RestartServerResult {
  restarted: boolean;
  previousPid: number | null;
  pid: number;
  endpoint: ServerEndpoint;
}

async function internalStopServer(
  options: {
    systemPath: string;
    timeoutMs: number;
  },
  action: 'stop' | 'restart' = 'stop',
): Promise<StopServerResult> {
  const { systemPath, timeoutMs } = options;

  const activeLeases = await getActiveLeases(systemPath);
  const activeDebugSessions = await listAllActiveDebugSessions(systemPath);

  if (activeLeases.length > 0 || activeDebugSessions.length > 0) {
    const blocking: string[] = [];
    if (activeLeases.length > 0) {
      blocking.push(
        `active connection lease(s): ${activeLeases
          .map(
            (l) =>
              `${l.kind} (PID ${l.pid}, project ${l.canonicalPath || l.projectId || 'unknown'})`,
          )
          .join(', ')}`,
      );
    }
    if (activeDebugSessions.length > 0) {
      blocking.push(
        `active debug session(s): ${activeDebugSessions
          .map(
            (s) =>
              `${s.id.slice(0, 8)} (PID ${s.pid}, project ${s.canonical || s.hash || 'unknown'})`,
          )
          .join(', ')}`,
      );
    }
    throw new Error(
      `Cannot ${action} IntelliJ server: active consumers detected: ${blocking.join('; ')}. All connections and debug sessions must be closed before ${action}.`,
    );
  }

  const verification = await verifyServerOwnership(systemPath);
  if (verification.status === 'not-found') {
    return { stopped: false, pid: null, detail: 'IntelliJ shared server is not running' };
  }
  if (verification.status === 'dead') {
    await rm(join(systemPath, 'server.port'), { force: true });
    await rm(join(systemPath, 'omp-server.json'), { force: true });
    return {
      stopped: false,
      pid: null,
      detail: 'IntelliJ shared server is not running (cleaned up stale metadata)',
    };
  }
  if (verification.status === 'running-unverified') {
    throw new Error(
      `Refusing to ${action} unverified server process (PID ${verification.pid}): ${verification.reason ?? 'process ownership cannot be proven'}`,
    );
  }

  if (!verification.pid) {
    throw new Error(`Cannot ${action} IntelliJ server: missing verified server PID`);
  }
  const pid = verification.pid;
  await terminateVerifiedServer(pid, timeoutMs);

  const currentPortFile = join(systemPath, 'server.port');
  const currentOwnerFile = join(systemPath, 'omp-server.json');
  await rm(currentPortFile, { force: true });
  await rm(currentOwnerFile, { force: true });

  return {
    stopped: true,
    pid,
  };
}

export async function stopServer(options: StopServerOptions = {}): Promise<StopServerResult> {
  const systemPath = options.systemPath ?? settings.systemPath;
  const timeoutMs = options.timeoutMs ?? settings.startupTimeoutMs;

  return withLifecycleLock(
    async () => {
      return internalStopServer({ systemPath, timeoutMs }, 'stop');
    },
    { systemPath, timeoutMs },
  );
}

async function resolveStartConfiguration(options: {
  executable?: string;
}): Promise<{ executable: string }> {
  let executable: string;
  if (options.executable) {
    executable = options.executable;
  } else {
    const configuration = await readServerConfig(settings.executable);
    if (configuration.mode === 'managed') {
      await trackInstallation(configuration.installDir);
      const installed = await findInstalled(configuration.installDir, {
        version: configuration.version ?? DEFAULT_SERVER_VERSION,
      });
      if (!installed) {
        throw new Error(
          `IntelliJ server ${configuration.version ?? DEFAULT_SERVER_VERSION} is not installed at "${configuration.installDir}". Run /intellij install to install and select the bundled version, or /intellij versions to inspect local installations.`,
        );
      }
      executable = installed.executable;
    } else {
      executable = configuration.executable;
    }
  }
  return { executable };
}

async function internalStartServer(
  options: {
    systemPath: string;
    timeoutMs: number;
    executable?: string;
    eulaHash?: string;
  },
  _lockHandle: LockHandle,
): Promise<{ socket: net.Socket; pid: number; endpoint: ServerEndpoint }> {
  const { systemPath, timeoutMs } = options;
  const startConfig = await resolveStartConfiguration({ executable: options.executable });
  const executable = startConfig.executable;
  const eulaHash = options.eulaHash ?? (await requireAcceptedEula(executable)).hash;
  await mkdir(systemPath, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let child: ChildProcess | undefined;

  const currentPortFile = join(systemPath, 'server.port');
  const currentOwnerFile = join(systemPath, 'omp-server.json');

  await rm(currentPortFile, { force: true });
  await rm(currentOwnerFile, { force: true });

  const log = await open(join(systemPath, 'launcher.log'), 'a');
  try {
    const extension = await resolveAndroidExtension(executable);
    if (extension.pluginPath) {
      await log.write(`[android-extension] Staged plugin path: ${extension.pluginPath}\n`);
    } else if (extension.reason) {
      await log.write(`[android-extension] Unavailable: ${extension.reason}\n`);
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(extension.pluginPath
        ? { IJ_JAVA_OPTIONS: mergeIjJavaOptions(process.env.IJ_JAVA_OPTIONS, extension.pluginPath) }
        : {}),
    };
    child = spawn(
      executable,
      [
        `--socket=${settings.host}:0`,
        `--port-file=${currentPortFile}`,
        '--multi-client',
        `--system-path=${systemPath}`,
        `--idle-timeout=${settings.idleTimeout}`,
        '--data-sharing=none',
        `--eula=${eulaHash}`,
      ],
      { detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env },
    );
    const {
      promise: spawnPromise,
      resolve: resolveSpawn,
      reject: rejectSpawn,
    } = Promise.withResolvers<void>();
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
    await spawnPromise;

    const childPid = child.pid;
    if (!childPid) {
      throw new Error('Failed to obtain spawned IntelliJ server PID');
    }

    const procInfo = await getProcessInfo(childPid);
    if (!procInfo?.startTime) {
      throw new Error(`Failed to capture OS process identity for child PID ${childPid}`);
    }
    const token = randomUUID();
    const ownerRecord: ServerOwnerRecord = {
      pid: childPid,
      token,
      systemPath: resolve(systemPath),
      createdAt: Date.now(),
      processStartTime: procInfo.startTime,
      executable: procInfo.executable || resolve(executable),
      pluginPaths: getIjPluginPaths(
        process.env.IJ_JAVA_OPTIONS,
        extension.pluginPath,
        process.cwd(),
      ),
    };
    await writeFile(currentOwnerFile, JSON.stringify(ownerRecord, null, 2));

    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`IntelliJ server exited with code ${child.exitCode}; see launcher.log`);
      }
      try {
        const socket = await connect(Math.min(1000, deadline - Date.now()), systemPath);
        child.unref();
        const ep = await endpoint(systemPath);
        return { socket, pid: childPid, endpoint: ep };
      } catch {}
      await pause(100);
    }

    throw Object.assign(
      new Error(
        `IntelliJ server startup exceeded ${timeoutMs}ms; see ${join(systemPath, 'launcher.log')}`,
      ),
      { code: 'ETIMEDOUT' },
    );
  } catch (error) {
    await stopFailedChild(child, systemPath);
    throw error;
  } finally {
    await log.close();
  }
}

export async function restartServer(
  options: RestartServerOptions = {},
): Promise<RestartServerResult> {
  const systemPath = options.systemPath ?? settings.systemPath;
  const timeoutMs = options.timeoutMs ?? settings.startupTimeoutMs;

  return withLifecycleLock(
    async (lockHandle) => {
      // Validate replacement before stopping a healthy server.
      const startConfig = await resolveStartConfiguration({ executable: options.executable });
      const eulaDoc = await requireAcceptedEula(startConfig.executable);

      const stopResult = await internalStopServer({ systemPath, timeoutMs }, 'restart');

      // 5. Start new server
      const startResult = await internalStartServer(
        { systemPath, timeoutMs, executable: startConfig.executable, eulaHash: eulaDoc.hash },
        lockHandle,
      );
      startResult.socket.destroy();

      return {
        restarted: true,
        previousPid: stopResult.pid,
        pid: startResult.pid,
        endpoint: startResult.endpoint,
      };
    },
    { systemPath, timeoutMs },
  );
}

async function stopFailedChild(
  child?: ChildProcess,
  systemPath: string = settings.systemPath,
): Promise<void> {
  if (!child?.pid) return;
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }
  const currentOwnerFile = join(systemPath, 'omp-server.json');
  const currentPortFile = join(systemPath, 'server.port');
  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(currentOwnerFile, 'utf8'));
  } catch {
    return;
  }
  if (owner && typeof owner === 'object' && 'pid' in owner && owner.pid === child.pid) {
    await rm(currentPortFile, { force: true });
    await rm(currentOwnerFile, { force: true });
  }
}

export async function ensureServer(
  options: { systemPath?: string; timeoutMs?: number; executable?: string } = {},
): Promise<net.Socket> {
  const systemPath = options.systemPath ?? settings.systemPath;
  const timeoutMs = options.timeoutMs ?? settings.startupTimeoutMs;

  try {
    return await connect(1000, systemPath);
  } catch {}

  const deadline = Date.now() + timeoutMs;
  const lockResult = await acquireLifecycleLock({
    timeoutMs,
    systemPath,
    onPoll: () =>
      connect(Math.min(500, Math.max(100, deadline - Date.now())), systemPath).catch(() => null),
  });

  if (lockResult.socket) return lockResult.socket;
  const lockHandle = lockResult;

  try {
    try {
      return await connect(1000, systemPath);
    } catch {}

    const started = await internalStartServer(
      { systemPath, timeoutMs, executable: options.executable },
      lockHandle,
    );
    return started.socket;
  } finally {
    await lockHandle.release();
  }
}

export interface ConnectWithLeaseOptions {
  systemPath?: string;
  kind?: string;
  projectPath?: string;
  pid?: number;
  socket?: net.Socket;
  timeoutMs?: number;
  executable?: string;
}

export interface ConnectionSession {
  socket: net.Socket;
  lease: LeaseHandle;
}

export async function connectWithLease(
  options: ConnectWithLeaseOptions = {},
): Promise<ConnectionSession> {
  const systemPath = options.systemPath ?? settings.systemPath;
  const timeoutMs = options.timeoutMs ?? settings.startupTimeoutMs;
  const kind = options.kind ?? 'bridge';
  const projectPath = options.projectPath;
  const pid = options.pid ?? process.pid;

  return withLifecycleLock(
    async (lockHandle) => {
      let socket: net.Socket;
      if (options.socket) {
        if (options.socket.destroyed || !options.socket.readable) {
          throw new Error('Passed socket is already closed or destroyed');
        }
        socket = options.socket;
      } else {
        try {
          socket = await connect(1000, systemPath);
        } catch {
          const started = await internalStartServer(
            { systemPath, timeoutMs, executable: options.executable },
            lockHandle,
          );
          socket = started.socket;
        }
      }

      let lease: LeaseHandle;
      try {
        lease = await createLeaseUnlocked(systemPath, { kind, projectPath, pid });
      } catch (err: unknown) {
        if (!options.socket) {
          socket.destroy();
        }
        throw err;
      }

      return { socket, lease };
    },
    { systemPath, timeoutMs },
  );
}
