const fs = require('fs');
const path = require('path');
const FakeBetterSqlite3PaymentsDatabase = require('../../test/helpers/fake-better-sqlite3-payments');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');

function loadPaymentHistoryModule(options = {}) {
  return loadMainModule(require.resolve('./payment-history'), {
    ...options,
    extraMocks: {
      'better-sqlite3': () => FakeBetterSqlite3PaymentsDatabase,
      [require.resolve('./logger')]: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    },
  });
}

// Common test fixtures
const BASE_CHAIN = 8453;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TEN_USDC = '10000000';
const ORIGIN = 'https://api.example.com';
const URL_FULL = 'https://api.example.com/article/42';
const PAY_TO = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const FROM_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('payment-history (sqlite)', () => {
  let userDataDir;
  let mod;

  // Each test gets a fresh module + fresh fake DB rooted at a fresh
  // temp userData. Migration tests that need to seed a legacy JSON
  // file before module load override this via `seedLegacy` + a manual
  // reload (see `migrateFromJson` describe block).
  beforeEach(() => {
    userDataDir = createTempUserDataDir();
    ({ mod } = loadPaymentHistoryModule({ userDataDir }));
  });

  afterEach(() => {
    if (mod?.closeDb) mod.closeDb();
    removeTempUserDataDir(userDataDir);
  });

  // Reload the module against the same temp dir — used by migration
  // tests that need to seed the legacy JSON file *before* the first
  // module load.
  function reloadFresh() {
    if (mod?.closeDb) mod.closeDb();
    ({ mod } = loadPaymentHistoryModule({ userDataDir }));
  }

  // === append ============================================================

  describe('append', () => {
    test('inserts an x402 record born settled', () => {
    const entry = mod.append({
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
    });

    test('inserts a wallet-send record born pending', () => {
    const entry = mod.append({
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

    test('rejects an unknown kind', () => {
    expect(() =>
        mod.append({ kind: 'lightning', chainId: 1, amount: '1' })
      ).toThrow(/unknown kind/);
    });

    test('rejects non-digit amount and non-finite chainId', () => {
    expect(() =>
        mod.append({ kind: 'x402', chainId: 1, amount: 'ten' })
      ).toThrow(/amount must be a digit string/);
      expect(() =>
        mod.append({ kind: 'x402', chainId: NaN, amount: '1' })
      ).toThrow(/chainId must be a finite number/);
    });

    test('serialises metadata as JSON', () => {
    const entry = mod.append({
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
    test('markConfirmed transitions pending → confirmed and stamps gas', () => {
    const pending = mod.append({
        kind: 'wallet-send', chainId: 1, txHash: '0x1', amount: '1',
      });

      const after = mod.markConfirmed(pending.id, {
        gasUsed: '21000', gasPrice: '20000000000',
      });

      expect(after).toMatchObject({
        id: pending.id,
        status: 'confirmed',
        gasUsed: '21000',
        gasPrice: '20000000000',
      });
      expect(after.confirmedAt).toBeGreaterThanOrEqual(pending.createdAt);
    });

    test('markFailed records the reason in metadata', () => {
    const pending = mod.append({ kind: 'wallet-send', chainId: 1, amount: '1' });
      const after = mod.markFailed(pending.id, { reason: 'reverted' });
      expect(after.status).toBe('failed');
      expect(after.metadata).toEqual({ failureReason: 'reverted' });
    });

    test('update is partial — unspecified fields are preserved', () => {
    const original = mod.append({
        kind: 'wallet-send', chainId: 1, txHash: '0xorig', amount: '1',
      });
      const after = mod.update(original.id, { status: 'confirmed' });
      expect(after.txHash).toBe('0xorig');
      expect(after.status).toBe('confirmed');
    });

    test('update of a non-existent id returns null', () => {
    expect(mod.update(999, { status: 'confirmed' })).toBeNull();
    });
  });

  // === getRecent + filters ==============================================

  describe('getRecent', () => {
    test('returns rows newest-first, honors limit + offset', () => {
    // Insert three with explicit createdAt so we control ordering.
      mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled', createdAt: 1000 });
      mod.append({ kind: 'x402', chainId: 1, amount: '2', status: 'settled', createdAt: 3000 });
      mod.append({ kind: 'x402', chainId: 1, amount: '3', status: 'settled', createdAt: 2000 });

      const all = mod.getRecent({});
      expect(all.map((r) => r.amount)).toEqual(['2', '3', '1']);

      const limited = mod.getRecent({ limit: 2 });
      expect(limited.map((r) => r.amount)).toEqual(['2', '3']);

      const offset = mod.getRecent({ limit: 2, offset: 1 });
      expect(offset.map((r) => r.amount)).toEqual(['3', '1']);
    });

    test('filters by kind, chainId, origin, status', () => {
    mod.append({ kind: 'x402', chainId: 8453, origin: 'https://a.example', amount: '1', status: 'settled' });
      mod.append({ kind: 'x402', chainId: 1,    origin: 'https://b.example', amount: '2', status: 'settled' });
      mod.append({ kind: 'wallet-send', chainId: 8453, amount: '3', status: 'pending' });

      expect(mod.getRecent({ kind: 'x402' })).toHaveLength(2);
      expect(mod.getRecent({ chainId: 8453 })).toHaveLength(2);
      expect(mod.getRecent({ origin: 'https://a.example' })).toHaveLength(1);
      expect(mod.getRecent({ status: 'pending' })).toHaveLength(1);
      expect(mod.getRecent({ kind: 'x402', chainId: 8453 })).toHaveLength(1);
    });
  });

  describe('getCount', () => {
    test('counts respect the same filter set as getRecent', () => {
    mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      mod.append({ kind: 'wallet-send', chainId: 1, amount: '2' });
      mod.append({ kind: 'dapp-send', chainId: 8453, amount: '3' });
      expect(mod.getCount({})).toBe(3);
      expect(mod.getCount({ kind: 'x402' })).toBe(1);
      expect(mod.getCount({ chainId: 1 })).toBe(2);
    });
  });

  describe('getById / clear / removeById', () => {
    test('round-trip + clear wipes everything', () => {
    const e1 = mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      expect(mod.getById(e1.id).id).toBe(e1.id);

      expect(mod.clear()).toBe(1);
      expect(mod.getRecent({})).toEqual([]);
    });

    test('removeById drops one row', () => {
    const e1 = mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      mod.append({ kind: 'x402', chainId: 1, amount: '2', status: 'settled' });
      expect(mod.removeById(e1.id)).toBe(true);
      expect(mod.getCount({})).toBe(1);
      expect(mod.removeById(999)).toBe(false);
    });
  });

  // === legacy x402-receipts.json migration ==============================

  describe('migrateFromJson', () => {
    function seedLegacy(entries) {
      const filePath = path.join(userDataDir, 'x402-receipts.json');
      fs.writeFileSync(filePath, JSON.stringify(entries));
      return filePath;
    }

    test('imports each receipt as kind=x402 and renames the file to .migrated', () => {
      const legacyPath = seedLegacy([
        {
          id: 'r-1700000000-0',
          url: URL_FULL,
          origin: ORIGIN,
          chainId: BASE_CHAIN,
          asset: USDC_BASE,
          amount: TEN_USDC,
          txHash: '0xabc',
          status: 'settled',
          settledAt: 1700000000,
        },
      ]);

      mod.getDb(); // first open triggers migration

      const all = mod.getRecent({});
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        kind: 'x402',
        chainId: BASE_CHAIN,
        asset: USDC_BASE,
        amount: TEN_USDC,
        txHash: '0xabc',
        status: 'settled',
        origin: ORIGIN,
        url: URL_FULL,
      });
      // settledAt seconds → createdAt ms
      expect(all[0].createdAt).toBe(1700000000 * 1000);
      expect(all[0].metadata).toEqual({ legacyId: 'r-1700000000-0' });

      expect(fs.existsSync(legacyPath)).toBe(false);
      expect(fs.existsSync(legacyPath + '.migrated')).toBe(true);
    });

    test('a stray legacy file on subsequent boots is dropped, not re-imported', () => {
      // First boot: migrate one entry, .migrated breadcrumb gets written.
      seedLegacy([
        { chainId: 1, asset: USDC_BASE, amount: '1', status: 'settled', settledAt: 1700000000 },
      ]);
      mod.getDb();
      expect(fs.existsSync(path.join(userDataDir, 'x402-receipts.json') + '.migrated')).toBe(true);

      // Simulate a stale legacy file reappearing (user restored a backup).
      // After reloading the module, the breadcrumb should drop the stray
      // file without touching the DB.
      fs.writeFileSync(
        path.join(userDataDir, 'x402-receipts.json'),
        JSON.stringify([{ chainId: 1, asset: USDC_BASE, amount: '99', status: 'settled', settledAt: 1700000001 }])
      );

      reloadFresh();
      mod.getDb();

      // The stray file is removed; no second-import row appears. The fake
      // DB is fresh per module reload, so we can't assert "row from boot
      // #1 carried over" — only that boot #2 didn't insert anything new.
      expect(fs.existsSync(path.join(userDataDir, 'x402-receipts.json'))).toBe(false);
      expect(mod.getCount({})).toBe(0);
    });

    test('a failed rename does not duplicate entries if migration runs again', () => {
      const legacyPath = seedLegacy([
        {
          chainId: BASE_CHAIN,
          asset: USDC_BASE,
          amount: TEN_USDC,
          txHash: '0xabc',
          status: 'settled',
          settledAt: 1700000000,
          url: URL_FULL,
          origin: ORIGIN,
        },
      ]);
      const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('rename denied');
      });

      try {
        mod.getDb();
        expect(fs.existsSync(legacyPath)).toBe(true);
        expect(mod.getCount({})).toBe(1);

        mod._migrateFromJsonForTest();
        expect(mod.getCount({})).toBe(1);
      } finally {
        renameSpy.mockRestore();
      }
    });

    test('a malformed legacy file does not abort startup; the file stays as a breadcrumb', () => {
      const legacyPath = path.join(userDataDir, 'x402-receipts.json');
      fs.writeFileSync(legacyPath, 'not valid json {{{');

      expect(() => mod.getDb()).not.toThrow();
      expect(fs.existsSync(legacyPath)).toBe(true);
    });
  });

  // === repollPending =====================================================

  describe('repollPending', () => {
    test('resolves pending rows according to the supplied status fn', async () => {
    const r1 = mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const r2 = mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xb', amount: '2' });
      const r3 = mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xc', amount: '3' });

      const fakeStatus = jest.fn(async (txHash) => {
        if (txHash === '0xa') return { status: 'confirmed', gasUsed: '21000', gasPrice: '10' };
        if (txHash === '0xb') return { status: 'failed' };
        return { status: 'pending' };
      });

      const summary = await mod.repollPending(fakeStatus);
      expect(summary).toEqual({ resolved: 2, stillPending: 1, errors: 0 });

      expect(mod.getById(r1.id).status).toBe('confirmed');
      expect(mod.getById(r1.id).gasUsed).toBe('21000');
      expect(mod.getById(r2.id).status).toBe('failed');
      expect(mod.getById(r3.id).status).toBe('pending');
    });

    test('a thrown error counts but does not corrupt the row', async () => {
    const row = mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const summary = await mod.repollPending(async () => {
        throw new Error('rpc down');
      });
      expect(summary.errors).toBe(1);
      expect(mod.getById(row.id).status).toBe('pending');
    });

    // The clock repollPending reads; tests step it past the confirm window.
    let clock;
    function useClock(start = 1_000_000) {
      clock = start;
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
    }
    afterEach(() => { jest.restoreAllMocks(); });

    // #749: a dropped transaction never gets a receipt; once another
    // transaction takes its nonce the row resolves instead of staying
    // pending forever. One sighting is not enough: a later sweep, at least
    // DROPPED_CONFIRM_MS on, must see it again.
    test('resolves a row whose nonce another transaction took as dropped', async () => {
      useClock();
      const dropped = mod.append({
        kind: 'safe-send', chainId: 1, txHash: '0xdropped', amount: '1',
        metadata: { safeAddress: '0xsafe', txFrom: FROM_ADDR, txNonce: 0 },
      });
      const resend = mod.append({
        kind: 'wallet-send', chainId: 1, txHash: '0xresend', amount: '1',
        metadata: { txFrom: FROM_ADDR, txNonce: 0 },
      });
      const fakeStatus = jest.fn(async (txHash) => (
        txHash === '0xresend' ? { status: 'confirmed', gasUsed: '21000' } : { status: 'dropped' }
      ));

      await expect(mod.repollPending(fakeStatus)).resolves.toEqual({
        resolved: 1, stillPending: 1, errors: 0,
      });
      expect(fakeStatus).toHaveBeenCalledWith('0xdropped', 1, { from: FROM_ADDR, nonce: 0, sweep: true });
      expect(mod.getById(dropped.id)).toMatchObject({
        status: 'pending',
        metadata: { safeAddress: '0xsafe', txDroppedSeenAt: clock },
      });
      expect(mod.getById(resend.id).status).toBe('confirmed');

      clock += mod.DROPPED_CONFIRM_MS;
      await expect(mod.repollPending(fakeStatus)).resolves.toEqual({
        resolved: 1, stillPending: 0, errors: 0,
      });
      const row = mod.getById(dropped.id);
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
      const row = mod.append({
        kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1',
        metadata: { txFrom: FROM_ADDR, txNonce: 0 },
      });
      await mod.repollPending(async () => {
        mod.markFailed(row.id, { reason: 'reverted' });
        return { status: 'dropped' };
      });
      const after = mod.getById(row.id);
      expect(after.status).toBe('failed');
      expect(after.metadata).toEqual({ failureReason: 'reverted' });
      expect(after.metadata.txDroppedSeenAt).toBeUndefined();
    });

    // R4-M1: the confirming sweep's 'dropped' answer is also stale once
    // its lookup resolves; a final status written meanwhile stands.
    test.each([
      ['confirmed', (id) => mod.markConfirmed(id, { gasUsed: '21000' }), { txFrom: FROM_ADDR, txNonce: 0 }],
      ['failed', (id) => mod.markFailed(id, { reason: 'reverted' }), { failureReason: 'reverted' }],
    ])('a confirming sweep does not overwrite a row %s during its lookup', async (status, finalise, metadata) => {
      useClock();
      const row = mod.append({
        kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1',
        metadata: { txFrom: FROM_ADDR, txNonce: 0 },
      });
      await mod.repollPending(async () => ({ status: 'dropped' }));
      const seenAt = mod.getById(row.id).metadata.txDroppedSeenAt;
      clock += mod.DROPPED_CONFIRM_MS;
      await expect(mod.repollPending(async () => {
        finalise(row.id);
        return { status: 'dropped' };
      })).resolves.toEqual({ resolved: 0, stillPending: 0, errors: 0 });
      const after = mod.getById(row.id);
      expect(after.status).toBe(status);
      expect(after.metadata).toEqual(status === 'confirmed'
        ? { ...metadata, txDroppedSeenAt: seenAt }
        : metadata);
    });

    test('markDropped leaves a row that is no longer pending alone', () => {
      const row = mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      mod.markConfirmed(row.id, {});
      expect(mod.markDropped(row.id)).toBeNull();
      expect(mod.getById(row.id).status).toBe('confirmed');
    });

    test('a pending answer clears the sighting without dropping concurrent metadata', async () => {
      useClock();
      const row = mod.append({
        kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1',
        metadata: { txFrom: FROM_ADDR, txNonce: 0 },
      });
      await mod.repollPending(async () => ({ status: 'dropped' }));
      await mod.repollPending(async () => {
        mod.update(row.id, { metadata: { ...mod.getById(row.id).metadata, note: 'added' } });
        return { status: 'pending' };
      });
      expect(mod.getById(row.id).metadata).toEqual({ txFrom: FROM_ADDR, txNonce: 0, note: 'added' });
    });

    test('a second sighting inside the confirm window leaves the row pending', async () => {
      useClock();
      const row = mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const fn = async () => ({ status: 'dropped' });
      await mod.repollPending(fn);
      const firstSeen = clock;
      clock += mod.DROPPED_CONFIRM_MS - 1;
      await expect(mod.repollPending(fn)).resolves.toMatchObject({ resolved: 0, stillPending: 1 });
      // The window still counts from the first sighting.
      expect(mod.getById(row.id)).toMatchObject({
        status: 'pending', metadata: { txDroppedSeenAt: firstSeen },
      });
      clock += 1;
      await expect(mod.repollPending(fn)).resolves.toMatchObject({ resolved: 1 });
      expect(mod.getById(row.id).status).toBe('dropped');
    });

    // A lagging endpoint read a just-mined transaction as dropped once; the
    // next read that sees it pending again must reset, not confirm, that.
    test('a pending answer between sightings starts the window over', async () => {
      useClock();
      const row = mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      await mod.repollPending(async () => ({ status: 'dropped' }));
      clock += 1000;
      await mod.repollPending(async () => ({ status: 'pending' }));
      expect(mod.getById(row.id).metadata?.txDroppedSeenAt).toBeUndefined();
      clock += mod.DROPPED_CONFIRM_MS;
      await mod.repollPending(async () => ({ status: 'dropped' }));
      expect(mod.getById(row.id)).toMatchObject({
        status: 'pending', metadata: { txDroppedSeenAt: clock },
      });
    });

    test('a waiting sighting schedules its own confirming sweep', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      try {
        const row = mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
        const fn = jest.fn(async () => ({ status: 'dropped' }));
        await mod.repollPending(fn);
        expect(mod.getById(row.id).status).toBe('pending');
        expect(fn).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(mod.DROPPED_CONFIRM_MS);
        for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
        expect(fn).toHaveBeenCalledTimes(2);
        expect(mod.getById(row.id).status).toBe('dropped');
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    test('a dropped row is final and is not polled again', async () => {
      useClock();
      mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      await mod.repollPending(async () => ({ status: 'dropped' }));
      clock += mod.DROPPED_CONFIRM_MS;
      await mod.repollPending(async () => ({ status: 'dropped' }));
      const fn = jest.fn();
      await expect(mod.repollPending(fn)).resolves.toEqual({ resolved: 0, stillPending: 0, errors: 0 });
      expect(fn).not.toHaveBeenCalled();
    });

    test('a row recorded without a sender nonce is polled without one', async () => {
      mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const fn = jest.fn(async () => ({ status: 'pending' }));
      await mod.repollPending(fn);
      expect(fn).toHaveBeenCalledWith('0xa', 1, { from: undefined, nonce: undefined, sweep: true });
    });

    test('a call during a sweep queues one more sweep after it, shared by every caller', async () => {
      mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const releases = [];
      const fn = jest.fn(() => new Promise((resolve) => { releases.push(resolve); }));
      const first = mod.repollPending(fn);
      const second = mod.repollPending(fn);
      const third = mod.repollPending(fn);
      expect(second).not.toBe(first);
      expect(third).toBe(second);
      await new Promise((resolve) => setImmediate(resolve));
      expect(fn).toHaveBeenCalledTimes(1);
      // The running sweep read the row before the chain moved.
      releases[0]({ status: 'pending' });
      await expect(first).resolves.toMatchObject({ resolved: 0, stillPending: 1 });
      await new Promise((resolve) => setImmediate(resolve));
      // The queued sweep re-reads it, now that the nonce has moved.
      expect(fn).toHaveBeenCalledTimes(2);
      releases[1]({ status: 'confirmed' });
      await expect(second).resolves.toMatchObject({ resolved: 1, stillPending: 0 });
      expect(fn).toHaveBeenCalledTimes(2);
    });

    // The running sweep has settled but the queued one has not started yet:
    // a caller in that gap joins the queued sweep instead of starting a third.
    test('a call between a sweep settling and the queued one starting joins the queued one', async () => {
      mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const releases = [];
      const fn = jest.fn(() => new Promise((resolve) => { releases.push(resolve); }));
      const first = mod.repollPending(fn);
      const second = mod.repollPending(fn);
      await new Promise((resolve) => setImmediate(resolve));
      releases[0]({ status: 'pending' });
      await first;
      const late = mod.repollPending(fn);
      expect(late).toBe(second);
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
      releases[1]({ status: 'confirmed' });
      await second;
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('a queued sweep still runs when the sweep before it fails', async () => {
      mod.append({ kind: 'wallet-send', chainId: 1, txHash: '0xa', amount: '1' });
      const first = mod.repollPending(() => { throw new Error('boom'); });
      const second = mod.repollPending(async () => ({ status: 'confirmed' }));
      await first;
      await expect(second).resolves.toMatchObject({ resolved: 1 });
    });

    test('pending rows with no txHash are skipped, not polled', async () => {
    mod.append({ kind: 'wallet-send', chainId: 1, amount: '1' }); // no txHash
      const fn = jest.fn();
      const summary = await mod.repollPending(fn);
      expect(fn).not.toHaveBeenCalled();
      expect(summary.stillPending).toBe(1);
    });
  });

  // === payments:tx-recorded broadcast ====================================

  describe('payments:tx-recorded broadcast', () => {
    let send;
    beforeEach(() => {
      if (mod?.closeDb) mod.closeDb();
      send = jest.fn();
      ({ mod } = loadPaymentHistoryModule({
        userDataDir,
        webContents: { getAllWebContents: () => [{ send }, { send }] },
      }));
    });

    test('append broadcasts the inserted row to every webContents', () => {
      const entry = mod.append({
        kind: 'x402', chainId: BASE_CHAIN, asset: USDC_BASE,
        amount: TEN_USDC, txHash: '0xabc', status: 'settled',
      });
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledWith('payments:tx-recorded', {
        id: entry.id, kind: 'x402', status: 'settled', txHash: '0xabc',
      });
    });

    test('markConfirmed broadcasts the updated row', () => {
      const pending = mod.append({
        kind: 'wallet-send', chainId: 1, txHash: '0x1', amount: '1',
      });
      send.mockClear();
      mod.markConfirmed(pending.id, { gasUsed: '21000', gasPrice: '20000000000' });
      expect(send).toHaveBeenCalledWith('payments:tx-recorded',
        expect.objectContaining({ id: pending.id, status: 'confirmed' }));
    });

    test('markFailed broadcasts the updated row', () => {
      const pending = mod.append({
        kind: 'wallet-send', chainId: 1, txHash: '0x2', amount: '1',
      });
      send.mockClear();
      mod.markFailed(pending.id, { reason: 'reverted' });
      expect(send).toHaveBeenCalledWith('payments:tx-recorded',
        expect.objectContaining({ id: pending.id, status: 'failed' }));
    });

    test('clear broadcasts a null-id sentinel so listeners re-query an empty table', () => {
      mod.append({ kind: 'x402', chainId: BASE_CHAIN, amount: TEN_USDC, status: 'settled' });
      send.mockClear();
      mod.clear();
      expect(send).toHaveBeenCalledWith('payments:tx-recorded', { id: null });
    });

    test('removeById broadcasts on a successful delete and stays quiet on a miss', () => {
      const row = mod.append({ kind: 'x402', chainId: BASE_CHAIN, amount: TEN_USDC, status: 'settled' });
      send.mockClear();
      mod.removeById(row.id);
      expect(send).toHaveBeenCalledWith('payments:tx-recorded', { id: null });

      send.mockClear();
      mod.removeById(99999);
      expect(send).not.toHaveBeenCalled();
    });

    test('a destroyed webContents send-throwing does not break the broadcast', () => {
      // Mid-loop throw used to break the rest of the loop. Verify the
      // catch in broadcastTxRecorded keeps the remaining webContents
      // receiving the event.
      const ok = jest.fn();
      const dead = jest.fn(() => { throw new Error('destroyed'); });
      if (mod?.closeDb) mod.closeDb();
      ({ mod } = loadPaymentHistoryModule({
        userDataDir,
        webContents: { getAllWebContents: () => [{ send: dead }, { send: ok }] },
      }));
      mod.append({
        kind: 'x402', chainId: BASE_CHAIN, amount: TEN_USDC, status: 'settled',
      });
      expect(dead).toHaveBeenCalled();
      expect(ok).toHaveBeenCalled();
    });
  });

  // === KINDS / STATUSES re-export ========================================

  test('exposes KINDS and STATUSES constants for callers', () => {
expect(mod.KINDS).toMatchObject({ X402: 'x402', WALLET_SEND: 'wallet-send', DAPP_SEND: 'dapp-send' });
    expect(mod.STATUSES).toMatchObject({
      PENDING: 'pending', CONFIRMED: 'confirmed', FAILED: 'failed',
      SETTLED: 'settled', NO_RECEIPT: 'no-receipt',
    });
  });

  // === IPC handlers ====================================================

  describe('registerPaymentHistoryIpc', () => {
    let ipcMain;
    beforeEach(() => {
      // Re-load the module with a captured ipcMain so we can drive the
      // registered handlers directly.
      if (mod?.closeDb) mod.closeDb();
      ({ mod, ipcMain } = loadPaymentHistoryModule({ userDataDir }));
      mod.registerPaymentHistoryIpc();
    });

    test('payments:get-recent forwards filters to the store', async () => {
      mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      mod.append({ kind: 'wallet-send', chainId: 1, amount: '2' });

      const result = await ipcMain.invoke('payments:get-recent', { kind: 'x402' });
      expect(result.success).toBe(true);
      expect(result.payments).toHaveLength(1);
      expect(result.payments[0]).toMatchObject({ kind: 'x402' });
    });

    test('payments:get-recent drops unknown filter keys silently', async () => {
      mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      const result = await ipcMain.invoke('payments:get-recent', { kind: 'x402', bogus: 'foo' });
      expect(result.success).toBe(true);
      expect(result.payments).toHaveLength(1);
    });

    test('payments:get-recent is robust to a JSON-wire __proto__ own-property attack', async () => {
      mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
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
        mod.append({ kind: 'x402', chainId: 1, amount: String(i + 1), status: 'settled' });
      }
      const result = await ipcMain.invoke('payments:get-recent', { limit: 10_000_000 });
      // We can't observe the clamp directly here, but a 5-row table with a
      // huge limit still returns 5 rows — i.e. doesn't throw or hang on
      // a query the SQL layer would otherwise be forced to materialise.
      expect(result.success).toBe(true);
      expect(result.payments).toHaveLength(5);
    });

    test('payments:get-by-id returns the row', async () => {
      const row = mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      const result = await ipcMain.invoke('payments:get-by-id', row.id);
      expect(result.success).toBe(true);
      expect(result.payment.id).toBe(row.id);
    });

    test('payments:get-by-id rejects non-integer id', async () => {
      const result = await ipcMain.invoke('payments:get-by-id', 'not-an-int');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/integer/);
    });

    test('payments:get-count respects filters', async () => {
      mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      mod.append({ kind: 'wallet-send', chainId: 1, amount: '2' });
      const result = await ipcMain.invoke('payments:get-count', { kind: 'x402' });
      expect(result).toEqual({ success: true, count: 1 });
    });

    test('payments:clear empties the table', async () => {
      mod.append({ kind: 'x402', chainId: 1, amount: '1', status: 'settled' });
      mod.append({ kind: 'wallet-send', chainId: 1, amount: '2' });
      const result = await ipcMain.invoke('payments:clear');
      expect(result).toEqual({ success: true, removed: 2 });
      expect(mod.getCount({})).toBe(0);
    });
  });
});
