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
test.each(['ok', 'write', 'state', 'unfinished', 'bad-operation'])(
  'operation keeps the read-only receipt contract (%s)',
  async (mode) => {
    const f = setup();
    const module = require('./railgun-private-preparation');
    const preparation = { transactionDigest: 'checked', spendingEnabled: false };
    const prepare = jest
      .spyOn(module, 'normalizeRailgunPrivatePreparation')
      .mockReturnValue(preparation);
    const operation = jest
      .spyOn(module, 'normalizeRailgunPrivateOperation')
      .mockImplementation((v, p) => {
        expect(p).toBe(preparation);
        if (mode === 'bad-operation') throw Error('Invalid final transaction');
        return v;
      });
    try {
      f.result.privatePreparation = { from: 'utility' };
      f.result.privateOperation = { status: 'refused' };
      if (mode === 'write') f.grant.getStatus = () => ({ readOnly: true, writeAttempts: 1 });
      if (mode === 'state')
        f.runJob.mockImplementation(async () => {
          f.mutate();
          return f.result;
        });
      if (mode === 'unfinished') f.result.closed.code = 'RAILGUN_PROCESS_FAILED';
      const running = f.runner.operateReadOnly({
        ...f.args,
        privateIntent: {},
        privateOperation: {},
      });
      if (mode !== 'ok') {
        await expect(running).rejects.toThrow();
        expect(f.store.finishRestore).not.toHaveBeenCalled();
        expect(f.store.close).toHaveBeenCalled();
      } else {
        const completed = await running;
        expect(completed.operation).toEqual({ status: 'refused' });
        expect(completed.preparation).toBe(preparation);
        expect(f.store.finishRestore).toHaveBeenCalledWith(completed.receipt);
        expect(f.runJob.mock.calls[0][0].restore).toBe(true);
      }
      expect(f.store.beginEngine).not.toHaveBeenCalled();
      expect(f.store.finishEngine).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      operation.mockRestore();
    }
  }
);
test('ordinary wallet runs reject an unsolicited operation result', async () => {
  const f = setup();
  f.result.privateOperation = { status: 'proved' };
  await expect(f.runner.run(f.args)).rejects.toThrow();
  expect(f.store.finishEngine).not.toHaveBeenCalled();
});

function recoverySetup(kind = 'railgun-token-unshield', source = 'Shield') {
  const f = setup(),
    fixtures = require('../../../scripts/fixtures/railgun-partial-capsule-data');
  const data =
    kind === 'railgun-partial-unshield'
      ? fixtures.createRailgunPartialCapsuleData()
      : fixtures.createRailgunLegacyCapsuleData(kind);
  const { capsule } = data;
  capsule.walletId = walletId;
  f.args.privateRecovery = {
    capsule,
    signature: { R8: [hash(1), hash(2)], S: hash(3) },
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
  };
  f.args.snapshot = {
    ...f.args.snapshot,
    checkpoint: {
      ...checkpoint,
      state: {
        ...checkpoint.state,
        trees: [{ tree: 0, length: 2, root: hash(999) }],
        commitments: { count: 2, sha256: inventory },
      },
    },
    signal: new AbortController().signal,
  };
  const pins = require('./railgun-shield-pins.json');
  f.result.scannedLeaves = 2;
  f.result.expectedReceived = [{ tree: 0, position: 1 }];
  f.result.received = [
    {
      tree: 0,
      position: 1,
      txid: hash(10),
      hash: capsule.noteHash,
      tokenHash: '0x' + pins.wrappedNative.slice(2).padStart(64, '0'),
      tokenData: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hash(0) },
      value: '1000',
      spentTxid: false,
    },
  ];
  f.result.ownedPoi = [
    {
      id: '0:1',
      hash: capsule.noteHash,
      txid: hash(10),
      npk: hash(8),
      nullifier: capsule.preparation.expected.nullifier,
      blindedCommitment: hash(9),
      type: source,
      blockNumber: 1,
    },
  ];
  data.inner.proof = { a: { x: 1, y: 2 }, b: { x: [3, 4], y: [5, 6] }, c: { x: 7, y: 8 } };
  const transaction = { ...capsule.preparation.transaction, data: data.encode() };
  f.result.privateRecovery = {
    status: 'proved',
    transaction,
    transactionDigest: require('./railgun-private-intent').matchRailgunPrivateProvedTransaction(
      capsule.preparation.transaction,
      transaction,
      capsule.preparation.expected
    ).digest,
    independentlyVerified: false,
  };
  return f;
}
test.each(
  ['railgun-private-transfer', 'railgun-token-unshield', 'railgun-partial-unshield'].flatMap(
    (kind) => ['Shield', 'Transact'].map((source) => [kind, source])
  )
)(
  'fixed %s recovery of %s input yields only genuine restore receipt and unverified local proof',
  async (kind, source) => {
    const f = recoverySetup(kind, source),
      completed = await f.runner.recoverReadOnly(f.args);
    expect(completed.recovery).toEqual(f.result.privateRecovery);
    expect(completed.recovery.independentlyVerified).toBe(false);
    expect(f.runJob.mock.calls[0][0].privateRecovery).toEqual(f.args.privateRecovery);
    expect(f.store.beginEngine).not.toHaveBeenCalled();
    expect(f.store.finishRestore).toHaveBeenCalledWith(completed.receipt);
    expect(() =>
      f.runner.assertScan(completed.receipt, {
        session: f.session,
        walletId,
        policy,
        mode: 'restore',
        checkpoint: f.args.snapshot.checkpoint,
      })
    ).not.toThrow();
  }
);
test.each(['run', 'restoreReadOnly', 'prepareReadOnly', 'operateReadOnly'])(
  '%s cannot select recovery through ordinary options',
  async (method) => {
    const f = recoverySetup();
    const options = { ...f.args, privateIntent: {}, privateOperation: {} };
    await expect(f.runner[method](options)).rejects.toThrow();
    expect(f.runJob).not.toHaveBeenCalled();
    expect(f.session.inspectWalletState).not.toHaveBeenCalled();
  }
);
test.each([
  'state',
  'write',
  'exit',
  'spent',
  'hash',
  'nullifier',
  'amount',
  'root-output',
  'digest',
  'verified',
  'refused',
  'extra-preparation',
  'extra-operation',
])('recovery refuses %s without issuing a receipt', async (mode) => {
  const f = recoverySetup();
  if (mode === 'state')
    f.runJob.mockImplementation(async () => {
      f.mutate();
      return f.result;
    });
  if (mode === 'write') f.grant.getStatus = () => ({ readOnly: true, writeAttempts: 1 });
  if (mode === 'exit') f.result.closed.code = 'RAILGUN_PROCESS_FAILED';
  if (mode === 'spent') f.result.received[0].spentTxid = hash(12);
  if (mode === 'hash') f.result.received[0].hash = hash(12);
  if (mode === 'nullifier') f.result.ownedPoi[0].nullifier = hash(12);
  if (mode === 'amount') f.result.received[0].value = '999';
  if (mode === 'root-output')
    f.result.privateRecovery.transaction.data =
      f.args.privateRecovery.capsule.preparation.transaction.data;
  if (mode === 'digest') f.result.privateRecovery.transactionDigest = '0'.repeat(64);
  if (mode === 'verified') f.result.privateRecovery.independentlyVerified = true;
  if (mode === 'refused') f.result.privateRecovery = { status: 'refused' };
  if (mode === 'extra-preparation') f.result.privatePreparation = {};
  if (mode === 'extra-operation') f.result.privateOperation = {};
  await expect(f.runner.recoverReadOnly(f.args)).rejects.toThrow();
  expect(f.store.finishRestore).not.toHaveBeenCalled();
  expect(f.store.close).toHaveBeenCalled();
});
test('recovery snapshots original data before its first await', async () => {
  const f = recoverySetup();
  let release;
  f.session.inspectWalletState.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            schema: 'wallet-store-v1',
            storeId: '4'.repeat(64),
            count: 0,
            bytes: 0,
            sha256: '5'.repeat(64),
          });
      })
  );
  const signature = structuredClone(f.args.privateRecovery.signature),
    original = f.args.privateRecovery.capsule.preparation.transaction.data;
  const running = f.runner.recoverReadOnly(f.args);
  f.args.privateRecovery.signature.S = hash(99);
  f.args.privateRecovery.capsule.preparation.transaction.data = '0x';
  release();
  await running;
  expect(f.runJob.mock.calls[0][0].privateRecovery.signature).toEqual(signature);
  expect(f.runJob.mock.calls[0][0].privateRecovery.capsule.preparation.transaction.data).toBe(
    original
  );
});
test('ordinary runner rejects unsolicited recovery results', async () => {
  const f = setup();
  f.result.privateRecovery = { status: 'proved' };
  await expect(f.runner.run(f.args)).rejects.toThrow();
  expect(f.store.finishEngine).not.toHaveBeenCalled();
});
