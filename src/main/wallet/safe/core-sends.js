/**
 * The wallet's own Safe sends on the core's Safe backend (freedom-core
 * design 0016, SAFE-3's PR 4a; FREEDOM_SAFE_BACKEND=core, development
 * builds only: safe-backend-kind.js). safe-transactions.js routes its steps
 * here on the core, and keeps today's protocol-kit path on js.
 *
 * - **Prepared, approved, then minted.** A send the chrome composed is
 *   built by the core first, `safe.prepare` as main's own (`shell`): the
 *   Safe's eight verified reads and the SafeTx at its nonce. The approval
 *   then shows the SafeTx its token will bind: the approvals document's
 *   `wallet.safe_send` with main's view of the core's SafeTx
 *   (wallet-approvals.js), or, with the document off, a second confirmation
 *   of the chrome's showing that SafeTx's nonce (SAFE_TX_PREPARED, below).
 *   On the approval main mints design 0016's `safe-send`
 *   (D6) under `shell`, `{ safe, chain_id, safe_tx, safe_tx_hash }`
 *   (signing-confirmation.js), and keeps the SafeTx it minted each token
 *   for (`prepared`), never the chrome's copy. Nothing mints the legacy
 *   form here.
 * - **Proposed.** The chrome presents the token with the call it composed,
 *   which must be the prepared SafeTx's; `safe.propose` spends the token
 *   under `shell`, naming `safe_tx_hash`: the core reads the Safe again,
 *   signs with the vault owners while the vault is unlocked, and writes the
 *   entry with its proposal mark. The token is burnt however it ends. Main
 *   holds the Safe's send reservation meanwhile (safe-approvals.js), so
 *   its deletion waits, and writes no entry itself.
 * - **The board** is the core's, `safe.pending`'s states in
 *   `getSafeSendState`'s shape. The last state main read or a step
 *   answered for each Safe is kept for the approvals document's board,
 *   which reads between its steps without waiting (`cachedState`).
 * - **Owners** sign through `safe.sign_owner`: without an owner the vault
 *   owners' sweep, with one that owner. A Ledger owner is refused here,
 *   unsent, until SAFE-3's PR 8 (main's binding of the SafeTx, on PR 6's
 *   records): no device is asked for a Safe owner before then. A phone
 *   owner is the core's own refusal.
 * - **A discard** is `safe.discard`, naming the SafeTx the board showed.
 *   Every board step names that SafeTx, its sweep included: one that names
 *   none is refused here, unsent, so a step never acts on a SafeTx that
 *   replaced the one shown (the core refuses another, SAFE_DISCARDED).
 * - **The execution** (`safe.execute`, the executor's signature, the
 *   journal and the broadcast, then `safe.executed`) is SAFE-3's PR 4b:
 *   refused here, nothing sent.
 *
 * Each step holds main's own step exclusion for the Safe, as today's path
 * does, and then reads the core's entry into main's read-only copy
 * (pending-store.js `refreshPending`; the SAFE-3 plan's point 3, the copy
 * PR 8's binding reads). A refusal of the core's keeps its code
 * (wallet/safe/errors.js): nothing here falls back to main's own path.
 *
 * PR 6 hooks the approval records in at `approvalRecords`, below.
 */

const crypto = require('crypto');
const { codedError, SAFE_BUSY, SAFE_DISCARDED, SAFE_UNSUPPORTED } = require('./errors');
const safeApprovals = require('./safe-approvals');

// The SafeTxs main minted a wallet `safe-send` for, by token: { safeIndex,
// payload: { chainId, safeTx, safeTxHash }, expiresAt }. Bounded as the
// core bounds its outstanding tokens; one main no longer holds is refused.
const MAX_PREPARED = 32;
const prepared = new Map();

// The SafeTxs prepared for the chrome's own confirmation (the approvals
// document off), by the id the chrome confirms them with: { safeIndex,
// payload, expiresAt }, for a token's life at most, bounded likewise.
const PREPARED_TTL_MS = 2 * 60 * 1000;
const awaiting = new Map();
// The chrome's answer to a send prepared for its own confirmation: the
// SafeTx's nonce shown, then confirmed again with its id.
const SAFE_TX_PREPARED = 'SAFE_TX_PREPARED';

// The board's last state of each Safe, by its index, as the core gave it.
const boards = new Map();

/**
 * PR 6's seam (the SAFE-3 plan's point 5, approval records). Today each
 * does nothing. PR 6 records `{ address, chainId: 100, hash }` for the Safe
 * on the user's decision (`decided`, before the token is minted, and only
 * once ethers' hash of the prepared fields is the core's `safe_tx_hash`:
 * a throw there mints nothing), and drops it (`dropped`) on a failed
 * propose and before `safe.discard`; PR 4b adds its drops on a superseded
 * SafeTx and before `safe.executed`.
 */
const approvalRecords = {
  /** The user approved the SafeTx `payload` for Safe `safeIndex`. */
  decided(_safeIndex, _payload) {},
  /** The Safe's record for `safeTxHash` ends (`why`: `propose_failed`, `discard`). */
  dropped(_safeIndex, _safeTxHash, _why) {},
};

function vault() {
  return require('../../core/vault-backend').vaultBackend;
}

function signing() {
  return require('../signing-confirmation');
}

function notConfirmed(reason) {
  return codedError(`Signing was not confirmed: ${reason}`, signing().NOT_CONFIRMED);
}

/** A call `{ to, value, data }` as main compares calls: lowercase, decimal. */
function callOf(tx) {
  if (!tx || typeof tx !== 'object') throw new Error('Transaction is required');
  if (typeof tx.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(tx.to)) throw new Error('Invalid to');
  let value;
  try {
    value = BigInt(tx.value ?? 0);
  } catch {
    value = -1n;
  }
  if (value < 0n) throw new Error('Invalid value');
  const data = tx.data === undefined || tx.data === null || tx.data === '' ? '0x' : tx.data;
  if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) throw new Error('Invalid data');
  return { to: tx.to.toLowerCase(), value: value.toString(), data: data.toLowerCase() };
}

const sameCall = (a, b) => a.to === b.to && a.value === b.value && a.data === b.data;

function chainOf(chainId) {
  const n = Number(chainId);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Invalid chainId');
  return n;
}

function hold(map, key, safeIndex, payload, expiresAt) {
  if (map.size >= MAX_PREPARED) {
    const now = Date.now();
    for (const [held, entry] of map) {
      if (entry.expiresAt <= now) map.delete(held);
    }
  }
  while (map.size >= MAX_PREPARED) map.delete(map.keys().next().value);
  map.set(key, { safeIndex, payload, expiresAt });
}

/** The SafeTx held under `key` (a token, or a prepared id), taken: held once. */
function take(key, map = prepared) {
  const entry = typeof key === 'string' ? map.get(key) : undefined;
  map.delete(key);
  return entry && entry.expiresAt > Date.now() ? entry : null;
}

/** A step's SafeTx, the one the caller showed: required, or nothing is sent. */
function shown(safeTxHash) {
  if (typeof safeTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(safeTxHash)) {
    throw codedError('This transaction was discarded or replaced', SAFE_DISCARDED);
  }
  return safeTxHash;
}

/** The core's entry for the Safe into main's read-only copy; never rejects. */
function refreshCopy(safeIndex) {
  return require('./pending-store').refreshPending(safeIndex);
}

const isState = (state) =>
  state !== null && typeof state === 'object' && Number.isSafeInteger(state.safeIndex) && typeof state.safeTxHash === 'string';

/** A step's answer, the board's state: kept for the Safe, and returned. */
function remember(safeIndex, answer) {
  if (!isState(answer) || answer.safeIndex !== safeIndex) {
    throw new Error("The identity core answered no state of this account's transaction");
  }
  const { durable, ...state } = answer;
  if (durable === false) {
    console.warn('[SafeCore] A Safe transaction was saved, but it may not survive a power loss yet');
  }
  boards.set(safeIndex, state);
  return state;
}

/**
 * The SafeTx the core builds for the chrome's call (`{ tx, chainId }`), as
 * its token will bind it: `{ chainId, safeTx, safeTxHash }`, the call the
 * one composed. The core's refusals (another chain, a Safe not activated,
 * `safe_unverified`, `safe_changed`…) carry their codes.
 */
async function prepare(safeIndex, request) {
  const call = callOf(request?.tx);
  const chainId = chainOf(request?.chainId);
  const answer = await vault().safe.prepare({ safe: safeIndex, chain_id: chainId, tx: call });
  const payload = { chainId, safeTx: answer?.safe_tx, safeTxHash: answer?.safe_tx_hash };
  const { KINDS, bindingFor } = signing();
  const facts = bindingFor(KINDS.SAFE_SEND, safeIndex, payload);
  if (!sameCall(callOf(facts.safeTx), call)) {
    throw new Error('The identity core prepared another transaction than the one composed');
  }
  return payload;
}

/**
 * The chrome's `wallet:confirm-signing` for its own Safe send, on the core:
 * prepared (`prepare`), approved in window `sender`'s approvals document
 * (`approvals`, wallet-approvals.js) or, with none, on the chrome's word,
 * then minted under `shell`. Resolves `{ approved: true, token, expiresAt }`,
 * or `{ approved: false, error, code }` as the document answers a refusal.
 *
 * @param {{ sender: object, safeIndex: number, request: { tx: object, chainId: number },
 *   approvals: object|null }} options
 */
async function confirmWalletSend({ sender, safeIndex, request, approvals }) {
  if (!approvals) return confirmOnChrome(safeIndex, request);
  const payload = await prepare(safeIndex, request);
  const outcome = await approvals.confirm(
    { sender, kind: signing().KINDS.SAFE_SEND, index: safeIndex, payload, feeChecked: false, built: true },
    () => mint(safeIndex, payload)
  );
  return outcome.approved
    ? { approved: true, token: outcome.token, expiresAt: outcome.expiresAt }
    : { approved: false, error: outcome.error, code: outcome.code };
}

/** The user's decision recorded (PR 6), then the token minted for `payload` and held. */
async function mint(safeIndex, payload) {
  await approvalRecords.decided(safeIndex, payload);
  const { KINDS, issueConfirmation } = signing();
  const { token, expiresAt } = await issueConfirmation(KINDS.SAFE_SEND, safeIndex, payload);
  hold(prepared, token, safeIndex, payload, expiresAt);
  return { token, expiresAt };
}

/**
 * The chrome's own confirmation, with the approvals document off: its
 * review showed the call, not the SafeTx the core builds after it. So the
 * first request (`{ tx, chainId }`) is prepared and answered
 * `{ approved: false, code: SAFE_TX_PREPARED, prepared: { id, nonce } }`,
 * nothing minted, for the chrome to show "Safe transaction #N"; the token
 * is minted only for its second (`{ tx, chainId, prepared: id }`), for
 * exactly the SafeTx it showed, with no new prepare. An id is taken once,
 * and refused for another Safe or another call.
 */
async function confirmOnChrome(safeIndex, request) {
  if (request?.prepared === undefined) {
    const payload = await prepare(safeIndex, request);
    const id = crypto.randomBytes(16).toString('hex');
    hold(awaiting, id, safeIndex, payload, Date.now() + PREPARED_TTL_MS);
    const nonce = payload.safeTx.nonce;
    return {
      approved: false,
      code: SAFE_TX_PREPARED,
      error: `Confirm Safe transaction #${nonce}`,
      prepared: { id, nonce },
    };
  }
  const held = take(request.prepared, awaiting);
  if (!held || held.safeIndex !== safeIndex) throw notConfirmed('unknown or already used confirmation');
  const facts = signing().bindingFor(signing().KINDS.SAFE_SEND, safeIndex, held.payload);
  let call;
  try {
    call = callOf(request.tx);
  } catch (err) {
    throw notConfirmed(err.message);
  }
  if (!sameCall(call, callOf(facts.safeTx)) || Number(request.chainId) !== facts.chainId) {
    throw notConfirmed('request differs from what was confirmed');
  }
  return { approved: true, ...(await mint(safeIndex, held.payload)) };
}

/**
 * `wallet:safe-send` on the core: the token the chrome presents
 * (`authorization.confirmation`) spent by `safe.propose` for the SafeTx
 * main minted it for, once the chrome's call (`tx`, `chainId`) is that
 * SafeTx's; `display` goes with it, the chrome's text for the board and
 * the payment record. Resolves the board's state. Refused, the token burnt
 * and nothing proposed, for no token, one main holds no SafeTx for (or
 * another Safe's, or another kind's), another call, and the chrome's
 * auto-approve claim.
 */
async function propose({ safeIndex, tx, chainId, display, authorization }) {
  const token = typeof authorization?.confirmation === 'string' ? authorization.confirmation : '';
  // Taken at once: a token is presented once, whatever becomes of it.
  const held = token ? take(token) : null;
  const refuse = (reason) => {
    if (token) signing().discardConfirmation(token);
    return notConfirmed(reason);
  };
  if (authorization?.autoApprove !== undefined) throw refuse("main reads a page's rules itself");
  if (!token) throw refuse('no confirmation token');
  if (!held || held.safeIndex !== safeIndex) throw refuse('unknown or already used confirmation');
  let call;
  try {
    call = callOf(tx);
  } catch (err) {
    throw refuse(err.message);
  }
  const { KINDS, confirmationFor } = signing();
  const facts = signing().bindingFor(KINDS.SAFE_SEND, safeIndex, held.payload);
  if (!sameCall(call, callOf(facts.safeTx)) || Number(chainId) !== facts.chainId) {
    throw refuse('request differs from what was confirmed');
  }
  // Main's record of the kind it minted the token as, checked (and the
  // token burnt otherwise) before the core is asked.
  const confirmation = confirmationFor(token, KINDS.SAFE_SEND, safeIndex, held.payload);
  let reservation;
  try {
    reservation = safeApprovals.reserveSend(safeIndex);
  } catch (err) {
    signing().discardConfirmation(token);
    throw err;
  }
  const safeTxHash = facts.safeTxHash;
  try {
    const answer = await vault().safe.propose({
      safe: safeIndex,
      safe_tx_hash: safeTxHash,
      authorization: { token: confirmation.token },
      display,
    });
    return remember(safeIndex, answer);
  } catch (err) {
    await approvalRecords.dropped(safeIndex, safeTxHash, 'propose_failed');
    // Burnt by the core however its propose ended; one never sent is burnt here.
    signing().discardConfirmation(token);
    throw err;
  } finally {
    reservation.release();
    await refreshCopy(safeIndex);
  }
}

/** Every pending SafeTx's state, the core's board (`safe.pending`), oldest first. */
async function readStates() {
  const reply = await vault().safe.pending();
  const states = Array.isArray(reply?.states) ? reply.states.filter(isState) : [];
  boards.clear();
  for (const state of states) boards.set(state.safeIndex, state);
  return states;
}

/** The Safe's pending SafeTx's state, the core's board read again, or null. */
async function readState(safeIndex) {
  await readStates();
  return boards.get(safeIndex) ?? null;
}

/** The Safe's last state main read or a step answered, or null. */
function cachedState(safeIndex) {
  return boards.get(safeIndex) ?? null;
}

function isLedgerOwner(ownerIndex) {
  const { getWalletRecord, WALLET_TYPES } = require('../../identity-manager');
  return getWalletRecord(ownerIndex)?.type === WALLET_TYPES.LEDGER;
}

/**
 * One owner's signature (`ownerIndex`), or the vault owners' sweep (none),
 * through `safe.sign_owner` as main's own, naming the SafeTx the caller
 * showed (`safeTxHash`, required: none is refused unsent, and another
 * pending is the core's SAFE_DISCARDED). Resolves the
 * board's state. No owner needs a confirmation of its own on the core: its
 * proposal authorized them, so `approval` is refused.
 */
async function signOwner(safeIndex, ownerIndex, { safeTxHash = null, approval = null } = {}) {
  if (approval !== null) throw new Error('This transaction was not confirmed');
  const named = shown(safeTxHash);
  const owner = ownerIndex === undefined || ownerIndex === null ? undefined : ownerIndex;
  if (owner !== undefined && isLedgerOwner(owner)) {
    // SAFE-3's PR 8: a Ledger owner signs on the core only under main's
    // binding of the SafeTx (and PR 6's record of its approval).
    throw codedError("A Ledger can't sign for a multi-owner account here yet", SAFE_UNSUPPORTED);
  }
  safeApprovals.beginStep(safeIndex);
  try {
    const answer = await vault().safe.signOwner({ safe: safeIndex, owner, safe_tx_hash: named });
    return remember(safeIndex, answer);
  } finally {
    safeApprovals.endStep(safeIndex);
    await refreshCopy(safeIndex);
  }
}

/**
 * The Safe's pending SafeTx discarded (`safe.discard`): the one named
 * (`safeTxHash`, the board's, required: none is refused unsent, and
 * another pending, or none, is the core's SAFE_DISCARDED). Refused
 * (SAFE_BUSY) while a step of the Safe runs. Resolves the outcome to tell
 * (`{ safeIndex, safeTxHash, outcome: 'discarded' }`).
 */
async function discard(safeIndex, { safeTxHash = null } = {}) {
  if (safeApprovals.stepRunning(safeIndex)) {
    throw codedError('Wait for the current step to finish first', SAFE_BUSY);
  }
  const named = shown(safeTxHash);
  safeApprovals.beginStep(safeIndex);
  try {
    await approvalRecords.dropped(safeIndex, named, 'discard');
    await vault().safe.discard({ safe: safeIndex, safe_tx_hash: named });
    boards.delete(safeIndex);
  } finally {
    safeApprovals.endStep(safeIndex);
    await refreshCopy(safeIndex);
  }
  return { safeIndex, safeTxHash: named, outcome: 'discarded' };
}

/**
 * The execution, SAFE-3's PR 4b: until then refused, nothing sent. PR 4b
 * runs `safe.execute`, the executor's fee as the plan's point 8 has it,
 * the signature under the core's token, the journal under `execIntentKey`
 * (safe-executor.js) and the broadcast, then `safe.executed`, with PR 6's
 * drops before it and on a superseded SafeTx.
 */
async function execute() {
  throw codedError(
    "Sending a multi-owner transaction through the identity core isn't available in this build yet",
    SAFE_UNSUPPORTED
  );
}

/**
 * A site's Safe send, which runs on the core from SAFE-3's PR 7 (the
 * hello's `safe3`, and `safe.propose` under the page): until then refused,
 * before its token is spent, nothing started.
 */
function siteSendRefused() {
  return codedError(
    "A site's multi-owner transaction isn't available through the identity core in this build yet",
    SAFE_UNSUPPORTED
  );
}

/** Tests: nothing held. */
function _reset() {
  prepared.clear();
  awaiting.clear();
  boards.clear();
}

module.exports = {
  SAFE_TX_PREPARED,
  approvalRecords,
  cachedState,
  confirmWalletSend,
  discard,
  execute,
  propose,
  readState,
  readStates,
  signOwner,
  siteSendRefused,
  _reset,
};
