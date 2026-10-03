const { createRailgunWalletRunner } = require('./railgun-wallet-runner');
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const inventory = '1'.repeat(64),
  policy = '2'.repeat(64),
  walletId = '3'.repeat(64);
const checkpoint = {
  from: 0,
  previousHash: hash(0),
  to: { number: 10, hash: hash(10) },
  anchor: { number: 100, hash: hash(100) },
  logs: { count: 0, sha256: inventory },
  source: {
    level: 'unverified-rpc',
    providersSha256: inventory,
    ledgerId: inventory,
    ledgerSha256: inventory,
  },
  state: {
    schema: 'public-records-v1',
    storeId: inventory,
    trees: [],
    commitments: { count: 0, sha256: inventory },
    nullifiers: { count: 0, sha256: inventory },
    unshields: { count: 0, sha256: inventory },
  },
};
function setup() {
  const controller = new AbortController();
  let state = {
    schema: 'wallet-store-v1',
    storeId: '4'.repeat(64),
    count: 0,
    bytes: 0,
    sha256: '5'.repeat(64),
  };
  const session = {
    signal: controller.signal,
    inspectWalletState: jest.fn(async () => ({ ...state })),
    assertFresh: jest.fn(),
  };
  const result = {
    closed: { code: 'RAILGUN_PROCESS_CLOSED' },
    inventory,
    spendableGranted: false,
    poiCalls: 0,
    guards: { attempts: 0, hooks: ['a'], canaries: 1 },
    instanceId: '0zk1' + 'q'.repeat(123),
    received: [],
    ownedPoi: [],
    sent: [],
    scannedLeaves: 0,
    expectedReceived: [],
    expectedSent: [],
    quarantine: [],
    unrecoverableSent: [],
  };
  const grant = { getStatus: () => ({ readOnly: true, writeAttempts: 0 }) };
  const store = {
    session,
    beginEngine: jest.fn(() => grant),
    beginRestore: jest.fn(() => grant),
    finishEngine: jest.fn(),
    finishRestore: jest.fn(),
    close: jest.fn(),
  };
  const runJob = jest.fn(async () => result),
    runner = createRailgunWalletRunner({ runJob, inventory, policy });
  const args = {
    snapshot: { checkpoint },
    walletSession: session,
    coverageStore: store,
    walletId,
    restore: false,
  };
  return {
    runner,
    args,
    runJob,
    result,
    store,
    session,
    controller,
    grant,
    mutate: () => {
      state.sha256 = '6'.repeat(64);
    },
  };
}
test('only completed jobs issue session-, wallet-, policy- and checkpoint-bound opaque receipts', async () => {
  const f = setup(),
    completed = await f.runner.run(f.args);
  expect(f.runJob.mock.calls[0][0].walletGrant).toBe(f.grant);
  expect(f.store.finishEngine).toHaveBeenCalledWith(completed.receipt);
  const expected = { session: f.session, walletId, policy, checkpoint, mode: 'scan' };
  expect(() => f.runner.assertScan(completed.receipt, expected)).not.toThrow();
  for (const change of [
    { session: {} },
    { walletId: '9'.repeat(64) },
    { policy: '9'.repeat(64) },
    { mode: 'restore' },
    { summary: {} },
  ])
    expect(() => f.runner.assertScan(completed.receipt, { ...expected, ...change })).toThrow();
  expect(() => f.runner.assertScan({}, expected)).toThrow();
  f.controller.abort();
  expect(() => f.runner.assertScan(completed.receipt, expected)).toThrow();
});
test.each(['exit', 'inventory', 'egress', 'canary', 'poi', 'spendable', 'coverage', 'exception'])(
  'refuses %s and closes the derived session without a receipt',
  async (mode) => {
    const f = setup();
    if (mode === 'exit') f.result.closed.code = 'RAILGUN_PROCESS_EXITED';
    if (mode === 'inventory') f.result.inventory = '9'.repeat(64);
    if (mode === 'egress') f.result.guards.attempts = 1;
    if (mode === 'canary') f.result.guards.canaries = 0;
    if (mode === 'poi') f.result.poiCalls = 1;
    if (mode === 'spendable') f.result.spendableGranted = true;
    if (mode === 'coverage') f.result.scannedLeaves = 1;
    if (mode === 'exception') f.runJob.mockRejectedValue(Error('interrupted'));
    await expect(f.runner.run(f.args)).rejects.toThrow();
    expect(f.store.finishEngine).not.toHaveBeenCalled();
    expect(f.store.close).toHaveBeenCalledTimes(1);
  }
);
test('restore must preserve exact whole-store digest and binds it for later journal checks', async () => {
  const f = setup();
  f.args.restore = true;
  f.runJob.mockImplementation(async () => {
    f.mutate();
    return f.result;
  });
  await expect(f.runner.run(f.args)).rejects.toThrow();
  const good = setup();
  good.args.restore = true;
  const { receipt } = await good.runner.run(good.args);
  good.mutate();
  expect(() =>
    good.runner.assertScan(receipt, {
      session: good.session,
      walletId,
      policy,
      mode: 'restore',
      state: { sha256: '6'.repeat(64) },
    })
  ).toThrow();
});

test('read-only restoration forces restore mode and uses only its matching grant lifecycle', async () => {
  const f = setup();
  f.args.snapshot.signal = new AbortController().signal;
  const { receipt } = await f.runner.restoreReadOnly(f.args);
  expect(f.store.beginRestore).toHaveBeenCalledWith(f.args.snapshot.signal);
  expect(f.store.beginEngine).not.toHaveBeenCalled();
  expect(f.runJob.mock.calls[0][0].restore).toBe(true);
  expect(f.runJob.mock.calls[0][0].walletGrant).toBe(f.grant);
  expect(f.store.finishRestore).toHaveBeenCalledWith(receipt);
  expect(f.store.finishEngine).not.toHaveBeenCalled();
  expect(() =>
    f.runner.assertScan(receipt, { session: f.session, walletId, policy, mode: 'restore' })
  ).not.toThrow();
});
test('read-only restoration refuses state mutation or an incomplete job', async () => {
  for (const mutation of [true, false]) {
    const f = setup();
    if (mutation)
      f.runJob.mockImplementation(async () => {
        f.mutate();
        return f.result;
      });
    else f.result.closed.code = 'RAILGUN_PROCESS_FAILED';
    await expect(f.runner.restoreReadOnly(f.args)).rejects.toThrow();
    expect(f.store.close).toHaveBeenCalledTimes(1);
    expect(f.store.finishRestore).not.toHaveBeenCalled();
  }
});
