jest.mock('electron', () => ({ ipcMain: { handle: jest.fn() }, app: { getPath: jest.fn() } }));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createBrowsingCreditService,
  createSpendStore,
  recordSettlements,
  spendWithin,
  formatPlur,
  BUCKET_MS,
  DAY_MS,
  WEEK_MS,
  SAMPLE_MS,
  MAX_SAMPLE_GAP_MS,
  BALANCE_MAX_AGE_MS,
} = require('./browsing-credit-service');

const XBZZ = 10n ** 16n;
const plur = (xbzz) => (BigInt(Math.round(xbzz * 1e6)) * XBZZ / 1_000_000n).toString();
const CHEQUEBOOK = '0x' + 'ab'.repeat(20);
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

function memoryStore() {
  const data = {};
  return { get: (k) => data[k] || null, set: jest.fn((k, v) => { data[k] = v; }), data };
}

describe('recordSettlements', () => {
  test('the first reading is a baseline, not spend', () => {
    const { ledger } = recordSettlements(null, [{ peer: 'aa', sent: plur(0.5) }], T0);
    expect(ledger.since).toBe(T0);
    expect(ledger.peers).toEqual({ aa: [plur(0.5), T0] });
    expect(spendWithin(ledger, WEEK_MS, T0)).toBe(0n);
  });

  test('growth per peer is spend, bucketed by hour', () => {
    let { ledger } = recordSettlements(null, [{ peer: 'aa', sent: '100' }], T0);
    ({ ledger } = recordSettlements(ledger, [{ peer: 'aa', sent: '150' }, { peer: 'bb', sent: '30' }], T0 + 60_000));
    ({ ledger } = recordSettlements(ledger, [{ peer: 'aa', sent: '170' }, { peer: 'bb', sent: '45' }], T0 + 120_000));
    // aa: +50 +20; bb: first seen at 30 (a baseline), then +15.
    expect(ledger.buckets).toEqual([[Math.floor(T0 / BUCKET_MS) * BUCKET_MS, '85']]);
    expect(spendWithin(ledger, DAY_MS, T0 + 120_000)).toBe(85n);
  });

  test('a peer first seen after the baseline counts nothing for its lifetime total', () => {
    // /settlements lists only connected peers: one paid last month that
    // reconnects later shows its whole cumulative figure, which has no date.
    let { ledger } = recordSettlements(null, [{ peer: 'aa', sent: '100' }], T0);
    let changed;
    ({ ledger, changed } = recordSettlements(ledger, [{ peer: 'aa', sent: '100' }, { peer: 'bb', sent: plur(2) }], T0 + 10 * 60_000));
    expect(changed).toBe(true);
    expect(ledger.peers.bb).toEqual([plur(2), T0 + 10 * 60_000]);
    expect(spendWithin(ledger, WEEK_MS, T0 + 10 * 60_000)).toBe(0n);
    ({ ledger } = recordSettlements(ledger, [{ peer: 'bb', sent: (BigInt(plur(2)) + 7n).toString() }], T0 + 20 * 60_000));
    expect(spendWithin(ledger, DAY_MS, T0 + 20 * 60_000)).toBe(7n);
  });

  test('peers unseen for longer than the kept history are dropped, and come back as a baseline', () => {
    let { ledger } = recordSettlements(null, [{ peer: 'aa', sent: '100' }, { peer: 'bb', sent: '50' }], T0);
    let changed;
    // aa stays listed (its last-seen refreshes at most daily); bb goes away.
    for (let d = 1; d <= 7; d += 1) {
      ({ ledger } = recordSettlements(ledger, [{ peer: 'aa', sent: '100' }], T0 + d * DAY_MS));
    }
    expect(Object.keys(ledger.peers).sort()).toEqual(['aa', 'bb']);
    ({ ledger, changed } = recordSettlements(ledger, [{ peer: 'aa', sent: '100' }], T0 + 8 * DAY_MS));
    expect(changed).toBe(true);
    expect(Object.keys(ledger.peers)).toEqual(['aa']);
    // Sampled continuously (lastAt one interval back): bb is a baseline
    // because it was dropped, not because of a gap.
    ({ ledger } = recordSettlements(ledger, [{ peer: 'aa', sent: '100' }, { peer: 'bb', sent: '80' }], T0 + 9 * DAY_MS, T0 + 9 * DAY_MS - SAMPLE_MS));
    expect(spendWithin(ledger, WEEK_MS, T0 + 9 * DAY_MS)).toBe(0n);
  });

  test('an unchanged figure does not rewrite the ledger until its last-seen is a day old', () => {
    let { ledger } = recordSettlements(null, [{ peer: 'aa', sent: '100' }], T0);
    let changed;
    ({ changed } = recordSettlements(ledger, [{ peer: 'aa', sent: '100' }], T0 + DAY_MS - 1));
    expect(changed).toBe(false);
    ({ ledger, changed } = recordSettlements(ledger, [{ peer: 'aa', sent: '100' }], T0 + DAY_MS));
    expect(changed).toBe(true);
    expect(ledger.peers.aa).toEqual(['100', T0 + DAY_MS]);
  });

  test('reads the older bare-string peer shape', () => {
    const old = { since: T0, peers: { aa: '100' }, buckets: [] };
    let { ledger, changed } = recordSettlements(old, [{ peer: 'aa', sent: '130' }], T0 + 1000, T0);
    expect(changed).toBe(true);
    expect(ledger.peers.aa).toEqual(['130', T0 + 1000]);
    expect(spendWithin(ledger, DAY_MS, T0 + 1000)).toBe(30n);
    // With no time for the previous reading at all, the growth is undated.
    ({ ledger } = recordSettlements(old, [{ peer: 'aa', sent: '130' }], T0 + 1000));
    expect(ledger.peers.aa).toEqual(['130', T0 + 1000]);
    expect(spendWithin(ledger, DAY_MS, T0 + 1000)).toBe(0n);
  });

  test('a peer that drops out and comes back with the same figure adds nothing', () => {
    // /settlements lists the peers the node knows now, so totalSent can fall
    // and rise again without any new cheque.
    let { ledger } = recordSettlements(null, [{ peer: 'aa', sent: '100' }, { peer: 'bb', sent: '50' }], T0);
    let changed;
    ({ ledger, changed } = recordSettlements(ledger, [{ peer: 'aa', sent: '100' }], T0 + 1000));
    expect(changed).toBe(false);
    ({ ledger } = recordSettlements(ledger, [{ peer: 'aa', sent: '100' }, { peer: 'BB', sent: '50' }], T0 + 2000));
    expect(spendWithin(ledger, WEEK_MS, T0 + 2000)).toBe(0n);
  });

  test('a lower figure never counts as negative spend', () => {
    let { ledger } = recordSettlements(null, [{ peer: 'aa', sent: '100' }], T0);
    ({ ledger } = recordSettlements(ledger, [{ peer: 'aa', sent: '40' }], T0 + 1000));
    expect(ledger.peers.aa[0]).toBe('100');
    ({ ledger } = recordSettlements(ledger, [{ peer: 'aa', sent: '130' }], T0 + 2000));
    expect(spendWithin(ledger, DAY_MS, T0 + 2000)).toBe(30n);
  });

  test('day and week windows, and old buckets are dropped', () => {
    let { ledger } = recordSettlements(null, [{ peer: 'aa', sent: '0' }], T0);
    ({ ledger } = recordSettlements(ledger, [{ peer: 'aa', sent: '10' }], T0));
    ({ ledger } = recordSettlements(ledger, [{ peer: 'aa', sent: '30' }], T0 + 3 * DAY_MS, T0 + 3 * DAY_MS - SAMPLE_MS));
    const at = T0 + 3 * DAY_MS + 1000;
    expect(spendWithin(ledger, DAY_MS, at)).toBe(20n);
    expect(spendWithin(ledger, WEEK_MS, at)).toBe(30n);

    ({ ledger } = recordSettlements(ledger, [{ peer: 'aa', sent: '31' }], T0 + 9 * DAY_MS, T0 + 9 * DAY_MS - SAMPLE_MS));
    // The day-0 bucket is past the kept 8 days; day 3's is inside the week.
    expect(ledger.buckets.map(([, v]) => v)).toEqual(['20', '1']);
    expect(spendWithin(ledger, WEEK_MS, T0 + 9 * DAY_MS)).toBe(21n);
    expect(spendWithin(ledger, DAY_MS, T0 + 9 * DAY_MS)).toBe(1n);
  });

  test('growth across a gap in the sampling is a baseline, not spend in this hour', () => {
    // A reused node that kept paying peers for days while Freedom was closed.
    let { ledger } = recordSettlements(null, [{ peer: 'aa', sent: '100' }], T0);
    expect(ledger.sampled).toBe(T0);
    const back = T0 + 5 * DAY_MS;
    let changed;
    ({ ledger, changed } = recordSettlements(ledger, [{ peer: 'aa', sent: plur(3) }], back));
    expect(changed).toBe(true);
    expect(ledger.peers.aa).toEqual([plur(3), back]);
    expect(ledger.buckets).toEqual([]);
    expect(spendWithin(ledger, WEEK_MS, back)).toBe(0n);
    // Sampling again from there dates the growth as usual.
    ({ ledger } = recordSettlements(ledger, [{ peer: 'aa', sent: (BigInt(plur(3)) + 9n).toString() }], back + SAMPLE_MS));
    expect(spendWithin(ledger, DAY_MS, back + SAMPLE_MS)).toBe(9n);
    // The edge: a reading exactly MAX_SAMPLE_GAP_MS later still counts; one past it does not.
    const edge = back + SAMPLE_MS + MAX_SAMPLE_GAP_MS;
    let next;
    ({ ledger: next } = recordSettlements(ledger, [{ peer: 'aa', sent: (BigInt(plur(3)) + 10n).toString() }], edge));
    expect(spendWithin(next, DAY_MS, edge)).toBe(10n);
    ({ ledger: next } = recordSettlements(ledger, [{ peer: 'aa', sent: (BigInt(plur(3)) + 10n).toString() }], edge + 1));
    expect(spendWithin(next, DAY_MS, edge + 1)).toBe(9n);
  });

  test('a last-seen in the future (clock stepped back) is clamped to now', () => {
    const future = T0 + WEEK_MS;
    const old = { since: T0, sampled: T0, peers: { aa: ['100', future], bb: ['50', future] }, buckets: [] };
    let { ledger, changed } = recordSettlements(old, [{ peer: 'aa', sent: '100' }], T0);
    expect(changed).toBe(true);
    expect(ledger.peers).toEqual({ aa: ['100', T0], bb: ['50', T0] });
    // aa then gets its daily refresh, and bb is pruned on the normal clock.
    ({ ledger, changed } = recordSettlements(ledger, [{ peer: 'aa', sent: '100' }], T0 + DAY_MS));
    expect(changed).toBe(true);
    expect(ledger.peers.aa).toEqual(['100', T0 + DAY_MS]);
    for (let d = 2; d <= 8; d += 1) {
      ({ ledger } = recordSettlements(ledger, [{ peer: 'aa', sent: '100' }], T0 + d * DAY_MS));
    }
    expect(Object.keys(ledger.peers)).toEqual(['aa']);
  });

  test('a saved sampled time in the future dates nothing, and is rewritten to now', () => {
    // Saved with the clock two days ahead; the clock is then corrected and
    // Freedom stays closed a day while a reused node pays aa 1 xBZZ.
    const old = { since: T0, sampled: T0 + 2 * DAY_MS, peers: { aa: ['100', T0] }, buckets: [] };
    const at = T0 + DAY_MS;
    const grown = (BigInt(plur(1)) + 100n).toString();
    let { ledger, changed } = recordSettlements(old, [{ peer: 'aa', sent: grown }], at);
    expect(changed).toBe(true);
    expect(ledger.peers.aa).toEqual([grown, at]);
    expect(ledger.buckets).toEqual([]);
    expect(spendWithin(ledger, DAY_MS, at)).toBe(0n);
    // Unchanged figures still rewrite the future `sampled` so it isn't kept.
    ({ ledger, changed } = recordSettlements({ ...old, peers: { aa: ['100', at] } }, [{ peer: 'aa', sent: '100' }], at));
    expect(changed).toBe(true);
    expect(ledger.sampled).toBe(at);
    // An explicit previous time later than now dates nothing either.
    ({ ledger } = recordSettlements(ledger, [{ peer: 'aa', sent: '150' }], at + SAMPLE_MS, at + 2 * SAMPLE_MS));
    expect(spendWithin(ledger, DAY_MS, at + SAMPLE_MS)).toBe(0n);
  });

  test('ignores malformed rows', () => {
    const { ledger } = recordSettlements(null, [{ peer: 'aa', sent: 'x' }, { sent: '1' }, null, { peer: 'bb', sent: '-5' }], T0);
    expect(ledger.peers).toEqual({});
  });
});

describe('formatPlur', () => {
  test('xBZZ has 16 decimals', () => {
    expect(formatPlur(plur(0.001))).toBe('0.001');
    expect(formatPlur('11000000000')).toBe('0.000001');
    expect(formatPlur('0')).toBe('0');
    expect(formatPlur('nope')).toBeNull();
  });
});

describe('createSpendStore', () => {
  test('persists per chequebook and survives a reload', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'credit-'));
    const file = path.join(dir, 'spend.json');
    const store = createSpendStore(file);
    expect(store.get(CHEQUEBOOK)).toBeNull();
    store.set(CHEQUEBOOK, { since: 1, peers: { aa: '5' }, buckets: [] });
    expect(createSpendStore(file).get(CHEQUEBOOK)).toEqual({ since: 1, peers: { aa: '5' }, buckets: [] });
    fs.writeFileSync(file, '{broken');
    expect(createSpendStore(file).get(CHEQUEBOOK)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

function makeService(overrides = {}) {
  let now = T0;
  let swap = overrides.swapEnable ?? true;
  let status = overrides.status ?? 'running';
  const api = {
    getChequebookAddress: jest.fn(async () => ({ ok: true, data: { chequebookAddress: overrides.address ?? CHEQUEBOOK } })),
    getChequebookBalance: jest.fn(async () => ({
      ok: true,
      data: overrides.balance ?? { totalBalance: plur(0.001), availableBalance: plur(0.0004) },
    })),
    getSettlements: jest.fn(async () => ({ ok: true, data: { totalSent: '0', settlements: overrides.rows?.() ?? [] } })),
  };
  const store = memoryStore();
  const intervals = [];
  const deps = {
    api,
    getNodeStatus: () => ({ status }),
    getSwapSupport: jest.fn(async () => overrides.support ?? 'supported'),
    isSwapEnabled: () => swap,
    setSwapEnabled: jest.fn((v) => {
      swap = v;
      return true;
    }),
    restartNode: overrides.restartNode ?? jest.fn(async () => ({ ok: true, error: null })),
    store,
    now: () => now,
    setIntervalFn: jest.fn((fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    }),
    clearIntervalFn: jest.fn(),
  };
  const svc = createBrowsingCreditService(deps);
  return {
    svc,
    api,
    deps,
    store,
    intervals,
    advance: (ms) => {
      now += ms;
    },
    setStatus: (s) => {
      status = s;
    },
    swap: () => swap,
  };
}

describe('createBrowsingCreditService', () => {
  test('reports the chequebook, its spendable balance and the spend', async () => {
    let sent = '0';
    const ctx = makeService({ rows: () => [{ peer: 'aa', sent }] });
    let state = await ctx.svc.getState();
    expect(state).toMatchObject({
      node: 'running',
      support: 'supported',
      swapEnable: true,
      chequebook: {
        address: CHEQUEBOOK,
        total: '0.001',
        available: '0.0004',
        availablePlur: plur(0.0004),
        availableExact: true,
      },
      spend: { day: '0', week: '0', since: T0 },
    });

    sent = plur(0.0006);
    ctx.advance(BALANCE_MAX_AGE_MS);
    state = await ctx.svc.getState();
    expect(state.spend).toMatchObject({ day: '0.0006', week: '0.0006' });
  });

  test('throttles the chain reads behind the card', async () => {
    const ctx = makeService();
    await ctx.svc.getState();
    await ctx.svc.getState();
    expect(ctx.api.getChequebookBalance).toHaveBeenCalledTimes(1);
    expect(ctx.api.getSettlements).toHaveBeenCalledTimes(1);
    ctx.advance(BALANCE_MAX_AGE_MS);
    await ctx.svc.getState();
    expect(ctx.api.getChequebookBalance).toHaveBeenCalledTimes(2);
  });

  test('no chequebook reads as null; an unread one as undefined', async () => {
    const none = makeService({ address: '0x' + '0'.repeat(40) });
    expect((await none.svc.getState()).chequebook).toBeNull();
    expect(none.api.getSettlements).not.toHaveBeenCalled();

    const failing = makeService();
    failing.api.getChequebookBalance.mockResolvedValue({ ok: false, status: 503 });
    expect((await failing.svc.getState()).chequebook).toBeUndefined();

    const stopped = makeService({ status: 'stopped' });
    const state = await stopped.svc.getState();
    expect(state.chequebook).toBeUndefined();
    expect(stopped.api.getChequebookBalance).not.toHaveBeenCalled();
  });

  test('says when availableBalance is only the on-chain upper bound', async () => {
    const ctx = makeService({
      balance: { totalBalance: '5', availableBalance: '5', availableBalanceError: 'ledger unreadable' },
    });
    expect((await ctx.svc.getState()).chequebook.availableExact).toBe(false);
  });

  test('samples /settlements in the background only while the node runs', async () => {
    const ctx = makeService();
    ctx.svc.handleNodeStatus();
    expect(ctx.intervals).toHaveLength(1);
    expect(ctx.intervals[0].ms).toBe(SAMPLE_MS);
    ctx.svc.handleNodeStatus();
    expect(ctx.intervals).toHaveLength(1);
    ctx.setStatus('stopped');
    ctx.svc.handleNodeStatus();
    expect(ctx.deps.clearIntervalFn).toHaveBeenCalledWith(1);
  });

  test('idle samples date later growth without rewriting the file; a gap does not', async () => {
    let sent = '100';
    const ctx = makeService({ rows: () => [{ peer: 'aa', sent }] });
    await ctx.svc.getState();
    expect(ctx.store.set).toHaveBeenCalledTimes(1);
    // An hour of idle samples: nothing written, so the saved `sampled` lags.
    for (let i = 0; i < 12; i += 1) {
      ctx.advance(SAMPLE_MS);
      await ctx.svc.getState();
    }
    expect(ctx.api.getSettlements).toHaveBeenCalledTimes(13);
    expect(ctx.store.set).toHaveBeenCalledTimes(1);
    sent = '130';
    ctx.advance(SAMPLE_MS);
    expect((await ctx.svc.getState()).spend.dayPlur).toBe('30');

    // The node down for a day while its figure moved on (a reused node).
    ctx.setStatus('stopped');
    ctx.advance(DAY_MS);
    sent = '500';
    ctx.setStatus('running');
    const state = await ctx.svc.getState();
    expect(ctx.store.data[CHEQUEBOOK].peers.aa[0]).toBe('500');
    expect(state.spend.weekPlur).toBe('30');
  });

  test('a future saved sampled does not outrank the real last reading', async () => {
    let sent = '100';
    const ctx = makeService({ rows: () => [{ peer: 'aa', sent }] });
    await ctx.svc.getState();
    // The file carries a `sampled` from a clock that was ahead.
    ctx.store.data[CHEQUEBOOK] = { ...ctx.store.data[CHEQUEBOOK], sampled: T0 + 2 * DAY_MS };
    sent = '130';
    ctx.advance(SAMPLE_MS);
    expect((await ctx.svc.getState()).spend.dayPlur).toBe('30');
    expect(ctx.store.data[CHEQUEBOOK].sampled).toBe(T0 + SAMPLE_MS);
  });

  describe('setSwapEnable', () => {
    test('saves the setting and restarts the running node', async () => {
      const ctx = makeService();
      const result = await ctx.svc.setSwapEnable(false);
      expect(result.ok).toBe(true);
      expect(ctx.deps.setSwapEnabled).toHaveBeenCalledWith(false);
      expect(ctx.deps.restartNode).toHaveBeenCalledTimes(1);
      expect(result.state).toMatchObject({ swapEnable: false, toggle: { inProgress: false, error: null } });
    });

    test('a stopped node takes it at its next start, without a restart', async () => {
      const ctx = makeService({ status: 'stopped' });
      expect((await ctx.svc.setSwapEnable(false)).ok).toBe(true);
      expect(ctx.deps.restartNode).not.toHaveBeenCalled();
      expect(ctx.swap()).toBe(false);
    });

    test('no change, no restart', async () => {
      const ctx = makeService();
      expect((await ctx.svc.setSwapEnable(true)).ok).toBe(true);
      expect(ctx.deps.setSwapEnabled).not.toHaveBeenCalled();
      expect(ctx.deps.restartNode).not.toHaveBeenCalled();
    });

    test.each([
      ['unsupported', 'Not supported by this node version.'],
      ['unknown', 'Not supported by this node version.'],
      ['unmanaged', 'Freedom does not manage this Swarm node.'],
    ])('refuses on a %s node and changes nothing', async (support, error) => {
      const ctx = makeService({ support });
      expect(await ctx.svc.setSwapEnable(false)).toEqual({ ok: false, error });
      expect(ctx.deps.setSwapEnabled).not.toHaveBeenCalled();
      expect(ctx.deps.restartNode).not.toHaveBeenCalled();
    });

    test('a refused restart puts the setting back to what the node runs with', async () => {
      const ctx = makeService({
        restartNode: jest.fn(async () => ({
          ok: false,
          error: 'Wait for the purchase to finish before restarting the node.',
        })),
      });
      const result = await ctx.svc.setSwapEnable(false);
      expect(result.ok).toBe(false);
      expect(ctx.swap()).toBe(true);
      expect(result.state.toggle.error).toMatch(/purchase/);
    });

    test('one change at a time', async () => {
      let finish;
      const ctx = makeService({
        restartNode: jest.fn(() => new Promise((resolve) => { finish = resolve; })),
      });
      const first = ctx.svc.setSwapEnable(false);
      await new Promise((r) => setImmediate(r));
      expect((await ctx.svc.getState()).toggle.inProgress).toBe(true);
      expect(await ctx.svc.setSwapEnable(true)).toEqual({
        ok: false,
        error: 'The Swarm node is already restarting.',
      });
      finish({ ok: true });
      expect((await first).ok).toBe(true);
    });

    test('rejects a non-boolean', async () => {
      const ctx = makeService();
      expect((await ctx.svc.setSwapEnable('false')).ok).toBe(false);
    });
  });
});
