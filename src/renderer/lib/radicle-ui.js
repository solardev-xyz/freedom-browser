// Radicle node UI controls
import { state, buildRadicleUrl, getDisplayMessage } from './state.js';
import { pushDebug } from './debug.js';

// DOM elements (initialized in initRadicleUi)
let radicleToggleBtn = null;
let radicleToggleSwitch = null;
let radiclePeersCount = null;
let radicleReposCount = null;
let radicleVersionText = null;
let radicleNodeId = null;
let radicleInfoPanel = null;
let radicleStatusRow = null;
let radicleStatusLabel = null;
let radicleStatusValue = null;

// Binary availability state
let radicleBinaryAvailable = true;

// Polling state
let radicleInfoInterval = null;

export const stopRadicleInfoPolling = () => {
  if (radicleInfoInterval) {
    clearInterval(radicleInfoInterval);
    radicleInfoInterval = null;
  }
  radicleInfoPanel?.classList.remove('visible');
  if (radiclePeersCount) radiclePeersCount.textContent = '--';
  if (radicleReposCount) radicleReposCount.textContent = '--';
  if (radicleVersionText) radicleVersionText.textContent = state.radicleVersionFetched ? state.radicleVersionValue : '';
  if (radicleNodeId) {
    radicleNodeId.textContent = '--';
    radicleNodeId.title = '';
  }
};

const fetchRadicleInfo = async () => {
  if (!state.beeMenuOpen) return;
  if (state.currentRadicleStatus === 'stopped') {
    stopRadicleInfoPolling();
    return;
  }
  if (!radicleInfoPanel?.classList.contains('visible')) return;

  // Fetch connected peers count via IPC (uses rad node status --json)
  if (window.radicle?.getConnections) {
    try {
      const connResult = await window.radicle.getConnections();
      if (!radicleInfoPanel?.classList.contains('visible')) return;
      if (connResult.success && radiclePeersCount) {
        radiclePeersCount.textContent = String(connResult.count);
      } else if (radiclePeersCount) {
        radiclePeersCount.textContent = '--';
      }
    } catch (err) {
      if (radiclePeersCount) radiclePeersCount.textContent = '--';
    }
  }

  // Fetch seeded repos count from /api/v1/stats
  try {
    const statsResponse = await fetch(buildRadicleUrl('/api/v1/stats'));
    if (!radicleInfoPanel?.classList.contains('visible')) return;
    if (statsResponse.ok) {
      const stats = await statsResponse.json();
      const count = stats?.repos?.total ?? 0;
      if (radicleReposCount) radicleReposCount.textContent = String(count);
    } else if (radicleReposCount) {
      radicleReposCount.textContent = '--';
    }
  } catch (err) {
    if (radicleReposCount) radicleReposCount.textContent = '--';
  }

  // Fetch node ID from /api/v1/node (only once, it doesn't change)
  if (radicleNodeId && radicleNodeId.textContent === '--') {
    try {
      const nodeResponse = await fetch(buildRadicleUrl('/api/v1/node'));
      if (!radicleInfoPanel?.classList.contains('visible')) return;
      if (nodeResponse.ok) {
        const nodeInfo = await nodeResponse.json();
        const fullId = nodeInfo?.id || '';
        if (fullId && radicleNodeId) {
          // Truncate: first 8 chars + ... + last 4 chars
          const truncated = fullId.length > 16
            ? `${fullId.slice(0, 8)}...${fullId.slice(-4)}`
            : fullId;
          radicleNodeId.textContent = truncated;
          radicleNodeId.title = fullId; // Full ID on hover
        }
      }
    } catch (err) {
      // Node ID fetch failed, leave as --
    }
  }
};

const fetchRadicleVersionOnce = async () => {
  if (state.radicleVersionFetched) return;
  try {
    // radicle-httpd returns version at / (root endpoint)
    const response = await fetch(buildRadicleUrl('/'));
    if (response.ok) {
      const data = await response.json();
      // Clean up version string - remove build hash if present
      const rawVersion = data?.version || '';
      state.radicleVersionValue = rawVersion.split('-')[0] || rawVersion;
      state.radicleVersionFetched = true;
      if (radicleVersionText) radicleVersionText.textContent = state.radicleVersionValue;
    } else if (radicleVersionText) {
      radicleVersionText.textContent = '';
    }
  } catch (err) {
    if (radicleVersionText) radicleVersionText.textContent = '';
  }
};

export const startRadicleInfoPolling = () => {
  if (!state.beeMenuOpen || state.currentRadicleStatus === 'stopped') {
    stopRadicleInfoPolling();
    return;
  }

  radicleInfoPanel?.classList.add('visible');

  fetchRadicleInfo();
  if (!state.radicleVersionFetched) fetchRadicleVersionOnce();

  if (radicleInfoInterval) clearInterval(radicleInfoInterval);
  radicleInfoInterval = setInterval(fetchRadicleInfo, 2000);
};

export const updateRadicleUi = (status, error) => {
  if (state.suppressRadicleRunningStatus && status === 'running') {
    return;
  }
  if (status === 'stopped' || status === 'error') {
    state.suppressRadicleRunningStatus = false;
  }

  state.currentRadicleStatus = status;

  // Update status line and toggle state from registry
  updateRadicleStatusLine();
  updateRadicleToggleState();

  if (!radicleToggleBtn || !radicleToggleSwitch) return;

  radicleToggleSwitch.classList.remove('running');
  switch (status) {
    case 'running':
    case 'starting':
      radicleToggleSwitch.classList.add('running');
      break;
    case 'error':
      if (error) pushDebug(`Radicle Error: ${error}`);
      break;
    case 'stopping':
    case 'stopped':
    default:
      // Clear status row when stopped
      if (radicleStatusRow) radicleStatusRow.classList.remove('visible');
      break;
  }

  if (state.beeMenuOpen) {
    if (status === 'stopped') {
      stopRadicleInfoPolling();
    } else if (!radicleInfoInterval && radicleToggleSwitch?.classList.contains('running')) {
      startRadicleInfoPolling();
    }
  }
};

const setToggleDisabled = (disabled) => {
  if (!radicleToggleBtn) return;

  if (disabled) {
    radicleToggleBtn.classList.add('disabled');
    radicleToggleBtn.setAttribute('disabled', 'true');
    radicleToggleBtn.setAttribute('title', 'Radicle binaries not found');
  } else {
    radicleToggleBtn.classList.remove('disabled');
    radicleToggleBtn.removeAttribute('disabled');
    radicleToggleBtn.removeAttribute('title');
  }
};

// Update the status row from registry
export const updateRadicleStatusLine = () => {
  if (!radicleStatusRow || !radicleStatusLabel || !radicleStatusValue) return;

  const message = getDisplayMessage('radicle');

  if (message) {
    // Parse "Label: value" format
    const colonIndex = message.indexOf(':');
    if (colonIndex > 0) {
      radicleStatusLabel.textContent = message.substring(0, colonIndex + 1);
      radicleStatusValue.textContent = message.substring(colonIndex + 1).trim();
    } else {
      // Fallback for messages without colon
      radicleStatusLabel.textContent = message;
      radicleStatusValue.textContent = '';
    }
    radicleStatusRow.classList.add('visible');
  } else {
    radicleStatusLabel.textContent = '';
    radicleStatusValue.textContent = '';
    radicleStatusRow.classList.remove('visible');
  }
};

// Update toggle visual state based on node mode
export const updateRadicleToggleState = () => {
  if (!radicleToggleBtn) return;

  const mode = state.registry?.radicle?.mode;
  const isReused = mode === 'reused';

  if (isReused) {
    radicleToggleBtn.classList.add('external');
  } else {
    radicleToggleBtn.classList.remove('external');
  }
};

export const initRadicleUi = () => {
  // Initialize DOM elements
  radicleToggleBtn = document.getElementById('radicle-toggle-btn');
  radicleToggleSwitch = document.getElementById('radicle-toggle-switch');
  radiclePeersCount = document.getElementById('radicle-peers-count');
  radicleReposCount = document.getElementById('radicle-repos-count');
  radicleVersionText = document.getElementById('radicle-version-text');
  radicleNodeId = document.getElementById('radicle-node-id');
  radicleInfoPanel = document.querySelector('.radicle-info');
  radicleStatusRow = document.getElementById('radicle-status-row');
  radicleStatusLabel = document.getElementById('radicle-status-label');
  radicleStatusValue = document.getElementById('radicle-status-value');

  // Check binary availability
  if (window.radicle) {
    window.radicle.checkBinary().then(({ available }) => {
      radicleBinaryAvailable = available;
      setToggleDisabled(!available);
      if (!available) {
        pushDebug('Radicle binaries not found - toggle disabled');
      }
    });
  }

  // Toggle button listener
  radicleToggleBtn?.addEventListener('click', () => {
    if (!radicleBinaryAvailable) return;

    if (state.currentRadicleStatus === 'running' || state.currentRadicleStatus === 'starting') {
      state.suppressRadicleRunningStatus = true;
      radicleToggleSwitch?.classList.remove('running');
      stopRadicleInfoPolling();
      pushDebug('User toggled Radicle Off');
      window.radicle
        .stop()
        .then(({ status, error }) => updateRadicleUi(status, error))
        .catch((err) => {
          console.error('Failed to toggle Radicle', err);
          pushDebug(`Failed to toggle Radicle: ${err.message}`);
        });
    } else {
      state.suppressRadicleRunningStatus = false;
      radicleToggleSwitch?.classList.add('running');
      startRadicleInfoPolling();
      pushDebug('User toggled Radicle On');
      window.radicle
        .start()
        .then(({ status, error }) => updateRadicleUi(status, error))
        .catch((err) => {
          console.error('Failed to toggle Radicle', err);
          pushDebug(`Failed to toggle Radicle: ${err.message}`);
        });
    }
  });

  // Listen for status updates from main process
  if (window.radicle) {
    const handleStatus = ({ status, error }) => {
      pushDebug(`Radicle Status Update: ${status} ${error ? `(${error})` : ''}`);
      updateRadicleUi(status, error);
    };
    window.radicle.onStatusUpdate(handleStatus);

    // Initial status check
    const refreshRadicleStatus = () => {
      window.radicle.getStatus().then(({ status, error }) => {
        updateRadicleUi(status, error);
      });
    };
    refreshRadicleStatus();
    setInterval(refreshRadicleStatus, 5000);
  }
};
