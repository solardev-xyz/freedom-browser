const { createAutoWriteLimiter, LIMITS } = require('./auto-write-limiter');

describe('auto-write limiter', () => {
  test('matches the decided limits', () => {
    expect(LIMITS).toEqual({ BURST: 5, REFILL_MS: 30_000, DAILY_MAX: 50, DAY_MS: 86_400_000 });
  });

  test('refills one write per 30 s, up to the burst', () => {
    let now = 0;
    const limiter = createAutoWriteLimiter({ now: () => now });
    for (let i = 0; i < 5; i += 1) expect(limiter.admit('a')).toBe(true);
    expect(limiter.admit('a')).toBe(false);

    // Idle for an hour: back to the burst, never more.
    now += 60 * 60 * 1000;
    for (let i = 0; i < 5; i += 1) expect(limiter.admit('a')).toBe(true);
    expect(limiter.admit('a')).toBe(false);

    now += 45_000;
    expect(limiter.admit('a')).toBe(true);
    expect(limiter.admit('a')).toBe(false);
    now += 15_000;
    expect(limiter.admit('a')).toBe(true);
  });

  test('a refused write does not use up a token', () => {
    let now = 0;
    const limiter = createAutoWriteLimiter({ now: () => now });
    for (let i = 0; i < 5; i += 1) limiter.admit('a');
    for (let i = 0; i < 10; i += 1) expect(limiter.admit('a')).toBe(false);
    now += 30_000;
    expect(limiter.admit('a')).toBe(true);
  });

  test('origins are counted apart; forget() resets one', () => {
    const limiter = createAutoWriteLimiter({ now: () => 0 });
    for (let i = 0; i < 5; i += 1) limiter.admit('a');
    expect(limiter.admit('a')).toBe(false);
    expect(limiter.admit('b')).toBe(true);
    limiter.forget('a');
    expect(limiter.admit('a')).toBe(true);
  });
});
