import { type ChildProcess, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { IntegrationSandbox } from './fixture.js';

export interface OmpHostOptions {
  mode: 'launch' | 'attach';
  cwd: string;
  program?: string;
  host?: string;
  port?: number;
  launchDefaults?: Record<string, unknown>;
  attachDefaults?: Record<string, unknown>;
  breakpoint?: { file: string; line: number };
}

export interface OmpHostDriver {
  process: ChildProcess;
  starting: Promise<Record<string, unknown>>;
  ready: Promise<Record<string, unknown>>;
  closed: Promise<Record<string, unknown>>;
  exited: Promise<void>;
  cancel(): void;
  close(): Promise<void>;
}

export function createOmpHostDriver(options: OmpHostOptions, sandbox: IntegrationSandbox): OmpHostDriver {
  const child = spawn(process.platform === 'win32' ? 'bun.exe' : 'bun', [
    resolve('test/integration/omp-dap-host.mjs'),
    JSON.stringify(options),
  ], {
    cwd: options.cwd,
    env: {
      ...sandbox.env,
      PI_CODING_AGENT_DIR: join(sandbox.sandboxDir, 'host-home', '.omp', 'agent'),
      CLAUDE_CONFIG_DIR: join(sandbox.sandboxDir, 'host-home', '.claude'),
    },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  sandbox.trackProcess(child);
  const starting = Promise.withResolvers<Record<string, unknown>>();
  const ready = Promise.withResolvers<Record<string, unknown>>();
  const closed = Promise.withResolvers<Record<string, unknown>>();
  const exited = Promise.withResolvers<void>();
  for (const promise of [starting.promise, ready.promise, closed.promise, exited.promise]) {
    void promise.catch(() => {});
  }
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    starting.reject(error);
    ready.reject(error);
    closed.reject(error);
  };
  child.once('error', (error) => {
    fail(error);
    exited.reject(error);
  });
  const lines = createInterface({ input: child.stdout! });
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.event === 'starting') starting.resolve(message);
      else if (message.event === 'ready') ready.resolve(message);
      else if (message.event === 'closed') closed.resolve(message);
      else if (message.event === 'failure') fail(new Error(String(message.message)));
    } catch (error) {
      fail(new Error(`Invalid OMP host output: ${line}`, { cause: error }));
    }
  });
  child.once('exit', (code, signal) => {
    lines.close();
    if (code === 0 && !failure) exited.resolve();
    else exited.reject(failure ?? new Error(`OMP host exited: code=${code}, signal=${signal}`));
    fail(failure ?? new Error('OMP host closed before the requested event'));
  });
  child.stdin!.on('error', fail);
  return {
    process: child,
    starting: starting.promise,
    ready: ready.promise,
    closed: closed.promise,
    exited: exited.promise,
    cancel() { child.stdin!.write('cancel\n'); },
    async close() {
      if (child.exitCode === null && child.signalCode === null && !child.stdin!.destroyed) {
        child.stdin!.end('terminate\n');
      }
      await Promise.all([closed.promise, exited.promise]);
    },
  };
}