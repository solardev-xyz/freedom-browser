// A phone account's payment, checked against the one confirmed once its
// transaction is visible (freedom-core design 0012, PHN-1 and PHN-2,
// "Unverified payments"; #1025). Real transaction service, tx-recorder and
// payment history (its sqlite fake, kept after every write as SQLite keeps
// its file, so a new run of main finds the rows a crash left); mocked chain
// data. Fake timers drive the rechecks and the wall clock.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet } = require('ethers');

const mockChainRequest = jest.fn();
jest.mock('../networks/chain-data', () => ({
  request: (...args) => mockChainRequest(...args),
  getFeeQuote: () => {
    throw new Error('a phone picks its own fees');
  },
  broadcastRawTransaction: () => {
    throw new Error('a phone broadcasts itself');
  },
  SOURCE_CAPABILITIES: {},
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
jest.mock('better-sqlite3', () => {
  const Fake = jest.requireActual('../../../test/helpers/fake-better-sqlite3-payments');
  if (!globalThis.mockKeptPaymentDbs) globalThis.mockKeptPaymentDbs = new Map();
  const kept = globalThis.mockKeptPaymentDbs;
  return class KeptFake extends Fake {
    constructor(filePath) {
      super(filePath);
      const state = kept.get(filePath);
      if (state) Object.assign(this, JSON.parse(state));
    }
    prepare(sql) {
      const statement = super.prepare(sql);
      if (typeof statement.run !== 'function') return statement;
      return {
        ...statement,
        run: (...values) => {
          const result = statement.run(...values);
          this.keep();
          return result;
        },
      };
    }
    pragma(...args) {
      const result = super.pragma(...args);
      this.keep();
      return result;
    }
    keep() {
      const { rows, nextId, userVersion } = this;
      kept.set(this.filePath, JSON.stringify({ rows, nextId, userVersion }));
    }
  };
});
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// Deterministic test key (not a real wallet).
const ALICE = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const RECIPIENT = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const OTHER = '0x' + '22'.repeat(20);
const CHAIN = 100;
const HASH = '0x' + 'cd'.repeat(32);
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);
// What the user confirmed: the job names the account, to, value, data and chain.
const JOB = { to: RECIPIENT, value: '1000', data: '0xabcdef01', gasLimit: '21000', chainId: CHAIN };
const MINED = { status: '0x1', blockNumber: '0x1', gasUsed: '0x5208' };

// The transaction main's RPC shows for the hash: the one confirmed, unless
// changed. The phone picks its own nonce, gas and fees.
const theTransaction = (change = {}) => ({
  hash: HASH,
  from: ALICE.address,
  to: RECIPIENT,
  value: '0x3e8',
  input: '0xabcdef01',
  chainId: '0x64',
  nonce: '0x9',
  gas: '0x5208',
  maxFeePerGas: '0x77359400',
  ...change,
});

// What main's RPC answers: `tx` (a transaction, null when not visible, an
// Error when the read fails) and the hash's receipt, which is mined
// whatever the transaction: a receipt says the hash was mined, never that
// it is the payment confirmed.
let chain;
const reads = (method) => mockChainRequest.mock.calls.filter(([, m]) => m === method).length;

beforeEach(() => {
  mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-payments-'));
  jest.useFakeTimers({ now: T0 });
  chain = { tx: null, receipt: MINED };
  mockChainRequest.mockReset().mockImplementation(async (_chainId, method) => {
    if (method === 'eth_getTransactionByHash') {
      if (chain.tx instanceof Error) throw chain.tx;
      return { result: chain.tx, source: 'direct' };
    }
    if (method === 'eth_getTransactionReceipt') return { result: chain.receipt, source: 'direct' };
    throw new Error(`unexpected read ${method}`);
  });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  globalThis.mockKeptPaymentDbs.clear();
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

// A run of main: new modules over the same userData.
function start() {
  jest.resetModules();
  return {
    recorder: require('./tx-recorder'),
    history: require('../payment-history'),
    tx: require('./transaction-service'),
  };
}

// Main ends without a word (a crash): its timers go with it, and the next
// run finds what the history last wrote. (Clearing fake timers resets
// their clock too; the wall clock goes on.)
function crashAndStart() {
  const now = Date.now();
  jest.clearAllTimers();
  jest.setSystemTime(now);
  return start();
}

const phone = () => ({
  getAddress: async () => ALICE.address,
  sendTransaction: jest.fn(async () => HASH),
});

const pay = (run, job = JOB) => run.recorder.signAndRecord(job, phone(), { kind: 'wallet-send' });

async function elapse(ms) {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const rowOf = (run, reply) => run.history.getById(reply.paymentId);
const sha256 = (hex) =>
  crypto
    .createHash('sha256')
    .update(Buffer.from(hex.slice(2), 'hex'))
    .digest('hex');

describe('a phone payment not visible at the answer', () => {
  test('is recorded unverified, with the fields it was confirmed for, and polls no receipt', async () => {
    const run = start();
    const reply = await pay(run);

    expect(reply).toMatchObject({ hash: HASH, phoneCheck: 'unverified', recorded: true });
    expect(reply).not.toHaveProperty('phoneRecord');
    const row = rowOf(run, reply);
    expect(row).toMatchObject({
      status: 'unverified',
      txHash: HASH,
      toAddress: RECIPIENT,
      amount: '1000',
    });
    expect(row.metadata.phoneCheck).toEqual({
      state: 'unverified',
      from: ALICE.address.toLowerCase(),
      to: RECIPIENT.toLowerCase(),
      value: '1000',
      dataLength: 4,
      dataSha256: sha256('0xabcdef01'),
      chainId: '100',
      answeredAt: T0,
    });
    // `data` by its length and SHA-256, never its bytes.
    expect(JSON.stringify(row.metadata)).not.toContain('abcdef01');

    // Still not visible: nothing changes, and no receipt is read, though
    // the hash is mined.
    await elapse(60_000);
    expect(rowOf(run, reply).status).toBe('unverified');
    expect(reads('eth_getTransactionReceipt')).toBe(0);
    // The boot sweep of pending rows passes it by.
    await run.history.repollPending(run.tx.getTransactionStatus);
    expect(rowOf(run, reply).status).toBe('unverified');
  });

  test.each([
    ['another recipient', { to: OTHER }],
    ['a contract creation', { to: null }],
    ['another amount', { value: '0x3e9' }],
    ['other calldata', { input: '0xabcdee01' }],
    ['no calldata', { input: '0x' }],
    ['another chain', { chainId: '0x1' }],
    ['no chain id', { chainId: undefined }],
  ])('later visible with %s: wrong transaction, never confirmed', async (_label, change) => {
    const run = start();
    const reply = await pay(run);

    chain.tx = theTransaction(change);
    await elapse(5_000);

    const row = rowOf(run, reply);
    expect(row.status).toBe('wrong-transaction');
    expect(row.metadata.phoneCheck).toMatchObject({
      state: 'mismatch',
      code: 'REMOTE_WRONG_TRANSACTION',
      checkedAt: T0 + 5_000,
      observed: expect.objectContaining({ from: ALICE.address.toLowerCase() }),
    });
    // Its receipt is there, and nothing confirms it: no poll, no sweep.
    await elapse(DAY);
    await run.history.repollPending(run.tx.getTransactionStatus);
    expect(rowOf(run, reply).status).toBe('wrong-transaction');
    expect(reads('eth_getTransactionReceipt')).toBe(0);
  });

  test("later visible from another account: wrong transaction, as the answer's check says", async () => {
    const run = start();
    const reply = await pay(run);

    chain.tx = theTransaction({ from: OTHER });
    await elapse(5_000);

    expect(rowOf(run, reply)).toMatchObject({
      status: 'wrong-transaction',
      metadata: { phoneCheck: { state: 'mismatch', code: 'REMOTE_WRONG_ACCOUNT' } },
    });
  });

  test('later visible and the same: verified, then confirmed by its receipt', async () => {
    const run = start();
    chain.receipt = null;
    const reply = await pay(run);

    await elapse(5_000);
    expect(rowOf(run, reply).status).toBe('unverified');
    // The same transaction, whatever the case of its address and calldata.
    chain.tx = theTransaction({ to: RECIPIENT.toLowerCase(), input: '0xABCDEF01' });
    await elapse(10_000);

    expect(rowOf(run, reply)).toMatchObject({
      status: 'pending',
      metadata: { phoneCheck: { state: 'verified', checkedAt: T0 + 15_000 } },
    });
    chain.receipt = MINED;
    await elapse(2_000);
    expect(rowOf(run, reply).status).toBe('confirmed');
  });

  test('a failed lookup at the answer is unverified too, and so are failed rechecks', async () => {
    const run = start();
    chain.tx = new Error('rpc down');
    const reply = await pay(run);

    expect(reply.phoneCheck).toBe('unverified');
    expect(rowOf(run, reply).status).toBe('unverified');
    await elapse(5_000 + 10_000);
    expect(rowOf(run, reply).status).toBe('unverified');

    chain.tx = theTransaction({ value: '0x0' });
    await elapse(20_000);
    expect(rowOf(run, reply)).toMatchObject({
      status: 'wrong-transaction',
      metadata: { phoneCheck: { state: 'mismatch', code: 'REMOTE_WRONG_TRANSACTION' } },
    });
  });

  test('a failed lookup at the answer, later visible and the same: verified', async () => {
    const run = start();
    chain.tx = new Error('rpc down');
    const reply = await pay(run);

    chain.tx = theTransaction();
    await elapse(5_000);
    expect(rowOf(run, reply)).toMatchObject({
      status: 'confirmed',
      metadata: { phoneCheck: { state: 'verified' } },
    });
  });

  test('rechecks after 5 s, then at doubling intervals up to every 10 minutes', async () => {
    const run = start();
    await pay(run);
    const lookups = [];
    mockChainRequest.mockImplementation(async (_chainId, method) => {
      if (method === 'eth_getTransactionByHash') lookups.push(Date.now() - T0);
      return { result: null, source: 'direct' };
    });

    await elapse(3_600_000);
    expect(lookups.slice(0, 9)).toEqual([
      5_000, 15_000, 35_000, 75_000, 155_000, 315_000, 635_000, 1_235_000, 1_835_000,
    ]);
  });
});

describe('a restart between the answer and the transaction appearing', () => {
  test.each([
    ['another recipient', { to: OTHER }],
    ['another amount', { value: '0x3e9' }],
    ['calldata differing only in its last byte', { input: '0xabcdef02' }],
    ['calldata of another length', { input: '0xabcdef0100' }],
    ['another chain', { chainId: '0xa' }],
  ])('the next run checks it at its start: %s is the wrong transaction', async (_label, change) => {
    const first = start();
    const reply = await pay(first);

    const next = crashAndStart();
    chain.tx = theTransaction(change);
    expect(next.recorder.resumePhoneChecks()).toBe(1);
    await elapse(0);

    expect(rowOf(next, reply)).toMatchObject({
      status: 'wrong-transaction',
      metadata: { phoneCheck: { state: 'mismatch', code: 'REMOTE_WRONG_TRANSACTION' } },
    });
    await elapse(DAY);
    expect(rowOf(next, reply).status).toBe('wrong-transaction');
  });

  test('the next run resumes every unverified payment, past one page of history', async () => {
    const first = start();
    const reply = await pay(first);
    const row = rowOf(first, reply);
    // 500 more unverified phone payments, so the oldest sits past the first page.
    for (let i = 0; i < 500; i += 1) {
      first.history.append({
        kind: row.kind,
        chainId: row.chainId,
        amount: row.amount,
        status: 'unverified',
        txHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
        createdAt: row.createdAt + 1 + i,
        metadata: row.metadata,
      });
    }

    const next = crashAndStart();
    expect(next.recorder.resumePhoneChecks()).toBe(501);
  });

  test('the next run checks it at its start: the same transaction is verified, then confirmed', async () => {
    const first = start();
    const reply = await pay(first);

    const next = crashAndStart();
    chain.tx = theTransaction();
    next.recorder.resumePhoneChecks();
    await elapse(0);

    expect(rowOf(next, reply)).toMatchObject({
      status: 'confirmed',
      metadata: { phoneCheck: { state: 'verified' } },
    });
  });

  test('not visible at the start either: the next run keeps checking, and compares it then', async () => {
    const first = start();
    const reply = await pay(first);

    const next = crashAndStart();
    next.recorder.resumePhoneChecks();
    await elapse(0);
    expect(rowOf(next, reply).status).toBe('unverified');

    chain.tx = theTransaction({ to: OTHER });
    await elapse(5_000);
    expect(rowOf(next, reply).status).toBe('wrong-transaction');
  });
});

describe('never visible within a day of the answer', () => {
  test('waits until 86,399,999 ms after the answer, and is unknown at 86,400,000 for good', async () => {
    const run = start();
    const reply = await pay(run);

    await elapse(DAY - 1);
    expect(rowOf(run, reply).status).toBe('unverified');
    await elapse(1);
    const row = rowOf(run, reply);
    expect(row.status).toBe('unknown');
    expect(row.metadata.phoneCheck).toMatchObject({ state: 'unknown', checkedAt: T0 + DAY });

    // Visible and the same afterwards: still unknown, and not read again.
    const lookups = reads('eth_getTransactionByHash');
    chain.tx = theTransaction();
    await elapse(DAY);
    expect(rowOf(run, reply).status).toBe('unknown');
    expect(reads('eth_getTransactionByHash')).toBe(lookups);
    expect(reads('eth_getTransactionReceipt')).toBe(0);
  });

  test('at a start a day after the answer: unknown before any read, though visible and the same', async () => {
    const first = start();
    const reply = await pay(first);

    jest.setSystemTime(T0 + DAY);
    const next = crashAndStart();
    chain.tx = theTransaction();
    const before = reads('eth_getTransactionByHash');
    next.recorder.resumePhoneChecks();
    await elapse(0);

    expect(rowOf(next, reply).status).toBe('unknown');
    expect(reads('eth_getTransactionByHash')).toBe(before);
  });

  test('at a start 1 ms before the day ends: still checked, and verified', async () => {
    const first = start();
    const reply = await pay(first);

    jest.setSystemTime(T0 + DAY - 1);
    const next = crashAndStart();
    chain.tx = theTransaction();
    next.recorder.resumePhoneChecks();
    await elapse(0);

    expect(rowOf(next, reply).metadata.phoneCheck.state).toBe('verified');
  });

  test('a wall clock set before the answer ends it unknown, at a recheck and at a start', async () => {
    const run = start();
    const reply = await pay(run);
    chain.tx = theTransaction();
    jest.setSystemTime(T0 - 10_000);
    await elapse(5_000);
    expect(rowOf(run, reply).status).toBe('unknown');

    jest.setSystemTime(T0);
    chain.tx = null;
    const second = await pay(run);
    expect(rowOf(run, second).status).toBe('unverified');
    chain.tx = theTransaction();
    jest.setSystemTime(T0 - 1);
    const next = crashAndStart();
    next.recorder.resumePhoneChecks();
    await elapse(0);
    expect(rowOf(next, second).status).toBe('unknown');
  });
});

describe('at the answer', () => {
  test('visible and the same: verified, recorded pending and confirmed by its receipt', async () => {
    const run = start();
    chain.tx = theTransaction();
    const reply = await pay(run);

    expect(reply.phoneCheck).toBe('verified');
    await elapse(0);
    const row = rowOf(run, reply);
    expect(row.status).toBe('confirmed');
    expect(row.metadata?.phoneCheck).toBeUndefined();
  });

  test('visible without a chain id: the wrong transaction, as it is later', async () => {
    const run = start();
    chain.tx = theTransaction({ chainId: undefined });
    await expect(pay(run)).rejects.toMatchObject({ code: 'REMOTE_WRONG_TRANSACTION' });
  });

  test("a record that can't be saved is unknown at once, never unverified", async () => {
    const run = start();
    jest.spyOn(run.history, 'append').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const reply = await pay(run);

    expect(reply).toMatchObject({ hash: HASH, phoneCheck: 'unknown', recorded: false });
  });
});
