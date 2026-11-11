import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  createLspSession,
  type LspSession,
  resolveLaunch,
  toLspFileUri,
} from '../debug/run-core.js';
import { settings } from '../server/service.js';
import { sanitizeString } from '../shared/runtime-status.js';
import { getHostInitializationOptions } from './configuration.js';
import { canonicalizeProject, recordReadiness } from './metadata.js';
import {
  applyWorkspaceOptions,
  cleanPath,
  findFirstSourceFile,
  getWorkspaceConfigDir,
  maskConfiguredSecrets,
  readWorkspaceConfig,
  registerSystemPath,
  writeAtomicJson,
} from './workspace.js';

export interface ReimportWorkspaceResult {
  ready: boolean;
  projectRoot: string;
  canonicalPath: string;
  appliedJdk: string | null;
  verifiedJdk?: boolean;
  submittedEnvKeys?: string[];
  elapsedMs?: number;
}

export async function reimportWorkspace(
  projectRoot: string,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    systemPath?: string;
    configDir?: string;
  } = {},
): Promise<ReimportWorkspaceResult> {
  const startTime = Date.now();
  if (!projectRoot) throw new Error('Project root is required');
  const cleanedRoot = cleanPath(projectRoot);
  const canonical = canonicalizeProject(cleanedRoot);
  const { canonicalPath, nativePath, rootUri, id } = canonical;
  const systemPath = options.systemPath ?? settings.systemPath;
  if (systemPath) registerSystemPath(systemPath);
  const configDir = options.configDir;
  const targetDir = getWorkspaceConfigDir({ configDir });
  const saved = await readWorkspaceConfig(targetDir, canonical);
  const configRevision = saved?.updatedAt ?? Date.now();
  const plannedEnvKeys = saved?.env ? Object.keys(saved.env).sort() : [];
  const appliedJdk = saved?.javaHome || null;

  const receiptDir = join(systemPath, 'plugin-metadata', 'receipts');
  const importReceiptPath = join(receiptDir, `${id}.import-status.json`);

  const writeImportReceipt = async (
    status: 'pending' | 'submitted' | 'applied' | 'failed',
    stage: 'saved' | 'connect' | 'submitted' | 'reload' | 'verification' | 'ready',
    failure?: { stage: string; message: string } | null,
    verifiedJdk = false,
  ) => {
    try {
      const doc = {
        id,
        canonicalPath,
        status,
        stage,
        revision: configRevision,
        submittedEnvKeys: stage === 'connect' || stage === 'saved' ? [] : plannedEnvKeys,
        appliedJdk: verifiedJdk ? appliedJdk : null,
        verifiedJdk,
        failure: failure
          ? {
              stage: failure.stage,
              message: sanitizeString(maskConfiguredSecrets(failure.message, saved?.env)),
            }
          : null,
        timestamp: Date.now(),
      };
      await writeAtomicJson(importReceiptPath, doc);
    } catch {}
  };

  const rawHostOpts = await getHostInitializationOptions(systemPath, id);
  const baseInitOptions = rawHostOpts ?? {};
  const fullInitOptions = await applyWorkspaceOptions(nativePath, baseInitOptions, {
    systemPath,
    configDir,
  });

  const waitTimeout = options.timeoutMs ?? settings.requestWaitTimeoutMs ?? 300000;

  let session: LspSession | null = null;
  try {
    try {
      session = await createLspSession(nativePath, {
        signal: options.signal,
        requestWaitTimeoutMs: waitTimeout,
        systemPath,
        configDir,
      });
    } catch (connectErr: unknown) {
      const errMsg = connectErr instanceof Error ? connectErr.message : String(connectErr);
      await writeImportReceipt('failed', 'connect', { stage: 'connect', message: errMsg });
      throw connectErr;
    }

    try {
      await writeImportReceipt('submitted', 'submitted');
      await session.reloadWorkspace({
        initializationOptions: fullInitOptions,
        timeoutMs: waitTimeout,
        signal: options.signal,
      });
    } catch (reloadErr: unknown) {
      const errMsg = reloadErr instanceof Error ? reloadErr.message : String(reloadErr);
      await writeImportReceipt('failed', 'reload', { stage: 'reload', message: errMsg });
      throw reloadErr;
    }

    let javaExec: string | null = null;
    let verified = false;

    const sourceFile = await findFirstSourceFile(nativePath);
    if (sourceFile && appliedJdk) {
      try {
        const sourceFileUri = toLspFileUri(sourceFile, rootUri);
        const launch = await resolveLaunch(session, sourceFileUri);
        if (!launch?.javaExec) {
          throw new Error(
            `Model verification failed: resolveLaunch returned no javaExec for ${sourceFileUri}`,
          );
        }
        javaExec = launch.javaExec;
        const resolvedLaunchJdk = resolve(dirname(dirname(javaExec)))
          .replace(/\\/g, '/')
          .toLowerCase();
        const expectedJdk = resolve(appliedJdk).replace(/\\/g, '/').toLowerCase();
        if (resolvedLaunchJdk !== expectedJdk) {
          throw new Error(
            `Model verification mismatch: expected JDK "${appliedJdk}" but IntelliJ resolved "${javaExec}"`,
          );
        }
        verified = true;
      } catch (verifyErr: unknown) {
        const errMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
        await writeImportReceipt('failed', 'verification', {
          stage: 'verification',
          message: errMsg,
        });
        throw verifyErr;
      }
    }

    let serverPid: number | null = null;
    try {
      const ownerRaw: unknown = JSON.parse(
        await readFile(join(systemPath, 'omp-server.json'), 'utf8'),
      );
      const owner = ownerRaw as { pid?: number } | null;
      if (Number.isSafeInteger(owner?.pid) && (owner?.pid ?? 0) > 0) {
        serverPid = owner?.pid ?? null;
      }
    } catch {}

    if (appliedJdk && serverPid && verified) {
      const receiptPath = join(receiptDir, `${id}.applied.json`);
      const receipt = {
        id,
        canonicalPath,
        pid: serverPid,
        javaHome: appliedJdk,
        javaExec,
        appliedAt: Date.now(),
        verified: true,
      };
      await writeAtomicJson(receiptPath, receipt);
      await recordReadiness(systemPath, nativePath, Date.now()).catch(() => {});
    }

    await writeImportReceipt('applied', 'ready', null, verified);

    const elapsedMs = Date.now() - startTime;
    return {
      ready: true,
      projectRoot: cleanedRoot,
      canonicalPath,
      appliedJdk: verified ? appliedJdk : null,
      verifiedJdk: verified,
      submittedEnvKeys: plannedEnvKeys,
      elapsedMs,
    };
  } finally {
    if (session) {
      await session.close().catch(() => {});
    }
  }
}
