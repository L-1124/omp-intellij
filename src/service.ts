import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { readServerConfig, trackInstallation } from './server-config.js';
import { ensureInstalled } from './server-install.js';
import type { PluginSettings } from './types.js';

async function loadSettings(): Promise<PluginSettings> {
  const configuredPath = process.env.OMP_INTELLIJ_SETTINGS;
  const candidates: Array<URL | string> = configuredPath
    ? [configuredPath]
    : [
        new URL('../settings.json', import.meta.url),
        new URL('../../settings.json', import.meta.url),
      ];
  for (const url of candidates) {
    try {
      const parsed: unknown = JSON.parse(await readFile(url, 'utf8'));
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('executable' in parsed) ||
        typeof parsed.executable !== 'string' ||
        !('systemPath' in parsed) ||
        typeof parsed.systemPath !== 'string' ||
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

const portFile = join(settings.systemPath, 'server.port');
const ownerFile = join(settings.systemPath, 'omp-server.json');

export interface ServerEndpoint {
  host: string;
  port: number;
}

export interface LockHandle {
  lock?: string;
  token?: string;
  socket?: net.Socket;
  release: () => Promise<boolean>;
}

export async function endpoint(): Promise<ServerEndpoint> {
  const text = (await readFile(portFile, 'utf8')).trim();
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535)
    throw new Error('Invalid shared server port file');
  const ownerRaw: unknown = JSON.parse(await readFile(ownerFile, 'utf8'));
  const pid =
    ownerRaw && typeof ownerRaw === 'object' && 'pid' in ownerRaw ? (ownerRaw.pid as number) : NaN;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid shared server PID');
  process.kill(pid, 0);
  return { host: settings.host, port };
}

export async function connect(timeout: number = 1000): Promise<net.Socket> {
  const address = await endpoint();
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

export async function status(): Promise<boolean> {
  try {
    const socket = await connect();
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
    const port = Number((await readFile(join(systemPath, 'server.port'), 'utf8')).trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { alive: false, pid };
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

export async function releaseLifecycleLock(lock: string, token: string): Promise<boolean> {
  if (!token) return false;
  try {
    const ownerPath = join(lock, 'owner.json');
    let owner: unknown;
    try {
      owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    } catch {
      return false;
    }
    if (!owner || typeof owner !== 'object' || !('token' in owner) || owner.token !== token)
      return false;
    await rm(lock, { recursive: true, force: true });
    return true;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT')
      throw error;
    return false;
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
  const onPoll = options.onPoll ?? null;

  await mkdir(systemPath, { recursive: true });
  const lock = join(systemPath, 'omp-start.lock');
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  let acquired = false;

  while (Date.now() < deadline) {
    if (onPoll) {
      const pollResult = await onPoll();
      if (pollResult) {
        return {
          socket: pollResult,
          release: async () => false,
        };
      }
    }
    try {
      await mkdir(lock);
      acquired = true;
      break;
    } catch (error: unknown) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
        throw error;
      try {
        const owner: unknown = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
        if (
          owner &&
          typeof owner === 'object' &&
          'pid' in owner &&
          typeof owner.pid === 'number' &&
          Number.isSafeInteger(owner.pid) &&
          owner.pid > 0
        ) {
          try {
            process.kill(owner.pid, 0);
          } catch (e: unknown) {
            if (e && typeof e === 'object' && 'code' in e && e.code === 'ESRCH') {
              throw new Error(
                'IntelliJ lifecycle lock is locked by inactive process (PID ' +
                  owner.pid +
                  '). Clean up manually at ' +
                  lock +
                  ' if no process is running.',
              );
            }
          }
        }
      } catch (e: unknown) {
        if (
          e instanceof Error &&
          e.message.startsWith('IntelliJ lifecycle lock is locked by inactive process')
        )
          throw e;
      }
      await pause(100);
    }
  }

  if (!acquired) {
    let ownerPid: number | null = null;
    let isDead = false;
    try {
      const owner: unknown = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
      if (
        owner &&
        typeof owner === 'object' &&
        'pid' in owner &&
        typeof owner.pid === 'number' &&
        Number.isSafeInteger(owner.pid) &&
        owner.pid > 0
      ) {
        ownerPid = owner.pid;
        try {
          process.kill(ownerPid, 0);
        } catch (e: unknown) {
          if (e && typeof e === 'object' && 'code' in e && e.code === 'ESRCH') isDead = true;
        }
      }
    } catch {}

    if (isDead) {
      throw new Error(
        'IntelliJ lifecycle lock is locked by inactive process (PID ' +
          ownerPid +
          '). Clean up manually at ' +
          lock +
          ' if no process is running.',
      );
    }
    throw new Error('Timed out waiting for IntelliJ lifecycle lock: ' + lock);
  }

  await writeFile(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
  );
  let released = false;
  return {
    lock,
    token,
    release: async () => {
      if (released) return false;
      released = true;
      return releaseLifecycleLock(lock, token);
    },
  };
}

export async function withLifecycleLock<T>(
  action: (handle: LockHandle) => Promise<T>,
  options: {
    timeoutMs?: number;
    systemPath?: string;
    onPoll?: (() => Promise<net.Socket | null>) | null;
  } = {},
): Promise<T> {
  const handle = await acquireLifecycleLock(options);
  try {
    return await action(handle);
  } finally {
    if (handle.release) await handle.release();
  }
}

async function stopFailedChild(child?: ChildProcess): Promise<void> {
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
  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(ownerFile, 'utf8'));
  } catch {
    return;
  }
  if (owner && typeof owner === 'object' && 'pid' in owner && owner.pid === child.pid) {
    await rm(portFile, { force: true });
    await rm(ownerFile, { force: true });
  }
}

export async function ensureServer(): Promise<net.Socket> {
  try {
    return await connect();
  } catch {}
  const configuration = await readServerConfig(settings.executable);
  let executable: string;
  if (configuration.mode === 'managed') {
    await trackInstallation(configuration.installDir);
    executable = (await ensureInstalled(configuration.installDir)).executable;
  } else {
    executable = configuration.executable;
  }
  await mkdir(settings.systemPath, { recursive: true });
  const deadline = Date.now() + settings.startupTimeoutMs;
  let child: ChildProcess | undefined;
  const lockResult = await acquireLifecycleLock({
    timeoutMs: settings.startupTimeoutMs,
    systemPath: settings.systemPath,
    onPoll: () => connect(Math.min(500, Math.max(100, deadline - Date.now()))).catch(() => null),
  });
  if (lockResult.socket) return lockResult.socket;
  const lockHandle = lockResult;
  try {
    try {
      return await connect();
    } catch {}
    await rm(portFile, { force: true });
    await rm(ownerFile, { force: true });
    const log = await open(join(settings.systemPath, 'launcher.log'), 'a');
    try {
      child = spawn(
        executable,
        [
          '--socket=' + settings.host + ':0',
          '--port-file=' + portFile,
          '--multi-client',
          '--system-path=' + settings.systemPath,
          '--idle-timeout=' + settings.idleTimeout,
          '--data-sharing=none',
        ],
        { detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] },
      );
      await new Promise<void>((resolve, reject) => {
        child?.once('spawn', () => resolve());
        child?.once('error', reject);
      });
      await writeFile(ownerFile, JSON.stringify({ pid: child.pid }));
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            'IntelliJ server exited with code ' + child.exitCode + '; see launcher.log',
          );
        }
        try {
          const socket = await connect(Math.min(1000, deadline - Date.now()));
          child.unref();
          return socket;
        } catch {}
        await pause(100);
      }
      throw new Error(
        'IntelliJ server startup exceeded ' +
          settings.startupTimeoutMs +
          'ms; see ' +
          join(settings.systemPath, 'launcher.log'),
      );
    } finally {
      await log.close();
    }
  } catch (error) {
    await stopFailedChild(child);
    throw error;
  } finally {
    await lockHandle.release();
  }
}
