/**
 * Main's Swarm I/O pool (freedom-core design 0015, "Main's Swarm I/O
 * pool"): 64 MiB, browser-wide, for what main holds of the node's Swarm
 * traffic until the core takes it, and for the core's Swarm results until
 * main hands them on. It is apart from the chain I/O pool (192 MiB,
 * `service-client.js`) and the Colibri fetch pool (128 MiB,
 * `colibri-fetch-pool.js`), so a page's Swarm reads can't starve the
 * core's chain replies or Colibri's fetches, nor the reverse.
 *
 * Who charges it:
 * - **the core's Swarm asks** (`shell.swarm_*`): a handler registered with
 *   `handle(…, { pool })` charges what it holds through its lease, which
 *   lasts until its reply's last byte is written, or a streamed reply's
 *   terminal, or until the reply is dropped (service-client.js);
 * - **main's own requests' fragmented responses** (`{ pool }` on a
 *   request): twice the size the begin declares, before the buffer for it
 *   is made, until the caller has the response;
 * - **the streams main holds itself** (a `swarm.body`): a reservation of
 *   its own (`reserve`), until the stream's terminal.
 *
 * With no room, nothing is charged: a call isn't dialled (`busy`), a
 * response is dropped. Control frames, small answers and stream heads
 * never take from it.
 *
 * `highWater` is the most it has held at once, for the tests that check
 * it is never passed (design 0015, "The tests") and for diagnostics.
 */

const SWARM_IO_POOL_BYTES = 64 * 1024 * 1024;

const isBytes = (bytes) => Number.isSafeInteger(bytes) && bytes >= 0;

class SwarmIoPool {
  /** @param {number} [limit] - bytes, 64 MiB by default */
  constructor(limit = SWARM_IO_POOL_BYTES) {
    if (!isBytes(limit)) throw new TypeError('A Swarm I/O pool needs a byte limit');
    this.limit = limit;
    this.held = 0;
    this.highWater = 0;
  }

  /**
   * Charges `bytes`: false, and nothing charged, when they don't fit or
   * aren't a byte count. The interface service-client.js charges a pool
   * through, as it does its chain I/O pool.
   */
  take(bytes) {
    if (!isBytes(bytes) || bytes > this.limit - this.held) return false;
    this.held += bytes;
    if (this.held > this.highWater) this.highWater = this.held;
    return true;
  }

  /** Gives back `bytes` taken with `take` (never below nothing). */
  release(bytes) {
    if (!isBytes(bytes)) return;
    this.held = Math.max(0, this.held - bytes);
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
    if (!isBytes(bytes)) throw new TypeError('A Swarm I/O reservation needs a byte count');
    if (!this.take(bytes)) return null;
    const pool = this;
    let held = bytes;
    const giveBack = (amount) => {
      // A count that isn't whole bytes gives back nothing.
      const given = Math.min(Math.max(0, Number.isSafeInteger(amount) ? amount : 0), held);
      held -= given;
      pool.release(given);
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
const swarmIoPool = new SwarmIoPool();

module.exports = { SWARM_IO_POOL_BYTES, SwarmIoPool, swarmIoPool };
