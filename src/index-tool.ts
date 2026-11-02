import { resolve } from 'node:path';
import { type ProjectStateResult, readProjectState } from './connection-state.js';
import type {
  ExtensionContext,
  ExtensionPluginInstance,
  ToolResult,
  ToolUpdate,
} from './extension-types.js';
import { findProjectRoot } from './readiness.js';
import { settings } from './service.js';

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    const err = new Error('IntelliJ index wait aborted');
    err.name = 'AbortError';
    return Promise.reject(err);
  }
  const { promise, resolve: resolvePromise, reject: rejectPromise } = Promise.withResolvers<void>();
  let timer: NodeJS.Timeout | undefined;
  function onAbort() {
    clearTimeout(timer);
    const err = new Error('IntelliJ index wait aborted');
    err.name = 'AbortError';
    rejectPromise(err);
  }
  timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolvePromise();
  }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
  return promise;
}

export interface IntellijIndexParams {
  action?: 'status' | 'wait';
  project?: string;
  timeout?: number;
}

export interface IntellijIndexDetails extends ProjectStateResult {
  project: string;
  timeout?: number;
  stillIndexing?: boolean;
}

export interface ExecuteIntellijIndexOptions {
  readProjectState?: (systemPath: string, projectRoot: string) => Promise<ProjectStateResult>;
  systemPath?: string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  now?: () => number;
}

export async function executeIntellijIndex(
  params: IntellijIndexParams,
  signal: AbortSignal | undefined,
  onUpdate: ((update: ToolUpdate) => void) | undefined,
  ctx: ExtensionContext,
  options: ExecuteIntellijIndexOptions = {},
): Promise<ToolResult<IntellijIndexDetails>> {
  const readState = options.readProjectState || readProjectState;
  const systemPath = options.systemPath || settings.systemPath;
  const sleep = options.sleep || defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const now = options.now || Date.now;

  const projectRoot = params.project ? resolve(ctx.cwd, params.project) : findProjectRoot(ctx.cwd);
  const action = params.action || 'status';

  if (action === 'status') {
    const snapshot = await readState(systemPath, projectRoot);
    if (snapshot.phase === 'not-started') {
      return {
        content: [
          {
            type: 'text',
            text: `IntelliJ index status: not-started for project ${projectRoot}.\nNo active IntelliJ connection found. Use /intellij start to start the service, then run an LSP query to connect.`,
          },
        ],
        details: { project: projectRoot, ...snapshot },
        isError: false,
      };
    }

    const lines = [`IntelliJ index phase: ${snapshot.phase}`, `Project: ${projectRoot}`];
    if (snapshot.detail) lines.push(`Detail: ${snapshot.detail}`);
    if (snapshot.progress?.percentage !== undefined && snapshot.progress.percentage >= 0) {
      lines.push(`Progress: ${Math.round(snapshot.progress.percentage)}%`);
    }
    if (snapshot.progress?.message) {
      lines.push(`Progress message: ${snapshot.progress.message}`);
    }
    if (snapshot.live === false) lines.push('Connection: none (last session ended)');
    if (snapshot.connectionId) lines.push(`Connection ID: ${snapshot.connectionId}`);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      details: {
        project: projectRoot,
        ...snapshot,
      },
      isError: snapshot.phase === 'failed',
    };
  }

  if (action === 'wait') {
    let current = await readState(systemPath, projectRoot);

    if (current.phase === 'not-started') {
      return {
        content: [
          {
            type: 'text',
            text: `IntelliJ index status: not-started for project ${projectRoot}.\nNo active IntelliJ connection found. Cannot wait without an active bridge. Use /intellij start to start the service, then run an LSP query to connect.`,
          },
        ],
        details: { project: projectRoot, ...current },
        isError: false,
      };
    }

    if (current.phase === 'ready' && current.live !== false) {
      return {
        content: [
          {
            type: 'text',
            text: `IntelliJ index is ready for project ${projectRoot}.`,
          },
        ],
        details: { project: projectRoot, ...current },
        isError: false,
      };
    }

    if (current.phase === 'failed' || current.phase === 'disconnected') {
      return {
        content: [
          {
            type: 'text',
            text: `IntelliJ index is in ${current.phase} state for project ${projectRoot}: ${current.detail || 'Connection stopped'}.`,
          },
        ],
        details: { project: projectRoot, ...current },
        isError: true,
      };
    }
    if (current.live === false) {
      return {
        content: [
          {
            type: 'text',
            text: `No active IntelliJ connection for ${projectRoot}; the last session ended in phase ${current.phase}. Cannot wait without a live bridge. Run an LSP query to reconnect; if the service is stopped, use /intellij start first.`,
          },
        ],
        details: { live: false, project: projectRoot, ...current },
        isError: false,
      };
    }

    // In-flight indexing: connecting, importing, indexing
    const timeoutSec = Math.min(Math.max(params.timeout || 60, 1), 300);
    const deadline = now() + timeoutSec * 1000;
    let lastUpdateKey = '';

    while (now() < deadline) {
      if (signal?.aborted) {
        const err = new Error('IntelliJ index wait aborted');
        err.name = 'AbortError';
        throw err;
      }

      // Avoid per-poll onUpdate spam: only emit when state changes
      const updateKey = `${current.phase}:${current.detail || ''}:${current.progress?.percentage ?? ''}`;
      if (updateKey !== lastUpdateKey) {
        lastUpdateKey = updateKey;
        onUpdate?.({
          content: [
            {
              type: 'text',
              text: `Waiting for IntelliJ index: ${current.phase}${current.detail ? ` (${current.detail})` : ''}`,
            },
          ],
          details: { phase: current.phase, project: projectRoot },
        });
      }

      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;

      await sleep(Math.min(pollIntervalMs, remainingMs), signal);

      if (signal?.aborted) {
        const err = new Error('IntelliJ index wait aborted');
        err.name = 'AbortError';
        throw err;
      }

      current = await readState(systemPath, projectRoot);

      if (current.phase === 'ready' && current.live !== false) {
        return {
          content: [
            {
              type: 'text',
              text: `IntelliJ index is ready for project ${projectRoot}.`,
            },
          ],
          details: { project: projectRoot, ...current },
          isError: false,
        };
      }

      if (current.phase === 'failed' || current.phase === 'disconnected') {
        return {
          content: [
            {
              type: 'text',
              text: `IntelliJ index failed for project ${projectRoot}: ${current.detail || current.phase}.`,
            },
          ],
          details: { project: projectRoot, ...current },
          isError: true,
        };
      }

      if (current.phase === 'not-started' || current.live === false) {
        return {
          content: [
            {
              type: 'text',
              text: `No active IntelliJ connection for project ${projectRoot}; current phase: ${current.phase}. Run an LSP query to reconnect.`,
            },
          ],
          details: { project: projectRoot, ...current },
          isError: false,
        };
      }
    }

    // Timeout reached without failure: return still-indexing status
    return {
      content: [
        {
          type: 'text',
          text: `IntelliJ index wait timed out after ${timeoutSec}s for project ${projectRoot}; project is still ${current.phase}${current.detail ? `: ${current.detail}` : ''}.`,
        },
      ],
      details: { project: projectRoot, timeout: timeoutSec, stillIndexing: true, ...current },
      isError: false,
    };
  }

  throw new Error(`Unknown action: ${action}`);
}

export function registerIntellijIndex(
  pi: ExtensionPluginInstance,
  options: ExecuteIntellijIndexOptions = {},
): void {
  const z = pi.zod;
  pi.registerTool<IntellijIndexParams, IntellijIndexDetails>({
    name: 'intellij_index',
    approval: 'read',
    label: 'IntelliJ Index',
    description:
      'Check actual IntelliJ index status or wait for indexing to finish. Watches bridge state without initiating new LSP connections. When waiting, times out after specified seconds without marking failure if still indexing.',
    parameters: z.object({
      action: z
        .enum(['status', 'wait'])
        .default('status')
        .describe('Check indexing status or wait for indexing to complete'),
      project: z
        .string()
        .optional()
        .describe('Project root directory; defaults to current directory or detected project root'),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(300)
        .default(60)
        .describe('Timeout in seconds when waiting for index readiness (1-300, default 60)'),
    }),
    execute(
      _id: string,
      params: IntellijIndexParams,
      signal: AbortSignal | undefined,
      onUpdate: ((update: ToolUpdate) => void) | undefined,
      ctx: ExtensionContext,
    ) {
      return executeIntellijIndex(params, signal, onUpdate, ctx, options);
    },
  });
}
