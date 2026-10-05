jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
  assertEmpty: jest.fn(),
}));
jest.mock('./railgun-combined-poi-list-replay', () => ({ assertProvider: jest.fn() }));
jest.mock('./railgun-combined-poi-second-chain', () => ({ create: jest.fn() }));
jest.mock('./railgun-combined-poi-second-cold-counts', () => ({
  assertProveStop: jest.fn(() => ({ checked: true })),
}));
jest.mock('../../src/main/wallet/railgun-private-capsule', () => ({
  digestRailgunPrivateCapsule: () => 'first-digest',
}));
jest.mock('../../src/main/wallet/privacy-storage', () => ({ getPrivacyStoragePath: jest.fn() }));
jest.mock('../../src/main/wallet/railgun-account-wallet', () => ({
  openRailgunAccountWallet: jest.fn(),
  readRailgunAccountOwnedNotes: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-transact-staging', () => ({
  stageRailgunTransactInput: jest.fn(),
  assertRailgunTransactStaging: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-private-operation', () => ({
  proveRailgunAccountPrivateOperation: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-private-submission', () => ({
  submitRailgunPrivateTransaction: jest.fn(() => {
    throw Error('Must not submit');
  }),
}));
jest.mock('../../src/main/networks/privacy-context', () => ({
  getPrivacyContext: jest.fn(),
  createPrivacyScope: jest.fn(),
}));
jest.mock('../../src/main/networks/private-rpc', () => ({
  createPrivateRpc: jest.fn(),
  getPrivateRpcDestination: jest.fn(),
  getPrivateRpcDestinationDetails: () => ({
    url: 'https://synthetic.invalid/railgun-partial-controller',
  }),
  createPrivateRpcDestinationConstraint: jest.fn(),
}));
const fs = require('fs'),
  path = require('path'),
  os = require('os');
const { proveAndStopRestart } = require('./railgun-combined-poi-second-spend');
const wallet = require('../../src/main/wallet/railgun-account-wallet');
const operation = require('../../src/main/wallet/railgun-private-operation');
const staging = require('../../src/main/wallet/railgun-transact-staging');
const submit = require('../../src/main/wallet/railgun-private-submission');
const defer = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const copy = (v) => JSON.parse(JSON.stringify(v));
let h, events, first, second, firstRecord, account, staged, completion, chain, controller, proved;
beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  controller = new AbortController();
  proved = false;
  first = {
    entry: {
      id: 'a'.repeat(64),
      state: 'signing',
      facts: { nullifier: 'first-null' },
      signing: { submitter: 'owner' },
    },
    stored: {
      holdId: 'a'.repeat(64),
      capsule: {
        version: 2,
        selection: { recipient: 'owner' },
        preparation: {
          inputAmount: '1000',
          unshieldAmount: '400',
          changeAmount: '600',
          expected: {
            changeCommitment: 'change',
            unshieldCommitment: 'unshield',
            nullifier: 'first-null',
            merkleRoot: 'first-root',
          },
        },
      },
      signature: ['first'],
      provedTransaction: { data: 'first' },
    },
  };
  second = {
    entry: {
      id: 'b'.repeat(64),
      state: 'signing',
      facts: { nullifier: 'second-null' },
      signing: { submitter: 'owner' },
    },
    stored: {
      holdId: 'b'.repeat(64),
      capsule: {
        version: 1,
        selection: { kind: 'railgun-token-unshield', recipient: 'owner' },
        noteHash: 'change',
        preparation: { expected: { amount: '600' } },
      },
      signature: ['second'],
      provedTransaction: { data: 'second' },
    },
  };
  firstRecord = {
    hash: '0xfirst',
    resolution: { railgun: {} },
    revision: 1,
    observation: { observedAt: 1, confirmations: 3, blockHash: 'anchor' },
  };
  const row = { txid: 'first', commitments: ['change', 'unshield'] },
    state = { root: 'root' };
  const note = {
    id: '0:2',
    tree: 0,
    position: 2,
    hash: 'change',
    txid: '0xfirst',
    spentTxid: false,
    amount: 600n,
  };
  const record = {
    ...note,
    type: 'Transact',
    nullifier: 'second-null',
    blindedCommitment: 'blind',
  };
  delete record.amount;
  wallet.readRailgunAccountOwnedNotes.mockReturnValue({
    read: { received: [note] },
    ownedPoi: [record],
    trees: [{ tree: 0, length: 3, root: 'second-root' }],
  });
  account = { close: jest.fn(async () => events.push('account-close')) };
  wallet.openRailgunAccountWallet.mockResolvedValue(account);
  staged = {
    status: 'staged',
    account,
    receipt: {},
    close: jest.fn(() => events.push('staging-close')),
  };
  staging.stageRailgunTransactInput.mockResolvedValue(staged);
  staging.assertRailgunTransactStaging.mockReturnValue({
    state,
    noteWitness: { witness: { row }, outputIndex: 0 },
    baseline: { owned: record, received: note },
  });
  completion = { receipt: {}, close: jest.fn(() => events.push('completion-close')) };
  operation.proveRailgunAccountPrivateOperation.mockImplementation(async () => {
    events.push('prove');
    proved = true;
    firstRecord.revision++;
    return { status: 'proved', holdId: second.entry.id, completion };
  });
  const r1 = {},
    r2 = {};
  const reservations = {
    withSigningRecovery: jest.fn(async (run) => {
      const records = [
        { entry: first.entry, receipt: r1 },
        ...(proved ? [{ entry: second.entry, receipt: r2 }] : []),
      ];
      return run(records, { assertCurrent() {} });
    }),
  };
  const capsules = {
    get: jest.fn(async () => copy(second.stored)),
    readSigned: jest.fn(async (r) => copy(r === r1 ? first.stored : second.stored)),
  };
  const enrollment = {
    descriptor: { walletId: 'wallet', accountIndex: 0 },
    directory: '/account',
    getContext: () => ({}),
    openPrivateRecoveryStores: async () => ({ reservations, capsules }),
  };
  const context = require('../../src/main/networks/privacy-context');
  context.getPrivacyContext.mockReturnValue({
    profileId: 'profile',
    subject: { kind: 'private-account', operation: 'engine' },
  });
  context.createPrivacyScope.mockReturnValue({
    getContext: (v) => v,
    close: jest.fn(() => events.push('scope-close')),
  });
  require('../../src/main/networks/private-rpc').createPrivateRpcDestinationConstraint.mockImplementation(
    () => ({ constraint: {}, close: jest.fn() })
  );
  chain = {
    bindProved: jest.fn(),
    assertFirstRecord: jest.fn(),
    report: () => ({ firstCanonicalRefreshReads: 1, sends: 0, signatures: 0 }),
    close: jest.fn(() => events.push('chain-close')),
  };
  require('./railgun-combined-poi-second-chain').create.mockReturnValue(chain);
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prove-stop-')), 'encrypted');
  fs.writeFileSync(filename, 'cipher');
  require('../../src/main/wallet/privacy-storage').getPrivacyStoragePath.mockReturnValue(filename);
  h = {
    identity: {},
    enrollment,
    coordinator: {},
    archive: '/engine',
    proverArchive: '/prover',
    artifactDirectory: '/artifacts',
    continuation: {
      ownEvidence: { capsule: first.stored.capsule, record: firstRecord, row, receipt: {} },
      state,
    },
    store: {
      get: async () => ({ state: 'attempted', payload: { blindedCommitmentsOut: ['blind'] } }),
      inspect: async () => ({ reservedTransitions: 2 }),
    },
    replay: { assertChange: jest.fn() },
    signal: controller.signal,
    adoptStores: jest.fn(),
    journal: () => ({ list: async () => [copy(firstRecord)] }),
    activity: () => ({ phase: 'observed' }),
    phase: (n) => events.push(n),
    bytecodes: '/code',
    installTransport: jest.fn(),
    pendingChildren: () => 0,
    unwipedLoans: () => 0,
  };
});
test('stop persists real modeled proof but discards completion and never calls warm submit', async () => {
  const result = await proveAndStopRestart(h);
  expect(result.report.completionDiscarded).toBe(true);
  expect(result.report.secondColdSubmitQualified).toBe(false);
  expect(submit.submitRailgunPrivateTransaction).not.toHaveBeenCalled();
  expect(completion.close).toHaveBeenCalledTimes(1);
  expect(events.indexOf('account-close')).toBeLessThan(events.indexOf('completion-close'));
  expect(events.indexOf('staging-close')).toBeLessThan(events.indexOf('completion-close'));
  expect(result.sealed.records.second.signature).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(result)).not.toContain('"signature":["second"]');
  expect(h.installTransport).toHaveBeenLastCalledWith(undefined);
});
test('stop does not settle or close completion ahead of original account drain', async () => {
  const gate = defer();
  account.close.mockImplementation(async () => {
    events.push('closing');
    await gate.promise;
    events.push('closed');
  });
  let done = false;
  const work = proveAndStopRestart(h).finally(() => {
    done = true;
  });
  for (let i = 0; i < 60 && !events.includes('closing'); i++) await Promise.resolve();
  expect(events).toContain('closing');
  expect(done).toBe(false);
  expect(completion.close).not.toHaveBeenCalled();
  gate.resolve();
  await work;
  expect(completion.close).toHaveBeenCalledTimes(1);
});
test('throwing completion close prevents successful stop and still closes chain', async () => {
  completion.close.mockImplementation(() => {
    throw Error('cleanup refused');
  });
  await expect(proveAndStopRestart(h)).rejects.toThrow();
  expect(chain.close).toHaveBeenCalled();
  expect(submit.submitRailgunPrivateTransaction).not.toHaveBeenCalled();
});
test('second proof missing cannot be sealed, and original signature remains retained', async () => {
  second.stored.provedTransaction = null;
  await expect(proveAndStopRestart(h)).rejects.toThrow();
  expect(first.stored.signature).toEqual(['first']);
  expect(submit.submitRailgunPrivateTransaction).not.toHaveBeenCalled();
});
test('one first canonical refresh required at stop, not four from former warm whole run', async () => {
  chain.report = () => ({ firstCanonicalRefreshReads: 4, sends: 0, signatures: 0 });
  await expect(proveAndStopRestart(h)).rejects.toThrow();
});

test('cancelled held account drain retains proof but cannot publish a proved handoff', async () => {
  const gate = defer();
  account.close.mockImplementation(async () => {
    events.push('closing');
    await gate.promise;
  });
  const work = proveAndStopRestart(h);
  const refusal = expect(work).rejects.toThrow();
  for (let i = 0; i < 60 && !events.includes('closing'); i++) await Promise.resolve();
  expect(events).toContain('closing');
  controller.abort();
  gate.resolve();
  await refusal;
  expect(second.stored.signature).toEqual(['second']);
  expect(second.stored.provedTransaction).not.toBeNull();
  expect(submit.submitRailgunPrivateTransaction).not.toHaveBeenCalled();
});
