/**
 * Seed fetch status tracker.
 *
 * `rad seed` only records a seeding policy — whether the repository
 * actually replicates is a separate, asynchronous network fetch that can
 * take seconds, fail per-seed, or never complete (verified: `rad seed`
 * exits 0 even when its fetch times out). This module owns the truth
 * about that second phase so the provider can report it honestly.
 *
 * Three sources of truth, merged in getStatus():
 *  - storage presence (`<RAD_HOME>/storage/<rid>`): the repo is local. Wins.
 *  - the fetch driver: a bounded retry loop around `rad sync --fetch`,
 *    started by startFetch(). Its stdout yields the network-wide seeder
 *    count ("found N potential seed(s)").
 *  - the node's own log output, fed in via noteNodeOutput(): per-seed
 *    "Fetched … successfully" / "Fetch failed … : <error>" lines give
 *    real-time attempt results, including the node's background retries
 *    after our driver gives up.
 *
 * v1 caveats (deliberate): log parsing only works in managed-node mode —
 * with a reused system node we don't own the process, so per-seed
 * attempt detail degrades gracefully to driver results + storage checks.
 * The `.tmp` staging dir is a private radicle storage detail. The deeper
 * source for both is the node's control-socket event stream; migrate
 * there when polling outgrows v1.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('../logger');

// Per-attempt `rad sync` budget. The CLI's --timeout is not reliably
// honored mid-pack-transfer (observed hanging well past it), so every
// attempt also gets a hard kill.
const SYNC_TIMEOUT_SEC = 60;
const SYNC_KILL_MS = 75000;
const RETRY_DELAY_MS = 3000;
const MAX_ATTEMPTS = 3;
const MAX_ATTEMPT_LOG = 20;

/** rid -> record. Records live for the app session (or until unseed). */
const records = new Map();

const SEED_COUNT_RE = /found (\d+) potential seed/;
// Node log lines. Case matters: "Peer X fetched rad:… from us" must not match.
const NODE_FETCHED_RE = /Fetched (rad:[A-Za-z0-9]+) from ([A-Za-z0-9]+) successfully/;
const NODE_FAILED_RE = /Fetch failed for (rad:[A-Za-z0-9]+) from ([A-Za-z0-9]+): (.+)/;

function repoStorageDir(radHome, rid) {
  return path.join(radHome, 'storage', rid.replace(/^rad:/, ''));
}

function isInStorage(radHome, rid) {
  return fs.existsSync(repoStorageDir(radHome, rid));
}

// A fetch in flight stages into `<repo>.tmp`. Only a *fresh* .tmp counts:
// a crashed fetch leaves the dir behind forever, and reporting perpetual
// 'fetching' for it would make status consumers poll without end.
const TMP_FRESH_MS = 10 * 60 * 1000;

function fetchTmpActive(radHome, rid) {
  try {
    const stat = fs.statSync(`${repoStorageDir(radHome, rid)}.tmp`);
    return Date.now() - stat.mtimeMs < TMP_FRESH_MS;
  } catch {
    return false;
  }
}

function recordAttempt(record, attempt) {
  record.attempts.push({ ...attempt, at: Date.now() });
  if (record.attempts.length > MAX_ATTEMPT_LOG) record.attempts.shift();
  if (attempt.error) record.lastError = attempt.error;
}

function markFetched(record) {
  if (record.state === 'fetched') return;
  record.state = 'fetched';
  record.finishedAt = Date.now();
  log.info(`[seed-status] ${record.rid} fetched`);
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * One `rad sync --fetch` attempt. Resolves when the CLI exits or the hard
 * kill fires; per-seed outcomes arrive via noteNodeOutput in parallel.
 */
function runSyncAttempt(record, opts) {
  return new Promise((resolve) => {
    // Exactly one of 'error' / 'exit' may fire (a spawn failure — ENOENT on a
    // missing rad binary, EACCES, EMFILE — emits only 'error'), and a killed
    // child can emit both. Settle once, on whichever arrives first, or the
    // fetch loop awaits forever and the record is wedged at 'fetching' —
    // which startFetch's idempotency guard then treats as in-flight, killing
    // the retry path for good.
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      record.child = null;
      resolve();
    };

    let child;
    try {
      child = spawn(
        opts.radBin,
        ['sync', '--fetch', '--timeout', `${SYNC_TIMEOUT_SEC}sec`, record.rid],
        { env: { ...process.env, RAD_HOME: opts.radHome, RAD_PASSPHRASE: '' } }
      );
    } catch (err) {
      // spawn can throw synchronously (bad options); no child, nothing to clean up.
      record.lastError = err.message;
      resolve();
      return;
    }
    record.child = child;

    const killTimer = setTimeout(() => {
      log.warn(`[seed-status] ${record.rid} sync attempt hard-killed after budget`);
      child.kill('SIGKILL');
    }, opts.killMs ?? SYNC_KILL_MS);
    killTimer.unref?.(); // never keep the process alive for a fetch

    // rad prints progress AND errors on stdout; watch both streams anyway.
    const parseOutput = (data) => {
      const text = String(data);
      const match = SEED_COUNT_RE.exec(text);
      if (match) record.seedersKnown = Number(match[1]);
      // Nodes without reachable seeds fail instantly with this — it's the
      // precise "zero reachable seeds" signal (no "found N potential
      // seed(s)" line is printed in that case).
      if (record.seedersKnown === null && /no candidate seeds/.test(text)) {
        record.seedersKnown = 0;
      }
    };
    // Streams are absent when the spawn itself failed.
    child.stdout?.on('data', parseOutput);
    child.stderr?.on('data', parseOutput);
    child.on('error', (err) => {
      record.lastError = err.message;
      log.warn(`[seed-status] ${record.rid} sync attempt could not run: ${err.message}`);
      settle();
    });
    // 'exit', not 'close': a killed rad can leave subprocesses holding the
    // stdout pipe open, and 'close' would wait for them.
    child.on('exit', settle);
  });
}

async function runFetchLoop(record, opts) {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  for (let round = 0; round < maxAttempts && !record.cancelled; round++) {
    if (isInStorage(opts.radHome, record.rid)) break;
    if (round > 0) await delay(opts.retryDelayMs ?? RETRY_DELAY_MS);
    if (record.cancelled) break;
    await runSyncAttempt(record, opts);
  }
  if (record.cancelled) return;
  if (isInStorage(opts.radHome, record.rid) || record.state === 'fetched') {
    markFetched(record);
  } else {
    record.state = 'failed';
    record.finishedAt = Date.now();
    if (!record.lastError) {
      record.lastError =
        record.seedersKnown === 0
          ? 'No seeds for this repository are currently reachable'
          : 'Fetch did not complete within the retry budget';
    }
    log.warn(`[seed-status] ${record.rid} fetch failed: ${record.lastError}`);
  }
}

/**
 * Start (or reuse) a background fetch for a seeded repository.
 * Idempotent: a repo already fetching keeps its in-flight record; a repo
 * that previously failed gets a fresh run (that's the retry path).
 * @param {string} rid - full `rad:` RID (already validated by the caller)
 * @param {{radBin: string, radHome: string}} opts
 */
function startFetch(rid, opts) {
  const existing = records.get(rid);
  if (existing && existing.state === 'fetching') return existing;

  const record = {
    rid,
    state: 'fetching',
    startedAt: Date.now(),
    finishedAt: null,
    seedersKnown: existing?.seedersKnown ?? null,
    attempts: [],
    lastError: null,
    child: null,
    cancelled: false,
  };
  records.set(rid, record);

  record.done = runFetchLoop(record, opts).catch((err) => {
    record.state = 'failed';
    record.lastError = err.message;
    log.error(`[seed-status] ${rid} fetch loop error: ${err.message}`);
  });
  return record;
}

/** Stop tracking (and any in-flight driver) — the unseed path. */
function cancelFetch(rid) {
  const record = records.get(rid);
  if (!record) return;
  record.cancelled = true;
  if (record.child) record.child.kill('SIGKILL');
  records.delete(rid);
}

/**
 * Feed a chunk of radicle-node stdout. Cheap: scans only for the two
 * fetch-outcome line shapes, and only updates repos we track.
 */
function noteNodeOutput(text) {
  if (records.size === 0) return;
  // The node log is chatty; both target line shapes contain "Fetch".
  const chunk = String(text);
  if (!chunk.includes('Fetch')) return;
  for (const line of chunk.split('\n')) {
    let match = NODE_FAILED_RE.exec(line);
    if (match) {
      const record = records.get(match[1]);
      if (record) recordAttempt(record, { nid: match[2], ok: false, error: match[3].trim() });
      continue;
    }
    match = NODE_FETCHED_RE.exec(line);
    if (match) {
      const record = records.get(match[1]);
      if (record) {
        recordAttempt(record, { nid: match[2], ok: true });
        // The node can land a repo after our driver gave up (background
        // retries on announcements) — promote failed → fetched.
        markFetched(record);
      }
    }
  }
}

/**
 * Merged status for a repository. Storage presence is ground truth.
 * @returns {{rid: string, state: 'fetched'|'fetching'|'failed'|'idle',
 *   inStorage: boolean, seedersKnown: number|null, attemptCount: number,
 *   recentAttempts: Array, lastError: string|null,
 *   startedAt: number|null, finishedAt: number|null}}
 */
function getStatus(rid, radHome) {
  const record = records.get(rid);
  const inStorage = isInStorage(radHome, rid);
  let state;
  if (inStorage) {
    if (record) markFetched(record);
    state = 'fetched';
  } else if (record) {
    state = record.state === 'fetched' ? 'fetching' : record.state;
  } else {
    // Not tracked this session; a leftover .tmp means the node itself is
    // (or was) fetching in the background.
    state = fetchTmpActive(radHome, rid) ? 'fetching' : 'idle';
  }
  return {
    rid,
    state,
    inStorage,
    seedersKnown: record?.seedersKnown ?? null,
    attemptCount: record?.attempts.length ?? 0,
    recentAttempts: record ? record.attempts.slice(-5) : [],
    lastError: record?.lastError ?? null,
    startedAt: record?.startedAt ?? null,
    finishedAt: record?.finishedAt ?? null,
  };
}

/** Test hook. */
function _reset() {
  for (const record of records.values()) {
    record.cancelled = true;
    if (record.child) record.child.kill('SIGKILL');
  }
  records.clear();
}

module.exports = {
  startFetch,
  cancelFetch,
  noteNodeOutput,
  getStatus,
  _reset,
};
