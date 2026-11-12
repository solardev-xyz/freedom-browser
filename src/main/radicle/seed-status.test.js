jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const tracker = require('./seed-status');

const RID = 'rad:z371PVmDHdjJucejRoRYJcDEvD5pp';

beforeEach(() => tracker._reset());
afterAll(() => tracker._reset());

test('unknown repositories are idle unless native storage contains them', async () => {
  await expect(tracker.getStatus(RID, { repoExists: async () => false })).resolves.toMatchObject({
    state: 'idle',
    inStorage: false,
  });
  await expect(tracker.getStatus(RID, { repoExists: async () => true })).resolves.toMatchObject({
    state: 'fetched',
    inStorage: true,
  });
});

test('tracks a native fetch from fetching to fetched', async () => {
  let finish;
  const fetchRepo = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
  const initial = tracker.startFetch(RID, {
    fetchRepo,
    getSeeders: async () => 4,
  });
  expect(initial.state).toBe('fetching');
  await Promise.resolve();
  finish();
  await initial.done;
  await expect(tracker.getStatus(RID)).resolves.toMatchObject({
    state: 'fetched',
    inStorage: true,
    seedersKnown: 4,
    attemptCount: 1,
  });
});

test('records streamed peer progress and recent outcomes', async () => {
  let finish;
  let emit;
  const fetchRepo = jest.fn((_rid, onProgress) => {
    emit = onProgress;
    return new Promise((resolve) => { finish = resolve; });
  });
  const initial = tracker.startFetch(RID, { fetchRepo });
  expect(fetchRepo).toHaveBeenCalledTimes(1);

  emit({ phase: 'resolving', candidates: 2 });
  emit({
    phase: 'peer-failed', nid: 'z6MkFirst', index: 1, total: 2, reason: 'offline',
  });
  emit({ phase: 'fetching', nid: 'z6MkSecond', index: 2, total: 2 });
  emit({ phase: 'done' });
  finish({ ok: true });
  await initial.done;

  await expect(tracker.getStatus(RID)).resolves.toMatchObject({
    state: 'fetched',
    seedersKnown: null,
    progress: { phase: 'done' },
    recentAttempts: [
      { nid: 'z6MkFirst', ok: false, error: 'offline' },
      { nid: 'z6MkSecond', ok: true },
    ],
  });
});

test('pushes every fetch transition to status listeners', async () => {
  let emit;
  let finish;
  const statuses = [];
  const initial = tracker.startFetch(RID, {
    fetchRepo: (_rid, onProgress) => {
      emit = onProgress;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    onStatus: (status) => statuses.push(status),
  });

  emit({ phase: 'connecting', nid: 'z6MkSeed', addr: 'seed:8776', index: 1, total: 1 });
  finish({ ok: true });
  await initial.done;

  expect(statuses.map((status) => status.progress?.phase)).toEqual([
    'starting',
    'connecting',
    'done',
  ]);
  expect(statuses.at(-1)).toMatchObject({ state: 'fetched', inStorage: true });
});

test('reattaches a deduplicated listener to an in-flight fetch', async () => {
  let finish;
  let emit;
  const listener = jest.fn();
  const initial = tracker.startFetch(RID, {
    fetchRepo: (_rid, onProgress) => {
      emit = onProgress;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });

  expect(tracker.subscribe(RID, listener)).toBe(true);
  expect(tracker.subscribe(RID, listener)).toBe(true);
  expect(listener).toHaveBeenCalledTimes(1);
  emit({ phase: 'fetching', nid: 'z6MkSeed', index: 1, total: 1 });
  expect(listener).toHaveBeenCalledTimes(2);

  tracker.unsubscribe(listener);
  emit({ phase: 'connecting', nid: 'z6MkSeed', index: 1, total: 1 });
  expect(listener).toHaveBeenCalledTimes(2);
  finish({ ok: true });
  await initial.done;
});

test('surfaces native fetch failures and allows retry', async () => {
  const failed = tracker.startFetch(RID, {
    fetchRepo: async () => { throw new Error('network failed'); },
  });
  await failed.done;
  await expect(tracker.getStatus(RID)).resolves.toMatchObject({
    state: 'failed',
    lastError: 'network failed',
  });

  const retried = tracker.startFetch(RID, { fetchRepo: async () => {} });
  await retried.done;
  await expect(tracker.getStatus(RID)).resolves.toMatchObject({
    state: 'fetched',
    attemptCount: 2,
  });
});

test('marks native no-seed failures as zero reachable seeds', async () => {
  const failed = tracker.startFetch(RID, {
    fetchRepo: async () => { throw new Error(`no seeds found for ${RID}`); },
  });
  await failed.done;
  await expect(tracker.getStatus(RID)).resolves.toMatchObject({
    state: 'failed',
    seedersKnown: 0,
  });
});

test('cancelled fetches cannot resurrect their record', async () => {
  let finish;
  tracker.startFetch(RID, {
    fetchRepo: () => new Promise((resolve) => { finish = resolve; }),
  });
  await Promise.resolve();
  const done = tracker.cancelFetch(RID);
  expect(done).toBeDefined();
  finish();
  await done;
  await expect(tracker.getStatus(RID)).resolves.toMatchObject({ state: 'idle' });
});

describe('a summary of peer failures (freedom-core design 0008, Progress, deviation progress-summary)', () => {
  /** A fetch whose progress the test emits, and every status it published. */
  function tracked() {
    let emit;
    let finish;
    let fail;
    const statuses = [];
    const initial = tracker.startFetch(RID, {
      fetchRepo: (_rid, onProgress) => {
        emit = onProgress;
        return new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
      },
      onStatus: (status) => statuses.push(status),
    });
    return { initial, statuses, emit: (event) => emit(event), finish, fail: (err) => fail(err) };
  }

  const failure = (n) => ({
    phase: 'peer-failed',
    nid: `z6MkPeer${n}`,
    index: n,
    total: 20,
    reason: `reason ${n}`,
  });

  test('its reasons are recent attempts with no nid; its progress is the count and the latest reason, never the summary itself', async () => {
    const { initial, statuses, emit, finish } = tracked();
    for (let n = 1; n <= 8; n += 1) emit(failure(n));
    emit({
      phase: 'peer-failed',
      summary: { count: 12, reasons: ['reason 17', 'reason 18', 'reason 19', 'reason 20'] },
    });
    const status = statuses.at(-1);
    expect(status.progress).toEqual({ phase: 'peer-failed', count: 12, reason: 'reason 20' });
    expect(status.recentAttempts.map(({ nid, ok, error }) => ({ nid, ok, error }))).toEqual([
      { nid: 'z6MkPeer8', ok: false, error: 'reason 8' },
      { nid: null, ok: false, error: 'reason 17' },
      { nid: null, ok: false, error: 'reason 18' },
      { nid: null, ok: false, error: 'reason 19' },
      { nid: null, ok: false, error: 'reason 20' },
    ]);
    // No attempt names an nid it doesn't have.
    for (const s of statuses) {
      for (const attempt of s.recentAttempts) expect(attempt.nid).not.toBeUndefined();
      expect(s.progress).not.toHaveProperty('summary');
    }
    // The singles and the summary's count: every failure.
    const singles = statuses.filter(
      (s) => s.progress?.phase === 'peer-failed' && !('count' in s.progress)
    );
    const counted = statuses.reduce((sum, s) => sum + (s.progress?.count ?? 0), 0);
    expect(singles.length + counted).toBe(20);
    emit({ phase: 'fetching', nid: 'z6MkPeer21', index: 21, total: 21 });
    emit({ phase: 'done' });
    finish({ ok: true });
    await initial.done;
    expect(statuses.at(-1)).toMatchObject({ state: 'fetched', progress: { phase: 'done' } });
    // The last fetching peer is the one that served it.
    expect(statuses.at(-1).recentAttempts.at(-1)).toMatchObject({ nid: 'z6MkPeer21', ok: true });
  });

  test("a status's summary can't be changed through what a listener got", () => {
    const { statuses, emit } = tracked();
    const reasons = ['one'];
    emit({ phase: 'peer-failed', summary: { count: 9, reasons } });
    reasons.push('two');
    statuses.at(-1).progress.reason = 'changed';
    statuses.at(-1).recentAttempts[0].error = 'changed';
    return expect(tracker.getStatus(RID)).resolves.toMatchObject({
      progress: { phase: 'peer-failed', count: 9, reason: 'one' },
      recentAttempts: [{ nid: null, ok: false, error: 'one' }],
    });
  });

  test("a summary that isn't one counts nothing and names no reason", () => {
    const { statuses, emit } = tracked();
    emit({ phase: 'peer-failed', summary: null });
    emit({ phase: 'peer-failed', summary: { count: -3, reasons: 'not a list' } });
    emit({ phase: 'peer-failed', summary: { count: 2.5, reasons: [7, null, 'kept'] } });
    expect(statuses.slice(1).map((s) => s.progress)).toEqual([
      { phase: 'peer-failed', count: 0, reason: null },
      { phase: 'peer-failed', count: 0, reason: null },
      { phase: 'peer-failed', count: 0, reason: 'kept' },
    ]);
    expect(statuses.at(-1).recentAttempts.map((a) => a.error)).toEqual(['kept']);
  });

  test('cancelled arrives last: the terminal event, then the cancelled status', async () => {
    const { initial, statuses, emit, finish } = tracked();
    emit({ phase: 'peer-failed', summary: { count: 30, reasons: ['r'] } });
    emit({ phase: 'cancelled' });
    finish({ cancelled: true });
    await initial.done;
    expect(statuses.map((s) => [s.state, s.progress?.phase])).toEqual([
      ['fetching', 'starting'],
      ['fetching', 'peer-failed'],
      ['fetching', 'cancelled'],
      ['cancelled', 'cancelled'],
    ]);
  });
});
