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
  namesOwnFees,
} = require('./transaction-service');
const { signAndRecord, KINDS: PAYMENT_KINDS } = require('./tx-recorder');
const { intentFailure } = require('./intent-ipc');
const { getActiveWalletIndex } = require('../identity-manager');
const { getEffectiveRpcUrls } = require('./rpc-manager');
const chainData = require('../networks/chain-data');
const { getSigner } = require('./signers');
const { isVaultLockedError } = require('./vault-errors');
const {
  KINDS: CONFIRM_KINDS,
  NOT_CONFIRMED,
  issueConfirmation,
  consumeConfirmation,
} = require('./signing-confirmation');
const dappPermissions = require('./dapp-permissions');
const { sitePaymentWaiting, takeSiteTurn } = require('./auto-approve-pause');
const {
  FEE_CHECK_ASK_AGAIN,
  FEE_CHECK_NOT_AUTO_APPROVED,
  checkFees,
  checkAtApproval,
  feeCheckError,
  feeNotShownError,
} = require('./fee-check');
const { normalizeOrigin } = require('../../shared/origin-utils');

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

// The renderer's context is display data for the history row. An intent
// key in it would name a held intent to send again, outside this request's
// authorization: keys come only from main's own callers (Safe execution and
// deployment), so any key-like field is dropped here.
const RENDERER_KEY_FIELD = /^(intent_?key|key)$/i;

// Shared body of the two send-transaction IPC handlers. They differ only
// in which wallet index signs and which payment-history kind tags the
// resulting row.
function buildTxRecordContext(kind, context = {}) {
  const display = Object.fromEntries(
    Object.entries(context ?? {}).filter(([name]) => !RENDERER_KEY_FIELD.test(name))
  );
  return { ...display, kind };
}

/** What a Safe screen needs to ask for a fee the fee check stopped for:
 * main's verdict and the transaction offered for confirmation. */
function feeAsk(err) {
  return err?.feeCheck && err?.offer ? { feeCheck: err.feeCheck, offer: err.offer } : {};
}

function notAuthorized(reason) {
  const err = new Error(`Signing was not confirmed: ${reason}`);
  err.code = NOT_CONFIRMED;
  return err;
}

/** The 4-byte function selector of `data`, or null for a plain transfer. */
function selectorOf(data) {
  return typeof data === 'string' && /^0x[0-9a-fA-F]{8}/.test(data)
    ? data.slice(0, 10).toLowerCase()
    : null;
}

/**
 * The dApp's stored grant, but only when it exposes exactly `walletIndex`
 * — an auto-approve rule authorises the account the site is connected
 * with, never another one.
 */
function permissionFor(permissionKey, walletIndex) {
  if (typeof permissionKey !== 'string' || !permissionKey) return null;
  const permission = dappPermissions.getPermission(permissionKey);
  return permission && permission.walletIndex === walletIndex ? permission : null;
}

/** Main's own evaluation of a dApp's transaction auto-approve rules. */
function isDappTxAutoApproved(permissionKey, walletIndex, tx) {
  if (!permissionFor(permissionKey, walletIndex)) return false;
  const selector = selectorOf(tx.data);
  if (!selector || !tx.to) return false;
  return dappPermissions.isTransactionAutoApproved(
    permissionKey,
    tx.to,
    selector,
    Number(tx.chainId)
  );
}

/**
 * The site a dApp send is recorded under: the intent's and the history
 * row's origin, which "Always allow"'s pause reads (D12). It comes from
 * what authorized the send, never from the renderer's display context
 * alone:
 * - auto-approved: the auto-approve key main checked. A context naming
 *   another site is refused, so a site can't sign under its own rule and
 *   record the payment as another's;
 * - confirmed: the site the confirmation binds (signing-confirmation.js),
 *   which the token's check holds equal to the context's, and which can't
 *   be empty.
 * As a permission key (normalizeOrigin), or null when there is none, which
 * no authorization then accepts.
 */
function dappSendSite(context, authorization) {
  const shown = typeof context?.origin === 'string' ? normalizeOrigin(context.origin) : '';
  if (!authorization?.confirmation && typeof authorization?.autoApprove === 'string') {
    const site = normalizeOrigin(authorization.autoApprove);
    if (context?.origin != null && shown !== site) {
      throw notAuthorized("the request's site is not the one its auto-approve names");
    }
    return site || null;
  }
  return shown || null;
}

/** Main's own evaluation of a dApp's signing auto-approve flag. */
function isDappSigningAutoApproved(permissionKey, walletIndex) {
  return Boolean(
    permissionFor(permissionKey, walletIndex) &&
      dappPermissions.getSigningAutoApprove(permissionKey)
  );
}

/**
 * Gate every signing handler (security audit O-7). A request is signed
 * only when the caller presents
 *   - `{ confirmation }`: a token main issued through
 *     `wallet:confirm-signing` for exactly this request (single use,
 *     short-lived — see signing-confirmation.js), or
 *   - `{ autoApprove: permissionKey }`: and main's own reading of that
 *     dApp's stored auto-approve policy covers this request
 *     (`autoApproveCheck`, absent where auto-approve doesn't exist).
 * Anything else throws SIGNING_NOT_CONFIRMED before a key is touched.
 *
 * @returns {'confirmed'|'auto-approved'}
 */
function authorizeSigning(authorization, kind, accountIndex, payload, autoApproveCheck) {
  if (authorization?.confirmation) {
    consumeConfirmation(authorization.confirmation, kind, accountIndex, payload);
    return 'confirmed';
  }
  if (authorization?.autoApprove !== undefined && autoApproveCheck) {
    if (autoApproveCheck(authorization.autoApprove)) {
      return 'auto-approved';
    }
    throw notAuthorized('this request is not covered by the site\'s auto-approve rules');
  }
  throw notAuthorized('no confirmation token');
}

// The confirmations whose transaction main signs with the fees the user saw:
// the fee check at confirmation runs for them (design 0005, A). A phone
// account's payment is not among them in effect: the phone picks its own
// fees, signs and broadcasts, and main signs nothing (phoneSigner).
const FEE_CHECKED_KINDS = new Set([
  CONFIRM_KINDS.WALLET_SEND,
  CONFIRM_KINDS.DAPP_SEND,
  CONFIRM_KINDS.INTENT_REPLACE,
  CONFIRM_KINDS.EXECUTOR_SEND,
]);

/** Whether `walletIndex` is a phone account, which signs and pays itself. */
function phoneSigner(walletIndex) {
  if (!Number.isInteger(walletIndex)) return false;
  try {
    return typeof getSigner(walletIndex)?.sendTransaction === 'function';
  } catch {
    return false;
  }
}

async function handleSendTransaction(walletIndex, params, kind, context = {}, authorization = null) {
  // A dApp send's turn among its site's sends (auto-approve-pause.js), left
  // once its payment is committed, or here when it fails first.
  let release = null;
  try {
    const { to, value, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasPrice, chainId } = params || {};
    if (!to || chainId === undefined || !gasLimit) {
      return { success: false, error: 'Missing required parameters: to, chainId, gasLimit' };
    }
    const tx = { to, value, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasPrice, chainId };
    const dapp = kind === PAYMENT_KINDS.DAPP_SEND;
    const confirmKind = dapp ? CONFIRM_KINDS.DAPP_SEND : CONFIRM_KINDS.WALLET_SEND;
    // A dApp send is confirmed for, and recorded under, its site.
    const site = dapp ? dappSendSite(context, authorization) : undefined;
    const how = authorizeSigning(
      authorization,
      confirmKind,
      walletIndex,
      dapp ? { ...tx, origin: site } : tx,
      dapp ? (permissionKey) => isDappTxAutoApproved(permissionKey, walletIndex, tx) : null
    );
    // A send approved without the user is judged at this moment by the fee
    // check (design 0005, A): one that can't be compared, is one endpoint's
    // word, or is above the threshold goes to the user instead.
    if (how === 'auto-approved' && !phoneSigner(walletIndex)) {
      const verdict = await checkAtApproval(tx);
      if (!verdict.autoApprove) throw feeCheckError(FEE_CHECK_NOT_AUTO_APPROVED, verdict);
    }
    // Main never signs fees the user didn't see: a send that doesn't name
    // its own would be given today's after its confirmation
    // (resolveFeeParams). It goes back to its screen instead, with nothing
    // signed. A phone picks its own fees.
    if (!namesOwnFees(tx) && !phoneSigner(walletIndex)) throw feeNotShownError();
    if (dapp) {
      // D12: the site's dApp sends take turns until each one's payment is
      // committed (auto-approve-pause.js). A silent send doesn't wait for
      // one: with another of the site's payments under way, it is paused.
      // In its turn, it stops if one of the site's payments is waiting; a
      // confirmed one goes on.
      const silent = how === 'auto-approved';
      const paused = () =>
        notAuthorized('auto-approve is paused while a payment this site requested is waiting');
      try {
        release = await takeSiteTurn(site, { wait: !silent });
      } catch (err) {
        throw silent && err.code === 'SITE_TURN_BUSY' ? paused() : err;
      }
      if (silent && (await sitePaymentWaiting(site))) throw paused();
    }
    const result = await signAndRecord(
      tx,
      getSigner(walletIndex),
      buildTxRecordContext(kind, dapp ? { ...context, origin: site } : context),
      { walletIndex, onCommitted: release }
    );

    // "Always allow" is recorded here, from the transaction the user just
    // confirmed — never from a free-standing renderer call — so a rule can
    // only ever cover a (contract, selector, chain) the user saw.
    let autoApproveAdded;
    if (how === 'confirmed' && confirmKind === CONFIRM_KINDS.DAPP_SEND && authorization?.rememberAutoApprove) {
      const permissionKey = authorization.rememberAutoApprove;
      const selector = selectorOf(data);
      autoApproveAdded = Boolean(
        selector &&
          permissionFor(permissionKey, walletIndex) &&
          dappPermissions.addTransactionAutoApprove(permissionKey, to, selector, Number(chainId))
      );
    }
    return {
      success: true,
      ...result,
      ...(autoApproveAdded !== undefined ? { autoApproveAdded } : {}),
    };
  } catch (err) {
    console.error(`[WalletIPC] ${kind} transaction failed:`, err);
    // A send that got as far as an intent reports it (its id, outcome and a
    // summary), so the screen can offer to send those same bytes again. One
    // its fee check refused carries the verdict.
    return {
      success: false,
      error: err.message,
      ...intentFailure(err),
      ...(err.feeCheck ? { feeCheck: err.feeCheck } : {}),
    };
  } finally {
    release?.();
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

  // Startup display reads cached data only; visible wallet refresh owns fetching.
  ipcMain.handle('wallet:get-balances-cached', async (_event, address) => {
    try {
      if (!address) {
        return { success: false, error: 'Address is required' };
      }
      const { balances, fromCache } = await getBalancesWithCache(address, false);
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

  // The fee check of a transaction about to be shown for confirmation
  // (design 0005, A): the most it can cost and how its fee compares with
  // today's network fee, from evidence main keeps for up to 60 s.
  ipcMain.handle('wallet:fee-check', async (_event, tx) => {
    try {
      return { success: true, feeCheck: await checkFees(tx) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Issue a confirmation token for a request the user just confirmed on an
  // approval screen (O-7). The signing handler below it will sign exactly
  // this request, once. A wallet send binds the account active right now.
  //
  // A transaction's confirmation is also the moment of its approval for the
  // fee check (design 0005, A): judged against evidence at most 60 s old, a
  // send above the threshold gets no token unless the user confirmed it
  // again (`options.feeAcknowledged`), and the screen asks again with the
  // verdict it gets back.
  ipcMain.handle('wallet:confirm-signing', async (_event, kind, accountIndex, payload, options) => {
    try {
      const index = kind === CONFIRM_KINDS.WALLET_SEND ? getActiveWalletIndex() : accountIndex;
      if (FEE_CHECKED_KINDS.has(kind) && !phoneSigner(index)) {
        const verdict = await checkAtApproval(payload, {
          acknowledged: options?.feeAcknowledged === true,
        });
        if (verdict.askAgain) {
          const error = feeCheckError(FEE_CHECK_ASK_AGAIN, verdict);
          return { success: false, error: error.message, code: error.code, feeCheck: verdict };
        }
      }
      const { token, expiresAt } = issueConfirmation(kind, index, payload);
      return { success: true, token, expiresAt };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('wallet:send-transaction', (_event, params, context, authorization) =>
    handleSendTransaction(
      getActiveWalletIndex(),
      params,
      PAYMENT_KINDS.WALLET_SEND,
      context,
      authorization
    ));

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
  ipcMain.handle('wallet:dapp-send-transaction', (_event, params, walletIndex, context, authorization) =>
    handleSendTransaction(walletIndex, params, PAYMENT_KINDS.DAPP_SEND, context, authorization));

  // Sign a personal message (EIP-191) for a dApp
  ipcMain.handle('wallet:sign-message', async (_event, message, walletIndex, authorization) => {
    try {
      if (!message) {
        return { success: false, error: 'Message is required' };
      }
      authorizeSigning(authorization, CONFIRM_KINDS.SIGN_MESSAGE, walletIndex, message, (key) =>
        isDappSigningAutoApproved(key, walletIndex));

      const signature = await getSigner(walletIndex).signMessage(message);

      return { success: true, signature };
    } catch (err) {
      console.error('[WalletIPC] Message signing failed:', err);
      return { success: false, error: err.message, ...(err.code === NOT_CONFIRMED ? { code: err.code } : {}) };
    }
  });

  // Sign typed data (EIP-712) for a dApp
  ipcMain.handle('wallet:sign-typed-data', async (_event, typedData, walletIndex, authorization) => {
    try {
      if (!typedData) {
        return { success: false, error: 'Typed data is required' };
      }
      authorizeSigning(authorization, CONFIRM_KINDS.SIGN_TYPED_DATA, walletIndex, typedData, (key) =>
        isDappSigningAutoApproved(key, walletIndex));

      const signature = await getSigner(walletIndex).signTypedData(typedData);

      return { success: true, signature };
    } catch (err) {
      console.error('[WalletIPC] Typed data signing failed:', err);
      return { success: false, error: err.message, ...(err.code === NOT_CONFIRMED ? { code: err.code } : {}) };
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

  // `options.feeConfirmation`: an 'executor-send' confirmation of the fee
  // the fee check stopped for, with that fee (safe-executor.js).
  ipcMain.handle('wallet:activate-safe', async (_event, index, options) => {
    try {
      const { activateSafe } = require('./safe/safe-service');
      const result = await activateSafe(index, { feeConfirmation: options?.feeConfirmation });
      return { success: true, ...result };
    } catch (err) {
      // The identity core's errors carry their own code (`vault_locked`);
      // the renderer's contract is VAULT_LOCKED.
      const code = isVaultLockedError(err) ? 'VAULT_LOCKED' : err.code;
      return { success: false, error: err.message, code, ...feeAsk(err) };
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
      // The identity core's errors carry their own code (`vault_locked`);
      // the renderer's contract is VAULT_LOCKED.
      const code = isVaultLockedError(err) ? 'VAULT_LOCKED' : err.code;
      return { success: false, error: err.message, code, ...feeAsk(err) };
    }
  };

  ipcMain.handle(
    'wallet:safe-send',
    safeStateHandler((safeIndex, tx, display, chainId, authorization) => {
      // Creating the SafeTx is the confirmation point: it silently collects
      // the vault owners' signatures, and every later board step
      // (safe-sign, safe-execute) only acts on this main-held, confirmed
      // SafeTx. There is no auto-approve for Safe sends.
      //
      // A dApp's SafeTx is confirmed for its site (`display.site`): its
      // payment is recorded under that site and takes the site's turn
      // (D12), so the token binds it. A wallet's own SafeTx has none.
      const site = display?.site ?? undefined;
      authorizeSigning(
        authorization,
        CONFIRM_KINDS.SAFE_SEND,
        safeIndex,
        { tx, chainId, origin: site },
        null
      );
      const bound = site === undefined ? display : { ...display, site: normalizeOrigin(site) };
      const { startSafeSend } = require('./safe/safe-transactions');
      return startSafeSend({ safeIndex, tx, display: bound, chainId });
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
    safeStateHandler((safeIndex, options) => {
      const { executeSafePending } = require('./safe/safe-transactions');
      return executeSafePending(safeIndex, { feeConfirmation: options?.feeConfirmation });
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
    safeStateHandler((safeIndex, request, display, requester, authorization) => {
      // Same confirmation point as safe-send; follow-up calls are bound to
      // the session token this returns. A dApp's signing auto-approve is
      // evaluated here, in main.
      authorizeSigning(authorization, CONFIRM_KINDS.SAFE_MESSAGE, safeIndex, request, (key) =>
        key === (requester?.origin ?? null) && isDappSigningAutoApproved(key, safeIndex));
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
  ipcMain.handle(
    'wallet:chain-request',
    async (_event, { chainId, method, params, routingContext }) => {
      try {
        if (!chainData.isReadMethod(method)) {
          return { success: false, error: { code: 4200, message: 'Method not supported' } };
        }
        const response = await chainData.request(chainId, method, params || [], {
          routingContext,
        });
        return { success: true, ...response };
      } catch (err) {
        return {
          success: false,
          error: { code: err.code || -32603, message: err.message, data: err.data },
        };
      }
    }
  );

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
  authorizeSigning,
  buildTxRecordContext,
  registerWalletIpc,
};
