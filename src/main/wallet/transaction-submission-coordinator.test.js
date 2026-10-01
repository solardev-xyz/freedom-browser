const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet, Transaction } = require('ethers');
let mockProfile, mockLifetime;
const mnemonic = 'test test test test test test test test test test test junk';
const mockOrdinaryNetwork = {
  request: jest.fn(),
  getFeeQuote: jest.fn(),
  broadcastRawTransaction: jest.fn(),
};
jest.mock('../networks/chain-data-router', () => mockOrdinaryNetwork);
jest.mock('../profile-resolver', () => ({ getActiveProfile: () => mockProfile }));
jest.mock('../identity/vault', () => ({
  getSessionSignal: () => mockLifetime.signal,
  getMnemonic: () =>
    mockLifetime.signal.aborted
      ? null
      : 'test test test test test test test test test test test junk',
}));
const { openPrivacySession, resetPrivacySession } = require('./privacy-session');
const { getPrivateSubmissionJournal } = require('./private-submission-journal');
const {
  enrollment,
  acquireSubmissionLease,
  consumeSubmissionPermit,
} = require('./transaction-submission-coordinator');
const wallet = Wallet.fromPhrase(mnemonic);
const other = new Wallet(`0x${'2'.repeat(64)}`);
const params = { chainId: 11155111, from: wallet.address };
let leases;
beforeEach(() => {
  mockProfile = {
    id: 'test',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'submission-coordinator-')),
  };
  mockLifetime = new AbortController();
  leases = [];
  mockOrdinaryNetwork.request.mockReset().mockImplementation(async (_chain, method) => ({
    result:
      method === 'eth_getCode'
        ? '0x'
        : method === 'eth_getBalance'
          ? '0x100000'
          : method === 'eth_getTransactionByHash'
            ? null
            : '0x0',
    source: 'fixture',
  }));
  mockOrdinaryNetwork.broadcastRawTransaction
    .mockReset()
    .mockImplementation(async (chain, signed, options) => {
      consumeSubmissionPermit(chain, signed, options?.submissionPermit);
      return { result: Transaction.from(signed).hash, source: 'fixture' };
    });
});
afterEach(() => {
  leases.forEach((lease) => lease.release());
  mockLifetime.abort();
  resetPrivacySession();
});
const lease = (extra = {}) => {
  const value = acquireSubmissionLease({
    ...params,
    readCode: async (address, signal) =>
      (await mockOrdinaryNetwork.request(11155111, 'eth_getCode', [address, 'pending'], { signal }))
        .result,
    ...extra,
  });
  leases.push(value);
  return value;
};
const journal = () =>
  getPrivateSubmissionJournal(
    openPrivacySession().getContext({
      kind: 'public-address',
      principal: wallet.address,
      chainId: 11155111,
      role: 'transaction-rpc',
    })
  );
const raw = (nonce) =>
  wallet.signTransaction({
    chainId: 11155111,
    to: other.address,
    value: 1n,
    gasLimit: 21000n,
    gasPrice: 10n,
    nonce,
  });
async function enrolled({ resolved = false } = {}) {
  const state = journal(),
    hash = Transaction.from(await raw(5)).hash;
  await state.begin(hash, 5);
  if (resolved) {
    await state.observe(
      hash,
      {
        status: 'included',
        trust: 'unverified',
        observedAt: 1,
        confirmations: 2,
        blockHash: `0x${'a'.repeat(64)}`,
        blockNumber: 100,
      },
      0
    );
    await state.resolve(hash, 1, 2);
  }
  return state;
}

test('ordinary profiles, other chains and unenrolled accounts keep their existing behavior', async () => {
  mockLifetime.abort();
  const send = lease({ remote: true });
  await send.prepare();
  expect(send.journaled).toBe(false);
  expect(fs.readdirSync(mockProfile.userDataDir)).toEqual([]);
  send.release();
  mockLifetime = new AbortController();
  await enrolled();
  const mainnet = lease({ chainId: 1, remote: true });
  await mainnet.prepare();
  expect(mainnet.journaled).toBe(false);
  const independent = lease({ from: other.address, remote: true });
  await independent.prepare();
  expect(independent.journaled).toBe(false);
});

test('existing privacy profiles require authentication before a negative enrollment decision', async () => {
  await enrolled();
  mockLifetime.abort();
  expect(() => enrollment(11155111, other.address)).toThrow(
    expect.objectContaining({ code: 'PRIVATE_JOURNAL_UNAVAILABLE' })
  );
  mockLifetime = new AbortController();
  resetPrivacySession();
  const marker = path.join(mockProfile.userDataDir, 'wallet-privacy-inventory.json');
  const record = JSON.parse(fs.readFileSync(marker));
  record.state.files = [];
  fs.writeFileSync(marker, JSON.stringify(record));
  expect(() => enrollment(11155111, other.address)).toThrow(
    expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_INVALID' })
  );
});

test('unresolved, locked and remote enrolled sends fail before signing', async () => {
  await enrolled();
  const send = lease();
  await expect(send.prepare()).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNRESOLVED' });
  send.release();
  const remote = lease({ remote: true });
  await expect(remote.prepare()).rejects.toMatchObject({
    code: 'PRIVATE_REMOTE_BROADCAST_UNSUPPORTED',
  });
  remote.release();
  mockLifetime.abort();
  const locked = lease();
  await expect(locked.prepare()).rejects.toMatchObject({ code: 'PRIVATE_JOURNAL_UNAVAILABLE' });
});

test('ordinary handoff persists before a one-use permit and gates both routes after restart', async () => {
  await enrolled({ resolved: true });
  const send = lease();
  await send.prepare();
  expect(await send.selectNonce(0)).toBe(6);
  const signed = await raw(6);
  expect(() => consumeSubmissionPermit(11155111, signed)).toThrow(
    expect.objectContaining({ code: 'PRIVATE_BROADCAST_PERMIT_REQUIRED' })
  );
  const permit = await send.begin(signed);
  expect((await journal().list()).at(-1)).toMatchObject({
    hash: Transaction.from(signed).hash,
    state: 'attempted',
    route: 'ordinary',
  });
  expect(consumeSubmissionPermit(11155111, signed, permit)).toBe(true);
  expect(() => consumeSubmissionPermit(11155111, signed, permit)).toThrow(
    expect.objectContaining({ code: 'PRIVATE_BROADCAST_PERMIT_REQUIRED' })
  );
  send.release();
  resetPrivacySession();
  const resumed = lease();
  await expect(resumed.prepare()).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNRESOLVED' });
  await expect(journal().assertCanSubmit()).rejects.toMatchObject({
    code: 'PRIVATE_SUBMISSION_UNRESOLVED',
  });
});

test('ordinary and private preparation share a fail-fast account lease without queuing', async () => {
  const handle = openPrivacySession().getContext({
    kind: 'public-address',
    principal: wallet.address,
    chainId: 11155111,
    role: 'transaction-rpc',
  });
  const ordinary = lease();
  expect(() => lease({ privacyContext: handle })).toThrow(
    expect.objectContaining({ code: 'PRIVATE_SEND_IN_PROGRESS' })
  );
  ordinary.release();
  const privateSend = lease({ privacyContext: handle });
  expect(() => lease()).toThrow(expect.objectContaining({ code: 'PRIVATE_SEND_IN_PROGRESS' }));
  privateSend.release();
  const independent = lease({ from: other.address });
  await independent.prepare();
});

test('profile change or lock invalidates a prepared handoff permit', async () => {
  await enrolled({ resolved: true });
  const send = lease();
  await send.prepare();
  const signed = await raw(6),
    permit = await send.begin(signed);
  mockLifetime.abort();
  expect(() => consumeSubmissionPermit(11155111, signed, permit)).toThrow();
  send.release();
});

test('ordinary service uses the durable nonce floor and records successful handoff without auto-resolution', async () => {
  await enrolled({ resolved: true });
  const signer = {
    getAddress: async () => wallet.address,
    signTransaction: jest.fn((tx) => wallet.signTransaction(tx)),
  };
  const service = require('./transaction-service');
  const intent = {
    chainId: 11155111,
    to: other.address,
    value: '1',
    gasLimit: '21000',
    gasPrice: '10',
  };
  const result = await service.signAndSendTransaction(intent, signer);
  expect(result.nonce).toBe(6);
  expect((await journal().list()).at(-1)).toMatchObject({
    hash: result.hash,
    nonce: 6,
    state: 'submitted',
  });
  expect((await journal().list()).at(-1).resolution).toBeUndefined();
  await expect(service.signAndSendTransaction(intent, signer)).rejects.toMatchObject({
    code: 'PRIVATE_SUBMISSION_UNRESOLVED',
  });
  expect(signer.signTransaction).toHaveBeenCalledTimes(1);
  expect(mockOrdinaryNetwork.broadcastRawTransaction).toHaveBeenCalledTimes(1);
});

test.each(['lost-response', 'wrong-hash', 'lock-at-handoff'])(
  'ordinary %s retains durable uncertainty across restart',
  async (failure) => {
    await enrolled({ resolved: true });
    mockOrdinaryNetwork.broadcastRawTransaction.mockImplementation(
      async (chain, signed, options) => {
        consumeSubmissionPermit(chain, signed, options.submissionPermit);
        if (failure === 'lock-at-handoff') mockLifetime.abort();
        if (failure === 'wrong-hash') return { result: `0x${'f'.repeat(64)}`, source: 'fixture' };
        throw new Error('nonce too low: provider response lost');
      }
    );
    const service = require('./transaction-service');
    await expect(
      service.signAndSendTransaction(
        { chainId: 11155111, to: other.address, value: '1', gasLimit: '21000', gasPrice: '10' },
        {
          getAddress: async () => wallet.address,
          signTransaction: (tx) => wallet.signTransaction(tx),
        }
      )
    ).rejects.toMatchObject({ code: 'PRIVATE_BROADCAST_UNCERTAIN', submissionStatus: 'unknown' });
    mockLifetime = new AbortController();
    resetPrivacySession();
    expect((await journal().list()).at(-1)).toMatchObject({ nonce: 6, state: 'attempted' });
    await expect(journal().assertCanSubmit()).rejects.toMatchObject({
      code: 'PRIVATE_SUBMISSION_UNRESOLVED',
    });
  }
);

test('insufficient maximum-fee balance refuses before signing or writing an attempt', async () => {
  await enrolled({ resolved: true });
  mockOrdinaryNetwork.request.mockResolvedValue({ result: '0x0', source: 'fixture' });
  const signer = { getAddress: async () => wallet.address, signTransaction: jest.fn() };
  await expect(
    require('./transaction-service').signAndSendTransaction(
      { chainId: 11155111, to: other.address, value: '1', gasLimit: '21000', gasPrice: '10' },
      signer
    )
  ).rejects.toThrow('Insufficient funds');
  expect(signer.signTransaction).not.toHaveBeenCalled();
  expect(await journal().list()).toHaveLength(1);
  expect(mockOrdinaryNetwork.broadcastRawTransaction).not.toHaveBeenCalled();
});

test('private initialization enrolls an empty journal; missing listed files remain blocked', async () => {
  const state = journal();
  expect(enrollment(11155111, wallet.address)).toBeNull();
  await state.initialize();
  expect(enrollment(11155111, wallet.address)).not.toBeNull();
  const directory = path.join(mockProfile.userDataDir, 'wallet-private-submissions');
  const name = fs.readdirSync(directory)[0];
  fs.renameSync(
    path.join(directory, name),
    path.join(mockProfile.userDataDir, 'retained-missing-store-fixture')
  );
  expect(() => enrollment(11155111, wallet.address)).toThrow(
    expect.objectContaining({ code: 'PRIVATE_PROFILE_STORE_MISSING' })
  );
});

test('first enrollment cannot race an ordinary phone-wallet send', async () => {
  let complete;
  const phone = {
    getAddress: async () => wallet.address,
    sendTransaction: jest.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    ),
  };
  const service = require('./transaction-service');
  const intent = { chainId: 11155111, to: other.address, value: '1' };
  const pending = service.signAndSendTransaction(intent, phone);
  await new Promise((resolve) => setImmediate(resolve));
  const state = journal();
  await expect(state.initialize()).rejects.toMatchObject({ code: 'PRIVATE_SEND_IN_PROGRESS' });
  expect(enrollment(11155111, wallet.address)).toBeNull();
  complete(`0x${'a'.repeat(64)}`);
  await pending;
  await state.initialize();
  await expect(service.signAndSendTransaction(intent, phone)).rejects.toMatchObject({
    code: 'PRIVATE_REMOTE_BROADCAST_UNSUPPORTED',
  });
  expect(phone.sendTransaction).toHaveBeenCalledTimes(1);
});

test('other chains retain concurrent same-account sends and their existing profile lifetime behavior', async () => {
  const first = lease({ chainId: 1 });
  const second = lease({ chainId: 1 });
  mockProfile = { id: 'other', userDataDir: '/synthetic/other-profile' };
  expect(() => first.assertActive()).not.toThrow();
  expect(() => second.assertActive()).not.toThrow();
  await first.prepare();
  await second.prepare();
  expect(first.journaled).toBe(false);
});

test('matching broadcast acknowledgment remains visible when vault lock prevents its journal annotation', async () => {
  await enrolled({ resolved: true });
  mockOrdinaryNetwork.broadcastRawTransaction.mockImplementation(async (chain, signed, options) => {
    consumeSubmissionPermit(chain, signed, options.submissionPermit);
    mockLifetime.abort();
    return { result: Transaction.from(signed).hash, source: 'fixture' };
  });
  const result = await require('./transaction-service').signAndSendTransaction(
    { chainId: 11155111, to: other.address, value: '1', gasLimit: '21000', gasPrice: '10' },
    { getAddress: async () => wallet.address, signTransaction: (tx) => wallet.signTransaction(tx) }
  );
  expect(result).toMatchObject({
    nonce: 6,
    submissionState: 'attempted',
    requiresReconciliation: true,
  });
  mockLifetime = new AbortController();
  resetPrivacySession();
  expect((await journal().list()).at(-1)).toMatchObject({ hash: result.hash, state: 'attempted' });
  await expect(journal().assertCanSubmit()).rejects.toMatchObject({
    code: 'PRIVATE_SUBMISSION_UNRESOLVED',
  });
});

test('a moved profile is refused instead of silently appearing unenrolled', async () => {
  await enrolled();
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'moved-submission-profile-'));
  fs.cpSync(mockProfile.userDataDir, destination, { recursive: true });
  mockProfile = { ...mockProfile, userDataDir: destination };
  expect(() => enrollment(11155111, wallet.address)).toThrow(
    expect.objectContaining({ code: 'PRIVATE_PROFILE_MOVED' })
  );
});

test.each(['protocol-target', 'delegated-sender', 'type4', 'authorization-list'])(
  'enrolled ordinary %s is refused before signing or journaling',
  async (reason) => {
    await journal().initialize();
    const tx = {
      chainId: 11155111,
      to: other.address,
      value: '1',
      gasLimit: '21000',
      gasPrice: '10',
    };
    if (reason === 'protocol-target')
      tx.to = require('./ppv2-sepolia-pins.json').contracts.pool.address;
    if (reason === 'type4') tx.type = 4;
    if (reason === 'authorization-list') tx.authorizationList = [];
    if (reason === 'delegated-sender') {
      const original = mockOrdinaryNetwork.request.getMockImplementation();
      mockOrdinaryNetwork.request.mockImplementation((chain, method, ...rest) =>
        method === 'eth_getCode'
          ? Promise.resolve({ result: '0xef0100' + '11'.repeat(20) })
          : original(chain, method, ...rest)
      );
    }
    const signer = { getAddress: async () => wallet.address, signTransaction: jest.fn() };
    await expect(
      require('./transaction-service').signAndSendTransaction(tx, signer)
    ).rejects.toMatchObject({ code: 'PRIVATE_ORDINARY_TRANSACTION_REFUSED' });
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(await journal().list()).toEqual([]);
    expect(mockOrdinaryNetwork.broadcastRawTransaction).not.toHaveBeenCalled();
  }
);

test.each(['protocol-target', 'type4', 'delegated-sender', 'malformed-code', 'code-read-failed'])(
  'signed %s cannot bypass the final ordinary classification',
  async (reason) => {
    await journal().initialize();
    const send = lease();
    await send.prepare();
    const tx = {
      chainId: 11155111,
      to: other.address,
      value: 1n,
      gasLimit: 21000n,
      gasPrice: 10n,
      nonce: 0,
    };
    if (reason === 'protocol-target')
      tx.to = require('./ppv2-sepolia-pins.json').contracts.pool.address;
    if (reason === 'type4') {
      delete tx.gasPrice;
      Object.assign(tx, {
        type: 4,
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: 1n,
        authorizationList: [],
      });
    }
    if (reason === 'delegated-sender')
      mockOrdinaryNetwork.request.mockResolvedValue({ result: '0xef0100' + '11'.repeat(20) });
    if (reason === 'malformed-code')
      mockOrdinaryNetwork.request.mockResolvedValue({ result: '0x0' });
    if (reason === 'code-read-failed')
      mockOrdinaryNetwork.request.mockRejectedValue(new Error('RPC offline'));
    await expect(send.begin(await wallet.signTransaction(tx))).rejects.toThrow();
    expect(await journal().list()).toEqual([]);
  }
);

test('ordinary sends preserve PPv2 note operations with signed facts across restart', async () => {
  await journal().initialize();
  const send = lease();
  await send.prepare();
  await send.begin(await raw(0));
  resetPrivacySession();
  const state = journal();
  expect((await state.list())[0]).toMatchObject({
    route: 'ordinary',
    ordinary: {
      to: other.address.toLowerCase(),
      selector: null,
      senderCode: '0x',
      trust: 'unverified-rpc',
    },
  });
  const reservations = require('./ppv2-exit-reservations').createPPv2ExitReservations({
    journal: state,
    pool: require('./ppv2-sepolia-pins.json').contracts.pool.address,
  });
  const note = {
    commitment: `0x${'0'.repeat(63)}1`,
    value: 100n,
    asset: { __type: 'native' },
    status: 'active',
    labelState: 'approved',
  };
  await expect(reservations.assertAvailable(note.commitment)).resolves.toBeUndefined();
  await expect(reservations.assertSelectable([note], note.asset)).resolves.toBeUndefined();
  expect(await reservations.notes([note])).toEqual([note]);
  expect(await reservations.balance([note])).toEqual(
    expect.arrayContaining([expect.objectContaining({ tag: 'spendable', amount: 100n })])
  );
  await expect(state.assertCanSubmit()).rejects.toMatchObject({
    code: 'PRIVATE_SUBMISSION_UNRESOLVED',
  });
});

test.each(['0x0', '', 'garbage', '0xef0100' + '11'.repeat(20)])(
  'code appearing during signing (%s) is refused before any journal attempt',
  async (code) => {
    await journal().initialize();
    let signed = false;
    const original = mockOrdinaryNetwork.request.getMockImplementation();
    mockOrdinaryNetwork.request.mockImplementation((chain, method, ...rest) =>
      method === 'eth_getCode' && signed
        ? Promise.resolve({ result: code })
        : original(chain, method, ...rest)
    );
    const signer = {
      getAddress: async () => wallet.address,
      signTransaction: jest.fn(async (tx) => {
        signed = true;
        return wallet.signTransaction(tx);
      }),
    };
    await expect(
      require('./transaction-service').signAndSendTransaction(
        { chainId: 11155111, to: other.address, value: '1', gasLimit: '21000', gasPrice: '10' },
        signer
      )
    ).rejects.toMatchObject({ code: 'PRIVATE_ORDINARY_TRANSACTION_REFUSED' });
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);
    expect(await journal().list()).toEqual([]);
    expect(mockOrdinaryNetwork.broadcastRawTransaction).not.toHaveBeenCalled();
  }
);
