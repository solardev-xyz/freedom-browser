/** RPC observations are unverified, including their claimed canonical chain.
 * Reconciliation never signs, broadcasts, or automatically permits another send.
 */
const { privacyError } = require('../networks/privacy-context');
const { isQuantity } = require('../networks/private-rpc');
const hash = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const quantity = (value) => isQuantity(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);

function createSubmissionReconciler({ rpc, journal, principal, assertActive }) {
  async function observe(transactionHash) {
    assertActive();
    const records = await journal.list();
    const record = records.find((entry) => entry.hash === transactionHash?.toLowerCase());
    if (!record) throw privacyError('PRIVATE_TRANSACTION_REQUEST_REFUSED', 'Submission is outside this context');
    const txHash = record.hash;
    const { result: receipt } = await rpc.request('eth_getTransactionReceipt', [txHash], (value) => value === null ||
      (value && value.transactionHash?.toLowerCase() === txHash && value.from?.toLowerCase() === principal &&
        ['0x0', '0x1'].includes(value.status) && hash(value.blockHash) && quantity(value.blockNumber)));
    let status, blockNumber = null, blockHash = null, confirmations = 0;
    if (receipt) {
      blockNumber = Number(BigInt(receipt.blockNumber)); blockHash = receipt.blockHash.toLowerCase();
      const { result: block } = await rpc.request('eth_getBlockByNumber', [receipt.blockNumber, false], (value) =>
        value === null || (value && hash(value.hash) && quantity(value.number) && BigInt(value.number) === BigInt(receipt.blockNumber)));
      const { result: head } = await rpc.request('eth_blockNumber', [], quantity);
      if (!block || block.hash.toLowerCase() !== blockHash || BigInt(head) < BigInt(receipt.blockNumber)) {
        status = 'reorged'; blockNumber = null; blockHash = null;
      } else {
        status = receipt.status === '0x1' ? 'included' : 'reverted';
        confirmations = Number(BigInt(head) - BigInt(receipt.blockNumber) + 1n);
        if (!Number.isSafeInteger(confirmations)) throw privacyError('PRIVATE_RPC_INVALID', 'Invalid confirmation depth');
      }
    } else {
      const { result: transaction } = await rpc.request('eth_getTransactionByHash', [txHash], (value) => value === null ||
        (value && value.hash?.toLowerCase() === txHash && value.from?.toLowerCase() === principal &&
          quantity(value.nonce) && Number(BigInt(value.nonce)) === record.nonce &&
          (value.blockHash === null || hash(value.blockHash))));
      // A transaction object without a receipt establishes no inclusion.
      status = record.observation?.blockHash ? 'reorged' : transaction ? 'pending' : 'unknown';
    }
    assertActive();
    const observation = { status, blockNumber, blockHash, confirmations, observedAt: Date.now(), trust: 'unverified' };
    return journal.observe(txHash, observation, record.revision || 0);
  }

  async function resolve(transactionHash, { minimumConfirmations, review, reviewTimeoutMs = 120000 } = {}) {
    if (!Number.isSafeInteger(minimumConfirmations) || minimumConfirmations < 1 || minimumConfirmations > 100000 ||
        typeof review !== 'function' || !Number.isSafeInteger(reviewTimeoutMs) || reviewTimeoutMs < 1 || reviewTimeoutMs > 120000) {
      throw privacyError('PRIVATE_RECONCILIATION_REVIEW_REQUIRED', 'An explicit reconciliation policy and review are required');
    }
    const eligible = (record) => ['included', 'reverted'].includes(record.observation?.status) &&
      record.observation.confirmations >= minimumConfirmations;
    const before = await observe(transactionHash);
    if (!eligible(before)) throw privacyError('PRIVATE_SUBMISSION_UNRESOLVED', 'Submission is not ready for reconciliation review');
    const expiresAt = Date.now() + reviewTimeoutMs;
    const deadline = AbortSignal.timeout(reviewTimeoutMs);
    const signal = AbortSignal.any([rpc.signal, deadline]);
    const decision = await new Promise((resolve, reject) => {
      const abort = () => reject(privacyError('PRIVACY_REQUEST_ABORTED', 'Reconciliation review cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => {
        assertActive(); if (signal.aborted) throw privacyError('PRIVACY_REQUEST_ABORTED', 'Reconciliation review cancelled');
        return review(Object.freeze({ action: 'allow-next-transaction', transactionHash: before.hash,
          nonce: before.nonce, observation: before.observation, minimumConfirmations, expiresAt }));
      }).then(resolve, () => reject(privacyError('PRIVATE_REVIEW_REJECTED', 'Reconciliation review failed')))
        .finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
    assertActive();
    if (decision?.allowNextTransaction !== true || decision.acceptedEvidence !== 'unverified-rpc') {
      throw privacyError('PRIVATE_REVIEW_REJECTED', 'Unverified reconciliation evidence was not explicitly accepted');
    }
    const after = await observe(transactionHash);
    if (Date.now() >= expiresAt || !eligible(after) || before.observation.blockHash !== after.observation.blockHash ||
        before.observation.blockNumber !== after.observation.blockNumber || before.observation.status !== after.observation.status) {
      throw privacyError('PRIVATE_REVIEW_STALE', 'Submission evidence changed or its review expired');
    }
    assertActive();
    return journal.resolve(after.hash, after.revision, minimumConfirmations);
  }
  return Object.freeze({ observe, resolve });
}

module.exports = { createSubmissionReconciler };
