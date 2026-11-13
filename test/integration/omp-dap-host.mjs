import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { DapSessionManager } from '@oh-my-pi/pi-coding-agent/dap/session';

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
const adapter = {
  name: 'intellij',
  command: options.nodeExecutable,
  resolvedCommand: options.nodeExecutable,
  args: [options.proxyScript],
  languages: ['java', 'kotlin'],
  fileTypes: ['.java', '.kt'],
  rootMarkers: ['settings.gradle', 'settings.gradle.kts'],
  launchDefaults: options.launchDefaults ?? {},
  attachDefaults: options.attachDefaults ?? {},
  connectMode: 'stdio',
  acceptsDirectoryProgram: false,
};
let failure;
try {
  process.stdout.write(`${JSON.stringify({ event: 'starting' })}\n`);
  const session = options.mode === 'attach'
    ? await manager.attach({ adapter, cwd: options.cwd, port: options.port, host: options.host }, startup.signal, 120000)
    : await manager.launch({ adapter, cwd: options.cwd, program: options.program ?? '' }, startup.signal, 120000);
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
    const scopes = await manager.scopes(stack.stackFrames[0].id);
    const locals = scopes.scopes.find((scope) => /local/i.test(scope.name)) ?? scopes.scopes[0];
    assert.ok(locals?.variablesReference > 0);
    const variables = await manager.variables(locals.variablesReference);
    assert.ok(variables.variables.some((variable) => variable.name === 'before'));
    await manager.stepOver();
  }
  const threads = await manager.threads();
  assert.ok(threads.threads.length > 0);
  process.stdout.write(`${JSON.stringify({ event: 'ready', session, capabilities, threads: threads.threads })}\n`);
  await terminated.promise;
} catch (error) {
  failure = error;
  process.stdout.write(`${JSON.stringify({ event: 'failure', message: String(error) })}\n`);
} finally {
  input.close();
  await manager.terminate(undefined, 30000);
  assert.equal(manager.listSessions().length, 0);
  process.stdout.write(`${JSON.stringify({ event: 'closed', sessions: manager.listSessions() })}\n`);
}
if (failure) throw failure;
