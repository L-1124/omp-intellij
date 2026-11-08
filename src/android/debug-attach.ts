import type { LspSession } from '../debug/run-core.js';

export const ANDROID_DEBUG_COMMANDS = {
  prepare: 'omp.android.debug.prepare',
  claim: 'omp.android.debug.claim',
  release: 'omp.android.debug.release',
} as const;

export type AndroidDebugCommand =
  (typeof ANDROID_DEBUG_COMMANDS)[keyof typeof ANDROID_DEBUG_COMMANDS];

export class AndroidDebugCapabilityError extends Error {
  readonly code = 'COMMAND_UNSUPPORTED';

  constructor(command: string) {
    super(`Language server does not advertise command '${command}'`);
    this.name = 'AndroidDebugCapabilityError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface PrepareAndroidDebugParams {
  packageName?: string;
  pid?: number;
  deviceId?: string;
  adbPath?: string;
  timeoutMs?: number;
}

export interface PreparedAndroidDebug {
  success: true;
  cleanupKey: string;
  expiresAt: number;
  deviceId: string;
  pid: number;
  processName: string;
  host: string;
  port: number;
  jdwpTarget: string;
  debug: {
    action: 'attach';
    adapter: 'intellij';
    host: string;
    port: number;
    timeout: number;
  };
}

export interface ClaimAndroidDebugTarget {
  host: string;
  port: number;
}

export type ClaimAndroidDebugResult = { claimed: false } | { claimed: true; cleanupKey: string };

export interface ReleaseAndroidDebugResult {
  success: boolean;
  cleaned: boolean;
  reason?: string;
}

export type LspSessionLike = Pick<LspSession, 'request' | 'serverCapabilities'>;

export function supportsAndroidDebugCommand(
  session: { serverCapabilities?: Record<string, unknown> } | null | undefined,
  command: string,
): boolean {
  const caps = session?.serverCapabilities;
  if (!caps || typeof caps !== 'object' || !('executeCommandProvider' in caps)) {
    return false;
  }
  const execProvider = caps.executeCommandProvider;
  if (
    !execProvider ||
    typeof execProvider !== 'object' ||
    !('commands' in execProvider) ||
    !Array.isArray(execProvider.commands)
  ) {
    return false;
  }
  return execProvider.commands.includes(command);
}

export async function prepareAndroidDebug(
  session: LspSessionLike,
  params: PrepareAndroidDebugParams,
): Promise<PreparedAndroidDebug> {
  if (!supportsAndroidDebugCommand(session, ANDROID_DEBUG_COMMANDS.prepare)) {
    throw new AndroidDebugCapabilityError(ANDROID_DEBUG_COMMANDS.prepare);
  }

  const reqTimeoutMs =
    typeof params.timeoutMs === 'number' ? Math.max(params.timeoutMs + 5000, 15000) : undefined;

  const rawResult = await session.request(
    'workspace/executeCommand',
    {
      command: ANDROID_DEBUG_COMMANDS.prepare,
      arguments: [params],
    },
    reqTimeoutMs,
  );

  if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
    throw new Error('Invalid prepare response from language server');
  }

  if (!('success' in rawResult) || rawResult.success !== true) {
    throw new Error(`Prepare command did not succeed: ${JSON.stringify(rawResult)}`);
  }
  if (
    !('cleanupKey' in rawResult) ||
    typeof rawResult.cleanupKey !== 'string' ||
    !('expiresAt' in rawResult) ||
    typeof rawResult.expiresAt !== 'number' ||
    !('deviceId' in rawResult) ||
    typeof rawResult.deviceId !== 'string' ||
    !('pid' in rawResult) ||
    typeof rawResult.pid !== 'number' ||
    !('processName' in rawResult) ||
    typeof rawResult.processName !== 'string' ||
    !('host' in rawResult) ||
    typeof rawResult.host !== 'string' ||
    !('port' in rawResult) ||
    typeof rawResult.port !== 'number' ||
    !('jdwpTarget' in rawResult) ||
    typeof rawResult.jdwpTarget !== 'string' ||
    !('debug' in rawResult) ||
    !rawResult.debug ||
    typeof rawResult.debug !== 'object'
  ) {
    throw new Error('Incomplete prepare response from language server');
  }
  const debug = rawResult.debug;
  if (
    !('action' in debug) ||
    debug.action !== 'attach' ||
    !('adapter' in debug) ||
    debug.adapter !== 'intellij' ||
    !('host' in debug) ||
    typeof debug.host !== 'string' ||
    !('port' in debug) ||
    typeof debug.port !== 'number' ||
    !('timeout' in debug) ||
    typeof debug.timeout !== 'number'
  ) {
    throw new Error('Invalid debug configuration in prepare response');
  }
  return {
    success: true,
    cleanupKey: rawResult.cleanupKey,
    expiresAt: rawResult.expiresAt,
    deviceId: rawResult.deviceId,
    pid: rawResult.pid,
    processName: rawResult.processName,
    host: rawResult.host,
    port: rawResult.port,
    jdwpTarget: rawResult.jdwpTarget,
    debug: {
      action: 'attach',
      adapter: 'intellij',
      host: debug.host,
      port: debug.port,
      timeout: debug.timeout,
    },
  };
}

export async function claimAndroidDebug(
  session: LspSessionLike,
  target: ClaimAndroidDebugTarget,
): Promise<ClaimAndroidDebugResult> {
  if (!supportsAndroidDebugCommand(session, ANDROID_DEBUG_COMMANDS.claim)) {
    return { claimed: false };
  }

  if (!target || typeof target !== 'object') {
    throw new TypeError('target must be an object with host and port');
  }
  if (typeof target.host !== 'string' || target.host.trim().length === 0) {
    throw new TypeError('target.host must be a non-empty string');
  }
  if (
    typeof target.port !== 'number' ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65535
  ) {
    throw new TypeError('target.port must be an integer between 1 and 65535');
  }

  const rawResult = await session.request(
    'workspace/executeCommand',
    {
      command: ANDROID_DEBUG_COMMANDS.claim,
      arguments: [{ host: target.host.trim(), port: target.port }],
    },
    10000,
  );

  if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
    throw new Error('Invalid claim response from language server');
  }

  if ('claimed' in rawResult && rawResult.claimed === false) {
    return { claimed: false };
  }
  if (
    'claimed' in rawResult &&
    rawResult.claimed === true &&
    'cleanupKey' in rawResult &&
    typeof rawResult.cleanupKey === 'string' &&
    rawResult.cleanupKey.length > 0
  ) {
    return { claimed: true, cleanupKey: rawResult.cleanupKey };
  }

  throw new Error(`Unexpected claim response: ${JSON.stringify(rawResult)}`);
}

export async function releaseAndroidDebug(
  session: LspSessionLike,
  cleanupKey: string,
  timeoutMs: number = 10000,
): Promise<ReleaseAndroidDebugResult> {
  if (!supportsAndroidDebugCommand(session, ANDROID_DEBUG_COMMANDS.release)) {
    throw new AndroidDebugCapabilityError(ANDROID_DEBUG_COMMANDS.release);
  }

  if (typeof cleanupKey !== 'string' || cleanupKey.trim().length === 0) {
    throw new TypeError('cleanupKey must be a non-empty string');
  }

  const rawResult = await session.request(
    'workspace/executeCommand',
    {
      command: ANDROID_DEBUG_COMMANDS.release,
      arguments: [{ cleanupKey: cleanupKey.trim() }],
    },
    timeoutMs,
  );

  if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
    throw new Error('Invalid release response from language server');
  }

  if (
    !('success' in rawResult) ||
    rawResult.success !== true ||
    !('cleaned' in rawResult) ||
    typeof rawResult.cleaned !== 'boolean' ||
    (!rawResult.cleaned && (!('reason' in rawResult) || rawResult.reason !== 'already_cleaned'))
  ) {
    throw new Error(`Unexpected release response: ${JSON.stringify(rawResult)}`);
  }
  return rawResult.cleaned
    ? { success: true, cleaned: true }
    : { success: true, cleaned: false, reason: 'already_cleaned' };
}
