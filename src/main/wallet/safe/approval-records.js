/**
 * Main's approval records for the Safe sends on the core's Safe backend
 * (freedom-core design 0016; the SAFE-3 plan's point 5, its PR 6;
 * FREEDOM_SAFE_BACKEND=core, development builds only): for each Safe, by
 * its wallet index, the SafeTx the user approved, `{ address, chainId: 100,
 * hash }`.
 *
 * - **Recorded at the decision, and only there** (core-sends.js
 *   `approvalRecords.decided`, before the token is minted): the approvals
 *   document's approval of `wallet.safe_send`, or, with the document off,
 *   the chrome's confirmation of the prepared SafeTx's nonce. And only once
 *   ethers' EIP-712 hash of the ten fields `safe.prepare` answered, for the
 *   Safe's address on Gnosis, is the core's `safe_tx_hash`: otherwise the
 *   decision is refused (`record` throws) and nothing is minted. A Safe has
 *   one pending SafeTx, so a newer decision replaces the Safe's record.
 * - **Dropped, never restored** (`drop`): on a failed propose (the core's
 *   refusal, or main's own of the token presented), before `safe.discard`,
 *   when `safe.execute` answers the SafeTx superseded, before
 *   `safe.executed`, on a mint that fails, and with the Safe's deletion
 *   (`forget`). A drop names its SafeTx: the record of another (a newer
 *   decision's) stays.
 * - **In memory only.** Nothing here is written anywhere, by design: after
 *   a restart main holds no record, and a Ledger owner's turn goes through
 *   the board's "confirm again" step (SAFE-3's PR 8, the plan's point 6).
 * - **Read** by SAFE-3's PR 8 (`binds`): a SafeTx is the Safe's approved one
 *   only when its fields hash, for the record's Safe and chain, to the
 *   record's hash. A record binds that one SafeTx and no other.
 *
 * On js nothing here runs. Dependency-light (ethers only), as
 * safe-approvals.js is, so a Safe's deletion (identity-manager) can drop
 * its record without loading the Safe stack.
 */

const { TypedDataEncoder, getAddress } = require('ethers');

// The only chain a Safe signs on here (design 0016).
const SAFE_CHAIN_ID = 100;

// A SafeTx as Safe 1.3 and later hash it (EIP-712, the domain `{ chainId,
// verifyingContract }`), its ten fields in the contract's order.
const SAFE_TX_TYPES = Object.freeze({
  SafeTx: Object.freeze([
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ]),
});
const SAFE_TX_FIELDS = Object.freeze(SAFE_TX_TYPES.SafeTx.map((field) => field.name));
const ADDRESS_FIELDS = Object.freeze(
  SAFE_TX_TYPES.SafeTx.filter((f) => f.type === 'address').map((f) => f.name)
);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

// Safe index -> its record, frozen: { address, chainId, hash }.
const records = new Map();

function safeIndexOf(safeIndex) {
  if (!Number.isSafeInteger(safeIndex) || safeIndex < 0) throw new Error('Invalid Safe index');
  return safeIndex;
}

/** An address, checksummed; any case is read as the address it spells. */
function addressOf(address) {
  if (typeof address !== 'string' || !ADDRESS.test(address))
    throw new Error('Invalid Safe address');
  return getAddress(address.toLowerCase());
}

/**
 * ethers' EIP-712 hash of a SafeTx's ten fields (exactly those) for the
 * Safe at `address` on `chainId`, lowercase. Throws for anything else.
 */
function safeTxHashOf(address, chainId, safeTx) {
  if (!safeTx || typeof safeTx !== 'object' || Array.isArray(safeTx)) {
    throw new Error('Invalid Safe transaction');
  }
  const keys = Object.keys(safeTx);
  if (
    keys.length !== SAFE_TX_FIELDS.length ||
    !SAFE_TX_FIELDS.every((key) => Object.hasOwn(safeTx, key))
  ) {
    throw new Error('Invalid Safe transaction');
  }
  const message = {};
  for (const key of SAFE_TX_FIELDS) {
    const value = safeTx[key];
    message[key] =
      ADDRESS_FIELDS.includes(key) && typeof value === 'string' ? value.toLowerCase() : value;
  }
  const domain = { chainId, verifyingContract: addressOf(address) };
  return TypedDataEncoder.hash(domain, SAFE_TX_TYPES, message).toLowerCase();
}

function notBound() {
  return new Error(
    "The identity core's Safe transaction doesn't match its hash, so nothing was approved"
  );
}

/**
 * The SafeTx `safe.prepare` answered, checked as its record will bind it:
 * on Gnosis, and ethers' hash of its fields (`safeTx`) for the Safe at
 * `address` the core's `safeTxHash`. Returns `{ address, chainId, hash }`;
 * throws otherwise, recording nothing.
 *
 * @param {{ address: string, chainId: number, safeTx: object, safeTxHash: string }} prepared
 */
function verify({ address, chainId, safeTx, safeTxHash } = {}) {
  if (chainId !== SAFE_CHAIN_ID) throw notBound();
  if (typeof safeTxHash !== 'string' || !HASH.test(safeTxHash)) throw notBound();
  const hash = safeTxHash.toLowerCase();
  let computed;
  try {
    computed = safeTxHashOf(address, SAFE_CHAIN_ID, safeTx);
  } catch {
    throw notBound();
  }
  if (computed !== hash) throw notBound();
  return { address: addressOf(address), chainId: SAFE_CHAIN_ID, hash };
}

/**
 * The user's decision for Safe `safeIndex` recorded, once `verify` holds:
 * the Safe's record, replacing any older one. Throws, recording nothing
 * (and leaving the Safe's record as it was), otherwise.
 */
function record(safeIndex, prepared) {
  const index = safeIndexOf(safeIndex);
  const entry = Object.freeze(verify(prepared));
  records.set(index, entry);
  return entry;
}

/**
 * The Safe's record dropped, if it is for `safeTxHash` (any case): another
 * SafeTx's stays. A drop that names no hash drops the Safe's record.
 * Returns whether one was dropped.
 */
function drop(safeIndex, safeTxHash) {
  const held = records.get(safeIndex);
  if (!held) return false;
  if (
    typeof safeTxHash === 'string' &&
    HASH.test(safeTxHash) &&
    safeTxHash.toLowerCase() !== held.hash
  ) {
    return false;
  }
  records.delete(safeIndex);
  return true;
}

/** The Safe's record dropped, whatever it was for (the Safe deleted). */
function forget(safeIndex) {
  records.delete(safeIndex);
}

/** The Safe's record, `{ address, chainId, hash }` (frozen), or null. */
function recordFor(safeIndex) {
  return records.get(safeIndex) ?? null;
}

/**
 * Whether the SafeTx `safeTx` (its ten fields) for the Safe at `address` on
 * `chainId` is the one the user approved for Safe `safeIndex`: the record's
 * Safe and chain, and ethers' hash of those fields the record's hash.
 */
function binds(safeIndex, { address, chainId, safeTx } = {}) {
  const held = records.get(safeIndex);
  if (!held) return false;
  try {
    return (
      addressOf(address) === held.address &&
      chainId === held.chainId &&
      safeTxHashOf(held.address, held.chainId, safeTx) === held.hash
    );
  } catch {
    return false;
  }
}

/** Tests: nothing held. */
function _reset() {
  records.clear();
}

module.exports = {
  SAFE_CHAIN_ID,
  SAFE_TX_TYPES,
  binds,
  drop,
  forget,
  record,
  recordFor,
  safeTxHashOf,
  verify,
  _reset,
};
