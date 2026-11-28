/**
 * Swarm filter-list update manager (WP5 5.B2).
 *
 * One update cycle: read the signed manifest from the trust-anchored feed,
 * verify it, download the enabled categories' lists whose hashes changed,
 * verify each blob, write them + a browser-shaped manifest atomically to
 * userData/adblock/updated/, then rebuild the engine. On any failure the
 * previous updated dir (and the bundled floor beneath it) is left intact —
 * the browser never regresses on a bad update.
 *
 * The feed read and blob download are injected so the apply pipeline is
 * testable without a live node; the defaults read the node's API on its
 * transport (ant-storage-api.js).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { keccak256 } = require('ethers');
const log = require('../logger');
const { loadSettings } = require('../settings-store');
const {
  FEED_OWNER_ADDRESS,
  MANIFEST_SIG_ADDRESS,
  FEED_TOPIC,
  isTrustAnchorConfigured,
} = require('./feed-config');
const { verifyManifest, desktopListsFor } = require('./update-manifest');
const { refreshEngine, getEnabledFeedCategories } = require('./service');

// The feed read and each list download go through the Swarm node, and the
// node's transport sets no deadline of its own: it waits as long as the node
// does. A stuck retrieval must end the cycle (as feed_unavailable /
// download_failed, which the scheduler retries soon) rather than hold it.
// The feed read is a couple of small chunks, so it gets this long in total,
// and is cancelled then. A list download is multi-MB and can be slow but
// steady on a cold node, so it is an inactivity limit instead: it ends only
// after this long with no response headers and no body bytes, and an
// aborted download stops pulling bytes.
const IO_TIMEOUT_MS = 2 * 60 * 1000;

// The signed manifest is a few KB of JSON (a version, a signature and one
// entry per list). The feed read is held to this, well above any real
// manifest, so an oversized entry is refused before it is downloaded rather
// than held whole (browser main's manifest meter).
const MANIFEST_MAX_BYTES = 1024 * 1024;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Run `start(signal)`, failing after `ms` in total; the signal is aborted
// then, so the read lets its connection go.
function withTimeout(start, ms) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`timed out after ${ms / 1000} s`);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  return Promise.race([Promise.resolve().then(() => start(controller.signal)), timeout]).finally(
    () => clearTimeout(timer)
  );
}

// Run a transfer that reports its own progress, failing only after `ms` with
// none. The timer starts with the call and restarts on every progress() call
// (the transfer reports response headers and each body chunk); on expiry the
// signal is aborted so the transfer can release its connection.
function withInactivityTimeout(start, ms) {
  const controller = new AbortController();
  let timer;
  let settled = false;
  return new Promise((resolve, reject) => {
    const progress = () => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const err = new Error(`no progress for ${ms / 1000} s`);
        controller.abort(err);
        reject(err);
      }, ms);
    };
    progress();
    Promise.resolve()
      .then(() => start({ signal: controller.signal, progress }))
      .then(resolve, reject);
  }).finally(() => {
    settled = true;
    clearTimeout(timer);
  });
}

// ── Default Swarm-backed IO (replaced in tests) ──────────────────────────
//
// Both read the node's API on its transport (ant-storage-api.js's `antGet`;
// freedom-core design 0015, SWM-8): the bundled node, or any loopback one,
// with Node's fetch; a remote one on the default session's stack, through
// its proxy and Tor, each GET announced to the Ant API guard for its dial.
// One dial each, never retried, and a redirect is answered, never followed.
// They read the node as bee-js 13 did, with no bee-js.

// What bee-js's client asks for; the feed read also asks for the body as it
// is, so a declared length is the entry's (feed-service.js's latest read).
const ACCEPT = 'application/json, text/plain, */*';
const FEED_HEADERS = { accept: ACCEPT, 'accept-encoding': 'identity' };

/** The topic as bee-js's `Topic.fromString` makes it: keccak256 of its UTF-8, as hex. */
function feedTopicHex(topic) {
  return keccak256(new TextEncoder().encode(topic)).slice(2);
}

/** 20 bytes of hex, `0x` optional, any case, as bee-js's `EthAddress` takes them. */
function addressHex(address) {
  if (typeof address !== 'string' || !/^(0x)?[0-9a-f]{40}$/i.test(address)) {
    throw new Error(`the feed owner is not an Ethereum address: ${address}`);
  }
  return address.replace(/^0x/i, '').toLowerCase();
}

/** A 32- or 64-byte reference in hex, `0x` optional, any case, as bee-js's `Reference` takes it. */
function referenceHex(ref) {
  if (typeof ref !== 'string' || !/^(0x)?(?:[0-9a-f]{64}){1,2}$/i.test(ref)) {
    throw new Error(`not a Swarm reference: ${ref}`);
  }
  return ref.replace(/^0x/i, '').toLowerCase();
}

// A feed index header as bee-js's `FeedIndex` reads it: 8 bytes of hex.
const FEED_INDEX = /^(0x)?[0-9a-f]{16}$/i;

/** The body's declared length, or null when it has none it can be held to. */
function declaredLength(response) {
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') return null;
  const value = response.headers.get('content-length');
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const length = Number(value.trim());
  return Number.isSafeInteger(length) ? length : null;
}

function entryTooLarge(actual) {
  const err = new Error(`Feed entry exceeds the maximum read size of ${MANIFEST_MAX_BYTES} bytes`);
  err.reason = 'data_too_large';
  err.limit = MANIFEST_MAX_BYTES;
  if (actual !== undefined) err.actual = actual;
  return err;
}

/** A reply that isn't the content: its body let go, the status thrown. */
function nodeRefused(response, path) {
  response.body?.cancel().catch(() => {});
  return new Error(`GET ${path}: ${response.status} ${response.statusText}`.trim());
}

/**
 * The feed's latest entry, as the node resolves it (`GET /feeds/<owner>/
 * <topic>`), parsed as the manifest's JSON: the reply bee-js's feed reader
 * took (feed-service.js's `readFeedPayload`), checked as it checked it.
 *
 * - A 404 or a 500 is an empty feed; any other failure status fails too.
 * - Both index headers (`swarm-feed-index`, `swarm-feed-index-next`) must be
 *   there, each 8 bytes of hex.
 * - The body is held to MANIFEST_MAX_BYTES: a declared length past it is
 *   refused before the body is read, and the body is held to its declared
 *   length exactly; a body with none is refused once it passes the cap.
 */
async function defaultReadFeed({ signal } = {}) {
  const { antGet, readBody } = require('../swarm/ant-storage-api');
  const path = `/feeds/${addressHex(FEED_OWNER_ADDRESS)}/${feedTopicHex(FEED_TOPIC)}`;
  const response = await antGet(path, { headers: FEED_HEADERS, signal });
  if (!response.ok) {
    if (response.status === 404 || response.status === 500) {
      response.body?.cancel().catch(() => {});
      throw new Error('Feed is empty — no entries to read');
    }
    throw nodeRefused(response, path);
  }
  let declared;
  try {
    for (const name of ['swarm-feed-index', 'swarm-feed-index-next']) {
      const value = response.headers.get(name);
      if (!value) throw new Error(`Response did not contain expected ${name}!`);
      if (!FEED_INDEX.test(value)) throw new Error(`Response's ${name} is not a feed index`);
    }
    declared = declaredLength(response);
    if (declared !== null && declared > MANIFEST_MAX_BYTES) throw entryTooLarge(declared);
  } catch (err) {
    response.body?.cancel().catch(() => {});
    throw err;
  }
  const payload = await readBody(response, signal, (_bytes, total) => {
    if (declared === null) {
      if (total > MANIFEST_MAX_BYTES) throw entryTooLarge();
    } else if (total > declared) {
      throw new Error(`Node sent more than the ${declared} bytes it declared for the feed entry`);
    }
  });
  if (declared !== null && payload.length !== declared) {
    throw new Error(
      `Node sent ${payload.length} of the ${declared} bytes it declared for the feed entry`
    );
  }
  return JSON.parse(payload.toString('utf-8'));
}

/**
 * One list (`GET /bytes/<ref>`), streamed so each chunk counts as progress
 * for the inactivity timeout above: progress() once the headers are in, and
 * on each chunk. The abort signal handed in is what stops the transfer: it
 * aborts the dial, and once the headers are in, cancels the body
 * (ant-storage-api's `readBody`), which releases the connection. No size
 * cap, as bee-js had none: the list's sha256 is checked after.
 */
async function defaultDownloadBlob(ref, { signal, progress = () => {} } = {}) {
  const { antGet, readBody } = require('../swarm/ant-storage-api');
  const path = `/bytes/${referenceHex(ref)}`;
  const response = await antGet(path, { headers: { accept: ACCEPT }, signal });
  if (!response.ok) throw nodeRefused(response, path);
  progress();
  const blob = await readBody(response, signal, () => progress());
  if (signal?.aborted) throw signal.reason;
  return blob;
}

function getUpdateRoot() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'adblock');
}

// What's already applied on disk: the feed version (0 if none), the
// categories that update carried — only the ones enabled at download time, so
// a category enabled later is absent and needs backfilling — and the raw
// per-category entries so an apply can reuse still-valid local copies.
function readAppliedState(updatedDir) {
  try {
    const raw = fs.readFileSync(path.join(updatedDir, 'manifest.json'), 'utf-8');
    const local = JSON.parse(raw);
    const entries =
      local.categories && typeof local.categories === 'object' ? local.categories : {};
    return {
      version: Number.isInteger(local.feedVersion) ? local.feedVersion : 0,
      categories: Object.keys(entries),
      entries,
    };
  } catch {
    return { version: 0, categories: [], entries: {} };
  }
}

/**
 * Run one update cycle.
 *
 * @param {object} [io]
 * @param {(opts: {signal: AbortSignal}) => Promise<object|null>} [io.readFeed]
 *   - the signal aborts once the read has run timeoutMs
 * @param {(ref: string, opts: {signal: AbortSignal, progress: () => void}) => Promise<Buffer>} [io.downloadBlob]
 *   - call progress() on each sign of life; the download fails after
 *     timeoutMs without one
 * @param {string} [io.root] - override userData/adblock (tests)
 * @param {() => Promise<void>} [io.activate] - override refreshEngine (tests)
 * @param {number} [io.timeoutMs] - override IO_TIMEOUT_MS (tests)
 * @returns {Promise<{status: string, version?: number, reason?: string}>}
 */
async function runUpdateOnce(io = {}) {
  const readFeed = io.readFeed || defaultReadFeed;
  const downloadBlob = io.downloadBlob || defaultDownloadBlob;
  const activate = io.activate || refreshEngine;
  const root = io.root || getUpdateRoot();
  const sigAddress = io.sigAddress || MANIFEST_SIG_ADDRESS;
  const trustConfigured = io.trustConfigured ?? isTrustAnchorConfigured();
  const timeoutMs = io.timeoutMs ?? IO_TIMEOUT_MS;

  if (!trustConfigured) return { status: 'dormant' };
  if (loadSettings().adblockEnabled === false) return { status: 'disabled' };

  const updatedDir = path.join(root, 'updated');
  const applied = readAppliedState(updatedDir);
  const enabledCategories = getEnabledFeedCategories();
  // A category enabled after the last update landed isn't in updated/ — the
  // bundled floor serves it meanwhile, but the feed copy must be able to
  // backfill without waiting for the publisher to bump the version. Re-applying
  // the current version is safe (same signed content); older is still a
  // downgrade and stays rejected.
  const needsBackfill = enabledCategories.some((c) => !applied.categories.includes(c));

  let manifest;
  try {
    manifest = await withTimeout((signal) => readFeed({ signal }), timeoutMs);
  } catch (err) {
    log.info(`[adblock-update] feed read failed: ${err.message}`);
    return { status: 'feed_unavailable' };
  }
  if (!manifest) return { status: 'feed_empty' };

  const verdict = verifyManifest(manifest, {
    sigAddress,
    appliedVersion: applied.version,
    allowRepublish: needsBackfill,
  });
  if (!verdict.ok) {
    log.info(`[adblock-update] rejected manifest: ${verdict.reason}`);
    return { status: 'rejected', reason: verdict.reason };
  }

  const entries = desktopListsFor(manifest, enabledCategories);
  if (entries.length === 0) return { status: 'no_enabled_lists' };
  // Backfill path only: the republished version has nothing this install is
  // missing, so don't re-download and rebuild the engine every tick.
  if (
    manifest.version === applied.version &&
    entries.every((entry) => applied.categories.includes(entry.category))
  ) {
    return { status: 'up_to_date', version: manifest.version };
  }

  const stageDir = path.join(root, 'updated.next');

  // Download + verify every enabled list before touching disk.
  const files = [];
  for (const entry of entries) {
    // Belt-and-braces alongside verifyManifest's list_id schema check: the
    // resolved output path must stay a direct child of the staging dir, so
    // even a hostile list_id can never write outside it.
    const file = `${entry.list_id}.txt`;
    const dest = path.resolve(stageDir, file);
    if (path.dirname(dest) !== path.resolve(stageDir) || path.basename(dest) !== file) {
      log.warn(`[adblock-update] unsafe list_id ${JSON.stringify(entry.list_id)} — aborting`);
      return { status: 'rejected', reason: 'unsafe_list_id' };
    }
    // Reuse the applied copy when its hash already matches the manifest —
    // on a backfill only the newly-enabled category is actually missing, so
    // re-downloading the rest wastes bandwidth and re-opens the window for a
    // differently-signed same-version manifest to rewrite applied lists. The
    // read bytes are still hash-verified below like a download would be.
    let blob = null;
    const appliedEntry = applied.entries[entry.category];
    if (appliedEntry?.sha256 === entry.sha256 && appliedEntry.file) {
      try {
        blob = await fs.promises.readFile(path.join(updatedDir, path.basename(appliedEntry.file)));
      } catch {
        blob = null; // applied file missing/unreadable — fall through to download
      }
      if (blob && sha256Hex(blob) !== entry.sha256) blob = null;
    }
    if (!blob) {
      try {
        blob = await withInactivityTimeout((opts) => downloadBlob(entry.ref, opts), timeoutMs);
      } catch (err) {
        log.warn(`[adblock-update] download failed for ${entry.category}: ${err.message}`);
        return { status: 'download_failed', reason: entry.category };
      }
      if (sha256Hex(blob) !== entry.sha256) {
        log.warn(`[adblock-update] sha256 mismatch for ${entry.category} — aborting`);
        return { status: 'hash_mismatch', reason: entry.category };
      }
    }
    files.push({ entry, blob, file });
  }

  // Retain applied categories that are currently disabled but still valid at
  // this manifest version — discarding them would serve the older bundled
  // list for up to a tick if the user re-enables one.
  for (const [category, appliedEntry] of Object.entries(applied.entries)) {
    if (files.some(({ entry }) => entry.category === category)) continue;
    const manifestEntry = manifest.platforms.desktop.lists.find(
      (candidate) => candidate.category === category
    );
    if (!manifestEntry || manifestEntry.sha256 !== appliedEntry?.sha256 || !appliedEntry.file) {
      continue;
    }
    const file = path.basename(appliedEntry.file);
    let blob;
    try {
      blob = await fs.promises.readFile(path.join(updatedDir, file));
    } catch {
      continue; // nothing local to retain
    }
    if (sha256Hex(blob) !== manifestEntry.sha256) continue;
    files.push({ entry: manifestEntry, blob, file });
  }

  // Stage, then promote atomically. Keep the prior updated dir as last-known-good.
  const prevDir = path.join(root, 'updated.prev');
  await fs.promises.rm(stageDir, { recursive: true, force: true });
  await fs.promises.mkdir(stageDir, { recursive: true });

  const categories = {};
  for (const { entry, blob, file } of files) {
    await fs.promises.writeFile(path.join(stageDir, file), blob);
    categories[entry.category] = {
      file,
      title: entry.title,
      sourceUrl: entry.source_url,
      license: entry.license,
      sha256: entry.sha256,
      bytes: entry.bytes,
      ruleCount: entry.rule_count,
    };
  }
  // Browser-shaped manifest (what service.js reads) + the feed version for the
  // next applied-version check.
  await fs.promises.writeFile(
    path.join(stageDir, 'manifest.json'),
    JSON.stringify(
      { version: manifest.generated_at, feedVersion: manifest.version, categories },
      null,
      2
    )
  );

  // Scriptlet resources are not carried by the feed yet: the staged manifest
  // has no `resources`, so service.js keeps serving the bundled floor's
  // (digest-checked at load, see readResources). When the feed publishes
  // them, verify the blob against the feed sha256 here before staging, like
  // the lists above — tracked in #415.

  // Promote: current → prev, next → current.
  await fs.promises.rm(prevDir, { recursive: true, force: true });
  if (fs.existsSync(updatedDir)) await fs.promises.rename(updatedDir, prevDir);
  await fs.promises.rename(stageDir, updatedDir);

  try {
    await activate();
  } catch (err) {
    // Roll back to last-known-good and rebuild from it.
    log.error(`[adblock-update] engine rebuild failed, rolling back: ${err.message}`);
    await fs.promises.rm(updatedDir, { recursive: true, force: true });
    if (fs.existsSync(prevDir)) await fs.promises.rename(prevDir, updatedDir);
    await activate().catch(() => {});
    return { status: 'activate_failed', reason: err.message };
  }

  await fs.promises.rm(prevDir, { recursive: true, force: true });
  log.info(`[adblock-update] applied version ${manifest.version} (${entries.length} lists)`);
  return { status: 'applied', version: manifest.version };
}

module.exports = {
  runUpdateOnce,
  MANIFEST_MAX_BYTES,
  _defaultReadFeed: defaultReadFeed,
  _defaultDownloadBlob: defaultDownloadBlob,
  _feedTopicHex: feedTopicHex,
};
