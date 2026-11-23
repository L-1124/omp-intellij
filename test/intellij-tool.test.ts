import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as zod from '@oh-my-pi/omptype/zod';
import type { AgentToolResult } from '@oh-my-pi/pi-coding-agent';
import {
  executeIntellij,
  type IntellijDetails,
  registerIntellij,
} from '../src/extension/intellij-tool.js';
import type { ProjectStateResult } from '../src/project/connection-state.js';

const ctx = { cwd: process.cwd() };
const project = '.';
const ready = { phase: 'ready', detail: '', live: true };
const indexing = { phase: 'indexing', detail: 'Indexing modules', live: true };

function unexpectedCall(): never {
  assert.fail('Cancelled action should not reach this operation');
}

test('intellij registration declares exec approval and bounded side-effect guidance', () => {
  let registered = false;
  registerIntellij({
    zod,
    registerTool(tool) {
      registered = true;
      assert.equal(tool.name, 'intellij');
      assert.equal(tool.approval, 'exec');
      assert.ok(tool.description.length < 200);
      assert.match(tool.description, /doctor, status and wait do not start the service/i);
      assert.match(tool.description, /model connects.*without building or running/i);
      assert.match(tool.description, /reload reimports the project/i);
    },
  });
  assert.equal(registered, true);
});

for (const action of ['status', 'wait'] as const) {
  test(`${action} checks cancellation before reading state`, async () => {
    const signal = AbortSignal.abort(new Error('Stopped by caller'));
    await assert.rejects(
      executeIntellij({ action, project }, signal, undefined, ctx, {
        readProjectState: unexpectedCall,
      }),
      { name: 'AbortError' },
    );
  });

  test(`${action} checks cancellation before using a terminal initial snapshot`, async () => {
    const controller = new AbortController();
    await assert.rejects(
      executeIntellij({ action, project }, controller.signal, undefined, ctx, {
        async readProjectState() {
          controller.abort(new Error('Stopped while reading'));
          return ready;
        },
        getWorkspaceInfo: unexpectedCall,
      }),
      { name: 'AbortError' },
    );
  });
}

test('status checks cancellation after lookup even when workspace metadata fails', async () => {
  const controller = new AbortController();
  await assert.rejects(
    executeIntellij({ action: 'status', project }, controller.signal, undefined, ctx, {
      readProjectState: async () => ready,
      async getWorkspaceInfo() {
        controller.abort();
        throw new Error('Metadata unavailable');
      },
    }),
    { name: 'AbortError' },
  );
});

test('wait checks cancellation after a poll sleep before reading again', async () => {
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(
    executeIntellij({ action: 'wait', project }, controller.signal, undefined, ctx, {
      async readProjectState() {
        assert.equal(++reads, 1);
        return indexing;
      },
      async sleep(_ms, signal) {
        assert.equal(signal, controller.signal);
        controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
});

test('wait does not return ready when cancelled during a poll read', async () => {
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(
    executeIntellij({ action: 'wait', project }, controller.signal, undefined, ctx, {
      async readProjectState() {
        if (++reads === 1) return indexing;
        controller.abort(new Error('Stopped during polling'));
        return ready;
      },
      sleep: async () => {},
    }),
    { name: 'AbortError' },
  );
});

test('wait does not poll if the progress callback cancels', async () => {
  const controller = new AbortController();
  await assert.rejects(
    executeIntellij({ action: 'wait', project }, controller.signal, () => controller.abort(), ctx, {
      readProjectState: async () => indexing,
      sleep: unexpectedCall,
    }),
    { name: 'AbortError' },
  );
});

test('wait emits sanitized progress and deduplicates exactly the reported fields', async () => {
  const initial = {
    title: 'Indexing https://user:title-secret@example.com',
    message: 'token=message-secret',
    percentage: 0,
    token: 'opaque-progress-secret',
  };
  const states: ProjectStateResult[] = [
    { ...indexing, progress: initial },
    {
      ...indexing,
      progress: { ...initial, message: 'token=changed-secret', token: 'another-opaque-secret' },
    },
    { ...indexing, progress: { ...initial, message: 'Resolving modules' } },
    { ...indexing, progress: { ...initial, message: 'Resolving modules', title: 'Scan' } },
    {
      ...indexing,
      progress: { ...initial, message: 'Resolving modules', title: 'Scan', percentage: 15 },
    },
    ready,
  ];
  const updates: AgentToolResult<IntellijDetails>[] = [];
  const result = await executeIntellij(
    { action: 'wait', project },
    undefined,
    (update) => updates.push(update),
    ctx,
    {
      async readProjectState() {
        const state = states.shift();
        assert.ok(state);
        return state;
      },
      sleep: async () => {},
      now: () => 0,
    },
  );
  const safeTitle = 'Indexing https://[REDACTED]@example.com';
  assert.deepEqual(
    updates.map((update) => update.details?.progress),
    [
      { title: safeTitle, message: 'token=[REDACTED]', percentage: 0 },
      { title: safeTitle, message: 'Resolving modules', percentage: 0 },
      { title: 'Scan', message: 'Resolving modules', percentage: 0 },
      { title: 'Scan', message: 'Resolving modules', percentage: 15 },
    ],
  );
  for (const update of updates) {
    const progress = update.details?.progress;
    const text = update.content[0];
    assert.ok(progress && text?.type === 'text');
    assert.ok(text.text.includes(`Progress title: ${progress.title}`));
    assert.ok(text.text.includes(`Progress message: ${progress.message}`));
    assert.ok(text.text.includes(`Progress: ${progress.percentage}%`));
  }
  assert.doesNotMatch(JSON.stringify(updates), /secret/);
  assert.equal(result.details.phase, 'ready');
  assert.equal(result.isError, false);
});

test('wait retains timeout and inactive-bridge result semantics', async () => {
  let time = 0;
  const timedOut = await executeIntellij(
    { action: 'wait', project, timeout: 1 },
    undefined,
    undefined,
    ctx,
    {
      readProjectState: async () => indexing,
      pollIntervalMs: 1000,
      now: () => time,
      async sleep(ms) {
        time += ms;
      },
    },
  );
  assert.equal(timedOut.details.phase, 'indexing');
  assert.equal(timedOut.details.stillIndexing, true);
  assert.equal(timedOut.details.timeout, 1);
  assert.equal(timedOut.isError, false);

  const inactive = await executeIntellij({ action: 'wait', project }, undefined, undefined, ctx, {
    readProjectState: async () => ({ ...indexing, live: false }),
    sleep: unexpectedCall,
  });
  assert.equal(inactive.details.live, false);
  assert.match(inactive.content[0]?.text ?? '', /last bridge connection closed/);
  assert.equal(inactive.isError, false);
});
