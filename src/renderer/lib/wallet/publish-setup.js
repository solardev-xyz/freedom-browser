/**
 * Publish Setup Module
 *
 * The sidebar screen that takes a profile from "cannot publish" to "can
 * publish" in one payment: pick a storage plan, send the quoted xDAI to the
 * Swarm node (from the Freedom wallet, or from any wallet by QR), and the node
 * swaps it, buys the storage and funds its chequebook. Extensions and deposit
 * top-ups started from the storage screen run through the same pay step.
 *
 * The state lives in the main process (src/main/swarm/publish-setup-service.js):
 * readiness, the armed operation and its quotes. This module renders it and
 * forwards the user's choices, so closing the screen drops nothing; the
 * purchase goes through as soon as the payment arrives.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { refuseSubscreenWhileInFlight } from './signature-flight.js';
import { openSend } from './send.js';
import { generateThemedQr } from './receive.js';
import { openStampManager } from './stamp-manager.js';
import { GNOSIS_CHAIN_ID, XDAI_TOKEN_KEY } from './funding-actions.js';
import {
  buildFundUrl,
  buildPaymentUri,
  describeDone,
  describeExecuting,
  describeOperationTarget,
  describeOperationTitle,
  describePlan,
} from './swarm-readiness.js';
import { createTab } from '../tabs.js';
import { isVisible as isSidebarVisible } from '../sidebar.js';

// DOM references
let screen;
let titleEl;
let backBtn;
let originNote;
let originText;
let errorNote;
let nodeView;
let nodeText;
let nodeActionBtn;
let plansView;
let plansWarning;
let plansWarningText;
let planList;
let plansError;
let readyView;
let readyText;
let manageBtn;
let buyMoreBtn;
let payView;
let payLabel;
let payAmount;
let payBalance;
let payDeposit;
let payDepositText;
let payWalletBtn;
let payWalletError;
let payQr;
let payAddress;
let payCopyBtn;
let fundLinkBtn;
let payStatus;
let payCancelBtn;
let executingView;
let executingTitle;
let executingText;
let doneView;
let doneText;
let doneManageBtn;
let doneCloseBtn;
let failedView;
let failedUncertain;
let failedUncertainText;
let failedText;
let failedRetryBtn;
let failedCancelBtn;

let isOpen = false;
let setupState = null;
// The user asked for the plan list although the node can already publish.
let showPlans = false;
let plans = null;
let plansLoading = false;
let plansRequestId = 0;
// When the plan prices were last fetched; a failed fetch is retried on a
// later render once this is PLANS_RETRY_MS old.
let plansLoadedAt = 0;
const PLANS_RETRY_MS = 10_000;
// Why the last purchase, extension or top-up could not start (arm refused),
// shown above whichever view is up until the user does something else.
let startError = null;
// The id of a finished (done/failed) operation this screen has shown. Leaving
// the screen dismisses it, so a later visit starts from readiness instead of
// a stale result.
let shownFinishedOpId = null;
// The site whose publish request brought the user here, and the provider's
// 4900 reason for refusing it.
let requestOrigin = null;
let requestReason = null;
// The finished (done/failed) operation this window has left. The main process
// keeps it while another window still shows it, so this window hides it
// itself rather than open on it again.
let dismissedOpId = null;
// The payment the Send screen we opened for the pay step was prefilled with
// ({ to, wei }), while that screen is up.
let walletPayment = null;
let renderedQrUri = null;

export function initPublishSetup() {
  screen = document.getElementById('sidebar-publish-setup');
  titleEl = document.getElementById('publish-setup-title');
  backBtn = document.getElementById('publish-setup-back');
  originNote = document.getElementById('publish-setup-origin');
  originText = document.getElementById('publish-setup-origin-text');
  errorNote = document.getElementById('publish-setup-error');
  nodeView = document.getElementById('publish-setup-node');
  nodeText = document.getElementById('publish-setup-node-text');
  nodeActionBtn = document.getElementById('publish-setup-node-action');
  plansView = document.getElementById('publish-setup-plans');
  plansWarning = document.getElementById('publish-setup-plans-warning');
  plansWarningText = document.getElementById('publish-setup-plans-warning-text');
  planList = document.getElementById('publish-plan-list');
  plansError = document.getElementById('publish-plans-error');
  readyView = document.getElementById('publish-setup-ready');
  readyText = document.getElementById('publish-setup-ready-text');
  manageBtn = document.getElementById('publish-setup-manage');
  buyMoreBtn = document.getElementById('publish-setup-buy-more');
  payView = document.getElementById('publish-setup-pay');
  payLabel = document.getElementById('publish-pay-label');
  payAmount = document.getElementById('publish-pay-amount');
  payBalance = document.getElementById('publish-pay-balance');
  payDeposit = document.getElementById('publish-pay-deposit');
  payDepositText = document.getElementById('publish-pay-deposit-text');
  payWalletBtn = document.getElementById('publish-pay-wallet');
  payWalletError = document.getElementById('publish-pay-wallet-error');
  payQr = document.getElementById('publish-pay-qr');
  payAddress = document.getElementById('publish-pay-address');
  payCopyBtn = document.getElementById('publish-pay-copy');
  fundLinkBtn = document.getElementById('publish-pay-fund-link');
  payStatus = document.getElementById('publish-pay-status');
  payCancelBtn = document.getElementById('publish-pay-cancel');
  executingView = document.getElementById('publish-setup-executing');
  executingTitle = document.getElementById('publish-executing-title');
  executingText = document.getElementById('publish-executing-text');
  doneView = document.getElementById('publish-setup-done');
  doneText = document.getElementById('publish-done-text');
  doneManageBtn = document.getElementById('publish-done-manage');
  doneCloseBtn = document.getElementById('publish-done-close');
  failedView = document.getElementById('publish-setup-failed');
  failedUncertain = document.getElementById('publish-failed-uncertain');
  failedUncertainText = document.getElementById('publish-failed-uncertain-text');
  failedText = document.getElementById('publish-failed-text');
  failedRetryBtn = document.getElementById('publish-failed-retry');
  failedCancelBtn = document.getElementById('publish-failed-cancel');

  registerScreenHider(() => closePublishSetup());

  backBtn?.addEventListener('click', () => closePublishSetup());
  manageBtn?.addEventListener('click', () => openStorage());
  buyMoreBtn?.addEventListener('click', () => {
    showPlans = true;
    startError = null;
    render();
  });
  payWalletBtn?.addEventListener('click', () => payFromWallet());
  payCopyBtn?.addEventListener('click', () => copyPaymentAddress());
  fundLinkBtn?.addEventListener('click', () => openFundLink());
  payCancelBtn?.addEventListener('click', () => cancelOperation());
  doneManageBtn?.addEventListener('click', () => {
    void dismissOperation();
    openStorage();
  });
  doneCloseBtn?.addEventListener('click', () => {
    void dismissOperation();
    closePublishSetup();
  });
  // A failure that may still have landed on chain puts checking the storage
  // first: retrying at once could pay for a second batch.
  failedRetryBtn?.addEventListener('click', () => {
    if (setupState?.operation?.uncertain) {
      void dismissOperation();
      openStorage();
    } else {
      retryOperation();
    }
  });
  failedCancelBtn?.addEventListener('click', () => {
    if (setupState?.operation?.uncertain) retryOperation();
    else cancelOperation();
  });
  nodeActionBtn?.addEventListener('click', () => restartNode());

  window.publishSetup?.onState((state) => {
    setupState = state;
    if (isOpen) render();
  });

  // The pay step's own Send: follow the transaction to its receipt, since a
  // mined but reverted payment sends nothing. Only a transaction that still
  // pays the node is tracked: the user can edit the prefilled Send.
  window.addEventListener('wallet:tx-success', (event) => {
    const hash = event.detail?.hash;
    if (hash && isNodePayment(event.detail, walletPayment)) {
      void window.publishSetup?.trackFundingTx(hash);
    }
  });
}

/**
 * Open the setup screen. `origin` names a site whose publish request failed
 * for a setup reason (the swarm provider routes it here) and `reason` is that
 * refusal's 4900 reason; `error` says why a purchase the opener tried to start
 * was refused (the storage and deposit screens arm before they hand over).
 */
export async function openPublishSetup({ origin = null, error = null, reason = null } = {}) {
  if (refuseSubscreenWhileInFlight('Publish setup screen')) return;

  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');
  isOpen = true;
  requestOrigin = typeof origin === 'string' && origin ? origin : null;
  requestReason = requestOrigin && typeof reason === 'string' ? reason : null;
  showPlans = false;
  plans = null;
  plansLoadedAt = 0;
  renderedQrUri = null;
  startError = typeof error === 'string' && error ? error : null;
  shownFinishedOpId = null;
  show(payWalletError, false);
  void window.publishSetup?.watch('publish-setup', true);

  render();
  try {
    setupState = (await window.publishSetup?.getState()) || setupState;
  } catch (err) {
    console.error('[PublishSetup] Failed to read setup state:', err);
  }
  if (isOpen) render();
}

export function closePublishSetup() {
  if (isOpen) void window.publishSetup?.watch('publish-setup', false);
  // A result the user has seen is over once they leave it: dismiss it, or
  // the next visit (Buy More Storage, a site's request) opens on it. Only for
  // this window: main keeps it while another window's screen shows it.
  const op = visibleOperation(setupState);
  if (
    isOpen &&
    op &&
    op.id === shownFinishedOpId &&
    (op.phase === 'done' || op.phase === 'failed')
  ) {
    void dismissOperation();
  }
  shownFinishedOpId = null;
  startError = null;
  isOpen = false;
  requestOrigin = null;
  requestReason = null;
  screen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
}

// ============================================
// Rendering
// ============================================

function show(el, visible) {
  el?.classList.toggle('hidden', !visible);
}

// The operation this window shows: a finished one it has left is gone here
// even while main still holds it for another window.
function visibleOperation(state) {
  const op = state?.operation;
  if (!op) return null;
  if (op.id === dismissedOpId && (op.phase === 'done' || op.phase === 'failed')) return null;
  return op;
}

// A site's write found no batch with room for it while the node can publish:
// the storage exists, it is just too small or full for that upload.
function isRoomShortfall(state) {
  return (
    Boolean(requestOrigin) &&
    requestReason === 'no-usable-stamps' &&
    state?.readiness?.key === 'ready' &&
    !visibleOperation(state)
  );
}

function currentView(state) {
  const op = visibleOperation(state);
  if (op) {
    if (op.phase === 'executing' || op.phase === 'confirming') return 'executing';
    if (op.phase === 'done') return 'done';
    if (op.phase === 'failed') return 'failed';
    return 'pay';
  }
  const key = state?.readiness?.key;
  if (!state || key === 'checking') return 'node';
  if (!state.canBuy) return 'node';
  // Storage that exists but is still reaching the network needs no purchase.
  if ((key === 'ready' || key === 'storage-pending') && !showPlans) return 'ready';
  // "Buy More Storage" from either. On a node without Ant's `propagating`
  // flag, a batch still "reaching the network" can be one the peers never
  // accept, so a new plan stays one click away.
  if (key === 'ready' || key === 'storage-pending' || key === 'needs-storage') return 'plans';
  return 'node';
}

function render() {
  if (!isOpen) return;
  const state = setupState;
  const view = currentView(state);
  const op = visibleOperation(state);
  const roomShortfall = isRoomShortfall(state);

  if (titleEl) titleEl.textContent = describeOperationTitle(op);

  if ((view === 'done' || view === 'failed') && op?.id != null) shownFinishedOpId = op.id;

  show(originNote, Boolean(requestOrigin) && view !== 'done');
  show(errorNote, Boolean(startError));
  if (errorNote) errorNote.textContent = startError || '';
  if (originText && requestOrigin) {
    originText.textContent = roomShortfall
      ? `${requestOrigin} tried to publish more than your storage has room for.`
      : `${requestOrigin} wants to publish on Swarm. Set up publishing to let it.`;
  }

  show(nodeView, view === 'node');
  show(plansView, view === 'plans');
  show(readyView, view === 'ready');
  show(payView, view === 'pay');
  show(executingView, view === 'executing');
  show(doneView, view === 'done');
  show(failedView, view === 'failed');

  if (view === 'node') renderNode(state);
  if (view === 'plans') renderPlans();
  // Ant's search for storage this wallet already owns stopped finishing
  // (a scan that keeps failing): the plans show, with why to look first.
  const stalled = view === 'plans' && state.readiness?.scanStalled === true;
  show(plansWarning, stalled);
  if (plansWarningText) plansWarningText.textContent = stalled ? state.readiness.message : '';
  if (view === 'ready' && readyText) {
    readyText.textContent = roomShortfall
      ? 'None of your storage batches has room for that upload. Make one bigger under Manage Storage, or buy more storage.'
      : state.readiness.message;
  }
  if (view === 'pay') renderPay(state, op);
  if (view === 'executing') {
    const copy = describeExecuting(op);
    if (executingTitle) executingTitle.textContent = copy.title;
    if (executingText) executingText.textContent = copy.text;
  }
  if (view === 'done' && doneText) doneText.textContent = describeDone(op);
  if (view === 'failed') {
    const uncertain = op.uncertain === true;
    const message = op.error || 'The purchase failed.';
    show(failedUncertain, uncertain);
    show(failedText, !uncertain);
    if (failedUncertainText) failedUncertainText.textContent = message;
    if (failedText) failedText.textContent = message;
    if (failedRetryBtn) failedRetryBtn.textContent = uncertain ? 'Check Storage' : 'Try Again';
    if (failedCancelBtn) failedCancelBtn.textContent = uncertain ? 'Try Again' : 'Cancel';
  }
}

function renderNode(state) {
  if (!state) {
    if (nodeText) nodeText.textContent = 'Checking the Swarm node…';
    show(nodeActionBtn, false);
    return;
  }
  const readiness = state.readiness || {};
  let message = readiness.message || 'Checking the Swarm node…';
  if (state.node?.registryMode === 'reused') {
    message =
      'This Swarm node was already running when Freedom started, so it is managed outside Freedom. Buy storage for it with the tools that run it.';
  } else if (state.account?.storage === 'missing' && readiness.key !== 'ready') {
    message = 'This Swarm node cannot buy storage with xDAI. It needs a newer version of Ant.';
  } else if (state.account?.storage === 'no-chain') {
    message =
      'The Swarm node has no Gnosis Chain connection for transactions, so it cannot buy storage.';
  }
  if (state.restart?.inProgress) message = 'Restarting the Swarm node…';
  else if (state.restart?.error) message = `${message} Restart failed: ${state.restart.error}`;
  if (nodeText) nodeText.textContent = message;

  const key = readiness.key;
  const offerRestart =
    state.canRestart &&
    !state.restart?.inProgress &&
    (key === 'stopped' || key === 'error' || key === 'unreachable' || readiness.slow === true);
  show(nodeActionBtn, offerRestart);
  if (nodeActionBtn) nodeActionBtn.textContent = key === 'stopped' ? 'Start Node' : 'Restart Node';
}

function renderPlans() {
  const failed = Boolean(plans?.some((p) => p.error));
  const stale = failed && Date.now() - plansLoadedAt >= PLANS_RETRY_MS;
  if ((!plans || stale) && !plansLoading) void loadPlans();
  if (!planList) return;

  const byId = new Map((plans || []).map((p) => [p.id, p]));
  const list = setupState?.plans || [];
  planList.innerHTML = '';
  list.forEach((plan) => {
    const quoted = byId.get(plan.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stamp-preset-btn';
    btn.disabled = !quoted?.quote;

    const label = document.createElement('span');
    label.className = 'stamp-preset-label';
    if (quoted?.quote) label.textContent = `${plan.title} · ${quoted.quote.price.display} xDAI`;
    else label.textContent = plansLoading || !plans ? `${plan.title} · …` : plan.title;

    const desc = document.createElement('span');
    desc.className = 'stamp-preset-desc';
    desc.textContent = describePlan(plan);

    btn.append(label, desc);
    btn.addEventListener('click', () => armOperation({ kind: 'buy', planId: plan.id }));
    planList.appendChild(btn);
  });

  const firstError = (plans || []).find((p) => p.error)?.error;
  const errorText = plansLoading ? '' : firstError || '';
  show(plansError, Boolean(errorText));
  if (plansError) plansError.textContent = errorText;
}

async function loadPlans() {
  const requestId = ++plansRequestId;
  plansLoading = true;
  try {
    const result = await window.publishSetup?.getPlans();
    if (requestId !== plansRequestId) return;
    plans = result?.plans || [];
  } catch (err) {
    if (requestId !== plansRequestId) return;
    plans = [{ error: err.message || 'Could not get prices from the Swarm node.' }];
  } finally {
    if (requestId === plansRequestId) {
      plansLoading = false;
      plansLoadedAt = Date.now();
    }
  }
  render();
}

function renderPay(state, op) {
  const quote = op.quote;
  if (payLabel) payLabel.textContent = describeOperationTarget(op, state.plans);
  if (payAmount) payAmount.textContent = quote ? `${quote.send.display} xDAI` : 'Getting a price…';
  if (payBalance) {
    payBalance.textContent = quote?.walletXdai ? `Your node holds ${quote.walletXdai} xDAI` : '';
  }

  show(payDeposit, Boolean(quote?.depositXbzz) && op.request.kind !== 'deposit');
  if (payDepositText && quote?.depositXbzz) {
    payDepositText.textContent = `Includes a one-time ${quote.depositXbzz} xBZZ chequebook deposit, which pays other nodes for your uploads' bandwidth. It stays yours until it is spent.`;
  }

  if (payWalletBtn) payWalletBtn.disabled = !quote;
  if (payAddress) payAddress.textContent = quote?.walletAddress || '';
  if (payCopyBtn) payCopyBtn.disabled = !quote;
  if (fundLinkBtn) fundLinkBtn.disabled = !quote;

  const uri = quote ? buildPaymentUri(quote.walletAddress, quote.send.wei) : null;
  if (uri !== renderedQrUri) {
    renderedQrUri = uri;
    if (payQr) payQr.removeAttribute('src');
    if (uri) {
      generateThemedQr(uri).then((dataUrl) => {
        if (dataUrl && payQr && renderedQrUri === uri) {
          payQr.src = dataUrl;
          payQr.alt = `Payment request: ${quote.send.display} xDAI to ${quote.walletAddress}`;
        }
      });
    }
  }

  if (payStatus) payStatus.textContent = describePayStatus(op);
}

function describePayStatus(op) {
  const tx = op.fundingTx;
  if (tx?.status === 'failed') return op.notice || 'Your payment failed on Gnosis Chain.';
  if (op.notice) return op.notice;
  if (tx?.status === 'pending') return 'Payment sent. Waiting for Gnosis Chain to confirm it…';
  if (tx?.status === 'confirmed') return 'Payment confirmed. Waiting for your node to see it…';
  if (!op.quote) return 'Getting a price from your Swarm node…';
  return 'Waiting for payment… Your node starts as soon as it arrives.';
}

// ============================================
// Actions
// ============================================

async function armOperation(request) {
  startError = null;
  show(payWalletError, false);
  const result = await window.publishSetup?.arm(request);
  if (result && !result.ok) {
    // Shown above whatever view is up: a refused Try Again leaves the
    // failed view in place, where the plan list's own error is hidden.
    startError = result.error || 'Could not start the purchase.';
    render();
    return;
  }
  if (result?.state) setupState = result.state;
  render();
}

async function cancelOperation() {
  startError = null;
  const result = await window.publishSetup?.cancel();
  if (result?.state) setupState = result.state;
  render();
}

// Dismiss the finished operation on screen, and only that one: hidden here at
// once, dropped in main once no other window's screen shows it.
async function dismissOperation() {
  const id = visibleOperation(setupState)?.id;
  if (id == null) return;
  dismissedOpId = id;
  const result = await window.publishSetup?.dismiss(id);
  if (result?.state) setupState = result.state;
}

function retryOperation() {
  const request = setupState?.operation?.request;
  if (request) void armOperation(request);
}

async function restartNode() {
  if (nodeActionBtn) nodeActionBtn.disabled = true;
  try {
    await window.publishSetup?.restartNode();
  } finally {
    if (nodeActionBtn) nodeActionBtn.disabled = false;
  }
}

/**
 * Pay from the Freedom wallet: a plain xDAI transfer to the node, reviewed
 * and signed like any other Send, so the vault, a Ledger, a Safe or a phone
 * can each sign it.
 */
async function payFromWallet() {
  const quote = setupState?.operation?.quote;
  if (!quote) return;
  show(payWalletError, false);

  closePublishSetup();
  walletPayment = { to: quote.walletAddress, wei: quote.send.wei };
  const result = await openSend({
    recipient: quote.walletAddress,
    chainId: GNOSIS_CHAIN_ID,
    tokenKey: XDAI_TOKEN_KEY,
    tokenSymbol: 'xDAI',
    amount: quote.send.display,
    onClose: returnFromSend,
  });
  if (!result?.opened) {
    walletPayment = null;
    // A Safe with a transaction already waiting opens its signing board
    // instead; that board explains itself and keeps the sidebar.
    if (!isWalletHomeShown()) return;
    await openPublishSetup();
    if (payWalletError) {
      payWalletError.textContent = result?.reason || 'The Send screen could not open.';
      show(payWalletError, true);
    }
  }
}

function returnFromSend({ handedOff = false } = {}) {
  walletPayment = null;
  // A Safe send hands the sidebar to its signing board: stay away.
  if (handedOff) return;
  // A sidebar close also closes Send; only come back while the user is here
  // and no other screen has taken the sidebar meanwhile.
  setTimeout(() => {
    if (isSidebarVisible() && isWalletHomeShown() && visibleOperation(setupState)) {
      void openPublishSetup();
    }
  }, 0);
}

// The wallet home is what a closed sub-screen leaves behind; any other
// screen up hides it.
function isWalletHomeShown() {
  return !walletState.identityView?.classList.contains('hidden');
}

/**
 * Whether a sent transaction (the `wallet:tx-success` detail) is the pay
 * step's payment: native xDAI on Gnosis to the node wallet, at least the
 * prefilled amount.
 */
export function isNodePayment(detail, expected) {
  if (!detail || !expected?.to || !expected.wei) return false;
  if (Number(detail.chainId) !== GNOSIS_CHAIN_ID || detail.asset != null) return false;
  if (typeof detail.to !== 'string' || detail.to.toLowerCase() !== expected.to.toLowerCase()) {
    return false;
  }
  try {
    return BigInt(detail.value) >= BigInt(expected.wei);
  } catch {
    return false;
  }
}

async function copyPaymentAddress() {
  const address = setupState?.operation?.quote?.walletAddress;
  if (!address) return;
  try {
    await window.electronAPI?.copyText?.(address);
    const label = payCopyBtn?.querySelector('span');
    payCopyBtn?.classList.add('copied');
    if (label) label.textContent = 'Copied!';
    setTimeout(() => {
      payCopyBtn?.classList.remove('copied');
      if (label) label.textContent = 'Copy Address';
    }, 2000);
  } catch (err) {
    console.error('[PublishSetup] Copy address failed:', err);
  }
}

function openFundLink() {
  const quote = setupState?.operation?.quote;
  if (!quote) return;
  createTab(buildFundUrl(quote.walletAddress, quote.send.display));
}

function openStorage() {
  closePublishSetup();
  openStampManager();
}
