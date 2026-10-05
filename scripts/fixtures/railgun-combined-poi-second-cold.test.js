// Fixed fixture orchestration with modeled production owners. Native campaigns
// must supply real registries/engine; these tests do not issue capabilities.
jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
  assertEmpty: jest.fn(),
}));
jest.mock('./railgun-combined-poi-second-chain', () => ({
  createCold: jest.fn(),
  createColdLost: jest.fn(),
}));
jest.mock('./railgun-combined-poi-second-cold-counts', () => ({
  assertColdHost: jest.fn(),
  jobs: jest.fn(),
}));
jest.mock('./railgun-combined-poi-terminal-ingest', () => ({ runRestart: jest.fn() }));
jest.mock('./railgun-combined-poi-terminal-data', () => ({ beforeSecond: jest.fn() }));
jest.mock('./railgun-combined-poi-second-spend', () => ({ selectChange: jest.fn() }));
jest.mock('../../src/main/wallet/railgun-private-submission', () => ({
  submitRailgunRecoveredPrivateTransaction: jest.fn(),
  submitRailgunPrivateTransaction: jest.fn(() => {
    throw Error('No completion route');
  }),
}));
jest.mock('../../src/main/wallet/railgun-account-wallet', () => ({
  openRailgunCompletedAccountWallet: jest.fn(),
  readRailgunAccountOwnedNotes: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-account-public', () => ({
  getRailgunAccountPublicDestination: jest.fn(),
}));
jest.mock('../../src/main/networks/private-rpc', () => ({
  getPrivateRpcDestinationDetails: jest.fn(),
}));
jest.mock('../../src/main/wallet/privacy-storage', () => ({ getPrivacyStoragePath: jest.fn() }));
jest.mock('../../src/main/wallet/railgun-transact-recovery', () => ({
  openRailgunTransactRecovery: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-own-operation', () => ({
  captureRailgunOwnOperation: jest.fn(),
}));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const api = require('./railgun-combined-poi-second-cold');
const hashes = require('./railgun-combined-poi-second-handoff');
const submit = require('../../src/main/wallet/railgun-private-submission');
const wallet = require('../../src/main/wallet/railgun-account-wallet');
const chainModule = require('./railgun-combined-poi-second-chain');
const terminal = require('./railgun-combined-poi-terminal-ingest');
const { POI_URL } = require('../../src/main/wallet/railgun-public-services');
const copy = (v) => JSON.parse(JSON.stringify(v));
const defer = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let h,
  events,
  pair,
  originals,
  firstRecord,
  secondChain,
  account,
  recovery,
  traffic,
  selected,
  destination,
  capture,
  controller,
  activity;
beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  controller = new AbortController();
  firstRecord = {
    hash: '0xfirst',
    nonce: 0,
    revision: 1,
    intent: { operation: 'partial' },
    resolution: { blockHash: 'anchor' },
    observation: { blockHash: 'anchor', confirmations: 3, observedAt: 1 },
  };
  const entry = (id, n) => ({
    id,
    state: 'signing',
    facts: { tree: 0, position: n, nullifier: 'nullifier' + n, noteHash: 'note' + n },
    signing: { submitter: 'owner' },
  });
  pair = {
    first: {
      entry: entry('a'.repeat(64), 0),
      stored: {
        holdId: 'a'.repeat(64),
        capsule: {
          version: 2,
          preparation: {
            expected: {
              changeCommitment: 'note1',
              nullifier: 'nullifier0',
              merkleRoot: 'first-root',
            },
            changeAmount: '600',
          },
        },
        signature: ['first'],
        provedTransaction: { data: 'first' },
      },
    },
    second: {
      entry: entry('b'.repeat(64), 1),
      stored: {
        holdId: 'b'.repeat(64),
        capsule: {
          version: 1,
          selection: { kind: 'railgun-token-unshield', recipient: 'owner', tree: 0, position: 1 },
          noteHash: 'note1',
          preparation: {
            expected: { amount: '600', nullifier: 'nullifier1', merkleRoot: 'second-root' },
          },
        },
        signature: ['second'],
        provedTransaction: { data: 'second' },
      },
    },
  };
  originals = copy(pair);
  const receipts = { first: {}, second: {} };
  const reservations = {
    withSigningRecovery: jest.fn(async (fn) =>
      fn(
        ['second', 'first'].map((k) => ({ entry: pair[k].entry, receipt: receipts[k] })),
        { assertCurrent() {} }
      )
    ),
  };
  const capsules = {
    readSigned: jest.fn(async (receipt) =>
      receipt === receipts.first ? pair.first.stored : pair.second.stored
    ),
  };
  const enrollment = {
    descriptor: { accountIndex: 0, walletId: 'wallet' },
    directory: '/account',
    getContext: jest.fn(() => ({})),
    openPrivateRecoveryStores: jest.fn(async () => ({ reservations, capsules })),
  };
  const retained = { state: 'attempted', payload: { blindedCommitmentsOut: ['blind'] } },
    inspect = { reservedTransitions: 2 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'second-cold-unit-'));
  const file = path.join(dir, 'encrypted');
  fs.writeFileSync(file, 'cipher');
  require('../../src/main/wallet/privacy-storage').getPrivacyStoragePath.mockReturnValue(file);
  const recordHashes = hashes.pairHashes(pair.first, pair.second, firstRecord);
  traffic = { sends: 0, signatures: 0, firstCanonicalRefreshReads: 0 };
  secondChain = {
    bindProved: jest.fn((v) => {
      expect(v).toEqual(pair.second.stored);
      events.push('bind-proof');
    }),
    report: () => copy(traffic),
    evidence: () => ({
      transaction: { hash: '0xsecond' },
      receipt: { transactionHash: '0xsecond' },
    }),
    close: jest.fn(() => events.push('chain-close')),
    assertFirstRecord: jest.fn(),
  };
  chainModule.createCold.mockReturnValue(secondChain);
  chainModule.createColdLost.mockReturnValue(secondChain);
  account = { close: jest.fn(async () => events.push('account-closed')) };
  wallet.openRailgunCompletedAccountWallet.mockImplementation(async () => {
    events.push('baseline-open');
    return account;
  });
  wallet.readRailgunAccountOwnedNotes.mockReturnValue({ genuineModeledOwned: true });
  selected = {
    type: 'Transact',
    id: '0:1',
    hash: 'note1',
    txid: '0xfirst',
    nullifier: 'nullifier1',
    blindedCommitment: 'blind',
  };
  require('./railgun-combined-poi-second-spend').selectChange.mockReturnValue({
    record: selected,
    note: { amount: 600n },
  });
  require('./railgun-combined-poi-terminal-data').beforeSecond.mockReturnValue({
    unrelated: ['retained'],
    selected: '0:1',
  });
  destination = {};
  require('../../src/main/wallet/railgun-account-public').getRailgunAccountPublicDestination.mockReturnValue(
    destination
  );
  require('../../src/main/networks/private-rpc').getPrivateRpcDestinationDetails.mockReturnValue({
    url: 'https://source.invalid',
  });
  recovery = {
    observe: jest.fn(async () => ({
      transact: { status: 'matched', output: { kind: 'unshield', amount: '600' } },
    })),
    resolve: jest.fn(async (_hash, o) => o.review({ transact: { status: 'matched' } })),
    close: jest.fn(() => events.push('recovery-close')),
  };
  require('../../src/main/wallet/railgun-transact-recovery').openRailgunTransactRecovery.mockReturnValue(
    recovery
  );
  capture = {
    capsule: copy(pair.second.stored.capsule),
    record: { hash: '0xsecond' },
    projection: { railgun: { transact: { output: { kind: 'unshield' } } } },
  };
  require('../../src/main/wallet/railgun-own-operation').captureRailgunOwnOperation.mockResolvedValue(
    { status: 'captured', capture }
  );
  activity = { audit: {}, chain: {}, roleMethods: {}, services: { transportReleases: 0 } };
  h = {
    enrollment,
    identity: {},
    publicAccount: { coordinator: {} },
    archive: '/engine',
    proverArchive: '/prover',
    artifactDirectory: '/artifacts',
    signal: controller.signal,
    continuation: {
      ownEvidence: {
        capsule: pair.first.stored.capsule,
        record: firstRecord,
        receipt: { first: true },
      },
    },
    store: {
      get: jest.fn(async () => copy(retained)),
      inspect: jest.fn(async () => copy(inspect)),
    },
    replay: { assertChange: jest.fn() },
    chain: { report: () => ({ posts: 0 }) },
    pair: copy(pair),
    sealed: { records: recordHashes },
    wire: { retained: { capsuleDigest: 'capsule-digest' } },
    bytecodes: '/code',
    journal: () => ({ list: async () => [copy(firstRecord)] }),
    installTransport: jest.fn(),
    activity: () => copy(activity),
    phase: (n) => events.push(n),
    recordReview: jest.fn(),
    pendingChildren: () => 0,
    unwipedLoans: () => 0,
  };
  terminal.runRestart.mockImplementation(async (value) => {
    events.push('terminal');
    expect(value.second.capture).toBe(capture);
    expect(value.second.terminalBaseline.unrelated).toEqual(['retained']);
    return { selectedChangeUnspentAmount: '0' };
  });
  submit.submitRailgunRecoveredPrivateTransaction.mockImplementation(async (options) => {
    events.push('host');
    if (traffic.sends) {
      activity.services.transportReleases += 2;
      return { status: 'recovery-required', stage: 'prior-attempt' };
    }
    expect(options).toMatchObject({
      identity: h.identity,
      enrollment,
      coordinator: h.publicAccount.coordinator,
      destination,
      holdId: pair.second.entry.id,
      timeoutMs: 600000,
    });
    expect(Object.keys(options).sort()).toEqual(
      [
        'identity',
        'enrollment',
        'coordinator',
        'destination',
        'archive',
        'proverArchive',
        'artifactDirectory',
        'holdId',
        'signal',
        'timeoutMs',
        'gasLimit',
        'maxGasFee',
        'reviewDisclosures',
        'reviewTransaction',
      ].sort()
    );
    await options.reviewDisclosures(
      {
        purpose: 'railgun-recovered-private-submission',
        operation: 'railgun-token-unshield',
        selection: { noteId: '0:1' },
        originalSpendingSignatureReused: true,
        newSpendingSignature: false,
        simulationBeforeTransactionReview: true,
        submitter: 'owner',
        destinations: {
          retainedSource: 'https://source.invalid',
          protocolRpc: 'https://synthetic.invalid/railgun-partial-controller',
          transactionRpc: 'https://synthetic.invalid/railgun-partial-controller',
          poi: POI_URL,
          txid: POI_URL,
        },
        exposures: { transactionRpc: ['eth_call', 'eth_estimateGas'] },
      },
      controller.signal
    );
    await options.reviewTransaction({
      operation: 'railgun-token-unshield',
      transaction: { data: 'second' },
      from: 'owner',
      expiresAt: Date.now() + 10000,
    });
    traffic.sends = 1;
    traffic.signatures = 1;
    traffic.firstCanonicalRefreshReads = 3;
    firstRecord.revision += 3;
    firstRecord.observation.confirmations = 5;
    return { hash: '0xsecond' };
  });
});
test('cold host owns fresh gates; no completion route or second staging; genuine later baseline retained', async () => {
  const result = await api.run(h);
  expect(result.report.secondColdSubmitQualified).toBe(true);
  expect(submit.submitRailgunRecoveredPrivateTransaction).toHaveBeenCalledTimes(3);
  expect(submit.submitRailgunPrivateTransaction).not.toHaveBeenCalled();
  expect(events.indexOf('baseline-open')).toBeGreaterThan(events.indexOf('host'));
  expect(events.indexOf('terminal')).toBeGreaterThan(events.indexOf('account-closed'));
  expect(h.pair).toEqual(originals);
  expect(h.installTransport).toHaveBeenLastCalledWith(undefined);
  expect(terminal.runRestart.mock.calls[0][0].first.ownEvidence.record.revision).toBe(4);
});
test.each(['first', 'second'])(
  'exact %s encrypted record reread refuses before host',
  async (name) => {
    pair[name].stored.signature = ['changed'];
    await expect(api.readPair(h.enrollment, h.sealed.records)).rejects.toThrow();
    expect(submit.submitRailgunRecoveredPrivateTransaction).not.toHaveBeenCalled();
  }
);
test('readPair selects by hash not order; copied state is detached', async () => {
  const v = await api.readPair(h.enrollment, h.sealed.records);
  expect(v).toEqual(originals);
  pair.second.stored.signature.push('mutated');
  expect(v.second.stored.signature).toEqual(['second']);
});
test('duplicate matching hash is refused', async () => {
  const { reservations } = await h.enrollment.openPrivateRecoveryStores();
  reservations.withSigningRecovery.mockImplementation(async (fn) =>
    fn(
      [
        { entry: pair.first.entry, receipt: {} },
        { entry: pair.first.entry, receipt: {} },
      ],
      { assertCurrent() {} }
    )
  );
  await expect(api.readPair(h.enrollment, h.sealed.records)).rejects.toThrow();
});
test('mutated proof after async host return stops before baseline or terminal', async () => {
  const original = submit.submitRailgunRecoveredPrivateTransaction.getMockImplementation();
  submit.submitRailgunRecoveredPrivateTransaction.mockImplementation(async (o) => {
    const result = await original(o);
    pair.second.stored.provedTransaction.data = 'changed';
    return result;
  });
  await expect(api.run(h)).rejects.toThrow();
  expect(wallet.openRailgunCompletedAccountWallet).not.toHaveBeenCalled();
  expect(terminal.runRestart).not.toHaveBeenCalled();
  expect(secondChain.close).toHaveBeenCalled();
});
test('held terminal baseline closure blocks further ownership and terminal work', async () => {
  const gate = defer();
  account.close.mockImplementation(async () => {
    events.push('closing');
    await gate.promise;
    events.push('closed');
  });
  let settled = false;
  const work = api.run(h).finally(() => {
    settled = true;
  });
  for (let i = 0; i < 50 && !events.includes('closing'); i++) await Promise.resolve();
  expect(events).toContain('closing');
  // Let all ready continuations run: removing the await must reach terminal
  // while the original close gate remains held.
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(terminal.runRestart).not.toHaveBeenCalled();
  expect(secondChain.close).not.toHaveBeenCalled();
  gate.resolve();
  await work;
});
test('cancel during held opening adopts then drains late account; no terminal', async () => {
  const gate = defer();
  wallet.openRailgunCompletedAccountWallet.mockImplementation(async () => {
    events.push('opening');
    await gate.promise;
    return account;
  });
  const work = api.run(h);
  const rejection = expect(work).rejects.toThrow();
  for (let i = 0; i < 100 && !events.includes('opening'); i++) await Promise.resolve();
  expect(events).toContain('opening');
  controller.abort();
  gate.resolve();
  await rejection;
  expect(account.close).toHaveBeenCalledTimes(1);
  expect(terminal.runRestart).not.toHaveBeenCalled();
  expect(secondChain.close).toHaveBeenCalled();
});
test('wrong captured capsule cannot feed terminal ingestion', async () => {
  capture.capsule.noteHash = 'wrong';
  await expect(api.run(h)).rejects.toThrow();
  expect(terminal.runRestart).not.toHaveBeenCalled();
});
test('EOA review validates nonrenewing expiry', async () => {
  const original = submit.submitRailgunRecoveredPrivateTransaction.getMockImplementation();
  submit.submitRailgunRecoveredPrivateTransaction.mockImplementation((o) =>
    original({
      ...o,
      reviewTransaction: (request) =>
        o.reviewTransaction({ ...request, expiresAt: Date.now() - 1 }),
    })
  );
  await expect(api.run(h)).rejects.toThrow();
  expect(traffic.sends).toBe(0);
  expect(terminal.runRestart).not.toHaveBeenCalled();
});
test('first immutable drift refuses before any host work', async () => {
  firstRecord.nonce++;
  await expect(api.run(h)).rejects.toThrow();
  expect(submit.submitRailgunRecoveredPrivateTransaction).not.toHaveBeenCalled();
});

test('lost genuine submit result preserved while re-POST/re-sign stays forbidden', async () => {
  const original = submit.submitRailgunRecoveredPrivateTransaction.getMockImplementation();
  submit.submitRailgunRecoveredPrivateTransaction.mockImplementation(async (options) => {
    const value = await original(options);
    if (value.hash) {
      traffic.controlledLostReplies = 1;
      return { submissionStatus: 'unknown', transactionHash: value.hash };
    }
    return value;
  });
  const result = await api.runLost(h);
  expect(result.report.actualSubmitOutcome).toBe('unknown');
  expect(traffic.sends).toBe(1);
  expect(submit.submitRailgunRecoveredPrivateTransaction).toHaveBeenCalledTimes(3);
  expect(submit.submitRailgunPrivateTransaction).not.toHaveBeenCalled();
});

test('early recovered-host refusal records its stage without downstream work', async () => {
  h.recordColdRefusalStage = jest.fn();
  submit.submitRailgunRecoveredPrivateTransaction.mockResolvedValue({
    status: 'recovery-required',
    stage: 'history',
  });
  await expect(api.run(h)).rejects.toThrow();
  expect(h.recordColdRefusalStage).toHaveBeenCalledWith('history');
  expect(h.recordReview).not.toHaveBeenCalled();
  expect(traffic.sends).toBe(0);
  expect(traffic.signatures).toBe(0);
  expect(secondChain.close).toHaveBeenCalled();
});

test('retry counter drift diagnoses a fixed category and still refuses', async () => {
  h.recordColdRetryDifference = jest.fn();
  const original = submit.submitRailgunRecoveredPrivateTransaction.getMockImplementation();
  submit.submitRailgunRecoveredPrivateTransaction.mockImplementation(async (options) => {
    const retry = traffic.sends > 0;
    const result = await original(options);
    if (retry) activity.roleMethods['public-address:transaction-rpc:eth_getBalance'] = 1;
    return result;
  });
  await expect(api.run(h)).rejects.toThrow();
  expect(h.recordColdRetryDifference).toHaveBeenCalledWith('roleMethods');
  expect(h.recordColdRetryDifference).toHaveBeenCalledTimes(1);
  expect(wallet.openRailgunCompletedAccountWallet).not.toHaveBeenCalled();
  expect(secondChain.close).toHaveBeenCalled();
});

test.each([-1, 1])('retry logical releases must have the exact count: delta %s', async (delta) => {
  const original = submit.submitRailgunRecoveredPrivateTransaction.getMockImplementation();
  submit.submitRailgunRecoveredPrivateTransaction.mockImplementation(async (options) => {
    const retry = traffic.sends > 0;
    const result = await original(options);
    if (retry) activity.services.transportReleases += delta;
    return result;
  });
  await expect(api.run(h)).rejects.toThrow();
  expect(wallet.openRailgunCompletedAccountWallet).not.toHaveBeenCalled();
  expect(secondChain.close).toHaveBeenCalled();
});

test.each(['deployment-read', 'transaction-read', 'outer-role-read'])(
  'hidden %s before disclosure refuses before EOA review/send',
  async (fault) => {
    const original = submit.submitRailgunRecoveredPrivateTransaction.getMockImplementation();
    submit.submitRailgunRecoveredPrivateTransaction.mockImplementation(async (options) => {
      const review = options.reviewDisclosures;
      return original({
        ...options,
        reviewDisclosures: (...args) => {
          if (fault === 'outer-role-read')
            activity.roleMethods['public-address:transaction-rpc:eth_getBalance'] = 1;
          else {
            const key =
              fault === 'deployment-read'
                ? 'protocol-rpc:shield-preflight:eth_getCode'
                : 'transaction-rpc:public:eth_getBalance';
            traffic.attempted = { [key]: 1 };
            traffic.validated = { [key]: 1 };
          }
          return review(...args);
        },
      });
    });
    await expect(api.run(h)).rejects.toThrow();
    expect(h.recordReview).not.toHaveBeenCalled();
    expect(traffic.sends).toBe(0);
    expect(traffic.signatures).toBe(0);
    expect(wallet.openRailgunCompletedAccountWallet).not.toHaveBeenCalled();
    expect(secondChain.close).toHaveBeenCalled();
  }
);
