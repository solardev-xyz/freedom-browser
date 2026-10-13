/**
 * Wallet intent records (freedom-core design 0005, "Retrying an intent").
 *
 * A payment the user confirms is an intent. Main signs it at one nonce and
 * never at another: a later signature of the intent is a replacement at that
 * nonce, and a retry sends the same bytes again. At most one transaction per
 * nonce can be mined, so nothing the wallet does can pay one intent twice.
 * This store is the durable record that keeps the rule across crashes and
 * restarts. Its lines, in `wallet-intents.jsonl` under the profile's
 * userData (a durable journal, lib/durable-journal.js):
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
 *   hide a handoff. Void is final: send-again and replacements refuse it.
 *
 * Every line carries the run of main that wrote it (RUN_ID, one per
 * process).
 *
 * An intent is held from its first commit until it settles or is voided.
 * Its nonce stays reserved while it is held: a new intent goes above every
 * held nonce of its account (nonce-reservations.js). A settled or voided
 * intent's bytes are forgotten, in memory at once and on disk at the next
 * compaction: at startup, after a void, or when the file is full.
 *
 * - **Separate from payment history**, which the user can clear: neither
 *   clearing it nor deleting the vault touches this file.
 * - **A damaged file** (a bad line, or a line breaking these rules) is moved
 *   aside as `<file>.corrupt-<ts>`, and the store starts empty, as after a
 *   restore; `quarantined` says so, for a notice. A missing file is a
 *   restore too: nothing to send again.
 * - **Bounds:** LIMITS.heldPerAccount held intents per account and
 *   LIMITS.journalBytes in the file; a new intent past either is refused.
 * - **Signed bytes, never keys.** Records are mode 0600 and never logged.
 */

const crypto = require('crypto');
const path = require('path');
const { app } = require('electron');
const { Transaction, keccak256 } = require('ethers');
const log = require('../logger');
const { createJournal, encodeLine } = require('../lib/durable-journal');
const { holdsAccountLock } = require('./nonce-reservations');

const FILE_NAME = 'wallet-intents.jsonl';
const LIMITS = Object.freeze({
  heldPerAccount: 32,
  journalBytes: 8 * 1024 * 1024,
  // geth's txpool refuses anything larger (txMaxSize).
  rawBytes: 128 * 1024,
  handoffsPerIntent: 64,
  // A file this large is not one this store wrote.
  readBytes: 64 * 1024 * 1024,
});
// This run of main. Lines it writes carry it; an intent whose lines don't
// all carry it can never be voided.
const RUN_ID = crypto.randomUUID();

const OUTCOMES = new Set(['sent', 'uncertain', 'rejected', 'not_sent']);
const LABELS = new Set(['paid', 'failed', 'taken']);
const TRANSACTION_TYPES = new Set([0, 2]);
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const HEX_PATTERN = /^0x(?:[0-9a-f]{2})*$/;
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const TEXT_LIMITS = { origin: 2048, key: 256, source: 64, reason_class: 128 };

const LIVE = Object.freeze({ live: true });
const LOADING = Object.freeze({ live: false });

function intentError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

// Messages name ids and numbers only: never bytes, fields or origins.
function invalid(detail) {
  return intentError('INTENT_INVALID', `Invalid wallet intent record: ${detail}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireId(value, what) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw invalid(`bad ${what}`);
  return value;
}

function requireChainId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid('bad chain id');
  return value;
}

function requireCount(value, what) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`bad ${what}`);
  return value;
}

function requireHex(value, pattern, what) {
  const lower = typeof value === 'string' ? value.toLowerCase() : null;
  if (!lower || !pattern.test(lower)) throw invalid(`bad ${what}`);
  return lower;
}

function optionalText(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > TEXT_LIMITS[name]) {
    throw invalid(`bad ${name}`);
  }
  return value;
}

function normalizeContext(context) {
  if (!isPlainObject(context)) throw invalid('an original commit needs its context');
  if (typeof context.kind !== 'string' || !KIND_PATTERN.test(context.kind)) {
    throw invalid('bad context kind');
  }
  const walletIndex = context.wallet_index ?? context.walletIndex ?? null;
  if (walletIndex !== null) requireCount(walletIndex, 'wallet index');
  return {
    kind: context.kind,
    origin: optionalText(context.origin, 'origin'),
    key: optionalText(context.key, 'key'),
    wallet_index: walletIndex,
  };
}

// The unsigned fields of a signed transaction, as stored.
function fieldsOf(tx) {
  return {
    type: tx.type,
    to: tx.to ? tx.to.toLowerCase() : null,
    value: tx.value.toString(),
    data: tx.data,
    gas_limit: tx.gasLimit.toString(),
    max_fee_per_gas: tx.type === 2 ? tx.maxFeePerGas.toString() : null,
    max_priority_fee_per_gas: tx.type === 2 ? tx.maxPriorityFeePerGas.toString() : null,
    gas_price: tx.type === 0 ? tx.gasPrice.toString() : null,
  };
}

/**
 * Decode `raw` and check that it is the intent's: signed, canonical, at its
 * nonce, for its chain, hashing to its hash and, when `recover` is set,
 * signed by its sender. Loading skips the signature recovery: the checksum
 * covers the bytes, and they were checked when committed.
 */
function verifySigned({ raw, chainId, sender, nonce, hash }, { recover }) {
  let tx;
  try {
    tx = Transaction.from(raw);
  } catch {
    throw invalid('the signed transaction does not decode');
  }
  if (!tx.signature) throw invalid('the transaction is not signed');
  if (!TRANSACTION_TYPES.has(tx.type))
    throw invalid(`transaction type ${tx.type} is not supported`);
  if (tx.serialized !== raw) throw invalid('the transaction is not canonically encoded');
  if (tx.nonce !== nonce)
    throw invalid(`the transaction is signed at nonce ${tx.nonce}, not ${nonce}`);
  if (tx.chainId !== BigInt(chainId)) {
    throw invalid(`the transaction is signed for chain ${tx.chainId}, not ${chainId}`);
  }
  if (keccak256(raw) !== hash) throw invalid("the transaction does not hash to the intent's hash");
  if (recover) {
    let from;
    try {
      from = tx.from?.toLowerCase();
    } catch {
      from = null;
    }
    if (from !== sender) throw invalid("the transaction is not signed by the intent's sender");
  }
  return tx;
}

function sameAccount(a, b) {
  return a.chainId === b.chainId && a.sender === b.sender;
}

function camelFields(fields) {
  return {
    type: fields.type,
    to: fields.to,
    value: fields.value,
    data: fields.data,
    gasLimit: fields.gas_limit,
    maxFeePerGas: fields.max_fee_per_gas,
    maxPriorityFeePerGas: fields.max_priority_fee_per_gas,
    gasPrice: fields.gas_price,
  };
}

// A copy for callers, in camelCase.
function view(intent) {
  const latest = intent.hashes[intent.hashes.length - 1];
  const original = intent.hashes[0];
  return {
    intentId: intent.id,
    chainId: intent.chainId,
    sender: intent.sender,
    nonce: intent.nonce,
    state: intent.state,
    recovered: intent.recovered,
    context: {
      kind: intent.context.kind,
      origin: intent.context.origin,
      key: intent.context.key,
      walletIndex: intent.context.wallet_index,
    },
    hash: latest.hash,
    raw: latest.raw,
    fields: original.fields ? camelFields(original.fields) : null,
    hashes: intent.hashes.map((entry) => ({
      hash: entry.hash,
      raw: entry.raw,
      via: entry.via,
      at: entry.at,
    })),
    handoffs: [...intent.handoffs.values()].map((handoff) => ({
      handoffId: handoff.id,
      hash: handoff.hash,
      at: handoff.at,
      outcome: handoff.outcome && {
        outcome: handoff.outcome.outcome,
        source: handoff.outcome.source,
        reasonClass: handoff.outcome.reason_class,
        at: handoff.outcome.at,
      },
    })),
    settlement: intent.settlement && { ...intent.settlement },
    voidedAt: intent.voidedAt,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  };
}

/**
 * @param {object} options
 * @param {string} options.filePath
 * @param {() => number} [options.now]
 * @param {Partial<typeof LIMITS>} [options.limits]
 */
function createIntentStore({ filePath, now = Date.now, limits: overrides = {} }) {
  const limits = { ...LIMITS, ...overrides };
  const journal = createJournal(filePath, { maxBytes: limits.readBytes });
  let intents = new Map();
  let sequence = 0;
  let loaded = false;
  let loading = null;
  let quarantined = null;
  let queue = Promise.resolve();

  // One write at a time: each checks the state, appends and applies before
  // the next one looks.
  function serialize(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  function assertLoaded() {
    if (!loaded) {
      throw intentError('INTENT_STORE_UNAVAILABLE', "The wallet's payment records are not loaded.");
    }
  }

  function heldOf(account) {
    return [...intents.values()].filter(
      (intent) => intent.state === 'held' && sameAccount(intent, account)
    );
  }

  function requireIntent(id) {
    const intent = intents.get(id);
    if (!intent) throw intentError('INTENT_UNKNOWN', `Unknown wallet intent ${id}`);
    return intent;
  }

  function requireHeld(intent, mode) {
    if (intent.state === 'held') return;
    if (!mode.live) throw invalid(`intent ${intent.id} is ${intent.state}`);
    throw intentError(
      'INTENT_NOT_HELD',
      intent.state === 'voided' ? 'This payment was voided.' : 'This payment is already settled.'
    );
  }

  function requireRun(record) {
    return requireId(record.run, 'run');
  }

  function remember(intent, record) {
    sequence += 1;
    intent.records.push({ sequence, record });
    intent.updatedAt = record.at;
  }

  // Settled or voided: keep what it was, forget the bytes.
  function close(intent) {
    for (const entry of intent.hashes) {
      entry.raw = null;
      entry.fields = null;
    }
    intent.records = [];
  }

  // Each `prepare*` checks a record against the state and returns the
  // function that applies it. Loading applies at once; a write applies only
  // once its line is on disk.

  function prepareCommit(record, mode) {
    const id = requireId(record.intent_id, 'intent id');
    const run = requireRun(record);
    const chainId = requireChainId(record.chain_id);
    const sender = requireHex(record.sender, ADDRESS_PATTERN, 'sender');
    const nonce = requireCount(record.nonce, 'nonce');
    const hash = requireHex(record.hash, HASH_PATTERN, 'hash');
    const raw = requireHex(record.raw, HEX_PATTERN, 'signed transaction');
    if (mode.live && (raw.length - 2) / 2 > limits.rawBytes) {
      throw intentError('INTENT_TOO_LARGE', 'This transaction is too large to send.');
    }
    const tx = verifySigned({ raw, chainId, sender, nonce, hash }, { recover: mode.live });
    const fields = fieldsOf(tx);
    if (!mode.live && JSON.stringify(record.fields) !== JSON.stringify(fields)) {
      throw invalid(`the fields of ${hash} do not match its transaction`);
    }
    const entry = { hash, raw, via: record.via, fields, at: record.at, run };
    const existing = intents.get(id);

    if (record.via === 'original') {
      if (existing) throw invalid(`intent ${id} is already committed`);
      const context = normalizeContext(record.context);
      if (mode.live) checkNewIntent({ chainId, sender, nonce, context });
      return () => {
        const intent = {
          id,
          chainId,
          sender,
          nonce,
          context,
          run,
          recovered: !mode.live,
          state: 'held',
          hashes: [entry],
          handoffs: new Map(),
          settlement: null,
          voidedAt: null,
          createdAt: record.at,
          updatedAt: record.at,
          // Its lines, while the file has them.
          records: [],
          inFile: true,
        };
        intents.set(id, intent);
        remember(intent, record);
      };
    }

    if (record.via !== 'replacement') throw invalid('bad via');
    if (!existing) throw invalid(`a replacement for unknown intent ${id}`);
    requireHeld(existing, mode);
    if (existing.chainId !== chainId || existing.sender !== sender || existing.nonce !== nonce) {
      // The rule itself: one nonce per intent, for good.
      throw invalid(`a replacement of intent ${id} must keep its chain, sender and nonce`);
    }
    if (existing.hashes.some((known) => known.hash === hash)) {
      throw invalid(`${hash} is already committed to intent ${id}`);
    }
    const original = existing.hashes[0].fields;
    if (
      fields.to !== original.to ||
      fields.value !== original.value ||
      fields.data !== original.data
    ) {
      throw invalid(`a replacement of intent ${id} must pay what the original pays`);
    }
    return () => {
      existing.hashes.push(entry);
      remember(existing, record);
    };
  }

  // Live only: what a new intent must not collide with.
  function checkNewIntent({ chainId, sender, nonce, context }) {
    const held = heldOf({ chainId, sender });
    if (held.length >= limits.heldPerAccount) {
      throw intentError(
        'INTENT_ACCOUNT_LIMIT',
        `This account already has ${held.length} payments waiting to confirm. ` +
          'Wait for some of them before sending another.'
      );
    }
    const highest = held.reduce((max, intent) => Math.max(max, intent.nonce), -1);
    if (nonce <= highest) {
      throw invalid(`nonce ${nonce} is not above the account's held nonce ${highest}`);
    }
    const sameKey = (intent) => intent.state === 'held' && intent.context.key === context.key;
    if (context.key && [...intents.values()].some(sameKey)) {
      throw invalid('another held intent has the same key');
    }
  }

  function prepareHandoff(record, mode) {
    const intent = requireIntent(requireId(record.intent_id, 'intent id'));
    const run = requireRun(record);
    const handoffId = requireId(record.handoff_id, 'handoff id');
    const hash = requireHex(record.hash, HASH_PATTERN, 'hash');
    requireHeld(intent, mode);
    if (!intent.hashes.some((entry) => entry.hash === hash)) {
      throw invalid(`${hash} is not committed to intent ${intent.id}`);
    }
    if (intent.handoffs.has(handoffId)) throw invalid(`handoff ${handoffId} is already recorded`);
    if (mode.live && intent.handoffs.size >= limits.handoffsPerIntent) {
      throw intentError(
        'INTENT_HANDOFF_LIMIT',
        'This payment has been sent too many times. Wait for it to confirm.'
      );
    }
    return () => {
      intent.handoffs.set(handoffId, { id: handoffId, hash, at: record.at, run, outcome: null });
      remember(intent, record);
    };
  }

  function prepareOutcome(record, mode) {
    const intent = requireIntent(requireId(record.intent_id, 'intent id'));
    const run = requireRun(record);
    const handoff = intent.handoffs.get(requireId(record.handoff_id, 'handoff id'));
    if (!handoff) throw invalid(`unknown handoff ${record.handoff_id}`);
    if (intent.state === 'voided') requireHeld(intent, mode);
    if (handoff.hash !== requireHex(record.hash, HASH_PATTERN, 'hash')) {
      throw invalid(`handoff ${handoff.id} was of another hash`);
    }
    if (handoff.outcome) throw invalid(`handoff ${handoff.id} already has its outcome`);
    if (handoff.run !== run) {
      // Its reply was lost with the run that made it: possibly sent, for good.
      throw invalid(`handoff ${handoff.id} was made by an earlier run of main`);
    }
    if (!OUTCOMES.has(record.outcome)) throw invalid('bad outcome');
    const outcome = {
      outcome: record.outcome,
      source: optionalText(record.source, 'source'),
      reason_class: optionalText(record.reason_class, 'reason_class'),
      at: record.at,
      run,
    };
    return () => {
      handoff.outcome = outcome;
      remember(intent, record);
    };
  }

  function prepareSettle(record, mode) {
    const intent = requireIntent(requireId(record.intent_id, 'intent id'));
    requireRun(record);
    requireHeld(intent, mode);
    if (!LABELS.has(record.label)) throw invalid('bad label');
    let hash = null;
    if (record.label === 'taken') {
      if (record.hash !== null && record.hash !== undefined) {
        throw invalid('a taken intent has no transaction of its own');
      }
    } else {
      hash = requireHex(record.hash, HASH_PATTERN, 'hash');
      if (!intent.hashes.some((entry) => entry.hash === hash)) {
        throw invalid(`${hash} is not committed to intent ${intent.id}`);
      }
    }
    const block = requireCount(record.block, 'block');
    return () => {
      intent.state = 'settled';
      intent.settlement = { label: record.label, hash, block, at: record.at };
      intent.updatedAt = record.at;
      close(intent);
    };
  }

  /**
   * Why the intent can't be voided by a void of `run`, or null.
   * Live, `run` is this one, and an intent read from disk never qualifies.
   */
  function voidRefusal(intent, run, mode) {
    if (intent.state !== 'held') return `it is ${intent.state}`;
    if (mode.live && intent.recovered)
      return 'it was recovered from disk, where a handoff may be missing';
    const handoffs = [...intent.handoffs.values()];
    const inRun =
      intent.run === run &&
      intent.hashes.every((entry) => entry.run === run) &&
      handoffs.every(
        (handoff) => handoff.run === run && (!handoff.outcome || handoff.outcome.run === run)
      );
    if (!inRun) return 'not all of it happened in this run of main';
    for (const handoff of handoffs) {
      if (!handoff.outcome) return 'a handoff has no recorded outcome, so it may have been sent';
      if (handoff.outcome.outcome !== 'not_sent') {
        return `a handoff ended ${handoff.outcome.outcome}, so it may have been sent`;
      }
    }
    const above = heldOf(intent).find((other) => other !== intent && other.nonce > intent.nonce);
    if (above) return `held intent ${above.id} has a higher nonce`;
    return null;
  }

  function prepareVoid(record, mode, lock) {
    const intent = requireIntent(requireId(record.intent_id, 'intent id'));
    const run = requireRun(record);
    if (mode.live && !holdsAccountLock(lock, intent.chainId, intent.sender)) {
      throw intentError(
        'INTENT_LOCK_REQUIRED',
        "Voiding a payment needs its account's reservation lock."
      );
    }
    requireHeld(intent, mode);
    const refusal = voidRefusal(intent, run, mode);
    if (refusal) {
      if (!mode.live) throw invalid(`void of intent ${intent.id}: ${refusal}`);
      throw intentError('INTENT_VOID_REFUSED', `This payment can't be voided: ${refusal}.`);
    }
    return () => {
      intent.state = 'voided';
      intent.voidedAt = record.at;
      intent.updatedAt = record.at;
      close(intent);
    };
  }

  const PREPARE = {
    commit: prepareCommit,
    handoff: prepareHandoff,
    outcome: prepareOutcome,
    settle: prepareSettle,
    void: prepareVoid,
  };

  function prepare(record, mode, lock) {
    const prepareType = Object.hasOwn(PREPARE, record.type) ? PREPARE[record.type] : null;
    if (!prepareType) throw invalid('unknown record type');
    if (!Number.isSafeInteger(record.at) || record.at < 0) throw invalid('bad time');
    return prepareType(record, mode, lock);
  }

  // Held intents' lines, in their original order: a subset of the file, so
  // the old file, if a crash keeps it, still says the same.
  async function compactNow() {
    const kept = [...intents.values()]
      .filter((intent) => intent.state === 'held')
      .flatMap((intent) => intent.records)
      .sort((a, b) => a.sequence - b.sequence)
      .map((entry) => entry.record);
    await journal.compact(kept);
    // Closed intents stay in memory for this run, without their bytes, so a
    // voided one stays voided.
    for (const intent of intents.values()) {
      if (intent.state !== 'held') intent.inFile = false;
    }
  }

  async function compactQuietly(why) {
    try {
      await compactNow();
    } catch (error) {
      log.warn(`[IntentStore] Compaction ${why} failed: ${error.message}`);
    }
  }

  // Whether compaction would drop anything.
  function hasClosed() {
    return [...intents.values()].some((intent) => intent.state !== 'held' && intent.inFile);
  }

  async function quarantine(reason) {
    intents = new Map();
    const at = now();
    const movedTo = await journal.moveAside(`corrupt-${at}`);
    quarantined = { path: movedTo, at, reason };
    log.error(
      `[IntentStore] Wallet intent records were damaged (${reason}); moved to ${movedTo} ` +
        'and starting empty'
    );
  }

  async function doLoad() {
    let result = null;
    let damage = null;
    try {
      result = await journal.open();
    } catch (error) {
      if (error.code !== 'JOURNAL_TOO_LARGE' && error.code !== 'JOURNAL_NOT_A_FILE') throw error;
      damage = error.code === 'JOURNAL_TOO_LARGE' ? 'the file is too large' : 'not a regular file';
    }
    if (result?.corrupt.length > 0) {
      damage = `${result.corrupt.length} damaged line(s), the first at line ${result.corrupt[0].line}`;
    }
    if (!damage) {
      try {
        for (const record of result.records) prepare(record, LOADING)();
      } catch (error) {
        damage = error.message;
      }
    }
    if (damage) {
      await quarantine(damage);
    } else {
      if (result.tornTail > 0) {
        log.warn(`[IntentStore] Dropped an unfinished last line (${result.tornTail} bytes)`);
      }
      if (hasClosed()) await compactQuietly('at startup');
    }
    loaded = true;
    const held = [...intents.values()].filter((intent) => intent.state === 'held').length;
    log.info(`[IntentStore] Loaded ${held} held wallet intent(s)`);
  }

  /**
   * Read the file, check it and compact it. Idempotent; a failed load is
   * tried again by the next call.
   */
  function load() {
    if (!loading) {
      loading = serialize(doLoad).catch((error) => {
        loading = null;
        intents = new Map();
        log.error(`[IntentStore] Could not load wallet intent records: ${error.message}`);
        throw intentError(
          'INTENT_STORE_UNAVAILABLE',
          "The wallet's payment records could not be read.",
          error
        );
      });
    }
    return loading;
  }

  // Check, append, then apply: the state changes only once the line is on
  // disk. `beforeAppend` may refuse the write after the checks.
  async function write(record, lock, beforeAppend) {
    await load();
    return serialize(async () => {
      const apply = prepare(record, LIVE, lock);
      if (beforeAppend) await beforeAppend();
      try {
        await journal.append(record);
      } catch (error) {
        throw intentError(
          'INTENT_WRITE_FAILED',
          "Could not save the wallet's payment record.",
          error
        );
      }
      apply();
      return intents.get(record.intent_id);
    });
  }

  function stamp(type, fields) {
    return { type, run: RUN_ID, at: now(), ...fields };
  }

  return {
    filePath,

    load,

    /** Settles once the records are loaded (and starts loading them). */
    get ready() {
      return load();
    },

    /** Set when a damaged file was moved aside: `{ path, at, reason }`. */
    get quarantined() {
      return quarantined && { ...quarantined };
    },

    /**
     * Commit a signed transaction of an intent: its first (`via:
     * 'original'`, with its `context`) or a replacement at its nonce.
     * Resolves once the record is on disk; only then may the bytes go to a
     * broadcaster (after a handoff).
     *
     * @param {object} commit
     * @param {string} commit.intentId
     * @param {number} commit.chainId
     * @param {string} commit.sender
     * @param {number} commit.nonce
     * @param {string} commit.hash
     * @param {string} commit.raw the signed transaction
     * @param {'original'|'replacement'} commit.via
     * @param {{ kind: string, origin?: string, key?: string, walletIndex?: number }} [commit.context]
     */
    async commit({ intentId, chainId, sender, nonce, hash, raw, via, context }) {
      const record = stamp('commit', {
        intent_id: intentId,
        chain_id: chainId,
        sender: typeof sender === 'string' ? sender.toLowerCase() : sender,
        nonce,
        hash: typeof hash === 'string' ? hash.toLowerCase() : hash,
        raw: typeof raw === 'string' ? raw.toLowerCase() : raw,
        via,
      });
      if (via === 'original') record.context = normalizeContext(context);
      // Filled in from the decoded bytes, so they always agree.
      try {
        record.fields = fieldsOf(Transaction.from(record.raw));
      } catch {
        record.fields = null;
      }
      const intent = await write(record, null, async () => {
        const bytes = Buffer.byteLength(encodeLine(record));
        if (journal.size + bytes <= limits.journalBytes) return;
        if (hasClosed()) await compactQuietly('to make room');
        if (journal.size + bytes > limits.journalBytes) {
          throw intentError(
            'INTENT_STORE_FULL',
            "The wallet's records of payments waiting to confirm are full. " +
              'Wait for some of them to confirm before sending another.'
          );
        }
      });
      return view(intent);
    },

    /**
     * Record that bytes of the intent are about to go to a broadcaster. Send
     * them only once this resolves, and record the outcome against the
     * handoff it returns. Refused for a settled or voided intent; writes are
     * serialized, so a void and a handoff can't both pass.
     *
     * @param {string} intentId
     * @param {string} [hash] which committed transaction; the latest by default
     * @returns {Promise<{ handoffId: string, hash: string, raw: string }>}
     */
    async handoff(intentId, hash) {
      await load();
      const intent = requireIntent(intentId);
      const latest = intent.hashes[intent.hashes.length - 1].hash;
      const chosen = typeof hash === 'string' ? hash.toLowerCase() : latest;
      const record = stamp('handoff', {
        intent_id: intentId,
        hash: chosen,
        handoff_id: crypto.randomUUID(),
      });
      const written = await write(record, null);
      const entry = written.hashes.find((known) => known.hash === chosen);
      return { handoffId: record.handoff_id, hash: chosen, raw: entry.raw };
    },

    /**
     * Record how a handoff ended.
     *
     * @param {object} result
     * @param {string} result.intentId
     * @param {string} result.handoffId
     * @param {'sent'|'uncertain'|'rejected'|'not_sent'} result.outcome
     * @param {string} [result.source]
     * @param {string} [result.reasonClass]
     */
    async outcome({ intentId, handoffId, outcome, source, reasonClass }) {
      await load();
      const handoff = requireIntent(intentId).handoffs.get(handoffId);
      if (!handoff) throw invalid(`unknown handoff ${handoffId}`);
      const record = stamp('outcome', {
        intent_id: intentId,
        hash: handoff.hash,
        handoff_id: handoffId,
        outcome,
        source: source ?? null,
        reason_class: reasonClass ?? null,
      });
      return view(await write(record, null));
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
     */
    async settle({ intentId, label, hash, block }) {
      const record = stamp('settle', {
        intent_id: intentId,
        label,
        hash: typeof hash === 'string' ? hash.toLowerCase() : (hash ?? null),
        block,
      });
      return view(await write(record, null));
    },

    /**
     * Void an intent: final, its nonce freed and its bytes forgotten. Only
     * under the account's lock: pass the token `withAccountLock` gave you.
     *
     * @param {string} intentId
     * @param {object} lock
     */
    async void(intentId, lock) {
      const record = stamp('void', { intent_id: intentId });
      const intent = await write(record, lock);
      await serialize(() => compactQuietly('after a void'));
      return view(intent);
    },

    /** Why the intent can't be voided now, or null if it can (lock aside). */
    voidRefusal(intentId) {
      assertLoaded();
      return voidRefusal(requireIntent(intentId), RUN_ID, LIVE);
    },

    /** Drop settled and voided intents from the file. */
    compact() {
      assertLoaded();
      return serialize(compactNow);
    },

    /** One intent, or null. */
    get(intentId) {
      assertLoaded();
      const intent = intents.get(intentId);
      return intent ? view(intent) : null;
    },

    /** The held intent whose context has this key, or null. */
    byKey(key) {
      assertLoaded();
      let found = null;
      for (const intent of intents.values()) {
        if (intent.state === 'held' && intent.context.key === key) found = intent;
      }
      return found ? view(found) : null;
    },

    /** Held intents, by account and nonce. */
    held() {
      assertLoaded();
      return [...intents.values()]
        .filter((intent) => intent.state === 'held')
        .sort(
          (a, b) => a.chainId - b.chainId || a.sender.localeCompare(b.sender) || a.nonce - b.nonce
        )
        .map(view);
    },

    /** Every intent this run knows: held ones, and settled or voided ones until a restart. */
    list() {
      assertLoaded();
      return [...intents.values()].map(view);
    },

    /** The nonces the account's held intents have, ascending. */
    heldNonces(chainId, sender) {
      assertLoaded();
      return heldOf({ chainId, sender: String(sender).toLowerCase() })
        .map((intent) => intent.nonce)
        .sort((a, b) => a - b);
    },
  };
}

let defaultStore = null;

/** The profile's intent store, at userData/wallet-intents.jsonl. */
function getIntentStore() {
  if (!defaultStore) {
    defaultStore = createIntentStore({
      filePath: path.join(app.getPath('userData'), FILE_NAME),
    });
  }
  return defaultStore;
}

module.exports = {
  FILE_NAME,
  LIMITS,
  RUN_ID,
  createIntentStore,
  getIntentStore,
};
