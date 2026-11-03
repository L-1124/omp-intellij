import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type net from 'node:net';
import { join } from 'node:path';

export interface LockHandle {
  lock?: string;
  token?: string;
  socket?: net.Socket;
  release: () => Promise<boolean>;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

export async function acquireLifecycleLock(options: {
  timeoutMs?: number;
  systemPath: string;
  onPoll?: (() => Promise<net.Socket | null>) | null;
}): Promise<LockHandle> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const systemPath = options.systemPath;
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
    throw new Error(`Timed out waiting for IntelliJ lifecycle lock: ${lock}`);
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
    systemPath: string;
    onPoll?: (() => Promise<net.Socket | null>) | null;
  },
): Promise<T> {
  const handle = await acquireLifecycleLock(options);
  try {
    return await action(handle);
  } finally {
    if (handle.release) await handle.release();
  }
}
