import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonicalizeProject } from '../src/project/metadata.js';
import {
  formatModelLines,
  inspectWorkspaceModel,
  isPathContained,
  serializeWorkspaceModelError,
  validateSourceFile,
} from '../src/project/workspace-model.js';
import { encode, frameParser } from '../src/shared/protocol.js';

interface TestServerFixture {
  server: net.Server;
  connect: () => Promise<net.Socket>;
  receivedMethods: string[];
  receivedCommands: string[];
}

async function createTestServer(
  t: TestContext,
  handlers: {
    onBuildTool?: (id: number, uri: string) => unknown;
    capabilities?: Record<string, unknown>;
    onExportWorkspace?: (id: number, exportDir: string) => Promise<unknown> | unknown;
  } = {},
): Promise<TestServerFixture> {
  const receivedMethods: string[] = [];
  const receivedCommands: string[] = [];
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
          socket.write(
            encode({
              jsonrpc: '2.0',
              id: msg.id,
              result: { capabilities: handlers.capabilities ?? {} },
            }),
          );
          setImmediate(() => {
            socket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));
          });
        } else if (msg.method === 'workspace/executeCommand' && msg.id !== undefined) {
          const params = msg.params as { command?: string; arguments?: unknown[] };
          if (typeof params.command === 'string') receivedCommands.push(params.command);
          if (params.command === 'intellij.java.buildTool') {
            const firstArg = Array.isArray(params.arguments) ? params.arguments[0] : undefined;
            const uri =
              firstArg &&
              typeof firstArg === 'object' &&
              'uri' in firstArg &&
              typeof firstArg.uri === 'string'
                ? firstArg.uri
                : '';
            const resp = handlers.onBuildTool
              ? handlers.onBuildTool(msg.id, uri)
              : { result: { tool: 'gradle', env: { JAVA_HOME: '/test/jdk' } } };
            if (resp !== undefined)
              socket.write(encode({ jsonrpc: '2.0', id: msg.id, ...(resp as object) }));
          } else if (params.command === 'exportWorkspace') {
            const exportDir =
              Array.isArray(params.arguments) && typeof params.arguments[0] === 'string'
                ? params.arguments[0]
                : '';
            const resp = handlers.onExportWorkspace
              ? await handlers.onExportWorkspace(msg.id, exportDir)
              : { result: null };
            if (resp !== undefined) {
              socket.write(encode({ jsonrpc: '2.0', id: msg.id, ...(resp as object) }));
            }
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

  return { server, connect, receivedMethods, receivedCommands };
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

test('fixture: inspectWorkspaceModel reports the registered build tool and module roots without executing a build', async (t: TestContext) => {
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

  let queriedUri = '';
  const fixture = await createTestServer(t, {
    capabilities: {
      executeCommandProvider: { commands: ['intellij.java.buildTool', 'exportWorkspace'] },
    },
    onBuildTool: (_id, uri) => {
      queriedUri = uri;
      return { result: { tool: 'gradle', env: { JAVA_HOME: '/test/jdk-21' } } };
    },
    onExportWorkspace: async (_id, exportDir) => {
      await writeFile(
        join(exportDir, 'workspace.json'),
        JSON.stringify({
          modules: [
            {
              name: 'demo.main',
              contentRoots: [
                {
                  path: projectDir,
                  sourceRoots: [{ path: srcDir, type: 'java-source' }],
                },
              ],
            },
          ],
          libraries: [{ name: 'junit-4.13.2' }],
          sdks: [{ name: 'JDK 21', type: 'JavaSDK', homePath: '/test/jdk-21' }],
        }),
        'utf8',
      );
      return { result: null };
    },
  });

  const clientSocket = await fixture.connect();
  const report = await inspectWorkspaceModel(projectDir, javaFile, {
    socket: clientSocket,
    timeoutMs: 10000,
  });

  assert.equal(report.supported, true);
  assert.equal(report.buildTool, 'gradle');
  assert.deepEqual(report.buildEnv, { JAVA_HOME: '/test/jdk-21' });
  assert.equal(report.reason, undefined);
  assert.equal(report.moduleName, 'demo.main');
  assert.deepEqual(report.moduleSourceRoots, [{ path: srcDir, type: 'java-source' }]);
  assert.equal(report.libraryCount, 1);
  assert.equal(report.sdks?.[0]?.name, 'JDK 21');

  // Inspection must not claim runtime values it never resolved.
  for (const obsolete of [
    'javaExec',
    'classpath',
    'modulePath',
    'workingDirectory',
    'buildCwd',
    'buildCommand',
  ]) {
    assert.equal(obsolete in report, false, `${obsolete} must not be reported by inspection`);
  }

  assert.ok(fixture.receivedMethods.includes('initialize'));
  assert.ok(fixture.receivedMethods.includes('workspace/executeCommand'));
  assert.equal(fixture.receivedMethods.includes('start_debug_server'), false);
  assert.deepEqual(fixture.receivedCommands, ['intellij.java.buildTool', 'exportWorkspace']);
  assert.equal(fixture.receivedCommands.includes('intellij.build'), false);
  assert.ok(
    queriedUri.endsWith('/Hello.java'),
    `Build tool query must carry the inspected file URI, got ${queriedUri}`,
  );

  const formatted = formatModelLines(report).join('\n');
  assert.match(formatted, /Build tool: gradle \(registered; build execution not verified\)/);
  assert.match(formatted, /Build tool environment: JAVA_HOME=\/test\/jdk-21/);

  if (!clientSocket.destroyed) {
    await once(clientSocket, 'close');
  }
  assert.equal(clientSocket.destroyed, true);
});

test('fixture: a server reporting no registered build tool stays unsupported without inventing one', async (t: TestContext) => {
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
    capabilities: { executeCommandProvider: { commands: ['intellij.java.buildTool'] } },
    onBuildTool: () => ({ result: { tool: null, env: {} } }),
  });

  const clientSocket = await fixture.connect();
  const report = await inspectWorkspaceModel(projectDir, javaFile, {
    socket: clientSocket,
    timeoutMs: 10000,
  });

  assert.equal(report.supported, false);
  assert.equal(report.buildTool, undefined);
  assert.equal(report.buildEnv, undefined);
  assert.equal(report.reason, 'No build tool registered for this module');
  assert.match(formatModelLines(report).join('\n'), /Build tool: none registered by server/);
});

test('fixture: malformed build tool responses are rejected explicitly', async (t: TestContext) => {
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

  for (const scenario of [
    {
      name: 'missing tool field',
      response: { result: { env: {} } },
      expected: /returned an invalid tool/,
    },
    {
      name: 'non-string tool',
      response: { result: { tool: 42, env: {} } },
      expected: /returned an invalid tool/,
    },
    {
      name: 'non-object env',
      response: { result: { tool: 'gradle', env: ['JAVA_HOME=/jdk'] } },
      expected: /returned an invalid environment/,
    },
    {
      name: 'non-string env value',
      response: { result: { tool: 'gradle', env: { JAVA_HOME: 21 } } },
      expected: /returned an invalid environment/,
    },
  ]) {
    await t.test(scenario.name, async (subtest) => {
      const fixture = await createTestServer(subtest, {
        capabilities: { executeCommandProvider: { commands: ['intellij.java.buildTool'] } },
        onBuildTool: () => scenario.response,
      });
      await assert.rejects(
        inspectWorkspaceModel(projectDir, javaFile, {
          socket: await fixture.connect(),
          timeoutMs: 10000,
        }),
        scenario.expected,
      );
    });
  }
});

test('fixture: RPC error in the build tool query is propagated and not swallowed into success', async (t: TestContext) => {
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
    capabilities: { executeCommandProvider: { commands: ['intellij.java.buildTool'] } },
    onBuildTool: () => ({
      error: { code: -32603, message: 'Fatal server error: module descriptor parsing failed' },
    }),
  });

  const clientSocket = await fixture.connect();
  await assert.rejects(
    () =>
      inspectWorkspaceModel(projectDir, javaFile, {
        socket: clientSocket,
        timeoutMs: 10000,
      }),
    /Fatal server error: module descriptor parsing failed/,
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
      onBuildTool() {
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
    capabilities: {
      executeCommandProvider: { commands: ['intellij.java.buildTool', 'exportWorkspace'] },
    },
    onBuildTool: () => ({
      result: {
        tool: 'maven',
        env: { JAVA_HOME: `${projectDir}/my-custom-super-secret-token-jdk` },
      },
    }),
    onExportWorkspace: async (_id, exportDir) => {
      await writeFile(
        join(exportDir, 'workspace.json'),
        JSON.stringify({
          modules: [
            {
              name: 'demo',
              contentRoots: [
                { path: projectDir, sourceRoots: [{ path: srcDir, type: 'java-source' }] },
              ],
            },
          ],
          sdks: [
            {
              name: 'JDK 21 (my-custom-super-secret-token)',
              type: 'JavaSDK',
              homePath: projectDir,
            },
          ],
          libraries: [],
        }),
        'utf8',
      );
      return { result: null };
    },
  });

  const clientSocket = await fixture.connect();
  const report = await inspectWorkspaceModel(projectDir, javaFile, {
    socket: clientSocket,
    configDir,
    timeoutMs: 10000,
  });

  assert.equal(JSON.stringify(report).includes('my-custom-super-secret-token'), false);
  assert.ok(report.buildEnv?.JAVA_HOME.includes('[REDACTED]'));
  assert.ok(report.sdks?.[0]?.name.includes('[REDACTED]'));

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

test('fixture: exportWorkspace enriches moduleSourceRoots, sdks, libraryCount, expands <HOME>/<MAVEN_REPO>, and masks secrets', async (t: TestContext) => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'omp-model-export-test-'));
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));

  const fakeHome = join(tmpRoot, 'home');
  const m2Dir = join(fakeHome, '.m2');
  const customRepo = join(fakeHome, 'custom-m2-repo');
  const projectDir = join(fakeHome, 'workspace', 'myhook');
  const mainJavaDir = join(projectDir, 'app', 'src', 'main', 'java', 'com', 'example');
  const kspDir = join(projectDir, 'app', 'build', 'generated', 'ksp', 'debug', 'kotlin');
  const configDir = join(tmpRoot, 'configs');
  await mkdir(m2Dir, { recursive: true });
  await mkdir(customRepo, { recursive: true });
  await mkdir(mainJavaDir, { recursive: true });
  await mkdir(kspDir, { recursive: true });
  await mkdir(configDir, { recursive: true });

  await writeFile(
    join(m2Dir, 'settings.xml'),
    `<settings><!-- <localRepository>/ignored/comment</localRepository> --><localRepository>\${user.home}/custom-m2-repo</localRepository></settings>`,
    'utf8',
  );
  await writeFile(join(projectDir, 'settings.gradle.kts'), 'include(":app")', 'utf8');
  const javaFile = join(mainJavaDir, 'App.java');
  await writeFile(javaFile, 'package com.example; public class App {}', 'utf8');

  const { id: projectId } = canonicalizeProject(projectDir);
  await writeFile(
    join(configDir, `${projectId}.json`),
    JSON.stringify({
      id: projectId,
      env: { REPO_SECRET: 'secret-sdk-token' },
    }),
    'utf8',
  );

  let observedExportDir = '';
  const fixture = await createTestServer(t, {
    capabilities: {
      executeCommandProvider: {
        commands: ['intellij.java.buildTool', 'exportWorkspace'],
      },
    },
    onBuildTool: () => ({ result: { tool: 'gradle', env: { JAVA_HOME: '/opt/jdks/jdk-21' } } }),
    onExportWorkspace: async (_id, exportDir) => {
      observedExportDir = exportDir;
      await writeFile(
        join(exportDir, 'workspace.json'),
        JSON.stringify({
          modules: [
            {
              name: 'myhook',
              contentRoots: [{ path: '<HOME>/workspace/myhook' }],
            },
            {
              name: 'myhook.app.debug',
              contentRoots: [
                {
                  path: '<HOME>/workspace/myhook/app/src/main',
                  sourceRoots: [
                    {
                      path: '<HOME>/workspace/myhook/app/src/main/java',
                      type: 'java-source',
                    },
                  ],
                },
                {
                  path: '<HOME>/workspace/myhook/app/build/generated/ksp/debug/kotlin',
                  sourceRoots: [
                    {
                      path: '<HOME>/workspace/myhook/app/build/generated/ksp/debug/kotlin',
                      type: 'java-source',
                    },
                  ],
                },
              ],
            },
          ],
          sdks: [
            {
              name: 'JDK 21 (secret-sdk-token)',
              type: 'JavaSDK',
              version: '21.0.12',
              homePath: '<MAVEN_REPO>/jdks/jdk-21',
            },
          ],
          libraries: [
            { name: 'Gradle: junit:junit:4.13.2' },
            { name: 'Gradle: androidx.room:room-runtime:2.6.1' },
          ],
        }),
        'utf8',
      );
      return { result: null };
    },
  });

  const clientSocket = await fixture.connect();
  const report = await inspectWorkspaceModel(projectDir, javaFile, {
    socket: clientSocket,
    configDir,
    homeDir: fakeHome,
    timeoutMs: 10000,
  });

  assert.equal(report.moduleName, 'myhook.app.debug');
  assert.equal(report.buildTool, 'gradle');
  assert.equal(report.buildEnv?.JAVA_HOME, '/opt/jdks/jdk-21');
  assert.equal(report.moduleContentPaths?.length, 2);
  assert.equal(report.moduleSourceRoots?.length, 2);
  assert.equal(report.moduleSourceRoots?.[0]?.path, join(projectDir, 'app', 'src', 'main', 'java'));
  assert.equal(report.moduleSourceRoots?.[0]?.type, 'java-source');
  assert.equal(report.moduleSourceRoots?.[1]?.path, kspDir);
  assert.equal(report.libraryCount, 2);
  assert.equal(report.sdks?.length, 1);
  assert.ok(report.sdks?.[0]?.name.includes('[REDACTED]'));
  assert.equal(report.sdks?.[0]?.homePath, join(customRepo, 'jdks', 'jdk-21'));
  assert.equal(JSON.stringify(report).includes('secret-sdk-token'), false);

  const formatted = formatModelLines(report).join('\n');
  assert.match(formatted, /Module: myhook\.app\.debug/);
  assert.match(formatted, /Module source roots: .*java-source/);
  assert.match(formatted, /SDKs: JDK 21/);
  assert.match(formatted, /Workspace libraries: 2/);
  assert.ok(observedExportDir.length > 0);
});

test('workspace export failures remain visible instead of returning a complete model', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'omp-model-export-failure-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const sourceFile = join(projectDir, 'App.java');
  await writeFile(sourceFile, 'class App {}');
  for (const scenario of [
    { name: 'missing file', document: undefined, expected: /did not write workspace.json/ },
    { name: 'invalid shape', document: '[]', expected: /invalid document/ },
    { name: 'invalid libraries', document: '{"libraries":false}', expected: /invalid libraries/ },
    { name: 'server error', document: undefined, expected: /Export failed/ },
  ]) {
    await t.test(scenario.name, async (subtest) => {
      const fixture = await createTestServer(subtest, {
        capabilities: { executeCommandProvider: { commands: ['exportWorkspace'] } },
        onExportWorkspace: async (_id, exportDir) => {
          if (scenario.name === 'server error') {
            return { error: { code: -32603, message: 'Export failed' } };
          }
          if (scenario.document !== undefined) {
            await writeFile(join(exportDir, 'workspace.json'), scenario.document);
          }
          return { result: null };
        },
      });
      await assert.rejects(
        inspectWorkspaceModel(projectDir, sourceFile, {
          socket: await fixture.connect(),
          timeoutMs: 10000,
        }),
        scenario.expected,
      );
    });
  }
});
test('workspace model reports no build tool when the server does not advertise intellij.java.buildTool', async (t: TestContext) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'omp-model-unknown-cmd-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const sourceFile = join(projectDir, 'src', 'App.java');
  await mkdir(join(projectDir, 'src'), { recursive: true });
  await writeFile(sourceFile, 'package com.example;\npublic class App {}');

  const fixture = await createTestServer(t, {
    capabilities: {
      executeCommandProvider: {
        commands: ['exportWorkspace'],
      },
    },
    onExportWorkspace: async (_id, exportDir) => {
      await writeFile(
        join(exportDir, 'workspace.json'),
        JSON.stringify({
          modules: [
            {
              name: 'my-app',
              contentRoots: [
                {
                  path: projectDir,
                  sourceRoots: [{ path: join(projectDir, 'src'), type: 'java-source' }],
                },
              ],
            },
          ],
          libraries: [{ name: 'junit-4.13.2' }],
          sdks: [
            {
              name: 'JDK 21',
              type: 'JavaSDK',
              homePath: '/opt/jdks/jdk-21',
            },
          ],
        }),
      );
      return { result: null };
    },
  });

  const report = await inspectWorkspaceModel(projectDir, sourceFile, {
    socket: await fixture.connect(),
    timeoutMs: 10000,
  });

  assert.equal(report.supported, false);
  assert.equal(report.buildTool, undefined);
  assert.equal(report.reason, 'Build tool not advertised by server');
  assert.equal(report.moduleName, 'my-app');
  assert.equal(report.libraryCount, 1);
  assert.equal(report.sdks?.length, 1);
  assert.ok(report.moduleSourceRoots && report.moduleSourceRoots.length > 0);
  assert.equal(fixture.receivedCommands.includes('intellij.java.buildTool'), false);
});

test('workspace model tolerates an unknown-command error from intellij.java.buildTool', async (t: TestContext) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'omp-model-unknown-error-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const sourceFile = join(projectDir, 'App.java');
  await writeFile(sourceFile, 'class App {}');

  const fixture = await createTestServer(t, {
    onBuildTool: () => ({
      error: { code: -32601, message: 'Unknown command: intellij.java.buildTool' },
    }),
  });

  const report = await inspectWorkspaceModel(projectDir, sourceFile, {
    socket: await fixture.connect(),
    timeoutMs: 10000,
  });

  assert.equal(report.supported, false);
  assert.equal(report.buildTool, undefined);
});
