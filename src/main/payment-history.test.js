/**
 * payment-history.js as the identity core's client (freedom-core design
 * 0013, "Payment history"; PRF-6(c)), against the simulated core
 * (test/helpers/simulated-payments-core.js): each function runs the
 * reference module (9d4ea6251) on fake-better-sqlite3-payments.js, so the
 * rows are today's. The real core is tested in
 * payment-history.integration.test.js. The broadcasts, the requests' callers
 * and the failure paths run against a stub of `vaultBackend.payments`.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const FakeBetterSqlite3PaymentsDatabase = require('../../test/helpers/fake-better-sqlite3-payments');
const { simulatedPayments } = require('../../test/helpers/simulated-payments-core');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');

/**
 * payment-history.js, fresh, over the simulated core (`sim` options), or
 * over `backend` (a stub of `vaultBackend.payments`) when given.
 */
function loadPaymentHistoryModule(options = {}) {
  let sim = null;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const loaded = loadMainModule(require.resolve('./payment-history'), {
    ...options,
    extraMocks: {
      'better-sqlite3': options.betterSqlite3 ?? (() => FakeBetterSqlite3PaymentsDatabase),
      [require.resolve('./logger')]: () => logger,
      [require.resolve('./core/vault-backend')]: () => {
        if (!options.backend) sim = simulatedPayments(options.sim);
        return { vaultBackend: { payments: options.backend ?? sim.payments } };
      },
      ...(options.extraMocks || {}),
    },
  });
  return { ...loaded, sim, logger };
}

/** A stub of `vaultBackend.payments`: each method a jest.fn answering `answers[name]`. */
function stubBackend(answers = {}) {
  const names = [
    'append',
    'update',
    'markConfirmed',
    'markFailed',
    'markDropped',
    'setDroppedSeen',
    'pending',
    'getRecent',
    'getById',
    'getCount',
    'clear',
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      jest.fn(async () => {
        const answer = answers[name];
        if (answer instanceof Error) throw answer;
        return typeof answer === 'function' ? answer() : answer;
      }),
    ])
  );
}

const coded = (code, message, data) => Object.assign(new Error(message), { code, data });

// Common test fixtures
const BASE_CHAIN = 8453;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TEN_USDC = '10000000';
const ORIGIN = 'https://api.example.com';
const URL_FULL = 'https://api.example.com/article/42';
const PAY_TO = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const FROM_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('payment-history (through the core)', () => {
  let userDataDir;
  let mod;
  let sim;

  // Each test gets a fresh module and a fresh simulated core, whose fake
  // database is the reference module's, under a fresh temp userData.
  beforeEach(() => {
    userDataDir = createTempUserDataDir();
    ({ mod, sim } = loadPaymentHistoryModule({ userDataDir }));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    removeTempUserDataDir(userDataDir);
  });

  // === append ============================================================

  describe('append', () => {
    test('inserts an x402 record born settled', async () => {
      const entry = await mod.append({
        kind: 'x402',
        chainId: BASE_CHAIN,
        txHash: '0xabc',
        toAddress: PAY_TO,
        asset: USDC_BASE,
        amount: TEN_USDC,
        origin: ORIGIN,
        url: URL_FULL,
        status: 'settled',
      });
      expect(entry).toMatchObject({
        kind: 'x402',
        chainId: BASE_CHAIN,
        txHash: '0xabc',
        asset: USDC_BASE,
        amount: TEN_USDC,
        status: 'settled',
      });
      expect(entry.id).toEqual(expect.any(Number));
      expect(entry.createdAt).toEqual(expect.any(Number));
      expect(entry.confirmedAt).toEqual(entry.createdAt);
      expect(sim.calls).toEqual([['payments.append', 'shell']]);
    });

    test('inserts a wallet-send record born pending', async () => {
      const entry = await mod.append({
        kind: 'wallet-send',
        chainId: 1,
        txHash: '0xdef',
        fromAddress: FROM_ADDR,
        toAddress: '0x1234567890abcdef1234567890abcdef12345678',
        amount: '1000000000000000000',
      });
      expect(entry.status).toBe('pending');
      expect(entry.confirmedAt).toBeNull();
    });

    // Coordinator call G13: the core names the class it refused with, and
    // main throws it again, so callers see what the module threw before.
    test("a refusal is thrown as the module's class, with its message", async () => {
      const unknown = await mod
        .append({ kind: 'lightning', chainId: 1, amount: '1' })
        .catch((e) => e);
      expect(unknown).toBeInstanceOf(Error);
      expect(unknown.message).toMatch(/unknown kind/);
      expect(unknown).toMatchObject({ code: 'invalid_argument', data: { name: 'Error' } });
      await expect(mod.append({ kind: 'x402', chainId: 1, amount: 'ten' })).rejects.toThrow(
        /amount must be a digit string/
      );
      await expect(mod.append({ kind: 'x402', chainId: NaN, amount: '1' })).rejects.toThrow(
        /chainId must be a finite number/
      );
      const typeError = await mod.getRecent(null).catch((e) => e);
      expect(typeError).toBeInstanceOf(TypeError);
      expect(typeError.data).toEqual({ name: 'TypeError' });
    });

    test('serialises metadata as JSON', async () => {
      const entry = await mod.append({
        kind: 'dapp-send',
        chainId: 1,
        amount: '1',
        metadata: { dappFavicon: '/icon.png', x402Version: 2 },
      });
      expect(entry.metadata).toEqual({ dappFavicon: '/icon.png', x402Version: 2 });
    });
  });

  // === update + mark*** ==================================================

  describe('update / markConfirmed / markFailed', () => {
    test('markConfirmed transitions pending → confirmed and stamps gas', async () => {
      const pending = await mod.append({
        kind: 'wallet-send',
        chainId: 1,
        txHash: '0x1',
        amount: '1',
      });
      const after = await mod.markConfirmed(pending.id, {
        gasUsed: '21000',
        gasPrice: '20000000000',
      });
      expect(after).toMatchObject({
        id: pending.id,
        status: 'confirmed',
        gasUsed: '21000',
        gasPrice: '20000000000',
      });
      expect(after.confirmedAt).toBeGreaterThanOrEqual(pending.createdAt);
    });

    test('markFailed records the reason in metadata', async () => {
      const pending = await mod.append({ kind: 'wallet-send', chainId: 1, amount: '1' });
      const after = await mod.markFailed(pending.id, { reason: 'reverted' });
      expect(after.status).toBe('failed');
      expect(after.metadata).toEqual({ failureReason: 'reverted' });
    });

    test('update is partial — unspecified fields are preserved', async () => {
      const original = await mod.append({
        kind: 'wallet-send',
        chainId: 1,
        txHash: '0xorig',
        amount: '1',
      });
      const after = await mod.update(original.id, { status: 'confirmed' });
      expect(after.txHash).toBe('0xorig');
      expect(after.status).toBe('confirmed');
    });

    test('update of a non-existent id returns null', async () => {
      await expect(mod.update(999, { status: 'confirmed' })).resolves.toBeNull();
    });

    test('the writes are main’s own (shell)', async () => {
      const row = await mod.append({ kind: 'wallet-send', chainId: 1, amount: '1' });
      await mod.update(row.id, {});
      await mod.markConfirmed(row.id);
      await mod.markFailed(row.id);
      await mod.markDropped(row.id);
      expect(sim.calls.map(([, caller]) => caller)).toEqual([
        'shell',
        'shell',
        'shell',
        'shell',
        'shell',
      ]);
      expect(sim.calls.map(([method]) => method)).toEqual([
        'payments.append',
        'payments.update',
        'payments.mark_confirmed',
        'payments.mark_failed',
        'payments.mark_dropped',
      ]);
    });
  });

  // === getRecent + filters ==============================================

  describe('getRecent', () => {
    test('returns rows newest-first, honors limit + offset', async () => {
      // Insert three with explicit createdAt so we control ordering.
      await mod.append({
        kind: 'x402',
        chainId: 1,
        amount: '1',
        status: 'settled',
        createdAt: 1000,
      });
      await mod.append({
        kind: 'x402',
        chainId: 1,
        amount: '2',
        status: 'settled',
        createdAt: 3000,
      });
      await mod.append({
        kind: 'x402',
        chainId: 1,
        amount: '3',
        status: 'settled',
        createdAt: 2000,
      });

      expect((await mod.getRecent({})).map((r) => r.amount)).toEqual(['2', '3', '1']);
      expect((await mod.getRecent({ limit: 2 })).map((r) => r.amount)).toEqual(['2', '3']);
      expect((await mod.getRecent({ limit: 2, offset: 1 })).map((r) => r.amount)).toEqual([
        '3',
        '1',
      ]);
      expect((await mod.getRecent()).map((r) => r.amount)).toEqual(['2', '3', '1']);
    });

    test('filters by kind, chainId, origin, status', async () => {
      await mod.append({
        kind: 'x402',
        chainId: 8453,
        origin: 'https://a.example',
        amount: '1',
        status: 'settled',
      });
      await mod.append({
        kind: 'x402',
        chainId: 1,
        origin: 'https://b.example',
        amount: '2',
        status: 'settled',
      });
      await mod.append({ kind: 'wallet-send', chainId: 8453, amount: '3', status: 'pending' });

      expect(await mod.getRecent({ kind: 'x402' })).toHaveLength(2);
      expect(await mod.getRecent({ chainId: 8453 })).toHaveLength(2);
      expect(await mod.getRecent({ origin: 'https://a.example' })).toHaveLength(1);
      expect(await mod.getRecent({ status: 'pending' })).toHaveLength(1);
      expect(await mod.getRecent({ kind: 'x402', chainId: 8453 })).toHaveLength(1);
    });
  });

  describe('getCount', () => {
    test('counts respect the same filter set as getRecent', async () => {
      await mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      await mod.append({ kind: 'wallet-send', chainId: 1, amount: '2' });
      await mod.append({ kind: 'dapp-send', chainId: 8453, amount: '3' });
      expect(await mod.getCount({})).toBe(3);
      expect(await mod.getCount()).toBe(3);
      expect(await mod.getCount({ kind: 'x402' })).toBe(1);
      expect(await mod.getCount({ chainId: 1 })).toBe(2);
    });
  });

  describe('getById / clear', () => {
    test('round-trip + clear wipes everything', async () => {
      const e1 = await mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      expect((await mod.getById(e1.id)).id).toBe(e1.id);
      await expect(mod.getById(999)).resolves.toBeNull();

      await expect(mod.clear()).resolves.toBe(1);
      await expect(mod.getRecent({})).resolves.toEqual([]);
    });
  });

  // === repollPending =====================================================

  describe('repollPending', () => {
    test('resolves pending rows according to the supplied status fn', async () => {
      const r1 = await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const r2 = await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xb', amount: '2' });
      const r3 = await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xc', amount: '3' });

      const fakeStatus = jest.fn(async (txHash) => {
        if (txHash === '0xa') return { status: 'confirmed', gasUsed: '21000', gasPrice: '10' };
        if (txHash === '0xb') return { status: 'failed' };
        return { status: 'pending' };
      });

      const summary = await mod.repollPending(fakeStatus);
      expect(summary).toEqual({ resolved: 2, stillPending: 1, errors: 0 });

      expect(await mod.getById(r1.id)).toMatchObject({ status: 'confirmed', gasUsed: '21000' });
      expect((await mod.getById(r2.id)).status).toBe('failed');
      expect((await mod.getById(r3.id)).status).toBe('pending');
      // The sweep's rows: the core's `pending`, main's own read.
      expect(sim.calls).toContainEqual(['payments.pending', 'shell']);
    });

    test('a thrown error counts but does not corrupt the row', async () => {
      const row = await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const summary = await mod.repollPending(async () => {
        throw new Error('rpc down');
      });
      expect(summary.errors).toBe(1);
      expect((await mod.getById(row.id)).status).toBe('pending');
    });

    test("a core that can't write a row's status counts it an error, and the next sweep resolves it", async () => {
      const row = await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      sim.failBefore('payments.mark_confirmed', 'core_unavailable');
      const confirmed = async () => ({ status: 'confirmed', gasUsed: '21000' });
      await expect(mod.repollPending(confirmed)).resolves.toEqual({
        resolved: 0,
        stillPending: 0,
        errors: 1,
      });
      expect((await mod.getById(row.id)).status).toBe('pending');
      await expect(mod.repollPending(confirmed)).resolves.toEqual({
        resolved: 1,
        stillPending: 0,
        errors: 0,
      });
      expect((await mod.getById(row.id)).status).toBe('confirmed');
    });

    test("a core that can't list the pending rows fails the sweep", async () => {
      sim.failBefore('payments.pending', 'storage');
      await expect(mod.repollPending(jest.fn())).rejects.toMatchObject({ code: 'storage' });
    });

    // The clock repollPending reads; tests step it past the confirm window.
    let clock;
    function useClock(start = 1_000_000) {
      clock = start;
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
    }

    // #749: a dropped transaction never gets a receipt; once another
    // transaction takes its nonce the row resolves instead of staying
    // pending forever. One sighting is not enough: a later sweep, at least
    // DROPPED_CONFIRM_MS on, must see it again.
    test('resolves a row whose nonce another transaction took as dropped', async () => {
      useClock();
      const dropped = await mod.append({
        kind: 'safe-send',
        chainId: 1,
        txHash: '0xdropped',
        amount: '1',
        metadata: { safeAddress: '0xsafe', txFrom: FROM_ADDR, txNonce: 0 },
      });
      const resend = await mod.append({
        kind: 'wallet-send',
        chainId: 1,
        txHash: '0xresend',
        amount: '1',
        metadata: { txFrom: FROM_ADDR, txNonce: 0 },
      });
      const fakeStatus = jest.fn(async (txHash) =>
        txHash === '0xresend' ? { status: 'confirmed', gasUsed: '21000' } : { status: 'dropped' }
      );

      await expect(mod.repollPending(fakeStatus)).resolves.toEqual({
        resolved: 1,
        stillPending: 1,
        errors: 0,
      });
      expect(fakeStatus).toHaveBeenCalledWith('0xdropped', 1, {
        from: FROM_ADDR,
        nonce: 0,
        sweep: true,
      });
      expect(await mod.getById(dropped.id)).toMatchObject({
        status: 'pending',
        metadata: { safeAddress: '0xsafe', txDroppedSeenAt: clock },
      });
      expect((await mod.getById(resend.id)).status).toBe('confirmed');
      expect(sim.calls).toContainEqual(['payments.set_dropped_seen', 'shell']);

      clock += mod.DROPPED_CONFIRM_MS;
      await expect(mod.repollPending(fakeStatus)).resolves.toEqual({
        resolved: 1,
        stillPending: 0,
        errors: 0,
      });
      const row = await mod.getById(dropped.id);
      expect(row.status).toBe('dropped');
      expect(row.confirmedAt).toEqual(expect.any(Number));
      // The row's own metadata survives the status change.
      expect(row.metadata).toMatchObject({
        safeAddress: '0xsafe',
        txNonce: 0,
        failureReason: 'nonce used by another transaction',
      });
    });

    // R3-M2: the sighting is written after the status lookup resolves; a
    // finaliser that ran meanwhile must not have its metadata overwritten
    // with the sweep's stale snapshot.
    test('a sighting does not overwrite a row finalised during its lookup', async () => {
      useClock();
      const row = await mod.append({
        kind: 'wallet-send',
        chainId: 1,
        txHash: '0xa',
        amount: '1',
        metadata: { txFrom: FROM_ADDR, txNonce: 0 },
      });
      await mod.repollPending(async () => {
        await mod.markFailed(row.id, { reason: 'reverted' });
        return { status: 'dropped' };
      });
      const after = await mod.getById(row.id);
      expect(after.status).toBe('failed');
      expect(after.metadata).toEqual({ failureReason: 'reverted' });
      expect(after.metadata.txDroppedSeenAt).toBeUndefined();
    });

    // R4-M1: the confirming sweep's 'dropped' answer is also stale once
    // its lookup resolves; a final status written meanwhile stands.
    test.each([
      [
        'confirmed',
        (id) => mod.markConfirmed(id, { gasUsed: '21000' }),
        { txFrom: FROM_ADDR, txNonce: 0 },
      ],
      ['failed', (id) => mod.markFailed(id, { reason: 'reverted' }), { failureReason: 'reverted' }],
    ])(
      'a confirming sweep does not overwrite a row %s during its lookup',
      async (status, finalise, metadata) => {
        useClock();
        const row = await mod.append({
          kind: 'wallet-send',
          chainId: 1,
          txHash: '0xa',
          amount: '1',
          metadata: { txFrom: FROM_ADDR, txNonce: 0 },
        });
        await mod.repollPending(async () => ({ status: 'dropped' }));
        const seenAt = (await mod.getById(row.id)).metadata.txDroppedSeenAt;
        clock += mod.DROPPED_CONFIRM_MS;
        await expect(
          mod.repollPending(async () => {
            await finalise(row.id);
            return { status: 'dropped' };
          })
        ).resolves.toEqual({ resolved: 0, stillPending: 0, errors: 0 });
        const after = await mod.getById(row.id);
        expect(after.status).toBe(status);
        expect(after.metadata).toEqual(
          status === 'confirmed' ? { ...metadata, txDroppedSeenAt: seenAt } : metadata
        );
      }
    );

    test('markDropped leaves a row that is no longer pending alone', async () => {
      const row = await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      await mod.markConfirmed(row.id, {});
      await expect(mod.markDropped(row.id)).resolves.toBeNull();
      expect((await mod.getById(row.id)).status).toBe('confirmed');
    });

    test('a pending answer clears the sighting without dropping concurrent metadata', async () => {
      useClock();
      const row = await mod.append({
        kind: 'wallet-send',
        chainId: 1,
        txHash: '0xa',
        amount: '1',
        metadata: { txFrom: FROM_ADDR, txNonce: 0 },
      });
      await mod.repollPending(async () => ({ status: 'dropped' }));
      await mod.repollPending(async () => {
        await mod.update(row.id, {
          metadata: { ...(await mod.getById(row.id)).metadata, note: 'added' },
        });
        return { status: 'pending' };
      });
      expect((await mod.getById(row.id)).metadata).toEqual({
        txFrom: FROM_ADDR,
        txNonce: 0,
        note: 'added',
      });
    });

    test('a second sighting inside the confirm window leaves the row pending', async () => {
      useClock();
      const row = await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const fn = async () => ({ status: 'dropped' });
      await mod.repollPending(fn);
      const firstSeen = clock;
      clock += mod.DROPPED_CONFIRM_MS - 1;
      await expect(mod.repollPending(fn)).resolves.toMatchObject({ resolved: 0, stillPending: 1 });
      // The window still counts from the first sighting.
      expect(await mod.getById(row.id)).toMatchObject({
        status: 'pending',
        metadata: { txDroppedSeenAt: firstSeen },
      });
      clock += 1;
      await expect(mod.repollPending(fn)).resolves.toMatchObject({ resolved: 1 });
      expect((await mod.getById(row.id)).status).toBe('dropped');
    });

    // A lagging endpoint read a just-mined transaction as dropped once; the
    // next read that sees it pending again must reset, not confirm, that.
    test('a pending answer between sightings starts the window over', async () => {
      useClock();
      const row = await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      await mod.repollPending(async () => ({ status: 'dropped' }));
      clock += 1000;
      await mod.repollPending(async () => ({ status: 'pending' }));
      expect((await mod.getById(row.id)).metadata?.txDroppedSeenAt).toBeUndefined();
      clock += mod.DROPPED_CONFIRM_MS;
      await mod.repollPending(async () => ({ status: 'dropped' }));
      expect(await mod.getById(row.id)).toMatchObject({
        status: 'pending',
        metadata: { txDroppedSeenAt: clock },
      });
    });

    test('a waiting sighting schedules its own confirming sweep', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      const row = await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const fn = jest.fn(async () => ({ status: 'dropped' }));
      await mod.repollPending(fn);
      expect((await mod.getById(row.id)).status).toBe('pending');
      expect(fn).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(mod.DROPPED_CONFIRM_MS);
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(fn).toHaveBeenCalledTimes(2);
      expect((await mod.getById(row.id)).status).toBe('dropped');
      expect(jest.getTimerCount()).toBe(0);
    });

    test('a dropped row is final and is not polled again', async () => {
      useClock();
      await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      await mod.repollPending(async () => ({ status: 'dropped' }));
      clock += mod.DROPPED_CONFIRM_MS;
      await mod.repollPending(async () => ({ status: 'dropped' }));
      const fn = jest.fn();
      await expect(mod.repollPending(fn)).resolves.toEqual({
        resolved: 0,
        stillPending: 0,
        errors: 0,
      });
      expect(fn).not.toHaveBeenCalled();
    });

    test('a row recorded without a sender nonce is polled without one', async () => {
      await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const fn = jest.fn(async () => ({ status: 'pending' }));
      await mod.repollPending(fn);
      expect(fn).toHaveBeenCalledWith('0xa', 1, { from: undefined, nonce: undefined, sweep: true });
    });

    const flush = async (turns = 5) => {
      for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
    };

    test('a call during a sweep queues one more sweep after it, shared by every caller', async () => {
      await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const releases = [];
      const fn = jest.fn(
        () =>
          new Promise((resolve) => {
            releases.push(resolve);
          })
      );
      const first = mod.repollPending(fn);
      const second = mod.repollPending(fn);
      const third = mod.repollPending(fn);
      expect(second).not.toBe(first);
      expect(third).toBe(second);
      await flush();
      expect(fn).toHaveBeenCalledTimes(1);
      // The running sweep read the row before the chain moved.
      releases[0]({ status: 'pending' });
      await expect(first).resolves.toMatchObject({ resolved: 0, stillPending: 1 });
      await flush();
      // The queued sweep re-reads it, now that the nonce has moved.
      expect(fn).toHaveBeenCalledTimes(2);
      releases[1]({ status: 'confirmed' });
      await expect(second).resolves.toMatchObject({ resolved: 1, stillPending: 0 });
      expect(fn).toHaveBeenCalledTimes(2);
    });

    // The running sweep has settled but the queued one has not started yet:
    // a caller in that gap joins the queued sweep instead of starting a third.
    test('a call between a sweep settling and the queued one starting joins the queued one', async () => {
      await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const releases = [];
      const fn = jest.fn(
        () =>
          new Promise((resolve) => {
            releases.push(resolve);
          })
      );
      const first = mod.repollPending(fn);
      const second = mod.repollPending(fn);
      await flush();
      releases[0]({ status: 'pending' });
      await first;
      const late = mod.repollPending(fn);
      expect(late).toBe(second);
      await flush();
      releases[1]({ status: 'confirmed' });
      await second;
      await flush();
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('a queued sweep still runs when the sweep before it fails', async () => {
      await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const first = mod.repollPending(() => {
        throw new Error('boom');
      });
      const second = mod.repollPending(async () => ({ status: 'confirmed' }));
      await first;
      await expect(second).resolves.toMatchObject({ resolved: 1 });
    });

    test('pending rows with no txHash are skipped, not polled', async () => {
      await mod.append({ kind: 'wallet-send', chainId: 1, amount: '1' }); // no txHash
      const fn = jest.fn();
      const summary = await mod.repollPending(fn);
      expect(fn).not.toHaveBeenCalled();
      expect(summary.stillPending).toBe(1);
    });
  });

  // === the repoll at each start of the core ==============================

  describe('attachCore: the repoll at each start of the core', () => {
    const flush = async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    };

    test('sweeps at each ready of the core, and at once when it is ready already', async () => {
      await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const client = Object.assign(new EventEmitter(), { state: 'starting' });
      const status = jest.fn(async () => ({ status: 'pending' }));
      mod.attachCore(status, client);
      // Attached once per client.
      mod.attachCore(status, client);
      await flush();
      expect(status).not.toHaveBeenCalled();
      client.emit('ready', {});
      await flush();
      expect(status).toHaveBeenCalledTimes(1);
      // A restarted core: the rows a lost write left pending are read again.
      client.emit('ready', {});
      await flush();
      expect(status).toHaveBeenCalledTimes(2);

      const up = Object.assign(new EventEmitter(), { state: 'ready' });
      mod.attachCore(status, up);
      await flush();
      expect(status).toHaveBeenCalledTimes(3);
    });

    test('a sweep the core fails is logged, and the next ready tries again', async () => {
      const { mod: fresh, logger } = loadPaymentHistoryModule({
        userDataDir,
        backend: stubBackend({
          pending: coded('requirement_unmet', "The core can't take this request"),
        }),
      });
      const client = Object.assign(new EventEmitter(), { state: 'starting' });
      fresh.attachCore(jest.fn(), client);
      client.emit('ready', {});
      await flush();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("The core can't take this request")
      );
    });

    test('with no core client, nothing is attached', () => {
      const { mod: fresh } = loadPaymentHistoryModule({
        userDataDir,
        extraMocks: {
          [require.resolve('./core/core-process')]: () => ({ getCoreClient: () => null }),
        },
      });
      expect(() => fresh.attachCore(jest.fn())).not.toThrow();
    });
  });

  // === after a restart: lost answers and the kept appends =================

  // A write whose answer was lost may or may not have happened, and no
  // listener heard of it; the core's next start settles both (attachCore).
  describe('a lost answer, then a restart of the core', () => {
    let send;
    let client;
    let logger;
    const flush = async () => {
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    };
    const restart = async () => {
      client.emit('ready', {});
      await flush();
    };
    const events = () => send.mock.calls.map(([, payload]) => payload);
    const NONCE = `0x${'cd'.repeat(32)}`;
    const x402 = (extra = {}) => ({
      kind: 'x402',
      chainId: BASE_CHAIN,
      origin: ORIGIN,
      url: URL_FULL,
      asset: USDC_BASE,
      amount: TEN_USDC,
      toAddress: PAY_TO,
      status: 'settled',
      txHash: '0xsettled',
      ...extra,
    });

    beforeEach(() => {
      send = jest.fn();
      ({ mod, sim, logger } = loadPaymentHistoryModule({
        userDataDir,
        webContents: { getAllWebContents: () => [{ send }] },
      }));
      client = Object.assign(new EventEmitter(), { state: 'starting' });
      mod.attachCore(async () => ({ status: 'pending' }), client);
    });

    // Codex round 1 on #1299: each write, its answer lost (it happened)
    // or failed unsent with its outcome unknown (it didn't): after the
    // restart the history is read again, then every listener told to read
    // it again, and the write is in the history once or not at all.
    test.each([
      [
        'append',
        'payments.append',
        async () => mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' }),
        async () => expect(await mod.getCount({ kind: 'wallet-send' })).toBe(1),
        async () => expect(await mod.getCount({ kind: 'wallet-send' })).toBe(0),
      ],
      [
        'update',
        'payments.update',
        async (row) => mod.update(row.id, { txHash: '0xnew' }),
        async (row) => expect((await mod.getById(row.id)).txHash).toBe('0xnew'),
        async (row) => expect((await mod.getById(row.id)).txHash).toBe('0xa'),
      ],
      [
        'markConfirmed',
        'payments.mark_confirmed',
        async (row) => mod.markConfirmed(row.id, { gasUsed: '21000' }),
        async (row) => expect((await mod.getById(row.id)).status).toBe('confirmed'),
        async (row) => expect((await mod.getById(row.id)).status).toBe('pending'),
      ],
      [
        'markFailed',
        'payments.mark_failed',
        async (row) => mod.markFailed(row.id, { reason: 'reverted' }),
        async (row) => expect((await mod.getById(row.id)).status).toBe('failed'),
        async (row) => expect((await mod.getById(row.id)).status).toBe('pending'),
      ],
      [
        'markDropped',
        'payments.mark_dropped',
        async (row) => mod.markDropped(row.id),
        async (row) => expect((await mod.getById(row.id)).status).toBe('dropped'),
        async (row) => expect((await mod.getById(row.id)).status).toBe('pending'),
      ],
      [
        'clear',
        'payments.clear',
        async () => mod.clear(),
        async () => expect(await mod.getCount({})).toBe(0),
        async () => expect(await mod.getCount({})).toBe(1),
      ],
    ])(
      '%s: applied or not, the restart re-reads and tells every listener once',
      async (_name, method, write, applied, notApplied) => {
        for (const [lose, check] of [
          [() => sim.loseReply(method), applied],
          [() => sim.failBefore(method, 'core_unavailable'), notApplied],
        ]) {
          await mod.clear().catch(() => {});
          const row =
            method === 'payments.append'
              ? null
              : await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
          send.mockClear();
          lose();
          await expect(write(row)).rejects.toMatchObject({ code: 'core_unavailable' });
          expect(send).not.toHaveBeenCalled();
          const reads = sim.calls.length;
          await restart();
          // Read again first (`get_count`), then told.
          expect(sim.calls.slice(reads, reads + 1)).toEqual([['payments.get_count', 'shell']]);
          expect(events()).toEqual([{ id: null }]);
          await check(row);
          // Owed once: the next start tells no one.
          send.mockClear();
          await restart();
          expect(send).not.toHaveBeenCalled();
        }
      }
    );

    test('a write the core refused or main never sent owes nothing', async () => {
      const row = await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      send.mockClear();
      sim.failBefore('payments.mark_confirmed', 'storage');
      await expect(mod.markConfirmed(row.id, {})).rejects.toMatchObject({ code: 'storage' });
      await expect(mod.append({ kind: 'lightning', chainId: 1, amount: '1' })).rejects.toThrow(
        /unknown kind/
      );
      await restart();
      expect(send).not.toHaveBeenCalled();
    });

    test('a re-read the core fails is owed to the start after', async () => {
      const row = await mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      sim.loseReply('payments.mark_confirmed');
      await expect(mod.markConfirmed(row.id, {})).rejects.toMatchObject({
        code: 'core_unavailable',
      });
      send.mockClear();
      sim.failBefore('payments.get_count', 'core_unavailable');
      await restart();
      expect(send).not.toHaveBeenCalled();
      await restart();
      expect(events()).toEqual([{ id: null }]);
    });

    // The x402 rows (appendOnce): the money has left, so the row must land,
    // and land once.
    test.each([
      ['with its nonce', { metadata: { authorizationNonce: NONCE } }],
      ['without a nonce', {}],
    ])(
      'a kept append %s whose answer was lost is found at the restart, never written twice',
      async (_name, extra) => {
        sim.loseReply('payments.append');
        await expect(mod.appendOnce(x402(extra))).resolves.toBeNull();
        expect(await mod.getCount({ kind: 'x402' })).toBe(1);
        expect(send).not.toHaveBeenCalled();
        await restart();
        expect(await mod.getCount({ kind: 'x402' })).toBe(1);
        const [row] = await mod.getRecent({ kind: 'x402' });
        // Told with its row (x402's balance refresh listens for its kind), and re-read.
        expect(events()).toEqual([
          { id: row.id, kind: 'x402', status: 'settled', txHash: '0xsettled' },
          { id: null },
        ]);
        expect(sim.calls.filter(([m]) => m === 'payments.append')).toHaveLength(1);
      }
    );

    test.each([
      ['never sent, its outcome unknown', 'core_unavailable'],
      ['refused before it was written', 'storage'],
      ['refused by main', 'requirement_unmet'],
    ])('a kept append %s is written once at the restart', async (_name, code) => {
      sim.failBefore('payments.append', code);
      await expect(
        mod.appendOnce(x402({ metadata: { authorizationNonce: NONCE } }))
      ).resolves.toBeNull();
      expect(await mod.getCount({ kind: 'x402' })).toBe(0);
      await restart();
      const rows = await mod.getRecent({ kind: 'x402' });
      expect(rows).toEqual([
        expect.objectContaining({
          amount: TEN_USDC,
          status: 'settled',
          metadata: { authorizationNonce: NONCE },
        }),
      ]);
      expect(events()[0]).toEqual({
        id: rows[0].id,
        kind: 'x402',
        status: 'settled',
        txHash: '0xsettled',
      });
      // Nothing left: the next start writes nothing.
      await restart();
      expect(await mod.getCount({ kind: 'x402' })).toBe(1);
    });

    test('a kept append is written with the time it was first sent', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      sim.failBefore('payments.append', 'core_unavailable');
      await mod.appendOnce(x402());
      Date.now.mockReturnValue(1_700_000_999_000);
      await restart();
      expect((await mod.getRecent({ kind: 'x402' }))[0].createdAt).toBe(1_700_000_000_000);
    });

    test('a kept append refused while the core is up is tried again a minute later', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      client.state = 'ready';
      sim.failBefore('payments.append', 'storage');
      await mod.appendOnce(x402({ metadata: { authorizationNonce: NONCE } }));
      expect(await mod.getCount({ kind: 'x402' })).toBe(0);
      jest.advanceTimersByTime(59_000);
      await flush();
      expect(await mod.getCount({ kind: 'x402' })).toBe(0);
      jest.advanceTimersByTime(1_000);
      await flush();
      expect(await mod.getCount({ kind: 'x402' })).toBe(1);
    });

    test('a kept append whose read-back fails waits for the next start, and is still found then', async () => {
      sim.loseReply('payments.append');
      await mod.appendOnce(x402({ metadata: { authorizationNonce: NONCE } }));
      sim.failBefore('payments.get_recent', 'core_unavailable');
      await restart();
      sim.failBefore('payments.append', 'core_unavailable');
      await restart();
      expect(await mod.getCount({ kind: 'x402' })).toBe(1);
      expect(sim.calls.filter(([m]) => m === 'payments.append')).toHaveLength(1);
    });

    test('a kept append the core refuses each time is given up after three attempts, and logged', async () => {
      const refused = x402({ amount: 'not-digits' });
      await expect(mod.appendOnce(refused)).resolves.toBeNull();
      await restart();
      await restart();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('after 3 attempts'));
      const appends = sim.calls.filter(([m]) => m === 'payments.append').length;
      await restart();
      expect(sim.calls.filter(([m]) => m === 'payments.append')).toHaveLength(appends);
      expect(appends).toBe(3);
    });

    test('a kept append the core answers at once is written once and told once', async () => {
      const row = await mod.appendOnce(x402({ metadata: { authorizationNonce: NONCE } }));
      expect(row).toMatchObject({ kind: 'x402', metadata: { authorizationNonce: NONCE } });
      expect(events()).toEqual([
        { id: row.id, kind: 'x402', status: 'settled', txHash: '0xsettled' },
      ]);
      await restart();
      expect(await mod.getCount({ kind: 'x402' })).toBe(1);
      expect(events()).toHaveLength(1);
    });

    test('two payments alike but for their nonces are told apart', async () => {
      await mod.appendOnce(x402({ metadata: { authorizationNonce: `0x${'01'.repeat(32)}` } }));
      sim.loseReply('payments.append');
      await mod.appendOnce(x402({ metadata: { authorizationNonce: `0x${'02'.repeat(32)}` } }));
      sim.failBefore('payments.append', 'core_unavailable');
      await mod.appendOnce(x402({ metadata: { authorizationNonce: `0x${'03'.repeat(32)}` } }));
      await restart();
      const nonces = (await mod.getRecent({ kind: 'x402' }))
        .map((r) => r.metadata.authorizationNonce)
        .sort();
      expect(nonces).toEqual([
        `0x${'01'.repeat(32)}`,
        `0x${'02'.repeat(32)}`,
        `0x${'03'.repeat(32)}`,
      ]);
    });
  });

  // === payments:tx-recorded broadcast ====================================

  describe('payments:tx-recorded broadcast', () => {
    const PENDING = { id: 7, kind: 'wallet-send', status: 'pending', txHash: '0x1' };
    let send;
    let backend;

    function load(answers) {
      send = jest.fn();
      backend = stubBackend(answers);
      ({ mod } = loadPaymentHistoryModule({
        userDataDir,
        backend,
        webContents: { getAllWebContents: () => [{ send }, { send }] },
      }));
    }

    test("append broadcasts the core's record to every webContents, after its answer", async () => {
      let answer;
      load({
        append: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      });
      const appending = mod.append({ kind: 'x402', chainId: BASE_CHAIN, amount: TEN_USDC });
      await new Promise((resolve) => setImmediate(resolve));
      expect(send).not.toHaveBeenCalled();
      answer({ id: 3, kind: 'x402', status: 'settled', txHash: '0xabc', amount: TEN_USDC });
      await expect(appending).resolves.toMatchObject({ id: 3 });
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledWith('payments:tx-recorded', {
        id: 3,
        kind: 'x402',
        status: 'settled',
        txHash: '0xabc',
      });
      expect(backend.append).toHaveBeenCalledWith({
        kind: 'x402',
        chainId: BASE_CHAIN,
        amount: TEN_USDC,
      });
    });

    test.each([
      [
        'update',
        (m) => m.update(7, { status: 'confirmed' }),
        'update',
        [7, { status: 'confirmed' }],
      ],
      [
        'markConfirmed',
        (m) => m.markConfirmed(7, { gasUsed: '1' }),
        'markConfirmed',
        [7, { gasUsed: '1' }],
      ],
      ['markFailed', (m) => m.markFailed(7, { reason: 'x' }), 'markFailed', [7, { reason: 'x' }]],
      ['markDropped', (m) => m.markDropped(7), 'markDropped', [7]],
    ])(
      '%s broadcasts the record it names, and nothing for null',
      async (_name, write, method, args) => {
        load({ [method]: { ...PENDING, status: 'confirmed' } });
        await write(mod);
        expect(backend[method]).toHaveBeenCalledWith(...args);
        expect(send).toHaveBeenCalledWith(
          'payments:tx-recorded',
          expect.objectContaining({ id: 7, status: 'confirmed' })
        );
        load({ [method]: null });
        await expect(write(mod)).resolves.toBeNull();
        expect(send).not.toHaveBeenCalled();
      }
    );

    test('the marks send the module’s defaults', async () => {
      load({ markConfirmed: null, markFailed: null });
      await mod.markConfirmed(7);
      await mod.markFailed(7);
      expect(backend.markConfirmed).toHaveBeenCalledWith(7, {});
      expect(backend.markFailed).toHaveBeenCalledWith(7, {});
    });

    test('clear broadcasts a null-id sentinel when it removed rows, and nothing otherwise', async () => {
      load({ clear: 2 });
      await expect(mod.clear()).resolves.toBe(2);
      expect(send).toHaveBeenCalledWith('payments:tx-recorded', { id: null });
      load({ clear: 0 });
      await expect(mod.clear()).resolves.toBe(0);
      expect(send).not.toHaveBeenCalled();
    });

    test('the sweep’s sighting broadcasts nothing; its marks do', async () => {
      const row = {
        id: 7,
        kind: 'wallet-send',
        tx_hash: '0xa',
        chain_id: 1,
        status: 'pending',
        metadata: null,
      };
      load({
        pending: [row],
        setDroppedSeen: undefined,
        markConfirmed: { ...PENDING, status: 'confirmed' },
      });
      await mod.repollPending(async () => ({ status: 'dropped' }));
      expect(backend.setDroppedSeen).toHaveBeenCalledWith(7, expect.any(Number));
      expect(send).not.toHaveBeenCalled();
      await mod.repollPending(async () => ({ status: 'confirmed', gasUsed: '21000' }));
      expect(send).toHaveBeenCalledWith(
        'payments:tx-recorded',
        expect.objectContaining({ id: 7, status: 'confirmed' })
      );
    });

    test.each([
      ['requirement_unmet', coded('requirement_unmet', "The core can't take this request")],
      [
        'storage',
        coded('storage', 'The payment history could not be read or written', {
          store: 'payments',
          kind: 'busy',
        }),
      ],
      ['core_unavailable', coded('core_unavailable', 'The identity core is not running')],
    ])(
      "a write the core fails (%s) rejects with the core's error and broadcasts nothing",
      async (_name, error) => {
        load({
          append: error,
          update: error,
          markConfirmed: error,
          markFailed: error,
          markDropped: error,
          clear: error,
        });
        await expect(mod.append({ kind: 'x402', chainId: 1, amount: '1' })).rejects.toBe(error);
        await expect(mod.update(1, {})).rejects.toBe(error);
        await expect(mod.markConfirmed(1)).rejects.toBe(error);
        await expect(mod.markFailed(1)).rejects.toBe(error);
        await expect(mod.markDropped(1)).rejects.toBe(error);
        await expect(mod.clear()).rejects.toBe(error);
        expect(send).not.toHaveBeenCalled();
      }
    );

    test('a destroyed webContents send-throwing does not break the broadcast', async () => {
      // Mid-loop throw used to break the rest of the loop. Verify the
      // catch in broadcastTxRecorded keeps the remaining webContents
      // receiving the event.
      const ok = jest.fn();
      const dead = jest.fn(() => {
        throw new Error('destroyed');
      });
      ({ mod } = loadPaymentHistoryModule({
        userDataDir,
        backend: stubBackend({ append: { id: 1, kind: 'x402', status: 'settled' } }),
        webContents: { getAllWebContents: () => [{ send: dead }, { send: ok }] },
      }));
      await mod.append({ kind: 'x402', chainId: BASE_CHAIN, amount: TEN_USDC, status: 'settled' });
      expect(dead).toHaveBeenCalled();
      expect(ok).toHaveBeenCalled();
    });
  });

  // === KINDS / STATUSES re-export ========================================

  test('exposes KINDS and STATUSES constants for callers', () => {
    expect(mod.KINDS).toMatchObject({
      X402: 'x402',
      WALLET_SEND: 'wallet-send',
      DAPP_SEND: 'dapp-send',
    });
    expect(mod.STATUSES).toMatchObject({
      PENDING: 'pending',
      CONFIRMED: 'confirmed',
      FAILED: 'failed',
      SETTLED: 'settled',
      NO_RECEIPT: 'no-receipt',
    });
  });

  // === IPC handlers ====================================================

  describe('registerPaymentHistoryIpc', () => {
    let ipcMain;
    beforeEach(() => {
      // Re-load the module with a captured ipcMain so we can drive the
      // registered handlers directly.
      ({ mod, ipcMain, sim } = loadPaymentHistoryModule({ userDataDir }));
      mod.registerPaymentHistoryIpc();
    });

    test('payments:get-recent forwards filters to the core, as the chrome', async () => {
      await mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      await mod.append({ kind: 'wallet-send', chainId: 1, amount: '2' });

      const result = await ipcMain.invoke('payments:get-recent', { kind: 'x402' });
      expect(result.success).toBe(true);
      expect(result.payments).toHaveLength(1);
      expect(result.payments[0]).toMatchObject({ kind: 'x402' });
      expect(sim.calls.at(-1)).toEqual(['payments.get_recent', 'chrome']);
    });

    test('payments:get-recent drops unknown filter keys silently', async () => {
      await mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      const result = await ipcMain.invoke('payments:get-recent', { kind: 'x402', bogus: 'foo' });
      expect(result.success).toBe(true);
      expect(result.payments).toHaveLength(1);
    });

    test('payments:get-recent is robust to a JSON-wire __proto__ own-property attack', async () => {
      await mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      // Object literals treat `__proto__` as the prototype-setting form,
      // not an own property — IPC payloads come off the wire via
      // structured-clone / JSON.parse, which DOES create an own __proto__.
      const malicious = JSON.parse('{"kind":"x402","__proto__":{"evil":true}}');
      const result = await ipcMain.invoke('payments:get-recent', malicious);
      expect(result.success).toBe(true);
      expect(result.payments).toHaveLength(1);
      expect({}.evil).toBeUndefined();
    });

    test('payments:get-recent clamps oversized limit to MAX_LIMIT', async () => {
      for (let i = 0; i < 5; i++) {
        await mod.append({ kind: 'x402', chainId: 1, amount: String(i + 1), status: 'settled' });
      }
      const result = await ipcMain.invoke('payments:get-recent', { limit: 10_000_000 });
      expect(result.success).toBe(true);
      expect(result.payments).toHaveLength(5);
    });

    test('payments:get-by-id returns the row', async () => {
      const row = await mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      const result = await ipcMain.invoke('payments:get-by-id', row.id);
      expect(result.success).toBe(true);
      expect(result.payment.id).toBe(row.id);
      expect(sim.calls.at(-1)).toEqual(['payments.get_by_id', 'chrome']);
    });

    test('payments:get-by-id rejects non-integer id, unsent', async () => {
      const result = await ipcMain.invoke('payments:get-by-id', 'not-an-int');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/integer/);
      expect(sim.calls).toEqual([]);
    });

    test('payments:get-count respects filters', async () => {
      await mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      await mod.append({ kind: 'wallet-send', chainId: 1, amount: '2' });
      const result = await ipcMain.invoke('payments:get-count', { kind: 'x402' });
      expect(result).toEqual({ success: true, count: 1 });
      expect(sim.calls.at(-1)).toEqual(['payments.get_count', 'chrome']);
    });

    test('payments:clear empties the table', async () => {
      await mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      await mod.append({ kind: 'wallet-send', chainId: 1, amount: '2' });
      const result = await ipcMain.invoke('payments:clear');
      expect(result).toEqual({ success: true, removed: 2 });
      expect(sim.calls.at(-1)).toEqual(['payments.clear', 'chrome']);
      expect(await mod.getCount({})).toBe(0);
    });

    test('a core that can’t serve the store answers each handler’s failure', async () => {
      ({ mod, ipcMain } = loadPaymentHistoryModule({ userDataDir, sim: { moved: false } }));
      mod.registerPaymentHistoryIpc();
      const failure = { success: false, error: "The core can't take this request" };
      expect(await ipcMain.invoke('payments:get-recent', {})).toEqual(failure);
      expect(await ipcMain.invoke('payments:get-by-id', 1)).toEqual(failure);
      expect(await ipcMain.invoke('payments:get-count', {})).toEqual(failure);
      expect(await ipcMain.invoke('payments:clear')).toEqual(failure);
    });

    test('a refused filter answers the refusal', async () => {
      const result = await ipcMain.invoke('payments:get-recent', null);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Cannot read properties of null/);
    });
  });
});

// Coordinator call G27: no Jest global setup spies on better-sqlite3 across
// the suites, so this one does for the module that used to open the
// database, and the integration suite does for the real flows.
describe('main opens no payment-history.sqlite', () => {
  let userDataDir;

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
  });

  afterEach(() => {
    removeTempUserDataDir(userDataDir);
  });

  test("every function, handler and sweep goes to the core, and better-sqlite3's constructor sees no open of it", async () => {
    const opened = [];
    function GuardedDatabase(file) {
      opened.push(String(file));
      if (/payment-history\.sqlite/.test(String(file))) {
        throw new Error('main opened payment-history.sqlite');
      }
      return new FakeBetterSqlite3PaymentsDatabase(file);
    }
    const row = { id: 1, kind: 'wallet-send', status: 'pending', txHash: '0xa' };
    const backend = stubBackend({
      append: row,
      update: row,
      markConfirmed: row,
      markFailed: row,
      markDropped: row,
      pending: [{ id: 1, tx_hash: '0xa', chain_id: 1, status: 'pending', metadata: null }],
      getRecent: [row],
      getById: row,
      getCount: 1,
      clear: 1,
    });
    const { mod, ipcMain } = loadPaymentHistoryModule({
      userDataDir,
      backend,
      betterSqlite3: () => GuardedDatabase,
    });
    mod.registerPaymentHistoryIpc();
    await mod.append({ kind: 'x402', chainId: 1, amount: '1' });
    await mod.update(1, {});
    await mod.markConfirmed(1);
    await mod.markFailed(1);
    await mod.markDropped(1);
    await mod.getRecent({});
    await mod.getById(1);
    await mod.getCount({});
    await mod.clear();
    await mod.repollPending(async () => ({ status: 'dropped' }));
    await mod.repollPending(async () => ({ status: 'confirmed' }));
    for (const [channel, arg] of [
      ['payments:get-recent', {}],
      ['payments:get-by-id', 1],
      ['payments:get-count', {}],
      ['payments:clear', undefined],
    ]) {
      expect((await ipcMain.invoke(channel, arg)).success).toBe(true);
    }
    expect(opened).toEqual([]);
    expect(
      fs.readdirSync(userDataDir).filter((name) => name.startsWith('payment-history'))
    ).toEqual([]);
  });

  test('none of its former callers requires better-sqlite3 or names the database', () => {
    for (const file of [
      'payment-history.js',
      'index.js',
      'wallet/tx-recorder.js',
      'wallet/intent-ipc.js',
      'x402/intercept.js',
      'x402/ipc.js',
    ]) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect([file, /require\(['"]better-sqlite3['"]\)/.test(source)]).toEqual([file, false]);
      if (file !== 'payment-history.js') {
        expect([file, source.includes('payment-history.sqlite')]).toEqual([file, false]);
      }
    }
  });
});
