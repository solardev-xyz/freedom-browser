/**
 * Publish Setup Service
 *
 * The main process's single source of truth for Swarm publishing: whether
 * this profile's node can publish right now, and, when it cannot, the one
 * purchase that gets it there. It replaces the Bee-era renderer checklist
 * (fund xDAI, switch to light mode, wait for the chequebook, swap for xBZZ,
 * buy stamps), which each window ran separately, inferring progress from
 * Bee-shaped signals.
 *
 * Funding is node-side, as in AntDrive: the user sends plain xDAI to the node
 * wallet, and the node quotes, swaps xDAI for xBZZ, buys and registers the
 * batch, and funds its chequebook (see ant-storage-api.js). Freedom's part:
 *
 *   - Readiness, from `/health.chainReady`, `/health.walletScan`, `/node`,
 *     `/readiness` and usable `/stamps`, plus the settlement deposit and
 *     node wallet balances while a surface that shows them is on screen.
 *   - The armed operation: a buy, an extend or a deposit top-up the user
 *     chose. A top-up refills the deposit to the node's target or, on Ant
 *     releases with freedom-hq/ant#126, adds an amount the user picked.
 *     While it waits for funds it re-quotes every few seconds, and the
 *     first quote with `sufficientFunds` fires the write route exactly once.
 *     It lives here rather than in a window, so closing the screen does not
 *     drop it.
 *   - The node restart the user can ask for to recover a failed or stuck
 *     node: one restart, from main, instead of one per chrome window.
 *
 * The setup screen, the node card, the settings row, freedom://publish and
 * the swarm provider all read this state. Renderers get it pushed on
 * `swarm:setup-state`.
 */

const { ipcMain } = require('electron');
const log = require('../logger');
const IPC = require('../../shared/ipc-channels');
const antStorageApi = require('./ant-storage-api');
const {
  parseWalletScan,
  isWalletScanFinished,
  walletScanPercent,
  mayRediscoverUnreported,
} = require('./ant-wallet-scan');
const {
  isUsableStamp,
  isPendingStamp,
  isPropagatingStamp,
  isFullImmutableStamp,
} = require('./swarm-service');

// A batch uploads can stamp: usable, and not an immutable one that is full
// (selectBestBatch skips those, so counting them would say "ready" while
// every publish fails for want of a batch).
function hasRoom(batch) {
  return isUsableStamp(batch) && !isFullImmutableStamp(batch);
}

const GNOSIS_CHAIN_ID = 100;

// AntDrive's tiers (nodes/ant examples/ios-drive, DriveModels.swift). Each
// depth is the smallest whose Swarm effective volume (unencrypted) covers the
// advertised size: d20 ≈ 688 MB, d21 ≈ 2.60 GB, d22 ≈ 7.73 GB.
const PLANS = Object.freeze([
  Object.freeze({
    id: 'starter',
    title: 'Starter',
    depth: 20,
    days: 30,
    safeLimitBytes: 100_000_000,
  }),
  Object.freeze({
    id: 'advanced',
    title: 'Advanced',
    depth: 21,
    days: 180,
    safeLimitBytes: 1_000_000_000,
  }),
  Object.freeze({ id: 'plus', title: 'Plus', depth: 22, days: 365, safeLimitBytes: 5_000_000_000 }),
]);
const EXTEND_DAYS = Object.freeze([30, 90, 180, 365]);

const REQUOTE_MS = 6_000;
const WATCH_REFRESH_MS = 15_000;
const STARTUP_REFRESH_MS = 3_000;
const PROBE_TIMEOUT_MS = 5_000;
const READINESS_MAX_AGE_MS = 2_000;
const STATE_MAX_AGE_MS = 5_000;
const FUNDING_TX_POLL_MS = 4_000;
// After a buy, how often and how long to wait for the node to call the new
// batch usable: storer peers only accept its stamps once they have synced
// its creation.
const CONFIRM_POLL_MS = 3_000;
const CONFIRM_TIMEOUT_MS = 10 * 60_000;
const FUNDING_TX_TIMEOUT_MS = 15 * 60_000;
// antd's chain init has no timeout of its own. After this long the setup
// screen suggests checking the Gnosis RPC or restarting the node.
const CHAIN_INIT_SLOW_MS = 3 * 60_000;
const MAX_EXTEND_DAYS = 3650;
// Ant's background batch rediscovery (#510, ant-wallet-scan.js): while it
// runs, an empty `/stamps` does not mean the wallet owns no storage. A node
// that reports `/health.walletScan` (Ant v0.5.59+) is held until it says
// `done` or `confirming`, however long a scan that moves takes (one that
// stops moving is bounded by SCAN_STALL_MAX_MS). A node that may be
// rediscovering without reporting it (Ant v0.5.58, or a `walletScan` state
// this release does not know) is held for at most this long after the node
// started, and only if Freedom spawned it: an external node's start time is
// unknown here, and it may have finished long ago. Neither holds a wallet
// that never sent a transaction, which owns nothing to rediscover. Before #484, the first scan of a wallet
// with history took 15-25 minutes behind a range-capped RPC; past this the
// fallback stops guessing rather than keep the user from buying for good.
const REDISCOVERY_MAX_WAIT_MS = 30 * 60_000;
// After this long the fallback's message says the first check can take a while.
const REDISCOVERY_SLOW_MS = 2 * 60_000;
// A reported scan that keeps failing (`retrying`, with no block read since)
// for this long is not going to finish on its own: a Gnosis RPC set short of
// a quorum, or a dead logs endpoint. antd's own retry backs off to 5
// minutes, so this is several failed attempts. Past it the hold is released,
// with a message saying the check did not finish, rather than keep the user
// from storage plans for the whole session. The clock starts when Freedom
// first sees the scan failing, not when antd started retrying: `/health`
// carries no timestamp for that, and the service only probes while a
// surface (publish setup, storage, the node card) is watching. A scan that failed
// unwatched for hours therefore still holds for up to this long once a
// surface opens; the bound is a ceiling on what Freedom has seen, not on
// the scan's own age.
const SCAN_STALL_MAX_MS = 30 * 60_000;

const QUOTING_PHASES = new Set(['quoting', 'awaiting-funds']);
// The surface name the chrome's setup screen watches under (publish-setup.js).
const SETUP_SCREEN_SURFACE = 'publish-setup';

const UNCERTAIN_MESSAGE =
  'Gnosis Chain did not confirm the transaction in time. It may still go through, so check your storage in a minute before you try again.';

const REJECTED_BATCH_MESSAGE =
  'Your storage was bought, but the Swarm network did not accept it, so it cannot be used to publish. Restarting the node can help; otherwise pick a plan again.';

const WEI_PER_CENT = 10n ** 16n;
const PLUR_PER_BZZ = 10n ** 16n;
// What a "Top Up Credit" amount may be (freedom-hq/ant#126's
// `POST /v0/settlement/deposit?amount=`): from the node's own default deposit
// (0.001 xBZZ) to 10 xBZZ (about 17 GB of fully paid download), so a typo
// cannot swap the node's whole xDAI balance. The renderer offers the same
// range (browsing-credit.js).
const MIN_DEPOSIT_AMOUNT_PLUR = PLUR_PER_BZZ / 1000n;
const MAX_DEPOSIT_AMOUNT_PLUR = 10n * PLUR_PER_BZZ;

const WALLET_GREW_MESSAGE =
  'Your node wallet now holds more xDAI than when you chose this top-up, and the node pays from it first. Choose the amount again to go ahead.';

const OLD_NODE_DEPOSIT_AMOUNT_MESSAGE =
  'This Swarm node can only top its deposit up to its default target. A newer Ant adds any amount.';

function toBigInt(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Round a wei amount up to the next whole cent (0.01 xDAI), as AntDrive does:
 * the user sends a clean figure that is never below what the quote asks for.
 */
function roundUpToCent(weiValue) {
  const wei = toBigInt(weiValue);
  if (wei === null || wei < 0n) return null;
  const cents = (wei + WEI_PER_CENT - 1n) / WEI_PER_CENT;
  return {
    wei: (cents * WEI_PER_CENT).toString(),
    display: `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`,
  };
}

/** A decimal string with up to `maxDecimals` places, trailing zeros trimmed. */
function formatUnits(value, decimals, maxDecimals = 4) {
  const raw = toBigInt(value);
  if (raw === null || raw < 0n) return null;
  const unit = 10n ** BigInt(decimals);
  const fraction = (raw % unit)
    .toString()
    .padStart(decimals, '0')
    .slice(0, maxDecimals)
    .replace(/0+$/, '');
  return fraction ? `${raw / unit}.${fraction}` : `${raw / unit}`;
}

function isAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isZeroAddress(value) {
  return !isAddress(value) || /^0x0{40}$/.test(value);
}

function normalizeBatchId(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

function normalizeSwarmMode(mode) {
  if (typeof mode !== 'string') return null;
  const normalized = mode.trim().toLowerCase().replace(/[-_]/g, '');
  if (normalized === 'ultralight') return 'ultraLight';
  if (normalized === 'light') return 'light';
  if (normalized === 'full' || normalized === 'fullnode') return 'full';
  return null;
}

/**
 * The quote fields the UI shows and the write routes need. `send` is what the
 * user is asked to pay, `price` the all-in cost at the node's current
 * balances; both rounded up to the cent. Returns null for a malformed body.
 */
function normalizeQuote(data, kind) {
  if (!data || typeof data !== 'object' || typeof data.sufficientFunds !== 'boolean') return null;
  if (!isAddress(data.walletAddress)) return null;
  const send = roundUpToCent(data.xdaiToSendWei);
  const price = roundUpToCent(data.xdaiRequiredWei);
  if (!send || !price) return null;
  if (
    kind !== 'deposit' &&
    (typeof data.amountPerChunk !== 'string' || toBigInt(data.amountPerChunk) === null)
  ) {
    return null;
  }
  const depositPlur = kind === 'deposit' ? data.shortfallPlur : data.settlementDepositPlur;
  return {
    depth: Number.isInteger(data.depth) ? data.depth : null,
    days: Number.isInteger(data.days) ? data.days : null,
    amountPerChunk: kind === 'deposit' ? null : data.amountPerChunk,
    walletAddress: data.walletAddress.toLowerCase(),
    walletXdai: formatUnits(data.walletXdaiWei, 18),
    xdaiToSendWei: String(data.xdaiToSendWei),
    send,
    price,
    depositXbzz: toBigInt(depositPlur) > 0n ? formatUnits(depositPlur, 16) : null,
    sufficientFunds: data.sufficientFunds,
  };
}

/**
 * The pay step's quote for an amount deposit, from the shortfall the node
 * reported (parseXdaiShortfall) and the wallet the last deposit read saw.
 */
function amountQuote(op, shortWei) {
  return {
    depth: null,
    days: null,
    amountPerChunk: null,
    walletAddress: op.walletAddress,
    walletXdai: formatUnits(op.walletXdaiWei ?? 0n, 18),
    xdaiToSendWei: shortWei.toString(),
    send: roundUpToCent(shortWei),
    price: null,
    depositXbzz: formatUnits(op.params.amountPlur, 16),
    sufficientFunds: false,
  };
}

/**
 * Classify publish readiness from the node's status and the latest probe.
 * `reason` is the swarm provider's wire value (`window.swarm` apps see it in
 * `swarm_getCapabilities` and in 4900 errors), so it keeps its four values.
 */
function classifyReadiness({
  node,
  probe,
  runningSince = null,
  rediscovery = null,
  scanStalled = false,
  now = Date.now(),
}) {
  const registryMode = node?.registryMode || 'none';
  const external = registryMode === 'reused' || registryMode === 'external';
  const result = (key, reason, message, extra = {}) => ({
    ok: key === 'ready',
    key,
    reason,
    message,
    slow: false,
    ...extra,
  });

  if (registryMode === 'disabled') {
    return result('disabled', 'node-stopped', 'The Swarm node is turned off for this profile.');
  }
  switch (node?.status) {
    case 'running':
      break;
    case 'starting':
      return result('starting', 'node-stopped', 'The Swarm node is starting…');
    case 'stopping':
      return result('stopping', 'node-stopped', 'The Swarm node is stopping…');
    case 'error':
      return result(
        'error',
        'node-stopped',
        node.error ? `The Swarm node failed: ${node.error}` : 'The Swarm node failed.'
      );
    default:
      return result('stopped', 'node-stopped', 'The Swarm node is not running.');
  }

  if (!probe) return result('checking', 'node-not-ready', 'Checking the Swarm node…');
  if (probe.unreachable) {
    return result('unreachable', 'node-stopped', 'Cannot reach the Swarm node.');
  }
  if (probe.chainReady === false) {
    const slow = runningSince !== null && now - runningSince > CHAIN_INIT_SLOW_MS;
    return result(
      'chain-syncing',
      'node-not-ready',
      slow
        ? 'The Swarm node is still connecting to Gnosis Chain. Check the Gnosis RPC in Settings, or restart the node.'
        : 'The Swarm node is connecting to Gnosis Chain…',
      { slow }
    );
  }
  if (probe.nodeMode === 'ultraLight') {
    return result(
      'ultra-light',
      'ultra-light-mode',
      external
        ? 'This Swarm node runs in ultra-light mode, which cannot publish. Change its mode where the node is managed.'
        : 'The Swarm node has no Gnosis Chain connection, so it cannot publish.'
    );
  }
  if (probe.peersReady === false) {
    return result('connecting', 'node-not-ready', 'The Swarm node is connecting to peers…');
  }
  if (!probe.stamps?.known) return result('checking', 'node-not-ready', 'Checking your storage…');
  if (probe.stamps.usable === 0 && probe.stamps.propagating > 0) {
    // Ant takes uploads with a propagating batch and holds each push until
    // the network knows it, so publishing need not wait for the batch.
    return result(
      'storage-pending',
      null,
      'Your new storage is reaching the Swarm network. Uploads you start now finish once it arrives.',
      { ok: true }
    );
  }
  if (probe.stamps.usable === 0 && probe.stamps.pending > 0) {
    // A node without the flag refuses uploads until the batch is usable.
    return result(
      'storage-pending',
      'node-not-ready',
      'Your new storage is reaching the Swarm network. Publishing works in a moment.'
    );
  }
  if (probe.stamps.usable === 0 && rediscovery) {
    // The node is still looking for batches this wallet bought before
    // (rediscoveryHold): offering a plan now invites buying one it owns.
    // Never `slow`: that offers a restart, which starts the scan over.
    const progress = Number.isInteger(rediscovery.percent) ? rediscovery.percent : null;
    const done = progress === null ? '' : ` ${progress}% checked.`;
    if (rediscovery.state === 'retrying') {
      return result(
        'checking',
        'node-not-ready',
        `Looking for your existing storage…${done} Gnosis Chain did not answer, so the Swarm node is trying again. If this lasts, check the Gnosis RPC in Settings.`,
        { rediscovery: 'retrying', progress }
      );
    }
    if (rediscovery.state === 'unreported') {
      return result(
        'checking',
        'node-not-ready',
        rediscovery.slow
          ? 'Still looking for your existing storage. This Swarm node does not report its progress, and the first check of a wallet on a device can take several minutes.'
          : 'Looking for your existing storage…',
        { rediscovery: 'running', progress: null }
      );
    }
    return result(
      'checking',
      'node-not-ready',
      `Looking for your existing storage…${done} Storage plans appear if this wallet has none.`,
      { rediscovery: 'running', progress }
    );
  }
  if (probe.stamps.usable === 0) {
    return result(
      'needs-storage',
      'no-usable-stamps',
      scanStalled
        ? 'The Swarm node could not finish looking for storage this wallet already owns: Gnosis Chain keeps failing. Check the Gnosis RPC in Settings before buying, or you may pay for storage you already have.'
        : probe.stamps.full > 0
          ? 'Your storage is full. Buy a storage plan to keep publishing.'
          : probe.stamps.total > 0
            ? 'None of your storage can be used anymore. Buy a storage plan to publish.'
            : 'Publishing needs storage. Pick a storage plan to start.',
      scanStalled ? { scanStalled: true } : {}
    );
  }
  const count = probe.stamps.usable;
  return result(
    'ready',
    null,
    `Ready to publish. ${count} storage batch${count === 1 ? '' : 'es'} available.`
  );
}

function actionLabel(kind) {
  if (kind === 'extend') return 'Extending storage';
  if (kind === 'deposit') return 'Topping up the deposit';
  return 'Buying storage';
}

function isShortOfXdai(res) {
  return res?.status === 400 && /(not enough|insufficient) xDAI/i.test(res.message || '');
}

/**
 * The xDAI (wei) a refused write says the node wallet is short of: antd's
 * `not enough xDAI: send 0.1201 more xDAI to your account, then try again`,
 * rounded up to 4 places by the node. Null when the message has no figure.
 */
function parseXdaiShortfall(message) {
  const match = /send (\d+)(?:\.(\d{1,18}))? more xDAI/i.exec(message || '');
  if (!match) return null;
  const wei = BigInt(match[1]) * 10n ** 18n + BigInt((match[2] || '').padEnd(18, '0') || '0');
  return wei > 0n ? wei : null;
}

/** A deposit amount from the renderer: a PLUR integer string within range. */
function parseDepositAmount(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,30}$/.test(value)) return null;
  const plur = BigInt(value);
  if (plur < MIN_DEPOSIT_AMOUNT_PLUR || plur > MAX_DEPOSIT_AMOUNT_PLUR) return null;
  return plur.toString();
}

function parseRequest(request) {
  const kind = request?.kind;
  if (kind === 'buy') {
    const plan = PLANS.find((p) => p.id === request.planId);
    if (!plan) return { error: 'Unknown storage plan.' };
    return {
      kind,
      request: { kind, planId: plan.id },
      params: { depth: plan.depth, days: plan.days, immutable: true },
    };
  }
  if (kind === 'extend') {
    const batchId = normalizeBatchId(request.batchId);
    if (!batchId) return { error: 'Invalid storage batch.' };
    const days = request.days == null ? 0 : request.days;
    if (!Number.isInteger(days) || days < 0 || days > MAX_EXTEND_DAYS) {
      return { error: 'Invalid duration.' };
    }
    const depth = request.depth == null ? null : request.depth;
    if (depth !== null && (!Number.isInteger(depth) || depth < 17 || depth > 255)) {
      return { error: 'Invalid size.' };
    }
    if (days === 0 && depth === null) return { error: 'Choose how long or how big to make it.' };
    return { kind, request: { kind, batchId, days, depth }, params: { batchId, days, depth } };
  }
  if (kind === 'deposit') {
    if (request.amountPlur == null) return { kind, request: { kind }, params: {} };
    const amountPlur = parseDepositAmount(request.amountPlur);
    if (!amountPlur) return { error: 'Choose an amount between 0.001 and 10 xBZZ.' };
    // The node wallet's xDAI the deposit screen showed when the user chose
    // this: the most the node may swap before Freedom has a price for it.
    const spend = request.walletXdaiWei == null ? '0' : request.walletXdaiWei;
    if (typeof spend !== 'string' || !/^(0|[1-9]\d{0,40})$/.test(spend)) {
      return { error: 'Invalid wallet balance.' };
    }
    return {
      kind,
      request: { kind, amountPlur, walletXdaiWei: spend },
      params: { amountPlur, walletSpendCapWei: BigInt(spend) },
    };
  }
  return { error: 'Unknown operation.' };
}

function createPublishSetupService({
  api = antStorageApi,
  getNodeStatus,
  getRegistryMode,
  restartNode,
  getTransactionStatus,
  // The node wallet's Gnosis Chain transaction count, or null if unknown.
  getWalletTxCount = null,
  // When the node Freedom spawned started (ms), or null: what the fallback
  // hold is measured from, so a service constructed late does not stretch it.
  getNodeStartedAt = null,
  publish = () => {},
  now = () => Date.now(),
} = {}) {
  let node = readNode();
  let runningSince = node.status === 'running' ? now() : null;
  // Bumped each time the node comes up: what was learned about one run of
  // the node (maybe with another key) does not carry over to the next.
  let nodeRun = node.status === 'running' ? 1 : 0;
  let probe = null;
  let account = null;
  let operation = null;
  let restart = { inProgress: false, error: null };
  let opSeq = 0;
  const watchers = new Set();
  // Windows (watch-key prefixes) that have left the current finished result.
  let dismissal = { opId: null, viewers: new Set() };
  let watchTimer = null;
  let quoteTimer = null;
  let txTimer = null;
  let confirmTimer = null;
  let probeInflight = null;
  let accountInflight = null;
  let lastPublished = null;
  let disposed = false;
  // Whether the node wallet has sent a transaction, per node run.
  // Rediscovery only finds batches the node wallet paid for itself, so a
  // wallet that never sent a transaction owns nothing for it to find, and
  // need not wait for a scan of the whole chain (about 70 minutes for a new
  // wallet through the chain bridge's range-capped quorum, measured
  // 2026-10-05; #529 tracks a faster first scan).
  let walletHistory = { run: null, hasHistory: null };
  let historyInflight = null;
  // Since when a reported scan has been failing without reading a block
  // (SCAN_STALL_MAX_MS), per node run. `through` is the progress it stalled
  // at: antd flips between `retrying` and `scanning` on each attempt, so only
  // a block actually read counts as the scan moving again.
  let scanStall = { run: null, since: null, through: null };
  // The earliest `from` seen for the scan in progress, for its percentage:
  // antd resets `from` to its resume point on every retry and restart, so
  // the progress shown would drop to ~0% after a failure (see
  // walletScanPercent). Kept across a node restart for the same wallet;
  // cleared when the scan finishes or the wallet changes. An app restart
  // loses it (antd reports only the resume point), so a scan resumed then
  // shows progress from where it resumed.
  let scanOrigin = null;

  function readNode() {
    const { status = 'stopped', error = null } = getNodeStatus?.() || {};
    return { status, error: error || null, registryMode: getRegistryMode?.() || 'none' };
  }

  function canBuy() {
    const mode = node.registryMode;
    return mode !== 'reused' && mode !== 'disabled' && account?.storage !== 'missing';
  }

  function publicOperation(op) {
    return {
      id: op.id,
      kind: op.kind,
      request: { ...op.request },
      phase: op.phase,
      quote: op.quote,
      notice: op.notice,
      error: op.error,
      uncertain: op.uncertain,
      result: op.result,
      fundingTx: op.fundingTx ? { ...op.fundingTx } : null,
    };
  }

  function publicAccount(acc) {
    const cb = acc.chequebook;
    return {
      storage: acc.storage,
      walletAddress: acc.walletAddress,
      xdai: formatUnits(acc.xdaiWei, 18),
      xdaiWei: toBigInt(acc.xdaiWei) === null ? null : toBigInt(acc.xdaiWei).toString(),
      bzz: formatUnits(acc.bzzPlur, 16),
      chequebook: cb
        ? {
            address: cb.address,
            deposit: formatUnits(cb.depositPlur, 16),
            target: cb.targetPlur == null ? null : formatUnits(cb.targetPlur, 16),
            needsTopUp: cb.needsTopUp,
            managed: cb.managed,
          }
        : null,
    };
  }

  /**
   * Why publish setup should not take an empty storage list at its word
   * (#510), or null: `{ state, percent, slow }`.
   *
   * A node that reports `/health.walletScan` decides: held while it reads
   * `pending`, `scanning` or `retrying`, with its progress, and released at
   * `done` or `confirming`. The probe reads `/health` before `/stamps`, so a
   * finished scan's batches are already in the list it releases with.
   *
   * The fallback, for a node that may rediscover without reporting it (see
   * mayRediscoverUnreported, or a `walletScan` state not known here): held
   * as `unreported` for at most REDISCOVERY_MAX_WAIT_MS after Freedom saw
   * the node running.
   *
   * Either way, a wallet known to have sent no transactions is not held. A
   * wallet whose history could not be read is: a wrong "checking" costs a
   * wait, a wrong "pick a plan" can cost a duplicate purchase.
   */
  function rediscoveryHold() {
    const kind = holdKind();
    if (!kind || runningSince === null) return null;
    if (walletHistory.run === nodeRun && walletHistory.hasHistory === false) return null;
    if (kind === 'reported') {
      if (isScanStalled()) return null;
      const scan = probe.walletScan;
      return {
        state: scan.state,
        percent: walletScanPercent(scan, scanOriginFrom()),
        slow: false,
      };
    }
    const startedAt = nodeStartedAt();
    if (startedAt === null) return null;
    const waited = now() - startedAt;
    if (waited > REDISCOVERY_MAX_WAIT_MS) return null;
    return { state: 'unreported', percent: null, slow: waited > REDISCOVERY_SLOW_MS };
  }

  // 'reported' while the node reports an unfinished scan, 'fallback' while
  // it may be rediscovering without saying so, else null. The fallback is
  // for the node Freedom spawned only: for an external one Freedom cannot
  // tell a scan that just started from one that finished days ago, and
  // guessing would hold the plans for the bound on every launch.
  function holdKind() {
    if (!probe || probe.unreachable) return null;
    const scan = probe.walletScan;
    if (scan && scan.state !== 'unknown') return isWalletScanFinished(scan) ? null : 'reported';
    if (node.registryMode !== 'bundled') return null;
    if (scan) return 'fallback';
    return mayRediscoverUnreported(probe.version) ? 'fallback' : null;
  }

  // When the node started: the bundled node's spawn time where known, else
  // when Freedom first saw it running.
  function nodeStartedAt() {
    const spawned = getNodeStartedAt?.();
    if (Number.isFinite(spawned) && spawned <= now()) return spawned;
    return runningSince;
  }

  function noteWalletScan(scan, at) {
    if (
      scanStall.run !== nodeRun ||
      !scan ||
      scan.state === 'unknown' ||
      isWalletScanFinished(scan)
    ) {
      scanStall = { run: nodeRun, since: null, through: null };
      if (!scan || scan.state !== 'retrying') return;
    }
    const through = scan.scannedThrough;
    if (
      scanStall.since !== null &&
      through !== null &&
      (scanStall.through === null || through > scanStall.through)
    ) {
      scanStall = { run: nodeRun, since: null, through: null };
    }
    if (scan.state === 'retrying' && scanStall.since === null) {
      scanStall = { run: nodeRun, since: at, through };
    }
  }

  function currentWallet() {
    const address = account?.walletAddress;
    return isAddress(address) ? address.toLowerCase() : null;
  }

  function noteScanOrigin(scan) {
    if (!scan || scan.state === 'unknown' || isWalletScanFinished(scan)) {
      scanOrigin = null;
      return;
    }
    if (scan.from === null) return;
    const wallet = currentWallet();
    if (scanOrigin && scanOrigin.run !== nodeRun) {
      // A restarted node: carry the origin over only once the wallet is
      // known to be the same one (account is re-read after a restart).
      if (!scanOrigin.wallet) scanOrigin = null;
      else if (!wallet) return;
      else if (wallet !== scanOrigin.wallet) scanOrigin = null;
    }
    if (scanOrigin && wallet && scanOrigin.wallet && wallet !== scanOrigin.wallet) {
      scanOrigin = null;
    }
    scanOrigin = scanOrigin
      ? {
          run: nodeRun,
          wallet: scanOrigin.wallet || wallet,
          from: Math.min(scanOrigin.from, scan.from),
        }
      : { run: nodeRun, wallet, from: scan.from };
  }

  function scanOriginFrom() {
    if (!scanOrigin) return null;
    if (scanOrigin.run === nodeRun) return scanOrigin.from;
    const wallet = currentWallet();
    return wallet && wallet === scanOrigin.wallet ? scanOrigin.from : null;
  }

  function isScanStalled() {
    return (
      scanStall.run === nodeRun &&
      scanStall.since !== null &&
      now() - scanStall.since > SCAN_STALL_MAX_MS
    );
  }

  async function readWalletHistory() {
    if (!holdKind() || typeof getWalletTxCount !== 'function') return;
    const run = nodeRun;
    if (walletHistory.run === run && walletHistory.hasHistory !== null) return;
    let address = account?.walletAddress;
    if (!isAddress(address)) {
      const res = await api.getAddresses({ timeoutMs: PROBE_TIMEOUT_MS });
      address = res.ok && isAddress(res.data?.ethereum) ? res.data.ethereum : null;
    }
    if (!address) return;
    let count = null;
    try {
      count = await getWalletTxCount(address.toLowerCase());
    } catch (err) {
      log.warn(`[PublishSetup] wallet history read failed: ${err.message}`);
    }
    // Kept under the run it was read for: a restart (maybe with a new key)
    // while the read was in flight leaves it answering for that run only.
    if (Number.isSafeInteger(count) && count >= 0) {
      walletHistory = { run, hasHistory: count > 0 };
      // Probes do not wait for this read (it is an RPC round-trip), so a
      // wallet with no history lifts the hold here.
      if (!disposed) emit();
    }
  }

  function walletHistoryOnce() {
    if (!historyInflight) {
      historyInflight = readWalletHistory()
        .catch((err) => log.warn(`[PublishSetup] wallet history check failed: ${err.message}`))
        .finally(() => {
          historyInflight = null;
        });
    }
    return historyInflight;
  }

  // Every reader of readiness (the setup state, the swarm provider's
  // pre-flight) classifies through here, so they agree on the hold.
  function currentReadiness() {
    return classifyReadiness({
      node,
      probe,
      runningSince,
      rediscovery: rediscoveryHold(),
      // The stalled-scan warning is for a wallet that may own storage.
      scanStalled:
        holdKind() === 'reported' &&
        isScanStalled() &&
        !(walletHistory.run === nodeRun && walletHistory.hasHistory === false),
      now: now(),
    });
  }

  function getState() {
    const readiness = currentReadiness();
    const mode = node.registryMode;
    return {
      node: { ...node },
      readiness,
      chainReady: probe?.chainReady ?? null,
      nodeMode: probe?.nodeMode ?? null,
      stamps: probe?.stamps
        ? {
            known: probe.stamps.known,
            usable: probe.stamps.usable,
            pending: probe.stamps.pending,
            total: probe.stamps.total,
          }
        : { known: false, usable: 0, pending: 0, total: 0 },
      account: account ? publicAccount(account) : null,
      canBuy: canBuy(),
      canRestart: mode !== 'reused' && mode !== 'disabled' && operation?.phase !== 'executing',
      operation: operation ? publicOperation(operation) : null,
      restart: { ...restart },
      plans: PLANS,
    };
  }

  function emit() {
    if (disposed) return;
    const state = getState();
    const serialized = JSON.stringify(state);
    if (serialized === lastPublished) return;
    lastPublished = serialized;
    try {
      publish(state);
    } catch (err) {
      log.warn(`[PublishSetup] state broadcast failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Readiness and account probes
  // ---------------------------------------------------------------------------

  async function runProbe() {
    node = readNode();
    if (node.status !== 'running') {
      probe = null;
      return;
    }
    const at = now();
    const health = await api.getHealth({ timeoutMs: PROBE_TIMEOUT_MS });
    if (!health.ok) {
      probe = {
        at,
        unreachable: true,
        version: null,
        walletScan: null,
        chainReady: null,
        nodeMode: null,
        peersReady: null,
        stamps: null,
      };
      return;
    }
    // Bee and Ant releases before the flag omit it: treat a missing field as
    // ready rather than blocking a node that has no chain init to wait for.
    const chainReady = health.data?.chainReady !== false;
    const version = typeof health.data?.version === 'string' ? health.data.version : null;
    const walletScan = parseWalletScan(health.data?.walletScan);
    noteWalletScan(walletScan, at);
    noteScanOrigin(walletScan);
    if (!chainReady) {
      probe = {
        at,
        unreachable: false,
        version,
        walletScan,
        chainReady,
        nodeMode: null,
        peersReady: null,
        stamps: { known: false },
      };
      return;
    }
    const [nodeRes, readinessRes, stampsRes] = await Promise.all([
      api.getNode({ timeoutMs: PROBE_TIMEOUT_MS }),
      api.getReadiness({ timeoutMs: PROBE_TIMEOUT_MS }),
      api.getStamps({ timeoutMs: PROBE_TIMEOUT_MS }),
    ]);
    const stamps =
      stampsRes.ok && Array.isArray(stampsRes.data?.stamps) ? stampsRes.data.stamps : null;
    probe = {
      at,
      unreachable: false,
      version,
      walletScan,
      chainReady,
      nodeMode: nodeRes.ok ? normalizeSwarmMode(nodeRes.data?.beeMode) : null,
      peersReady: readinessRes.status === 0 ? null : readinessRes.ok,
      stamps: stamps
        ? {
            known: true,
            usable: stamps.filter(hasRoom).length,
            full: stamps.filter((s) => isUsableStamp(s) && isFullImmutableStamp(s)).length,
            pending: stamps.filter(isPendingStamp).length,
            propagating: stamps.filter(isPropagatingStamp).length,
            total: stamps.length,
          }
        : { known: false },
    };
    const s = probe.stamps;
    if (s.known && s.usable === 0 && s.pending === 0 && s.propagating === 0 && holdKind()) {
      // Not awaited: readiness (and the swarm provider's pre-flight) must not
      // wait on an RPC round-trip. Until it answers the hold applies, and the
      // read emits when it lands.
      void walletHistoryOnce();
    }
  }

  function accountFromDeposit(data, at) {
    return {
      at,
      storage: 'available',
      walletAddress: isAddress(data.walletAddress) ? data.walletAddress.toLowerCase() : null,
      xdaiWei: data.walletXdaiWei,
      bzzPlur: data.walletBzzPlur,
      chequebook: isZeroAddress(data.chequebook)
        ? null
        : {
            address: data.chequebook.toLowerCase(),
            depositPlur: data.depositPlur,
            targetPlur: data.targetPlur ?? null,
            needsTopUp: data.needsTopUp === true,
            managed: data.managed !== false,
          },
    };
  }

  // Nodes without the storage routes (Bee, an older Ant) still report their
  // wallet and chequebook through the Bee API; the node card shows those.
  async function legacyAccount(at, storage) {
    const [addresses, wallet, cbAddress, cbBalance] = await Promise.all([
      api.getAddresses(),
      api.getWallet(),
      api.getChequebookAddress(),
      api.getChequebookBalance(),
    ]);
    const address = cbAddress.ok ? cbAddress.data?.chequebookAddress : null;
    const walletAddress = addresses.ok ? addresses.data?.ethereum : wallet.data?.walletAddress;
    return {
      at,
      storage,
      walletAddress: isAddress(walletAddress) ? walletAddress.toLowerCase() : null,
      xdaiWei: wallet.ok ? wallet.data?.nativeTokenBalance : null,
      bzzPlur: wallet.ok ? wallet.data?.bzzBalance : null,
      chequebook: isZeroAddress(address)
        ? null
        : {
            address: address.toLowerCase(),
            depositPlur: cbBalance.ok ? String(cbBalance.data?.availableBalance ?? '0') : null,
            targetPlur: null,
            needsTopUp: false,
            managed: null,
          },
    };
  }

  async function runAccount() {
    if (node.status !== 'running') {
      account = null;
      return;
    }
    const res = await api.getSettlementDeposit();
    const at = now();
    if (res.ok && res.data) {
      account = accountFromDeposit(res.data, at);
    } else if (antStorageApi.isStorageRouteMissing(res)) {
      account = await legacyAccount(at, 'missing');
    } else if (res.status === 501) {
      account = {
        at,
        storage: 'no-chain',
        walletAddress: null,
        xdaiWei: null,
        bzzPlur: null,
        chequebook: null,
      };
    }
    // 503 (chain init), 5xx and timeouts keep the previous snapshot.
  }

  function probeOnce() {
    if (!probeInflight) {
      probeInflight = runProbe()
        .catch((err) => log.warn(`[PublishSetup] readiness probe failed: ${err.message}`))
        .finally(() => {
          probeInflight = null;
        });
    }
    return probeInflight;
  }

  function accountOnce() {
    if (!accountInflight) {
      accountInflight = runAccount()
        .catch((err) => log.warn(`[PublishSetup] account probe failed: ${err.message}`))
        .finally(() => {
          accountInflight = null;
        });
    }
    return accountInflight;
  }

  async function refresh({ withAccount = false } = {}) {
    await probeOnce();
    if (withAccount && probe?.chainReady === true) await accountOnce();
    emit();
  }

  async function ensureFresh(maxAgeMs) {
    node = readNode();
    if (node.status !== 'running') {
      probe = null;
      emit();
      return;
    }
    if (probe && now() - probe.at <= maxAgeMs) return;
    await refresh();
  }

  // While converging the watch polls every few seconds: chain init, and a
  // reported rediscovery, so its progress moves and the plans (or the found
  // storage) show soon after it finishes.
  function isConverging() {
    if (!probe || probe.unreachable || probe.chainReady === false || !probe.stamps?.known) {
      return true;
    }
    return holdKind() === 'reported' && rediscoveryHold() !== null;
  }

  function scheduleWatch() {
    clearTimeout(watchTimer);
    watchTimer = null;
    if (disposed || watchers.size === 0 || node.status !== 'running') return;
    watchTimer = setTimeout(
      async () => {
        watchTimer = null;
        // Chain-heavy reads (the deposit route reads balances and the
        // chequebook over RPC) only in the steady cadence, or once when the
        // chain first comes up.
        await refresh({ withAccount: !isConverging() || !account });
        scheduleWatch();
      },
      isConverging() ? STARTUP_REFRESH_MS : WATCH_REFRESH_MS
    );
  }

  function watch(key, on) {
    const before = watchers.size;
    if (on) watchers.add(key);
    else watchers.delete(key);
    if (!on) settleDismissal();
    if (before === 0 && watchers.size > 0) {
      void refresh({ withAccount: true }).then(scheduleWatch);
      return;
    }
    scheduleWatch();
  }

  function unwatchPrefix(prefix) {
    for (const key of [...watchers]) {
      if (key.startsWith(prefix)) watchers.delete(key);
    }
    settleDismissal();
    scheduleWatch();
  }

  function handleNodeStatus() {
    const previous = node.status;
    node = readNode();
    if (node.status === 'running' && previous !== 'running') {
      runningSince = now();
      nodeRun += 1;
    }
    if (node.status !== 'running') {
      runningSince = null;
      probe = null;
      account = null;
    }
    emit();
    if (node.status === 'running' && previous !== 'running' && watchers.size > 0) {
      void refresh({ withAccount: true }).then(scheduleWatch);
      return;
    }
    scheduleWatch();
  }

  // ---------------------------------------------------------------------------
  // The armed operation
  // ---------------------------------------------------------------------------

  function clearQuoteTimer() {
    clearTimeout(quoteTimer);
    quoteTimer = null;
  }

  function stopTxPoll() {
    clearTimeout(txTimer);
    txTimer = null;
  }

  function stopConfirmPoll() {
    clearTimeout(confirmTimer);
    confirmTimer = null;
  }

  function scheduleQuote(current) {
    clearQuoteTimer();
    if (disposed || operation !== current || !QUOTING_PHASES.has(current.phase)) return;
    quoteTimer = setTimeout(() => void requote(current), REQUOTE_MS);
  }

  function fetchQuote(op) {
    if (op.kind === 'deposit') return api.getSettlementDeposit();
    if (op.kind === 'extend') {
      const { batchId, days, depth } = op.params;
      return api.getStorageQuote({ batchId, days, depth: depth ?? undefined });
    }
    return api.getStorageQuote({ depth: op.params.depth, days: op.params.days });
  }

  function writeOperation(op) {
    if (op.kind === 'deposit') {
      return api.topUpSettlementDeposit({ amountPlur: op.params.amountPlur });
    }
    if (op.kind === 'extend') {
      return api.extendStorage({
        batchId: op.params.batchId,
        amountPerChunk: op.quote.amountPerChunk,
        depth: op.params.depth ?? undefined,
      });
    }
    return api.buyStorage({
      depth: op.params.depth,
      amountPerChunk: op.quote.amountPerChunk,
      immutable: op.params.immutable,
    });
  }

  function isPermanentQuoteFailure(res) {
    return (
      antStorageApi.isStorageRouteMissing(res) ||
      res.status === 400 ||
      res.status === 404 ||
      res.status === 501
    );
  }

  function finishOperation(current, result) {
    clearQuoteTimer();
    stopTxPoll();
    stopConfirmPoll();
    current.phase = 'done';
    current.result = result;
    current.notice = null;
    current.error = null;
    emit();
    void refresh({ withAccount: true });
  }

  function failOperation(current, message, { uncertain = false } = {}) {
    clearQuoteTimer();
    stopTxPoll();
    stopConfirmPoll();
    current.phase = 'failed';
    current.error = message;
    current.notice = null;
    current.uncertain = uncertain;
    emit();
    void refresh({ withAccount: true });
  }

  async function stampIds() {
    const res = await api.getStamps({ timeoutMs: PROBE_TIMEOUT_MS });
    if (!res.ok || !Array.isArray(res.data?.stamps)) return null;
    return new Set(res.data.stamps.map((s) => normalizeBatchId(s?.batchID)).filter(Boolean));
  }

  async function pollConfirm(current, deadline) {
    confirmTimer = null;
    if (operation !== current || current.phase !== 'confirming') return;
    const res = await api.getStamps({ timeoutMs: PROBE_TIMEOUT_MS });
    if (operation !== current || current.phase !== 'confirming') return;
    const batch = Array.isArray(res.data?.stamps)
      ? res.data.stamps.find((s) => normalizeBatchId(s?.batchID) === current.result.batchId)
      : null;
    if (res.ok && isUsableStamp(batch)) {
      finishOperation(current, current.result);
      return;
    }
    if (res.ok && batch && batch.propagating === false) {
      // Ant gave up on it (storer peers rejected it, or the chain says it is
      // gone): waiting out the confirm window would only hold the screen on
      // a spinner and refuse a new plan. Fail so the user can act.
      log.warn(`[PublishSetup] batch ${current.result.batchId} stopped propagating`);
      failOperation(current, REJECTED_BATCH_MESSAGE);
      return;
    }
    if (now() >= deadline) {
      log.warn(
        `[PublishSetup] batch ${current.result.batchId} not usable after the confirm window`
      );
      finishOperation(current, { ...current.result, slow: true });
      return;
    }
    confirmTimer = setTimeout(() => void pollConfirm(current, deadline), CONFIRM_POLL_MS);
  }

  /**
   * A bought batch is paid for and registered, but storer peers accept its
   * stamps only once they have synced its creation from the chain; until then
   * an upload fails with "not found on-chain". Stay in `confirming` until the
   * node reports the batch usable, so "done" means "you can publish now".
   */
  function confirmBatch(current, batchId) {
    current.phase = 'confirming';
    current.result = { batchId };
    current.notice = null;
    emit();
    void pollConfirm(current, now() + CONFIRM_TIMEOUT_MS);
  }

  async function execute(current) {
    // Exactly once per quote that said the funds are there: a second quote
    // landing while this one runs finds `executed` set and leaves.
    if (current.executed) return;
    current.executed = true;
    clearQuoteTimer();
    stopTxPoll();
    current.phase = 'executing';
    current.notice = null;
    current.error = null;
    current.uncertain = false;
    emit();

    const before = current.kind === 'buy' ? await stampIds() : null;
    log.info(`[PublishSetup] ${actionLabel(current.kind)} (${JSON.stringify(current.request)})`);
    const res = await writeOperation(current);
    if (operation !== current) return;

    if (res.ok) {
      const batchId = normalizeBatchId(res.data?.batchID);
      log.info(
        `[PublishSetup] ${actionLabel(current.kind)} succeeded${batchId ? `: batch ${batchId}` : ''}`
      );
      if (current.kind === 'buy' && batchId) confirmBatch(current, batchId);
      else finishOperation(current, current.kind === 'deposit' ? { deposit: true } : { batchId });
      return;
    }

    const label = actionLabel(current.kind);
    // An amount deposit has no quote route of its own: the node prices it when
    // asked to pay, and refuses before sending anything when its wallet is
    // short. That refusal is the quote (see requoteAmountDeposit).
    if (current.params.amountPlur && isShortOfXdai(res)) {
      const short = parseXdaiShortfall(res.message);
      if (short === null) {
        failOperation(current, antStorageApi.describeAntError(res, label));
        return;
      }
      current.executed = false;
      current.xdaiNeededWei = (current.walletXdaiWei ?? 0n) + short;
      current.quote = amountQuote(current, short);
      current.phase = 'awaiting-funds';
      current.notice = null;
      emit();
      scheduleQuote(current);
      return;
    }

    // 409 (another node transaction runs), 503 (chain init) and a funds race
    // leave nothing on chain: go back to quoting and try again.
    if (res.status === 409 || res.status === 503 || isShortOfXdai(res)) {
      current.executed = false;
      current.phase = isShortOfXdai(res) ? 'awaiting-funds' : 'quoting';
      current.notice = antStorageApi.describeAntError(res, label);
      emit();
      scheduleQuote(current);
      return;
    }

    if (antStorageApi.isUncertainWrite(res)) {
      log.warn(`[PublishSetup] ${label}: outcome unknown (status ${res.status})`);
      if (before) {
        const after = await stampIds();
        if (operation !== current) return;
        const added = after ? [...after].find((id) => !before.has(id)) : null;
        if (added) {
          confirmBatch(current, added);
          return;
        }
      }
      failOperation(current, UNCERTAIN_MESSAGE, { uncertain: true });
      return;
    }

    log.warn(`[PublishSetup] ${label} failed: ${res.status} ${res.message || ''}`);
    failOperation(current, antStorageApi.describeAntError(res, label));
  }

  async function requote(current) {
    quoteTimer = null;
    if (operation !== current || !QUOTING_PHASES.has(current.phase)) return;
    const res = await fetchQuote(current);
    if (operation !== current || !QUOTING_PHASES.has(current.phase)) return;

    if (!res.ok) {
      if (antStorageApi.isStorageRouteMissing(res) && account) account.storage = 'missing';
      if (isPermanentQuoteFailure(res)) {
        failOperation(current, antStorageApi.describeAntError(res, actionLabel(current.kind)));
        return;
      }
      current.notice = antStorageApi.describeAntError(res, 'Getting a price');
      emit();
      scheduleQuote(current);
      return;
    }

    if (current.kind === 'deposit') {
      if (isZeroAddress(res.data?.chequebook)) {
        failOperation(
          current,
          'There is no chequebook yet. Your first storage purchase creates and funds it.'
        );
        return;
      }
      if (res.data.managed === false) {
        failOperation(
          current,
          'This node manages its chequebook deposit through its own configuration.'
        );
        return;
      }
      if (current.params.amountPlur) {
        await requoteAmountDeposit(current, res.data);
        return;
      }
      if (res.data.needsTopUp !== true) {
        finishOperation(current, { deposit: true, alreadyFull: true });
        return;
      }
    }

    const quote = normalizeQuote(res.data, current.kind);
    if (!quote) {
      current.notice = 'The Swarm node returned a price Freedom could not read.';
      emit();
      scheduleQuote(current);
      return;
    }
    current.quote = quote;
    current.notice = current.fundingTx?.status === 'failed' ? current.notice : null;
    if (quote.sufficientFunds) {
      await execute(current);
      return;
    }
    current.phase = 'awaiting-funds';
    emit();
    scheduleQuote(current);
  }

  /**
   * A deposit of an amount the user picked (freedom-hq/ant#126). The deposit
   * route prices only a top-up to the node's target, so this one is priced by
   * asking the node to pay it: the first quote goes straight to the write,
   * which either deposits (the wallet had the xDAI, as a target top-up with
   * `sufficientFunds` does) or is refused before anything is sent, naming the
   * xDAI the wallet lacks. That becomes the pay step's figure, and the write
   * is tried again once the wallet holds that much more.
   *
   * The node swaps from its wallet before Freedom has any price, so that first
   * write may spend only the xDAI the deposit screen showed the user as
   * at stake (`walletSpendCapWei`, from the request). A wallet that has grown
   * since fails the operation instead of spending xDAI nobody agreed to.
   *
   * An Ant release from before #126 ignores `?amount=` and would top up to its
   * target instead, so the node must report `/node`'s `settlement` first.
   */
  async function requoteAmountDeposit(current, data) {
    if (!current.amountChecked) {
      const info = await api.getNode({ timeoutMs: PROBE_TIMEOUT_MS });
      if (operation !== current || !QUOTING_PHASES.has(current.phase)) return;
      if (!info.ok) {
        current.notice = antStorageApi.describeAntError(info, 'Getting a price');
        emit();
        scheduleQuote(current);
        return;
      }
      const settlement = info.data?.settlement;
      if (!settlement || typeof settlement !== 'object') {
        failOperation(current, OLD_NODE_DEPOSIT_AMOUNT_MESSAGE);
        return;
      }
      current.amountChecked = true;
    }
    const wallet = toBigInt(data.walletXdaiWei);
    if (!isAddress(data.walletAddress) || wallet === null || wallet < 0n) {
      current.notice = 'The Swarm node returned a price Freedom could not read.';
      emit();
      scheduleQuote(current);
      return;
    }
    current.walletAddress = data.walletAddress.toLowerCase();
    current.walletXdaiWei = wallet;
    if (current.xdaiNeededWei == null) {
      if (wallet > current.params.walletSpendCapWei) {
        failOperation(current, WALLET_GREW_MESSAGE);
        return;
      }
      await execute(current);
      return;
    }
    if (wallet >= current.xdaiNeededWei) {
      await execute(current);
      return;
    }
    current.quote = amountQuote(current, current.xdaiNeededWei - wallet);
    current.notice = current.fundingTx?.status === 'failed' ? current.notice : null;
    current.phase = 'awaiting-funds';
    emit();
    scheduleQuote(current);
  }

  function arm(request) {
    if (disposed) return { ok: false, error: 'Freedom is shutting down.' };
    if (operation?.phase === 'executing') {
      return { ok: false, error: 'Freedom is already buying storage. Wait for it to finish.' };
    }
    if (operation?.phase === 'confirming') {
      return {
        ok: false,
        error: 'Your new storage is still reaching the network. Wait a moment for it to finish.',
      };
    }
    if (node.registryMode === 'reused') {
      return { ok: false, error: 'This Swarm node is managed outside Freedom.' };
    }
    const parsed = parseRequest(request);
    if (parsed.error) return { ok: false, error: parsed.error };
    clearQuoteTimer();
    stopTxPoll();
    operation = {
      id: ++opSeq,
      kind: parsed.kind,
      request: parsed.request,
      params: parsed.params,
      phase: 'quoting',
      quote: null,
      notice: null,
      error: null,
      uncertain: false,
      result: null,
      fundingTx: null,
      executed: false,
      // An amount deposit's pricing (requoteAmountDeposit).
      amountChecked: false,
      walletAddress: null,
      walletXdaiWei: null,
      xdaiNeededWei: null,
    };
    emit();
    void requote(operation);
    return { ok: true, state: getState() };
  }

  /**
   * Drop the operation. With `opId`, only that one: a screen dismissing a
   * result it showed must not cancel a newer operation armed meanwhile.
   */
  function cancel(opId = null) {
    if (!operation) return { ok: true, state: getState() };
    if (opId !== null && opId !== undefined && operation.id !== opId) {
      return { ok: true, state: getState() };
    }
    if (operation.phase === 'executing') {
      return { ok: false, error: 'The purchase is already on its way and cannot be cancelled.' };
    }
    operation = null;
    clearQuoteTimer();
    stopTxPoll();
    stopConfirmPoll();
    emit();
    return { ok: true, state: getState() };
  }

  /**
   * A window leaving a finished (done/failed) result it showed. The result is
   * shared by every window, so it is dropped only once no window that has not
   * left it still has the setup screen up: a tab switch in one window must not
   * take a failure (an uncertain one included) off the screen of another.
   * `viewer` is the leaving window's watch-key prefix. Main remembers every
   * window that left: such a window hides the result itself if it reopens the
   * screen and never sends a second dismissal, so its open screen must not
   * keep the result alive, and the last other window leaving or closing (a
   * watch going off, see settleDismissal) drops it. Never drops an operation
   * that is still running.
   */
  function dismiss(opId, viewer = '') {
    if (!operation || operation.id !== opId) return { ok: true, state: getState() };
    if (operation.phase !== 'done' && operation.phase !== 'failed') {
      return { ok: true, state: getState() };
    }
    if (dismissal.opId !== opId) dismissal = { opId, viewers: new Set() };
    if (viewer) dismissal.viewers.add(viewer);
    if (shownToUndismissedViewer()) return { ok: true, state: getState() };
    return cancel(opId);
  }

  /** Is the setup screen up in a window that has not left the result? */
  function shownToUndismissedViewer() {
    const viewers = [...dismissal.viewers];
    return [...watchers].some(
      (key) => key.endsWith(`:${SETUP_SCREEN_SURFACE}`) && !viewers.some((v) => key.startsWith(v))
    );
  }

  /**
   * After a setup screen goes away (left, or its window closed), drop a
   * finished result some window already left once no window that has not
   * left it still shows it.
   */
  function settleDismissal() {
    if (!operation || dismissal.opId !== operation.id || dismissal.viewers.size === 0) return;
    if (operation.phase !== 'done' && operation.phase !== 'failed') return;
    if (shownToUndismissedViewer()) return;
    cancel(operation.id);
  }

  async function pollFundingTx(current, tx, deadline) {
    txTimer = null;
    if (operation !== current || current.fundingTx !== tx || tx.status !== 'pending') return;
    let status;
    try {
      status = await getTransactionStatus(tx.hash, GNOSIS_CHAIN_ID);
    } catch {
      status = null;
    }
    if (operation !== current || current.fundingTx !== tx) return;
    if (status?.status === 'confirmed') {
      tx.status = 'confirmed';
      emit();
      if (QUOTING_PHASES.has(current.phase)) {
        clearQuoteTimer();
        void requote(current);
      }
      return;
    }
    if (status?.status === 'failed') {
      tx.status = 'failed';
      current.notice =
        'Your payment failed on Gnosis Chain, so no xDAI was sent. Pay again to continue.';
      emit();
      return;
    }
    if (now() > deadline) {
      tx.status = 'unknown';
      emit();
      return;
    }
    txTimer = setTimeout(() => void pollFundingTx(current, tx, deadline), FUNDING_TX_POLL_MS);
  }

  /**
   * Follow the user's own payment from the Freedom wallet: a mined but
   * reverted transaction sends nothing, and only its receipt says so.
   */
  function trackFundingTx(hash) {
    if (!operation || !QUOTING_PHASES.has(operation.phase)) return { ok: false };
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      return { ok: false, error: 'Invalid transaction hash.' };
    }
    stopTxPoll();
    const tx = { hash: hash.toLowerCase(), status: 'pending' };
    operation.fundingTx = tx;
    operation.notice = null;
    emit();
    void pollFundingTx(operation, tx, now() + FUNDING_TX_TIMEOUT_MS);
    return { ok: true };
  }

  async function restartNodeAction() {
    if (restart.inProgress) return { ok: false, error: 'The Swarm node is already restarting.' };
    const mode = node.registryMode;
    if (mode === 'reused' || mode === 'disabled') {
      return { ok: false, error: 'Freedom does not manage this Swarm node.' };
    }
    if (operation?.phase === 'executing') {
      return { ok: false, error: 'Wait for the purchase to finish before restarting the node.' };
    }
    restart = { inProgress: true, error: null };
    emit();
    try {
      await restartNode();
      restart = { inProgress: false, error: null };
    } catch (err) {
      restart = { inProgress: false, error: err?.message || 'Restarting the Swarm node failed.' };
    }
    emit();
    return { ok: !restart.error, error: restart.error };
  }

  // ---------------------------------------------------------------------------
  // Quotes for the pickers
  // ---------------------------------------------------------------------------

  function attachQuote(option, res, kind) {
    if (antStorageApi.isStorageRouteMissing(res) && account) account.storage = 'missing';
    const quote = res.ok ? normalizeQuote(res.data, kind) : null;
    return {
      ...option,
      quote,
      error: quote ? null : antStorageApi.describeAntError(res, 'Getting a price'),
    };
  }

  async function getPlans() {
    const results = await Promise.all(
      PLANS.map((plan) => api.getStorageQuote({ depth: plan.depth, days: plan.days }))
    );
    const plans = PLANS.map((plan, i) => attachQuote({ ...plan }, results[i], 'buy'));
    emit();
    return { plans };
  }

  async function getExtendOptions(batchId, currentDepth) {
    const id = normalizeBatchId(batchId);
    if (!id) return { error: 'Invalid storage batch.', durations: [], sizes: [] };
    const durations = EXTEND_DAYS.map((days) => ({ days }));
    const sizes = Number.isInteger(currentDepth)
      ? PLANS.filter((p) => p.depth > currentDepth).map((p) => ({
          depth: p.depth,
          safeLimitBytes: p.safeLimitBytes,
        }))
      : [];
    const results = await Promise.all([
      ...durations.map(({ days }) => api.getStorageQuote({ batchId: id, days })),
      ...sizes.map(({ depth }) => api.getStorageQuote({ batchId: id, days: 0, depth })),
    ]);
    emit();
    return {
      durations: durations.map((d, i) => attachQuote(d, results[i], 'extend')),
      sizes: sizes.map((s, i) => attachQuote(s, results[durations.length + i], 'extend')),
    };
  }

  async function getPublishReadiness() {
    await ensureFresh(READINESS_MAX_AGE_MS);
    const readiness = currentReadiness();
    return { ok: readiness.ok, reason: readiness.reason, message: readiness.message };
  }

  function dispose() {
    disposed = true;
    clearTimeout(watchTimer);
    watchTimer = null;
    clearQuoteTimer();
    stopTxPoll();
    stopConfirmPoll();
    watchers.clear();
  }

  return {
    getState,
    ensureFresh,
    refresh,
    watch,
    unwatchPrefix,
    handleNodeStatus,
    arm,
    cancel,
    dismiss,
    trackFundingTx,
    restartNode: restartNodeAction,
    getPlans,
    getExtendOptions,
    getPublishReadiness,
    dispose,
  };
}

// -----------------------------------------------------------------------------
// The app's instance and its IPC
// -----------------------------------------------------------------------------

let service = null;

// Setup state names the node wallet and its balances: push it to the chrome
// and Freedom's internal pages only, never to a web page's webContents.
function broadcastState(state) {
  const { webContents } = require('electron');
  const { isChromeIndexUrl, internalPageFileForUrl } = require('../ipc-sender-policy');
  for (const wc of webContents?.getAllWebContents?.() || []) {
    try {
      const url = wc.getURL();
      if (isChromeIndexUrl(url) || internalPageFileForUrl(url)) {
        wc.send(IPC.SWARM_SETUP_STATE, state);
      }
    } catch {
      // webContents may be destroyed mid-iteration
    }
  }
}

function getPublishSetupService() {
  if (!service) {
    const antManager = require('../ant-manager');
    const { getRegistry } = require('../service-registry');
    const { getTransactionStatus } = require('../wallet/transaction-service');
    service = createPublishSetupService({
      getNodeStatus: antManager.getStatus,
      getRegistryMode: () => getRegistry().ant?.mode,
      getNodeStartedAt: antManager.getSpawnedAt,
      restartNode: async () => {
        await antManager.stopAnt();
        await antManager.startAnt();
      },
      getTransactionStatus,
      getWalletTxCount: async (address) => {
        const chainData = require('../networks/chain-data-router');
        const { result } = await chainData.request(GNOSIS_CHAIN_ID, 'eth_getTransactionCount', [
          address,
          'latest',
        ]);
        const count = toBigInt(result);
        return count === null || count < 0n ? null : Number(count);
      },
      publish: broadcastState,
    });
    antManager.onStatusChange(() => service.handleNodeStatus());
  }
  return service;
}

/** The swarm provider's pre-flight: `{ ok, reason, message }`. */
function getPublishReadiness() {
  return getPublishSetupService().getPublishReadiness();
}

function registerPublishSetupIpc() {
  const svc = getPublishSetupService();
  const watchedSenders = new Set();

  ipcMain.handle(IPC.SWARM_SETUP_GET_STATE, async () => {
    await svc.ensureFresh(STATE_MAX_AGE_MS);
    return svc.getState();
  });

  // A surface that shows chain-backed data (balances, the deposit) says when
  // it is on screen; the service polls only while at least one is.
  ipcMain.handle(IPC.SWARM_SETUP_WATCH, (event, surface, on) => {
    const sender = event.sender;
    const prefix = `${sender.id}:`;
    if (on === true && !watchedSenders.has(sender.id)) {
      watchedSenders.add(sender.id);
      sender.once('destroyed', () => {
        watchedSenders.delete(sender.id);
        svc.unwatchPrefix(prefix);
      });
    }
    svc.watch(`${prefix}${String(surface).slice(0, 64)}`, on === true);
    return svc.getState();
  });

  ipcMain.handle(IPC.SWARM_SETUP_GET_PLANS, () => svc.getPlans());
  ipcMain.handle(IPC.SWARM_SETUP_GET_EXTEND_OPTIONS, (_event, batchId, depth) =>
    svc.getExtendOptions(batchId, depth)
  );
  ipcMain.handle(IPC.SWARM_SETUP_ARM, (_event, request) => svc.arm(request));
  // `{ dismiss: true }`: the screen is leaving a finished result it showed,
  // which another window may still have up (dismiss() above).
  ipcMain.handle(IPC.SWARM_SETUP_CANCEL, (event, opId, options) => {
    const id = Number.isInteger(opId) ? opId : null;
    if (options?.dismiss === true) {
      if (id === null) return { ok: true, state: svc.getState() };
      return svc.dismiss(id, `${event.sender.id}:`);
    }
    return svc.cancel(id);
  });
  ipcMain.handle(IPC.SWARM_SETUP_TRACK_FUNDING_TX, (_event, hash) => svc.trackFundingTx(hash));
  ipcMain.handle(IPC.SWARM_SETUP_RESTART_NODE, () => svc.restartNode());

  log.info('[PublishSetup] IPC handlers registered');
}

module.exports = {
  createPublishSetupService,
  classifyReadiness,
  normalizeQuote,
  roundUpToCent,
  formatUnits,
  normalizeSwarmMode,
  parseXdaiShortfall,
  parseDepositAmount,
  getPublishSetupService,
  getPublishReadiness,
  registerPublishSetupIpc,
  PLANS,
  EXTEND_DAYS,
  REQUOTE_MS,
  WATCH_REFRESH_MS,
  STARTUP_REFRESH_MS,
  FUNDING_TX_POLL_MS,
  CONFIRM_POLL_MS,
  CONFIRM_TIMEOUT_MS,
  CHAIN_INIT_SLOW_MS,
  REDISCOVERY_MAX_WAIT_MS,
  REDISCOVERY_SLOW_MS,
  SCAN_STALL_MAX_MS,
  MIN_DEPOSIT_AMOUNT_PLUR,
  MAX_DEPOSIT_AMOUNT_PLUR,
};
