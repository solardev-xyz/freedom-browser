// IPFS node UI controls
import { state, getDisplayMessage } from './state.js';
import { pushDebug } from './debug.js';
import { versionText } from './ui-format.js';

// DOM elements (initialized in initIpfsUi)
let ipfsToggleBtn = null;
let ipfsToggleSwitch = null;
let ipfsActiveRequestsCount = null;
let ipfsDataRead = null;
let ipfsVersionText = null;
let ipfsInfoPanel = null;
let ipfsStatusRow = null;
let ipfsStatusLabel = null;
let ipfsStatusValue = null;

// Binary availability state
let ipfsBinaryAvailable = true;

// Guards one-time listener/subscription wiring so re-running initIpfsUi (e.g.
// to re-check binary availability) doesn't bind the click handler twice.
let ipfsListenersAttached = false;

export const stopIpfsInfoPolling = () => {
  if (state.ipfsInfoInterval) {
    clearInterval(state.ipfsInfoInterval);
    state.ipfsInfoInterval = null;
  }
  ipfsInfoPanel?.classList.remove('visible');
  if (ipfsActiveRequestsCount) ipfsActiveRequestsCount.textContent = '0';
  if (ipfsDataRead) ipfsDataRead.textContent = '';
  if (ipfsVersionText)
    ipfsVersionText.textContent = versionText(
      state.ipfsVersionFetched ? state.ipfsVersionValue : ''
    );
};

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const parseNativeBuildInfo = (raw) => {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const readNativeVersion = (diagnostics = {}) => {
  const buildInfo = parseNativeBuildInfo(diagnostics.nativeBuildInfo);
  return (
    (typeof buildInfo?.version === 'string' && buildInfo.version) ||
    (typeof diagnostics.nativeVersion === 'string' && diagnostics.nativeVersion) ||
    ''
  );
};

// The native node only reports its version once it's actually running. Read it
// off each stats poll and cache it the first time a real version appears — and
// only then. A poll taken while the node is still spinning up (stopped status /
// no diagnostics) shows the menu's shared 'Unknown' placeholder (#253) but does
// NOT mark the version fetched, so later polls keep upgrading it instead of
// locking in the placeholder forever.
// Identity label for an external gateway: the detected node version when the
// RPC answered, otherwise the gateway endpoint. Falls back to the registry gateway
// when no diagnostics are at hand (immediate UI updates that don't carry a stats poll).
const externalIdentityLabel = (diagnostics) => {
  if (diagnostics?.externalVersion) return diagnostics.externalVersion;
  const gateway = diagnostics?.externalGateway || state.registry?.ipfs?.gateway || '';
  return gateway ? `External · ${gateway.replace(/^https?:\/\//, '')}` : 'External gateway';
};

const updateVersionFromDiagnostics = (diagnostics) => {
  if (state.ipfsVersionFetched) return;
  const version = readNativeVersion(diagnostics);
  if (version) {
    state.ipfsVersionValue = `Freedom IPFS v${version}`;
    state.ipfsVersionFetched = true;
  }
  if (ipfsVersionText) ipfsVersionText.textContent = versionText(state.ipfsVersionValue);
};

// The real backend state, ignoring any pending user intent.
const isIpfsLiveRunning = () =>
  state.currentIpfsStatus === 'running' || state.currentIpfsStatus === 'starting';

// What the UI should show: the user's target while a toggle is pending
// (ipfsDesiredRunning !== null), otherwise the live backend state. The switch
// and stats polling read this so the toggle reflects the latest click instantly
// and never flickers back to a transient/stale backend status mid-transition.
const isIpfsEffectivelyRunning = () =>
  state.ipfsDesiredRunning !== null ? state.ipfsDesiredRunning : isIpfsLiveRunning();

const fetchNativeStats = async () => {
  if (!state.antMenuOpen) return;
  if (!isIpfsEffectivelyRunning()) {
    stopIpfsInfoPolling();
    return;
  }
  if (!ipfsInfoPanel?.classList.contains('visible')) return;

  try {
    const status = await window.ipfs?.getStatus?.();
    if (!ipfsInfoPanel?.classList.contains('visible')) return;
    const stats = JSON.parse(status?.diagnostics?.nativeGatewayStats || '{}');
    if (ipfsActiveRequestsCount) {
      ipfsActiveRequestsCount.textContent = String(stats.active_native_handles ?? 0);
    }
    if (ipfsDataRead) {
      ipfsDataRead.textContent = formatBytes(stats.bytes_read || 0);
    }
    if (state.registry?.ipfs?.mode === 'external') {
      if (ipfsVersionText) {
        ipfsVersionText.textContent = externalIdentityLabel(status?.diagnostics);
      }
    } else {
      updateVersionFromDiagnostics(status?.diagnostics);
    }
  } catch {
    if (ipfsActiveRequestsCount) ipfsActiveRequestsCount.textContent = '0';
    if (ipfsDataRead) ipfsDataRead.textContent = '';
  }
};

export const startIpfsInfoPolling = () => {
  if (!state.antMenuOpen || !isIpfsEffectivelyRunning()) {
    stopIpfsInfoPolling();
    return;
  }

  ipfsInfoPanel?.classList.add('visible');

  // fetchNativeStats also reads the node version off the same getStatus call and
  // upgrades the label once a real version is available (see
  // updateVersionFromDiagnostics).
  fetchNativeStats();

  if (state.ipfsInfoInterval) clearInterval(state.ipfsInfoInterval);
  state.ipfsInfoInterval = setInterval(fetchNativeStats, 1000);
};

export const updateIpfsUi = (status, error) => {
  state.currentIpfsStatus = status;

  // Update status line and toggle disabled/external state from registry
  updateIpfsStatusLine();
  updateIpfsToggleState();

  // NOTE: the external-mode identity/version line is owned solely by the stats
  // poll (fetchNativeStats), which has the diagnostics to show the detected node
  // version. Setting it here too made the label flicker between identity/version
  // and the endpoint.
  if (!ipfsToggleBtn || !ipfsToggleSwitch) return;

  // While a toggle is pending (ipfsDesiredRunning !== null) the switch follows
  // the user's target and ignores transient/stale backend states. The intent is
  // cleared by the reconcile loop once it reaches the target or gives up (see
  // reconcileIpfsToggle), after which the switch follows live status again.
  const showRunning = isIpfsEffectivelyRunning();

  ipfsToggleSwitch.classList.toggle('running', showRunning);

  if (status === 'error') {
    if (error) pushDebug(`IPFS Error: ${error}`);
  } else if (!showRunning && ipfsStatusRow) {
    // Clear the status row once the node is no longer running.
    ipfsStatusRow.classList.remove('visible');
  }

  if (state.antMenuOpen) {
    if (!showRunning) {
      stopIpfsInfoPolling();
    } else if (!state.ipfsInfoInterval) {
      startIpfsInfoPolling();
    }
  }
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

  if (message && ipfsStatusRow) {
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
  const isExternal = mode === 'external';

  if (isReused) {
    ipfsToggleBtn.classList.add('external');
    ipfsToggleBtn.setAttribute('title', 'Using existing node — cannot be controlled from Freedom');
  } else if (isExternal) {
    // A user-configured external gateway is controllable and works even when the
    // native addon is unavailable, so keep the switch enabled and drop the "binary not found"
    // hint that setToggleDisabled would otherwise leave in place.
    ipfsToggleBtn.classList.remove('external');
    ipfsToggleBtn.classList.remove('disabled');
    ipfsToggleBtn.removeAttribute('disabled');
    ipfsToggleBtn.setAttribute('title', 'Using an external IPFS gateway');
  } else if (ipfsBinaryAvailable) {
    ipfsToggleBtn.classList.remove('external');
    ipfsToggleBtn.removeAttribute('title');
  }
};

// True while the background reconcile loop is converging the backend toward the
// user's target, so a flurry of clicks doesn't spawn overlapping loops.
let ipfsReconciling = false;

// Drive the backend toward state.ipfsDesiredRunning. The click handler sets the
// target and the switch instantly; this loop does the slow start()/stop() work
// in the background and always converges to the *latest* target, so the user can
// toggle rapidly and the node ends up where they last left the switch.
//
// Each iteration re-reads the target, so a click made mid-flight redirects the
// loop. If an operation completes without reaching a still-unchanged target
// (e.g. a stop that left the node running, or a start that failed), the loop
// gives up rather than spinning, and the switch falls back to the real status.
const reconcileIpfsToggle = async () => {
  if (ipfsReconciling) return;
  ipfsReconciling = true;
  try {
    while (state.ipfsDesiredRunning !== null && state.ipfsDesiredRunning !== isIpfsLiveRunning()) {
      const target = state.ipfsDesiredRunning;
      let status;
      let error;
      try {
        const result = (target ? await window.ipfs.start() : await window.ipfs.stop()) || {};
        ({ status, error } = result);
      } catch (err) {
        console.error('Failed to toggle IPFS', err);
        pushDebug(`Failed to toggle IPFS: ${err.message}`);
        // The call threw; re-query the real status so the UI reflects reality.
        const live = await window.ipfs?.getStatus?.()?.catch(() => null);
        status = live?.status ?? state.currentIpfsStatus;
        error = live?.error;
      }
      updateIpfsUi(status, error);
      // If the target hasn't changed but the op didn't reach it, don't spin —
      // accept reality. If the target changed mid-flight, loop again toward it.
      if (state.ipfsDesiredRunning === target && state.ipfsDesiredRunning !== isIpfsLiveRunning()) {
        break;
      }
    }
  } finally {
    ipfsReconciling = false;
    // Stop overriding the switch: the loop reached the target or gave up, so the
    // live status is now the source of truth.
    state.ipfsDesiredRunning = null;
    updateIpfsUi(state.currentIpfsStatus);
  }
};

export const initIpfsUi = () => {
  // Initialize DOM elements
  ipfsToggleBtn = document.getElementById('ipfs-toggle-btn');
  ipfsToggleSwitch = document.getElementById('ipfs-toggle-switch');
  ipfsActiveRequestsCount = document.getElementById('ipfs-active-requests-count');
  ipfsDataRead = document.getElementById('ipfs-data-read');
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

  if (ipfsListenersAttached) return;
  ipfsListenersAttached = true;

  // Toggle button listener
  ipfsToggleBtn?.addEventListener('click', () => {
    // Don't allow toggling when reusing an auto-detected node it can't control.
    const mode = state.registry?.ipfs?.mode;
    if (mode === 'reused') return;

    // A user-configured external gateway is controllable and does not need the
    // native addon.
    if (!ipfsBinaryAvailable && mode !== 'external') return;

    // Flip to the opposite of whatever the switch currently shows (the pending
    // target if one is set, otherwise live status), so each click reverses the
    // last one even mid-transition.
    const desired = !isIpfsEffectivelyRunning();
    state.ipfsDesiredRunning = desired;

    // Update the switch and stats panel instantly; the reconcile loop drives the
    // backend toward this target in the background and coalesces rapid clicks.
    ipfsToggleSwitch?.classList.toggle('running', desired);
    if (desired) {
      startIpfsInfoPolling();
    } else {
      stopIpfsInfoPolling();
    }
    pushDebug(`User toggled IPFS ${desired ? 'On' : 'Off'}`);
    reconcileIpfsToggle();
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
