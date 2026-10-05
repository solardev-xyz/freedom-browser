/** Orchestration controls only. Native uses genuine owners/receipts, never these mocks. */
const genuine = require('assert/strict');
jest.mock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
const W = '../../src/main/wallet/';
function setup(phase) {
  jest.resetModules();
  const trace = [],
    events = {};
  let sequence = 0;
  const checkpoint = { state: { trees: [] }, hash: 'current' };
  const resources = {};
  const observer = {
    walletCheckpoint: jest.fn(() => ({ sequence, settled: sequence > 0, checkpoint })),
    snapshot: jest.fn(() => structuredClone(resources)),
  };
  const profileFiles = jest.fn(() => ({ vault: 'same', journal: 'same' }));
  let visible = true,
    corrupt = false,
    resolved = false;
  const record = {
    hash: '0x' + '11'.repeat(32),
    nonce: 0,
    attemptedAt: 5,
    state: 'submitted',
    intent: { digest: 'one' },
  };
  const shield = {
    status: 'matched',
    npk: 'npk',
    noteValue: '10',
    position: 7,
    trust: 'unverified-rpc',
  };
  const resolution = { railgun: { outcome: 'matched', shield } };
  const recovery = {
    list: jest.fn(async () => [{ ...record, ...(phase === 'restore' && { resolution }) }]),
    observe: jest.fn(async () => {
      trace.push('observe');
      return {
        record: { ...record, observation: { status: visible ? 'included' : 'pending' } },
        shield: visible ? shield : null,
      };
    }),
    resolve: jest.fn(async (_hash, { review }) => {
      trace.push('resolve');
      if (corrupt) throw Error('cipher');
      await review({ shield });
      resolved = true;
      return { ...record, resolution };
    }),
    close: jest.fn(() => {
      trace.push('recovery.close');
    }),
    closed: Promise.resolve(),
  };
  const account = {
    close: jest.fn(),
    signal: new AbortController().signal,
    generationId: 'genuine-test-generation',
    view: {
      instanceId: async () => 'id',
      balance: async () => [{ amount: 10n, tag: 'unverified' }],
      notes: async () => [],
      status: async () => ({ poi: 'unverified', spendableGranted: false }),
    },
  };
  const current = { read: { received: [] }, ownedPoi: [], trees: [], checkpointHash: 'current' };
  const diagnose = jest.fn(async (value) => {
    const matched =
      value.account === account &&
      value.owners === state.owners &&
      value.checkpoint === checkpoint &&
      value.transaction.from === chain.transaction.from &&
      !value.signal.aborted;
    return Object.freeze({
      status: matched ? 'matched' : 'refused',
      trust: 'supplied-data',
      ownershipAuthenticated: false,
      canonicalityVerified: false,
      spendingEnabled: false,
      poiBypassEnabled: false,
      localJournalAuthenticated: matched,
      localAccountSnapshotSourceAuthenticated: matched,
    });
  });
  jest.doMock(W + 'railgun-shield-origin', () => ({ diagnoseRailgunShieldOrigin: diagnose }));
  jest.doMock(W + 'railgun-wallet-coverage', () => ({ checkpointHash: (c) => c.hash }));
  jest.doMock(W + 'railgun-shield-recovery', () => ({ openRailgunShieldRecovery: () => recovery }));
  jest.doMock('./railgun-public-cold-session', () => ({ preview: () => ({}) }));
  jest.doMock('./railgun-public-cold-data', () => ({
    digest: () => 'credit',
    inventory: () => ({ sqlite: 'same' }),
    assertCredit: jest.fn(),
    wethAmount: () => 10n,
  }));
  jest.doMock('./railgun-public-cold-handoff', () => ({
    recordBinding: (r) => ({ hash: r.hash, nonce: r.nonce }),
    profileFiles,
  }));
  jest.doMock(W + 'railgun-account-public', () => ({
    getRailgunAccountPublicDestination: () => ({}),
  }));
  const wallet = {
    getRailgunAccountWalletPolicy: () => 'policy',
    openRailgunAccountWallet: jest.fn(async (options) => {
      sequence++;
      trace.push('wallet.' + options.mode);
      genuine.equal(resolved, true);
      return account;
    }),
    openRailgunCompletedAccountWallet: jest.fn(async () => {
      sequence++;
      trace.push('completed');
      return account;
    }),
    readRailgunAccountOwnedNotes: () => current,
  };
  jest.doMock(W + 'railgun-account-wallet', () => wallet);
  const state = {
    owner: 'owner',
    signal: new AbortController(),
    owners: {},
    enrollment: {
      catalog: {
        activeFor: (policy) => {
          genuine.equal(policy, 'policy');
          return { directory: 'generation' };
        },
      },
    },
    identity: { descriptor: { instanceId: 'id' } },
    accounts: [],
    publicAccount: {
      advance: jest.fn(async () => {
        trace.push('advance');
        genuine.equal(resolved, true);
        genuine.ok(trace.includes('recovery.close'));
      }),
    },
  };
  const transport = {
    receiptVisibility: (v) => {
      visible = v;
    },
    corruptReceipt: (v) => {
      corrupt = v;
    },
    activeRecoveryGroups: () => 0,
    snapshot: () => JSON.parse(JSON.stringify(events)),
  };
  const previous = {
    owner: 'owner',
    mode: 'acknowledged',
    record: { hash: record.hash, nonce: 0 },
    baseline: { checkpoint: { hash: 'baseline' } },
    creditSha256: 'credit',
  };
  const chain = {
    baselineTo: 3,
    latest: 100,
    headers: Array.from({ length: 101 }, () => ({ hash: 'h' })),
    expected: { npk: 'npk', noteValue: '10', tree: 0, position: 7 },
    transaction: { from: '0x' + '11'.repeat(20) },
    receipt: { status: '0x1' },
  };
  const run = require('./railgun-public-cold-run');
  return {
    run,
    state,
    transport,
    previous,
    chain,
    trace,
    wallet,
    recovery,
    observer,
    checkpoint,
    current,
    diagnose,
    profileFiles,
    resources,
    events,
    account,
    profileDirectory: 'profile',
  };
}
afterEach(() => {
  for (const name of [
    'railgun-shield-recovery',
    'railgun-account-public',
    'railgun-account-wallet',
    'railgun-wallet-coverage',
    'railgun-shield-origin',
  ])
    jest.dontMock(W + name);
  for (const name of ['session', 'data', 'handoff']) jest.dontMock('./railgun-public-cold-' + name);
});
test('resolve performs unavailable/ciphertext controls then healthy resolution before explicit advance', async () => {
  const s = setup('resolve');
  await s.run.resume({ ...s, phase: 'resolve', archive: 'archive' });
  expect(s.trace).toEqual([
    'observe',
    'resolve',
    'observe',
    'resolve',
    'recovery.close',
    'advance',
    'wallet.advance',
  ]);
  expect(s.wallet.openRailgunCompletedAccountWallet).not.toHaveBeenCalled();
});
test('retained phase invokes fixed completed opener without receipt requests or advancement', async () => {
  const s = setup('restore');
  await s.run.resume({ ...s, phase: 'restore', archive: 'archive' });
  expect(s.trace).toEqual(['recovery.close', 'completed']);
  expect(s.recovery.observe).not.toHaveBeenCalled();
  expect(s.recovery.resolve).not.toHaveBeenCalled();
  expect(s.state.publicAccount.advance).not.toHaveBeenCalled();
  expect(s.wallet.openRailgunAccountWallet).not.toHaveBeenCalled();
});
test('independent owner mismatch stops before journal/RPC work', async () => {
  const s = setup('restore');
  s.previous.owner = 'wrong';
  await expect(s.run.resume({ ...s, phase: 'restore', archive: 'archive' })).rejects.toThrow();
  expect(s.recovery.list).not.toHaveBeenCalled();
  expect(s.trace).toEqual([]);
});
test('unrevoked recovery transport cannot be hidden by successful resolution', async () => {
  const s = setup('resolve');
  s.transport.activeRecoveryGroups = () => 1;
  await expect(s.run.resume({ ...s, phase: 'resolve', archive: 'archive' })).rejects.toThrow();
  expect(s.state.publicAccount.advance).not.toHaveBeenCalled();
  expect(s.wallet.openRailgunAccountWallet).not.toHaveBeenCalled();
});
test('wrong durable event coordinate refuses before wallet admission', async () => {
  const s = setup('restore');
  s.chain.expected.position++;
  await expect(s.run.resume({ ...s, phase: 'restore', archive: 'archive' })).rejects.toThrow();
  expect(s.wallet.openRailgunCompletedAccountWallet).not.toHaveBeenCalled();
});
test('setup passes the directly returned opaque public operation, never an invented wrapper', async () => {
  jest.resetModules();
  const activity = { attempted: { transaction: {}, deployment: {} }, sends: 0 };
  const accounts = [];
  let send;
  const state = {
    owners: {
      coordinator: {
        withPublicSnapshot: async (fn) => ({ value: fn({ checkpoint: {} }), evidence: {} }),
        assertSnapshot: () => structuredClone({}),
      },
    },
    identity: { descriptor: { instanceId: 'id' } },
    signal: new AbortController(),
    accounts: [],
    plugins: [],
    owner: 'owner',
    signs: 0,
    addresses: 0,
    publicAccount: { advance: async () => {} },
  };
  const d = {
    receivedDigest: () => 'notes',
    wethAmount: () => 0n,
    digest: () => 'balance',
    acceptSigned: () => {
      chain.transaction = { hash: 'hash' };
    },
  };
  jest.doMock('./railgun-public-cold-data', () => d);
  jest.doMock('./railgun-public-cold-handoff', () => ({ recordBinding: () => ({}) }));
  jest.doMock(W + 'railgun-account-wallet', () => ({
    openRailgunAccountWallet: async () => {
      const a = { signal: { aborted: false } };
      accounts.push(a);
      return a;
    },
    readRailgunAccountOwnedNotes: () => ({}),
  }));
  jest.doMock(W + 'private-submission-journal', () => ({
    getPrivateSubmissionJournal: () => ({ list: async () => [{}] }),
  }));
  jest.doMock('./railgun-public-cold-session', () => ({ preview: () => ({}) }));
  jest.doMock(W + 'railgun-shield-recovery', () => ({
    openRailgunShieldRecovery: () => ({
      list: async () => [{ state: 'submitted' }],
      close() {},
      closed: Promise.resolve(),
    }),
  }));
  const expectedToken = Object.freeze({ __type: 'publicOperation' });
  let redeemed = false;
  jest.doMock(W + 'railgun-kohaku-plugin', () => ({
    createRailgunKohakuPlugin: (options) => ({
      closed: Promise.resolve(),
      close() {},
      async prepareShield() {
        const ok = await options.reviewPreparation(
          {
            purpose: 'railgun-public-shield-preparation',
            operation: 'railgun-native-shield',
            amount: '1000000000000',
            recipient: 'id',
            funding: { address: 'owner' },
            destinations: { protocolRpc: 'url', transactionRpc: 'url' },
            poiQueries: false,
            sourceQueries: false,
            permitsSigning: false,
            permitsSimulation: true,
            exposures: {
              transactionRpc: [
                'public-funding-address',
                'native-amount',
                'relay-adapt-shield-calldata',
                'encrypted-note',
                'eth_estimateGas',
                'eth_call',
              ],
            },
          },
          { signal: { aborted: false } }
        );
        if (!ok) {
          options.account.signal.aborted = true;
          throw Object.assign(Error('denied'), { code: 'RAILGUN_KOHAKU_REFUSED' });
        }
        return expectedToken;
      },
    }),
  }));
  jest.doMock(W + 'railgun-kohaku-public-submitter', () => ({
    createRailgunKohakuPublicSubmitter: () => ({
      async submit(token) {
        if (token !== expectedToken || redeemed) throw Error('copy/replay');
        redeemed = true;
        state.signs++;
        await send({}, {});
        return { hash: 'hash', from: 'owner' };
      },
    }),
  }));
  jest.doMock(W + 'railgun-kohaku-broadcaster', () => ({
    createRailgunKohakuBroadcaster: () => {
      throw Error('wrong mode');
    },
  }));
  const chain = { baselineTo: 1, latest: 3, headers: [{}, {}, {}, { hash: 'anchor' }] };
  const transport = {
    url: 'url',
    snapshot: () => activity,
    onSend: (fn) => {
      send = fn;
    },
  };
  await require('./railgun-public-cold-run').setup({
    state,
    archive: 'archive',
    chain,
    transport,
    observer: { snapshot: () => ({ jobs: {} }) },
    mode: 'acknowledged',
  });
  expect(redeemed).toBe(true);
  expect(accounts.length).toBe(2);
  for (const name of [
    'railgun-kohaku-plugin',
    'railgun-kohaku-public-submitter',
    'railgun-kohaku-broadcaster',
    'private-submission-journal',
  ])
    jest.dontMock(W + name);
});

test.each(['resolve', 'restore'])(
  'origin diagnostic %s joins current checkpoint and exactly exercises healthy/refusal/reuse sequence',
  async (phase) => {
    const s = setup(phase);
    const out = await s.run.resume({ ...s, phase, archive: 'archive' });
    expect(s.diagnose).toHaveBeenCalledTimes(6);
    const calls = s.diagnose.mock.calls.map(([v]) => v);
    expect(calls[0]).toEqual({
      account: s.account,
      owners: s.state.owners,
      noteId: '0:7',
      signal: s.state.signal.signal,
      transaction: s.chain.transaction,
      receipt: s.chain.receipt,
      checkpoint: s.checkpoint,
    });
    expect(calls[0].owners).toBe(s.state.owners);
    expect(calls[1].checkpoint).toBe(s.previous.baseline.checkpoint);
    expect(calls[2].account).not.toBe(s.account);
    expect(Object.isFrozen(calls[2].account)).toBe(true);
    expect(Object.keys(calls[2].account).sort()).toEqual([
      'close',
      'generationId',
      'signal',
      'view',
    ]);
    for (const key of Object.keys(s.account)) expect(calls[2].account[key]).toBe(s.account[key]);
    expect(s.account.close).not.toHaveBeenCalled();
    expect(calls[3].transaction.from).not.toBe(s.chain.transaction.from);
    expect(calls[3].transaction).not.toBe(s.chain.transaction);
    expect(calls[4].signal.aborted).toBe(true);
    expect(calls[5]).toBe(calls[0]);
    expect(s.observer.walletCheckpoint).toHaveBeenCalledTimes(2);
    expect(s.profileFiles).toHaveBeenNthCalledWith(1, 'profile');
    expect(s.profileFiles).toHaveBeenNthCalledWith(2, 'profile');
    expect(out.originDiagnostic).toEqual({
      result: {
        status: 'matched',
        trust: 'supplied-data',
        ownershipAuthenticated: false,
        canonicalityVerified: false,
        spendingEnabled: false,
        poiBypassEnabled: false,
        localJournalAuthenticated: true,
        localAccountSnapshotSourceAuthenticated: true,
      },
      calls: 6,
      matches: 2,
      refusals: 4,
      currentCheckpointCaptured: true,
      staleCheckpointRefused: true,
      copiedAccountRefused: true,
      changedSenderRefused: true,
      preAbortedRefused: true,
      noAddedRpcJobsWorkersOrRailgunKeys: true,
      measuredEncryptedProfileBytesUnchanged: true,
      diagnosticWalletFilesUnchanged: true,
      borrowedOwnersRemainUsable: true,
    });
  }
);
test.each(['missing-call', 'failed-call', 'baseline', 'wrong-current', 'wrong-trees'])(
  'origin measurement rejects %s checkpoint observation before diagnostic work',
  async (mode) => {
    const s = setup('restore');
    if (mode === 'missing-call')
      s.observer.walletCheckpoint.mockReturnValue({
        sequence: 0,
        settled: true,
        checkpoint: s.checkpoint,
      });
    if (mode === 'failed-call')
      s.observer.walletCheckpoint
        .mockImplementationOnce(() => ({ sequence: 0 }))
        .mockImplementationOnce(() => ({ sequence: 1, settled: false, checkpoint: s.checkpoint }));
    if (mode === 'baseline') {
      s.checkpoint.hash = 'baseline';
      s.current.checkpointHash = 'baseline';
    }
    if (mode === 'wrong-current') s.checkpoint.hash = 'foreign';
    if (mode === 'wrong-trees') s.checkpoint.state.trees = [{ length: 1 }];
    await expect(s.run.resume({ ...s, phase: 'restore', archive: 'archive' })).rejects.toThrow();
    expect(s.diagnose).not.toHaveBeenCalled();
  }
);
test.each([
  'rpc',
  'resource',
  'profile',
  'view',
  'sign',
  'address',
  'abort',
  'authority',
  'extra-result-key',
  'refusal-bypassed',
])(
  'origin assertion detects %s drift instead of reporting successful no-work diagnostic',
  async (mode) => {
    const s = setup('restore'),
      original = s.diagnose.getMockImplementation();
    s.diagnose.mockImplementation(async (options) => {
      let result = await original(options);
      if (mode === 'rpc') s.events.extra = 1;
      if (mode === 'resource') s.resources.extra = 1;
      if (mode === 'profile') s.profileFiles.mockReturnValue({ vault: 'changed', journal: 'same' });
      if (mode === 'view') s.account.view = { ...s.account.view };
      if (mode === 'sign') s.state.signs = 1;
      if (mode === 'address') s.state.addresses = 1;
      if (mode === 'abort') s.state.signal.abort();
      if (mode === 'authority') result = Object.freeze({ ...result, spendingEnabled: true });
      if (mode === 'extra-result-key') result = Object.freeze({ ...result, secret: 'not allowed' });
      if (mode === 'refusal-bypassed') result = Object.freeze({ ...result, status: 'matched' });
      return result;
    });
    await expect(s.run.resume({ ...s, phase: 'restore', archive: 'archive' })).rejects.toThrow();
  }
);
