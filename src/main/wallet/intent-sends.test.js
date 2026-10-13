// The send path over the intent records (freedom-core design 0005,
// "Retrying an intent"): one nonce per intent, committed before its bytes go
// anywhere. Real intent store, reservations, tx-recorder, payment history
// (its sqlite fake) and Safe executor; mocked chain data and signers. Each
// start() is a fresh run of main over the same userData.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet, keccak256 } = require('ethers');
const { readJournal } = require('../lib/durable-journal');

const mockChainRequest = jest.fn();
const mockGetFeeQuote = jest.fn();
const mockBroadcast = jest.fn();
jest.mock('../networks/chain-data', () => ({
  request: (...args) => mockChainRequest(...args),
  getFeeQuote: (...args) => mockGetFeeQuote(...args),
  broadcastRawTransaction: (...args) => mockBroadcast(...args),
}));
jest.mock('./chains', () => ({
  getTxExplorerUrl: (chainId, hash) => `https://explorer.test/${chainId}/${hash}`,
}));
let mockUserData;
jest.mock('electron', () => ({
  app: { getPath: () => mockUserData },
  ipcMain: { handle: () => {} },
  webContents: { getAllWebContents: () => [] },
}));
jest.mock('better-sqlite3', () => require('../../../test/helpers/fake-better-sqlite3-payments'));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Every signature a Safe executor makes, by wallet index and nonce.
const mockSignatures = [];
jest.mock('./signers', () => ({
  getSigner: (index) => {
    const signer = require('./safe/__tests__/helpers/test-owners').createTestSigner(index);
    return {
      ...signer,
      signTransaction: (tx) => {
        mockSignatures.push({ index, nonce: tx.nonce });
        return signer.signTransaction(tx);
      },
    };
  },
}));
jest.mock('../identity-manager', () => ({
  getWalletRecord: () => null,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
jest.mock('./provider-manager', () => ({
  getEip1193Provider: () => {
    throw new Error('unit tests must inject a provider');
  },
}));

jest.setTimeout(20000);

// Deterministic test key (not a real wallet); wallet index 0 of test-owners.
const ALICE = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const RECIPIENT = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const CHAIN = 100;
const PARAMS = {
  to: RECIPIENT,
  value: '1000',
  gasLimit: '21000',
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
  chainId: CHAIN,
};

let pending;
let signer;

const sent = async (_chainId, raw) => ({ result: keccak256(raw), source: 'direct' });
const tagged = (message, outcome) => Object.assign(new Error(message), { outcome });
const pendingReads = () =>
  mockChainRequest.mock.calls.filter(([, method]) => method === 'eth_getTransactionCount');
const broadcastRaws = () => mockBroadcast.mock.calls.map(([, raw]) => raw);
const intentFile = () => path.join(mockUserData, 'wallet-intents.jsonl');

beforeEach(() => {
  mockSignatures.length = 0;
  mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-sends-'));
  pending = 7;
  mockChainRequest.mockReset().mockImplementation(async (_chainId, method) => {
    if (method === 'eth_getTransactionCount') {
      return { result: `0x${pending.toString(16)}`, source: 'direct' };
    }
    if (method === 'eth_estimateGas') return { result: '0x5208', source: 'direct' };
    // tx-recorder's receipt poll: confirmed at once, so it ends with the test.
    if (method === 'eth_getTransactionReceipt') {
      return { result: { status: '0x1', blockNumber: '0x1', gasUsed: '0x5208' }, source: 'direct' };
    }
    throw new Error(`unexpected read ${method}`);
  });
  mockGetFeeQuote.mockReset().mockResolvedValue({
    type: 'eip1559',
    maxFeePerGas: '2000000000',
    maxPriorityFeePerGas: '1000000000',
    source: 'direct',
  });
  mockBroadcast.mockReset().mockImplementation(sent);
  signer = {
    getAddress: async () => ALICE.address,
    signTransaction: jest.fn((tx) => ALICE.signTransaction(tx)),
  };
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

// A fresh run of main: new modules, so a new run id, over the same userData.
function start() {
  jest.resetModules();
  return {
    tx: require('./transaction-service'),
    store: require('./intent-store').getIntentStore(),
    reservations: require('./nonce-reservations'),
  };
}

async function until(condition) {
  for (let i = 0; i < 1000; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition never met');
}

describe('a new intent', () => {
  test('is committed, and handed off, before the broadcaster sees its bytes', async () => {
    const { tx, store } = start();
    const events = [];
    const commit = store.commit;
    jest.spyOn(store, 'commit').mockImplementation(async (...args) => {
      const committed = await commit(...args);
      events.push('commit resolved');
      return committed;
    });
    let onDisk;
    mockBroadcast.mockImplementation(async (chainId, raw) => {
      events.push('broadcast');
      onDisk = (await readJournal(intentFile())).records;
      return sent(chainId, raw);
    });

    const result = await tx.signAndSendTransaction(PARAMS, signer);

    expect(events).toEqual(['commit resolved', 'broadcast']);
    // The store names the intent; its id is on disk before the bytes go out.
    expect(store.commit).toHaveBeenCalledWith(
      expect.not.objectContaining({ intentId: expect.anything() })
    );
    const [raw] = broadcastRaws();
    expect(onDisk.map((record) => record.type)).toEqual(['commit', 'handoff']);
    expect(onDisk[0]).toMatchObject({ raw, nonce: 7, hash: keccak256(raw) });
    expect(result).toMatchObject({
      hash: keccak256(raw),
      nonce: 7,
      from: ALICE.address,
      outcome: 'sent',
      intentId: onDisk[0].intent_id,
      broadcastSource: 'direct',
    });
    expect(store.get(result.intentId).handoffs).toEqual([
      expect.objectContaining({ outcome: expect.objectContaining({ outcome: 'sent' }) }),
    ]);
  });

  test('a failed commit sends nothing, and releases the nonce', async () => {
    const { tx, store } = start();
    await store.ready;
    const fsp = require('fs/promises');
    jest
      .spyOn(fsp, 'open')
      .mockRejectedValueOnce(
        Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      );

    await expect(tx.signAndSendTransaction(PARAMS, signer)).rejects.toMatchObject({
      code: 'INTENT_WRITE_FAILED',
    });
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);

    // The reservation is free again, at the same nonce.
    await expect(tx.signAndSendTransaction(PARAMS, signer)).resolves.toMatchObject({ nonce: 7 });
  });

  test('a crash after the commit: on restart the intent is held, and sent again as signed', async () => {
    let main = start();
    await main.store.ready;
    // Main dies between the commit and the handoff.
    jest.spyOn(main.store, 'handoff').mockImplementationOnce(() => new Promise(() => {}));
    main.tx.signAndSendTransaction(PARAMS, signer);
    await until(() => main.store.held().length === 1);
    const [committed] = main.store.held();
    expect(mockBroadcast).not.toHaveBeenCalled();

    main = start();
    await main.store.ready;
    expect(main.store.get(committed.intentId)).toMatchObject({
      state: 'held',
      recovered: true,
      nonce: 7,
      hash: committed.hash,
      raw: committed.raw,
      handoffs: [],
    });
    mockChainRequest.mockClear();
    signer.signTransaction.mockClear();

    const result = await main.tx.resendIntent(committed.intentId);

    expect(broadcastRaws()).toEqual([committed.raw]);
    expect(pendingReads()).toEqual([]);
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      intentId: committed.intentId,
      hash: committed.hash,
      nonce: 7,
      outcome: 'sent',
      resent: true,
    });
  });

  const OUTCOMES = [
    ['sent', sent, { returns: 'sent' }],
    [
      'uncertain',
      async (_chainId, raw) => ({ result: keccak256(raw), source: 'myotis', outcome: 'uncertain' }),
      { returns: 'uncertain' },
    ],
    [
      'uncertain, with no hash',
      async () => ({ result: null, source: 'myotis', outcome: 'uncertain' }),
      { returns: 'uncertain' },
    ],
    [
      'rejected',
      async () => {
        throw tagged('insufficient funds for gas * price + value', 'rejected');
      },
      { throws: 'rejected', message: 'Insufficient funds for transaction' },
    ],
    [
      'not_sent',
      async () => {
        throw tagged('Myotis is not ready', 'not_sent');
      },
      { throws: 'not_sent' },
    ],
    [
      "main's record: uncertain (the core died after an attempt started)",
      async (_chainId, raw) => ({
        result: keccak256(raw),
        source: undefined,
        outcome: 'uncertain',
      }),
      { returns: 'uncertain' },
    ],
    [
      "main's record: not_sent (the core never got it)",
      async () => {
        throw tagged('freedom-cored is not running', 'not_sent');
      },
      { throws: 'not_sent' },
    ],
    [
      'a throw with no outcome',
      async () => {
        throw new Error('socket hang up');
      },
      { returns: 'uncertain' },
    ],
  ];

  test.each(OUTCOMES)(
    '%s: a retry keeps the one nonce, and pending is read once',
    async (_name, first, expected) => {
      const { tx, store } = start();
      mockBroadcast.mockImplementationOnce(first);

      let intentId;
      if (expected.returns) {
        const result = await tx.signAndSendTransaction(PARAMS, signer);
        expect(result).toMatchObject({ outcome: expected.returns, nonce: 7 });
        expect(result.hash).toBe(keccak256(broadcastRaws()[0]));
        intentId = result.intentId;
      } else {
        const failure = await tx.signAndSendTransaction(PARAMS, signer).catch((err) => err);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toMatchObject({
          outcome: expected.throws,
          intentId: expect.any(String),
          ...(expected.message ? { message: expected.message } : {}),
        });
        intentId = failure.intentId;
      }

      // The retry: the same bytes, at the same nonce, with no new signature.
      const retried = await tx.resendIntent(intentId);
      const [firstRaw, secondRaw] = broadcastRaws();
      expect(secondRaw).toBe(firstRaw);
      expect(retried).toMatchObject({ intentId, nonce: 7, outcome: 'sent' });
      expect(pendingReads()).toHaveLength(1);
      expect(signer.signTransaction).toHaveBeenCalledTimes(1);
      expect(store.get(intentId).handoffs.map((handoff) => handoff.outcome.outcome)).toEqual([
        expected.returns ?? expected.throws,
        'sent',
      ]);
    }
  );

  test('a broadcaster naming another hash makes the send uncertain, never an error', async () => {
    const { tx, store } = start();
    mockBroadcast.mockResolvedValueOnce({ result: `0x${'11'.repeat(32)}`, source: 'direct' });
    const result = await tx.signAndSendTransaction(PARAMS, signer);
    const [raw] = broadcastRaws();
    expect(result).toMatchObject({ hash: keccak256(raw), outcome: 'uncertain' });
    expect(store.get(result.intentId).handoffs[0].outcome.outcome).toBe('uncertain');
  });

  test('a rejection on the Ledger leaves no record, and the nonce free', async () => {
    const { tx, store } = start();
    const { createLedgerError, LEDGER_ERROR_CODES } = require('./ledger/errors');
    const rejection = createLedgerError(LEDGER_ERROR_CODES.USER_REJECTED);
    signer.signTransaction.mockRejectedValueOnce(rejection);

    await expect(tx.signAndSendTransaction(PARAMS, signer)).rejects.toBe(rejection);
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(intentFile())).toBe(false);
    expect(mockBroadcast).not.toHaveBeenCalled();
    await expect(tx.signAndSendTransaction(PARAMS, signer)).resolves.toMatchObject({ nonce: 7 });
  });

  test('a locked vault leaves no record, and the nonce free', async () => {
    const { tx, store } = start();
    const { VAULT_LOCKED_MESSAGE } = require('./vault-errors');
    signer.signTransaction.mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));

    await expect(tx.signAndSendTransaction(PARAMS, signer)).rejects.toThrow(VAULT_LOCKED_MESSAGE);
    expect(store.list()).toEqual([]);
    expect(mockBroadcast).not.toHaveBeenCalled();
    await expect(tx.signAndSendTransaction(PARAMS, signer)).resolves.toMatchObject({ nonce: 7 });
  });

  test('two sends from one account, the first waiting on the device, get N and N+1', async () => {
    const { tx } = start();
    let approve;
    const approved = new Promise((resolve) => {
      approve = resolve;
    });
    const slowSigner = {
      ...signer,
      signTransaction: jest.fn(async (transaction) => {
        await approved;
        return ALICE.signTransaction(transaction);
      }),
    };
    const first = tx.signAndSendTransaction(PARAMS, slowSigner);
    const second = tx.signAndSendTransaction(PARAMS, signer);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The second waits for the first's commit, not for the chain.
    expect(signer.signTransaction).not.toHaveBeenCalled();
    approve();
    const [a, b] = await Promise.all([first, second]);
    expect([a.nonce, b.nonce]).toEqual([7, 8]);
  });
});

describe('the phone path', () => {
  test('signs and broadcasts on the phone, with no record and no reservation', async () => {
    const { tx, store } = start();
    const hash = `0x${'cd'.repeat(32)}`;
    const phone = {
      getAddress: async () => ALICE.address,
      sendTransaction: jest.fn(async () => hash),
    };
    mockChainRequest.mockImplementation(async (_chainId, method) => {
      if (method === 'eth_getTransactionByHash') {
        return { result: { from: ALICE.address }, source: 'direct' };
      }
      throw new Error(`unexpected read ${method}`);
    });

    await expect(tx.signAndSendTransaction(PARAMS, phone)).resolves.toMatchObject({ hash });
    await store.ready;
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(intentFile())).toBe(false);
    expect(pendingReads()).toEqual([]);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe('sending again', () => {
  test('after a restore without records: pending N+1 gives a new intent there, and an unknown id is refused', async () => {
    const { tx } = start();
    pending = 8;
    await expect(tx.signAndSendTransaction(PARAMS, signer)).resolves.toMatchObject({ nonce: 8 });
    await expect(tx.resendIntent('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'INTENT_UNKNOWN',
    });
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });

  test('a voided intent is refused, and nothing is sent', async () => {
    const { tx, store, reservations } = start();
    mockBroadcast.mockImplementationOnce(async () => {
      throw tagged('Myotis is not ready', 'not_sent');
    });
    const failure = await tx.signAndSendTransaction(PARAMS, signer).catch((err) => err);
    const intent = store.get(failure.intentId);
    await reservations.withAccountLock({ chainId: CHAIN, sender: intent.sender }, (lock) =>
      store.void(intent.intentId, lock)
    );

    await expect(tx.resendIntent(intent.intentId)).rejects.toMatchObject({
      code: 'INTENT_NOT_HELD',
      message: 'This payment was voided.',
      outcome: 'not_sent',
    });
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    // Its nonce is free: the next new intent takes it.
    await expect(tx.signAndSendTransaction(PARAMS, signer)).resolves.toMatchObject({ nonce: 7 });
  });

  test('a resend waits for the account lock: a void holding it wins, and the resend is refused', async () => {
    const { tx, store, reservations } = start();
    mockBroadcast.mockImplementationOnce(async () => {
      throw tagged('Myotis is not ready', 'not_sent');
    });
    const failure = await tx.signAndSendTransaction(PARAMS, signer).catch((err) => err);
    const intent = store.get(failure.intentId);

    let releaseVoid;
    const voiding = reservations.withAccountLock(
      { chainId: CHAIN, sender: intent.sender },
      async (lock) => {
        await new Promise((resolve) => {
          releaseVoid = resolve;
        });
        return store.void(intent.intentId, lock);
      }
    );
    await until(() => releaseVoid);
    const resend = tx.resendIntent(intent.intentId).catch((err) => err);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Waiting for the lock: no handoff yet, so the void is still allowed.
    expect(store.get(intent.intentId).handoffs).toHaveLength(1);
    releaseVoid();

    await expect(voiding).resolves.toMatchObject({ state: 'voided' });
    expect(await resend).toMatchObject({ code: 'INTENT_NOT_HELD', outcome: 'not_sent' });
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });

  test('an intent key names a held intent: sending under it again sends the held bytes', async () => {
    const { tx } = start();
    const key = 'safe-exec:100:0xabc';
    mockBroadcast.mockImplementationOnce(async () => {
      throw tagged('insufficient funds for gas * price + value', 'rejected');
    });
    await expect(
      tx.signAndSendTransaction(PARAMS, signer, { intentKey: key })
    ).rejects.toMatchObject({
      outcome: 'rejected',
    });
    // Different params under the same key change nothing: it is the same intent.
    const again = await tx.signAndSendTransaction({ ...PARAMS, value: '5' }, signer, {
      intentKey: key,
    });
    expect(again).toMatchObject({ resent: true, nonce: 7, value: '1000' });
    const [firstRaw, secondRaw] = broadcastRaws();
    expect(secondRaw).toBe(firstRaw);
    expect(pendingReads()).toHaveLength(1);
  });
});

describe('payment history', () => {
  test('a wallet send writes one row, carrying its intent and outcome', async () => {
    const { store } = start();
    const { signAndRecord } = require('./tx-recorder');
    const history = require('../payment-history');
    mockBroadcast.mockImplementationOnce(async (_chainId, raw) => ({
      result: keccak256(raw),
      source: 'myotis',
      outcome: 'uncertain',
    }));

    const result = await signAndRecord(PARAMS, signer, { kind: 'wallet-send' });
    expect(result).toMatchObject({ outcome: 'uncertain', recorded: true });
    const rows = history.getRecent({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      txHash: result.hash,
      metadata: { intentId: result.intentId, outcome: 'uncertain' },
    });
    expect(store.get(result.intentId).context).toMatchObject({ kind: 'wallet-send' });
  });
});

describe('Safe', () => {
  const { ownerWallet } = require('./safe/__tests__/helpers/test-owners');
  const { createStubChain } = require('./safe/__tests__/helpers/stub-chain');
  const OWNERS = [ownerWallet(0).address, ownerWallet(2).address, ownerWallet(4).address];
  const INIT = { owners: OWNERS, threshold: 2, saltNonce: '7508' };

  async function signedSafeTx(safe) {
    const address = await safe.predictSafeAddress({
      ...INIT,
      chainId: CHAIN,
      provider: createStubChain({ chainId: CHAIN }),
    });
    const provider = createStubChain({
      chainId: CHAIN,
      deployedSafes: { [address]: { nonce: 0, threshold: 2, owners: OWNERS } },
    });
    const built = await safe.buildSafeTransaction({
      chainId: CHAIN,
      safe: INIT,
      tx: { to: OWNERS[2], value: '1000', data: '0x' },
      provider,
    });
    const signatures = [
      await safe.collectOwnerSignature({ typedData: built.typedData, ownerIndex: 0 }),
      await safe.collectOwnerSignature({ typedData: built.typedData, ownerIndex: 2 }),
    ];
    return { built, signatures };
  }

  test('an execution refused for funds, then "Try again": the same raw, one history row', async () => {
    start();
    const safe = require('./safe/safe-executor');
    const history = require('../payment-history');
    const { built, signatures } = await signedSafeTx(safe);
    const execute = () =>
      safe.execTransaction({
        chainId: CHAIN,
        safeAddress: built.safeAddress,
        safeTxData: built.safeTxData,
        signatures,
        executorIndex: 0,
        record: {
          kind: 'safe-send',
          fromAddress: built.safeAddress,
          toAddress: OWNERS[2],
          amount: '1000',
          metadata: { safeAddress: built.safeAddress, safeTxHash: built.safeTxHash },
        },
      });

    mockBroadcast.mockImplementationOnce(async () => {
      throw tagged('insufficient funds for gas * price + value', 'rejected');
    });
    await expect(execute()).rejects.toMatchObject({
      message: 'Insufficient funds for transaction',
      outcome: 'rejected',
    });
    expect(history.getCount()).toBe(0);

    // The executor is funded; the user presses "Try again".
    const result = await execute();
    const [firstRaw, secondRaw] = broadcastRaws();
    expect(secondRaw).toBe(firstRaw);
    expect(result).toMatchObject({ resent: true, outcome: 'sent', nonce: 7 });
    expect(pendingReads()).toHaveLength(1);
    expect(
      mockChainRequest.mock.calls.filter(([, method]) => method === 'eth_estimateGas')
    ).toHaveLength(1);
    const rows = history.getRecent({});
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({
      safeTxHash: built.safeTxHash,
      intentId: result.intentId,
      outcome: 'sent',
    });
  });

  test('a deployment whose reply was lost, then an activation retry: the same nonce, one row', async () => {
    const { store } = start();
    const safe = require('./safe/safe-executor');
    const history = require('../payment-history');
    const deployment = {
      safeAddress: '0x' + '5a'.repeat(20),
      to: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
      data: '0x1688f0b9',
    };
    const deploy = () =>
      safe.deploySafe({
        ...INIT,
        chainId: CHAIN,
        executorIndex: 0,
        deployment,
        record: { kind: 'safe-deploy', toAddress: deployment.safeAddress, amount: '0' },
      });

    // The broadcast's reply is lost: the core died with an attempt open.
    mockBroadcast.mockImplementationOnce(async () => {
      throw new Error('freedom-cored exited');
    });
    const first = await deploy();
    expect(first.tx).toMatchObject({ outcome: 'uncertain', nonce: 7 });

    const second = await deploy();
    expect(second.tx).toMatchObject({ outcome: 'sent', nonce: 7, resent: true });
    const [firstRaw, secondRaw] = broadcastRaws();
    expect(secondRaw).toBe(firstRaw);
    expect(pendingReads()).toHaveLength(1);
    expect(store.byKey(`safe-deploy:100:${deployment.safeAddress}`)).toMatchObject({
      intentId: first.tx.intentId,
    });
    const rows = history.getRecent({});
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ intentId: first.tx.intentId, outcome: 'sent' });
  });
});

describe('review fixes (#706)', () => {
  const { ownerWallet } = require('./safe/__tests__/helpers/test-owners');
  const deployment = {
    safeAddress: '0x' + '5a'.repeat(20),
    to: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
    data: '0x1688f0b9',
  };
  const deploy = (safe, executorIndex = 0) =>
    safe.deploySafe({
      owners: [ownerWallet(0).address],
      threshold: 1,
      saltNonce: '1',
      chainId: CHAIN,
      executorIndex,
      deployment,
    });

  describe('M1: a key names only an intent of the same chain, sender and kind', () => {
    test.each([
      ['another sender', { signer: 'bob' }],
      ['another chain', { chainId: 1 }],
      ['another kind', { kind: 'dapp-send' }],
    ])('a held intent of %s is refused, with nothing signed or sent', async (_name, change) => {
      const { tx, store } = start();
      const key = 'safe-exec:100:0xabc';
      mockBroadcast.mockImplementationOnce(async () => {
        throw tagged('Myotis is not ready', 'not_sent');
      });
      const failure = await tx
        .signAndSendTransaction(PARAMS, signer, { intentKey: key, context: { kind: 'safe-send' } })
        .catch((error) => error);
      const held = store.get(failure.intentId);
      const bob = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
      const caller =
        change.signer === 'bob'
          ? { getAddress: async () => bob.address, signTransaction: jest.fn() }
          : signer;
      signer.signTransaction.mockClear();

      await expect(
        tx.signAndSendTransaction({ ...PARAMS, chainId: change.chainId ?? CHAIN }, caller, {
          intentKey: key,
          context: { kind: change.kind ?? 'safe-send' },
        })
      ).rejects.toMatchObject({ code: 'INTENT_KEY_MISMATCH' });
      expect(mockBroadcast).toHaveBeenCalledTimes(1);
      expect(caller.signTransaction).not.toHaveBeenCalled();
      expect(store.get(held.intentId).handoffs).toHaveLength(1);
    });
  });

  describe('M2: one operation, one signature, however many first sends', () => {
    test('two simultaneous first deployments sign once; the second sends the same bytes', async () => {
      // The review's probe.
      const { store } = start();
      const safe = require('./safe/safe-executor');
      const [first, second] = await Promise.all([deploy(safe), deploy(safe)]);

      expect(mockSignatures).toEqual([{ index: 0, nonce: 7 }]);
      expect(pendingReads()).toHaveLength(1);
      expect(second.tx).toMatchObject({ intentId: first.tx.intentId, nonce: 7, resent: true });
      expect(first.tx.resent).toBeUndefined();
      const [a, b] = broadcastRaws();
      expect(b).toBe(a);
      expect(store.held()).toHaveLength(1);
    });

    test('a first deployment through another executor waits, then is refused, unsigned', async () => {
      const { store } = start();
      const safe = require('./safe/safe-executor');
      const [first, second] = await Promise.allSettled([deploy(safe, 0), deploy(safe, 2)]);

      expect(first).toMatchObject({ status: 'fulfilled' });
      expect(second).toMatchObject({ status: 'rejected', reason: { code: 'INTENT_KEY_MISMATCH' } });
      expect(mockSignatures).toEqual([{ index: 0, nonce: 7 }]);
      expect(store.held()).toHaveLength(1);
    });
  });

  describe('N1: one history row, whichever reply comes last', () => {
    test("the original's reply after its resend's updates the row", async () => {
      // The review's probe.
      start();
      const { signAndRecord } = require('./tx-recorder');
      const history = require('../payment-history');
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      mockBroadcast.mockImplementationOnce(async (chainId, raw) => {
        await held;
        return sent(chainId, raw);
      });
      const options = { intentKey: 'safe-exec:100:0xdef' };
      const original = signAndRecord(PARAMS, signer, { kind: 'safe-send' }, options);
      await until(() => mockBroadcast.mock.calls.length === 1);

      const resent = await signAndRecord(PARAMS, signer, { kind: 'safe-send' }, options);
      expect(resent).toMatchObject({ resent: true, recorded: true });
      release();
      const first = await original;

      expect(first).toMatchObject({ intentId: resent.intentId, paymentId: resent.paymentId });
      const rows = history.getRecent({});
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({ intentId: resent.intentId });
    });
  });

  describe('N2: the pending read and the signing wait for the account', () => {
    test.each([
      ['a new intent', {}],
      ['a keyed first send', { intentKey: 'safe-deploy:100:0x' + '7c'.repeat(20) }],
    ])(
      '%s reads pending and signs only once another approval releases the account',
      async (_name, options) => {
        const { tx, reservations } = start();
        let releaseOther;
        const otherApproval = reservations.withAccountLock(
          { chainId: CHAIN, sender: ALICE.address },
          () =>
            new Promise((resolve) => {
              releaseOther = resolve;
            })
        );
        await until(() => releaseOther);

        const sending = tx.signAndSendTransaction(PARAMS, signer, options);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(pendingReads()).toHaveLength(0);
        expect(signer.signTransaction).not.toHaveBeenCalled();

        releaseOther();
        await otherApproval;
        await expect(sending).resolves.toMatchObject({ nonce: 7, outcome: 'sent' });
        expect(pendingReads()).toHaveLength(1);
        expect(signer.signTransaction).toHaveBeenCalledTimes(1);
      }
    );
  });
});

describe('the only way to sign, and to read pending', () => {
  // A tripwire, not a proof: it flags code that signs, or reads the pending
  // count, outside the intent path's reservation. The behavioural tests
  // above are what show both wait for the account's lock. It parses each
  // file (with espree, ESLint's parser), so spacing, computed properties,
  // destructuring and string aliases don't hide a site.
  const espree = require('espree');
  const MAIN = path.join(__dirname, '..');
  const SERVICE = 'wallet/transaction-service.js';
  const FUNCTIONS = new Set([
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
  ]);

  function sources(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
      return entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') ? [full] : [];
    });
  }

  const parse = (source) =>
    espree.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      ecmaFeatures: { globalReturn: true },
    });

  // Every node, with its parent.
  function walk(node, visit, parent = null) {
    visit(node, parent);
    for (const [name, value] of Object.entries(node)) {
      if (name === 'parent') continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child.type === 'string') walk(child, visit, node);
      }
    }
  }

  function index(ast) {
    const parents = new Map();
    const nodes = [];
    walk(ast, (node, parent) => {
      parents.set(node, parent);
      nodes.push(node);
    });
    const functionOf = (node) => {
      for (let at = parents.get(node); at; at = parents.get(at)) {
        if (FUNCTIONS.has(at.type)) return at;
      }
      return null;
    };
    return { parents, nodes, functionOf };
  }

  const isString = (node, value) =>
    (node.type === 'Literal' && node.value === value) ||
    (node.type === 'TemplateLiteral' &&
      node.expressions.length === 0 &&
      node.quasis[0].value.cooked === value);
  const isName = (node, value) =>
    Boolean(node) && ((node.type === 'Identifier' && node.name === value) || isString(node, value));

  function contains(root, predicate) {
    let found = false;
    walk(root, (node) => {
      if (predicate(node)) found = true;
    });
    return found;
  }

  // Identifiers that read `name` inside `scope` (not declarations, keys or
  // member properties).
  function readsOf(name, scope, parents) {
    const reads = [];
    walk(scope, (node, parent) => {
      if (node.type !== 'Identifier' || node.name !== name || !parent) return;
      if (parent.type === 'VariableDeclarator' && parent.id === node) return;
      if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
      if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
        return;
      reads.push({ node, parent: parents.get(node) ?? parent });
    });
    return reads;
  }

  // Every read of `signTransaction` off an object, and the functions in
  // which the pending count is asked for.
  function sitesIn(ast) {
    const { parents, nodes, functionOf } = index(ast);
    const signing = [];
    const pending = new Set();
    for (const node of nodes) {
      if (
        node.type === 'MemberExpression' &&
        (node.computed
          ? isString(node.property, 'signTransaction')
          : isName(node.property, 'signTransaction'))
      ) {
        signing.push(node);
      }
      if (node.type === 'ObjectPattern') {
        for (const property of node.properties) {
          if (property.type === 'Property' && isName(property.key, 'signTransaction')) {
            signing.push(node);
          }
        }
      }
      if (isString(node, 'eth_getTransactionCount')) {
        // The literal's function, or, for a name bound to it, every function
        // that reads the name.
        const parent = parents.get(node);
        const uses =
          parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier'
            ? readsOf(parent.id.name, functionOf(parent) ?? ast, parents).map((read) => read.node)
            : [node];
        for (const use of uses) {
          const fn = functionOf(use);
          if (fn && contains(fn, (other) => isString(other, 'pending'))) pending.add(fn);
        }
      }
    }
    return { signing, pending: [...pending], parents, functionOf };
  }

  // The signing site is in the callback of a `reserve(...)` call made by
  // `commitNewIntent`.
  function inReservation(site, { parents, functionOf }) {
    const callback = functionOf(site);
    const call = parents.get(callback);
    if (call?.type !== 'CallExpression' || !isName(call.callee, 'reserve')) return false;
    if (call.arguments[1] !== callback) return false;
    return functionOf(call)?.id?.name === 'commitNewIntent';
  }

  // The pending read is `readPending`, read once: as the reservation's
  // `readPending` option.
  function readOnlyByReservation(fn, { parents, functionOf }) {
    const declarator = parents.get(fn);
    if (declarator?.type !== 'VariableDeclarator' || !isName(declarator.id, 'readPending')) {
      return false;
    }
    const reads = readsOf('readPending', functionOf(declarator), parents);
    if (reads.length !== 1) return false;
    const option = reads[0].parent;
    const call = parents.get(parents.get(option));
    return (
      option.type === 'Property' &&
      isName(option.key, 'readPending') &&
      call?.type === 'CallExpression' &&
      isName(call.callee, 'reserve')
    );
  }

  test('signTransaction and the pending count appear only inside the reservation', () => {
    const signing = {};
    const pending = {};
    let service;
    for (const file of sources(MAIN)) {
      const name = path.relative(MAIN, file).split(path.sep).join('/');
      const sites = sitesIn(parse(fs.readFileSync(file, 'utf8')));
      if (sites.signing.length) signing[name] = sites.signing;
      if (sites.pending.length) pending[name] = sites.pending;
      if (name === SERVICE) service = sites;
    }
    // The signer layer itself (signers.js delegates to a backend; the Ledger
    // backend calls the device) and the intent path: nothing else.
    expect(Object.keys(signing).sort()).toEqual([
      'wallet/ledger/signer.js',
      'wallet/signers.js',
      SERVICE,
    ]);
    expect(Object.keys(pending)).toEqual([SERVICE]);

    expect(service.signing).toHaveLength(1);
    expect(inReservation(service.signing[0], service)).toBe(true);
    expect(service.pending).toHaveLength(1);
    expect(readOnlyByReservation(service.pending[0], service)).toBe(true);
  });

  test('the scan catches what its first, textual version missed', () => {
    // The review's two mutants, as source. First: a spaced, computed and
    // destructured signing call, and a pending read through a string alias.
    const unguarded = sitesIn(
      parse(`
        async function unguardedSend(signer, chainData, chainId, from, tx) {
          const method = "eth_getTransactionCount";
          await chainData.request(chainId, method, [from, "pending"]);
          const { signTransaction } = signer;
          return signer [ 'signTransaction' ] (tx) && signTransaction(tx);
        }`)
    );
    expect(unguarded.signing).toHaveLength(2);
    expect(unguarded.pending).toHaveLength(1);

    // Second: pending read before the lock, its count handed in later.
    const early = sitesIn(
      parse(`
        async function commitNewIntent(signer, from) {
          const readPending = async () => request('eth_getTransactionCount', [from, 'pending']);
          const before = await readPending();
          return reserve({ readPending: async () => before }, async (n) => signer.signTransaction(n));
        }`)
    );
    expect(inReservation(early.signing[0], early)).toBe(true);
    expect(readOnlyByReservation(early.pending[0], early)).toBe(false);
  });
});
