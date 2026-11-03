import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { executeBuild, runViaDap } from '../src/debug/run-core.js';
import { encode, frameParser } from '../src/shared/protocol.js';

test('build preserves argv containing spaces and shell metacharacters', async () => {
  const literal = 'argument with spaces & | < > % ! ^ ( )';
  const result = await executeBuild({
    command: [
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      literal,
    ],
    cwd: process.cwd(),
  });
  assert.deepEqual(JSON.parse(result.buildOutput), [literal]);
});

test('failed build preserves compiler diagnostics and blocks success', async () => {
  await assert.rejects(
    executeBuild({
      command: [
        process.execPath,
        '-e',
        'console.error("compile-failure-sentinel"); process.exit(7)',
      ],
    }),
    /exit code 7[\s\S]*compile-failure-sentinel/,
  );
});

for (const exitCode of [0, 7]) {
  test(`build decodes fragmented UTF-8 streams through exit ${exitCode}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'omp-build-output-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const release = join(dir, 'release');
    const output = { stdout: '', stderr: '' };
    const build = executeBuild(
      {
        command: [
          process.execPath,
          '-e',
          `
            const fs = require('node:fs');
            const out = Buffer.from('中文🚀');
            const err = Buffer.from('错误🙂');
            const watcher = fs.watch('.', () => {
              if (!fs.existsSync(process.argv[1])) return;
              watcher.close();
              process.exitCode = Number(process.argv[2]);
              process.stdout.end(out.subarray(1));
              process.stderr.end(Buffer.concat([err.subarray(2), Buffer.from([0xe4])]));
            });
            process.stdout.write(Buffer.concat([Buffer.from('stdout:'), out.subarray(0, 1)]));
            process.stderr.write(Buffer.concat([Buffer.from('stderr:'), err.subarray(0, 2)]));
          `,
          release,
          String(exitCode),
        ],
        cwd: dir,
      },
      {
        onOutput: (event) => {
          if (event.category !== 'stdout' && event.category !== 'stderr') return;
          output[event.category] += event.output;
          if (output.stdout.startsWith('stdout:') && output.stderr.startsWith('stderr:')) {
            writeFileSync(release, '');
          }
        },
      },
    );
    if (exitCode === 0) {
      const result = await build;
      assert.equal(result.exitCode, 0);
      assert.ok(result.buildOutput.includes('中文🚀'));
      assert.ok(result.buildOutput.includes('错误🙂\ufffd'));
    } else {
      await assert.rejects(build, /exit code 7[\s\S]*错误🙂\ufffd/);
    }
    assert.deepEqual(output, { stdout: 'stdout:中文🚀', stderr: 'stderr:错误🙂\ufffd' });
  });
}

test('cancellation terminates a running build', async () => {
  const abort = new AbortController();
  await assert.rejects(
    executeBuild(
      {
        command: [
          process.execPath,
          '-e',
          'console.log("build-started"); setInterval(() => {}, 1000)',
        ],
      },
      {
        signal: abort.signal,
        onOutput: (event) => {
          if (event.output.includes('build-started\n')) abort.abort();
        },
      },
    ),
    /cancel/i,
  );
});

interface FakeDapMessage {
  command?: string;
  seq?: number;
  type?: string;
  request_seq?: number;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

async function fakeAdapter(
  t: TestContext,
  afterLaunch: (socket: net.Socket, message: FakeDapMessage) => void,
) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on(
      'data',
      frameParser((messageRaw: unknown) => {
        const message = messageRaw as FakeDapMessage;
        if (message.command === 'initialize') {
          const response = encode({
            seq: 1,
            type: 'response',
            request_seq: message.seq,
            command: 'initialize',
            success: true,
            body: {},
          });
          socket.write(response.subarray(0, 13));
          setImmediate(() => socket.write(response.subarray(13)));
        } else if (message.command === 'launch') afterLaunch(socket, message);
        else if (message.command === 'disconnect') socket.end();
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return (server.address() as net.AddressInfo).port;
}

test('lost DAP connection cannot become successful exit zero', async (t) => {
  const port = await fakeAdapter(t, (socket) => socket.end());
  await assert.rejects(
    runViaDap({ port, launchConfig: {}, timeoutMs: 2000 }),
    /closed|exit|disconnect/i,
  );
});

test('DAP nonzero exit survives fragmented initialization and termination', async (t) => {
  const port = await fakeAdapter(t, (socket) => {
    socket.write(encode({ seq: 2, type: 'event', event: 'exited', body: { exitCode: 7 } }));
    socket.write(encode({ seq: 3, type: 'event', event: 'terminated', body: {} }));
  });
  const result = await runViaDap({ port, launchConfig: {}, timeoutMs: 2000 });
  assert.equal(result.exitCode, 7);
});
