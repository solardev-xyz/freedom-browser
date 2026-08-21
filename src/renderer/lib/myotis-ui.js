// Myotis embedded Ethereum light-client controls in the Nodes menu.
import { state } from './state.js';
import { pushDebug } from './debug.js';

let toggleButton = null;
let toggleSwitch = null;
let infoPanel = null;
let stateText = null;
let peersCount = null;
let finalizedBlock = null;
let versionText = null;
let divider = null;
let latestStatus = null;
let desiredRunning = null;
let reconciling = false;
let listenersAttached = false;
let pollInterval = null;
const gnosis = {
  chainId: 100,
  button: null,
  toggle: null,
  info: null,
  state: null,
  peers: null,
  block: null,
  version: null,
  divider: null,
  status: null,
  desiredRunning: null,
  reconciling: false,
};

const isLiveRunning = () => latestStatus?.running === true;
const isEffectivelyRunning = () =>
  desiredRunning === null ? isLiveRunning() : desiredRunning;

const stateLabel = (status) => {
  if (!status) return 'Unavailable';
  if (status.state === 'disabled') return 'Disabled';
  if (status.state === 'unavailable') return 'Unavailable';
  if (status.state === 'error') return 'Error';
  if (status.state === 'off') return 'Off';
  if (status.state === 'ready') return 'Ready';
  if (status.currentPeriod && status.targetPeriod) {
    return `Syncing ${status.currentPeriod}/${status.targetPeriod}`;
  }
  return 'Syncing';
};

const updateControls = (status) => {
  latestStatus = status || null;
  const supported = status?.supported !== false;
  const available = status?.available === true;
  const disabled = status?.state === 'disabled';
  const controllable = supported && available && !disabled;
  const running = isEffectivelyRunning();

  if (divider) divider.hidden = !supported;

  if (toggleButton) {
    toggleButton.hidden = !supported;
    toggleButton.disabled = !controllable;
    toggleButton.classList.toggle('disabled', !controllable);
    if (disabled) {
      toggleButton.title = 'Disabled for this profile in Settings';
    } else if (!available) {
      toggleButton.title = 'Myotis native addon not found';
    } else {
      toggleButton.removeAttribute('title');
    }
  }
  toggleSwitch?.classList.toggle('running', running);
  infoPanel?.classList.toggle('visible', state.antMenuOpen && running);
  if (stateText) stateText.textContent = stateLabel(status);
  if (peersCount) peersCount.textContent = String(status?.peerCount ?? 0);
  if (finalizedBlock) finalizedBlock.textContent = status?.finalizedBlockNumber || '--';
  if (versionText) {
    versionText.textContent = status?.version ? `Myotis v${status.version}` : 'Myotis';
  }
};

const refreshStatus = async () => {
  try {
    updateControls(await window.myotis?.getStatus?.());
    updateGnosisControls(await window.myotis?.getStatus?.(gnosis.chainId));
  } catch (err) {
    pushDebug(`Myotis status failed: ${err?.message || err}`);
  }
};

const updateGnosisControls = (status) => {
  gnosis.status = status || null;
  const supported = status?.supported !== false;
  const available = status?.available === true;
  const disabled = status?.state === 'disabled';
  const controllable = supported && available && !disabled;
  const running = gnosis.desiredRunning === null
    ? status?.running === true
    : gnosis.desiredRunning;

  if (gnosis.divider) gnosis.divider.hidden = !supported;

  if (gnosis.button) {
    gnosis.button.hidden = !supported;
    gnosis.button.disabled = !controllable;
    gnosis.button.classList.toggle('disabled', !controllable);
    if (disabled) gnosis.button.title = 'Disabled for this profile in Settings';
    else if (!available) gnosis.button.title = 'Myotis native addon not found';
    else gnosis.button.removeAttribute('title');
  }
  gnosis.toggle?.classList.toggle('running', running);
  gnosis.info?.classList.toggle('visible', state.antMenuOpen && running);
  if (gnosis.state) gnosis.state.textContent = stateLabel(status);
  if (gnosis.peers) gnosis.peers.textContent = String(status?.peerCount ?? 0);
  if (gnosis.block) gnosis.block.textContent = status?.finalizedBlockNumber || '--';
  if (gnosis.version) {
    gnosis.version.textContent = status?.version ? `Myotis v${status.version}` : 'Myotis';
  }
};

export const stopMyotisInfoPolling = () => {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = null;
  infoPanel?.classList.remove('visible');
  gnosis.info?.classList.remove('visible');
};

export const startMyotisInfoPolling = () => {
  if (!state.antMenuOpen) return;
  refreshStatus();
  infoPanel?.classList.toggle('visible', isEffectivelyRunning());
  gnosis.info?.classList.toggle(
    'visible',
    gnosis.desiredRunning === null ? gnosis.status?.running === true : gnosis.desiredRunning
  );
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(refreshStatus, 5000);
};

const reconcileGnosisToggle = async () => {
  if (gnosis.reconciling) return;
  gnosis.reconciling = true;
  try {
    while (
      gnosis.desiredRunning !== null &&
      gnosis.desiredRunning !== (gnosis.status?.running === true)
    ) {
      const target = gnosis.desiredRunning;
      try {
        const result = target
          ? await window.myotis.start(gnosis.chainId)
          : await window.myotis.stop(gnosis.chainId);
        updateGnosisControls(result);
      } catch (err) {
        pushDebug(`Failed to toggle Gnosis Myotis: ${err?.message || err}`);
        break;
      }
      if (gnosis.desiredRunning === target && target !== (gnosis.status?.running === true)) break;
    }
  } finally {
    gnosis.desiredRunning = null;
    gnosis.reconciling = false;
    updateGnosisControls(gnosis.status);
  }
};

const reconcileToggle = async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    while (desiredRunning !== null && desiredRunning !== isLiveRunning()) {
      const target = desiredRunning;
      try {
        const result = target ? await window.myotis.start() : await window.myotis.stop();
        updateControls(result);
      } catch (err) {
        pushDebug(`Failed to toggle Myotis: ${err?.message || err}`);
        break;
      }
      if (desiredRunning === target && desiredRunning !== isLiveRunning()) break;
    }
  } finally {
    desiredRunning = null;
    reconciling = false;
    updateControls(latestStatus);
  }
};

export const initMyotisUi = () => {
  toggleButton = document.getElementById('myotis-toggle-btn');
  toggleSwitch = document.getElementById('myotis-toggle-switch');
  infoPanel = document.getElementById('myotis-info');
  stateText = document.getElementById('myotis-state-text');
  peersCount = document.getElementById('myotis-peers-count');
  finalizedBlock = document.getElementById('myotis-finalized-block');
  versionText = document.getElementById('myotis-version-text');
  divider = document.getElementById('myotis-divider');
  gnosis.button = document.getElementById('myotis-gnosis-toggle-btn');
  gnosis.toggle = document.getElementById('myotis-gnosis-toggle-switch');
  gnosis.info = document.getElementById('myotis-gnosis-info');
  gnosis.state = document.getElementById('myotis-gnosis-state-text');
  gnosis.peers = document.getElementById('myotis-gnosis-peers-count');
  gnosis.block = document.getElementById('myotis-gnosis-finalized-block');
  gnosis.version = document.getElementById('myotis-gnosis-version-text');
  gnosis.divider = document.getElementById('myotis-gnosis-divider');

  if (listenersAttached) return;
  listenersAttached = true;

  toggleButton?.addEventListener('click', () => {
    if (toggleButton.disabled) return;
    desiredRunning = !isEffectivelyRunning();
    updateControls(latestStatus);
    pushDebug(`User toggled Myotis ${desiredRunning ? 'On' : 'Off'}`);
    reconcileToggle();
  });

  gnosis.button?.addEventListener('click', () => {
    if (gnosis.button.disabled) return;
    const live = gnosis.status?.running === true;
    gnosis.desiredRunning = !(gnosis.desiredRunning === null ? live : gnosis.desiredRunning);
    updateGnosisControls(gnosis.status);
    pushDebug(`User toggled Gnosis Myotis ${gnosis.desiredRunning ? 'On' : 'Off'}`);
    reconcileGnosisToggle();
  });

  if (window.myotis?.onStatusUpdate) {
    window.myotis.onStatusUpdate((status) => {
      if (status?.chainId === gnosis.chainId) updateGnosisControls(status);
      else updateControls(status);
    });
    window.myotis.getStatus?.(gnosis.chainId).then(updateGnosisControls).catch(() => {});
  } else {
    refreshStatus();
  }
};
