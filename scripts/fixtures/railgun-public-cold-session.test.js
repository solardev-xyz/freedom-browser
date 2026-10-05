function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
beforeEach(() => jest.resetModules());
test('healthy ordered cleanup does not close dependencies before held owner drains', async () => {
  const { steps } = require('./railgun-public-cold-session'),
    gate = deferred(),
    calls = [];
  const task = steps([
    [
      'wallet',
      async () => {
        calls.push('wallet');
        await gate.promise;
      },
    ],
    ['public', () => calls.push('public')],
    ['vault', () => calls.push('vault')],
  ]);
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toEqual(['wallet']);
  gate.resolve();
  await task;
  expect(calls).toEqual(['wallet', 'public', 'vault']);
});
test('rejected first barrier still closes and awaits independent next owner, every failure sticky', async () => {
  const sticky = require('./railgun-native-assertions'),
    { steps } = require('./railgun-public-cold-session'),
    gate = deferred(),
    calls = [];
  const task = steps([
    [
      'wallet',
      async () => {
        calls.push('wallet');
        throw Error('first');
      },
    ],
    [
      'public',
      async () => {
        calls.push('public');
        gate.resolve();
        await gate.promise;
        throw Error('second');
      },
    ],
    ['vault', () => calls.push('vault')],
  ]);
  await expect(task).rejects.toThrow();
  expect(calls).toEqual(['wallet', 'public', 'vault']);
  expect(sticky.report().map((v) => v.label)).toEqual(['wallet', 'public']);
});
test('never-settling barrier has labelled qualification failure, not drained success', async () => {
  jest.useFakeTimers();
  try {
    const sticky = require('./railgun-native-assertions'),
      { bounded } = require('./railgun-public-cold-session');
    let settled = false;
    const raw = new Promise(() => {});
    raw.then(() => {
      settled = true;
    });
    const tested = expect(bounded(raw, 'held child', 10)).rejects.toThrow('held child');
    await jest.advanceTimersByTimeAsync(11);
    await tested;
    expect(settled).toBe(false);
    expect(sticky.report()).toEqual([{ label: 'held child.timeout', name: 'Error' }]);
  } finally {
    jest.useRealTimers();
  }
});
