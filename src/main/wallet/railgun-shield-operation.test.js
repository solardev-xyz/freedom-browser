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
  mockMode,
  mockUrl;
const mockAcquire = jest.fn(),
  mockRequest = jest.fn(),
  mockPrepare = jest.fn(),
  mockReceive = jest.fn(),
  mockRelease = jest.fn();
const mockSources = [];
const mockJournals = new WeakMap();
jest.mock('./railgun-shield-prepare', () => ({
  MAX_AGE_MS: 120000,
  prepareRailgunNativeShield: (options) => mockPrepare(options),
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
  verifyRailgunShieldReceiver: (options) => mockReceive(options),
  assertRailgunShieldReceiver: (receipt) => {
    if (receipt !== mockReceiver || !mockCurrent) throw Error('Invalid receiver');
    return mockPreparation.prepared;
  },
}));
jest.mock('./railgun-shield-preflight', () => ({
  createRailgunShieldPreflight: (enrollment, options = {}) => {
    const abort = new AbortController();
    const receipt = Object.freeze({});
    // Only the deployment read/receipt is synthetic. Genuine token validation
    // and current selected-destination construction remain connected here.
    const rpc =
      options.destinationConstraint === undefined
        ? undefined
        : require('../networks/private-rpc').createPrivateRpc(
            enrollment.getContext('protocol-rpc', 'shield-preflight'),
            'protocol-rpc',
            options
          );
    const source = {
      signal: abort.signal,
      acquire: async () => {
        await mockAcquire();
        return { receipt };
      },
      close: jest.fn(() => {
        abort.abort();
        rpc?.release();
      }),
      receipt,
      options,
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
  getEndpoints: () => [mockUrl],
  getEndpointSources: () => [{ keyed: false, coverage: { 11155111: mockUrl } }],
}));
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: () => ({ request: mockRequest, release: mockRelease }),
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
const {
  createPrivateRpc,
  getPrivateRpcDestination,
  createPrivateRpcDestinationConstraint,
} = require('../networks/private-rpc');
const { openRailgunShieldOperation } = require('./railgun-shield-operation');
const prepared = require('../../../docs/qualification/railgun-shield-account-2026-10-03.json')
  .prepared[0];
const wallet = new Wallet('0x' + '11'.repeat(32)); // Public test key only.
let parentScope, handles, methods, operation, signer, broadcastCount, rawHash, constraints;
beforeEach(() => {
  jest.clearAllMocks();
  mockSources.length = 0;
  mockAcquire.mockResolvedValue(undefined);
  mockPrepare.mockImplementation(async () => mockPreparation);
  mockReceive.mockImplementation(async () => mockReceiver);
  mockRelease.mockImplementation(() => {});
  constraints = [];
  operation = undefined;
  mockUrl = 'https://rpc.example';
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
    getAddress: jest.fn(async () => wallet.address),
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
afterEach(async () => {
  jest.restoreAllMocks();
  operation?.close();
  await operation?.closed.catch(() => {});
  for (const constraint of constraints) constraint.close();
  parentScope.close();
  jest.useRealTimers();
});
const open = async (options = {}) =>
  (operation = await openRailgunShieldOperation({
    identity: mockIdentity,
    enrollment: mockEnrollment,
    archive: '/fixture/engine.asar',
    amount: prepared.value,
    owner: wallet.address.toLowerCase(),
    ...options,
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
  await expect(submit()).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNRESOLVED' });
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

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const destinationPair = () => {
  const make = (handle, role) => {
    const rpc = createPrivateRpc(handle, role);
    const authority = createPrivateRpcDestinationConstraint({
      observation: getPrivateRpcDestination(rpc, handle),
      signal: parentScope.signal,
      deadline: performance.now() + 120000,
    });
    constraints.push(authority);
    return authority.constraint;
  };
  return {
    protocol: make(mockEnrollment.getContext('protocol-rpc', 'shield-preflight'), 'protocol-rpc'),
    transaction: make(
      parentScope.getContext({
        kind: 'public-address',
        principal: wallet.address.toLowerCase(),
        chainId: 11155111,
        role: 'transaction-rpc',
      }),
      'transaction-rpc'
    ),
  };
};

test('genuine fixed destinations reach every preflight attempt and the journal-before-send transaction route', async () => {
  const destinationConstraints = destinationPair();
  mockAcquire.mockRejectedValueOnce(Object.assign(Error('Transport'), { reason: 'rpc' }));
  await open({ destinationConstraints });
  expect(mockPrepare.mock.calls[0][0].signal).toBe(mockReceive.mock.calls[0][0].signal);
  expect(mockPrepare.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(120000);
  expect(mockReceive.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(
    mockPrepare.mock.calls[0][0].timeoutMs
  );
  expect(mockSources).toHaveLength(2);
  for (const source of mockSources)
    expect(source.options.destinationConstraint).toBe(destinationConstraints.protocol);
  expect(mockRequest).not.toHaveBeenCalled();
  await submit();
  await operation.closed;
  expect(broadcastCount).toBe(1);
  expect(mockRequest.mock.calls.every(([, url]) => url === 'https://rpc.example')).toBe(true);
});

test.each(['missing', 'extra', 'prototype', 'proxy', 'getter', 'forged', 'swapped'])(
  'refuses %s destination constraints before viewing credentials or RPC',
  async (kind) => {
    let pair = destinationPair();
    const getter = jest.fn(() => pair.protocol);
    if (kind === 'missing') pair = { protocol: pair.protocol };
    if (kind === 'extra') pair = { ...pair, fallback: true };
    if (kind === 'prototype') pair = Object.assign(Object.create({}), pair);
    if (kind === 'proxy')
      pair = new Proxy(pair, {
        get: () => {
          throw Error('must not inspect proxy');
        },
      });
    if (kind === 'getter') Object.defineProperty(pair, 'protocol', { get: getter });
    if (kind === 'forged') pair = { protocol: {}, transaction: {} };
    if (kind === 'swapped') pair = { protocol: pair.transaction, transaction: pair.protocol };
    await expect(open({ destinationConstraints: pair })).rejects.toMatchObject({
      code: 'RAILGUN_SHIELD_HANDOFF_REFUSED',
    });
    expect(getter).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockReceive).not.toHaveBeenCalled();
    expect(mockAcquire).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  }
);

test('a pre-aborted operation performs no credential or source work', async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(open({ signal: abort.signal })).rejects.toMatchObject({
    code: 'RAILGUN_SHIELD_HANDOFF_REFUSED',
  });
  expect(mockPrepare).not.toHaveBeenCalled();
  expect(mockReceive).not.toHaveBeenCalled();
  expect(mockAcquire).not.toHaveBeenCalled();
});

test.each(['prepare', 'receive'])(
  'abort is installed before held %s and opening waits for the original host promise',
  async (stage) => {
    const held = deferred(),
      entered = deferred(),
      abort = new AbortController();
    const factory = stage === 'prepare' ? mockPrepare : mockReceive;
    factory.mockImplementationOnce((options) => {
      entered.resolve(options);
      return held.promise;
    });
    let settled = false;
    const opening = open({ signal: abort.signal }).then(
      () => {
        settled = true;
        throw Error('unexpected open');
      },
      (error) => {
        settled = true;
        return error;
      }
    );
    const options = await entered.promise;
    try {
      abort.abort();
      expect(options.signal.aborted).toBe(true);
      await tick();
      expect(settled).toBe(false);
      expect(mockAcquire).not.toHaveBeenCalled();
      if (stage === 'prepare') expect(mockReceive).not.toHaveBeenCalled();
    } finally {
      held.resolve(stage === 'prepare' ? mockPreparation : mockReceiver);
    }
    expect(await opening).toMatchObject({
      code: 'RAILGUN_SHIELD_HANDOFF_REFUSED',
      message: 'Railgun shield handoff refused',
    });
    expect(mockRequest).not.toHaveBeenCalled();
  }
);

test('the original operation deadline bounds a held host and cannot renew at the receiver', async () => {
  jest.useFakeTimers();
  const held = deferred(),
    entered = deferred();
  mockPrepare.mockImplementationOnce((options) => {
    entered.resolve(options);
    return held.promise;
  });
  const opening = open().catch((error) => error);
  const options = await entered.promise;
  await jest.advanceTimersByTimeAsync(120001);
  expect(options.signal.aborted).toBe(true);
  held.resolve(mockPreparation);
  expect(await opening).toMatchObject({ code: 'RAILGUN_SHIELD_HANDOFF_REFUSED' });
  expect(mockReceive).not.toHaveBeenCalled();
  expect(mockAcquire).not.toHaveBeenCalled();
});

test('receiver budget consumes time already spent preparing', async () => {
  jest.useFakeTimers();
  mockPrepare.mockImplementationOnce(async () => {
    await jest.advanceTimersByTimeAsync(27000);
    return mockPreparation;
  });
  await open();
  expect(mockPrepare.mock.calls[0][0].timeoutMs).toBe(120000);
  expect(mockReceive.mock.calls[0][0].timeoutMs).toBe(93000);
});

test('a changed destination between credentials and preflight never obtains an unrestricted source', async () => {
  const destinationConstraints = destinationPair();
  mockReceive.mockImplementationOnce(async () => {
    mockUrl = 'https://other.example';
    return mockReceiver;
  });
  await expect(open({ destinationConstraints })).rejects.toMatchObject({
    code: 'RAILGUN_SHIELD_HANDOFF_REFUSED',
  });
  expect(mockAcquire).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
});

test('registry change between token mint and construction refuses before either credential', async () => {
  const destinationConstraints = destinationPair();
  mockUrl = 'https://other.example';
  await expect(open({ destinationConstraints })).rejects.toMatchObject({
    code: 'RAILGUN_SHIELD_HANDOFF_REFUSED',
  });
  expect(mockPrepare).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
});

test('a valid current protocol token cannot hide a stale transaction destination before credentials', async () => {
  const oldPair = destinationPair();
  mockUrl = 'https://other.example';
  const currentPair = destinationPair();
  await expect(
    open({
      destinationConstraints: {
        protocol: currentPair.protocol,
        transaction: oldPair.transaction,
      },
    })
  ).rejects.toMatchObject({ code: 'RAILGUN_SHIELD_HANDOFF_REFUSED' });
  expect(mockPrepare).not.toHaveBeenCalled();
  expect(mockReceive).not.toHaveBeenCalled();
  expect(mockAcquire).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
});

test('cancellation at preparation completion prevents entering receiver verification', async () => {
  const abort = new AbortController();
  mockPrepare.mockImplementationOnce(() =>
    Promise.resolve(mockPreparation).then((result) => {
      abort.abort();
      return result;
    })
  );
  await expect(open({ signal: abort.signal })).rejects.toMatchObject({
    code: 'RAILGUN_SHIELD_HANDOFF_REFUSED',
  });
  expect(mockPrepare).toHaveBeenCalledTimes(1);
  expect(mockReceive).not.toHaveBeenCalled();
  expect(mockAcquire).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
});

test('constraint revocation propagates into a held credential and still waits for its drain', async () => {
  const destinationConstraints = destinationPair(),
    held = deferred(),
    entered = deferred();
  mockPrepare.mockImplementationOnce((options) => {
    entered.resolve(options);
    return held.promise;
  });
  let settled = false;
  const opening = open({ destinationConstraints }).catch((error) => {
    settled = true;
    return error;
  });
  const options = await entered.promise;
  try {
    constraints[1].close();
    expect(options.signal.aborted).toBe(true);
    await tick();
    expect(settled).toBe(false);
  } finally {
    held.resolve(mockPreparation);
  }
  expect(await opening).toMatchObject({ code: 'RAILGUN_SHIELD_HANDOFF_REFUSED' });
  expect(mockReceive).not.toHaveBeenCalled();
});

test('failed cleanup keeps opening pending even after held acquisition drains and never retries', async () => {
  const held = deferred(),
    entered = deferred(),
    abort = new AbortController();
  mockAcquire.mockImplementationOnce(() => {
    entered.resolve();
    return held.promise;
  });
  let settled = false;
  const opening = open({ signal: abort.signal });
  Promise.allSettled([opening]).then(() => {
    settled = true;
  });
  await entered.promise;
  mockSources[0].close.mockImplementationOnce(() => {
    throw Error('private cleanup detail');
  });
  try {
    expect(() => abort.abort()).not.toThrow();
    await tick();
    expect(settled).toBe(false);
  } finally {
    held.reject(Object.assign(Error('private acquisition detail'), { reason: 'rpc' }));
  }
  await tick();
  expect(settled).toBe(false);
  expect(mockAcquire).toHaveBeenCalledTimes(1);
  expect(mockRequest).not.toHaveBeenCalled();
});

test('a held preflight has a sixty-second expiry within the original operation budget', async () => {
  jest.useFakeTimers();
  const held = deferred(),
    entered = deferred();
  mockAcquire.mockImplementationOnce(() => {
    entered.resolve();
    return held.promise;
  });
  const opening = open().catch((error) => error);
  await entered.promise;
  await jest.advanceTimersByTimeAsync(60001);
  expect(mockSources[0].signal.aborted).toBe(true);
  held.resolve();
  expect(await opening).toMatchObject({ code: 'RAILGUN_SHIELD_HANDOFF_REFUSED' });
  expect(mockAcquire).toHaveBeenCalledTimes(1);
});

test.each(['review', 'getAddress', 'signTransaction'])(
  'closed waits for the original held %s after outward cancellation, with no late send',
  async (stage) => {
    const held = deferred(),
      entered = deferred(),
      abort = new AbortController();
    await open({ signal: abort.signal });
    const callback = () => {
      entered.resolve();
      return held.promise;
    };
    if (stage !== 'review') signer[stage].mockImplementationOnce(callback);
    const outcome = submit(stage === 'review' ? callback : undefined).catch((error) => error);
    await entered.promise;
    let drained = false;
    operation.closed.then(() => {
      drained = true;
    });
    try {
      abort.abort();
      expect(await outcome).toMatchObject({ code: 'RAILGUN_SHIELD_HANDOFF_REFUSED' });
      await tick();
      expect(drained).toBe(false);
      expect(broadcastCount).toBe(0);
      if (stage !== 'signTransaction') expect(signer.signTransaction).not.toHaveBeenCalled();
    } finally {
      held.resolve(stage === 'review' ? true : stage === 'getAddress' ? wallet.address : '0x');
    }
    await operation.closed;
    expect(drained).toBe(true);
    expect(broadcastCount).toBe(0);
    const reopenedHandle = parentScope.getContext({
      kind: 'public-address',
      principal: wallet.address.toLowerCase(),
      chainId: 11155111,
      role: 'transaction-rpc',
    });
    const journal = jest.requireActual('./private-submission-journal').createSubmissionJournal({
      handle: reopenedHandle,
      directory: mockDirectory,
      key: Buffer.alloc(32, 3),
    });
    expect(await journal.list()).toEqual([]);
  }
);

test.each(
  ['review', 'getAddress', 'signTransaction'].flatMap((stage) =>
    ['PRIVATE_BROADCAST_UNCERTAIN', 'PRIVATE_SUBMISSION_UNRESOLVED'].map((code) => [stage, code])
  )
)('untrusted %s cannot forge a journal-owned %s error', async (stage, code) => {
  const callback = jest.fn(async () => {
    throw Object.assign(Error('sensitive callback error'), {
      code,
      transactionHash: 'forged',
    });
  });
  await open();
  if (stage !== 'review') signer[stage] = callback;
  await expect(submit(stage === 'review' ? callback : undefined)).rejects.toMatchObject({
    code: 'RAILGUN_SHIELD_HANDOFF_REFUSED',
    message: 'Railgun shield handoff refused',
  });
  expect(broadcastCount).toBe(0);
  await operation.closed;
});

test.each(['acknowledged', 'uncertain'])(
  'cleanup failure keeps closed pending while the actual %s send outcome survives',
  async (mode) => {
    if (mode === 'uncertain') mockMode = 'lost';
    await open();
    mockSources[0].close.mockImplementationOnce(() => {
      throw Error('sensitive cleanup failure');
    });
    const result = await submit().catch((error) => error);
    if (mode === 'acknowledged') expect(result.hash).toBe(rawHash);
    else
      expect(result).toMatchObject({
        code: 'PRIVATE_BROADCAST_UNCERTAIN',
        transactionHash: rawHash,
        submissionStatus: 'unknown',
      });
    expect(broadcastCount).toBe(1);
    expect(() => operation.close()).not.toThrow();
    let released = false;
    Promise.allSettled([operation.closed]).finally(() => {
      released = true;
    });
    // Failed cleanup cannot be attested. The synthetic source has no child or
    // socket to clean; deliberately do not await this permanently pending gate.
    operation = undefined;
    await tick();
    expect(released).toBe(false);
  }
);

test('closed also observes asynchronous source cleanup without confusing it with a socket-drain claim', async () => {
  await open();
  const held = deferred();
  mockSources[0].close.mockImplementationOnce(() => held.promise);
  let drained = false;
  operation.closed.then(() => {
    drained = true;
  });
  operation.close();
  await tick();
  expect(drained).toBe(false);
  held.resolve();
  await operation.closed;
  expect(drained).toBe(true);
});

test('a changed selection between preflight attempts refuses rather than retrying without its token', async () => {
  const destinationConstraints = destinationPair();
  mockAcquire.mockImplementationOnce(async () => {
    mockUrl = 'https://other.example';
    throw Object.assign(Error('transport'), { reason: 'rpc' });
  });
  await expect(open({ destinationConstraints })).rejects.toMatchObject({
    code: 'RAILGUN_SHIELD_HANDOFF_REFUSED',
  });
  expect(mockAcquire).toHaveBeenCalledTimes(1);
  expect(mockSources[0].signal.aborted).toBe(true);
  expect(mockRequest).not.toHaveBeenCalled();
});

test('transaction-service reuse keeps the originally constrained destination after registry changes', async () => {
  await open({ destinationConstraints: destinationPair() });
  mockUrl = 'https://other.example';
  await submit();
  expect(broadcastCount).toBe(1);
  expect(mockRequest.mock.calls.every(([, url]) => url === 'https://rpc.example')).toBe(true);
});

test('review deadline cancellation retains the held original callback through closed', async () => {
  jest.useFakeTimers();
  const held = deferred(),
    entered = deferred();
  await open();
  const outcome = submit(() => {
    entered.resolve();
    return held.promise;
  }).catch((error) => error);
  await entered.promise;
  let drained = false;
  operation.closed.then(() => {
    drained = true;
  });
  try {
    await jest.advanceTimersByTimeAsync(50001);
    expect(await outcome).toMatchObject({ code: 'RAILGUN_SHIELD_HANDOFF_REFUSED' });
    expect(drained).toBe(false);
    expect(signer.signTransaction).not.toHaveBeenCalled();
  } finally {
    held.resolve(true);
  }
  await operation.closed;
  expect(broadcastCount).toBe(0);
});

test('rejected asynchronous cleanup cannot release an allSettled handoff gate', async () => {
  await open();
  const held = deferred();
  mockSources[0].close.mockImplementationOnce(() => held.promise);
  let released = false;
  Promise.allSettled([operation.closed]).finally(() => {
    released = true;
  });
  operation.close();
  // Only synthetic cleanup fails; no actual child or transport is left running.
  operation = undefined;
  held.reject(Error('private cleanup failure'));
  await tick();
  expect(released).toBe(false);
});
