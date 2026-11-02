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
