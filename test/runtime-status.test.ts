import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type FailureDetail,
  LICENSE_RECOVERY_GUIDANCE,
  projectLicenseState,
  RpcResponseError,
  sanitizeStatus,
  sanitizeString,
} from '../src/shared/runtime-status.js';

test('sanitizeStatus: named sensitive keys are redacted case-insensitively', () => {
  const input = {
    password: 'secret-password',
    Passwd: 'secret-passwd',
    Token: 'secret-token',
    accessToken: 'secret-access',
    AccessToken: 'secret-access-pascal',
    refreshToken: 'secret-refresh',
    RefreshToken: 'secret-refresh-pascal',
    authorization: 'secret-auth',
    Authorization: 'secret-auth-title',
    Cookie: 'session=abc; id=123',
    licenseKey: 'LIC-KEY-999',
    LicenseKey: 'LIC-KEY-888',
    activationCode: 'ACT-CODE-111',
    ActivationCode: 'ACT-CODE-222',
    nested: {
      safeField: 'safe',
      token: 'deep-secret',
      inner: {
        password: 'deep-nested-password',
      },
    },
  };

  const result = sanitizeStatus(input) as Record<string, unknown>;

  assert.equal(result.password, '[REDACTED]');
  assert.equal(result.Passwd, '[REDACTED]');
  assert.equal(result.Token, '[REDACTED]');
  assert.equal(result.accessToken, '[REDACTED]');
  assert.equal(result.AccessToken, '[REDACTED]');
  assert.equal(result.refreshToken, '[REDACTED]');
  assert.equal(result.RefreshToken, '[REDACTED]');
  assert.equal(result.authorization, '[REDACTED]');
  assert.equal(result.Authorization, '[REDACTED]');
  assert.equal(result.Cookie, '[REDACTED]');
  assert.equal(result.licenseKey, '[REDACTED]');
  assert.equal(result.LicenseKey, '[REDACTED]');
  assert.equal(result.activationCode, '[REDACTED]');
  assert.equal(result.ActivationCode, '[REDACTED]');

  const nested = result.nested as Record<string, unknown>;
  assert.equal(nested.safeField, 'safe');
  assert.equal(nested.token, '[REDACTED]');
  const inner = nested.inner as Record<string, unknown>;
  assert.equal(inner.password, '[REDACTED]');
});

test('sanitizeString: redacts URL userinfo, Bearer tokens, and sensitive key=value pairs', () => {
  // URL userinfo
  assert.equal(
    sanitizeString('Failed resolving https://user:secret@repo.corp/pkg'),
    'Failed resolving https://[REDACTED]@repo.corp/pkg',
  );
  assert.equal(
    sanitizeString('Connecting to http://admin:pass123@127.0.0.1:8080/'),
    'Connecting to http://[REDACTED]@127.0.0.1:8080/',
  );
  assert.equal(
    sanitizeString('Cloning git+ssh://git:token123@github.com/org/repo.git'),
    'Cloning git+ssh://[REDACTED]@github.com/org/repo.git',
  );
  // Normal URL without credentials remains untouched
  assert.equal(
    sanitizeString('Normal url https://repo.corp/maven/artifact.jar'),
    'Normal url https://repo.corp/maven/artifact.jar',
  );

  // Authorization and Cookie headers masked whole through newline
  assert.equal(
    sanitizeString('Authorization: Basic dXNlcjpzZWNyZXQ='),
    'Authorization: [REDACTED]',
  );
  assert.equal(
    sanitizeString('Authorization: Bearer $$BEARERTOKEN_XN3Z375LMRYQ:M$$'),
    'Authorization: [REDACTED]',
  );
  assert.equal(sanitizeString('Cookie: session=abc; refresh=secret'), 'Cookie: [REDACTED]');
  assert.equal(
    sanitizeString('Header Cookie: session=abcdef12345; secure'),
    'Header Cookie: [REDACTED]',
  );
  assert.equal(
    sanitizeString(
      'GET / HTTP/1.1\nAuthorization: Basic dXNlcjpzZWNyZXQ=\nCookie: session=abc; refresh=secret\nHost: example.com',
    ),
    'GET / HTTP/1.1\nAuthorization: [REDACTED]\nCookie: [REDACTED]\nHost: example.com',
  );

  // Standalone Bearer token outside Authorization header
  assert.equal(
    sanitizeString('Received 401 with bearer $$BEARERTOKEN_OQY67R8T95YJ:L$$'),
    'Received 401 with bearer [REDACTED]',
  );
  // Sensitive key=value and key: value
  assert.equal(
    sanitizeString('Cannot auth with password=superSecretPass; try again'),
    'Cannot auth with password=[REDACTED]; try again',
  );
  assert.equal(
    sanitizeString('Config: token: secret-token-xyz, other: 123'),
    'Config: token: [REDACTED], other: 123',
  );
  assert.equal(
    sanitizeString("Flag accessToken=secret_access and refreshToken='quoted_refresh'"),
    'Flag accessToken=[REDACTED] and refreshToken=[REDACTED]',
  );
  assert.equal(
    sanitizeString('License info: licenseKey: 12345-ABCDE, activationCode=XYZ-888'),
    'License info: licenseKey: [REDACTED], activationCode=[REDACTED]',
  );
  assert.equal(
    sanitizeString('INTELLIJ_SERVER_LICENSE=secret_payload_content'),
    'INTELLIJ_SERVER_LICENSE=[REDACTED]',
  );

  // Quoted JSON inside error strings
  assert.equal(
    sanitizeString('{"token": "my-secret-token", "module": ":app"}'),
    '{"token": "[REDACTED]", "module": ":app"}',
  );

  // Escaped quotes and backslashes inside quoted sensitive values
  assert.equal(
    sanitizeString('{"token": "secret\\"with\\"escapes", "module": ":app"}'),
    '{"token": "[REDACTED]", "module": ":app"}',
  );
  assert.equal(
    sanitizeString("CLI option: token='secret\\'quoted\\'val', other=123"),
    'CLI option: token=[REDACTED], other=123',
  );
  assert.equal(
    sanitizeString('Config: password="p\\\\\\"word", port=8080'),
    'Config: password=[REDACTED], port=8080',
  );
});

test('sanitizeString: matches known environment credential literals without reading files', () => {
  const originalEnv = process.env.INTELLIJ_SERVER_LICENSE;
  try {
    process.env.INTELLIJ_SERVER_LICENSE = 'LITERAL_SECRET_ENV_LICENSE_TICKET_999';
    const message = 'Server log: using license LITERAL_SECRET_ENV_LICENSE_TICKET_999 for session';
    const sanitized = sanitizeString(message);
    assert.equal(sanitized, 'Server log: using license [REDACTED] for session');
    assert.ok(!sanitized.includes('LITERAL_SECRET_ENV_LICENSE_TICKET_999'));
  } finally {
    if (originalEnv === undefined) {
      delete process.env.INTELLIJ_SERVER_LICENSE;
    } else {
      process.env.INTELLIJ_SERVER_LICENSE = originalEnv;
    }
  }
});

test('known license file paths are masked without opening the file', () => {
  const previous = process.env.INTELLIJ_SERVER_LICENSE_FILE;
  const file = 'C:/private/missing-license-file.txt';
  process.env.INTELLIJ_SERVER_LICENSE_FILE = file;
  try {
    assert.equal(sanitizeString(`Cannot read ${file}`), 'Cannot read [REDACTED]');
  } finally {
    if (previous === undefined) delete process.env.INTELLIJ_SERVER_LICENSE_FILE;
    else process.env.INTELLIJ_SERVER_LICENSE_FILE = previous;
  }
});

test('sanitizeStatus: preserves normal structures, error codes, and non-sensitive fields', () => {
  const normalData = {
    code: -32001,
    kind: 'rpc',
    stage: 'request',
    module: ':app',
    count: 42,
    enabled: true,
    tags: ['java', 'kotlin', 'gradle'],
    nested: {
      ok: true,
      path: '/workspace/project',
    },
  };

  const result = sanitizeStatus(normalData) as typeof normalData;
  assert.deepEqual(result, normalData);
});
test('sanitizeStatus: preserves __proto__ structure from JSON without prototype pollution', () => {
  const parsed = JSON.parse('{"__proto__":{"module":":app"},"ok":true}');
  const sanitized = sanitizeStatus(parsed) as Record<string, unknown>;

  assert.equal(JSON.stringify(sanitized), '{"__proto__":{"module":":app"},"ok":true}');
  assert.equal(Object.hasOwn(sanitized, '__proto__'), true);
  assert.equal((Object.prototype as unknown as Record<string, unknown>).module, undefined);
});

test('sanitizeStatus: handles FailureDetail with mixed clean and sensitive data', () => {
  const failure: FailureDetail = {
    kind: 'import',
    stage: 'import',
    message: 'Cannot resolve https://user:secret@repo.com/pkg with token=secret123',
    code: -32002,
    data: {
      repository: 'https://user:secret@repo.com/pkg',
      token: 'secret123',
      module: ':app',
    },
    folders: [
      {
        uri: 'file:///workspace/app',
        tool: 'gradle',
        status: 'FAILED',
        message: 'Auth failed with password=topsecret',
      },
      {
        uri: 'file:///workspace/lib',
        tool: 'gradle',
        status: 'SUCCESS',
        message: 'Imported successfully',
      },
    ],
    logPath: '/tmp/launcher.log',
  };

  const sanitized = sanitizeStatus(failure) as FailureDetail;

  assert.equal(sanitized.kind, 'import');
  assert.equal(sanitized.stage, 'import');
  assert.equal(sanitized.code, -32002);
  assert.equal(
    sanitized.message,
    'Cannot resolve https://[REDACTED]@repo.com/pkg with token=[REDACTED]',
  );

  const data = sanitized.data as Record<string, unknown>;
  assert.equal(data.module, ':app');
  assert.equal(data.repository, 'https://[REDACTED]@repo.com/pkg');
  assert.equal(data.token, '[REDACTED]');

  assert.ok(sanitized.folders);
  assert.equal(sanitized.folders.length, 2);
  assert.equal(sanitized.folders[0].status, 'FAILED');
  assert.equal(sanitized.folders[0].message, 'Auth failed with password=[REDACTED]');
  assert.equal(sanitized.folders[1].status, 'SUCCESS');
  assert.equal(sanitized.folders[1].message, 'Imported successfully');
  assert.equal(sanitized.logPath, '/tmp/launcher.log');
});

test('sanitizeStatus: converts non-JSON values and exceptions to safe messages', () => {
  assert.equal(sanitizeStatus(null), null);
  assert.equal(sanitizeStatus(undefined), undefined);
  assert.equal(sanitizeStatus(123), 123);
  assert.equal(sanitizeStatus(NaN), null);
  assert.equal(sanitizeStatus(Infinity), null);
  assert.equal(sanitizeStatus(true), true);
  assert.equal(
    sanitizeStatus(() => 'secret'),
    undefined,
  );
  assert.equal(sanitizeStatus(Symbol('secret')), undefined);

  // BigInt
  const bigintResult = sanitizeStatus(BigInt(9007199254740991)) as Record<string, unknown>;
  assert.ok(typeof bigintResult.message === 'string');
  assert.ok(bigintResult.message.includes('BigInt'));

  // Non-plain objects (e.g. Date, RegExp) converted to safe messages instead of serialized
  const dateResult = sanitizeStatus(new Date('2026-11-02T12:00:00.000Z')) as Record<
    string,
    unknown
  >;
  assert.ok(typeof dateResult.message === 'string');
  assert.ok(dateResult.message.includes('[Non-JSON value: Date]'));

  const regexResult = sanitizeStatus(/secret/gi) as Record<string, unknown>;
  assert.ok(typeof regexResult.message === 'string');
  assert.ok(regexResult.message.includes('[Non-JSON value: RegExp]'));

  // Shared acyclic nodes must not be mistaken for circular
  const sharedNode = { ok: true, token: 'secret-token' };
  const sharedContainer = { first: sharedNode, second: sharedNode };
  const sanitizedShared = sanitizeStatus(sharedContainer) as Record<string, unknown>;
  const first = sanitizedShared.first as Record<string, unknown>;
  const second = sanitizedShared.second as Record<string, unknown>;
  assert.equal(first.ok, true);
  assert.equal(first.token, '[REDACTED]');
  assert.equal(second.ok, true);
  assert.equal(second.token, '[REDACTED]');
  assert.notEqual(second, '[Circular]');

  // Circular reference
  const circular: Record<string, unknown> = { name: 'cyclic' };
  circular.self = circular;
  const sanitizedCycle = sanitizeStatus(circular) as Record<string, unknown>;
  assert.equal(sanitizedCycle.name, 'cyclic');
  assert.equal(sanitizedCycle.self, '[Circular]');
  // Object with throwing getter
  const throwingObj = {};
  Object.defineProperty(throwingObj, 'broken', {
    enumerable: true,
    get() {
      throw new Error('Getter failed with token=secret_in_error');
    },
  });
  const sanitizedThrowing = sanitizeStatus(throwingObj) as Record<string, unknown>;
  assert.ok(typeof sanitizedThrowing.message === 'string');
  assert.ok(sanitizedThrowing.message.includes('[Unserializable:'));
  assert.ok(sanitizedThrowing.message.includes('token=[REDACTED]'));
});
test('sanitizeStatus: sanitizes string code, stage, kind, and logPath on Error instances', () => {
  const customErr = new Error('Custom error message');
  const errRecord = customErr as unknown as Record<string, unknown>;
  errRecord.code = 'ERR_AUTH: password=secret123';
  errRecord.stage = 'request: token=token_abc';
  errRecord.kind = 'rpc: accessToken=token_xyz';
  errRecord.logPath = '/var/log/app.log?token=secret456';

  const sanitized = sanitizeStatus(customErr) as Record<string, unknown>;
  assert.equal(sanitized.code, 'ERR_AUTH: password=[REDACTED]');
  assert.equal(sanitized.stage, 'request: token=[REDACTED]');
  assert.equal(sanitized.kind, 'rpc: accessToken=[REDACTED]');
  assert.equal(sanitized.logPath, '/var/log/app.log?token=[REDACTED]');
});

test('projectLicenseState: precedence rules enforce Expired, needs-activation, and Valid order', () => {
  // Precedence 1: Expired status
  const expired1 = projectLicenseState({
    activeLicense: { status: 'Expired', source: 'subscription' },
  });
  assert.deepEqual(expired1, {
    status: 'expired',
    source: 'subscription',
  });

  // Precedence 1: GraceExpired parked reason overrides Valid active license
  const expiredGrace = projectLicenseState({
    activeLicense: { status: 'Valid', source: 'eap' },
    parkedReason: 'GraceExpired',
  });
  assert.deepEqual(expiredGrace, {
    status: 'expired',
    source: 'eap',
    reason: 'GraceExpired',
  });

  // Precedence 1 beats Precedence 2: Expired + featuresDeclined = expired
  const expiredBeatsDeclined = projectLicenseState({
    activeLicense: { status: 'Expired', source: 'trial' },
    featuresDeclined: true,
  });
  assert.deepEqual(expiredBeatsDeclined, {
    status: 'expired',
    featuresDeclined: true,
    source: 'trial',
  });

  // Precedence 2: featuresDeclined === true -> needs-activation (overrides Valid active license)
  const needsActivation = projectLicenseState({
    activeLicense: { status: 'Valid', source: 'activationCode' },
    featuresDeclined: true,
    parkedReason: 'StartedUnlicensed',
  });
  assert.deepEqual(needsActivation, {
    status: 'needs-activation',
    featuresDeclined: true,
    source: 'activationCode',
    reason: 'StartedUnlicensed',
  });

  // Precedence 3: Valid status when featuresDeclined !== true
  const valid = projectLicenseState({
    activeLicense: { status: 'Valid', source: 'subscription' },
    featuresDeclined: false,
  });
  assert.deepEqual(valid, {
    status: 'valid',
    featuresDeclined: false,
    source: 'subscription',
  });

  // Precedence 3: Valid status when featuresDeclined is undefined
  const validNoDeclined = projectLicenseState({
    activeLicense: { status: 'Valid', source: 'trial' },
  });
  assert.deepEqual(validNoDeclined, {
    status: 'valid',
    source: 'trial',
  });
});

test('projectLicenseState: projection strictly whitelists status, featuresDeclined, source, reason', () => {
  const fullServerPayload = {
    method: 'jetbrains/licensing/state',
    params: {
      activeLicense: {
        status: 'Valid',
        source: 'subscription',
        licenseId: 'LIC-99999',
        holder: 'Jane Doe <jane@corp.com>',
        product: 'IntelliJ IDEA Ultimate',
        serverAddress: 'https://license.corp.com:8443',
        account: {
          email: 'jane@corp.com',
          accountName: 'Acme Jane',
        },
      },
      featuresDeclined: false,
      parkedReason: 'None',
      licenseServerFlowState: {
        kind: 'configured',
      },
    },
  };

  const summary = projectLicenseState(fullServerPayload);

  assert.deepEqual(summary, {
    status: 'valid',
    featuresDeclined: false,
    source: 'subscription',
    reason: 'None',
  });

  const record = summary as unknown as Record<string, unknown>;
  assert.equal(record.licenseId, undefined);
  assert.equal(record.holder, undefined);
  assert.equal(record.product, undefined);
  assert.equal(record.serverAddress, undefined);
  assert.equal(record.account, undefined);
  assert.equal(record.licenseServerFlowState, undefined);
});

test('projectLicenseState: malformed, unknown, cancelled payloads, and arbitrary status fields yield unknown', () => {
  assert.deepEqual(projectLicenseState(null), { status: 'unknown' });
  assert.deepEqual(projectLicenseState(undefined), { status: 'unknown' });
  assert.deepEqual(projectLicenseState(''), { status: 'unknown' });
  assert.deepEqual(projectLicenseState(42), { status: 'unknown' });
  assert.deepEqual(projectLicenseState({}), { status: 'unknown' });

  // Unknown statuses must not infer valid
  assert.deepEqual(projectLicenseState({ activeLicense: { status: 'Invalid' } }), {
    status: 'unknown',
  });
  assert.deepEqual(projectLicenseState({ activeLicense: { status: 'Revoked' } }), {
    status: 'unknown',
  });
  assert.deepEqual(projectLicenseState({ activeLicense: { status: 'SUCCESS' } }), {
    status: 'unknown',
  });

  // Unknown top-level fields must never infer authorization
  assert.deepEqual(projectLicenseState({ status: 'valid' }), { status: 'unknown' });
  assert.deepEqual(projectLicenseState({ status: 'expired' }), { status: 'unknown' });

  // LSP cancellation code -32800 must not infer authorization status
  assert.deepEqual(projectLicenseState({ code: -32800, message: 'Request cancelled' }), {
    status: 'unknown',
  });

  assert.ok(LICENSE_RECOVERY_GUIDANCE.includes('在受支持的 JetBrains 客户端中显式完成授权'));
});

test('RpcResponseError: preserves raw code and data in memory while keeping message and serialization sanitized', () => {
  const rawData = {
    repository: 'https://user:secret@repo.com/pkg',
    token: 'super_secret_token_123',
    module: ':core',
  };

  const error = new RpcResponseError({
    code: -32001,
    message: 'Dependency error https://user:secret@repo.com/pkg with token=super_secret_token_123',
    data: rawData,
  });

  // Message must be sanitized
  assert.equal(
    error.message,
    'Dependency error https://[REDACTED]@repo.com/pkg with token=[REDACTED]',
  );

  // In memory, raw code and raw data must be preserved for callers
  assert.equal(error.code, -32001);
  assert.equal(error.data, rawData);
  assert.equal((error.data as typeof rawData).repository, 'https://user:secret@repo.com/pkg');
  assert.equal((error.data as typeof rawData).token, 'super_secret_token_123');

  assert.ok(error instanceof Error);
  assert.ok(error instanceof RpcResponseError);
  assert.equal(error.name, 'RpcResponseError');

  // Serialization via toJSON / JSON.stringify / sanitizeStatus NEVER leaks raw secrets
  const jsonStr = JSON.stringify(error);
  assert.ok(!jsonStr.includes('super_secret_token_123'));
  assert.ok(!jsonStr.includes('user:secret'));
  assert.ok(jsonStr.includes('[REDACTED]'));
  assert.ok(jsonStr.includes(':core'));

  const sanitized = sanitizeStatus(error) as Record<string, unknown>;
  assert.equal(sanitized.name, 'RpcResponseError');
  assert.equal(sanitized.code, -32001);
  assert.equal(
    sanitized.message,
    'Dependency error https://[REDACTED]@repo.com/pkg with token=[REDACTED]',
  );
  const sanitizedData = sanitized.data as Record<string, unknown>;
  assert.equal(sanitizedData.token, '[REDACTED]');
  assert.equal(sanitizedData.repository, 'https://[REDACTED]@repo.com/pkg');
  assert.equal(sanitizedData.module, ':core');
});
