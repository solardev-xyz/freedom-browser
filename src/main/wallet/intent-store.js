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
 *   hide a handoff.
 *
 * Every line carries the run of main that wrote it (RUN_ID, one per
 * process).
 *
 * An intent is held from its first commit until it settles or is voided.
 * Its nonce stays reserved while it is held: a new intent goes above every
 * held nonce of its account (nonce-reservations.js).
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
 * - **tombstone**: a settled or voided intent, without its bytes: its id,
 *   account, nonce and how it closed. Closed is final: a commit or a handoff
 *   of a closed id is refused, and a late outcome for it is ignored, across
 *   reloads and compactions. The newest LIMITS.tombstones are kept; an
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
 * - **A damaged file** is moved aside as `<file>.corrupt-<ts>`, and the
 *   store starts empty, as after a restore; `quarantined` says so, for a
 *   notice. A missing file is a restore too: nothing to send again.
 * - **Bounds** (LIMITS): held intents per account and in all; replacements
 *   per intent; open handoffs per intent; and the file's size, admitted so
 *   that the outcomes and terminal lines still owed always fit (see
 *   `budget`). A new intent past any bound is refused; recorded state never
 *   is.
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
const RUN_ID = crypto.randomUUID();

const OUTCOMES = new Set(['sent', 'uncertain', 'rejected', 'not_sent']);
const LABELS = new Set(['paid', 'failed', 'taken']);
const CLOSED = new Set(['settled', 'voided']);
const TRANSACTION_TYPES = new Set([0, 2]);
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const HEX_PATTERN = /^0x(?:[0-9a-f]{2})*$/;
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const TEXT_LIMITS = { origin: 2048, key: 256 };
// An outcome's texts are cosmetic, and an outcome is never refused for one:
// anything else is recorded as null. Plain ASCII keeps the line's size known.
const OUTCOME_TEXT = { source: 64, reason_class: 128 };
const OUTCOME_TEXT_PATTERN = /^[A-Za-z0-9 ._:/()-]+$/;

const LIVE = Object.freeze({ live: true });
const LOADING = Object.freeze({ live: false });

const lineBytes = (record) => Buffer.byteLength(encodeLine(record));

// The largest line of each kind the store may still owe: an outcome for an
// open handoff, a settle or void for a held intent, and the one handoff of
// headroom each held intent keeps (`budget`).
const LONGEST = {
  id: 'x'.repeat(64),
  hash: `0x${'f'.repeat(64)}`,
  time: Number.MAX_SAFE_INTEGER,
};
const HANDOFF_LINE_MAX = lineBytes({
  type: 'handoff',
  run: LONGEST.id,
  at: LONGEST.time,
  intent_id: LONGEST.id,
  hash: LONGEST.hash,
  handoff_id: LONGEST.id,
});
const OUTCOME_LINE_MAX = lineBytes({
  type: 'outcome',
  run: LONGEST.id,
  at: LONGEST.time,
  intent_id: LONGEST.id,
  hash: LONGEST.hash,
  handoff_id: LONGEST.id,
  outcome: 'uncertain',
  source: 'x'.repeat(OUTCOME_TEXT.source),
  reason_class: 'x'.repeat(OUTCOME_TEXT.reason_class),
});
const TERMINAL_LINE_MAX = Math.max(
  lineBytes({
    type: 'settle',
    run: LONGEST.id,
    at: LONGEST.time,
    intent_id: LONGEST.id,
    label: 'failed',
    hash: LONGEST.hash,
    block: LONGEST.time,
  }),
  lineBytes({ type: 'void', run: LONGEST.id, at: LONGEST.time, intent_id: LONGEST.id })
);

function intentError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

// Messages name ids and numbers only: never bytes, fields or origins.
function invalid(detail) {
  return intentError('INTENT_INVALID', `Invalid wallet intent record: ${detail}`);
}

function storeFull() {
  return intentError(
    'INTENT_STORE_FULL',
    "The wallet's records of payments waiting to confirm are full. " +
      'Wait for some of them to confirm before sending another.'
  );
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

function isOutcomeText(value, name) {
  return (
    typeof value === 'string' &&
    value.length <= OUTCOME_TEXT[name] &&
    OUTCOME_TEXT_PATTERN.test(value)
  );
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
 * nonce, for its chain and hashing to its hash. The signer is checked by
 * `signerOf`, at once for a live write and after the replay on reload, for
 * the bytes a held intent keeps.
 */
function verifySigned({ raw, chainId, nonce, hash }) {
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
  if (tx.nonce !== nonce) {
    throw invalid(`the transaction is signed at nonce ${tx.nonce}, not ${nonce}`);
  }
  if (tx.chainId !== BigInt(chainId)) {
    throw invalid(`the transaction is signed for chain ${tx.chainId}, not ${chainId}`);
  }
  if (keccak256(raw) !== hash) throw invalid("the transaction does not hash to the intent's hash");
  return tx;
}

function signerOf(raw) {
  try {
    return Transaction.from(raw).from?.toLowerCase() ?? null;
  } catch {
    return null;
  }
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

function isOpen(handoff) {
  return !handoff.outcome;
}

// Handoffs as they count: the summary of earlier ones plus this run's.
function handoffTally(intent) {
  const handoffs = [...intent.handoffs.values()];
  return {
    count: intent.summary.count + handoffs.length,
    possiblySent:
      intent.summary.possiblySent ||
      handoffs.some((handoff) => isOpen(handoff) || handoff.outcome.outcome !== 'not_sent'),
  };
}

// A copy for callers, in camelCase.
function view(intent) {
  const latest = intent.hashes[intent.hashes.length - 1] ?? null;
  const tally = handoffTally(intent);
  return {
    intentId: intent.id,
    chainId: intent.chainId,
    sender: intent.sender,
    nonce: intent.nonce,
    state: intent.state,
    recovered: intent.recovered,
    context: intent.context && {
      kind: intent.context.kind,
      origin: intent.context.origin,
      key: intent.context.key,
      walletIndex: intent.context.wallet_index,
    },
    hash: latest?.hash ?? null,
    raw: latest?.raw ?? null,
    fields: latest?.fields ? camelFields(latest.fields) : null,
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
    handoffCount: tally.count,
    possiblySent: tally.possiblySent,
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
  // While loading: the signed bytes whose signer the replay still owes a check.
  let unrecovered = [];

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

  function heldIntents() {
    return [...intents.values()].filter((intent) => intent.state === 'held');
  }

  function closedIntents() {
    return [...intents.values()]
      .filter((intent) => intent.state !== 'held')
      .sort((a, b) => a.closedAt - b.closedAt || a.sequence - b.sequence);
  }

  function heldOf(account) {
    return heldIntents().filter((intent) => sameAccount(intent, account));
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

  function newIntent({ id, chainId, sender, nonce, context, run, at, recovered }) {
    sequence += 1;
    return {
      id,
      chainId,
      sender,
      nonce,
      context,
      run,
      recovered,
      sequence,
      state: 'held',
      hashes: [],
      // This run's handoffs (while loading, the file's), by id.
      handoffs: new Map(),
      // Handoffs folded away: earlier runs', and this run's finished ones
      // once compacted.
      summary: { count: 0, possiblySent: false },
      settlement: null,
      voidedAt: null,
      closedAt: null,
      createdAt: at,
      updatedAt: at,
    };
  }

  // Settled or voided: what it was, without its bytes. Its open handoffs'
  // outcomes are no longer owed (a late one is ignored).
  function close(intent, at) {
    const tally = handoffTally(intent);
    intent.summary = { count: tally.count, possiblySent: tally.possiblySent };
    intent.handoffs = new Map();
    intent.hashes = intent.hashes.map((entry) => ({ ...entry, raw: null, fields: null }));
    intent.closedAt = at;
    intent.updatedAt = at;
  }

  // Each `prepare*` checks a record against the state and returns the
  // function that applies it. Loading applies at once; a write applies only
  // once its line is on disk.

  // A new intent, live or replayed: above its account's held nonces, with a
  // key no held intent has. Live also checks the count bounds.
  function checkNewIntent({ chainId, sender, nonce, context }, mode) {
    const held = heldOf({ chainId, sender });
    if (mode.live && held.length >= limits.heldPerAccount) {
      throw intentError(
        'INTENT_ACCOUNT_LIMIT',
        `This account already has ${held.length} payments waiting to confirm. ` +
          'Wait for some of them before sending another.'
      );
    }
    if (mode.live && heldIntents().length >= limits.held) {
      throw intentError(
        'INTENT_STORE_LIMIT',
        `The wallet already has ${limits.held} payments waiting to confirm. ` +
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
    const fields = fieldsOf(verifySigned({ raw, chainId, nonce, hash }));
    if (mode.live && signerOf(raw) !== sender) {
      throw invalid("the transaction is not signed by the intent's sender");
    }
    if (!mode.live && JSON.stringify(record.fields) !== JSON.stringify(fields)) {
      throw invalid(`the fields of ${hash} do not match its transaction`);
    }
    const entry = { hash, raw, via: record.via, fields, at: record.at, run };
    const existing = intents.get(id);

    if (record.via === 'original') {
      // Closed ids included: closed is final.
      if (existing) throw invalid(`intent ${id} is already committed`);
      const context = normalizeContext(record.context);
      checkNewIntent({ chainId, sender, nonce, context }, mode);
      return () => {
        const intent = newIntent({
          id,
          chainId,
          sender,
          nonce,
          context,
          run,
          at: record.at,
          recovered: !mode.live,
        });
        intent.hashes.push(entry);
        intents.set(id, intent);
        if (!mode.live) unrecovered.push({ intent, entry });
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
    if (mode.live && existing.hashes.length >= limits.hashesPerIntent) {
      throw intentError(
        'INTENT_REPLACEMENT_LIMIT',
        'This payment has been replaced too many times. Send it again as it is.'
      );
    }
    const paying = existing.hashes[existing.hashes.length - 1].fields;
    if (fields.to !== paying.to || fields.value !== paying.value || fields.data !== paying.data) {
      throw invalid(`a replacement of intent ${id} must pay what the original pays`);
    }
    return () => {
      existing.hashes.push(entry);
      existing.updatedAt = record.at;
      if (!mode.live) unrecovered.push({ intent: existing, entry });
    };
  }

  // A held intent in one line, as compaction writes it. Replayed like an
  // original commit (the same cross-intent rules), then the bytes it keeps
  // are checked like any commit's.
  function prepareHeldSnapshot(record, mode) {
    if (mode.live) throw invalid('a snapshot is written by compaction only');
    const id = requireId(record.intent_id, 'intent id');
    const run = requireRun(record);
    const chainId = requireChainId(record.chain_id);
    const sender = requireHex(record.sender, ADDRESS_PATTERN, 'sender');
    const nonce = requireCount(record.nonce, 'nonce');
    const hash = requireHex(record.hash, HASH_PATTERN, 'hash');
    const raw = requireHex(record.raw, HEX_PATTERN, 'signed transaction');
    const fields = fieldsOf(verifySigned({ raw, chainId, nonce, hash }));
    if (JSON.stringify(record.fields) !== JSON.stringify(fields)) {
      throw invalid(`the fields of ${hash} do not match its transaction`);
    }
    const listed = Array.isArray(record.hashes) ? record.hashes : [];
    if (listed.length === 0) throw invalid(`intent ${id} lists no hashes`);
    const hashes = listed.map((item, index) => {
      if (!isPlainObject(item)) throw invalid(`intent ${id} lists a bad hash`);
      const via = index === 0 ? 'original' : 'replacement';
      if (item.via !== via || !Number.isSafeInteger(item.at)) {
        throw invalid(`intent ${id} lists a bad hash`);
      }
      return {
        hash: requireHex(item.hash, HASH_PATTERN, 'hash'),
        raw: null,
        via,
        fields: null,
        at: item.at,
        run: requireId(item.run, 'run'),
      };
    });
    if (new Set(hashes.map((entry) => entry.hash)).size !== hashes.length) {
      throw invalid(`intent ${id} lists a hash twice`);
    }
    const latest = hashes[hashes.length - 1];
    if (latest.hash !== hash) throw invalid(`intent ${id}'s bytes are not its latest hash`);
    Object.assign(latest, { raw, fields });
    const summary = record.handoffs;
    if (!isPlainObject(summary) || typeof summary.possibly_sent !== 'boolean') {
      throw invalid(`intent ${id} has a bad handoff summary`);
    }
    requireCount(summary.count, 'handoff count');
    if (intents.has(id)) throw invalid(`intent ${id} is already committed`);
    const context = normalizeContext(record.context);
    checkNewIntent({ chainId, sender, nonce, context }, mode);
    return () => {
      const intent = newIntent({
        id,
        chainId,
        sender,
        nonce,
        context,
        run,
        at: record.at,
        recovered: true,
      });
      intent.hashes = hashes;
      intent.summary = { count: summary.count, possiblySent: summary.possibly_sent };
      intents.set(id, intent);
      unrecovered.push({ intent, entry: latest });
    };
  }

  // A closed intent, as compaction keeps it: final, and without its bytes.
  function prepareTombstone(record, mode) {
    if (mode.live) throw invalid('a tombstone is written by compaction only');
    const id = requireId(record.intent_id, 'intent id');
    const chainId = requireChainId(record.chain_id);
    const sender = requireHex(record.sender, ADDRESS_PATTERN, 'sender');
    const nonce = requireCount(record.nonce, 'nonce');
    if (!CLOSED.has(record.closed)) throw invalid('bad closed state');
    const settled = record.closed === 'settled';
    if (settled ? !LABELS.has(record.label) : record.label !== undefined) {
      throw invalid('bad label');
    }
    if (intents.has(id)) throw invalid(`intent ${id} is already committed`);
    return () => {
      const intent = newIntent({
        id,
        chainId,
        sender,
        nonce,
        context: null,
        run: null,
        at: record.at,
        recovered: true,
      });
      intent.state = record.closed;
      intent.closedAt = record.at;
      if (settled) {
        intent.settlement = { label: record.label, hash: null, block: null, at: record.at };
      } else {
        intent.voidedAt = record.at;
      }
      intents.set(id, intent);
    };
  }

  function prepareHandoff(record, mode) {
    const intent = requireIntent(requireId(record.intent_id, 'intent id'));
    requireHeld(intent, mode);
    const run = requireRun(record);
    const handoffId = requireId(record.handoff_id, 'handoff id');
    const hash = requireHex(record.hash, HASH_PATTERN, 'hash');
    const entry = intent.hashes.find((known) => known.hash === hash);
    if (!entry) throw invalid(`${hash} is not committed to intent ${intent.id}`);
    if (mode.live && !entry.raw) {
      throw invalid(`the bytes of ${hash} are no longer kept; send the latest`);
    }
    if (intent.handoffs.has(handoffId)) throw invalid(`handoff ${handoffId} is already recorded`);
    const open = [...intent.handoffs.values()].filter(isOpen).length;
    if (mode.live && open >= limits.openHandoffsPerIntent) {
      throw intentError(
        'INTENT_HANDOFF_LIMIT',
        'This payment is already being sent. Wait for that to finish.'
      );
    }
    return () => {
      intent.handoffs.set(handoffId, {
        id: handoffId,
        hash,
        at: record.at,
        run,
        outcome: null,
        record,
        bytes: lineBytes(record),
      });
      intent.updatedAt = record.at;
    };
  }

  // Live, an outcome the store no longer owes returns null: ignored, nothing
  // written. That is one for an unknown (evicted) or closed intent, for a
  // handoff already folded into the summary (an earlier run's, or a
  // finished one after compaction), or a second one for the same handoff.
  function prepareOutcome(record, mode) {
    const id = requireId(record.intent_id, 'intent id');
    const run = requireRun(record);
    const intent = intents.get(id);
    const handoff = intent?.handoffs.get(requireId(record.handoff_id, 'handoff id'));
    if (!intent || intent.state !== 'held' || !handoff || handoff.outcome) {
      if (mode.live) return null;
      if (!intent) throw invalid(`an outcome for unknown intent ${id}`);
      if (intent.state !== 'held') throw invalid(`an outcome for ${intent.state} intent ${id}`);
      if (!handoff) throw invalid(`unknown handoff ${record.handoff_id}`);
      throw invalid(`handoff ${handoff.id} already has its outcome`);
    }
    if (handoff.hash !== requireHex(record.hash, HASH_PATTERN, 'hash')) {
      throw invalid(`handoff ${handoff.id} was of another hash`);
    }
    if (handoff.run !== run) {
      // Its reply was lost with the run that made it: possibly sent, for good.
      throw invalid(`handoff ${handoff.id} was made by an earlier run of main`);
    }
    if (!OUTCOMES.has(record.outcome)) throw invalid('bad outcome');
    for (const name of ['source', 'reason_class']) {
      if (record[name] !== null && !isOutcomeText(record[name], name)) throw invalid(`bad ${name}`);
    }
    const outcome = {
      outcome: record.outcome,
      source: record.source,
      reason_class: record.reason_class,
      at: record.at,
      run,
    };
    return () => {
      handoff.outcome = outcome;
      intent.updatedAt = record.at;
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
      close(intent, record.at);
    };
  }

  /**
   * Why the intent can't be voided by a void of `run`, or null.
   * Live, `run` is this one, and an intent read from disk never qualifies.
   */
  function voidRefusal(intent, run, mode) {
    if (intent.state !== 'held') return `it is ${intent.state}`;
    if (mode.live && intent.recovered) {
      return 'it was recovered from disk, where a handoff may be missing';
    }
    if (intent.summary.possiblySent) return 'an earlier handoff may have been sent';
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
      close(intent, record.at);
    };
  }

  const PREPARE = {
    commit: prepareCommit,
    held: prepareHeldSnapshot,
    tombstone: prepareTombstone,
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

  // --- Compaction ---------------------------------------------------------

  // A held intent's line, as compaction writes it. `sizing` gives the
  // longest it can become (the summary at its widest), which is what the
  // budget counts.
  function snapshotRecord(intent, { sizing = false, extra = null } = {}) {
    const hashes = extra ? [...intent.hashes, extra] : intent.hashes;
    const latest = hashes[hashes.length - 1];
    const finished = [...intent.handoffs.values()].filter((handoff) => !isOpen(handoff));
    return {
      type: 'held',
      run: intent.run,
      at: intent.createdAt,
      intent_id: intent.id,
      chain_id: intent.chainId,
      sender: intent.sender,
      nonce: intent.nonce,
      hash: latest.hash,
      raw: latest.raw,
      fields: latest.fields,
      context: intent.context,
      hashes: hashes.map((entry) => ({
        hash: entry.hash,
        via: entry.via,
        at: entry.at,
        run: entry.run,
      })),
      handoffs: sizing
        ? { count: Number.MAX_SAFE_INTEGER, possibly_sent: false }
        : {
            count: intent.summary.count + finished.length,
            possibly_sent:
              intent.summary.possiblySent ||
              finished.some((handoff) => handoff.outcome.outcome !== 'not_sent'),
          },
    };
  }

  function tombstoneRecord(intent) {
    return {
      type: 'tombstone',
      at: intent.closedAt,
      intent_id: intent.id,
      chain_id: intent.chainId,
      sender: intent.sender,
      nonce: intent.nonce,
      closed: intent.state,
      ...(intent.state === 'settled' ? { label: intent.settlement.label } : {}),
    };
  }

  // The file compaction writes: the newest tombstones, then each held intent
  // (in the order they were created, so a replay meets them as it met them
  // live) with this run's open handoffs.
  function compactedRecords() {
    const tombstones = closedIntents().slice(-limits.tombstones).map(tombstoneRecord);
    const held = heldIntents()
      .sort((a, b) => a.sequence - b.sequence)
      .flatMap((intent) => [
        snapshotRecord(intent),
        ...[...intent.handoffs.values()].filter(isOpen).map((handoff) => handoff.record),
      ]);
    return [...tombstones, ...held];
  }

  // Finished handoffs, folded into the sticky summary, as the file now has
  // them. For an intent of this run the summary still says whether every
  // folded handoff ended not_sent (`possiblySent` false), which is all a
  // void needs of them; open ones stay, as they do in the file.
  function foldFinished(intent) {
    const finished = [...intent.handoffs.values()].filter((handoff) => !isOpen(handoff));
    if (finished.length === 0) return;
    intent.summary = {
      count: intent.summary.count + finished.length,
      possiblySent:
        intent.summary.possiblySent ||
        finished.some((handoff) => handoff.outcome.outcome !== 'not_sent'),
    };
    for (const handoff of finished) intent.handoffs.delete(handoff.id);
  }

  async function compactNow() {
    await journal.compact(compactedRecords());
    for (const intent of closedIntents().slice(0, -limits.tombstones)) intents.delete(intent.id);
    for (const intent of heldIntents()) foldFinished(intent);
  }

  async function compactQuietly(why) {
    try {
      await compactNow();
    } catch (error) {
      log.warn(`[IntentStore] Compaction ${why} failed: ${error.message}`);
    }
  }

  // --- Budget -------------------------------------------------------------
  //
  // The file never exceeds limits.journalBytes. Lines the store must always
  // accept (an outcome for each open handoff, a settle or void for each held
  // intent) are owed: `owed()` reserves the longest each can be. A line the
  // store may refuse is admitted only if:
  //   (1) for a commit: the budget after it fits. The budget is what
  //       compaction would write (each held intent's snapshot at its widest,
  //       this run's open handoffs, the kept tombstones), plus what is owed,
  //       plus one handoff and its outcome of headroom for each held intent.
  //       So once a new intent is in, every held intent can still be sent
  //       again;
  //   (1') for a handoff: the same, when it grows the budget. The first
  //       open handoff of an intent spends the pair its intent reserved and
  //       doesn't; a further one is refused unless there is slack beyond
  //       every other held intent's pair;
  //   (2) for a commit or a handoff: the file plus the line plus what is
  //       owed fits, after compacting if needed. Compacting brings the file
  //       to within (1), so a handoff of an intent with nothing open always
  //       fits: a send again is never refused for space.
  // Owed lines spend only what was reserved for them, so the file stays
  // within limits.journalBytes, and the reader's limits.readBytes is above it.

  // A held intent's snapshot at its widest; it only changes with a new hash.
  function snapshotBytes(intent, extraHash = null) {
    if (extraHash) return lineBytes(snapshotRecord(intent, { sizing: true, extra: extraHash }));
    if (intent.sized?.hashes !== intent.hashes.length) {
      intent.sized = {
        hashes: intent.hashes.length,
        bytes: lineBytes(snapshotRecord(intent, { sizing: true })),
      };
    }
    return intent.sized.bytes;
  }

  function tombstoneBytes(intent) {
    intent.tombstoneBytes ??= lineBytes(tombstoneRecord(intent));
    return intent.tombstoneBytes;
  }

  function intentBudget(intent, extraHash = null, extraOpenBytes = 0) {
    const openBytes =
      [...intent.handoffs.values()]
        .filter(isOpen)
        .reduce((sum, handoff) => sum + handoff.bytes + OUTCOME_LINE_MAX, 0) +
      (extraOpenBytes ? extraOpenBytes + OUTCOME_LINE_MAX : 0);
    return (
      snapshotBytes(intent, extraHash) +
      TERMINAL_LINE_MAX +
      Math.max(HANDOFF_LINE_MAX + OUTCOME_LINE_MAX, openBytes)
    );
  }

  function budget() {
    const held = heldIntents().reduce((sum, intent) => sum + intentBudget(intent), 0);
    const tombstones = closedIntents()
      .slice(-limits.tombstones)
      .reduce((sum, intent) => sum + tombstoneBytes(intent), 0);
    return held + tombstones;
  }

  function owed() {
    return heldIntents().reduce(
      (sum, intent) =>
        sum +
        TERMINAL_LINE_MAX +
        [...intent.handoffs.values()].filter(isOpen).length * OUTCOME_LINE_MAX,
      0
    );
  }

  // The budget before and after `record` is applied, and the owed bytes
  // after, for (1) and (2).
  function admission(record) {
    const intent = intents.get(record.intent_id);
    const budgetBefore = budget();
    if (record.type === 'handoff') {
      return {
        budgetBefore,
        budgetAfter:
          budgetBefore - intentBudget(intent) + intentBudget(intent, null, lineBytes(record)),
        owedAfter: owed() + OUTCOME_LINE_MAX,
      };
    }
    const entry = {
      hash: record.hash,
      raw: record.raw,
      via: record.via,
      fields: record.fields,
      at: record.at,
      run: record.run,
    };
    if (record.via === 'replacement') {
      return {
        budgetBefore,
        budgetAfter: budgetBefore - intentBudget(intent) + intentBudget(intent, entry),
        owedAfter: owed(),
      };
    }
    const fresh = {
      id: record.intent_id,
      chainId: record.chain_id,
      sender: record.sender,
      nonce: record.nonce,
      context: record.context,
      run: record.run,
      createdAt: record.at,
      hashes: [entry],
      handoffs: new Map(),
      summary: { count: 0, possiblySent: false },
    };
    return {
      budgetBefore,
      budgetAfter: budgetBefore + intentBudget(fresh),
      owedAfter: owed() + TERMINAL_LINE_MAX,
    };
  }

  async function admit(record) {
    const { budgetBefore, budgetAfter, owedAfter } = admission(record);
    // A line that grows the budget past the limit is refused: a new intent,
    // a replacement, or an extra open handoff that would spend another
    // held intent's reserved pair. A first handoff spends its own intent's
    // pair and doesn't grow the budget.
    if (budgetAfter > limits.journalBytes && budgetAfter > budgetBefore) throw storeFull();
    const fits = () => journal.size + lineBytes(record) + owedAfter <= limits.journalBytes;
    if (fits()) return;
    try {
      await compactNow();
    } catch (error) {
      throw intentError(
        'INTENT_WRITE_FAILED',
        "Could not save the wallet's payment record.",
        error
      );
    }
    if (!fits()) throw storeFull();
  }

  // --- Loading ------------------------------------------------------------

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

  // The bytes a held intent keeps must be signed by its sender. About 2.3 ms
  // each, bounded by LIMITS.held × LIMITS.hashesPerIntent; the event loop
  // gets a turn between batches.
  async function recoverSigners() {
    let checked = 0;
    for (const { intent, entry } of unrecovered) {
      if (intent.state !== 'held' || !entry.raw) continue;
      if (signerOf(entry.raw) !== intent.sender) {
        throw invalid(`intent ${intent.id}'s bytes are not signed by its sender`);
      }
      checked += 1;
      if (checked % 32 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // After a load every handoff is an earlier run's: fold it into the
  // summary, where an open one counts as possibly sent. Only the latest
  // bytes are kept.
  function foldLoaded() {
    for (const intent of heldIntents()) {
      const tally = handoffTally(intent);
      intent.summary = { count: tally.count, possiblySent: tally.possiblySent };
      intent.handoffs = new Map();
      intent.hashes = intent.hashes.map((entry, index, all) =>
        index === all.length - 1 ? entry : { ...entry, raw: null, fields: null }
      );
    }
  }

  async function doLoad() {
    let result = null;
    let damage = null;
    unrecovered = [];
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
        await recoverSigners();
      } catch (error) {
        damage = error.message;
      }
    }
    unrecovered = [];
    if (damage) {
      await quarantine(damage);
    } else {
      foldLoaded();
      if (result.tornTail > 0) {
        log.warn(`[IntentStore] Dropped an unfinished last line (${result.tornTail} bytes)`);
      }
      if (JSON.stringify(compactedRecords()) !== JSON.stringify(result.records)) {
        await compactQuietly('at startup');
      }
    }
    loaded = true;
    log.info(`[IntentStore] Loaded ${heldIntents().length} held wallet intent(s)`);
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

  // Check, admit, append, then apply: the state changes only once the line
  // is on disk. A prepare that returns null writes nothing.
  async function write(record, lock, { admitted = false } = {}) {
    await load();
    return serialize(async () => {
      const apply = prepare(record, LIVE, lock);
      if (!apply) return intents.get(record.intent_id);
      if (admitted) await admit(record);
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
      notify(record.intent_id);
      return intents.get(record.intent_id);
    });
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

  function stamp(type, fields) {
    return { type, run: RUN_ID, at: now(), ...fields };
  }

  return {
    filePath,

    load,

    /**
     * Call `listener(intentId)` after every change written to the records.
     * Returns a function that stops it.
     */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

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
     * Resolves once the record is on disk, with the intent; only then may
     * the bytes go to a broadcaster (after a handoff).
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
      if (via === 'original' && intentId !== undefined) {
        throw invalid('the store names a new intent: commit an original without an intentId');
      }
      const record = stamp('commit', {
        intent_id: via === 'original' ? crypto.randomUUID() : intentId,
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
      return view(await write(record, null, { admitted: true }));
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
      const latest = intent.hashes[intent.hashes.length - 1]?.hash ?? null;
      const chosen = typeof hash === 'string' ? hash.toLowerCase() : latest;
      const record = stamp('handoff', {
        intent_id: intentId,
        hash: chosen,
        handoff_id: crypto.randomUUID(),
      });
      const written = await write(record, null, { admitted: true });
      const entry = written.hashes.find((known) => known.hash === chosen);
      return { handoffId: record.handoff_id, hash: chosen, raw: entry.raw };
    },

    /**
     * Record how a handoff ended. Never refused for space. An outcome the
     * store no longer owes is ignored, nothing written: for a settled,
     * voided or forgotten intent (null then), or for a handoff already
     * finished or folded into the summary.
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
      const intent = intents.get(intentId);
      const handoff = intent?.handoffs.get(handoffId);
      const record = stamp('outcome', {
        intent_id: intentId,
        hash: handoff?.hash ?? null,
        handoff_id: handoffId,
        outcome,
        source: isOutcomeText(source, 'source') ? source : null,
        reason_class: isOutcomeText(reasonClass, 'reason_class') ? reasonClass : null,
      });
      const written = await write(record, null);
      return written ? view(written) : null;
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

    /**
     * How full the records are, in bytes: the file, what is owed to it, the
     * budget new intents are admitted against, and the limit.
     */
    usage() {
      assertLoaded();
      return { file: journal.size, owed: owed(), budget: budget(), limit: limits.journalBytes };
    },

    /** Rewrite the file from the state: tombstones and held snapshots. */
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
      for (const intent of heldIntents()) {
        if (intent.context.key === key) found = intent;
      }
      return found ? view(found) : null;
    },

    /** Held intents, by account and nonce. */
    held() {
      assertLoaded();
      return heldIntents()
        .sort(
          (a, b) => a.chainId - b.chainId || a.sender.localeCompare(b.sender) || a.nonce - b.nonce
        )
        .map(view);
    },

    /** Every intent this run knows: held ones, and the kept closed ones. */
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
  LINE_MAX: Object.freeze({
    handoff: HANDOFF_LINE_MAX,
    outcome: OUTCOME_LINE_MAX,
    terminal: TERMINAL_LINE_MAX,
  }),
  createIntentStore,
  getIntentStore,
};
