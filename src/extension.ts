import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyPrune,
  computePruneCandidates,
  formatBytes,
  getCacheInventory,
} from './cache-manager.js';
import { type ProjectStateResult, readProjectState } from './connection-state.js';
import { listDebugSessions, recoverDebugSession } from './debug-control.js';
import { formatDoctorReport, inspectDoctor } from './doctor.js';
import { acceptServerEula, type EulaDocument, readEulaAcceptance, readServerEula } from './eula.js';
import type { ExtensionContext, ExtensionPluginInstance } from './extension-types.js';
import {
  formatInstallDescription,
  formatInstallStatusText,
  formatStatusText,
  isInstallActive,
  parseInstallArgs,
} from './install-status.js';
import { registerIntellij } from './intellij-tool.js';
import { recordConnection } from './metadata.js';
import { failureContentKey, findProjectRoot, licenseContentKey, watchIndex } from './readiness.js';
import {
  type FailureDetail,
  LICENSE_RECOVERY_GUIDANCE,
  type LicenseSummary,
  sanitizeStatus,
  sanitizeString,
} from './runtime-status.js';
import {
  DEFAULT_SERVER_VERSION,
  latestServerVersion as defaultLatestServerVersion,
  resolveServerBundle as defaultResolveServerBundle,
  serverBundle,
  validateServerVersion,
} from './server-bundles.js';
import {
  defaultInstallDir as defaultDefaultInstallDir,
  readObservedInstallState as defaultReadObservedInstallState,
  readServerConfig as defaultReadServerConfig,
  saveServerConfig as defaultSaveServerConfig,
  trackInstallation as defaultTrackInstallation,
} from './server-config.js';
import {
  ensureInstalled as defaultEnsureInstalled,
  findInstalled as defaultFindInstalled,
  listInstalledVersions as defaultListInstalledVersions,
  readInstallState as defaultReadInstallState,
  type InstallState,
} from './server-install.js';
import { selectServerVersion as defaultSelectServerVersion } from './server-versions.js';
import {
  endpoint,
  ensureServer,
  isServerAlive,
  restartServer,
  settings,
  status,
  stopServer,
  withLifecycleLock,
} from './service.js';
import type { DiscoveredJdkItem } from './workspace.js';
import * as defaultWorkspaceApi from './workspace.js';
export function parseJdkPath(input: unknown): string {
  if (typeof input !== 'string') return '';
  let s = input.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

const STATUS_KEY = 'intellij-index';

function projectLabel(state: ProjectStateResult, fallbackRoot?: string, cwd?: string): string {
  if (state?.canonicalPath) return state.canonicalPath;
  return fallbackRoot || cwd || '';
}

function isTimeoutError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const code = 'code' in err ? err.code : undefined;
    const message = 'message' in err ? err.message : undefined;
    return code === 'ETIMEDOUT' || (typeof message === 'string' && message.includes('timed out'));
  }
  return false;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String(err.message);
  }
  return String(err);
}

export function isAuthDenied(license?: LicenseSummary): boolean {
  if (!license) return false;
  return (
    license.status === 'needs-activation' ||
    license.status === 'expired' ||
    Boolean(license.featuresDeclined)
  );
}

export function formatFailureSummary(failure?: FailureDetail, systemPath?: string): string {
  if (!failure) return '';
  const sanitized = sanitizeStatus(failure) as FailureDetail;
  const parts = [
    `failure: ${sanitized.kind} (${sanitized.stage}) - ${sanitizeString(sanitized.message)}`,
  ];
  if (sanitized.code !== undefined && sanitized.code !== '') {
    parts.push(`code: ${sanitized.code}`);
  }
  if (sanitized.folders && sanitized.folders.length > 0) {
    parts.push(
      'folders: ' +
        sanitized.folders
          .map((f) => `${sanitizeString(f.uri || f.tool || 'folder')}[${f.status}]`)
          .join(', '),
    );
  }
  const logPath = sanitized.logPath || (systemPath ? join(systemPath, 'launcher.log') : undefined);
  if (logPath) {
    parts.push(`log: ${sanitizeString(logPath)}`);
  }
  return parts.join('; ');
}

export function formatLicenseSummary(license?: LicenseSummary): string {
  if (!license) return '';
  const sanitized = sanitizeStatus(license) as LicenseSummary;
  const parts = [`license: ${sanitized.status || 'unknown'}`];
  if (sanitized.featuresDeclined) {
    parts.push('features declined');
  }
  if (sanitized.reason) {
    parts.push(`reason: ${sanitizeString(sanitized.reason)}`);
  }
  if (sanitized.source) {
    parts.push(`source: ${sanitizeString(sanitized.source)}`);
  }
  return parts.join('; ');
}

export interface ExtensionOverrides {
  workspaceApi?: typeof defaultWorkspaceApi | Partial<typeof defaultWorkspaceApi>;
  readinessApi?: Partial<{
    watchIndex: typeof watchIndex;
    findProjectRoot: typeof findProjectRoot;
  }>;
  serverConfigApi?: Partial<{
    readServerConfig: typeof defaultReadServerConfig;
    saveServerConfig: typeof defaultSaveServerConfig;
    defaultInstallDir: typeof defaultDefaultInstallDir;
    trackInstallation: typeof defaultTrackInstallation;
    readObservedInstallState: typeof defaultReadObservedInstallState;
  }>;
  serverInstallApi?: Partial<{
    ensureInstalled: typeof defaultEnsureInstalled;
    readInstallState: typeof defaultReadInstallState;
    findInstalled: typeof defaultFindInstalled;
    listInstalledVersions: typeof defaultListInstalledVersions;
  }>;
  versionApi?: Partial<{
    selectServerVersion: typeof defaultSelectServerVersion;
    resolveServerBundle: typeof defaultResolveServerBundle;
    latestServerVersion: typeof defaultLatestServerVersion;
  }>;
  pollIntervalMs?: number;
  configFile?: string;
  debugControlApi?: Partial<{
    listDebugSessions: typeof listDebugSessions;
    recoverDebugSession: typeof recoverDebugSession;
  }>;
  lifecycleApi?: Partial<{
    stopServer: typeof stopServer;
    restartServer: typeof restartServer;
  }>;
  systemPath?: string;
  configDir?: string;
  doctorApi?: Partial<{
    inspectDoctor: typeof inspectDoctor;
    formatDoctorReport: typeof formatDoctorReport;
  }>;
}

export default function (pi: ExtensionPluginInstance, overrides: ExtensionOverrides = {}) {
  const wsApi = { ...defaultWorkspaceApi, ...overrides.workspaceApi };
  const watchIndexFn = overrides.readinessApi?.watchIndex ?? watchIndex;
  const findProjectRootFn = overrides.readinessApi?.findProjectRoot ?? findProjectRoot;
  const configApi = {
    readServerConfig: overrides.serverConfigApi?.readServerConfig ?? defaultReadServerConfig,
    saveServerConfig: overrides.serverConfigApi?.saveServerConfig ?? defaultSaveServerConfig,
    defaultInstallDir: overrides.serverConfigApi?.defaultInstallDir ?? defaultDefaultInstallDir,
    trackInstallation: overrides.serverConfigApi?.trackInstallation ?? defaultTrackInstallation,
    readObservedInstallState:
      overrides.serverConfigApi?.readObservedInstallState ?? defaultReadObservedInstallState,
  };
  const installApi = {
    ensureInstalled: overrides.serverInstallApi?.ensureInstalled ?? defaultEnsureInstalled,
    readInstallState: overrides.serverInstallApi?.readInstallState ?? defaultReadInstallState,
    findInstalled: overrides.serverInstallApi?.findInstalled ?? defaultFindInstalled,
    listInstalledVersions:
      overrides.serverInstallApi?.listInstalledVersions ?? defaultListInstalledVersions,
  };
  const versionApi = {
    selectServerVersion: overrides.versionApi?.selectServerVersion ?? defaultSelectServerVersion,
    resolveServerBundle: overrides.versionApi?.resolveServerBundle ?? defaultResolveServerBundle,
    latestServerVersion: overrides.versionApi?.latestServerVersion ?? defaultLatestServerVersion,
  };
  const pollIntervalMs = overrides.pollIntervalMs ?? 500;
  const configOptions = overrides.configFile ? { configFile: overrides.configFile } : {};
  const debugApi = {
    listDebugSessions: overrides.debugControlApi?.listDebugSessions ?? listDebugSessions,
    recoverDebugSession: overrides.debugControlApi?.recoverDebugSession ?? recoverDebugSession,
  };
  const lifecycleApi = {
    stopServer: overrides.lifecycleApi?.stopServer ?? stopServer,
    restartServer: overrides.lifecycleApi?.restartServer ?? restartServer,
  };
  const doctorApi = {
    inspectDoctor: overrides.doctorApi?.inspectDoctor ?? inspectDoctor,
    formatDoctorReport: overrides.doctorApi?.formatDoctorReport ?? formatDoctorReport,
  };
  const activeSystemPath = overrides.systemPath ?? settings.systemPath;
  async function resolveSelectedExecutable(): Promise<{
    executable?: string;
    mode: 'managed' | 'external';
    installDir?: string;
    version?: string;
    error?: string;
  }> {
    const configuration = await configApi.readServerConfig(settings.executable, configOptions);
    if (configuration.mode === 'external') {
      return { mode: 'external', executable: configuration.executable };
    }
    const installDir = configuration.installDir;
    const version = configuration.version ?? DEFAULT_SERVER_VERSION;
    const installed = await installApi.findInstalled(installDir, { version }).catch(() => null);
    if (installed?.executable && existsSync(installed.executable)) {
      return {
        mode: 'managed',
        executable: installed.executable,
        installDir,
        version: installed.version,
      };
    }
    return {
      mode: 'managed',
      installDir,
      version,
      error: `Managed IntelliJ server is not installed (${version}). Run /intellij install to install it first.`,
    };
  }

  pi.setLabel?.('IntelliJ LSP');
  registerIntellij(pi, {
    systemPath: activeSystemPath,
    configFile: overrides.configFile,
    configDir: overrides.configDir,
  });

  let statusVisible = false;
  let statusText = '';

  function clearStatus(ctx?: ExtensionContext | null): void {
    if (!ctx?.ui?.setStatus) return;
    if (!statusVisible) return;
    statusVisible = false;
    statusText = '';
    try {
      ctx.ui.setStatus(STATUS_KEY, '');
    } catch {}
  }

  function setStatusText(ctx: ExtensionContext | undefined | null, text: string): void {
    if (!ctx?.ui?.setStatus) return;
    if (statusVisible && statusText === text) return;
    statusVisible = true;
    statusText = text;
    ctx.ui.setStatus(STATUS_KEY, text);
  }

  let stopObserver: (() => void) | null = null;
  let installPollTimer: NodeJS.Timeout | null = null;
  let activeCommandAbort: AbortController | null = null;
  let state: ProjectStateResult = { phase: 'not-started', detail: '' };
  let activeInstallState: InstallState | null = null;
  let disposed = false;
  let generation = 0;
  let activeCtx: ExtensionContext | null = null;
  const notifiedReady = new Set<string>();
  const notifiedInstalls = new Set<string>();
  let observationStart = Date.now();

  function renderStatus(ctx: ExtensionContext | null | undefined): void {
    if (disposed || !ctx) {
      clearStatus(ctx);
      return;
    }

    if (activeInstallState && isInstallActive(activeInstallState)) {
      setStatusText(ctx, formatInstallStatusText(activeInstallState));
      return;
    }

    const phase = state?.phase;
    if (
      state?.live !== false &&
      (phase === 'connecting' || phase === 'importing' || phase === 'indexing')
    ) {
      setStatusText(ctx, formatStatusText(phase, state.detail, state.progress));
      return;
    }

    clearStatus(ctx);
  }

  function applyInstallState(
    observed: InstallState | null,
    ctx: ExtensionContext | null,
    currentGen: number,
    isPoll: boolean = false,
  ): void {
    if (disposed || generation !== currentGen) return;

    if (isPoll) {
      if (!observed) {
        if (activeCommandAbort && isInstallActive(activeInstallState)) {
          return;
        }
        activeInstallState = null;
        renderStatus(ctx);
        return;
      }

      if (
        activeInstallState &&
        observed.installId &&
        observed.installId === activeInstallState.installId &&
        (observed.updatedAt ?? 0) < (activeInstallState.updatedAt ?? 0)
      ) {
        return;
      }
    }

    activeInstallState = observed;
    renderStatus(ctx);

    if (!observed || activeCommandAbort) return;

    if (observed.phase === 'ready' || observed.phase === 'failed') {
      const isStale = (observed.updatedAt ?? 0) < observationStart;
      if (!isStale) {
        const notifKey = `${observed.installId || observed.installDir || 'unknown'}:${observed.phase}`;
        if (!notifiedInstalls.has(notifKey)) {
          notifiedInstalls.add(notifKey);
          if (observed.phase === 'ready') {
            const version = observed.version || 'unknown';
            const location = observed.executable || observed.installDir;
            ctx?.ui?.notify(`IntelliJ server installed: ${version} at ${location}`, 'info');
          } else {
            ctx?.ui?.notify(
              `IntelliJ server installation failed: ${observed.error || 'unknown error'}.`,
              'warning',
            );
          }
        }
      }
    }
  }

  function startObserver(ctx: ExtensionContext): void {
    activeCtx = ctx;
    const currentGeneration = ++generation;
    stopObserver?.();
    stopObserver = null;
    if (installPollTimer !== null) {
      clearTimeout(installPollTimer);
      installPollTimer = null;
    }
    if (activeCommandAbort) {
      activeCommandAbort.abort();
      activeCommandAbort = null;
    }
    disposed = false;
    observationStart = Date.now();
    renderStatus(ctx);

    const projectRoot = findProjectRootFn(ctx.cwd);
    const markers = [
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'settings.gradle.kts',
      '.idea',
    ];
    const isJava = markers.some((marker) => existsSync(join(projectRoot, marker)));

    let stopWatchIndex: (() => void) | null = null;
    let lastNotifiedLicenseKey: string | null = null;
    let lastNotifiedFailureKey: string | null = null;
    let wasAuthDenied = false;

    if (isJava) {
      stopWatchIndex = watchIndexFn(
        projectRoot,
        (next) => {
          if (disposed || generation !== currentGeneration) return;
          const previous = state;
          state = next;
          renderStatus(ctx);

          if (next.phase === 'ready' && next.live !== false && !isAuthDenied(next.license)) {
            const readyKey = next.connectionId || `gen-${currentGeneration}`;
            if (!notifiedReady.has(readyKey)) {
              notifiedReady.add(readyKey);
              ctx.ui?.notify(
                `IntelliJ index ready: ${projectLabel(next, projectRoot, ctx.cwd)}`,
                'info',
              );
            }
          } else if (next.phase === 'failed' || next.phase === 'disconnected') {
            const stale = (next.updatedAt ?? 0) < observationStart;
            const currentFailKey = failureContentKey(next.failure);
            const failChanged =
              previous.phase !== next.phase ||
              previous.detail !== next.detail ||
              currentFailKey !== lastNotifiedFailureKey;
            if (!stale && failChanged) {
              lastNotifiedFailureKey = currentFailKey;
              if (next.phase === 'disconnected') {
                ctx.ui?.notify(
                  `IntelliJ connection lost: ${next.detail || 'server disconnected'}.`,
                  'warning',
                );
              } else {
                const failDetail = next.failure?.message || next.detail || '';
                ctx.ui?.notify(
                  `IntelliJ index failed: ${failDetail}. Use /intellij start to retry.`,
                  'warning',
                );
              }
            }
          }

          const currentLicKey = licenseContentKey(next.license);
          const authDeniedNow = isAuthDenied(next.license);

          if (authDeniedNow) {
            if (currentLicKey !== lastNotifiedLicenseKey) {
              lastNotifiedLicenseKey = currentLicKey;
              wasAuthDenied = true;
              const reason =
                next.license?.reason || next.license?.status || 'authorization required';
              ctx.ui?.notify(
                `IntelliJ authorization required: ${reason}. ${LICENSE_RECOVERY_GUIDANCE}`,
                'warning',
              );
            }
          } else if (
            wasAuthDenied &&
            next.license?.status === 'valid' &&
            !next.license?.featuresDeclined
          ) {
            wasAuthDenied = false;
            lastNotifiedLicenseKey = currentLicKey;
            ctx.ui?.notify('IntelliJ authorization restored.', 'info');
          } else {
            lastNotifiedLicenseKey = currentLicKey;
          }
        },
        { systemPath: activeSystemPath },
      );
    }

    async function checkInstallState() {
      if (disposed || generation !== currentGeneration) return;
      try {
        const observed = await configApi.readObservedInstallState(configOptions);
        if (disposed || generation !== currentGeneration) return;
        applyInstallState(observed, ctx, currentGeneration, true);
      } catch {}
    }

    function scheduleInstallPoll() {
      if (disposed || generation !== currentGeneration) return;
      installPollTimer = setTimeout(async () => {
        if (disposed || generation !== currentGeneration) return;
        await checkInstallState();
        scheduleInstallPoll();
      }, pollIntervalMs);
      installPollTimer.unref?.();
    }

    void checkInstallState();
    scheduleInstallPoll();

    stopObserver = () => {
      if (stopWatchIndex) {
        stopWatchIndex();
        stopWatchIndex = null;
      }
      if (installPollTimer !== null) {
        clearTimeout(installPollTimer);
        installPollTimer = null;
      }
      if (activeCommandAbort) {
        activeCommandAbort.abort();
        activeCommandAbort = null;
      }
    };
  }

  pi.registerCommand('intellij', {
    description:
      'IntelliJ language server, project index, cache, pruning, workspace and debug management',
    handler: async (rawArgs: string, ctx: ExtensionContext) => {
      const args = rawArgs.trim();
      const parts = args.split(/\s+/).filter(Boolean);
      const sub = parts[0] || 'status';

      if (sub === 'start') {
        const socket = await ensureServer();
        socket.destroy();
        startObserver(ctx);
      } else if (sub === 'stop' || sub === 'restart') {
        if (parts.length !== 1) {
          ctx.ui?.notify(`Usage: /intellij ${sub}`, 'warning');
          return;
        }
        try {
          if (sub === 'stop') {
            const result = await lifecycleApi.stopServer({ systemPath: activeSystemPath });
            ctx.ui?.notify(
              result.stopped
                ? `IntelliJ shared server stopped (PID ${result.pid}); caches and workspace configuration retained.`
                : result.detail || 'IntelliJ shared server is not running.',
              'info',
            );
          } else {
            const result = await lifecycleApi.restartServer({ systemPath: activeSystemPath });
            ctx.ui?.notify(
              `IntelliJ shared server restarted: ${result.endpoint.host}:${result.endpoint.port} (PID ${result.pid}); caches and workspace configuration retained.`,
              'info',
            );
          }
          startObserver(ctx);
        } catch (error: unknown) {
          ctx.ui?.notify(
            `IntelliJ ${sub} refused: ${sanitizeString(getErrorMessage(error))}`,
            'warning',
          );
        }
      } else if (sub === 'doctor') {
        if (parts.length !== 1) {
          ctx.ui?.notify('Usage: /intellij doctor', 'warning');
          return;
        }
        try {
          const projectRoot = findProjectRootFn(ctx.cwd);
          const report = await doctorApi.inspectDoctor(projectRoot, {
            systemPath: activeSystemPath,
            configFile: overrides.configFile,
            configDir: overrides.configDir,
          });
          const formatted = doctorApi.formatDoctorReport(report);
          ctx.ui?.notify(formatted, report.summary.ok ? 'info' : 'warning');
        } catch (error: unknown) {
          ctx.ui?.notify(
            `IntelliJ doctor failed: ${sanitizeString(getErrorMessage(error))}`,
            'error',
          );
        }
      } else if (sub === 'status') {
        const projectRoot = findProjectRootFn(ctx.cwd);
        const current = await readProjectState(activeSystemPath, projectRoot);
        state = current;

        const configuration = await configApi.readServerConfig(settings.executable, configOptions);
        const configDesc =
          configuration.mode === 'managed'
            ? `server (managed): ${configuration.installDir} (version: ${configuration.version ?? DEFAULT_SERVER_VERSION})`
            : `server (external): ${configuration.executable}`;

        const observed =
          (await configApi.readObservedInstallState(configOptions).catch(() => null)) ??
          activeInstallState;
        const installDesc = observed ? formatInstallDescription(observed) : '';

        let serverDesc: string;
        if (await status()) {
          const { host, port } = await endpoint();
          serverDesc = `IntelliJ ${host}:${port}`;
        } else {
          serverDesc = 'IntelliJ shared server stopped';
        }

        const indexDesc = `project index: ${state.phase}${state.detail ? ` (${state.detail})` : ''}`;

        const parts = [serverDesc, configDesc];
        if (installDesc) {
          parts.push(installDesc);
        }
        parts.push(indexDesc);
        const licSummary = formatLicenseSummary(state.license);
        if (licSummary) {
          parts.push(licSummary);
        }
        const failSummary = formatFailureSummary(state.failure, activeSystemPath);
        if (failSummary) {
          parts.push(failSummary);
        }
        if (isAuthDenied(state.license)) {
          parts.push(`recovery: ${LICENSE_RECOVERY_GUIDANCE}`);
        }
        const debugSessions = await debugApi
          .listDebugSessions({
            systemPath: activeSystemPath,
            projectRoot,
          })
          .catch(() => []);
        if (debugSessions.length > 0) {
          const liveCount = debugSessions.filter((s) => s.live).length;
          parts.push(`debug: ${liveCount} active / ${debugSessions.length} total`);
        }
        ctx.ui?.notify(parts.join('; '), 'info');
      } else if (sub === 'install') {
        startObserver(ctx);
        const commandGen = generation;
        const remainder = rawArgs.trim().slice('install'.length);
        const { dir, version: requestedVersion, error } = parseInstallArgs(remainder);
        if (error) {
          ctx.ui?.notify(error, 'warning');
          return;
        }

        const ownedAbort = new AbortController();
        activeCommandAbort = ownedAbort;
        let targetDir = dir;

        try {
          const currentConfig = await configApi.readServerConfig(
            settings.executable,
            configOptions,
          );
          if (!targetDir) {
            if (currentConfig.mode === 'managed') {
              targetDir = currentConfig.installDir;
            } else {
              targetDir = configApi.defaultInstallDir();
            }
          }

          let targetVersion = requestedVersion;
          if (!targetVersion) {
            if (currentConfig.mode === 'managed' && currentConfig.version) {
              targetVersion = currentConfig.version;
            } else {
              targetVersion = DEFAULT_SERVER_VERSION;
            }
          }

          const cachedVersion =
            targetVersion === 'latest' ? null : validateServerVersion(targetVersion);
          let result = cachedVersion
            ? await installApi.findInstalled(targetDir, { version: cachedVersion })
            : null;
          await configApi.trackInstallation(targetDir, configOptions);
          if (!result) {
            const bundle =
              targetVersion === DEFAULT_SERVER_VERSION
                ? serverBundle()
                : await versionApi.resolveServerBundle(targetVersion, {
                    signal: ownedAbort.signal,
                  });
            result = await installApi.ensureInstalled(targetDir, {
              bundle,
              signal: ownedAbort.signal,
              onProgress: (prog) => {
                applyInstallState(prog, ctx, commandGen, false);
              },
            });
          }
          if (disposed || generation !== commandGen) {
            return;
          }

          let selectionBlockedError: string | null = null;
          try {
            await versionApi.selectServerVersion(result.version, {
              configFile: overrides.configFile,
              installDir: result.installDir,
              systemPath: activeSystemPath,
            });
          } catch (selectErr: unknown) {
            selectionBlockedError = getErrorMessage(selectErr);
          }

          if (disposed || generation !== commandGen) {
            return;
          }

          const realState = await installApi.readInstallState(result.installDir);
          if (disposed || generation !== commandGen) return;
          const readyKey = `${realState?.installId || result.installDir}:ready`;
          notifiedInstalls.add(readyKey);
          if (realState?.version === result.version) {
            applyInstallState(realState, ctx, commandGen, false);
          } else {
            activeInstallState = null;
            renderStatus(ctx);
          }

          if (selectionBlockedError) {
            const retryDirArg = dir ? ` --dir "${result.installDir}"` : '';
            ctx.ui?.notify(
              `IntelliJ server installed: ${result.version} at ${result.executable}, but not selected: ${selectionBlockedError}. Stop the server and re-run /intellij install --version ${result.version}${retryDirArg} to switch to this installation.`,
              'warning',
            );
          } else {
            ctx.ui?.notify(
              `IntelliJ server installed: ${result.version} at ${result.executable} (configured/selected; start explicitly)`,
              'info',
            );
          }
        } catch (err: unknown) {
          if (disposed || generation !== commandGen) {
            return;
          }
          const errorMsg = getErrorMessage(err);
          const failedState = targetDir
            ? await installApi.readInstallState(targetDir).catch(() => null)
            : null;
          if (disposed || generation !== commandGen) return;
          const failKey = `${failedState?.installId || targetDir || 'command'}:failed`;
          notifiedInstalls.add(failKey);
          if (failedState) {
            applyInstallState(failedState, ctx, commandGen, false);
          } else {
            activeInstallState = null;
            renderStatus(ctx);
          }
          ctx.ui?.notify(`IntelliJ installation failed: ${errorMsg}`, 'error');
        } finally {
          if (activeCommandAbort === ownedAbort) {
            activeCommandAbort = null;
          }
        }
      } else if (sub === 'versions') {
        const remainder = rawArgs.trim().slice('versions'.length).trim();
        let queryRemote = false;
        if (remainder) {
          if (remainder === '--remote') {
            queryRemote = true;
          } else {
            ctx.ui?.notify('Usage: /intellij versions [--remote]', 'warning');
            return;
          }
        }

        try {
          const currentConfig = await configApi.readServerConfig(
            settings.executable,
            configOptions,
          );

          let serverRunningDesc: string;
          if (await status(activeSystemPath)) {
            try {
              const { host, port } = await endpoint(activeSystemPath);
              serverRunningDesc = `running (${host}:${port})`;
            } catch {
              serverRunningDesc = 'running';
            }
          } else if ((await isServerAlive(activeSystemPath)).alive) {
            serverRunningDesc = 'process running (endpoint unavailable)';
          } else {
            serverRunningDesc = 'stopped';
          }

          const lines: string[] = [];
          const selectedVersion =
            currentConfig.mode === 'managed'
              ? (currentConfig.version ?? DEFAULT_SERVER_VERSION)
              : null;
          const installDir =
            currentConfig.mode === 'managed'
              ? currentConfig.installDir
              : configApi.defaultInstallDir();
          if (currentConfig.mode === 'managed') {
            lines.push(
              `Selected version: ${selectedVersion}${currentConfig.version ? '' : ' (default)'}`,
            );
          } else {
            lines.push(`External executable: ${currentConfig.executable}`);
          }
          const installed = await installApi.listInstalledVersions(installDir);
          lines.push(
            `Installed versions: ${
              installed
                .map((item) =>
                  item.version === selectedVersion ? `${item.version} (selected)` : item.version,
                )
                .join(', ') || 'none'
            }`,
            `Installation directory: ${installDir}`,
          );
          lines.push(`Server status: ${serverRunningDesc}`);

          if (queryRemote) {
            try {
              const latest = await versionApi.latestServerVersion();
              lines.push(`Latest remote version: ${latest}`);
            } catch (err: unknown) {
              lines.push(`Latest remote version: error (${getErrorMessage(err)})`);
            }
          }

          ctx.ui?.notify(lines.join('; '), 'info');
        } catch (err: unknown) {
          ctx.ui?.notify(`Failed to list IntelliJ versions: ${getErrorMessage(err)}`, 'error');
        }
      } else if (sub === 'use') {
        const remainder = rawArgs.trim().slice('use'.length).trim();
        const useTokens = remainder ? remainder.split(/\s+/).filter(Boolean) : [];
        if (useTokens.length !== 1) {
          ctx.ui?.notify('Usage: /intellij use <version>', 'warning');
          return;
        }
        const targetVersion = useTokens[0];
        if (targetVersion === 'latest') {
          ctx.ui?.notify(
            'Usage: /intellij use <version> requires an explicit numeric build version, not "latest".',
            'warning',
          );
          return;
        }

        try {
          const selected = await versionApi.selectServerVersion(targetVersion, {
            configFile: overrides.configFile,
            systemPath: activeSystemPath,
          });

          let eulaNote = '';
          try {
            const doc = await readServerEula(selected.executable);
            const acceptance = await readEulaAcceptance(configOptions);
            const isAccepted = acceptance.acceptedHashes.includes(doc.hash);
            if (isAccepted) {
              eulaNote = `EULA accepted (${doc.hash}).`;
            } else {
              eulaNote = `EULA not accepted (hash: ${doc.hash}). Run /intellij eula accept ${doc.hash} before starting the server.`;
            }
          } catch (eulaErr: unknown) {
            eulaNote = `EULA status unknown (${getErrorMessage(eulaErr)}).`;
          }

          ctx.ui?.notify(
            `Selected IntelliJ server ${selected.version} (${selected.executable}). ${eulaNote}`,
            'info',
          );
        } catch (err: unknown) {
          ctx.ui?.notify(`Failed to select IntelliJ version: ${getErrorMessage(err)}`, 'error');
        }
      } else if (sub === 'cache') {
        try {
          const inv = await getCacheInventory(settings.systemPath);
          const count = inv.workspaces.length;
          const confirmed = inv.workspaces.filter((w) => w.mapping.status === 'confirmed').length;
          const unknown = count - confirmed;
          const serverNote = inv.serverAlive
            ? 'Server running (PID ' + inv.serverPid + ')'
            : 'Server stopped';
          const leaseNote = inv.activeLeases.length + ' active lease(s)';

          const details = inv.workspaces
            .map((w) => {
              const name =
                w.mapping.status === 'confirmed'
                  ? w.mapping.projectPath || w.hash
                  : 'Unknown (' + w.hash.slice(0, 8) + ')';
              const used = w.lastUsed
                ? new Date(w.lastUsed).toISOString().replace('T', ' ').slice(0, 16)
                : 'never';
              const lease = w.hasActiveLease ? ' [active lease]' : '';
              return (
                name + ': ' + formatBytes(w.logicalBytes) + ' (last used: ' + used + ')' + lease
              );
            })
            .join('; ');

          const summary =
            'IntelliJ cache: ' +
            formatBytes(inv.totalLogicalBytes) +
            ' across ' +
            count +
            ' workspace(s) (' +
            confirmed +
            ' confirmed, ' +
            unknown +
            ' unknown). ' +
            serverNote +
            '; ' +
            leaseNote +
            '.' +
            (unknown > 0
              ? ' (Note: Unknown workspaces cannot be pruned because native ownership cannot be verified.)'
              : '') +
            (details ? ' Breakdown: ' + details : '');

          ctx.ui?.notify(summary, 'info');

          const warnGiB = settings.cachePolicy?.warnAboveGiB ?? 5;
          if (inv.totalLogicalBytes > warnGiB * 1024 * 1024 * 1024) {
            ctx.ui?.notify(
              'IntelliJ cache total (' +
                formatBytes(inv.totalLogicalBytes) +
                ') exceeds policy limit of ' +
                warnGiB +
                ' GiB. Use /intellij prune to inspect pruning candidates.',
              'warning',
            );
          }
        } catch (err: unknown) {
          ctx.ui?.notify('Failed to inspect cache: ' + getErrorMessage(err), 'warning');
        }
      } else if (sub === 'prune') {
        const applyMode = parts[1] === '--apply';
        try {
          const inv = await getCacheInventory(settings.systemPath);
          const plan = computePruneCandidates(inv, settings.cachePolicy);

          if (!applyMode) {
            if (plan.candidates.length === 0) {
              ctx.ui?.notify(
                'IntelliJ prune preview: 0 workspaces eligible (retention: ' +
                  plan.retentionDays +
                  'd). All cached data is currently retained, active, or protected unknown.',
                'info',
              );
              return;
            }
            const candList = plan.candidates
              .map(
                (c) =>
                  c.hash.slice(0, 8) +
                  ' (' +
                  c.projectPath +
                  ', ' +
                  formatBytes(c.logicalBytes) +
                  ')',
              )
              .join(', ');
            ctx.ui?.notify(
              'IntelliJ prune preview: ' +
                plan.candidates.length +
                ' candidate(s) totaling ' +
                formatBytes(plan.candidateBytes) +
                ' eligible for pruning (retention: ' +
                plan.retentionDays +
                'd): ' +
                candList +
                '. To delete, run /intellij prune --apply.',
              'info',
            );
          } else {
            if (plan.candidates.length === 0) {
              ctx.ui?.notify('No cache candidates eligible for pruning.', 'info');
              return;
            }
            if (typeof ctx.ui?.confirm !== 'function') {
              ctx.ui?.notify('Prune apply cancelled: confirmation UI unavailable.', 'warning');
              return;
            }
            const summaryList = plan.candidates
              .map(
                (c) =>
                  c.hash.slice(0, 8) +
                  ' (' +
                  c.projectPath +
                  ', ' +
                  formatBytes(c.logicalBytes) +
                  ')',
              )
              .join(', ');
            const ok = await ctx.ui.confirm(
              'Prune ' +
                plan.candidates.length +
                ' workspace(s) (' +
                formatBytes(plan.candidateBytes) +
                ')? Candidates: ' +
                summaryList,
            );
            if (!ok) {
              ctx.ui?.notify('Prune cancelled by user.', 'info');
              return;
            }

            await withLifecycleLock(async () => {
              const liveServer = await isServerAlive(settings.systemPath);
              if (liveServer.alive) {
                ctx.ui?.notify(
                  'Cannot prune cache while shared IntelliJ server is running (PID ' +
                    liveServer.pid +
                    '). Stop server before pruning.',
                  'warning',
                );
                return;
              }
              const freshInv = await getCacheInventory(settings.systemPath);
              const freshPlan = computePruneCandidates(freshInv, settings.cachePolicy);

              const prevHashes = plan.candidates
                .map((c) => c.hash)
                .sort()
                .join(',');
              const freshHashes = freshPlan.candidates
                .map((c) => c.hash)
                .sort()
                .join(',');
              if (prevHashes !== freshHashes) {
                ctx.ui?.notify(
                  'Cache state changed during confirmation. Prune cancelled; please re-run /intellij prune to preview.',
                  'warning',
                );
                return;
              }

              const result = await applyPrune(freshPlan.candidates, settings.systemPath);
              ctx.ui?.notify(
                'IntelliJ cache pruned: deleted ' +
                  formatBytes(result.deletedLogicalBytes) +
                  ' logical (' +
                  formatBytes(result.freeSpaceDelta) +
                  ' OS free-space delta across ' +
                  result.pruned.length +
                  ' workspaces).',
                'info',
              );
            });
          }
        } catch (err: unknown) {
          ctx.ui?.notify('Prune failed: ' + getErrorMessage(err), 'warning');
        }
      } else if (sub === 'workspace') {
        const wsSub = (parts[1] || 'status').toLowerCase();
        if (wsSub === 'status') {
          try {
            const projectRoot = findProjectRootFn(ctx.cwd);
            const info = await wsApi.getWorkspaceInfo(projectRoot, {
              systemPath: activeSystemPath,
            });
            const projectState = await readProjectState(activeSystemPath, projectRoot);
            state = projectState;
            const jdkPart = info.savedJdk
              ? `${info.savedJdk}${info.savedVersion ? ` (Java ${info.savedVersion})` : ''} ${info.isApplied ? '[applied]' : '[saved, not applied - run /intellij workspace reload]'}`
              : info.appliedJdk
                ? `${info.appliedJdk} [applied runtime default]`
                : 'system default (none configured)';
            const typePart =
              info.projectType && info.projectType !== 'unknown' ? ` (${info.projectType})` : '';
            const statusParts = [
              `IntelliJ workspace: ${info.canonicalPath}${typePart}; JDK: ${jdkPart}`,
              `index: ${projectState.phase}${projectState.detail ? ` (${projectState.detail})` : ''}`,
            ];
            if (info.savedEnvKeys && info.savedEnvKeys.length > 0) {
              statusParts.push(
                `env: ${info.savedEnvKeys.length} configured (${info.savedEnvKeys.join(', ')})`,
              );
            }
            if (info.importStatus) {
              if (info.importStatus.status === 'failed') {
                statusParts.push(
                  `import: failed (${info.importStatus.stage || 'reload'}) - ${sanitizeString(info.importStatus.failure?.message || 'unknown error')}`,
                );
              } else if (info.importStatus.status === 'pending') {
                statusParts.push('import: saved, not applied - run /intellij workspace reload');
              } else if (info.importStatus.status === 'submitted') {
                statusParts.push('import: reload submitted');
              } else if (info.importStatus.status === 'applied') {
                statusParts.push(
                  'import: reload succeeded (model reloaded; build tool runtime effectiveness depends on daemon)',
                );
              }
            }
            const licPart = formatLicenseSummary(projectState.license);
            if (licPart) statusParts.push(licPart);
            const failPart = formatFailureSummary(projectState.failure, activeSystemPath);
            if (failPart) statusParts.push(failPart);
            if (isAuthDenied(projectState.license)) {
              statusParts.push(`recovery: ${LICENSE_RECOVERY_GUIDANCE}`);
            }
            ctx.ui?.notify(statusParts.join('; ') + '.', 'info');
          } catch (err: unknown) {
            ctx.ui?.notify('Failed to get workspace info: ' + getErrorMessage(err), 'warning');
          }
        } else if (wsSub === 'list') {
          try {
            const list = await wsApi.listWorkspaces({ systemPath: settings.systemPath });
            if (!list || list.length === 0) {
              ctx.ui?.notify('No configured IntelliJ workspaces found.', 'info');
              return;
            }
            const entries = list
              .map((w) => {
                const jdk = w.savedJdk
                  ? `${w.savedJdk} ${w.isApplied ? '[applied]' : '[pending]'}`
                  : w.appliedJdk
                    ? `${w.appliedJdk} [runtime]`
                    : 'default';
                const type =
                  w.projectType && w.projectType !== 'unknown' ? `${w.projectType}, ` : '';
                const envNote =
                  w.savedEnvKeys && w.savedEnvKeys.length > 0
                    ? `, env: ${w.savedEnvKeys.length} var(s)`
                    : '';
                return `${w.canonicalPath} (${type}JDK: ${jdk}${envNote})`;
              })
              .join('; ');
            ctx.ui?.notify(`IntelliJ workspaces (${list.length}): ${entries}`, 'info');
          } catch (err: unknown) {
            ctx.ui?.notify('Failed to list workspaces: ' + getErrorMessage(err), 'warning');
          }
        } else if (wsSub === 'jdks') {
          try {
            const projectRoot = findProjectRootFn(ctx.cwd);
            const candidates = await wsApi.discoverJdks(projectRoot, {
              systemPath: settings.systemPath,
            });
            if (!candidates || candidates.length === 0) {
              ctx.ui?.notify(
                'No installed JDKs discovered. You can specify a custom JDK path using /intellij workspace jdk <path>.',
                'warning',
              );
              return;
            }
            const items = candidates
              .map((c) => {
                const ver = c.version ? `v${c.version}` : 'JDK';
                const vendor = c.vendor ? ` (${c.vendor})` : '';
                return `${ver}${vendor}: ${c.javaHome}`.trim();
              })
              .join('; ');
            ctx.ui?.notify(`Discovered JDKs (${candidates.length}): ${items}`, 'info');
          } catch (err: unknown) {
            ctx.ui?.notify('Failed to discover JDKs: ' + getErrorMessage(err), 'warning');
          }
        } else if (wsSub === 'jdk') {
          const match = args.match(/^workspace\s+jdk(?:\s+([\s\S]+))?$/i);
          const rawPath = match ? match[1] : null;
          const explicitPath = rawPath ? parseJdkPath(rawPath) : '';
          let targetPath = explicitPath;

          if (!targetPath) {
            if (typeof ctx.ui?.select !== 'function') {
              ctx.ui?.notify(
                'No interactive UI available. Run /intellij workspace jdks to view candidates or specify path: /intellij workspace jdk <path>',
                'warning',
              );
              return;
            }
            const projectRoot = findProjectRootFn(ctx.cwd);
            let candidates: DiscoveredJdkItem[] = [];
            try {
              candidates = await wsApi.discoverJdks(projectRoot, {
                systemPath: settings.systemPath,
              });
            } catch (err: unknown) {
              ctx.ui.notify('Failed to discover JDKs: ' + getErrorMessage(err), 'warning');
              return;
            }
            if (!candidates || candidates.length === 0) {
              ctx.ui.notify(
                'No installed JDKs discovered. Specify a custom JDK path: /intellij workspace jdk <path>',
                'warning',
              );
              return;
            }
            const items = candidates.map((c) => ({
              label: `${c.version ? `Java ${c.version}` : 'JDK'}${c.vendor ? ` (${c.vendor})` : ''} - ${c.javaHome}`,
              value: c.javaHome,
              description: c.javaHome,
            }));
            const selected = await ctx.ui.select('Select JDK for workspace:', items);
            if (!selected) {
              ctx.ui.notify('JDK selection cancelled.', 'info');
              return;
            }
            targetPath =
              typeof selected === 'object' && selected !== null && 'value' in selected
                ? selected.value
                : String(selected);
          }

          const projectRoot = findProjectRootFn(ctx.cwd);
          let saved: { javaHome?: string } | undefined;
          try {
            saved = await wsApi.setWorkspaceJdk(projectRoot, targetPath, {
              systemPath: settings.systemPath,
            });
          } catch (err: unknown) {
            ctx.ui?.notify('Failed to save workspace JDK: ' + getErrorMessage(err), 'warning');
            return;
          }

          try {
            const reimport = await wsApi.reimportWorkspace(projectRoot, {
              systemPath: settings.systemPath,
            });
            const timeNote =
              reimport?.elapsedMs !== undefined ? ' (' + reimport.elapsedMs + 'ms)' : '';
            ctx.ui?.notify(
              'Workspace JDK saved and applied: ' +
                (saved?.javaHome || targetPath) +
                timeNote +
                '.',
              'info',
            );
          } catch (err: unknown) {
            const msg = getErrorMessage(err);
            if (isTimeoutError(err)) {
              ctx.ui?.notify(
                'Workspace JDK saved (' +
                  (saved?.javaHome || targetPath) +
                  '), but reimport timed out: ' +
                  msg +
                  '. Settings are saved but not yet fully applied.',
                'warning',
              );
            } else {
              ctx.ui?.notify(
                'Workspace JDK saved (' +
                  (saved?.javaHome || targetPath) +
                  '), but reimport failed: ' +
                  msg +
                  '. Settings are saved but not applied to active session.',
                'warning',
              );
            }
          }
        } else if (wsSub === 'reload') {
          const projectRoot = findProjectRootFn(ctx.cwd);
          try {
            const reimport = await wsApi.reimportWorkspace(projectRoot, {
              systemPath: settings.systemPath,
            });
            const timeNote =
              reimport?.elapsedMs !== undefined ? ' (' + reimport.elapsedMs + 'ms)' : '';
            ctx.ui?.notify(
              'Workspace reimported successfully: index ready' + timeNote + '.',
              'info',
            );
          } catch (err: unknown) {
            const msg = getErrorMessage(err);
            if (isTimeoutError(err)) {
              ctx.ui?.notify('Workspace reimport timed out: ' + msg + '.', 'warning');
            } else {
              ctx.ui?.notify('Workspace reimport failed: ' + msg + '.', 'warning');
            }
          }
        } else if (wsSub === 'env') {
          const action = (parts[2] || 'view').toLowerCase();
          const projectRoot = findProjectRootFn(ctx.cwd);

          if (action === 'view') {
            try {
              const info = await wsApi.getWorkspaceInfo(projectRoot, {
                systemPath: activeSystemPath,
              });
              if (!info.savedEnvKeys || info.savedEnvKeys.length === 0) {
                ctx.ui?.notify(
                  `IntelliJ workspace: ${info.canonicalPath}; no custom environment variables configured.`,
                  'info',
                );
                return;
              }
              const entries = info.savedEnvKeys
                .map((k) => `${k}=${info.maskedEnv?.[k] ?? '***'}`)
                .join(', ');
              ctx.ui?.notify(
                `IntelliJ workspace: ${info.canonicalPath}; env (${info.savedEnvKeys.length}): ${entries}. (Note: configured JDK java-home takes precedence over env.JAVA_HOME).`,
                'info',
              );
            } catch (err: unknown) {
              ctx.ui?.notify('Failed to get workspace env: ' + getErrorMessage(err), 'warning');
            }
          } else if (action === 'set') {
            const match = args.match(
              /^workspace\s+env\s+set(?:\s+("[^"]+"|'[^']+'|[^\s]+))?(?:\s+([\s\S]+))?$/i,
            );
            const rawName = match ? match[1] : null;
            const name = rawName ? parseJdkPath(rawName).trim() : '';
            const rawValue = match ? match[2] : null;
            const value =
              rawValue !== null && rawValue !== undefined ? parseJdkPath(rawValue) : null;

            if (!name || value === null) {
              ctx.ui?.notify('Usage: /intellij workspace env set <NAME> <VALUE>', 'warning');
              return;
            }
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
              ctx.ui?.notify(
                `Invalid environment variable name "${name}". Variable names must be valid alphanumeric identifiers (e.g. HTTP_PROXY).`,
                'warning',
              );
              return;
            }

            try {
              await wsApi.setWorkspaceEnvVar(projectRoot, name, value, {
                systemPath: activeSystemPath,
              });
            } catch (err: unknown) {
              ctx.ui?.notify(
                'Failed to save workspace environment variable: ' + getErrorMessage(err),
                'warning',
              );
              return;
            }

            const precedenceNote =
              name === 'JAVA_HOME'
                ? ' (Note: configured workspace JDK takes precedence over env.JAVA_HOME)'
                : '';

            try {
              const reimport = await wsApi.reimportWorkspace(projectRoot, {
                systemPath: activeSystemPath,
              });
              const timeNote =
                reimport?.elapsedMs !== undefined ? ' (' + reimport.elapsedMs + 'ms)' : '';
              ctx.ui?.notify(
                `Workspace environment variable ${name} saved and reload submitted: index ready${timeNote}.${precedenceNote}`,
                'info',
              );
            } catch (err: unknown) {
              const rawMsg = getErrorMessage(err);
              const msg = sanitizeString(
                typeof wsApi.maskConfiguredSecrets === 'function'
                  ? wsApi.maskConfiguredSecrets(rawMsg, { [name]: value })
                  : rawMsg,
              );
              if (isTimeoutError(err)) {
                ctx.ui?.notify(
                  `Workspace environment variable ${name} saved, but reimport timed out: ${msg}. Settings are saved but not yet fully applied.`,
                  'warning',
                );
              } else {
                ctx.ui?.notify(
                  `Workspace environment variable ${name} saved, but reimport failed: ${msg}. Settings are saved but not applied to active session.`,
                  'warning',
                );
              }
            }
          } else if (action === 'unset') {
            const match = args.match(/^workspace\s+env\s+unset(?:\s+([\s\S]+))?$/i);
            const rawName = match ? match[1] : null;
            const name = rawName ? parseJdkPath(rawName).trim() : '';

            if (!name) {
              ctx.ui?.notify('Usage: /intellij workspace env unset <NAME>', 'warning');
              return;
            }

            let unsetResult: { wasSet?: boolean } | undefined;
            try {
              unsetResult = await wsApi.unsetWorkspaceEnvVar(projectRoot, name, {
                systemPath: activeSystemPath,
              });
            } catch (err: unknown) {
              ctx.ui?.notify(
                'Failed to unset workspace environment variable: ' + getErrorMessage(err),
                'warning',
              );
              return;
            }

            if (!unsetResult?.wasSet) {
              ctx.ui?.notify(
                `Environment variable "${name}" is not set in workspace configuration.`,
                'info',
              );
              return;
            }

            try {
              const reimport = await wsApi.reimportWorkspace(projectRoot, {
                systemPath: activeSystemPath,
              });
              const timeNote =
                reimport?.elapsedMs !== undefined ? ' (' + reimport.elapsedMs + 'ms)' : '';
              ctx.ui?.notify(
                `Workspace environment variable ${name} unset and reload submitted: index ready${timeNote}.`,
                'info',
              );
            } catch (err: unknown) {
              const rawMsg = getErrorMessage(err);
              const msg = sanitizeString(
                typeof wsApi.maskConfiguredSecrets === 'function'
                  ? wsApi.maskConfiguredSecrets(rawMsg, { [name]: '' })
                  : rawMsg,
              );
              if (isTimeoutError(err)) {
                ctx.ui?.notify(
                  `Workspace environment variable ${name} unset, but reimport timed out: ${msg}. Settings are saved but not yet fully applied.`,
                  'warning',
                );
              } else {
                ctx.ui?.notify(
                  `Workspace environment variable ${name} unset, but reimport failed: ${msg}. Settings are saved but not applied to active session.`,
                  'warning',
                );
              }
            }
          } else {
            ctx.ui?.notify(
              'Usage: /intellij workspace env [view|set <NAME> <VALUE>|unset <NAME>]',
              'warning',
            );
          }
        } else {
          ctx.ui?.notify(
            'Usage: /intellij workspace [status|list|jdks|jdk [path]|env [view|set|unset]|reload]',
            'warning',
          );
        }
      } else if (sub === 'debug') {
        const debugSub = (parts[1] || 'status').toLowerCase();
        const targetId = parts[2];
        const projectRoot = findProjectRootFn(ctx.cwd);

        if (debugSub === 'status') {
          const sessions = await debugApi.listDebugSessions({
            systemPath: activeSystemPath,
            projectRoot,
          });
          if (sessions.length === 0) {
            ctx.ui?.notify('No active IntelliJ debug session found for current project.', 'info');
            return;
          }
          const formatted = sessions
            .map((s) => `[${s.id.slice(0, 8)}] PID ${s.pid}: ${s.detail}`)
            .join('; ');
          const level = sessions.some((s) => s.live) ? 'info' : 'warning';
          ctx.ui?.notify(
            `IntelliJ debug (${sessions.length} session${sessions.length > 1 ? 's' : ''}): ${formatted}`,
            level,
          );
        } else if (debugSub === 'recover') {
          try {
            const snap = await debugApi.recoverDebugSession({
              systemPath: activeSystemPath,
              projectRoot,
              id: targetId,
            });
            ctx.ui?.notify(
              `IntelliJ debug session recovered (${snap.mode}: ${snap.phase}; pending requests: ${snap.pendingRequests}).`,
              'info',
            );
          } catch (err: unknown) {
            ctx.ui?.notify(`IntelliJ debug recover: ${getErrorMessage(err)}`, 'warning');
          }
        } else {
          ctx.ui?.notify('Usage: /intellij debug [status|recover [id]]', 'warning');
        }
      } else if (sub === 'eula') {
        const eulaSub = (parts[1] || 'status').toLowerCase();
        const rawHash = parts[2] ? parts[2].trim() : '';

        if (eulaSub === 'status') {
          const resolved = await resolveSelectedExecutable();
          if (resolved.error || !resolved.executable) {
            ctx.ui?.notify(
              resolved.error ||
                'Managed IntelliJ server is not installed. Run /intellij install to install it first.',
              'warning',
            );
            return;
          }
          try {
            const doc = await readServerEula(resolved.executable);
            const acceptance = await readEulaAcceptance(configOptions);
            const isAccepted = acceptance.acceptedHashes.includes(doc.hash);
            const statusLabel = isAccepted ? 'accepted' : 'not accepted';
            const actionPrompt = isAccepted
              ? ''
              : ` Run /intellij eula accept ${doc.hash} to accept.`;
            ctx.ui?.notify(
              `IntelliJ EULA: ${statusLabel}; hash: ${doc.hash}; path: ${doc.path}.${actionPrompt}`,
              'info',
            );
          } catch (err: unknown) {
            ctx.ui?.notify(`Failed to read IntelliJ EULA: ${getErrorMessage(err)}`, 'warning');
          }
        } else if (eulaSub === 'view') {
          const resolved = await resolveSelectedExecutable();
          if (resolved.error || !resolved.executable) {
            ctx.ui?.notify(
              resolved.error ||
                'Managed IntelliJ server is not installed. Run /intellij install to install it first.',
              'warning',
            );
            return;
          }
          try {
            const doc = await readServerEula(resolved.executable);
            ctx.ui?.notify(
              `IntelliJ EULA (hash: ${doc.hash}, path: ${doc.path}):\n\n${doc.text}`,
              'info',
            );
          } catch (err: unknown) {
            ctx.ui?.notify(`Failed to read IntelliJ EULA: ${getErrorMessage(err)}`, 'warning');
          }
        } else if (eulaSub === 'accept') {
          const hashCandidate = rawHash;
          if (!/^[0-9a-f]{16}$/.test(hashCandidate)) {
            ctx.ui?.notify(
              'Usage: /intellij eula accept <16-character lowercase hex hash>',
              'warning',
            );
            return;
          }
          const resolved = await resolveSelectedExecutable();
          if (resolved.error || !resolved.executable) {
            ctx.ui?.notify(
              resolved.error ||
                'Managed IntelliJ server is not installed. Run /intellij install to install it first.',
              'warning',
            );
            return;
          }
          let doc: EulaDocument;
          try {
            doc = await readServerEula(resolved.executable);
          } catch (err: unknown) {
            ctx.ui?.notify(`Failed to read IntelliJ EULA: ${getErrorMessage(err)}`, 'warning');
            return;
          }
          if (doc.hash !== hashCandidate) {
            ctx.ui?.notify(
              `EULA hash mismatch: requested ${hashCandidate}, but current EULA hash is ${doc.hash} (${doc.path}).`,
              'warning',
            );
            return;
          }
          if (typeof ctx.ui?.confirm !== 'function') {
            ctx.ui?.notify(
              'EULA acceptance cancelled: interactive confirmation UI unavailable.',
              'warning',
            );
            return;
          }
          const ok = await ctx.ui.confirm(
            `Accept IntelliJ Language Server EULA?\nPath: ${doc.path}\nHash: ${doc.hash}\nBy accepting, you agree to JetBrains EULA terms.`,
          );
          if (!ok) {
            ctx.ui?.notify('EULA acceptance cancelled by user.', 'info');
            return;
          }
          try {
            await withLifecycleLock(
              async () => {
                const freshResolved = await resolveSelectedExecutable();
                if (freshResolved.error || !freshResolved.executable) {
                  ctx.ui?.notify(
                    `EULA acceptance cancelled: ${freshResolved.error || 'server executable unavailable.'}`,
                    'warning',
                  );
                  return;
                }
                const freshDoc = await readServerEula(freshResolved.executable);
                if (freshDoc.hash !== hashCandidate || freshDoc.path !== doc.path) {
                  ctx.ui?.notify(
                    `EULA document changed during confirmation (current hash: ${freshDoc.hash}). Acceptance cancelled; please review the updated EULA.`,
                    'warning',
                  );
                  return;
                }
                await acceptServerEula(freshDoc, configOptions);
                ctx.ui?.notify(
                  `IntelliJ EULA accepted: hash ${freshDoc.hash} at ${freshDoc.path}.`,
                  'info',
                );
              },
              { systemPath: activeSystemPath },
            );
          } catch (err: unknown) {
            ctx.ui?.notify(`Failed to accept IntelliJ EULA: ${getErrorMessage(err)}`, 'warning');
          }
        } else {
          ctx.ui?.notify('Usage: /intellij eula [status|view|accept <16-lowerhex>]', 'warning');
        }
      } else {
        ctx.ui?.notify(
          'Usage: /intellij [status|start|stop|restart|doctor|install [--version <build|latest>] [--dir <path>]|versions [--remote]|use <version>|cache|prune [--apply]|eula [status|view|accept <hash>]|workspace [status|list|jdks|jdk [path]|reload|env [set <NAME> <value>|unset <NAME>]]|debug [status|recover [id]]]',
          'warning',
        );
      }
    },
  });

  pi.on?.('session_start', (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.agent?.kind === 'sub') return;
    const projectRoot = findProjectRootFn(ctx.cwd);
    const markers = [
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'settings.gradle.kts',
      '.idea',
    ];
    if (!markers.some((marker) => existsSync(join(projectRoot, marker)))) return;
    recordConnection(settings.systemPath, projectRoot, Date.now()).catch(() => {});
    startObserver(ctx);
  });

  pi.on?.('session_shutdown', () => {
    disposed = true;
    generation++;
    stopObserver?.();
    stopObserver = null;
    activeInstallState = null;
    clearStatus(activeCtx);
  });
}
