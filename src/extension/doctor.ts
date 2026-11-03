import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ProjectStateResult, readProjectState } from '../project/connection-state.js';
import { canonicalizeProject } from '../project/metadata.js';
import {
  getWorkspaceConfigDir,
  getWorkspaceInfo,
  maskConfiguredSecrets,
  validateJdk,
} from '../project/workspace.js';
import { DEFAULT_SERVER_VERSION } from '../server/bundles.js';
import { readServerConfig, type ServerConfiguration, serverConfigFile } from '../server/config.js';
import { readEulaAcceptance, readServerEula } from '../server/eula.js';
import { findInstalled } from '../server/install.js';
import {
  endpoint,
  type ServerOwnershipVerification,
  settings,
  status,
  verifyServerOwnership,
} from '../server/service.js';
import { sanitizeString } from '../shared/runtime-status.js';

export type DoctorSeverity = 'ok' | 'warning' | 'error' | 'unknown';

export interface DoctorCheck {
  id: string;
  name: string;
  severity: DoctorSeverity;
  message: string;
  detail?: string;
}

export interface DoctorSummary {
  ok: boolean;
  counts: {
    ok: number;
    warning: number;
    error: number;
    unknown: number;
  };
}

export interface DoctorReport {
  pluginVersion: string;
  project?: string;
  systemPath: string;
  configPath: string;
  selectedVersion?: string;
  executable?: string;
  logPaths: string[];
  checks: DoctorCheck[];
  summary: DoctorSummary;
}

export interface DoctorOptions {
  systemPath?: string;
  configFile?: string;
  configDir?: string;
  fallbackExecutable?: string;
}

const CHECK_NAMES: Record<string, string> = {
  plugin: 'OMP IntelliJ Plugin',
  config: 'Server Configuration',
  install: 'Server Installation',
  eula: 'JetBrains EULA',
  server: 'Shared Server',
  'project-state': 'Project State',
  'project-failure': 'Project Failure',
  'workspace-jdk': 'Workspace JDK',
  license: 'License',
  import: 'Workspace Import',
  logs: 'Log Files',
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return String(error);
}

async function resolvePluginVersion(): Promise<string> {
  try {
    let currentDir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 5; depth++) {
      const candidate = join(currentDir, 'package.json');
      if (existsSync(candidate)) {
        const raw: unknown = JSON.parse(await readFile(candidate, 'utf8'));
        if (
          raw &&
          typeof raw === 'object' &&
          'name' in raw &&
          raw.name === 'omp-intellij' &&
          'version' in raw &&
          typeof raw.version === 'string' &&
          raw.version.trim()
        ) {
          return raw.version.trim();
        }
      }
      const parent = dirname(currentDir);
      if (parent === currentDir) break;
      currentDir = parent;
    }
  } catch {}
  return 'unknown';
}

export async function inspectDoctor(
  projectRoot?: string,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const pluginVersion = await resolvePluginVersion();
  const configPath = serverConfigFile({ configFile: options.configFile });
  const systemPath = resolve(options.systemPath ?? settings.systemPath);

  let canonicalProjectRoot: string | undefined;
  let rawEnv: Record<string, string> | undefined;

  const checks: DoctorCheck[] = [];
  function mask(text: string): string {
    let res = sanitizeString(text);
    if (rawEnv) {
      res = maskConfiguredSecrets(res, rawEnv);
    }
    return res;
  }

  function add(id: string, severity: DoctorSeverity, message: string, detail?: string): void {
    checks.push({
      id,
      name: CHECK_NAMES[id] ?? id,
      severity,
      message: mask(message),
      detail: detail ? mask(detail) : undefined,
    });
  }

  if (projectRoot && typeof projectRoot === 'string' && projectRoot.trim()) {
    try {
      canonicalProjectRoot = canonicalizeProject(projectRoot.trim()).nativePath;
    } catch {
      canonicalProjectRoot = projectRoot.trim();
    }

    try {
      const { id } = canonicalizeProject(canonicalProjectRoot);
      const targetDir = getWorkspaceConfigDir({ configDir: options.configDir });
      const cfgFile = join(targetDir, `${id}.json`);
      if (existsSync(cfgFile)) {
        const raw: unknown = JSON.parse(await readFile(cfgFile, 'utf8'));
        if (
          raw &&
          typeof raw === 'object' &&
          'env' in raw &&
          raw.env &&
          typeof raw.env === 'object' &&
          !Array.isArray(raw.env)
        ) {
          rawEnv = raw.env as Record<string, string>;
        }
      }
    } catch (err: unknown) {
      if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')) {
        add('config', 'error', `Failed to read workspace configuration: ${getErrorMessage(err)}`);
      }
    }
  }

  let selectedVersion: string | undefined;
  let executable: string | undefined;

  // Plugin check
  add(
    'plugin',
    pluginVersion !== 'unknown' ? 'ok' : 'warning',
    pluginVersion !== 'unknown'
      ? `Plugin version ${pluginVersion}`
      : 'Plugin version could not be determined from package.json',
  );

  // Configuration check
  let serverConfig: ServerConfiguration | null = null;
  try {
    serverConfig = await readServerConfig(options.fallbackExecutable ?? settings.executable, {
      configFile: options.configFile,
    });
    if (serverConfig.mode === 'managed') {
      selectedVersion = serverConfig.version ?? DEFAULT_SERVER_VERSION;
      const pinnedNote = serverConfig.version ? ' [pinned]' : ' [default]';
      add(
        'config',
        'ok',
        `Managed server (installDir: ${serverConfig.installDir}, version: ${selectedVersion}${pinnedNote})`,
        `Configuration file: ${configPath}`,
      );
    } else {
      executable = serverConfig.executable;
      add(
        'config',
        'ok',
        `External server (executable: ${serverConfig.executable})`,
        `Configuration file: ${configPath}`,
      );
    }
  } catch (err: unknown) {
    add(
      'config',
      'error',
      `Invalid server configuration: ${getErrorMessage(err)}`,
      `Configuration file: ${configPath}`,
    );
  }

  // Installation check
  if (!serverConfig) {
    add('install', 'unknown', 'Cannot verify installation due to invalid configuration');
  } else if (serverConfig.mode === 'managed') {
    const targetVersion = selectedVersion ?? DEFAULT_SERVER_VERSION;
    try {
      const installed = await findInstalled(serverConfig.installDir, { version: targetVersion });
      if (installed?.executable && existsSync(installed.executable)) {
        executable = installed.executable;
        add(
          'install',
          'ok',
          `Server ${targetVersion} is installed at ${installed.installDir}`,
          `Executable: ${installed.executable}`,
        );
      } else {
        add(
          'install',
          'error',
          `Server ${targetVersion} is not installed at "${serverConfig.installDir}". Run /intellij install to install.`,
        );
      }
    } catch (err: unknown) {
      add('install', 'error', `Failed to check installation: ${getErrorMessage(err)}`);
    }
  } else {
    try {
      const s = await stat(serverConfig.executable);
      if (s.isFile()) {
        executable = serverConfig.executable;
        add('install', 'ok', `External server executable exists at ${serverConfig.executable}`);
      } else {
        add('install', 'error', `External server path is not a file: "${serverConfig.executable}"`);
      }
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err.code === 'ENOENT' || err.code === 'ENOTDIR')
      ) {
        add(
          'install',
          'error',
          `External server executable not found at "${serverConfig.executable}"`,
        );
      } else {
        add(
          'install',
          'error',
          `Cannot access external server executable: ${getErrorMessage(err)}`,
        );
      }
    }
  }

  // JetBrains EULA check
  if (executable && existsSync(executable)) {
    try {
      const doc = await readServerEula(executable);
      const acceptance = await readEulaAcceptance({ configFile: options.configFile });
      if (acceptance.acceptedHashes.includes(doc.hash)) {
        add('eula', 'ok', `JetBrains EULA accepted (hash: ${doc.hash})`, `EULA file: ${doc.path}`);
      } else {
        add(
          'eula',
          'warning',
          `JetBrains EULA is not accepted (current hash: ${doc.hash}). Run /intellij eula accept ${doc.hash} to accept.`,
          `EULA file: ${doc.path}`,
        );
      }
    } catch (err: unknown) {
      add('eula', 'error', `EULA document unavailable: ${getErrorMessage(err)}`);
    }
  } else {
    add('eula', 'unknown', 'EULA check skipped: server executable is not available');
  }

  // Server reachability & ownership check
  let isRunning = false;
  let activeEndpoint: { host: string; port: number } | undefined;
  try {
    isRunning = await status(systemPath);
    if (isRunning) activeEndpoint = await endpoint(systemPath);
  } catch {
    isRunning = false;
  }

  let ownership: ServerOwnershipVerification;
  try {
    ownership = await verifyServerOwnership(systemPath);
  } catch (err: unknown) {
    ownership = { status: 'running-unverified', pid: null, reason: getErrorMessage(err) };
  }

  if (isRunning) {
    if (ownership.status === 'running-owned') {
      add(
        'server',
        'ok',
        `Server is running at ${activeEndpoint?.host}:${activeEndpoint?.port} (PID ${ownership.pid}, owned)`,
      );
    } else {
      add(
        'server',
        'warning',
        `Server is listening at ${activeEndpoint?.host}:${activeEndpoint?.port} but unverified: ${ownership.reason ?? ownership.status}`,
        ownership.pid ? `PID: ${ownership.pid}` : undefined,
      );
    }
  } else if (ownership.status === 'not-found') {
    add('server', 'ok', 'Server is stopped (offline)');
  } else if (ownership.status === 'dead') {
    add('server', 'ok', `Server is stopped (stale PID ${ownership.pid} is dead)`);
  } else if (ownership.status === 'running-unverified') {
    add(
      'server',
      'warning',
      `Server is offline but owner record is unverified: ${ownership.reason ?? 'unverified'}`,
      ownership.pid ? `PID: ${ownership.pid}` : undefined,
    );
  } else {
    add(
      'server',
      'warning',
      `Owned process ${ownership.pid} is alive but its endpoint is unreachable`,
    );
  }

  // Project state check
  let projectState: ProjectStateResult | null = null;
  if (canonicalProjectRoot) {
    try {
      projectState = await readProjectState(systemPath, canonicalProjectRoot);
      const detailNote = projectState.detail ? ` (${projectState.detail})` : '';
      if (projectState.phase === 'ready') {
        add('project-state', 'ok', `Project index is ready${detailNote}`);
      } else if (projectState.phase === 'indexing') {
        add('project-state', 'ok', `Project indexing in progress${detailNote}`);
      } else if (projectState.phase === 'not-started') {
        add(
          'project-state',
          'ok',
          `Project index: not started (${projectState.detail || 'offline'})`,
        );
      } else {
        add('project-state', 'warning', `Project index phase: ${projectState.phase}${detailNote}`);
      }
      const license = projectState.license;
      const denied =
        license?.status === 'needs-activation' ||
        license?.status === 'expired' ||
        license?.featuresDeclined === true;
      add(
        'license',
        denied ? 'error' : license?.status === 'valid' ? 'ok' : 'unknown',
        `License status: ${license?.status ?? 'unknown'}`,
        denied
          ? 'Restore authorization in a supported JetBrains client, then reconnect.'
          : undefined,
      );

      if (projectState.failure) {
        add(
          'project-failure',
          'error',
          `Project error during ${projectState.failure.stage}: ${projectState.failure.message}`,
        );
      }
    } catch (err: unknown) {
      add('project-state', 'warning', `Failed to inspect project state: ${getErrorMessage(err)}`);
    }
  }

  // Workspace JDK check
  if (canonicalProjectRoot) {
    try {
      const wsInfo = await getWorkspaceInfo(canonicalProjectRoot, {
        systemPath,
        configDir: options.configDir,
      });
      if (wsInfo.importStatus) {
        const imported = wsInfo.importStatus;
        add(
          'import',
          imported.status === 'failed' ? 'error' : imported.status === 'applied' ? 'ok' : 'unknown',
          `Import status: ${imported.status}${imported.stage ? ` (${imported.stage})` : ''}`,
          imported.failure?.message,
        );
      }
      if (wsInfo.savedJdk) {
        try {
          const validated = validateJdk(wsInfo.savedJdk);
          const importDetail = wsInfo.importStatus
            ? `, Import: ${wsInfo.importStatus.status}${wsInfo.importStatus.stage ? ` (${wsInfo.importStatus.stage})` : ''}`
            : '';
          add(
            'workspace-jdk',
            'ok',
            `Configured JDK: ${validated.javaHome} (Java ${validated.javaVersion}) ${wsInfo.isApplied ? '[applied]' : '[saved]'}`,
            `Project type: ${wsInfo.projectType}${importDetail}`,
          );
        } catch (jdkErr: unknown) {
          add(
            'workspace-jdk',
            'error',
            `Configured JDK is invalid: ${getErrorMessage(jdkErr)}`,
            `Configured path: "${wsInfo.savedJdk}"`,
          );
        }
      } else {
        add(
          'workspace-jdk',
          'unknown',
          'Workspace JDK is not configured (IntelliJ project model default; runtime JDK unknown until server imports project)',
          `Project type: ${wsInfo.projectType}`,
        );
      }
    } catch (err: unknown) {
      add('workspace-jdk', 'warning', `Failed to inspect workspace: ${getErrorMessage(err)}`);
    }
  }

  // Log files check
  const logCandidates = [
    join(systemPath, 'launcher.log'),
    join(systemPath, 'log', 'idea.log'),
    ...(projectState?.failure?.logPath ? [projectState.failure.logPath] : []),
  ];
  const logPaths: string[] = [];
  const seenLogs = new Set<string>();
  for (const cand of logCandidates) {
    if (typeof cand === 'string' && cand.trim()) {
      const norm = resolve(cand);
      if (!seenLogs.has(norm) && existsSync(norm)) {
        seenLogs.add(norm);
        logPaths.push(norm);
      }
    }
  }

  add(
    'logs',
    'ok',
    logPaths.length > 0 ? `Found ${logPaths.length} log file(s)` : 'No log files found on disk',
    logPaths.length > 0 ? logPaths.join(', ') : `Checked: ${join(systemPath, 'launcher.log')}`,
  );

  const counts = {
    ok: checks.filter((c) => c.severity === 'ok').length,
    warning: checks.filter((c) => c.severity === 'warning').length,
    error: checks.filter((c) => c.severity === 'error').length,
    unknown: checks.filter((c) => c.severity === 'unknown').length,
  };

  return {
    pluginVersion,
    project: canonicalProjectRoot ? mask(canonicalProjectRoot) : undefined,
    systemPath: mask(systemPath),
    configPath: mask(configPath),
    selectedVersion,
    executable: executable ? mask(executable) : undefined,
    logPaths: logPaths.map(mask),
    checks,
    summary: {
      ok: counts.error === 0,
      counts,
    },
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('IntelliJ Doctor Report');
  lines.push(`Plugin version: ${report.pluginVersion}`);
  if (report.project) lines.push(`Project: ${report.project}`);
  lines.push(`System path: ${report.systemPath}`);
  lines.push(`Config path: ${report.configPath}`);
  if (report.selectedVersion) lines.push(`Selected version: ${report.selectedVersion}`);
  if (report.executable) lines.push(`Executable: ${report.executable}`);
  if (report.logPaths.length > 0) lines.push(`Logs: ${report.logPaths.join(', ')}`);

  lines.push('');
  lines.push('Checks:');
  for (const check of report.checks) {
    const badge = check.severity.toUpperCase().padEnd(7);
    lines.push(`  [${badge}] ${check.name}: ${check.message}`);
    if (check.detail) lines.push(`            ${check.detail}`);
  }

  lines.push('');
  const { counts } = report.summary;
  const statusLabel = report.summary.ok
    ? counts.warning > 0 || counts.unknown > 0
      ? 'NO ERRORS (review warnings and unknown checks)'
      : 'NO ERRORS'
    : 'FAILED';
  lines.push(
    `Summary: ${statusLabel} (${report.checks.length} checks: ${counts.ok} ok, ${counts.warning} warning, ${counts.error} error, ${counts.unknown} unknown)`,
  );

  return lines.join('\n');
}
