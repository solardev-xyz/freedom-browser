const { createRediscoveryTracker, FINISHED_LINE, FAILED_LINE } = require('./ant-rediscovery');

// The lines antd v0.5.58 logs, as `tracing`'s default formatter prints them.
const finished = `2026-10-05T10:00:00.000000Z  INFO antd: ${FINISHED_LINE}; /stamps lists every batch found rediscovered=2 batches=2`;
const failed = `2026-10-05T10:00:00.000000Z  WARN antd: ${FAILED_LINE}: rpc timeout; continuing without it`;

describe('createRediscoveryTracker', () => {
  test('is null until a bundled node starts', () => {
    expect(createRediscoveryTracker().get()).toBeNull();
  });

  test('a started node is running until it logs the finished line', () => {
    const tracker = createRediscoveryTracker();
    const run = tracker.begin();
    expect(tracker.get()).toMatchObject({ run, state: 'running', failed: false });
    tracker.noteLine(run, 'INFO antd: chain ready');
    expect(tracker.get().state).toBe('running');
    tracker.noteLine(run, finished);
    expect(tracker.get()).toMatchObject({ run, state: 'finished', failed: false });
  });

  test('remembers a failed scan across the finished line that follows it', () => {
    const tracker = createRediscoveryTracker();
    const run = tracker.begin();
    tracker.noteLine(run, failed);
    expect(tracker.get()).toMatchObject({ state: 'running', failed: true });
    tracker.noteLine(run, finished);
    expect(tracker.get()).toMatchObject({ state: 'finished', failed: true });
  });

  test('ignores lines from an earlier process', () => {
    const tracker = createRediscoveryTracker();
    const first = tracker.begin();
    const second = tracker.begin();
    tracker.noteLine(first, finished);
    expect(tracker.get()).toMatchObject({ run: second, state: 'running', failed: false });
    // An earlier process exiting late does not clear the current one.
    tracker.end(first);
    expect(tracker.get()).not.toBeNull();
    tracker.end(second);
    expect(tracker.get()).toBeNull();
  });

  test('a reused or external node clears it', () => {
    const tracker = createRediscoveryTracker();
    tracker.begin();
    tracker.end();
    expect(tracker.get()).toBeNull();
  });

  test('tells subscribers about every change, and survives a failing one', () => {
    const tracker = createRediscoveryTracker();
    const seen = [];
    tracker.onChange(() => {
      throw new Error('boom');
    });
    const off = tracker.onChange((state) => seen.push(state && state.state));
    const run = tracker.begin();
    tracker.noteLine(run, finished);
    tracker.noteLine(run, finished);
    tracker.end(run);
    expect(seen).toEqual(['running', 'finished', null]);
    off();
    tracker.begin();
    expect(seen).toHaveLength(3);
  });

  test('stamps each run with its spawn time, which bounds the hold (#510)', () => {
    let t = 1000;
    const tracker = createRediscoveryTracker({ now: () => t });
    tracker.begin();
    t = 5000;
    expect(tracker.get().startedAt).toBe(1000);
    tracker.begin();
    expect(tracker.get().startedAt).toBe(5000);
  });
});
