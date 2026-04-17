import { state, getDisplayMessage } from './state.js';
import { pushDebug } from './debug.js';

let tonToggleBtn = null;
let tonToggleSwitch = null;
let tonStatusRow = null;
let tonStatusLabel = null;
let tonStatusValue = null;
let tonProxyPort = null;
let tonVersionText = null;

let tonInfoPanel = null;
let tonBinaryAvailable = true;
let tonUiInitialized = false;

const setToggleDisabled = (disabled) => {
  if (!tonToggleBtn) return;

  if (disabled) {
    tonToggleBtn.classList.add('disabled');
    tonToggleBtn.setAttribute('disabled', 'true');
    tonToggleBtn.setAttribute('title', 'TON binary not found');
  } else {
    tonToggleBtn.classList.remove('disabled');
    tonToggleBtn.removeAttribute('disabled');
    tonToggleBtn.removeAttribute('title');
  }
};

export const updateTonStatusLine = () => {
  if (!tonStatusRow || !tonStatusLabel || !tonStatusValue) return;

  const message = getDisplayMessage('ton');

  if (message) {
    const colonIndex = message.indexOf(':');
    if (colonIndex > 0) {
      tonStatusLabel.textContent = message.substring(0, colonIndex + 1);
      tonStatusValue.textContent = message.substring(colonIndex + 1).trim();
    } else {
      tonStatusLabel.textContent = message;
      tonStatusValue.textContent = '';
    }
    tonStatusRow.classList.add('visible');
  } else {
    tonStatusLabel.textContent = '';
    tonStatusValue.textContent = '';
    tonStatusRow.classList.remove('visible');
  }
};

export const updateTonUi = (status, payload = {}) => {
  if (state.suppressTonRunningStatus && status === 'running') {
    return;
  }
  if (status === 'stopped' || status === 'error') {
    state.suppressTonRunningStatus = false;
  }

  state.currentTonStatus = status;

  updateTonStatusLine();

  if (!tonToggleBtn || !tonToggleSwitch) return;

  tonToggleSwitch.classList.remove('running');

  switch (status) {
    case 'running':
    case 'starting':
      tonToggleSwitch.classList.add('running');
      tonInfoPanel?.classList.add('visible');
      if (payload.proxyPort && tonProxyPort) {
        tonProxyPort.textContent = String(payload.proxyPort);
      }
      if (payload.version && tonVersionText) {
        tonVersionText.textContent = payload.version;
      }
      break;
    case 'error':
      if (payload.error) pushDebug(`TON Error: ${payload.error}`);
      tonInfoPanel?.classList.remove('visible');
      break;
    case 'stopping':
    case 'stopped':
    default:
      tonInfoPanel?.classList.remove('visible');
      if (tonStatusRow) tonStatusRow.classList.remove('visible');
      if (tonProxyPort) tonProxyPort.textContent = '--';
      if (tonVersionText) tonVersionText.textContent = '--';
      break;
  }
};

export const initTonUi = () => {
  tonToggleBtn = document.getElementById('ton-toggle-btn');
  tonToggleSwitch = document.getElementById('ton-toggle-switch');
  tonStatusRow = document.getElementById('ton-status-row');
  tonStatusLabel = document.getElementById('ton-status-label');
  tonStatusValue = document.getElementById('ton-status-value');
  tonProxyPort = document.getElementById('ton-proxy-port');
  tonVersionText = document.getElementById('ton-version-text');
  tonInfoPanel = document.querySelector('.ton-info');

  if (window.ton) {
    window.ton.checkBinary().then(({ available }) => {
      tonBinaryAvailable = available;
      setToggleDisabled(!available);
      if (!available) {
        pushDebug('TON binary not found - toggle disabled');
      }
    });
  }

  if (!tonUiInitialized) {
    tonUiInitialized = true;

    tonToggleBtn?.addEventListener('click', () => {
      if (!tonBinaryAvailable) return;

      if (
        state.currentTonStatus === 'running' ||
        state.currentTonStatus === 'starting'
      ) {
        state.suppressTonRunningStatus = true;
        tonToggleSwitch?.classList.remove('running');
        pushDebug('User toggled TON Off');
        window.ton
          .stop()
          .then((payload) => updateTonUi(payload.status, payload))
          .catch((err) => {
            console.error('Failed to toggle TON', err);
            pushDebug(`Failed to toggle TON: ${err.message}`);
          });
      } else {
        state.suppressTonRunningStatus = false;
        tonToggleSwitch?.classList.add('running');
        pushDebug('User toggled TON On');
        window.ton
          .start()
          .then((payload) => updateTonUi(payload.status, payload))
          .catch((err) => {
            console.error('Failed to toggle TON', err);
            pushDebug(`Failed to toggle TON: ${err.message}`);
          });
      }
    });

    if (window.ton) {
      const handleStatus = (payload) => {
        const status = payload?.status || 'stopped';
        const error = payload?.error || null;
        pushDebug(`TON Status Update: ${status}${error ? ` (${error})` : ''}`);
        updateTonUi(status, payload || {});
      };
      window.ton.onStatusUpdate(handleStatus);

      const refreshTonStatus = () => {
        window.ton.getStatus().then((payload) => {
          updateTonUi(payload.status, payload);
        });
      };
      refreshTonStatus();
      setInterval(refreshTonStatus, 5000);
    }
  }
};
