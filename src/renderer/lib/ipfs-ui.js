// IPFS node UI controls
import { state, buildIpfsApiUrl, getDisplayMessage } from './state.js';
import { pushDebug } from './debug.js';

// DOM elements (initialized in initIpfsUi)
let ipfsToggleBtn = null;
let ipfsToggleSwitch = null;
let ipfsPeersCount = null;
let ipfsBandwidthDown = null;
let ipfsBandwidthUp = null;
let ipfsVersionText = null;
let ipfsInfoPanel = null;
let ipfsStatusRow = null;
let ipfsStatusLabel = null;
let ipfsStatusValue = null;

// Binary availability state
let ipfsBinaryAvailable = true;

export const stopIpfsInfoPolling = () => {
  if (state.ipfsPeersInterval) {
    clearInterval(state.ipfsPeersInterval);
    state.ipfsPeersInterval = null;
  }
  ipfsInfoPanel?.classList.remove('visible');
  if (ipfsPeersCount) ipfsPeersCount.textContent = '0';
  if (ipfsBandwidthDown) ipfsBandwidthDown.textContent = '';
  if (ipfsBandwidthUp) ipfsBandwidthUp.textContent = '';
  if (ipfsVersionText)
    ipfsVersionText.textContent = state.ipfsVersionFetched ? state.ipfsVersionValue : '';
};

const formatBandwidth = (bytesPerSec) => {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
};

const fetchPeersAndBandwidth = async () => {
  if (!state.beeMenuOpen) return;
  if (state.currentIpfsStatus === 'stopped') {
    stopIpfsInfoPolling();
    return;
  }
  if (!ipfsInfoPanel?.classList.contains('visible')) return;

  // Fetch version if not yet fetched
  if (!state.ipfsVersionFetched) fetchVersionOnce();

  // Fetch peers
  try {
    const response = await fetch(buildIpfsApiUrl('/api/v0/swarm/peers'), { method: 'POST' });
    if (!ipfsInfoPanel?.classList.contains('visible')) return;
    if (response.ok) {
      const data = await response.json();
      const peers = data?.Peers || [];
      if (ipfsPeersCount) ipfsPeersCount.textContent = String(peers.length ?? 0);
    } else if (ipfsPeersCount) {
      ipfsPeersCount.textContent = '0';
    }
  } catch {
    if (ipfsPeersCount) ipfsPeersCount.textContent = '0';
  }

  // Fetch bandwidth stats
  try {
    const bwResponse = await fetch(buildIpfsApiUrl('/api/v0/stats/bw'), { method: 'POST' });
    if (!ipfsInfoPanel?.classList.contains('visible')) return;
    if (bwResponse.ok) {
      const bwData = await bwResponse.json();
      const rateIn = bwData?.RateIn || 0;
      const rateOut = bwData?.RateOut || 0;
      if (ipfsBandwidthDown) ipfsBandwidthDown.textContent = `↓${formatBandwidth(rateIn)}`;
      if (ipfsBandwidthUp) ipfsBandwidthUp.textContent = `↑${formatBandwidth(rateOut)}`;
    } else {
      if (ipfsBandwidthDown) ipfsBandwidthDown.textContent = '';
      if (ipfsBandwidthUp) ipfsBandwidthUp.textContent = '';
    }
  } catch {
    if (ipfsBandwidthDown) ipfsBandwidthDown.textContent = '';
    if (ipfsBandwidthUp) ipfsBandwidthUp.textContent = '';
  }
};

const fetchVersionOnce = async () => {
  if (state.ipfsVersionFetched) return;
  try {
    const response = await fetch(buildIpfsApiUrl('/api/v0/id'), { method: 'POST' });
    if (response.ok) {
      const data = await response.json();
      state.ipfsVersionValue = data?.AgentVersion?.split('/')[1]?.split('-')[0] || '';
      state.ipfsVersionFetched = true;
      if (ipfsVersionText) ipfsVersionText.textContent = state.ipfsVersionValue;
    } else {
      if (ipfsVersionText) ipfsVersionText.textContent = '';
    }
  } catch {
    if (ipfsVersionText) ipfsVersionText.textContent = '';
  }
};

export const startIpfsInfoPolling = () => {
  if (!state.beeMenuOpen || state.currentIpfsStatus === 'stopped') {
    stopIpfsInfoPolling();
    return;
  }

  ipfsInfoPanel?.classList.add('visible');

  fetchPeersAndBandwidth();
  if (!state.ipfsVersionFetched) fetchVersionOnce();

  if (state.ipfsPeersInterval) clearInterval(state.ipfsPeersInterval);
  state.ipfsPeersInterval = setInterval(fetchPeersAndBandwidth, 1000);
};

export const updateIpfsUi = (status, error) => {
  if (state.suppressIpfsRunningStatus && status === 'running') {
    return;
  }
  if (status === 'stopped' || status === 'error') {
    state.suppressIpfsRunningStatus = false;
  }

  state.currentIpfsStatus = status;

  // Update status line and toggle state from registry
  updateIpfsStatusLine();
  updateIpfsToggleState();

  if (!ipfsToggleBtn || !ipfsToggleSwitch) return;

  ipfsToggleSwitch.classList.remove('running');
  switch (status) {
    case 'running':
    case 'starting':
      ipfsToggleSwitch.classList.add('running');
      break;
    case 'error':
      if (error) pushDebug(`IPFS Error: ${error}`);
      break;
    case 'stopping':
    case 'stopped':
    default:
      // Clear status row when stopped
      if (ipfsStatusRow) ipfsStatusRow.classList.remove('visible');
      break;
  }

  if (state.beeMenuOpen) {
    if (status === 'stopped') {
      stopIpfsInfoPolling();
    } else if (!state.ipfsPeersInterval && ipfsToggleSwitch?.classList.contains('running')) {
      startIpfsInfoPolling();
    }
  }
};

export const resetIpfsVersion = () => {
  state.ipfsVersionFetched = false;
  state.ipfsVersionValue = '';
  if (ipfsVersionText) ipfsVersionText.textContent = '';
  if (ipfsBandwidthDown) ipfsBandwidthDown.textContent = '';
  if (ipfsBandwidthUp) ipfsBandwidthUp.textContent = '';
};

const setToggleDisabled = (disabled) => {
  if (!ipfsToggleBtn) return;

  if (disabled) {
    ipfsToggleBtn.classList.add('disabled');
    ipfsToggleBtn.setAttribute('disabled', 'true');
    ipfsToggleBtn.setAttribute('title', 'IPFS binary not found');
  } else {
    ipfsToggleBtn.classList.remove('disabled');
    ipfsToggleBtn.removeAttribute('disabled');
    ipfsToggleBtn.removeAttribute('title');
  }
};

// Update the status row from registry
export const updateIpfsStatusLine = () => {
  if (!ipfsStatusRow || !ipfsStatusLabel || !ipfsStatusValue) return;

  const message = getDisplayMessage('ipfs');

  if (message) {
    // Parse "Label: value" format
    const colonIndex = message.indexOf(':');
    if (colonIndex > 0) {
      ipfsStatusLabel.textContent = message.substring(0, colonIndex + 1);
      ipfsStatusValue.textContent = message.substring(colonIndex + 1).trim();
    } else {
      // Fallback for messages without colon
      ipfsStatusLabel.textContent = message;
      ipfsStatusValue.textContent = '';
    }
    ipfsStatusRow.classList.add('visible');
  } else {
    ipfsStatusLabel.textContent = '';
    ipfsStatusValue.textContent = '';
    ipfsStatusRow.classList.remove('visible');
  }
};

// Update toggle disabled state based on node mode
export const updateIpfsToggleState = () => {
  if (!ipfsToggleBtn) return;

  const mode = state.registry?.ipfs?.mode;
  const isReused = mode === 'reused';

  if (isReused) {
    ipfsToggleBtn.classList.add('external');
    ipfsToggleBtn.setAttribute('title', 'Using existing node — cannot be controlled from Freedom');
  } else if (ipfsBinaryAvailable) {
    ipfsToggleBtn.classList.remove('external');
    ipfsToggleBtn.removeAttribute('title');
  }
};

export const initIpfsUi = () => {
  // Initialize DOM elements
  ipfsToggleBtn = document.getElementById('ipfs-toggle-btn');
  ipfsToggleSwitch = document.getElementById('ipfs-toggle-switch');
  ipfsPeersCount = document.getElementById('ipfs-peers-count');
  ipfsBandwidthDown = document.getElementById('ipfs-bandwidth-down');
  ipfsBandwidthUp = document.getElementById('ipfs-bandwidth-up');
  ipfsVersionText = document.getElementById('ipfs-version-text');
  ipfsInfoPanel = document.querySelector('.ipfs-info');
  ipfsStatusRow = document.getElementById('ipfs-status-row');
  ipfsStatusLabel = document.getElementById('ipfs-status-label');
  ipfsStatusValue = document.getElementById('ipfs-status-value');

  // Check binary availability
  if (window.ipfs) {
    window.ipfs.checkBinary().then(({ available }) => {
      ipfsBinaryAvailable = available;
      setToggleDisabled(!available);
      if (!available) {
        pushDebug('IPFS binary not found - toggle disabled');
      }
    });
  }

  // Toggle button listener
  ipfsToggleBtn?.addEventListener('click', () => {
    if (!ipfsBinaryAvailable) return;

    // Don't allow toggling when using an external node
    const mode = state.registry?.ipfs?.mode;
    if (mode === 'reused') return;

    if (state.currentIpfsStatus === 'running' || state.currentIpfsStatus === 'starting') {
      state.suppressIpfsRunningStatus = true;
      ipfsToggleSwitch?.classList.remove('running');
      stopIpfsInfoPolling();
      pushDebug('User toggled IPFS Off');
      window.ipfs
        .stop()
        .then(({ status, error }) => updateIpfsUi(status, error))
        .catch((err) => {
          console.error('Failed to toggle IPFS', err);
          pushDebug(`Failed to toggle IPFS: ${err.message}`);
        });
    } else {
      state.suppressIpfsRunningStatus = false;
      ipfsToggleSwitch?.classList.add('running');
      startIpfsInfoPolling();
      pushDebug('User toggled IPFS On');
      window.ipfs
        .start()
        .then(({ status, error }) => updateIpfsUi(status, error))
        .catch((err) => {
          console.error('Failed to toggle IPFS', err);
          pushDebug(`Failed to toggle IPFS: ${err.message}`);
        });
    }
  });

  // Listen for status updates from main process
  if (window.ipfs) {
    const handleStatus = ({ status, error }) => {
      pushDebug(`IPFS Status Update: ${status} ${error ? `(${error})` : ''}`);
      updateIpfsUi(status, error);
    };
    window.ipfs.onStatusUpdate(handleStatus);

    // Initial status check
    const refreshIpfsStatus = () => {
      window.ipfs.getStatus().then(({ status, error }) => {
        updateIpfsUi(status, error);
      });
    };
    refreshIpfsStatus();
    setInterval(refreshIpfsStatus, 5000);
  }
};
