/**
 * Wallet IPC Handlers
 *
 * Registers IPC handlers for wallet operations.
 */

const { ipcMain } = require('electron');
const QRCode = require('qrcode');
const { getAllBalances, getBalancesWithCache, clearBalanceCache } = require('./balance-service');
const { getChain, getAllChains } = require('./chains');
const { testProvider } = require('./provider-manager');
const {
  estimateGas,
  getGasPrices,
  buildErc20TransferData,
  parseAmount,
  getTransactionStatus,
  waitForTransaction,
} = require('./transaction-service');
const { signAndRecord, KINDS: PAYMENT_KINDS } = require('./tx-recorder');
const { getActiveWalletIndex } = require('../identity-manager');
const { getEffectiveRpcUrls } = require('./rpc-manager');
const chainData = require('../networks/chain-data-router');
const { getSigner } = require('./signers');
const { isVaultLockedError } = require('./vault-errors');

/**
 * Validate that an RPC URL is a known, trusted endpoint.
 * Builds an allowlist from all chain configs + configured provider URLs.
 */
function isAllowedRpcUrl(rpcUrl) {
  try {
    const parsed = new URL(rpcUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
  } catch {
    return false;
  }

  // Allowlist = the registry's resolved rpc pool for every known chain.
  const chains = getAllChains();
  for (const chain of Object.values(chains)) {
    const providerUrls = getEffectiveRpcUrls(chain.chainId);
    for (const url of providerUrls) {
      if (url === rpcUrl) return true;
    }
  }

  return false;
}

// Shared body of the two send-transaction IPC handlers. They differ only
// in which wallet index signs and which payment-history kind tags the
// resulting row.
function buildTxRecordContext(kind, context = {}) {
  return { ...context, kind };
}

async function handleSendTransaction(walletIndex, params, kind, context = {}) {
  try {
    const { to, value, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasPrice, chainId } = params;
    if (!to || chainId === undefined || !gasLimit) {
      return { success: false, error: 'Missing required parameters: to, chainId, gasLimit' };
    }
    const result = await signAndRecord(
      { to, value, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasPrice, chainId },
      getSigner(walletIndex),
      buildTxRecordContext(kind, context),
    );
    return { success: true, ...result };
  } catch (err) {
    console.error(`[WalletIPC] ${kind} transaction failed:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * Register wallet IPC handlers
 */
function registerWalletIpc() {
  // Get all balances for an address (always fetches fresh)
  ipcMain.handle('wallet:get-balances', async (_event, address) => {
    try {
      if (!address) {
        return { success: false, error: 'Address is required' };
      }
      const balances = await getAllBalances(address);
      return { success: true, balances, fromCache: false };
    } catch (err) {
      console.error('[WalletIPC] Failed to get balances:', err);
      return { success: false, error: err.message };
    }
  });

  // Get balances with cache-first strategy
  ipcMain.handle('wallet:get-balances-cached', async (_event, address) => {
    try {
      if (!address) {
        return { success: false, error: 'Address is required' };
      }
      const { balances, fromCache } = await getBalancesWithCache(address, true);
      return { success: true, balances, fromCache };
    } catch (err) {
      console.error('[WalletIPC] Failed to get cached balances:', err);
      return { success: false, error: err.message };
    }
  });

  // Clear balance cache
  ipcMain.handle('wallet:clear-balance-cache', async (_event, address) => {
    try {
      clearBalanceCache(address);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get chain configuration
  ipcMain.handle('wallet:get-chain', async (_event, chainId) => {
    try {
      const chain = getChain(chainId);
      if (!chain) {
        return { success: false, error: `Chain ${chainId} not supported` };
      }
      return { success: true, chain };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get all supported chains
  ipcMain.handle('wallet:get-chains', async () => {
    try {
      const chains = getAllChains();
      return { success: true, chains };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Test provider connectivity
  ipcMain.handle('wallet:test-provider', async (_event, chainId) => {
    try {
      const result = await testProvider(chainId);
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Generate QR code as data URL
  ipcMain.handle('wallet:generate-qr', async (_event, text, options = {}) => {
    try {
      if (!text) {
        return { success: false, error: 'Text is required' };
      }
      const dataUrl = await QRCode.toDataURL(text, {
        width: options.width || 200,
        margin: options.margin || 2,
        color: {
          dark: options.dark || '#000000',
          light: options.light || '#ffffff',
        },
        errorCorrectionLevel: options.errorCorrectionLevel || 'M',
      });
      return { success: true, dataUrl };
    } catch (err) {
      console.error('[WalletIPC] Failed to generate QR code:', err);
      return { success: false, error: err.message };
    }
  });

  // ============================================
  // Transaction handlers
  // ============================================

  // Estimate gas for a transaction
  ipcMain.handle('wallet:estimate-gas', async (_event, params) => {
    try {
      const { from, to, value, data, chainId } = params;
      if (!from || !to || chainId === undefined) {
        return { success: false, error: 'Missing required parameters: from, to, chainId' };
      }
      const result = await estimateGas({ from, to, value, data, chainId });
      return { success: true, ...result };
    } catch (err) {
      console.error('[WalletIPC] Gas estimation failed:', err);
      return { success: false, error: err.message };
    }
  });

  // Get current gas prices
  ipcMain.handle('wallet:get-gas-price', async (_event, chainId) => {
    try {
      if (chainId === undefined) {
        return { success: false, error: 'Chain ID is required' };
      }
      const prices = await getGasPrices(chainId);
      return { success: true, ...prices };
    } catch (err) {
      console.error('[WalletIPC] Failed to get gas prices:', err);
      return { success: false, error: err.message };
    }
  });

  // Build ERC-20 transfer data
  ipcMain.handle('wallet:build-erc20-data', async (_event, to, amount) => {
    try {
      if (!to || !amount) {
        return { success: false, error: 'Recipient and amount are required' };
      }
      const data = buildErc20TransferData(to, amount);
      return { success: true, data };
    } catch (err) {
      console.error('[WalletIPC] Failed to build ERC-20 data:', err);
      return { success: false, error: err.message };
    }
  });

  // Parse amount to smallest unit
  ipcMain.handle('wallet:parse-amount', async (_event, amount, decimals = 18) => {
    try {
      if (amount === undefined || amount === null || amount === '') {
        return { success: false, error: 'Amount is required' };
      }
      const parsed = parseAmount(amount.toString(), decimals);
      return { success: true, value: parsed.toString() };
    } catch (err) {
      console.error('[WalletIPC] Failed to parse amount:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('wallet:send-transaction', (_event, params, context) =>
    handleSendTransaction(getActiveWalletIndex(), params, PAYMENT_KINDS.WALLET_SEND, context));

  // Get transaction status
  ipcMain.handle('wallet:get-transaction-status', async (_event, txHash, chainId) => {
    try {
      if (!txHash || chainId === undefined) {
        return { success: false, error: 'Transaction hash and chain ID are required' };
      }
      const status = await getTransactionStatus(txHash, chainId);
      return { success: true, ...status };
    } catch (err) {
      console.error('[WalletIPC] Failed to get transaction status:', err);
      return { success: false, error: err.message };
    }
  });

  // Wait for transaction confirmation
  ipcMain.handle('wallet:wait-for-transaction', async (_event, txHash, chainId, confirmations = 1) => {
    try {
      if (!txHash || chainId === undefined) {
        return { success: false, error: 'Transaction hash and chain ID are required' };
      }
      const result = await waitForTransaction(txHash, chainId, confirmations);
      return { success: true, ...result };
    } catch (err) {
      console.error('[WalletIPC] Wait for transaction failed:', err);
      return { success: false, error: err.message };
    }
  });

  // ============================================
  // dApp-specific handlers (use specific wallet index)
  // ============================================

  // Renderer threads the dapp's permissionKey through as context.origin
  // so payment-history rows match the x402 permission store's keying.
  ipcMain.handle('wallet:dapp-send-transaction', (_event, params, walletIndex, context) =>
    handleSendTransaction(walletIndex, params, PAYMENT_KINDS.DAPP_SEND, context));

  // Sign a personal message (EIP-191) for a dApp
  ipcMain.handle('wallet:sign-message', async (_event, message, walletIndex) => {
    try {
      if (!message) {
        return { success: false, error: 'Message is required' };
      }

      const signature = await getSigner(walletIndex).signMessage(message);

      return { success: true, signature };
    } catch (err) {
      console.error('[WalletIPC] Message signing failed:', err);
      return { success: false, error: err.message };
    }
  });

  // Sign typed data (EIP-712) for a dApp
  ipcMain.handle('wallet:sign-typed-data', async (_event, typedData, walletIndex) => {
    try {
      if (!typedData) {
        return { success: false, error: 'Typed data is required' };
      }

      const signature = await getSigner(walletIndex).signTypedData(typedData);

      return { success: true, signature };
    } catch (err) {
      console.error('[WalletIPC] Typed data signing failed:', err);
      return { success: false, error: err.message };
    }
  });

  // Safe account lifecycle (chain-touching — see safe/safe-service.js).
  // Lazily required so wallet-ipc doesn't load protocol-kit at startup.
  ipcMain.handle('wallet:create-safe', async (_event, name, ownerIndexes, threshold) => {
    try {
      const { createSafeAccount } = require('./safe/safe-service');
      const wallet = await createSafeAccount({ name, ownerIndexes, threshold });
      return { success: true, wallet };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('wallet:get-safe-status', async (_event, index) => {
    try {
      const { getSafeStatus } = require('./safe/safe-service');
      const status = await getSafeStatus(index);
      return { success: true, status };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('wallet:activate-safe', async (_event, index) => {
    try {
      const { activateSafe } = require('./safe/safe-service');
      const result = await activateSafe(index);
      return { success: true, ...result };
    } catch (err) {
      const code = err.code ?? (isVaultLockedError(err) ? 'VAULT_LOCKED' : undefined);
      return { success: false, error: err.message, code };
    }
  });

  // Safe sends — the signing board's granular API: build (+ silent free
  // signatures), sign one owner per user action, execute as its own
  // idempotent step, render from state. Half-signed transactions are
  // persisted main-side; signature failures never destroy them.
  const safeStateHandler = (fn) => async (_event, ...args) => {
    try {
      const state = await fn(...args);
      return { success: true, state };
    } catch (err) {
      // A locked vault is recoverable — the renderer walks the user
      // through the standard unlock and retries.
      const code = err.code ?? (isVaultLockedError(err) ? 'VAULT_LOCKED' : undefined);
      return { success: false, error: err.message, code };
    }
  };

  ipcMain.handle(
    'wallet:safe-send',
    safeStateHandler((safeIndex, tx, display) => {
      const { startSafeSend } = require('./safe/safe-transactions');
      return startSafeSend({ safeIndex, tx, display });
    })
  );

  ipcMain.handle(
    'wallet:safe-sign',
    safeStateHandler((safeIndex, ownerIndex) => {
      const { signSafePending } = require('./safe/safe-transactions');
      return signSafePending(safeIndex, ownerIndex);
    })
  );

  ipcMain.handle(
    'wallet:safe-execute',
    safeStateHandler((safeIndex) => {
      const { executeSafePending } = require('./safe/safe-transactions');
      return executeSafePending(safeIndex);
    })
  );

  ipcMain.handle(
    'wallet:safe-state',
    safeStateHandler((safeIndex) => {
      const { getSafeSendState } = require('./safe/safe-transactions');
      return getSafeSendState(safeIndex);
    })
  );

  ipcMain.handle(
    'wallet:safe-cancel-pending',
    safeStateHandler((safeIndex) => {
      const { cancelSafeSend } = require('./safe/safe-transactions');
      cancelSafeSend(safeIndex);
    })
  );

  ipcMain.handle('wallet:safe-pending-list', async () => {
    try {
      const { getAllSafeSendStates } = require('./safe/safe-transactions');
      return { success: true, states: getAllSafeSendStates() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // SafeMessage sessions — dApp message signing via EIP-1271 (see
  // safe/safe-messages.js). Same granular board API as sends; complete
  // returns the concatenated owner signatures instead of a state. Each
  // session is bound to its requesting page: start takes the requester
  // identity and returns a per-session token that every other call must
  // present.
  ipcMain.handle(
    'wallet:safe-message-start',
    safeStateHandler((safeIndex, request, display, requester) => {
      const { startSafeMessage } = require('./safe/safe-messages');
      return startSafeMessage({ safeIndex, request, display, requester });
    })
  );

  ipcMain.handle(
    'wallet:safe-message-sign',
    safeStateHandler((safeIndex, ownerIndex, token) => {
      const { signSafeMessage } = require('./safe/safe-messages');
      return signSafeMessage(safeIndex, ownerIndex, token);
    })
  );

  ipcMain.handle(
    'wallet:safe-message-state',
    safeStateHandler((safeIndex, token) => {
      const { getSafeMessageState } = require('./safe/safe-messages');
      return getSafeMessageState(safeIndex, token);
    })
  );

  ipcMain.handle(
    'wallet:safe-message-cancel',
    safeStateHandler((safeIndex, token) => {
      const { cancelSafeMessage } = require('./safe/safe-messages');
      cancelSafeMessage(safeIndex, token);
    })
  );

  ipcMain.handle('wallet:safe-message-complete', async (_event, safeIndex, token) => {
    try {
      const { completeSafeMessage } = require('./safe/safe-messages');
      const { signature } = completeSafeMessage(safeIndex, token);
      return { success: true, signature };
    } catch (err) {
      return { success: false, error: err.message, code: err.code };
    }
  });

  // Capability-aware chain request. Myotis and Colibri are attempted before
  // quorum/direct RPC according to the selected chain's access policy.
  ipcMain.handle('wallet:chain-request', async (_event, { chainId, method, params }) => {
    try {
      if (!chainData.isReadMethod(method)) {
        return { success: false, error: { code: 4200, message: 'Method not supported' } };
      }
      const response = await chainData.request(chainId, method, params || []);
      return { success: true, ...response };
    } catch (err) {
      return {
        success: false,
        error: { code: err.code || -32603, message: err.message, data: err.data },
      };
    }
  });

  // Legacy endpoint-specific proxy retained for existing internal callers.
  ipcMain.handle('wallet:proxy-rpc', async (_event, { rpcUrl, method, params }) => {
    try {
      if (!isAllowedRpcUrl(rpcUrl)) {
        return { success: false, error: { code: -32603, message: 'RPC URL not in allowlist' } };
      }

      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params: params || [],
        }),
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        // Non-JSON response (e.g. "GNOSIS_MAINNET not enabled")
        return { success: false, error: { code: -32603, message: text.slice(0, 200) } };
      }
      if (data.error) {
        return { success: false, error: data.error };
      }
      return { success: true, result: data.result };
    } catch (err) {
      return { success: false, error: { code: -32603, message: err.message } };
    }
  });

  console.log('[WalletIPC] Handlers registered');
}

module.exports = {
  buildTxRecordContext,
  registerWalletIpc,
};
