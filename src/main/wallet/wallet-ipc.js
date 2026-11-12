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
const { redactedHandler } = require('./rpc-errors');
const chainData = require('../networks/chain-data');
const { getSigner } = require('./signers');
const { isVaultLockedError } = require('./vault-errors');
const {
  signsRawHash,
  normalizeMessage,
  messageToBytes,
  normalizeTypedData,
  toCoreTypedData,
  typedDataViewOptions,
  typedDataWarnings,
} = require('./signing-utils');
const { vaultBackend } = require('../core/vault-backend');
const {
  KINDS: CONFIRM_KINDS,
  NOT_CONFIRMED,
  isPageKind,
  bindingFor,
  issueConfirmation,
  consumeConfirmation,
} = require('./signing-confirmation');
const { takeSiteTurn } = require('./auto-approve-pause');
const {
  FEE_CHECK_ASK_AGAIN,
  checkFees,
  checkAtApproval,
  feeCheckError,
  feeNotShownError,
} = require('./fee-check');
const { guestHostedBy } = require('./agent-tab-custody');
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

// The page kinds, whose methods main serves now (freedom-core design 0011,
// "Approval tokens"; PRQ-5): `personal_sign` and `eth_signTypedData_v4`
// (PRQ-5a) and `eth_sendTransaction` (PRQ-5b), from a Safe account too. Main's
// own issuer mints their tokens for a page's request (page/page-signing.js,
// page/page-sends.js), so the chrome's `wallet:confirm-signing` refuses them,
// and a Safe send that names a site with them (`isPageKind`). The signing
// handlers refuse the chrome's `{ autoApprove, webContentsId }` claim
// outright: main reads a site's rules itself, for the requester's attested
// key, and no other kind has a rule. The wallet's own six kinds stay the
// chrome's to confirm until APS-3.
const CHROME_REFUSED_KINDS = new Set([
  CONFIRM_KINDS.DAPP_SEND,
  CONFIRM_KINDS.SIGN_MESSAGE,
  CONFIRM_KINDS.SIGN_TYPED_DATA,
  CONFIRM_KINDS.SAFE_MESSAGE,
]);
const PAGE_KIND_REFUSED = 'This request comes from a page: main confirms it itself';

function notAuthorized(reason) {
  const err = new Error(`Signing was not confirmed: ${reason}`);
  err.code = NOT_CONFIRMED;
  return err;
}

/**
 * The site a dApp send is confirmed for and recorded under: the one its
 * confirmation binds (signing-confirmation.js), which the token's check holds
 * equal to the context's and which can't be empty. As a permission key
 * (normalizeOrigin), or null when there is none, which no confirmation then
 * accepts.
 */
function dappSendSite(context) {
  const shown = typeof context?.origin === 'string' ? normalizeOrigin(context.origin) : '';
  return shown || null;
}

/**
 * Whether signing auto-approve may cover a dApp's message request: never a
 * personal_sign of exactly 32 bytes, whose signature can be a Swarm feed
 * update (#89), whatever the account. Its prompt always shows.
 */
function isAutoApprovableMessage(method, message) {
  return !(method === 'personal_sign' && signsRawHash(message));
}

/**
 * A dApp's typed data through the identity core (freedom-core design
 * 0002, #88): its digest and the core's view of exactly what is signed,
 * with the dApp's primaryType as it came and its active chain compared and
 * reported. Refused like any malformed typed data when the view wouldn't
 * fit one reply.
 *
 * @returns {Promise<{hash: string, view: object, warnings: string[]}>}
 */
async function typedDataViewFor(typedData, chainId) {
  const normalized = normalizeTypedData(typedData);
  if (!normalized || typeof normalized !== 'object') {
    throw new Error('Typed data is required');
  }
  const { hash, view } = await vaultBackend.typedDataView(
    toCoreTypedData(normalized),
    typedDataViewOptions(normalized, chainId)
  );
  return { hash, view, warnings: typedDataWarnings(view) };
}

/**
 * What a dApp's personal_sign signs, for the approval screen (#88): the
 * bytes main sends to the core, from the same strictly validated hex, and
 * whether they are a raw 32-byte value (#89). A message that isn't a
 * string can't be shown, so it is refused before the prompt.
 */
function messageViewFor(message) {
  if (typeof message !== 'string') {
    throw new Error('The message to sign must be text or 0x-prefixed hex');
  }
  const bytes = messageToBytes(normalizeMessage(message));
  return { hex: '0x' + bytes.toString('hex'), rawHash: signsRawHash(message) };
}

/**
 * Gate every signing handler (security audit O-7). A request is signed only
 * when the caller presents `{ confirmation }`: a token main issued through
 * `wallet:confirm-signing` for exactly this request (single use,
 * short-lived — see signing-confirmation.js). Anything else throws
 * SIGNING_NOT_CONFIRMED before a key is touched.
 *
 * The chrome's `{ autoApprove, webContentsId }` claim of a site's rule is
 * refused for every kind (freedom-core design 0011, PRQ-5): a page's rules,
 * its signing rule and its contract rules, are main's to read for the
 * request it holds (page/page-signing.js, page/page-sends.js), and the
 * wallet's own kinds have none.
 *
 * @returns {Promise<'confirmed'>}
 */
async function authorizeSigning(authorization, kind, accountIndex, payload) {
  if (authorization?.autoApprove !== undefined) {
    throw notAuthorized("main reads a page's rules itself");
  }
  if (authorization?.confirmation) {
    consumeConfirmation(authorization.confirmation, kind, accountIndex, payload);
    return 'confirmed';
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
    // A dApp send is confirmed for, and recorded under, its site. Main's
    // issuer alone mints a dApp send's token, for a page's request it holds
    // (page/page-sends.js, PRQ-5b), and never for this route: the chrome's
    // old path stays until PRQ-9, but sends nothing a page asked for.
    const site = dapp ? dappSendSite(context) : undefined;
    await authorizeSigning(authorization, confirmKind, walletIndex, dapp ? { ...tx, origin: site } : tx);
    // Main never signs fees the user didn't see: a send that doesn't name
    // its own would be given today's after its confirmation
    // (resolveFeeParams). It goes back to its screen instead, with nothing
    // signed. A phone picks its own fees.
    if (!namesOwnFees(tx) && !phoneSigner(walletIndex)) throw feeNotShownError();
    // D12: a confirmed dApp send waits for its site's turn
    // (auto-approve-pause.js).
    if (dapp) release = await takeSiteTurn(site, { wait: true });
    const result = await signAndRecord(
      tx,
      getSigner(walletIndex),
      buildTxRecordContext(kind, dapp ? { ...context, origin: site } : context),
      { walletIndex, onCommitted: release }
    );
    // A contract rule ("Always allow") is recorded by main from a send the
    // user confirmed on main's own prompt, for the requester's key
    // (page/page-sends.js), never here.
    return { success: true, ...result };
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
 * A wallet handler, registered with its replies redacted (#1040): many
 * answer a failure with `err.message`, and an RPC error can quote a keyed
 * provider's URL, with the user's API key in it. Main's providers already
 * throw none (rpc-errors.js); this is the second line, for every handler.
 */
function handle(channel, listener) {
  ipcMain.handle(channel, redactedHandler(listener));
}

/**
 * Register wallet IPC handlers
 */
function registerWalletIpc() {
  // Get all balances for an address (always fetches fresh)
  handle('wallet:get-balances', async (_event, address) => {
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
  handle('wallet:get-balances-cached', async (_event, address) => {
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
  handle('wallet:clear-balance-cache', async (_event, address) => {
    try {
      clearBalanceCache(address);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get chain configuration
  handle('wallet:get-chain', async (_event, chainId) => {
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
  handle('wallet:get-chains', async () => {
    try {
      const chains = getAllChains();
      return { success: true, chains };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Test provider connectivity
  handle('wallet:test-provider', async (_event, chainId) => {
    try {
      const result = await testProvider(chainId);
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Generate QR code as data URL
  handle('wallet:generate-qr', async (_event, text, options = {}) => {
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
  handle('wallet:estimate-gas', async (_event, params) => {
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
  handle('wallet:get-gas-price', async (_event, chainId) => {
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
  handle('wallet:build-erc20-data', async (_event, to, amount) => {
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
  handle('wallet:parse-amount', async (_event, amount, decimals = 18) => {
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
  handle('wallet:fee-check', async (_event, tx) => {
    try {
      return { success: true, feeCheck: await checkFees(tx) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Issue a confirmation token for a request the user just confirmed on an
  // approval screen (O-7). The signing handler below it will sign exactly
  // this request, once. A wallet send binds the account active right now,
  // and so does an x402 payment, which `x402:approve` signs with the active
  // account (x402/ipc.js). An x402 payment is confirmed only by the chrome
  // window that hosts its tab, the one window `x402:approve` takes it from.
  //
  // A transaction's confirmation is also the moment of its approval for the
  // fee check (design 0005, A): judged against evidence at most 60 s old, a
  // send above the threshold gets no token unless the user confirmed it
  // again (`options.feeAcknowledged`), and the screen asks again with the
  // verdict it gets back.
  handle('wallet:confirm-signing', async (event, kind, accountIndex, payload, options) => {
    try {
      // A page's signature or send is confirmed by main's own issuer, on the
      // user's decision of the prompt main showed (design 0011, PRQ-5): a
      // dApp send and a Safe send that names a site among them.
      if (CHROME_REFUSED_KINDS.has(kind) || isPageKind(kind, payload)) {
        return { success: false, error: PAGE_KIND_REFUSED, code: NOT_CONFIRMED };
      }
      if (kind === CONFIRM_KINDS.X402_PAYMENT && !guestHostedBy(event?.sender, payload?.webContentsId)) {
        return { success: false, error: 'This payment is not on a tab of this window' };
      }
      // An auto-pay cap's edit (#1023) is bound to the window confirming
      // it and to the cap as main holds it, never to the caller's word.
      if (kind === CONFIRM_KINDS.X402_CAP_UPDATE) {
        payload = require('../x402/permissions').capUpdateRequest(event?.sender?.id, payload);
      }
      const index =
        kind === CONFIRM_KINDS.WALLET_SEND || kind === CONFIRM_KINDS.X402_PAYMENT
          ? getActiveWalletIndex()
          : accountIndex;
      // With the approvals document on (design 0011, APS-3), the wallet's own
      // kinds are minted only on the user's approval in the window's
      // approvals document, which shows main's view of exactly the request
      // the token binds, checked first, and asks again for a fee above the
      // threshold itself: the chrome's acknowledgement counts for nothing.
      const walletApprovals = require('../approvals/wallet-approvals');
      const approvals = walletApprovals.PROMPT_KINDS[kind] ? walletApprovals.getWalletApprovals() : null;
      if (approvals) {
        bindingFor(kind, index, payload);
        // Minted on the approval, before the panel's decision is answered.
        const outcome = await approvals.confirm(
          {
            sender: event?.sender,
            kind,
            index,
            payload,
            feeChecked: FEE_CHECKED_KINDS.has(kind) && !phoneSigner(index),
          },
          () => issueConfirmation(kind, index, payload)
        );
        if (!outcome.approved) return { success: false, error: outcome.error, code: outcome.code };
        return { success: true, token: outcome.token, expiresAt: outcome.expiresAt };
      }
      if (FEE_CHECKED_KINDS.has(kind) && !phoneSigner(index)) {
        const verdict = await checkAtApproval(payload, {
          acknowledged: options?.feeAcknowledged === true,
        });
        if (verdict.askAgain) {
          const error = feeCheckError(FEE_CHECK_ASK_AGAIN, verdict);
          return { success: false, error: error.message, code: error.code, feeCheck: verdict };
        }
      }
      // Typed data, whose token binds the core's digest, is a page kind:
      // main's own issuer mints it (page/page-signing.js).
      const { token, expiresAt } = issueConfirmation(kind, index, payload);
      return { success: true, token, expiresAt };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // What a dApp's signing request signs, before its prompt (#88). Typed
  // data: the core's view, for every signer kind; a request it refuses
  // (malformed, or a view too large for one reply) fails here, unprompted.
  handle('wallet:typed-data-view', async (_event, typedData, chainId) => {
    try {
      return { success: true, ...(await typedDataViewFor(typedData, chainId)) };
    } catch (err) {
      return { success: false, error: err.message, ...(err.code ? { code: err.code } : {}) };
    }
  });

  handle('wallet:message-view', async (_event, message) => {
    try {
      return { success: true, ...messageViewFor(message) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  handle('wallet:send-transaction', (_event, params, context, authorization) =>
    handleSendTransaction(
      getActiveWalletIndex(),
      params,
      PAYMENT_KINDS.WALLET_SEND,
      context,
      authorization
    ));

  // Get transaction status
  handle('wallet:get-transaction-status', async (_event, txHash, chainId) => {
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
  handle('wallet:wait-for-transaction', async (_event, txHash, chainId, confirmations = 1) => {
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
  handle('wallet:dapp-send-transaction', (_event, params, walletIndex, context, authorization) =>
    handleSendTransaction(walletIndex, params, PAYMENT_KINDS.DAPP_SEND, context, authorization));

  // A dApp's personal_sign (EIP-191) and typed data (EIP-712): the chrome's
  // old path, kept for rollback until PRQ-9. A page's request is served by
  // main now (page/page-signing.js), whose own issuer mints its token on the
  // user's decision, and the chrome gets none (`wallet:confirm-signing`) and
  // can claim no site's rule (`authorizeSigning`). So these sign nothing a
  // page asked for.
  handle('wallet:sign-message', async (_event, message, walletIndex, authorization) => {
    try {
      if (!message) {
        return { success: false, error: 'Message is required' };
      }
      await authorizeSigning(authorization, CONFIRM_KINDS.SIGN_MESSAGE, walletIndex, message);

      const signature = await getSigner(walletIndex).signMessage(message);

      return { success: true, signature };
    } catch (err) {
      console.error('[WalletIPC] Message signing failed:', err);
      return { success: false, error: err.message, ...(err.code === NOT_CONFIRMED ? { code: err.code } : {}) };
    }
  });

  handle('wallet:sign-typed-data', async (_event, typedData, walletIndex, authorization) => {
    try {
      if (!typedData) {
        return { success: false, error: 'Typed data is required' };
      }
      if (!authorization?.confirmation) {
        await authorizeSigning(authorization, CONFIRM_KINDS.SIGN_TYPED_DATA, walletIndex, typedData);
      }
      // The digest the user confirmed: the core signs nothing else.
      const { hash: expectedHash } = consumeConfirmation(
        authorization.confirmation,
        CONFIRM_KINDS.SIGN_TYPED_DATA,
        walletIndex,
        typedData
      );

      const signature = await getSigner(walletIndex).signTypedData(typedData, { expectedHash });

      return { success: true, signature };
    } catch (err) {
      console.error('[WalletIPC] Typed data signing failed:', err);
      return { success: false, error: err.message, ...(err.code === NOT_CONFIRMED ? { code: err.code } : {}) };
    }
  });

  // Safe account lifecycle (chain-touching — see safe/safe-service.js).
  // Lazily required so wallet-ipc doesn't load protocol-kit at startup.
  handle('wallet:create-safe', async (_event, name, ownerIndexes, threshold) => {
    try {
      const { createSafeAccount } = require('./safe/safe-service');
      const wallet = await createSafeAccount({ name, ownerIndexes, threshold });
      return { success: true, wallet };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  handle('wallet:get-safe-status', async (_event, index) => {
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
  handle('wallet:activate-safe', async (_event, index, options) => {
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

  handle(
    'wallet:safe-send',
    safeStateHandler(async (safeIndex, tx, display, chainId, authorization) => {
      // Creating the SafeTx is the confirmation point: it silently collects
      // the vault owners' signatures, and every later board step
      // (safe-sign, safe-execute) only acts on this main-held, confirmed
      // SafeTx. There is no auto-approve for Safe sends.
      //
      // A dApp's SafeTx is confirmed for its site (`display.site`): its
      // payment is recorded under that site and takes the site's turn
      // (D12), so the token binds it. A wallet's own SafeTx has none.
      const site = display?.site ?? undefined;
      await authorizeSigning(authorization, CONFIRM_KINDS.SAFE_SEND, safeIndex, { tx, chainId, origin: site });
      const bound = site === undefined ? display : { ...display, site: normalizeOrigin(site) };
      const { startSafeSend } = require('./safe/safe-transactions');
      return startSafeSend({ safeIndex, tx, display: bound, chainId });
    })
  );

  handle(
    'wallet:safe-sign',
    safeStateHandler((safeIndex, ownerIndex) => {
      const { signSafePending } = require('./safe/safe-transactions');
      return signSafePending(safeIndex, ownerIndex);
    })
  );

  handle(
    'wallet:safe-execute',
    safeStateHandler((safeIndex, options) => {
      const { executeSafePending } = require('./safe/safe-transactions');
      return executeSafePending(safeIndex, { feeConfirmation: options?.feeConfirmation });
    })
  );

  handle(
    'wallet:safe-state',
    safeStateHandler((safeIndex) => {
      const { getSafeSendState } = require('./safe/safe-transactions');
      return getSafeSendState(safeIndex);
    })
  );

  handle(
    'wallet:safe-cancel-pending',
    safeStateHandler((safeIndex) => {
      const { cancelSafeSend } = require('./safe/safe-transactions');
      cancelSafeSend(safeIndex);
    })
  );

  // The wallet's own Safe board in the window's approvals document (design
  // 0011, APS-3b): main runs it, for the Safe's pending SafeTx, and answers
  // with how it ended (executed, parked, discarded…), for the chrome's
  // summary. Only with the document on; the chrome's own board otherwise.
  handle('wallet:safe-board', async (event, safeIndex) => {
    try {
      const boards = require('../approvals/safe-boards').getSafeBoards();
      if (!boards) return { success: false, error: 'The approvals document is off' };
      const { BrowserWindow } = require('electron');
      const win = BrowserWindow.fromWebContents(event?.sender);
      const windowId = win && !win.isDestroyed() && win.webContents === event?.sender ? win.id : null;
      const outcome = await boards.openWalletBoard(windowId, safeIndex);
      if (outcome?.error) return { success: false, error: outcome.error.message || 'The board could not open' };
      return { success: true, outcome };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  handle('wallet:safe-pending-list', async () => {
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
  // session is bound to its requesting page and guarded by a per-session
  // token that every other call must present.
  //
  // A page's Safe message is served by main now (page/page-signing.js),
  // which opens the session itself on the user's decision or the site's
  // rule. This start is the chrome's old path, kept for rollback until
  // PRQ-9: the chrome gets no token for it (`wallet:confirm-signing`) and
  // can claim no site's rule (`authorizeSigning`), so it opens nothing a
  // page asked for.
  handle(
    'wallet:safe-message-start',
    safeStateHandler(async (safeIndex, request, display, requester, authorization) => {
      const { startSafeMessage } = require('./safe/safe-messages');
      await authorizeSigning(authorization, CONFIRM_KINDS.SAFE_MESSAGE, safeIndex, request);
      return startSafeMessage({ safeIndex, request, display, requester });
    })
  );

  handle(
    'wallet:safe-message-sign',
    safeStateHandler((safeIndex, ownerIndex, token) => {
      const { signSafeMessage } = require('./safe/safe-messages');
      return signSafeMessage(safeIndex, ownerIndex, token);
    })
  );

  handle(
    'wallet:safe-message-state',
    safeStateHandler((safeIndex, token) => {
      const { getSafeMessageState } = require('./safe/safe-messages');
      return getSafeMessageState(safeIndex, token);
    })
  );

  handle(
    'wallet:safe-message-cancel',
    safeStateHandler((safeIndex, token) => {
      const { cancelSafeMessage } = require('./safe/safe-messages');
      cancelSafeMessage(safeIndex, token);
    })
  );

  // A session main opened for a page's request is completed by main, which
  // answers the page: the chrome's board only collects its signatures.
  handle('wallet:safe-message-complete', async (_event, safeIndex, token) => {
    try {
      const { completeSafeMessage } = require('./safe/safe-messages');
      const { signature } = completeSafeMessage(safeIndex, token, { chrome: true });
      return { success: true, signature };
    } catch (err) {
      return { success: false, error: err.message, code: err.code };
    }
  });

  // Capability-aware chain request. Myotis and Colibri are attempted before
  // quorum/direct RPC according to the selected chain's access policy.
  handle(
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
  handle('wallet:proxy-rpc', async (_event, { rpcUrl, method, params }) => {
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
  CHROME_REFUSED_KINDS,
  authorizeSigning,
  buildTxRecordContext,
  isAutoApprovableMessage,
  messageViewFor,
  registerWalletIpc,
  typedDataViewFor,
};
