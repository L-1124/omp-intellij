import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import extension from '../src/extension.js';
import { formatStatusText, sanitizeDetail } from '../src/install-status.js';
import { createMockCtx, createMockPi } from './helpers.js';

test('session_start ignores subagents', async () => {
  const pi = createMockPi();
  extension(pi);

  const ctx = createMockCtx('/fake/dir', { agent: { kind: 'sub' } });
  pi.emit('session_start', {}, ctx);

  assert.equal(ctx.statusCalls.length, 0);
  assert.equal(ctx.notifications.length, 0);
});

test('status text stays single-line, bounded, and undecorated', () => {
  const text = formatStatusText('indexing', 'Project import in progress\nsecond line\tthird', {
    percentage: 42.4,
  });
  assert.equal(text.includes('\n'), false);
  assert.equal(text.includes('\t'), false);
  assert.match(text, /^IntelliJ indexing/);
  assert.match(text, /42%/);
  assert.ok(text.length < 130);
  assert.equal(text.includes(`${String.fromCharCode(27)}[`), false);
});

test('long details are truncated and whitespace collapsed', () => {
  const longText = 'a'.repeat(200);
  const sanitized = sanitizeDetail(longText, 50);
  assert.equal(sanitized.length, 50);
  assert.ok(sanitized.endsWith('…'));

  const withSpaces = sanitizeDetail('  hello   world  \n\t next  ');
  assert.equal(withSpaces, 'hello world next');
});

test('formatStatusText avoids duplicate percentage prefix', () => {
  const textWithDup = formatStatusText('indexing', '42% - indexing symbols', { percentage: 42 });
  assert.equal(textWithDup.includes('42% - 42%'), false);
  assert.match(textWithDup, /IntelliJ indexing \(42% - indexing symbols\)/);

  const textWithoutDup = formatStatusText('indexing', 'indexing symbols', { percentage: 42 });
  assert.match(textWithoutDup, /IntelliJ indexing \(42% - indexing symbols\)/);
});

test('extension startup and shutdown are idempotent without noisy status writes', async () => {
  const pi = createMockPi();
  extension(pi);
  const base = join(tmpdir(), 'omp-ui-idem-' + Math.random().toString(36).slice(2));
  await mkdir(base, { recursive: true });
  await writeFile(join(base, 'pom.xml'), '<project></project>', 'utf8');
  try {
    const ctx = createMockCtx(base);
    pi.emit('session_start', {}, ctx);
    pi.emit('session_start', {}, ctx);
    const beforeShutdown = ctx.statusCalls.length;
    pi.emit('session_shutdown');
    pi.emit('session_shutdown');
    const after = ctx.statusCalls.slice(beforeShutdown);

    for (const call of after) {
      assert.equal(call.key, 'intellij-index');
      assert.equal(typeof call.value, 'string');
    }
    assert.equal(
      after.filter((c) => c.value !== '').length,
      0,
      'shutdown must leave no visible status text',
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
