// Radicle node UI controls
import { state, getDisplayMessage } from './state.js';
import { pushDebug } from './debug.js';

// DOM elements (initialized in initRadicleUi)
let radicleToggleBtn = null;
let radicleToggleSwitch = null;
let radiclePeersCount = null;
let radicleReposCount = null;
let radicleVersionText = null;
let radicleInfoPanel = null;
let radicleStatusRow = null;
let radicleStatusLabel = null;
let radicleStatusValue = null;

// Binary availability state
let radicleBinaryAvailable = true;

export const stopRadicleInfoUpdates = () => {
  radicleInfoPanel?.classList.remove('visible');
  if (radiclePeersCount) radiclePeersCount.textContent = '0';
  if (radicleReposCount) radicleReposCount.textContent = '0';
  if (radicleVersionText) radicleVersionText.textContent = state.radicleVersionFetched ? state.radicleVersionValue : '';
};

const isDisabledForProfile = () => state.registry.radicle?.mode === 'disabled';

const applyRadicleInfo = (info) => {
  if (!radicleInfoPanel?.classList.contains('visible')) return;
  if (info.success && radiclePeersCount) {
    radiclePeersCount.textContent = String(info.count);
  } else if (radiclePeersCount) {
    radiclePeersCount.textContent = '0';
  }
  // Counters in this menu share one empty state: '0', not '--' (#227).
  // '--' stays reserved for the non-numeric Version row.
  if (radicleReposCount) {
    radicleReposCount.textContent = Number.isInteger(info.reposCount)
      ? String(info.reposCount)
      : '0';
  }
  if (typeof info.version === 'string' && info.version) {
    state.radicleVersionValue = `libradicle v${info.version}`;
    state.radicleVersionFetched = true;
  }
  if (radicleVersionText) {
    radicleVersionText.textContent = state.radicleVersionValue || '--';
  }
};

const refreshRadicleInfo = async () => {
  if (!state.antMenuOpen) return;
  if (state.currentRadicleStatus === 'stopped') {
    stopRadicleInfoUpdates();
    return;
  }
  if (!radicleInfoPanel?.classList.contains('visible')) return;

  // Fetch node information through the preload bridge. The internal radapi:
  // protocol deliberately does not grant cross-origin access to the renderer.
  if (window.radicle?.getConnections) {
    try {
      const info = await window.radicle.getConnections();
      applyRadicleInfo(info);
    } catch {
      if (radiclePeersCount) radiclePeersCount.textContent = '0';
      if (radicleReposCount) radicleReposCount.textContent = '0';
      if (radicleVersionText) {
        radicleVersionText.textContent = state.radicleVersionValue || '--';
      }
    }
  }
};

export const startRadicleInfoUpdates = () => {
  if (!state.antMenuOpen || state.currentRadicleStatus === 'stopped') {
    stopRadicleInfoUpdates();
    return;
  }

  radicleInfoPanel?.classList.add('visible');

  void refreshRadicleInfo();
};

export const updateRadicleUi = (status, error) => {
  if (state.suppressRadicleRunningStatus && status === 'running') {
    return;
  }
  if (status === 'stopped' || status === 'error') {
    state.suppressRadicleRunningStatus = false;
  }

  state.currentRadicleStatus = status;

  // Update status line from registry.
  updateRadicleStatusLine();

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
      break;
  }

  if (state.antMenuOpen) {
    if (status === 'stopped') {
      stopRadicleInfoUpdates();
    } else if (
      radicleToggleSwitch?.classList.contains('running') &&
      !radicleInfoPanel?.classList.contains('visible')
    ) {
      startRadicleInfoUpdates();
    }
  }
};

const updateToggleAvailability = () => {
  if (!radicleToggleBtn) return;

  const profileDisabled = isDisabledForProfile();
  const disabled = profileDisabled || !radicleBinaryAvailable;
  if (disabled) {
    radicleToggleBtn.classList.add('disabled');
    radicleToggleBtn.setAttribute('disabled', 'true');
    radicleToggleBtn.setAttribute(
      'title',
      profileDisabled ? 'Disabled for this profile in Settings' : 'libradicle addon not found'
    );
  } else {
    radicleToggleBtn.classList.remove('disabled');
    radicleToggleBtn.removeAttribute('disabled');
    radicleToggleBtn.removeAttribute('title');
  }
};

const refreshRadicleBinaryAvailability = () => {
  if (!window.radicle?.checkBinary) return;
  window.radicle.checkBinary().then(({ available }) => {
    radicleBinaryAvailable = available;
    updateToggleAvailability();
    if (!available) {
      pushDebug('libradicle addon not found - toggle disabled');
    }
  });
};

// Update the status row from registry
export const updateRadicleStatusLine = () => {
  updateToggleAvailability();
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

export const initRadicleUi = () => {
  // Initialize DOM elements
  radicleToggleBtn = document.getElementById('radicle-toggle-btn');
  radicleToggleSwitch = document.getElementById('radicle-toggle-switch');
  radiclePeersCount = document.getElementById('radicle-peers-count');
  radicleReposCount = document.getElementById('radicle-repos-count');
  radicleVersionText = document.getElementById('radicle-version-text');
  radicleInfoPanel = document.querySelector('.radicle-info');
  radicleStatusRow = document.getElementById('radicle-status-row');
  radicleStatusLabel = document.getElementById('radicle-status-label');
  radicleStatusValue = document.getElementById('radicle-status-value');

  // Check binary availability
  refreshRadicleBinaryAvailability();

  // Toggle button listener
  radicleToggleBtn?.addEventListener('click', () => {
    if (isDisabledForProfile() || !radicleBinaryAvailable) return;

    if (state.currentRadicleStatus === 'running' || state.currentRadicleStatus === 'starting') {
      state.suppressRadicleRunningStatus = true;
      radicleToggleSwitch?.classList.remove('running');
      stopRadicleInfoUpdates();
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
      startRadicleInfoUpdates();
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
    const handleStatus = ({ status, error, info }) => {
      pushDebug(`Radicle Status Update: ${status} ${error ? `(${error})` : ''}`);
      updateRadicleUi(status, error);
      if (info) applyRadicleInfo(info);
    };
    window.radicle.onStatusUpdate(handleStatus);
  }

};
