export interface PluginSettings {
  executable: string;
  host: string;
  systemPath: string;
  startupTimeoutMs: number;
  initializeTimeoutMs: number;
  requestWaitTimeoutMs: number;
  idleTimeout: string;
  cachePolicy: {
    retentionDays: number;
    warnAboveGiB: number;
    automaticDeletion: boolean;
  };
  workspaceConfigPath?: string;
  initTimeoutMs?: number;
  indexWaitTimeoutMs?: number;
}
