import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectStateResult } from '../src/connection-state.js';
import type { ToolUpdate } from '../src/extension-types.js';
import { executeIntellijIndex, registerIntellijIndex } from '../src/index-tool.js';
import { createMockPi } from './helpers.js';

test('status action on not-started returns clear next step without initiating connection', async () => {
  const readProjectState = async (): Promise<ProjectStateResult> => ({
    phase: 'not-started',
    detail: 'No active connection',
  });
  const result = await executeIntellijIndex(
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
  const result = await executeIntellijIndex(
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
  const result = await executeIntellijIndex(
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

  const result = await executeIntellijIndex(
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

  const result = await executeIntellijIndex(
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

  const result = await executeIntellijIndex(
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

  const result = await executeIntellijIndex(
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

  const result = await executeIntellijIndex(
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

  const result = await executeIntellijIndex(
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

  const result = await executeIntellijIndex(
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

  const result = await executeIntellijIndex(
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
    executeIntellijIndex(
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

  await executeIntellijIndex(
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

test('registerIntellijIndex registers tool with pi zod schema and read approval', () => {
  const pi = createMockPi();
  registerIntellijIndex(pi);

  const registeredTool = pi.getTool('intellij_index');
  assert.ok(registeredTool);
  assert.equal(registeredTool.name, 'intellij_index');
  assert.equal(registeredTool.approval, 'read');
});

test('executeIntellijIndex rejects unknown action', async () => {
  const invalidAction = 'unknown' as 'status';
  await assert.rejects(
    executeIntellijIndex({ action: invalidAction }, undefined, undefined, { cwd: '/test/proj' }),
    /Unknown action: unknown/,
  );
});

for (const phase of ['indexing', 'ready']) {
  test(`wait stops when ${phase} loses its live connection during polling`, async () => {
    let reads = 0;
    let sleeps = 0;
    const result = await executeIntellijIndex(
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

  const result = await executeIntellijIndex(
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

    const result = await executeIntellijIndex(
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

  const result = await executeIntellijIndex(
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

  const result = await executeIntellijIndex(
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
  const result = await executeIntellijIndex(
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
    executeIntellijIndex(
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
