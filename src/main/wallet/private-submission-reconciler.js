/** RPC observations are unverified, including their claimed canonical chain.
 * Reconciliation never signs, broadcasts, or automatically permits another send.
 */
const { privacyError } = require('../networks/privacy-context');
const { isQuantity } = require('../networks/private-rpc');
const hash = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const quantity = (value) => isQuantity(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
const unavailable = () => privacyError('PRIVATE_RECONCILIATION_UNAVAILABLE', 'Current submission evidence is unavailable');

function createSubmissionReconciler({ rpc, journal, principal, assertActive }) {
  async function consumedNonce(record) {
    const readBlock = async (tag) => (await rpc.request('eth_getBlockByNumber', [tag, false], (value) => value === null ||
      (value && hash(value.hash) && quantity(value.number) && (tag === 'finalized' || BigInt(value.number) === BigInt(tag))))).result;
    const final = await readBlock('finalized');
    if (!final) throw unavailable();
    const prior = record.observation?.status === 'nonce-consumed' ? record.observation : null;
    const tag = prior ? `0x${prior.blockNumber.toString(16)}` : final.number;
    if (BigInt(final.number) < BigInt(tag)) throw unavailable();
    const anchor = await readBlock(tag);
    if (!anchor) throw unavailable();
    if (!prior && anchor.hash.toLowerCase() !== final.hash.toLowerCase()) throw unavailable();
    if (prior && anchor.hash.toLowerCase() !== prior.blockHash) return { status: 'reorged' };
    const { result: nonce } = await rpc.request('eth_getTransactionCount', [principal, tag], quantity);
    const after = await readBlock(tag);
    if (!after || after.hash.toLowerCase() !== anchor.hash.toLowerCase()) throw unavailable();
    if (BigInt(nonce) <= BigInt(record.nonce)) return prior ? { status: 'reorged' } : null;
    const { result: head } = await rpc.request('eth_blockNumber', [], quantity);
    if (BigInt(head) < BigInt(tag)) throw unavailable();
    const confirmations = Number(BigInt(head) - BigInt(tag) + 1n);
    if (!Number.isSafeInteger(confirmations)) throw unavailable();
    // This proves only that the nonce can no longer be used on the observed
    // chain. It does not distinguish the original transaction from a replacement.
    return { status: 'nonce-consumed', blockNumber: Number(BigInt(tag)), blockHash: anchor.hash.toLowerCase(),
      confirmations, finalizedNonce: Number(BigInt(nonce)) };
  }
  async function observe(transactionHash) {
    assertActive();
    const records = await journal.list();
    const record = records.find((entry) => entry.hash === transactionHash?.toLowerCase());
    if (!record) throw privacyError('PRIVATE_TRANSACTION_REQUEST_REFUSED', 'Submission is outside this context');
    const txHash = record.hash;
    const { result: receipt } = await rpc.request('eth_getTransactionReceipt', [txHash], (value) => value === null ||
      (value && value.transactionHash?.toLowerCase() === txHash && value.from?.toLowerCase() === principal &&
        ['0x0', '0x1'].includes(value.status) && hash(value.blockHash) && quantity(value.blockNumber)));
    let status, blockNumber = null, blockHash = null, confirmations = 0, finalizedNonce;
    if (receipt) {
      blockNumber = Number(BigInt(receipt.blockNumber)); blockHash = receipt.blockHash.toLowerCase();
      const { result: block } = await rpc.request('eth_getBlockByNumber', [receipt.blockNumber, false], (value) =>
        value === null || (value && hash(value.hash) && quantity(value.number) && BigInt(value.number) === BigInt(receipt.blockNumber)));
      const { result: head } = await rpc.request('eth_blockNumber', [], quantity);
      if (!block || BigInt(head) < BigInt(receipt.blockNumber)) throw unavailable();
      if (block.hash.toLowerCase() !== blockHash) {
        status = 'reorged'; blockNumber = null; blockHash = null;
      } else {
        status = receipt.status === '0x1' ? 'included' : 'reverted';
        confirmations = Number(BigInt(head) - BigInt(receipt.blockNumber) + 1n);
        if (!Number.isSafeInteger(confirmations)) throw privacyError('PRIVATE_RPC_INVALID', 'Invalid confirmation depth');
      }
    } else if (['included', 'reverted'].includes(record.observation?.status)) {
      // A pruned/lagging transaction index does not prove a reorg. Revalidate
      // the previously reviewed inclusion through its canonical block instead.
      const prior = record.observation;
      const { result: block } = await rpc.request('eth_getBlockByNumber', [`0x${prior.blockNumber.toString(16)}`, false],
        (value) => value === null || (value && hash(value.hash) && quantity(value.number) && Number(BigInt(value.number)) === prior.blockNumber));
      if (!block) throw unavailable();
      if (block.hash.toLowerCase() !== prior.blockHash) status = 'reorged';
      else {
        if (!Array.isArray(block.transactions) || block.transactions.length > 32768 || !block.transactions.every(hash) ||
            !block.transactions.some((value) => value.toLowerCase() === txHash)) throw unavailable();
        const { result: head } = await rpc.request('eth_blockNumber', [], quantity);
        if (BigInt(head) < BigInt(prior.blockNumber)) throw unavailable();
        status = prior.status; blockNumber = prior.blockNumber; blockHash = prior.blockHash;
        confirmations = Number(BigInt(head) - BigInt(blockNumber) + 1n);
        if (!Number.isSafeInteger(confirmations)) throw unavailable();
      }
    } else {
      const { result: transaction } = await rpc.request('eth_getTransactionByHash', [txHash], (value) => value === null ||
        (value && value.hash?.toLowerCase() === txHash && value.from?.toLowerCase() === principal &&
          quantity(value.nonce) && Number(BigInt(value.nonce)) === record.nonce &&
          (value.blockHash === null || hash(value.blockHash))));
      // A transaction object without a receipt establishes no inclusion.
      status = transaction ? 'pending' : 'unknown';
      if (!transaction) {
        const consumed = await consumedNonce(record);
        if (consumed) ({ status, blockNumber = null, blockHash = null, confirmations = 0, finalizedNonce } = consumed);
      }
    }
    assertActive();
    const observation = { status, blockNumber, blockHash, confirmations, observedAt: Date.now(), trust: 'unverified',
      ...(finalizedNonce === undefined ? {} : { finalizedNonce }) };
    return journal.observe(txHash, observation, record.revision || 0);
  }

  async function refreshResolved(signal) {
    if (signal?.aborted) throw unavailable();
    const records = (await journal.list()).filter((record) => record.resolution);
    if (!records.length) return;
    const { result: head } = await rpc.request('eth_blockNumber', [], quantity);
    for (let offset = 0; offset < records.length; offset += 2) {
      if (signal?.aborted) throw unavailable();
      const results = await Promise.allSettled(records.slice(offset, offset + 2).map(async (record) => {
        const prior = record.observation;
        const { result: canonical } = await rpc.request('eth_getBlockByNumber', [`0x${prior.blockNumber.toString(16)}`, false],
          (value) => value === null || (value && hash(value.hash) && quantity(value.number)));
        if (!canonical || Number(BigInt(canonical.number)) !== prior.blockNumber || BigInt(head) < BigInt(prior.blockNumber)) throw unavailable();
        const matches = canonical.hash.toLowerCase() === prior.blockHash;
        const confirmations = Number(BigInt(head) - BigInt(prior.blockNumber) + 1n);
        if (!Number.isSafeInteger(confirmations)) throw unavailable();
        const observation = matches ? { ...prior, confirmations, observedAt: Date.now() } :
          { status: 'reorged', blockNumber: null, blockHash: null, confirmations: 0, observedAt: Date.now(), trust: 'unverified' };
        assertActive(); if (signal?.aborted) throw unavailable();
        await journal.observe(record.hash, observation, record.revision || 0);
      }));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
  }

  async function resolve(transactionHash, { minimumConfirmations, review, reviewTimeoutMs = 120000 } = {}) {
    if (!Number.isSafeInteger(minimumConfirmations) || minimumConfirmations < 1 || minimumConfirmations > 100000 ||
        typeof review !== 'function' || !Number.isSafeInteger(reviewTimeoutMs) || reviewTimeoutMs < 1 || reviewTimeoutMs > 120000) {
      throw privacyError('PRIVATE_RECONCILIATION_REVIEW_REQUIRED', 'An explicit reconciliation policy and review are required');
    }
    const eligible = (record) => ['included', 'reverted', 'nonce-consumed'].includes(record.observation?.status) &&
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
        before.observation.blockNumber !== after.observation.blockNumber || before.observation.status !== after.observation.status ||
        before.observation.finalizedNonce !== after.observation.finalizedNonce) {
      throw privacyError('PRIVATE_REVIEW_STALE', 'Submission evidence changed or its review expired');
    }
    assertActive();
    return journal.resolve(after.hash, after.revision, minimumConfirmations);
  }
  return Object.freeze({ observe, resolve, refreshResolved });
}

module.exports = { createSubmissionReconciler };
