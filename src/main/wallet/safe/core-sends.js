/**
 * The wallet's own Safe sends on the core's Safe backend (freedom-core
 * design 0016, SAFE-3's PRs 4a and 4b; FREEDOM_SAFE_BACKEND=core,
 * development builds only: safe-backend-kind.js). safe-transactions.js
 * routes its steps here on the core, and keeps today's protocol-kit path
 * on js.
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
 * - **The execution** (SAFE-3's PR 4b) is `safe.execute`, naming the
 *   SafeTx the board showed (required, as for every board step): the core
 *   reads the Safe again and answers its executor's prepared send with an
 *   `executor-send` token it minted itself, or `{ fee_check }`, or `{
 *   superseded }`. A fee the core's check
 *   stops is the user's to confirm, as the plan's point 8 has it: the
 *   approvals document's `wallet.executor_send` panel (or, with it off, the
 *   chrome's board) shows the core's verdict, and the user's confirmation
 *   is `safe.execute` again with `fee_ack: true`; main mints no
 *   `executor-send` token. Main checks the send (the executor, the Safe,
 *   the SafeTx's call, the fee the user confirmed), the executor signs it
 *   with the core's token (`sign.transaction` with `{ token, kind:
 *   "executor-send" }`), main journals it under `execIntentKey`
 *   (transaction-service.js commits the intent before its bytes go
 *   anywhere) and broadcasts it, then tells the core (`safe.executed`).
 *   A "Try again" while the execution is held sends its bytes again, at
 *   its nonce, with nothing signed anew.
 *
 * Each step holds main's own step exclusion for the Safe, as today's path
 * does, and then reads the core's entry into main's read-only copy
 * (pending-store.js `refreshPending`; the SAFE-3 plan's point 3, the copy
 * PR 8's binding reads). A refusal of the core's keeps its code
 * (wallet/safe/errors.js): nothing here falls back to main's own path.
 *
 * - **The approval records** (SAFE-3's PR 6, the plan's point 5;
 *   approval-records.js, in memory only): at the user's decision, before
 *   the token is minted, main records the SafeTx approved for the Safe,
 *   `{ address, chainId: 100, hash }`, only once ethers' hash of the fields
 *   `safe.prepare` answered is the core's `safe_tx_hash` (checked at the
 *   prepare too, so a SafeTx that doesn't hash to it is never shown). The
 *   record is dropped on a failed mint or propose, before `safe.discard`,
 *   when `safe.execute` answers the SafeTx superseded, and before
 *   `safe.executed` (`approvalRecords`, below). PR 8's binding of a Ledger
 *   owner's SafeTx reads it.
 */

const crypto = require('crypto');
const { Interface, ZeroAddress } = require('ethers');
const {
  codedError,
  SAFE_BUSY,
  SAFE_DISCARDED,
  SAFE_NEEDS_FUNDS,
  SAFE_UNSUPPORTED,
} = require('./errors');
const records = require('./approval-records');
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

// The executor's fee the core offered for each Safe (`safe.execute`'s `{
// fee_check }`), by its index, as main shows it: { safeTxHash,
// executorIndex, safeAddress, verdict }. `fee_ack` goes to the core only
// for the SafeTx of an offer main holds, and the send it answers must cost
// what that verdict showed. Dropped once a send, a supersession or a
// discard of the Safe ends it.
const offers = new Map();

// Executions broadcast whose `safe.executed` failed, by the Safe's index:
// { state, executed: { hash, explorerUrl } } (`finishExecuted`). In memory
// only, as the core keeps no executed mark: after a restart the verified
// nonce decides.
const unfinished = new Map();

const EXEC_INTERFACE = new Interface([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
]);
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;

/**
 * The approval records (SAFE-3's PR 6, the plan's point 5;
 * approval-records.js): `{ address, chainId: 100, hash }` recorded for the
 * Safe on the user's decision (`decided`, before the token is minted, and
 * only once ethers' hash of the prepared fields, for the Safe's address as
 * main's record holds it now, is the core's `safe_tx_hash`: a throw there
 * mints nothing), and dropped (`dropped`) on a failed mint or propose,
 * before `safe.discard`, when `safe.execute` answers the SafeTx superseded,
 * and before `safe.executed`. Both synchronous, in memory.
 */
const approvalRecords = {
  /** The user approved the SafeTx `payload` (`{ chainId, safeTx, safeTxHash }`) for Safe `safeIndex`. */
  decided(safeIndex, payload) {
    const { address } = safeRecord(safeIndex);
    records.record(safeIndex, {
      address,
      chainId: payload?.chainId,
      safeTx: payload?.safeTx,
      safeTxHash: payload?.safeTxHash,
    });
  },
  /**
   * The Safe's record for `safeTxHash` ends (`why`: `mint_failed`,
   * `propose_failed`, `discard`, `superseded`, `executed`); another
   * SafeTx's stays.
   */
  dropped(safeIndex, safeTxHash, _why) {
    records.drop(safeIndex, safeTxHash);
  },
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
  // The binding its approval will record (PR 6), checked before anything
  // is shown: a SafeTx whose fields don't hash to the core's
  // `safe_tx_hash` is never asked about.
  records.verify({ address: safeRecord(safeIndex).address, ...payload });
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

/**
 * The user's decision recorded (PR 6), then the token minted for `payload`
 * and held. A mint that fails drops the record: no token, no approval.
 */
async function mint(safeIndex, payload) {
  await approvalRecords.decided(safeIndex, payload);
  const { KINDS, issueConfirmation } = signing();
  let minted;
  try {
    minted = await issueConfirmation(KINDS.SAFE_SEND, safeIndex, payload);
  } catch (err) {
    await approvalRecords.dropped(safeIndex, payload.safeTxHash, 'mint_failed');
    throw err;
  }
  const { token, expiresAt } = minted;
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
  // A token main holds a SafeTx for, refused before the core is asked: a
  // failed propose, so its approval's record (PR 6) goes with it.
  const dropHeld = () => {
    if (held) approvalRecords.dropped(held.safeIndex, held.payload.safeTxHash, 'propose_failed');
  };
  const refuse = (reason) => {
    if (token) signing().discardConfirmation(token);
    dropHeld();
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
  let confirmation;
  try {
    confirmation = confirmationFor(token, KINDS.SAFE_SEND, safeIndex, held.payload);
  } catch (err) {
    dropHeld();
    throw err;
  }
  let reservation;
  try {
    reservation = safeApprovals.reserveSend(safeIndex);
  } catch (err) {
    signing().discardConfirmation(token);
    dropHeld();
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
    offers.delete(safeIndex);
  } finally {
    safeApprovals.endStep(safeIndex);
    await refreshCopy(safeIndex);
  }
  return { safeIndex, safeTxHash: named, outcome: 'discarded' };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function safeRecord(safeIndex) {
  const { getWalletRecord, WALLET_TYPES } = require('../../identity-manager');
  const record = getWalletRecord(safeIndex);
  if (record?.type !== WALLET_TYPES.SAFE || typeof record.address !== 'string') {
    throw new Error('Not a multi-owner account');
  }
  return record;
}

/**
 * The Safe's executor as main reads the record: its first vault owner, the
 * account the core sends from (`pickDefaultExecutor`'s rule).
 */
function executorOf(record) {
  const { getWalletRecord, WALLET_TYPES } = require('../../identity-manager');
  const owners = Array.isArray(record.owners) ? record.owners : [];
  const index = owners.find((owner) => getWalletRecord(owner)?.type === WALLET_TYPES.MNEMONIC);
  if (index === undefined) {
    throw new Error('No browser account among the owners to act as executor — choose one that can pay gas');
  }
  return index;
}

/**
 * The call an `execTransaction` calldata executes, as main compares calls,
 * or null for any other calldata, or a SafeTx Freedom doesn't make (one
 * CALL, no refund).
 */
function executedCall(data) {
  let decoded;
  try {
    decoded = EXEC_INTERFACE.decodeFunctionData('execTransaction', data);
  } catch {
    return null;
  }
  const fixed =
    decoded.operation === 0n &&
    decoded.safeTxGas === 0n &&
    decoded.baseGas === 0n &&
    decoded.gasPrice === 0n &&
    decoded.gasToken === ZeroAddress &&
    decoded.refundReceiver === ZeroAddress;
  if (!fixed) return null;
  return callOf({ to: decoded.to, value: decoded.value.toString(), data: decoded.data });
}

const decimalOf = (value) => (typeof value === 'string' && DECIMAL.test(value) ? BigInt(value) : null);

/** The most a send in `sign.transaction`'s form can cost: gas limit times `max_fee_per_gas ?? gas_price`. */
function maxCostOf(tx) {
  const gasLimit = decimalOf(tx.gas_limit);
  const perGas = decimalOf(tx.type === 2 ? tx.max_fee_per_gas : tx.gas_price);
  return gasLimit === null || perGas === null ? null : (gasLimit * perGas).toString();
}

/**
 * The executor's send the core prepared (`{ send }`), checked before the
 * executor signs it: the core's own `executor-send` token, from the Safe's
 * executor (`executorOf`), to the Safe on the board's chain, value 0, its
 * calldata `execTransaction` of the very call the board shows for the
 * SafeTx, with a gas limit and fees. Main's form of the transaction
 * (`mainTxOf`), or a throw.
 */
function checkedSend(send, { record, state }) {
  const refuse = () => new Error('The identity core prepared another execution than the pending transaction');
  if (!isObject(send) || send.kind !== 'executor-send' || typeof send.token !== 'string' || send.token === '') {
    throw refuse();
  }
  const tx = send.tx;
  if (!isObject(tx) || send.account !== executorOf(record)) throw refuse();
  if (tx.type !== 0 && tx.type !== 2) throw refuse();
  if (decimalOf(tx.chain_id) === null || Number(tx.chain_id) !== state.chainId) throw refuse();
  if (typeof tx.to !== 'string' || tx.to.toLowerCase() !== record.address.toLowerCase()) throw refuse();
  if (decimalOf(tx.value) !== 0n || !(decimalOf(tx.gas_limit) > 0n) || maxCostOf(tx) === null) throw refuse();
  if (tx.type === 2 && decimalOf(tx.max_priority_fee_per_gas) === null) throw refuse();
  const call = executedCall(tx.data);
  let shown;
  try {
    shown = callOf(state.call);
  } catch {
    shown = null;
  }
  if (!call || !shown || !sameCall(call, shown)) throw refuse();
  // Main's form of it, as a page's prepared send is signed.
  return require('../../page/page-core-sends').mainTxOf(tx);
}

/**
 * The executor's fee the core's check stopped (FEE_CHECK_NEEDS_CONFIRMATION,
 * with the core's verdict), offered for the user to confirm: by
 * acknowledging it (`feeAck`, the core's `fee_ack`), never with a token.
 */
function feeAsk(offer) {
  const { FEE_CHECK_NEEDS_CONFIRMATION, feeCheckError } = require('../fee-check');
  const error = feeCheckError(FEE_CHECK_NEEDS_CONFIRMATION, { ...offer.verdict });
  error.offer = {
    feeAck: true,
    safeIndex: offer.safeIndex,
    executorIndex: offer.executorIndex,
    chainId: offer.chainId,
    to: offer.safeAddress,
    value: '0',
  };
  return error;
}

/**
 * The user's confirmation of the executor's fee the core offered for the
 * Safe (`offers`), in the window's approvals document (`approvals`,
 * wallet-approvals.js; `windowId`, or the chrome's `sender`):
 * `wallet.executor_send` with the core's verdict, asked again above the
 * threshold, nothing minted. Resolves `{ approved: true, feeConfirmation: {
 * feeAck: true } }`, or the document's refusal; none held is refused.
 */
async function confirmOfferedFee({ approvals, windowId = null, sender = null, safeIndex }) {
  const offer = offers.get(safeIndex);
  if (!offer) {
    return { approved: false, error: "This transaction's network fee wasn't shown, so nothing was signed", code: 'FEE_NOT_SHOWN' };
  }
  const outcome = await approvals.confirm(
    {
      ...(Number.isInteger(windowId) ? { windowId } : { sender }),
      kind: signing().KINDS.EXECUTOR_SEND,
      index: offer.executorIndex,
      // What the panel shows: the Safe its executor sends to, on its chain.
      // The core keeps the offer's calldata and fees; the fee is its verdict's.
      payload: { chainId: offer.chainId, to: offer.safeAddress, value: '0' },
      verdict: offer.verdict,
    },
    () => ({})
  );
  // Still the offer the user saw: a newer one is asked again.
  if (outcome.approved && offers.get(safeIndex) !== offer) {
    return { approved: false, error: "This transaction's network fee changed, so nothing was signed", code: 'FEE_NOT_SHOWN' };
  }
  return outcome.approved
    ? { approved: true, feeConfirmation: { feeAck: true } }
    : { approved: false, error: outcome.error, code: outcome.code };
}

/**
 * An execution broadcast, told to the core (`safe.executed`), after PR 6's
 * record is dropped: the core ends the Safe's approvals and clears its
 * entry. If the core isn't told, the execution is kept (`unfinished`) and
 * the error thrown: the next attempt tells it again, and executes nothing.
 */
async function finishExecuted(safeIndex, done) {
  await approvalRecords.dropped(safeIndex, done.state.safeTxHash, 'executed');
  try {
    await vault().safe.executed({ safe: safeIndex, safe_tx_hash: done.state.safeTxHash, hash: done.executed.hash });
  } catch (err) {
    // Another SafeTx pending: nothing of this one is left to clear.
    if (err?.code === SAFE_DISCARDED) unfinished.delete(safeIndex);
    else unfinished.set(safeIndex, done);
    console.warn('[SafeCore] An executed Safe transaction was not cleared yet:', err?.message);
    throw err;
  }
  unfinished.delete(safeIndex);
  boards.delete(safeIndex);
  return { ...done.state, status: 'executed', executed: done.executed };
}

/**
 * The Safe's pending SafeTx `safeTxHash` executed (`safe.execute`), the one
 * the board showed (required): another pending, or none named, is
 * SAFE_DISCARDED, with nothing sent. `feeConfirmation`: `{ feeAck: true }`, the user's confirmation
 * of the executor's fee the core last offered for that SafeTx (main's
 * caller asked it: `confirmOfferedFee`, or the chrome's board with the
 * approvals document off); a token is refused, and burnt.
 *
 * In order, holding main's step exclusion for the Safe from `safe.execute`
 * to `safe.executed`, as the reference's `acquire` spans its signature and
 * broadcast:
 * - `{ superseded }`: PR 6's record dropped, and the board's state returned
 *   (`status: 'superseded'`), nothing signed;
 * - `{ fee_check }`: the offer kept, and FEE_CHECK_NEEDS_CONFIRMATION with
 *   the core's verdict (`feeAsk`), nothing signed; but while the execution
 *   is held (a broadcast that failed), its bytes go again, as the fee they
 *   were signed with needs no new confirmation;
 * - `{ send }`, checked (`checkedSend`; after `fee_ack`, at the fee the
 *   user confirmed): signed by the executor with the core's token,
 *   journaled under `execIntentKey` and broadcast, or the held execution's
 *   bytes sent again; then PR 6's record dropped and `safe.executed` told
 *   (`finishExecuted`). Resolves the board's state, `status: 'executed'`,
 *   with `executed: { hash, explorerUrl }`.
 * The token is burnt however it ends. A failed signature or broadcast
 * leaves the SafeTx pending for "Try again".
 */
async function execute(safeIndex, { feeConfirmation = null, safeTxHash = null } = {}) {
  if (feeConfirmation !== null && feeConfirmation?.feeAck !== true) {
    if (typeof feeConfirmation?.confirmation === 'string') signing().discardConfirmation(feeConfirmation.confirmation);
    throw notConfirmed("the executor's fee is confirmed by acknowledging the identity core's offer");
  }
  // The SafeTx the board showed, required: none is refused unsent.
  const named = shown(safeTxHash).toLowerCase();
  const record = safeRecord(safeIndex);
  safeApprovals.beginStep(safeIndex);
  let token = null;
  try {
    // Broadcast before, but the core not told: told now, executed no more.
    const done = unfinished.get(safeIndex);
    if (done && done.state.safeTxHash.toLowerCase() === named) return await finishExecuted(safeIndex, done);
    let state = cachedState(safeIndex);
    if (state?.safeTxHash?.toLowerCase() !== named) state = await readState(safeIndex);
    if (state?.safeTxHash?.toLowerCase() !== named) {
      throw codedError('This transaction was discarded or replaced', SAFE_DISCARDED);
    }
    // SAFE-3's PR 7: a site's SafeTx executes on the core only with its
    // site's guard.
    if (state.display?.site !== undefined && state.display?.site !== null) throw siteSendRefused();
    const chainId = state.chainId;
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
      throw new Error("The identity core answered no state of this account's transaction");
    }
    const intentKey = require('./safe-executor').execIntentKey(chainId, named);
    const { heldIntentFor } = require('../transaction-service');
    const held = await heldIntentFor(intentKey);
    const offer = offers.get(safeIndex);
    const ack = feeConfirmation !== null && offer?.safeTxHash === named;
    const answer = await vault().safe.execute({
      safe: safeIndex,
      safe_tx_hash: state.safeTxHash,
      ...(ack ? { fee_ack: true } : {}),
    });

    if (isObject(answer?.superseded)) {
      offers.delete(safeIndex);
      await approvalRecords.dropped(safeIndex, state.safeTxHash, 'superseded');
      return remember(safeIndex, answer.superseded);
    }

    let params;
    let executorIndex;
    if (isObject(answer?.fee_check)) {
      executorIndex = executorOf(record);
      const ask = {
        safeIndex,
        safeTxHash: named,
        executorIndex,
        chainId,
        safeAddress: record.address,
        verdict: answer.fee_check,
      };
      offers.set(safeIndex, ask);
      // Asked, unless the execution is held: its bytes go again unsigned,
      // and a send that would sign anew refuses without a gas limit.
      if (!held) throw feeAsk(ask);
      params = { to: record.address, value: '0', data: '0x', chainId };
    } else {
      const send = answer?.send;
      token = typeof send?.token === 'string' ? send.token : null;
      params = checkedSend(send, { record, state });
      if (ack && maxCostOf(send.tx) !== offer.verdict?.maxCost) {
        offers.delete(safeIndex);
        throw require('../fee-check').feeNotShownError();
      }
      offers.delete(safeIndex);
      executorIndex = send.account;
    }

    const { getSigner } = require('../signers');
    const executor = getSigner(
      executorIndex,
      token ? { confirmation: { token, kind: signing().KINDS.EXECUTOR_SEND, page: null } } : {}
    );
    const from = await executor.getAddress();
    const display = isObject(state.display) ? state.display : {};
    const { signAndRecord, KINDS: PAYMENT_KINDS } = require('../tx-recorder');
    let result;
    try {
      result = await signAndRecord(
        params,
        executor,
        {
          kind: PAYMENT_KINDS.SAFE_SEND,
          fromAddress: record.address,
          toAddress: display.toAddress,
          asset: display.asset ?? null,
          amount: display.amount,
          metadata: { safeAddress: record.address, safeTxHash: state.safeTxHash, executor: from },
        },
        { intentKey }
      );
    } catch (err) {
      if (/insufficient funds/i.test(err?.message ?? '')) err.code = SAFE_NEEDS_FUNDS;
      throw err;
    }

    const { durable: _durable, ...shown } = state;
    return await finishExecuted(safeIndex, {
      state: shown,
      executed: { hash: result.hash, explorerUrl: result.explorerUrl ?? null },
    });
  } finally {
    // The core's token, spent at its presentation; one never presented is burnt.
    if (token) signing().discardConfirmation(token);
    safeApprovals.endStep(safeIndex);
    await refreshCopy(safeIndex);
  }
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
  offers.clear();
  unfinished.clear();
}

module.exports = {
  SAFE_TX_PREPARED,
  approvalRecords,
  cachedState,
  confirmOfferedFee,
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
