/**
 * Safe send orchestration — a user-paced task board, not a pipeline.
 *
 * Collecting owner signatures is fundamentally asynchronous: devices
 * need to be plugged in or fetched, and the user decides which owner
 * signs when. So the API is granular — build once, sign one owner at a
 * time, execute as its own idempotent step — and every intermediate
 * state is persisted (pending-store, one pending SafeTx per Safe) so a
 * rejection, an unreachable device, or an app restart never loses
 * collected signatures. A signature failure is an OWNER-row fact, never
 * a transaction failure.
 *
 * Free signatures are still free: mnemonic owners are signed silently
 * when the SafeTx is created (vault unlocked, zero ceremony). Devices
 * are never cold-called — only signSafePending, user-initiated, touches
 * them.
 *
 * Execution is nonce-guarded: if the Safe's on-chain nonce moved past
 * the pending SafeTx (a broadcast that silently landed, or the user
 * executing via app.safe.global), the pending tx can never execute —
 * it flips to a terminal 'superseded' state instead of retry-looping.
 *
 * Every signature of a SafeTx presents its Safe approval (freedom-core
 * design 0012, APB-1c; `safe-approvals.js`): the one its `safe-send`
 * token gave when it was confirmed, a page's with that page's PageContext.
 * Each vault owner's signature and the executor's present it; with none
 * held (a restart since, or it ended) no owner signs until the user
 * confirms the SafeTx again (SAFE_APPROVAL_NEEDED; `signSafePending`'s
 * `approval`), and the executor needs an 'executor-send' token. Main ends
 * it before the SafeTx's discard, when it is superseded, and once it is
 * executed, before the pending entry is cleared.
 */

const { KINDS: PAYMENT_KINDS } = require('../tx-recorder');
const {
  buildSafeTransaction,
  execTransaction,
  pickDefaultExecutor,
  withdrawExecutionSite,
} = require('./safe-executor');
const {
  getSafeRecord,
  resolveOwnerAddresses,
  chainRead,
  isMarkedDeployed,
  DEPLOY_CHAIN_ID,
} = require('./safe-service');
const { getPending, setPending, clearPending, listPendingIndexes } = require('./pending-store');
const safeApprovals = require('./safe-approvals');
const {
  codedError,
  SAFE_BUSY,
  SAFE_DISCARDED,
  SAFE_PENDING_EXISTS,
  SAFE_NEEDS_FUNDS,
  SAFE_SITE_WITHDRAWN,
  SAFE_SITE_WITHDRAWING,
} = require('./errors');
const {
  acquire,
  release,
  isBusy,
  ownersView,
  collectFreeSignatures,
  signEntryOwner,
} = require('./signature-collection');

// The signature-collection store over the persisted pending-SafeTx
// entries; the SafeTx hash is the entry's identity, and the Safe approval
// main holds for it is what its owners present.
const SEND = safeApprovals.KINDS.SEND;
const store = {
  get: getPending,
  set: setPending,
  idOf: (entry) => entry.safeTxHash,
  approvalOf: (safeIndex, entry) => safeApprovals.held(SEND, safeIndex, entry.safeTxHash),
  forgetApproval: (safeIndex, entry) => safeApprovals.forget(SEND, safeIndex, entry.safeTxHash),
};

/**
 * The pending SafeTx, refused (SAFE_DISCARDED, nothing done) when the caller
 * names another one: a board's step acts only on the SafeTx it showed
 * (`approvals/safe-boards.js`), never on one that replaced it meanwhile.
 * Read in the same run as the step it guards.
 */
function pendingNamed(safeIndex, safeTxHash) {
  const pending = getPending(safeIndex);
  if (safeTxHash != null && pending?.safeTxHash !== safeTxHash) {
    throw codedError('This transaction was discarded or replaced', SAFE_DISCARDED);
  }
  return pending;
}

// Who hears a pending SafeTx's outcome (onSafeSendSettled).
const settledListeners = new Set();

/**
 * Hear each pending SafeTx's outcome as main records it: `{ safeIndex,
 * safeTxHash, outcome: 'executed', hash }` once its execution lands, or
 * `{ safeIndex, safeTxHash, outcome: 'discarded' }` once it is discarded.
 * A page's Safe send waits on this for its answer (page/page-sends.js),
 * whichever screen executed or discarded it. Returns the way to stop.
 *
 * @param {(event: object) => void} listener
 * @returns {() => void}
 */
function onSafeSendSettled(listener) {
  if (typeof listener !== 'function') return () => {};
  settledListeners.add(listener);
  return () => settledListeners.delete(listener);
}

// A site's SafeTx: the guard of the page request that started it, by SafeTx
// hash (guardSiteSafeSend).
const siteGuards = new Map();

/**
 * A page's request guards the site's SafeTx it started (freedom-core design
 * 0011, PRQ-5b, "After a waiting signature or send"). Before each execution
 * of it, `guard(execute)` checks the site's name and key, and that the
 * requesting document is live, and runs `execute` itself in the same run as
 * its last check, or throws SAFE_SITE_WITHDRAWN. The execution waits on the
 * executor's quote, the site's turn and its signer, so the same guard runs
 * again at its last step: after the executor's signature and before the
 * first commit, or before a held execution's bytes go out again
 * (`execTransaction`'s `guardCommit`). Returns the way to stop.
 *
 * A site's SafeTx with no guard (its request has ended, its page gone, or
 * main restarted since) is never executed for the site either. Whenever the
 * check fails, the SafeTx isn't executed: it stays pending as the wallet's
 * own, with no site, for the user to execute or discard: the site is taken
 * from an execution already held for it (a first attempt committed, then not
 * sent), durably, and only then from the pending SafeTx, with its signatures
 * and signed bytes kept. If the held execution's records can't be rewritten,
 * nothing changes and nothing is sent (SAFE_SITE_WITHDRAWING): the next
 * attempt, with no guard, tries again. A crash between the two leaves a held
 * execution with no site under a pending SafeTx that still names it, which
 * the next attempt finishes.
 *
 * @param {string} safeTxHash
 * @param {(execute: () => Promise<object>) => Promise<object>} guard
 * @returns {() => void}
 */
function guardSiteSafeSend(safeTxHash, guard) {
  if (typeof safeTxHash !== 'string' || typeof guard !== 'function') return () => {};
  siteGuards.set(safeTxHash, guard);
  return () => {
    if (siteGuards.get(safeTxHash) === guard) siteGuards.delete(safeTxHash);
  };
}

function siteWithdrawing() {
  return codedError(
    "The site that asked for this transaction no longer holds it, so it wasn't sent. " +
      "The wallet couldn't record it as your own yet: try again.",
    SAFE_SITE_WITHDRAWING
  );
}

function siteWithdrawn() {
  return codedError(
    "The site that asked for this transaction no longer holds it, so it wasn't sent for the site. " +
      "It is now your wallet's own: execute it again, or discard it.",
    SAFE_SITE_WITHDRAWN
  );
}

function settled(event) {
  for (const listener of [...settledListeners]) {
    try {
      listener(Object.freeze({ ...event }));
    } catch {
      // One listener's failure never changes the outcome, or what the others hear.
    }
  }
}

/** Safe.nonce() — raw uncached read. */
async function chainSafeNonce(safeAddress) {
  return BigInt(
    await chainRead(DEPLOY_CHAIN_ID, 'eth_call', [
      { to: safeAddress, data: '0xaffed0e0' /* nonce() */ },
      'latest',
    ])
  );
}

/**
 * The board's render model. Pure — never touches the chain, never
 * throws for a render call. Null when nothing is pending.
 *
 * @returns {{safeIndex: number, chainId: number, safeTxHash: string,
 *   threshold: number, collected: number,
 *   owners: Array<{index: number, address: string|null, type: string, signed: boolean}>,
 *   executorIndex: number|null, display: Object, createdAt: number,
 *   status: 'awaiting'|'superseded'}|null}
 */
function getSafeSendState(safeIndex) {
  const pending = getPending(safeIndex);
  if (!pending) {
    return null;
  }

  let ownerIndexes = [];
  try {
    ownerIndexes = getSafeRecord(safeIndex).owners;
  } catch {
    // record gone — render what the pending entry alone supports
  }
  const owners = ownersView(ownerIndexes, pending.signatures);

  let executorIndex = null;
  try {
    executorIndex = pickDefaultExecutor(ownerIndexes);
  } catch {
    // no local gas payer — the board says so at execution time
  }

  return {
    safeIndex,
    chainId: pending.chainId,
    safeTxHash: pending.safeTxHash,
    threshold: pending.threshold,
    collected: pending.signatures.length,
    owners,
    executorIndex,
    display: pending.display,
    // The call the SafeTx makes, as a new confirmation of it binds it.
    call: {
      to: pending.safeTxData?.to ?? null,
      value: pending.safeTxData?.value ?? null,
      data: pending.safeTxData?.data ?? null,
    },
    createdAt: pending.createdAt,
    status: pending.superseded ? 'superseded' : 'awaiting',
  };
}

/**
 * Build a new SafeTx, persist it, and silently collect the free
 * signatures (mnemonic owners, vault unlocked — no ceremony). Never
 * touches a device and never executes: the caller (the signing board)
 * drives both, per user action.
 *
 * The chain is the caller's, not this module's assumption: the composing
 * screen decides which chain the user is sending on, and the calldata it
 * built is only meaningful there. Silently rebasing it onto the deployment
 * chain would spend the wrong native token, or call a token address that
 * holds no code on this chain — a CALL that succeeds, burns the Safe nonce
 * and records a transfer that moved nothing. Safes exist on exactly one
 * chain here, so a mismatch is refused rather than translated.
 *
 * @param {Object} params
 * @param {number} params.safeIndex
 * @param {number} params.chainId - the chain the send was composed on
 * @param {Object} params.tx - {to, value, data?} the Safe should execute
 * @param {Object} params.display - Presentation-ready payment facts,
 *   persisted verbatim for the board/card: {toAddress, recipientName?,
 *   asset, amount (atomic), symbol, decimals, formattedAmount}
 * @param {{id: string, page: object|null}} params.approval - The Safe
 *   approval its `safe-send` token gave (design 0012): held for the SafeTx
 *   once built, and ended if it isn't
 * @returns {Promise<Object>} SafeSendState
 */
async function startSafeSend({ safeIndex, tx, display, chainId, approval }) {
  let held = false;
  try {
    if (!safeApprovals.isApproval(approval)) throw new Error('This transaction was not confirmed');
    const record = getSafeRecord(safeIndex);
    const sendChainId = Number(chainId);
    if (!Number.isInteger(sendChainId) || sendChainId !== DEPLOY_CHAIN_ID) {
      throw new Error('Multi-signature accounts can only send on Gnosis');
    }
    // Only a verified check's mark counts (#1066): a Safe still pending
    // verification is refused like one not yet activated.
    if (!isMarkedDeployed(record, DEPLOY_CHAIN_ID)) {
      throw new Error('Activate this account on Gnosis before sending');
    }
    assertNoPendingSafeSend(safeIndex);

    acquire(safeIndex);
    try {
      const built = await buildSafeTransaction({
        chainId: sendChainId,
        safe: { ...record, owners: resolveOwnerAddresses(record.owners) },
        tx,
      });
      setPending(safeIndex, {
        chainId: sendChainId,
        safeAddress: built.safeAddress,
        safeTxData: built.safeTxData,
        safeTxHash: built.safeTxHash,
        typedData: built.typedData,
        threshold: record.threshold,
        display,
        signatures: [],
        createdAt: Date.now(),
      });
      await safeApprovals.hold(SEND, safeIndex, approval, built.safeTxHash);
      held = true;
      await collectFreeSignatures(store, safeIndex, record.owners);
    } finally {
      release(safeIndex);
    }
  } finally {
    // An approval for no SafeTx main holds: ended.
    if (!held) await safeApprovals.release(approval);
  }
  return getSafeSendState(safeIndex);
}

/**
 * Refuses (SAFE_PENDING_EXISTS) while the Safe has a pending SafeTx: one at
 * a time. Asked before a new `safe-send` token is spent, too, since the
 * core's new approval for a Safe ends its older one.
 */
function assertNoPendingSafeSend(safeIndex) {
  if (getPending(safeIndex)) {
    throw codedError(
      'A transaction is already waiting for signatures — finish or discard it first',
      SAFE_PENDING_EXISTS
    );
  }
}

/**
 * Collect exactly one owner's signature — the user tapped that row, the
 * device is in their hand. Persists immediately. Errors (device not
 * connected, rejection, locked vault) leave the pending SafeTx intact;
 * they belong to the row, not the transaction.
 *
 * Called without an ownerIndex it instead sweeps the FREE signatures
 * (unsigned mnemonic owners, vault unlocked) — the board runs this on
 * open to cover a vault that was locked when the SafeTx was created.
 *
 * With `safeTxHash`, only that SafeTx is signed: another one pending is
 * refused (SAFE_DISCARDED), and so is a signature whose SafeTx was replaced
 * while it was made.
 *
 * Each owner presents the Safe approval main holds for the SafeTx. With
 * none (SAFE_APPROVAL_NEEDED), the board confirms the SafeTx again: a
 * wallet `safe-send` token for its call, spent through the core, whose
 * approval comes here as `approval` and is held for this SafeTx (design
 * 0012: "an owner that hasn't signed needs a new safe-send token from the
 * board"). It is the wallet's, so it isn't taken for a site's SafeTx whose
 * request still holds it (`guardSiteSafeSend`): its signatures stay the
 * page's.
 *
 * @param {number} safeIndex
 * @param {number} [ownerIndex]
 * @param {{ safeTxHash?: string, approval?: {id: string, page: null} }} [options]
 * @returns {Promise<Object>} SafeSendState
 */
async function signSafePending(safeIndex, ownerIndex, { safeTxHash = null, approval = null } = {}) {
  let taken = approval === null;
  try {
    const record = getSafeRecord(safeIndex);
    const pending = pendingNamed(safeIndex, safeTxHash);
    if (!pending) {
      throw new Error('No pending transaction for this account');
    }
    if (pending.superseded) {
      throw new Error('This transaction can no longer be signed — discard it');
    }
    if (approval !== null) {
      if (!safeApprovals.isApproval(approval) || approval.page !== null) {
        throw new Error('This transaction was not confirmed');
      }
      if (pending.display?.site && siteGuards.has(pending.safeTxHash)) {
        throw new Error('The site that asked for this transaction still holds it');
      }
      await safeApprovals.hold(SEND, safeIndex, approval, pending.safeTxHash);
      taken = true;
    }

    await signEntryOwner({ store, safeIndex, ownerIndex, ownerIndexes: record.owners, expectedId: pending.safeTxHash });
  } finally {
    if (!taken) await safeApprovals.release(approval);
  }
  return getSafeSendState(safeIndex);
}

/**
 * The call of the pending SafeTx `safeTxHash` (`{ tx: { to, value, data },
 * chainId }`), as a wallet `safe-send` token binds it, for confirming it
 * again (`signSafePending`'s `approval`); null when another one, or none,
 * is pending.
 */
function pendingCall(safeIndex, safeTxHash) {
  const pending = getPending(safeIndex);
  if (!pending || pending.safeTxHash !== safeTxHash || !pending.safeTxData) return null;
  const { to, value, data } = pending.safeTxData;
  return { tx: { to, value, data }, chainId: pending.chainId };
}

/**
 * Execute the fully-signed SafeTx through the executor EOA. Idempotent
 * and nonce-guarded: called automatically by the board at threshold and
 * re-called safely after any failure (signatures survive — the SafeTx
 * nonce only advances when an execution lands).
 *
 * The executor's fee is judged by the fee check at confirmation (design
 * 0005, A): one that needs the user stops the execution with nothing
 * signed and the SafeTx kept (FEE_CHECK_NEEDS_CONFIRMATION); it runs again
 * with `feeConfirmation`, the user's confirmation of that fee.
 *
 * With `safeTxHash`, only that SafeTx is executed: another one pending is
 * refused (SAFE_DISCARDED), nothing executed.
 *
 * @param {number} safeIndex
 * @param {{ feeConfirmation?: Object, safeTxHash?: string }} [options]
 * @returns {Promise<Object>} SafeSendState; on success carries
 *   `executed: {hash, explorerUrl}` (and the pending entry is cleared)
 */
async function executeSafePending(safeIndex, { feeConfirmation = null, safeTxHash = null } = {}) {
  const record = getSafeRecord(safeIndex);
  const pending = pendingNamed(safeIndex, safeTxHash);
  if (!pending) {
    throw new Error('No pending transaction for this account');
  }
  // A SafeTx saved while a release before #1066 trusted an unverified
  // deployed mark waits until a verified check marks the Safe again.
  if (!isMarkedDeployed(record, DEPLOY_CHAIN_ID)) {
    throw new Error('Activate this account on Gnosis before sending');
  }

  acquire(safeIndex);
  try {
    // Nonce guard: a moved nonce means this SafeTx can never execute —
    // an earlier broadcast landed after all, or the Safe was used
    // elsewhere (app.safe.global). Terminal, not retryable.
    const chainNonce = await chainSafeNonce(pending.safeAddress);
    if (chainNonce > BigInt(pending.safeTxData.nonce)) {
      // Superseded: its approval ended first (design 0012).
      await safeApprovals.end(SEND, safeIndex, pending.safeTxHash);
      pending.superseded = true;
      setPending(safeIndex, pending);
      return getSafeSendState(safeIndex);
    }

    if (pending.signatures.length < pending.threshold) {
      throw new Error(
        `Not enough signatures yet (${pending.signatures.length} of ${pending.threshold})`
      );
    }

    const guard = pending.display?.site ? siteGuards.get(pending.safeTxHash) : null;
    const execute = () =>
      execTransaction({
        chainId: pending.chainId,
        safeAddress: pending.safeAddress,
        safeTxData: pending.safeTxData,
        signatures: pending.signatures,
        executorIndex: pickDefaultExecutor(record.owners),
        feeConfirmation,
        record: {
          kind: PAYMENT_KINDS.SAFE_SEND,
          fromAddress: pending.safeAddress,
          toAddress: pending.display?.toAddress,
          asset: pending.display?.asset ?? null,
          amount: pending.display?.amount,
          // dApp-initiated sends carry the requesting site.
          ...(pending.display?.site ? { origin: pending.display.site } : {}),
          metadata: { safeAddress: pending.safeAddress, safeTxHash: pending.safeTxHash },
        },
        // And again at its last step, after the executor's signature.
        guardCommit: guard,
        // The executor presents the SafeTx's approval (design 0012), or its
        // 'executor-send' token.
        approval: safeApprovals.held(SEND, safeIndex, pending.safeTxHash),
      });
    let result;
    try {
      if (pending.display?.site) {
        // A site's SafeTx executes for the site only past its request's
        // check, just before the execution (guardSiteSafeSend).
        if (!guard) throw siteWithdrawn();
        result = await guard(execute);
      } else {
        result = await execute();
      }
    } catch (err) {
      if (err?.code === SAFE_SITE_WITHDRAWN) {
        // Not executed: kept, as the wallet's own, with no site, in every
        // record that has one. The held execution's intent first, durably
        // (a no-op when it has none, or none with a site); only then the
        // pending SafeTx. If the intent can't be rewritten, neither changes.
        try {
          await withdrawExecutionSite(pending.chainId, pending.safeTxHash);
        } catch (withdrawError) {
          console.warn('[SafeTransactions] A held execution kept its site for now:', withdrawError?.message);
          throw siteWithdrawing();
        }
        const { site: _site, ...display } = pending.display || {};
        setPending(safeIndex, { ...pending, display });
        throw siteWithdrawn();
      }
      if (/insufficient funds/i.test(err.message)) {
        err.code = SAFE_NEEDS_FUNDS;
      }
      throw err;
    }

    const state = getSafeSendState(safeIndex);
    // Executed: its approval ended (the executor's signature ended it in the
    // core as well), then the entry cleared.
    await safeApprovals.end(SEND, safeIndex, pending.safeTxHash);
    clearPending(safeIndex);
    settled({ safeIndex, safeTxHash: pending.safeTxHash, outcome: 'executed', hash: result.hash });
    return { ...state, status: 'executed', executed: { hash: result.hash, explorerUrl: result.explorerUrl } };
  } finally {
    release(safeIndex);
  }
}

/**
 * Render models of every pending SafeTx, across all Safes — the wallet's
 * "unfinished transactions" overview.
 * @returns {Array<Object>} SafeSendStates, oldest first
 */
function getAllSafeSendStates() {
  return listPendingIndexes()
    .map((safeIndex) => getSafeSendState(safeIndex))
    .filter(Boolean)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Discard the pending SafeTx (collected signatures are thrown away).
 * Refused while a signature ceremony or the execution is live. With
 * `safeTxHash`, only that SafeTx is discarded: another one pending, or none,
 * is refused (SAFE_DISCARDED), nothing discarded. Its Safe approval is
 * ended first (design 0012), the Safe held meanwhile, so no step starts
 * between the two.
 */
async function cancelSafeSend(safeIndex, { safeTxHash = null } = {}) {
  if (isBusy(safeIndex)) {
    throw codedError('Wait for the current step to finish first', SAFE_BUSY);
  }
  const pending = pendingNamed(safeIndex, safeTxHash);
  acquire(safeIndex);
  try {
    if (pending) await safeApprovals.end(SEND, safeIndex, pending.safeTxHash);
    clearPending(safeIndex);
  } finally {
    release(safeIndex);
  }
  if (pending) settled({ safeIndex, safeTxHash: pending.safeTxHash, outcome: 'discarded' });
}

module.exports = {
  startSafeSend,
  assertNoPendingSafeSend,
  pendingCall,
  signSafePending,
  executeSafePending,
  getSafeSendState,
  getAllSafeSendStates,
  cancelSafeSend,
  onSafeSendSettled,
  guardSiteSafeSend,
};
