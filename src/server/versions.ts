import { getActiveLeases } from '../project/metadata.js';
import { validateServerVersion } from './bundles.js';
import { defaultInstallDir, readServerConfig, saveServerConfig } from './config.js';
import { findInstalled, type InstallResult } from './install.js';
import {
  listAllActiveDebugSessions,
  settings,
  verifyServerOwnership,
  withLifecycleLock,
} from './service.js';

export async function selectServerVersion(
  version: string,
  options: { systemPath?: string; configFile?: string; installDir?: string } = {},
): Promise<InstallResult> {
  validateServerVersion(version);
  const systemPath = options.systemPath ?? settings.systemPath;
  return withLifecycleLock(
    async () => {
      const leases = await getActiveLeases(systemPath);
      const sessions = await listAllActiveDebugSessions(systemPath);
      if (leases.length || sessions.length) {
        const blockers = [
          ...leases.map(
            (lease) =>
              `${lease.kind}: ${lease.canonicalPath ?? 'unknown project'} (PID ${lease.pid})`,
          ),
          ...sessions.map((session) => `debug ${session.id} (PID ${session.pid})`),
        ];
        throw new Error(
          `Cannot select IntelliJ version while consumers are active: ${blockers.join('; ')}. Close connections and run /intellij stop first.`,
        );
      }
      const owner = await verifyServerOwnership(systemPath);
      if (owner.status === 'running-owned' || owner.status === 'running-unverified') {
        throw new Error(
          'Cannot select IntelliJ version while the shared server is running or its ownership is unverified. Run /intellij stop first.',
        );
      }
      const current = await readServerConfig(settings.executable, options);
      const installDir =
        options.installDir ??
        (current.mode === 'managed' ? current.installDir : defaultInstallDir());
      const installed = await findInstalled(installDir, { version });
      if (!installed) {
        throw new Error(
          `IntelliJ server ${version} is not installed or its receipt is invalid at "${installDir}". Run /intellij install --version ${version} first.`,
        );
      }
      await saveServerConfig(
        { mode: 'managed', installDir: installed.installDir, version },
        options,
      );
      return installed;
    },
    { systemPath },
  );
}
