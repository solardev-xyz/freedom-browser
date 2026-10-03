const fs = require('fs'),
  os = require('os'),
  path = require('path');
let mockPreparation,
  mockReceiver,
  mockEnrollment,
  mockIdentity,
  mockEndpoint,
  mockDirectory,
  mockCurrent,
  mockMode;
const mockAcquire = jest.fn(),
  mockRequest = jest.fn();
const mockSources = [];
const mockJournals = new WeakMap();
jest.mock('./railgun-shield-prepare', () => ({
  MAX_AGE_MS: 120000,
  prepareRailgunNativeShield: async () => mockPreparation,
  assertRailgunShieldPreparation: (receipt, identity, enrollment) => {
    if (
      receipt !== mockPreparation.receipt ||
      identity !== mockIdentity ||
      enrollment !== mockEnrollment ||
      !mockCurrent
    )
      throw Error('Invalid preparation');
    return mockPreparation.prepared;
  },
}));
jest.mock('./railgun-shield-receive', () => ({
  verifyRailgunShieldReceiver: async () => mockReceiver,
  assertRailgunShieldReceiver: (receipt) => {
    if (receipt !== mockReceiver || !mockCurrent) throw Error('Invalid receiver');
    return mockPreparation.prepared;
  },
}));
jest.mock('./railgun-shield-preflight', () => ({
  createRailgunShieldPreflight: () => {
    const abort = new AbortController();
    const receipt = Object.freeze({});
    const source = {
      signal: abort.signal,
      acquire: async () => {
        await mockAcquire();
        return { receipt };
      },
      close: jest.fn(() => abort.abort()),
      receipt,
    };
    mockSources.push(source);
    return source;
  },
  assertRailgunShieldPreflight: (source, receipt) => {
    if (source.receipt !== receipt || source.signal.aborted || !mockCurrent)
      throw Error('Invalid preflight');
  },
}));
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('../networks/network-registry', () => ({
  getNetwork: () => ({}),
  getEndpoints: () => ['https://rpc.example'],
  getEndpointSources: () => [{ keyed: false, coverage: { 11155111: 'https://rpc.example' } }],
}));
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: () => ({ request: mockRequest }),
}));
jest.mock('./private-submission-journal', () => ({
  getPrivateSubmissionJournal: (handle) => {
    if (!mockJournals.has(handle))
      mockJournals.set(
        handle,
        jest
          .requireActual('./private-submission-journal')
          .createSubmissionJournal({ handle, directory: mockDirectory, key: Buffer.alloc(32, 3) })
      );
    return mockJournals.get(handle);
  },
}));
const { Wallet, Transaction } = require('ethers');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { openRailgunShieldOperation } = require('./railgun-shield-operation');
const prepared = require('../../../docs/qualification/railgun-shield-account-2026-10-03.json')
  .prepared[0];
const wallet = new Wallet('0x' + '11'.repeat(32)); // Public test key only.
let parentScope, handles, methods, operation, signer, broadcastCount, rawHash;
beforeEach(() => {
  jest.clearAllMocks();
  mockSources.length = 0;
  mockAcquire.mockResolvedValue(undefined);
  mockCurrent = true;
  mockMode = null;
  handles = [];
  methods = [];
  broadcastCount = 0;
  mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-shield-operation-'));
  const tor = new AbortController();
  mockEndpoint = { signal: tor.signal };
  parentScope = createPrivacyScope({
    profileId: 'shield-operation-fixture',
    signal: new AbortController().signal,
  });
  mockEnrollment = {
    signal: parentScope.signal,
    getContext: (role, operation) =>
      parentScope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        operation,
      }),
  };
  mockIdentity = { signal: parentScope.signal };
  mockPreparation = { receipt: Object.freeze({}), prepared };
  mockReceiver = Object.freeze({});
  signer = {
    getAddress: async () => wallet.address,
    signTransaction: jest.fn(async (tx) => {
      if (mockMode === 'late-sign') mockCurrent = false;
      return wallet.signTransaction(tx);
    }),
  };
  mockRequest.mockImplementation(async (handle, _url, options) => {
    handles.push(handle);
    const call = JSON.parse(options.body);
    methods.push(call.method);
    let result = {
      eth_chainId: '0xaa36a7',
      eth_getCode: '0x',
      eth_estimateGas: '0x493e0',
      eth_call: '0x',
      eth_gasPrice: '0x64',
      eth_getTransactionCount: '0x0',
      eth_getBalance: '0xde0b6b3a7640000',
    }[call.method];
    if (mockMode === 'delegated' && call.method === 'eth_getCode') result = '0xef0100';
    if (mockMode === 'estimate' && call.method === 'eth_estimateGas') result = '0xffffff';
    if (
      mockMode === 'pending' &&
      call.method === 'eth_getTransactionCount' &&
      call.params[1] === 'pending'
    )
      result = '0x1';
    if (mockMode === 'balance' && call.method === 'eth_getBalance') result = '0x0';
    if (call.method === 'eth_sendRawTransaction') {
      broadcastCount++;
      const parsed = Transaction.from(call.params[0]);
      rawHash = parsed.hash;
      const saved = await mockJournals.get(handle).list();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        hash: rawHash,
        nonce: 0,
        state: 'attempted',
        intent: { kind: 'railgun-native-shield', npk: prepared.npk },
      });
      expect(JSON.stringify(saved)).not.toContain(call.params[0]);
      if (mockMode === 'lost') throw Error('Connection lost after send');
      result = parsed.hash;
    }
    return {
      status: 200,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: call.id, result })),
    };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  operation?.close();
  parentScope.close();
});
const open = async () =>
  (operation = await openRailgunShieldOperation({
    identity: mockIdentity,
    enrollment: mockEnrollment,
    archive: '/fixture/engine.asar',
    amount: prepared.value,
    owner: wallet.address.toLowerCase(),
  }));
const submit = (review) =>
  operation.submit({
    signer,
    review: review ?? (async () => true),
    gasLimit: 500000n,
    maxGasFee: 1000000000000000n,
  });
test('real signing writes canonical shield intent before broadcast and uses the separate public-address route once', async () => {
  await open();
  const review = jest.fn(async (request) => {
    expect(request).toMatchObject({
      fundingAddressPublic: true,
      operation: 'railgun-native-shield',
      recipient: prepared.recipient,
      noteCommitment: prepared.commitment,
      chainStateVerified: false,
    });
    expect(request.protocolFee + request.noteValue).toBe(BigInt(prepared.value));
    return true;
  });
  const sent = await submit(review);
  expect(sent.hash).toBe(rawHash);
  expect(broadcastCount).toBe(1);
  expect(review).toHaveBeenCalledTimes(1);
  const context = getPrivacyContext;
  // The scope closes at completion. Inspect the subject while the route is live
  // in the review callback in the companion isolation test below.
  expect(() => context(handles[0])).toThrow();
  await expect(submit()).rejects.toThrow();
  expect(broadcastCount).toBe(1);
});
test('funding requests use public-address identity without a private-account operation tag', async () => {
  await open();
  await submit(async () => {
    for (const handle of handles)
      expect(getPrivacyContext(handle).subject).toMatchObject({
        kind: 'public-address',
        principal: wallet.address.toLowerCase(),
        role: 'transaction-rpc',
        protocol: null,
        deployment: null,
        operation: null,
      });
    return true;
  });
});
test.each(['delegated', 'estimate', 'pending', 'balance'])(
  'refuses %s before signing or journal submission',
  async (mode) => {
    mockMode = mode;
    await open();
    await expect(submit()).rejects.toThrow();
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(broadcastCount).toBe(0);
  }
);
test.each(['review', 'late-sign'])(
  'revocation at %s never reaches the broadcaster',
  async (mode) => {
    mockMode = mode;
    await open();
    await expect(
      submit(async () => {
        if (mode === 'review') mockCurrent = false;
        return true;
      })
    ).rejects.toThrow();
    expect(broadcastCount).toBe(0);
  }
);
test('uncertain broadcast survives a new operation and prevents another signed deposit', async () => {
  mockMode = 'lost';
  await open();
  await expect(submit()).rejects.toMatchObject({ code: 'PRIVATE_BROADCAST_UNCERTAIN' });
  expect(broadcastCount).toBe(1);
  mockMode = null;
  await open();
  await expect(submit()).rejects.toThrow();
  expect(broadcastCount).toBe(1);
  expect(signer.signTransaction).toHaveBeenCalledTimes(1);
});
test('only a transport acquisition refusal can retry once on a fresh source', async () => {
  mockAcquire.mockRejectedValueOnce(Object.assign(Error('Transport'), { reason: 'rpc' }));
  await open();
  expect(mockAcquire).toHaveBeenCalledTimes(2);
  expect(mockSources[0].signal.aborted).toBe(true);
});
test('deployment mismatch is never retried and creates no transaction route', async () => {
  mockAcquire.mockRejectedValueOnce(
    Object.assign(Error('Changed deployment'), { reason: 'mismatch' })
  );
  await expect(open()).rejects.toThrow();
  expect(mockAcquire).toHaveBeenCalledTimes(1);
  expect(handles).toHaveLength(0);
});

test.each([
  { gasLimit: 3000001n },
  { gasLimit: 0n },
  { maxGasFee: 2000000000000001n },
  { maxGasFee: 0n },
])('qualification caps refuse before any transaction RPC %#', (change) => {
  return open().then(async () => {
    await expect(
      operation.submit({
        signer,
        review: async () => true,
        gasLimit: 500000n,
        maxGasFee: 1000000000000000n,
        ...change,
      })
    ).rejects.toThrow();
    expect(handles).toHaveLength(0);
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });
});
test('generic private context cannot bypass enrolled operation receipts at signing or raw broadcast', async () => {
  const handle = parentScope.getContext({
    kind: 'public-address',
    principal: wallet.address.toLowerCase(),
    chainId: 11155111,
    role: 'transaction-rpc',
  });
  const tx = {
    chainId: 11155111,
    from: wallet.address,
    to: prepared.to,
    value: prepared.value,
    data: prepared.data,
    gasLimit: '500000',
  };
  const intent = require('./private-transaction-intent').transactionIntent(
    'railgun-native-shield',
    tx
  );
  await expect(
    require('./transaction-service').signAndSendTransaction(tx, signer, {
      privacyContext: handle,
      intent,
      review: async () => true,
    })
  ).rejects.toMatchObject({ code: 'RAILGUN_SHIELD_HANDOFF_REFUSED' });
  expect(signer.signTransaction).not.toHaveBeenCalled();
  const signed = await wallet.signTransaction({ ...tx, gasPrice: 100n, nonce: 0, type: 0 });
  await expect(
    require('./private-transaction-network')
      .getPrivateTransactionNetwork(handle)
      .broadcastRawTransaction(11155111, signed, { intent })
  ).rejects.toMatchObject({ code: 'RAILGUN_SHIELD_HANDOFF_REFUSED' });
  expect(handles).toHaveLength(0);
});
test('review uses the shorter preflight deadline with a ten-second safety margin', async () => {
  const start = Date.now();
  await open();
  await expect(
    submit(async (request) => {
      expect(request.expiresAt).toBeLessThanOrEqual(start + 50500);
      jest.spyOn(Date, 'now').mockReturnValue(request.expiresAt + 1);
      return true;
    })
  ).rejects.toThrow();
  expect(signer.signTransaction).not.toHaveBeenCalled();
  expect(broadcastCount).toBe(0);
});
