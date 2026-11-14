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
 * attached to the wrong payload. `get` answers the same object while an
 * entry lives, so the free sweep keeps a signature only in the entry it
 * was made for, never one discarded meanwhile.
 *
 * Every owner's signature presents the Safe approval main holds for the
 * entry (freedom-core design 0012, APB-1c; `safe-approvals.js`): the
 * adapter's `approvalOf(safeIndex, entry)` names it, or null. With none, no
 * owner signs: the free sweep signs nothing, and a chosen owner is refused
 * (SAFE_APPROVAL_NEEDED) before any key or device is asked. One the core
 * no longer knows is forgotten (`forgetApproval`), and refused the same
 * way. `signed(safeIndex, entry)`, if the adapter has it, runs after each
 * signature is kept (a SafeMessage's approval ends at its last).
 * `ended(entry)`, if the adapter has it, says the entry has ended for good
 * (a SafeMessage whose page went away, kept only until its approval's end):
 * no owner signs it, and a signature that lands for it is dropped.
 * `lastCheck(entry)`, if the adapter has it, names the caller's last check
 * kept with the entry (a page's standing rule, for the Safe message it
 * answers), or null: every owner's signer awaits it right before it signs,
 * a free owner's in a sweep and a chosen owner's alike. When it refuses,
 * `refused(safeIndex, entry)` ends the entry (a SafeMessage's approval
 * ended, then its session dropped), still under the Safe's step, and only
 * then does the caller hear the refusal.
 */

const { collectOwnerSignature } = require('./safe-executor');
const { getWalletRecord, isVaultUnlocked, WALLET_TYPES } = require('../../identity-manager');
const { beginStep, endStep, stepRunning } = require('./safe-approvals');
const { codedError, SAFE_DISCARDED, SAFE_APPROVAL_NEEDED } = require('./errors');

// An entry ended for good (`store.ended`: a SafeMessage whose page went
// away), though kept until its approval's end: nothing more signs it.
const ended = (store, entry) => store.ended?.(entry) === true;

function approvalNeeded() {
  return codedError(
    'This request needs your confirmation again before its owners can sign',
    SAFE_APPROVAL_NEEDED
  );
}

// The core no longer knows the approval presented (design 0012): ended,
// dropped among its 64, or the core restarted.
const approvalGone = (err) => err?.code === 'SIGNING_NOT_CONFIRMED' && err.reason === 'unknown_token';

// One live ceremony/execution per Safe at a time, across sends AND
// message sessions — a device can't serve two ceremonies at once — and
// none while the Safe is being deleted: the Safe's exclusion
// (`safe-approvals.js`), which a deletion takes too. The renderer keeps its
// own row-level spinner state.
function acquire(safeIndex) {
  beginStep(safeIndex);
}

function release(safeIndex) {
  endStep(safeIndex);
}

function isBusy(safeIndex) {
  return stepRunning(safeIndex);
}

/**
 * The caller's last check kept with the entry (`store.lastCheck`), as the
 * owner's signer awaits it (`beforeSign`), or null; `refused(err)` tells its
 * refusal from the signer's own failure.
 */
function lastCheckOf(store, entry) {
  const check = store.lastCheck?.(entry) || null;
  if (typeof check !== 'function') return { beforeSign: null, refused: () => false };
  const refusals = new WeakSet();
  return {
    beforeSign: async () => {
      try {
        await check();
      } catch (err) {
        const refusal = err && typeof err === 'object' ? err : new Error(String(err));
        refusals.add(refusal);
        throw refusal;
      }
    },
    refused: (err) => refusals.has(err),
  };
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
 * The entry's last check (`store.lastCheck`: a page's standing rule for the
 * Safe message it answers) is awaited inside each owner's signer right
 * before it signs. Its refusal stops the sweep: the entry is ended
 * (`store.refused`), and the refusal is the caller's to hear.
 */
async function collectFreeSignatures(store, safeIndex, ownerIndexes, expectedId = null) {
  if (!(await isVaultUnlocked())) {
    return;
  }
  for (const ownerIndex of ownerIndexes) {
    const entry = store.get(safeIndex);
    if (!entry || entry.superseded || ended(store, entry) || entry.signatures.length >= entry.threshold) break;
    if (expectedId != null && store.idOf(entry) !== expectedId) break;
    const owner = getWalletRecord(ownerIndex);
    if (owner?.type !== WALLET_TYPES.MNEMONIC || hasSigned(entry.signatures, owner.address)) {
      continue;
    }
    // No approval held (or it is being ended): no free signature; the
    // owners stay rows.
    const approval = store.approvalOf(safeIndex, entry);
    if (!approval) break;
    const check = lastCheckOf(store, entry);
    let signature;
    try {
      signature = await collectOwnerSignature({
        typedData: entry.typedData,
        ownerIndex,
        approval,
        ...(check.beforeSign ? { beforeSign: check.beforeSign } : {}),
      });
    } catch (err) {
      if (check.refused(err)) {
        await store.refused?.(safeIndex, entry);
        throw err;
      }
      if (approvalGone(err)) {
        store.forgetApproval(safeIndex, entry);
        break;
      }
      // Vault locked mid-loop or a derivation hiccup: this owner
      // degrades to a manual row on the board, nothing fails.
      console.warn(`[SafeSign] auto-sign skipped for owner ${ownerIndex}:`, err.message);
      continue;
    }
    // The signature was an await: it is kept only in the entry it was made
    // for, while that entry is still the store's. One discarded meanwhile
    // (its page gone, cancelled, its Safe deleted) or replaced is never
    // written back, and nothing more is signed for it.
    if (store.get(safeIndex) !== entry || ended(store, entry)) break;
    entry.signatures = [...entry.signatures, signature];
    store.set(safeIndex, entry);
    try {
      await store.signed?.(safeIndex, entry);
    } catch (err) {
      // The approval's end at the threshold wasn't confirmed: the entry
      // keeps it and the signature, and the next step (the join) ends it
      // again, failing visibly if it still can't.
      console.warn('[SafeSign] the approval stays held for now:', err.message);
      break;
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
 * refused (SAFE_DISCARDED) before any ceremony starts. The entry's last
 * check (`store.lastCheck`) is the chosen owner's too, right before it
 * signs; its refusal ends the entry (`store.refused`) before it is thrown.
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
  if (!entry || ended(store, entry) || (expectedId != null && store.idOf(entry) !== expectedId)) {
    throw codedError('The request was discarded or replaced', SAFE_DISCARDED);
  }
  if (hasSigned(entry.signatures, getWalletRecord(ownerIndex)?.address)) {
    return; // already signed — idempotent
  }
  const approval = store.approvalOf(safeIndex, entry);
  if (!approval) throw approvalNeeded();

  const check = lastCheckOf(store, entry);

  acquire(safeIndex);
  try {
    const signedId = store.idOf(entry);
    let signature;
    try {
      signature = await collectOwnerSignature({
        typedData: entry.typedData,
        ownerIndex,
        approval,
        ...(check.beforeSign ? { beforeSign: check.beforeSign } : {}),
      });
    } catch (err) {
      if (check.refused(err)) {
        // The caller's last check withdrew it: the entry ends here, under
        // the Safe's step, before the refusal is heard.
        await store.refused?.(safeIndex, entry);
        throw err;
      }
      if (!approvalGone(err)) throw err;
      store.forgetApproval(safeIndex, entry);
      throw approvalNeeded();
    }

    // The ceremony can take minutes (a device's isn't fenced by the
    // approval's end): re-validate that THIS entry is still the pending
    // one, and not ended meanwhile (its page gone), before persisting into
    // it.
    const current = store.get(safeIndex);
    if (!current || current !== entry || store.idOf(current) !== signedId || ended(store, current)) {
      throw codedError(
        'The request was discarded while the signature was being made',
        SAFE_DISCARDED
      );
    }
    current.signatures = [...current.signatures, signature];
    store.set(safeIndex, current);
    await store.signed?.(safeIndex, current);
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
