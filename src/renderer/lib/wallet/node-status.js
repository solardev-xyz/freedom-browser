/**
 * Node Status Module
 *
 * Node cards, status badges, Swarm balances, and publishing setup CTA.
 *
 * The Swarm card renders the main-process publish setup state
 * (src/main/swarm/publish-setup-service.js): the node's mode, its wallet and
 * chequebook balances, and whether it can publish. The balances are chain
 * reads, so the card asks the service to poll them only while it is on
 * screen.
 *
 * Its Browsing Credit group (#488) renders the browsing credit service
 * (src/main/swarm/browsing-credit-service.js): the chequebook's spendable
 * balance, the recent spend, whether the node pays peers, and the node's
 * `swap-enable` switch. It is read on the same on-screen cadence.
 */

import { state } from '../state.js';
import { truncateAddress } from './wallet-utils.js';
import { describePublishCta, formatSwarmMode } from './swarm-readiness.js';
import { openPublishSetup } from './publish-setup.js';
import { openStampManager } from './stamp-manager.js';
import { topUpXdai } from './funding-actions.js';
import { openChequebookDeposit } from './chequebook-deposit.js';
import { openPublisherIdentities } from './publisher-identities.js';
import { describeBrowsingCredit } from './browsing-credit.js';

// Share of the Swarm card that must be on screen for it to count as shown.
const CARD_VISIBLE_RATIO = 0.05;
// How often the Browsing Credit group re-reads while the card is shown. The
// service throttles the chain reads behind it to the same pace.
const CREDIT_REFRESH_MS = 15_000;

// DOM references
let swarmModeBadge;
let swarmStatusBadge;
let swarmCardContent;
let swarmBalanceXdaiEl;
let swarmBalanceXbzzEl;
let swarmWalletGroup;
let swarmChequebookGroup;
let swarmChequebookAddress;
let swarmChequebookBalance;
let swarmIdentitiesCta;
let swarmSetupCta;
let swarmSetupBtn;
let swarmSetupBtnLabel;
let swarmSetupHint;
let creditEls = {};

let setupState = null;
let chequebookFullAddress = null;
let currentCtaTarget = null; // 'setup' | 'storage' | null
let cardWatched = false;
let creditState = null;
let creditTimer = null;
let creditRequest = 0;
let toggleInFlight = false;

// Node status tracking
let nodeStatusUnsubscribers = [];

export function initNodeStatus() {
  swarmModeBadge = document.getElementById('swarm-mode-badge');
  swarmStatusBadge = document.getElementById('swarm-status-badge');
  swarmCardContent = document.getElementById('swarm-card-content');
  swarmBalanceXdaiEl = document.getElementById('swarm-balance-xdai');
  swarmBalanceXbzzEl = document.getElementById('swarm-balance-xbzz');
  swarmWalletGroup = document.getElementById('swarm-wallet-group');
  swarmChequebookGroup = document.getElementById('swarm-chequebook-group');
  swarmChequebookAddress = document.getElementById('swarm-chequebook-address');
  swarmChequebookBalance = document.getElementById('swarm-chequebook-balance');
  swarmIdentitiesCta = document.getElementById('swarm-identities-cta');
  swarmSetupCta = document.getElementById('swarm-setup-cta');
  swarmSetupBtn = document.getElementById('swarm-setup-btn');
  swarmSetupBtnLabel = document.getElementById('swarm-setup-btn-label');
  swarmSetupHint = document.getElementById('swarm-setup-hint');
  creditEls = {
    group: document.getElementById('swarm-credit-group'),
    tier: document.getElementById('swarm-credit-tier'),
    available: document.getElementById('swarm-credit-available'),
    detail: document.getElementById('swarm-credit-detail'),
    spend: document.getElementById('swarm-credit-spend'),
    status: document.getElementById('swarm-credit-status'),
    topUpCta: document.getElementById('swarm-credit-topup-cta'),
    topUp: document.getElementById('swarm-credit-topup'),
    toggle: document.getElementById('swarm-credit-switch'),
    toggleHint: document.getElementById('swarm-credit-toggle-hint'),
    note: document.getElementById('swarm-credit-note'),
  };

  setupNodeCards();

  document.getElementById('swarm-topup-xdai')?.addEventListener('click', () => {
    topUpXdai(setupState?.account?.walletAddress);
  });

  document.getElementById('swarm-topup-chequebook')?.addEventListener('click', () => {
    openChequebookDeposit();
  });

  creditEls.topUp?.addEventListener('click', () => openChequebookDeposit());
  creditEls.toggle?.addEventListener('change', () => {
    void handleSwapToggle(creditEls.toggle.checked);
  });

  const chequebookCopyBtn = document.getElementById('swarm-chequebook-copy');
  if (chequebookCopyBtn) {
    chequebookCopyBtn.addEventListener('click', () => {
      copyWithFeedback(chequebookFullAddress, chequebookCopyBtn);
    });
  }

  subscribeToSetupState();
  watchCardVisibility();
  subscribeToNodeStatus();
}

function setupNodeCards() {
  document.querySelectorAll('.node-card-header').forEach((header) => {
    header.addEventListener('click', () => {
      const nodeName = header.dataset.node;
      toggleNodeCard(nodeName);
    });
  });

  if (swarmSetupBtn) {
    swarmSetupBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      handleSetupCtaClick();
    });
  }

  const swarmIdentitiesBtn = document.getElementById('swarm-identities-btn');
  if (swarmIdentitiesBtn) {
    swarmIdentitiesBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openPublisherIdentities();
    });
  }
}

function toggleNodeCard(nodeName) {
  const card = document.getElementById(`node-card-${nodeName}`);
  const content = document.getElementById(`${nodeName}-card-content`);

  if (!card || !content) return;

  const isExpanded = card.classList.contains('expanded');

  if (isExpanded) {
    card.classList.remove('expanded');
    content.classList.add('hidden');
  } else {
    card.classList.add('expanded');
    content.classList.remove('hidden');
  }
}

function subscribeToSetupState() {
  if (!window.publishSetup) return;
  window.publishSetup.onState((next) => {
    setupState = next;
    updateSwarmUi();
  });
  window.publishSetup
    .getState()
    .then((initial) => {
      setupState = initial || setupState;
      updateSwarmUi();
    })
    .catch((err) => console.error('[WalletUI] Failed to read publish setup state:', err));
}

// The wallet and chequebook balances are RPC reads on the node: ask for them
// only while the Swarm card is actually on screen (sidebar open, Nodes tab,
// card expanded).
function watchCardVisibility() {
  if (!swarmCardContent || typeof IntersectionObserver !== 'function') return;
  // A collapsed sidebar is 0 px wide and clips the card rather than hiding
  // it, which can still count as a zero-area intersection: go by the ratio.
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.some((entry) => entry.intersectionRatio >= CARD_VISIBLE_RATIO);
      if (visible === cardWatched) return;
      cardWatched = visible;
      void window.publishSetup?.watch('node-card', visible);
      if (visible) startCreditRefresh();
      else stopCreditRefresh();
    },
    { threshold: [0, CARD_VISIBLE_RATIO] }
  );
  observer.observe(swarmCardContent);
}

function subscribeToNodeStatus() {
  nodeStatusUnsubscribers.forEach((unsub) => unsub?.());
  nodeStatusUnsubscribers = [];

  if (window.ant?.onStatusUpdate) {
    const unsubBee = window.ant.onStatusUpdate(({ status }) => {
      updateSwarmStatus(status);
    });
    if (unsubBee) nodeStatusUnsubscribers.push(unsubBee);
  }

  if (window.ipfs?.onStatusUpdate) {
    const unsubIpfs = window.ipfs.onStatusUpdate(({ status }) => {
      updateNodeBadge('ipfs-status-badge', status);
    });
    if (unsubIpfs) nodeStatusUnsubscribers.push(unsubIpfs);
  }

  if (window.radicle?.onStatusUpdate) {
    const unsubRadicle = window.radicle.onStatusUpdate(({ status }) => {
      updateNodeBadge('radicle-status-badge', status);
    });
    if (unsubRadicle) nodeStatusUnsubscribers.push(unsubRadicle);
  }

  fetchInitialNodeStatus();
}

async function fetchInitialNodeStatus() {
  try {
    if (window.ant?.getStatus) {
      const { status } = await window.ant.getStatus();
      updateSwarmStatus(status);
    }

    if (window.ipfs?.getStatus) {
      const { status } = await window.ipfs.getStatus();
      updateNodeBadge('ipfs-status-badge', status);
    }

    if (window.radicle?.getStatus) {
      const { status } = await window.radicle.getStatus();
      updateNodeBadge('radicle-status-badge', status);
    }
  } catch (err) {
    console.error('[WalletUI] Failed to fetch initial node status:', err);
  }
}

function getStatusBadgeState(status) {
  switch (status) {
    case 'running':
      return { text: 'Running', value: 'running' };
    case 'starting':
      return { text: 'Starting', value: 'starting' };
    case 'stopping':
      return { text: 'Stopping', value: 'starting' };
    case 'error':
      return { text: 'Error', value: 'error' };
    case 'stopped':
    default:
      return { text: 'Stopped', value: 'stopped' };
  }
}

function updateSwarmStatus(status) {
  const previous = state.currentAntStatus;
  state.currentAntStatus = status;
  if (status !== previous && cardWatched) void refreshCredit();

  if (swarmStatusBadge) {
    const badgeState = getStatusBadgeState(status);
    swarmStatusBadge.textContent = badgeState.text;
    swarmStatusBadge.dataset.status = badgeState.value;
  }
}

function updateSwarmUi() {
  const modeLabel = formatSwarmMode(setupState?.nodeMode);
  if (swarmModeBadge) {
    swarmModeBadge.textContent = modeLabel || '';
    swarmModeBadge.classList.toggle('hidden', !modeLabel);
  }
  updateSwarmBalances();
  updateSwarmSetupCta();
  renderCredit();
}

// ---------------------------------------------------------------------------
// Browsing credit (#488)
// ---------------------------------------------------------------------------

function startCreditRefresh() {
  stopCreditRefresh();
  void refreshCredit();
  creditTimer = setInterval(() => void refreshCredit(), CREDIT_REFRESH_MS);
}

function stopCreditRefresh() {
  if (creditTimer) clearInterval(creditTimer);
  creditTimer = null;
}

async function refreshCredit() {
  if (!window.browsingCredit?.getState) return;
  const request = ++creditRequest;
  try {
    const next = await window.browsingCredit.getState();
    // A read that started before the switch was flipped is older than the
    // flip's own answer.
    if (request !== creditRequest || toggleInFlight) return;
    creditState = next;
  } catch (err) {
    console.error('[WalletUI] Failed to read browsing credit:', err);
  }
  renderCredit();
}

async function handleSwapToggle(enabled) {
  if (!window.browsingCredit?.setSwapEnable || toggleInFlight) return;
  toggleInFlight = true;
  creditRequest += 1;
  // Show the restart while it runs, with the switch where the user put it.
  if (creditState) {
    creditState = {
      ...creditState,
      swapEnable: enabled,
      toggle: { inProgress: true, error: null },
    };
  }
  renderCredit();
  let result;
  try {
    result = await window.browsingCredit.setSwapEnable(enabled);
  } catch (err) {
    result = { ok: false, error: err?.message || null };
  }
  toggleInFlight = false;
  if (result?.state) creditState = result.state;
  if (!result?.ok && creditState) {
    creditState = {
      ...creditState,
      swapEnable: result?.state ? result.state.swapEnable : !enabled,
      toggle: { inProgress: false, error: result?.error || 'Could not change the setting.' },
    };
  }
  renderCredit();
}

function setLine(el, text) {
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

function renderCredit() {
  // The publish CTA warns when paying peers is off, so it follows the credit.
  updateSwarmSetupCta();
  const view = describeBrowsingCredit(creditState, setupState);
  creditEls.group?.classList.toggle('hidden', !view.visible);
  if (!view.visible) return;

  if (creditEls.tier) {
    creditEls.tier.classList.toggle('hidden', !view.tier);
    creditEls.tier.textContent = view.tier?.text || '';
    // Reuse the node badge palette: green while paying, grey on the free tier.
    creditEls.tier.dataset.status = view.tier?.value === 'paying' ? 'running' : 'stopped';
  }
  if (creditEls.available) creditEls.available.textContent = view.available;
  setLine(creditEls.detail, view.detail);
  setLine(creditEls.spend, view.spend);
  setLine(creditEls.status, view.status);
  if (creditEls.status) creditEls.status.dataset.level = view.level;
  creditEls.topUpCta?.classList.toggle('hidden', !view.showTopUp);
  if (creditEls.toggle) {
    creditEls.toggle.checked = view.toggle.checked;
    creditEls.toggle.disabled = view.toggle.disabled;
  }
  if (creditEls.toggleHint) creditEls.toggleHint.textContent = view.toggle.hint;
  setLine(creditEls.note, view.costNote);
}

function updateSwarmBalances() {
  const account = setupState?.account;
  const hasWallet = Boolean(account && (account.xdai !== null || account.bzz !== null));
  swarmWalletGroup?.classList.toggle('hidden', !hasWallet);
  if (swarmBalanceXdaiEl) swarmBalanceXdaiEl.textContent = account?.xdai ?? '--';
  if (swarmBalanceXbzzEl) swarmBalanceXbzzEl.textContent = account?.bzz ?? '--';

  const chequebook = account?.chequebook;
  swarmChequebookGroup?.classList.toggle('hidden', !chequebook);
  chequebookFullAddress = chequebook?.address || null;
  if (!chequebook) return;

  if (swarmChequebookAddress) {
    swarmChequebookAddress.textContent = truncateAddress(chequebook.address);
    swarmChequebookAddress.title = chequebook.address;
  }
  if (swarmChequebookBalance) swarmChequebookBalance.textContent = chequebook.deposit ?? '--';
}

function handleSetupCtaClick() {
  if (!currentCtaTarget) return;
  if (currentCtaTarget === 'storage') {
    openStampManager();
  } else {
    openPublishSetup();
  }
}

function updateSwarmSetupCta() {
  const cta = describePublishCta(setupState, creditState);

  swarmSetupCta?.classList.toggle('hidden', !cta.visible);
  currentCtaTarget = cta.visible && !cta.disabled ? cta.target : null;
  if (swarmSetupBtn) swarmSetupBtn.disabled = cta.disabled;
  if (swarmSetupBtnLabel) swarmSetupBtnLabel.textContent = cta.label;
  if (swarmSetupHint) swarmSetupHint.textContent = cta.hint;

  // Show publisher identities button when identities exist
  updatePublisherIdentitiesButton();
}

async function updatePublisherIdentitiesButton() {
  if (!swarmIdentitiesCta) return;
  try {
    const entries = await window.swarmFeedStore?.getAllOrigins?.();
    swarmIdentitiesCta.classList.toggle('hidden', !entries || entries.length === 0);
  } catch {
    swarmIdentitiesCta.classList.add('hidden');
  }
}

async function copyWithFeedback(text, buttonEl) {
  if (!text) return;
  try {
    await window.electronAPI?.copyText?.(text);
    buttonEl.classList.add('copied');
    setTimeout(() => buttonEl.classList.remove('copied'), 1500);
  } catch {
    // Non-critical
  }
}

function updateNodeBadge(elementId, status) {
  const badge = document.getElementById(elementId);
  if (badge) {
    const badgeState = getStatusBadgeState(status);
    badge.textContent = badgeState.text;
    badge.dataset.status = badgeState.value;
  }
}
