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
 */

const { KINDS: PAYMENT_KINDS } = require('../tx-recorder');
const { buildSafeTransaction, execTransaction, pickDefaultExecutor } = require('./safe-executor');
const {
  getSafeRecord,
  resolveOwnerAddresses,
  chainRead,
  DEPLOY_CHAIN_ID,
} = require('./safe-service');
const { getPending, setPending, clearPending, listPendingIndexes } = require('./pending-store');
const { codedError, SAFE_BUSY, SAFE_PENDING_EXISTS, SAFE_NEEDS_FUNDS } = require('./errors');
const {
  acquire,
  release,
  isBusy,
  ownersView,
  collectFreeSignatures,
  signEntryOwner,
} = require('./signature-collection');

// The signature-collection store over the persisted pending-SafeTx
// entries; the SafeTx hash is the entry's identity.
const store = { get: getPending, set: setPending, idOf: (entry) => entry.safeTxHash };

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
 * @returns {Promise<Object>} SafeSendState
 */
async function startSafeSend({ safeIndex, tx, display, chainId }) {
  const record = getSafeRecord(safeIndex);
  const sendChainId = Number(chainId);
  if (!Number.isInteger(sendChainId) || sendChainId !== DEPLOY_CHAIN_ID) {
    throw new Error('Multi-signature accounts can only send on Gnosis');
  }
  if (!record.deployed?.[DEPLOY_CHAIN_ID]) {
    throw new Error('Activate this account on Gnosis before sending');
  }
  if (getPending(safeIndex)) {
    throw codedError(
      'A transaction is already waiting for signatures — finish or discard it first',
      SAFE_PENDING_EXISTS
    );
  }

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
    await collectFreeSignatures(store, safeIndex, record.owners);
  } finally {
    release(safeIndex);
  }
  return getSafeSendState(safeIndex);
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
 * @param {number} safeIndex
 * @param {number} [ownerIndex]
 * @returns {Promise<Object>} SafeSendState
 */
async function signSafePending(safeIndex, ownerIndex) {
  const record = getSafeRecord(safeIndex);
  const pending = getPending(safeIndex);
  if (!pending) {
    throw new Error('No pending transaction for this account');
  }
  if (pending.superseded) {
    throw new Error('This transaction can no longer be signed — discard it');
  }

  await signEntryOwner({ store, safeIndex, ownerIndex, ownerIndexes: record.owners });
  return getSafeSendState(safeIndex);
}

/**
 * Execute the fully-signed SafeTx through the executor EOA. Idempotent
 * and nonce-guarded: called automatically by the board at threshold and
 * re-called safely after any failure (signatures survive — the SafeTx
 * nonce only advances when an execution lands).
 *
 * @param {number} safeIndex
 * @returns {Promise<Object>} SafeSendState; on success carries
 *   `executed: {hash, explorerUrl}` (and the pending entry is cleared)
 */
async function executeSafePending(safeIndex) {
  const record = getSafeRecord(safeIndex);
  const pending = getPending(safeIndex);
  if (!pending) {
    throw new Error('No pending transaction for this account');
  }

  acquire(safeIndex);
  try {
    // Nonce guard: a moved nonce means this SafeTx can never execute —
    // an earlier broadcast landed after all, or the Safe was used
    // elsewhere (app.safe.global). Terminal, not retryable.
    const chainNonce = await chainSafeNonce(pending.safeAddress);
    if (chainNonce > BigInt(pending.safeTxData.nonce)) {
      pending.superseded = true;
      setPending(safeIndex, pending);
      return getSafeSendState(safeIndex);
    }

    if (pending.signatures.length < pending.threshold) {
      throw new Error(
        `Not enough signatures yet (${pending.signatures.length} of ${pending.threshold})`
      );
    }

    let result;
    try {
      result = await execTransaction({
        chainId: pending.chainId,
        safeAddress: pending.safeAddress,
        safeTxData: pending.safeTxData,
        signatures: pending.signatures,
        executorIndex: pickDefaultExecutor(record.owners),
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
      });
    } catch (err) {
      if (/insufficient funds/i.test(err.message)) {
        err.code = SAFE_NEEDS_FUNDS;
      }
      throw err;
    }

    const state = getSafeSendState(safeIndex);
    clearPending(safeIndex);
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
 * Refused while a signature ceremony or the execution is live.
 */
function cancelSafeSend(safeIndex) {
  if (isBusy(safeIndex)) {
    throw codedError('Wait for the current step to finish first', SAFE_BUSY);
  }
  clearPending(safeIndex);
}

module.exports = {
  startSafeSend,
  signSafePending,
  executeSafePending,
  getSafeSendState,
  getAllSafeSendStates,
  cancelSafeSend,
};
