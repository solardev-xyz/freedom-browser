/**
 * Transaction Service
 *
 * Handles gas estimation, transaction building, signing, and broadcasting.
 * Uses the vault's derived keys for signing.
 */

const { parseEther, parseUnits, formatUnits, Interface, Wallet, Transaction, hashMessage, TypedDataEncoder } = require('ethers');
const { getProvider, withRetry } = require('./provider-manager');
const { getChain, getTxExplorerUrl } = require('./chains');

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
  const provider = getProvider(chainId);
  if (!provider) {
    throw new Error(`No provider available for chain ${chainId}`);
  }

  try {
    const tx = {
      from,
      to,
      value: value || '0',
    };

    if (data) {
      tx.data = data;
    }

    const gasLimit = await withRetry(() => provider.estimateGas(tx), 2, chainId);

    // Add 20% buffer for safety
    const bufferedGas = (gasLimit * 120n) / 100n;

    return {
      gasLimit: bufferedGas.toString(),
    };
  } catch (err) {
    console.error('[TransactionService] Gas estimation failed:', err);
    throw new Error(`Gas estimation failed: ${err.message}`);
  }
}

/**
 * Get current gas prices for a chain
 * Returns EIP-1559 fee data with market preset
 * @param {number} chainId - Chain ID
 * @returns {Promise<Object>} Gas price data
 */
async function getGasPrices(chainId) {
  const provider = getProvider(chainId);
  if (!provider) {
    throw new Error(`No provider available for chain ${chainId}`);
  }

  try {
    const [feeData, block] = await withRetry(
      () => Promise.all([provider.getFeeData(), provider.getBlock('latest')]),
      2,
      chainId
    );

    // For EIP-1559 chains (Ethereum, Gnosis)
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      const baseFee = block?.baseFeePerGas || feeData.gasPrice || 0n;

      // Market: 2x base fee + priority fee (covers 2 blocks of full blocks)
      const marketMaxFee = baseFee * 2n + feeData.maxPriorityFeePerGas;

      return {
        type: 'eip1559',
        baseFee: baseFee.toString(),
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas.toString(),
        maxFeePerGas: marketMaxFee.toString(),
        // For display: estimated fee per gas
        effectiveGasPrice: ((baseFee + feeData.maxPriorityFeePerGas)).toString(),
      };
    }

    // Legacy gas price (fallback)
    return {
      type: 'legacy',
      gasPrice: (feeData.gasPrice || 0n).toString(),
      effectiveGasPrice: (feeData.gasPrice || 0n).toString(),
    };
  } catch (err) {
    console.error('[TransactionService] Failed to get gas prices:', err);
    throw new Error(`Failed to get gas prices: ${err.message}`);
  }
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
  if (maxFeePerGas && maxPriorityFeePerGas) {
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
 * Sign and broadcast a transaction
 * @param {Object} params - Transaction parameters
 * @param {string} params.to - Recipient (or token contract for ERC-20)
 * @param {string} params.value - Value in wei
 * @param {string} [params.data] - Transaction data
 * @param {string} params.gasLimit - Gas limit
 * @param {string} [params.maxFeePerGas] - Max fee per gas (EIP-1559)
 * @param {string} [params.maxPriorityFeePerGas] - Max priority fee (EIP-1559)
 * @param {string} [params.gasPrice] - Gas price (legacy)
 * @param {number} params.chainId - Chain ID
 * @param {string} privateKey - Private key for signing (0x-prefixed)
 * @returns {Promise<Object>} Transaction result
 */
async function signAndSendTransaction(params, privateKey) {
  const { to, value, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasPrice, chainId } = params;

  const provider = getProvider(chainId);
  if (!provider) {
    throw new Error(`No provider available for chain ${chainId}`);
  }

  try {
    // Create wallet from private key
    const wallet = new Wallet(privateKey, provider);

    // Get nonce
    const nonce = await withRetry(() => provider.getTransactionCount(wallet.address, 'pending'), 2, chainId);

    // Build transaction
    const tx = buildTransaction({
      to,
      value,
      data,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasPrice,
      nonce,
      chainId,
    });

    console.log('[TransactionService] Signing transaction:', {
      to: tx.to,
      value: tx.value,
      gasLimit: tx.gasLimit,
      chainId: tx.chainId,
      nonce: tx.nonce,
    });

    // Sign and send
    const txResponse = await wallet.sendTransaction(tx);

    console.log('[TransactionService] Transaction sent:', txResponse.hash);

    return {
      hash: txResponse.hash,
      nonce: txResponse.nonce,
      from: txResponse.from,
      to: txResponse.to,
      value: txResponse.value?.toString(),
      chainId,
      explorerUrl: getTxExplorerUrl(chainId, txResponse.hash),
    };
  } catch (err) {
    console.error('[TransactionService] Transaction failed:', err);

    // Parse common error messages
    if (err.message.includes('insufficient funds')) {
      throw new Error('Insufficient funds for transaction');
    }
    if (err.message.includes('nonce')) {
      throw new Error('Transaction nonce error. Please try again.');
    }
    if (err.message.includes('gas')) {
      throw new Error('Gas estimation error. The transaction may fail.');
    }
    // Server errors (rate limiting, blocked, etc.)
    if (
      err.code === 'SERVER_ERROR' ||
      err.message.includes('SERVER_ERROR') ||
      err.message.includes('403') ||
      err.message.includes('429') ||
      err.message.includes('invalid numeric value')
    ) {
      throw new Error('RPC provider temporarily unavailable. Please try again.');
    }

    throw new Error(`Transaction failed: ${err.message}`);
  }
}

/**
 * Get transaction status/receipt
 * @param {string} txHash - Transaction hash
 * @param {number} chainId - Chain ID
 * @returns {Promise<Object>} Transaction status
 */
async function getTransactionStatus(txHash, chainId) {
  const provider = getProvider(chainId);
  if (!provider) {
    throw new Error(`No provider available for chain ${chainId}`);
  }

  try {
    const receipt = await withRetry(() => provider.getTransactionReceipt(txHash), 2, chainId);

    if (!receipt) {
      return {
        status: 'pending',
        hash: txHash,
      };
    }

    return {
      status: receipt.status === 1 ? 'confirmed' : 'failed',
      hash: txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed?.toString(),
      effectiveGasPrice: receipt.gasPrice?.toString(),
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
  const provider = getProvider(chainId);
  if (!provider) {
    throw new Error(`No provider available for chain ${chainId}`);
  }

  try {
    const receipt = await provider.waitForTransaction(txHash, confirmations, 60000); // 60s timeout

    return {
      status: receipt.status === 1 ? 'confirmed' : 'failed',
      hash: txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed?.toString(),
      effectiveGasPrice: receipt.gasPrice?.toString(),
      explorerUrl: getTxExplorerUrl(chainId, txHash),
    };
  } catch (err) {
    console.error('[TransactionService] Wait for transaction failed:', err);
    throw new Error(`Transaction confirmation timeout: ${err.message}`);
  }
}

/**
 * Sign a personal message (EIP-191)
 * @param {string} message - Message to sign (hex string or UTF-8)
 * @param {string} privateKey - Private key for signing
 * @returns {Promise<string>} Signature (hex string)
 */
async function signPersonalMessage(message, privateKey) {
  try {
    const wallet = new Wallet(privateKey);

    // If message is hex-encoded, convert to bytes
    let messageToSign = message;
    if (message.startsWith('0x')) {
      // Convert hex to string for personal_sign
      const bytes = Buffer.from(message.slice(2), 'hex');
      messageToSign = bytes.toString('utf8');
    }

    // signMessage automatically applies EIP-191 prefix
    const signature = await wallet.signMessage(messageToSign);

    console.log('[TransactionService] Message signed');
    return signature;
  } catch (err) {
    console.error('[TransactionService] Message signing failed:', err);
    throw new Error(`Message signing failed: ${err.message}`);
  }
}

/**
 * Sign typed data (EIP-712)
 * @param {Object} typedData - EIP-712 typed data object
 * @param {string} privateKey - Private key for signing
 * @returns {Promise<string>} Signature (hex string)
 */
async function signTypedData(typedData, privateKey) {
  try {
    const wallet = new Wallet(privateKey);

    // Parse if string
    const data = typeof typedData === 'string' ? JSON.parse(typedData) : typedData;

    // Extract domain, types, and message from EIP-712 structure
    const { domain, types, message, primaryType } = data;

    // Remove EIP712Domain from types (ethers handles it internally)
    const typesWithoutDomain = { ...types };
    delete typesWithoutDomain.EIP712Domain;

    // Sign using ethers' signTypedData
    const signature = await wallet.signTypedData(domain, typesWithoutDomain, message);

    console.log('[TransactionService] Typed data signed');
    return signature;
  } catch (err) {
    console.error('[TransactionService] Typed data signing failed:', err);
    throw new Error(`Typed data signing failed: ${err.message}`);
  }
}

module.exports = {
  estimateGas,
  getGasPrices,
  buildErc20TransferData,
  parseAmount,
  formatAmount,
  buildTransaction,
  signAndSendTransaction,
  getTransactionStatus,
  waitForTransaction,
  signPersonalMessage,
  signTypedData,
};
