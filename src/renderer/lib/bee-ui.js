// Bee/Swarm node UI controls
import { state, buildBeeUrl, getDisplayMessage } from './state.js';
import { pushDebug } from './debug.js';

// DOM elements (initialized in initBeeUi)
let beeToggleBtn = null;
let beeToggleSwitch = null;
let beePeersCount = null;
let beeNetworkPeers = null;
let beeVersionText = null;
let beeInfoPanel = null;
let beeStatusRow = null;
let beeStatusLabel = null;
let beeStatusValue = null;

// Binary availability state
let beeBinaryAvailable = true;

export const stopBeeInfoPolling = () => {
  if (state.beePeersInterval) {
    clearInterval(state.beePeersInterval);
    state.beePeersInterval = null;
  }
  if (state.beeVisibleInterval) {
    clearInterval(state.beeVisibleInterval);
    state.beeVisibleInterval = null;
  }
  beeInfoPanel?.classList.remove('visible');
  if (beePeersCount) beePeersCount.textContent = '0';
  if (beeNetworkPeers) beeNetworkPeers.textContent = '0';
  if (beeVersionText)
    beeVersionText.textContent = state.beeVersionFetched ? state.beeVersionValue : '';
};

const fetchConnectedPeers = async () => {
  if (!state.beeMenuOpen) return;
  if (state.currentBeeStatus === 'stopped') {
    stopBeeInfoPolling();
    return;
  }
  if (!beeInfoPanel?.classList.contains('visible')) return;

  try {
    const response = await fetch(buildBeeUrl('/peers'));
    if (!beeInfoPanel?.classList.contains('visible')) return;
    if (response.ok) {
      const peersData = await response.json();
      const peers = peersData?.peers || peersData || [];
      const count = Array.isArray(peers) ? peers.length : peers?.total || 0;
      if (beePeersCount) beePeersCount.textContent = String(count ?? 0);
    } else if (beePeersCount) {
      beePeersCount.textContent = '0';
    }
  } catch {
    if (beePeersCount) beePeersCount.textContent = '0';
  }
};

const fetchVisiblePeers = async () => {
  if (!state.beeMenuOpen) return;
  if (state.currentBeeStatus === 'stopped') {
    stopBeeInfoPolling();
    return;
  }
  if (!beeInfoPanel?.classList.contains('visible')) return;

  try {
    const response = await fetch(buildBeeUrl('/topology'));
    if (!beeInfoPanel?.classList.contains('visible')) return;
    if (response.ok) {
      const topologyData = await response.json();
      const populationSum = Object.values(topologyData?.bins || {}).reduce(
        (sum, bin) => sum + (bin?.population || 0),
        0
      );
      if (beeNetworkPeers) beeNetworkPeers.textContent = String(populationSum ?? 0);
    } else if (beeNetworkPeers) {
      beeNetworkPeers.textContent = '0';
    }
  } catch {
    if (beeNetworkPeers) beeNetworkPeers.textContent = '0';
  }
};

const fetchBeeVersionOnce = async () => {
  if (state.beeVersionFetched) return;
  try {
    const healthResponse = await fetch(buildBeeUrl('/health'));
    if (healthResponse.ok) {
      const healthData = await healthResponse.json();
      state.beeVersionValue = (healthData?.version || '').split('-')[0];
      state.beeVersionFetched = true;
      if (beeVersionText) beeVersionText.textContent = state.beeVersionValue;
    } else if (beeVersionText) {
      beeVersionText.textContent = '';
    }
  } catch {
    if (beeVersionText) beeVersionText.textContent = '';
  }
};

export const startBeeInfoPolling = () => {
  if (!state.beeMenuOpen || state.currentBeeStatus === 'stopped') {
    stopBeeInfoPolling();
    return;
  }

  beeInfoPanel?.classList.add('visible');

  fetchConnectedPeers();
  fetchVisiblePeers();
  if (!state.beeVersionFetched) fetchBeeVersionOnce();

  if (state.beePeersInterval) clearInterval(state.beePeersInterval);
  state.beePeersInterval = setInterval(fetchConnectedPeers, 500);

  if (state.beeVisibleInterval) clearInterval(state.beeVisibleInterval);
  state.beeVisibleInterval = setInterval(fetchVisiblePeers, 1000);
};

export const updateBeeUi = (status, error) => {
  if (state.suppressRunningStatus && status === 'running') {
    return;
  }
  if (status === 'stopped' || status === 'error') {
    state.suppressRunningStatus = false;
  }

  state.currentBeeStatus = status;

  // Fetch version immediately when Bee becomes running (don't wait for polling)
  if (status === 'running' && !state.beeVersionFetched) {
    fetchBeeVersionOnce();
  }

  // Update status line and toggle state from registry
  updateBeeStatusLine();
  updateBeeToggleState();

  if (!beeToggleBtn || !beeToggleSwitch) return;

  beeToggleSwitch.classList.remove('running');
  switch (status) {
    case 'running':
    case 'starting':
      beeToggleSwitch.classList.add('running');
      break;
    case 'error':
      if (error) pushDebug(`Bee Error: ${error}`);
      break;
    case 'stopping':
    case 'stopped':
    default:
      // Clear status row when stopped
      if (beeStatusRow) beeStatusRow.classList.remove('visible');
      break;
  }

  if (state.beeMenuOpen) {
    if (status === 'stopped') {
      stopBeeInfoPolling();
    } else if (
      !state.beePeersInterval &&
      !state.beeVisibleInterval &&
      beeToggleSwitch?.classList.contains('running')
    ) {
      startBeeInfoPolling();
    }
  }
};

export const resetBeeVersion = () => {
  state.beeVersionFetched = false;
  state.beeVersionValue = '';
  if (beeVersionText) beeVersionText.textContent = '';
};

const setToggleDisabled = (disabled) => {
  if (!beeToggleBtn) return;

  if (disabled) {
    beeToggleBtn.classList.add('disabled');
    beeToggleBtn.setAttribute('disabled', 'true');
    beeToggleBtn.setAttribute('title', 'Swarm binary not found');
  } else {
    beeToggleBtn.classList.remove('disabled');
    beeToggleBtn.removeAttribute('disabled');
    beeToggleBtn.removeAttribute('title');
  }
};

// Update the status row from registry
export const updateBeeStatusLine = () => {
  if (!beeStatusRow || !beeStatusLabel || !beeStatusValue) return;

  const message = getDisplayMessage('bee');

  if (message) {
    // Parse "Label: value" format
    const colonIndex = message.indexOf(':');
    if (colonIndex > 0) {
      beeStatusLabel.textContent = message.substring(0, colonIndex + 1);
      beeStatusValue.textContent = message.substring(colonIndex + 1).trim();
    } else {
      // Fallback for messages without colon
      beeStatusLabel.textContent = message;
      beeStatusValue.textContent = '';
    }
    beeStatusRow.classList.add('visible');
  } else {
    beeStatusLabel.textContent = '';
    beeStatusValue.textContent = '';
    beeStatusRow.classList.remove('visible');
  }
};

// Update toggle disabled state based on node mode
export const updateBeeToggleState = () => {
  if (!beeToggleBtn) return;

  const mode = state.registry?.bee?.mode;
  const isReused = mode === 'reused';

  if (isReused) {
    beeToggleBtn.classList.add('external');
    beeToggleBtn.setAttribute('title', 'Using existing node — cannot be controlled from Freedom');
  } else if (beeBinaryAvailable) {
    beeToggleBtn.classList.remove('external');
    beeToggleBtn.removeAttribute('title');
  }
};

export const initBeeUi = () => {
  // Initialize DOM elements
  beeToggleBtn = document.getElementById('bee-toggle-btn');
  beeToggleSwitch = document.getElementById('bee-toggle-switch');
  beePeersCount = document.getElementById('bee-peers-count');
  beeNetworkPeers = document.getElementById('bee-network-peers');
  beeVersionText = document.getElementById('bee-version-text');
  beeInfoPanel = document.querySelector('.bee-info');
  beeStatusRow = document.getElementById('bee-status-row');
  beeStatusLabel = document.getElementById('bee-status-label');
  beeStatusValue = document.getElementById('bee-status-value');

  // Check binary availability
  if (window.bee) {
    window.bee.checkBinary().then(({ available }) => {
      beeBinaryAvailable = available;
      setToggleDisabled(!available);
      if (!available) {
        pushDebug('Swarm binary not found - toggle disabled');
      }
    });
  }

  // Toggle button listener
  beeToggleBtn?.addEventListener('click', () => {
    if (!beeBinaryAvailable) return;

    // Don't allow toggling when using an external node
    const mode = state.registry?.bee?.mode;
    if (mode === 'reused') return;

    if (state.currentBeeStatus === 'running' || state.currentBeeStatus === 'starting') {
      state.suppressRunningStatus = true;
      beeToggleSwitch?.classList.remove('running');
      stopBeeInfoPolling();
      pushDebug('User toggled Swarm Off');
      window.bee
        .stop()
        .then(({ status, error }) => updateBeeUi(status, error))
        .catch((err) => {
          console.error('Failed to toggle Bee', err);
          pushDebug(`Failed to toggle Bee: ${err.message}`);
        });
    } else {
      state.suppressRunningStatus = false;
      beeToggleSwitch?.classList.add('running');
      startBeeInfoPolling();
      pushDebug('User toggled Swarm On');
      window.bee
        .start()
        .then(({ status, error }) => updateBeeUi(status, error))
        .catch((err) => {
          console.error('Failed to toggle Bee', err);
          pushDebug(`Failed to toggle Bee: ${err.message}`);
        });
    }
  });

  // Listen for status updates from main process
  if (window.bee) {
    const handleStatus = ({ status, error }) => {
      pushDebug(`Bee Status Update: ${status} ${error ? `(${error})` : ''}`);
      updateBeeUi(status, error);
    };
    window.bee.onStatusUpdate(handleStatus);

    // Initial status check
    const refreshBeeStatus = () => {
      window.bee.getStatus().then(({ status, error }) => {
        updateBeeUi(status, error);
      });
    };
    refreshBeeStatus();
    setInterval(refreshBeeStatus, 5000);
  }
};
