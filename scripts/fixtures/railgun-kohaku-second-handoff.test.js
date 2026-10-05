/** The facade helper is a modeled completed/drained boundary here; no native or
 * authority claim. Distinguishes forbidden host-level staging/proof fallback. */
jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
  assertEmpty: jest.fn(),
}));
jest.mock('./railgun-kohaku-partial-native', () => ({ assertCounts: jest.fn() }));
jest.mock('../../src/main/wallet/railgun-account-wallet', () => ({
  openRailgunAccountWallet: jest.fn(),
  readRailgunAccountOwnedNotes: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-private-capsule', () => ({
  digestRailgunPrivateCapsule: () => 'first',
}));
jest.mock('../../src/main/wallet/railgun-transact-staging', () => ({
  stageRailgunTransactInput: jest.fn(() => {
    throw Error('direct staging');
  }),
}));
jest.mock('../../src/main/wallet/railgun-private-operation', () => ({
  proveRailgunAccountPrivateOperation: jest.fn(() => {
    throw Error('direct proof');
  }),
}));
jest.mock('../../src/main/wallet/railgun-private-submission', () => ({
  submitRailgunPrivateTransaction: jest.fn(() => {
    throw Error('direct submit');
  }),
}));
jest.mock('../../src/main/wallet/privacy-storage', () => ({ getPrivacyStoragePath: jest.fn() }));
jest.mock('./railgun-combined-poi-second-chain', () => ({ create: jest.fn() }));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { runFacade } = require('./railgun-combined-poi-second-spend');
const { samplePartial } = require('./railgun-partial-own-txid-data');
const wallet = require('../../src/main/wallet/railgun-account-wallet');
const staging = require('../../src/main/wallet/railgun-transact-staging');
const operation = require('../../src/main/wallet/railgun-private-operation');
const submit = require('../../src/main/wallet/railgun-private-submission');
const defer = () => {
  let resolve;
  return { promise: new Promise((r) => (resolve = r)), resolve: () => resolve() };
};
let h, account, chain, records, gate, seen, original, stored;
beforeEach(() => {
  jest.clearAllMocks();
  const sample = samplePartial();
  seen = [];
  gate = defer();
  const note = {
    id: '1:123',
    tree: 1,
    position: 123,
    hash: sample.capsule.preparation.expected.changeCommitment,
    txid: '0x' + sample.row.txid,
    amount: 600n,
    spentTxid: false,
  };
  const record = {
    ...note,
    type: 'Transact',
    nullifier: 'new-nullifier',
    blindedCommitment: 'blind',
  };
  account = { close: jest.fn(async () => seen.push('account-close')) };
  wallet.openRailgunAccountWallet.mockResolvedValue(account);
  wallet.readRailgunAccountOwnedNotes.mockReturnValue({
    read: { received: [note] },
    ownedPoi: [record],
    trees: [{ tree: 1, length: 124, root: 'new-root' }],
  });
  const entry = {
    id: 'first',
    state: 'signing',
    signing: { submitter: sample.capsule.selection.recipient },
  };
  original = {
    entry,
    stored: {
      capsule: sample.capsule,
      signature: { first: true },
      provedTransaction: { data: 'first' },
    },
  };
  records = jest.fn(async (use) => {
    if (records.mock.calls.length === 1)
      return use([{ entry, receipt: {} }], { assertCurrent() {} });
    seen.push('recovery-after-facade');
    throw Error('boundary after drained facade');
  });
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'facade-handoff-')), 'cipher');
  fs.writeFileSync(filename, 'original');
  require('../../src/main/wallet/privacy-storage').getPrivacyStoragePath.mockReturnValue(filename);
  chain = { bindProved: jest.fn(), close: jest.fn(() => seen.push('chain-close')) };
  require('./railgun-combined-poi-second-chain').create.mockReturnValue(chain);
  stored = { holdId: 'second', signature: { second: true }, provedTransaction: { data: 'second' } };
  h = {
    identity: {},
    enrollment: {
      descriptor: { walletId: 'wallet', accountIndex: 0 },
      directory: '/account',
      getContext: () => ({}),
      openPrivateRecoveryStores: async () => ({
        reservations: { withSigningRecovery: records },
        capsules: { readSigned: async () => original.stored },
      }),
    },
    coordinator: {},
    archive: '/engine',
    proverArchive: '/prover',
    artifactDirectory: '/artifacts',
    continuation: { ownEvidence: sample },
    acceptance: { report: () => ({ accepted: true, verifierExits: 1, bindingExits: 1 }) },
    signal: new AbortController().signal,
    store: {
      get: async () => ({ state: 'attempted', payload: { blindedCommitmentsOut: ['blind'] } }),
      inspect: async () => ({ reservedTransitions: 2 }),
    },
    journal: () => ({ list: async () => [sample.record] }),
    phase: (n) => seen.push(n),
    activity: () => ({}),
    facadeMeasure: () => ({}),
    adoptStores: jest.fn(),
    installTransport: jest.fn(),
    recordReview: jest.fn(),
    bytecodes: '/bytecodes',
    facade: {
      second: jest.fn(async (options) => {
        seen.push('facade-enter');
        expect(options.account).toBe(account);
        expect(options.record.id).toBe(note.id);
        expect(options.amount).toBe(note.amount);
        await gate.promise;
        options.onStored(stored);
        seen.push('facade-drained');
        return { stored, report: { transactionReviews: 1 }, submitted: { hash: 'second' } };
      }),
    },
  };
});
test('no phase/store reacquisition before second facade drains; no duplicate external staging/proving/submission', async () => {
  const work = runFacade(h);
  const rejection = expect(work).rejects.toThrow('boundary after drained facade');
  for (let i = 0; i < 30 && !seen.includes('facade-enter'); i++) await Promise.resolve();
  expect(seen).toContain('facade-enter');
  await new Promise((r) => setImmediate(r));
  expect(records).toHaveBeenCalledTimes(1);
  expect(staging.stageRailgunTransactInput).not.toHaveBeenCalled();
  expect(operation.proveRailgunAccountPrivateOperation).not.toHaveBeenCalled();
  expect(submit.submitRailgunPrivateTransaction).not.toHaveBeenCalled();
  gate.resolve();
  await rejection;
  expect(seen.indexOf('recovery-after-facade')).toBeGreaterThan(seen.indexOf('facade-drained'));
  expect(chain.bindProved).toHaveBeenCalledWith(stored);
  expect(account.close).not.toHaveBeenCalled();
  expect(chain.close).toHaveBeenCalled();
});
test('facade failure never reacquires recovery or falls back to direct controller', async () => {
  h.facade.second.mockRejectedValue(Error('facade refused'));
  await expect(runFacade(h)).rejects.toThrow('facade refused');
  expect(records).toHaveBeenCalledTimes(1);
  expect(submit.submitRailgunPrivateTransaction).not.toHaveBeenCalled();
  expect(chain.close).toHaveBeenCalled();
});
