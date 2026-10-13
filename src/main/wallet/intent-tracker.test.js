jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { createIntentTracker, SCHEDULE, CONCURRENCY } = require('./intent-tracker');
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
