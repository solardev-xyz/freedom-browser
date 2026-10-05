// Orchestration-only mocks: actual ABI/scan joins and engine guards are exercised
// independently. These handles cannot authenticate notes or authorize a spend.
jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
  assertEmpty: jest.fn(),
}));
jest.mock('./railgun-combined-poi-terminal-data', () => ({
  rowFromSecond: jest.fn(),
  assertScanned: jest.fn(),
}));
jest.mock('./railgun-combined-poi-change-inventory', () => ({ observeWalletInventory: jest.fn() }));
jest.mock('../../src/main/networks/privacy-context', () => ({
  getPrivacyContext: jest.fn(),
  createPrivacyScope: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-process', () => ({ startRailgunProcess: jest.fn() }));
jest.mock('../../src/main/wallet/railgun-own-txid', () => ({ matchRailgunOwnTxid: jest.fn() }));
jest.mock('../../src/main/wallet/railgun-account-txid', () => ({
  openRailgunAccountTxid: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-account-wallet', () => ({
  openRailgunAccountWallet: jest.fn(),
  readRailgunAccountOwnedNotes: jest.fn(),
}));
jest.mock('../../src/main/wallet/privacy-storage', () => ({
  getPrivacyStoragePath: () => '/mock-intent',
}));
jest.mock('../../src/main/wallet/railgun-private-capsule', () => ({
  digestRailgunPrivateCapsule: () => 'capsule',
}));
const fs = require('fs');
const { run } = require('./railgun-combined-poi-terminal-ingest');
const data = require('./railgun-combined-poi-terminal-data');
const inventory = require('./railgun-combined-poi-change-inventory');
const context = require('../../src/main/networks/privacy-context');
const runtime = require('../../src/main/wallet/railgun-process');
const txid = require('../../src/main/wallet/railgun-account-txid');
const wallet = require('../../src/main/wallet/railgun-account-wallet');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const copy = (v) => JSON.parse(JSON.stringify(v));
let h,
  abort,
  mirror,
  account,
  initialHistory,
  projected,
  row,
  phase,
  readSpy,
  stored,
  privateEntries,
  eoa,
  checkFiles;
const jobs = {
  'railgun-combined-poi-row-job.js': 1,
  'railgun-public-job.js': 2,
  'railgun-txid-job.js': 6,
  'railgun-wallet-job.js': 1,
};
const methods = {
  'private-account:protocol-rpc:eth_getBlockByNumber': 25,
  'private-account:protocol-rpc:eth_getLogs': 1,
  'service:poi:ppoi_validated_txid': 4,
  'service:poi:ppoi_validate_txid_merkleroot': 3,
  'service:indexer:page': 1,
};
const activity = (done) => ({
  eoa: { sends: 2, signatures: 2 },
  methods: {},
  audit: {
    ...Object.fromEntries(
      ['starts', 'exits', 'attemptedResults', 'admittedResults', 'guards'].map((k) => [
        k,
        done ? jobs : {},
      ])
    ),
    keyRequests: done ? { 'railgun-wallet-job.js': 1 } : {},
    keyReplies: done ? { 'railgun-wallet-job.js': 1 } : {},
    modes: done ? { inspect: 2, project: 2, apply: 2 } : {},
  },
  roleMethods: done ? methods : {},
  chain: { attempted: done ? methods : {}, validated: done ? methods : {}, posts: 1 },
  services: { poiMethods: {}, signatureChecks: 1 },
  storageWorkers: { starts: done ? 2 : 0, exits: done ? 2 : 0, pending: 0 },
});
beforeEach(() => {
  jest.clearAllMocks();
  abort = new AbortController();
  phase = '';
  initialHistory = {
    rows: [{ commitments: [hex(1)] }],
    state: { count: 1 },
    checkpoints: [{ count: 1 }],
    finalized: 10,
  };
  row = { commitments: [hex(2)] };
  projected = {
    rows: [...initialHistory.rows, { ...row, verificationHash: hex(8) }],
    state: { count: 2 },
    checkpoints: [...initialHistory.checkpoints, { count: 2 }],
    guards: { attempts: 0, canaries: 1, hooks: ['mock'] },
  };
  data.rowFromSecond.mockReturnValue({ row, finalized: 30 });
  require('../../src/main/wallet/railgun-own-txid').matchRailgunOwnTxid.mockReturnValue({
    output: { kind: 'unshield', amount: '600' },
  });
  let to = 10;
  h = {
    identity: {},
    acceptance: { report: () => ({ accepted: true, postCalls: 1 }) },
    enrollment: { descriptor: { walletId: 'test' }, directory: '/mock', getContext: () => ({}) },
    publicAccount: {
      generationId: 'same',
      coordinator: { inspect: () => ({ to: { number: to, hash: hex(to) } }) },
    },
    archive: '/mock',
    first: {
      ownEvidence: { record: { hash: hex(1) }, capsule: { preparation: { changeAmount: '600' } } },
      rows: initialHistory.rows,
      state: initialHistory.state,
    },
    second: {
      capture: { record: { hash: hex(2) }, capsule: {} },
      receipt: {},
      transaction: {},
      terminalBaseline: {},
    },
    chain: { inspectHistory: () => copy(initialHistory), appendFinalizedUnshield: jest.fn() },
    signal: abort.signal,
    header: (n) => ({ hash: hex(n) }),
    phase: (s) => {
      phase = s;
    },
    adoptStores: jest.fn(),
    pendingChildren: () => 0,
    unwipedLoans: () => 0,
  };
  h.publicAccount.advance = jest.fn(async () => {
    to = 30;
  });
  stored = { state: 'attempted' };
  h.store = { get: async () => copy(stored), inspect: async () => ({ reservedTransitions: 2 }) };
  privateEntries = [
    { entry: { id: 1 }, receipt: {} },
    { entry: { id: 2 }, receipt: {} },
  ];
  h.enrollment.openPrivateRecoveryStores = async () => ({
    reservations: {
      withSigningRecovery: async (use) => use(privateEntries, { assertCurrent: () => {} }),
    },
    capsules: {
      readSigned: async () => ({ signature: 'retained', provedTransaction: 'retained' }),
    },
  });
  eoa = [
    { hash: hex(1), resolution: {} },
    { hash: hex(2), resolution: {} },
  ];
  h.journal = () => ({ list: async () => copy(eoa) });
  let activityCalls = 0;
  h.activity = () => activity(activityCalls++ > 0);
  const realRead = fs.readFileSync;
  readSpy = jest
    .spyOn(fs, 'readFileSync')
    .mockImplementation((name, ...args) =>
      name === '/mock-intent' ? Buffer.from('retained') : realRead(name, ...args)
    );
  context.getPrivacyContext.mockReturnValue({ profileId: 'p', subject: {}, signal: abort.signal });
  context.createPrivacyScope.mockImplementation(() => {
    const a = new AbortController();
    return { signal: a.signal, getContext: () => ({}), close: () => a.abort() };
  });
  runtime.startRailgunProcess.mockImplementation((options) => ({
    ready: Promise.resolve().then(() =>
      options.broker.dispatch(JSON.stringify({ id: 1, method: 'result', value: projected }))
    ),
    close: jest.fn(),
    closed: Promise.resolve({
      code: 'RAILGUN_PROCESS_CLOSED',
      exitCode: 15,
      escalated: false,
      peerDisconnected: false,
    }),
  }));
  let advanced = false;
  mirror = {
    inspect: async () => ({
      pending: null,
      checkpoint: { state: advanced ? projected.state : initialHistory.state },
    }),
    advance: jest.fn(async () => {
      advanced = true;
    }),
    close: jest.fn(async () => {}),
  };
  txid.openRailgunAccountTxid.mockResolvedValue(mirror);
  account = { close: jest.fn(async () => {}) };
  wallet.openRailgunAccountWallet.mockResolvedValue(account);
  wallet.readRailgunAccountOwnedNotes.mockReturnValue({ fresh: true });
  checkFiles = jest.fn(() => ['walletAndCoverage', 'walletJournal']);
  inventory.observeWalletInventory.mockReturnValue({ assertAfter: checkFiles });
});
afterEach(() => readSpy.mockRestore());
test('sequential real API calls use existing mirror then fresh registry scan, report remains bounded', async () => {
  const result = await run(h);
  expect(txid.openRailgunAccountTxid).toHaveBeenCalledWith(
    expect.objectContaining({ create: false, signal: abort.signal })
  );
  expect(wallet.openRailgunAccountWallet).toHaveBeenCalledWith({
    identity: h.identity,
    enrollment: h.enrollment,
    coordinator: h.publicAccount.coordinator,
    archive: h.archive,
    mode: 'advance',
  });
  expect(wallet.readRailgunAccountOwnedNotes).toHaveBeenCalledTimes(1);
  expect(data.assertScanned).toHaveBeenCalledWith(
    h.second.terminalBaseline,
    { fresh: true },
    h.first,
    h.second
  );
  expect(mirror.close).toHaveBeenCalledTimes(1);
  expect(account.close).toHaveBeenCalledTimes(1);
  expect(checkFiles).toHaveBeenCalledTimes(1);
  expect(result.secondColdSubmitQualified).toBe(false);
  expect(result.secondSpendIngestedIntoWallet).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/nullifier|signature|commitment|receipt/);
});
test('late mirror open after caller abort is closed/drained before refusal and no wallet is opened', async () => {
  const opening = deferred(),
    closing = deferred();
  txid.openRailgunAccountTxid.mockReturnValue(opening.promise);
  mirror.close.mockReturnValue(closing.promise);
  let settled = false;
  const work = run(h).finally(() => {
    settled = true;
  });
  const refused = expect(work).rejects.toThrow();
  while (!txid.openRailgunAccountTxid.mock.calls.length) await Promise.resolve();
  abort.abort();
  opening.resolve(mirror);
  await Promise.resolve();
  await Promise.resolve();
  expect(mirror.close).toHaveBeenCalled();
  expect(settled).toBe(false);
  expect(wallet.openRailgunAccountWallet).not.toHaveBeenCalled();
  closing.resolve();
  await refused;
});
test('late wallet after abort is never read and held close delays refusal', async () => {
  const opening = deferred(),
    closing = deferred();
  wallet.openRailgunAccountWallet.mockReturnValue(opening.promise);
  account.close.mockReturnValue(closing.promise);
  let settled = false;
  const work = run(h).finally(() => {
    settled = true;
  });
  const refused = expect(work).rejects.toThrow();
  while (!wallet.openRailgunAccountWallet.mock.calls.length) await Promise.resolve();
  abort.abort();
  opening.resolve(account);
  await Promise.resolve();
  await Promise.resolve();
  expect(wallet.readRailgunAccountOwnedNotes).not.toHaveBeenCalled();
  expect(settled).toBe(false);
  expect(account.close).toHaveBeenCalled();
  closing.resolve();
  await refused;
});
test('failed mirror checkpoint cannot proceed to wallet scan', async () => {
  mirror.inspect = async () => ({ pending: null, checkpoint: { state: { count: 0 } } });
  await expect(run(h)).rejects.toThrow();
  expect(mirror.close).toHaveBeenCalled();
  expect(wallet.openRailgunAccountWallet).not.toHaveBeenCalled();
});
test('scan mismatch still awaits account close and does not produce a success', async () => {
  const gate = deferred();
  account.close.mockReturnValue(gate.promise);
  data.assertScanned.mockImplementation(() => {
    throw Error('wrong spent flag');
  });
  let settled = false;
  const work = run(h).finally(() => {
    settled = true;
  });
  const refused = expect(work).rejects.toThrow('wrong spent flag');
  while (!account.close.mock.calls.length) await Promise.resolve();
  expect(settled).toBe(false);
  gate.resolve();
  await refused;
});
test('failed actual wallet drain cannot report spent', async () => {
  account.close.mockRejectedValue(Error('exit unavailable'));
  await expect(run(h)).rejects.toThrow('exit unavailable');
  expect(checkFiles).not.toHaveBeenCalled();
});
test.each(['private entry', 'EOA record', 'intent state', 'extra query'])(
  'terminal %s drift refuses',
  async (name) => {
    account.close.mockImplementation(async () => {
      if (name === 'private entry') privateEntries[0].entry.id = 3;
      if (name === 'EOA record') eoa[0].revision = 8;
      if (name === 'intent state') stored.state = 'changed';
      if (name === 'extra query') {
        const next = activity(true);
        next.roleMethods = { ...next.roleMethods, 'private-account:poi:ppoi_pois_per_list': 1 };
        h.activity = () => next;
      }
    });
    await expect(run(h)).rejects.toThrow();
    expect(phase).toBe('terminal-wallet-advance');
  }
);
