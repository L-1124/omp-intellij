import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { glob, mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  getDebugSessionsDir,
  listDebugSessions,
  recoverDebugSession,
} from '../../src/debug/control.js';
import { executeIntellij } from '../../src/extension/intellij-tool.js';
import { readProjectState } from '../../src/project/connection-state.js';
import { canonicalizeProject } from '../../src/project/metadata.js';
import type { ExtensionContext } from '../../src/shared/extension-types.js';
import {
  copyWorkspaceFixture,
  createDapClientDriver,
  createIntegrationSandbox,
  createLspClientDriver,
  createTcpGate,
  generateLargeJavaProject,
  isProcessAlive,
  isSandboxServerProcess,
  killProcessSafely,
  startExternalAttachTarget,
  verifyPrerequisites,
} from './fixture.js';

const prerequisites = await verifyPrerequisites();
test('dual project concurrency: JDK 17 and JDK 21 independent debugging and session recovery', async () => {
  const sandbox = await createIntegrationSandbox(prerequisites);

  try {
    const jdk17Dir = await copyWorkspaceFixture('jdk17', sandbox);
    const jdk21Dir = await copyWorkspaceFixture('jdk21', sandbox);

    const bridge17 = createLspClientDriver(jdk17Dir, sandbox);
    const bridge21 = createLspClientDriver(jdk21Dir, sandbox);

    // Initialize both bridges concurrently
    const init17Promise = bridge17.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(jdk17Dir).href,
      rootPath: jdk17Dir,
      capabilities: { window: { workDoneProgress: true }, experimental: { licensingUi: true } },
    });
    const init21Promise = bridge21.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(jdk21Dir).href,
      rootPath: jdk21Dir,
      capabilities: { window: { workDoneProgress: true }, experimental: { licensingUi: true } },
    });

    await Promise.all([init17Promise, init21Promise]);
    bridge17.notify('initialized', {});
    bridge21.notify('initialized', {});

    // Wait for indexing to complete on both projects using executeIntellij
    const [index17, index21] = await Promise.all([
      executeIntellij(
        { action: 'wait', project: jdk17Dir, timeout: 120 },
        undefined,
        undefined,
        { cwd: jdk17Dir } as ExtensionContext,
        { systemPath: sandbox.systemPath },
      ),
      executeIntellij(
        { action: 'wait', project: jdk21Dir, timeout: 120 },
        undefined,
        undefined,
        { cwd: jdk21Dir } as ExtensionContext,
        { systemPath: sandbox.systemPath },
      ),
    ]);

    assert.equal(index17.details?.phase, 'ready', 'JDK 17 project must be ready');
    assert.equal(index21.details?.phase, 'ready', 'JDK 21 project must be ready');

    // Verify server PID from omp-server.json
    const serverOwnerFile = join(sandbox.systemPath, 'omp-server.json');
    assert.ok(existsSync(serverOwnerFile), 'omp-server.json must exist');
    const owner = JSON.parse(await readFile(serverOwnerFile, 'utf8')) as { pid?: number };
    const initialServerPid = owner.pid;
    assert.ok(initialServerPid && initialServerPid > 0, 'Server owner PID must be valid');

    const app17Source = join(jdk17Dir, 'src', 'main', 'java', 'com', 'example', 'App.java');
    const app21Source = join(jdk21Dir, 'src', 'main', 'java', 'com', 'example', 'App.java');

    // Launch DAP debug sessions for both projects
    const dap17 = createDapClientDriver(jdk17Dir, sandbox);
    const dap21 = createDapClientDriver(jdk21Dir, sandbox);

    await dap17.request('initialize', { clientID: 'test-concurrency', adapterID: 'intellij' });
    await dap21.request('initialize', { clientID: 'test-concurrency', adapterID: 'intellij' });

    // Set breakpoints on line 8 (deterministic breakpoint line)
    await dap17.request('setBreakpoints', {
      source: { path: app17Source },
      breakpoints: [{ line: 8 }],
    });
    await dap21.request('setBreakpoints', {
      source: { path: app21Source },
      breakpoints: [{ line: 8 }],
    });

    // Launch using required program/file and project parameters with buildTool: 'gradle'
    await Promise.all([
      dap17.request('launch', {
        file: app17Source,
        project: jdk17Dir,
        build: true,
        buildTool: 'gradle',
        mainClass: 'com.example.App',
      }),
      dap21.request('launch', {
        file: app21Source,
        project: jdk21Dir,
        build: true,
        buildTool: 'gradle',
        mainClass: 'com.example.App',
      }),
    ]);

    await dap17.request('configurationDone');
    await dap21.request('configurationDone');

    // Wait for stopped event at line 8 breakpoint
    const [stopped17, stopped21] = await Promise.all([
      dap17.waitForEvent('stopped', 45000),
      dap21.waitForEvent('stopped', 45000),
    ]);

    const threadId17 = (stopped17.body as { threadId?: number })?.threadId;
    const threadId21 = (stopped21.body as { threadId?: number })?.threadId;
    assert.ok(threadId17 && threadId21, 'Stopped events must provide actual thread IDs');

    // Get actual stack frame IDs from threads
    const [stack17, stack21] = await Promise.all([
      dap17.request('stackTrace', { threadId: threadId17, startFrame: 0, levels: 1 }),
      dap21.request('stackTrace', { threadId: threadId21, startFrame: 0, levels: 1 }),
    ]);

    const frameId17 = (stack17.body as { stackFrames: Array<{ id: number }> }).stackFrames[0]?.id;
    const frameId21 = (stack21.body as { stackFrames: Array<{ id: number }> }).stackFrames[0]?.id;
    assert.ok(frameId17 !== undefined, 'Stack frame 17 must exist');
    assert.ok(frameId21 !== undefined, 'Stack frame 21 must exist');

    // Evaluate Java version and project ID at breakpoint
    const javaVersion17 = await dap17.evaluate('System.getProperty("java.version")', frameId17);
    assert.match(String(javaVersion17), /^"?17/, `Expected JDK 17, got ${javaVersion17}`);

    const projectId17 = await dap17.evaluate('com.example.App.PROJECT_ID', frameId17);
    assert.match(String(projectId17), /jdk17/, `Expected project ID jdk17, got ${projectId17}`);

    const javaVersion21 = await dap21.evaluate('System.getProperty("java.version")', frameId21);
    assert.match(String(javaVersion21), /^"?21/, `Expected JDK 21, got ${javaVersion21}`);

    const projectId21 = await dap21.evaluate('com.example.App.PROJECT_ID', frameId21);
    assert.match(String(projectId21), /jdk21/, `Expected project ID jdk21, got ${projectId21}`);

    // Continue execution on both
    await dap17.request('continue', { threadId: threadId17 });
    await dap21.request('continue', { threadId: threadId21 });

    // Wait for heartbeat output from both running apps
    await Promise.all([
      dap17.waitForOutputSubstring('HEARTBEAT_17=', 15000),
      dap21.waitForOutputSubstring('HEARTBEAT_21=', 15000),
    ]);

    // Create a second debug session in jdk21
    const dap21Second = createDapClientDriver(jdk21Dir, sandbox);
    await dap21Second.request('initialize', {
      clientID: 'test-concurrency-second',
      adapterID: 'intellij',
    });
    await dap21Second.request('launch', {
      file: app21Source,
      project: jdk21Dir,
      noDebug: true,
      build: false,
      mainClass: 'com.example.App',
    });
    await dap21Second.request('configurationDone');

    const sessions21 = await listDebugSessions({
      systemPath: sandbox.systemPath,
      projectRoot: jdk21Dir,
    });
    const sessionToRecover = sessions21.find((s) => s.pid === dap21.process.pid);
    const survivingSession = sessions21.find((s) => s.pid === dap21Second.process.pid);
    assert.ok(sessionToRecover?.live, 'Session 1 must be active in jdk21');
    assert.ok(survivingSession?.live, 'Session 2 must be active in jdk21');

    // Targeted recovery of session 2 by UUID
    const recovered = await recoverDebugSession({
      systemPath: sandbox.systemPath,
      projectRoot: jdk21Dir,
      id: survivingSession.id,
    });
    assert.ok(recovered, 'Targeted recovery of debug session 2 succeeded');
    for (const survivor of [
      { dap: dap17, source: app17Source, previous: stopped17.seq, version: '17', project: 'jdk17' },
      { dap: dap21, source: app21Source, previous: stopped21.seq, version: '21', project: 'jdk21' },
    ]) {
      await survivor.dap.request('setBreakpoints', {
        source: { path: survivor.source },
        breakpoints: [{ line: 13 }],
      });
      const stopped = await survivor.dap.waitFor(
        (message) =>
          message.type === 'event' &&
          message.event === 'stopped' &&
          message.seq > survivor.previous,
        10000,
      );
      assert.ok(stopped.body && typeof stopped.body === 'object' && 'threadId' in stopped.body);
      const threadId = stopped.body.threadId;
      assert.equal(typeof threadId, 'number');
      const stack = await survivor.dap.request('stackTrace', {
        threadId,
        startFrame: 0,
        levels: 1,
      });
      assert.ok(stack.body && typeof stack.body === 'object' && 'stackFrames' in stack.body);
      const frames = stack.body.stackFrames;
      assert.ok(Array.isArray(frames) && Number.isInteger(frames[0]?.id));
      assert.match(
        String(await survivor.dap.evaluate('System.getProperty("java.version")', frames[0].id)),
        new RegExp(`^"?${survivor.version}`),
      );
      assert.match(
        String(await survivor.dap.evaluate('com.example.App.PROJECT_ID', frames[0].id)),
        new RegExp(survivor.project),
      );
      await survivor.dap.request('setBreakpoints', {
        source: { path: survivor.source },
        breakpoints: [],
      });
      await survivor.dap.request('continue', { threadId });
    }

    // Verify same-project survivor (dap21 session 1) and cross-project survivor (dap17) continue heartbeating
    await dap17.waitForOutputSubstring('HEARTBEAT_17=', 15000);
    await dap21.waitForOutputSubstring('HEARTBEAT_21=', 15000);

    // Verify server PID in omp-server.json remains unchanged
    const ownerAfter = JSON.parse(await readFile(serverOwnerFile, 'utf8')) as { pid?: number };
    assert.equal(ownerAfter.pid, initialServerPid, 'Server PID must remain stable');

    await dap17.close();
    await dap21.close();
    await dap21Second.close();
    await bridge17.close();
    await bridge21.close();
  } finally {
    await sandbox.cleanup();
  }
});

test('indexing cancellation: wait cancellation releases barrier and permits subsequent requests', async () => {
  const sandbox = await createIntegrationSandbox(prerequisites);

  try {
    const largeProjectDir = await copyWorkspaceFixture('jdk21', sandbox);
    await generateLargeJavaProject(largeProjectDir, 5000);
    const referenceFile = join(largeProjectDir, 'src/main/java/com/example/bigtree/UseBig.java');
    const referenceText =
      'package com.example.bigtree;\n\npublic class UseBig { int value = BigClass00001.value(); }\n';
    await writeFile(referenceFile, referenceText, 'utf8');

    const bridge = createLspClientDriver(largeProjectDir, sandbox);
    await bridge.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(largeProjectDir).href,
      rootPath: largeProjectDir,
      capabilities: { window: { workDoneProgress: true }, experimental: { licensingUi: true } },
    });
    bridge.notify('initialized', {});

    // Poll until project state enters connecting, importing, or indexing
    let state = await readProjectState(sandbox.systemPath, largeProjectDir);
    const waitDeadline = Date.now() + 15000;
    while (Date.now() < waitDeadline && ['not-started', 'connecting'].includes(state.phase)) {
      await sleep(200);
      state = await readProjectState(sandbox.systemPath, largeProjectDir);
    }
    assert.ok(
      ['importing', 'indexing'].includes(state.phase),
      `Expected active import, got ${state.phase}`,
    );

    const serverOwnerFile = join(sandbox.systemPath, 'omp-server.json');
    const owner = JSON.parse(await readFile(serverOwnerFile, 'utf8')) as { pid?: number };
    const serverPid = owner.pid;
    assert.ok(serverPid && serverPid > 0);

    // Cancel index wait with AbortController
    const abortController = new AbortController();
    const waitPromise = executeIntellij(
      { action: 'wait', project: largeProjectDir, timeout: 60 },
      abortController.signal,
      undefined,
      { cwd: largeProjectDir } as ExtensionContext,
      { systemPath: sandbox.systemPath },
    );

    // Abort after a short delay while in-flight
    await sleep(150);
    abortController.abort(new Error('Index wait aborted'));
    const cancelledAt = Date.now();

    let waitCancelled = false;
    try {
      await waitPromise;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        waitCancelled = true;
      }
    }
    assert.ok(waitCancelled, 'executeIntellij wait rejected with AbortError');
    assert.ok(Date.now() - cancelledAt < 2000, 'Only the index wait must cancel promptly');

    // Verify server process is still alive and healthy
    assert.ok(isProcessAlive(serverPid), 'Server process must survive index wait cancellation');

    // Now wait for indexing to reach ready state
    const readyResult = await executeIntellij(
      { action: 'wait', project: largeProjectDir, timeout: 120 },
      undefined,
      undefined,
      { cwd: largeProjectDir } as ExtensionContext,
      { systemPath: sandbox.systemPath },
    );
    assert.equal(
      readyResult.details?.phase,
      'ready',
      'Big tree indexing must complete successfully',
    );

    // Perform a real definition query on one of the generated classes to verify readiness
    const classFile = join(
      largeProjectDir,
      'src',
      'main',
      'java',
      'com',
      'example',
      'bigtree',
      'BigClass00001.java',
    );
    const referenceUri = pathToFileURL(referenceFile).href;

    bridge.notify('textDocument/didOpen', {
      textDocument: { uri: referenceUri, languageId: 'java', version: 1, text: referenceText },
    });

    const definitionResult = await bridge.request('textDocument/definition', {
      textDocument: { uri: referenceUri },
      position: { line: 2, character: referenceText.split('\n')[2].indexOf('BigClass00001') + 2 },
    });
    const definition = Array.isArray(definitionResult) ? definitionResult[0] : definitionResult;
    assert.ok(definition && typeof definition === 'object');
    const targetUri =
      'uri' in definition
        ? definition.uri
        : 'targetUri' in definition
          ? definition.targetUri
          : undefined;
    assert.equal(typeof targetUri, 'string');
    assert.equal(
      canonicalizeProject(String(targetUri)).canonicalPath,
      canonicalizeProject(classFile).canonicalPath,
    );

    await bridge.close();
  } finally {
    await sandbox.cleanup();
  }
});

test('build cancellation: aborting DAP launch terminates process tree and preserves shared daemon', async () => {
  const sandbox = await createIntegrationSandbox(prerequisites);

  try {
    const jdk17Dir = await copyWorkspaceFixture('jdk17', sandbox);
    const jdk21Dir = await copyWorkspaceFixture('jdk21', sandbox);

    // Keep active sibling session in jdk21
    const siblingDap = createDapClientDriver(jdk21Dir, sandbox);
    const app21Source = join(jdk21Dir, 'src', 'main', 'java', 'com', 'example', 'App.java');
    await siblingDap.request('initialize', { clientID: 'test-sibling', adapterID: 'intellij' });
    await siblingDap.request('launch', {
      file: app21Source,
      project: jdk21Dir,
      noDebug: true,
      build: true,
      mainClass: 'com.example.App',
    });
    await siblingDap.request('configurationDone');
    await siblingDap.waitForOutputSubstring('HEARTBEAT_21=', 15000);

    const buildDir = join(jdk17Dir, 'build');
    await mkdir(buildDir, { recursive: true });

    // Arm build gate trigger
    const triggerFile = join(buildDir, 'build-gate-trigger.txt');
    const gateFile = join(buildDir, 'build-gate.txt');
    await writeFile(triggerFile, 'trigger', 'utf8');

    const app17Source = join(jdk17Dir, 'src', 'main', 'java', 'com', 'example', 'App.java');
    const dap = createDapClientDriver(jdk17Dir, sandbox);
    await dap.request('initialize', { clientID: 'test-build-cancellation', adapterID: 'intellij' });
    const ownershipMarker = randomUUID();

    // Initiate launch which executes Gradle build
    const launchPromise = dap.request('launch', {
      file: app17Source,
      project: jdk17Dir,
      build: true,
      buildTool: 'gradle',
      mainClass: 'com.example.App',
      vmArgs: [`-Domp.intellij.test.ownership=${ownershipMarker}`],
    });
    launchPromise.catch(() => {});

    // Await actual marker from build gate (no fake timers)
    await dap.waitForOutputSubstring('BUILD_GATE_WAITING', 45000);
    const daemonPids: number[] = [];
    for await (const file of glob('daemon/*/daemon-*.out.log', { cwd: sandbox.gradleUserHome })) {
      const pid = Number(/daemon-(\d+)\.out\.log$/.exec(file)?.[1]);
      if (Number.isSafeInteger(pid) && isProcessAlive(pid)) daemonPids.push(pid);
    }
    assert.ok(
      daemonPids.length > 0,
      'A shared sandbox Gradle daemon must exist before cancellation',
    );

    // Capture snapshot and control port
    const sessions = await listDebugSessions({
      systemPath: sandbox.systemPath,
      projectRoot: jdk17Dir,
    });
    const launchSession = sessions.find((x) => x.pid === dap.process.pid);
    assert.ok(launchSession?.live, 'Session must be active while waiting in build');
    const { port: controlPort } = JSON.parse(
      await readFile(
        join(getDebugSessionsDir(sandbox.systemPath, jdk17Dir), `${launchSession.id}.json`),
        'utf8',
      ),
    ) as { port: number };
    assert.ok(controlPort > 0, 'Owned debug control endpoint must exist');

    // Close client stdin to trigger cancellation
    dap.process.stdin?.end();

    // Release build gate latch so Gradle finishes cleanly
    await writeFile(gateFile, 'proceed', 'utf8');

    // Await actual proxy process exit
    await dap.waitForExit(15000);
    assert.ok(dap.process.exitCode !== null || dap.process.signalCode !== null, 'DAP proxy exited');
    for (const pid of daemonPids)
      assert.equal(
        isProcessAlive(pid),
        true,
        `Shared Gradle daemon ${pid} must survive cancellation`,
      );
    const targets = spawnSync(
      join(prerequisites.jdk21Path, 'bin', process.platform === 'win32' ? 'jps.exe' : 'jps'),
      ['-v'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    assert.equal(targets.status, 0, 'Owned target probe must succeed');
    assert.equal(
      targets.stdout.includes(`-Domp.intellij.test.ownership=${ownershipMarker}`),
      false,
      'Cancelled launch must leave no marked target JVM',
    );

    // Confirm control port is no longer connectable
    if (controlPort) {
      let connectable = false;
      try {
        const sock = net.createConnection({ host: '127.0.0.1', port: controlPort });
        const { promise, resolve: resolveConn } = Promise.withResolvers<void>();
        sock.once('connect', () => {
          connectable = true;
          sock.destroy();
          resolveConn();
        });
        sock.once('error', () => resolveConn());
        await promise;
      } catch {}
      assert.equal(connectable, false, 'Control port must be closed');
    }

    // Verify sibling session survived and heartbeats continue
    await siblingDap.waitForOutputSubstring('HEARTBEAT_21=', 15000);
    await siblingDap.close();
  } finally {
    await sandbox.cleanup();
  }
});

test('attach cancellation: aborting handshake disconnects proxy and leaves target JVM intact', async () => {
  const sandbox = await createIntegrationSandbox(prerequisites);

  try {
    const project = await copyWorkspaceFixture('jdk21', sandbox);
    const bridge = createLspClientDriver(project, sandbox);
    await bridge.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(project).href,
      rootPath: project,
      workspaceFolders: [{ uri: pathToFileURL(project).href, name: 'jdk21' }],
      capabilities: { window: { workDoneProgress: true }, experimental: { licensingUi: true } },
    });
    bridge.notify('initialized', {});
    const source = join(project, 'src/main/java/com/example/App.java');
    bridge.notify('textDocument/didOpen', {
      textDocument: {
        uri: pathToFileURL(source).href,
        languageId: 'java',
        version: 1,
        text: await readFile(source, 'utf8'),
      },
    });
    const indexed = await executeIntellij(
      { action: 'wait', project, timeout: 120 },
      undefined,
      undefined,
      { cwd: project },
      { systemPath: sandbox.systemPath },
    );
    assert.equal(indexed.details?.phase, 'ready', JSON.stringify(indexed.details));
    const target = await startExternalAttachTarget(
      prerequisites.jdk21Path,
      sandbox.workspacesDir,
      sandbox,
    );
    assert.ok(target.jdwpPort > 0, `JDWP port must be positive: ${target.jdwpPort}`);

    // Create TCP gate holding bytes
    const gate = await createTcpGate(target.jdwpPort, sandbox);

    const dap = createDapClientDriver(project, sandbox);
    await dap.request('initialize', {
      clientID: 'test-attach-cancellation',
      adapterID: 'intellij',
    });

    // Send attach pointing to gate port
    const attachPromise = dap.request(
      'attach',
      {
        host: '127.0.0.1',
        port: gate.gatePort,
        timeout: 5000,
      },
      8000,
    );
    attachPromise.catch(() => {});

    // Await actual handshake bytes observed by the gate
    await gate.waitForBytesObserved(15000);

    // Cancel attach with terminateDebuggee: false (never true for external targets)
    try {
      await dap.request('disconnect', { terminateDebuggee: false }, 3000);
    } catch {}
    dap.process.stdin?.end();
    await dap.waitForExit(10000);

    gate.release();
    await gate.close();

    // Verify external target JVM is still alive and generating heartbeats
    const heartbeatsBeforeCancellation = target.heartbeats;
    await sleep(600);
    assert.ok(
      target.heartbeats > heartbeatsBeforeCancellation,
      'Target must continue heartbeating after cancellation',
    );

    // Re-attach to latest announced target JDWP port
    const dapReattach = createDapClientDriver(project, sandbox);
    await dapReattach.request('initialize', { clientID: 'test-reattach', adapterID: 'intellij' });
    const reattachResp = await dapReattach.request('attach', {
      host: '127.0.0.1',
      port: target.jdwpPort,
      timeout: 10000,
    });
    assert.equal(reattachResp.success, true, 'Re-attach to target JDWP port must succeed');
    await dapReattach.request('configurationDone');

    const threadsResp = await dapReattach.request('threads');
    assert.ok(
      Array.isArray((threadsResp.body as { threads?: unknown[] })?.threads),
      'Threads query succeeded on reattached JVM',
    );

    await dapReattach.request('disconnect', { terminateDebuggee: false });
    await dapReattach.waitForExit(10000);

    const heartbeatsBeforeDisconnect = target.heartbeats;
    await sleep(600);
    assert.ok(
      target.heartbeats > heartbeatsBeforeDisconnect,
      'Target continues heartbeating after reattach disconnect',
    );

    target.close();
  } finally {
    await sandbox.cleanup();
  }
});

test('process isolation: killed proxy marks session unrecoverable and preserves sibling sessions', async () => {
  const sandbox = await createIntegrationSandbox(prerequisites);

  try {
    const jdk21Dir = await copyWorkspaceFixture('jdk21', sandbox);
    const app21Source = join(jdk21Dir, 'src', 'main', 'java', 'com', 'example', 'App.java');

    const terminatedClient = createDapClientDriver(jdk21Dir, sandbox);
    const survivingClient = createDapClientDriver(jdk21Dir, sandbox);

    await terminatedClient.request('initialize', {
      clientID: 'test-kill-1',
      adapterID: 'intellij',
    });
    await terminatedClient.request('launch', {
      file: app21Source,
      project: jdk21Dir,
      noDebug: true,
      build: true,
      mainClass: 'com.example.App',
    });
    await terminatedClient.request('configurationDone');

    await survivingClient.request('initialize', { clientID: 'test-kill-2', adapterID: 'intellij' });
    await survivingClient.request('launch', {
      file: app21Source,
      project: jdk21Dir,
      noDebug: true,
      build: false,
      mainClass: 'com.example.App',
    });
    await survivingClient.request('configurationDone');

    // Both sessions must be active and present
    const sessions = await listDebugSessions({
      systemPath: sandbox.systemPath,
      projectRoot: jdk21Dir,
    });
    const terminatedSession = sessions.find((s) => s.pid === terminatedClient.process.pid);
    const survivingSession = sessions.find((s) => s.pid === survivingClient.process.pid);
    assert.ok(terminatedSession?.live, 'Session 1 must be active');
    assert.ok(survivingSession?.live, 'Session 2 must be active');

    // Strong kill proxy 1 PID
    const terminatedProxyPid = terminatedClient.process.pid;
    assert.ok(terminatedProxyPid, 'dap1 PID must exist');
    killProcessSafely(terminatedProxyPid, sandbox);
    await terminatedClient.waitForExit();

    // Query listDebugSessions: must assert killed session is present and marked unrecoverable
    const sessionsAfter = await listDebugSessions({
      systemPath: sandbox.systemPath,
      projectRoot: jdk21Dir,
    });
    const killed = sessionsAfter.find((s) => s.id === terminatedSession.id);
    assert.ok(killed, 'Killed session must be recorded in debug metadata');
    assert.equal(killed.live, false, 'Killed session must be reported dead');
    assert.match(
      killed.detail,
      /unrecoverable \(proxy PID \d+ exited; backend connection lost\)/,
      'Killed session must show unrecoverable detail',
    );

    // Verify survivor session 2 continues heartbeating
    await survivingClient.waitForOutputSubstring('HEARTBEAT_21=', 15000);
    await survivingClient.close();
  } finally {
    await sandbox.cleanup();
  }
});

test('crash recovery: terminated server transitions connection to disconnected with bounded wait [smoke]', async () => {
  const sandbox = await createIntegrationSandbox(prerequisites);

  try {
    const jdk17Dir = await copyWorkspaceFixture('jdk17', sandbox);
    const app17Source = join(jdk17Dir, 'src', 'main', 'java', 'com', 'example', 'App.java');

    const bridge = createLspClientDriver(jdk17Dir, sandbox);
    await bridge.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(jdk17Dir).href,
      rootPath: jdk17Dir,
      capabilities: { window: { workDoneProgress: true }, experimental: { licensingUi: true } },
    });
    bridge.notify('initialized', {});

    const fileContent = await readFile(app17Source, 'utf8');
    bridge.notify('textDocument/didOpen', {
      textDocument: {
        uri: pathToFileURL(app17Source).href,
        languageId: 'java',
        version: 1,
        text: fileContent,
      },
    });

    const dap = createDapClientDriver(jdk17Dir, sandbox);
    await dap.request('initialize', { clientID: 'test-crash-dap', adapterID: 'intellij' });

    // Send real semantic request on bridge and launch request on DAP
    const pending = Promise.allSettled([
      bridge.request(
        'textDocument/definition',
        {
          textDocument: { uri: pathToFileURL(app17Source).href },
          position: { line: 5, character: 20 },
        },
        10000,
      ),
      dap.request(
        'launch',
        {
          file: app17Source,
          project: jdk17Dir,
          noDebug: true,
          build: false,
          mainClass: 'com.example.App',
        },
        10000,
      ),
    ]);

    // Verify server PID and kill only verified sandbox server
    const serverOwnerFile = join(sandbox.systemPath, 'omp-server.json');
    const owner = JSON.parse(await readFile(serverOwnerFile, 'utf8')) as { pid?: number };
    const serverPid = owner.pid;
    assert.ok(serverPid && isSandboxServerProcess(serverPid, sandbox.systemPath));

    killProcessSafely(serverPid, sandbox);

    assert.deepEqual(
      (await pending).map((result) => result.status),
      ['rejected', 'rejected'],
    );

    await bridge.waitForExit();
    const disconnected = await readProjectState(sandbox.systemPath, jdk17Dir);
    assert.equal(disconnected.phase, 'disconnected');
    assert.equal(disconnected.live, false);
    await dap.close();
  } finally {
    await sandbox.cleanup();
  }
});

test('build gate timeout: long-running Gradle launch resolves upon gate release', async () => {
  const sandbox = await createIntegrationSandbox(prerequisites);

  try {
    const jdk17Dir = await copyWorkspaceFixture('jdk17', sandbox);
    const buildDir = join(jdk17Dir, 'build');
    await mkdir(buildDir, { recursive: true });

    const triggerFile = join(buildDir, 'build-gate-trigger.txt');
    const gateFile = join(buildDir, 'build-gate.txt');
    await writeFile(triggerFile, 'trigger', 'utf8');

    const app17Source = join(jdk17Dir, 'src', 'main', 'java', 'com', 'example', 'App.java');
    const dap = createDapClientDriver(jdk17Dir, sandbox);
    await dap.request('initialize', { clientID: 'test-build-deadline', adapterID: 'intellij' });

    // Initiate launch with build
    const launchPromise = dap.request(
      'launch',
      {
        file: app17Source,
        project: jdk17Dir,
        build: true,
        buildTool: 'gradle',
        mainClass: 'com.example.App',
        noDebug: true,
      },
      60000,
    );

    // Await actual gate marker on output
    await dap.waitForOutputSubstring('BUILD_GATE_WAITING', 45000);
    const holdStart = Date.now();

    // Hold latch for > 15 seconds to simulate deterministic long build
    await sleep(15500);
    await writeFile(gateFile, 'proceed', 'utf8');

    // Launch must complete successfully
    const launchResp = await launchPromise;
    assert.equal(launchResp.success, true, 'Launch must succeed after latch release');
    await dap.request('configurationDone');

    // Confirm application actually started and emitted heartbeat
    await dap.waitForOutputSubstring('HEARTBEAT_17=', 30000);

    const holdElapsed = Date.now() - holdStart;
    assert.ok(holdElapsed >= 15000, `Long build hold was ${holdElapsed}ms (>= 15000ms)`);

    await dap.close();
  } finally {
    await sandbox.cleanup();
  }
});
