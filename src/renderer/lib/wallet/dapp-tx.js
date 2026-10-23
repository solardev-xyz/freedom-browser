/**
 * dApp Transaction Approval Module
 *
 * Transaction approval screen for dApp-initiated transactions.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import {
  assertNoSignatureInFlight,
  isSignatureInFlight,
  signatureInFlightError,
  beginSignatureFlight,
  endSignatureFlight,
} from './signature-flight.js';
import { open as openSidebarPanel } from '../sidebar.js';
import {
  bypassUnlockGateForDevice,
  bypassUnlockGateForSafe,
  signingButtonLabel,
  isSafeAccount,
  accountType,
  renderSafeFeePayer,
  truncateAddress,
} from './wallet-utils.js';
import { openSafeSigningBoard, isSafeSigningBoardOpen } from './safe-signing.js';
import { confirmSigning } from './signing-confirmation.js';
import { FEE_NOT_SHOWN, FeeConfirmation, feeFields } from './fee-check.js';
import {
  outcomeText,
  ACTIONS,
  PHONE_OUTCOME_UNKNOWN,
  siteOutcomeUnknownError,
} from './intent-texts.js';
import { resendHeldPayment } from './intent-resend.js';
import { parseOnchainAppUrl } from '../url-utils.js';

// DOM references
let dappTxScreen;
let dappTxBackBtn;
let dappTxSite;
let dappTxTo;
let dappTxValue;
let dappTxData;
let dappTxDataRow;
let dappTxNetwork;
let dappTxFee;
let dappTxFeeRetryRow;
let dappTxFeeRetryBtn;
let dappTxWarning;
let dappTxUnlock;
let dappTxTouchIdBtn;
let dappTxPasswordLink;
let dappTxPasswordSection;
let dappTxPasswordInput;
let dappTxPasswordSubmit;
let dappTxError;
let dappTxRejectBtn;
let dappTxApproveBtn;
let dappTxAutoApproveRow;
let dappTxAutoApproveCheckbox;

// Local state. `dappTxPending.signing` is true while the signature and
// broadcast are in flight: a hardware signature is a device prompt we
// cannot recall, so there is no cancellation path once it starts —
// rejecting behind it would settle the dApp promise with 4001 while the
// transaction still broadcasts.
let dappTxPending = null;

// The approval's fee check at confirmation (freedom-core design 0005, A).
// Confirm also waits for the fee itself (`feeKnown`): main never signs a
// dApp transaction with fees the user didn't see (waitsForFee).
let dappTxFeeCheck = null;
const DAPP_TX_CONFIRM_LABEL = 'Confirm';

const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';

/**
 * The chain a contract-hosted app's origin is pinned to, or null for any
 * other page. A second line of defence behind the provider's resolved chain:
 * it is derived from the document actually making the request, so it cannot
 * go stale the way a stored grant can.
 */
function pinnedOnchainAppChainId(webview) {
  try {
    return parseOnchainAppUrl(webview?.getURL?.())?.chainId || null;
  } catch {
    return null;
  }
}

export function initDappTx() {
  dappTxScreen = document.getElementById('sidebar-dapp-tx');
  dappTxBackBtn = document.getElementById('dapp-tx-back');
  dappTxSite = document.getElementById('dapp-tx-site');
  dappTxTo = document.getElementById('dapp-tx-to');
  dappTxValue = document.getElementById('dapp-tx-value');

  dappTxData = document.getElementById('dapp-tx-data');
  dappTxDataRow = document.getElementById('dapp-tx-data-row');
  dappTxNetwork = document.getElementById('dapp-tx-network');
  dappTxFee = document.getElementById('dapp-tx-fee');
  dappTxFeeRetryRow = document.getElementById('dapp-tx-fee-retry-row');
  dappTxFeeRetryBtn = document.getElementById('dapp-tx-fee-retry');
  dappTxWarning = document.getElementById('dapp-tx-warning');
  dappTxUnlock = document.getElementById('dapp-tx-unlock');
  dappTxTouchIdBtn = document.getElementById('dapp-tx-touchid-btn');
  dappTxPasswordLink = document.getElementById('dapp-tx-password-link');
  dappTxPasswordSection = document.getElementById('dapp-tx-password-section');
  dappTxPasswordInput = document.getElementById('dapp-tx-password-input');
  dappTxPasswordSubmit = document.getElementById('dapp-tx-password-submit');
  dappTxError = document.getElementById('dapp-tx-error');
  dappTxRejectBtn = document.getElementById('dapp-tx-reject');
  dappTxApproveBtn = document.getElementById('dapp-tx-approve');
  dappTxAutoApproveRow = document.getElementById('dapp-tx-auto-approve-row');
  dappTxAutoApproveCheckbox = document.getElementById('dapp-tx-auto-approve');
  dappTxFeeCheck = new FeeConfirmation({
    maxEl: document.getElementById('dapp-tx-fee-max'),
    noteEl: document.getElementById('dapp-tx-fee-note'),
    warningEl: document.getElementById('dapp-tx-fee-warning'),
    warningTextEl: document.getElementById('dapp-tx-fee-warning-text'),
  });

  // Register screen hider
  registerScreenHider(() => dappTxScreen?.classList.add('hidden'));

  setupDappTxScreen();
}

function setupDappTxScreen() {
  if (dappTxBackBtn) {
    dappTxBackBtn.addEventListener('click', () => {
      if (dappTxPending?.signing) return;
      rejectDappTx();
      closeDappTx();
    });
  }

  if (dappTxRejectBtn) {
    dappTxRejectBtn.addEventListener('click', () => {
      if (dappTxPending?.signing) return;
      rejectDappTx();
      closeDappTx();
    });
  }

  if (dappTxApproveBtn) {
    dappTxApproveBtn.addEventListener('click', approveDappTx);
  }

  dappTxFeeRetryBtn?.addEventListener('click', retryDappTxFee);

  if (dappTxTouchIdBtn) {
    dappTxTouchIdBtn.addEventListener('click', handleDappTxTouchIdUnlock);
  }

  if (dappTxPasswordSubmit) {
    dappTxPasswordSubmit.addEventListener('click', handleDappTxPasswordUnlock);
  }

  if (dappTxPasswordInput) {
    dappTxPasswordInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleDappTxPasswordUnlock();
    });
  }

  if (dappTxPasswordLink) {
    dappTxPasswordLink.addEventListener('click', () => {
      dappTxPasswordLink.classList.add('hidden');
      dappTxPasswordSection?.classList.remove('hidden');
      dappTxPasswordInput?.focus();
    });
  }
}

/**
 * Show dApp transaction approval screen
 *
 * The sidebar is a single shared surface, and an in-flight signature owns
 * it: the device prompt it produced cannot be recalled, so a later request
 * must not repaint the screen, reset `dappTxPending` and re-enable
 * Reject/Back/Confirm underneath it — the user would then be cancelling
 * (or confirming) request B while the device is still showing request A.
 * The lock is global (see signature-flight.js), so this refuses the
 * newcomer whichever surface is holding the device: a sibling transaction,
 * a dapp-sign request, or an x402 payment. The dApp can retry once the
 * device is done.
 *
 * `requestChainId` is the chain the provider already resolved for this
 * request — for a contract-hosted app that is the chain its origin is pinned
 * to, which outranks both the stored grant and the wallet's current
 * selection. Re-deriving it here would let a chain switch between the connect
 * prompt and this approval quote, sign, broadcast and record the transaction
 * on a chain the app never asked for (and file its auto-approve rule under a
 * chain the next request never checks).
 */
export async function showDappTxApproval(webview, permissionKey, txParams, requestChainId = null) {
  assertNoSignatureInFlight();

  const permission = await window.dappPermissions.getPermission(permissionKey);
  if (!permission) {
    throw Object.assign(new Error('Unauthorized - not connected'), { code: 4100 });
  }

  const chainId = requestChainId
    || pinnedOnchainAppChainId(webview)
    || permission.chainId
    || walletState.selectedChainId;
  const selector = extractSelector(txParams.data);

  return new Promise((resolve, reject) => {
    // Re-checked after the awaits above: the screen must still be free at
    // the moment we take it over.
    assertNoSignatureInFlight();
    const request = { permissionKey, walletIndex: permission.walletIndex, txParams, resolve, reject, webview, chainId, selector };
    dappTxPending = request;

    if (dappTxSite) {
      dappTxSite.textContent = permissionKey;
    }

    // Show auto-approve checkbox only for contract calls (has function selector)
    if (dappTxAutoApproveCheckbox) dappTxAutoApproveCheckbox.checked = false;
    setDappTxCancelEnabled(true);
    if (dappTxAutoApproveRow) {
      dappTxAutoApproveRow.classList.toggle('hidden', !selector);
    }

    Promise.all([
      populateDappTxDetails(txParams, chainId),
      checkDappTxUnlockStatus(),
    ]).then(() => {
      // Another surface may have started a device signature while we were
      // estimating fees / checking vault status (the user could still
      // click Pay on an x402 card, say). It owns the sidebar now — refuse
      // rather than paint over a live confirmation.
      if (isSignatureInFlight()) {
        if (dappTxPending === request) dappTxPending = null;
        reject(signatureInFlightError());
        return;
      }
      hideAllSubscreens();
      walletState.identityView?.classList.add('hidden');
      dappTxScreen?.classList.remove('hidden');

      openSidebarPanel();
    });
  });
}

async function populateDappTxDetails(txParams, chainId) {
  const chainsResult = await window.networks.getChains();
  const chains = chainsResult.success ? chainsResult.chains : {};
  const chain = chains[chainId];

  if (dappTxTo) {
    const to = txParams.to || '';
    dappTxTo.textContent = to ? `${to.slice(0, 10)}…${to.slice(-8)}` : 'Contract Creation';
    dappTxTo.title = to;
  }

  if (dappTxValue) {
    const value = txParams.value ? BigInt(txParams.value) : 0n;
    const ethValue = Number(value) / 1e18;
    const symbol = chain?.nativeSymbol || 'ETH';
    dappTxValue.textContent = `${ethValue.toFixed(6)} ${symbol}`;
  }

  if (dappTxData) {
    const data = txParams.data || '';
    if (data && data !== '0x') {
      dappTxData.textContent = `${data.slice(0, 20)}…`;
      dappTxData.title = data;
      dappTxDataRow?.classList.remove('hidden');
      dappTxWarning?.classList.remove('hidden');
    } else {
      dappTxData.textContent = 'No data';
      dappTxDataRow?.classList.remove('hidden');
      dappTxWarning?.classList.add('hidden');
    }
  }

  if (dappTxNetwork) {
    dappTxNetwork.textContent = chain?.name || `Chain ${chainId}`;
  }

  // Nothing of an earlier request's fee check stays on the screen.
  dappTxFeeCheck?.reset();
  dappTxFeeRetryRow?.classList.add('hidden');
  if (dappTxFee && isSafeAccount(dappTxPending?.walletIndex)) {
    // The executor EOA pays the execution fee, quoted after signing.
    renderSafeFeePayer(dappTxFee, dappTxPending.walletIndex);
    return;
  }

  if (dappTxPending) {
    dappTxPending.chain = chain;
    await estimateDappTxFee(dappTxPending);
  }
}

/**
 * Quotes `request`'s fee and shows it, with the fee check's verdict. Until
 * a fee is quoted Confirm waits (waitsForFee); a quote that fails says so,
 * with a way to try again.
 */
async function estimateDappTxFee(request) {
  const { txParams, chainId, chain } = request;
  const symbol = chain?.nativeSymbol || 'ETH';
  request.feeKnown = false;
  request.feeFailed = false;
  request.gasLimit = undefined;
  request.gasPrice = undefined;
  dappTxFeeCheck?.reset(symbol);
  if (dappTxFee) dappTxFee.textContent = 'Estimating…';
  syncDappTxConfirm();

  try {
    const walletsResult = await window.wallet.getDerivedWallets();
    const wallets = walletsResult.success ? walletsResult.wallets : [];
    const wallet = wallets.find((w) => w.index === request.walletIndex);

    if (wallet) {
      const gasResult = await window.wallet.estimateGas({
        from: wallet.address,
        to: txParams.to,
        value: txParams.value || '0',
        data: txParams.data,
        chainId,
      });

      const priceResult = await window.wallet.getGasPrice(chainId);
      if (request !== dappTxPending) return;

      if (gasResult.success && priceResult.success && namesFees(quotedFees(priceResult))) {
        const gasLimit = BigInt(gasResult.gasLimit);
        const gasPrice = BigInt(priceResult.effectiveGasPrice);
        const fee = gasLimit * gasPrice;
        const feeEth = Number(fee) / 1e18;
        if (dappTxFee) dappTxFee.textContent = `~${feeEth.toFixed(6)} ${symbol}`;

        request.gasLimit = gasResult.gasLimit;
        request.gasPrice = priceResult;
        request.feeKnown = true;
        // The fee check (design 0005, A): the most this transaction can
        // cost, and how its fee compares with today's network fee. A phone
        // picks and pays its own fee: there is none here to check.
        // Confirm waits until its verdict is shown.
        if (accountType(request.walletIndex) !== 'remote') {
          const fields = { chainId, gasLimit: gasResult.gasLimit, ...quotedFees(priceResult) };
          dappTxFeeCheck
            ?.load(feeFields(fields), symbol)
            .then(() => {
              renderDappTxConfirmLabel();
              syncDappTxConfirm();
            })
            .catch((err) => console.warn('[WalletUI] Fee check unavailable:', err));
        }
      }
    }
  } catch (err) {
    console.error('[WalletUI] Gas estimation failed:', err);
  }
  if (request !== dappTxPending) return;
  if (!request.feeKnown) {
    if (dappTxFee) dappTxFee.textContent = 'Unable to estimate';
    request.feeFailed = true;
  }
  syncDappTxConfirm();
}

/** The user asks for the fee again after a quote failed. */
function retryDappTxFee() {
  const request = dappTxPending;
  if (!request || request.signing || !request.feeFailed) return;
  hideDappTxError();
  estimateDappTxFee(request);
}

/** The fee fields a quote gives a transaction. */
function quotedFees(quote) {
  if (!quote) return {};
  return quote.type === 'eip1559'
    ? { maxFeePerGas: quote.maxFeePerGas, maxPriorityFeePerGas: quote.maxPriorityFeePerGas }
    : { gasPrice: quote.gasPrice };
}

/** Whether fee fields name a fee: both EIP-1559 fees, or a gas price. */
function namesFees({ maxFeePerGas, maxPriorityFeePerGas, gasPrice }) {
  return Boolean((maxFeePerGas && maxPriorityFeePerGas) || gasPrice);
}

/**
 * Whether `request`'s Confirm waits for its fee (design 0005, A): main
 * never signs a dApp transaction with fees the user didn't see. A Safe's
 * executor fee is checked when it executes, a phone picks its own, and a
 * held payment sent again signs nothing new.
 */
function waitsForFee(request) {
  if (!request || request.failedIntent) return false;
  if (isSafeAccount(request.walletIndex) || accountType(request.walletIndex) === 'remote') {
    return false;
  }
  return !request.feeKnown;
}

/**
 * Whether `request`'s Confirm waits for the fee check's verdict (design
 * 0005, A): it is pending, for a transaction whose fee this screen checks.
 */
function waitsForVerdict(request) {
  if (!request || request.failedIntent) return false;
  if (isSafeAccount(request.walletIndex) || accountType(request.walletIndex) === 'remote') {
    return false;
  }
  return Boolean(dappTxFeeCheck?.pending());
}

/**
 * Confirm's state for the request shown: disabled while the vault is
 * locked, its payment is closed, its fee isn't known, or the fee check's
 * verdict is pending; and the way to ask for the fee again after a quote
 * failed.
 */
function syncDappTxConfirm() {
  const request = dappTxPending;
  if (!request) return;
  dappTxFeeRetryRow?.classList.toggle('hidden', !request.feeFailed || Boolean(request.signing));
  if (!dappTxApproveBtn || request.signing) return;
  dappTxApproveBtn.disabled = Boolean(
    request.locked || request.paymentClosed || waitsForFee(request) || waitsForVerdict(request)
  );
}

/** The vault's state for the request shown, and Confirm's with it. */
function setDappTxLocked(locked) {
  if (dappTxPending) dappTxPending.locked = locked;
  syncDappTxConfirm();
}

function renderDappTxConfirmLabel() {
  if (!dappTxApproveBtn || !dappTxFeeCheck) return;
  if (dappTxPending?.signing || dappTxPending?.failedIntent) return;
  dappTxApproveBtn.textContent = dappTxFeeCheck.confirmLabel(DAPP_TX_CONFIRM_LABEL);
}

async function checkDappTxUnlockStatus() {
  try {
    if (
      bypassUnlockGateForDevice(dappTxPending?.walletIndex, dappTxUnlock, dappTxApproveBtn) ||
      bypassUnlockGateForSafe(dappTxPending?.walletIndex, dappTxUnlock, dappTxApproveBtn)
    ) {
      setDappTxLocked(false);
      return;
    }

    const status = await window.identity.getStatus();

    if (status.isUnlocked) {
      dappTxUnlock?.classList.add('hidden');
      setDappTxLocked(false);
      return;
    }

    dappTxUnlock?.classList.remove('hidden');
    setDappTxLocked(true);

    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();
    const hasTouchId = canUseTouchId && touchIdEnabled;

    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    if (dappTxTouchIdBtn) {
      dappTxTouchIdBtn.classList.toggle('hidden', !hasTouchId);
    }

    if (hasTouchId && userKnowsPassword) {
      dappTxPasswordLink?.classList.remove('hidden');
      dappTxPasswordSection?.classList.add('hidden');
    } else if (userKnowsPassword) {
      dappTxPasswordLink?.classList.add('hidden');
      dappTxPasswordSection?.classList.remove('hidden');
    } else {
      dappTxPasswordLink?.classList.add('hidden');
      dappTxPasswordSection?.classList.add('hidden');
    }
  } catch (err) {
    console.error('[WalletUI] Failed to check vault status:', err);
    dappTxUnlock?.classList.remove('hidden');
    dappTxTouchIdBtn?.classList.add('hidden');
    dappTxPasswordLink?.classList.add('hidden');
    dappTxPasswordSection?.classList.remove('hidden');
  }
}

async function handleDappTxTouchIdUnlock() {
  try {
    const result = await window.quickUnlock.unlock();
    if (!result.success) {
      throw new Error(result.error || 'Touch ID failed');
    }

    dappTxUnlock?.classList.add('hidden');
    setDappTxLocked(false);
    hideDappTxError();
  } catch (err) {
    console.error('[WalletUI] dApp tx Touch ID unlock failed:', err);
    if (err.message !== 'Touch ID cancelled') {
      showDappTxError(err.message || 'Touch ID failed');
    }
  }
}

async function handleDappTxPasswordUnlock() {
  const password = dappTxPasswordInput?.value;
  if (!password) return;

  try {
    const result = await window.identity.unlock(password);
    if (!result.success) {
      throw new Error(result.error || 'Incorrect password');
    }

    dappTxUnlock?.classList.add('hidden');
    setDappTxLocked(false);
    if (dappTxPasswordInput) dappTxPasswordInput.value = '';
    hideDappTxError();
  } catch (err) {
    console.error('[WalletUI] dApp tx password unlock failed:', err);
    showDappTxError(err.message || 'Failed to unlock');
  }
}

async function approveDappTx() {
  if (!dappTxPending || dappTxPending.signing) return;
  // Its payment is settled, voided or unknown to main: nothing to confirm.
  if (dappTxPending.paymentClosed) return;
  // Its fee, or the fee check's verdict, isn't shown: nothing to confirm yet.
  if (waitsForFee(dappTxPending) || waitsForVerdict(dappTxPending)) return;

  const request = dappTxPending;
  const { permissionKey, walletIndex, txParams, resolve, gasLimit, gasPrice, chainId, selector } = request;
  // Snapshot the auto-approve intent now: the checkbox is shared DOM that
  // a later request can repopulate while this send is still in flight.
  const autoApprove = Boolean(dappTxAutoApproveCheckbox?.checked);
  const safeAccount = isSafeAccount(walletIndex);

  // A fee far above today's network fee is confirmed twice (design 0005,
  // A): the first press asks again. A held payment sent again signs
  // nothing, and a phone picks and pays its own fee.
  const checked = !safeAccount && !request.failedIntent && accountType(walletIndex) !== 'remote';
  if (checked && dappTxFeeCheck && !dappTxFeeCheck.proceed()) {
    renderDappTxConfirmLabel();
    return;
  }

  try {
    request.signing = true;
    // Claim the sidebar for the whole flight: no other approval surface
    // may repaint over or tear down a live device confirmation.
    if (!safeAccount) beginSignatureFlight(request);
    if (dappTxApproveBtn) {
      dappTxApproveBtn.disabled = true;
      dappTxApproveBtn.textContent = signingButtonLabel(walletIndex);
    }
    setDappTxCancelEnabled(false);

    if (request.failedIntent) {
      await sendFailedIntentAgain(request);
      return;
    }

    if (safeAccount) {
      const hash = await sendViaSafeAccount(walletIndex, txParams, permissionKey, chainId);
      console.log('[WalletUI] dApp Safe transaction executed:', hash);
      resolve(hash);
      closeDappTx();
      return;
    }

    const tx = {
      to: txParams.to,
      value: txParams.value || '0',
      data: txParams.data,
      gasLimit: gasLimit || txParams.gas,
      chainId,
    };

    if (gasPrice) {
      if (gasPrice.type === 'eip1559') {
        tx.maxFeePerGas = gasPrice.maxFeePerGas;
        tx.maxPriorityFeePerGas = gasPrice.maxPriorityFeePerGas;
      } else {
        tx.gasPrice = gasPrice.gasPrice;
      }
    }

    // The user pressed Confirm on exactly this transaction, for this site:
    // main signs it once against this token, and records it under that site.
    // "Always allow" rides along and is recorded by main from the confirmed
    // transaction itself (security audit O-7).
    const authorization = await confirmSigning(
      'dapp-send',
      walletIndex,
      { ...tx, origin: permissionKey },
      dappTxFeeCheck?.options()
    );
    if (autoApprove && permissionKey && selector && txParams.to) {
      authorization.rememberAutoApprove = permissionKey;
    }
    const result = await window.wallet.dappSendTransaction(
      tx,
      walletIndex,
      buildDappTxContext(permissionKey, txParams),
      authorization
    );

    if (!result.success) {
      throw Object.assign(new Error(result.error || 'Transaction failed'), {
        failure: {
          outcome: result.outcome,
          reasonClass: result.reasonClass,
          intentId: result.intentId,
          intent: result.intent,
          code: result.code,
        },
      });
    }
    if (result.recorded === false) {
      console.warn('[WalletUI] dApp transaction broadcast but payment history did not record:', result.recordError);
    }

    if (result.autoApproveAdded) {
      console.log('[WalletUI] Transaction auto-approve added:', txParams.to, selector, 'chain', chainId);
    }

    console.log('[WalletUI] dApp transaction sent:', result.hash);
    resolve(result.hash);
    // Only tear down the screen if it is still showing *this* request.
    if (dappTxPending === request) {
      closeDappTx();
    }
  } catch (err) {
    if (err?.code === 4001) {
      // The user discarded the Safe transaction — that IS the rejection.
      rejectDappTx();
      closeDappTx();
      return;
    }
    // The fee is above the threshold at the press: nothing was signed, and
    // the approval asks again with main's verdict.
    if (dappTxFeeCheck?.askAgain(err)) {
      if (dappTxApproveBtn) {
        dappTxApproveBtn.disabled = false;
        dappTxApproveBtn.textContent = dappTxFeeCheck.confirmLabel(DAPP_TX_CONFIRM_LABEL);
      }
      setDappTxCancelEnabled(true);
      return;
    }
    console.error('[WalletUI] dApp transaction failed:', err);
    const failure = err.failure ?? {};
    // The payment is held: Confirm now sends those same signed bytes again
    // instead of signing a second payment.
    if (failure.intent?.state === 'held') {
      request.failedIntent = failure.intent;
    } else if (failure.intentId || failure.intent) {
      // A payment main names but no longer holds: nothing to confirm again.
      request.paymentClosed = true;
    } else if (failure.code === FEE_NOT_SHOWN) {
      // Main refused a fee the screen didn't show: nothing was signed. The
      // fee is asked for again before Confirm can send it.
      request.feeKnown = false;
      request.feeFailed = true;
      request.gasLimit = undefined;
      request.gasPrice = undefined;
      dappTxFeeCheck?.reset(request.chain?.nativeSymbol || 'ETH');
      if (dappTxFee) dappTxFee.textContent = 'Unable to estimate';
    } else if (failure.code === PHONE_OUTCOME_UNKNOWN) {
      // The phone may have sent it: confirming again would ask the phone to
      // pay a second time. The text asks the user to check the phone first,
      // and the site, once this approval closes, hears that the outcome is
      // unknown, never that it was rejected.
      request.paymentClosed = true;
      request.outcomeUnknown = true;
    }
    showDappTxError(
      outcomeText(failure.outcome, failure.reasonClass) || err.message || 'Transaction failed'
    );
    if (dappTxApproveBtn) {
      dappTxApproveBtn.disabled =
        Boolean(request.paymentClosed) || waitsForFee(request) || waitsForVerdict(request);
      dappTxApproveBtn.textContent = request.failedIntent ? ACTIONS.sendAgain : 'Confirm';
    }
    dappTxFeeRetryRow?.classList.toggle('hidden', !request.feeFailed);
    setDappTxCancelEnabled(true);
    // The signing board may have replaced this screen — bring the
    // approval back so the error is actually visible.
    if (safeAccount) {
      walletState.identityView?.classList.add('hidden');
      dappTxScreen?.classList.remove('hidden');
    }
  } finally {
    request.signing = false;
    endSignatureFlight(request);
  }
}

/**
 * Confirm again after a send that left a held payment: send its signed
 * bytes again, at its one nonce. Nothing is signed. The user's press on the
 * approval that still shows this transaction is the confirmation, bound to
 * the held intent as main records it ('intent-resend'). "Always allow" is
 * not recorded from a resend. `request.failedIntent` is never cleared by a
 * failure, so this approval can't fall back to signing the payment afresh;
 * once main reports the payment no longer held, Confirm stays disabled.
 */
async function sendFailedIntentAgain(request) {
  if (dappTxApproveBtn) dappTxApproveBtn.textContent = ACTIONS.sendingAgain;
  const { result, intent, closed } = await resendHeldPayment(request.failedIntent);
  if (!result.success) {
    if (closed) request.paymentClosed = true;
    throw Object.assign(new Error(result.error || 'Transaction failed'), {
      failure: {
        outcome: result.outcome,
        reasonClass: result.reasonClass,
        intent: intent ?? request.failedIntent,
      },
    });
  }
  console.log('[WalletUI] dApp transaction sent again:', result.hash);
  request.failedIntent = null;
  request.resolve(result.hash);
  if (dappTxPending === request) closeDappTx();
}

/**
 * Enable/disable the two ways out of the approval screen (Reject, Back).
 * Both are disabled while a signature is in flight.
 */
function setDappTxCancelEnabled(enabled) {
  if (dappTxRejectBtn) dappTxRejectBtn.disabled = !enabled;
  if (dappTxBackBtn) dappTxBackBtn.disabled = !enabled;
}

/**
 * Route a dApp transaction through the Safe signing board: start the
 * pending SafeTx (free vault signatures collected silently), open the
 * board for the rest, and resolve with the execution hash once the
 * threshold is met and the executor broadcast lands. The user parking
 * the board keeps the dApp waiting (its transaction is still pending);
 * discarding rejects with EIP-1193 code 4001.
 */
async function sendViaSafeAccount(walletIndex, txParams, site, chainId) {
  const value = txParams.value ? BigInt(txParams.value).toString() : '0';
  const safeTx = { to: txParams.to, value, data: txParams.data || '0x' };
  const started = await window.wallet.safeSend(
    walletIndex,
    safeTx,
    buildSafeDappDisplay(txParams, value, site),
    // The app's chain, resolved by the provider — main refuses a chain the
    // Safe does not live on rather than executing the calldata elsewhere.
    chainId,
    // Confirmed for this site, which main records its payment under.
    await confirmSigning('safe-send', walletIndex, { tx: safeTx, chainId, origin: site })
  );
  if (!started.success) {
    throw new Error(started.error || 'Transaction failed');
  }

  const execution = awaitSafeExecution(walletIndex, started.state.safeTxHash);
  openSafeSigningBoard(walletIndex, started.state);
  return execution;
}

/** Resolve with the exec-tx hash / reject 4001 on discard, by board events. */
function awaitSafeExecution(safeIndex, safeTxHash) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('wallet:safe-executed', onExecuted);
      window.removeEventListener('wallet:safe-discarded', onDiscarded);
    };
    const onExecuted = (event) => {
      if (event.detail?.safeTxHash !== safeTxHash) return;
      cleanup();
      resolve(event.detail.hash);
    };
    const onDiscarded = (event) => {
      if (event.detail?.safeIndex !== safeIndex) return;
      cleanup();
      reject({ code: 4001, message: 'User rejected the request' });
    };
    window.addEventListener('wallet:safe-executed', onExecuted);
    window.addEventListener('wallet:safe-discarded', onDiscarded);
  });
}

/**
 * Presentation facts for the signing board / pending row. Native
 * transfers reuse the board's own amount/recipient formatting; token
 * transfers and arbitrary calldata carry a pre-composed `label` line.
 * The raw to/asset/amount still feed the payment-history row, and
 * `site` makes the board say who asked ("— requested by <site>").
 */
function buildSafeDappDisplay(txParams, value, site) {
  const decoded = decodeErc20Transfer(txParams.data);
  if (decoded) {
    return {
      site,
      asset: String(txParams.to).toLowerCase(),
      toAddress: decoded.toAddress,
      amount: decoded.amount,
      // unknown token decimals/symbol — don't pretend to format them
      label: `sending tokens to ${truncateAddress(decoded.toAddress)}`,
    };
  }
  if (!txParams.data || txParams.data === '0x') {
    return { site, asset: null, toAddress: txParams.to, amount: value };
  }
  return {
    site,
    asset: null,
    toAddress: txParams.to,
    amount: value,
    label: `a contract call to ${truncateAddress(txParams.to)}`,
  };
}

/**
 * Answer the site when the user leaves the approval (Reject, Back): 4001,
 * unless the phone may have sent the payment. Then the site hears that the
 * outcome is unknown, so it doesn't send the request again as if nothing
 * had happened (D13).
 */
function rejectDappTx() {
  if (dappTxPending?.reject) {
    dappTxPending.reject(
      dappTxPending.outcomeUnknown
        ? siteOutcomeUnknownError()
        : { code: 4001, message: 'User rejected the request' }
    );
  }
}

function closeDappTx() {
  dappTxScreen?.classList.add('hidden');
  // A Safe flow may still be showing the signing board (in-flow, not a
  // modal) — restoring the identity view under it would double-render.
  if (!isSafeSigningBoardOpen()) {
    walletState.identityView?.classList.remove('hidden');
  }
  dappTxPending = null;
  dappTxFeeCheck?.reset();
  dappTxFeeRetryRow?.classList.add('hidden');
  hideDappTxError();
  if (dappTxPasswordInput) dappTxPasswordInput.value = '';
  if (dappTxAutoApproveCheckbox) dappTxAutoApproveCheckbox.checked = false;
  if (dappTxApproveBtn) {
    dappTxApproveBtn.disabled = false;
    dappTxApproveBtn.textContent = 'Confirm';
  }
  setDappTxCancelEnabled(true);
}

function showDappTxError(message) {
  if (dappTxError) {
    dappTxError.textContent = message;
    dappTxError.classList.remove('hidden');
  }
}

function hideDappTxError() {
  dappTxError?.classList.add('hidden');
}

/**
 * Extract the 4-byte function selector from transaction data.
 * Returns null for plain ETH transfers (no data or data < 4 bytes).
 * @param {string} data - Hex-encoded transaction data (0x prefixed)
 * @returns {string|null} e.g. "0xabcd1234" or null
 */
export function extractSelector(data) {
  if (!data || typeof data !== 'string') return null;
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  if (hex.length < 8) return null;
  return '0x' + hex.slice(0, 8).toLowerCase();
}

export function decodeErc20Transfer(data) {
  if (!data || typeof data !== 'string') return null;
  const hex = data.toLowerCase();
  if (!hex.startsWith(ERC20_TRANSFER_SELECTOR) || hex.length < 138) return null;
  const recipientSlot = hex.slice(10, 74);
  const amountSlot = hex.slice(74, 138);
  if (!/^[0-9a-f]{64}$/.test(recipientSlot) || !/^[0-9a-f]{64}$/.test(amountSlot)) {
    return null;
  }
  return {
    toAddress: `0x${recipientSlot.slice(24)}`,
    amount: BigInt(`0x${amountSlot}`).toString(10),
  };
}

export function buildDappTxContext(origin, txParams = {}) {
  const decoded = decodeErc20Transfer(txParams.data);
  if (!decoded || !txParams.to) {
    return { origin };
  }
  return {
    origin,
    asset: String(txParams.to).toLowerCase(),
    toAddress: decoded.toAddress,
    amount: decoded.amount,
    metadata: { erc20Method: 'transfer' },
  };
}
