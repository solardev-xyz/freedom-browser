jest.mock('./railgun-combined-poi-second-recovery-data', () => ({
  readUnfinishedPair: jest.fn(),
}));
jest.mock('./railgun-combined-poi-second-recovery', () => ({ run: jest.fn() }));
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
const { recoverStop, hashes } = require('./railgun-combined-poi-restart');
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

function coldInput() {
  record.observation = { blockHash: 'anchor', confirmations: 3, observedAt: 1 };
  record.revision = 2;
  h.sealed = {
    records: {
      record: digest(record),
      immutableRecord: require('./railgun-combined-poi-second-handoff').firstImmutable(record),
    },
    retained: {
      entrySha256: h.wire.retained.entrySha256,
      inspectSha256: digest(inspect),
    },
  };
  h.adoptStores = jest.fn();
  cold.readPair.mockResolvedValue({
    first: privateState,
    second: { genuineModeledStored: true },
  });
  cold.run.mockResolvedValue({ report: { secondColdSubmitQualified: true } });
  cold.runLost.mockResolvedValue({
    report: { actualSubmitOutcome: 'unknown' },
  });
}

test('fixed C recovery route reads genuine unfinished slot and goes directly to host without receipt/source/TXID bootstrap', async () => {
  coldInput();
  const source = require('./railgun-combined-poi-second-recovery-data');
  source.readUnfinishedPair.mockResolvedValue({
    first: privateState,
    second: { unfinished: true },
  });
  const recovery = require('./railgun-combined-poi-second-recovery');
  recovery.run.mockResolvedValue({
    report: { originalSecondSignatureReused: true },
  });
  const result = await recoverStop(h);
  expect(result.report.originalSecondSignatureReused).toBe(true);
  expect(source.readUnfinishedPair).toHaveBeenCalledWith(h.enrollment, h.sealed.records);
  expect(cold.readPair).not.toHaveBeenCalled();
  expect(cold.run).not.toHaveBeenCalled();
  expect(h.publicAccount.coordinator.withCompletedPublicSnapshot).not.toHaveBeenCalled();
  expect(terminal.projectRetainedPartial).not.toHaveBeenCalled();
  expect(txid.openRailgunAccountTxid).not.toHaveBeenCalled();
  expect(own.captureRailgunOwnOperation).not.toHaveBeenCalled();
  expect(second.runRestart).not.toHaveBeenCalled();
});
test('failed recovery awaits store closure before releasing signature replay', async () => {
  coldInput();
  require('./railgun-combined-poi-second-recovery-data').readUnfinishedPair.mockResolvedValue({
    first: privateState,
    second: { unfinished: true },
  });
  require('./railgun-combined-poi-second-recovery').run.mockRejectedValue(Error('refused'));
  const gate = defer();
  store.closed = gate.promise;
  let done = false;
  const work = recoverStop(h).finally(() => {
    done = true;
  });
  const rejected = expect(work).rejects.toThrow();
  for (let i = 0; i < 60 && !store.close.mock.calls.length; i++) await Promise.resolve();
  expect(store.close).toHaveBeenCalled();
  expect(done).toBe(false);
  expect(replay.close).not.toHaveBeenCalled();
  gate.resolve();
  await rejected;
  expect(replay.close).toHaveBeenCalled();
});
