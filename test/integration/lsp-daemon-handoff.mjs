// Run with Bun against the installed OMP SDK.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function serveFixture() {
  const instance = randomUUID();
  const documents = new Set();
  let initializes = 0;
  let pending = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]);
    while (true) {
      const headerEnd = pending.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = pending.toString('ascii', 0, headerEnd);
      const length = Number(/^Content-Length: (\d+)$/im.exec(header)?.[1]);
      assert.ok(Number.isSafeInteger(length), `Invalid LSP header: ${header}`);
      const end = headerEnd + 4 + length;
      if (pending.length < end) break;
      const { id, method, params } = JSON.parse(pending.toString('utf8', headerEnd + 4, end));
      pending = pending.subarray(end);
      if (method === 'exit') return;
      if (method === 'textDocument/didOpen') documents.add(params.textDocument.uri);
      if (method === 'textDocument/didClose') documents.delete(params.textDocument.uri);
      if (id === undefined) continue;
      let reply;
      switch (method) {
        case 'initialize':
          initializes++;
          reply = { result: { capabilities: { textDocumentSync: 1 } } };
          break;
        case 'fixture/state':
          reply = { result: { instance, initializes, documents: [...documents] } };
          break;
        case 'shutdown':
          reply = { result: null };
          break;
        default:
          reply = { error: { code: -32601, message: `Unknown method: ${method}` } };
      }
      const body = JSON.stringify({ jsonrpc: '2.0', id, ...reply });
      process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
  }
}

async function checkHandoff() {
  assert.ok(process.versions.bun, 'Run this regression with Bun');
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'omp19-lsp-handoff-')));
  // Do not let SDK bootstrap see an inherited daemon or a named user profile.
  delete process.env.OMP_DAEMON_TCP;
  delete process.env.OMP_DAEMON_DIR;
  delete process.env.OMP_DAEMON_RESUME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  process.env.PI_CODING_AGENT_DIR = join(cwd, 'agent');
  process.env.XDG_CONFIG_HOME = join(cwd, 'config');
  process.env.XDG_CACHE_HOME = join(cwd, 'cache');
  process.env.XDG_DATA_HOME = join(cwd, 'data');
  process.env.XDG_STATE_HOME = join(cwd, 'state');
  const { closeDaemonClient, daemonClient, isolateDaemonForSmokeTest } = await import(
    '@oh-my-pi/pi-coding-agent/daemon/client'
  );
  const stopDaemon = await isolateDaemonForSmokeTest();
  try {
    const {
      getOrCreateClient,
      holdSharedLsp,
      sendNotification,
      sendRequest,
      shutdownAll,
      shutdownClientInstance,
    } = await import('@oh-my-pi/pi-coding-agent/lsp/client');
    const mode = holdSharedLsp(true);
    try {
      const config = {
        command: process.execPath,
        args: [fileURLToPath(import.meta.url), '--fixture'],
        fileTypes: ['.handoff'],
        rootMarkers: [],
        watchFiles: false,
      };
      const start = () => getOrCreateClient(config, cwd, 10_000);
      const state = (client) => sendRequest(client, 'fixture/state', null, undefined, 5_000);
      const first = await start();
      assert.equal(
        first.proc.sharedMux,
        true,
        'The first client must not fall back to a private process',
      );
      const daemonPid = (await daemonClient()).welcome.daemon.pid;
      const uri = pathToFileURL(join(cwd, 'overlay.handoff')).href;
      await sendNotification(first, 'textDocument/didOpen', {
        textDocument: { uri, languageId: 'handoff', version: 1, text: 'session-owned overlay' },
      });
      const original = await state(first);
      assert.equal(original.initializes, 1);
      assert.deepEqual(original.documents, [uri]);
      assert.equal(await shutdownClientInstance(first), true);
      await closeDaemonClient();

      const second = await start();
      assert.equal(
        second.proc.sharedMux,
        true,
        'The second client must not fall back to a private process',
      );
      const daemon = await daemonClient();
      assert.equal(daemon.welcome.daemon.pid, daemonPid);
      assert.deepEqual(await state(second), {
        instance: original.instance,
        initializes: 1,
        documents: [],
      });
      const { units } = await daemon.request({ op: 'list', kind: 'lsp' });
      assert.equal(units.length, 1, 'Both attachments must use the same daemon LSP unit');

      assert.equal(await shutdownClientInstance(second), true);
      // A different executable build can upgrade and replace the sandbox daemon.
      const { runPsCommand } = await import('@oh-my-pi/pi-coding-agent/cli/ps-cli');
      await runPsCommand({
        action: 'stop',
        name: units[0].id,
        flags: { all: false, json: false, plain: true, dir: cwd, timeout: 5 },
      });
      assert.ok(!process.exitCode, 'Targeted stop must succeed against the same SDK build');
      const third = await start();
      assert.equal(third.proc.sharedMux, true);
      assert.equal((await daemonClient()).welcome.daemon.pid, daemonPid);
      const rebuilt = await state(third);
      assert.notEqual(rebuilt.instance, original.instance);
      assert.equal(rebuilt.initializes, 1);
    } finally {
      mode.release();
      await shutdownAll();
    }
  } finally {
    await stopDaemon();
  }
  await rm(cwd, { recursive: true, force: true });
  console.log(
    'OMP daemon reused the LSP instance, cleared the overlay, and rebuilt after targeted stop',
  );
}

if (process.argv[2] === '--fixture') await serveFixture();
else await checkHandoff();
