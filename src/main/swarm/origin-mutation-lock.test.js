const { withOriginLock, _resetForTests } = require('./origin-mutation-lock');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  _resetForTests();
});

describe('origin mutation lock', () => {
  test('serializes work for equivalent normalized origins', async () => {
    const gate = deferred();
    const events = [];
    const first = withOriginLock('bzz://app.eth/page', async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
    });
    const second = withOriginLock('app.eth', () => {
      events.push('second');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  test('allows unrelated origins to proceed independently', async () => {
    const gate = deferred();
    const events = [];
    const first = withOriginLock('one.eth', () => gate.promise);
    const second = withOriginLock('two.eth', () => events.push('two'));

    await second;
    expect(events).toEqual(['two']);
    gate.resolve();
    await first;
  });

  test('continues the queue after a rejected task', async () => {
    const first = withOriginLock('app.eth', () => Promise.reject(new Error('expected')));
    const second = withOriginLock('app.eth', () => 'recovered');

    await expect(first).rejects.toThrow('expected');
    await expect(second).resolves.toBe('recovered');
  });
});
