/**
 * Node Status Module
 *
 * Node cards, status badges, Swarm notifications.
 */

import { buildBeeUrl } from '../state.js';
import { formatBalance, formatBytes } from './wallet-utils.js';

// DOM references
let swarmModeBadge;
let swarmStatusBadge;
let swarmStampsCount;
let swarmStampsSummary;
let walletNotification;
let walletNotificationText;
let walletNotificationAction;

// Node status tracking
let nodeStatusUnsubscribers = [];

export function initNodeStatus() {
  // Node card elements
  swarmModeBadge = document.getElementById('swarm-mode-badge');
  swarmStatusBadge = document.getElementById('swarm-status-badge');
  swarmStampsCount = document.getElementById('swarm-stamps-count');
  swarmStampsSummary = document.getElementById('swarm-stamps-summary');

  // Notification elements
  walletNotification = document.getElementById('wallet-notification');
  walletNotificationText = document.getElementById('wallet-notification-text');
  walletNotificationAction = document.getElementById('wallet-notification-action');

  // Setup node card collapse/expand
  setupNodeCards();

  // Subscribe to node status updates
  subscribeToNodeStatus();
}

// ============================================
// Node Cards (Collapsible)
// ============================================

function setupNodeCards() {
  // Add click listeners to all node card headers
  document.querySelectorAll('.node-card-header').forEach(header => {
    header.addEventListener('click', () => {
      const nodeName = header.dataset.node;
      toggleNodeCard(nodeName);
    });
  });

  // Upgrade node button
  const upgradeBtn = document.getElementById('swarm-upgrade-btn');
  if (upgradeBtn) {
    upgradeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleUpgradeNode();
    });
  }
}

function handleSendToNode(token) {
  // TODO: Implement send flow
  console.log(`[WalletUI] Send ${token} to node - not yet implemented`);
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

function handleUpgradeNode() {
  // TODO: Implement upgrade flow
  console.log('[WalletUI] Upgrade to light node - coming soon');
  alert('Upgrade to Light Node - coming soon');
}

// ============================================
// Node Status Subscriptions
// ============================================

function subscribeToNodeStatus() {
  // Clean up any existing subscriptions
  nodeStatusUnsubscribers.forEach(unsub => unsub?.());
  nodeStatusUnsubscribers = [];

  // Subscribe to Swarm/Bee status
  if (window.bee?.onStatusUpdate) {
    const unsubBee = window.bee.onStatusUpdate(({ status, error }) => {
      updateSwarmStatus(status, error);
    });
    if (unsubBee) nodeStatusUnsubscribers.push(unsubBee);
  }

  // Subscribe to IPFS status
  if (window.ipfs?.onStatusUpdate) {
    const unsubIpfs = window.ipfs.onStatusUpdate(({ status, error }) => {
      updateIpfsStatus(status, error);
    });
    if (unsubIpfs) nodeStatusUnsubscribers.push(unsubIpfs);
  }

  // Subscribe to Radicle status
  if (window.radicle?.onStatusUpdate) {
    const unsubRadicle = window.radicle.onStatusUpdate(({ status, error }) => {
      updateRadicleStatus(status, error);
    });
    if (unsubRadicle) nodeStatusUnsubscribers.push(unsubRadicle);
  }

  // Get initial status
  fetchInitialNodeStatus();
}

async function fetchInitialNodeStatus() {
  try {
    if (window.bee?.getStatus) {
      const { status, error } = await window.bee.getStatus();
      updateSwarmStatus(status, error);
    }

    if (window.ipfs?.getStatus) {
      const { status, error } = await window.ipfs.getStatus();
      updateIpfsStatus(status, error);
    }

    if (window.radicle?.getStatus) {
      const { status, error } = await window.radicle.getStatus();
      updateRadicleStatus(status, error);
    }
  } catch (err) {
    console.error('[WalletUI] Failed to fetch initial node status:', err);
  }
}

function updateSwarmStatus(status, error) {
  if (swarmStatusBadge) {
    let statusText = 'Stopped';
    let statusValue = 'stopped';

    switch (status) {
      case 'running':
        statusText = 'Running';
        statusValue = 'running';
        break;
      case 'starting':
        statusText = 'Starting';
        statusValue = 'starting';
        break;
      case 'stopping':
        statusText = 'Stopping';
        statusValue = 'starting';
        break;
      case 'error':
        statusText = 'Error';
        statusValue = 'error';
        break;
      case 'stopped':
      default:
        statusText = 'Stopped';
        statusValue = 'stopped';
        break;
    }

    swarmStatusBadge.textContent = statusText;
    swarmStatusBadge.dataset.status = statusValue;
  }

  if (status === 'running') {
    fetchSwarmMode();
    hideNotification();
  } else if (swarmModeBadge) {
    swarmModeBadge.textContent = '--';
  }
}

async function fetchSwarmMode() {
  if (!swarmModeBadge) return;

  try {
    const response = await fetch(buildBeeUrl('/status'));
    if (response.ok) {
      const data = await response.json();
      if (data.beeMode) {
        const mode = data.beeMode.charAt(0).toUpperCase() + data.beeMode.slice(1);
        swarmModeBadge.textContent = mode;
      }
    }
  } catch (err) {
    console.error('[WalletUI] Failed to fetch Swarm mode:', err);
    swarmModeBadge.textContent = '--';
  }
}

function updateIpfsStatus(status, error) {
  const badge = document.getElementById('ipfs-status-badge');
  if (badge) {
    let statusText = 'Stopped';
    let statusValue = 'stopped';

    switch (status) {
      case 'running':
        statusText = 'Running';
        statusValue = 'running';
        break;
      case 'starting':
        statusText = 'Starting';
        statusValue = 'starting';
        break;
      case 'stopping':
        statusText = 'Stopping';
        statusValue = 'starting';
        break;
      case 'error':
        statusText = 'Error';
        statusValue = 'error';
        break;
      case 'stopped':
      default:
        statusText = 'Stopped';
        statusValue = 'stopped';
        break;
    }

    badge.textContent = statusText;
    badge.dataset.status = statusValue;
  }
}

function updateRadicleStatus(status, error) {
  const badge = document.getElementById('radicle-status-badge');
  if (badge) {
    let statusText = 'Stopped';
    let statusValue = 'stopped';

    switch (status) {
      case 'running':
        statusText = 'Running';
        statusValue = 'running';
        break;
      case 'starting':
        statusText = 'Starting';
        statusValue = 'starting';
        break;
      case 'stopping':
        statusText = 'Stopping';
        statusValue = 'starting';
        break;
      case 'error':
        statusText = 'Error';
        statusValue = 'error';
        break;
      case 'stopped':
      default:
        statusText = 'Stopped';
        statusValue = 'stopped';
        break;
    }

    badge.textContent = statusText;
    badge.dataset.status = statusValue;
  }
}

function updateSwarmWalletBalances(walletInfo) {
  if (swarmBalanceXdaiEl && walletInfo?.xdai !== undefined) {
    swarmBalanceXdaiEl.textContent = formatBalance(walletInfo.xdai);
  }
  if (swarmBalanceXbzzEl && walletInfo?.xbzz !== undefined) {
    swarmBalanceXbzzEl.textContent = formatBalance(walletInfo.xbzz);
  }
}

function updateSwarmStamps(stamps) {
  if (swarmStampsCount) {
    const count = Array.isArray(stamps) ? stamps.length : 0;
    swarmStampsCount.textContent = count.toString();
  }

  if (swarmStampsSummary) {
    if (!stamps || (Array.isArray(stamps) && stamps.length === 0)) {
      swarmStampsSummary.innerHTML = '<span class="node-stamps-empty">No stamps available</span>';
    } else if (Array.isArray(stamps)) {
      const totalCapacity = stamps.reduce((sum, s) => sum + (s.amount || 0), 0);
      swarmStampsSummary.innerHTML = `<span>Total capacity: ${formatBytes(totalCapacity)}</span>`;
    }
  }
}

// ============================================
// Wallet Notifications
// ============================================

function checkSwarmNotifications(status) {
  if (!walletNotification || !walletNotificationText || !walletNotificationAction) {
    return;
  }

  walletNotification.classList.add('hidden');

  if (!status?.running) return;

  if (status.wallet?.xdai !== undefined) {
    const xdaiBalance = parseFloat(status.wallet.xdai);
    if (xdaiBalance < 0.01) {
      showNotification(
        'Swarm node needs xDAI for gas fees',
        'Send xDAI',
        () => handleSendToNode('xdai')
      );
      return;
    }
  }

  if (status.wallet?.xbzz !== undefined) {
    const xbzzBalance = parseFloat(status.wallet.xbzz);
    if (xbzzBalance < 0.1) {
      showNotification(
        'Swarm node needs xBZZ for postage stamps',
        'Send xBZZ',
        () => handleSendToNode('xbzz')
      );
      return;
    }
  }

  if (status.stamps !== undefined) {
    const stampCount = Array.isArray(status.stamps) ? status.stamps.length : 0;
    if (stampCount === 0 && status.wallet?.xbzz && parseFloat(status.wallet.xbzz) > 0) {
      showNotification(
        'No postage stamps available for uploads',
        'Buy Stamps',
        () => handleBuyStamps()
      );
      return;
    }
  }
}

function showNotification(message, actionLabel, actionHandler) {
  if (!walletNotification || !walletNotificationText || !walletNotificationAction) {
    return;
  }

  walletNotificationText.textContent = message;
  walletNotificationAction.textContent = actionLabel;

  // Remove old listener and add new one
  const newActionBtn = walletNotificationAction.cloneNode(true);
  walletNotificationAction.parentNode.replaceChild(newActionBtn, walletNotificationAction);
  walletNotificationAction = newActionBtn;
  walletNotificationAction.addEventListener('click', actionHandler);

  walletNotification.classList.remove('hidden');
}

function hideNotification() {
  if (walletNotification) {
    walletNotification.classList.add('hidden');
  }
}

function handleBuyStamps() {
  // TODO: Implement buy stamps flow
  console.log('[WalletUI] Buy stamps - coming soon');
  alert('Buy Postage Stamps - coming soon');
}
