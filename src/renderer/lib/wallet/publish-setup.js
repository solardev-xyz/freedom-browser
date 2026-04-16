/**
 * Publish Setup Module
 *
 * Guided checklist for enabling Swarm publishing: fund xDAI, switch to
 * light mode, chequebook deployment, acquire xBZZ, purchase stamps.
 */

import { state } from '../state.js';
import { walletState, registerScreenHider } from './wallet-state.js';
import { isChequebookDeployed } from './wallet-utils.js';
import { normalizeSwarmMode } from './swarm-readiness.js';
import { fetchBeeJson } from './bee-api.js';
import { openStampManager } from './stamp-manager.js';
import { topUpXdai, topUpXbzz, GNOSIS_CHAIN_ID, XDAI_TOKEN_KEY, XBZZ_TOKEN_KEY } from './funding-actions.js';

const POLL_MS = 5000;

// DOM references
let publishSetupScreen;
let publishSetupBackBtn;
let stepFundXdai;
let stepFundXdaiBtn;
let stepFundXdaiMeta;
let stepLightMode;
let stepLightModeBtn;
let stepChequebook;
let stepChequebookWaiting;
let stepFundXbzz;
let stepFundXbzzBtn;
let stepStamps;
let stepStampsBtn;

let pollInterval = null;
let cachedBeeWalletAddress = null;
let lastEvaluation = null;

/**
 * Return the Bee wallet address, preferring the canonical identity-derived
 * address over the cached Bee API value. The cache is only a fallback for
 * when identity data hasn't loaded yet.
 */
function getBeeWalletAddress() {
  return walletState.fullAddresses.swarm || cachedBeeWalletAddress;
}

export function initPublishSetup() {
  publishSetupScreen = document.getElementById('sidebar-publish-setup');
  publishSetupBackBtn = document.getElementById('publish-setup-back');

  stepFundXdai = document.getElementById('publish-step-fund-xdai');
  stepFundXdaiBtn = document.getElementById('publish-step-fund-xdai-btn');
  stepFundXdaiMeta = document.getElementById('publish-step-fund-xdai-meta');
  stepLightMode = document.getElementById('publish-step-light-mode');
  stepLightModeBtn = document.getElementById('publish-step-light-mode-btn');
  stepChequebook = document.getElementById('publish-step-chequebook');
  stepChequebookWaiting = document.getElementById('publish-step-chequebook-waiting');
  stepFundXbzz = document.getElementById('publish-step-fund-xbzz');
  stepFundXbzzBtn = document.getElementById('publish-step-fund-xbzz-btn');
  stepStamps = document.getElementById('publish-step-stamps');
  stepStampsBtn = document.getElementById('publish-step-stamps-btn');

  registerScreenHider(() => closePublishSetup());

  publishSetupBackBtn?.addEventListener('click', () => closePublishSetup());

  window.addEventListener('wallet:tx-success', () => {
    if (!publishSetupScreen?.classList.contains('hidden')) {
      clearBeeWalletCache();
      setTimeout(() => refreshChecklist(), 3000);
    }
  });

  stepFundXdaiBtn?.addEventListener('click', () => handleFundXdai());
  stepLightModeBtn?.addEventListener('click', () => handleSwitchToLightMode());
  stepFundXbzzBtn?.addEventListener('click', () => handleFundXbzz());
  stepStampsBtn?.addEventListener('click', () => handleBuyStamps());
}

export function openPublishSetup() {
  walletState.identityView?.classList.add('hidden');
  publishSetupScreen?.classList.remove('hidden');

  clearBeeWalletCache();
  refreshChecklist();
  startPolling();
}

export function closePublishSetup() {
  stopPolling();
  cachedBeeWalletAddress = null;
  lastEvaluation = null;
  publishSetupScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
}

function startPolling() {
  stopPolling();
  pollInterval = setInterval(() => refreshChecklist(), POLL_MS);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

async function refreshChecklist() {
  try {
    lastEvaluation = await evaluateSteps();
    renderSteps(lastEvaluation);
  } catch (err) {
    console.error('[PublishSetup] Failed to refresh checklist:', err);
  }
}

async function evaluateSteps() {
  const beeStatus = state.currentBeeStatus;

  // If Bee isn't running, return a node-level blocked state
  if (beeStatus !== 'running') {
    return {
      nodeState: beeStatus === 'starting' ? 'starting' : beeStatus === 'stopping' ? 'stopping' : beeStatus === 'error' ? 'error' : 'stopped',
      hasXdai: false,
      beeWalletAddress: getBeeWalletAddress(),
      isLightOrFull: false,
      chequebookDeployed: false,
      stampsSynced: false,
      hasXbzz: false,
      hasUsableStamps: false,
      syncProgress: null,
    };
  }

  // Tier 1 queries (always available when Bee is running)
  let nodeResult, addressesResult, chequebookAddrResult;
  try {
    [nodeResult, addressesResult, chequebookAddrResult] = await Promise.all([
      fetchBeeJson('/node'),
      fetchBeeJson('/addresses'),
      fetchBeeJson('/chequebook/address'),
    ]);
  } catch {
    return {
      nodeState: 'unreachable',
      hasXdai: false,
      beeWalletAddress: getBeeWalletAddress(),
      isLightOrFull: false,
      chequebookDeployed: false,
      stampsSynced: false,
      hasXbzz: false,
      hasUsableStamps: false,
      syncProgress: null,
    };
  }

  const beeMode = normalizeSwarmMode(nodeResult.data?.beeMode);
  const isLightOrFull = beeMode === 'light' || beeMode === 'full';
  const beeWalletAddress = addressesResult.data?.ethereum || null;

  if (beeWalletAddress) {
    cachedBeeWalletAddress = beeWalletAddress;
  }

  const chequebookAddr = chequebookAddrResult.data?.chequebookAddress;
  const chequebookDeployed = isChequebookDeployed(chequebookAddr);

  // Balance checks via existing wallet infrastructure (main process IPC)
  let hasXdai = false;
  let beeHasXbzz = false;
  let mainWalletHasXbzz = false;
  const beeAddr = getBeeWalletAddress();
  const mainAddr = walletState.fullAddresses.wallet;

  // Bee wallet balances
  if (beeAddr && window.wallet?.getBalances) {
    try {
      const result = await window.wallet.getBalances(beeAddr);
      if (result?.success && result.balances) {
        const xdaiRaw = parseFloat(result.balances[XDAI_TOKEN_KEY]?.formatted || '0');
        hasXdai = xdaiRaw > 0;
        const xbzzRaw = parseFloat(result.balances[XBZZ_TOKEN_KEY]?.formatted || '0');
        beeHasXbzz = xbzzRaw > 0;
      }
    } catch {
      // Balance fetch failed — leave as false
    }
  }

  // Main wallet xBZZ balance (to know if user already swapped).
  // Read from walletState.currentBalances — already kept fresh by balance-display polling.
  if (!beeHasXbzz && mainAddr && mainAddr.toLowerCase() !== beeAddr?.toLowerCase()) {
    const xbzzRaw = parseFloat(walletState.currentBalances[XBZZ_TOKEN_KEY]?.formatted || '0');
    mainWalletHasXbzz = xbzzRaw > 0;
  }

  // Tier 2 + sync progress queries (run in parallel when available)
  let hasXbzz = beeHasXbzz;
  let hasUsableStamps = false;
  let stampsSynced = false;
  let syncProgress = null;

  if (isLightOrFull) {
    const tier2Promises = [fetchBeeJson('/status')];
    if (chequebookDeployed) {
      tier2Promises.push(fetchBeeJson('/wallet'), fetchBeeJson('/stamps'));
    }

    let statusResult, walletResult, stampsResult;
    try {
      const results = await Promise.all(tier2Promises);
      statusResult = results[0];
      walletResult = chequebookDeployed ? results[1] : { ok: false, data: null };
      stampsResult = chequebookDeployed ? results[2] : { ok: false, data: null };
    } catch {
      statusResult = { ok: false, data: null };
      walletResult = { ok: false, data: null };
      stampsResult = { ok: false, data: null };
    }

    if (walletResult.ok && walletResult.data) {
      const bzz = walletResult.data.bzzBalance;
      if (typeof bzz === 'string' && bzz !== '0' && bzz.length > 0) {
        hasXbzz = true;
      }
    }

    if (stampsResult.ok && Array.isArray(stampsResult.data?.stamps)) {
      stampsSynced = true;
      hasUsableStamps = stampsResult.data.stamps.some((s) => s?.usable === true);
    }

    if (statusResult.ok && statusResult.data?.lastSyncedBlock) {
      const lastSynced = statusResult.data.lastSyncedBlock;
      let chainHead = null;
      try {
        if (window.wallet?.testProvider) {
          const providerResult = await window.wallet.testProvider(GNOSIS_CHAIN_ID);
          if (providerResult?.success) {
            chainHead = providerResult.blockNumber;
          }
        }
      } catch {
        // Non-critical
      }
      syncProgress = { lastSynced, chainHead };
    }
  }

  return {
    nodeState: 'running',
    hasXdai,
    beeWalletAddress: getBeeWalletAddress(),
    isLightOrFull,
    chequebookDeployed,
    stampsSynced,
    hasXbzz,
    mainWalletHasXbzz,
    hasUsableStamps,
    syncProgress,
  };
}

function renderSteps(steps) {
  // If Bee isn't running, show all steps as blocked
  if (steps.nodeState !== 'running') {
    const blockedDetail = {
      stopped: 'Start the Swarm node to continue.',
      starting: 'Swarm node is starting\u2026',
      stopping: 'Swarm node is stopping\u2026',
      error: 'Swarm node encountered an error.',
      unreachable: 'Cannot reach the Swarm node.',
    }[steps.nodeState] || 'Swarm node is not available.';

    setStepStatus(stepFundXdai, 'pending');
    setStepStatus(stepLightMode, 'pending');
    setStepStatus(stepChequebook, 'pending');
    setStepStatus(stepFundXbzz, 'pending');
    setStepStatus(stepStamps, 'pending');
    toggleEl(stepFundXdaiBtn, false);
    toggleEl(stepLightModeBtn, false);
    toggleEl(stepChequebookWaiting, false);
    toggleEl(stepFundXbzzBtn, false);
    toggleEl(stepStampsBtn, false);

    if (stepFundXdaiMeta) {
      stepFundXdaiMeta.textContent = blockedDetail;
      stepFundXdaiMeta.classList.remove('hidden');
    }
    return;
  }

  // Step 1: Fund xDAI
  const step1Complete = steps.hasXdai || steps.chequebookDeployed;
  const step1Status = step1Complete ? 'complete' : 'active';

  setStepStatus(stepFundXdai, step1Status);
  toggleEl(stepFundXdaiBtn, step1Status === 'active');

  if (stepFundXdaiBtn && step1Status === 'active') {
    const mainHasXdai = parseFloat(walletState.currentBalances[XDAI_TOKEN_KEY]?.formatted || '0') > 0;
    stepFundXdaiBtn.textContent = mainHasXdai ? 'Send xDAI' : 'Get xDAI';
  }

  if (stepFundXdaiMeta) {
    if (steps.beeWalletAddress) {
      stepFundXdaiMeta.textContent = steps.beeWalletAddress;
      stepFundXdaiMeta.classList.remove('hidden');
    } else {
      stepFundXdaiMeta.classList.add('hidden');
    }
  }

  // Step 2: Switch to light mode
  const step2Complete = steps.isLightOrFull;
  const step2Active = step1Complete && !step2Complete;
  const step2Status = step2Complete ? 'complete' : step2Active ? 'active' : 'pending';

  setStepStatus(stepLightMode, step2Status);
  toggleEl(stepLightModeBtn, step2Status === 'active');

  // Step 3: Chequebook deployment + postage sync
  const step3Complete = steps.chequebookDeployed && steps.stampsSynced;
  const step3Waiting = step2Complete && !step3Complete;
  const step3Status = step3Complete ? 'complete' : step3Waiting ? 'waiting' : 'pending';

  setStepStatus(stepChequebook, step3Status);

  if (stepChequebookWaiting) {
    if (step3Status === 'waiting') {
      stepChequebookWaiting.classList.remove('hidden');
      if (steps.chequebookDeployed && !steps.stampsSynced && steps.syncProgress) {
        const { lastSynced, chainHead } = steps.syncProgress;
        if (chainHead && lastSynced) {
          const pct = Math.min(99, Math.round((lastSynced / chainHead) * 100));
          stepChequebookWaiting.textContent = `Syncing postage data\u2026 ${pct}% (block ${lastSynced.toLocaleString()} / ${chainHead.toLocaleString()})`;
        } else {
          stepChequebookWaiting.textContent = `Syncing postage data\u2026 block ${(lastSynced || 0).toLocaleString()}`;
        }
      } else if (!steps.chequebookDeployed) {
        stepChequebookWaiting.textContent = 'Deploying chequebook contract\u2026';
      } else {
        stepChequebookWaiting.textContent = 'Syncing postage data\u2026';
      }
    } else {
      stepChequebookWaiting.classList.add('hidden');
    }
  }

  // Step 4: Acquire xBZZ
  const step4Complete = steps.hasXbzz;
  const step4Active = step3Complete && !step4Complete;
  const step4Status = step4Complete ? 'complete' : step4Active ? 'active' : 'pending';

  setStepStatus(stepFundXbzz, step4Status);
  toggleEl(stepFundXbzzBtn, step4Status === 'active');

  if (stepFundXbzzBtn && step4Status === 'active') {
    stepFundXbzzBtn.textContent = steps.mainWalletHasXbzz
      ? 'Send xBZZ to Node'
      : 'Swap xDAI \u2192 xBZZ';
  }

  // Step 5: Purchase stamps
  const step5Complete = steps.hasUsableStamps;
  const step5Active = step4Complete && !step5Complete;
  const step5Status = step5Complete ? 'complete' : step5Active ? 'active' : 'pending';

  setStepStatus(stepStamps, step5Status);
  toggleEl(stepStampsBtn, step5Status === 'active');
}

function setStepStatus(el, status) {
  if (el) {
    el.dataset.status = status;
  }
}

function toggleEl(el, visible) {
  if (el) {
    el.classList.toggle('hidden', !visible);
  }
}

// ============================================
// Step actions
// ============================================

function handleFundXdai() {
  closePublishSetup();
  topUpXdai(getBeeWalletAddress());
}

async function handleSwitchToLightMode() {
  try {
    const settings = await window.electronAPI?.getSettings?.();
    const nextSettings = { ...settings, beeNodeMode: 'light' };
    const success = await window.electronAPI?.saveSettings?.(nextSettings);

    if (!success) {
      throw new Error('Failed to save settings');
    }
  } catch (err) {
    console.error('[PublishSetup] Failed to switch to light mode:', err);
    alert(err.message || 'Failed to switch to light mode');
  }
}

function handleFundXbzz() {
  closePublishSetup();
  topUpXbzz(getBeeWalletAddress());
}

function handleBuyStamps() {
  closePublishSetup();
  openStampManager();
}

// ============================================
// Helpers
// ============================================

async function clearBeeWalletCache() {
  const addr = getBeeWalletAddress();
  if (addr && window.wallet?.clearBalanceCache) {
    try {
      await window.wallet.clearBalanceCache(addr);
    } catch {
      // Non-critical
    }
  }
}
