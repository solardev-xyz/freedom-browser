// Orchestration mocks only; production registries/engine run in offline native.
jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
}));
jest.mock('./railgun-combined-poi-list-replay', () => ({
  create: jest.fn(),
  snapshot: jest.fn(),
}));
jest.mock('./railgun-combined-poi-chain', () => ({ createReplay: jest.fn() }));
jest.mock('./railgun-combined-poi-second-spend', () => ({
  runRestart: jest.fn(),
  proveAndStopRestart: jest.fn(),
}));
jest.mock('./railgun-combined-poi-terminal-ingest', () => ({
  runRestart: jest.fn(),
  projectRetainedPartial: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-account-public', () => ({
  getRailgunAccountPublicDestination: jest.fn(),
  getRailgunAccountPublicIdentity: jest.fn(),
  assertRailgunAccountPublicDestination: jest.fn(),
  assertRailgunAccountPublic: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-public-policy', () => ({
  getRailgunPublicPolicy: () => 'registered-policy',
}));
jest.mock('../../src/main/wallet/railgun-private-capsule', () => ({
  digestRailgunPrivateCapsule: () => 'a'.repeat(64),
}));
jest.mock('../../src/main/wallet/railgun-poi-submit-data', () => ({
  prepareRailgunPoiSubmission: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-own-operation', () => ({
  captureRailgunOwnOperation: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-own-txid', () => ({
  matchRailgunOwnTxid: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-account-txid', () => ({
  openRailgunAccountTxid: jest.fn(),
}));
const { proveStop, coldSubmit, coldSubmitLost, hashes } = require('./railgun-combined-poi-restart');
jest.mock('./railgun-combined-poi-second-cold', () => ({
  readPair: jest.fn(),
  run: jest.fn(),
  runLost: jest.fn(),
}));
const cold = require('./railgun-combined-poi-second-cold');
const { digest, sha } = require('./railgun-combined-poi-restart-data');
const list = require('./railgun-combined-poi-list-replay');
const chainModule = require('./railgun-combined-poi-chain');
const terminal = require('./railgun-combined-poi-terminal-ingest');
const second = require('./railgun-combined-poi-second-spend');
const pub = require('../../src/main/wallet/railgun-account-public');
const submission = require('../../src/main/wallet/railgun-poi-submit-data');
const own = require('../../src/main/wallet/railgun-own-operation');
const ownTxid = require('../../src/main/wallet/railgun-own-txid');
const txid = require('../../src/main/wallet/railgun-account-txid');
const defer = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
let h,
  abort,
  store,
  mirror,
  replay,
  chain,
  privateState,
  record,
  capture,
  checkpoint,
  inspect,
  events;
beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  abort = new AbortController();
  const row = { txid: 'first', verificationHash: '0x' + 'b'.repeat(64) },
    state = { root: 'root', count: 1 };
  privateState = {
    entry: {
      state: 'signing',
      facts: { tree: 0, position: 2, nullifier: 'nullifier', noteHash: 'hash' },
    },
    stored: {
      capsule: { version: 2 },
      signature: ['signature'],
      provedTransaction: { data: 'actual-calldata' },
    },
  };
  record = { hash: '0xfirst', resolution: { matched: true } };
  const payload = {
    txidMerkleroot: 'root',
    txidMerklerootIndex: 0,
    railgunTxidIfHasUnshield: '0x' + 'c'.repeat(64),
  };
  const retained = {
    state: 'attempted',
    payload,
    attempt: { submission: { requestId: 1 } },
  };
  inspect = { reservedTransitions: 2 };
  store = {
    get: jest.fn(async () => retained),
    inspect: jest.fn(async () => inspect),
    close: jest.fn(() => events.push('store-close')),
    closed: Promise.resolve(),
  };
  const context = { assertCurrent: jest.fn() };
  const enrollment = {
    signal: abort.signal,
    descriptor: { accountIndex: 0 },
    openPrivateRecoveryStores: jest.fn(async () => ({
      reservations: {
        withSigningRecovery: async (run) =>
          run([{ entry: privateState.entry, receipt: {} }], context),
      },
      capsules: { readSigned: async () => privateState.stored },
    })),
    openPoiIntents: jest.fn(async () => store),
  };
  checkpoint = { to: { number: 100, hash: 'anchor' } };
  const coordinator = {
    withCompletedPublicSnapshot: jest.fn(async (_o, run) => {
      await run();
      return { evidence: {} };
    }),
    assertSnapshot: jest.fn(() => checkpoint),
  };
  capture = {
    capsuleDigest: 'a'.repeat(64),
    capsule: privateState.stored.capsule,
    record,
    provedTransaction: privateState.stored.provedTransaction,
    submitter: 'owner',
  };
  mirror = {
    inspect: jest.fn(async () => ({ pending: null, checkpoint: { state } })),
    witness: jest.fn(async (txid) => {
      expect(txid).toBe('c'.repeat(64));
      expect(txid).not.toBe(row.txid);
      return { witness: { row } };
    }),
    close: jest.fn(async () => events.push('mirror-close')),
  };
  replay = { close: jest.fn(() => events.push('replay-close')) };
  chain = {
    bindProof: jest.fn(),
    report: () => ({ posts: 0 }),
    continuation: { logs: ['real-logs'] },
  };
  pub.getRailgunAccountPublicDestination.mockReturnValue({});
  pub.getRailgunAccountPublicIdentity.mockImplementation((value, owner) => {
    expect(value).toBe(coordinator);
    expect(owner).toBe(enrollment);
    return { generation: 'original' };
  });
  pub.assertRailgunAccountPublic.mockReturnValue('registered-policy');
  submission.prepareRailgunPoiSubmission.mockReturnValue({
    body: 'actual-body',
  });
  list.create.mockReturnValue(replay);
  chainModule.createReplay.mockReturnValue(chain);
  own.captureRailgunOwnOperation.mockResolvedValue({
    status: 'captured',
    capture,
  });
  ownTxid.matchRailgunOwnTxid.mockReturnValue({
    output: { kind: 'partial-unshield' },
  });
  txid.openRailgunAccountTxid.mockResolvedValue(mirror);
  terminal.projectRetainedPartial.mockResolvedValue({
    rows: [row],
    state,
    checkpoints: [state],
  });
  second.runRestart.mockImplementation(async () => {
    events.push('second');
    return { report: { fresh: true }, continuation: { second: true } };
  });
  terminal.runRestart.mockResolvedValue({
    selectedChangeUnspentAmount: '0',
    unrelatedNotesAndBalancesPreserved: true,
  });
  h = {
    identity: {},
    enrollment,
    publicAccount: { coordinator },
    archive: '/engine',
    signal: abort.signal,
    wire: {
      privateHashes: hashes(privateState, record),
      transaction: { hash: '0xfirst', from: 'owner', input: 'actual-calldata' },
      receipt: {},
      retained: {
        capsuleDigest: 'a'.repeat(64),
        entrySha256: digest(retained),
        inspect,
      },
      acceptedBodySha256: sha('actual-body'),
      history: { rows: [row], state, checkpoints: [state] },
      checkpoint,
      publicIdentity: { generation: 'original' },
      list: {},
    },
    journal: () => ({ list: async () => [record] }),
    phase: jest.fn(),
    installChain: jest.fn(),
    assertBootstrapDrained: jest.fn(),
    beforeSecond: jest.fn(),
  };
});

test('fixed prove stop routes only to prefix after authentic A joins/mirror close', async () => {
  second.proveAndStopRestart.mockImplementation(async () => {
    expect(mirror.close).toHaveBeenCalledTimes(1);
    return { report: { completionDiscarded: true }, sealed: { hashesOnly: true } };
  });
  const value = await proveStop(h);
  expect(value.sealed).toEqual({ hashesOnly: true });
  expect(second.runRestart).not.toHaveBeenCalled();
  expect(terminal.runRestart).not.toHaveBeenCalled();
  expect(store.close).toHaveBeenCalled();
});
function coldInput() {
  record.observation = { blockHash: 'anchor', confirmations: 3, observedAt: 1 };
  record.revision = 2;
  h.sealed = {
    records: {
      record: digest(record),
      immutableRecord: require('./railgun-combined-poi-second-handoff').firstImmutable(record),
    },
    retained: { entrySha256: h.wire.retained.entrySha256, inspectSha256: digest(inspect) },
  };
  h.adoptStores = jest.fn();
  cold.readPair.mockResolvedValue({ first: privateState, second: { genuineModeledStored: true } });
  cold.run.mockResolvedValue({ report: { secondColdSubmitQualified: true } });
  cold.runLost.mockResolvedValue({ report: { actualSubmitOutcome: 'unknown' } });
}
test.each([false, true])(
  'fixed cold route lost=%s has no preliminary source/mirror/warm operation',
  async (lost) => {
    coldInput();
    const result = await (lost ? coldSubmitLost : coldSubmit)(h);
    expect(lost ? cold.runLost : cold.run).toHaveBeenCalledWith(
      expect.objectContaining({
        pair: expect.objectContaining({ first: privateState }),
        store,
        replay,
        chain,
      })
    );
    expect(result.chain).toBe(chain);
    expect(h.publicAccount.coordinator.withCompletedPublicSnapshot).not.toHaveBeenCalled();
    expect(terminal.projectRetainedPartial).not.toHaveBeenCalled();
    expect(txid.openRailgunAccountTxid).not.toHaveBeenCalled();
    expect(own.captureRailgunOwnOperation).not.toHaveBeenCalled();
    expect(second.runRestart).not.toHaveBeenCalled();
    expect(second.proveAndStopRestart).not.toHaveBeenCalled();
    expect(h.beforeSecond).toHaveBeenCalledTimes(1);
  }
);
test('cold public generation mismatch refuses before host, not repaired', async () => {
  coldInput();
  h.wire.publicIdentity = { generation: 'wrong' };
  await expect(coldSubmit(h)).rejects.toThrow();
  expect(cold.run).not.toHaveBeenCalled();
  expect(h.publicAccount.coordinator.withCompletedPublicSnapshot).not.toHaveBeenCalled();
});
test('cold body hash cannot launder changed retained payload into host', async () => {
  coldInput();
  submission.prepareRailgunPoiSubmission.mockReturnValue({ body: 'wrong' });
  await expect(coldSubmit(h)).rejects.toThrow();
  expect(cold.run).not.toHaveBeenCalled();
});
test('cold host failure holds original store drain before replay closes', async () => {
  coldInput();
  const gate = defer();
  store.closed = gate.promise;
  cold.run.mockRejectedValue(Error('host refused'));
  let settled = false;
  const work = coldSubmit(h).finally(() => {
    settled = true;
  });
  const refusal = expect(work).rejects.toThrow();
  for (let i = 0; i < 60 && !store.close.mock.calls.length; i++) await Promise.resolve();
  expect(store.close).toHaveBeenCalled();
  expect(settled).toBe(false);
  expect(replay.close).not.toHaveBeenCalled();
  gate.resolve();
  await refusal;
  expect(replay.close).toHaveBeenCalled();
});
