/**
 * dApp Transaction Approval Module
 *
 * Transaction approval screen for dApp-initiated transactions.
 *
 * From freedom-core design 0011 PRQ-5b a page's send is main's: main shows
 * its prompt (`eth.send`, through page-prompts.js) and this screen renders
 * main's view: the site main attested, the account, the chain, the
 * transaction in main's form, the fee main quoted and the fee check's
 * verdict. It answers the handle (`page:decide`) with the choices it offers,
 * "always allow" and the fee confirmed again above the threshold. Main mints
 * the approval's token and sends. An approved send keeps the screen, its
 * Confirm button showing the device step, until main has answered the page,
 * or until main asks again (the fee newly above the threshold at the press,
 * or quoted again), whose prompt the screen shows in place. A Safe's
 * approval takes the screen down at once, for its signing board.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { beginSignatureFlight, endSignatureFlight } from './signature-flight.js';
import { open as openSidebarPanel } from '../sidebar.js';
import {
  bypassUnlockGateForDevice,
  bypassUnlockGateForSafe,
  signingButtonLabel,
  renderSafeFeePayer,
} from './wallet-utils.js';
import { isSafeSigningBoardOpen } from './safe-signing.js';
import { FeeConfirmation } from './fee-check.js';
import { registerDappPrompt } from './dapp-prompt-guard.js';
import { registerPagePromptRenderer, pagePromptDisplaced } from '../page-prompt-renderers.js';

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

// The approval's fee check at confirmation (freedom-core design 0005, A),
// as main judged it. Confirm also waits for the fee itself (`feeKnown`):
// main never signs a dApp transaction with fees the user didn't see
// (waitsForFee).
let dappTxFeeCheck = null;
const DAPP_TX_CONFIRM_LABEL = 'Confirm';
// While the screen paints a page prompt, the hider it runs is its own.
let presentingPagePrompt = false;

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

  // Register screen hider. A page prompt another screen hides stays main's
  // shown prompt: it is told, so it can show again once that screen is done.
  registerScreenHider(() => {
    dappTxScreen?.classList.add('hidden');
    const request = dappTxPending;
    if (!presentingPagePrompt && request && !request.deciding) {
      dappTxPending = null;
      walletState.identityView?.classList.remove('hidden');
      pagePromptDisplaced(request.handle);
    }
  });
  registerPagePromptRenderer('eth.send', {
    show: showPageSend,
    close: closePageSend,
    isShowing: shownPageSend,
    takesOver: pageSendTakesOver,
  });
  // Showing an undecided transaction: newcomers wait (dapp-prompt-guard.js).
  registerDappPrompt(
    () => dappTxPending !== null && Boolean(dappTxScreen) && !dappTxScreen.classList.contains('hidden')
  );

  setupDappTxScreen();
}

function setupDappTxScreen() {
  const reject = () => {
    if (!dappTxPending) {
      closeDappTx();
      return;
    }
    if (dappTxPending.signing || dappTxPending.deciding) return;
    decidePageSend(dappTxPending, false);
  };
  dappTxBackBtn?.addEventListener('click', reject);
  dappTxRejectBtn?.addEventListener('click', reject);

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
 * The user asks for the fee again after a quote failed. Main quotes a
 * page's send: an approval of its prompt with no fee asks main for the
 * quote again, on a new prompt.
 */
function retryDappTxFee() {
  const request = dappTxPending;
  if (!request || request.signing || request.deciding || !request.feeFailed) return;
  decidePageSend(request, true, {}, { retry: true });
}

/**
 * Whether `request`'s Confirm waits for its fee (design 0005, A): main
 * never signs a dApp transaction with fees the user didn't see. Main
 * quoted it, or Confirm waits for its quote again. A Safe's executor fee
 * is checked when it executes.
 */
function waitsForFee(request) {
  if (!request) return false;
  return !request.safe && !request.feeKnown;
}

/**
 * Confirm's state for the request shown: disabled while the vault is
 * locked or its fee isn't known; and the way to ask for the fee again
 * after a quote failed.
 */
function syncDappTxConfirm() {
  const request = dappTxPending;
  if (!request) return;
  dappTxFeeRetryRow?.classList.toggle('hidden', !request.feeFailed || Boolean(request.signing));
  if (!dappTxApproveBtn || request.signing) return;
  dappTxApproveBtn.disabled = Boolean(request.locked || waitsForFee(request));
}

/** The vault's state for the request shown, and Confirm's with it. */
function setDappTxLocked(locked) {
  if (dappTxPending) dappTxPending.locked = locked;
  syncDappTxConfirm();
}

function renderDappTxConfirmLabel() {
  if (!dappTxApproveBtn || !dappTxFeeCheck) return;
  if (dappTxPending?.signing) return;
  dappTxApproveBtn.textContent = dappTxFeeCheck.confirmLabel(DAPP_TX_CONFIRM_LABEL);
}

// Writes the unlock UI only while `request` is still the pending one.
async function checkDappTxUnlockStatus(request) {
  try {
    if (
      bypassUnlockGateForDevice(request?.walletIndex, dappTxUnlock, dappTxApproveBtn) ||
      bypassUnlockGateForSafe(request?.walletIndex, dappTxUnlock, dappTxApproveBtn)
    ) {
      setDappTxLocked(false);
      return;
    }

    const status = await window.identity.getStatus();
    if (dappTxPending !== request) return;

    if (status.isUnlocked) {
      dappTxUnlock?.classList.add('hidden');
      setDappTxLocked(false);
      return;
    }

    dappTxUnlock?.classList.remove('hidden');
    setDappTxLocked(true);

    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    if (dappTxPending !== request) return;
    const touchIdEnabled = await window.quickUnlock.isEnabled();
    if (dappTxPending !== request) return;
    const hasTouchId = canUseTouchId && touchIdEnabled;

    const vaultMeta = await window.identity.getVaultMeta();
    if (dappTxPending !== request) return;
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
    // A replaced request's failure paints nothing on its successor.
    if (dappTxPending !== request) return;
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
  approvePageSend(dappTxPending);
}

/**
 * Render main's send prompt (`page:prompt`, kind `eth.send`): the site main
 * attested, the account and chain, the transaction in main's form, the fee
 * main quoted and the fee check's verdict. The page's own text and images
 * aren't shown. The caller shows it only while nothing else holds the
 * sidebar (`page-prompts.js`), or in place of this request's decided prompt
 * (`pageSendTakesOver`).
 */
export function showPageSend(prompt) {
  const view = prompt?.view || {};
  const account = view.account || {};
  const tx = view.tx || {};
  const chain = view.chain || {};
  const symbol = typeof chain.symbol === 'string' && chain.symbol ? chain.symbol : 'ETH';
  const previous = dappTxPending;
  const safe = account.type === 'safe';
  const request = {
    handle: prompt.handle,
    guest: prompt.guest,
    walletIndex: account.index,
    safe,
    phone: account.type === 'remote',
    feeKnown: Boolean(view.fee) && !safe,
    feeFailed: !safe && !view.fee,
    alwaysAllowOffered: view.alwaysAllow === true,
    chain: { nativeSymbol: symbol },
    deciding: false,
    signing: false,
  };
  // This request's decided prompt, which main asked again: its lock goes
  // with it, and its screen shows the new prompt.
  if (previous?.deciding) endSignatureFlight(previous);
  dappTxPending = request;
  try {
    renderPageSend(request, prompt, view, tx, chain, symbol);
  } catch (err) {
    // What can't be shown is never sent.
    console.error('[WalletUI] A send prompt main sent can’t be shown:', err);
    dappTxPending = null;
    decideHandle(request.handle, false);
    return;
  }
  // Confirm waits for the unlock check (a vault account needs the vault open).
  request.locked = true;
  syncDappTxConfirm();
  checkDappTxUnlockStatus(request);

  presentingPagePrompt = true;
  try {
    hideAllSubscreens();
  } finally {
    presentingPagePrompt = false;
  }
  walletState.identityView?.classList.add('hidden');
  dappTxScreen?.classList.remove('hidden');
  openSidebarPanel();
}

function renderPageSend(request, prompt, view, tx, chain, symbol) {
  if (dappTxSite) dappTxSite.textContent = prompt?.site?.label || prompt?.site?.key || 'Unknown';
  if (dappTxAutoApproveCheckbox) dappTxAutoApproveCheckbox.checked = false;
  dappTxAutoApproveRow?.classList.toggle('hidden', !request.alwaysAllowOffered);
  setDappTxCancelEnabled(true);
  hideDappTxError();
  if (dappTxTo) {
    const to = typeof tx.to === 'string' ? tx.to : '';
    dappTxTo.textContent = to ? `${to.slice(0, 10)}…${to.slice(-8)}` : 'Contract Creation';
    dappTxTo.title = to;
  }
  if (dappTxValue) {
    const value = BigInt(typeof tx.value === 'string' && tx.value ? tx.value : '0');
    dappTxValue.textContent = `${(Number(value) / 1e18).toFixed(6)} ${symbol}`;
  }
  if (dappTxData) {
    const data = typeof tx.data === 'string' ? tx.data : '';
    const call = Boolean(data) && data !== '0x';
    dappTxData.textContent = call ? `${data.slice(0, 20)}…` : 'No data';
    dappTxData.title = call ? data : '';
    dappTxDataRow?.classList.remove('hidden');
    dappTxWarning?.classList.toggle('hidden', !call);
  }
  if (dappTxNetwork) dappTxNetwork.textContent = chain.name || `Chain ${chain.id}`;
  dappTxFeeCheck?.reset(symbol);
  if (request.safe) {
    // The executor pays the execution fee, checked as it executes.
    if (dappTxFee) renderSafeFeePayer(dappTxFee, request.walletIndex);
  } else if (view.fee) {
    const estimate = BigInt(typeof view.fee.estimate === 'string' ? view.fee.estimate : '0');
    if (dappTxFee) dappTxFee.textContent = `~${(Number(estimate) / 1e18).toFixed(6)} ${symbol}`;
    // The fee check's verdict, and the most the send can cost, as main
    // judged them; asked again when main found the fee newly above.
    dappTxFeeCheck?.show(view.feeCheck || null, symbol, { askAgain: view.feeAskAgain === true });
  } else if (dappTxFee) {
    dappTxFee.textContent = 'Unable to estimate';
  }
  if (dappTxApproveBtn) dappTxApproveBtn.textContent = DAPP_TX_CONFIRM_LABEL;
  renderDappTxConfirmLabel();
}

/**
 * Take down main's prompt `handle` (hidden, closed, or refused). A decided
 * send keeps the screen until main answers it, or asks again.
 */
export function closePageSend(handle) {
  const request = dappTxPending;
  if (!request || request.handle !== handle) return false;
  if (request.deciding) return true;
  closeDappTx();
  return true;
}

/** The page prompt the screen shows, or null. */
export function shownPageSend() {
  return dappTxPending && dappTxScreen && !dappTxScreen.classList.contains('hidden')
    ? dappTxPending.handle
    : null;
}

/**
 * Whether the screen takes `prompt` in place of the prompt it shows: this
 * request's prompt, which the user decided and main is still working on,
 * asked again. A document has one wallet request waiting at a time, so a
 * send prompt of the same tab while one is decided is the same request's.
 */
export function pageSendTakesOver(prompt) {
  const request = dappTxPending;
  return Boolean(
    request?.deciding &&
      prompt?.kind === 'eth.send' &&
      prompt.handle !== request.handle &&
      prompt.guest === request.guest
  );
}

async function decideHandle(handle, approve, choices = {}) {
  try {
    return await window.pagePrompts?.decide?.(handle, approve, choices);
  } catch (err) {
    console.error('[WalletUI] The decision did not reach main:', err);
    return null;
  }
}

// The user pressed Confirm on main's prompt. A fee above the threshold is
// confirmed twice (design 0005, A): the first press asks again.
function approvePageSend(request) {
  if (request.deciding || request.locked || waitsForFee(request)) return;
  const checked = !request.safe && !request.phone;
  if (checked && dappTxFeeCheck && !dappTxFeeCheck.proceed()) {
    renderDappTxConfirmLabel();
    return;
  }
  const choices = {};
  if (request.alwaysAllowOffered) choices.alwaysAllow = Boolean(dappTxAutoApproveCheckbox?.checked);
  if (checked && dappTxFeeCheck?.options()?.feeAcknowledged) choices.feeAcknowledged = true;
  decidePageSend(request, true, choices);
}

// Answer main's prompt: the decision counts only for the handle main shows
// at this moment. Main sends, and answers once the page has its answer, or
// shows this request's next prompt, which the screen takes in place. A
// Safe's approval goes on to its signing board, which main shows next.
async function decidePageSend(request, approve, choices = {}, { retry = false } = {}) {
  if (request.deciding) return;
  request.deciding = true;
  if (approve && retry) {
    if (dappTxFee) dappTxFee.textContent = 'Estimating…';
    dappTxFeeRetryRow?.classList.add('hidden');
  } else if (approve && !request.safe) {
    // The signature may be a device's: nothing may paint over it.
    request.signing = true;
    beginSignatureFlight(request);
    if (dappTxApproveBtn) {
      dappTxApproveBtn.disabled = true;
      dappTxApproveBtn.textContent = signingButtonLabel(request.walletIndex);
    }
    setDappTxCancelEnabled(false);
  }
  if (!approve || request.safe) {
    if (dappTxPending === request) closeDappTx();
  }
  try {
    await decideHandle(request.handle, approve, approve ? choices : {});
  } finally {
    request.signing = false;
    request.deciding = false;
    endSignatureFlight(request);
    if (dappTxPending === request) closeDappTx();
  }
}

/**
 * Enable/disable the two ways out of the approval screen (Reject, Back).
 * Both are disabled while a signature is in flight.
 */
function setDappTxCancelEnabled(enabled) {
  if (dappTxRejectBtn) dappTxRejectBtn.disabled = !enabled;
  if (dappTxBackBtn) dappTxBackBtn.disabled = !enabled;
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
