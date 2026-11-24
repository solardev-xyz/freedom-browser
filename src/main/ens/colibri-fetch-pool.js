/**
 * Main's Colibri fetch pool (freedom-core design 0014, "Bodies" and
 * "Budgets"): 128 MiB, browser-wide, for every `freedom-colibrid` process,
 * persistent or checkpoint. Before main sends a `shell.colibri_fetch` to a
 * server, it reserves the variant's body maximum here; with no room the
 * fetch isn't sent, and the service gets `Colibri fetch pool full`. 128 MiB
 * is 8 bodies of 16 MiB, one per Colibri operation main runs at once
 * (design 0004).
 *
 * It is apart from the chain I/O pool (192 MiB, `service-client.js`), which
 * bounds what main holds for the core's connection: Colibri's fetches can't
 * starve the core's replies, or the reverse. Control frames don't use it.
 *
 * A reservation is held while main reads a body (whichever server answers,
 * under the same one), shrinks to the body's length once it is read, and is
 * given back as the service takes the bytes, or whole when the body ends or
 * is cancelled.
 */

const COLIBRI_FETCH_POOL_BYTES = 128 * 1024 * 1024;

class ColibriFetchPool {
  /** @param {number} [limit] - bytes, 128 MiB by default */
  constructor(limit = COLIBRI_FETCH_POOL_BYTES) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new TypeError('A Colibri fetch pool needs a byte limit');
    }
    this.limit = limit;
    this.held = 0;
  }

  /**
   * Reserves `bytes`, or answers null, with nothing reserved, when they
   * don't fit. The reservation:
   * - `held`: the bytes it still holds;
   * - `shrink(bytes)`: holds at most `bytes`, giving back the rest;
   * - `release(bytes)`: gives back `bytes` of what it holds (at most all);
   * - `close()`: gives back everything; a closed one holds nothing more.
   * @returns {{held: number, shrink(bytes: number): void, release(bytes: number): void, close(): void}|null}
   */
  reserve(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError('A Colibri fetch reservation needs a byte count');
    }
    if (bytes > this.limit - this.held) return null;
    this.held += bytes;
    const pool = this;
    let held = bytes;
    const giveBack = (amount) => {
      const given = Math.min(Math.max(0, amount), held);
      held -= given;
      pool.held -= given;
    };
    return {
      get held() {
        return held;
      },
      shrink(to) {
        giveBack(held - to);
      },
      release(amount) {
        giveBack(amount);
      },
      close() {
        giveBack(held);
      },
    };
  }
}

/** The browser's one pool. */
const colibriFetchPool = new ColibriFetchPool();

module.exports = { COLIBRI_FETCH_POOL_BYTES, ColibriFetchPool, colibriFetchPool };
