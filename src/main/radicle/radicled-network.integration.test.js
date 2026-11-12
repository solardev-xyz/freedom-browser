/**
 * The network operations on the real freedom-radicled (freedom-core design
 * 0008, Methods `rad.connect_seeds` and `rad.clone`, Progress; the radicled
 * step-5 plan's B9), through the production manager, `radicle-embedded.js`
 * and `seed-status.js` under `FREEDOM_RADICLE_BACKEND=service`: the contract
 * suite's radicled backend (test/helpers/radicle-contract-backends.js), its
 * fixture's home, and its key sealed to the process. Skipped unless
 * FREEDOM_RADICLED_PATH names a build, e.g.
 *   FREEDOM_RADICLED_PATH=freedom-radicled-bin/linux-x64/freedom-radicled \
 *     npx jest src/main/radicle/radicled-network.integration
 *
 * Off the network: the process runs under `--network socks5:` at a closed
 * loopback port, and the home names no peer to dial. Before the start, its
 * routing table is given seeders for two repositories, nodes that are never
 * connected: a clone of those resolves candidates whose fetches fail "not
 * connected", which libradicle retries every 500 ms (its handshake
 * backoff) while its time allows.
 *
 * - **the background start** (B6's, through the network operations):
 *   `rad.connect_seeds(15000)` finds no seed, and the default repository's
 *   clone none;
 * - **a seed with no seeder known:** `no seeds found`, its terminal event
 *   before the error, and a sync of it, now seeded;
 * - **the cancel's timing:** a clone in its handshake retries, cancelled:
 *   `cancelClone` answers at once, and the clone stops within its backoff's
 *   check, `cancelled` last;
 * - **more than 16 failed candidates:** each failure reaches main, a summary
 *   counting those the service folded, the terminal last.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const binary = process.env.FREEDOM_RADICLED_PATH;
const describeIfBinary = binary ? describe : describe.skip;
const TEST_MS = 120_000;
const SRC = path.join(__dirname, '..');

/** A repository no seeder is known for. */
const UNSEEDED = 'rad:zAZKsERFwcegAzRw2RfVDVPH3mDe';
/** One never-connected seeder known: its clone retries until cancelled. */
const STUCK = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
/** Twenty of them: each fails at once once its clone's time is short. */
const BURST = 'rad:zioqhMLRQeAybtee3uXQbVUVFmqd';
const BURST_SEEDERS = 20;
/** Under libradicle's 500 ms backoff, so no candidate is retried. */
const BURST_TIMEOUT_MS = 450;
const DEFAULT_RID = 'rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** A node ID no one holds: an Ed25519 public key's `z6Mk…` form. */
const randomNid = () =>
  `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), crypto.randomBytes(32)]))}`;

/** Records `seeders` as seeding `rid` in the home's routing table, each with
 * an address it never dials (the SOCKS policy refuses every connection). */
function addSeeders(home, rid, seeders) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(home, 'node', 'node.db'));
  try {
    const now = Date.now();
    for (const nid of seeders) {
      db.prepare('insert into nodes (id, features, alias, timestamp) values (?, 0, ?, ?)').run(
        nid,
        'seeder',
        now
      );
      db.prepare(
        'insert into addresses (node, type, value, source, timestamp) values (?, ?, ?, ?, ?)'
      ).run(nid, 'dns', 'seed.invalid:8776', 'peer', now);
      db.prepare('insert into routing (repo, node, timestamp) values (?, ?, ?)').run(rid, nid, now);
    }
  } finally {
    db.close();
  }
}

/** Resolves once `check()` is truthy, polling; rejects after `ms`. */
async function until(check, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const lines = (mock) => mock.mock.calls.map((parts) => parts.map(String).join(' '));

describeIfBinary('the network operations on the real freedom-radicled', () => {
  let home;
  let backend;
  let embedded;
  let seedStatus;

  beforeAll(async () => {
    const { BACKENDS } = require('../../../test/helpers/radicle-contract-backends');
    const { restoreSnapshot } = require('../../../test/helpers/radicle-fixture');
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'radicled-network-'));
    restoreSnapshot(home);
    addSeeders(home, STUCK, [randomNid()]);
    addSeeders(home, BURST, Array.from({ length: BURST_SEEDERS }, randomNid));
    backend = await BACKENDS.radicled.load({ home, networkOnBinary: true });
    await backend.start();
    // The registry the manager loaded with.
    embedded = backend.embedded;
    seedStatus = require(path.join(SRC, 'radicle', 'seed-status.js'));
  }, TEST_MS);

  afterAll(async () => {
    await backend?.close();
    if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, TEST_MS);

  test(
    "the background start: rad.connect_seeds finds no seed, and the default repository's clone none",
    async () => {
      const warned = await until(() =>
        lines(backend.log.warn).find((line) =>
          line.startsWith('[Radicle] Background network initialization failed:')
        )
      );
      expect(warned).toBe(
        `[Radicle] Background network initialization failed: no seeds found for ${DEFAULT_RID}`
      );
      // The report as libradicle wrote it: no seed in the book, so its target
      // of none is reached, in a millisecond or so.
      expect(lines(backend.log.info)).toContainEqual(
        expect.stringMatching(
          /^\[Radicle\] Seed bootstrap ready: 0\/0 seed connections, 0 live peers, 0 attempted in \d+ms$/
        )
      );
    },
    TEST_MS
  );

  test(
    'a seed with no seeder known: no seeds found, its terminal event first; then a sync of it, now seeded',
    async () => {
      const statuses = [];
      const started = await backend.manager.seedRepository(UNSEEDED, (s) => statuses.push(s));
      expect(started).toMatchObject({ success: true, status: { state: 'fetching' } });
      await started.status.done;
      const message = `no seeds found for ${UNSEEDED}`;
      expect(statuses.map((s) => [s.state, s.progress])).toEqual([
        ['fetching', { phase: 'starting' }],
        ['fetching', { reason: message, phase: 'failed' }],
        ['failed', { phase: 'failed', reason: message }],
      ]);
      expect(statuses.at(-1)).toMatchObject({ lastError: message, seedersKnown: 0 });

      // The clone wrote its seeding policy: a sync is allowed, and fetches.
      const synced = await backend.manager.refetchRepository(UNSEEDED);
      expect(synced).toMatchObject({ success: true });
      await synced.status.done;
      await expect(backend.manager.getSeedFetchStatus(UNSEEDED)).resolves.toMatchObject({
        success: true,
        status: { state: 'failed', inStorage: false, attemptCount: 2, lastError: message },
      });
    },
    TEST_MS
  );

  test(
    "the cancel's timing: a clone in its handshake retries, cancelled, stops within its backoff's check, cancelled last",
    async () => {
      const statuses = [];
      const started = await backend.manager.seedRepository(STUCK, (s) => statuses.push(s));
      await until(() => statuses.find((s) => s.progress?.phase === 'fetching'));
      const settled = { done: false };
      started.status.done.then(() => (settled.done = true));
      // Retrying, for up to 120 s: nothing has settled it.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(settled.done).toBe(false);

      const cancelledAt = Date.now();
      await expect(embedded.cancelClone(STUCK)).resolves.toEqual({ cancelled: true });
      await started.status.done;
      const took = Date.now() - cancelledAt;
      // libradicle checks its token every 50 ms of its backoff.
      expect(took).toBeLessThan(2_000);
      expect(statuses.slice(-2).map((s) => [s.state, s.progress?.phase])).toEqual([
        ['fetching', 'cancelled'],
        ['cancelled', 'cancelled'],
      ]);
      await expect(embedded.cancelClone(STUCK)).resolves.toEqual({ cancelled: false });
    },
    TEST_MS
  );

  test(
    'more than 16 failed candidates: every failure reaches main, the terminal last, and seed-status counts them all',
    async () => {
      const events = [];
      const statuses = [];
      const fetch = seedStatus.startFetch(BURST, {
        fetchRepo: (rid, onProgress) =>
          embedded.cloneRepoWithProgress(rid, BURST_TIMEOUT_MS, (event) => {
            events.push(event);
            onProgress(event);
          }),
        onStatus: (status) => statuses.push(status),
      });
      await fetch.done;
      const failures = events.filter((event) => event.phase === 'peer-failed');
      const counted = failures.reduce((n, e) => n + (e.summary ? e.summary.count : 1), 0);
      expect(counted).toBe(BURST_SEEDERS);
      for (const summary of failures.filter((e) => e.summary)) {
        expect(summary.summary.reasons.length).toBeGreaterThan(0);
        expect(summary.summary.reasons.length).toBeLessThanOrEqual(4);
      }
      // At most 8 single failures wait at once: the rest come folded.
      expect(failures.filter((e) => !e.summary).length).toBeLessThanOrEqual(BURST_SEEDERS);
      expect(events.at(-1)).toMatchObject({ phase: 'failed' });
      expect(events.at(-1).reason).toMatch(new RegExp(`^fetching ${BURST} failed: `));
      // seed-status's statuses count the same failures.
      const statusCount = statuses
        .filter((s) => s.progress?.phase === 'peer-failed')
        .reduce((n, s) => n + ('count' in s.progress ? s.progress.count : 1), 0);
      expect(statusCount).toBe(BURST_SEEDERS);
      expect(statuses.at(-1)).toMatchObject({ state: 'failed', lastError: events.at(-1).reason });
    },
    TEST_MS
  );
});
