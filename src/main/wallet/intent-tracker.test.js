jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { createIntentTracker, SCHEDULE, CONCURRENCY } = require('./intent-tracker');

const SENDER = '0x1111111111111111111111111111111111111111';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
const hex = (n) => `0x${n.toString(16)}`;
const hashOf = (i) => `0x${i.toString(16).padStart(64, '0')}`;

const verified = (result) => ({
  result,
  source: 'quorum',
  verified: true,
  trust: { level: 'verified', method: 'quorum', quorum: { k: 3, m: 2, achieved: true } },
});

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
    settle: jest.fn(async ({ intentId, label, hash, block }) => {
      const settled = map.get(intentId);
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
function chainReads({ count = 0, mined = {} } = {}) {
  return jest.fn(async (_chainId, method, params) => {
    if (method === 'eth_getBlockByNumber' && params[0] === 'finalized') {
      return verified({ number: hex(100), hash: hashOf(9999) });
    }
    if (method === 'eth_getTransactionCount') return verified(hex(count));
    if (method === 'eth_getTransactionReceipt') {
      const nonce = Number(BigInt(params[0]));
      if (!(nonce in mined)) return verified(null);
      return verified({
        transactionHash: params[0],
        from: SENDER,
        blockNumber: hex(90),
        blockHash: hashOf(90),
        status: hex(mined[nonce]),
      });
    }
    if (method === 'eth_getBlockByNumber') return verified({ number: params[0], hash: hashOf(90) });
    throw new Error(`unexpected ${method}`);
  });
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
    const store = fakeStore(Array.from({ length: 12 }, (_, i) => intent(i + 1)));
    const reads = chainReads({ count: 0 });
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
    // One finalized block and one count for the sender; a receipt each.
    expect(request.mock.calls.map(([, method]) => method).sort()).toEqual(
      [
        'eth_getBlockByNumber',
        'eth_getTransactionCount',
        ...Array(12).fill('eth_getTransactionReceipt'),
      ].sort()
    );
  });

  test('a replacement committed while the reads ran is read again before it settles', async () => {
    const first = intent(5);
    const store = fakeStore([first]);
    const reads = chainReads({ count: 6 });
    const request = jest.fn(async (...args) => {
      // The user replaced it at nonce 5 meanwhile.
      if (args[1] === 'eth_getTransactionReceipt') {
        store.put({ ...first, hashes: [...first.hashes, { hash: hashOf(0x55) }] });
      }
      return reads(...args);
    });
    const { instance } = tracker({ store, request });
    await instance.pass();
    expect(store.settle).not.toHaveBeenCalled();
    expect(store.get('intent-0005').state).toBe('held');
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
