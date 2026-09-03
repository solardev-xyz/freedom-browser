/**
 * History writes are best-effort: a store-side failure logs and lets the
 * tx through (broadcast already returned). Confirmation is polled in the
 * background; if the app exits before resolution, payment-history's
 * repollPending picks the row up on next boot.
 */

const log = require('../logger');
const { signAndSendTransaction, waitForTransaction } = require('./transaction-service');
const paymentHistory = require('../payment-history');
const { KINDS, STATUSES } = paymentHistory;

// JSON-RPC eth_sendTransaction.value is hex-encoded ("0x123abc"); the
// payment-history schema stores atomic units as a decimal digit string.
// BigInt accepts both shapes; toString(10) normalises.
function toAtomicDecimal(value) {
  if (value === undefined || value === null || value === '') return '0';
  return BigInt(value).toString(10);
}

/**
 * @param {object} params       Same shape as signAndSendTransaction.
 * @param {import('./signers').Signer} signer
 * @param {object} context
 * @param {string} context.kind         paymentHistory.KINDS member
 * @param {string} [context.origin]     normalised origin (dapp sends only)
 * @param {string} [context.fromAddress] human-visible sender; defaults to the
 *                                      signer's address (which is the *executor*
 *                                      for Safe txs, not the paying account —
 *                                      pass the safe address explicitly there)
 * @param {string} [context.asset]      ERC-20 contract address (null = native)
 * @param {string} [context.amount]     atomic units; defaults to params.value
 *                                      (which is 0 for ERC-20 transfers — pass
 *                                      this explicitly when you have the human
 *                                      amount on hand)
 * @param {string} [context.toAddress]  human-visible recipient; defaults to
 *                                      params.to (which is the *contract*
 *                                      address for ERC-20 transfers, not the
 *                                      recipient — pass this explicitly when
 *                                      you have the real recipient)
 * @param {object} [context.metadata]   free-form per-kind extras
 */
async function signAndRecord(params, signer, context) {
  const response = await signAndSendTransaction(params, signer);

  let row;
  try {
    row = paymentHistory.append({
      kind: context.kind,
      chainId: params.chainId,
      txHash: response.hash,
      fromAddress: context.fromAddress ?? response.from,
      toAddress: context.toAddress ?? params.to,
      asset: context.asset ?? null,
      amount: toAtomicDecimal(context.amount ?? params.value),
      origin: context.origin ?? null,
      metadata: context.metadata,
    });
  } catch (err) {
    log.error('[TxRecorder] failed to record pending row:', err.message);
    return { ...response, recorded: false, recordError: err.message };
  }

  waitForTransaction(response.hash, params.chainId)
    .then((receipt) => {
      const gas = { gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice };
      try {
        if (receipt.status === STATUSES.CONFIRMED) {
          paymentHistory.markConfirmed(row.id, gas);
        } else {
          paymentHistory.markFailed(row.id, gas);
        }
      } catch (err) {
        // The store throws when the DB closes mid-poll (app quitting). Log
        // and drop; repollPending on next boot resolves the row from chain.
        log.warn(`[TxRecorder] post-receipt write failed for row ${row.id}: ${err.message}`);
      }
    })
    .catch((err) => {
      // A timeout doesn't mean the tx failed; leave the row pending and
      // let repollPending sort it out on next boot.
      log.warn(`[TxRecorder] waitForTransaction failed for row ${row.id}: ${err.message}`);
    });

  return { ...response, recorded: true, paymentId: row.id };
}

module.exports = { signAndRecord, KINDS };
