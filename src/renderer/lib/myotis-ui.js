// Myotis embedded Ethereum light-client controls in the Nodes menu.
import { state } from './state.js';
import { pushDebug } from './debug.js';
import { countText, versionText as versionLabel } from './ui-format.js';

let toggleButton = null;
let toggleSwitch = null;
let infoPanel = null;
let stateText = null;
let peersCount = null;
let finalizedBlock = null;
let versionText = null;
let divider = null;
let retryCheckpointButton = null;
const retryingCheckpoints = new Set();
const retryErrors = new Map();
const notifiedFailures = new Map();
const pendingNotices = new Map();
let recoveryNotice = null;
let recoveryNoticeText = null;
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
  retryCheckpointButton: null,
  status: null,
  desiredRunning: null,
  reconciling: false,
};

const isLiveRunning = () => latestStatus?.running === true;
const isEffectivelyRunning = () => (desiredRunning === null ? isLiveRunning() : desiredRunning);

const stateLabel = (status) => {
  if (!status) return 'Unavailable';
  if (status.state === 'disabled') return 'Disabled';
  if (status.state === 'unavailable') return 'Unavailable';
  if (status.state === 'error') return 'Error';
  if (status.state === 'off') return 'Off';
  if (status.state === 'ready') return 'Ready';
  if (status.state === 'recovering') return 'Recovering';
  if (status.state === 'recovery-blocked') {
    return status.recovery?.reason === 'stalled' ? 'Syncing slowly' : 'Sync paused';
  }
  if (status.beaconState === 'STALE_ANCHOR') return 'Sync paused';
  if (status.paused) return 'Paused';
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
  const controllable = supported && (available || status?.running === true) && !disabled;
  const running = isEffectivelyRunning();

  if (divider) divider.hidden = !supported;
  updateRecovery(retryCheckpointButton, status, 1);

  if (toggleButton) {
    toggleButton.hidden = !supported;
    toggleButton.disabled = !controllable;
    toggleButton.classList.toggle('disabled', !controllable);
    if (disabled) {
      toggleButton.title = 'Disabled for this profile in Settings';
    } else if (status?.recovery) {
      toggleButton.title = recoveryMessage(status);
    } else if (!available) {
      toggleButton.title = 'Myotis native addon not found';
    } else if (status?.error) {
      toggleButton.title = status.error;
    } else {
      toggleButton.removeAttribute('title');
    }
  }
  toggleSwitch?.classList.toggle('running', running);
  infoPanel?.classList.toggle('visible', state.antMenuOpen && (running || Boolean(status?.recovery)));
  if (stateText) stateText.textContent = stateLabel(status);
  if (peersCount) peersCount.textContent = String(status?.peerCount ?? 0);
  if (finalizedBlock) finalizedBlock.textContent = countText(status?.finalizedBlockNumber);
  if (versionText) {
    versionText.textContent = versionLabel(status?.version && `Myotis v${status.version}`);
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
  const controllable = supported && (available || status?.running === true) && !disabled;
  const running = gnosis.desiredRunning === null ? status?.running === true : gnosis.desiredRunning;

  if (gnosis.divider) gnosis.divider.hidden = !supported;
  updateRecovery(gnosis.retryCheckpointButton, status, gnosis.chainId);

  if (gnosis.button) {
    gnosis.button.hidden = !supported;
    gnosis.button.disabled = !controllable;
    gnosis.button.classList.toggle('disabled', !controllable);
    if (disabled) gnosis.button.title = 'Disabled for this profile in Settings';
    else if (status?.recovery) gnosis.button.title = recoveryMessage(status);
    else if (!available) gnosis.button.title = 'Myotis native addon not found';
    else if (status?.error) gnosis.button.title = status.error;
    else gnosis.button.removeAttribute('title');
  }
  gnosis.toggle?.classList.toggle('running', running);
  gnosis.info?.classList.toggle('visible', state.antMenuOpen && (running || Boolean(status?.recovery)));
  if (gnosis.state) gnosis.state.textContent = stateLabel(status);
  if (gnosis.peers) gnosis.peers.textContent = String(status?.peerCount ?? 0);
  if (gnosis.block) gnosis.block.textContent = countText(status?.finalizedBlockNumber);
  if (gnosis.version) {
    gnosis.version.textContent = versionLabel(status?.version && `Myotis v${status.version}`);
  }
};

const recoveryFailureMessage = (reason) =>
  ({
    'quorum-unavailable': 'Not enough checkpoint sources could confirm a recent checkpoint. Check your connection and retry.',
    'quorum-conflict': 'Checkpoint sources disagree. Sync is paused. Retry to check again.',
    unavailable: 'Could not reach the checkpoint service. Check your connection and retry.',
    stale: 'The checkpoint service returned an outdated checkpoint. Retry to get a recent one.',
    mismatch: 'Checkpoint could not be verified. Sync is paused.',
    clock: 'Check your computer’s date and time, then retry.',
    storage: 'Local sync data is inconsistent. Repair sync data to start again; your old data will be kept.',
    'storage-io': 'Could not read or save sync data. Check disk space and folder permissions, then retry.',
    ownership:
      'Could not confirm that the previous node stopped. Close other Freedom instances and retry. If this persists, choose Get help.',
    unsupported: 'Update or reinstall Freedom to recover this node.',
    installation: 'The sync component is missing or incompatible. Update or reinstall Freedom.',
    startup: 'Could not restart the node. Retry to resume syncing.',
    stalled:
      'Sync is taking longer than expected. Check your connection; the node will keep trying.',
  })[reason] || 'Could not recover this node. Retry to resume syncing.';

const recoveryMessage = (status) => {
  const recovery = status?.recovery;
  if (recovery?.phase === 'blocked') return recoveryFailureMessage(recovery.reason);
  if (status?.state !== 'recovering') return '';
  if (recovery?.phase === 'waiting') {
    const retryAt = recovery.nextRetryAt;
    const seconds = Number.isFinite(retryAt) ? Math.ceil((retryAt - Date.now()) / 1000) : 0;
    const reason =
      recovery.reason === 'stale'
        ? 'Checkpoint is still out of date.'
        : recovery.reason === 'quorum-unavailable'
          ? 'Waiting for checkpoint sources to agree.'
          : 'Checkpoint service unavailable.';
    return seconds > 0 ? `${reason} Retrying in ${seconds}s…` : `${reason} Waiting to retry…`;
  }
  if (recovery?.phase === 'restarting') {
    return recovery.mode === 'restart'
      ? 'Restarting node…'
      : 'Checkpoint verified. Restarting sync…';
  }
  return 'Updating sync checkpoint…';
};

function renderRecoveryNotice() {
  if (!recoveryNotice || !recoveryNoticeText) return;
  const notices = [...pendingNotices.values()];
  recoveryNotice.hidden = notices.length === 0;
  recoveryNoticeText.textContent =
    notices.length > 1
      ? [...pendingNotices.keys()].some(id => (id === 100 ? gnosis.status : latestStatus)?.recovery?.phase === 'blocked')
        ? 'Ethereum and Gnosis sync need attention. Open Nodes for details.'
        : 'Ethereum and Gnosis sync recovery is taking longer than usual. Still trying automatically.'
      : notices[0] || '';
}

function updateRecovery(button, status, chainId) {
  const active = (status?.running || status?.recovery) && status?.state !== 'disabled';
  const blocked = active && status?.recovery?.phase === 'blocked';
  const slow = active && status?.state === 'recovering' && status.recovery?.takingLonger;
  const message = document.getElementById(
    chainId === 100 ? 'myotis-gnosis-recovery-message' : 'myotis-recovery-message'
  );
  if (!blocked) retryErrors.delete(chainId);
  if (message) {
    message.textContent = active ? retryErrors.get(chainId) || recoveryMessage(status) : '';
    message.hidden = !message.textContent;
    message.classList.toggle('warning', Boolean(blocked));
  }
  if (button) {
    button.hidden = !(blocked && status.recovery?.canRetry);
    button.disabled = retryingCheckpoints.has(chainId);
    button.textContent = button.disabled ? 'Starting…' : status?.recovery?.reason === 'storage' ? 'Repair sync data' : 'Retry sync';
  }
  const help = document.getElementById(chainId === 100 ? 'myotis-gnosis-recovery-help' : 'myotis-recovery-help');
  if (help) help.hidden = !(blocked && ['storage', 'storage-io', 'ownership', 'installation', 'unsupported'].includes(status.recovery?.reason));
  if (blocked || slow) {
    const key = slow ? 'slow' : `${status.recovery?.attempt}:${status.recovery?.reason}`;
    if (notifiedFailures.get(chainId) !== key) {
      notifiedFailures.set(chainId, key);
      pendingNotices.set(
        chainId,
        `${chainId === 100 ? 'Gnosis' : 'Ethereum'}: ${slow ? 'Sync recovery is taking longer than usual. Still trying automatically; you can keep browsing.' : recoveryFailureMessage(status.recovery?.reason)}`
      );
    }
  } else {
    notifiedFailures.delete(chainId);
    pendingNotices.delete(chainId);
  }
  renderRecoveryNotice();
}

async function retryCheckpoint(chainId) {
  const status = chainId === 100 ? gnosis.status : latestStatus;
  if (retryingCheckpoints.has(chainId) || !status?.running || !status.recovery?.canRetry) return;
  retryingCheckpoints.add(chainId);
  retryErrors.delete(chainId);
  const update = chainId === 100 ? updateGnosisControls : updateControls;
  update(status);
  try {
    update(await (status.recovery.reason === 'storage' ? window.myotis.repairSyncData : window.myotis.retryCheckpoint)(chainId));
  } catch {
    retryErrors.set(chainId, 'The recovery action could not start. Try again.');
    pushDebug('Myotis checkpoint retry failed');
  } finally {
    retryingCheckpoints.delete(chainId);
    update(chainId === 100 ? gnosis.status : latestStatus);
  }
}

export const stopMyotisInfoPolling = () => {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = null;
  infoPanel?.classList.remove('visible');
  gnosis.info?.classList.remove('visible');
};

export const startMyotisInfoPolling = () => {
  if (!state.antMenuOpen) return;
  refreshStatus();
  infoPanel?.classList.toggle('visible', isEffectivelyRunning() || Boolean(latestStatus?.recovery));
  gnosis.info?.classList.toggle(
    'visible',
    (gnosis.desiredRunning === null ? gnosis.status?.running === true : gnosis.desiredRunning) || Boolean(gnosis.status?.recovery)
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
  retryCheckpointButton = document.getElementById('myotis-retry-checkpoint');
  gnosis.retryCheckpointButton = document.getElementById('myotis-gnosis-retry-checkpoint');
  gnosis.button = document.getElementById('myotis-gnosis-toggle-btn');
  gnosis.toggle = document.getElementById('myotis-gnosis-toggle-switch');
  gnosis.info = document.getElementById('myotis-gnosis-info');
  gnosis.state = document.getElementById('myotis-gnosis-state-text');
  gnosis.peers = document.getElementById('myotis-gnosis-peers-count');
  gnosis.block = document.getElementById('myotis-gnosis-finalized-block');
  gnosis.version = document.getElementById('myotis-gnosis-version-text');
  gnosis.divider = document.getElementById('myotis-gnosis-divider');

  recoveryNotice = document.getElementById('myotis-recovery-notice');
  recoveryNoticeText = document.getElementById('myotis-recovery-notice-text');

  if (listenersAttached) return;
  listenersAttached = true;
  const dismissNotice = () => {
    pendingNotices.clear();
    renderRecoveryNotice();
  };
  document.getElementById('myotis-recovery-notice-close')?.addEventListener('click', dismissNotice);
  document.getElementById('myotis-recovery-notice-open')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const chainId = pendingNotices.keys().next().value;
    if (!state.antMenuOpen) document.getElementById('bee-menu-button')?.click();
    (chainId === 100 ? gnosis.info : infoPanel)?.scrollIntoView?.({ block: 'nearest' });
    dismissNotice();
  });
  for (const chainId of [1, 100]) {
    document.getElementById(chainId === 100 ? 'myotis-gnosis-recovery-help' : 'myotis-recovery-help')?.addEventListener('click', async () => {
      try { await window.myotis.recoveryHelp(chainId); } catch {
        retryErrors.set(chainId, 'Help could not open. Try again.');
        if (chainId === 100) updateGnosisControls(gnosis.status);
        else updateControls(latestStatus);
      }
    });
  }
  retryCheckpointButton?.addEventListener('click', () => retryCheckpoint(1));
  gnosis.retryCheckpointButton?.addEventListener('click', () => retryCheckpoint(100));

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
  }
  refreshStatus();
};
