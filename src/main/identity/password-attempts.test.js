const { createPasswordAttempts, LIMITS, PasswordAttemptsThrottled } = require('./password-attempts');

const wrong = () => Promise.reject(new Error('Incorrect password'));
const right = () => Promise.resolve('ok');

describe('wrong-password back-off (K-4)', () => {
  test('matches the documented limits', () => {
    expect(LIMITS).toEqual({ FREE_FAILURES: 3, BASE_DELAY_MS: 1000, MAX_DELAY_MS: 60000 });
  });

  test('three free failures, then 1 s, 2 s, 4 s … up to 60 s', async () => {
    let now = 0;
    const attempts = createPasswordAttempts({ now: () => now });
    for (let i = 0; i < 2; i += 1) await expect(attempts.withPasswordAttempt(wrong)).rejects.toThrow('Incorrect');
    expect(attempts.state().blockedUntil).toBe(0);

    const expected = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
    for (const delay of expected) {
      await expect(attempts.withPasswordAttempt(wrong)).rejects.toThrow('Incorrect password');
      expect(attempts.state().blockedUntil - now).toBe(delay);
      // Locked out: the check is not even run.
      const check = jest.fn(right);
      await expect(attempts.withPasswordAttempt(check)).rejects.toBeInstanceOf(PasswordAttemptsThrottled);
      expect(check).not.toHaveBeenCalled();
      now += delay;
    }
  });

  test('a right password resets the count', async () => {
    let now = 0;
    const attempts = createPasswordAttempts({ now: () => now });
    for (let i = 0; i < 3; i += 1) await attempts.withPasswordAttempt(wrong).catch(() => {});
    now += 1000;
    await expect(attempts.withPasswordAttempt(right)).resolves.toBe('ok');
    expect(attempts.state()).toEqual({ failures: 0, blockedUntil: 0 });
  });

  test('other errors do not count; parallel guesses run one at a time', async () => {
    const attempts = createPasswordAttempts({ now: () => 0 });
    await attempts.withPasswordAttempt(() => Promise.reject(new Error('No vault found'))).catch(() => {});
    expect(attempts.state().failures).toBe(0);

    let running = 0;
    let most = 0;
    const slowWrong = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
      throw new Error('Incorrect password');
    };
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => attempts.withPasswordAttempt(slowWrong))
    );
    expect(most).toBe(1);
    // Three were checked; the rest met the lock-out without running.
    expect(results.filter((r) => r.reason instanceof PasswordAttemptsThrottled)).toHaveLength(7);
  });
});
