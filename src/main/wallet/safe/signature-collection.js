/**
 * Owner-signature collection shared by the Safe pending flows — SafeTx
 * sends (safe-transactions.js, persisted) and SafeMessage sessions
 * (safe-messages.js, in-memory). Both collect owner signatures over an
 * EIP-712 payload at the user's pace, so the machinery is identical;
 * only the store differs.
 *
 * A store adapter is `{get(safeIndex), set(safeIndex, entry), idOf(entry)}`
 * over entries shaped `{typedData, threshold, signatures, superseded?}`.
 * `idOf` names the entry's identity (SafeTx hash / SafeMessage hash) so a
 * signature landing after a discard-and-replace is dropped, never
 * attached to the wrong payload.
 */

const { collectOwnerSignature } = require('./safe-executor');
const { getWalletRecord, isVaultUnlocked, WALLET_TYPES } = require('../../identity-manager');
const { codedError, SAFE_BUSY, SAFE_DISCARDED } = require('./errors');

// One live ceremony/execution per Safe at a time, across sends AND
// message sessions — a device can't serve two ceremonies at once.
// In-memory only (a main-process crash clears it, the correct reset);
// the renderer keeps its own row-level spinner state.
const inFlight = new Set();

function acquire(safeIndex) {
  if (inFlight.has(safeIndex)) {
    throw codedError('Another step of this transaction is still running', SAFE_BUSY);
  }
  inFlight.add(safeIndex);
}

function release(safeIndex) {
  inFlight.delete(safeIndex);
}

function isBusy(safeIndex) {
  return inFlight.has(safeIndex);
}

const hasSigned = (signatures, address) =>
  Boolean(address) &&
  signatures.some((sig) => sig.signer.toLowerCase() === address.toLowerCase());

/** The owner rows of the render model, derived from live wallet records. */
function ownersView(ownerIndexes, signatures) {
  return ownerIndexes.map((index) => {
    const record = getWalletRecord(index);
    return {
      index,
      address: record?.address || null,
      type: record?.type || WALLET_TYPES.MNEMONIC,
      signed: hasSigned(signatures, record?.address),
    };
  });
}

/**
 * Silently sign every unsigned mnemonic owner while the vault is
 * unlocked — zero ceremony, so no user action is required. The single
 * home of the "which signatures are free" policy; runs at creation and
 * again when the board (re)opens (covers a vault that was locked the
 * first time).
 */
async function collectFreeSignatures(store, safeIndex, ownerIndexes) {
  if (!(await isVaultUnlocked())) {
    return;
  }
  for (const ownerIndex of ownerIndexes) {
    const entry = store.get(safeIndex);
    if (!entry || entry.superseded || entry.signatures.length >= entry.threshold) break;
    const owner = getWalletRecord(ownerIndex);
    if (owner?.type !== WALLET_TYPES.MNEMONIC || hasSigned(entry.signatures, owner.address)) {
      continue;
    }
    try {
      const signature = await collectOwnerSignature({ typedData: entry.typedData, ownerIndex });
      entry.signatures = [...entry.signatures, signature];
      store.set(safeIndex, entry);
    } catch (err) {
      // Vault locked mid-loop or a derivation hiccup: this owner
      // degrades to a manual row on the board, nothing fails.
      console.warn(`[SafeSign] auto-sign skipped for owner ${ownerIndex}:`, err.message);
    }
  }
}

/**
 * Collect one owner's signature (the user tapped that row, the device is
 * in their hand) — or, called without an ownerIndex, sweep the free
 * signatures instead. Persists through the store immediately; errors
 * (device not connected, rejection, locked vault) leave the entry
 * intact — they belong to the row, not the pending item.
 *
 * Callers own the existence/terminal-state checks on the entry; this
 * owns membership, idempotency, mutual exclusion, and the
 * identity re-check after a ceremony that may have taken minutes.
 */
async function signEntryOwner({ store, safeIndex, ownerIndex, ownerIndexes }) {
  if (ownerIndex == null) {
    acquire(safeIndex);
    try {
      await collectFreeSignatures(store, safeIndex, ownerIndexes);
    } finally {
      release(safeIndex);
    }
    return;
  }

  if (!ownerIndexes.includes(ownerIndex)) {
    throw new Error('That account is not an owner of this Safe');
  }
  const entry = store.get(safeIndex);
  if (hasSigned(entry.signatures, getWalletRecord(ownerIndex)?.address)) {
    return; // already signed — idempotent
  }

  acquire(safeIndex);
  try {
    const expectedId = store.idOf(entry);
    const signature = await collectOwnerSignature({ typedData: entry.typedData, ownerIndex });

    // The ceremony can take minutes: re-validate that THIS payload is
    // still the pending one before persisting into it.
    const current = store.get(safeIndex);
    if (!current || store.idOf(current) !== expectedId) {
      throw codedError(
        'The request was discarded while the signature was being made',
        SAFE_DISCARDED
      );
    }
    current.signatures = [...current.signatures, signature];
    store.set(safeIndex, current);
  } finally {
    release(safeIndex);
  }
}

module.exports = {
  acquire,
  release,
  isBusy,
  hasSigned,
  ownersView,
  collectFreeSignatures,
  signEntryOwner,
};
