const { createAutoWriteLimiter, LIMITS } = require('./auto-write-limiter');

describe('auto-write limiter', () => {
  test('matches the decided limits', () => {
    expect(LIMITS).toEqual({ BURST: 5, REFILL_MS: 30_000, DAILY_MAX: 50, DAY_MS: 86_400_000 });
  });

  test('refills one write per 30 s, up to the burst', () => {
    let now = 0;
    const limiter = createAutoWriteLimiter({ now: () => now });
    for (let i = 0; i < 5; i += 1) expect(limiter.admit('a')).toBeTruthy();
    expect(limiter.admit('a')).toBeNull();

    // Idle for an hour: back to the burst, never more.
    now += 60 * 60 * 1000;
    for (let i = 0; i < 5; i += 1) expect(limiter.admit('a')).toBeTruthy();
    expect(limiter.admit('a')).toBeNull();

    now += 45_000;
    expect(limiter.admit('a')).toBeTruthy();
    expect(limiter.admit('a')).toBeNull();
    now += 15_000;
    expect(limiter.admit('a')).toBeTruthy();
  });

  test('a refused write does not use up a token', () => {
    let now = 0;
    const limiter = createAutoWriteLimiter({ now: () => now });
    for (let i = 0; i < 5; i += 1) limiter.admit('a');
    for (let i = 0; i < 10; i += 1) expect(limiter.admit('a')).toBeNull();
    now += 30_000;
    expect(limiter.admit('a')).toBeTruthy();
  });

  test('a refunded write gives back its token and daily slot, once', () => {
    let now = 0;
    const limiter = createAutoWriteLimiter({ now: () => now });
    const refunds = [];
    for (let i = 0; i < 5; i += 1) refunds.push(limiter.admit('a'));
    expect(limiter.admit('a')).toBeNull();
    refunds[4]();
    refunds[4]();
    expect(limiter.admit('a')).toBeTruthy();
    expect(limiter.admit('a')).toBeNull();

    // Daily cap: 50 admitted, one refunded, room for exactly one more.
    const daily = createAutoWriteLimiter({ now: () => now });
    let last;
    for (let i = 0; i < 50; i += 1) {
      last = daily.admit('a');
      now += 30_000;
    }
    expect(daily.admit('a')).toBeNull();
    last();
    expect(daily.admit('a')).toBeTruthy();
    expect(daily.admit('a')).toBeNull();
  });

  test('origins are counted apart; forget() resets one', () => {
    const limiter = createAutoWriteLimiter({ now: () => 0 });
    for (let i = 0; i < 5; i += 1) limiter.admit('a');
    expect(limiter.admit('a')).toBeNull();
    expect(limiter.admit('b')).toBeTruthy();
    limiter.forget('a');
    expect(limiter.admit('a')).toBeTruthy();
  });
});
