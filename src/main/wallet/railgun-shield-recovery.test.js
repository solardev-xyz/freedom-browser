const fs = require('fs'),
  os = require('os'),
  path = require('path');
let mockSession, mockEndpoint, mockDirectory, mockUrl;
const mockRequest = jest.fn(),
  mockOpenSession = jest.fn(),
  mockNetwork = jest.fn(),
  mockJournals = new WeakMap();
jest.mock('./privacy-session', () => ({ openPrivacySession: () => mockOpenSession() }));
jest.mock('./private-transaction-network', () => ({
  getPrivateTransactionNetwork: (...args) => mockNetwork(...args),
}));
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('../networks/network-registry', () => ({
  getNetwork: () => ({}),
  getEndpoints: () => [mockUrl],
  getEndpointSources: () => [{ keyed: false, coverage: { 11155111: mockUrl } }],
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
const { Wallet, Interface, Transaction } = require('ethers');
const { createPrivacyScope } = require('../networks/privacy-context');
const {
  createPrivateRpc,
  getPrivateRpcDestination,
  createPrivateRpcDestinationConstraint,
} = require('../networks/private-rpc');
const actualNetwork = jest.requireActual(
  './private-transaction-network'
).getPrivateTransactionNetwork;
const { createSubmissionJournal } = jest.requireActual('./private-submission-journal');
const { transactionIntent } = require('./private-transaction-intent');
const { openRailgunShieldRecovery } = require('./railgun-shield-recovery');
const { SHIELD_EVENT } = require('./railgun-shield-receipt');
const { SHIELD_ABI } = require('./railgun-shield-policy');
const pins = require('./railgun-shield-pins.json');
const prepared = require('../../../docs/qualification/railgun-shield-account-2026-10-03.json')
  .prepared[0];
const abi = new Interface([...SHIELD_ABI, SHIELD_EVENT]),
  wallet = new Wallet('0x' + '11'.repeat(32));
const owner = wallet.address.toLowerCase(),
  blockHash = '0x' + 'b'.repeat(64);
const subject = {
  kind: 'public-address',
  principal: owner,
  chainId: 11155111,
  role: 'transaction-rpc',
};
const session = () =>
  createPrivacyScope({
    profileId: 'railgun-recovery-fixture',
    signal: new AbortController().signal,
  });
let recovery, receipt, tx, canonical, head, hash, nonceConsumed, restrictions, gates;
beforeEach(async () => {
  jest.clearAllMocks();
  mockUrl = 'https://rpc.example';
  mockOpenSession.mockImplementation(() => mockSession);
  mockNetwork.mockImplementation(actualNetwork);
  restrictions = [];
  gates = [];
  mockSession = session();
  mockEndpoint = { signal: new AbortController().signal };
  mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-shield-recovery-'));
  const signed = Transaction.from(
    await wallet.signTransaction({
      chainId: 11155111,
      to: pins.relayAdapt,
      value: BigInt(prepared.value),
      data: prepared.data,
      nonce: 0,
      gasLimit: 500000n,
      gasPrice: 100n,
      type: 0,
    })
  );
  hash = signed.hash;
  const intent = transactionIntent('railgun-native-shield', signed);
  const journal = createSubmissionJournal({
    handle: mockSession.getContext(subject),
    directory: mockDirectory,
    key: Buffer.alloc(32, 3),
  });
  await journal.begin(hash, 0, intent);
  mockSession.close();
  mockSession = session();
  const [, calls] = abi.decodeFunctionData('multicall', prepared.data);
  const [notes] = abi.decodeFunctionData('shield', calls[1].data);
  const event = abi.encodeEventLog('Shield', [
    0,
    123,
    [[prepared.npk, [0, pins.wrappedNative, 0], prepared.noteValue]],
    [notes[0].ciphertext],
    [BigInt(prepared.value) - BigInt(prepared.noteValue)],
  ]);
  receipt = {
    transactionHash: hash,
    from: owner,
    to: pins.relayAdapt,
    status: '0x1',
    blockHash,
    blockNumber: '0x10',
    gasUsed: '0x493e0',
    logs: [
      {
        ...event,
        address: pins.proxy,
        transactionHash: hash,
        blockHash,
        blockNumber: '0x10',
        logIndex: '0x4',
        removed: false,
      },
    ],
  };
  tx = {
    hash,
    from: owner,
    to: pins.relayAdapt,
    chainId: '0xaa36a7',
    nonce: '0x0',
    value: '0x' + BigInt(prepared.value).toString(16),
    input: prepared.data,
    blockHash,
    blockNumber: '0x10',
  };
  canonical = { number: '0x10', hash: blockHash, transactions: [hash] };
  head = '0x12';
  nonceConsumed = false;
  mockRequest.mockImplementation(async (_handle, _url, options) => {
    const call = JSON.parse(options.body);
    const result = {
      eth_chainId: '0xaa36a7',
      eth_getTransactionReceipt: receipt,
      eth_getTransactionByHash: tx,
      eth_getBlockByNumber: canonical,
      eth_blockNumber: head,
      eth_getTransactionCount: nonceConsumed ? '0x1' : '0x0',
    }[call.method];
    if (result === undefined) throw Error('Unexpected recovery request');
    return {
      status: 200,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: call.id, result })),
    };
  });
  recovery = openRailgunShieldRecovery(owner);
});
afterEach(async () => {
  recovery?.close();
  // Failure cleanup releases fixture gates; assertions never depend on this.
  gates.forEach((gate) => gate.resolve());
  await recovery?.closed;
  restrictions.forEach((value) => value.close());
  mockSession.close();
});
const approve = async () => ({ allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' });
test('cold journal recovery matches the shield and explicit confirmed resolution survives a second reopen', async () => {
  const observed = await recovery.observe(hash);
  expect(observed.shield).toMatchObject({ status: 'matched', feeDeviation: false });
  expect(observed.record.observation).toMatchObject({ status: 'included', confirmations: 3 });
  const review = jest.fn(approve);
  await recovery.resolve(hash, { minimumConfirmations: 3, review });
  expect(review).toHaveBeenCalledWith(
    expect.objectContaining({ shield: expect.objectContaining({ status: 'matched' }) })
  );
  const records = await recovery.list();
  expect(records[0].resolution).toBeTruthy();
  recovery.close();
  mockSession.close();
  mockSession = session();
  recovery = openRailgunShieldRecovery(owner);
  expect((await recovery.list())[0].resolution).toEqual(records[0].resolution);
});
test.each(['missing', 'nonce-consumed', 'pending', 'shallow', 'reorg'])(
  'refuses %s evidence without allowing a new transaction',
  async (mode) => {
    if (mode === 'missing') receipt.logs = [];
    if (mode === 'nonce-consumed') {
      receipt = null;
      tx = null;
      nonceConsumed = true;
    }
    if (mode === 'pending') {
      receipt = null;
      tx.blockHash = null;
    }
    if (mode === 'shallow') head = '0x10';
    if (mode === 'reorg') canonical.hash = '0x' + 'c'.repeat(64);
    const review = jest.fn(approve);
    await expect(recovery.resolve(hash, { minimumConfirmations: 3, review })).rejects.toThrow();
    expect(review).not.toHaveBeenCalled();
    expect((await recovery.list())[0].resolution).toBeUndefined();
  }
);
test.each(['event', 'reorg', 'lock'])('changed %s during approval cannot resolve', async (mode) => {
  await expect(
    recovery.resolve(hash, {
      minimumConfirmations: 3,
      review: async () => {
        if (mode === 'event') receipt.logs = [];
        if (mode === 'reorg') canonical.hash = '0x' + 'c'.repeat(64);
        if (mode === 'lock') mockSession.close();
        return approve();
      },
    })
  ).rejects.toThrow();
  if (mode !== 'lock') expect((await recovery.list())[0].resolution).toBeUndefined();
});
test('a reverted transaction can be explicitly resolved without claiming a shield', async () => {
  receipt.status = '0x0';
  receipt.logs = [];
  const result = await recovery.resolve(hash, {
    minimumConfirmations: 3,
    review: async (request) => {
      expect(request.observation.status).toBe('reverted');
      expect(request.shield).toBeNull();
      return approve();
    },
  });
  expect(result.resolution).toBeTruthy();
});
test('an unjournaled hash and too-low confirmation policy never reach RPC', async () => {
  await expect(recovery.observe('0x' + 'f'.repeat(64))).rejects.toThrow();
  await expect(
    recovery.resolve(hash, { minimumConfirmations: 2, review: approve })
  ).rejects.toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});

test('a generic transaction context cannot resolve a shield or mint a journal resolution permit', async () => {
  const handle = mockSession.getContext(subject);
  const client = require('./private-transaction-network').getPrivateTransactionNetwork(handle);
  const review = jest.fn(approve);
  await expect(
    client.resolveSubmission(hash, { minimumConfirmations: 3, review })
  ).rejects.toMatchObject({ code: 'RAILGUN_SHIELD_RECOVERY_REFUSED' });
  expect(review).not.toHaveBeenCalled();
  const journal = mockJournals.get(handle),
    record = (await journal.list())[0];
  await expect(journal.resolve(hash, record.revision, 3, {})).rejects.toMatchObject({
    code: 'RAILGUN_SHIELD_RECOVERY_REFUSED',
  });
});
test('matching receipt cannot release a nonce ahead of the finalized height', async () => {
  const original = mockRequest.getMockImplementation();
  mockRequest.mockImplementation(async (handle, url, options) => {
    const call = JSON.parse(options.body);
    if (call.method === 'eth_getBlockByNumber' && call.params[0] === 'finalized')
      return {
        status: 200,
        body: Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id: call.id,
            result: { number: '0xf', hash: blockHash },
          })
        ),
      };
    return original(handle, url, options);
  });
  const review = jest.fn(approve);
  await expect(recovery.resolve(hash, { minimumConfirmations: 3, review })).rejects.toThrow();
  expect(review).not.toHaveBeenCalled();
});
test('actual matched note facts and fee deviation survive encrypted archival and cold reopen', async () => {
  const args = abi.decodeEventLog('Shield', receipt.logs[0].data, receipt.logs[0].topics);
  Object.assign(
    receipt.logs[0],
    abi.encodeEventLog('Shield', [
      args.treeNumber,
      args.startPosition,
      [[prepared.npk, [0, pins.wrappedNative, 0], BigInt(prepared.noteValue) - 1n]],
      [args.shieldCiphertext[0]],
      [args.fees[0] + 1n],
    ])
  );
  await recovery.resolve(hash, { minimumConfirmations: 3, review: approve });
  const record = (await recovery.list())[0],
    facts = record.resolution.railgun;
  expect(facts).toMatchObject({
    outcome: 'matched',
    finalizedBlockNumber: 16,
    finalizedBlockHash: blockHash,
    shield: {
      position: 123,
      feeDeviation: true,
      noteValue: (BigInt(prepared.noteValue) - 1n).toString(),
    },
  });
  expect(Object.isFrozen(facts.shield)).toBe(true);
  const handle = mockSession.getContext(subject);
  const journal = createSubmissionJournal({
    handle,
    directory: mockDirectory,
    key: Buffer.alloc(32, 3),
  });
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60 * 1000 + 1);
  try {
    await journal.archiveResolved(
      [{ hash, revision: record.revision }],
      [{ blockNumber: 16, blockHash }]
    );
  } finally {
    jest.restoreAllMocks();
  }
  const archived = await journal.listArchive();
  expect(archived[0].railgun).toEqual(facts);
  const { validArchive } = require('./privacy-journal-retention');
  expect(validArchive(archived, 'public')).toBe(true);
  const changed = structuredClone(archived);
  changed[0].railgun.shield.position = 65536;
  expect(validArchive(changed, 'public')).toBe(false);
  recovery.close();
  mockSession.close();
  mockSession = session();
  const reopened = createSubmissionJournal({
    handle: mockSession.getContext(subject),
    directory: mockDirectory,
    key: Buffer.alloc(32, 3),
  });
  expect((await reopened.listArchive())[0].railgun).toEqual(facts);
});

test.each([
  'changed-finalized-hash',
  'ahead-of-head',
  'regressed',
  'changed-prior-anchor',
  'consistent-advance',
])('finality consistency across review: %s', async (mode) => {
  const C = '0x' + 'c'.repeat(64),
    D = '0x' + 'd'.repeat(64);
  let reviewed = false;
  const original = mockRequest.getMockImplementation();
  mockRequest.mockImplementation(async (handle, url, options) => {
    const call = JSON.parse(options.body);
    if (call.method !== 'eth_getBlockByNumber' || call.params[0] === '0x10')
      return original(handle, url, options);
    let result;
    if (call.params[0] === 'finalized') {
      if (mode === 'ahead-of-head') result = { number: '0x100', hash: D };
      else if (reviewed && mode === 'regressed') result = canonical;
      else if (reviewed && ['consistent-advance', 'changed-prior-anchor'].includes(mode))
        result = { number: '0x12', hash: D };
      else result = { number: '0x11', hash: reviewed && mode === 'changed-finalized-hash' ? D : C };
    } else if (call.params[0] === '0x11')
      result = {
        number: '0x11',
        hash: reviewed && ['changed-finalized-hash', 'changed-prior-anchor'].includes(mode) ? D : C,
      };
    else if (call.params[0] === '0x12') result = { number: '0x12', hash: D };
    else throw Error('Unexpected block read');
    return {
      status: 200,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: call.id, result })),
    };
  });
  const pending = recovery.resolve(hash, {
    minimumConfirmations: 3,
    review: async () => {
      reviewed = true;
      return approve();
    },
  });
  if (mode === 'consistent-advance') await expect(pending).resolves.toHaveProperty('resolution');
  else {
    await expect(pending).rejects.toThrow();
    expect((await recovery.list())[0].resolution).toBeUndefined();
  }
});

test('timed-out review keeps exclusion until drained and cannot mint a late permit', async () => {
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  let settled = false;
  const pending = recovery
    .resolve(hash, {
      minimumConfirmations: 3,
      reviewTimeoutMs: 100,
      review: async () => {
        entered();
        await paused;
        return approve();
      },
    })
    .then(
      () => {
        throw Error('unexpected resolution');
      },
      (error) => {
        settled = true;
        return error;
      }
    );
  await started;
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(settled).toBe(false);
  await expect(
    recovery.resolve(hash, { minimumConfirmations: 3, review: approve })
  ).rejects.toMatchObject({ code: 'RAILGUN_SHIELD_RECOVERY_REFUSED' });
  const calls = mockRequest.mock.calls.length;
  release();
  expect(await pending).toBeInstanceOf(Error);
  expect(mockRequest.mock.calls.length).toBe(calls);
  expect((await recovery.list())[0].resolution).toBeUndefined();
  await recovery.resolve(hash, { minimumConfirmations: 3, review: approve });
  expect((await recovery.list())[0].resolution).toBeTruthy();
});

const refused = {
  code: 'RAILGUN_SHIELD_RECOVERY_REFUSED',
  message: 'Railgun shield recovery unavailable',
};
function deferred() {
  let resolve;
  const promise = new Promise((yes) => (resolve = yes));
  const gate = { promise, resolve };
  gates.push(gate);
  return gate;
}
async function turns() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function reviewedDestination() {
  const handle = mockSession.getContext(subject),
    rpc = createPrivateRpc(handle, 'transaction-rpc');
  const restriction = createPrivateRpcDestinationConstraint({
    observation: getPrivateRpcDestination(rpc, handle),
    signal: mockSession.signal,
    deadline: performance.now() + 60000,
  });
  restrictions.push(restriction);
  return restriction;
}
function reopen(options) {
  recovery.close();
  recovery = openRailgunShieldRecovery(owner, options);
  return recovery;
}
test.each([
  null,
  false,
  [],
  Object.create(null),
  { extra: true },
  { [Symbol('extra')]: true },
  { signal: null },
  { signal: false },
  { signal: {} },
  { signal: Object.create(AbortSignal.prototype) },
  new Proxy({}, {}),
  { signal: new Proxy(new AbortController().signal, {}) },
])('rejects malformed options before opening the borrowed session: %#', (options) => {
  const before = mockOpenSession.mock.calls.length;
  expect(() => openRailgunShieldRecovery(owner, options)).toThrow(expect.objectContaining(refused));
  expect(mockOpenSession).toHaveBeenCalledTimes(before);
  expect(mockRequest).not.toHaveBeenCalled();
  expect(() => mockSession.getContext(subject)).not.toThrow();
});
test.each(['signal', 'destinationConstraint'])('never invokes an options %s accessor', (key) => {
  const read = jest.fn(() => {
    throw Error('private options detail');
  });
  const before = mockOpenSession.mock.calls.length;
  expect(() =>
    openRailgunShieldRecovery(owner, Object.defineProperty({}, key, { get: read }))
  ).toThrow(expect.objectContaining(refused));
  expect(read).not.toHaveBeenCalled();
  expect(mockOpenSession).toHaveBeenCalledTimes(before);
});
test('an already-aborted caller refuses without opening a session', () => {
  const controller = new AbortController();
  controller.abort();
  const before = mockOpenSession.mock.calls.length;
  expect(() => openRailgunShieldRecovery(owner, { signal: controller.signal })).toThrow(
    expect.objectContaining(refused)
  );
  expect(mockOpenSession).toHaveBeenCalledTimes(before);
  expect(mockRequest).not.toHaveBeenCalled();
});
test.each([{}, { signal: undefined }, { destinationConstraint: undefined }])(
  'optional defaults preserve legacy local journal access: %#',
  async (options) => {
    reopen(options);
    expect((await recovery.list())[0].hash).toBe(hash);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(Object.isFrozen(recovery)).toBe(true);
  }
);
test('unused and repeated close drain logically without closing the borrowed parent', async () => {
  let closed = false;
  recovery.closed.then(() => (closed = true));
  await turns();
  expect(closed).toBe(false);
  recovery.close();
  recovery.close();
  expect(recovery.signal.aborted).toBe(true);
  await recovery.closed;
  expect(closed).toBe(true);
  expect(() => mockSession.getContext(subject)).not.toThrow();
  await expect(recovery.list()).rejects.toMatchObject(refused);
  await expect(recovery.observe(hash)).rejects.toMatchObject(refused);
  await expect(
    recovery.resolve(hash, { minimumConfirmations: 3, review: approve })
  ).rejects.toMatchObject(refused);
  expect(mockRequest).not.toHaveBeenCalled();
});
test.each(['caller', 'parent', 'restriction'])(
  '%s abort revokes an unused recovery synchronously',
  async (which) => {
    const controller = new AbortController(),
      restriction = reviewedDestination();
    reopen({ signal: controller.signal, destinationConstraint: restriction.constraint });
    if (which === 'caller') controller.abort();
    if (which === 'parent') mockSession.close();
    if (which === 'restriction') restriction.close();
    expect(recovery.signal.aborted).toBe(true);
    await recovery.closed;
    await expect(recovery.list()).rejects.toMatchObject(refused);
    expect(mockRequest).not.toHaveBeenCalled();
    if (which !== 'parent') expect(() => mockSession.getContext(subject)).not.toThrow();
  }
);
test('reviewed restriction binds the exact client; omitted network lookup inherits it', async () => {
  mockUrl = 'https://rpc.example/reviewed';
  const restriction = reviewedDestination();
  reopen({ destinationConstraint: restriction.constraint });
  const [handle, options] = mockNetwork.mock.calls.at(-1);
  expect(options).toEqual({ destinationConstraint: restriction.constraint });
  const retained = mockNetwork.mock.results.at(-1).value;
  expect(actualNetwork(handle)).toBe(retained);
  expect(mockRequest).not.toHaveBeenCalled();
  mockUrl = 'https://rpc.example/replacement';
  await recovery.observe(hash);
  expect(mockRequest.mock.calls.every(([, url]) => url === 'https://rpc.example/reviewed')).toBe(
    true
  );
  expect(
    mockRequest.mock.calls.some(
      ([, , options]) => JSON.parse(options.body).method === 'eth_chainId'
    )
  ).toBe(true);
  restriction.close();
  await recovery.closed;
  expect(() => actualNetwork(handle)).toThrow();
});
test('same-host changed path refuses construction without downgrading or closing the reviewer', async () => {
  mockUrl = 'https://rpc.example/reviewed';
  const restriction = reviewedDestination();
  mockUrl = 'https://rpc.example/changed';
  expect(() =>
    openRailgunShieldRecovery(owner, { destinationConstraint: restriction.constraint })
  ).toThrow(expect.objectContaining(refused));
  const [failedHandle] = mockNetwork.mock.calls.at(-1);
  expect(() => actualNetwork(failedHandle)).toThrow();
  expect(restriction.signal.aborted).toBe(false);
  expect(mockRequest).not.toHaveBeenCalled();
  expect(() => mockSession.getContext(subject)).not.toThrow();
  mockUrl = 'https://rpc.example/reviewed';
  reopen({ destinationConstraint: restriction.constraint });
  await recovery.observe(hash);
  expect(mockRequest.mock.calls.every(([, url]) => url === mockUrl)).toBe(true);
});
test.each([{}, null, false, { signal: new AbortController().signal }])(
  'forged restriction refuses with no RPC and closes only the derived context: %#',
  (destinationConstraint) => {
    expect(() => openRailgunShieldRecovery(owner, { destinationConstraint })).toThrow(
      expect.objectContaining(refused)
    );
    const [failedHandle] = mockNetwork.mock.calls.at(-1);
    expect(() => actualNetwork(failedHandle)).toThrow();
    expect(() => mockSession.getContext(subject)).not.toThrow();
    expect(mockRequest).not.toHaveBeenCalled();
  }
);
test('caller abort during network construction cannot return a live recovery', () => {
  const caller = new AbortController();
  mockNetwork.mockImplementation((...args) => {
    const value = actualNetwork(...args);
    caller.abort();
    return value;
  });
  expect(() => openRailgunShieldRecovery(owner, { signal: caller.signal })).toThrow(
    expect.objectContaining(refused)
  );
  expect(() => mockSession.getContext(subject)).not.toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
test.each(['close', 'caller'])(
  'held original journal work drains after %s before closed settles',
  async (mode) => {
    const entered = deferred(),
      held = deferred(),
      caller = new AbortController();
    mockNetwork.mockImplementation((...args) => {
      const network = actualNetwork(...args);
      return {
        ...network,
        listSubmissions: async () => {
          const records = await network.listSubmissions();
          entered.resolve();
          await held.promise;
          return records;
        },
      };
    });
    reopen({ signal: caller.signal });
    let settled = false,
      drained = false;
    const result = recovery.list().catch((error) => {
      settled = true;
      return error;
    });
    recovery.closed.then(() => (drained = true));
    await entered.promise;
    if (mode === 'close') recovery.close();
    else caller.abort();
    await turns();
    expect(settled).toBe(false);
    expect(drained).toBe(false);
    held.resolve();
    expect(await result).toMatchObject(refused);
    await recovery.closed;
    expect(drained).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
  }
);
test('reentrant close from admitted list cannot publish closure ahead of its original promise', async () => {
  const held = deferred();
  mockNetwork.mockImplementation((...args) => {
    const network = actualNetwork(...args);
    return {
      ...network,
      listSubmissions: () => {
        recovery.close();
        return held.promise;
      },
    };
  });
  reopen();
  let drained = false;
  recovery.closed.then(() => (drained = true));
  const result = recovery.list().catch((error) => error);
  expect(recovery.signal.aborted).toBe(true);
  await turns();
  expect(drained).toBe(false);
  held.resolve([]);
  expect(await result).toMatchObject(refused);
  await recovery.closed;
});
test.each([0, 1])(
  'closure waits both admitted journal operations when gate %s drains first',
  async (first) => {
    const held = [deferred(), deferred()],
      entered = [deferred(), deferred()];
    let calls = 0;
    mockNetwork.mockImplementation((...args) => {
      const network = actualNetwork(...args);
      return {
        ...network,
        listSubmissions: async () => {
          const index = calls++;
          const records = await network.listSubmissions();
          entered[index].resolve();
          await held[index].promise;
          return records;
        },
      };
    });
    reopen();
    let drained = false;
    recovery.closed.then(() => (drained = true));
    const results = [recovery.list().catch((error) => error)];
    await entered[0].promise;
    results.push(recovery.observe(hash).catch((error) => error));
    await entered[1].promise;
    recovery.close();
    held[first].resolve();
    expect(await results[first]).toMatchObject(refused);
    await turns();
    expect(drained).toBe(false);
    held[1 - first].resolve();
    expect(await results[1 - first]).toMatchObject(refused);
    await recovery.closed;
    expect(mockRequest).not.toHaveBeenCalled();
  }
);
test('an unknown journal callback error is sanitized without revoking the borrowed parent', async () => {
  let bad = true;
  mockNetwork.mockImplementation((...args) => {
    const network = actualNetwork(...args);
    return {
      ...network,
      listSubmissions: () => {
        if (bad) throw Error('private backend detail');
        return network.listSubmissions();
      },
    };
  });
  reopen();
  await expect(recovery.list()).rejects.toMatchObject(refused);
  expect(() => mockSession.getContext(subject)).not.toThrow();
  bad = false;
  expect((await recovery.list())[0].hash).toBe(hash);
});
test.each(['eth_chainId', 'eth_getTransactionReceipt'])(
  'close waits an ignored cancellation in admitted %s and admits no later request',
  async (method) => {
    const original = mockRequest.getMockImplementation(),
      entered = deferred(),
      held = deferred();
    mockRequest.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (JSON.parse(args[2].body).method === method) {
        entered.resolve();
        await held.promise;
      }
      return response;
    });
    let drained = false;
    recovery.closed.then(() => (drained = true));
    const result = recovery.observe(hash).catch((error) => error);
    await entered.promise;
    const calls = mockRequest.mock.calls.length;
    recovery.close();
    await turns();
    expect(drained).toBe(false);
    held.resolve();
    expect(await result).toMatchObject(refused);
    await recovery.closed;
    expect(mockRequest).toHaveBeenCalledTimes(calls);
  }
);
test('a transaction callback that closes recovery cannot admit the following receipt call', async () => {
  const request = jest.fn();
  mockNetwork.mockImplementation((...args) => {
    const network = actualNetwork(...args);
    request.mockImplementation(async (...query) => {
      const result = await network.request(...query);
      if (query[1] === 'eth_getTransactionByHash') recovery.close();
      return result;
    });
    return { ...network, request };
  });
  reopen();
  await expect(recovery.observe(hash)).rejects.toMatchObject(refused);
  await recovery.closed;
  expect(request.mock.calls.map((args) => args[1])).toEqual(['eth_getTransactionByHash']);
});
test('cancelled held review retains closure and cannot admit later reads or a resolution permit', async () => {
  const entered = deferred(),
    held = deferred(),
    caller = new AbortController();
  reopen({ signal: caller.signal });
  let drained = false,
    settled = false;
  recovery.closed.then(() => (drained = true));
  const result = recovery
    .resolve(hash, {
      minimumConfirmations: 3,
      review: async () => {
        entered.resolve();
        await held.promise;
        return approve();
      },
    })
    .catch((error) => {
      settled = true;
      return error;
    });
  await entered.promise;
  const calls = mockRequest.mock.calls.length;
  caller.abort();
  await turns();
  expect(drained).toBe(false);
  expect(settled).toBe(false);
  await expect(
    recovery.resolve(hash, { minimumConfirmations: 3, review: approve })
  ).rejects.toMatchObject(refused);
  held.resolve();
  expect(await result).toMatchObject(refused);
  await recovery.closed;
  expect(mockRequest).toHaveBeenCalledTimes(calls);
  reopen();
  expect((await recovery.list())[0].resolution).toBeUndefined();
  await expect(
    recovery.resolve(hash, { minimumConfirmations: 3, review: approve })
  ).resolves.toHaveProperty('resolution');
});
test('already-durable resolution survives close while its enclosing network callback is pending', async () => {
  const entered = deferred(),
    held = deferred();
  mockNetwork.mockImplementation((...args) => {
    const network = actualNetwork(...args);
    return {
      ...network,
      resolveSubmission: async (...args) => {
        const result = await network.resolveSubmission(...args);
        entered.resolve(result);
        await held.promise;
        return result;
      },
    };
  });
  reopen();
  let drained = false;
  recovery.closed.then(() => (drained = true));
  const result = recovery.resolve(hash, { minimumConfirmations: 3, review: approve });
  const durable = await entered.promise;
  expect(durable.resolution).toBeTruthy();
  recovery.close();
  await turns();
  expect(drained).toBe(false);
  held.resolve();
  expect(await result).toEqual(durable);
  await recovery.closed;
  mockNetwork.mockImplementation(actualNetwork);
  reopen();
  expect((await recovery.list())[0].resolution).toEqual(durable.resolution);
});
