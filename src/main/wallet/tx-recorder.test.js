jest.mock('../logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

const mockSignAndSendTransaction = jest.fn();
const mockWaitForTransaction = jest.fn();
jest.mock('./transaction-service', () => ({
  signAndSendTransaction: (...args) => mockSignAndSendTransaction(...args),
  waitForTransaction: (...args) => mockWaitForTransaction(...args),
}));

const mockAppend = jest.fn();
const mockMarkConfirmed = jest.fn();
const mockMarkFailed = jest.fn();
const mockRepollPending = jest.fn();
const mockUpdate = jest.fn();
const mockGetById = jest.fn();
const mockGetRecent = jest.fn();
jest.mock('../payment-history', () => ({
  append: (...args) => mockAppend(...args),
  repollPending: (...args) => mockRepollPending(...args),
  markConfirmed: (...args) => mockMarkConfirmed(...args),
  markFailed: (...args) => mockMarkFailed(...args),
  update: (...args) => mockUpdate(...args),
  getById: (...args) => mockGetById(...args),
  getRecent: (...args) => mockGetRecent(...args),
  KINDS: { WALLET_SEND: 'wallet-send', DAPP_SEND: 'dapp-send' },
  STATUSES: {
    CONFIRMED: 'confirmed',
    FAILED: 'failed',
    PENDING: 'pending',
    UNVERIFIED: 'unverified',
    WRONG_TRANSACTION: 'wrong-transaction',
    UNKNOWN: 'unknown',
  },
}));

const log = require('../logger');
const {
  signAndRecord,
  phoneChecked,
  phoneLost,
  resumePhoneChecks,
  attachPhoneEvents,
} = require('./tx-recorder');

const fakeSigner = { getAddress: async () => '0xfrom' };

describe('tx-recorder', () => {
  beforeEach(() => {
    mockSignAndSendTransaction.mockReset().mockResolvedValue({
      hash: '0xtx',
      from: '0xfrom',
    });
    mockWaitForTransaction.mockReset().mockResolvedValue({
      status: 'confirmed',
      gasUsed: '21000',
      effectiveGasPrice: '7',
    });
    mockAppend.mockReset().mockReturnValue({ id: 123 });
    mockMarkConfirmed.mockReset();
    mockMarkFailed.mockReset();
    mockRepollPending.mockReset().mockResolvedValue({ resolved: 0, stillPending: 0, errors: 0 });
  });

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  test("passes main's own options through: the turn's release and a page send's guard (0011 PRQ-5b)", async () => {
    const onCommitted = jest.fn();
    const guardCommit = jest.fn();
    await signAndRecord({ to: '0xto', value: '0', chainId: 1 }, fakeSigner, { kind: 'dapp-send', origin: 'https://app.example' }, {
      walletIndex: 3,
      onCommitted,
      guardCommit,
    });
    expect(mockSignAndSendTransaction).toHaveBeenCalledWith(expect.anything(), fakeSigner, {
      intentKey: null,
      context: { kind: 'dapp-send', origin: 'https://app.example', walletIndex: 3 },
      onCommitted,
      guardCommit,
    });
  });

  test('records the signing account and nonce so a dropped row can resolve', async () => {
    mockSignAndSendTransaction.mockResolvedValue({ hash: '0xtx', from: '0xsigner', nonce: 7 });

    await signAndRecord({ to: '0xsafe', value: '0', chainId: 1 }, fakeSigner, {
      kind: 'safe-send',
      fromAddress: '0xsafe',
      metadata: { safeAddress: '0xsafe' },
    });

    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({
      fromAddress: '0xsafe',
      metadata: { safeAddress: '0xsafe', txFrom: '0xsigner', txNonce: 7 },
    }));
  });

  // Integration: an intent's row is labelled by the finality tracker, so it
  // takes no 'dropped' sighting, and no sweep runs after a receipt (its
  // reads would reach Colibri first; see tx-recorder.js).
  test("an intent's row records no account and nonce for the dropped sweep", async () => {
    mockSignAndSendTransaction.mockResolvedValue({
      hash: '0xtx',
      from: '0xsigner',
      nonce: 7,
      intentId: 'intent-1',
      outcome: 'sent',
    });

    await signAndRecord({ to: '0xr', value: '0', chainId: 1 }, fakeSigner, {
      kind: 'wallet-send',
      metadata: { note: 'x' },
    });

    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { note: 'x', intentId: 'intent-1', outcome: 'sent' },
    }));
  });

  test('no sweep runs once a receipt settles, mined or timed out', async () => {
    await signAndRecord({ to: '0xr', value: '1', chainId: 1 }, fakeSigner, { kind: 'wallet-send' });
    await settle();
    expect(mockMarkConfirmed).toHaveBeenCalledWith(123, { gasUsed: '21000', gasPrice: '7' });

    mockWaitForTransaction.mockRejectedValue(new Error('Timed out'));
    await signAndRecord({ to: '0xr', value: '1', chainId: 1 }, fakeSigner, { kind: 'wallet-send' });
    await settle();

    expect(mockRepollPending).not.toHaveBeenCalled();
  });

  test('records user-visible ERC-20 recipient and amount from context', async () => {
    const result = await signAndRecord({
      to: '0xtoken',
      value: '0',
      chainId: 8453,
    }, fakeSigner, {
      kind: 'dapp-send',
      origin: 'https://app.example',
      asset: '0xtoken',
      toAddress: '0xrecipient',
      amount: '12345',
    });

    expect(result).toMatchObject({ hash: '0xtx', recorded: true, paymentId: 123 });
    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'dapp-send',
      chainId: 8453,
      txHash: '0xtx',
      fromAddress: '0xfrom',
      toAddress: '0xrecipient',
      asset: '0xtoken',
      amount: '12345',
      origin: 'https://app.example',
    }));
  });

  test('context.fromAddress overrides the signer address (Safe txs: from = safe, executor in metadata)', async () => {
    await signAndRecord({
      to: '0xsafe',
      value: '0',
      chainId: 100,
    }, fakeSigner, {
      kind: 'safe-send',
      fromAddress: '0xsafe',
      toAddress: '0xrecipient',
      amount: '1000',
      metadata: { safeAddress: '0xsafe', executor: '0xfrom' },
    });

    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'safe-send',
      fromAddress: '0xsafe',
      toAddress: '0xrecipient',
      metadata: { safeAddress: '0xsafe', executor: '0xfrom' },
    }));
  });

  test('surfaces recorded:false when the broadcast succeeds but history append fails', async () => {
    mockAppend.mockImplementationOnce(() => {
      throw new Error('db closed');
    });

    const result = await signAndRecord({
      to: '0xrecipient',
      value: '0x2a',
      chainId: 1,
    }, fakeSigner, {
      kind: 'wallet-send',
    });

    expect(result).toMatchObject({
      hash: '0xtx',
      recorded: false,
      recordError: 'db closed',
    });
    expect(mockWaitForTransaction).not.toHaveBeenCalled();
  });
});


// The history is the identity core's (design 0013, PRF-6(c)), so a step
// that reads a row and writes it back awaits the core in between: two such
// steps on one row run one at a time, as they did in one synchronous turn
// each while main kept the database.
describe('read-then-write steps on one history row', () => {
  test("a resend's write and the intent's settlement both keep what they add", async () => {
    const { recordSettlement } = require('./tx-recorder');
    const rows = new Map([
      [5, { id: 5, kind: 'wallet-send', chainId: 1, txHash: '0x1', status: 'pending', metadata: { intentId: 'i1' } }],
    ]);
    // Each answer the row as the request found it, a turn of the clock
    // later, as the core's are.
    const answer = (value) => {
      const copy = JSON.parse(JSON.stringify(value));
      return new Promise((resolve) => setTimeout(() => resolve(copy), 5));
    };
    mockGetRecent.mockReset().mockImplementation(() => answer([...rows.values()]));
    mockGetById.mockReset().mockImplementation((id) => answer(rows.get(id) ?? null));
    mockUpdate.mockReset().mockImplementation((id, patch) => {
      const row = rows.get(id);
      Object.assign(row, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      return answer(row);
    });
    mockSignAndSendTransaction.mockResolvedValue({
      hash: '0x2',
      from: '0xfrom',
      intentId: 'i1',
      outcome: 'sent',
      resent: true,
      chainId: 1,
    });
    mockWaitForTransaction.mockReturnValue(new Promise(() => {}));
    const resent = signAndRecord({ to: '0xr', value: '1', chainId: 1 }, fakeSigner, { kind: 'wallet-send' });
    const settled = recordSettlement(
      { intentId: 'i1', chainId: 1, hashes: [{ hash: '0x2' }], context: { kind: 'wallet-send' } },
      { label: 'paid', hash: '0x2', block: 9 }
    );
    await Promise.all([resent, settled]);
    expect(rows.get(5)).toMatchObject({
      status: 'confirmed',
      txHash: '0x2',
      metadata: { intentId: 'i1', outcome: 'sent', finality: { label: 'paid', block: 9 } },
    });
  });
});

// Design 0012, PHN-2: a phone payment the identity core couldn't verify at
// the answer waits for the core's `phone.checked` for its job, up to the
// core's day and a margin; main reads nothing of the transaction itself.
describe("phone payments: the identity core's check", () => {
  const HASH = '0x' + 'ab'.repeat(32);
  const DAY = 24 * 60 * 60 * 1000;
  const MARGIN = 10 * 60 * 1000;
  // The history store, in memory: rows by id, unique across tests (a row's
  // deadline is armed once per id per run).
  const rows = new Map();
  let nextId = 1000;
  let jobs = 0;
  const newJob = () => `core-job-${(jobs += 1)}`;
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const put = (row) => {
    const stored = { id: (nextId += 1), chainId: 100, txHash: HASH, ...row };
    rows.set(stored.id, stored);
    return stored;
  };

  beforeEach(() => {
    rows.clear();
    mockSignAndSendTransaction.mockReset();
    log.warn.mockClear();
    log.info.mockClear();
    mockWaitForTransaction.mockReset().mockResolvedValue({ status: 'confirmed', gasUsed: '21000', effectiveGasPrice: '7' });
    mockMarkConfirmed.mockReset();
    mockAppend.mockReset().mockImplementation((row) => put({ status: 'pending', ...row }));
    mockUpdate.mockReset().mockImplementation((id, changes) => {
      const row = rows.get(id);
      if (!row) return null;
      Object.assign(row, changes);
      return row;
    });
    mockGetById.mockReset().mockImplementation((id) => rows.get(id) ?? null);
    mockGetRecent.mockReset().mockImplementation(({ status, limit = 50, offset = 0 } = {}) =>
      [...rows.values()].filter((row) => !status || row.status === status).slice(offset, offset + limit)
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  /** A phone send the core answered with `phoneCheck`, recorded. */
  async function recordPhoneSend(phoneCheck, phoneRecord) {
    mockSignAndSendTransaction.mockResolvedValueOnce({
      hash: HASH,
      from: '0xphone',
      phoneCheck,
      ...(phoneRecord ? { phoneRecord } : {}),
    });
    const result = await signAndRecord({ to: '0xr', value: '1', chainId: 100 }, fakeSigner, { kind: 'wallet-send' });
    return { result, row: rows.get(result.paymentId) };
  }

  describe('at the answer', () => {
    test('verified: written pending, and polled for its receipt', async () => {
      const { result, row } = await recordPhoneSend('verified');
      expect(row.status).toBe('pending');
      expect(row.metadata).toBeUndefined();
      expect(result).toMatchObject({ phoneCheck: 'verified', recorded: true });
      expect(mockWaitForTransaction).toHaveBeenCalledWith(HASH, 100);
    });

    test("unverified: written unverified with the core's job, and not polled (a receipt isn't the payment confirmed)", async () => {
      const job = newJob();
      const { result, row } = await recordPhoneSend('unverified', { job, answeredAt: 1_700_000_000_000 });
      expect(row.status).toBe('unverified');
      expect(row.metadata).toEqual({ phoneCheck: { state: 'unverified', job, answeredAt: 1_700_000_000_000 } });
      expect(result).toMatchObject({ phoneCheck: 'unverified', recorded: true, paymentId: row.id });
      expect(result).not.toHaveProperty('phoneRecord');
      expect(mockWaitForTransaction).not.toHaveBeenCalled();
    });

    test("unknown, the core's record not saved: written unknown with the job, not polled", async () => {
      const job = newJob();
      const { result, row } = await recordPhoneSend('unknown', { job, answeredAt: 1, durable: false });
      expect(row.status).toBe('unknown');
      expect(row.metadata.phoneCheck).toEqual({ state: 'unknown', job, answeredAt: 1, durable: false });
      expect(result).toMatchObject({ phoneCheck: 'unknown', recorded: true });
      expect(mockWaitForTransaction).not.toHaveBeenCalled();
    });

    test("an unverified payment whose row can't be written is unknown at once", async () => {
      mockAppend.mockImplementationOnce(() => {
        throw new Error('db closed');
      });
      const { result } = await recordPhoneSend('unverified', { job: newJob(), answeredAt: 1 });
      expect(result).toMatchObject({ phoneCheck: 'unknown', recorded: false, recordError: 'db closed' });
    });
  });

  describe("the core's phone.checked", () => {
    test('verified: the row goes on as pending, and the receipt poll follows', async () => {
      const job = newJob();
      const { row } = await recordPhoneSend('unverified', { job, answeredAt: 1 });
      expect(await phoneChecked({ job, outcome: 'verified' })).toBe(true);
      expect(row.status).toBe('pending');
      expect(row.metadata.phoneCheck).toEqual({ state: 'verified', job, answeredAt: 1, checkedAt: expect.any(Number) });
      expect(mockWaitForTransaction).toHaveBeenCalledWith(HASH, 100);
      await settle();
      expect(mockMarkConfirmed).toHaveBeenCalledWith(row.id, { gasUsed: '21000', gasPrice: '7' });
    });

    test("mismatch: another transaction the phone sent, kept with the core's fields, for good; never polled", async () => {
      const job = newJob();
      const transaction = { from: '0xphone', to: '0xother', value: '5', data: '0x', chain_id: 100 };
      const { row } = await recordPhoneSend('unverified', { job, answeredAt: 1 });
      expect(await phoneChecked({ job, outcome: 'mismatch', reason: 'wrong_transaction', transaction })).toBe(true);
      expect(row.status).toBe('wrong-transaction');
      expect(row.metadata.phoneCheck).toEqual({
        state: 'mismatch',
        job,
        answeredAt: 1,
        checkedAt: expect.any(Number),
        code: 'wrong_transaction',
        observed: transaction,
      });
      expect(mockWaitForTransaction).not.toHaveBeenCalled();
      // Ended: a later check for the job finds no row waiting.
      expect(await phoneChecked({ job, outcome: 'verified' })).toBe(false);
      expect(row.status).toBe('wrong-transaction');
    });

    test("mismatch with fields of the wrong type keeps neither", async () => {
      const job = newJob();
      const { row } = await recordPhoneSend('unverified', { job, answeredAt: 1 });
      await phoneChecked({ job, outcome: 'mismatch', reason: 7, transaction: 'tx' });
      expect(row.metadata.phoneCheck).not.toHaveProperty('code');
      expect(row.metadata.phoneCheck).not.toHaveProperty('observed');
    });

    test('unknown: the row stays unknown, never polled', async () => {
      const job = newJob();
      const { row } = await recordPhoneSend('unverified', { job, answeredAt: 1 });
      expect(await phoneChecked({ job, outcome: 'unknown' })).toBe(true);
      expect(row.status).toBe('unknown');
      expect(row.metadata.phoneCheck.state).toBe('unknown');
      expect(mockWaitForTransaction).not.toHaveBeenCalled();
    });

    test("an unsaved row (unknown, durable: false) still takes a later check", async () => {
      const job = newJob();
      const { row } = await recordPhoneSend('unknown', { job, answeredAt: 1, durable: false });
      expect(await phoneChecked({ job, outcome: 'verified' })).toBe(true);
      expect(row.status).toBe('pending');
      expect(mockWaitForTransaction).toHaveBeenCalledWith(HASH, 100);
    });

    test('an unknown row that is not an unsaved one takes no check', async () => {
      const job = newJob();
      put({ status: 'unknown', metadata: { phoneCheck: { state: 'unknown', job, answeredAt: 1 } } });
      expect(await phoneChecked({ job, outcome: 'verified' })).toBe(false);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    test.each([
      ['a job no row waits on', { job: 'no-such-job', outcome: 'verified' }],
      ['no job', { outcome: 'verified' }],
      ['an outcome it does not know', { job: 'core-job-x', outcome: 'confirmed' }],
      ['nothing', undefined],
    ])('%s: no row is written', async (_name, data) => {
      put({ status: 'unverified', metadata: { phoneCheck: { state: 'unverified', job: 'core-job-x', answeredAt: 1 } } });
      expect(await phoneChecked(data)).toBe(false);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    test("a flagged send's rule, written by the core once its payment verified, is logged", async () => {
      const job = newJob();
      await recordPhoneSend('unverified', { job, answeredAt: 1 });
      await phoneChecked({ job, outcome: 'verified', rule: { added: true } });
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('contract rule was saved'));
      await phoneChecked({ job: 'no-such-job', outcome: 'mismatch', rule: { added: false, reason: 'mismatch' } });
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('contract rule was not saved: mismatch'));
    });
  });

  describe("the core's phone.lost", () => {
    test('ends every row still unverified as unknown; other rows stay', async () => {
      const first = (await recordPhoneSend('unverified', { job: newJob(), answeredAt: 1 })).row;
      const second = (await recordPhoneSend('unverified', { job: newJob(), answeredAt: 2 })).row;
      const unsaved = (await recordPhoneSend('unknown', { job: newJob(), answeredAt: 3, durable: false })).row;
      const verified = (await recordPhoneSend('verified')).row;
      expect(await phoneLost()).toBe(2);
      for (const row of [first, second]) {
        expect(row.status).toBe('unknown');
        expect(row.metadata.phoneCheck).toMatchObject({ state: 'unknown', lost: true });
      }
      expect(unsaved.metadata.phoneCheck).not.toHaveProperty('lost');
      expect(verified.status).toBe('pending');
    });

    test('a history read that fails ends nothing, and is logged', async () => {
      mockGetRecent.mockImplementation(() => {
        throw new Error('db closed');
      });
      expect(await phoneLost()).toBe(0);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('db closed'));
    });
  });

  describe("the deadline: the core's day and a margin from the answer", () => {
    test('a row still unverified then ends unknown', async () => {
      jest.useFakeTimers({ now: 1_700_000_000_000, doNotFake: ['setImmediate'] });
      const { row } = await recordPhoneSend('unverified', { job: newJob(), answeredAt: Date.now() });
      await jest.advanceTimersByTimeAsync(DAY + MARGIN - 1);
      expect(row.status).toBe('unverified');
      await jest.advanceTimersByTimeAsync(1);
      expect(row.status).toBe('unknown');
      expect(row.metadata.phoneCheck.state).toBe('unknown');
    });

    test('a row the core checked before then is left as it is', async () => {
      jest.useFakeTimers({ now: 1_700_000_000_000, doNotFake: ['setImmediate'] });
      const job = newJob();
      const { row } = await recordPhoneSend('unverified', { job, answeredAt: Date.now() });
      await phoneChecked({ job, outcome: 'mismatch', reason: 'wrong_transaction' });
      mockUpdate.mockClear();
      await jest.advanceTimersByTimeAsync(DAY + MARGIN);
      expect(row.status).toBe('wrong-transaction');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    test('an answer already older than the deadline ends at once', async () => {
      jest.useFakeTimers({ now: 1_700_000_000_000, doNotFake: ['setImmediate'] });
      const { row } = await recordPhoneSend('unverified', { job: newJob(), answeredAt: Date.now() - 2 * DAY });
      expect(row.status).toBe('unverified');
      await jest.advanceTimersByTimeAsync(0);
      expect(row.status).toBe('unknown');
    });
  });

  describe('at a start (resumePhoneChecks)', () => {
    test('a row with the core\'s job waits for its check, up to its deadline; one with no job ends unknown', async () => {
      jest.useFakeTimers({ now: 1_700_000_000_000 });
      const job = newJob();
      const waiting = put({ status: 'unverified', metadata: { phoneCheck: { state: 'unverified', job, answeredAt: Date.now() - DAY } } });
      // An earlier build's row: the fields it was confirmed for, no job.
      const older = put({ status: 'unverified', metadata: { phoneCheck: { state: 'unverified', to: '0xr', answeredAt: Date.now() } } });
      const bare = put({ status: 'unverified' });
      expect(await resumePhoneChecks()).toBe(1);
      expect(waiting.status).toBe('unverified');
      expect(older.status).toBe('unknown');
      expect(older.metadata.phoneCheck).toMatchObject({ state: 'unknown', to: '0xr' });
      expect(bare.status).toBe('unknown');
      // The waiting row's check still counts, until its deadline.
      expect(await phoneChecked({ job, outcome: 'verified' })).toBe(true);
      expect(waiting.status).toBe('pending');
    });

    test('a waiting row ends unknown at its deadline', async () => {
      jest.useFakeTimers({ now: 1_700_000_000_000 });
      const row = put({ status: 'unverified', metadata: { phoneCheck: { state: 'unverified', job: newJob(), answeredAt: Date.now() - DAY } } });
      await resumePhoneChecks();
      await jest.advanceTimersByTimeAsync(MARGIN - 1);
      expect(row.status).toBe('unverified');
      await jest.advanceTimersByTimeAsync(1);
      expect(row.status).toBe('unknown');
    });

    test('every page of unverified rows is read, not just the newest', async () => {
      jest.useFakeTimers({ now: 1_700_000_000_000 });
      for (let i = 0; i < 500; i += 1) {
        put({ status: 'unverified', metadata: { phoneCheck: { state: 'unverified', job: newJob(), answeredAt: Date.now() } } });
      }
      const last = put({ status: 'unverified' });
      expect(await resumePhoneChecks()).toBe(500);
      expect(mockGetRecent).toHaveBeenCalledWith({ status: 'unverified', limit: 500, offset: 0 });
      expect(mockGetRecent).toHaveBeenCalledWith({ status: 'unverified', limit: 500, offset: 500 });
      expect(last.status).toBe('unknown');
    });

    test('a history read that fails waits on nothing', async () => {
      mockGetRecent.mockImplementation(() => {
        throw new Error('db closed');
      });
      expect(await resumePhoneChecks()).toBe(0);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('db closed'));
    });
  });

  describe("the core's events (attachPhoneEvents)", () => {
    const { EventEmitter } = require('events');

    test('phone.checked and phone.lost reach the rows; other events are ignored', async () => {
      const core = new EventEmitter();
      attachPhoneEvents(core);
      const job = newJob();
      const checked = (await recordPhoneSend('unverified', { job, answeredAt: 1 })).row;
      const lost = (await recordPhoneSend('unverified', { job: newJob(), answeredAt: 1 })).row;
      core.emit('event', 'vault.locked', {});
      expect(mockUpdate).not.toHaveBeenCalled();
      core.emit('event', 'phone.checked', { job, outcome: 'verified' });
      await settle();
      expect(checked.status).toBe('pending');
      core.emit('event', 'phone.lost', {});
      await settle();
      expect(lost.status).toBe('unknown');
    });

    test('attached once per client', async () => {
      const core = new EventEmitter();
      attachPhoneEvents(core);
      attachPhoneEvents(core);
      expect(core.listenerCount('event')).toBe(1);
      // A client with no events is passed over.
      expect(() => attachPhoneEvents(null)).not.toThrow();
      expect(() => attachPhoneEvents({})).not.toThrow();
    });

    test("a failure keeping an event is logged, never thrown at the core's client", async () => {
      const core = new EventEmitter();
      attachPhoneEvents(core);
      mockGetRecent.mockImplementation(() => {
        throw new Error('db closed');
      });
      expect(() => core.emit('event', 'phone.checked', { job: 'core-job-y', outcome: 'verified' })).not.toThrow();
      await settle();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("could not keep the core's phone.checked: db closed"));
    });
  });
});
