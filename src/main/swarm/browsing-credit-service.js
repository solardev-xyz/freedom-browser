/**
 * Browsing Credit Service (#488)
 *
 * The Swarm node's chequebook pays peers for bandwidth. Ant does it the way
 * bee does (freedom-hq/ant#126): the free pseudosettle refresh comes first,
 * and once the debt to a peer passes half its payment threshold a cheque
 * from the chequebook pays the rest. That is what lifts downloads past the
 * free tier's ~5-6 Mbit/s, so the chequebook is browsing credit as well as
 * the publishing deposit. The wallet sidebar's Nodes tab shows it; this
 * service is what it reads:
 *
 *   - `GET /chequebook/balance`: `totalBalance` (on chain) and
 *     `availableBalance` (bee's: what is left once every cheque the node has
 *     written is counted, cashed or not).
 *   - `GET /settlements`: per-peer cumulative `sent`. The node reports the
 *     peers it currently knows, not a ledger of every payment, so the spend
 *     over the last 24 hours and 7 days is built here: each reading is folded into
 *     a per-chequebook high-water mark per peer, and what a peer's figure
 *     grew by is recorded as spend in an hourly bucket, persisted under the
 *     profile's userData. A peer that drops out and comes back with the same
 *     figure adds nothing, and a peer seen for the first time is a baseline
 *     (its lifetime total is not dated). So is the first reading after a gap
 *     in the sampling (Freedom closed while a reused node kept paying, the
 *     node down): that growth has no hour either, and is left out.
 *   - The node-wide `swap-enable` switch ("Pay peers from the chequebook"):
 *     the `antSwapEnable` setting, which ant-manager writes into config.yaml.
 *     Ant exposes the runtime switch only on its control socket, which
 *     Freedom runs with `--no-control-socket`, and through ant-ffi; it has no
 *     HTTP route. So a change is a config write plus a restart of the
 *     managed node (through the publish setup service's restart, which
 *     refuses while a purchase is executing).
 *
 * An Ant release from before the switch (the pinned one, as of this change)
 * still serves the two reads; the switch is then reported `unsupported` and
 * the sidebar disables it.
 */

const fs = require('fs');
const path = require('path');
const { ipcMain, app } = require('electron');
const log = require('../logger');
const IPC = require('../../shared/ipc-channels');
const antStorageApi = require('./ant-storage-api');

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
// Spend is kept in hourly buckets: "last 24 hours" is accurate to the hour.
const BUCKET_MS = HOUR_MS;
const KEEP_MS = WEEK_MS + DAY_MS;
// /settlements is answered from the node's memory: sample it in the
// background while the node runs, so a burst of downloads with the sidebar
// closed still lands in the right hour.
const SAMPLE_MS = 5 * 60_000;
// Growth is only dated when the previous reading is this recent. A longer
// gap (Freedom closed while a reused node kept paying peers, the node down
// or unreachable for a while) leaves the growth undated: that reading is a
// fresh baseline rather than spend in its hour.
const MAX_SAMPLE_GAP_MS = 3 * SAMPLE_MS;
// /chequebook/balance is two chain reads: only while the card asks, and no
// more often than this.
const BALANCE_MAX_AGE_MS = 15_000;
const SETTLEMENTS_MAX_AGE_MS = 15_000;
const STORE_FILE = 'swarm-browsing-credit.json';
const STORE_VERSION = 1;
const ZERO_ADDRESS = /^0x0{40}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function toBigInt(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    return null;
  }
  try {
    const big = BigInt(value);
    return big >= 0n ? big : null;
  } catch {
    return null;
  }
}

/** A decimal string with up to `maxDecimals` places, trailing zeros trimmed. */
function formatPlur(value, maxDecimals = 6) {
  const raw = toBigInt(value);
  if (raw === null) return null;
  const unit = 10n ** 16n;
  const fraction = (raw % unit)
    .toString()
    .padStart(16, '0')
    .slice(0, maxDecimals)
    .replace(/0+$/, '');
  return fraction ? `${raw / unit}.${fraction}` : `${raw / unit}`;
}

// A peer's high-water mark is refreshed at most this often while its figure
// is unchanged, so an idle sample does not rewrite the file.
const PEER_SEEN_REFRESH_MS = DAY_MS;

/** `[sent, seenAt]` from a stored peer entry (a bare string: an older shape). */
function readPeer(entry, at) {
  if (Array.isArray(entry)) {
    const sent = toBigInt(entry[0]);
    // A last-seen in the future (the clock stepped back) is read as now, so
    // the peer still gets its daily refresh and its pruning clock runs.
    return sent === null
      ? null
      : { sent, seen: Number.isFinite(entry[1]) ? Math.min(entry[1], at) : at, future: entry[1] > at };
  }
  const sent = toBigInt(entry);
  return sent === null ? null : { sent, seen: null };
}

/**
 * Fold one `/settlements` reading into a chequebook's spend ledger.
 *
 * `ledger` is `{ since, sampled, peers: { <peer>: [<cumulative sent>, <last
 * seen ms>] }, buckets: [[<hour start ms>, <plur>]] }` or null. Only a peer's
 * growth between two readings no more than `MAX_SAMPLE_GAP_MS` apart (and
 * in order — a previous time later than `at` dates nothing) is spend; `lastAt` is the previous reading's time (default: the ledger's
 * `sampled`, which is saved only with some other change, so after a restart it
 * can be older than the real last reading — that errs towards a baseline,
 * never towards invented spend). After a longer gap, or with no previous time
 * at all, every peer's figure is a baseline: the growth happened while nobody
 * was looking and has no hour to go in. A figure seen for the first time — the
 * chequebook's first reading, or a peer not in the ledger — is a baseline
 * and counts nothing: Ant's `/settlements` lists only the peers connected
 * now, so a peer paid last month shows up with its lifetime total whenever
 * it reconnects, and that total has no date. (The cost: a peer that is both
 * new and paid within one sample interval has that first cheque missed.)
 *
 * Peers not listed for longer than the kept history are dropped, so the
 * ledger does not grow with every overlay the node has ever met; one that
 * comes back afterwards is a fresh baseline, so dropping it never invents
 * spend.
 *
 * Pure: returns `{ ledger, changed }` and never mutates its input.
 */
function recordSettlements(ledger, rows, at, lastAt = ledger?.sampled) {
  const current = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const peer = typeof row?.peer === 'string' ? row.peer.toLowerCase() : null;
    const sent = toBigInt(row?.sent);
    if (!peer || sent === null) continue;
    const previous = current.get(peer);
    if (previous === undefined || sent > previous) current.set(peer, sent);
  }

  if (!ledger) {
    const peers = {};
    for (const [peer, sent] of current) peers[peer] = [sent.toString(), at];
    return { ledger: { since: at, sampled: at, peers, buckets: [] }, changed: true };
  }

  const cutoff = at - KEEP_MS;
  // A previous reading later than now (the clock was ahead, then corrected)
  // says nothing about how long the node went unwatched, so it dates nothing.
  const gap = Number.isFinite(lastAt) ? at - lastAt : NaN;
  const dated = gap >= 0 && gap <= MAX_SAMPLE_GAP_MS;
  const peers = {};
  let spent = 0n;
  // A saved `sampled` in the future is rewritten to now, like a peer's.
  let changed = Number.isFinite(ledger.sampled) && ledger.sampled > at;
  for (const [peer, entry] of Object.entries(ledger.peers || {})) {
    const known = readPeer(entry, at);
    if (!known || (known.seen !== null && known.seen <= cutoff && !current.has(peer))) {
      changed = true;
      continue;
    }
    if (known.seen === null || known.future) changed = true; // rewrite in the current shape
    peers[peer] = [known.sent.toString(), known.seen ?? at];
  }
  for (const [peer, sent] of current) {
    const known = peers[peer] ? { sent: BigInt(peers[peer][0]), seen: peers[peer][1] } : null;
    if (!known) {
      peers[peer] = [sent.toString(), at];
      changed = true;
    } else if (sent > known.sent) {
      if (dated) spent += sent - known.sent;
      peers[peer] = [sent.toString(), at];
      changed = true;
    } else if (at - known.seen >= PEER_SEEN_REFRESH_MS) {
      peers[peer] = [known.sent.toString(), at];
      changed = true;
    }
  }

  let buckets = (ledger.buckets || []).filter(
    ([start, plur]) => Number.isFinite(start) && start + BUCKET_MS > cutoff && toBigInt(plur) !== null
  );
  if (buckets.length !== (ledger.buckets || []).length) changed = true;
  if (spent > 0n) {
    const start = Math.floor(at / BUCKET_MS) * BUCKET_MS;
    const last = buckets[buckets.length - 1];
    if (last && last[0] === start) {
      buckets = [...buckets.slice(0, -1), [start, (toBigInt(last[1]) + spent).toString()]];
    } else {
      buckets = [...buckets, [start, spent.toString()]];
    }
  }

  return { ledger: { since: ledger.since, sampled: at, peers, buckets }, changed };
}

/**
 * Spend recorded in the buckets that overlap the last `windowMs`: a rolling
 * window, not a calendar day, and up to one bucket (an hour) longer than
 * `windowMs` since the oldest bucket counts whole. The sidebar labels it so.
 */
function spendWithin(ledger, windowMs, at) {
  const from = at - windowMs;
  let total = 0n;
  for (const [start, plur] of ledger?.buckets || []) {
    if (start + BUCKET_MS > from) total += toBigInt(plur) ?? 0n;
  }
  return total;
}

function createSpendStore(filePath) {
  let data = null;

  function load() {
    if (data) return data;
    data = { version: STORE_VERSION, chequebooks: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (parsed?.version === STORE_VERSION && parsed.chequebooks && typeof parsed.chequebooks === 'object') {
        data = parsed;
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') log.warn(`[BrowsingCredit] spend history unreadable: ${err.message}`);
    }
    return data;
  }

  return {
    get(chequebook) {
      return load().chequebooks[chequebook] || null;
    },
    set(chequebook, ledger) {
      load().chequebooks[chequebook] = ledger;
      try {
        const tmp = `${filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
        fs.renameSync(tmp, filePath);
      } catch (err) {
        log.warn(`[BrowsingCredit] could not save spend history: ${err.message}`);
      }
    },
  };
}

function createBrowsingCreditService({
  api = antStorageApi,
  getNodeStatus,
  getSwapSupport,
  isSwapEnabled,
  setSwapEnabled,
  restartNode,
  store,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let chequebook = null; // { at, address, totalPlur, availablePlur, availableExact } | { at, address: null }
  let settlementsAt = 0;
  let addressCache = null; // { at, address }
  let toggle = { inProgress: false, error: null };
  let sampler = null;
  let sampleInflight = null;
  // When this process last read /settlements for each chequebook: the ledger's
  // own `sampled` is saved only with a change, so it lags while idle.
  const lastSampled = new Map();
  let balanceInflight = null;

  function nodeStatus() {
    return getNodeStatus?.()?.status || 'stopped';
  }

  async function readChequebookAddress() {
    if (addressCache && now() - addressCache.at < BALANCE_MAX_AGE_MS) return addressCache.address;
    const res = await api.getChequebookAddress();
    if (!res.ok) return addressCache?.address;
    const raw = res.data?.chequebookAddress;
    const address = typeof raw === 'string' && ADDRESS.test(raw) && !ZERO_ADDRESS.test(raw)
      ? raw.toLowerCase()
      : null;
    addressCache = { at: now(), address };
    return address;
  }

  async function sampleSettlements() {
    if (nodeStatus() !== 'running') return;
    const address = await readChequebookAddress();
    if (!address) return;
    const res = await api.getSettlements();
    if (!res.ok || !Array.isArray(res.data?.settlements)) return;
    const at = now();
    settlementsAt = at;
    const previous = store.get(address);
    // A previous time later than now (the clock stepped back) is dropped, so a
    // stale future `sampled` can't outrank the real in-memory last reading.
    const past = (t) => (Number.isFinite(t) && t <= at ? t : -Infinity);
    const lastAt = Math.max(past(lastSampled.get(address)), past(previous?.sampled));
    const { ledger, changed } = recordSettlements(previous, res.data.settlements, at, lastAt);
    lastSampled.set(address, at);
    if (changed) store.set(address, ledger);
  }

  function sampleOnce() {
    if (!sampleInflight) {
      sampleInflight = sampleSettlements()
        .catch((err) => log.warn(`[BrowsingCredit] settlements read failed: ${err.message}`))
        .finally(() => {
          sampleInflight = null;
        });
    }
    return sampleInflight;
  }

  async function readBalance() {
    const address = await readChequebookAddress();
    if (address === undefined) return;
    const at = now();
    if (!address) {
      chequebook = { at, address: null };
      return;
    }
    const res = await api.getChequebookBalance();
    if (!res.ok) return;
    const totalPlur = toBigInt(res.data?.totalBalance);
    const availablePlur = toBigInt(res.data?.availableBalance);
    if (totalPlur === null || availablePlur === null) return;
    chequebook = {
      at,
      address,
      totalPlur: totalPlur.toString(),
      availablePlur: availablePlur.toString(),
      // Ant sets this when it could not count the cheques it has written;
      // availableBalance is then the on-chain balance, an upper bound.
      availableExact: !res.data?.availableBalanceError,
    };
  }

  function balanceOnce() {
    if (!balanceInflight) {
      balanceInflight = readBalance()
        .catch((err) => log.warn(`[BrowsingCredit] chequebook read failed: ${err.message}`))
        .finally(() => {
          balanceInflight = null;
        });
    }
    return balanceInflight;
  }

  function publicChequebook() {
    if (!chequebook) return undefined;
    if (!chequebook.address) return null;
    return {
      address: chequebook.address,
      total: formatPlur(chequebook.totalPlur),
      available: formatPlur(chequebook.availablePlur),
      totalPlur: chequebook.totalPlur,
      availablePlur: chequebook.availablePlur,
      availableExact: chequebook.availableExact,
    };
  }

  function publicSpend() {
    const address = chequebook?.address || addressCache?.address;
    const ledger = address ? store.get(address) : null;
    if (!ledger) return null;
    const at = now();
    const day = spendWithin(ledger, DAY_MS, at);
    const week = spendWithin(ledger, WEEK_MS, at);
    return {
      day: formatPlur(day),
      week: formatPlur(week),
      dayPlur: day.toString(),
      weekPlur: week.toString(),
      since: ledger.since,
    };
  }

  async function getState() {
    const status = nodeStatus();
    const support = await getSwapSupport();
    if (status === 'running') {
      const reads = [];
      if (!chequebook || now() - chequebook.at >= BALANCE_MAX_AGE_MS) reads.push(balanceOnce());
      if (now() - settlementsAt >= SETTLEMENTS_MAX_AGE_MS) reads.push(sampleOnce());
      await Promise.all(reads);
    }
    return {
      node: status,
      support,
      swapEnable: isSwapEnabled(),
      toggle: { ...toggle },
      // undefined: not read yet; null: the node has no chequebook.
      chequebook: status === 'running' ? publicChequebook() : undefined,
      spend: publicSpend(),
    };
  }

  async function setSwapEnable(enabled) {
    if (typeof enabled !== 'boolean') return { ok: false, error: 'Invalid setting.' };
    if (toggle.inProgress) return { ok: false, error: 'The Swarm node is already restarting.' };
    const support = await getSwapSupport();
    if (support === 'unmanaged') {
      return { ok: false, error: 'Freedom does not manage this Swarm node.' };
    }
    if (support !== 'supported') {
      return { ok: false, error: 'Not supported by this node version.' };
    }
    const previous = isSwapEnabled();
    if (previous === enabled) {
      toggle = { inProgress: false, error: null };
      return { ok: true, state: await getState() };
    }
    if (!setSwapEnabled(enabled)) {
      return { ok: false, error: 'Could not save the setting.' };
    }
    const status = nodeStatus();
    if (status === 'stopped' || status === 'error') {
      // The next start writes it into config.yaml.
      toggle = { inProgress: false, error: null };
      return { ok: true, state: await getState() };
    }
    toggle = { inProgress: true, error: null };
    let error = null;
    try {
      const result = await restartNode();
      if (result && result.ok === false) error = result.error || 'Restarting the Swarm node failed.';
    } catch (err) {
      error = err?.message || 'Restarting the Swarm node failed.';
    }
    if (error) {
      // The node still runs with the old value: keep the setting with it.
      setSwapEnabled(previous);
    }
    toggle = { inProgress: false, error };
    chequebook = null;
    addressCache = null;
    return { ok: !error, error, state: await getState() };
  }

  function handleNodeStatus() {
    const running = nodeStatus() === 'running';
    if (running && !sampler) {
      void sampleOnce();
      sampler = setIntervalFn(() => void sampleOnce(), SAMPLE_MS);
      sampler?.unref?.();
    } else if (!running && sampler) {
      clearIntervalFn(sampler);
      sampler = null;
    }
    if (!running) {
      chequebook = null;
      addressCache = null;
    }
  }

  function dispose() {
    if (sampler) clearIntervalFn(sampler);
    sampler = null;
  }

  return { getState, setSwapEnable, handleNodeStatus, dispose };
}

// -----------------------------------------------------------------------------
// The app's instance and its IPC
// -----------------------------------------------------------------------------

let service = null;

function getBrowsingCreditService() {
  if (!service) {
    const antManager = require('../ant-manager');
    const { loadSettings, saveSettings } = require('../settings-store');
    const { getPublishSetupService } = require('./publish-setup-service');
    service = createBrowsingCreditService({
      getNodeStatus: antManager.getStatus,
      getSwapSupport: antManager.getSwapEnableSupport,
      isSwapEnabled: () => loadSettings().antSwapEnable !== false,
      setSwapEnabled: (enabled) => saveSettings({ antSwapEnable: enabled }),
      restartNode: () => getPublishSetupService().restartNode(),
      store: createSpendStore(path.join(app.getPath('userData'), STORE_FILE)),
    });
    antManager.onStatusChange(() => service.handleNodeStatus());
    service.handleNodeStatus();
  }
  return service;
}

// Chrome-only channels: no webview tier in ipc-sender-policy.js.
function registerBrowsingCreditIpc() {
  const svc = getBrowsingCreditService();
  ipcMain.handle(IPC.SWARM_CREDIT_GET_STATE, () => svc.getState());
  ipcMain.handle(IPC.SWARM_CREDIT_SET_SWAP_ENABLE, (_event, enabled) => svc.setSwapEnable(enabled));
  log.info('[BrowsingCredit] IPC handlers registered');
}

module.exports = {
  createBrowsingCreditService,
  createSpendStore,
  recordSettlements,
  spendWithin,
  formatPlur,
  registerBrowsingCreditIpc,
  BUCKET_MS,
  DAY_MS,
  WEEK_MS,
  KEEP_MS,
  SAMPLE_MS,
  MAX_SAMPLE_GAP_MS,
  BALANCE_MAX_AGE_MS,
};
