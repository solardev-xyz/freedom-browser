/**
 * Publish Setup Module
 *
 * Guided checklist for enabling Swarm publishing: fund xDAI, switch to
 * light mode, chequebook deployment, acquire xBZZ, purchase stamps.
 */

import { state } from '../state.js';
import { walletState, registerScreenHider } from './wallet-state.js';
import { isChequebookDeployed } from './wallet-utils.js';
import { openSend } from './send.js';
import { normalizeSwarmMode } from './swarm-readiness.js';
import { fetchBeeJson } from './bee-api.js';

const GNOSIS_CHAIN_ID = 100;
const XDAI_TOKEN_KEY = '100:native';
const XBZZ_TOKEN_KEY = '100:0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da';
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
    const steps = await evaluateSteps();
    renderSteps(steps);
  } catch (err) {
    console.error('[PublishSetup] Failed to refresh checklist:', err);
  }
}

async function evaluateSteps() {
  // Tier 1 queries (always available when Bee is running)
  let nodeResult, addressesResult, chequebookAddrResult;
  try {
    [nodeResult, addressesResult, chequebookAddrResult] = await Promise.all([
      fetchBeeJson('/node'),
      fetchBeeJson('/addresses'),
      fetchBeeJson('/chequebook/address'),
    ]);
  } catch {
    // Bee API unreachable — return empty state, all steps pending
    return {
      hasXdai: false,
      xdaiBalance: 0n,
      beeWalletAddress: cachedBeeWalletAddress,
      isLightOrFull: false,
      chequebookDeployed: false,
      hasXbzz: false,
      hasUsableStamps: false,
      tier2Available: false,
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

  // Balance check via existing wallet infrastructure (main process IPC)
  let hasXdai = false;
  let hasXbzzFromWallet = false;
  const beeAddr = cachedBeeWalletAddress || walletState.fullAddresses.swarm;
  if (beeAddr && window.wallet?.getBalances) {
    try {
      const result = await window.wallet.getBalances(beeAddr);
      if (result?.success && result.balances) {
        const xdaiRaw = parseFloat(result.balances[XDAI_TOKEN_KEY]?.formatted || '0');
        hasXdai = xdaiRaw > 0;
        const xbzzRaw = parseFloat(result.balances[XBZZ_TOKEN_KEY]?.formatted || '0');
        hasXbzzFromWallet = xbzzRaw > 0;
      }
    } catch {
      // Balance fetch failed — leave as false
    }
  }

  // Tier 2 + sync progress queries (run in parallel when available)
  let hasXbzz = hasXbzzFromWallet;
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
    hasXdai,
    beeWalletAddress: cachedBeeWalletAddress,
    isLightOrFull,
    chequebookDeployed,
    stampsSynced,
    hasXbzz,
    hasUsableStamps,
    syncProgress,
  };
}

function renderSteps(steps) {
  // Step 1: Fund xDAI
  const step1Complete = steps.hasXdai || steps.chequebookDeployed;
  const step1Status = step1Complete ? 'complete' : 'active';

  setStepStatus(stepFundXdai, step1Status);
  toggleEl(stepFundXdaiBtn, step1Status === 'active');

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
  const recipient = cachedBeeWalletAddress || walletState.fullAddresses.swarm;
  if (!recipient) {
    alert('Bee wallet address is not available yet.');
    return;
  }

  const tokenKey = XDAI_TOKEN_KEY;
  const mainWalletBalance = walletState.currentBalances[tokenKey];
  const available = parseFloat(mainWalletBalance?.formatted || '0');

  if (available <= 0) {
    alert('Your main wallet has no xDAI on Gnosis Chain to send to the Bee node yet.');
    return;
  }

  closePublishSetup();
  openSend({
    recipient,
    chainId: GNOSIS_CHAIN_ID,
    tokenKey,
    tokenSymbol: 'xDAI',
  });
}

async function handleSwitchToLightMode() {
  try {
    const settings = await window.electronAPI.getSettings();
    const nextSettings = { ...settings, beeNodeMode: 'light' };
    const success = await window.electronAPI.saveSettings(nextSettings);

    if (!success) {
      throw new Error('Failed to save settings');
    }

    window.dispatchEvent(new CustomEvent('settings:updated', { detail: nextSettings }));

    if (state.currentBeeStatus === 'running' || state.currentBeeStatus === 'starting') {
      await window.bee?.stop?.();
      await window.bee?.start?.();
    }
  } catch (err) {
    console.error('[PublishSetup] Failed to switch to light mode:', err);
    alert(err.message || 'Failed to switch to light mode');
  }
}

function handleFundXbzz() {
  const recipient = cachedBeeWalletAddress || walletState.fullAddresses.swarm;
  if (!recipient) {
    alert('Bee wallet address is not available yet.');
    return;
  }

  closePublishSetup();
  openSend({
    recipient,
    chainId: GNOSIS_CHAIN_ID,
    tokenKey: XBZZ_TOKEN_KEY,
    tokenSymbol: 'xBZZ',
  });
}

function handleBuyStamps() {
  alert('Buy Postage Stamps — coming soon.');
}

// ============================================
// Helpers
// ============================================

async function clearBeeWalletCache() {
  const addr = cachedBeeWalletAddress || walletState.fullAddresses.swarm;
  if (addr && window.wallet?.clearBalanceCache) {
    try {
      await window.wallet.clearBalanceCache(addr);
    } catch {
      // Non-critical
    }
  }
}
