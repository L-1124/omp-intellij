export interface FailureDetail {
  kind: 'connection' | 'import' | 'authorization' | 'cancelled' | 'timeout' | 'rpc';
  stage: 'connect' | 'initialize' | 'import' | 'index' | 'request';
  message: string;
  code?: number | string;
  data?: unknown;
  folders?: Array<{ uri?: string; tool?: string; status: string; message?: string }>;
  logPath?: string;
}

export interface LicenseSummary {
  status: 'unknown' | 'valid' | 'needs-activation' | 'expired';
  featuresDeclined?: boolean;
  source?: string;
  reason?: string;
}

export const LICENSE_RECOVERY_GUIDANCE =
  '在受支持的 JetBrains 客户端中显式完成授权，再重新连接或查看最新状态';

const SENSITIVE_KEY_NAMES: Record<string, true> = {
  password: true,
  passwd: true,
  token: true,
  accesstoken: true,
  refreshtoken: true,
  authorization: true,
  cookie: true,
  licensekey: true,
  activationcode: true,
};

function getEnvCredentialLiterals(): string[] {
  const literals: string[] = [];
  if (typeof process === 'undefined' || !process.env) {
    return literals;
  }
  const candidateKeys = [
    'INTELLIJ_SERVER_LICENSE',
    'INTELLIJ_SERVER_LICENSE_FILE',
    'JETBRAINS_LICENSE_SERVER',
  ];
  for (const key of candidateKeys) {
    const val = process.env[key];
    if (val) literals.push(val);
  }
  return literals;
}

export function sanitizeString(text: string): string {
  if (typeof text !== 'string') return '';
  let result = text;

  // Prevent leakage of credentials present in server or launcher environment variables
  for (const literal of getEnvCredentialLiterals()) {
    if (literal && result.includes(literal)) {
      result = result.replaceAll(literal, '[REDACTED]');
    }
  }

  // Strip credentials from repository/proxy URLs before persistence or user display
  result = result.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^@/\s?#]+)@/g, '$1[REDACTED]@');

  // Mask whole Authorization and Cookie header values through newline
  result = result.replace(
    /(?:(?<=[^\w$])|^)(authorization|cookie)\s*:\s*[^\r\n]+/gi,
    '$1: [REDACTED]',
  );

  // Strip bearer tokens from raw error or parameter descriptions
  result = result.replace(/\b(Bearer\s+)[^\s,;"]+/gi, '$1[REDACTED]');
  // Redact sensitive values inside JSON error fragments
  result = result.replace(
    /(["'])(password|passwd|token|accessToken|refreshToken|authorization|cookie|licenseKey|activationCode|INTELLIJ_SERVER_LICENSE)\1(\s*:\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\s{}]+)/gi,
    '$1$2$1$3"[REDACTED]"',
  );

  // Redact key=value or key: value parameters commonly found in command lines and logs
  result = result.replace(
    /\b(password|passwd|token|accessToken|refreshToken|authorization|cookie|licenseKey|activationCode|INTELLIJ_SERVER_LICENSE)\b(\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|Bearer\s+[^\s,;"]+|[^\s,;&)\s]+)/gi,
    '$1$2[REDACTED]',
  );

  return result;
}

function sanitizeInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  const type = typeof value;
  if (type === 'string') {
    return sanitizeString(value as string);
  }
  if (type === 'number') {
    return Number.isFinite(value as number) ? value : null;
  }
  if (type === 'boolean') {
    return value;
  }
  if (type === 'symbol' || type === 'function') {
    return undefined;
  }
  if (type === 'bigint') {
    return { message: sanitizeString(`[Non-JSON value: BigInt(${value.toString()})]`) };
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    try {
      if (value instanceof Error) {
        const errorObj: Record<string, unknown> = {
          name: sanitizeString(value.name || 'Error'),
          message: sanitizeString(value.message || ''),
        };
        const errRecord = value as unknown as Record<string, unknown>;
        if (errRecord.code !== undefined) {
          errorObj.code =
            typeof errRecord.code === 'string' ? sanitizeString(errRecord.code) : errRecord.code;
        }
        if (errRecord.data !== undefined) {
          errorObj.data = sanitizeInternal(errRecord.data, seen);
        }
        if (errRecord.stage !== undefined) {
          errorObj.stage =
            typeof errRecord.stage === 'string' ? sanitizeString(errRecord.stage) : errRecord.stage;
        }
        if (errRecord.kind !== undefined) {
          errorObj.kind =
            typeof errRecord.kind === 'string' ? sanitizeString(errRecord.kind) : errRecord.kind;
        }
        if (errRecord.folders !== undefined) {
          errorObj.folders = sanitizeInternal(errRecord.folders, seen);
        }
        if (errRecord.logPath !== undefined) {
          errorObj.logPath =
            typeof errRecord.logPath === 'string'
              ? sanitizeString(errRecord.logPath)
              : errRecord.logPath;
        }
        return errorObj;
      }

      if (Array.isArray(value)) {
        return value.map((item) => sanitizeInternal(item, seen));
      }

      // Convert non-plain objects into safe diagnostic messages to avoid non-JSON leakage
      const proto = Object.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) {
        const rawName =
          typeof value.constructor?.name === 'string' ? value.constructor.name : 'Object';
        return { message: sanitizeString(`[Non-JSON value: ${rawName}]`) };
      }

      const result: Record<string, unknown> = proto === null ? Object.create(null) : {};
      for (const [key, val] of Object.entries(value)) {
        const sanitizedVal =
          SENSITIVE_KEY_NAMES[key.toLowerCase()] === true
            ? '[REDACTED]'
            : sanitizeInternal(val, seen);
        Object.defineProperty(result, key, {
          value: sanitizedVal,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { message: `[Unserializable: ${sanitizeString(errMsg)}]` };
    } finally {
      seen.delete(value);
    }
  }

  return { message: sanitizeString(`[Non-JSON value: ${String(value)}]`) };
}

export function sanitizeStatus(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return sanitizeInternal(value, seen);
}

export function projectLicenseState(payload: unknown): LicenseSummary {
  if (!payload || typeof payload !== 'object') {
    return { status: 'unknown' };
  }

  const rawObj = payload as Record<string, unknown>;
  const root =
    'params' in rawObj && rawObj.params && typeof rawObj.params === 'object'
      ? (rawObj.params as Record<string, unknown>)
      : rawObj;

  const activeLicense =
    root.activeLicense && typeof root.activeLicense === 'object'
      ? (root.activeLicense as Record<string, unknown>)
      : undefined;

  const activeLicenseStatus =
    typeof activeLicense?.status === 'string' ? activeLicense.status : undefined;

  const parkedReason =
    typeof root.parkedReason === 'string' && root.parkedReason.trim()
      ? root.parkedReason.trim()
      : undefined;

  const featuresDeclined =
    typeof root.featuresDeclined === 'boolean' ? root.featuresDeclined : undefined;

  const rawSource =
    typeof activeLicense?.source === 'string' && activeLicense.source.trim()
      ? activeLicense.source.trim()
      : undefined;
  const source = rawSource ? sanitizeString(rawSource) : undefined;

  const reason = parkedReason ? sanitizeString(parkedReason) : undefined;

  let status: LicenseSummary['status'] = 'unknown';

  if (activeLicenseStatus === 'Expired' || parkedReason === 'GraceExpired') {
    status = 'expired';
  } else if (featuresDeclined === true) {
    status = 'needs-activation';
  } else if (activeLicenseStatus === 'Valid') {
    status = 'valid';
  } else {
    status = 'unknown';
  }

  const result: LicenseSummary = { status };
  if (featuresDeclined !== undefined) {
    result.featuresDeclined = featuresDeclined;
  }
  if (source !== undefined) {
    result.source = source;
  }
  if (reason !== undefined) {
    result.reason = reason;
  }

  return result;
}

export class RpcResponseError extends Error {
  readonly code?: number | string;
  readonly data?: unknown;

  constructor(error: { code?: number | string; message?: string; data?: unknown }) {
    const rawMessage = typeof error?.message === 'string' ? error.message : 'RPC response error';
    const sanitizedMsg = sanitizeString(rawMessage);
    super(sanitizedMsg);
    this.name = 'RpcResponseError';
    this.code = error?.code;
    this.data = error?.data;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  // Prevent accidental leak if error instance is passed directly to JSON.stringify
  toJSON(): Record<string, unknown> {
    return sanitizeStatus(this) as Record<string, unknown>;
  }
}
