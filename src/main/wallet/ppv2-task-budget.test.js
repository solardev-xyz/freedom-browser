const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createPPv2TaskBudget } = require('./ppv2-task-budget');
let scope, handle, events, budget;
beforeEach(() => {
  scope = createPrivacyScope({ profileId: 'budget-fixture', signal: new AbortController().signal });
  handle = scope.getContext({
    kind: 'private-account',
    principal: 'ppv2:0',
    protocol: 'privacy-pools-v2',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'session',
  });
  events = [];
  budget = createPPv2TaskBudget({ scope, handle, onProgress: (e) => events.push(e) });
});
afterEach(() => scope.close());
test('bounds an uncooperative task, revokes its capabilities and observes late rejection', async () => {
  let rejectLate;
  const task = budget.run(
    'session-open',
    () =>
      new Promise((_, reject) => {
        rejectLate = reject;
      }),
    10
  );
  await expect(task).rejects.toMatchObject({ code: 'PRIVATE_PPV2_TASK_TIMEOUT' });
  expect(() => getPrivacyContext(handle)).toThrow();
  expect(events.map((e) => e.stage)).toEqual(['started', 'timed-out']);
  rejectLate(new Error('sensitive SDK diagnostic'));
  await new Promise((resolve) => setImmediate(resolve));
  expect(events).toHaveLength(2);
});
test('completion clears the timer and diagnostic failure cannot revoke successful work', async () => {
  budget = createPPv2TaskBudget({
    scope,
    handle,
    onProgress: async () => {
      throw new Error('observer');
    },
  });
  await expect(budget.run('session-open', async () => 7, 10)).resolves.toBe(7);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(() => getPrivacyContext(handle)).not.toThrow();
});
test('progress filters diagnostics and rejects a concurrent budget without aborting the first', async () => {
  let finish;
  const pending = budget.run(
    'operation',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  await new Promise((resolve) => setImmediate(resolve));
  budget.progress('history', {
    completedWindows: 2,
    scannedBlocks: 10000,
    url: 'sensitive',
    commitment: 'secret',
    privateKey: 'secret',
  });
  await expect(budget.run('operation', async () => {})).rejects.toThrow();
  finish(true);
  await pending;
  expect(Object.keys(events[1]).sort()).toEqual([
    'completedWindows',
    'elapsedMs',
    'scannedBlocks',
    'stage',
    'task',
  ]);
  expect(Object.isFrozen(events[1])).toBe(true);
  expect(events.map((e) => e.stage)).toEqual(['started', 'history', 'complete']);
});

test('completed scan windows extend five-minute work, but duplicate progress cannot keep a stalled scan alive', async () => {
  jest.useFakeTimers();
  try {
    const pending = budget.run('sdk-operation', () => new Promise(() => {}), 300000, {
      allowScanProgress: true,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'PRIVATE_PPV2_TASK_TIMEOUT' });
    await jest.advanceTimersByTimeAsync(240000);
    budget.progress('history', { completedWindows: 1, scannedBlocks: 5000 });
    await jest.advanceTimersByTimeAsync(240000);
    expect(scope.signal.aborted).toBe(false); // Beyond the old absolute cutoff.
    budget.progress('history', { completedWindows: 1, scannedBlocks: 5000 });
    await jest.advanceTimersByTimeAsync(60000);
    await rejected;
  } finally {
    jest.useRealTimers();
  }
});

test('repeated completed scans exhaust the work ceiling independently of latency', async () => {
  jest.useFakeTimers();
  try {
    const pending = budget.run('session-open', () => new Promise(() => {}), 300000, {
      allowScanProgress: true,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'PRIVATE_PPV2_SCAN_LIMIT' });
    for (let i = 1; i <= 193; i++) {
      await jest.advanceTimersByTimeAsync(100000);
      if (i === 193)
        expect(() =>
          budget.beforeScan({ fromBlock: 0n, toBlock: 4999n, floor: 0n, head: 4999n })
        ).toThrow();
      else budget.beforeScan({ fromBlock: 0n, toBlock: 4999n, floor: 0n, head: 4999n });
      budget.progress('history', { completedWindows: i, scannedBlocks: i * 5000 });
    }
    await rejected;
    expect(events.at(-1).stage).toBe('scan-limit');
  } finally {
    jest.useRealTimers();
  }
});

test('a submission timeout explicitly retains outcome uncertainty', async () => {
  await expect(
    budget.run('operation', () => new Promise(() => {}), 10, { maySubmit: true })
  ).rejects.toMatchObject({
    code: 'PRIVATE_PPV2_TASK_TIMEOUT',
    submissionStatus: 'unknown',
    reconciliationRequired: true,
  });
});

test('a later inflated head cannot enlarge the fixed work grant', async () => {
  let release;
  const pending = budget.run(
    'session-open',
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    300000,
    { allowScanProgress: true }
  );
  const failed = expect(pending).rejects.toMatchObject({ code: 'PRIVATE_PPV2_SCAN_LIMIT' });
  await new Promise((resolve) => setImmediate(resolve));
  budget.beforeScan({ fromBlock: 0n, toBlock: 4999n, floor: 0n, head: 4999n });
  expect(() =>
    budget.beforeScan({ fromBlock: 0n, toBlock: 4999n, floor: 0n, head: 15000n })
  ).toThrow();
  await failed;
  release();
});

test('each task receives a fresh work grant and progress cannot leak its internal range', async () => {
  for (let i = 0; i < 2; i++)
    await budget.run(
      'sdk-operation',
      async () => {
        for (let j = 0; j < 192; j++)
          budget.beforeScan({ fromBlock: 0n, toBlock: 4999n, floor: 0n, head: 4999n });
        budget.progress('history', {
          completedWindows: i + 1,
          scannedBlocks: (i + 1) * 960000,
          floor: 0n,
          head: 4999n,
        });
      },
      300000,
      { allowScanProgress: true }
    );
  expect(scope.signal.aborted).toBe(false);
  expect(events.every((e) => !Object.hasOwn(e, 'head') && !Object.hasOwn(e, 'floor'))).toBe(true);
});

test('a lower subsequent head does not invalidate an earlier scan bound, including before the first window', async () => {
  await budget.run(
    'sdk-operation',
    async () => {
      budget.observeHead(5000n);
      budget.observeHead(4999n);
      budget.beforeScan({ fromBlock: 1n, toBlock: 5000n, floor: 0n, head: 4999n });
      budget.observeHead(4998n);
      budget.beforeScan({ fromBlock: 1n, toBlock: 5000n, floor: 0n, head: 4998n });
    },
    300000,
    { allowScanProgress: true }
  );
  expect(scope.signal.aborted).toBe(false);
});

test('a fresh recovery provider renews long scans after the main provider established a high-water mark', async () => {
  jest.useFakeTimers();
  try {
    const main = budget.createScanReporter();
    await budget.run(
      'session-open',
      async () => {
        for (let i = 1; i <= 100; i++) {
          budget.beforeScan({ fromBlock: 0n, toBlock: 4999n, floor: 0n, head: 500000n });
          main({ completedWindows: i, scannedBlocks: i * 5000 });
        }
      },
      300000,
      { allowScanProgress: true }
    );
    const recovery = budget.createScanReporter();
    let finish;
    const pending = budget.run(
      'sdk-operation',
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      300000,
      { allowScanProgress: true }
    );
    for (let i = 1; i <= 5; i++) {
      await jest.advanceTimersByTimeAsync(240000);
      budget.beforeScan({ fromBlock: 0n, toBlock: 4999n, floor: 0n, head: 500000n });
      recovery({ completedWindows: i, scannedBlocks: i * 5000 });
      expect(scope.signal.aborted).toBe(false);
    }
    finish('recovered');
    await expect(pending).resolves.toBe('recovered');
    expect(events.filter((e) => e.stage === 'history').at(-1)).toMatchObject({
      completedWindows: 105,
      scannedBlocks: 525000,
    });
    const stalled = budget.run('sdk-operation', () => new Promise(() => {}), 300000, {
      allowScanProgress: true,
    });
    const refusal = expect(stalled).rejects.toMatchObject({ code: 'PRIVATE_PPV2_TASK_TIMEOUT' });
    await jest.advanceTimersByTimeAsync(240000);
    recovery({ completedWindows: 5, scannedBlocks: 25000 });
    recovery({ completedWindows: 4, scannedBlocks: 20000 });
    await jest.advanceTimersByTimeAsync(60000);
    await refusal;
  } finally {
    jest.useRealTimers();
  }
});
