/**
 * Ant's wallet rediscovery, as the node reports it in `/health.walletScan`.
 *
 * Since Ant v0.5.58 (#506, freedom-hq/ant#120), `/health.chainReady` no
 * longer waits for antd to rediscover the postage batches its wallet owns on
 * chain, so until that scan finishes `GET /stamps` can omit batches the
 * wallet already owns. Publish setup must not offer to buy storage in that
 * window (#510). Since v0.5.59 (freedom-hq/ant#142) antd reports the scan:
 *
 *   "walletScan": { "state": "scanning", "from": 16514506,
 *                   "scannedThrough": 41230000, "head": 48560000 }
 *
 *   - `pending`: a rediscovery will run but has not read the chain yet. Set
 *     before `chainReady`, so a node never reads ready with no scan reported.
 *   - `scanning`: reading the wallet's history; `scannedThrough` advances
 *     after every window (`null` until the first one).
 *   - `retrying`: the last attempt failed and antd retries on its own (15 s,
 *     doubling, at most 5 min), keeping its progress. Carries `error`, with
 *     URLs replaced by `<url>`.
 *   - `done`: up to date, and every batch found is registered, so `/stamps`
 *     already lists it.
 *   - `confirming` (freedom-hq/ant#143): as `done`, but part of the history
 *     came from an unverified source and is being confirmed in the
 *     background. What it found is registered; hosts treat it as `done`.
 *
 * The field is absent when the node tracks no background rediscovery: no
 * logs RPC, or no write RPC (antd then rediscovers before `chainReady`).
 * Freedom always gives the bundled node both, through the chain bridge.
 */

const SCANNING_STATES = new Set(['pending', 'scanning', 'retrying']);
const FINISHED_STATES = new Set(['done', 'confirming']);

const block = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * The `walletScan` object from a `/health` body, normalized; null when the
 * node reported none. An unrecognized `state` is kept as `unknown`, which
 * callers must not read as finished.
 */
function parseWalletScan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const state =
    SCANNING_STATES.has(raw.state) || FINISHED_STATES.has(raw.state) ? raw.state : 'unknown';
  return {
    state,
    from: block(raw.from),
    scannedThrough: block(raw.scannedThrough),
    head: block(raw.head),
    error: state === 'retrying' && typeof raw.error === 'string' ? raw.error.slice(0, 300) : null,
  };
}

function isWalletScanFinished(scan) {
  return Boolean(scan) && FINISHED_STATES.has(scan.state);
}

/**
 * How far the scan has got, as a whole percentage of the blocks from where
 * it started to `head`, or null before the first window is read. Capped at
 * 99 while it runs: only `done` says it is finished (antd can report `done`
 * a few blocks short of the head it started with).
 *
 * antd resets `from` to its resume point (the saved `scannedThrough` + 1) on
 * every retry and on restart, so `from` alone measures only the current
 * attempt: a scan 82% through would read 1% after one failure. `originFrom`
 * is the earliest `from` the caller has seen for this scan; when given, and
 * earlier than `from`, the percentage counts from there instead.
 */
function walletScanPercent(scan, originFrom = null) {
  if (!scan || !SCANNING_STATES.has(scan.state)) return null;
  const { scannedThrough, head } = scan;
  const from =
    block(originFrom) !== null && scan.from !== null && originFrom < scan.from
      ? originFrom
      : scan.from;
  if (from === null || scannedThrough === null || head === null || head < from) return null;
  const total = head - from + 1;
  const done = Math.min(Math.max(scannedThrough - from + 1, 0), total);
  return Math.min(99, Math.floor((done * 100) / total));
}

/**
 * Whether a node that reports no `walletScan` may still be rediscovering its
 * batches in the background, from `/health.version`. Only antd v0.5.58 does
 * that without reporting it: earlier releases rediscover before
 * `chainReady`, and from v0.5.59 an absent field means no background
 * rediscovery is running. An antd whose version cannot be read counts as
 * possibly rediscovering. Bee and other nodes do not do this.
 */
function mayRediscoverUnreported(version) {
  if (typeof version !== 'string') return false;
  const match = /^antd\/v?(\S*)/.exec(version.trim());
  if (!match) return false;
  const semver = /^(\d+)\.(\d+)\.(\d+)/.exec(match[1]);
  if (!semver) return true;
  return semver[1] === '0' && semver[2] === '5' && semver[3] === '58';
}

module.exports = {
  parseWalletScan,
  isWalletScanFinished,
  walletScanPercent,
  mayRediscoverUnreported,
};
