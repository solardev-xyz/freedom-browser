/**
 * A back-off for wrong vault passwords (K-4).
 *
 * Every vault password check in main (unlock, mnemonic and private-key
 * export, password change, vault delete, quick-unlock enrolment) goes
 * through withPasswordAttempt. The first FREE_FAILURES wrong passwords in a
 * row cost nothing extra; after that each one locks password checks out for
 * BASE_DELAY_MS, doubling up to MAX_DELAY_MS. A right password resets the
 * count. Checks run one at a time, so a burst of parallel guesses is the
 * same as guessing in sequence.
 *
 * In memory: a restart starts the count again. PBKDF2's 900k iterations
 * remain the main cost of a guess; this makes repeated guessing through the
 * app slower still.
 */

const LIMITS = Object.freeze({
  FREE_FAILURES: 3,
  BASE_DELAY_MS: 1000,
  MAX_DELAY_MS: 60 * 1000,
});

class PasswordAttemptsThrottled extends Error {
  constructor(retryAfterMs) {
    super(`Too many wrong passwords. Try again in ${Math.ceil(retryAfterMs / 1000)} s.`);
    this.name = 'PasswordAttemptsThrottled';
    this.code = 'PASSWORD_ATTEMPTS_THROTTLED';
    this.retryAfterMs = retryAfterMs;
  }
}

function isWrongPassword(err) {
  return err?.message === 'Incorrect password';
}

function createPasswordAttempts({ now = () => Date.now(), limits = LIMITS } = {}) {
  let failures = 0;
  let blockedUntil = 0;
  let tail = Promise.resolve();

  async function attempt(check) {
    const wait = blockedUntil - now();
    if (wait > 0) throw new PasswordAttemptsThrottled(wait);
    try {
      const result = await check();
      failures = 0;
      blockedUntil = 0;
      return result;
    } catch (err) {
      if (isWrongPassword(err)) {
        failures += 1;
        if (failures >= limits.FREE_FAILURES) {
          const delay = Math.min(
            limits.MAX_DELAY_MS,
            limits.BASE_DELAY_MS * 2 ** (failures - limits.FREE_FAILURES)
          );
          blockedUntil = now() + delay;
        }
      }
      throw err;
    }
  }

  /**
   * Run one password check under the back-off.
   * @param {() => Promise<T>} check - throws Error('Incorrect password') on a wrong one
   * @returns {Promise<T>}
   * @throws {PasswordAttemptsThrottled} while locked out
   */
  function withPasswordAttempt(check) {
    const run = tail.then(() => attempt(check));
    tail = run.catch(() => {});
    return run;
  }

  return {
    withPasswordAttempt,
    state: () => ({ failures, blockedUntil }),
    reset: () => {
      failures = 0;
      blockedUntil = 0;
    },
  };
}

const shared = createPasswordAttempts();

module.exports = {
  LIMITS,
  PasswordAttemptsThrottled,
  createPasswordAttempts,
  withPasswordAttempt: (check) => shared.withPasswordAttempt(check),
  _resetPasswordAttempts: () => shared.reset(),
};
