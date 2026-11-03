import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonicalizeProject } from '../src/metadata.js';
import { encode, frameParser } from '../src/protocol.js';
import {
  inspectWorkspaceModel,
  isPathContained,
  serializeWorkspaceModelError,
  validateSourceFile,
} from '../src/workspace-model.js';

interface TestServerFixture {
  server: net.Server;
  connect: () => Promise<net.Socket>;
  receivedMethods: string[];
}

async function createTestServer(
  t: TestContext,
  handlers: {
    onLaunch?: (id: number) => unknown;
    onBuild?: (id: number) => unknown;
  } = {},
): Promise<TestServerFixture> {
  const receivedMethods: string[] = [];
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

        if (msg.method) {
          receivedMethods.push(msg.method);
        }

        if (msg.method === 'initialize' && msg.id !== undefined) {
          socket.write(encode({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }));
          setImmediate(() => {
            socket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));
          });
        } else if (msg.method === 'workspace/executeCommand' && msg.id !== undefined) {
          const params = msg.params as { command?: string; arguments?: unknown[] };
          if (params.command === 'intellij.java.resolveLaunch') {
            const resp = handlers.onLaunch
              ? handlers.onLaunch(msg.id)
              : {
                  result: {
                    javaExec: '/test/jdk/bin/java',
                    moduleContentPaths: [],
                    classpath: ['/test/project/target/classes'],
                    workingDirectory: '/test/project',
                  },
                };
            if (resp !== undefined)
              socket.write(encode({ jsonrpc: '2.0', id: msg.id, ...(resp as object) }));
          } else if (params.command === 'intellij.java.resolveBuildCommand') {
            const resp = handlers.onBuild
              ? handlers.onBuild(msg.id)
              : {
                  result: {
                    supported: true,
                    tool: 'maven',
                    cwd: '/test/project',
                    command: ['mvn.cmd', 'compile'],
                  },
                };
            socket.write(encode({ jsonrpc: '2.0', id: msg.id, ...(resp as object) }));
          }
        }
      }),
    );
  });

  server.listen(0, '127.0.0.1');
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;

  const connect = async (): Promise<net.Socket> => {
    const sock = net.connect(port, '127.0.0.1');
    await once(sock, 'connect');
    return sock;
  };

  return { server, connect, receivedMethods };
}

test('validateSourceFile rejects missing, non-regular, non-JVM, and outside files before session', async (t: TestContext) => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'omp-model-val-test-'));
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));

  const projectDir = join(tmpRoot, 'project');
  const outsideDir = join(tmpRoot, 'outside');
  const srcDir = join(projectDir, 'src', 'main', 'java');
  await mkdir(srcDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  await writeFile(
    join(projectDir, 'pom.xml'),
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>demo</artifactId><version>1.0.0</version></project>',
    'utf8',
  );

  const validJava = join(srcDir, 'App.java');
  await writeFile(
    validJava,
    'public class App { public static void main(String[] args) {} }',
    'utf8',
  );
  const textFile = join(srcDir, 'notes.txt');
  await writeFile(textFile, 'hello', 'utf8');
  const outsideJava = join(outsideDir, 'Outside.java');
  await writeFile(outsideJava, 'public class Outside {}', 'utf8');

  assert.throws(
    () => validateSourceFile(join(srcDir, 'NonExistent.java')),
    /Source file not found/,
  );
  assert.throws(() => validateSourceFile(srcDir), /Source file must be a regular file/);
  assert.throws(
    () => validateSourceFile(textFile),
    /Source file must be a \.java, \.kt, or \.kts file/,
  );
  assert.throws(() => validateSourceFile(outsideJava, projectDir), /outside project root/);

  const autoResolved = validateSourceFile(validJava);
  assert.equal(autoResolved.resolvedFile, validJava);
  assert.equal(autoResolved.resolvedProject, projectDir);

  const explicitResolved = validateSourceFile(validJava, projectDir);
  assert.equal(explicitResolved.resolvedFile, validJava);
  assert.equal(explicitResolved.resolvedProject, projectDir);
});

test('validateSourceFile strictly enforces realpath containment for internal symlinks pointing outside', async (t: TestContext) => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'omp-model-symlink-strict-'));
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));

  const realProj = join(tmpRoot, 'project');
  const outsideDir = join(tmpRoot, 'outside');
  await mkdir(join(realProj, 'src'), { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  const outsideJava = join(outsideDir, 'External.java');
  await writeFile(outsideJava, 'public class External {}', 'utf8');
  const symlinkInside = join(realProj, 'src', 'LinkedExternal.java');

  try {
    await symlink(outsideJava, symlinkInside, 'file');
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err.code === 'EPERM' || err.code === 'EACCES')
    ) {
      t.skip('Symlink creation requires elevated privileges in this environment');
      return;
    }
    throw err;
  }

  assert.throws(() => validateSourceFile(symlinkInside, realProj), /outside project root/);
});

test('isPathContained boundary checks and directory naming', () => {
  assert.equal(isPathContained('/app/proj', '/app/proj/src/Main.java'), true);
  assert.equal(isPathContained('/app/proj', '/app/other/Main.java'), false);
  assert.equal(isPathContained('/app/proj', '/app/proj'), false);
  assert.equal(isPathContained('/app/proj', '/app/proj/..special/Main.java'), true);
});

test('inspectWorkspaceModel validates timeoutMs', async () => {
  await assert.rejects(
    () => inspectWorkspaceModel('/dummy', '/dummy/File.java', { timeoutMs: Number.NaN }),
    /timeoutMs must be a positive finite number/,
  );
  await assert.rejects(
    () => inspectWorkspaceModel('/dummy', '/dummy/File.java', { timeoutMs: -10 }),
    /timeoutMs must be a positive finite number/,
  );
});

test('fixture: inspectWorkspaceModel returns launch and build model without executing build or debuggee', async (t: TestContext) => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'omp-model-fixture-test-'));
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));

  const projectDir = join(tmpRoot, 'project');
  const srcDir = join(projectDir, 'src');
  await mkdir(srcDir, { recursive: true });

  await writeFile(
    join(projectDir, 'pom.xml'),
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>demo</artifactId><version>1.0.0</version></project>',
    'utf8',
  );
  const javaFile = join(srcDir, 'Hello.java');
  await writeFile(
    javaFile,
    'public class Hello { public static void main(String[] args) {} }',
    'utf8',
  );

  const fixture = await createTestServer(t, {
    onLaunch: () => ({
      result: {
        javaExec: '/test/jdk/bin/java',
        moduleContentPaths: [],
        classpath: ['/test/project/target/classes'],
        workingDirectory: projectDir,
        vmArgs: ['-Dsensitive.token=SECRET12345'],
      },
    }),
    onBuild: () => ({
      result: {
        supported: true,
        tool: 'maven',
        cwd: projectDir,
        command: ['mvn.cmd', 'compile', '--token=SECRET12345'],
      },
    }),
  });

  const clientSocket = await fixture.connect();
  const report = await inspectWorkspaceModel(projectDir, javaFile, {
    socket: clientSocket,
    timeoutMs: 10000,
  });

  assert.ok(report.buildCommand);
  assert.equal(report.buildCommand?.includes('SECRET12345'), false);
  assert.ok(report.buildCommand?.some((arg) => arg.includes('[REDACTED]')));

  assert.equal('vmArgs' in report, false);

  assert.ok(fixture.receivedMethods.includes('initialize'));
  assert.ok(fixture.receivedMethods.includes('workspace/executeCommand'));
  assert.equal(fixture.receivedMethods.includes('start_debug_server'), false);

  if (!clientSocket.destroyed) {
    await once(clientSocket, 'close');
  }
  assert.equal(clientSocket.destroyed, true);
});

test('fixture: partial build unsupported preserves unsupported state without throwing or faking success', async (t: TestContext) => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'omp-model-unsupported-test-'));
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));

  const projectDir = join(tmpRoot, 'project');
  const srcDir = join(projectDir, 'src');
  await mkdir(srcDir, { recursive: true });

  await writeFile(
    join(projectDir, 'pom.xml'),
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>demo</artifactId><version>1.0.0</version></project>',
    'utf8',
  );
  const javaFile = join(srcDir, 'App.java');
  await writeFile(
    javaFile,
    'public class App { public static void main(String[] args) {} }',
    'utf8',
  );

  const fixture = await createTestServer(t, {
    onLaunch: () => ({
      result: { javaExec: '/test/jdk/bin/java' },
    }),
    onBuild: () => ({
      result: {
        supported: false,
        reason: 'Compilation not configured for this module',
      },
    }),
  });

  const clientSocket = await fixture.connect();
  const report = await inspectWorkspaceModel(projectDir, javaFile, {
    socket: clientSocket,
    timeoutMs: 10000,
  });

  assert.equal(report.supported, false);
  assert.equal(report.reason, 'Compilation not configured for this module');
  assert.equal(report.javaExec, '/test/jdk/bin/java');
});

test('fixture: malformed RPC responses are rejected explicitly', async (t: TestContext) => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'omp-model-malformed-test-'));
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));

  const projectDir = join(tmpRoot, 'project');
  const srcDir = join(projectDir, 'src');
  await mkdir(srcDir, { recursive: true });

  await writeFile(
    join(projectDir, 'pom.xml'),
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>demo</artifactId><version>1.0.0</version></project>',
    'utf8',
  );
  const javaFile = join(srcDir, 'App.java');
  await writeFile(javaFile, 'public class App {}', 'utf8');

  const fixtureMissingSupported = await createTestServer(t, {
    onLaunch: () => ({ result: { javaExec: '/test/jdk/bin/java' } }),
    onBuild: () => ({ result: { tool: 'maven' } }), // missing boolean supported
  });
  const sock1 = await fixtureMissingSupported.connect();
  await assert.rejects(
    () => inspectWorkspaceModel(projectDir, javaFile, { socket: sock1, timeoutMs: 10000 }),
    /missing or invalid boolean "supported" field/,
  );

  const fixtureMissingJavaExec = await createTestServer(t, {
    onLaunch: () => ({ result: { workingDirectory: projectDir } }), // missing javaExec
    onBuild: () => ({ result: { supported: true } }),
  });
  const sock2 = await fixtureMissingJavaExec.connect();
  await assert.rejects(
    () => inspectWorkspaceModel(projectDir, javaFile, { socket: sock2, timeoutMs: 10000 }),
    /Launch resolution returned no java executable/,
  );
});

test('fixture: RPC error in resolveBuildCommand is propagated and not swallowed into success', async (t: TestContext) => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'omp-model-rpc-err-test-'));
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));

  const projectDir = join(tmpRoot, 'project');
  const srcDir = join(projectDir, 'src');
  await mkdir(srcDir, { recursive: true });

  await writeFile(
    join(projectDir, 'pom.xml'),
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>demo</artifactId><version>1.0.0</version></project>',
    'utf8',
  );
  const javaFile = join(srcDir, 'App.java');
  await writeFile(javaFile, 'public class App {}', 'utf8');

  const fixture = await createTestServer(t, {
    onLaunch: () => ({ result: { javaExec: '/test/jdk/bin/java' } }),
    onBuild: () => ({
      error: { code: -32603, message: 'Fatal server error: build descriptor parsing failed' },
    }),
  });

  const clientSocket = await fixture.connect();
  await assert.rejects(
    () =>
      inspectWorkspaceModel(projectDir, javaFile, {
        socket: clientSocket,
        timeoutMs: 10000,
      }),
    /Fatal server error: build descriptor parsing failed/,
  );

  if (!clientSocket.destroyed) {
    await once(clientSocket, 'close');
  }
  assert.equal(clientSocket.destroyed, true);
});

test('fixture: cancellation with signal aborts and releases session', async (t: TestContext) => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'omp-model-cancel-test-'));
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));

  const projectDir = join(tmpRoot, 'project');
  const srcDir = join(projectDir, 'src');
  await mkdir(srcDir, { recursive: true });

  await writeFile(
    join(projectDir, 'pom.xml'),
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>demo</artifactId><version>1.0.0</version></project>',
    'utf8',
  );
  const javaFile = join(srcDir, 'App.java');
  await writeFile(javaFile, 'public class App {}', 'utf8');

  for (const mode of ['cancel', 'deadline']) {
    const ac = new AbortController();
    const fixture = await createTestServer(t, {
      onLaunch() {
        if (mode === 'cancel') ac.abort();
        return undefined;
      },
    });
    const socket = await fixture.connect();
    await assert.rejects(
      inspectWorkspaceModel(projectDir, javaFile, {
        socket,
        systemPath: join(tmpRoot, mode),
        signal: ac.signal,
        timeoutMs: 1000,
      }),
      (error: unknown) =>
        error instanceof Error &&
        (mode === 'cancel'
          ? error.name === 'AbortError'
          : /timeout|timed out/i.test(error.message)),
    );
    if (!socket.destroyed) await once(socket, 'close');
    assert.equal(socket.destroyed, true);
  }
});

test('maskConfiguredSecrets masks configured secrets across all report fields and preserves error code/data', async (t: TestContext) => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'omp-model-secrets-test-'));
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));

  const projectDir = join(tmpRoot, 'project');
  const configDir = join(tmpRoot, 'config');
  const srcDir = join(projectDir, 'src');
  await mkdir(configDir, { recursive: true });
  await mkdir(srcDir, { recursive: true });

  await writeFile(
    join(projectDir, 'pom.xml'),
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>demo</artifactId><version>1.0.0</version></project>',
    'utf8',
  );
  const javaFile = join(srcDir, 'App.java');
  await writeFile(javaFile, 'public class App {}', 'utf8');

  const { id: projectId } = canonicalizeProject(projectDir);
  const configFile = join(configDir, `${projectId}.json`);
  await writeFile(
    configFile,
    JSON.stringify({
      id: projectId,
      env: {
        SECRET_AUTH_HEADER: 'my-custom-super-secret-token',
      },
    }),
    'utf8',
  );

  const fixture = await createTestServer(t, {
    onLaunch: () => ({
      result: {
        javaExec: '/test/jdk/bin/java',
        workingDirectory: `${projectDir}/my-custom-super-secret-token-dir`,
      },
    }),
    onBuild: () => ({
      result: {
        supported: true,
        tool: 'maven',
        cwd: projectDir,
        command: ['mvn', '-Dtoken=my-custom-super-secret-token'],
        reason: 'Authorized with my-custom-super-secret-token',
      },
    }),
  });

  const clientSocket = await fixture.connect();
  const report = await inspectWorkspaceModel(projectDir, javaFile, {
    socket: clientSocket,
    configDir,
    timeoutMs: 10000,
  });

  assert.equal(JSON.stringify(report).includes('my-custom-super-secret-token'), false);
  assert.ok(report.buildCommand?.some((arg) => arg.includes('[REDACTED]')));
  assert.ok(report.workingDirectory?.includes('[REDACTED]'));
  assert.ok(report.reason?.includes('[REDACTED]'));

  // Error serialization maintains in-memory code/data while masking message
  const rawError = Object.assign(new Error('Failed with my-custom-super-secret-token'), {
    code: 'CUSTOM_ERR',
    data: { detail: 'sensitive my-custom-super-secret-token' },
  });
  const serialized = serializeWorkspaceModelError(rawError, {
    SECRET_AUTH_HEADER: 'my-custom-super-secret-token',
  }) as { message: string; code?: unknown; data?: { detail?: string } };

  assert.ok(serialized.message.includes('[REDACTED]'));
  assert.equal(serialized.code, 'CUSTOM_ERR');
  assert.equal(JSON.stringify(serialized).includes('my-custom-super-secret-token'), false);
  assert.equal(rawError.message, 'Failed with my-custom-super-secret-token');

  // Malformed config file must throw rather than quietly failing to mask secrets
  await writeFile(configFile, 'INVALID_JSON{{{', 'utf8');
  const clientSocket2 = await fixture.connect();
  await assert.rejects(
    () =>
      inspectWorkspaceModel(projectDir, javaFile, {
        socket: clientSocket2,
        configDir,
        timeoutMs: 10000,
      }),
    /Invalid workspace configuration/,
  );
});
