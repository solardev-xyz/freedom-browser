/**
 * Node Status Module
 *
 * Node cards, status badges, Swarm balances, and publishing setup CTA.
 */

import { state } from '../state.js';
import { formatBalance, formatRawTokenBalance } from './wallet-utils.js';
import { fetchBeeJson } from './bee-api.js';
import { walletState } from './wallet-state.js';
import {
  classifySwarmPublishState,
  normalizeSwarmMode,
} from './swarm-readiness.js';
import { openPublishSetup } from './publish-setup.js';
import { openStampManager } from './stamp-manager.js';

const SWARM_REFRESH_MS = 15000;

// DOM references
let swarmModeBadge;
let swarmStatusBadge;
let swarmBalanceXdaiEl;
let swarmBalanceXbzzEl;
let swarmBalancesGroup;
let swarmSetupCta;
let swarmSetupBtn;
let swarmSetupBtnLabel;
let swarmSetupHint;

let desiredSwarmMode = 'ultraLight';
let actualSwarmMode = null;
let swarmRefreshInterval = null;
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
  swarmBalancesGroup = document.getElementById('swarm-balances-group');
  swarmSetupCta = document.getElementById('swarm-setup-cta');
  swarmSetupBtn = document.getElementById('swarm-setup-btn');
  swarmSetupBtnLabel = document.getElementById('swarm-setup-btn-label');
  swarmSetupHint = document.getElementById('swarm-setup-hint');

  setupNodeCards();

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
    startSwarmRefresh();
  } else {
    stopSwarmRefresh();

    if (status !== 'starting' && status !== 'stopping') {
      actualSwarmMode = null;
      swarmRuntimeInfo = createEmptySwarmRuntimeInfo();
    }

    updateSwarmUi();
  }
}

function startSwarmRefresh() {
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

async function refreshSwarmRuntimeInfo() {
  if (state.currentBeeStatus !== 'running') {
    return;
  }

  try {
    const [nodeResult, readinessResult, walletResult, stampsResult] = await Promise.all([
      fetchBeeJson('/node'),
      fetchBeeJson('/readiness'),
      fetchBeeJson('/wallet'),
      fetchBeeJson('/stamps'),
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

    if (walletResult.ok && walletResult.data) {
      updateSwarmWalletBalances(walletResult.data);
    }
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

  swarmBalancesGroup?.classList.toggle('hidden', isUltraLight);
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

  // Show CTA when Bee is available and not an external node
  const showCta = !inspectOnly && beeAvailable;

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

function updateNodeBadge(elementId, status) {
  const badge = document.getElementById(elementId);
  if (badge) {
    const badgeState = getStatusBadgeState(status);
    badge.textContent = badgeState.text;
    badge.dataset.status = badgeState.value;
  }
}
