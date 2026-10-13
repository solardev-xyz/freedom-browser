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
jest.mock('./signers', () => ({
  getSigner: (index) => require('./safe/__tests__/helpers/test-owners').createTestSigner(index),
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

describe('the only way to sign, and to read pending', () => {
  const MAIN = path.join(__dirname, '..');

  function sources(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
      return entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') ? [full] : [];
    });
  }

  function bodyOf(source, name) {
    const start = source.indexOf(`async function ${name}(`);
    const next = source
      .slice(start + 1)
      .search(/\n(async function|function|const|module\.exports) /);
    return source.slice(start, start + 1 + next);
  }

  test('.signTransaction( and the pending count only in the intent path', () => {
    const signing = [];
    const pendingCounts = [];
    for (const file of sources(MAIN)) {
      const source = fs.readFileSync(file, 'utf8');
      const name = path.relative(MAIN, file).split(path.sep).join('/');
      for (const _ of source.matchAll(/\.signTransaction\(/g)) signing.push(name);
      for (const _ of source.matchAll(
        /eth_getTransactionCount['"]\s*,\s*\[[^\]]*['"]pending['"]/g
      )) {
        pendingCounts.push(name);
      }
    }
    // The signer layer itself (signers.js delegates to a backend, and the
    // Ledger backend calls the device) and the intent path: nothing else.
    expect(signing.sort()).toEqual([
      'wallet/ledger/signer.js',
      'wallet/signers.js',
      'wallet/transaction-service.js',
    ]);
    expect(pendingCounts).toEqual(['wallet/transaction-service.js']);

    const service = fs.readFileSync(path.join(MAIN, 'wallet/transaction-service.js'), 'utf8');
    const sendNewIntent = bodyOf(service, 'sendNewIntent');
    expect(sendNewIntent).toMatch(/\.signTransaction\(/);
    expect(sendNewIntent).toMatch(/'pending'/);
    // Signing and the pending read happen inside the reservation.
    expect(sendNewIntent.indexOf('reserve(')).toBeLessThan(
      sendNewIntent.indexOf('.signTransaction(')
    );
    expect(bodyOf(service, 'resendIntent')).not.toMatch(/signTransaction|eth_getTransactionCount/);
  });
});
