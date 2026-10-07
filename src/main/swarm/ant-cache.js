/**
 * The Swarm node's chunk cache (#579): how big it may grow, and what it holds.
 *
 * Size. Ant reads bee's `cache-capacity` key (a chunk count, × 4096 bytes)
 * from the config.yaml Freedom writes (ant-manager.js buildAntConfigContent).
 * Since Ant v0.5.61 (https://github.com/freedom-hq/ant/pull/150) a running
 * node also takes a new size live, `PUT /v0/cache/capacity` with
 * `{"bytes": N}`, evicting down to it before it answers; Ant doesn't persist
 * that, so the setting (and so the next config.yaml) is saved first and the
 * live call only spares the restart. The size is one of a fixed set, so a
 * value Ant would reject (a malformed `cache-capacity` is a startup error) can
 * never reach the file: anything else read from settings falls back to the
 * default.
 *
 * Status. `GET /v0/cache` (Ant v0.5.61+) gives the live figures in bytes; a
 * node without it is read through `GET /debugstore` (bee's `debugStorage`
 * shape, Ant v0.5.60+), which gives chunk counts: `Cache.Size` unpinned
 * chunks, `Cache.Capacity` the cap ÷ 4096, `ChunkStore.TotalChunks` every
 * chunk on disk, pinned or not. The main process reads them — the chrome's Ant API allowlist (ant-api-chrome.js) and
 * web content's guard (ant-api-guard.js) stay as they are — and hands
 * Settings → Nodes → Swarm cache one summary line over a settings-only channel.
 *
 * Clear. `POST /v0/cache/clear` (Ant v0.5.61+) removes every unpinned chunk
 * from the disk and in-memory caches and gives the space back; pinned and
 * published content stays (deleting chunks.sqlite would lose the pins). It
 * answers `{freed_bytes, removed_chunks, file_bytes_before, file_bytes_after,
 * memory_chunks_removed, status}`. With no disk cache it still answers 200,
 * having emptied only the memory tier, so Settings offers Clear only while the
 * usage line has a disk figure.
 *
 * Both writes are called from here, the main process, only. Ant answers them
 * only for a loopback caller that isn't a web page (no `Origin`, no cross-site
 * `Sec-Fetch-Site`), which Node's fetch is; web content can't reach the node's
 * API at all (ant-api-guard.js), and the chrome's read-only allowlist
 * (ant-api-chrome.js) doesn't list them.
 */

const fs = require('fs');
const path = require('path');

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

// Bee's chunk size, the factor `cache-capacity` and `/debugstore` count in.
const CHUNK_BYTES = 4096;

// Ant's FFI clamp (64 MiB–16 GiB); every size here sits inside it.
const MIN_CACHE_BYTES = 64 * MIB;
const MAX_CACHE_BYTES = 16 * GIB;

const CACHE_SIZES = Object.freeze([512 * MIB, 1 * GIB, 2 * GIB, 5 * GIB, 10 * GIB, 16 * GIB]);

const DEFAULT_CACHE_BYTES = 2 * GIB;

// What Ant uses with no cache key at all (`--disk-cache-max-gb`'s default),
// so what every install had before Freedom wrote the key.
const LEGACY_CACHE_BYTES = 10 * GIB;

// Ant counts an existing cache in the background after it opens it, and
// `/debugstore` reads 0 meanwhile (Ant documents ~30 s). Within this window of
// the spawn, an all-zero answer over a cache file at least this big is Ant
// still counting, not an empty cache. Same bounds as Android (#413).
const COUNTING_WINDOW_MS = 60_000;
const COUNTING_MIN_FILE_BYTES = 1 * MIB;

const STATUS_TIMEOUT_MS = 5_000;

// A clear deletes every unpinned row and vacuums, and a resize evicts down to
// the new size, before Ant answers: on a cache of several GB that is a while.
const WRITE_TIMEOUT_MS = 120_000;

/** `bytes` when it is one of the sizes, else null. */
function normalizeCacheBytes(bytes) {
  return CACHE_SIZES.includes(bytes) ? bytes : null;
}

/** The size to use for a stored value: the value if it is a size, else the default. */
function resolveCacheBytes(stored) {
  return normalizeCacheBytes(stored) ?? DEFAULT_CACHE_BYTES;
}

/** `cache-capacity`'s chunk count for a size (any input resolves to a size first). */
function cacheCapacityChunks(bytes) {
  return resolveCacheBytes(bytes) / CHUNK_BYTES;
}

/**
 * The cache size to write for this start, and whether to save it.
 *
 * `stored` is the `antCacheCapacityBytes` setting (null until a size is
 * chosen). `hasExistingCache` is whether this profile's data dir already holds
 * a chunks.sqlite.
 *
 * A profile whose node already built a cache under an older Freedom has been
 * running at Ant's 10 GiB. It keeps 10 GB until the user picks: dropping to
 * 2 GB on upgrade would throw away up to 8 GB of cached pages, and a cache
 * file made before Ant v0.5.60 does not hand that space back to the disk
 * right away, so the user would lose the cache without getting the space. A
 * profile with no cache yet gets the default. Either way the choice is saved
 * on this first start, so a cache built from now on doesn't later read as an
 * old one, and Settings shows what the node uses.
 *
 * (The config file can't tell the two apart: identity injection rewrites
 * config.yaml without a cache key on new profiles too.)
 */
function chooseCacheBytes({ stored, hasExistingCache }) {
  if (stored !== null && stored !== undefined) {
    return { bytes: resolveCacheBytes(stored), save: false };
  }
  return { bytes: hasExistingCache ? LEGACY_CACHE_BYTES : DEFAULT_CACHE_BYTES, save: true };
}

/** "512 MB", "2 GB", "1.3 GB": binary units, a decimal only when it isn't whole. */
function formatCacheBytes(bytes) {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  const rounded = Math.round(scaled * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[unit]}`;
}

/** The size as the picker names it, "(default)" on the default. */
function cacheSizeLabel(bytes) {
  const label = formatCacheBytes(bytes);
  return bytes === DEFAULT_CACHE_BYTES ? `${label} (default)` : label;
}

function chunkCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * `/debugstore`'s body as `{ diskEnabled, usedBytes, capacityBytes,
 * pinnedBytes, chunks }`, or null when it isn't bee's shape (garbage, an
 * error body, a node too old to have the route).
 *
 * Bytes are chunk counts × 4096, bee's own conversion, so they are close to
 * (a little under) what is on disk. `Cache.Capacity` 0 means Ant has no disk
 * cache (it couldn't open it, or runs with `--no-disk-cache`). Pinned chunks
 * are every chunk on disk minus the unpinned ones; `Pinning.TotalChunks` is
 * not used because it counts a chunk once per pin that holds it.
 */
function parseDebugstore(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const cache = data.Cache;
  if (!cache || typeof cache !== 'object') return null;
  const capacity = chunkCount(cache.Capacity);
  if (capacity === null) return null;
  const size = chunkCount(cache.Size) ?? 0;
  const total = chunkCount(data.ChunkStore?.TotalChunks);
  const pinned = total !== null && total > size ? total - size : 0;
  return {
    diskEnabled: capacity > 0,
    usedBytes: size * CHUNK_BYTES,
    capacityBytes: capacity * CHUNK_BYTES,
    pinnedBytes: pinned * CHUNK_BYTES,
    chunks: size + pinned,
  };
}

/**
 * `GET /v0/cache`'s body (Ant v0.5.61+, bytes rather than chunk counts) in the
 * same shape as parseDebugstore, or null when it isn't Ant's shape.
 * `chunks` counts pinned chunks too, as parseDebugstore's does.
 */
function parseCacheStatus(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (typeof data.disk_enabled !== 'boolean') return null;
  const capacityBytes = byteCount(data.capacity_bytes);
  if (capacityBytes === null) return null;
  const chunks = chunkCount(data.chunks) ?? 0;
  const pinnedChunks = chunkCount(data.pinned_chunks) ?? 0;
  return {
    diskEnabled: data.disk_enabled,
    usedBytes: byteCount(data.used_bytes) ?? 0,
    capacityBytes,
    pinnedBytes: byteCount(data.pinned_bytes) ?? 0,
    chunks: chunks + pinnedChunks,
  };
}

/**
 * Whether an all-zero reading is Ant still counting the cache it just opened:
 * the disk cache is on, nothing counted, the node was spawned less than a
 * minute ago, and the cache file is big enough not to be empty. Only known for
 * the node Freedom spawned (its spawn time and data dir); otherwise false.
 */
function isCounting(parsed, { sinceSpawnMs, fileBytes }) {
  if (!parsed?.diskEnabled) return false;
  if (parsed.chunks > 0) return false;
  if (!Number.isFinite(sinceSpawnMs) || sinceSpawnMs < 0 || sinceSpawnMs >= COUNTING_WINDOW_MS) {
    return false;
  }
  return Number.isFinite(fileBytes) && fileBytes >= COUNTING_MIN_FILE_BYTES;
}

/** "1.3 GB of 2 GB · 120 MB pinned", the pinned part only when there is some. */
function cacheSummary({ usedBytes, capacityBytes, pinnedBytes }) {
  const used = `${formatCacheBytes(usedBytes)} of ${formatCacheBytes(capacityBytes)}`;
  return pinnedBytes > 0 ? `${used} · ${formatCacheBytes(pinnedBytes)} pinned` : used;
}

// Settings' cache usage line for each state: `text` is the value, `reason`
// the line under it saying why there is no figure (empty when there is one).
const STATE_COPY = {
  'not-running': { text: 'Not running', reason: 'Shown while the Swarm node is running.' },
  starting: { text: 'Starting…', reason: 'Shown once the Swarm node is running.' },
  'disk-off': {
    text: 'Unavailable',
    reason: "The node couldn't open its disk cache. Restarting the node tries again.",
  },
  unreadable: { text: 'Unknown', reason: "This Swarm node doesn't report its cache." },
};

/**
 * The usage line for a node `status` and its `/debugstore` answer.
 *
 * @returns {{ state: string, text: string, reason: string, usedBytes?: number,
 *   capacityBytes?: number, pinnedBytes?: number }}
 */
function describeCache({ nodeStatus, parsed, counting = false }) {
  if (nodeStatus === 'starting') return { state: 'starting', ...STATE_COPY.starting };
  if (nodeStatus !== 'running') return { state: 'not-running', ...STATE_COPY['not-running'] };
  if (!parsed) return { state: 'unreadable', ...STATE_COPY.unreadable };
  if (!parsed.diskEnabled) return { state: 'disk-off', ...STATE_COPY['disk-off'] };
  const figures = {
    usedBytes: parsed.usedBytes,
    capacityBytes: parsed.capacityBytes,
    pinnedBytes: parsed.pinnedBytes,
  };
  if (counting) {
    return {
      state: 'counting',
      text: `Counting… (${formatCacheBytes(parsed.capacityBytes)} max)`,
      reason: 'The node is still counting its cache after starting.',
      ...figures,
    };
  }
  return { state: 'ok', text: cacheSummary(parsed), reason: '', ...figures };
}

/** Size of chunks.sqlite with its WAL, or null when there is no file. */
function cacheFileBytes(dataDir) {
  if (!dataDir) return null;
  let total = null;
  for (const name of ['chunks.sqlite', 'chunks.sqlite-wal']) {
    try {
      total = (total ?? 0) + fs.statSync(path.join(dataDir, name)).size;
    } catch {
      // Missing file: contributes nothing.
    }
  }
  return total;
}

function byteCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * `POST /v0/cache/clear`'s body as `{ freedBytes, fileBytesBefore,
 * fileBytesAfter, diskEnabled }`, or null when it isn't Ant's shape.
 */
function parseClearReport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const freedBytes = byteCount(data.freed_bytes);
  if (freedBytes === null) return null;
  return {
    freedBytes,
    fileBytesBefore: byteCount(data.file_bytes_before),
    fileBytesAfter: byteCount(data.file_bytes_after),
    diskEnabled: data.status?.disk_enabled !== false,
  };
}

/**
 * What Settings says after a clear: "Freed 1.3 GB", or that there was nothing
 * to free. Ant frees the chunks at once but a cache file made before v0.5.60
 * is rebuilt smaller only when there is room for it, so when the file on disk
 * didn't shrink the line says the space is reused rather than promise it back.
 */
function describeClearResult(report) {
  if (report.freedBytes === 0) return 'Freed 0 B. The cache was already empty.';
  const freed = `Freed ${formatCacheBytes(report.freedBytes)}.`;
  const { fileBytesBefore: before, fileBytesAfter: after } = report;
  if (before !== null && after !== null && after >= before) {
    return `${freed} The cache file keeps its size on disk; the node reuses the space.`;
  }
  return freed;
}

/**
 * The sentence for a `/v0/cache` write that didn't go through. `failure` is
 * `{ status, message }` for an answer (`message` from Ant's `{code, message}`
 * error body, when there is one) or `{ timedOut }` / `{}` for none.
 */
function describeCacheWriteError(action, failure = {}) {
  const what = action === 'clear' ? 'clear its cache' : 'change its cache size';
  const { status, message, timedOut } = failure;
  if (timedOut) return 'The Swarm node took too long to answer.';
  if (!status) return "The Swarm node didn't answer.";
  if (status === 404 || status === 405 || status === 501) {
    return `This Swarm node can't ${what} while it runs.`;
  }
  if (status === 503) return "The node's disk cache isn't available.";
  const detail = typeof message === 'string' && message.trim() ? `: ${message.trim()}` : '';
  return `The Swarm node couldn't ${what} (${status}${detail}).`;
}

/**
 * The usage line, read live. Dependencies are injectable for tests and for the
 * e2e's fake node.
 */
function createAntCacheService({
  getNodeStatus,
  getApiBase,
  getSpawnedAt = () => null,
  getDataDir = () => null,
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
  timeoutMs = STATUS_TIMEOUT_MS,
  writeTimeoutMs = WRITE_TIMEOUT_MS,
} = {}) {
  // The spawn whose cache was cleared. Ant can't hand the space of a cache
  // file made before v0.5.60 back, so after a clear an all-zero reading over
  // a big file is the truth, not Ant still counting (Android #413 does the same).
  let clearedSpawnedAt = null;

  // One write to the node: `{ ok: true, data }` with the JSON body, or
  // `{ ok: false, status?, message?, timedOut? }`.
  async function writeToNode(route, init) {
    const base = getApiBase();
    if (typeof base !== 'string' || !base) return { ok: false };
    let response;
    try {
      response = await fetchImpl(`${base.replace(/\/$/, '')}${route}`, {
        ...init,
        signal: AbortSignal.timeout(writeTimeoutMs),
      });
    } catch (err) {
      return { ok: false, timedOut: err?.name === 'TimeoutError' };
    }
    let text = '';
    try {
      text = await response.text();
    } catch {
      // An unreadable body: judged by the status alone.
    }
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON (axum's own rejections are plain text).
    }
    if (!response.ok) {
      const message = typeof data?.message === 'string' ? data.message : text.slice(0, 200);
      return { ok: false, status: response.status, message };
    }
    return { ok: true, data };
  }

  /**
   * Clear the cache of the running node: `{ ok: true, freedBytes, text }` or
   * `{ ok: false, error }`.
   */
  async function clearCache() {
    if (getNodeStatus()?.status !== 'running') {
      return { ok: false, error: "The Swarm node isn't running." };
    }
    const answer = await writeToNode('/v0/cache/clear', { method: 'POST' });
    if (!answer.ok) return { ok: false, error: describeCacheWriteError('clear', answer) };
    const report = parseClearReport(answer.data);
    if (!report) return { ok: false, error: "The Swarm node's answer couldn't be read." };
    if (!report.diskEnabled) {
      return { ok: false, error: "The node's disk cache isn't available, so nothing was cleared." };
    }
    clearedSpawnedAt = getSpawnedAt();
    return { ok: true, freedBytes: report.freedBytes, text: describeClearResult(report) };
  }

  /**
   * Set the running node's cache size live: `{ ok: true }`, or
   * `{ ok: false, applied, error }`. `applied`: Ant set the size but its
   * eviction down to it failed (a 500); the next cache write evicts again, so
   * the size still holds.
   */
  async function setCapacity(bytes) {
    const answer = await writeToNode('/v0/cache/capacity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bytes }),
    });
    if (answer.ok) return { ok: true };
    return {
      ok: false,
      applied: answer.status === 500,
      error: describeCacheWriteError('resize', answer),
    };
  }

  // One GET: `{ data }` with the parsed JSON body, `{ missing: true }` for a
  // node without the route (or a body that isn't JSON), or null for no answer.
  async function readJson(route) {
    const base = getApiBase();
    if (typeof base !== 'string' || !base) return null;
    try {
      const response = await fetchImpl(`${base.replace(/\/$/, '')}${route}`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        return { missing: true };
      }
      try {
        return { data: JSON.parse(await response.text()) };
      } catch {
        return { missing: true };
      }
    } catch {
      return null;
    }
  }

  // `GET /v0/cache` first: live counters, in bytes. `/debugstore` reads a
  // status snapshot the node refreshes on a tick, so right after a clear or a
  // live resize it can still show the old figures for a moment (measured
  // 0.1–0.25 s on v0.5.61). A node without `/v0/cache` (a reused bee, an Ant
  // before v0.5.61) is read through `/debugstore`.
  async function readUsage() {
    const live = await readJson('/v0/cache');
    if (!live) return null;
    const parsed = live.data ? parseCacheStatus(live.data) : null;
    if (parsed) return parsed;
    const store = await readJson('/debugstore');
    return store?.data ? parseDebugstore(store.data) : null;
  }

  async function getStatus() {
    const nodeStatus = getNodeStatus()?.status;
    if (nodeStatus !== 'running') return describeCache({ nodeStatus });
    const parsed = await readUsage();
    // The status can change while the read is out; a node that stopped
    // meanwhile reads as not running, not as unreadable.
    if (getNodeStatus()?.status !== 'running') return describeCache({ nodeStatus: 'stopped' });
    const spawnedAt = getSpawnedAt();
    const counting =
      Number.isFinite(spawnedAt) &&
      spawnedAt !== clearedSpawnedAt &&
      isCounting(parsed, {
        sinceSpawnMs: now() - spawnedAt,
        fileBytes: parsed?.diskEnabled && parsed.chunks === 0 ? cacheFileBytes(getDataDir()) : null,
      });
    return describeCache({ nodeStatus: 'running', parsed, counting });
  }

  return { getStatus, clearCache, setCapacity };
}

/**
 * Settings → Nodes → Swarm cache size: what the picker shows and whether it
 * can change anything. `managed` false (an external, disabled or reused node)
 * comes with the reason, and `clearReason` the same for Clear cache.
 * `nodeActive`: the node Freedom runs is up, so a new size applies live.
 * `hasExistingCache`: this profile's data dir already holds a chunks.sqlite,
 * which decides the size the first start writes.
 */
function cacheSettingsView({
  stored,
  hasExistingCache = false,
  profileMode,
  registryMode,
  nodeActive = false,
}) {
  let reason = '';
  let clearReason = '';
  if (profileMode === 'external' || registryMode === 'reused') {
    reason = "Freedom doesn't run this Swarm node. Set its cache size where it runs.";
    clearReason = "Freedom doesn't run this Swarm node. Clear its cache where it runs.";
  } else if (profileMode === 'disabled') {
    reason = 'The Swarm node is off for this profile under Settings → Nodes.';
    clearReason = reason;
  }
  // Before the first start there is no stored size yet; show the one that
  // start will write (chooseCacheBytes), so an upgrader with an old cache sees
  // 10 GB and can pick 2 GB before the node ever starts.
  return {
    bytes: chooseCacheBytes({ stored, hasExistingCache }).bytes,
    // What settings hold (null until chosen or first start): the renderer
    // compares a settings broadcast against this, not against `bytes`.
    // The raw stored value, not the normalized one: a hand-edited size
    // outside the set would otherwise read as null here and never match.
    storedBytes: stored ?? null,
    defaultBytes: DEFAULT_CACHE_BYTES,
    sizes: CACHE_SIZES.map((bytes) => ({ bytes, label: cacheSizeLabel(bytes) })),
    managed: !reason,
    reason,
    clearReason,
    // A new size applies to the running node at once (no restart).
    nodeActive: !reason && nodeActive === true,
  };
}

// Why Clear cache is off, for each usage state that has no disk figure.
const CLEAR_STATE_REASON = {
  'not-running': 'Available while the Swarm node is running.',
  starting: 'Available once the Swarm node is running.',
  'disk-off': "The node's disk cache isn't available, so there is nothing to clear.",
  unreadable: "The node doesn't report its cache, so Freedom can't clear it.",
};

/**
 * Whether Settings offers Clear cache: only for the node Freedom runs, while
 * it is running with a disk cache (the usage line has a figure, or is still
 * counting one). `{ canClear, clearReason }`, the reason empty when it can.
 */
function clearAvailability(usage, view) {
  if (view && view.managed === false) {
    return { canClear: false, clearReason: view.clearReason || view.reason || '' };
  }
  if (usage?.state === 'ok' || usage?.state === 'counting') {
    return { canClear: true, clearReason: '' };
  }
  return {
    canClear: false,
    clearReason: CLEAR_STATE_REASON[usage?.state] || CLEAR_STATE_REASON.unreadable,
  };
}

/**
 * Saves a new size and, when the node Freedom runs is up, applies it live
 * (`PUT /v0/cache/capacity`); otherwise the next start reads it from
 * config.yaml. Refuses anything not in the set, and a node Freedom doesn't
 * manage.
 *
 * @returns {Promise<{ ok: boolean, live?: boolean, error?: string }>}
 *   `live`: the running node uses the new size now. `error` with `ok: true`:
 *   saved, but it applies at the next start, and why.
 */
async function applyCacheSize(
  bytes,
  {
    getView,
    save,
    isNodeActive,
    // Ant's live resize (createAntCacheService's setCapacity).
    setLiveCapacity,
    // Resolves once the node has left STARTING (healthy, failed or exited),
    // or after a timeout. A node still coming up may have read config.yaml
    // before the save, so the live call waits for it and then applies.
    waitForNodeSettled = null,
    // Up and healthy (RUNNING), not merely coming up; defaults to isNodeActive.
    isNodeRunning = null,
  }
) {
  const size = normalizeCacheBytes(bytes);
  if (size === null) return { ok: false, error: 'That cache size is not one Freedom offers.' };
  const view = getView();
  if (!view.managed) return { ok: false, error: view.reason };
  if (save(size) === false) return { ok: false, error: 'The cache size could not be saved.' };
  if (!isNodeActive()) return { ok: true, live: false };
  if (waitForNodeSettled) await waitForNodeSettled();
  if (!(isNodeRunning || isNodeActive)()) return { ok: true, live: false };
  let result;
  try {
    result = await setLiveCapacity(size);
  } catch {
    result = { ok: false, error: "The Swarm node didn't answer." };
  }
  if (result?.ok) return { ok: true, live: true };
  // Ant applied the size but the eviction down to it failed; it evicts again
  // on the next cache write, so the size holds.
  if (result?.applied) return { ok: true, live: true };
  return { ok: true, live: false, error: result?.error || "The Swarm node didn't answer." };
}

module.exports = {
  CACHE_SIZES,
  CHUNK_BYTES,
  DEFAULT_CACHE_BYTES,
  LEGACY_CACHE_BYTES,
  MIN_CACHE_BYTES,
  MAX_CACHE_BYTES,
  COUNTING_WINDOW_MS,
  COUNTING_MIN_FILE_BYTES,
  normalizeCacheBytes,
  resolveCacheBytes,
  cacheCapacityChunks,
  chooseCacheBytes,
  formatCacheBytes,
  cacheSizeLabel,
  parseDebugstore,
  parseCacheStatus,
  isCounting,
  cacheSummary,
  describeCache,
  cacheFileBytes,
  parseClearReport,
  describeClearResult,
  describeCacheWriteError,
  createAntCacheService,
  cacheSettingsView,
  clearAvailability,
  applyCacheSize,
};
