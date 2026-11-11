import { join, resolve } from 'node:path';
import { type ProjectStateResult, readProjectState } from '../project/connection-state.js';
import { findProjectRoot } from '../project/readiness.js';
import {
  getWorkspaceInfo as defaultGetWorkspaceInfo,
  reimportWorkspace as defaultReimportWorkspace,
  type ReimportWorkspaceResult,
  type WorkspaceInfo,
} from '../project/workspace.js';
import {
  formatModelLines,
  inspectWorkspaceModel,
  serializeWorkspaceModelError,
  type WorkspaceModelReport,
} from '../project/workspace-model.js';
import { settings } from '../server/service.js';
import type {
  ExtensionContext,
  ExtensionPluginInstance,
  ToolResult,
  ToolUpdate,
} from '../shared/extension-types.js';
import {
  type FailureDetail,
  LICENSE_RECOVERY_GUIDANCE,
  type LicenseSummary,
  sanitizeStatus,
  sanitizeString,
} from '../shared/runtime-status.js';
import { type DoctorReport, formatDoctorReport, inspectDoctor } from './doctor.js';

export interface IntellijWorkspaceContext {
  projectType?: 'maven' | 'gradle' | 'unknown';
  savedJdk?: string | null;
  appliedJdk?: string | null;
  isApplied?: boolean;
  savedEnvKeys?: string[];
  submittedEnvKeys?: string[];
  error?: string;
}

function extractErrorCode(err: unknown): string | number | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const val = err.code;
    if (typeof val === 'string' || typeof val === 'number') {
      return val;
    }
  }
  return undefined;
}

function extractErrorData(err: unknown): unknown {
  if (err && typeof err === 'object' && 'data' in err) {
    return err.data;
  }
  return undefined;
}

function isTimeoutError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    if ('code' in err && err.code === 'ETIMEDOUT') return true;
    if ('message' in err && typeof err.message === 'string' && err.message.includes('timed out')) {
      return true;
    }
  }
  return false;
}

function formatWorkspaceLines(ws?: IntellijWorkspaceContext): string[] {
  if (!ws) return [];
  const lines: string[] = [];
  if (ws.error) {
    lines.push(`Workspace context error: ${ws.error}`);
  }
  if (ws.projectType && ws.projectType !== 'unknown') {
    lines.push(`Project type: ${ws.projectType}`);
  }
  if (ws.savedJdk) {
    lines.push(`Configured JDK: ${ws.savedJdk}`);
  }
  if (ws.appliedJdk) {
    lines.push(`Applied JDK: ${ws.appliedJdk}`);
  }
  if (typeof ws.isApplied === 'boolean') {
    lines.push(`JDK applied: ${ws.isApplied ? 'yes' : 'no'}`);
  }
  if (ws.submittedEnvKeys && ws.submittedEnvKeys.length > 0) {
    lines.push(`Submitted env variables: ${ws.submittedEnvKeys.join(', ')}`);
  } else if (ws.savedEnvKeys && ws.savedEnvKeys.length > 0) {
    lines.push(`Configured env variables: ${ws.savedEnvKeys.join(', ')}`);
  }
  return lines;
}

async function getWorkspaceContextSafe(
  getWorkspaceInfoFn: (
    projectRoot: string,
    options?: { systemPath?: string; configDir?: string },
  ) => Promise<WorkspaceInfo>,
  projectRoot: string,
  systemPath?: string,
  configDir?: string,
): Promise<IntellijWorkspaceContext | undefined> {
  try {
    const info = await getWorkspaceInfoFn(projectRoot, { systemPath, configDir });
    if (!info) return undefined;
    const ctx: IntellijWorkspaceContext = {};
    if (info.projectType) ctx.projectType = info.projectType as 'maven' | 'gradle' | 'unknown';
    if (info.savedJdk !== undefined) ctx.savedJdk = info.savedJdk;
    if (info.appliedJdk !== undefined) ctx.appliedJdk = info.appliedJdk;
    if (typeof info.isApplied === 'boolean') ctx.isApplied = info.isApplied;
    if (Array.isArray(info.savedEnvKeys)) ctx.savedEnvKeys = [...info.savedEnvKeys];
    return ctx;
  } catch (err: unknown) {
    return {
      error: sanitizeString(err instanceof Error ? err.message : String(err)),
    };
  }
}

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

export function isAuthDenied(license?: LicenseSummary): boolean {
  if (!license) return false;
  return (
    license.status === 'needs-activation' ||
    license.status === 'expired' ||
    Boolean(license.featuresDeclined)
  );
}

export function formatFailureLines(failure?: FailureDetail, fallbackSystemPath?: string): string[] {
  if (!failure) return [];
  const sanitized = sanitizeStatus(failure) as FailureDetail;
  const lines = [
    `Failure kind: ${sanitized.kind}`,
    `Failure stage: ${sanitized.stage}`,
    `Failure message: ${sanitizeString(sanitized.message)}`,
  ];
  if (sanitized.code !== undefined && sanitized.code !== '') {
    lines.push(`Failure code: ${sanitized.code}`);
  }
  if (sanitized.folders && sanitized.folders.length > 0) {
    lines.push(
      'Failure folders: ' +
        sanitized.folders
          .map(
            (f) =>
              `${sanitizeString(f.uri || f.tool || 'folder')} [${f.status}]: ${sanitizeString(f.message || '')}`,
          )
          .join(', '),
    );
  }
  const logPath =
    sanitized.logPath ||
    (fallbackSystemPath ? join(fallbackSystemPath, 'launcher.log') : undefined);
  if (logPath) {
    lines.push(`Launcher log: ${sanitizeString(logPath)}`);
  }
  return lines;
}

export function formatLicenseLines(license?: LicenseSummary): string[] {
  if (!license) return [];
  const sanitized = sanitizeStatus(license) as LicenseSummary;
  const lines = [`License status: ${sanitized.status || 'unknown'}`];
  if (sanitized.featuresDeclined) {
    lines.push('License features declined: true');
  }
  if (sanitized.reason) {
    lines.push(`License reason: ${sanitizeString(sanitized.reason)}`);
  }
  if (sanitized.source) {
    lines.push(`License source: ${sanitizeString(sanitized.source)}`);
  }
  if (isAuthDenied(sanitized)) {
    lines.push(`License recovery guidance: ${LICENSE_RECOVERY_GUIDANCE}`);
  }
  return lines;
}

export interface IntellijParams {
  action?: 'status' | 'wait' | 'reload' | 'doctor' | 'model';
  project?: string;
  file?: string;
  timeout?: number;
}

export interface IntellijDetails extends ProjectStateResult {
  project: string;
  timeout?: number;
  stillIndexing?: boolean;
  reloaded?: boolean;
  elapsedMs?: number;
  workspace?: IntellijWorkspaceContext;
  doctor?: DoctorReport;
  model?: WorkspaceModelReport;
}

export interface ExecuteIntellijOptions {
  readProjectState?: (systemPath: string, projectRoot: string) => Promise<ProjectStateResult>;
  reimportWorkspace?: (
    projectRoot: string,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      systemPath?: string;
      configDir?: string;
    },
  ) => Promise<ReimportWorkspaceResult>;
  getWorkspaceInfo?: (
    projectRoot: string,
    options?: { systemPath?: string; configDir?: string },
  ) => Promise<WorkspaceInfo>;
  systemPath?: string;
  configDir?: string;
  configFile?: string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  now?: () => number;
}

export async function executeIntellij(
  params: IntellijParams,
  signal: AbortSignal | undefined,
  onUpdate: ((update: ToolUpdate<IntellijDetails>) => void) | undefined,
  ctx: ExtensionContext,
  options: ExecuteIntellijOptions = {},
): Promise<ToolResult<IntellijDetails>> {
  const readState = options.readProjectState || readProjectState;
  const reimport = options.reimportWorkspace || defaultReimportWorkspace;
  const getWorkspaceInfoFn = options.getWorkspaceInfo || defaultGetWorkspaceInfo;
  const systemPath = options.systemPath || settings.systemPath;
  const configDir = options.configDir;
  const sleep = options.sleep || defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const now = options.now || Date.now;

  const projectRoot = params.project ? resolve(ctx.cwd, params.project) : findProjectRoot(ctx.cwd);
  const action = params.action || 'status';

  if (action === 'doctor') {
    signal?.throwIfAborted();
    const report = await inspectDoctor(projectRoot, {
      systemPath,
      configDir,
      configFile: options.configFile,
    });
    const snapshot = await readState(systemPath, projectRoot).catch(() => ({
      phase: 'failed',
    }));
    signal?.throwIfAborted();
    return {
      content: [{ type: 'text', text: formatDoctorReport(report) }],
      details: {
        phase: snapshot.phase,
        detail:
          report.checks.find((check) => check.id === 'project-state')?.message ??
          'Project state unavailable',
        project: report.project ?? sanitizeString(projectRoot),
        doctor: report,
      },
      isError: !report.summary.ok,
    };
  }
  if (action === 'model') {
    signal?.throwIfAborted();
    if (!params.file?.trim()) throw new Error('Action "model" requires a source file');
    const file = resolve(ctx.cwd, params.file);
    const timeoutSec = params.timeout ?? 60;
    if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 300) {
      throw new Error('Model timeout must be an integer from 1 to 300 seconds');
    }
    try {
      const model = await inspectWorkspaceModel(params.project ? projectRoot : undefined, file, {
        signal,
        timeoutMs: timeoutSec * 1000,
        systemPath,
        configDir,
      });
      const current = await readState(
        systemPath,
        params.project ? projectRoot : findProjectRoot(file),
      );
      return {
        content: [{ type: 'text', text: formatModelLines(model).join('\n') }],
        details: {
          project: model.project,
          phase: current.phase,
          detail: 'Model resolved; inspection connection released',
          model,
        },
        isError: false,
      };
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      const safe = serializeWorkspaceModelError(error) as {
        message?: string;
        code?: string | number;
        data?: unknown;
      } | null;
      const failure: FailureDetail = {
        kind:
          isTimeoutError(error) || (error instanceof Error && error.name === 'TimeoutError')
            ? 'timeout'
            : 'rpc',
        stage: 'request',
        message: safe?.message ?? 'Workspace model inspection failed',
        code: safe?.code,
        data: safe?.data,
      };
      return {
        content: [{ type: 'text', text: formatFailureLines(failure, systemPath).join('\n') }],
        details: {
          project: sanitizeString(projectRoot),
          phase: 'failed',
          detail: failure.message,
          failure,
        },
        isError: true,
      };
    }
  }

  if (action === 'status') {
    const rawSnapshot = await readState(systemPath, projectRoot);
    const snapshot = sanitizeStatus(rawSnapshot) as ProjectStateResult;
    const authDenied = isAuthDenied(snapshot.license);
    const workspaceContext = await getWorkspaceContextSafe(
      getWorkspaceInfoFn,
      projectRoot,
      systemPath,
      configDir,
    );

    if (snapshot.phase === 'not-started') {
      const textLines = [
        `IntelliJ index status: not-started for project ${projectRoot}.`,
        'No active IntelliJ connection found. Use /intellij start to start the service, then run an LSP query to connect.',
        ...formatWorkspaceLines(workspaceContext),
        ...formatLicenseLines(snapshot.license),
        ...formatFailureLines(snapshot.failure, systemPath),
      ];
      return {
        content: [
          {
            type: 'text',
            text: sanitizeString(textLines.join('\n')),
          },
        ],
        details: sanitizeStatus({
          project: projectRoot,
          ...snapshot,
          ...(workspaceContext ? { workspace: workspaceContext } : {}),
        }) as IntellijDetails,
        isError: authDenied,
      };
    }

    const lines = [`IntelliJ index phase: ${snapshot.phase}`, `Project: ${projectRoot}`];
    if (snapshot.detail) lines.push(`Detail: ${sanitizeString(snapshot.detail)}`);
    if (snapshot.progress?.percentage !== undefined && snapshot.progress.percentage >= 0) {
      lines.push(`Progress: ${Math.round(snapshot.progress.percentage)}%`);
    }
    if (snapshot.progress?.message) {
      lines.push(`Progress message: ${sanitizeString(snapshot.progress.message)}`);
    }
    if (snapshot.live === false) lines.push('Connection: none (last session ended)');
    if (snapshot.connectionId) lines.push(`Connection ID: ${snapshot.connectionId}`);
    lines.push(...formatWorkspaceLines(workspaceContext));
    lines.push(...formatLicenseLines(snapshot.license));
    lines.push(...formatFailureLines(snapshot.failure, systemPath));

    return {
      content: [{ type: 'text', text: sanitizeString(lines.join('\n')) }],
      details: sanitizeStatus({
        project: projectRoot,
        ...snapshot,
        ...(workspaceContext ? { workspace: workspaceContext } : {}),
      }) as IntellijDetails,
      isError: snapshot.phase === 'failed' || authDenied,
    };
  }

  if (action === 'wait') {
    const rawCurrent = await readState(systemPath, projectRoot);
    let current = sanitizeStatus(rawCurrent) as ProjectStateResult;
    if (isAuthDenied(current.license)) {
      const authLines = [
        `IntelliJ authorization required for project ${projectRoot}: ${current.license?.reason || current.license?.status || 'features declined'}.`,
        `Guidance: ${LICENSE_RECOVERY_GUIDANCE}`,
        ...formatLicenseLines(current.license),
        ...formatFailureLines(current.failure, systemPath),
      ];
      return {
        content: [{ type: 'text', text: sanitizeString(authLines.join('\n')) }],
        details: sanitizeStatus({ project: projectRoot, ...current }) as IntellijDetails,
        isError: true,
      };
    }

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
        details: sanitizeStatus({ project: projectRoot, ...current }) as IntellijDetails,
        isError: false,
      };
    }

    if (current.phase === 'failed' || current.phase === 'disconnected') {
      const failLines = [
        `IntelliJ index is in ${current.phase} state for project ${projectRoot}: ${current.detail || 'Connection stopped'}.`,
        ...formatLicenseLines(current.license),
        ...formatFailureLines(current.failure, systemPath),
      ];
      return {
        content: [
          {
            type: 'text',
            text: sanitizeString(failLines.join('\n')),
          },
        ],
        details: sanitizeStatus({ project: projectRoot, ...current }) as IntellijDetails,
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
        details: sanitizeStatus({
          live: false,
          project: projectRoot,
          ...current,
        }) as IntellijDetails,
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
          details: { phase: current.phase, detail: current.detail, project: projectRoot },
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

      const loopRawCurrent = await readState(systemPath, projectRoot);
      current = sanitizeStatus(loopRawCurrent) as ProjectStateResult;

      if (isAuthDenied(current.license)) {
        const authLines = [
          `IntelliJ authorization required for project ${projectRoot}: ${current.license?.reason || current.license?.status || 'features declined'}.`,
          `Guidance: ${LICENSE_RECOVERY_GUIDANCE}`,
          ...formatLicenseLines(current.license),
          ...formatFailureLines(current.failure, systemPath),
        ];
        return {
          content: [{ type: 'text', text: sanitizeString(authLines.join('\n')) }],
          details: sanitizeStatus({ project: projectRoot, ...current }) as IntellijDetails,
          isError: true,
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
          details: sanitizeStatus({ project: projectRoot, ...current }) as IntellijDetails,
          isError: false,
        };
      }

      if (current.phase === 'failed' || current.phase === 'disconnected') {
        const failLines = [
          `IntelliJ index failed for project ${projectRoot}: ${current.detail || current.phase}.`,
          ...formatLicenseLines(current.license),
          ...formatFailureLines(current.failure, systemPath),
        ];
        return {
          content: [
            {
              type: 'text',
              text: sanitizeString(failLines.join('\n')),
            },
          ],
          details: sanitizeStatus({ project: projectRoot, ...current }) as IntellijDetails,
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
          details: sanitizeStatus({ project: projectRoot, ...current }) as IntellijDetails,
          isError: false,
        };
      }
    }

    // Timeout reached without failure: return still-indexing status
    const timeoutLines = [
      `IntelliJ index wait timed out after ${timeoutSec}s for project ${projectRoot}; project is still ${current.phase}${current.detail ? `: ${current.detail}` : ''}.`,
      ...formatLicenseLines(current.license),
      ...formatFailureLines(current.failure, systemPath),
    ];
    return {
      content: [
        {
          type: 'text',
          text: sanitizeString(timeoutLines.join('\n')),
        },
      ],
      details: sanitizeStatus({
        project: projectRoot,
        timeout: timeoutSec,
        stillIndexing: true,
        ...current,
      }) as IntellijDetails,
      isError: false,
    };
  }
  if (action === 'reload') {
    if (signal?.aborted) {
      const err = new Error('IntelliJ workspace reload aborted');
      err.name = 'AbortError';
      throw err;
    }

    const timeoutSec = Math.min(Math.max(params.timeout || 60, 1), 300);
    const timeoutMs = timeoutSec * 1000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const workspaceContext = await getWorkspaceContextSafe(
      getWorkspaceInfoFn,
      projectRoot,
      systemPath,
      configDir,
    );

    const preStateRaw = await readState(systemPath, projectRoot);
    const preState = sanitizeStatus(preStateRaw) as ProjectStateResult;
    if (isAuthDenied(preState.license)) {
      const authLines = [
        `IntelliJ authorization required for project ${projectRoot}: ${preState.license?.reason || preState.license?.status || 'features declined'}.`,
        `Guidance: ${LICENSE_RECOVERY_GUIDANCE}`,
        ...formatWorkspaceLines(workspaceContext),
        ...formatLicenseLines(preState.license),
        ...formatFailureLines(preState.failure, systemPath),
      ];
      return {
        content: [{ type: 'text', text: sanitizeString(authLines.join('\n')) }],
        details: sanitizeStatus({
          ...preState,
          project: projectRoot,
          timeout: timeoutSec,
          reloaded: false,
          ...(workspaceContext ? { workspace: workspaceContext } : {}),
        }) as IntellijDetails,
        isError: true,
      };
    }

    onUpdate?.({
      content: [
        {
          type: 'text',
          text: `Reloading IntelliJ workspace model for project ${projectRoot}...`,
        },
      ],
      details: { phase: 'importing', detail: 'Reloading workspace model', project: projectRoot },
    });

    try {
      const reimportResult = await reimport(projectRoot, {
        timeoutMs,
        signal: effectiveSignal,
        systemPath,
        configDir,
      });

      if (signal?.aborted) {
        const err = new Error('IntelliJ workspace reload aborted');
        err.name = 'AbortError';
        throw err;
      }
      if (timeoutSignal.aborted) {
        const err = new Error(`IntelliJ workspace reload timed out after ${timeoutSec}s`);
        Object.assign(err, { code: 'ETIMEDOUT' });
        throw err;
      }

      const postStateRaw = await readState(systemPath, projectRoot);
      const postState = sanitizeStatus(postStateRaw) as ProjectStateResult;
      const latestWorkspace = await getWorkspaceContextSafe(
        getWorkspaceInfoFn,
        projectRoot,
        systemPath,
        configDir,
      );
      const effectiveWorkspace: IntellijWorkspaceContext = {
        ...(latestWorkspace || workspaceContext || {}),
      };
      if (reimportResult?.submittedEnvKeys) {
        effectiveWorkspace.submittedEnvKeys = reimportResult.submittedEnvKeys;
      }

      const isPostAuthDenied = isAuthDenied(postState.license);
      const isFailed = postState.phase === 'failed' || isPostAuthDenied || !reimportResult?.ready;

      if (isFailed) {
        const failLines = [
          `IntelliJ workspace reload failed for project ${projectRoot}${reimportResult?.elapsedMs !== undefined ? ` (${reimportResult.elapsedMs}ms)` : ''}: ${postState.detail || 'reload not ready'}.`,
          ...formatWorkspaceLines(effectiveWorkspace),
          ...formatLicenseLines(postState.license),
          ...formatFailureLines(postState.failure, systemPath),
        ];

        return {
          content: [{ type: 'text', text: sanitizeString(failLines.join('\n')) }],
          details: sanitizeStatus({
            ...postState,
            project: projectRoot,
            timeout: timeoutSec,
            reloaded: false,
            elapsedMs: reimportResult?.elapsedMs,
            ...(Object.keys(effectiveWorkspace).length > 0
              ? { workspace: effectiveWorkspace }
              : {}),
          }) as IntellijDetails,
          isError: true,
        };
      }

      const successLines = [
        `IntelliJ workspace reloaded successfully for project ${projectRoot}${reimportResult?.elapsedMs !== undefined ? ` (${reimportResult.elapsedMs}ms)` : ''}. Index is ready.`,
        ...formatWorkspaceLines(effectiveWorkspace),
        ...formatLicenseLines(postState.license),
        ...formatFailureLines(postState.failure, systemPath),
      ];

      return {
        content: [{ type: 'text', text: sanitizeString(successLines.join('\n')) }],
        details: sanitizeStatus({
          ...postState,
          project: projectRoot,
          timeout: timeoutSec,
          reloaded: true,
          elapsedMs: reimportResult?.elapsedMs,
          ...(Object.keys(effectiveWorkspace).length > 0 ? { workspace: effectiveWorkspace } : {}),
        }) as IntellijDetails,
        isError: false,
      };
    } catch (err: unknown) {
      if (signal?.aborted && !timeoutSignal.aborted) {
        const abortErr = new Error('IntelliJ workspace reload aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      if (err instanceof Error && err.name === 'AbortError' && !timeoutSignal.aborted) {
        throw err;
      }

      const postStateRaw = await readState(systemPath, projectRoot).catch(() => null);
      const postState = postStateRaw
        ? (sanitizeStatus(postStateRaw) as ProjectStateResult)
        : undefined;
      const latestWorkspace = await getWorkspaceContextSafe(
        getWorkspaceInfoFn,
        projectRoot,
        systemPath,
        configDir,
      );
      const effectiveWorkspace: IntellijWorkspaceContext = {
        ...(latestWorkspace || workspaceContext || {}),
      };

      const isTimeout = timeoutSignal.aborted || isTimeoutError(err);
      const rawMsg = err instanceof Error ? err.message : String(err);

      if (isTimeout) {
        const timeoutLines = [
          `IntelliJ workspace reload timed out after ${timeoutSec}s for project ${projectRoot}: ${sanitizeString(rawMsg)}.`,
          ...formatWorkspaceLines(effectiveWorkspace),
          ...formatLicenseLines(postState?.license),
          ...formatFailureLines(
            {
              kind: 'timeout',
              stage: 'import',
              message: rawMsg,
              code: 'ETIMEDOUT',
            },
            systemPath,
          ),
        ];

        return {
          content: [{ type: 'text', text: sanitizeString(timeoutLines.join('\n')) }],
          details: sanitizeStatus({
            ...postState,
            project: projectRoot,
            timeout: timeoutSec,
            reloaded: false,
            phase: postState?.phase || 'failed',
            failure: {
              kind: 'timeout',
              stage: 'import',
              message: rawMsg,
              code: 'ETIMEDOUT',
            },
            ...(Object.keys(effectiveWorkspace).length > 0
              ? { workspace: effectiveWorkspace }
              : {}),
          }) as IntellijDetails,
          isError: true,
        };
      }

      const currentFailure: FailureDetail = {
        kind: 'import',
        stage: 'import',
        message: rawMsg,
        code: extractErrorCode(err),
        data: extractErrorData(err),
      };

      const failLines = [
        `IntelliJ workspace reload failed for project ${projectRoot}: ${sanitizeString(rawMsg)}.`,
        ...formatWorkspaceLines(effectiveWorkspace),
        ...formatLicenseLines(postState?.license),
        ...formatFailureLines(currentFailure, systemPath),
      ];

      return {
        content: [{ type: 'text', text: sanitizeString(failLines.join('\n')) }],
        details: sanitizeStatus({
          ...postState,
          project: projectRoot,
          timeout: timeoutSec,
          reloaded: false,
          phase: postState?.phase || 'failed',
          failure: currentFailure,
          ...(Object.keys(effectiveWorkspace).length > 0 ? { workspace: effectiveWorkspace } : {}),
        }) as IntellijDetails,
        isError: true,
      };
    }
  }

  throw new Error(`Unknown action: ${action}`);
}

export function registerIntellij(
  pi: ExtensionPluginInstance,
  options: ExecuteIntellijOptions = {},
): void {
  const z = pi.zod;
  pi.registerTool({
    name: 'intellij',
    approval: 'exec',
    label: 'IntelliJ',
    description:
      'Inspect IntelliJ setup, index readiness, or the compile and launch model for a source file. Doctor, status and wait do not start the service; model connects without building or running; reload triggers project reimport.',
    parameters: z.object({
      action: z
        .enum(['status', 'wait', 'reload', 'doctor', 'model'])
        .default('status')
        .describe(
          'Inspect setup, index readiness, reload the project, or query the source-file model',
        ),
      project: z
        .string()
        .optional()
        .describe('Project root directory; defaults to current directory or detected project root'),
      file: z
        .string()
        .optional()
        .describe(
          'Required for model: JVM source path relative to current directory; project can specify the reactor root',
        ),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(300)
        .default(60)
        .describe('Timeout in seconds for wait, reload, or model (1-300, default 60)'),
    }),
    execute(
      _id: string,
      params: IntellijParams,
      signal: AbortSignal | undefined,
      onUpdate: ((update: ToolUpdate<IntellijDetails>) => void) | undefined,
      ctx: ExtensionContext,
    ) {
      return executeIntellij(params, signal, onUpdate, ctx, options);
    },
  });
}
