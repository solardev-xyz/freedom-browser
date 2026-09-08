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
