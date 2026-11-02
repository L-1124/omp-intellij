import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  connectionCloseState,
  createConnectionState,
  readProjectState,
} from '../src/connection-state.js';

test('connection reset preserves the cause without marking project import failed', async () => {
  const systemPath = await mkdtemp(join(tmpdir(), 'intellij-reset-'));
  try {
    const root = join(systemPath, 'project');
    const connection = createConnectionState({ systemPath });
    await connection.update({ root, phase: 'ready' });
    const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    await connection.close(connectionCloseState(error));
    const snapshot = await readProjectState(systemPath, root);
    assert.equal(snapshot.phase, 'disconnected');
    assert.equal(snapshot.live, false);
    assert.equal(snapshot.detail, 'read ECONNRESET');
  } finally {
    await rm(systemPath, { recursive: true, force: true });
  }
});

test('protocol and handshake failures remain failures', () => {
  assert.deepEqual(connectionCloseState(new Error('IntelliJ initialize handshake timed out')), {
    phase: 'failed',
    detail: 'IntelliJ initialize handshake timed out',
  });
});
