// Tor (.onion) node UI controls — node-status menu section.
// Mirrors radicle-ui.js but simpler: Tor exposes a status line (the SOCKS
// endpoint) and the Arti software version.
import { state, getDisplayMessage } from './state.js';
import { pushDebug } from './debug.js';
import { versionText } from './ui-format.js';

// DOM elements (initialized in initTorUi)
let torToggleBtn = null;
let torToggleSwitch = null;
let torStatusRow = null;
let torStatusLabel = null;
let torStatusValue = null;
let torVersionRow = null;
let torVersionText = null;
let torInfoPanel = null;
let torNodesSection = null;

// Binary availability state
let torBinaryAvailable = true;

// Version is read from the binary once and cached.
let torVersionFetched = false;
let torVersionValue = '';

const isExternalTorMode = () => state.registry?.tor?.mode === 'external';

// Sole writer of `.tor-info`'s `visible` class, and the only thing that decides
// whether anything renders beneath the Tor toggle.
//
// The block used to be shown unconditionally whenever the integration was on,
// so a stopped Tor still carried a `Version: Arti <n>` row while Swarm, IPFS,
// Ethereum, Gnosis and Radicle all show nothing beneath an off toggle (#349).
// It now follows the node's run state, like the Radicle/IPFS info panels.
//
// `error` is the one state that keeps the block, and only while the registry
// has something to put in it ("Tor failed to start", "External Tor
// unreachable"): that message is the user's only in-menu sign that a start
// attempt failed. An errored node with nothing to say renders
// nothing, same as a stopped one — never a lone version row, which is the shape
// this issue was about.
//
// Known gap, tracked in #377: one refusal path reports STOPPED rather than
// `error` and so loses its message here — a profile with Tor mode `disabled`
// answers a start click via `startDisabledTor()` (tor-manager.js), which sets
// "Tor disabled for this profile" with STATUS.STOPPED. That predates this gate
// (the pre-existing `stopped` branch in `updateTorUi` already stripped the
// status row's `visible` class), and closing it means changing what the main
// process reports or adding a second writer here, so it is deliberately not
// carved out below.
const updateTorInfoVisibility = () => {
  if (!torInfoPanel) return;
  const status = state.currentTorStatus;
  const visible =
    state.enableTorIntegration === true &&
    (status === 'running' ||
      status === 'starting' ||
      (status === 'error' && Boolean(getDisplayMessage('tor'))));
  torInfoPanel.classList.toggle('visible', visible);
};

const renderTorVersionLine = () => {
  const showBundledVersion = state.enableTorIntegration === true && !isExternalTorMode();
  if (torVersionRow) torVersionRow.hidden = !showBundledVersion;
  if (!torVersionText) return;
  torVersionText.textContent = showBundledVersion ? versionText(torVersionValue) : '';
};

const fetchTorVersionOnce = async () => {
  if (torVersionFetched) {
    renderTorVersionLine();
    return;
  }
  if (!state.enableTorIntegration || isExternalTorMode() || !window.tor?.getVersion) {
    renderTorVersionLine();
    return;
  }
  try {
    const result = await window.tor.getVersion();
    if (result?.success && result.version) {
      torVersionFetched = true;
      torVersionValue = `${result.name || 'Arti'} ${result.version}`;
      renderTorVersionLine();
    } else if (torVersionText) {
      torVersionValue = '';
      renderTorVersionLine();
    }
  } catch {
    torVersionValue = '';
    renderTorVersionLine();
  }
};

const updateTorSectionVisibility = () => {
  const enabled = state.enableTorIntegration === true;
  torNodesSection?.classList.toggle('hidden', !enabled);
  if (!enabled) {
    torToggleSwitch?.classList.remove('running');
  }
  updateTorInfoVisibility();
};

export const updateTorUi = (status, error) => {
  if (!state.enableTorIntegration) {
    state.currentTorStatus = 'stopped';
    updateTorInfoVisibility();
    return;
  }
  if (state.suppressTorRunningStatus && status === 'running') {
    return;
  }
  if (status === 'stopped' || status === 'error') {
    state.suppressTorRunningStatus = false;
  }

  state.currentTorStatus = status;

  updateTorStatusLine();
  // Also called from updateTorStatusLine, which bails early when the status-row
  // elements are missing; the run state still has to reach the panel.
  updateTorInfoVisibility();

  if (!torToggleBtn || !torToggleSwitch) return;

  torToggleSwitch.classList.remove('running');
  switch (status) {
    case 'running':
    case 'starting':
      torToggleSwitch.classList.add('running');
      break;
    case 'error':
      if (error) pushDebug(`Tor Error: ${error}`);
      break;
    case 'stopping':
    case 'stopped':
    default:
      if (torStatusRow) torStatusRow.classList.remove('visible');
      break;
  }
};

const setToggleDisabled = (disabled) => {
  if (!torToggleBtn) return;
  if (disabled) {
    torToggleBtn.classList.add('disabled');
    torToggleBtn.setAttribute('disabled', 'true');
    torToggleBtn.setAttribute('title', 'Tor (arti) binary not found');
  } else {
    torToggleBtn.classList.remove('disabled');
    torToggleBtn.removeAttribute('disabled');
    torToggleBtn.removeAttribute('title');
  }
};

const updateTorToggleAvailability = () => {
  setToggleDisabled(!torBinaryAvailable && !isExternalTorMode());
};

const refreshTorBinaryAvailability = () => {
  if (!window.tor?.checkBinary) return;
  window.tor.checkBinary().then(({ available }) => {
    torBinaryAvailable = available;
    updateTorToggleAvailability();
    if (!available) {
      pushDebug('Tor (arti) binary not found - toggle disabled');
    }
  });
};

// Update the status row from registry (e.g. "SOCKS: 127.0.0.1:9150")
export const updateTorStatusLine = () => {
  if (!state.enableTorIntegration) return;
  if (!torStatusRow || !torStatusLabel || !torStatusValue) return;

  updateTorToggleAvailability();
  renderTorVersionLine();
  fetchTorVersionOnce();

  const message = getDisplayMessage('tor');

  if (message) {
    const colonIndex = message.indexOf(':');
    if (colonIndex > 0) {
      torStatusLabel.textContent = message.substring(0, colonIndex + 1);
      torStatusValue.textContent = message.substring(colonIndex + 1).trim();
    } else {
      torStatusLabel.textContent = message;
      torStatusValue.textContent = '';
    }
    torStatusRow.classList.add('visible');
  } else {
    torStatusLabel.textContent = '';
    torStatusValue.textContent = '';
    torStatusRow.classList.remove('visible');
  }

  // A registry broadcast can add or drop the status message without any status
  // change, and on `error` that message is what keeps the block up.
  updateTorInfoVisibility();
};

export const initTorUi = () => {
  torToggleBtn = document.getElementById('tor-toggle-btn');
  torToggleSwitch = document.getElementById('tor-toggle-switch');
  torStatusRow = document.getElementById('tor-status-row');
  torStatusLabel = document.getElementById('tor-status-label');
  torStatusValue = document.getElementById('tor-status-value');
  torVersionText = document.getElementById('tor-version-text');
  torVersionRow = torVersionText?.closest?.('.tor-info-row') || null;
  torInfoPanel = document.querySelector('.tor-info');
  torNodesSection = document.getElementById('tor-nodes-section');
  updateTorSectionVisibility();

  refreshTorBinaryAvailability();
  fetchTorVersionOnce();

  torToggleBtn?.addEventListener('click', () => {
    if (!state.enableTorIntegration) return;
    if (!torBinaryAvailable && !isExternalTorMode()) return;

    if (state.currentTorStatus === 'running' || state.currentTorStatus === 'starting') {
      state.suppressTorRunningStatus = true;
      torToggleSwitch?.classList.remove('running');
      pushDebug('User toggled Tor Off');
      window.tor
        .stop()
        .then(({ status, error }) => updateTorUi(status, error))
        .catch((err) => {
          console.error('Failed to toggle Tor', err);
          pushDebug(`Failed to toggle Tor: ${err.message}`);
        });
    } else {
      state.suppressTorRunningStatus = false;
      torToggleSwitch?.classList.add('running');
      pushDebug('User toggled Tor On');
      window.tor
        .start()
        .then(({ status, error }) => updateTorUi(status, error))
        .catch((err) => {
          console.error('Failed to toggle Tor', err);
          pushDebug(`Failed to toggle Tor: ${err.message}`);
        });
    }
  });

  if (window.tor) {
    const handleStatus = ({ status, error }) => {
      pushDebug(`Tor Status Update: ${status} ${error ? `(${error})` : ''}`);
      updateTorUi(status, error);
    };
    window.tor.onStatusUpdate(handleStatus);

    const refreshTorStatus = () => {
      window.tor.getStatus().then(({ status, error }) => {
        updateTorUi(status, error);
      });
    };
    refreshTorStatus();
    setInterval(refreshTorStatus, 5000);
  }

  window.addEventListener('settings:updated', (event) => {
    const wasEnabled = state.enableTorIntegration === true;
    const isEnabled = event.detail?.enableTorIntegration === true;
    state.enableTorIntegration = isEnabled;
    updateTorSectionVisibility();
    if (!wasEnabled && isEnabled) {
      refreshTorBinaryAvailability();
      fetchTorVersionOnce();
    }
  });
};
