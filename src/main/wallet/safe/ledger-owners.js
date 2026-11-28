/**
 * A Safe's Ledger owner signing through the core (freedom-core design 0016,
 * "Main's typed-data binding", "Approval records", "The device lane",
 * "Typed data on the device (Q23)"; SAFE-3's PR 8, the plan's points 4 to
 * 6; FREEDOM_SAFE_BACKEND=core, development builds only). core-sends.js
 * routes a Ledger owner's signature of a pending SafeTx here, and
 * core-messages.js one of a page's SafeMessage.
 *
 * - **Only on the core's Ledger backend** (point 4: FREEDOM_LEDGER_BACKEND
 *   =core): on the JS one a Ledger owner is refused, unsent
 *   (SAFE_UNSUPPORTED), and its row shows it can't sign here.
 * - **A SafeTx** (`signPending`): at the owner's turn main reads the
 *   pending entry again (`safe_pending.get`, into its read-only copy,
 *   pending-store.js): the SafeTx the board named, for the Safe main's
 *   record names, on Gnosis, else nothing is sent (SAFE_DISCARDED, or a
 *   refusal). Main's approval record of the Safe (approval-records.js,
 *   in memory only) must bind those fields: the record's hash is the
 *   SafeTx named, and ethers' hash of the fields, for the record's Safe and
 *   chain, is the record's (`binds`). Then `safe.sign_owner` goes with the
 *   owner, opened in main's relay, which admits the core's stream only as
 *   it equals main's own encoding of those fields
 *   (wallet/ledger/apdu-binding.js `safeTxTypedData`): a field, the Safe
 *   or the chain changed is refused before the device.
 * - **No record** (point 6: main restarted since the approval, or another
 *   build discarded it, or it was another SafeTx's): SAFE_APPROVAL_NEEDED,
 *   unsent. The board confirms the SafeTx again (`confirmAgain`), shown
 *   from the entry's fields, main's decision only (nothing minted), which
 *   records it; then the owner signs under that record. Fields that don't
 *   hash to the core's own hash are never shown or recorded.
 * - **A SafeMessage** (`signMessage`): from the page's own request main
 *   holds with the session (core-messages.js): the digest ethers computes
 *   for it, `{ message: digest }` under the Safe's domain on Gnosis
 *   (`safeMessageTypedData`). Its hash must be the session's, the core's,
 *   else nothing is sent; then `safe.message_sign` goes with the owner,
 *   bound to that typed data in the relay. Sessions live in memory, so no
 *   record is needed.
 * - **The device** (vault-backend.js `safeDeviceCall`): the request goes
 *   under the device watchdog, 7 minutes and 15 s until the core's first
 *   `shell.ledger_apdu` names it (its reads' 120 s and the lane's 5 minutes
 *   in the queue), then each APDU's `deadline_ms` + 15 s, reset by each
 *   APDU and each answer (ledger-relay.js). The Safe is held through the
 *   device's wait (the caller's step), so the board's other steps answer
 *   SAFE_BUSY meanwhile.
 * - **The hash-only warning** (Q23): a Ledger that can't show the fields
 *   gets the warning in the surface its step runs in, captured as it is
 *   asked (hash-only-warning.js `currentHashOnlySurface`): the approvals
 *   document's board, on the owner row the user picked (safe-boards.js),
 *   or the chrome's notice. No `E0 0C 00 00` reaches the device before it
 *   is on screen.
 * - **Failures:** the device's are the Ledger's texts (ledger/errors.js);
 *   a SafeTx's stream the relay refused as `payload` (the entry changed
 *   under the owner) is "discarded or replaced" (SAFE_DISCARDED), not
 *   LEDGER_UNKNOWN; the core's Safe refusals keep their codes.
 *
 * Nothing here signs a Ledger owner's SafeTx or SafeMessage as
 * `sign.typed_data`: that interim path (LDG-3's point 11) is the JS Safe
 * backend's alone (wallet/signers.js refuses it on the core's).
 */

const { codedError, SAFE_APPROVAL_NEEDED, SAFE_DISCARDED, SAFE_UNSUPPORTED } = require('./errors');
const records = require('./approval-records');
const {
  safeMessageDigest,
  safeMessageTypedData,
  safeTxTypedData,
} = require('../ledger/apdu-binding');
const { fromCoreError } = require('../ledger/errors');
const { currentHashOnlySurface } = require('../ledger/hash-only-warning');

const UNAVAILABLE = "A Ledger can't sign for a multi-owner account here yet";

function vault() {
  return require('../../core/vault-backend').vaultBackend;
}

function walletRecord(index) {
  const { getWalletRecord, WALLET_TYPES } = require('../../identity-manager');
  return { record: getWalletRecord(index), WALLET_TYPES };
}

const sameText = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

const discarded = () => codedError('This transaction was discarded or replaced', SAFE_DISCARDED);
const pendingNotBound = () =>
  new Error(
    "The identity core's pending transaction isn't the one approved, so the Ledger wasn't asked"
  );
const messageNotBound = () =>
  new Error("The identity core's signature request isn't the page's, so the Ledger wasn't asked");

/** Whether wallet index `owner` is a Ledger's account, by main's own record of it. */
function isLedgerOwner(owner) {
  if (owner === undefined || owner === null) return false;
  const { record, WALLET_TYPES } = walletRecord(owner);
  return record?.type === WALLET_TYPES.LEDGER;
}

/**
 * The Ledger owner's record, on the core's Ledger backend only (point 4):
 * on the JS one, SAFE_UNSUPPORTED, unsent.
 */
function ledgerOwner(owner) {
  const { ledgerBackendKind } = require('../ledger/ledger-backend-kind');
  const { record, WALLET_TYPES } = walletRecord(owner);
  if (
    ledgerBackendKind() !== 'core' ||
    record?.type !== WALLET_TYPES.LEDGER ||
    typeof record.path !== 'string'
  ) {
    throw codedError(UNAVAILABLE, SAFE_UNSUPPORTED);
  }
  return record;
}

/** The Safe's address, from main's own record. */
function safeAddressOf(safeIndex) {
  const { record, WALLET_TYPES } = walletRecord(safeIndex);
  if (record?.type !== WALLET_TYPES.SAFE || typeof record.address !== 'string') {
    throw new Error('Not a multi-owner account');
  }
  return record.address;
}

/**
 * The Safe's pending SafeTx `safeTxHash` as the core holds it now, read
 * into main's copy (`safe_pending.get`; the SAFE-3 plan's point 3): `{
 * address, chainId, safeTx, safeTxHash }`, the Safe's address main's
 * record's. Another SafeTx pending, or none, is SAFE_DISCARDED; an entry
 * for another Safe or chain is refused.
 */
async function pendingFacts(safeIndex, safeTxHash) {
  const store = require('./pending-store');
  await store.ready;
  await store.refreshPending(safeIndex);
  const entry = store.getPending(safeIndex);
  if (!entry || typeof safeTxHash !== 'string' || !sameText(entry.safeTxHash, safeTxHash))
    throw discarded();
  const address = safeAddressOf(safeIndex);
  if (!sameText(entry.safeAddress, address) || entry.chainId !== records.SAFE_CHAIN_ID)
    throw pendingNotBound();
  return {
    address,
    chainId: entry.chainId,
    safeTx: entry.safeTxData,
    safeTxHash: safeTxHash.toLowerCase(),
  };
}

/**
 * Whether main's approval record binds the pending SafeTx `facts`: the
 * record's hash is the SafeTx named, and its fields, for the record's
 * Safe and chain, hash to it (approval-records.js `binds`).
 */
function recordBinds(safeIndex, facts) {
  const held = records.recordFor(safeIndex);
  return Boolean(held) && held.hash === facts.safeTxHash && records.binds(safeIndex, facts);
}

/** A device request's failure, in the wallet's words. */
function deviceError(err, { pending = false } = {}) {
  // The core's SafeTx left main's stream: the entry changed under the
  // owner (the SAFE-3 plan, section 4).
  if (pending && err?.relayRefused === 'payload') return discarded();
  return fromCoreError(err) || err;
}

/**
 * Ledger owner `owner` signs Safe `safeIndex`'s pending SafeTx
 * `safeTxHash` (the board's), through `safe.sign_owner` bound to the
 * pending entry's fields under main's approval record (the module's
 * comment). Resolves the core's answer, the board's state. The caller
 * holds the Safe's step.
 */
async function signPending(safeIndex, owner, safeTxHash) {
  const ledger = ledgerOwner(owner);
  const facts = await pendingFacts(safeIndex, safeTxHash);
  if (!recordBinds(safeIndex, facts)) {
    // Fields that aren't the core's own hash: never asked about.
    records.verify(facts);
    throw codedError(
      'Confirm this transaction again before this Ledger signs it',
      SAFE_APPROVAL_NEEDED
    );
  }
  let bound;
  try {
    bound = safeTxTypedData({ safeAddress: facts.address, safeTx: facts.safeTx });
  } catch {
    throw pendingNotBound();
  }
  if (bound.hash !== facts.safeTxHash) throw pendingNotBound();
  try {
    return await vault().safe.signOwner(
      { safe: safeIndex, owner, safe_tx_hash: safeTxHash },
      {
        device: {
          path: ledger.path,
          typedData: bound.typedData,
          expectedHash: facts.safeTxHash,
          hashOnlySurface: currentHashOnlySurface(),
        },
      }
    );
  } catch (err) {
    throw deviceError(err, { pending: true });
  }
}

/**
 * Ledger owner `owner` signs the page's SafeMessage of session `entry`
 * (core-messages.js's: `{ session, hash, request }`, the page's own
 * request as main holds it), through `safe.message_sign` bound to main's
 * own SafeMessage for that request. Resolves the core's answer, the
 * session's state. The caller holds the Safe's step.
 */
async function signMessage(safeIndex, owner, entry) {
  const ledger = ledgerOwner(owner);
  let bound;
  try {
    bound = safeMessageTypedData({
      safeAddress: safeAddressOf(safeIndex),
      digest: safeMessageDigest(entry.request),
    });
  } catch {
    throw messageNotBound();
  }
  if (!sameText(bound.hash, entry.hash)) throw messageNotBound();
  try {
    return await vault().safe.messageSign(
      { safe: safeIndex, session: entry.session, owner },
      {
        device: {
          path: ledger.path,
          typedData: bound.typedData,
          expectedHash: bound.hash,
          hashOnlySurface: currentHashOnlySurface(),
        },
      }
    );
  } catch (err) {
    throw deviceError(err);
  }
}

/**
 * The board's "confirm again" step for a Ledger owner with no record
 * (point 6): Safe `safeIndex`'s pending SafeTx `safeTxHash` shown in
 * window `windowId`'s approvals document (`approvals`,
 * wallet-approvals.js) as the wallet's `wallet.safe_send`, from the
 * pending entry's fields; on the user's approval there, main records it
 * (approval-records.js `record`, which checks ethers' hash of the fields
 * is the core's), and nothing is minted. Resolves whether it was approved
 * and recorded; throws, nothing shown, for fields that don't hash to the
 * core's own hash.
 */
async function confirmAgain({ approvals, windowId, safeIndex, safeTxHash }) {
  if (!approvals || !Number.isInteger(windowId)) return false;
  const facts = await pendingFacts(safeIndex, safeTxHash);
  records.verify(facts);
  const payload = { chainId: facts.chainId, safeTx: facts.safeTx, safeTxHash: facts.safeTxHash };
  const { KINDS } = require('../signing-confirmation');
  const outcome = await approvals.confirm(
    { windowId, kind: KINDS.SAFE_SEND, index: safeIndex, payload, feeChecked: false, built: true },
    () => {
      records.record(safeIndex, { address: facts.address, ...payload });
      return {};
    }
  );
  return outcome?.approved === true;
}

module.exports = { UNAVAILABLE, confirmAgain, isLedgerOwner, signMessage, signPending };
