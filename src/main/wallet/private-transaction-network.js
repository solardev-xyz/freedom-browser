/** Internal transaction transport experiment. No IPC or setting activates it.
 * A caller must own a transaction-rpc context and a reviewed transaction.
 */
const { Transaction } = require('ethers');
const { createPrivateRpc, isQuantity } = require('../networks/private-rpc');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const { validIntent, transactionIntent } = require('./private-transaction-intent');
const clients = new WeakMap();
const address = (value) => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const hash = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const data = (value) => typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value) && value.length <= 131074;

function getPrivateTransactionNetwork(handle) {
  getPrivacyContext(handle);
  const cached = clients.get(handle);
  if (cached && !cached.signal.aborted) return cached;
  clients.delete(handle);
  const rpc = createPrivateRpc(handle, 'transaction-rpc');
  const context = getPrivacyContext(handle);
  const { chainId, principal } = context.subject;
  const journal = () => require('./private-submission-journal').getPrivateSubmissionJournal(handle);
  let reconciler;
  const reconciliation = () => reconciler ||= require('./private-submission-reconciler').createSubmissionReconciler({
    rpc, journal: journal(), principal, assertActive,
  });
  async function assertCanSubmit(signal) {
    assertActive();
    await journal().assertCanSubmit();
    await reconciliation().refreshResolved(signal);
    await journal().assertCanSubmit();
    assertActive();
  }

  function assertActive(requestChain = chainId) {
    getPrivacyContext(handle, requestChain);
    rpc.assertActive();
  }
  function assertSigner(signerAddress) {
    assertActive();
    if (!address(signerAddress) || signerAddress.toLowerCase() !== principal) {
      throw privacyError('PRIVATE_SIGNER_MISMATCH', 'Signer does not own the transaction context');
    }
  }
  async function request(requestChain, method, params = []) {
    assertActive(requestChain);
    let allowed = false;
    let validate = isQuantity;
    if (method === 'eth_getTransactionCount') {
      allowed = params.length === 2 && params[0]?.toLowerCase?.() === principal && params[1] === 'pending';
      validate = (value) => isQuantity(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
    } else if (['eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_blockNumber'].includes(method)) {
      allowed = params.length === 0;
    } else if (['eth_call', 'eth_estimateGas'].includes(method)) {
      const tx = params[0];
      allowed = tx && address(tx.from) && tx.from.toLowerCase() === principal && address(tx.to) &&
        Object.keys(tx).every((key) => ['from', 'to', 'value', 'data', 'gas'].includes(key)) &&
        (tx.value === undefined || isQuantity(tx.value)) && (tx.gas === undefined || isQuantity(tx.gas)) &&
        (tx.data === undefined || data(tx.data)) &&
        (method === 'eth_estimateGas' ? params.length === 1 : params.length === 2 && params[1] === 'latest');
      if (method === 'eth_call') validate = data;
    } else if (['eth_getTransactionReceipt', 'eth_getTransactionByHash'].includes(method)) {
      allowed = params.length === 1 && hash(params[0]) && await journal().has(params[0].toLowerCase());
      validate = (value) => value === null || (value && !Array.isArray(value) && (
        method === 'eth_getTransactionReceipt'
          ? value.transactionHash?.toLowerCase() === params[0].toLowerCase() &&
            ['0x0', '0x1'].includes(value.status) && isQuantity(value.blockNumber) && isQuantity(value.gasUsed) &&
            (value.effectiveGasPrice === undefined || isQuantity(value.effectiveGasPrice))
          : value.hash?.toLowerCase() === params[0].toLowerCase() && value.from?.toLowerCase() === principal));
    }
    if (!allowed) throw privacyError('PRIVATE_TRANSACTION_REQUEST_REFUSED', 'Transaction request is outside this context');
    return rpc.request(method, params, validate);
  }
  async function getFeeQuote(requestChain) {
    const { result } = await request(requestChain, 'eth_gasPrice');
    if (BigInt(result) <= 0n) throw privacyError('PRIVATE_FEE_INVALID', 'No usable transaction fee');
    // A coherent legacy quote is sufficient for this technical experiment.
    // Product fee presets remain on the established ordinary-wallet path.
    return { type: 'legacy', gasPrice: BigInt(result).toString(), effectiveGasPrice: BigInt(result).toString(), source: 'direct', verified: false };
  }
  async function broadcastRawTransaction(requestChain, signed, { expiresAt, intent } = {}) {
    assertActive(requestChain);
    if (!data(signed)) throw privacyError('PRIVATE_SIGNED_TX_INVALID', 'Invalid signed transaction');
    let transaction;
    try { transaction = Transaction.from(signed); } catch {
      throw privacyError('PRIVATE_SIGNED_TX_INVALID', 'Invalid signed transaction');
    }
    if (!transaction.isSigned() || transaction.chainId !== BigInt(chainId)) {
      throw privacyError('PRIVATE_SIGNED_TX_INVALID', 'Signed transaction has the wrong chain');
    }
    assertSigner(transaction.from);
    if (intent !== undefined) {
      if (!validIntent(intent) || transactionIntent(intent.kind, transaction).digest !== intent.digest) {
        throw privacyError('PRIVATE_INTENT_INVALID', 'Signed transaction differs from its operation intent');
      }
      intent = Object.freeze({ ...intent });
    }
    const txHash = transaction.hash.toLowerCase();
    const assertDeadline = () => {
      if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt)) {
        throw privacyError('PRIVATE_REVIEW_EXPIRED', 'Transaction review expired');
      }
    };
    assertDeadline();
    if (await journal().has(txHash)) throw Object.assign(privacyError('PRIVATE_BROADCAST_ALREADY_ATTEMPTED', 'Query the existing submission before any further action'), { transactionHash: txHash });
    await assertCanSubmit();
    await rpc.ready();
    assertActive(); assertDeadline();
    // Atomic encrypted write + fsync must succeed before transport sees bytes.
    // If the process dies at any later instruction, recovery treats this hash
    // as possibly submitted. The journal never contains the signed bytes.
    await journal().begin(txHash, transaction.nonce, intent);
    try {
      assertActive(); assertDeadline();
      const response = await rpc.request('eth_sendRawTransaction', [signed], (result) => hash(result) && result.toLowerCase() === txHash);
      await journal().markSubmitted(txHash);
      assertActive();
      return response;
    } catch {
      throw Object.assign(privacyError('PRIVATE_BROADCAST_UNCERTAIN', 'Transaction submission outcome is unknown'), { transactionHash: txHash, submissionStatus: 'unknown' });
    }
  }
  const client = Object.freeze({ request, getFeeQuote, broadcastRawTransaction, assertSigner, assertActive, signal: rpc.signal,
    assertCanSubmit, listSubmissions: () => journal().list(),
    reconcileSubmission: (hash) => reconciliation().observe(hash),
    resolveSubmission: (hash, policy) => reconciliation().resolve(hash, policy) });
  clients.set(handle, client);
  return client;
}

function assertSignedIntent(signed, intended) {
  try {
    const actual = Transaction.from(signed);
    if (actual.isSigned() && actual.unsignedSerialized === Transaction.from(intended).unsignedSerialized) return;
  } catch { /* Malformed signer output is rejected with the same fixed diagnostic. */ }
  throw privacyError('PRIVATE_SIGNED_INTENT_MISMATCH', 'Signer output differs from the reviewed transaction');
}

module.exports = { getPrivateTransactionNetwork, assertSignedIntent };
