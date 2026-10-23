jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  createIntentTracker,
  SCHEDULE,
  CONCURRENCY,
  COULDNT_CONFIRM_AFTER_MS,
} = require('./intent-tracker');
const { fakeFinalityChain } = require('../../../test/helpers/fake-finality-chain');

const SENDER = '0x1111111111111111111111111111111111111111';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
const hashOf = (i) => `0x${i.toString(16).padStart(64, '0')}`;

function intent(n, overrides = {}) {
  return {
    intentId: `intent-${String(n).padStart(4, '0')}`,
    chainId: 1,
    sender: SENDER,
    nonce: n,
    state: 'held',
    hashes: [{ hash: hashOf(n) }],
    handoffs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// The store's surface the tracker uses, over a map.
function fakeStore(intents = []) {
  const map = new Map(intents.map((i) => [i.intentId, i]));
  const listeners = new Set();
  const changed = (id) => listeners.forEach((listener) => listener(id));
  return {
    ready: Promise.resolve(),
    held: () =>
      [...map.values()].filter((i) => i.state === 'held').sort((a, b) => a.nonce - b.nonce),
    get: (id) => map.get(id) ?? null,
    // As the real store: conditional on the hashes the label was read for.
    settle: jest.fn(async ({ intentId, label, hash, block, hashes }) => {
      const settled = map.get(intentId);
      const now = settled.hashes.map((entry) => entry.hash);
      if (hashes && (hashes.length !== now.length || hashes.some((h, i) => h !== now[i]))) {
        throw Object.assign(new Error('changed'), { code: 'INTENT_CHANGED' });
      }
      settled.state = 'settled';
      settled.settlement = { label, hash, block };
      changed(intentId);
      return settled;
    }),
    // As the real store: the tracker's state of a held intent, told to
    // no listener.
    track: jest.fn(async ({ intentId, bracket, unreadSince }) => {
      const tracked = map.get(intentId);
      if (!tracked || tracked.state !== 'held') {
        throw Object.assign(new Error('not held'), { code: 'INTENT_NOT_HELD' });
      }
      map.set(intentId, { ...tracked, bracket, unreadSince });
      return map.get(intentId);
    }),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    put(i) {
      map.set(i.intentId, i);
      changed(i.intentId);
    },
  };
}

/**
 * A chain where `mined` (nonce → status) are included at block 90, the
 * finalized block is 100 and the sender's finalized count `count`.
 */
/**
 * A chain (fake-finality-chain.js) where the sender's finalized nonce is
 * `count`: `mined` (nonce → status) are its own transactions, included at
 * block 90 below the finalized 100, and `takenAt` a nonce another
 * transaction of the sender used there.
 */
function chainReads({ count = 0, mined = {}, takenAt = null } = {}) {
  const txs = Object.entries(mined).map(([nonce, status]) => ({
    hash: hashOf(Number(nonce)),
    nonce: Number(nonce),
    status,
  }));
  if (takenAt !== null) txs.push({ hash: hashOf(0xeeee), nonce: takenAt, status: 1 });
  return fakeFinalityChain({
    sender: SENDER,
    startNonce: count - txs.length,
    txs: { 90: txs },
  }).request;
}

function tracker({ store, request = chainReads(), coreReady = () => true, ...rest }) {
  const recordSettlement = jest.fn();
  const instance = createIntentTracker({ store, request, recordSettlement, coreReady, ...rest });
  return { instance, recordSettlement, request };
}

const finalizedReads = (request) =>
  request.mock.calls.filter(
    ([, method, params]) => method === 'eth_getBlockByNumber' && params[0] === 'finalized'
  ).length;

beforeEach(() => {
  jest.useFakeTimers({ now: T0 });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('the schedule', () => {
  test('a pass shortly after startup, then every 2 minutes while intents are held', async () => {
    const store = fakeStore([intent(5)]);
    const { instance, request } = tracker({ store });
    instance.start();
    expect(instance.nextPassAt()).toBe(T0 + SCHEDULE.startupMs);

    await jest.advanceTimersByTimeAsync(SCHEDULE.startupMs - 1);
    expect(request).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(finalizedReads(request)).toBe(1);
    expect(instance.nextPassAt()).toBe(Date.now() + 2 * MINUTE);

    await jest.advanceTimersByTimeAsync(2 * MINUTE);
    expect(finalizedReads(request)).toBe(2);
    await jest.advanceTimersByTimeAsync(2 * MINUTE);
    expect(finalizedReads(request)).toBe(3);
    instance.stop();
    expect(instance.nextPassAt()).toBeNull();
  });

  test('every 10 minutes once the newest held intent has been quiet for an hour', async () => {
    const store = fakeStore([intent(5)]);
    const { instance, request } = tracker({ store });
    instance.start();
    await jest.advanceTimersByTimeAsync(SCHEDULE.startupMs);
    // An hour of 2-minute passes...
    await jest.advanceTimersByTimeAsync(60 * MINUTE);
    const passes = finalizedReads(request);
    expect(passes).toBe(31);
    // ...then 10 minutes apart.
    expect(instance.nextPassAt() - Date.now()).toBe(10 * MINUTE);
    await jest.advanceTimersByTimeAsync(10 * MINUTE - 1);
    expect(finalizedReads(request)).toBe(passes);
    await jest.advanceTimersByTimeAsync(1);
    expect(finalizedReads(request)).toBe(passes + 1);

    // A new broadcast of a held intent: back to checking soon.
    store.put(intent(6, { handoffs: [{ handoffId: 'h', hash: hashOf(6), at: Date.now() }] }));
    expect(instance.nextPassAt()).toBe(Date.now() + SCHEDULE.afterBroadcastMs);
    await jest.advanceTimersByTimeAsync(SCHEDULE.afterBroadcastMs);
    expect(finalizedReads(request)).toBe(passes + 2);
    expect(instance.nextPassAt() - Date.now()).toBe(2 * MINUTE);
    instance.stop();
  });

  test('about a minute after each broadcast, ahead of the regular pass', async () => {
    const store = fakeStore([intent(5)]);
    const { instance, request } = tracker({ store });
    instance.start();
    await jest.advanceTimersByTimeAsync(SCHEDULE.startupMs);
    expect(instance.nextPassAt() - Date.now()).toBe(2 * MINUTE);

    await jest.advanceTimersByTimeAsync(10 * SECOND);
    const broadcastAt = Date.now();
    store.put(intent(5, { handoffs: [{ handoffId: 'h1', hash: hashOf(5), at: broadcastAt }] }));
    expect(instance.nextPassAt()).toBe(broadcastAt + MINUTE);
    await jest.advanceTimersByTimeAsync(MINUTE);
    expect(finalizedReads(request)).toBe(2);
    instance.stop();
  });

  test('nothing held: no timer, and no reads; a new intent wakes it', async () => {
    const store = fakeStore([]);
    const { instance, request } = tracker({ store });
    instance.start();
    await jest.advanceTimersByTimeAsync(SCHEDULE.startupMs);
    expect(request).not.toHaveBeenCalled();
    expect(instance.nextPassAt()).toBeNull();

    // Committed, not handed off yet: checked at the regular pace.
    store.put(intent(5));
    expect(instance.nextPassAt()).toBe(Date.now() + 2 * MINUTE);
    // Its broadcast: about a minute after it.
    store.put(intent(5, { handoffs: [{ handoffId: 'h1', hash: hashOf(5), at: Date.now() }] }));
    expect(instance.nextPassAt()).toBe(Date.now() + MINUTE);
    await jest.advanceTimersByTimeAsync(MINUTE);
    expect(finalizedReads(request)).toBe(1);
    instance.stop();
  });

  test('settled: the tracker stops when nothing is held', async () => {
    const store = fakeStore([intent(5)]);
    const { instance, request, recordSettlement } = tracker({
      store,
      request: chainReads({ count: 6, mined: { 5: 1 } }),
    });
    instance.start();
    await jest.advanceTimersByTimeAsync(SCHEDULE.startupMs);
    expect(store.settle).toHaveBeenCalledWith({
      intentId: 'intent-0005',
      label: 'paid',
      hash: hashOf(5),
      block: 100,
      hashes: [hashOf(5)],
    });
    expect(recordSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: 'intent-0005', hashes: [{ hash: hashOf(5) }] }),
      { label: 'paid', hash: hashOf(5), block: 100 }
    );
    expect(instance.nextPassAt()).toBeNull();
    await jest.advanceTimersByTimeAsync(60 * MINUTE);
    expect(finalizedReads(request)).toBe(1);
  });
});

describe('the bounds', () => {
  test('no reads while the core is down; it retries soon', async () => {
    const store = fakeStore([intent(5)]);
    let up = false;
    const { instance, request } = tracker({ store, coreReady: () => up });
    instance.start();
    await jest.advanceTimersByTimeAsync(SCHEDULE.startupMs);
    expect(request).not.toHaveBeenCalled();
    expect(instance.nextPassAt()).toBe(Date.now() + SCHEDULE.coreDownMs);
    await jest.advanceTimersByTimeAsync(SCHEDULE.coreDownMs);
    expect(request).not.toHaveBeenCalled();
    up = true;
    await jest.advanceTimersByTimeAsync(SCHEDULE.coreDownMs);
    expect(finalizedReads(request)).toBe(1);
    instance.stop();
  });

  test(`at most ${CONCURRENCY} reads at once, and an identical read once per pass`, async () => {
    // A chain's intents are read one after another (they share its
    // verified headers); the bound shows in a header walk's parallel
    // fetches: intent 1's receipt is 10 blocks below F.
    const store = fakeStore(Array.from({ length: 12 }, (_, i) => intent(i + 1)));
    const reads = chainReads({ count: 2, mined: { 1: 1 } });
    let inFlight = 0;
    let most = 0;
    const request = jest.fn(async (...args) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return reads(...args);
    });
    const { instance } = tracker({ store, request });
    const pass = instance.pass();
    await jest.advanceTimersByTimeAsync(SECOND);
    await pass;
    expect(most).toBe(CONCURRENCY);
    // One finalized block, one count for the sender at its hash, a receipt
    // each, and the 10 headers down to intent 1's block, each once.
    const calls = request.mock.calls.map(([, method, params]) =>
      method === 'eth_getBlockByNumber' && params[0] !== 'finalized' ? 'header' : method
    );
    const tally = calls.reduce((all, call) => ({ ...all, [call]: (all[call] ?? 0) + 1 }), {});
    expect(tally).toEqual({
      eth_getBlockByNumber: 1,
      eth_getTransactionCount: 1,
      eth_getTransactionReceipt: 12,
      header: 10,
    });
    expect(store.get('intent-0001').state).toBe('settled');
  });

  test('a replacement committed while the reads ran is read again before it settles', async () => {
    const first = intent(5);
    const store = fakeStore([first]);
    const reads = chainReads({ count: 6, takenAt: 5 });
    const request = jest.fn(async (...args) => {
      // The user replaced it at nonce 5 meanwhile.
      if (args[1] === 'eth_getTransactionReceipt') {
        store.put({ ...first, hashes: [...first.hashes, { hash: hashOf(0x55) }] });
      }
      return reads(...args);
    });
    const { instance, recordSettlement } = tracker({ store, request });
    await instance.pass();
    // Asked to settle the hashes it read; the store refuses: they changed.
    expect(store.settle).toHaveBeenCalledWith(expect.objectContaining({ hashes: [hashOf(5)] }));
    expect(store.get('intent-0005').state).toBe('held');
    expect(recordSettlement).not.toHaveBeenCalled();
  });
});

describe('what the reads saw', () => {
  test('kept for the display, and announced only when it changes', async () => {
    const store = fakeStore([intent(5)]);
    const { instance } = tracker({ store, request: chainReads({ count: 5 }) });
    const changed = jest.fn();
    instance.onChange(changed);
    await instance.pass();
    expect(instance.observation('intent-0005')).toMatchObject({ observed: 'absent' });
    expect(changed).toHaveBeenCalledTimes(1);
    await instance.pass();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(instance.observation('missing')).toBeNull();
  });
});

// freedom-core #71: a chain with no held intents releases its headers.
test("a chain's verified headers are released with its last held intent", async () => {
  const store = fakeStore([intent(1)]);
  const chain = fakeFinalityChain({
    sender: SENDER,
    startNonce: 1,
    txs: {
      90: [
        { hash: hashOf(1), nonce: 1, status: 1 },
        { hash: hashOf(2), nonce: 2, status: 1 },
      ],
    },
  });
  const { instance } = tracker({ store, request: chain.request });
  const headerReads = () =>
    chain
      .reads()
      .filter(([method, params]) => method === 'eth_getBlockByNumber' && params[0] !== 'finalized')
      .length;

  await instance.pass();
  expect(store.get('intent-0001').state).toBe('settled');
  expect(headerReads()).toBe(10);

  // Nothing was held on the chain after that pass: a new intent walks its
  // headers afresh.
  store.put(intent(2));
  await instance.pass();
  expect(store.get('intent-0002').state).toBe('settled');
  expect(headerReads()).toBe(20);
  instance.stop();
});

// #712 review, round 3: an empty pass can't skip the release, even when
// no store change announced that the chain's last intent closed.
test('an empty pass releases the headers of a chain with nothing held', async () => {
  const held = intent(1);
  const store = fakeStore([held]);
  const chain = fakeFinalityChain({
    sender: SENDER,
    startNonce: 1,
    txs: { 90: [{ hash: hashOf(1), nonce: 1, status: 1 }] },
  });
  // Paid at 90, but the store refuses to settle: still held after the pass.
  store.settle.mockImplementationOnce(async () => {
    throw Object.assign(new Error('changed'), { code: 'INTENT_CHANGED' });
  });
  const { instance } = tracker({ store, request: chain.request });
  await instance.pass();
  expect(instance.verifiedHeaderCount(1)).toBe(11);

  // Closed with no change announced (the tracker hears nothing).
  held.state = 'voided';
  await instance.pass();
  expect(instance.verifiedHeaderCount(1)).toBe(0);
});

// freedom-core design 0005, "State history" (#94).
describe('state history (#94)', () => {
  const OTHER = hashOf(0xeeee);
  const W = 128;
  const DAY = COULDNT_CONFIRM_AFTER_MS;
  // The sender's nonce is 5 before block 1; another transaction of hers
  // uses it at `at`.
  const takenChain = (at, options) =>
    fakeFinalityChain({
      sender: SENDER,
      startNonce: 5,
      txs: at === null ? {} : { [at]: [{ hash: OTHER, nonce: 5, status: 1 }] },
      stateWindow: W,
      ...options,
    });

  describe('the bracket', () => {
    test('the first pass after the commit takes it, later passes move it up while the nonce is unused, and the search then runs above it', async () => {
      // Used at 80. The first pass sees F at 79: unused. By the second, F
      // is 100, 100 below the head: only a search above the bracket stays
      // within the endpoints' window.
      const chain = takenChain(80, { head: 200, finalized: 79 });
      const store = fakeStore([intent(5)]);
      const { instance, recordSettlement } = tracker({ store, request: chain.request });
      await instance.pass();
      expect(store.track).toHaveBeenLastCalledWith({
        intentId: 'intent-0005',
        bracket: { number: 79, hash: chain.canonicalHash(79) },
        unreadSince: null,
      });

      chain.views.canonical.finalized = 100;
      await instance.pass();
      expect(store.get('intent-0005')).toMatchObject({
        state: 'settled',
        settlement: { label: 'taken', block: 100 },
      });
      expect(recordSettlement).toHaveBeenCalledWith(expect.anything(), {
        label: 'taken',
        hash: null,
        block: 100,
      });

      // The same chain without the bracket: the search reaches past the
      // window, and the intent stays held.
      const fresh = fakeStore([intent(5)]);
      const other = tracker({ store: fresh, request: takenChain(80, { head: 200 }).request });
      await other.instance.pass();
      expect(fresh.get('intent-0005').state).toBe('held');
    });

    test('moved up on each pass while unused, and kept with the record', async () => {
      const chain = takenChain(null, { head: 300, finalized: 100, stateWindow: Infinity });
      const store = fakeStore([intent(5)]);
      const { instance } = tracker({ store, request: chain.request });
      for (const finalized of [100, 110, 125]) {
        chain.views.canonical.finalized = finalized;
        await instance.pass();
        expect(store.get('intent-0005').bracket).toEqual({
          number: finalized,
          hash: chain.canonicalHash(finalized),
        });
      }
      // Unchanged: nothing written.
      const writes = store.track.mock.calls.length;
      await instance.pass();
      expect(store.track.mock.calls.length).toBe(writes);
    });
  });

  test('every 2 minutes while a broadcast intent has no label, at its normal pace after', async () => {
    // Held an hour without activity: 10 minutes apart, unless broadcast.
    const chain = fakeFinalityChain({
      sender: SENDER,
      startNonce: 5,
      txs: { 110: [{ hash: hashOf(5), nonce: 5, status: 1 }] },
    });
    const quiet = T0 - 2 * 60 * MINUTE;
    const store = fakeStore([
      intent(4, { createdAt: quiet, updatedAt: quiet }),
      intent(5, { possiblySent: true, createdAt: quiet, updatedAt: quiet }),
    ]);
    const { instance } = tracker({ store, request: chain.request });
    instance.start();
    await jest.advanceTimersByTimeAsync(SCHEDULE.startupMs);
    // Intent 5 is on chain at 110, above F: no label yet.
    expect(store.get('intent-0005').state).toBe('held');
    expect(instance.nextPassAt() - Date.now()).toBe(SCHEDULE.fastMs);
    await jest.advanceTimersByTimeAsync(30 * MINUTE);
    expect(instance.nextPassAt() - Date.now()).toBeLessThanOrEqual(SCHEDULE.fastMs);

    // F passes 110: it is paid, and only the unbroadcast intent 4 is held.
    chain.views.canonical.finalized = 115;
    await jest.advanceTimersByTimeAsync(SCHEDULE.fastMs);
    expect(store.get('intent-0005').state).toBe('settled');
    expect(instance.nextPassAt() - Date.now()).toBe(SCHEDULE.slowMs);
    instance.stop();
  });

  describe("Couldn't confirm", () => {
    // Passes every 2 minutes (the intents are broadcast) for `ms`.
    async function runFor(instance, ms) {
      await jest.advanceTimersByTimeAsync(ms);
      await instance.pass();
    }

    test('the nonce past N and the block that used it out of reach: shown after a day of failed passes, not before, and closable', async () => {
      // Used 2,000 blocks below F, past the window, with no bracket.
      const chain = takenChain(1000, { head: 3100, finalized: 3000 });
      const store = fakeStore([intent(5, { possiblySent: true })]);
      const { instance } = tracker({ store, request: chain.request });
      const changed = jest.fn();
      instance.onChange(changed);
      instance.start();
      await jest.advanceTimersByTimeAsync(SCHEDULE.startupMs);
      const firstFailed = Date.now();
      expect(store.get('intent-0005').unreadSince).toBe(firstFailed);
      expect(instance.couldntConfirm(store.get('intent-0005'))).toBeNull();
      expect(instance.closeEvidence('intent-0005')).toBeNull();

      await jest.advanceTimersByTimeAsync(DAY - SCHEDULE.startupMs - SCHEDULE.fastMs);
      expect(instance.couldntConfirm(store.get('intent-0005'))).toBeNull();
      changed.mockClear();
      await jest.advanceTimersByTimeAsync(SCHEDULE.startupMs + SCHEDULE.fastMs);
      expect(Date.now() - firstFailed).toBeGreaterThanOrEqual(DAY);
      expect(instance.couldntConfirm(store.get('intent-0005'))).toEqual({
        since: firstFailed,
        closable: true,
      });
      // The chrome hears of it.
      expect(changed).toHaveBeenCalled();
      expect(instance.closeEvidence('intent-0005')).toEqual({
        block: 3000,
        hash: chain.canonicalHash(3000),
      });
      // Still held, its record as it was.
      expect(store.get('intent-0005')).toMatchObject({
        state: 'held',
        hashes: [{ hash: hashOf(5) }],
      });
      instance.stop();
    });

    test("likewise when the nonce at F can't be read for a day; then it isn't closable", async () => {
      const chain = takenChain(1000, { head: 3100, finalized: 3000 });
      chain.reshape('eth_getTransactionCount', () => {
        throw new Error('missing trie node');
      });
      const store = fakeStore([intent(5, { possiblySent: true })]);
      const { instance } = tracker({ store, request: chain.request });
      instance.start();
      await runFor(instance, DAY + SCHEDULE.startupMs);
      expect(instance.couldntConfirm(store.get('intent-0005'))).toMatchObject({ closable: false });
      expect(instance.closeEvidence('intent-0005')).toBeNull();
      instance.stop();
    });

    test('a Direct answer or a quorum of one for the nonce is not evidence: not closable', async () => {
      const direct = (result) => ({
        result,
        source: 'direct',
        verified: false,
        trust: { level: 'unverified', method: 'direct', quorum: { k: 3, m: 2, achieved: false } },
      });
      const singleton = (result) => ({
        result,
        source: 'quorum',
        verified: false,
        trust: { level: 'unverified', method: 'quorum', quorum: { k: 1, m: 1, achieved: true } },
      });
      for (const wrap of [direct, singleton]) {
        const chain = takenChain(1000, { head: 3100, finalized: 3000 });
        chain.wrap('eth_getTransactionCount', wrap);
        const store = fakeStore([intent(5, { possiblySent: true })]);
        const { instance } = tracker({ store, request: chain.request });
        instance.start();
        await runFor(instance, DAY + SCHEDULE.startupMs);
        expect(instance.couldntConfirm(store.get('intent-0005'))).toMatchObject({
          closable: false,
        });
        expect(instance.closeEvidence('intent-0005')).toBeNull();
        instance.stop();
      }
    });

    test('an intent whose nonce at F is N or below is never shown, however long its label is unread', async () => {
      // Nothing used its nonce; its receipts can't be read.
      const chain = takenChain(null, { head: 3100, finalized: 3000 });
      chain.reshape('eth_getTransactionReceipt', () => {
        throw new Error('timeout');
      });
      const store = fakeStore([intent(5, { possiblySent: true })]);
      const { instance } = tracker({ store, request: chain.request });
      instance.start();
      await runFor(instance, 2 * DAY);
      expect(store.get('intent-0005').unreadSince).toBeNull();
      expect(instance.couldntConfirm(store.get('intent-0005'))).toBeNull();
      expect(instance.closeEvidence('intent-0005')).toBeNull();
      instance.stop();
    });

    test('an unmined read resets the day; a failing one after it starts it again', async () => {
      const chain = takenChain(null, { head: 3100, finalized: 3000 });
      let failing = true;
      const request = jest.fn(async (chainId, method, params, options) => {
        if (failing && method === 'eth_getTransactionCount') throw new Error('timeout');
        return chain.request(chainId, method, params, options);
      });
      const store = fakeStore([intent(5, { possiblySent: true })]);
      const { instance } = tracker({ store, request });
      await instance.pass();
      const since = store.get('intent-0005').unreadSince;
      expect(since).toBe(Date.now());
      await jest.advanceTimersByTimeAsync(DAY / 2);
      failing = false;
      await instance.pass();
      expect(store.get('intent-0005').unreadSince).toBeNull();
      failing = true;
      await jest.advanceTimersByTimeAsync(DAY / 2 + MINUTE);
      await instance.pass();
      expect(store.get('intent-0005').unreadSince).toBe(Date.now());
      expect(instance.couldntConfirm(store.get('intent-0005'))).toBeNull();
    });

    test("once a read saw its nonce used, a lagging pair's older F where it was unused doesn't reset the day", async () => {
      const chain = takenChain(1000, { head: 3100, finalized: 3000 });
      const store = fakeStore([intent(5, { possiblySent: true })]);
      const { instance } = tracker({ store, request: chain.request });
      await instance.pass();
      const since = store.get('intent-0005').unreadSince;
      expect(since).toBe(Date.now());

      chain.defineView('lagging', { head: 950, finalized: 900, stateWindow: W });
      chain.route('eth_getBlockByNumber', 'lagging');
      chain.route('eth_getTransactionCount', 'lagging');
      await jest.advanceTimersByTimeAsync(DAY);
      await instance.pass();
      expect(store.get('intent-0005').unreadSince).toBe(since);
      expect(instance.couldntConfirm(store.get('intent-0005'))).toMatchObject({ closable: true });
    });

    test('counted from the first failed pass, across restarts', async () => {
      const chain = takenChain(1000, { head: 3100, finalized: 3000 });
      // The record says its passes have failed since a day ago.
      const store = fakeStore([
        intent(5, { possiblySent: true, unreadSince: Date.now() - DAY - MINUTE }),
      ]);
      const { instance } = tracker({ store, request: chain.request });
      await instance.pass();
      expect(store.get('intent-0005').unreadSince).toBe(Date.now() - DAY - MINUTE);
      expect(instance.couldntConfirm(store.get('intent-0005'))).toMatchObject({ closable: true });
    });

    test('it stays held and read: a later pass that reaches the evidence settles it', async () => {
      const chain = takenChain(1000, { head: 3100, finalized: 3000 });
      let colibri = false;
      // Colibri arrives later (a prover configured), proving the deep reads.
      const request = jest.fn(async (chainId, method, params, options) => {
        if (colibri && method === 'eth_getTransactionCount') {
          return {
            result: chain.prove(method, params),
            source: 'colibri',
            verified: true,
            trust: { level: 'verified', method: 'colibri', quorum: { k: 1, m: 1, achieved: true } },
          };
        }
        return chain.request(chainId, method, params, options);
      });
      const store = fakeStore([intent(5, { possiblySent: true })]);
      const { instance, recordSettlement } = tracker({ store, request });
      instance.start();
      await runFor(instance, DAY + SCHEDULE.startupMs);
      expect(instance.couldntConfirm(store.get('intent-0005'))).toMatchObject({ closable: true });

      colibri = true;
      await instance.pass();
      expect(store.get('intent-0005')).toMatchObject({
        state: 'settled',
        settlement: { label: 'taken', block: 3000 },
      });
      expect(recordSettlement).toHaveBeenCalled();
      expect(instance.closeEvidence('intent-0005')).toBeNull();
      instance.stop();
    });
  });
});
