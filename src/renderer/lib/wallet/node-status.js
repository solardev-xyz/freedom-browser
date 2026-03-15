/**
 * Node Status Module
 *
 * Node cards, status badges, Swarm balances, and publishing setup CTA.
 */

import { state } from '../state.js';
import { formatBalance, formatRawTokenBalance, truncateAddress, isChequebookDeployed } from './wallet-utils.js';
import { fetchBeeJson } from './bee-api.js';
import { walletState } from './wallet-state.js';
import {
  classifySwarmPublishState,
  normalizeSwarmMode,
} from './swarm-readiness.js';
import { openPublishSetup } from './publish-setup.js';
import { openStampManager } from './stamp-manager.js';
import { topUpXdai, topUpXbzz } from './funding-actions.js';
import { openChequebookDeposit } from './chequebook-deposit.js';

const SWARM_REFRESH_MS = 15000;
const SWARM_STARTUP_REFRESH_MS = 2000;
const SWARM_STARTUP_MAX_MS = 30000;

// DOM references
let swarmModeBadge;
let swarmStatusBadge;
let swarmBalanceXdaiEl;
let swarmBalanceXbzzEl;
let swarmWalletGroup;
let swarmChequebookGroup;
let swarmChequebookAddress;
let swarmChequebookBalance;
let swarmSetupCta;
let swarmSetupBtn;
let swarmSetupBtnLabel;
let swarmSetupHint;

let desiredSwarmMode = 'ultraLight';
let actualSwarmMode = null;
let swarmRefreshInterval = null;
let swarmStartupTimeout = null;
let isStartupConverging = false;
let swarmRuntimeInfo = createEmptySwarmRuntimeInfo();

// Node status tracking
let nodeStatusUnsubscribers = [];

function createEmptySwarmRuntimeInfo() {
  return {
    readiness: null,
    stamps: [],
    stampsKnown: false,
  };
}

export function initNodeStatus() {
  swarmModeBadge = document.getElementById('swarm-mode-badge');
  swarmStatusBadge = document.getElementById('swarm-status-badge');
  swarmBalanceXdaiEl = document.getElementById('swarm-balance-xdai');
  swarmBalanceXbzzEl = document.getElementById('swarm-balance-xbzz');
  swarmWalletGroup = document.getElementById('swarm-wallet-group');
  swarmChequebookGroup = document.getElementById('swarm-chequebook-group');
  swarmChequebookAddress = document.getElementById('swarm-chequebook-address');
  swarmChequebookBalance = document.getElementById('swarm-chequebook-balance');
  swarmSetupCta = document.getElementById('swarm-setup-cta');
  swarmSetupBtn = document.getElementById('swarm-setup-btn');
  swarmSetupBtnLabel = document.getElementById('swarm-setup-btn-label');
  swarmSetupHint = document.getElementById('swarm-setup-hint');

  setupNodeCards();

  document.getElementById('swarm-topup-xdai')?.addEventListener('click', () => {
    topUpXdai();
  });

  document.getElementById('swarm-topup-xbzz')?.addEventListener('click', () => {
    topUpXbzz();
  });

  document.getElementById('swarm-topup-chequebook')?.addEventListener('click', () => {
    openChequebookDeposit();
  });

  const chequebookCopyBtn = document.getElementById('swarm-chequebook-copy');
  if (chequebookCopyBtn) {
    chequebookCopyBtn.addEventListener('click', () => {
      copyWithFeedback(chequebookFullAddress, chequebookCopyBtn);
    });
  }

  syncDesiredSwarmMode();
  window.addEventListener('settings:updated', handleSettingsUpdated);

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

function formatSwarmMode(mode) {
  switch (normalizeSwarmMode(mode)) {
    case 'full':
      return 'Full';
    case 'light':
      return 'Light';
    case 'ultraLight':
      return 'Ultra-light';
    default:
      return '--';
  }
}

function getDisplayedSwarmMode() {
  if (actualSwarmMode) {
    return actualSwarmMode;
  }

  if (state.registry?.bee?.mode !== 'reused') {
    return desiredSwarmMode;
  }

  return null;
}

function updateSwarmModeUi() {
  if (swarmModeBadge) {
    swarmModeBadge.textContent = formatSwarmMode(getDisplayedSwarmMode());
  }
}

async function syncDesiredSwarmMode() {
  try {
    const settings = await window.electronAPI?.getSettings?.();
    desiredSwarmMode = settings?.beeNodeMode === 'light' ? 'light' : 'ultraLight';
  } catch {
    desiredSwarmMode = 'ultraLight';
  }

  updateSwarmUi();
}

function handleSettingsUpdated(event) {
  desiredSwarmMode = event.detail?.beeNodeMode === 'light' ? 'light' : 'ultraLight';
  updateSwarmUi();
}

function subscribeToNodeStatus() {
  nodeStatusUnsubscribers.forEach((unsub) => unsub?.());
  nodeStatusUnsubscribers = [];

  if (window.bee?.onStatusUpdate) {
    const unsubBee = window.bee.onStatusUpdate(({ status, error }) => {
      updateSwarmStatus(status, error);
    });
    if (unsubBee) nodeStatusUnsubscribers.push(unsubBee);
  }

  if (window.ipfs?.onStatusUpdate) {
    const unsubIpfs = window.ipfs.onStatusUpdate(({ status, error }) => {
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
    if (window.bee?.getStatus) {
      const { status, error } = await window.bee.getStatus();
      updateSwarmStatus(status, error);
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

function updateSwarmStatus(status, _error) {
  state.currentBeeStatus = status;

  if (swarmStatusBadge) {
    const badgeState = getStatusBadgeState(status);
    swarmStatusBadge.textContent = badgeState.text;
    swarmStatusBadge.dataset.status = badgeState.value;
  }

  if (status === 'running') {
    refreshSwarmRuntimeInfo();
    startSwarmStartupBurst();
  } else {
    stopSwarmRefresh();
    stopSwarmStartupBurst();

    if (status !== 'starting' && status !== 'stopping') {
      actualSwarmMode = null;
      chequebookFullAddress = null;
      isStartupConverging = false;
      swarmRuntimeInfo = createEmptySwarmRuntimeInfo();
    }

    updateSwarmUi();
  }
}

function startSwarmStartupBurst() {
  stopSwarmRefresh();
  stopSwarmStartupBurst();
  isStartupConverging = true;

  // Poll fast during startup until state converges
  swarmRefreshInterval = setInterval(() => {
    refreshSwarmRuntimeInfo();
  }, SWARM_STARTUP_REFRESH_MS);

  // After max startup time, switch to steady-state polling
  swarmStartupTimeout = setTimeout(() => {
    switchToSteadyStatePolling();
  }, SWARM_STARTUP_MAX_MS);
}

function switchToSteadyStatePolling() {
  isStartupConverging = false;
  stopSwarmStartupBurst();
  stopSwarmRefresh();
  swarmRefreshInterval = setInterval(() => {
    refreshSwarmRuntimeInfo();
  }, SWARM_REFRESH_MS);
}

function stopSwarmRefresh() {
  if (swarmRefreshInterval) {
    clearInterval(swarmRefreshInterval);
    swarmRefreshInterval = null;
  }
}

function stopSwarmStartupBurst() {
  if (swarmStartupTimeout) {
    clearTimeout(swarmStartupTimeout);
    swarmStartupTimeout = null;
  }
}

async function refreshSwarmRuntimeInfo() {
  if (state.currentBeeStatus !== 'running') {
    return;
  }

  try {
    const [nodeResult, readinessResult, walletResult, stampsResult, chequebookAddrResult, chequebookBalResult] = await Promise.all([
      fetchBeeJson('/node'),
      fetchBeeJson('/readiness'),
      fetchBeeJson('/wallet'),
      fetchBeeJson('/stamps'),
      fetchBeeJson('/chequebook/address'),
      fetchBeeJson('/chequebook/balance'),
    ]);

    const nodeInfo = nodeResult.ok ? nodeResult.data : null;
    if (nodeInfo?.beeMode) {
      actualSwarmMode = normalizeSwarmMode(nodeInfo.beeMode);
    }

    const stamps = Array.isArray(stampsResult.data?.stamps) ? stampsResult.data.stamps : [];
    const stampsKnown = Array.isArray(stampsResult.data?.stamps);

    swarmRuntimeInfo = {
      readiness: { ok: readinessResult.ok },
      stamps,
      stampsKnown,
    };

    // Once stamps are known, startup convergence is complete
    if (stampsKnown && isStartupConverging) {
      switchToSteadyStatePolling();
    }

    if (walletResult.ok && walletResult.data) {
      updateSwarmWalletBalances(walletResult.data);
    }

    updateSwarmChequebook(chequebookAddrResult, chequebookBalResult);
  } catch (err) {
    console.error('[WalletUI] Failed to refresh Swarm runtime info:', err);
    swarmRuntimeInfo = createEmptySwarmRuntimeInfo();
  }

  updateSwarmUi();
}

function updateSwarmUi() {
  updateSwarmModeUi();
  updateSwarmSectionVisibility();
  updateSwarmSetupCta();
}

function updateSwarmSectionVisibility() {
  const displayMode = normalizeSwarmMode(getDisplayedSwarmMode());
  const isUltraLight = displayMode === 'ultraLight';

  swarmWalletGroup?.classList.toggle('hidden', isUltraLight);
  // Chequebook visibility is handled by updateSwarmChequebook (only shown when deployed)
}

let currentCtaTarget = 'setup'; // 'setup' or 'storage'

function handleSetupCtaClick() {
  if (currentCtaTarget === 'storage') {
    openStampManager();
  } else {
    openPublishSetup();
  }
}

function updateSwarmSetupCta() {
  const publishState = classifySwarmPublishState({
    beeStatus: state.currentBeeStatus,
    desiredMode: desiredSwarmMode,
    actualMode: actualSwarmMode,
    registryMode: state.registry?.bee?.mode,
    readiness: swarmRuntimeInfo.readiness,
    stamps: swarmRuntimeInfo.stamps,
    stampsKnown: swarmRuntimeInfo.stampsKnown,
  });

  const inspectOnly = state.registry?.bee?.mode === 'reused';
  const beeAvailable = state.currentBeeStatus === 'running' || state.currentBeeStatus === 'starting';
  const isReady = publishState.key === 'ready';
  const isConverging = publishState.key === 'initializing' && isStartupConverging;

  // Hide CTA during startup convergence (state not yet reliable)
  // Show CTA when Bee is available, state is resolved, and not an external node
  const showCta = !inspectOnly && beeAvailable && !isConverging;

  if (swarmSetupCta) {
    swarmSetupCta.classList.toggle('hidden', !showCta);
  }

  // Switch CTA between setup and storage management
  if (isReady) {
    currentCtaTarget = 'storage';
    if (swarmSetupBtnLabel) swarmSetupBtnLabel.textContent = 'Manage Storage';
    if (swarmSetupHint) swarmSetupHint.textContent = 'View batches and storage';
  } else {
    currentCtaTarget = 'setup';
    if (swarmSetupBtnLabel) {
      swarmSetupBtnLabel.textContent = publishState.key === 'browsing-only'
        ? 'Set Up Publishing'
        : 'Publishing Setup';
    }
    if (swarmSetupHint) {
      const hints = {
        'browsing-only': 'Enable uploads and publishing',
        'no-usable-stamps': 'Stamps needed to publish',
        'initializing': 'Setup in progress',
        'error': 'Check node status',
      };
      swarmSetupHint.textContent = hints[publishState.key] || '';
    }
  }
}

function updateSwarmWalletBalances(walletInfo) {
  if (swarmBalanceXdaiEl) {
    swarmBalanceXdaiEl.textContent = formatRawTokenBalance(walletInfo?.nativeTokenBalance, 18);
  }

  if (swarmBalanceXbzzEl) {
    swarmBalanceXbzzEl.textContent = formatRawTokenBalance(walletInfo?.bzzBalance, 16);
  }
}

let chequebookFullAddress = null;

function updateSwarmChequebook(addrResult, balResult) {
  const addr = addrResult?.ok ? addrResult.data?.chequebookAddress : null;
  const isDeployed = isChequebookDeployed(addr);

  if (swarmChequebookGroup) {
    swarmChequebookGroup.classList.toggle('hidden', !isDeployed);
  }

  if (!isDeployed) {
    chequebookFullAddress = null;
    return;
  }

  chequebookFullAddress = addr;

  if (swarmChequebookAddress) {
    swarmChequebookAddress.textContent = truncateAddress(addr);
    swarmChequebookAddress.title = addr;
  }

  if (swarmChequebookBalance && balResult?.ok && balResult.data) {
    // availableBalance is in PLUR (raw xBZZ with 16 decimals)
    const available = balResult.data.availableBalance;
    swarmChequebookBalance.textContent = formatRawTokenBalance(
      typeof available === 'string' ? available : String(available || '0'),
      16
    );
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
