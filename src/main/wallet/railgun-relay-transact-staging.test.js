let mockSnapshot, mockLogs, mockWindowData, mockWindowToken, mockFenced;
const mockVerify = jest.fn(),
  mockQuarantine = jest.fn();
jest.mock('./railgun-note-provenance', () => ({
  verifyRailgunNoteProvenance: (...args) => mockVerify(...args),
}));
jest.mock('./railgun-account-enrollment', () => ({
  assertRailgunFencedAccountEnrollment: (e) => {
    if (!mockFenced || e !== mockEnrollment) throw Error('fence');
  },
}));
let mockIdentity, mockEnrollment, mockCoordinator, mockOld, mockNew, mockOwned, mockFresh;
let mockWalletPolicy, mockTxidPolicy, mockPublicPolicy, mockPublicIdentity, mockTxid, mockHandoff;
const mockOpenWallet = jest.fn(),
  mockOpenTxid = jest.fn(),
  mockRead = jest.fn(),
  mockWindow = jest.fn();
jest.mock('./railgun-identity', () => ({
  quarantineRailgunIdentityCredentials: (...args) => mockQuarantine(...args),
  assertRailgunIdentity: (identity) => {
    if (identity !== mockIdentity) throw Error('identity');
    return mockIdentity.descriptor;
  },
}));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-public-policy', () => ({ getRailgunPublicPolicy: () => mockPublicPolicy }));
jest.mock('./railgun-txid-policy', () => ({ getRailgunTxidPolicy: () => mockTxidPolicy }));
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: (c, e) => {
    if (c !== mockCoordinator || e !== mockEnrollment) throw Error('owners');
    return mockPublicIdentity;
  },
}));
jest.mock('./railgun-account-wallet', () => ({
  openRailgunAccountWallet: (...args) => mockOpenWallet(...args),
  getRailgunAccountWalletPolicy: () => mockWalletPolicy,
  readRailgunAccountOwnedNotes: (...args) => mockRead(...args),
  reserveRailgunAccountWalletHandoff: (account, owners) => {
    if (
      account !== mockOld ||
      owners.identity !== mockIdentity ||
      owners.enrollment !== mockEnrollment ||
      owners.coordinator !== mockCoordinator
    )
      throw Error('owners');
    return mockHandoff;
  },
  assertRailgunAccountRelayWindow: (...args) => mockWindow(...args),
}));
jest.mock('./railgun-account-txid', () => ({
  openRailgunAccountTxid: (...args) => mockOpenTxid(...args),
}));
const { createHash } = require('crypto');
const { Interface } = require('ethers');
const abi = new Interface(require('./railgun-transact-receipt').PRIVATE_EVENTS);
const { checkpointHash } = require('./railgun-wallet-coverage');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunTxidProjection } = require('./railgun-txid-projection');
const { findRailgunNoteTxidWitness } = require('./railgun-txid-note-witness');
const {
  stageRailgunRelayTransactInput,
  assertRailgunRelayTransactStaging,
  claimRailgunRelayTransactStaging,
  assertRailgunRelayTransactStagingAvailable,
} = require('./railgun-relay-transact-staging');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
const hash = (s) => '0' + createHash('sha256').update(s).digest('hex').slice(1);
const pair = (a, b) => hash(a + b),
  zeros = [hash('zero')];
for (let n = 0; n < 16; n++) zeros.push(pair(zeros[n], zeros[n]));
let scope, caller, oldController, newController, options, events, staged;
beforeEach(async () => {
  jest.clearAllMocks();
  // Native structuredClone returns foreign-realm prototypes under Jest. These
  // controlled owner records are acyclic plain data/BigInts, as in account tests.
  const clone = (v) =>
    Array.isArray(v)
      ? v.map(clone)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, clone(value)]))
        : v;
  jest.spyOn(global, 'structuredClone').mockImplementation(clone);
  events = [];
  staged = [];
  scope = createPrivacyScope({
    profileId: 'staging-fixture',
    signal: new AbortController().signal,
  });
  caller = new AbortController();
  oldController = new AbortController();
  newController = new AbortController();
  mockWalletPolicy = 'a'.repeat(64);
  mockPublicPolicy = 'b'.repeat(64);
  mockTxidPolicy = 'c'.repeat(64);
  mockPublicIdentity = {
    generationId: 'd'.repeat(64),
    sourceId: 'e'.repeat(64),
    publicId: 'f'.repeat(64),
  };
  mockFenced = true;
  mockIdentity = {
    signal: scope.signal,
    descriptor: { walletId: '5'.repeat(64), instanceId: 'self' },
  };
  mockEnrollment = {
    signal: scope.signal,
    catalog: { activeFor: jest.fn(() => ({ id: '1'.repeat(64) })) },
    getContext: (_role, operation) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'fixture',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role: 'engine',
        ...(operation ? { operation } : {}),
      }),
  };
  mockCoordinator = {
    signal: scope.signal,
    withPublicSnapshot: jest.fn(async (run) => {
      events.push('snapshot-open');
      const value = await run(mockSnapshot);
      events.push('snapshot-revalidated');
      return { value, evidence: {} };
    }),
  };
  mockOld = {
    generationId: '1'.repeat(64),
    signal: oldController.signal,
    close: jest.fn(async () => {
      events.push('old-close');
      oldController.abort();
    }),
  };
  mockNew = {
    generationId: '1'.repeat(64),
    signal: newController.signal,
    close: jest.fn(async () => {
      events.push('new-close');
      newController.abort();
    }),
  };
  mockHandoff = {
    token: Object.freeze({}),
    assertCurrent: jest.fn(),
    release: jest.fn(() => events.push('release')),
  };
  mockOwned = {
    checkpointHash: '2'.repeat(64),
    read: {
      instanceId: 'self',
      received: [
        {
          id: '0:0',
          tree: 0,
          position: 0,
          hash: hex(20),
          txid: hex(40),
          amount: 1000n,
          spentTxid: false,
          asset: { __type: 'erc20', contract: pins.wrappedNative },
        },
      ],
    },
    ownedPoi: [
      {
        id: '0:0',
        type: 'Transact',
        hash: hex(20),
        txid: hex(40),
        blockNumber: 1,
        nullifier: hex(10),
      },
    ],
  };
  mockFresh = structuredClone(mockOwned);
  mockRead.mockImplementation((account, owners) => {
    if (
      owners.identity !== mockIdentity ||
      owners.enrollment !== mockEnrollment ||
      owners.coordinator !== mockCoordinator
    )
      throw Error('owners');
    if (account === mockOld && !account.signal.aborted) return mockOwned;
    if (account === mockNew && !account.signal.aborted) return mockFresh;
    throw Error('account');
  });
  const p = createRailgunTxidProjection({
    hashPair: pair,
    zeroNodes: zeros,
    transactionHash: (r) => ({ hash: hash(JSON.stringify(r)), railgunTxid: hash(r.nullifiers[0]) }),
    verificationHash: () => hex(50),
  });
  const row = {
    version: 'V2',
    graphID: hex(1) + '0'.repeat(128),
    commitments: [hex(20)],
    nullifiers: [hex(10)],
    boundParamsHash: hex(30),
    blockNumber: 1,
    txid: hex(40).slice(2),
    timestamp: 1,
    utxoTreeIn: 0,
    utxoTreeOut: 0,
    utxoBatchStartPositionOut: 0,
    verificationHash: hex(50),
  };
  const store = new Map(),
    read = async (key) => store.get(key) ?? null;
  const result = await p.append(p.empty(), [row], read);
  result.writes.forEach(({ key, value }) => store.set(key, value));
  const note = {
    type: 'Transact',
    txid: hex(40),
    hash: hex(20),
    tree: 0,
    position: 0,
    blockNumber: 1,
  };
  const witness = await findRailgunNoteTxidWitness({
    state: result.state,
    note,
    read,
    projection: p,
  });
  mockTxid = {
    policy: mockTxidPolicy,
    publicIdentity: { ...mockPublicIdentity },
    inspect: jest.fn(async () => ({ checkpoint: { state: result.state }, pending: null })),
    witnessNote: jest.fn(async () => ({ noteWitness: witness })),
    close: jest.fn(async () => events.push('txid-close')),
  };
  mockOpenTxid.mockImplementation(async () => {
    expect(oldController.signal.aborted).toBe(true);
    events.push('txid-open');
    return mockTxid;
  });
  mockOpenWallet.mockImplementation(async () => {
    expect(mockTxid.close).toHaveBeenCalled();
    events.push('wallet-open');
    return mockNew;
  });
  options = {
    account: mockOld,
    owners: { identity: mockIdentity, enrollment: mockEnrollment, coordinator: mockCoordinator },
    request: {
      noteId: '0:0',
      quote: {
        data: Buffer.from(
          JSON.stringify({
            fees: { [pins.wrappedNative]: '0xde0b6b3a7640000' },
            feeExpiration: Date.now() + 240000,
            feesID: 'public-test',
            railgunAddress: '0zk1' + 'q'.repeat(123),
            availableWallets: 1,
            version: '8.0.0',
            relayAdapt: pins.relayAdapt,
            requiredPOIListKeys: ['44'.repeat(32)],
            reliability: -1,
          })
        ).toString('hex'),
        signature: '03'.repeat(32) + '00'.repeat(32),
      },
      gas: { transactionType: 0, gasEstimate: '84', gasPrice: '1', minGasPrice: '1' },
      maxFee: '100',
      signal: caller.signal,
    },
    archive: '/engine.asar',
    signal: caller.signal,
  };
  const checkpoint = {
    from: 0,
    previousHash: hex(0),
    to: { number: 10, hash: hex(10) },
    anchor: { number: 100, hash: hex(100) },
    logs: { count: 2, sha256: 'a'.repeat(64) },
    source: {
      level: 'unverified-rpc',
      providersSha256: 'b'.repeat(64),
      ledgerId: 'c'.repeat(64),
      ledgerSha256: 'd'.repeat(64),
    },
    state: {
      schema: 'public-records-v1',
      storeId: 'e'.repeat(64),
      trees: [{ tree: 0, length: 1, root: hex(11) }],
      commitments: { count: 1, sha256: 'f'.repeat(64) },
      nullifiers: { count: 1, sha256: '1'.repeat(64) },
      unshields: { count: 0, sha256: '2'.repeat(64) },
    },
  };
  const ciphertext = [[hex(1), hex(2), hex(3), hex(4)], hex(5), hex(6), '0x', '0x'];
  const log = (name, args, logIndex) => ({
    address: pins.proxy,
    blockNumber: 1,
    blockHash: hex(1),
    transactionHash: hex(40),
    transactionIndex: 0,
    logIndex,
    ...abi.encodeEventLog(abi.getEvent(name), args),
  });
  mockLogs = [
    log('Nullified', [0, [hex(10)]], 1),
    log('Transact', [0, 0, [hex(20)], [ciphertext]], 2),
  ];
  const freshAt = performance.now();
  mockSnapshot = {
    checkpoint,
    signal: caller.signal,
    visitSource: jest.fn(async (visitor) => {
      expect(performance.now() - freshAt).toBeLessThan(60000);
      events.push('source-visit');
      for (const log of mockLogs) await visitor(log);
      return {
        count: mockLogs.length,
        bytes: mockLogs.reduce((n, log) => n + Buffer.byteLength(JSON.stringify(log) + '\n'), 0),
      };
    }),
  };
  mockOwned.checkpointHash = mockFresh.checkpointHash = checkpointHash(checkpoint);
  mockVerify.mockImplementation(
    async ({ archive, state, note, noteWitness, events: sourceEvents }) => {
      events.push('verify-exited');
      const coverage = require('./railgun-txid-events').matchRailgunTxidEvents({
        blockNumber: note.blockNumber,
        txid: note.txid.slice(2),
        events: sourceEvents,
        rows: [noteWitness.witness.row],
      });
      return {
        inputSha256: createHash('sha256')
          .update(JSON.stringify({ archive, state, note, noteWitness, events: sourceEvents }))
          .digest('hex'),
        pathVerified: true,
        suppliedCreatorEventsMatched: true,
        utilityExitObserved: true,
        ownershipVerified: false,
        eventSourceAuthenticated: false,
        rootAccepted: false,
        spendingEnabled: false,
        coverage,
      };
    }
  );
  mockWindowToken = {};
  mockWindowData = {
    owned: mockFresh,
    selection: { tree: 0, position: 0 },
    checkpointHash: mockFresh.checkpointHash,
    draftDigest: '6'.repeat(64),
    summaryDigest: '7'.repeat(64),
    signal: newController.signal,
    deadline: performance.now() + 120000,
  };
  mockWindow.mockImplementation((token, account, owners, margin = 0) => {
    if (
      token !== mockWindowToken ||
      account !== mockNew ||
      owners.identity !== mockIdentity ||
      newController.signal.aborted ||
      performance.now() + margin >= mockWindowData.deadline
    )
      throw Error('window');
    return mockWindowData;
  });
});
afterEach(async () => {
  staged.forEach((v) => v.close());
  caller.abort();
  scope.close();
  await mockNew.close();
  jest.restoreAllMocks();
  jest.useRealTimers();
});
async function stage(extra = {}) {
  const value = await stageRailgunRelayTransactInput({ ...options, ...extra });
  if (value.status === 'staged') staged.push(value);
  return value;
}

const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const available = (r, request = options.request) =>
  assertRailgunRelayTransactStagingAvailable(r.receipt, mockNew, options.owners, request);
const claim = (r, token = mockWindowToken) =>
  claimRailgunRelayTransactStaging(r.receipt, mockNew, options.owners, options.request, token);
test('fixed pre-held sequence uses actual creator extraction and closes both owners before one-use relay claim', async () => {
  const r = await stage();
  expect(r.status).toBe('staged');
  expect(events).toEqual([
    'old-close',
    'txid-open',
    'txid-close',
    'snapshot-open',
    'source-visit',
    'snapshot-revalidated',
    'verify-exited',
    'wallet-open',
    'release',
  ]);
  expect(mockOpenTxid).toHaveBeenCalledWith(
    expect.objectContaining({ create: false, checkpointOnly: true, handoff: mockHandoff.token })
  );
  expect(mockVerify).toHaveBeenCalledTimes(1);
  expect(mockVerify.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(30000);
  expect(available(r).evidence.creator.source.trust).toBe('unverified-rpc');
  const copied = { ...r.receipt };
  expect(() =>
    assertRailgunRelayTransactStagingAvailable(copied, mockNew, options.owners, options.request)
  ).toThrow();
  const count = mockRead.mock.calls.length;
  const c = claim(r);
  expect(c.draftDigest).toBe(mockWindowData.draftDigest);
  expect(c.summaryDigest).toBe(mockWindowData.summaryDigest);
  expect(c.assertCurrent()).toBe(availableEvidence(r));
  expect(mockRead.mock.calls.length).toBe(count);
  expect(() => claim(r)).toThrow();
  expect(() => available(r)).toThrow();
  expect(() =>
    require('./railgun-transact-staging').assertRailgunTransactStagingAvailable(
      r.receipt,
      mockNew,
      options.owners,
      { kind: 'railgun-private-transfer', noteId: '0:0', recipient: 'self' }
    )
  ).toThrow();
});
function availableEvidence(r) {
  return assertRailgunRelayTransactStaging(
    r.receipt,
    mockNew,
    options.owners,
    options.request,
    mockWindowToken
  );
}
test.each([
  'private-kind',
  'extra',
  'accessor',
  'proxy',
  'fee',
  'wrong-token',
  'spent',
  'duplicate',
  'shield',
  'fence',
])('rejects %s before owner closure', async (fault) => {
  if (fault === 'private-kind')
    options.request = { kind: 'railgun-private-transfer', noteId: '0:0', recipient: 'self' };
  if (fault === 'extra') options.request.verified = true;
  if (fault === 'accessor')
    Object.defineProperty(options.request, 'quote', {
      get() {
        throw Error('must not invoke');
      },
      enumerable: true,
    });
  if (fault === 'proxy') options.request = new Proxy(options.request, {});
  if (fault === 'fee') options.request.maxFee = '99';
  if (fault === 'wrong-token') mockOwned.read.received[0].asset.contract = pins.proxy;
  if (fault === 'spent') mockOwned.read.received[0].spentTxid = hex(99);
  if (fault === 'duplicate') mockOwned.ownedPoi.push({ ...mockOwned.ownedPoi[0] });
  if (fault === 'shield') mockOwned.ownedPoi[0].type = 'Shield';
  if (fault === 'fence') mockFenced = false;
  expect((await stage()).status).toBe('refused');
  expect(mockOld.close).not.toHaveBeenCalled();
  expect(mockOpenTxid).not.toHaveBeenCalled();
});
test.each(['generation', 'hash', 'nullifier', 'amount', 'checkpoint', 'identity', 'request'])(
  'reopen %s mismatch refuses after verification and drains late wallet',
  async (fault) => {
    const original = mockOpenWallet.getMockImplementation();
    mockOpenWallet.mockImplementation(async (v) => {
      const value = await original(v);
      if (fault === 'generation') value.generationId = 'other';
      if (fault === 'hash') mockFresh.ownedPoi[0].hash = hex(99);
      if (fault === 'nullifier') mockFresh.ownedPoi[0].nullifier = hex(99);
      if (fault === 'amount') mockFresh.read.received[0].amount = 999n;
      if (fault === 'checkpoint') mockFresh.checkpointHash = '9'.repeat(64);
      if (fault === 'identity') mockPublicIdentity.publicId = '9'.repeat(64);
      if (fault === 'request') options.request.gas.gasPrice = '2';
      return value;
    });
    const r = await stage();
    if (fault === 'request') {
      expect(r.status).toBe('staged');
      expect(() => available(r)).toThrow();
    } else {
      expect(r.status).toBe('refused');
      expect(mockNew.close).toHaveBeenCalled();
    }
    expect(mockVerify).toHaveBeenCalled();
    expect(mockHandoff.release).toHaveBeenCalledTimes(1);
  }
);
test.each(['event-order', 'graph-index', 'checkpoint', 'post-refresh'])(
  'source %s mismatch stops before verifier/reopen',
  async (fault) => {
    if (fault === 'event-order') mockLogs.reverse();
    if (fault === 'graph-index') mockLogs.forEach((v) => (v.transactionIndex = 1));
    if (fault === 'checkpoint') mockSnapshot.checkpoint.to.hash = hex(99);
    if (fault === 'post-refresh')
      mockCoordinator.withPublicSnapshot.mockImplementation(async (run) => {
        await run(mockSnapshot);
        throw Error('canonical reorg');
      });
    expect((await stage()).status).toBe('refused');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockOpenWallet).not.toHaveBeenCalled();
    expect(mockHandoff.release).toHaveBeenCalledTimes(1);
  }
);
test('coordinator cancellation race still holds original creator callback before handoff release', async () => {
  const entered = deferred(),
    gate = deferred(),
    cancelled = deferred();
  const visit = mockSnapshot.visitSource.getMockImplementation();
  mockSnapshot.visitSource.mockImplementation(async (cb) => {
    entered.resolve();
    await gate.promise;
    return visit(cb);
  });
  mockCoordinator.withPublicSnapshot.mockImplementation((run) =>
    Promise.race([run(mockSnapshot), cancelled.promise])
  );
  let settled = false;
  const work = stage().then((v) => {
    settled = true;
    return v;
  });
  await entered.promise;
  cancelled.reject(Error('snapshot cancelled'));
  await turn();
  expect(settled).toBe(false);
  expect(mockHandoff.release).not.toHaveBeenCalled();
  gate.resolve();
  expect((await work).status).toBe('refused');
  expect(mockHandoff.release).toHaveBeenCalledTimes(1);
  expect(mockVerify).not.toHaveBeenCalled();
});
test.each([false, true])(
  'original verifier rejection unknown=%s drains first and retains only unknown handoff',
  async (unknown) => {
    const entered = deferred(),
      gate = deferred();
    mockVerify.mockImplementation(() => {
      entered.resolve();
      return gate.promise;
    });
    const error = Object.assign(Error('fixed verifier refusal'), {
      code: unknown ? 'RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED' : 'RAILGUN_NOTE_PROVENANCE_REFUSED',
    });
    let settled = false;
    const work = stage().then(
      (v) => {
        settled = true;
        return { value: v };
      },
      (e) => {
        settled = true;
        return { error: e };
      }
    );
    await entered.promise;
    caller.abort();
    await turn();
    expect(settled).toBe(false);
    expect(mockHandoff.release).not.toHaveBeenCalled();
    gate.reject(error);
    const result = await work;
    if (unknown) {
      expect(result.error).toBe(error);
      expect(mockHandoff.release).not.toHaveBeenCalled();
      expect(mockQuarantine).toHaveBeenCalledWith(mockIdentity);
    } else {
      expect(result.value.status).toBe('refused');
      expect(mockHandoff.release).toHaveBeenCalledTimes(1);
      expect(mockQuarantine).not.toHaveBeenCalled();
    }
  }
);
test('unknown old wallet close retains handoff and exposes no reusable outcome', async () => {
  mockOld.close.mockRejectedValue(Error('original closure unknown'));
  await expect(stage()).rejects.toMatchObject({
    code: 'RAILGUN_RELAY_TRANSACT_STAGING_DRAIN_FAILED',
  });
  expect(mockHandoff.release).not.toHaveBeenCalled();
  expect(mockOpenTxid).not.toHaveBeenCalled();
});
test('stage quote expiry and backward clock cannot revive immutable evidence', async () => {
  const r = await stage();
  expect(r.status).toBe('staged');
  const date = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(date - 1000);
  expect(() => available(r)).toThrow();
  clock.mockReturnValue(date + 1);
  expect(() => available(r)).toThrow();
  expect(r.signal.aborted).toBe(true);
});
test('source visit precedes a slow verifier rather than using an expired visit token afterward', async () => {
  const verify = mockVerify.getMockImplementation(),
    start = performance.now();
  mockVerify.mockImplementation(async (args) => {
    expect(mockSnapshot.visitSource).toHaveBeenCalledTimes(1);
    jest.spyOn(performance, 'now').mockReturnValue(start + 65000);
    return verify(args);
  });
  const r = await stage();
  expect(r.status).toBe('staged');
  expect(events.indexOf('source-visit')).toBeLessThan(events.indexOf('verify-exited'));
});
test('private window and changed draft generation cannot claim a relay receipt', async () => {
  const r = await stage();
  expect(() => claim(r, {})).toThrow();
  const c = claim(r);
  mockWindowData = { ...mockWindowData, draftDigest: '8'.repeat(64) };
  expect(() => c.assertCurrent()).toThrow();
});
test.each([119999, 300001])('quote margin %s refuses before owner closure', async (margin) => {
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  const fields = JSON.parse(Buffer.from(options.request.quote.data, 'hex').toString());
  fields.feeExpiration = now + margin;
  options.request.quote.data = Buffer.from(JSON.stringify(fields)).toString('hex');
  expect((await stage()).status).toBe('refused');
  expect(mockOld.close).not.toHaveBeenCalled();
});
test('staging cannot return a reopened account with insufficient later review admission margin', async () => {
  const fields = JSON.parse(Buffer.from(options.request.quote.data, 'hex').toString());
  const original = mockOpenWallet.getMockImplementation();
  mockOpenWallet.mockImplementation(async (args) => {
    const wallet = await original(args);
    jest.spyOn(Date, 'now').mockReturnValue(fields.feeExpiration - 119999);
    return wallet;
  });
  expect((await stage()).status).toBe('refused');
  expect(mockNew.close).toHaveBeenCalledTimes(1);
  expect(mockHandoff.release).toHaveBeenCalledTimes(1);
});
test('closing staging revokes evidence without closing the returned account or borrowed owners', async () => {
  const r = await stage();
  expect(r.status).toBe('staged');
  r.close();
  expect(() => available(r)).toThrow();
  expect(mockNew.close).not.toHaveBeenCalled();
  expect(mockNew.signal.aborted).toBe(false);
  expect(mockEnrollment.signal.aborted).toBe(false);
});
