/**
 * Wallet intent records (freedom-core design 0005, "Retrying an intent").
 *
 * A payment the user confirms is an intent. Main signs it at one nonce and
 * never at another: a later signature of the intent is a replacement at that
 * nonce, and a retry sends the same bytes again. At most one transaction per
 * nonce can be mined, so nothing the wallet does can pay one intent twice.
 * This store is the durable record that keeps the rule across crashes and
 * restarts. Its lines, in `wallet-intents.jsonl` at the profile's Freedom
 * root (a durable journal of JSON Lines), which the identity core keeps
 * from PRF-6(b2) (freedom-core design 0013, "The intent journal"):
 *
 * - **commit**: a signed transaction of the intent, committed before its
 *   bytes go anywhere. Refused unless the bytes decode to the intent's
 *   chain, sender, nonce and hash. The first is the `original`; later ones
 *   are `replacement`s at the same nonce, paying the same thing.
 * - **handoff**: bytes of the intent about to go to a broadcaster, committed
 *   before they leave main.
 * - **outcome**: how one handoff ended: `sent`, `uncertain`, `rejected` or
 *   `not_sent` (design 0005, "Outcome"). Only the run of main that made the
 *   handoff can record it; a handoff whose outcome was lost (a crash, the
 *   core dying) stays possibly sent for good.
 * - **settle**: the intent's label at the finalized block: paid, failed or
 *   taken.
 * - **void**: the intent is dropped and its nonce freed. Allowed only under
 *   the account's reservation lock, for an intent created in this run of
 *   main, whose every handoff ended `not_sent` in this run, and that has the
 *   highest nonce of its account's held intents: no byte of it ever left
 *   main, and nothing above it waits for its nonce. An intent recovered from
 *   disk is never voided; a crash or a restored older copy of this file can
 *   hide a handoff.
 * - **retire**: the user closed an intent shown as *Couldn't confirm*
 *   (design 0005, "State history", #94), once a verified read showed its
 *   nonce used at a finalized block (`block`): none of its transactions can
 *   be mined. Under the account's reservation lock, as a void is, and
 *   conditional on the hashes the user saw. It closes the intent like a
 *   settlement, its bytes forgotten, and keeps its hashes, also in its
 *   tombstone: whether it paid is unconfirmed.
 * - **track**: what the finality tracker keeps of a held intent across
 *   restarts: its bracket (the last finalized block, number and hash, where
 *   a verified read saw its nonce unused) and since when its passes
 *   couldn't read a label (`unread_since`). Not owed: when there is no room
 *   even after compacting, it is refused, and the tracker keeps what it had.
 *
 * Every line carries the run of main that wrote it (RUN_ID, one per
 * process).
 *
 * An intent is held from its first commit until it settles, is voided or
 * is retired. Its nonce stays reserved while it is held: a new intent goes
 * above every held nonce of its account (nonce-reservations.js).
 *
 * **Compaction** (at startup, after a void, and when room is needed)
 * rewrites the file from the state, with two more line types:
 * - **held**: a held intent in one line: its latest signed bytes, every
 *   hash it was signed as, its context, and a summary of its finished
 *   handoffs (`count`, and `possibly_sent`, which sticks once a handoff
 *   ended other than `not_sent` or was open when its run ended). This run's
 *   open handoffs follow it as lines, so their outcomes still find them.
 *   Memory folds the finished ones the same way once the file has them, so
 *   neither grows with a long run of sends. Loading folds every handoff into
 *   the summary: an earlier run's handoff only ever counts as possibly sent.
 * - **tombstone**: a settled, voided or retired intent, without its bytes:
 *   its id, account, nonce and how it closed, and a retired one's hashes.
 *   Closed is final: a commit or a handoff of a closed id is refused, and a
 *   late outcome for it is ignored, across reloads and compactions. The newest LIMITS.tombstones are kept; an
 *   older id is unknown, so nothing can be sent for it either, and it can't
 *   come back: the store names every new intent itself.
 *
 * **Replay** (loading) checks every line against the same rules as a live
 * write: the bytes decode to the intent's chain, nonce and hash and are
 * signed by its sender; a new intent goes above its account's held nonces
 * and its key is unique among held intents; a closed intent takes nothing
 * more. A file breaking any of them is damaged.
 *
 * - **Separate from payment history**, which the user can clear: neither
 *   clearing it nor deleting the vault touches this file.
 * - **A damaged file** is moved aside as `<file>.corrupt-<ts>` (the core
 *   logs why), and the store starts empty, as after a restore. A missing
 *   file is a restore too: nothing to send again.
 * - **Bounds** (LIMITS): held intents per account and in all; replacements
 *   per intent; open handoffs per intent; and the file's size, admitted so
 *   that the outcomes and terminal lines still owed always fit (see
 *   `budget`). A new intent past any bound is refused; recorded state never
 *   is.
 * - **Signed bytes, never keys.** Records are mode 0600 and never logged.
 *
 * **This module is main's adapter** to the core's `intents.*` (the core's
 * port of the store at freedom-core's STORES_REFERENCE_COMMIT, which
 * test/helpers/reference-intent-store.js keeps). Main names `intents` in
 * every hello's `store_moved` (core-client.js), so the core is the file's
 * one writer, and each request goes only to a core whose hello echoed the
 * name (`requires`, vault-backend.js): on an older core every operation
 * fails `requirement_unmet`, and nothing is written. Main writes, renames
 * and opens no `wallet-intents.jsonl*` itself.
 *
 * - **Writes are serialized here**, one request at a time in the order
 *   they were made, and `onChange` listeners run after each one the core
 *   answered (but `track`'s), as the store's did.
 * - **Every line carries main's run** (`RUN_ID`, one per process), passed
 *   as `run`: a core restart within one run of main keeps it. The core
 *   reloads the file when it restarts, though, so every held intent is then
 *   recovered: none can be voided until a new one is committed, and their
 *   open handoffs stay possibly sent (design 0013, `intents-core-restart`).
 * - **The account lock stays main's** until 0012's APR-6: `void` and
 *   `retire` check `holdsAccountLock` here, for the intent's own account
 *   (`intents.get`), and only then send `lock: true`.
 * - **A lost reply** (`core_unavailable`: the core died or hung with the
 *   request written) leaves the write's outcome unknown. It is never sent
 *   again: the error goes to the caller, so nothing is broadcast for a
 *   commit or a handoff whose answer didn't come back, and once a core
 *   answers again the listeners hear of the intent (read again with
 *   `intents.get`, or found among the held ones for a lost original's
 *   commit), so a commit that did land shows as held, for the user to send
 *   again.
 */

const crypto = require('crypto');
const log = require('../logger');
const { holdsAccountLock } = require('./nonce-reservations');

const FILE_NAME = 'wallet-intents.jsonl';
// The store's bounds, which the core keeps as the reference's (design 0013,
// "Bounds"); main's callers read them, and they size nothing here.
const LIMITS = Object.freeze({
  heldPerAccount: 32,
  held: 256,
  // Fee bumps of one intent. Also bounds the signatures reload recovers:
  // held × hashesPerIntent, about 2.3 ms each.
  hashesPerIntent: 8,
  // Handoffs of one intent awaiting their outcome; finished ones only count.
  openHandoffsPerIntent: 8,
  tombstones: 1024,
  // geth's txpool refuses anything larger (txMaxSize).
  rawBytes: 128 * 1024,
  // The file never exceeds this: see `budget`.
  journalBytes: 8 * 1024 * 1024,
  // Above the largest file the store can write (journalBytes), so its own
  // file is never refused as too large; see the arithmetic test.
  readBytes: 16 * 1024 * 1024,
});
// This run of main. Lines it writes carry it; an intent whose lines don't
// all carry it can never be voided.
// This run of main. Lines the core writes for it carry it; an intent whose
// lines don't all carry it can never be voided.
const RUN_ID = crypto.randomUUID();

const CORE_UNAVAILABLE = 'core_unavailable';

function intentError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Why a closed intent takes nothing more, for the user.
function closedText(state) {
  if (state === 'voided') return 'This payment was voided.';
  if (state === 'retired') return 'This payment was closed.';
  return 'This payment is already settled.';
}

/** `context` as the wire takes it: `wallet_index`, snake_case. */
function wireContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return context;
  const { walletIndex, wallet_index: snake, ...rest } = context;
  const index = snake ?? walletIndex;
  return index === undefined ? rest : { ...rest, wallet_index: index };
}

/** A cosmetic text the core keeps if it is one, null otherwise: never a refusal. */
const textOrNull = (value) => (typeof value === 'string' ? value : null);

/**
 * @param {object} [options]
 * @param {object} [options.backend] the core's `intents.*`
 *   (vault-backend.js's `vaultBackend.intents`), by default
 */
function createIntentStore({
  backend = require('../core/vault-backend').vaultBackend.intents,
} = {}) {
  let loading = null;
  let queue = Promise.resolve();

  // One write at a time, in the order they were made.
  function serialize(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  /**
   * The core up, with the store loaded: its first `intents.usage` loads the
   * file (a damaged one set aside, the file compacted). Idempotent; a
   * failed load is tried again by the next call.
   */
  function load() {
    if (!loading) {
      loading = backend.usage().then(
        () => {
          log.info('[IntentStore] Wallet intent records loaded by the identity core');
        },
        (error) => {
          loading = null;
          log.error(`[IntentStore] Could not load wallet intent records: ${error.message}`);
          throw error;
        }
      );
    }
    return loading;
  }

  // Who wants to know the records changed (a UI listing held intents).
  const listeners = new Set();

  function notify(intentId) {
    for (const listener of listeners) {
      try {
        listener(intentId);
      } catch (error) {
        log.warn(`[IntentStore] A change listener failed: ${error.message}`);
      }
    }
  }

  /**
   * After a lost reply: once a core answers again, the intent the write
   * named (or, for an original's commit, the held intent at its account
   * and nonce with its hash, if it landed) is announced, so the listeners
   * read it again. The write itself is never sent again.
   */
  async function afterLostReply(method, params) {
    log.warn(`[IntentStore] The identity core's answer to ${method} was lost; reading again`);
    try {
      await backend.usage();
      let intentId = params.intent_id ?? null;
      if (!intentId && method === 'commit') {
        const { intents } = await backend.held();
        intentId =
          intents.find(
            (intent) =>
              intent.chainId === params.chain_id &&
              intent.sender === String(params.sender).toLowerCase() &&
              intent.nonce === params.nonce &&
              intent.hashes.some((entry) => entry.hash === String(params.hash).toLowerCase())
          )?.intentId ?? null;
      }
      if (intentId) notify(intentId);
    } catch (error) {
      log.warn(`[IntentStore] Could not read the records again: ${error.message}`);
    }
  }

  /**
   * A write through the core, in line with the others: `method` with
   * `params` (`run` added for a line), then the listeners, unless `quiet`.
   * `before` runs first in the same turn of the queue (the lock check).
   */
  async function write(method, params, { line = true, quiet = false, before = null } = {}) {
    await load();
    return serialize(async () => {
      const sent = line ? { run: RUN_ID, ...params } : params;
      if (before) await before(sent);
      let answer;
      try {
        answer = await backend[method](sent);
      } catch (error) {
        if (error?.code === CORE_UNAVAILABLE) afterLostReply(method, sent);
        throw error;
      }
      if (!quiet) notify(sent.intent_id ?? answer?.intent?.intentId ?? null);
      return answer;
    });
  }

  /**
   * `void`'s and `retire`'s lock: main's own (nonce-reservations.js), for
   * the account of the intent as the core has it. An unknown intent goes
   * with `lock: false`, which the core refuses `INTENT_UNKNOWN` first.
   */
  function lockedBy(lock, message) {
    return async (sent) => {
      const { intent } = await backend.get({ intent_id: sent.intent_id });
      if (intent && !holdsAccountLock(lock, intent.chainId, intent.sender)) {
        throw intentError('INTENT_LOCK_REQUIRED', message);
      }
      sent.lock = intent !== null;
    };
  }

  return {
    load,

    /**
     * Call `listener(intentId)` after every change written to the records,
     * but the tracker's own (`track`): it changes nothing a listener shows,
     * and the tracker announces what its reads saw itself. Returns a
     * function that stops it.
     */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Settles once the core has the records loaded (and starts loading them). */
    get ready() {
      return load();
    },

    /**
     * Commit a signed transaction of an intent: its first (`via:
     * 'original'`, with its `context`) or a replacement at its nonce.
     * Resolves once the core has the record on disk, with the intent; only
     * then may the bytes go to a broadcaster (after a handoff). A failure,
     * a lost reply included, sends nothing.
     *
     * The store names a new intent itself (a random UUID, in the result's
     * `intentId`), so no caller can bring back an id that was closed, even
     * after its tombstone is gone. A replacement names a held intent.
     *
     * @param {object} commit
     * @param {string} [commit.intentId] a replacement's intent; none for an original
     * @param {number} commit.chainId
     * @param {string} commit.sender
     * @param {number} commit.nonce
     * @param {string} commit.hash
     * @param {string} commit.raw the signed transaction
     * @param {'original'|'replacement'} commit.via
     * @param {{ kind: string, origin?: string, key?: string, walletIndex?: number }} [commit.context]
     */
    async commit({ intentId, chainId, sender, nonce, hash, raw, via, context }) {
      const params = { chain_id: chainId, sender, nonce, hash, raw, via };
      if (intentId !== undefined) params.intent_id = intentId;
      if (context !== undefined) params.context = wireContext(context);
      return (await write('commit', params)).intent;
    },

    /**
     * Record that bytes of the intent are about to go to a broadcaster. Send
     * them only once this resolves, and record the outcome against the
     * handoff it returns. Refused for a closed intent; the core's writes
     * are serialized, so a void and a handoff can't both pass.
     *
     * @param {string} intentId
     * @param {string} [hash] which committed transaction; the latest by default
     * @returns {Promise<{ handoffId: string, hash: string, raw: string }>}
     */
    async handoff(intentId, hash) {
      const params = { intent_id: intentId };
      if (typeof hash === 'string') params.hash = hash;
      return (await write('handoff', params)).handoff;
    },

    /**
     * Record how a handoff ended. Never refused for space. An outcome the
     * store no longer owes is ignored, nothing written: the intent as it
     * is then (null for a forgotten one).
     *
     * @param {object} result
     * @param {string} result.intentId
     * @param {string} result.handoffId
     * @param {'sent'|'uncertain'|'rejected'|'not_sent'} result.outcome
     * @param {string} [result.source]
     * @param {string} [result.reasonClass]
     */
    async outcome({ intentId, handoffId, outcome, source, reasonClass }) {
      const answer = await write('outcome', {
        intent_id: intentId,
        handoff_id: handoffId,
        outcome,
        source: textOrNull(source),
        reason_class: textOrNull(reasonClass),
      });
      return answer.intent;
    },

    /**
     * Record the intent's label at the finalized block. It is no longer
     * held, and its bytes are forgotten.
     *
     * @param {object} settlement
     * @param {string} settlement.intentId
     * @param {'paid'|'failed'|'taken'} settlement.label
     * @param {string|null} settlement.hash the included transaction (paid,
     *   failed); null when taken
     * @param {number} settlement.block the finalized block it was read at
     * @param {string[]} [settlement.hashes] the intent's hashes the label
     *   was read for: if it has others by the time the settlement is
     *   written (a replacement committed meanwhile), nothing is written and
     *   this throws INTENT_CHANGED; read it again
     */
    async settle({ intentId, label, hash, block, hashes = null }) {
      const answer = await write('settle', {
        intent_id: intentId,
        label,
        hash: hash ?? null,
        block,
        hashes,
      });
      return answer.intent;
    },

    /**
     * Void an intent: final, its nonce freed and its bytes forgotten. Only
     * under the account's lock: pass the token `withAccountLock` gave you.
     *
     * @param {string} intentId
     * @param {object} lock
     */
    async void(intentId, lock) {
      const answer = await write(
        'void',
        { intent_id: intentId },
        { before: lockedBy(lock, "Voiding a payment needs its account's reservation lock.") }
      );
      return answer.intent;
    },

    /**
     * Close a held intent by hand (design 0005, "State history"): final,
     * its bytes forgotten, its hashes kept. Only under the account's lock
     * (the token `withAccountLock` gave you), and only for the hashes the
     * user saw: if the intent has others by the time this is written (a
     * replacement, even one still being written), nothing is written and
     * this throws INTENT_CHANGED. The caller checks that a verified read
     * showed the intent's nonce used at the finalized block `block`.
     *
     * @param {object} retirement
     * @param {string} retirement.intentId
     * @param {number} retirement.block
     * @param {string[]} retirement.hashes
     * @param {object} lock
     */
    async retire({ intentId, block, hashes }, lock) {
      if (!Array.isArray(hashes) || hashes.length === 0) {
        throw intentError(
          'INTENT_INVALID',
          'Invalid wallet intent record: closing a payment names the hashes the user saw'
        );
      }
      const answer = await write(
        'retire',
        { intent_id: intentId, block, hashes },
        { before: lockedBy(lock, "Closing a payment needs its account's reservation lock.") }
      );
      return answer.intent;
    },

    /**
     * Keep the finality tracker's state of a held intent: its bracket
     * (`{ number, hash }` or null) and since when its label couldn't be
     * read (ms, or null). Refused for an intent no longer held, and, when
     * there is no room even after compacting, with INTENT_STORE_FULL.
     */
    async track({ intentId, bracket = null, unreadSince = null }) {
      const answer = await write(
        'track',
        { intent_id: intentId, bracket, unread_since: unreadSince },
        { quiet: true }
      );
      return answer.intent;
    },

    /**
     * Withdraw the site a held intent was recorded for (freedom-core design
     * 0011, PRQ-5b: a site's Safe execution that its site no longer holds is
     * the wallet's own). Its context keeps its kind, key and account, with no
     * origin; its signed bytes, hashes and handoffs stay. The core rewrites
     * the file from the state, so the change outlives this run; if it
     * can't, the intent is left as it was and the error thrown.
     *
     * @returns {Promise<boolean>} false for an intent not held, or with no site
     */
    async withdrawOrigin(intentId) {
      const answer = await write(
        'withdrawOrigin',
        { intent_id: intentId },
        { line: false, quiet: true }
      );
      if (answer.withdrawn) notify(intentId);
      return answer.withdrawn;
    },

    /** Rewrite the file from the state: tombstones and held snapshots. */
    async compact() {
      await write('compact', {}, { line: false, quiet: true });
    },

    // The reads answer the core's state when it reads them, outside main's
    // write queue, so the caller resumes with what was true then: a write
    // may land in between. A caller that reads and then writes keeps its
    // guarantee where it already did: under the account's lock
    // (nonce-reservations.js), or with a condition the core checks in line
    // with its other writes (settle's and retire's hashes; a held intent
    // for handoff and commit).

    /** Why the intent can't be voided by this run now, or null if it can (lock aside). */
    async voidRefusal(intentId) {
      return (await backend.voidRefusal({ intent_id: intentId, run: RUN_ID })).refusal;
    },

    /**
     * How full the records are, in bytes: the file, what is owed to it, the
     * budget new intents are admitted against, and the limit.
     */
    async usage() {
      return (await backend.usage()).usage;
    },

    /** One intent, or null. */
    async get(intentId) {
      return (await backend.get({ intent_id: intentId })).intent;
    },

    /** The held intent whose context has this key, or null. */
    async byKey(key) {
      return (await backend.byKey({ key })).intent;
    },

    /** Held intents, by account and nonce. */
    async held() {
      return (await backend.held()).intents;
    },

    /** Every intent the core's store knows: held ones, and the kept closed ones. */
    async list() {
      return (await backend.list()).intents;
    },

    /** The nonces the account's held intents have, ascending. */
    async heldNonces(chainId, sender) {
      return (await backend.heldNonces({ chain_id: chainId, sender })).nonces;
    },
  };
}

let defaultStore = null;

/** The profile's intent store: the identity core's, through vault-backend.js. */
function getIntentStore() {
  if (!defaultStore) defaultStore = createIntentStore();
  return defaultStore;
}

module.exports = {
  FILE_NAME,
  LIMITS,
  RUN_ID,
  closedText,
  createIntentStore,
  getIntentStore,
};
