import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ProjectStateResult } from '../src/connection-state.js';
import type { ToolUpdate } from '../src/extension-types.js';
import { executeIntellij, registerIntellij } from '../src/intellij-tool.js';
import { encode, frameParser } from '../src/protocol.js';
import { createLspSession } from '../src/run-core.js';
import type { WorkspaceInfo } from '../src/workspace.js';
import { createMockPi } from './helpers.js';

test('status action on not-started returns clear next step without initiating connection', async () => {
  const readProjectState = async (): Promise<ProjectStateResult> => ({
    phase: 'not-started',
    detail: 'No active connection',
  });
  const result = await executeIntellij(
    { action: 'status' },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(result.isError, false);
  assert.equal(result.details?.phase, 'not-started');
  assert.match(result.content[0].text, /not-started/);
});

test('status action on active indexing returns phase and progress', async () => {
  const readProjectState = async (): Promise<ProjectStateResult> => ({
    phase: 'indexing',
    detail: 'Building symbol tables',
    progress: { percentage: 45, message: 'Processing symbols' },
    connectionId: 'conn-123',
  });
  const result = await executeIntellij(
    { action: 'status' },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(result.isError, false);
  assert.equal(result.details?.phase, 'indexing');
  assert.match(result.content[0].text, /phase: indexing/);
  assert.match(result.content[0].text, /Building symbol tables/);
  assert.match(result.content[0].text, /Progress: 45%/);
  assert.match(result.content[0].text, /conn-123/);
});

test('status action on failed returns error', async () => {
  const readProjectState = async (): Promise<ProjectStateResult> => ({
    phase: 'failed',
    detail: 'Fatal internal crash',
  });
  const result = await executeIntellij(
    { action: 'status' },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(result.isError, true);
  assert.equal(result.details?.phase, 'failed');
});

test('wait action when already ready returns immediately', async () => {
  let calls = 0;
  const readProjectState = async (): Promise<ProjectStateResult> => {
    calls++;
    return { phase: 'ready', detail: '', connectionId: 'conn-1' };
  };

  const result = await executeIntellij(
    { action: 'wait', timeout: 30 },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.isError, false);
  assert.equal(result.details?.phase, 'ready');
  assert.match(result.content[0].text, /ready/);
});

test('wait action when not-started returns immediately without polling (no live bridge regression)', async () => {
  let calls = 0;
  const readProjectState = async (): Promise<ProjectStateResult> => {
    calls++;
    return { phase: 'not-started', detail: 'No bridge process' };
  };

  const result = await executeIntellij(
    { action: 'wait', timeout: 30 },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.isError, false);
  assert.equal(result.details?.phase, 'not-started');
  assert.match(result.content[0].text, /not-started/);
});

test('wait action when live: false returns immediately without polling (no live bridge regression)', async () => {
  let calls = 0;
  const readProjectState = async (): Promise<ProjectStateResult> => {
    calls++;
    return { phase: 'indexing', live: false, detail: 'Prior session exited' };
  };

  const result = await executeIntellij(
    { action: 'wait', timeout: 30 },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.isError, false);
  assert.equal(result.details?.live, false);
  assert.equal(result.details?.phase, 'indexing');
  assert.match(result.content[0].text, /No active IntelliJ connection/);
});

test('wait action when disconnected returns error immediately without polling', async () => {
  let calls = 0;
  const readProjectState = async (): Promise<ProjectStateResult> => {
    calls++;
    return { phase: 'disconnected', live: false, detail: 'Socket closed unexpectedly' };
  };

  const result = await executeIntellij(
    { action: 'wait', timeout: 30 },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.isError, true);
  assert.equal(result.details?.phase, 'disconnected');
  assert.match(result.content[0].text, /disconnected/);
});

test('wait action when already failed returns error immediately without polling', async () => {
  let calls = 0;
  const readProjectState = async (): Promise<ProjectStateResult> => {
    calls++;
    return { phase: 'failed', detail: 'Process crash' };
  };

  const result = await executeIntellij(
    { action: 'wait', timeout: 30 },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.isError, true);
  assert.equal(result.details?.phase, 'failed');
  assert.match(result.content[0].text, /failed/);
  assert.match(result.content[0].text, /Process crash/);
});

test('wait action transitions from indexing to ready', async () => {
  const states: ProjectStateResult[] = [
    { phase: 'indexing', detail: 'Parsing files' },
    { phase: 'indexing', detail: 'Resolving types' },
    { phase: 'ready', detail: '' },
  ];
  let idx = 0;
  const readProjectState = async (): Promise<ProjectStateResult> => {
    const s = states[idx] || states[states.length - 1];
    idx++;
    return s;
  };

  const updates: ToolUpdate[] = [];
  const onUpdate = (u: ToolUpdate) => {
    updates.push(u);
  };

  const result = await executeIntellij(
    { action: 'wait', timeout: 10 },
    undefined,
    onUpdate,
    { cwd: '/test/proj' },
    {
      readProjectState,
      sleep: async () => {},
      pollIntervalMs: 1,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(result.isError, false);
  assert.equal(result.details?.phase, 'ready');
  assert.ok(updates.length > 0);
  assert.match(updates[0].content?.[0].text ?? '', /Waiting for IntelliJ index: indexing/);
});

test('wait action transitions from indexing to failed returns error', async () => {
  const states: ProjectStateResult[] = [
    { phase: 'indexing', detail: 'Parsing files' },
    { phase: 'failed', detail: 'Out of memory during symbol indexing' },
  ];
  let idx = 0;
  const readProjectState = async (): Promise<ProjectStateResult> => {
    const s = states[idx] || states[states.length - 1];
    idx++;
    return s;
  };

  const result = await executeIntellij(
    { action: 'wait', timeout: 10 },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      sleep: async () => {},
      pollIntervalMs: 1,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(result.isError, true);
  assert.equal(result.details?.phase, 'failed');
  assert.match(result.content[0].text, /Out of memory/);
});

test('wait action timeout returns still-indexing status without marking failure', async () => {
  const readProjectState = async (): Promise<ProjectStateResult> => ({
    phase: 'indexing',
    detail: 'Large project indexing in progress',
  });

  let simulatedTime = 1000;
  const sleep = async (ms: number) => {
    simulatedTime += ms + 5000; // deterministic jump past deadline
  };

  const result = await executeIntellij(
    { action: 'wait', timeout: 1 },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      sleep,
      now: () => simulatedTime,
      pollIntervalMs: 10,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(result.isError, false); // timeout does NOT claim project failure!
  assert.equal(result.details?.stillIndexing, true);
  assert.equal(result.details?.phase, 'indexing');
  assert.equal(result.details?.timeout, 1);
  assert.match(result.content[0].text, /timed out after 1s/);
  assert.match(result.content[0].text, /still indexing/);
});

test('wait action aborts on signal immediately', async () => {
  const controller = new AbortController();
  const readProjectState = async (): Promise<ProjectStateResult> => {
    controller.abort();
    return { phase: 'indexing', detail: 'Working' };
  };

  await assert.rejects(
    executeIntellij(
      { action: 'wait', timeout: 30 },
      controller.signal,
      undefined,
      { cwd: '/test/proj' },
      {
        readProjectState,
        sleep: async () => {},
        pollIntervalMs: 10,
        systemPath: '/fake/sys',
      },
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'AbortError');
      return true;
    },
  );
});

test('wait action avoids per-poll onUpdate spam', async () => {
  let polls = 0;
  const readProjectState = async (): Promise<ProjectStateResult> => {
    polls++;
    if (polls >= 5) {
      return { phase: 'ready', detail: '' };
    }
    return { phase: 'indexing', detail: 'Steady state' };
  };

  const updates: ToolUpdate[] = [];
  const onUpdate = (u: ToolUpdate) => {
    updates.push(u);
  };

  await executeIntellij(
    { action: 'wait', timeout: 5 },
    undefined,
    onUpdate,
    { cwd: '/test/proj' },
    {
      readProjectState,
      sleep: async () => {},
      pollIntervalMs: 1,
      systemPath: '/fake/sys',
    },
  );

  // Even though there were 4 indexing polls, onUpdate should only be emitted once for that state
  assert.equal(updates.length, 1);
});

test('registerIntellij registers tool with pi zod schema and actions', () => {
  const pi = createMockPi();
  registerIntellij(pi);

  const registeredTool = pi.getTool('intellij');
  assert.ok(registeredTool);
  assert.equal(registeredTool.name, 'intellij');
});

test('executeIntellij rejects unknown action', async () => {
  const invalidAction = 'unknown' as 'status';
  await assert.rejects(
    executeIntellij({ action: invalidAction }, undefined, undefined, { cwd: '/test/proj' }),
    /Unknown action: unknown/,
  );
});

for (const phase of ['indexing', 'ready']) {
  test(`wait stops when ${phase} loses its live connection during polling`, async () => {
    let reads = 0;
    let sleeps = 0;
    const result = await executeIntellij(
      { action: 'wait' },
      undefined,
      undefined,
      { cwd: '/test/proj' },
      {
        readProjectState: async () => {
          reads++;
          return reads === 1
            ? { phase: 'indexing', detail: 'working', live: true }
            : { phase, detail: 'prior session', live: false };
        },
        sleep: async () => {
          sleeps++;
        },
      },
    );
    assert.equal(reads, 2);
    assert.equal(sleeps, 1);
    assert.equal(result.details?.live, false);
    assert.equal(result.isError, false);
  });
}

test('status action surfaces sanitized failure and license details at surface boundary', async () => {
  const readProjectState = async (): Promise<ProjectStateResult> => ({
    phase: 'indexing',
    detail: 'Analyzing modules',
    license: {
      status: 'needs-activation',
      featuresDeclined: true,
      reason: 'Token expired: Bearer secret-tok-123',
    },
    failure: {
      kind: 'import',
      stage: 'import',
      message: 'Failed to resolve https://user:secretpass@maven.example.com/repo',
      code: -32001,
      folders: [
        {
          uri: 'file:///project/app',
          tool: 'gradle',
          status: 'FAILED',
          message: 'password=supersecret',
        },
      ],
      logPath: '/fake/sys/launcher.log',
    },
  });

  const result = await executeIntellij(
    { action: 'status' },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(result.isError, true, 'status with auth denied featuresDeclined must mark isError');
  const text = result.content[0].text;
  assert.match(text, /License status: needs-activation/);
  assert.match(text, /License features declined: true/);
  assert.match(text, /Failure kind: import/);
  assert.match(text, /Failure stage: import/);
  assert.match(text, /Failure code: -32001/);
  assert.match(text, /Launcher log: \/fake\/sys\/launcher\.log/);
  assert.match(text, /file:\/\/\/project\/app \[FAILED\]/);

  // Verify credentials were redacted at the surface
  assert.equal(text.includes('secretpass'), false);
  assert.equal(text.includes('secret-tok-123'), false);
  assert.equal(text.includes('supersecret'), false);
  assert.match(text, /\[REDACTED\]/);

  // Verify details object is sanitized
  const detailsStr = JSON.stringify(result.details);
  assert.equal(detailsStr.includes('secretpass'), false);
  assert.equal(detailsStr.includes('supersecret'), false);
});

for (const authDeniedCase of [
  {
    label: 'needs-activation',
    license: { status: 'needs-activation' as const, reason: 'License not found' },
  },
  {
    label: 'expired',
    license: { status: 'expired' as const, reason: 'Trial period expired' },
  },
  {
    label: 'featuresDeclined',
    license: { status: 'unknown' as const, featuresDeclined: true, reason: 'Feature declined' },
  },
]) {
  test(`wait action fails immediately (isError: true) when license is ${authDeniedCase.label} without polling`, async () => {
    let sleepCalls = 0;
    let readCalls = 0;
    const readProjectState = async (): Promise<ProjectStateResult> => {
      readCalls++;
      return {
        phase: 'indexing',
        detail: 'Starting index',
        license: authDeniedCase.license,
      };
    };

    const result = await executeIntellij(
      { action: 'wait', timeout: 30 },
      undefined,
      undefined,
      { cwd: '/test/proj' },
      {
        readProjectState,
        sleep: async () => {
          sleepCalls++;
        },
        systemPath: '/fake/sys',
      },
    );

    assert.equal(readCalls, 1);
    assert.equal(sleepCalls, 0, 'must not sleep or poll on active auth denial');
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /IntelliJ authorization required/);
    assert.match(result.content[0].text, /在受支持的 JetBrains 客户端中显式完成授权/);
  });
}

test('wait action with valid license alone does not bypass indexing until ready', async () => {
  const states: ProjectStateResult[] = [
    { phase: 'indexing', detail: 'Parsing files', license: { status: 'valid' } },
    { phase: 'indexing', detail: 'Resolving types', license: { status: 'valid' } },
    { phase: 'ready', detail: '', license: { status: 'valid' } },
  ];
  let callIndex = 0;
  let sleepCalls = 0;
  const readProjectState = async (): Promise<ProjectStateResult> => {
    const s = states[callIndex] || states[states.length - 1];
    callIndex++;
    return s;
  };

  const result = await executeIntellij(
    { action: 'wait', timeout: 10 },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      sleep: async () => {
        sleepCalls++;
      },
      pollIntervalMs: 1,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(result.isError, false);
  assert.equal(result.details?.phase, 'ready');
  assert.ok(
    sleepCalls >= 2,
    'valid license alone must not treat indexing phase as immediately ready',
  );
});

test('wait action with non-auth ordinary request failure in indexing phase does not fail wait', async () => {
  const states: ProjectStateResult[] = [
    {
      phase: 'indexing',
      detail: 'Indexing source roots',
      license: { status: 'valid' },
      failure: {
        kind: 'rpc',
        stage: 'request',
        message: 'Non-fatal request failed',
      },
    },
    {
      phase: 'ready',
      detail: 'Done',
      license: { status: 'valid' },
    },
  ];
  let callIdx = 0;
  const readProjectState = async (): Promise<ProjectStateResult> => {
    const s = states[callIdx] || states[states.length - 1];
    callIdx++;
    return s;
  };

  const result = await executeIntellij(
    { action: 'wait', timeout: 10 },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      sleep: async () => {},
      pollIntervalMs: 1,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(result.isError, false);
  assert.equal(result.details?.phase, 'ready');
});

test('wait action times out and reports stillIndexing with sanitized failure and license details', async () => {
  const readProjectState = async (): Promise<ProjectStateResult> => ({
    phase: 'indexing',
    detail: 'Heavy index',
    license: { status: 'valid' },
    failure: {
      kind: 'rpc',
      stage: 'request',
      message: 'token=secret-token-wait',
    },
  });

  let currentTime = 1000;
  const result = await executeIntellij(
    { action: 'wait', timeout: 5 },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      sleep: async () => {
        currentTime += 6000;
      },
      now: () => currentTime,
      pollIntervalMs: 500,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(result.isError, false);
  assert.equal(result.details?.stillIndexing, true);
  assert.equal(result.details?.timeout, 5);
  assert.match(result.content[0].text, /timed out after 5s/);
  assert.match(result.content[0].text, /still indexing: Heavy index/);
  assert.equal(result.content[0].text.includes('secret-token-wait'), false);
  assert.match(result.content[0].text, /\[REDACTED\]/);
});

test('wait action aborts on signal throwing AbortError', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    executeIntellij(
      { action: 'wait' },
      controller.signal,
      undefined,
      { cwd: '/test/proj' },
      {
        readProjectState: async () => ({ phase: 'indexing', detail: 'Running' }),
        sleep: async () => {},
      },
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'AbortError');
      return true;
    },
  );
});

test('status action includes minimal structured workspace context and redacts secrets', async () => {
  const readProjectState = async (): Promise<ProjectStateResult> => ({
    phase: 'ready',
    detail: 'Indexed',
    live: true,
  });
  const getWorkspaceInfo = async (): Promise<WorkspaceInfo> => ({
    projectRoot: '/test/proj',
    canonicalPath: '/test/proj',
    nativePath: '/test/proj',
    rootUri: 'file:///test/proj',
    projectType: 'maven',
    savedJdk: '/opt/jdks/jdk-21',
    savedVersion: '21.0.2',
    appliedJdk: '/opt/jdks/jdk-21',
    isApplied: true,
    savedEnvKeys: ['GRADLE_OPTS', 'SECRET_TOKEN'],
    maskedEnv: { GRADLE_OPTS: '***', SECRET_TOKEN: '***' },
    lastReady: Date.now(),
    lastConnected: Date.now(),
    hasLspRecorded: true,
  });

  const result = await executeIntellij(
    { action: 'status' },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      getWorkspaceInfo,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(result.isError, false);
  assert.equal(result.details?.workspace?.projectType, 'maven');
  assert.equal(result.details?.workspace?.savedJdk, '/opt/jdks/jdk-21');
  assert.equal(result.details?.workspace?.appliedJdk, '/opt/jdks/jdk-21');
  assert.equal(result.details?.workspace?.isApplied, true);
  assert.deepEqual(result.details?.workspace?.savedEnvKeys, ['GRADLE_OPTS', 'SECRET_TOKEN']);

  const text = result.content[0].text;
  assert.match(text, /Project type: maven/);
  assert.match(text, /Configured JDK: \/opt\/jdks\/jdk-21/);
  assert.match(text, /Applied JDK: \/opt\/jdks\/jdk-21/);
  assert.match(text, /JDK applied: yes/);
  assert.match(text, /Configured env variables: GRADLE_OPTS, SECRET_TOKEN/);
  // Verify NO secret values leaked
  assert.equal(text.includes('***'), false);
  assert.equal(JSON.stringify(result.details).includes('***'), false);
});

test('status action failure does not conceal errors as success when workspace context exists', async () => {
  const readProjectState = async (): Promise<ProjectStateResult> => ({
    phase: 'failed',
    detail: 'Build tool crashed',
    live: false,
  });
  const getWorkspaceInfo = async (): Promise<WorkspaceInfo> => ({
    projectRoot: '/test/proj',
    canonicalPath: '/test/proj',
    nativePath: '/test/proj',
    rootUri: 'file:///test/proj',
    projectType: 'gradle',
    savedJdk: '/opt/jdks/jdk-17',
    savedVersion: '17.0.2',
    appliedJdk: '/opt/jdks/jdk-17',
    isApplied: true,
    savedEnvKeys: ['JAVA_HOME'],
    maskedEnv: { JAVA_HOME: '***' },
    lastReady: Date.now(),
    lastConnected: Date.now(),
    hasLspRecorded: true,
  });

  const result = await executeIntellij(
    { action: 'status' },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      readProjectState,
      getWorkspaceInfo,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(result.isError, true);
  assert.equal(result.details?.phase, 'failed');
  assert.equal(result.details?.workspace?.projectType, 'gradle');
});

test('reload action converts timeout seconds to ms and returns structured result', async () => {
  let receivedTimeoutMs: number | undefined;
  const reimportWorkspace = async (
    _root: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => {
    receivedTimeoutMs = options?.timeoutMs;
    return {
      ready: true,
      projectRoot: '/test/proj',
      canonicalPath: '/test/proj',
      appliedJdk: '/opt/jdks/jdk-21',
      submittedEnvKeys: ['GRADLE_OPTS'],
      elapsedMs: 1234,
    };
  };
  const readProjectState = async (): Promise<ProjectStateResult> => ({
    phase: 'ready',
    detail: 'Ready after reload',
    live: true,
  });
  const getWorkspaceInfo = async (): Promise<WorkspaceInfo> => ({
    projectRoot: '/test/proj',
    canonicalPath: '/test/proj',
    nativePath: '/test/proj',
    rootUri: 'file:///test/proj',
    projectType: 'maven',
    savedJdk: '/opt/jdks/jdk-21',
    savedVersion: '21.0.2',
    appliedJdk: '/opt/jdks/jdk-21',
    isApplied: true,
    savedEnvKeys: ['GRADLE_OPTS'],
    maskedEnv: { GRADLE_OPTS: '***' },
    lastReady: Date.now(),
    lastConnected: Date.now(),
    hasLspRecorded: true,
  });

  const result = await executeIntellij(
    { action: 'reload', timeout: 45 },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      reimportWorkspace,
      readProjectState,
      getWorkspaceInfo,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(receivedTimeoutMs, 45000);
  assert.equal(result.isError, false);
  assert.equal(result.details?.reloaded, true);
  assert.equal(result.details?.elapsedMs, 1234);
  assert.equal(result.details?.workspace?.projectType, 'maven');
  assert.deepEqual(result.details?.workspace?.submittedEnvKeys, ['GRADLE_OPTS']);
  assert.match(result.content[0].text, /reloaded successfully/);
  assert.match(result.content[0].text, /Submitted env variables: GRADLE_OPTS/);
});

test('reload action aborts on signal throwing AbortError', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    executeIntellij(
      { action: 'reload' },
      controller.signal,
      undefined,
      { cwd: '/test/proj' },
      {
        reimportWorkspace: async () => ({
          ready: true,
          projectRoot: '/test/proj',
          canonicalPath: '/test/proj',
          appliedJdk: null,
        }),
        readProjectState: async () => ({ phase: 'ready', detail: 'Ready' }),
      },
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'AbortError');
      return true;
    },
  );
});

test('reload action timeout returns error and does not fake success', async () => {
  const timeoutError = Object.assign(new Error('Operation timed out after 3000ms'), {
    code: 'ETIMEDOUT',
  });
  const reimportWorkspace = async () => {
    throw timeoutError;
  };
  const readProjectState = async (): Promise<ProjectStateResult> => ({
    phase: 'importing',
    detail: 'Import stuck',
    live: true,
  });

  const result = await executeIntellij(
    { action: 'reload', timeout: 3 },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      reimportWorkspace,
      readProjectState,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(result.isError, true);
  assert.equal(result.details?.reloaded, false);
  assert.equal(result.details?.failure?.kind, 'timeout');
  assert.equal(result.details?.failure?.code, 'ETIMEDOUT');
  assert.match(result.content[0].text, /timed out after 3s/);
});

test('reload action failure surfaces sanitized raw failure and does not fake success', async () => {
  const rawError = Object.assign(
    new Error('Sync failed with token: secret-token-xyz and Bearer auth-token-999'),
    { code: 500 },
  );
  const reimportWorkspace = async () => {
    throw rawError;
  };
  const readProjectState = async (): Promise<ProjectStateResult> => ({
    phase: 'failed',
    detail: 'Failure detail',
    live: false,
  });

  const result = await executeIntellij(
    { action: 'reload' },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      reimportWorkspace,
      readProjectState,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(result.isError, true);
  assert.equal(result.details?.reloaded, false);
  assert.equal(result.details?.failure?.kind, 'import');
  assert.equal(result.details?.failure?.code, 500);
  assert.match(result.content[0].text, /failed for project/);
  assert.equal(result.content[0].text.includes('secret-token-xyz'), false);
  assert.equal(result.content[0].text.includes('auth-token-999'), false);
  assert.match(result.content[0].text, /\[REDACTED\]/);
});

test('reload action with auth denial returns error immediately without attempting reimport', async () => {
  let reimportCalled = false;
  const reimportWorkspace = async () => {
    reimportCalled = true;
    return {
      ready: true,
      projectRoot: '/test/proj',
      canonicalPath: '/test/proj',
      appliedJdk: null,
    };
  };
  const readProjectState = async (): Promise<ProjectStateResult> => ({
    phase: 'failed',
    detail: 'Auth denied',
    live: true,
    license: {
      status: 'needs-activation',
      reason: 'No license found',
    },
  });

  const result = await executeIntellij(
    { action: 'reload' },
    undefined,
    undefined,
    { cwd: '/test/proj' },
    {
      reimportWorkspace,
      readProjectState,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(reimportCalled, false);
  assert.equal(result.isError, true);
  assert.equal(result.details?.reloaded, false);
  assert.match(result.content[0].text, /authorization required/);
});

test('reload action emits onUpdate progress', async () => {
  const updates: ToolUpdate[] = [];
  const onUpdate = (u: ToolUpdate) => {
    updates.push(u);
  };
  const reimportWorkspace = async () => ({
    ready: true,
    projectRoot: '/test/proj',
    canonicalPath: '/test/proj',
    appliedJdk: null,
  });
  const readProjectState = async (): Promise<ProjectStateResult> => ({
    phase: 'ready',
    detail: 'Ready',
    live: true,
  });
  await executeIntellij(
    { action: 'reload' },
    undefined,
    onUpdate,
    { cwd: '/test/proj' },
    {
      reimportWorkspace,
      readProjectState,
      systemPath: '/fake/sys',
    },
  );

  assert.equal(updates.length, 1);
  assert.match(updates[0].content?.[0]?.text || '', /Reloading IntelliJ workspace model/);
});

test('fixture: reload action exercises actual session reload protocol with model update, cancel, and fail', async (t: TestContext) => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'omp-index-reload-test-'));
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));

  const systemPath = join(tmpRoot, 'system');
  const projectDir = join(tmpRoot, 'project');
  const configDir = join(tmpRoot, 'config');
  await mkdir(systemPath, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(configDir, { recursive: true });

  const pomPath = join(projectDir, 'pom.xml');
  await writeFile(
    pomPath,
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>demo</artifactId><version>1.0.0</version></project>',
    'utf8',
  );

  const reloadRequests: Array<{ method: string; params: unknown; id: number }> = [];
  let shouldFailReload = false;
  let delayReload = false;
  let currentModelVersion = '1.0.0';
  const { promise: thirdReloadReceived, resolve: resolveThirdReload } =
    Promise.withResolvers<void>();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});

    socket.on(
      'data',
      frameParser(async (rawMsg: unknown) => {
        const msg = rawMsg as { id?: number; method?: string; params?: unknown };
        if (!msg || typeof msg !== 'object') return;

        if (msg.method === 'initialize' && msg.id !== undefined) {
          socket.write(encode({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }));
          setImmediate(() => {
            socket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));
          });
        } else if (msg.method === 'workspace/symbol' && msg.id !== undefined) {
          const isV2 = currentModelVersion === '2.0.0-SNAPSHOT';
          const symbols = isV2
            ? [
                { name: 'DemoServiceV2', kind: 12, containerName: 'com.example.demo' },
                { name: 'JUnitRunner', kind: 12, containerName: 'org.junit' },
              ]
            : [{ name: 'DemoServiceV1', kind: 12, containerName: 'com.example.demo' }];
          socket.write(encode({ jsonrpc: '2.0', id: msg.id, result: symbols }));
        } else if (msg.method === 'intellij/reloadWorkspace' && msg.id !== undefined) {
          reloadRequests.push({ method: msg.method, params: msg.params, id: msg.id });
          if (reloadRequests.length === 3) {
            resolveThirdReload();
          }
          if (shouldFailReload) {
            socket.write(
              encode({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32603, message: 'Invalid pom.xml: parse failure at line 4' },
              }),
            );
            return;
          }

          if (delayReload) {
            return;
          }

          try {
            const pomContent = await readFile(pomPath, 'utf8');
            currentModelVersion = pomContent.includes('2.0.0-SNAPSHOT')
              ? '2.0.0-SNAPSHOT'
              : '1.0.0';
          } catch {}

          socket.write(encode({ jsonrpc: '2.0', id: msg.id, result: { success: true } }));
          setImmediate(() => {
            socket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));
          });
        } else if (msg.id !== undefined) {
          socket.write(encode({ jsonrpc: '2.0', id: msg.id, result: {} }));
        }
      }),
    );
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;

  t.after(() => {
    for (const s of sockets) {
      try {
        s.destroy();
      } catch {}
    }
    server.close();
  });

  await writeFile(join(systemPath, 'server.port'), String(port), 'utf8');
  await writeFile(
    join(systemPath, 'omp-server.json'),
    JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }),
    'utf8',
  );

  // 1. Initial reload: triggers initialize + intellij/reloadWorkspace protocol
  const initialResult = await executeIntellij(
    { action: 'reload', project: projectDir, timeout: 10 },
    undefined,
    undefined,
    { cwd: projectDir },
    { systemPath, configDir },
  );

  assert.equal(initialResult.isError, false);
  assert.equal(initialResult.details?.reloaded, true);
  assert.equal(initialResult.details?.workspace?.projectType, 'maven');
  assert.equal(reloadRequests.length, 1);
  assert.match(initialResult.content[0].text, /reloaded successfully/);

  // Verify consumer query against initial v1 model
  const session1 = await createLspSession(projectDir, { systemPath, configDir });
  const symbols1Raw = await session1.request('workspace/symbol', { query: '' });
  await session1.close();
  const symbols1 = symbols1Raw as Array<{ name: string }>;
  assert.equal(
    symbols1.some((s) => s.name === 'DemoServiceV1'),
    true,
  );
  assert.equal(
    symbols1.some((s) => s.name === 'DemoServiceV2'),
    false,
  );

  // 2. Modify build file -> reload again -> queries use fresh model
  await writeFile(
    pomPath,
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>demo</artifactId><version>2.0.0-SNAPSHOT</version><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version></dependency></dependencies></project>',
    'utf8',
  );

  const updatedResult = await executeIntellij(
    { action: 'reload', project: projectDir, timeout: 10 },
    undefined,
    undefined,
    { cwd: projectDir },
    { systemPath, configDir },
  );

  assert.equal(updatedResult.isError, false);
  assert.equal(updatedResult.details?.reloaded, true);
  assert.equal(reloadRequests.length, 2);

  // Verify consumer query against updated v2 model: new symbols appear, old symbols disappear
  const session2 = await createLspSession(projectDir, { systemPath, configDir });
  const symbols2Raw = await session2.request('workspace/symbol', { query: '' });
  await session2.close();
  const symbols2 = symbols2Raw as Array<{ name: string }>;
  assert.equal(
    symbols2.some((s) => s.name === 'DemoServiceV2'),
    true,
  );
  assert.equal(
    symbols2.some((s) => s.name === 'JUnitRunner'),
    true,
  );
  assert.equal(
    symbols2.some((s) => s.name === 'DemoServiceV1'),
    false,
  );
  // 3. Model reload cancellation via AbortSignal
  delayReload = true;
  const ac = new AbortController();
  const cancelPromise = executeIntellij(
    { action: 'reload', project: projectDir, timeout: 10 },
    ac.signal,
    undefined,
    { cwd: projectDir },
    { systemPath, configDir },
  );

  await thirdReloadReceived;
  ac.abort();

  await assert.rejects(cancelPromise, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'AbortError');
    return true;
  });
  delayReload = false;

  // 4. Model reload timeout via overall deadline in fixture
  delayReload = true;
  const timeoutResult = await executeIntellij(
    { action: 'reload', project: projectDir, timeout: 1 },
    undefined,
    undefined,
    { cwd: projectDir },
    { systemPath, configDir },
  );
  assert.equal(timeoutResult.isError, true);
  assert.equal(timeoutResult.details?.reloaded, false);
  assert.equal(timeoutResult.details?.failure?.kind, 'timeout');
  assert.equal(timeoutResult.details?.failure?.code, 'ETIMEDOUT');
  delayReload = false;

  // 5. Model reload failure with sanitized raw projection
  shouldFailReload = true;
  const failResult = await executeIntellij(
    { action: 'reload', project: projectDir, timeout: 10 },
    undefined,
    undefined,
    { cwd: projectDir },
    { systemPath, configDir },
  );

  assert.equal(failResult.isError, true);
  assert.equal(failResult.details?.reloaded, false);
  assert.equal(failResult.details?.failure?.code, -32603);
  assert.match(failResult.content[0].text, /Invalid pom\.xml: parse failure/);
});
