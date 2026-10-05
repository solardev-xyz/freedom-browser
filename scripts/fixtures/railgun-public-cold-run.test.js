/** Orchestration controls only. Native uses genuine owners/receipts, never these mocks. */
const genuine = require('assert/strict');
jest.mock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
const W = '../../src/main/wallet/';
function setup(phase) {
  jest.resetModules();
  const trace = [],
    events = {};
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
    view: {
      instanceId: async () => 'id',
      balance: async () => [{ amount: 10n, tag: 'unverified' }],
      notes: async () => [],
      status: async () => ({ poi: 'unverified', spendableGranted: false }),
    },
  };
  const current = { read: { received: [] }, ownedPoi: [], trees: [] };
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
  }));
  jest.doMock(W + 'railgun-account-public', () => ({
    getRailgunAccountPublicDestination: () => ({}),
  }));
  const wallet = {
    getRailgunAccountWalletPolicy: () => 'policy',
    openRailgunAccountWallet: jest.fn(async (options) => {
      trace.push('wallet.' + options.mode);
      genuine.equal(resolved, true);
      return account;
    }),
    openRailgunCompletedAccountWallet: jest.fn(async () => {
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
    snapshot: () => events,
  };
  const previous = {
    owner: 'owner',
    mode: 'acknowledged',
    record: { hash: record.hash, nonce: 0 },
    baseline: {},
    creditSha256: 'credit',
  };
  const chain = {
    baselineTo: 3,
    latest: 100,
    headers: Array.from({ length: 101 }, () => ({ hash: 'h' })),
    expected: { npk: 'npk', noteValue: '10', position: 7 },
  };
  const run = require('./railgun-public-cold-run');
  return { run, state, transport, previous, chain, trace, wallet, recovery };
}
afterEach(() => {
  for (const name of [
    'railgun-shield-recovery',
    'railgun-account-public',
    'railgun-account-wallet',
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
