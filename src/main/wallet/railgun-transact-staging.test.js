let mockIdentity, mockEnrollment, mockCoordinator, mockOld, mockNew, mockOwned, mockFresh;
let mockWalletPolicy, mockTxidPolicy, mockPublicPolicy, mockPublicIdentity, mockTxid, mockHandoff;
const mockOpenWallet = jest.fn(),
  mockOpenTxid = jest.fn(),
  mockRead = jest.fn(),
  mockWindow = jest.fn();
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (identity) => {
    if (identity !== mockIdentity) throw Error('identity');
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
  assertRailgunAccountPrivateWindow: (...args) => mockWindow(...args),
}));
jest.mock('./railgun-account-txid', () => ({
  openRailgunAccountTxid: (...args) => mockOpenTxid(...args),
}));
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunTxidProjection } = require('./railgun-txid-projection');
const { findRailgunNoteTxidWitness } = require('./railgun-txid-note-witness');
const {
  stageRailgunTransactInput,
  assertRailgunTransactStaging,
} = require('./railgun-transact-staging');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
const hash = (s) => '0' + createHash('sha256').update(s).digest('hex').slice(1);
const pair = (a, b) => hash(a + b),
  zeros = [hash('zero')];
for (let n = 0; n < 16; n++) zeros.push(pair(zeros[n], zeros[n]));
let scope, caller, oldController, newController, options, events, staged;
beforeEach(async () => {
  jest.clearAllMocks();
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
  mockIdentity = { signal: scope.signal };
  mockEnrollment = {
    signal: scope.signal,
    catalog: { activeFor: jest.fn(() => ({ id: '1'.repeat(64) })) },
    getContext: () =>
      scope.getContext({
        kind: 'private-account',
        principal: 'fixture',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role: 'engine',
      }),
  };
  mockCoordinator = { signal: scope.signal };
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
    request: { kind: 'railgun-private-transfer', noteId: '0:0', recipient: 'self' },
    archive: '/engine.asar',
    signal: caller.signal,
  };
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
  const value = await stageRailgunTransactInput({ ...options, ...extra });
  if (value.status === 'staged') staged.push(value);
  return value;
}
test('drains both old phases, rederives the same full note, and returns account-bound immutable staging data', async () => {
  const result = await stage();
  expect(result.status).toBe('staged');
  expect(result.account).toBe(mockNew);
  expect(events).toEqual(['old-close', 'txid-open', 'txid-close', 'wallet-open', 'release']);
  expect(mockOpenTxid).toHaveBeenCalledWith(
    expect.objectContaining({ create: false, checkpointOnly: true, handoff: mockHandoff.token })
  );
  expect(mockOpenWallet).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: 'active',
      policy: mockWalletPolicy,
      handoff: mockHandoff.token,
    })
  );
  const value = assertRailgunTransactStaging(
    result.receipt,
    mockNew,
    options.owners,
    options.request
  );
  expect(value.baseline.received.amount).toBe(1000n);
  expect(Object.isFrozen(value.noteWitness.witness.elements)).toBe(true);
  expect(result.observation.spendingEnabled).toBe(false);
  expect(oldController.signal.aborted).toBe(true);
  expect(result.signal.aborted).toBe(false);
  expect(() =>
    assertRailgunTransactStaging({ ...result.receipt }, mockNew, options.owners, options.request)
  ).toThrow();
  expect(() =>
    assertRailgunTransactStaging(result.receipt, mockOld, options.owners, options.request)
  ).toThrow();
  for (const key of ['identity', 'enrollment', 'coordinator'])
    expect(() =>
      assertRailgunTransactStaging(
        result.receipt,
        mockNew,
        { ...options.owners, [key]: {} },
        options.request
      )
    ).toThrow();
  expect(() =>
    assertRailgunTransactStaging(result.receipt, mockNew, options.owners, {
      ...options.request,
      recipient: 'other',
    })
  ).toThrow();
  result.close();
  expect(mockNew.close).not.toHaveBeenCalled();
  expect(() =>
    assertRailgunTransactStaging(result.receipt, mockNew, options.owners, options.request)
  ).toThrow();
});
test.each(['amount', 'asset', 'nullifier', 'spent', 'checkpoint', 'generation'])(
  'changed reopened %s refuses and drains the replacement',
  async (mode) => {
    if (mode === 'amount') mockFresh.read.received[0].amount++;
    if (mode === 'asset') mockFresh.read.received[0].asset.contract = '0x' + '1'.repeat(40);
    if (mode === 'nullifier') mockFresh.ownedPoi[0].nullifier = hex(99);
    if (mode === 'spent') mockFresh.read.received[0].spentTxid = hex(99);
    if (mode === 'checkpoint') mockFresh.checkpointHash = '3'.repeat(64);
    if (mode === 'generation') mockNew.generationId = '3'.repeat(64);
    expect(await stage()).toEqual({
      status: 'refused',
      stage: 'reopening-wallet',
      originalAccountReusable: false,
    });
    expect(mockNew.close).toHaveBeenCalled();
    expect(mockHandoff.release).toHaveBeenCalledTimes(1);
  }
);
test('non-Transact selection refuses before taking or closing any account resource', async () => {
  mockOwned.ownedPoi[0].type = 'Shield';
  expect(await stage()).toEqual({
    status: 'refused',
    stage: 'local',
    originalAccountReusable: true,
  });
  expect(mockOld.close).not.toHaveBeenCalled();
  expect(mockOpenTxid).not.toHaveBeenCalled();
  expect(mockHandoff.release).not.toHaveBeenCalled();
});
test.each(['policy', 'public', 'checkpoint', 'witness'])(
  'changed TXID %s refuses before reopening a wallet',
  async (mode) => {
    if (mode === 'policy') mockTxid.policy = '7'.repeat(64);
    if (mode === 'public') mockTxid.publicIdentity.sourceId = '7'.repeat(64);
    if (mode === 'checkpoint') {
      const original = mockTxid.inspect.getMockImplementation();
      let calls = 0;
      mockTxid.inspect.mockImplementation(async () => {
        const v = await original();
        return ++calls === 2 ? { ...v, pending: {} } : v;
      });
    }
    if (mode === 'witness') mockTxid.witnessNote.mockResolvedValue({ noteWitness: {} });
    expect((await stage()).status).toBe('refused');
    expect(mockOpenWallet).not.toHaveBeenCalled();
    expect(mockTxid.close).toHaveBeenCalled();
    expect(mockHandoff.release).toHaveBeenCalledTimes(1);
  }
);
test.each(['txid', 'wallet'])(
  'abort during late %s open waits for settlement and drain before releasing',
  async (phase) => {
    let entered,
      finishOpen,
      finishClose,
      settled = false;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const resource = phase === 'txid' ? mockTxid : mockNew;
    (phase === 'txid' ? mockOpenTxid : mockOpenWallet).mockImplementation(async () => {
      entered();
      await new Promise((resolve) => {
        finishOpen = resolve;
      });
      return resource;
    });
    resource.close.mockImplementation(async () => {
      await new Promise((resolve) => {
        finishClose = resolve;
      });
    });
    const pending = stage().then((v) => {
      settled = true;
      return v;
    });
    await ready;
    caller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mockHandoff.release).not.toHaveBeenCalled();
    finishOpen();
    for (let n = 0; n < 12; n++) await Promise.resolve();
    expect(resource.close).toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(mockHandoff.release).not.toHaveBeenCalled();
    finishClose();
    expect((await pending).status).toBe('refused');
    expect(mockHandoff.release).toHaveBeenCalledTimes(1);
    if (phase === 'txid') expect(mockOpenWallet).not.toHaveBeenCalled();
    resource.close.mockResolvedValue(undefined);
  }
);
test('deadline after old wallet drain does not start another phase', async () => {
  let now = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  mockOld.close.mockImplementation(async () => {
    oldController.abort();
    now += 11;
  });
  expect((await stage({ timeoutMs: 10 })).status).toBe('refused');
  expect(mockOpenTxid).not.toHaveBeenCalled();
  expect(mockHandoff.release).toHaveBeenCalledTimes(1);
});
test('cleanup integrity failure preserves handoff exclusion instead of reporting a usable original account', async () => {
  mockTxid.close.mockRejectedValue(Error('drain failure'));
  const result = await stage();
  expect(result.status).toBe('refused');
  expect(result.originalAccountReusable).toBe(false);
  expect(mockHandoff.release).not.toHaveBeenCalled();
  expect(mockOpenWallet).not.toHaveBeenCalled();
});
test('staging reasserts selection and a genuine window, and expires with the reopened account', async () => {
  const result = await stage(),
    window = {};
  mockWindow.mockImplementation((v, account) => {
    if (v !== window || account !== mockNew) throw Error('window');
    return {
      owned: mockFresh,
      selection: assertRailgunTransactStaging(
        result.receipt,
        mockNew,
        options.owners,
        options.request
      ).baseline.selection,
      checkpointHash: mockFresh.checkpointHash,
    };
  });
  expect(
    assertRailgunTransactStaging(result.receipt, mockNew, options.owners, options.request, window)
      .spendingEnabled
  ).toBe(false);
  expect(() =>
    assertRailgunTransactStaging(result.receipt, mockNew, options.owners, options.request, {})
  ).toThrow();
  mockFresh.ownedPoi[0].nullifier = hex(99);
  expect(() =>
    assertRailgunTransactStaging(result.receipt, mockNew, options.owners, options.request, window)
  ).toThrow();
  newController.abort();
  expect(result.signal.aborted).toBe(true);
});

test.each(['kind', 'recipient', 'tree', 'position', 'checkpoint'])(
  'a genuine window with changed %s cannot reuse staging for an unchanged owned note',
  async (mode) => {
    const result = await stage();
    const data = assertRailgunTransactStaging(
      result.receipt,
      mockNew,
      options.owners,
      options.request
    );
    const selection = structuredClone(data.baseline.selection);
    let checkpointHash = data.baseline.checkpointHash;
    if (mode === 'kind') selection.kind = 'railgun-token-unshield';
    if (mode === 'recipient') selection.recipient = 'other';
    if (mode === 'tree') selection.tree++;
    if (mode === 'position') selection.position++;
    if (mode === 'checkpoint') checkpointHash = '9'.repeat(64);
    mockWindow.mockReturnValue({ owned: mockFresh, selection, checkpointHash });
    expect(() =>
      assertRailgunTransactStaging(result.receipt, mockNew, options.owners, options.request, {})
    ).toThrow();
  }
);
