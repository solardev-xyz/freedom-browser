/**
 * The finality tracker: reads each held wallet intent's label at the
 * chain's finalized block (intent-labels.js) and settles the intent when
 * it is paid, failed or taken (freedom-core design 0005, "Retrying an
 * intent"). Until then the intent stays held, with what the reads saw kept
 * for the display.
 *
 * - **When:** a pass shortly after startup; about a minute after each
 *   broadcast; then every 2 minutes while intents are held, every 10 once
 *   the newest held intent has seen no activity for an hour, unless one of
 *   them was broadcast (possibly sent): then every 2 minutes until it has a
 *   label, so its bracket stays close to F (below). Nothing held, no timer:
 *   the next intent's broadcast wakes it.
 * - **The bracket** (design 0005, "State history", #94): each read that
 *   finds an intent's nonce unused at F moves its bracket up to F, and the
 *   store keeps it with the record (`store.track`), across restarts. Once
 *   the nonce is used, the search for the block that used it runs above
 *   the bracket: its deepest probe is then F's lag plus at most a pass's
 *   blocks below the head, within the window of recent state that a
 *   quorum's endpoints serve. Colibri, asked first, proves reads deeper.
 * - **Couldn't confirm:** a held intent whose passes couldn't read a label
 *   for a day (COULDNT_CONFIRM_AFTER_MS, counted from the first such pass
 *   and kept across restarts): its verified nonce at F couldn't be read, or
 *   it was past N and the block that used N was out of reach. Never one
 *   whose verified nonce at F is N or below: that one is unmined, and is
 *   offered sending again. It stays held and is read on every pass, so a
 *   source that reaches the evidence still settles it. Once a verified read
 *   in this run showed its nonce past N, it may be closed by hand
 *   (`closeEvidence`, intent-ipc.js).
 * - **Settling:** `store.settle` with the label, the included hash and the
 *   finalized block, conditional on the hashes that were read; then the
 *   history row (`confirmed`, `failed` or `taken`). The store's change
 *   reaches the chrome as `wallet:intents-changed` (intent-ipc.js); so
 *   does a change in what the reads saw, through `onChange`.
 * - **Bounds:** at most `concurrency` reads at once, one pass at a time,
 *   identical reads made once per pass, and no reads while the core isn't
 *   serving chain data. Per pass and chain: the headers from the last
 *   finalized block up to the new one, and down to the deepest block a
 *   label needs, never more than MAX_DEPTH (8192) below F; per intent, its
 *   nonce at F, up to 8 receipts, and, when another transaction may have
 *   used its nonce, at most 2 × 13 nonce reads to find that block and one
 *   block read. What it keeps is bounded too: replies are compacted as
 *   each resolves (a header to its number, hash and parent hash); only the
 *   finalized block and nonces are shared through a pass; headers are
 *   walked a chunk at a time; and a chain's verified headers (at most
 *   8193) are released with its last held intent.
 *
 * Settling is not only display: it forgets the intent's bytes and frees
 * its key, so a later send of the same operation takes a new nonce. That
 * is why a label rests only on evidence tied to the one finalized chain
 * (intent-labels.js).
 */

const log = require('../logger');
const {
  LABELS,
  OBSERVED,
  compactReply,
  createChainSegment,
  readLabel,
} = require('./intent-labels');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const SCHEDULE = Object.freeze({
  // The core starts with the app; the first pass leaves it a moment.
  startupMs: 15 * SECOND,
  afterBroadcastMs: MINUTE,
  fastMs: 2 * MINUTE,
  slowMs: 10 * MINUTE,
  // Since the newest held intent's last write (a commit or a handoff).
  slowAfterMs: 60 * MINUTE,
  coreDownMs: 30 * SECOND,
});
const CONCURRENCY = 4;
/** How long a held intent's passes go without reading a label before it is
 * shown as Couldn't confirm (a constant to tune, design 0005). */
const COULDNT_CONFIRM_AFTER_MS = 24 * 60 * MINUTE;

// Whether the core is serving chain data now.
function coreServesChain() {
  const driver = require('../core/chain').chainDriver();
  return Boolean(driver && driver.client?.state === 'ready');
}

// At most `limit` calls of `fn` at once.
function bounded(fn, limit) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= limit || waiting.length === 0) return;
    active += 1;
    const { args, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(() => fn(...args))
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (...args) =>
    new Promise((resolve, reject) => {
      waiting.push({ args, resolve, reject });
      next();
    });
}

/**
 * @param {object} deps
 * @param {object} deps.store - the intent store
 * @param {Function} deps.request - chainData.request
 * @param {Function} deps.recordSettlement - tx-recorder's
 * @param {() => boolean} [deps.coreReady]
 * @param {() => number} [deps.now]
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers]
 * @param {number} [deps.concurrency]
 * @param {Partial<typeof SCHEDULE>} [deps.schedule]
 * @param {number} [deps.couldntConfirmAfterMs]
 */
function createIntentTracker({
  store,
  request,
  recordSettlement,
  coreReady = coreServesChain,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  concurrency = CONCURRENCY,
  schedule: overrides = {},
  couldntConfirmAfterMs = COULDNT_CONFIRM_AFTER_MS,
}) {
  const schedule = { ...SCHEDULE, ...overrides };
  const limitedRequest = bounded(request, concurrency);
  const observations = new Map();
  // Per held intent, this run: the finalized block where a verified read
  // saw its nonce past N. Final, as the finalized chain is.
  const usedNonces = new Map();
  // Per held intent, what the display last showed of Couldn't confirm.
  const shown = new Map();
  // Each chain's headers verified down from its finalized block: immutable,
  // so kept across passes and shared by the chain's intents.
  const segments = new Map();
  const listeners = new Set();
  let started = false;
  let timer = null;
  let dueAt = null;
  let passing = null;
  let unsubscribe = null;

  function emit() {
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        log.warn(`[IntentTracker] A change listener failed: ${err.message}`);
      }
    }
  }

  // Run a pass at `at`, unless one is due sooner.
  function scheduleAt(at) {
    if (!started) return;
    if (timer && dueAt <= at) return;
    if (timer) timers.clearTimeout(timer);
    dueAt = at;
    timer = timers.setTimeout(
      () => {
        timer = null;
        dueAt = null;
        pass().catch((err) => log.warn(`[IntentTracker] A pass failed: ${err.message}`));
      },
      Math.max(0, at - now())
    );
    timer?.unref?.();
  }

  function heldNow() {
    try {
      return store.held();
    } catch {
      return [];
    }
  }

  // When the next pass is due, after one: none with nothing held. Fast
  // while a broadcast intent has no label (its bracket's reach depends on
  // it), or while the newest held intent saw activity in the last hour.
  function scheduleNext() {
    const held = heldNow();
    if (held.length === 0) return;
    const newest = Math.max(...held.map((intent) => intent.updatedAt ?? intent.createdAt ?? 0));
    const broadcast = held.some((intent) => intent.possiblySent);
    const fast = broadcast || now() - newest < schedule.slowAfterMs;
    scheduleAt(now() + (fast ? schedule.fastMs : schedule.slowMs));
  }

  // A chain with no held intents releases its verified headers (freedom-
  // core design 0005, rule 2).
  function releaseIdleSegments() {
    if (segments.size === 0) return;
    const stillHeld = new Set(heldNow().map((intent) => intent.chainId));
    for (const chainId of segments.keys()) {
      if (!stillHeld.has(chainId)) segments.delete(chainId);
    }
  }

  function lastHandoffAt(intent) {
    return intent.handoffs.reduce((latest, handoff) => Math.max(latest, handoff.at ?? 0), 0);
  }

  // A write to an intent: a broadcast of a held one is checked about a
  // minute later; a newly held one wakes an idle tracker.
  function onStoreChange(intentId) {
    let intent;
    try {
      intent = store.get(intentId);
    } catch {
      return;
    }
    if (!intent || intent.state !== 'held') {
      usedNonces.delete(intentId);
      const wasShown = shown.delete(intentId);
      if (observations.delete(intentId) || wasShown) emit();
      // Settled or voided outside a pass: its chain may have nothing held
      // left, and no pass may come to release its headers.
      releaseIdleSegments();
      return;
    }
    const handedOff = lastHandoffAt(intent);
    if (handedOff && now() - handedOff < schedule.afterBroadcastMs) {
      scheduleAt(handedOff + schedule.afterBroadcastMs);
    } else if (!timer && !passing) {
      scheduleAt(now() + schedule.fastMs);
    }
  }

  function observe(intentId, observed, reason) {
    const before = observations.get(intentId);
    observations.set(intentId, { observed, reason, at: now() });
    return before?.observed !== observed;
  }

  // Settle `intent` as `result` says, if its hashes are still the ones
  // read: the store checks that in line with its other writes, so a
  // replacement committed meanwhile, even one still being written, keeps
  // it held until the next pass reads it.
  async function settle(intent, result) {
    const current = store.get(intent.intentId);
    if (!current || current.state !== 'held') return false;
    try {
      await store.settle({
        intentId: intent.intentId,
        label: result.label,
        hash: result.hash,
        block: result.block,
        hashes: intent.hashes.map((entry) => entry.hash),
      });
    } catch (err) {
      if (err.code !== 'INTENT_CHANGED') throw err;
      log.info(
        `[IntentTracker] Intent ${intent.intentId} changed while read; read again next pass`
      );
      return false;
    }
    log.info(
      `[IntentTracker] Intent ${intent.intentId} is ${result.label} at finalized block ${result.block}`
    );
    recordSettlement(intent, { label: result.label, hash: result.hash, block: result.block });
    return true;
  }

  const sameBracket = (a, b) =>
    (a ?? null) === (b ?? null) || (a && b && a.number === b.number && a.hash === b.hash);

  // What a held read leaves for later passes: the bracket it moved up or
  // dropped, and since when the intent's label couldn't be read, kept with
  // the record when either changed. A read that saw the nonce unused at F
  // (and no read this run saw it used) is an unmined intent: never
  // Couldn't confirm.
  async function keep(intent, result) {
    const seen = result.nonceAtF;
    if (seen?.used && !usedNonces.has(intent.intentId)) {
      usedNonces.set(intent.intentId, { block: seen.block, hash: seen.hash });
    }
    const unmined = seen && !seen.used && !usedNonces.has(intent.intentId);
    const unreadSince = unmined ? null : (intent.unreadSince ?? now());
    const bracket = result.bracket ?? null;
    if (sameBracket(bracket, intent.bracket) && unreadSince === (intent.unreadSince ?? null)) {
      return;
    }
    try {
      await store.track({ intentId: intent.intentId, bracket, unreadSince });
    } catch (err) {
      // Settled or closed meanwhile, or no room: the next pass reads again.
      if (err.code !== 'INTENT_NOT_HELD') {
        log.warn(
          `[IntentTracker] Could not keep intent ${intent.intentId}'s progress: ${err.message}`
        );
      }
    }
  }

  async function check(intent, read) {
    let result;
    try {
      if (!segments.has(intent.chainId)) segments.set(intent.chainId, createChainSegment());
      result = await readLabel(intent, {
        request: read,
        segment: segments.get(intent.chainId),
        bracket: intent.bracket ?? null,
      });
    } catch (err) {
      result = {
        label: LABELS.HELD,
        observed: OBSERVED.UNKNOWN,
        reason: err.message,
        nonceAtF: null,
        bracket: intent.bracket ?? null,
      };
    }
    if (result.label === LABELS.HELD) {
      await keep(intent, result);
      return observe(intent.intentId, result.observed, result.reason);
    }
    try {
      if (await settle(intent, result)) return observations.delete(intent.intentId);
    } catch (err) {
      log.warn(`[IntentTracker] Could not settle intent ${intent.intentId}: ${err.message}`);
    }
    return false;
  }

  /**
   * Whether `view`, a held intent, is shown as Couldn't confirm: its label
   * unread for a day. `closable` once a verified read in this run showed
   * its nonce past N at a finalized block.
   */
  function couldntConfirm(view) {
    if (!view || view.state !== 'held') return null;
    const since = view.unreadSince ?? null;
    if (since === null || now() - since < couldntConfirmAfterMs) return null;
    return { since, closable: usedNonces.has(view.intentId) };
  }

  // Whether what Couldn't confirm shows changed for any held intent.
  function refreshShown(held) {
    let changed = false;
    const ids = new Set();
    for (const intent of held) {
      ids.add(intent.intentId);
      let view;
      try {
        view = store.get(intent.intentId);
      } catch {
        view = intent;
      }
      const state = couldntConfirm(view);
      const showing = state ? (state.closable ? 'closable' : 'shown') : null;
      if ((shown.get(intent.intentId) ?? null) !== showing) changed = true;
      if (showing) shown.set(intent.intentId, showing);
      else shown.delete(intent.intentId);
    }
    for (const id of shown.keys()) {
      if (!ids.has(id)) {
        shown.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  /** One pass over the held intents. Resolves when it is done. */
  async function pass() {
    if (passing) return passing;
    passing = (async () => {
      try {
        await store.ready;
        const held = heldNow();
        if (held.length === 0) return;
        if (!coreReady()) {
          scheduleAt(now() + schedule.coreDownMs);
          return;
        }
        // The small reads a chain's intents share (its finalized block, a
        // sender's nonce at a block) once per pass. Every other reply,
        // headers and blocks among them, is compacted as it resolves and
        // kept by no one but the read that asked for it (intent-labels.js).
        const memo = new Map();
        const read = (chainId, method, params, options) => {
          const fetch = () =>
            limitedRequest(chainId, method, params, options).then((reply) =>
              compactReply(method, params, reply)
            );
          const shared =
            method === 'eth_getTransactionCount' ||
            (method === 'eth_getBlockByNumber' && params[0] === 'finalized');
          if (!shared) return fetch();
          const key = JSON.stringify([chainId, method, params]);
          if (!memo.has(key)) memo.set(key, fetch());
          return memo.get(key);
        };
        // Chains in parallel; a chain's intents one after another, since
        // they share its verified headers (whose walks run in parallel,
        // within the read bound).
        const byChain = new Map();
        for (const intent of held) {
          if (!byChain.has(intent.chainId)) byChain.set(intent.chainId, []);
          byChain.get(intent.chainId).push(intent);
        }
        const changed = (
          await Promise.all(
            [...byChain.values()].map(async (intents) => {
              const results = [];
              for (const intent of intents) results.push(await check(intent, read));
              return results;
            })
          )
        ).flat();
        for (const id of observations.keys()) {
          if (!held.some((intent) => intent.intentId === id)) observations.delete(id);
        }
        for (const id of usedNonces.keys()) {
          if (!held.some((intent) => intent.intentId === id)) usedNonces.delete(id);
        }
        const shownChanged = refreshShown(heldNow());
        if (changed.some(Boolean) || shownChanged) emit();
      } finally {
        // Every pass, an empty one or one the core being down cut short
        // among them.
        releaseIdleSegments();
        passing = null;
        scheduleNext();
      }
    })();
    return passing;
  }

  return {
    /** Start: the first pass shortly, then as scheduled. */
    start() {
      if (started) return;
      started = true;
      unsubscribe = store.onChange(onStoreChange);
      scheduleAt(now() + schedule.startupMs);
    },

    stop() {
      started = false;
      unsubscribe?.();
      unsubscribe = null;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      dueAt = null;
    },

    pass,

    /** What the last pass saw of a held intent, or null. */
    observation(intentId) {
      const seen = observations.get(intentId);
      return seen ? { ...seen } : null;
    },

    couldntConfirm,

    /**
     * What closing a held intent by hand rests on: the finalized block
     * (`{ block, hash }`) where a verified read in this run showed its
     * nonce past N, while it is shown as Couldn't confirm. Null otherwise:
     * then it can't be closed.
     */
    closeEvidence(intentId) {
      let view;
      try {
        view = store.get(intentId);
      } catch {
        return null;
      }
      const state = couldntConfirm(view);
      return state?.closable ? { ...usedNonces.get(intentId) } : null;
    },

    /** How many verified headers are kept for a chain (0 once released). */
    verifiedHeaderCount(chainId) {
      return segments.get(chainId)?.headers.size ?? 0;
    },

    /** When the next pass is due (ms since the epoch), or null. */
    nextPassAt() {
      return dueAt;
    },

    /** Call `listener()` when what the reads saw changes. */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let defaultTracker = null;

/** The app's tracker, over the app's store and chain data. */
function getIntentTracker() {
  if (!defaultTracker) {
    const { getIntentStore } = require('./intent-store');
    const chainData = require('../networks/chain-data');
    const { recordSettlement } = require('./tx-recorder');
    defaultTracker = createIntentTracker({
      store: getIntentStore(),
      request: (...args) => chainData.request(...args),
      recordSettlement,
    });
  }
  return defaultTracker;
}

module.exports = {
  SCHEDULE,
  CONCURRENCY,
  COULDNT_CONFIRM_AFTER_MS,
  createIntentTracker,
  getIntentTracker,
};
