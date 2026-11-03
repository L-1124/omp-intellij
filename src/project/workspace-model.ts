import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type CreateLspSessionOptions,
  createLspSession,
  type LspSession,
  resolveBuildCommand,
  resolveLaunch,
  toLspFileUri,
} from '../debug/run-core.js';
import { sanitizeStatus, sanitizeString } from '../shared/runtime-status.js';
import { canonicalizeProject } from './metadata.js';
import { findProjectRoot } from './readiness.js';
import { getWorkspaceConfigDir, maskConfiguredSecrets, validateEnvMap } from './workspace.js';

export interface WorkspaceModelReport {
  project: string;
  file: string;
  javaExec: string;
  moduleName?: string;
  moduleContentPaths?: string[];
  moduleSourceRoots?: Array<{ path: string; type?: string }>;
  classpath?: string[];
  modulePath?: string[];
  workingDirectory?: string;
  sdks?: Array<{ name: string; type?: string; version?: string; homePath?: string }>;
  libraryCount?: number;
  buildTool?: string;
  buildCwd?: string;
  buildCommand?: string[];
  supported: boolean;
  reason?: string;
}

export interface InspectWorkspaceModelOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  systemPath?: string;
  configDir?: string;
  socket?: Socket;
  createSession?: (projectRoot: string, options?: CreateLspSessionOptions) => Promise<LspSession>;
  homeDir?: string;
}

export function isPathContained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false;
  }
  return true;
}

export function validateSourceFile(
  file: string,
  projectRoot?: string,
): { resolvedFile: string; resolvedProject: string } {
  if (!file || typeof file !== 'string' || !file.trim()) {
    throw new Error('A source file path is required');
  }

  const resolvedFile = resolve(file.trim());
  if (!existsSync(resolvedFile)) {
    throw new Error(`Source file not found: ${resolvedFile}`);
  }

  const fileStat = statSync(resolvedFile);
  if (!fileStat.isFile()) {
    throw new Error(`Source file must be a regular file: ${resolvedFile}`);
  }

  if (!/\.(java|kt|kts)$/i.test(resolvedFile)) {
    throw new Error(`Source file must be a .java, .kt, or .kts file: ${resolvedFile}`);
  }

  const realFile = realpathSync(resolvedFile);

  let resolvedProject: string;
  if (projectRoot?.trim()) {
    resolvedProject = resolve(projectRoot.trim());
    if (!existsSync(resolvedProject)) {
      throw new Error(`Project root not found: ${resolvedProject}`);
    }
  } else {
    resolvedProject = findProjectRoot(realFile);
  }

  const realProj = realpathSync(resolvedProject);
  if (!isPathContained(realProj, realFile)) {
    throw new Error(`Source file "${resolvedFile}" is outside project root "${resolvedProject}"`);
  }

  return { resolvedFile, resolvedProject };
}

export async function loadConfiguredEnv(
  configDir: string | undefined,
  projectId: string,
): Promise<Record<string, string> | null> {
  const targetDir = getWorkspaceConfigDir({ configDir });
  const configPath = join(targetDir, `${projectId}.json`);
  let content: string;
  try {
    content = await readFile(configPath, 'utf8');
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new Error(`Invalid workspace configuration at ${configPath}`, { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid workspace configuration at ${configPath}`);
  }
  return 'env' in parsed ? validateEnvMap(parsed.env) : null;
}

export function maskAndSanitize(text: string, env: Record<string, string> | null): string {
  return sanitizeString(maskConfiguredSecrets(text, env));
}

const errorEnvironments = new WeakMap<object, Record<string, string> | null>();

export function serializeWorkspaceModelError(
  err: unknown,
  configuredEnv?: Record<string, string> | null,
): unknown {
  const env =
    configuredEnv ?? (err && typeof err === 'object' ? errorEnvironments.get(err) : null) ?? null;
  const safe = sanitizeStatus(err);
  const text = JSON.stringify(safe, (_key, value: unknown) =>
    typeof value === 'string' ? maskAndSanitize(value, env) : value,
  );
  return text === undefined ? null : JSON.parse(text);
}
export async function resolveMavenRepository(homeDir = homedir()): Promise<string> {
  const settingsPath = join(homeDir, '.m2', 'settings.xml');
  try {
    const raw = await readFile(settingsPath, 'utf8');
    const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, '');
    const match = withoutComments.match(/<localRepository>\s*([\s\S]*?)\s*<\/localRepository>/);
    const repo = match?.[1]?.trim();
    if (repo) {
      return resolve(repo.replace(/\$\{user\.home\}/g, () => homeDir));
    }
  } catch {}
  return join(homeDir, '.m2', 'repository');
}

export function expandWorkspacePath(
  rawPath: string,
  homeDir: string,
  mavenRepoDir: string,
): string {
  let expanded = rawPath;
  if (expanded.startsWith('<MAVEN_REPO>')) {
    expanded = `${mavenRepoDir}${expanded.slice('<MAVEN_REPO>'.length)}`;
  } else if (expanded.startsWith('<HOME>')) {
    expanded = `${homeDir}${expanded.slice('<HOME>'.length)}`;
  }
  if (isAbsolute(expanded) || /^[a-zA-Z]:[\\/]/.test(expanded) || expanded.startsWith('/')) {
    return resolve(expanded);
  }
  return expanded;
}

export function sessionSupportsCommand(session: LspSession, command: string): boolean {
  const caps = session.serverCapabilities;
  if (!caps || typeof caps !== 'object') return false;
  const provider = caps.executeCommandProvider;
  if (
    !provider ||
    typeof provider !== 'object' ||
    Array.isArray(provider) ||
    !('commands' in provider)
  ) {
    return false;
  }
  const commands = provider.commands;
  return Array.isArray(commands) && commands.includes(command);
}

function pathContainsOrEquals(rootPath: string, targetFile: string): boolean {
  try {
    const rootCanonical = canonicalizeProject(rootPath).canonicalPath;
    const fileCanonical = canonicalizeProject(targetFile).canonicalPath;
    return rootCanonical === fileCanonical || isPathContained(rootCanonical, fileCanonical);
  } catch {
    return false;
  }
}

export function formatModelLines(model: WorkspaceModelReport): string[] {
  const lines: string[] = [
    `Project: ${model.project}`,
    `File: ${model.file}`,
    `Java executable: ${model.javaExec}`,
  ];
  if (model.moduleName) {
    lines.push(`Module: ${model.moduleName}`);
  }
  if (model.workingDirectory) {
    lines.push(`Working directory: ${model.workingDirectory}`);
  }
  if (model.moduleContentPaths && model.moduleContentPaths.length > 0) {
    lines.push(`Module content roots: ${model.moduleContentPaths.join(', ')}`);
  }
  if (model.moduleSourceRoots && model.moduleSourceRoots.length > 0) {
    lines.push(
      `Module source roots: ${model.moduleSourceRoots
        .map((r) => (r.type ? `${r.path} (${r.type})` : r.path))
        .join(', ')}`,
    );
  }
  if (model.classpath && model.classpath.length > 0) {
    lines.push(`Classpath entries: ${model.classpath.length}`);
  }
  if (model.modulePath && model.modulePath.length > 0) {
    lines.push(`Module path entries: ${model.modulePath.length}`);
  }
  if (model.sdks && model.sdks.length > 0) {
    lines.push(
      `SDKs: ${model.sdks
        .map((s) => (s.homePath ? `${s.name} (${s.homePath})` : s.name))
        .join(', ')}`,
    );
  }
  if (model.libraryCount !== undefined) {
    lines.push(`Workspace libraries: ${model.libraryCount}`);
  }
  lines.push(`Build support: ${model.supported ? 'supported' : 'unsupported'}`);
  if (model.buildTool) {
    lines.push(`Build tool: ${model.buildTool}`);
  }
  if (model.buildCwd) {
    lines.push(`Build working directory: ${model.buildCwd}`);
  }
  if (model.buildCommand && model.buildCommand.length > 0) {
    lines.push(`Build command: ${model.buildCommand.join(' ')}`);
  }
  if (model.reason) {
    lines.push(`Build reason: ${model.reason}`);
  }
  return lines;
}

export async function inspectWorkspaceModel(
  projectRoot: string | undefined,
  file: string,
  options: InspectWorkspaceModelOptions = {},
): Promise<WorkspaceModelReport> {
  const signal = options.signal;
  if (signal?.aborted) {
    const err = new Error('Workspace model inspection aborted');
    err.name = 'AbortError';
    throw err;
  }

  const rawTimeout = options.timeoutMs;
  if (rawTimeout !== undefined && (!Number.isFinite(rawTimeout) || rawTimeout <= 0)) {
    throw new Error('timeoutMs must be a positive finite number');
  }
  const timeoutMs = rawTimeout ?? 60000;
  const deadline = Date.now() + timeoutMs;

  const { resolvedFile, resolvedProject } = validateSourceFile(file, projectRoot);
  const {
    id: projectId,
    nativePath: canonicalProjectRoot,
    rootUri,
  } = canonicalizeProject(resolvedProject);

  const configuredEnv = await loadConfiguredEnv(options.configDir, projectId);

  const timeoutSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const fileUri = toLspFileUri(resolvedFile, rootUri);
  const createSession = options.createSession ?? createLspSession;

  let session: LspSession | undefined;
  let primaryError: unknown;

  try {
    const remainingForInit = Math.max(1, deadline - Date.now());
    session = await createSession(canonicalProjectRoot, {
      signal: combinedSignal,
      initializeTimeoutMs: remainingForInit,
      requestWaitTimeoutMs: remainingForInit,
      systemPath: options.systemPath,
      configDir: options.configDir,
      socket: options.socket,
    });

    if (combinedSignal.aborted) {
      const err = new Error('Workspace model inspection aborted');
      err.name = 'AbortError';
      throw err;
    }

    const launchPaths = await resolveLaunch(session, fileUri);
    if (!launchPaths || typeof launchPaths !== 'object') {
      throw new Error(`Launch resolution returned invalid response for ${resolvedFile}`);
    }
    if (typeof launchPaths.javaExec !== 'string' || !launchPaths.javaExec.trim()) {
      throw new Error(
        `Launch resolution returned no java executable for ${resolvedFile} (no project JDK configured?)`,
      );
    }
    for (const field of ['moduleName', 'workingDirectory'] as const) {
      if (launchPaths[field] !== undefined && typeof launchPaths[field] !== 'string') {
        throw new Error(`Launch resolution returned invalid ${field}`);
      }
    }
    for (const field of ['classpath', 'modulePath', 'moduleContentPaths'] as const) {
      const paths = launchPaths[field];
      if (
        paths !== undefined &&
        (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string'))
      ) {
        throw new Error(`Launch resolution returned invalid ${field}`);
      }
    }

    if (combinedSignal.aborted) {
      const err = new Error('Workspace model inspection aborted');
      err.name = 'AbortError';
      throw err;
    }

    const buildResult = await resolveBuildCommand(session, fileUri);
    if (!buildResult || typeof buildResult !== 'object') {
      throw new Error(`Build resolution returned invalid response for ${resolvedFile}`);
    }
    if (typeof buildResult.supported !== 'boolean') {
      throw new Error(
        `Build resolution returned missing or invalid boolean "supported" field for ${resolvedFile}`,
      );
    }
    if (
      buildResult.supported &&
      (!Array.isArray(buildResult.command) ||
        buildResult.command.length === 0 ||
        !buildResult.command.every((arg) => typeof arg === 'string') ||
        typeof buildResult.cwd !== 'string' ||
        !buildResult.cwd.trim())
    ) {
      throw new Error('Build resolution returned an incomplete supported build command');
    }

    const report: WorkspaceModelReport = {
      project: maskAndSanitize(canonicalProjectRoot, configuredEnv),
      file: maskAndSanitize(resolvedFile, configuredEnv),
      javaExec: maskAndSanitize(launchPaths.javaExec, configuredEnv),
      supported: buildResult.supported,
    };

    if (typeof launchPaths.moduleName === 'string' && launchPaths.moduleName.trim()) {
      report.moduleName = maskAndSanitize(launchPaths.moduleName, configuredEnv);
    }
    if (
      Array.isArray(launchPaths.moduleContentPaths) &&
      launchPaths.moduleContentPaths.every((p) => typeof p === 'string')
    ) {
      report.moduleContentPaths = launchPaths.moduleContentPaths.map((p) =>
        maskAndSanitize(p, configuredEnv),
      );
    }
    if (
      Array.isArray(launchPaths.classpath) &&
      launchPaths.classpath.every((p) => typeof p === 'string')
    ) {
      report.classpath = launchPaths.classpath.map((p) => maskAndSanitize(p, configuredEnv));
    }
    if (
      Array.isArray(launchPaths.modulePath) &&
      launchPaths.modulePath.every((p) => typeof p === 'string')
    ) {
      report.modulePath = launchPaths.modulePath.map((p) => maskAndSanitize(p, configuredEnv));
    }
    if (typeof launchPaths.workingDirectory === 'string' && launchPaths.workingDirectory.trim()) {
      report.workingDirectory = maskAndSanitize(launchPaths.workingDirectory, configuredEnv);
    }

    if (typeof buildResult.tool === 'string' && buildResult.tool.trim()) {
      report.buildTool = maskAndSanitize(buildResult.tool, configuredEnv);
    }
    if (typeof buildResult.cwd === 'string' && buildResult.cwd.trim()) {
      report.buildCwd = maskAndSanitize(buildResult.cwd, configuredEnv);
    }
    if (
      Array.isArray(buildResult.command) &&
      buildResult.command.every((arg) => typeof arg === 'string')
    ) {
      report.buildCommand = buildResult.command.map((arg) => maskAndSanitize(arg, configuredEnv));
    }
    if (typeof buildResult.reason === 'string' && buildResult.reason.trim()) {
      report.reason = maskAndSanitize(buildResult.reason, configuredEnv);
    }

    if (sessionSupportsCommand(session, 'exportWorkspace')) {
      const exportDir = await mkdtemp(join(tmpdir(), 'omp-ws-export-'));
      try {
        await session.request('workspace/executeCommand', {
          command: 'exportWorkspace',
          arguments: [exportDir],
        });
        if (combinedSignal.aborted) {
          const err = new Error('Workspace model inspection aborted');
          err.name = 'AbortError';
          throw err;
        }
        const exportedFile = join(exportDir, 'workspace.json');
        if (existsSync(exportedFile)) {
          const document: unknown = JSON.parse(await readFile(exportedFile, 'utf8'));
          if (!document || typeof document !== 'object' || Array.isArray(document)) {
            throw new Error('Workspace export returned an invalid document');
          }
          for (const field of ['modules', 'libraries', 'sdks']) {
            if (field in document && !Array.isArray(Reflect.get(document, field))) {
              throw new Error(`Workspace export returned invalid ${field}`);
            }
          }
          const parsedWs = document as Record<string, unknown>;
          const home = options.homeDir ?? homedir();
          const mavenRepo = await resolveMavenRepository(home);
          report.libraryCount = Array.isArray(parsedWs.libraries) ? parsedWs.libraries.length : 0;
          if (Array.isArray(parsedWs.sdks) && parsedWs.sdks.length > 0) {
            const sdks: NonNullable<WorkspaceModelReport['sdks']> = [];
            for (const rawSdk of parsedWs.sdks) {
              if (!rawSdk || typeof rawSdk !== 'object' || Array.isArray(rawSdk)) continue;
              const sdkObj = rawSdk as Record<string, unknown>;
              const name =
                typeof sdkObj.name === 'string' && sdkObj.name.trim()
                  ? maskAndSanitize(sdkObj.name.trim(), configuredEnv)
                  : 'SDK';
              const entry: NonNullable<WorkspaceModelReport['sdks']>[number] = { name };
              if (typeof sdkObj.type === 'string' && sdkObj.type.trim()) {
                entry.type = maskAndSanitize(sdkObj.type.trim(), configuredEnv);
              }
              if (typeof sdkObj.version === 'string' && sdkObj.version.trim()) {
                entry.version = maskAndSanitize(sdkObj.version.trim(), configuredEnv);
              }
              if (typeof sdkObj.homePath === 'string' && sdkObj.homePath.trim()) {
                entry.homePath = maskAndSanitize(
                  expandWorkspacePath(sdkObj.homePath.trim(), home, mavenRepo),
                  configuredEnv,
                );
              }
              sdks.push(entry);
            }
            if (sdks.length > 0) {
              report.sdks = sdks;
            }
          }
          if (Array.isArray(parsedWs.modules)) {
            type ParsedModule = {
              name: string;
              contentPaths: string[];
              sourceRoots: Array<{ path: string; type?: string }>;
              bestMatchLength: number;
            };
            const parsedModules: ParsedModule[] = [];
            for (const rawMod of parsedWs.modules) {
              if (!rawMod || typeof rawMod !== 'object' || Array.isArray(rawMod)) continue;
              const modObj = rawMod as Record<string, unknown>;
              if (typeof modObj.name !== 'string' || !modObj.name.trim()) continue;
              const contentPaths: string[] = [];
              const sourceRoots: Array<{ path: string; type?: string }> = [];
              let bestMatchLength = -1;
              const contentRoots = Array.isArray(modObj.contentRoots) ? modObj.contentRoots : [];
              for (const rawContent of contentRoots) {
                if (!rawContent || typeof rawContent !== 'object' || Array.isArray(rawContent)) {
                  continue;
                }
                const contentObj = rawContent as Record<string, unknown>;
                if (typeof contentObj.path === 'string' && contentObj.path.trim()) {
                  const expandedContent = expandWorkspacePath(
                    contentObj.path.trim(),
                    home,
                    mavenRepo,
                  );
                  contentPaths.push(expandedContent);
                  if (pathContainsOrEquals(expandedContent, resolvedFile)) {
                    bestMatchLength = Math.max(bestMatchLength, expandedContent.length);
                  }
                }
                const rawSourceRoots = Array.isArray(contentObj.sourceRoots)
                  ? contentObj.sourceRoots
                  : [];
                for (const rawSr of rawSourceRoots) {
                  if (!rawSr || typeof rawSr !== 'object' || Array.isArray(rawSr)) continue;
                  const srObj = rawSr as Record<string, unknown>;
                  if (typeof srObj.path !== 'string' || !srObj.path.trim()) continue;
                  const expandedSr = expandWorkspacePath(srObj.path.trim(), home, mavenRepo);
                  if (pathContainsOrEquals(expandedSr, resolvedFile)) {
                    bestMatchLength = Math.max(bestMatchLength, expandedSr.length);
                  }
                  sourceRoots.push({
                    path: maskAndSanitize(expandedSr, configuredEnv),
                    ...(typeof srObj.type === 'string' && srObj.type.trim()
                      ? { type: maskAndSanitize(srObj.type.trim(), configuredEnv) }
                      : {}),
                  });
                }
              }
              parsedModules.push({
                name: modObj.name.trim(),
                contentPaths,
                sourceRoots,
                bestMatchLength,
              });
            }
            let matched =
              typeof launchPaths.moduleName === 'string' && launchPaths.moduleName.trim()
                ? parsedModules.find((m) => m.name === launchPaths.moduleName?.trim())
                : undefined;
            if (!matched) {
              for (const candidate of parsedModules) {
                if (
                  candidate.bestMatchLength >= 0 &&
                  (!matched || candidate.bestMatchLength > matched.bestMatchLength)
                ) {
                  matched = candidate;
                }
              }
            }
            if (matched) {
              if (!report.moduleName) {
                report.moduleName = maskAndSanitize(matched.name, configuredEnv);
              }
              if (
                (!report.moduleContentPaths || report.moduleContentPaths.length === 0) &&
                matched.contentPaths.length > 0
              ) {
                report.moduleContentPaths = matched.contentPaths.map((p) =>
                  maskAndSanitize(p, configuredEnv),
                );
              }
              if (matched.sourceRoots.length > 0) {
                report.moduleSourceRoots = matched.sourceRoots;
              }
            }
          }
        } else {
          throw new Error('Workspace export did not write workspace.json');
        }
      } finally {
        await rm(exportDir, { recursive: true, force: true });
      }
    }
    return sanitizeStatus(report) as WorkspaceModelReport;
  } catch (err: unknown) {
    primaryError = err;
    if (err && typeof err === 'object') errorEnvironments.set(err, configuredEnv);
    throw err;
  } finally {
    if (session) {
      if (primaryError !== undefined) {
        try {
          await session.close();
        } catch (closeErr: unknown) {
          if (primaryError instanceof Error && closeErr instanceof Error) {
            try {
              (primaryError as Error & { cause?: unknown }).cause = closeErr;
            } catch {}
          }
        }
      } else {
        await session.close();
      }
    }
  }
}
