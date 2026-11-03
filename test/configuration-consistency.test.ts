import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLspSession } from '../src/debug/run-core.js';
import {
  findProjectIdForScope,
  getHostInitializationOptions,
  isPathInside,
  loadDefaultPluginSettings,
  loadProjectConfiguration,
  recordConfigurationItems,
  resolveConfigurationItems,
  resolveConfigurationSection,
  saveProjectConfiguration,
  stripRedactedPlaceholders,
  updateProjectSettings,
} from '../src/project/configuration.js';
import { canonicalizeProject } from '../src/project/metadata.js';
import { encode, frameParser } from '../src/shared/protocol.js';

test('resolveConfigurationSection: exact literal keys and dotted traversal', () => {
  const settings = {
    'jetbrains.java': {
      'hints.collapse complex types': true,
      'hints.settings.method parameter': false,
      'indent size': 4,
    },
    'jetbrains.kotlin': {
      'hints.settings.types.property': true,
    },
    'compound.literal.key': 'literal-value',
    compound: {
      literal: {
        key: 'nested-value',
      },
    },
    flags: {
      zero: 0,
      empty: '',
      disabled: false,
      absent: null,
    },
  };

  assert.deepEqual(resolveConfigurationSection(settings, null), settings);
  assert.deepEqual(resolveConfigurationSection(settings, ''), settings);
  assert.deepEqual(resolveConfigurationSection(settings, undefined), settings);

  assert.deepEqual(
    resolveConfigurationSection(settings, 'jetbrains.java'),
    settings['jetbrains.java'],
  );
  assert.equal(resolveConfigurationSection(settings, 'compound.literal.key'), 'literal-value');

  assert.equal(
    resolveConfigurationSection(settings, 'jetbrains.java.hints.collapse complex types'),
    true,
  );
  assert.equal(
    resolveConfigurationSection(settings, 'jetbrains.java.hints.settings.method parameter'),
    false,
  );
  assert.equal(resolveConfigurationSection(settings, 'jetbrains.java.indent size'), 4);
  assert.equal(
    resolveConfigurationSection(settings, 'jetbrains.kotlin.hints.settings.types.property'),
    true,
  );

  assert.equal(resolveConfigurationSection(settings, 'unknown'), null);
  assert.equal(resolveConfigurationSection(settings, 'jetbrains.java.unknown'), null);
  assert.equal(resolveConfigurationSection(settings, 'jetbrains.java.hints.nonexistent'), null);

  assert.equal(resolveConfigurationSection(settings, 'flags.zero'), 0);
  assert.equal(resolveConfigurationSection(settings, 'flags.empty'), '');
  assert.equal(resolveConfigurationSection(settings, 'flags.disabled'), false);
  assert.equal(resolveConfigurationSection(settings, 'flags.absent'), null);

  assert.equal(resolveConfigurationSection(null, 'foo'), null);
  assert.equal(resolveConfigurationSection(undefined, 'foo'), null);
});

test('stripRedactedPlaceholders: strips artificial placeholders from legacy metadata', () => {
  const legacy = {
    token: '[REDACTED]',
    safe: 'value',
    nested: { secret: '[REDACTED]', keep: 123 },
    list: ['a', '[REDACTED]', { masked: '[REDACTED]', visible: true }],
  };
  assert.deepEqual(stripRedactedPlaceholders(legacy), {
    safe: 'value',
    nested: { keep: 123 },
    list: ['a', { visible: true }],
  });
});

test('resolveConfigurationItems: resolves items with scope mapping and unknown fallback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'omp-intellij-resolve-items-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const systemPath = join(root, 'system');
  const proj = join(root, 'project');
  await mkdir(systemPath);
  await mkdir(proj);
  const { id } = canonicalizeProject(proj);
  await updateProjectSettings(
    systemPath,
    id,
    { 'jetbrains.java': { indent: 2 } },
    { projectPath: proj },
  );

  const res = await resolveConfigurationItems(systemPath, id, [
    { section: 'jetbrains.java.indent' },
    { section: 'unknown.section' },
    { scopeUri: pathToFileURL(join(proj, 'src', 'A.java')).href, section: 'jetbrains.java.indent' },
    {
      scopeUri: pathToFileURL(join(root, 'other', 'B.java')).href,
      section: 'jetbrains.java.indent',
    },
  ]);
  assert.deepEqual(res, [2, null, 2, null]);
});

test('isPathInside and findProjectIdForScope: segment boundary and file scopes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'omp-intellij-scope-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const systemPath = join(root, 'system');
  const projA = join(root, 'projectA');
  const projASibling = join(root, 'projectA-sibling');
  const projB = join(root, 'projectB');
  await mkdir(systemPath);
  await mkdir(projA);
  await mkdir(projASibling);
  await mkdir(projB);

  const idA = canonicalizeProject(projA).id;
  const idB = canonicalizeProject(projB).id;

  // Save snapshots for ProjA and ProjB
  await updateProjectSettings(systemPath, idA, { key: 'a' }, { projectPath: projA });
  await updateProjectSettings(systemPath, idB, { key: 'b' }, { projectPath: projB });

  // 1. isPathInside boundary checks
  const fileInA = join(projA, 'src', 'Main.java');
  const fileInSibling = join(projASibling, 'src', 'Main.java');
  const fileInB = join(projB, 'src', 'Bar.java');
  const fileExternal = join(root, 'external', 'Other.java');

  assert.equal(isPathInside(fileInA, projA), true);
  assert.equal(
    isPathInside(fileInSibling, projA),
    false,
    'Adjacent prefix directory must not match',
  );
  assert.equal(isPathInside(fileInB, projA), false);
  assert.equal(isPathInside(projA, projA), true);

  // 2. findProjectIdForScope
  assert.equal(await findProjectIdForScope(systemPath, idA, pathToFileURL(fileInA).href), idA);
  assert.equal(
    await findProjectIdForScope(systemPath, idA, pathToFileURL(fileInSibling).href),
    null,
    'File in adjacent prefix directory must return null',
  );
  assert.equal(
    await findProjectIdForScope(systemPath, idA, pathToFileURL(fileInB).href),
    idB,
    'File in Project B must map to Project B ID',
  );
  assert.equal(
    await findProjectIdForScope(systemPath, idA, pathToFileURL(fileExternal).href),
    null,
    'External scope must return null',
  );
});

test('didChangeConfiguration replaces snapshot and invalidates cached section responses', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'omp-intellij-replace-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const systemPath = join(root, 'system');
  const proj = join(root, 'project');
  await mkdir(systemPath);
  await mkdir(proj);
  const { id } = canonicalizeProject(proj);

  // Initial settings with multiple keys
  await updateProjectSettings(
    systemPath,
    id,
    {
      'jetbrains.java': {
        featureA: true,
        featureB: 'enabled',
      },
      keepOrDelete: 'initial',
    },
    { projectPath: proj },
  );

  let snap = await loadProjectConfiguration(systemPath, id);
  assert.equal(resolveConfigurationSection(snap?.settings, 'keepOrDelete'), 'initial');

  // Replacement update: featureB and keepOrDelete are removed
  await updateProjectSettings(
    systemPath,
    id,
    {
      'jetbrains.java': {
        featureA: false,
      },
    },
    { projectPath: proj },
  );

  snap = await loadProjectConfiguration(systemPath, id);
  // featureA is updated
  assert.equal(resolveConfigurationSection(snap?.settings, 'jetbrains.java.featureA'), false);
  // Deleted fields must not resurrect
  assert.equal(resolveConfigurationSection(snap?.settings, 'jetbrains.java.featureB'), null);
  assert.equal(resolveConfigurationSection(snap?.settings, 'keepOrDelete'), null);

  // Clearing settings with {} clears all keys
  await updateProjectSettings(systemPath, id, {}, { projectPath: proj });
  snap = await loadProjectConfiguration(systemPath, id);
  assert.deepEqual(snap?.settings, {});
  assert.equal(resolveConfigurationSection(snap?.settings, 'jetbrains.java.featureA'), null);
});
test('binary responseKey supports distinct file scopes for same section and whole-section responses', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'omp-intellij-binary-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const systemPath = join(root, 'system');
  const proj = join(root, 'project');
  await mkdir(systemPath);
  await mkdir(proj);
  const { id } = canonicalizeProject(proj);

  const fileOnePath = join(proj, 'src', 'FileOne.java');
  const fileTwoPath = join(proj, 'src', 'FileTwo.java');

  await updateProjectSettings(
    systemPath,
    id,
    { 'jetbrains.java': { indent: 4 } },
    { projectPath: proj },
  );

  // Record distinct host responses for FileOne and FileTwo for the exact same section
  // plus a whole-section response (section: null)
  await recordConfigurationItems(
    systemPath,
    id,
    [
      { scopeUri: pathToFileURL(fileOnePath).href, section: 'jetbrains.java.indent' },
      { scopeUri: pathToFileURL(fileTwoPath).href, section: 'jetbrains.java.indent' },
      { section: undefined },
    ],
    [
      2, // FileOne has indent 2
      8, // FileTwo has indent 8
      { wholeConfigOverridden: true }, // unscoped whole-section
    ],
  );

  const res = await resolveConfigurationItems(systemPath, id, [
    { scopeUri: pathToFileURL(fileOnePath).href, section: 'jetbrains.java.indent' },
    { scopeUri: pathToFileURL(fileTwoPath).href, section: 'jetbrains.java.indent' },
    { section: undefined }, // unscoped whole-section
    { section: 'jetbrains.java.indent' }, // unscoped section resolves from dynamic baseline
  ]);

  assert.deepEqual(res, [2, 8, { wholeConfigOverridden: true }, 4]);

  // Verify child section derives from parent section response for the same scope
  await recordConfigurationItems(
    systemPath,
    id,
    [{ scopeUri: pathToFileURL(fileOnePath).href, section: 'jetbrains.java' }],
    [{ 'hints.collapse complex types': true, derivedIndent: 10 }],
  );

  const derivedRes = await resolveConfigurationItems(systemPath, id, [
    { scopeUri: pathToFileURL(fileOnePath).href, section: 'jetbrains.java.derivedIndent' },
  ]);
  assert.deepEqual(derivedRes, [10]);
});

test('loadProjectConfiguration throws on malformed JSON and save cleans up temp files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'omp-intellij-malformed-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const systemPath = join(root, 'system');
  const proj = join(root, 'project');
  await mkdir(systemPath);
  await mkdir(proj);
  const { id } = canonicalizeProject(proj);

  const rawConfigDir = join(systemPath, 'plugin-metadata', 'raw-config');
  await mkdir(rawConfigDir, { recursive: true });
  await writeFile(join(rawConfigDir, `${id}.json`), 'invalid-not-json{');

  // Must throw on malformed snapshot rather than silently returning null or falsifying
  await assert.rejects(() => loadProjectConfiguration(systemPath, id), SyntaxError);

  // Must throw on truncated / incomplete snapshot structure
  await writeFile(join(rawConfigDir, `${id}.json`), JSON.stringify({ id, truncated: true }));
  await assert.rejects(
    () => loadProjectConfiguration(systemPath, id),
    /Malformed project configuration/,
  );
  // Verify successful save does not leave .tmp files behind
  await saveProjectConfiguration(systemPath, {
    id,
    projectPath: proj,
    rootUri: pathToFileURL(proj).href,
    updatedAt: Date.now(),
    settings: { valid: true },
  });

  const files = await readdir(rawConfigDir);
  assert.ok(files.includes(`${id}.json`));
  assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0);
});

test('loadDefaultPluginSettings reads single source of truth from marketplace manifest', async () => {
  const defaults = await loadDefaultPluginSettings();
  assert.ok(defaults && typeof defaults === 'object');
  assert.ok('jetbrains.java' in defaults);
  assert.ok('jetbrains.kotlin' in defaults);
});

test('getHostInitializationOptions preserves raw values without stripping', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'omp-intellij-host-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const systemPath = join(root, 'system');
  const proj = join(root, 'project');
  await mkdir(systemPath);
  await mkdir(proj);
  const { id } = canonicalizeProject(proj);

  // Raw snapshot with a string containing '[REDACTED]' as legitimate user configuration
  await updateProjectSettings(
    systemPath,
    id,
    {},
    {
      projectPath: proj,
      rawInitializationOptions: {
        pattern: 'User pattern containing [REDACTED] literal',
        nested: { token: 'real-secret' },
      },
    },
  );

  const rawOpts = await getHostInitializationOptions(systemPath, id);
  // Raw configuration must NOT be stripped of anything
  assert.deepEqual(rawOpts, {
    pattern: 'User pattern containing [REDACTED] literal',
    nested: { token: 'real-secret' },
  });

  // Legacy fallback: initialize-${id}.json was sanitized by sanitizeStatus; stripping applies only to legacy
  const legacyDir = join(systemPath, 'plugin-metadata');
  const legacyProject = canonicalizeProject(join(root, 'legacy-project'));
  const legacyId = legacyProject.id;
  await writeFile(
    join(legacyDir, `initialize-${legacyId}.json`),
    JSON.stringify({
      rootUri: legacyProject.rootUri,
      rawInitializationOptions: {
        keepMe: 'ok',
        maskedToken: '[REDACTED]',
      },
    }),
  );

  const legacyOpts = await getHostInitializationOptions(systemPath, legacyId);
  assert.deepEqual(legacyOpts, {
    keepMe: 'ok',
  });
});

test('bridge and runner yield identical values for workspace/configuration on fake server', {
  timeout: 20000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'omp-intellij-consistency-'));

  const systemPath = join(root, 'system');
  const projA = join(root, 'projectA');
  const projB = join(root, 'projectB');
  await mkdir(systemPath);
  await mkdir(projA);
  await mkdir(projB);

  const fileInA = join(projA, 'src', 'Main.java');
  const fileInB = join(projB, 'src', 'Bar.java');
  const adjacentFile = join(root, 'projectA-sibling', 'File.java');

  type RpcMessage = {
    jsonrpc?: string;
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: unknown;
  };

  const sockets = new Set<net.Socket>();
  const bridgeConfigResponse = Promise.withResolvers<unknown[]>();
  const runnerConfigResponse = Promise.withResolvers<unknown[]>();
  const runnerUpdatedResponse = Promise.withResolvers<unknown[]>();
  let didChangeCount = 0;
  const secondDidChangeForwarded = Promise.withResolvers<void>();
  const bridgeSocketResolver = Promise.withResolvers<net.Socket>();
  const runnerSocketResolver = Promise.withResolvers<net.Socket>();
  let serverConnectionCount = 0;

  const testConfigItems = [
    { section: 'jetbrains.java' },
    { section: 'jetbrains.java.hints.collapse complex types' },
    { section: 'custom literal with spaces.nested option' },
    { section: 'unknown.section' },
    // File scope inside Project A -> maps to Project A
    {
      scopeUri: pathToFileURL(fileInA).href,
      section: 'jetbrains.java.hints.collapse complex types',
    },
    // File scope inside Project B -> maps to Project B
    { scopeUri: pathToFileURL(fileInB).href, section: 'jetbrains.java' },
    // Adjacent prefix folder -> returns null
    { scopeUri: pathToFileURL(adjacentFile).href, section: 'jetbrains.java' },
  ];

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});

    socket.on(
      'data',
      frameParser((raw: unknown) => {
        const msg = raw as RpcMessage;
        if (!msg || typeof msg !== 'object') return;

        if (msg.method === 'initialize') {
          serverConnectionCount++;
          socket.write(
            encode({
              jsonrpc: '2.0',
              id: msg.id,
              result: { capabilities: { hoverProvider: true } },
            }),
          );
          socket.write(encode({ jsonrpc: '2.0', method: 'intellij/ready-for-test', params: {} }));

          if (serverConnectionCount === 1) {
            bridgeSocketResolver.resolve(socket);
          } else {
            runnerSocketResolver.resolve(socket);
          }
        } else if (msg.id === 100 && msg.result !== undefined) {
          bridgeConfigResponse.resolve(msg.result as unknown[]);
        } else if (msg.id === 200 && msg.result !== undefined) {
          runnerConfigResponse.resolve(msg.result as unknown[]);
        } else if (msg.id === 201 && msg.result !== undefined) {
          runnerUpdatedResponse.resolve(msg.result as unknown[]);
        } else if (msg.method === 'workspace/didChangeConfiguration') {
          didChangeCount++;
          if (didChangeCount >= 2) {
            secondDidChangeForwarded.resolve();
          }
        }
      }),
    );
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let childStderr = '';
  let childProcess: ChildProcess | null = null;
  let runnerSession: { close: () => Promise<void> } | null = null;
  t.after(async () => {
    if (runnerSession) {
      await runnerSession.close().catch(() => {});
    }
    if (childProcess && childProcess.exitCode === null) {
      childProcess.kill();
      await once(childProcess, 'close').catch(() => {});
    }
    for (const s of sockets) {
      try {
        s.destroy();
      } catch {}
    }
    server.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const address = server.address() as net.AddressInfo;
  await writeFile(join(systemPath, 'server.port'), String(address.port));
  await writeFile(join(systemPath, 'omp-server.json'), JSON.stringify({ pid: process.pid }));

  const configPath = join(root, 'settings.json');
  await writeFile(
    configPath,
    JSON.stringify({
      host: '127.0.0.1',
      executable: 'unused-existing-server',
      systemPath,
      startupTimeoutMs: 2000,
      initializeTimeoutMs: 2000,
      requestWaitTimeoutMs: 3000,
      idleTimeout: '30m',
      workspaceConfigPath: join(root, 'profiles'),
      cachePolicy: { retentionDays: 30, warnAboveGiB: 5, automaticDeletion: false },
    }),
  );

  // 1. Start Bridge for Project A
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../src/bridge.js', import.meta.url))],
    {
      cwd: projA,
      env: { ...process.env, OMP_INTELLIJ_SETTINGS: configPath },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  childProcess = child;
  child.stderr.on('data', (chunk: Buffer) => {
    childStderr += chunk.toString();
  });
  child.once('close', (code) => {
    if (code !== 0 && code !== null) {
      const err = new Error(`Bridge process exited with code ${code}: ${childStderr}`);
      bridgeReady.reject(err);
      bridgeConfigResponse.reject(err);
      clientConfigRequested.reject(err);
    }
  });

  const bridgeReady = Promise.withResolvers<void>();
  const clientConfigRequested = Promise.withResolvers<{ id: number; items: unknown[] }>();

  child.stdout.on(
    'data',
    frameParser((raw: unknown) => {
      const msg = raw as RpcMessage;
      if (msg?.method === 'intellij/ready-for-test') {
        bridgeReady.resolve();
      }
      if (msg?.method === 'workspace/configuration' && typeof msg.id === 'number') {
        const items = (msg.params?.items as unknown[]) || [];
        clientConfigRequested.resolve({ id: msg.id, items });
      }
    }),
  );

  // Send initialize from client
  child.stdin.write(
    encode({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        rootUri: pathToFileURL(projA).href,
        capabilities: { workspace: { configuration: true } },
        initializationOptions: { runMainCodeLens: true },
      },
    }),
  );
  await bridgeReady.promise;
  const bridgeSocket = await bridgeSocketResolver.promise;

  // Client sends workspace/didChangeConfiguration to Bridge
  const initialHostSettings = {
    'jetbrains.java': {
      'hints.collapse complex types': true,
      'hints.settings.method parameter': false,
    },
    'custom literal with spaces': {
      'nested option': 'literal-space-success',
    },
  };

  child.stdin.write(
    encode({
      jsonrpc: '2.0',
      method: 'workspace/didChangeConfiguration',
      params: {
        settings: initialHostSettings,
      },
    }),
  );

  // Fake server sends workspace/configuration to Bridge with request ID 100
  bridgeSocket.write(
    encode({
      jsonrpc: '2.0',
      id: 100,
      method: 'workspace/configuration',
      params: { items: testConfigItems },
    }),
  );

  // Client receives workspace/configuration from Bridge and responds with resolved values
  const clientReq = await clientConfigRequested.promise;
  assert.equal(clientReq.id, 100);

  const expectedValues = [
    initialHostSettings['jetbrains.java'],
    true,
    'literal-space-success',
    null,
    true, // fileInA maps to Project A
    null, // fileInB maps to Project B (unconfigured yet -> null)
    null, // adjacentFile maps to null
  ];

  child.stdin.write(
    encode({
      jsonrpc: '2.0',
      id: 100,
      result: expectedValues,
    }),
  );

  // Fake server receives the response from Bridge
  const bridgeResult = await bridgeConfigResponse.promise;
  assert.deepEqual(bridgeResult, expectedValues);

  // 2. Start Runner for Project A (runViaLsp / createLspSession)
  const runnerClientSocket = net.createConnection({ host: '127.0.0.1', port: address.port });
  sockets.add(runnerClientSocket);
  runnerClientSocket.on('error', () => {});
  await once(runnerClientSocket, 'connect');

  const session = await createLspSession(projA, {
    socket: runnerClientSocket,
    systemPath,
    initializeTimeoutMs: 2000,
    requestWaitTimeoutMs: 3000,
  });
  runnerSession = session;
  const runnerSocket = await runnerSocketResolver.promise;

  // Fake server sends workspace/configuration to Runner with request ID 200
  runnerSocket.write(
    encode({
      jsonrpc: '2.0',
      id: 200,
      method: 'workspace/configuration',
      params: { items: testConfigItems },
    }),
  );

  // Fake server receives Runner's response
  const runnerResult = await runnerConfigResponse.promise;

  // ACCEPTANCE CHECK: Bridge and Runner yield identical values!
  assert.deepEqual(
    runnerResult,
    bridgeResult,
    'Runner and Bridge must yield identical values for configured sections and scopes',
  );
  assert.deepEqual(runnerResult, expectedValues);

  // 3. Test Dynamic Updates: Client updates settings via didChangeConfiguration (feature set to false, custom removed)
  child.stdin.write(
    encode({
      jsonrpc: '2.0',
      method: 'workspace/didChangeConfiguration',
      params: {
        settings: {
          'jetbrains.java': {
            'hints.collapse complex types': false,
          },
        },
      },
    }),
  );

  // Wait deterministically for bridge to process and forward the second workspace/didChangeConfiguration
  await secondDidChangeForwarded.promise;

  // Fake server asks Runner again with request ID 201
  runnerSocket.write(
    encode({
      jsonrpc: '2.0',
      id: 201,
      method: 'workspace/configuration',
      params: {
        items: [
          { section: 'jetbrains.java.hints.collapse complex types' },
          { section: 'custom literal with spaces.nested option' }, // should be deleted (null)
        ],
      },
    }),
  );

  const updatedRunnerResult = await runnerUpdatedResponse.promise;
  assert.deepEqual(updatedRunnerResult, [false, null]);
});
