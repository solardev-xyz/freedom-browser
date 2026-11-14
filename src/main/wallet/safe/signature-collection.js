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
 * first time). With `expectedId`, only that entry is signed.
 *
 * `beforeSign`, the caller's last check (a page's standing rule for the
 * Safe message it answers), is awaited inside each owner's signer right
 * before it signs; its refusal stops the sweep and is the caller's to hear.
 */
async function collectFreeSignatures(store, safeIndex, ownerIndexes, expectedId = null, { beforeSign = null } = {}) {
  if (!(await isVaultUnlocked())) {
    return;
  }
  const refusals = new WeakSet();
  const lastCheck = beforeSign
    ? async () => {
        try {
          await beforeSign();
        } catch (err) {
          const refusal = err && typeof err === 'object' ? err : new Error(String(err));
          refusals.add(refusal);
          throw refusal;
        }
      }
    : null;
  for (const ownerIndex of ownerIndexes) {
    const entry = store.get(safeIndex);
    if (!entry || entry.superseded || entry.signatures.length >= entry.threshold) break;
    if (expectedId != null && store.idOf(entry) !== expectedId) break;
    const owner = getWalletRecord(ownerIndex);
    if (owner?.type !== WALLET_TYPES.MNEMONIC || hasSigned(entry.signatures, owner.address)) {
      continue;
    }
    try {
      const signature = await collectOwnerSignature({
        typedData: entry.typedData,
        ownerIndex,
        ...(lastCheck ? { beforeSign: lastCheck } : {}),
      });
      entry.signatures = [...entry.signatures, signature];
      store.set(safeIndex, entry);
    } catch (err) {
      if (refusals.has(err)) throw err;
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
 * identity re-check after a ceremony that may have taken minutes. With
 * `expectedId`, the caller's entry is the one signed: another one is
 * refused (SAFE_DISCARDED) before any ceremony starts.
 */
async function signEntryOwner({ store, safeIndex, ownerIndex, ownerIndexes, expectedId = null }) {
  if (ownerIndex == null) {
    acquire(safeIndex);
    try {
      await collectFreeSignatures(store, safeIndex, ownerIndexes, expectedId);
    } finally {
      release(safeIndex);
    }
    return;
  }

  if (!ownerIndexes.includes(ownerIndex)) {
    throw new Error('That account is not an owner of this Safe');
  }
  const entry = store.get(safeIndex);
  if (!entry || (expectedId != null && store.idOf(entry) !== expectedId)) {
    throw codedError('The request was discarded or replaced', SAFE_DISCARDED);
  }
  if (hasSigned(entry.signatures, getWalletRecord(ownerIndex)?.address)) {
    return; // already signed — idempotent
  }

  acquire(safeIndex);
  try {
    const signedId = store.idOf(entry);
    const signature = await collectOwnerSignature({ typedData: entry.typedData, ownerIndex });

    // The ceremony can take minutes: re-validate that THIS payload is
    // still the pending one before persisting into it.
    const current = store.get(safeIndex);
    if (!current || store.idOf(current) !== signedId) {
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
