const fs = require('fs'),
  os = require('os'),
  path = require('path');
let mockSession, mockEndpoint, mockDirectory;
const mockRequest = jest.fn(),
  mockJournals = new WeakMap();
jest.mock('./privacy-session', () => ({ openPrivacySession: () => mockSession }));
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
const { Wallet, Interface, Transaction } = require('ethers');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createSubmissionJournal } = jest.requireActual('./private-submission-journal');
const { transactionIntent } = require('./private-transaction-intent');
const { openRailgunTransactRecovery } = require('./railgun-transact-recovery');
const { PRIVATE_EVENTS } = require('./railgun-transact-receipt');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const pins = require('./railgun-shield-pins.json');
const fixture = require('../../../scripts/fixtures/railgun-transact-data').fixture();
const prepared = fixture.transaction();
const abi = new Interface([TRANSACT_ABI, ...PRIVATE_EVENTS]),
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
let recovery, receipt, tx, canonical, head, hash, nonceConsumed, signedBytes;
beforeEach(async () => {
  jest.clearAllMocks();
  mockSession = session();
  mockEndpoint = { signal: new AbortController().signal };
  mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-transact-recovery-'));
  const signed = Transaction.from(
    await wallet.signTransaction({
      chainId: 11155111,
      to: pins.proxy,
      value: BigInt(prepared.value),
      data: prepared.data,
      nonce: 0,
      gasLimit: 500000n,
      gasPrice: 100n,
      type: 0,
    })
  );
  hash = signed.hash;
  signedBytes = signed.serialized;
  const intent = transactionIntent('railgun-transact', signed);
  const journal = createSubmissionJournal({
    handle: mockSession.getContext(subject),
    directory: mockDirectory,
    key: Buffer.alloc(32, 3),
  });
  await journal.begin(hash, 0, intent);
  mockSession.close();
  mockSession = session();
  const events = [
    abi.encodeEventLog('Nullified', [0, fixture.inner.nullifiers]),
    abi.encodeEventLog('Transact', [
      0,
      123,
      fixture.inner.commitments,
      fixture.inner.boundParams.commitmentCiphertext,
    ]),
  ];
  receipt = {
    transactionHash: hash,
    from: owner,
    to: pins.proxy,
    status: '0x1',
    blockHash,
    blockNumber: '0x10',
    gasUsed: '0x493e0',
    transactionIndex: '0x1',
    logs: events.map((event, index) => ({
      ...event,
      address: pins.proxy,
      transactionHash: hash,
      blockHash,
      blockNumber: '0x10',
      transactionIndex: '0x1',
      logIndex: index === 0 ? '0x4' : '0x5',
      removed: false,
    })),
  };
  tx = {
    hash,
    from: owner,
    to: pins.proxy,
    chainId: '0xaa36a7',
    nonce: '0x0',
    value: '0x' + BigInt(prepared.value).toString(16),
    input: prepared.data,
    transactionIndex: '0x1',
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
  recovery = openRailgunTransactRecovery(owner);
});
afterEach(() => {
  recovery?.close();
  mockSession.close();
});
const approve = async () => ({ allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' });
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
  ).rejects.toMatchObject({ code: 'RAILGUN_TRANSACT_RECOVERY_REFUSED' });
  const calls = mockRequest.mock.calls.length;
  release();
  expect(await pending).toBeInstanceOf(Error);
  expect(mockRequest.mock.calls.length).toBe(calls);
  expect((await recovery.list())[0].resolution).toBeUndefined();
  await recovery.resolve(hash, { minimumConfirmations: 3, review: approve });
  expect((await recovery.list())[0].resolution).toBeTruthy();
});
test('cold journal recovery matches the transact and explicit confirmed resolution survives a second reopen', async () => {
  const observed = await recovery.observe(hash);
  expect(observed.transact).toMatchObject({
    status: 'matched',
    output: { kind: 'shielded', position: 123 },
  });
  expect(observed.record.observation).toMatchObject({ status: 'included', confirmations: 3 });
  const review = jest.fn(approve);
  await recovery.resolve(hash, { minimumConfirmations: 3, review });
  expect(review).toHaveBeenCalledWith(
    expect.objectContaining({ transact: expect.objectContaining({ status: 'matched' }) })
  );
  const records = await recovery.list();
  expect(records[0].resolution).toBeTruthy();
  recovery.close();
  mockSession.close();
  mockSession = session();
  recovery = openRailgunTransactRecovery(owner);
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
test('a reverted transaction can be explicitly resolved without claiming a transact', async () => {
  receipt.status = '0x0';
  receipt.logs = [];
  const result = await recovery.resolve(hash, {
    minimumConfirmations: 3,
    review: async (request) => {
      expect(request.observation.status).toBe('reverted');
      expect(request.transact).toBeNull();
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

test('a generic transaction context cannot resolve a transact or mint a journal resolution permit', async () => {
  const handle = mockSession.getContext(subject);
  const client = require('./private-transaction-network').getPrivateTransactionNetwork(handle);
  const review = jest.fn(approve);
  await expect(
    client.resolveSubmission(hash, { minimumConfirmations: 3, review })
  ).rejects.toMatchObject({ code: 'RAILGUN_TRANSACT_RECOVERY_REFUSED' });
  expect(review).not.toHaveBeenCalled();
  const journal = mockJournals.get(handle),
    record = (await journal.list())[0];
  await expect(journal.resolve(hash, record.revision, 3, {})).rejects.toMatchObject({
    code: 'RAILGUN_TRANSACT_RECOVERY_REFUSED',
  });
});
test('generic contexts cannot sign or broadcast a classified private transaction', async () => {
  const handle = mockSession.getContext(subject);
  const network = require('./private-transaction-network').getPrivateTransactionNetwork(handle);
  const intent = transactionIntent('railgun-transact', Transaction.from(signedBytes));
  await expect(
    network.broadcastRawTransaction(11155111, signedBytes, { intent })
  ).rejects.toMatchObject({ code: 'RAILGUN_PRIVATE_SUBMISSION_REFUSED' });
  const signer = { getAddress: async () => owner, signTransaction: jest.fn() };
  await expect(
    require('./transaction-service').signAndSendTransaction(
      {
        ...prepared,
        value: '0',
        gasLimit: '500000',
      },
      signer,
      { privacyContext: handle, intent, review: async () => true }
    )
  ).rejects.toMatchObject({ code: 'RAILGUN_PRIVATE_SUBMISSION_REFUSED' });
  expect(signer.signTransaction).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
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
test('actual matched output facts survive encrypted archival and cold reopen', async () => {
  await recovery.resolve(hash, { minimumConfirmations: 3, review: approve });
  const record = (await recovery.list())[0],
    facts = record.resolution.railgun;
  expect(facts).toMatchObject({
    outcome: 'matched',
    finalizedBlockNumber: 16,
    finalizedBlockHash: blockHash,
    transact: {
      output: { kind: 'shielded', position: 123 },
    },
  });
  expect(Object.isFrozen(facts.transact)).toBe(true);
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
  changed[0].railgun.transact.output.position = 65536;
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
