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
const { resume, hashes, snapshotSetup } = require('./railgun-combined-poi-restart');
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
test('cold rereads -> completed checkpoint -> independent projection -> real capture/mirror -> fresh second + terminal', async () => {
  const result = await resume(h);
  expect(h.enrollment.openPoiIntents).toHaveBeenCalledWith({
    existingOnly: true,
  });
  expect(txid.openRailgunAccountTxid).toHaveBeenCalledWith(
    expect.objectContaining({
      create: false,
      checkpointOnly: true,
      signal: abort.signal,
    })
  );
  expect(second.runRestart).toHaveBeenCalledWith(
    expect.objectContaining({
      replay,
      store,
      terminalMode: true,
      continuation: expect.objectContaining({
        ownEvidence: expect.objectContaining({
          capsule: privateState.stored.capsule,
          record,
        }),
        witness: { row: h.wire.history.rows[0] },
      }),
    })
  );
  expect(second.runRestart.mock.calls[0][0].acceptance).toBeUndefined();
  expect(terminal.runRestart).toHaveBeenCalledWith(
    expect.objectContaining({
      first: second.runRestart.mock.calls[0][0].continuation,
      second: { second: true },
      replay,
    })
  );
  expect(result.report.secondColdSubmitQualified).toBe(false);
  expect(result.report.secondSignedUnfinishedRecoveryQualified).toBe(false);
  expect(result.report.terminalIngest.unrelatedNotesAndBalancesPreserved).toBe(true);
  expect(mirror.close).toHaveBeenCalledTimes(1);
  expect(events.indexOf('mirror-close')).toBeGreaterThanOrEqual(0);
  expect(events.indexOf('mirror-close')).toBeLessThan(events.indexOf('second'));
  expect(store.close).toHaveBeenCalledTimes(1);
  expect(replay.close).toHaveBeenCalledTimes(1);
});
test.each(['entry', 'stored', 'capsule', 'signature', 'provedTransaction', 'record'])(
  'original %s hash mismatch refuses before replay or utility',
  async (key) => {
    h.wire.privateHashes[key] = 'changed';
    await expect(resume(h)).rejects.toThrow();
    expect(list.create).not.toHaveBeenCalled();
    expect(terminal.projectRetainedPartial).not.toHaveBeenCalled();
    expect(second.runRestart).not.toHaveBeenCalled();
  }
);
test.each([
  'body',
  'retained',
  'state',
  'checkpoint',
  'publicIdentity',
  'capture',
  'creator',
  'pending',
])('mismatched %s cannot reach second spend', async (which) => {
  if (which === 'body')
    submission.prepareRailgunPoiSubmission.mockReturnValue({
      body: 'different',
    });
  if (which === 'retained') h.wire.retained.entrySha256 = 'different';
  if (which === 'state')
    terminal.projectRetainedPartial.mockResolvedValue({
      ...(await terminal.projectRetainedPartial()),
      state: { root: 'different' },
    });
  if (which === 'checkpoint') h.wire.checkpoint = { to: { number: 101 } };
  if (which === 'publicIdentity') h.wire.publicIdentity = { generation: 'different' };
  if (which === 'capture')
    own.captureRailgunOwnOperation.mockResolvedValue({
      status: 'captured',
      capture: { ...capture, provedTransaction: { data: 'different' } },
    });
  if (which === 'creator')
    ownTxid.matchRailgunOwnTxid.mockReturnValue({
      output: { kind: 'unshield' },
    });
  if (which === 'pending')
    mirror.inspect.mockResolvedValue({
      pending: {},
      checkpoint: { state: h.wire.history.state },
    });
  await expect(resume(h)).rejects.toThrow();
  expect(second.runRestart).not.toHaveBeenCalled();
  expect(terminal.runRestart).not.toHaveBeenCalled();
});
test('late mirror opening after cancellation is closed and drained before returning', async () => {
  const open = defer(),
    closed = defer();
  txid.openRailgunAccountTxid.mockReturnValue(open.promise);
  mirror.close.mockImplementation(() => closed.promise);
  let settled = false;
  const work = resume(h).finally(() => {
    settled = true;
  });
  const caught = work.catch(() => {});
  for (let i = 0; i < 30 && !txid.openRailgunAccountTxid.mock.calls.length; i++)
    await Promise.resolve();
  expect(txid.openRailgunAccountTxid).toHaveBeenCalled();
  abort.abort();
  open.resolve(mirror);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(mirror.close).toHaveBeenCalled();
  expect(settled).toBe(false);
  expect(second.runRestart).not.toHaveBeenCalled();
  closed.resolve();
  await caught;
  expect(settled).toBe(true);
  expect(replay.close).toHaveBeenCalled();
});
test('held store drain retains replay through second failure', async () => {
  const closed = defer();
  store.closed = closed.promise;
  second.runRestart.mockRejectedValue(new Error('controller refused'));
  let settled = false;
  const work = resume(h).finally(() => {
    settled = true;
  });
  const caught = work.catch(() => {});
  for (let i = 0; i < 60 && !store.close.mock.calls.length; i++) await Promise.resolve();
  expect(store.close).toHaveBeenCalled();
  expect(settled).toBe(false);
  expect(replay.close).not.toHaveBeenCalled();
  expect(terminal.runRestart).not.toHaveBeenCalled();
  closed.resolve();
  await caught;
  expect(replay.close).toHaveBeenCalled();
});
test('failed independent projection never opens mirror or fresh controller', async () => {
  terminal.projectRetainedPartial.mockRejectedValue(new Error('bad path'));
  await expect(resume(h)).rejects.toThrow();
  expect(txid.openRailgunAccountTxid).not.toHaveBeenCalled();
  expect(second.runRestart).not.toHaveBeenCalled();
  expect(store.close).toHaveBeenCalled();
});

test('setup exports the actual accepted body hash, never its body or the private continuation', async () => {
  const data = require('./railgun-combined-poi-restart-data');
  const checked = jest.spyOn(data, 'checkWire').mockImplementation((value) => value);
  list.snapshot.mockReturnValue({ publicKeySpki: 'public-only' });
  try {
    const value = await snapshotSetup({
      ...h,
      inputCreator: 'Shield',
      store,
      signature: {},
      acceptance: {},
      chain: {
        exportAcceptedBody: () => 'actual-body',
        inspectHistory: () => h.wire.history,
      },
      continuation: {
        ownEvidence: {
          record,
          capsule: privateState.stored.capsule,
          transaction: h.wire.transaction,
          receipt: {},
        },
      },
    });
    expect(value.acceptedBodySha256).toBe(sha('actual-body'));
    expect(value).not.toHaveProperty('acceptedBody');
    expect(value.privateHashes).toEqual(h.wire.privateHashes);
    expect(value.publicIdentity).toEqual(h.wire.publicIdentity);
    for (const key of ['capsule', 'stored', 'signature', 'continuation', 'acceptance'])
      expect(Object.hasOwn(value, key)).toBe(false);
    expect(h.publicAccount.coordinator.withCompletedPublicSnapshot).toHaveBeenCalled();
    expect(list.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: store.get.mock.results[0].value
          ? (await store.get.mock.results[0].value).payload
          : null,
      })
    );
  } finally {
    checked.mockRestore();
  }
});

test('throwing store close cannot skip its drain or expose a successful restart', async () => {
  const closed = defer();
  store.closed = closed.promise;
  store.close.mockImplementation(() => {
    throw Error('close failed');
  });
  let settled = false;
  const work = resume(h).finally(() => {
    settled = true;
  });
  const caught = work.catch((error) => error);
  for (let i = 0; i < 70 && !store.close.mock.calls.length; i++) await Promise.resolve();
  expect(store.close).toHaveBeenCalled();
  expect(settled).toBe(false);
  expect(replay.close).not.toHaveBeenCalled();
  closed.resolve();
  expect((await caught).message).toBe('close failed');
  expect(replay.close).toHaveBeenCalled();
});
