/**
 * dApp Message Signing Module
 *
 * Message signing approval screen for dApp-initiated signing requests.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { open as openSidebarPanel } from '../sidebar.js';

// DOM references
let dappSignScreen;
let dappSignBackBtn;
let dappSignSite;
let dappSignMessage;
let dappSignTypedDataSection;
let dappSignTypedData;
let dappSignUnlock;
let dappSignTouchIdBtn;
let dappSignPasswordLink;
let dappSignPasswordSection;
let dappSignPasswordInput;
let dappSignPasswordSubmit;
let dappSignUnlockError;
let dappSignError;
let dappSignRejectBtn;
let dappSignApproveBtn;

// Local state
let dappSignPending = null;

export function initDappSign() {
  dappSignScreen = document.getElementById('sidebar-dapp-sign');
  dappSignBackBtn = document.getElementById('dapp-sign-back');
  dappSignSite = document.getElementById('dapp-sign-site');
  dappSignMessage = document.getElementById('dapp-sign-message');
  dappSignTypedDataSection = document.getElementById('dapp-sign-typed-data-section');
  dappSignTypedData = document.getElementById('dapp-sign-typed-data');
  dappSignUnlock = document.getElementById('dapp-sign-unlock');
  dappSignTouchIdBtn = document.getElementById('dapp-sign-touchid-btn');
  dappSignPasswordLink = document.getElementById('dapp-sign-password-link');
  dappSignPasswordSection = document.getElementById('dapp-sign-password-section');
  dappSignPasswordInput = document.getElementById('dapp-sign-password-input');
  dappSignPasswordSubmit = document.getElementById('dapp-sign-password-submit');
  dappSignUnlockError = document.getElementById('dapp-sign-unlock-error');
  dappSignError = document.getElementById('dapp-sign-error');
  dappSignRejectBtn = document.getElementById('dapp-sign-reject');
  dappSignApproveBtn = document.getElementById('dapp-sign-approve');

  // Register screen hider
  registerScreenHider(() => dappSignScreen?.classList.add('hidden'));

  setupDappSignScreen();
}

function setupDappSignScreen() {
  if (dappSignBackBtn) {
    dappSignBackBtn.addEventListener('click', () => {
      rejectDappSign();
      closeDappSign();
    });
  }

  if (dappSignRejectBtn) {
    dappSignRejectBtn.addEventListener('click', () => {
      rejectDappSign();
      closeDappSign();
    });
  }

  if (dappSignApproveBtn) {
    dappSignApproveBtn.addEventListener('click', approveDappSign);
  }

  if (dappSignTouchIdBtn) {
    dappSignTouchIdBtn.addEventListener('click', handleDappSignTouchIdUnlock);
  }

  if (dappSignPasswordSubmit) {
    dappSignPasswordSubmit.addEventListener('click', handleDappSignPasswordUnlock);
  }

  if (dappSignPasswordInput) {
    dappSignPasswordInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleDappSignPasswordUnlock();
    });
  }

  if (dappSignPasswordLink) {
    dappSignPasswordLink.addEventListener('click', () => {
      dappSignPasswordLink.classList.add('hidden');
      dappSignPasswordSection?.classList.remove('hidden');
      dappSignPasswordInput?.focus();
    });
  }
}

/**
 * Show dApp signing screen
 */
export async function showDappSignApproval(webview, permissionKey, method, params) {
  return new Promise(async (resolve, reject) => {
    const permission = await window.dappPermissions.getPermission(permissionKey);
    if (!permission) {
      reject({ code: 4100, message: 'Unauthorized - not connected' });
      return;
    }

    dappSignPending = { permissionKey, walletIndex: permission.walletIndex, method, params, resolve, reject, webview };

    if (dappSignSite) {
      dappSignSite.textContent = permissionKey;
    }

    if (method === 'personal_sign') {
      displayPersonalSignMessage(params);
    } else if (method === 'eth_signTypedData_v4') {
      displayTypedDataMessage(params);
    }

    await checkDappSignUnlockStatus();

    hideAllSubscreens();
    walletState.identityView?.classList.add('hidden');
    dappSignScreen?.classList.remove('hidden');

    openSidebarPanel();
  });
}

function displayPersonalSignMessage(params) {
  const message = params[0];

  if (dappSignMessage) {
    dappSignMessage.parentElement?.classList.remove('hidden');
  }
  dappSignTypedDataSection?.classList.add('hidden');

  if (dappSignMessage) {
    let displayMessage = message;
    if (message.startsWith('0x')) {
      try {
        displayMessage = hexToUtf8(message.slice(2));
      } catch {
        displayMessage = message;
      }
    }
    dappSignMessage.textContent = displayMessage;
  }
}

function hexToUtf8(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

function displayTypedDataMessage(params) {
  const typedDataStr = params[1];

  if (dappSignMessage) {
    dappSignMessage.parentElement?.classList.add('hidden');
  }
  dappSignTypedDataSection?.classList.remove('hidden');

  if (dappSignTypedData) {
    try {
      const typedData = typeof typedDataStr === 'string' ? JSON.parse(typedDataStr) : typedDataStr;
      const formatted = formatTypedDataForDisplay(typedData);
      dappSignTypedData.textContent = formatted;
    } catch (err) {
      dappSignTypedData.textContent = typedDataStr;
    }
  }
}

function formatTypedDataForDisplay(typedData) {
  const lines = [];

  if (typedData.domain) {
    lines.push('Domain:');
    if (typedData.domain.name) lines.push(`  Name: ${typedData.domain.name}`);
    if (typedData.domain.version) lines.push(`  Version: ${typedData.domain.version}`);
    if (typedData.domain.chainId) lines.push(`  Chain ID: ${typedData.domain.chainId}`);
    if (typedData.domain.verifyingContract) {
      lines.push(`  Contract: ${typedData.domain.verifyingContract.slice(0, 10)}...`);
    }
    lines.push('');
  }

  if (typedData.message) {
    lines.push('Message:');
    for (const [key, value] of Object.entries(typedData.message)) {
      const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
      const truncated = displayValue.length > 50 ? displayValue.slice(0, 50) + '...' : displayValue;
      lines.push(`  ${key}: ${truncated}`);
    }
  }

  return lines.join('\n');
}

async function checkDappSignUnlockStatus() {
  try {
    const status = await window.identity.getStatus();

    if (status.isUnlocked) {
      dappSignUnlock?.classList.add('hidden');
      if (dappSignApproveBtn) dappSignApproveBtn.disabled = false;
      return;
    }

    dappSignUnlock?.classList.remove('hidden');
    if (dappSignApproveBtn) dappSignApproveBtn.disabled = true;

    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();
    const hasTouchId = canUseTouchId && touchIdEnabled;

    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    if (dappSignTouchIdBtn) {
      dappSignTouchIdBtn.classList.toggle('hidden', !hasTouchId);
    }

    if (hasTouchId && userKnowsPassword) {
      dappSignPasswordLink?.classList.remove('hidden');
      dappSignPasswordSection?.classList.add('hidden');
    } else if (userKnowsPassword) {
      dappSignPasswordLink?.classList.add('hidden');
      dappSignPasswordSection?.classList.remove('hidden');
    } else {
      dappSignPasswordLink?.classList.add('hidden');
      dappSignPasswordSection?.classList.add('hidden');
    }
  } catch (err) {
    console.error('[WalletUI] Failed to check vault status:', err);
    dappSignUnlock?.classList.remove('hidden');
    dappSignTouchIdBtn?.classList.add('hidden');
    dappSignPasswordLink?.classList.add('hidden');
    dappSignPasswordSection?.classList.remove('hidden');
  }
}

async function handleDappSignTouchIdUnlock() {
  try {
    const result = await window.quickUnlock.unlock();
    if (!result.success) {
      throw new Error(result.error || 'Touch ID failed');
    }

    const unlockResult = await window.identity.unlock(result.password);
    if (!unlockResult.success) {
      throw new Error(unlockResult.error || 'Failed to unlock vault');
    }

    dappSignUnlock?.classList.add('hidden');
    if (dappSignApproveBtn) dappSignApproveBtn.disabled = false;
    hideDappSignError();
  } catch (err) {
    console.error('[WalletUI] dApp sign Touch ID unlock failed:', err);
    if (err.message !== 'Touch ID cancelled') {
      showDappSignError(err.message || 'Touch ID failed');
    }
  }
}

async function handleDappSignPasswordUnlock() {
  const password = dappSignPasswordInput?.value;
  if (!password) return;

  try {
    const result = await window.identity.unlock(password);
    if (!result.success) {
      throw new Error(result.error || 'Incorrect password');
    }

    dappSignUnlock?.classList.add('hidden');
    if (dappSignApproveBtn) dappSignApproveBtn.disabled = false;
    if (dappSignPasswordInput) dappSignPasswordInput.value = '';
    hideDappSignError();
  } catch (err) {
    console.error('[WalletUI] dApp sign password unlock failed:', err);
    showDappSignError(err.message || 'Failed to unlock');
  }
}

async function approveDappSign() {
  if (!dappSignPending) return;

  const { walletIndex, method, params, resolve } = dappSignPending;

  try {
    if (dappSignApproveBtn) {
      dappSignApproveBtn.disabled = true;
      dappSignApproveBtn.textContent = 'Signing...';
    }

    let signature;

    if (method === 'personal_sign') {
      const result = await window.wallet.signMessage(params[0], walletIndex);
      if (!result.success) {
        throw new Error(result.error || 'Signing failed');
      }
      signature = result.signature;
    } else if (method === 'eth_signTypedData_v4') {
      const result = await window.wallet.signTypedData(params[1], walletIndex);
      if (!result.success) {
        throw new Error(result.error || 'Signing failed');
      }
      signature = result.signature;
    } else {
      throw new Error(`Unsupported signing method: ${method}`);
    }

    console.log('[WalletUI] dApp message signed');
    resolve(signature);
    closeDappSign();
  } catch (err) {
    console.error('[WalletUI] dApp signing failed:', err);
    showDappSignError(err.message || 'Signing failed');
    if (dappSignApproveBtn) {
      dappSignApproveBtn.disabled = false;
      dappSignApproveBtn.textContent = 'Sign';
    }
  }
}

function rejectDappSign() {
  if (dappSignPending?.reject) {
    dappSignPending.reject({ code: 4001, message: 'User rejected the request' });
  }
}

function closeDappSign() {
  dappSignScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  dappSignPending = null;
  hideDappSignError();
  if (dappSignPasswordInput) dappSignPasswordInput.value = '';
  if (dappSignApproveBtn) {
    dappSignApproveBtn.disabled = false;
    dappSignApproveBtn.textContent = 'Sign';
  }
}

function showDappSignError(message) {
  if (dappSignError) {
    dappSignError.textContent = message;
    dappSignError.classList.remove('hidden');
  }
}

function hideDappSignError() {
  dappSignError?.classList.add('hidden');
}
