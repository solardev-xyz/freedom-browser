/**
 * Transaction Service
 *
 * Handles gas estimation, transaction building, and broadcasting.
 * Signing is delegated to a Signer (see ./signers.js), so this module
 * never touches key material.
 */

const { parseUnits, formatUnits, Interface, Transaction } = require('ethers');
const chainData = require('../networks/chain-data-router');
const { getTxExplorerUrl } = require('./chains');
const { REMOTE_ERROR_CODES, createRemoteError } = require('./remote/errors');

// ERC-20 transfer function interface
const ERC20_INTERFACE = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/**
 * Estimate gas for a transaction
 * @param {Object} params - Transaction parameters
 * @param {string} params.from - Sender address
 * @param {string} params.to - Recipient address
 * @param {string} params.value - Value in wei (as string)
 * @param {string} [params.data] - Transaction data (for token transfers)
 * @param {number} params.chainId - Chain ID
 * @returns {Promise<{gasLimit: string, error?: string}>}
 */
async function estimateGas({ from, to, value, data, chainId }) {
  try {
    const tx = {
      from,
      to,
      value: value || '0',
    };

    if (data) {
      tx.data = data;
    }

    const { result } = await chainData.request(chainId, 'eth_estimateGas', [tx]);
    const gasLimit = BigInt(result);

    // Add 20% buffer for safety
    const bufferedGas = (gasLimit * 120n) / 100n;

    return {
      gasLimit: bufferedGas.toString(),
    };
  } catch (err) {
    console.error('[TransactionService] Gas estimation failed:', err);
    throw new Error(`Gas estimation failed: ${err.message}`, { cause: err });
  }
}

/**
 * Get current gas prices for a chain
 * Returns EIP-1559 fee data with market preset
 * @param {number} chainId - Chain ID
 * @returns {Promise<Object>} Gas price data
 */
async function getGasPrices(chainId) {
  try {
    const quote = await chainData.getFeeQuote(chainId);
    console.log('[TransactionService] Fee quote:', {
      chainId,
      type: quote.type,
      source: quote.source,
      maxFeePerGas: quote.maxFeePerGas,
      maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
      gasPrice: quote.gasPrice,
    });
    return quote;
  } catch (err) {
    console.error('[TransactionService] Failed to get gas prices:', err);
    throw new Error(`Failed to get gas prices: ${err.message}`, { cause: err });
  }
}

/**
 * getGasPrices result → the fee fields buildTransaction / send params
 * expect, so callers don't re-derive the eip1559-vs-legacy branch.
 * @param {Object} gasPrices - Result of getGasPrices
 * @returns {{maxFeePerGas: string, maxPriorityFeePerGas: string}|{gasPrice: string}}
 */
function toFeeFields(gasPrices) {
  return gasPrices.type === 'eip1559'
    ? {
        maxFeePerGas: gasPrices.maxFeePerGas,
        maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
      }
    : { gasPrice: gasPrices.gasPrice };
}

/**
 * Build ERC-20 transfer calldata
 * @param {string} to - Recipient address
 * @param {string} amount - Amount in token's smallest unit (as string)
 * @returns {string} Encoded calldata
 */
function buildErc20TransferData(to, amount) {
  return ERC20_INTERFACE.encodeFunctionData('transfer', [to, amount]);
}

/**
 * Parse amount string to wei/smallest unit
 * @param {string} amount - Human-readable amount (e.g., "1.5")
 * @param {number} decimals - Token decimals
 * @returns {bigint} Amount in smallest unit
 */
function parseAmount(amount, decimals = 18) {
  return parseUnits(amount, decimals);
}

/**
 * Format amount from wei/smallest unit to human-readable
 * @param {string|bigint} amount - Amount in smallest unit
 * @param {number} decimals - Token decimals
 * @returns {string} Human-readable amount
 */
function formatAmount(amount, decimals = 18) {
  return formatUnits(amount, decimals);
}

/**
 * Build a transaction object
 * @param {Object} params - Transaction parameters
 * @returns {Object} Unsigned transaction
 */
function buildTransaction({
  to,
  value,
  data,
  gasLimit,
  maxFeePerGas,
  maxPriorityFeePerGas,
  gasPrice,
  nonce,
  chainId,
}) {
  const tx = {
    to,
    value: value || '0',
    gasLimit,
    chainId,
  };

  if (data) {
    tx.data = data;
  }

  if (nonce !== undefined) {
    tx.nonce = nonce;
  }

  // EIP-1559 or legacy
  if (maxFeePerGas != null && maxPriorityFeePerGas != null) {
    if (BigInt(maxPriorityFeePerGas) > BigInt(maxFeePerGas)) {
      throw new Error('Invalid transaction fees: priority fee exceeds maximum fee');
    }
    tx.maxFeePerGas = maxFeePerGas;
    tx.maxPriorityFeePerGas = maxPriorityFeePerGas;
    tx.type = 2; // EIP-1559
  } else if (gasPrice) {
    tx.gasPrice = gasPrice;
    tx.type = 0; // Legacy
  }

  return tx;
}

/**
 * Best-effort check that a device-broadcast tx really came from the
 * signer's account: a compromised responder could report the hash of
 * someone else's transaction. The tx usually reaches our RPC a beat
 * after the device's, so "not visible yet" is not an error — only a
 * visible mismatch is.
 */
async function verifyDeviceBroadcastFrom(hash, expectedFrom, chainId) {
  let tx;
  try {
    ({ result: tx } = await chainData.request(chainId, 'eth_getTransactionByHash', [hash]));
  } catch (err) {
    console.warn('[TransactionService] Device-broadcast lookup failed:', err.message);
    return;
  }
  if (!tx) {
    console.warn('[TransactionService] Device-broadcast tx not visible on our RPC yet:', hash);
    return;
  }
  if (tx.from.toLowerCase() !== expectedFrom.toLowerCase()) {
    throw createRemoteError(REMOTE_ERROR_CODES.WRONG_ACCOUNT);
  }
}

/**
 * Fill in fee parameters the caller didn't supply.
 *
 * ethers' Wallet.sendTransaction used to populate missing fees from the
 * network before signing. Now that signing and broadcasting are separate
 * steps nothing does, so an unpriced tx would be signed with
 * maxFeePerGas = 0 and rejected by every node as underpriced — on a
 * hardware wallet, only after the user confirmed it on-device. Populate
 * (or refuse) here, before the signer is ever asked to sign.
 *
 * @param {Object} params
 * @returns {Promise<{maxFeePerGas?: string, maxPriorityFeePerGas?: string, gasPrice?: string}>}
 */
async function resolveFeeParams({ maxFeePerGas, maxPriorityFeePerGas, gasPrice, chainId }) {
  if ((maxFeePerGas && maxPriorityFeePerGas) || gasPrice) {
    return { maxFeePerGas, maxPriorityFeePerGas, gasPrice };
  }

  const fees = await getGasPrices(chainId);

  if (fees.type === 'eip1559' && isPositiveFee(fees.maxFeePerGas) && isPositiveFee(fees.maxPriorityFeePerGas)) {
    return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  }
  if (isPositiveFee(fees.gasPrice)) {
    return { gasPrice: fees.gasPrice };
  }

  throw new Error('Unable to determine a gas price for this transaction. Please try again.');
}

function isPositiveFee(value) {
  try {
    return value !== undefined && value !== null && BigInt(value) > 0n;
  } catch {
    return false;
  }
}

/**
 * Sign and broadcast a transaction.
 *
 * Signing and broadcasting are separate steps so the signer can be
 * anything implementing the signer interface (vault key, hardware
 * device) — the provider only ever sees the serialized signed tx.
 *
 * Fee parameters are optional: when the caller supplies none they are
 * fetched from the network (see resolveFeeParams) rather than signed as
 * zero.
 *
 * @param {Object} params - Transaction parameters
 * @param {string} params.to - Recipient (or token contract for ERC-20)
 * @param {string} params.value - Value in wei
 * @param {string} [params.data] - Transaction data
 * @param {string} params.gasLimit - Gas limit
 * @param {string} [params.maxFeePerGas] - Max fee per gas (EIP-1559)
 * @param {string} [params.maxPriorityFeePerGas] - Max priority fee (EIP-1559)
 * @param {string} [params.gasPrice] - Gas price (legacy)
 * @param {number} params.chainId - Chain ID
 * @param {import('./signers').Signer} signer - Signer for the sending account
 * @returns {Promise<Object>} Transaction result
 */
async function signAndSendTransaction(params, signer) {
  const { to, value, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasPrice, chainId } = params;

  // Phone wallets populate fees and broadcast through their own RPC. All
  // raw-signing backends need complete fee data before device approval.
  const fees = typeof signer.sendTransaction === 'function'
    ? null
    : await resolveFeeParams({ maxFeePerGas, maxPriorityFeePerGas, gasPrice, chainId });

  try {
    const from = await signer.getAddress();

    // Backends that can only sign-and-broadcast through their own channel
    // (phone wallets) expose the optional sendTransaction capability: the
    // remote wallet picks the nonce, estimates gas, and broadcasts via its
    // own RPC — our gas parameters would be stale guesses by the time the
    // user confirms on the device, so only the intent fields go over.
    if (typeof signer.sendTransaction === 'function') {
      const hash = await signer.sendTransaction({ to, value, data, chainId });
      await verifyDeviceBroadcastFrom(hash, from, chainId);
      console.log('[TransactionService] Transaction broadcast by signer:', hash);
      return {
        hash,
        from,
        to,
        value,
        chainId,
        explorerUrl: getTxExplorerUrl(chainId, hash),
      };
    }

    // Get nonce
    const nonceResponse = await chainData.request(chainId, 'eth_getTransactionCount', [
      from,
      'pending',
    ]);
    const nonce = Number(BigInt(nonceResponse.result));

    // Build transaction
    const tx = buildTransaction({
      to,
      value,
      data,
      gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      gasPrice: fees.gasPrice,
      nonce,
      chainId,
    });

    console.log('[TransactionService] Signing transaction:', {
      to: tx.to,
      value: tx.value,
      gasLimit: tx.gasLimit,
      chainId: tx.chainId,
      nonce: tx.nonce,
      nonceSource: nonceResponse.source,
    });

    const signedTransaction = await signer.signTransaction(tx);
    const parsedTransaction = Transaction.from(signedTransaction);
    const broadcast = await chainData.broadcastRawTransaction(chainId, signedTransaction);
    if (
      parsedTransaction.hash &&
      String(broadcast.result).toLowerCase() !== parsedTransaction.hash.toLowerCase()
    ) {
      throw new Error(
        `Transaction may have been broadcast as ${parsedTransaction.hash}, ` +
        `but the broadcaster returned ${broadcast.result}`
      );
    }

    console.log('[TransactionService] Transaction sent:', broadcast.result);

    return {
      hash: broadcast.result,
      nonce: parsedTransaction.nonce,
      from: parsedTransaction.from || from,
      to: parsedTransaction.to,
      value: parsedTransaction.value?.toString(),
      chainId,
      broadcastSource: broadcast.source,
      explorerUrl: getTxExplorerUrl(chainId, broadcast.result),
    };
  } catch (err) {
    console.error('[TransactionService] Transaction failed:', err);

    // Device-backend errors (LEDGER_*/REMOTE_*) carry a stable code and a
    // user-facing message; rewrapping them here would strip the code and
    // let the local-provider heuristics below mislabel them.
    if (typeof err.code === 'string' && /^(LEDGER|REMOTE)_/.test(err.code)) {
      throw err;
    }

    // Parse common error messages
    const message = String(err?.message || '');
    const normalizedMessage = message.toLowerCase();
    if (normalizedMessage.includes('insufficient funds')) {
      throw new Error('Insufficient funds for transaction', { cause: err });
    }
    if (
      [
        'nonce too low',
        'nonce too high',
        'invalid nonce',
        'nonce has already been used',
        'replacement transaction underpriced',
      ].some((pattern) => normalizedMessage.includes(pattern))
    ) {
      throw new Error('Transaction nonce error. Please try again.', { cause: err });
    }
    if (
      normalizedMessage.includes('priority fee') ||
      normalizedMessage.includes('priorityfee') ||
      normalizedMessage.includes('maxfeepergas') ||
      normalizedMessage.includes('maxpriorityfeepergas') ||
      normalizedMessage.includes('fee cap') ||
      normalizedMessage.includes('base fee')
    ) {
      throw new Error('Transaction fee data is invalid. Please refresh and try again.', {
        cause: err,
      });
    }
    if (normalizedMessage.includes('gas')) {
      throw new Error('Gas estimation error. The transaction may fail.', { cause: err });
    }
    // Server errors (rate limiting, blocked, etc.)
    if (
      err.code === 'SERVER_ERROR' ||
      message.includes('SERVER_ERROR') ||
      message.includes('403') ||
      message.includes('429') ||
      normalizedMessage.includes('invalid numeric value')
    ) {
      throw new Error('RPC provider temporarily unavailable. Please try again.', { cause: err });
    }

    throw new Error(`Transaction failed: ${err.message}`, { cause: err });
  }
}

/**
 * Get transaction status/receipt
 * @param {string} txHash - Transaction hash
 * @param {number} chainId - Chain ID
 * @returns {Promise<Object>} Transaction status
 */
async function getTransactionStatus(txHash, chainId) {
  try {
    const { result: receipt } = await chainData.request(chainId, 'eth_getTransactionReceipt', [txHash]);

    if (!receipt) {
      return {
        status: 'pending',
        hash: txHash,
      };
    }

    return {
      status: BigInt(receipt.status || 0) === 1n ? 'confirmed' : 'failed',
      hash: txHash,
      blockNumber: receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null,
      gasUsed: receipt.gasUsed ? BigInt(receipt.gasUsed).toString() : null,
      effectiveGasPrice: receipt.effectiveGasPrice
        ? BigInt(receipt.effectiveGasPrice).toString()
        : null,
      explorerUrl: getTxExplorerUrl(chainId, txHash),
    };
  } catch (err) {
    console.error('[TransactionService] Failed to get transaction status:', err);
    return {
      status: 'unknown',
      hash: txHash,
      error: err.message,
    };
  }
}

/**
 * Wait for transaction confirmation
 * @param {string} txHash - Transaction hash
 * @param {number} chainId - Chain ID
 * @param {number} confirmations - Number of confirmations to wait for
 * @returns {Promise<Object>} Transaction receipt
 */
async function waitForTransaction(txHash, chainId, confirmations = 1) {
  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const status = await getTransactionStatus(txHash, chainId);
      if (status.status === 'failed') return status;
      if (status.status === 'confirmed') {
        if (confirmations <= 1) return status;
        try {
          const { result: head } = await chainData.request(chainId, 'eth_blockNumber');
          if (Number(BigInt(head)) - status.blockNumber + 1 >= confirmations) return status;
        } catch (err) {
          // Receipt confirmation is already known. A transient head lookup
          // must not turn that into a false timeout; keep polling until the
          // requested confirmation depth can be established.
          console.warn('[TransactionService] Confirmation head lookup failed:', err.message);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('Timed out waiting for transaction confirmation');
  } catch (err) {
    console.error('[TransactionService] Wait for transaction failed:', err);
    throw new Error(`Transaction confirmation timeout: ${err.message}`, { cause: err });
  }
}

module.exports = {
  estimateGas,
  getGasPrices,
  toFeeFields,
  buildErc20TransferData,
  parseAmount,
  formatAmount,
  buildTransaction,
  signAndSendTransaction,
  getTransactionStatus,
  waitForTransaction,
};
