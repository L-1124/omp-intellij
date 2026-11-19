import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { DapSessionManager } from '@oh-my-pi/pi-coding-agent/dap/session';
import { resolveAdapter } from '@oh-my-pi/pi-coding-agent/dap/config';
import { injectPluginDirRoots } from '@oh-my-pi/pi-coding-agent/discovery/helpers';

const options = JSON.parse(process.argv[2]);
const manager = new DapSessionManager();
const startup = new AbortController();
const terminated = Promise.withResolvers();
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line === 'cancel') startup.abort(new Error('Fixture cancelled host startup'));
  else if (line === 'terminate') terminated.resolve();
});
input.once('close', () => terminated.resolve());
await import('../../src/plugin.ts');
await injectPluginDirRoots(
  join(options.cwd, '.omp', 'host-home'),
  [fileURLToPath(new URL('../../', import.meta.url))],
  options.cwd,
);
await mkdir(join(options.cwd, '.omp'), { recursive: true });
await writeFile(
  join(options.cwd, '.omp', 'dap.json'),
  JSON.stringify({
    adapters: {
      intellij: {
        launchDefaults: options.launchDefaults ?? {},
        attachDefaults: options.attachDefaults ?? {},
      },
    },
  }),
);
const adapter = resolveAdapter('intellij', options.cwd);
assert.ok(adapter, 'The installed plugin must resolve its built-in intellij adapter');
let failure;
try {
  process.stdout.write(`${JSON.stringify({ event: 'starting' })}\n`);
  const session =
    options.mode === 'attach'
      ? await manager.attach(
          { adapter, cwd: options.cwd, port: options.port, host: options.host },
          startup.signal,
          120000,
        )
      : await manager.launch(
          { adapter, cwd: options.cwd, program: options.program ?? '' },
          startup.signal,
          120000,
        );
  const capabilities = manager.getCapabilities();
  assert.equal(capabilities?.supportsTerminateRequest, false);
  assert.equal(capabilities?.supportsCancelRequest, false);
  if (options.breakpoint) {
    await manager.setBreakpoint(options.breakpoint.file, options.breakpoint.line);
    const deadline = Date.now() + 15000;
    while (manager.getActiveSession()?.status !== 'stopped') {
      assert.ok(Date.now() < deadline, 'OMP host must observe the fixture breakpoint');
      await sleep(20);
    }
    const stack = await manager.stackTrace(10);
    assert.ok(stack.stackFrames.length > 0);
  }
  const threads = await manager.threads();
  assert.ok(threads.threads.length > 0);
  process.stdout.write(
    `${JSON.stringify({
      event: 'ready',
      adapter: { name: adapter.name, command: adapter.resolvedCommand, args: adapter.args },
      session,
      capabilities,
      threads: threads.threads,
    })}\n`,
  );
  await terminated.promise;
} catch (error) {
  failure = error;
  process.stdout.write(`${JSON.stringify({ event: 'failure', message: String(error) })}\n`);
} finally {
  input.close();
  await manager.terminate(undefined, 30000);
  assert.equal(manager.listSessions().length, 0);
  process.stdout.write(
    `${JSON.stringify({ event: 'closed', sessions: manager.listSessions() })}\n`,
  );
}
if (failure) throw failure;
