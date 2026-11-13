import assert from 'node:assert/strict';
import test from 'node:test';
import type { LspSession } from '../src/debug/run-core.js';
import {
  discoverTestsInFile,
  resolveTestLaunch,
  resolveTestTarget,
} from '../src/debug/test-launch.js';

function createMockLspSession(
  handler: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>,
): LspSession {
  return {
    rootUri: 'file:///workspace',
    nativePath: '/workspace',
    request: handler,
    notify: () => {},
    onNotification: () => () => {},
    isReady: () => true,
    reloadWorkspace: async () => ({ ready: true }),
    close: async () => {},
  };
}

test('resolveTestLaunch deduplicates testIds preserving first occurrence', async () => {
  let receivedIds: string[] | undefined;
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string; arguments: Array<{ testIds: string[] }> };
    assert.equal(cmd.command, 'intellij.jvm.resolveTestLaunch');
    receivedIds = cmd.arguments[0].testIds;
    return [
      {
        mainClass: 'com.example.Runner',
        args: [],
        runtimeClasspath: [],
        runtimeModulePath: [],
      },
    ];
  });

  await resolveTestLaunch(session, [
    'com.example.Test#test1',
    'com.example.Test#test2',
    'com.example.Test#test1',
    'com.example.Test#test3',
    'com.example.Test#test2',
  ]);

  assert.deepEqual(receivedIds, [
    'com.example.Test#test1',
    'com.example.Test#test2',
    'com.example.Test#test3',
  ]);
});

test('resolveTestLaunch rejects empty or non-string testIds', async () => {
  const session = createMockLspSession(async () => []);
  await assert.rejects(
    () => resolveTestLaunch(session, ['valid.Test', '']),
    /resolveTestLaunch: testId at index 1 must be a non-empty string/,
  );
});

test('malformed discovery responses block execution with command context', async () => {
  const malformedCases: unknown[] = [
    null,
    { not: 'array' },
    ['string-not-object'],
    [{ id: '', kind: 'SUITE' }],
    [{ id: 'com.example.Test', kind: 123 }],
    [{ id: 'com.example.Test', kind: 'CLASS' }],
  ];

  for (const badResponse of malformedCases) {
    const session = createMockLspSession(async () => badResponse);
    await assert.rejects(
      () => discoverTestsInFile(session, 'file:///workspace/Test.java'),
      /intellij\.jvm\.discoverTestsInFile:/,
    );
  }
});

test('discoverTestsInFile propagates server failure without returning empty array', async () => {
  const session = createMockLspSession(async () => {
    throw new Error('LSP discovery crash');
  });
  await assert.rejects(
    () => discoverTestsInFile(session, 'file:///workspace/Test.java'),
    /LSP discovery crash/,
  );
});

test('malformed launch specifications block launch resolution with command context', async () => {
  const malformedCases: unknown[] = [
    null,
    'not-an-array',
    [{ mainClass: '', args: [], runtimeClasspath: [], runtimeModulePath: [] }],
    [{ mainClass: 'Runner', args: ['ok', 123], runtimeClasspath: [], runtimeModulePath: [] }],
    [{ mainClass: 'Runner', args: [], runtimeClasspath: 'not-an-array', runtimeModulePath: [] }],
    [{ mainClass: 'Runner', args: [], runtimeClasspath: [] }],
  ];

  for (const badResponse of malformedCases) {
    const session = createMockLspSession(async () => badResponse);
    await assert.rejects(
      () => resolveTestLaunch(session, ['com.example.Test']),
      /intellij\.jvm\.resolveTestLaunch:/,
    );
  }
});

test('resolveTestLaunch propagates server error without returning empty array', async () => {
  const session = createMockLspSession(async () => {
    throw new Error('Server error in resolveTestLaunch');
  });
  await assert.rejects(
    () => resolveTestLaunch(session, ['com.example.Test']),
    /Server error in resolveTestLaunch/,
  );
});

test('resolveTestTarget with empty testIds selects SUITE over TEST to prevent duplicate execution', async () => {
  let resolvedTestIds: string[] | undefined;
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string; arguments: unknown[] };
    if (cmd.command === 'intellij.jvm.discoverTestsInFile') {
      return [
        { id: 'com.example.JavaGreeterTest', kind: 'SUITE', displayName: 'JavaGreeterTest' },
        { id: 'com.example.JavaGreeterTest#testGreeting', kind: 'TEST' },
        { id: 'com.example.JavaGreeterTest#testDefaultGreeting', kind: 'TEST' },
      ];
    }
    if (cmd.command === 'intellij.jvm.resolveTestLaunch') {
      const args = cmd.arguments[0] as { testIds: string[] };
      resolvedTestIds = args.testIds;
      return [
        {
          mainClass: 'com.intellij.rt.junit.JUnitStarter',
          args: ['-ideVersion5', 'com.example.JavaGreeterTest'],
          runtimeClasspath: ['/m2/junit-starter.jar'],
          runtimeModulePath: ['/m2/junit-jupiter-api.jar'],
          file: 'file:///app/src/test/java/JavaGreeterTest.java',
        },
      ];
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  const target = await resolveTestTarget(
    session,
    'file:///app/src/test/java/JavaGreeterTest.java',
    [],
  );

  assert.deepEqual(resolvedTestIds, ['com.example.JavaGreeterTest']);
  assert.equal(target.mainClass, 'com.intellij.rt.junit.JUnitStarter');
  assert.deepEqual(target.args, ['-ideVersion5', 'com.example.JavaGreeterTest']);
  assert.deepEqual(target.additionalClassPaths, ['/m2/junit-starter.jar']);
  assert.deepEqual(target.additionalModulePaths, ['/m2/junit-jupiter-api.jar']);
});

test('resolveTestTarget with empty testIds selects TESTs when no SUITE is present', async () => {
  let resolvedTestIds: string[] | undefined;
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string; arguments: unknown[] };
    if (cmd.command === 'intellij.jvm.discoverTestsInFile') {
      return [
        { id: 'com.example.ConcreteTest#method1', kind: 'TEST' },
        { id: 'com.example.ConcreteTest#method2', kind: 'TEST' },
      ];
    }
    if (cmd.command === 'intellij.jvm.resolveTestLaunch') {
      const args = cmd.arguments[0] as { testIds: string[] };
      resolvedTestIds = args.testIds;
      return [
        {
          mainClass: 'com.intellij.rt.junit.JUnitStarter',
          args: ['-ideVersion5', 'com.example.ConcreteTest,method1,method2'],
          runtimeClasspath: [],
          runtimeModulePath: [],
        },
      ];
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  const target = await resolveTestTarget(session, 'file:///test.java', []);
  assert.deepEqual(resolvedTestIds, [
    'com.example.ConcreteTest#method1',
    'com.example.ConcreteTest#method2',
  ]);
  assert.equal(target.mainClass, 'com.intellij.rt.junit.JUnitStarter');
  assert.deepEqual(target.additionalClassPaths, []);
  assert.deepEqual(target.additionalModulePaths, []);
});

test('resolveTestTarget with explicit testIds bypasses file discovery', async () => {
  let discoveryCalled = false;
  let resolvedTestIds: string[] | undefined;

  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string; arguments: unknown[] };
    if (cmd.command === 'intellij.jvm.discoverTestsInFile') {
      discoveryCalled = true;
      return [];
    }
    if (cmd.command === 'intellij.jvm.resolveTestLaunch') {
      const args = cmd.arguments[0] as { testIds: string[] };
      resolvedTestIds = args.testIds;
      return [
        {
          mainClass: 'com.intellij.rt.junit.JUnitStarter',
          args: ['-ideVersion5', 'com.example.KotlinAppTest,testKotlinCompute'],
          runtimeClasspath: ['/path/to/runner.jar'],
          runtimeModulePath: [],
        },
      ];
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  const target = await resolveTestTarget(session, 'file:///app/src/test/kotlin/KotlinAppTest.kt', [
    'com.example.KotlinAppTest#testKotlinCompute',
  ]);

  assert.equal(discoveryCalled, false);
  assert.deepEqual(resolvedTestIds, ['com.example.KotlinAppTest#testKotlinCompute']);
  assert.equal(target.mainClass, 'com.intellij.rt.junit.JUnitStarter');
});

test('resolveTestTarget throws explicit error when file discovery yields no runnable tests', async () => {
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string };
    if (cmd.command === 'intellij.jvm.discoverTestsInFile') {
      return [];
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  await assert.rejects(
    () => resolveTestTarget(session, 'file:///EmptyTest.java', []),
    (err: Error) => {
      assert.equal(
        err.message,
        'No runnable tests discovered; provide explicit test IDs if discovery is unavailable',
      );
      return true;
    },
  );
});

test('resolveTestTarget throws exact error when zero test launch specifications are returned', async () => {
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string };
    if (cmd.command === 'intellij.jvm.resolveTestLaunch') {
      return [];
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  await assert.rejects(
    () => resolveTestTarget(session, 'file:///Test.java', ['com.example.Test']),
    (err: Error) => {
      assert.equal(err.message, 'No test launch specification returned');
      return true;
    },
  );
});

test('resolveTestTarget throws exact error when multiple launch specifications are returned', async () => {
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string };
    if (cmd.command === 'intellij.jvm.resolveTestLaunch') {
      return [
        { mainClass: 'RunnerA', args: [], runtimeClasspath: [], runtimeModulePath: [] },
        { mainClass: 'RunnerB', args: [], runtimeClasspath: [], runtimeModulePath: [] },
      ];
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  await assert.rejects(
    () => resolveTestTarget(session, 'file:///Test.java', ['com.example.Test']),
    (err: Error) => {
      assert.equal(
        err.message,
        'Selected tests require multiple launch specifications; launch each group separately',
      );
      return true;
    },
  );
});

test('resolveTestTarget forwards runner paths as additions instead of replacing the module runtime', async () => {
  const session = createMockLspSession(async (_method, params) => {
    const cmd = params as { command: string };
    if (cmd.command === 'intellij.jvm.resolveTestLaunch') {
      return [
        {
          mainClass: 'com.example.Runner',
          args: ['run'],
          runtimeClasspath: ['/shared/common.jar', '/unique/runner.jar', '/shared/common.jar'],
          runtimeModulePath: ['/mods/test'],
        },
      ];
    }
    throw new Error(`Unexpected command: ${cmd.command}`);
  });

  const target = await resolveTestTarget(session, 'file:///Test.java', ['com.example.Test']);
  assert.deepEqual(target.additionalClassPaths, [
    '/shared/common.jar',
    '/unique/runner.jar',
    '/shared/common.jar',
  ]);
  assert.deepEqual(target.additionalModulePaths, ['/mods/test']);
  assert.equal(
    Object.keys(target).some((key) => key === 'javaExec' || key === 'classpath'),
    false,
  );
});
