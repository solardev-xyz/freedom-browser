/**
 * dApp Message Signing Module
 *
 * Message signing approval screen for dApp-initiated signing requests.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import {
  assertNoSignatureInFlight,
  isSignatureInFlight,
  signatureInFlightError,
  beginSignatureFlight,
  endSignatureFlight,
} from './signature-flight.js';
import { open as openSidebarPanel } from '../sidebar.js';
import { executeSign } from '../dapp-provider.js';
import { bypassUnlockGateForDevice, signingButtonLabel } from './wallet-utils.js';

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
let dappSignError;
let dappSignRejectBtn;
let dappSignApproveBtn;
let dappSignAutoApproveCheckbox;

// Local state. `dappSignPending.signing` is true while the signature is
// in flight: a hardware signature is a device prompt we cannot recall, so
// there is no cancellation path once it starts — rejecting behind it
// would settle the dApp promise with 4001 while the device still signs.
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
  dappSignError = document.getElementById('dapp-sign-error');
  dappSignRejectBtn = document.getElementById('dapp-sign-reject');
  dappSignApproveBtn = document.getElementById('dapp-sign-approve');
  dappSignAutoApproveCheckbox = document.getElementById('dapp-sign-auto-approve');

  // Register screen hider
  registerScreenHider(() => dappSignScreen?.classList.add('hidden'));

  setupDappSignScreen();
}

function setupDappSignScreen() {
  if (dappSignBackBtn) {
    dappSignBackBtn.addEventListener('click', () => {
      if (dappSignPending?.signing) return;
      rejectDappSign();
      closeDappSign();
    });
  }

  if (dappSignRejectBtn) {
    dappSignRejectBtn.addEventListener('click', () => {
      if (dappSignPending?.signing) return;
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
 *
 * The sidebar is a single shared surface, and an in-flight signature owns
 * it: the device prompt it produced cannot be recalled, so a later request
 * must not repaint the screen, reset `dappSignPending` and re-enable
 * Reject/Back/Sign underneath it — the user would then be cancelling (or
 * confirming) request B while the device is still showing request A. The
 * lock is global (see signature-flight.js), so this refuses the newcomer
 * whichever surface is holding the device: a sibling dapp-sign request,
 * dapp-tx, or an x402 payment. The dApp can retry once the device is done.
 */
export async function showDappSignApproval(webview, permissionKey, method, params) {
  assertNoSignatureInFlight();

  const permission = await window.dappPermissions.getPermission(permissionKey);
  if (!permission) {
    throw Object.assign(new Error('Unauthorized - not connected'), { code: 4100 });
  }

  return new Promise((resolve, reject) => {
    // Re-checked after the awaits above: the screen must still be free at
    // the moment we take it over.
    assertNoSignatureInFlight();
    const request = { permissionKey, walletIndex: permission.walletIndex, method, params, resolve, reject, webview };
    dappSignPending = request;
    if (dappSignAutoApproveCheckbox) dappSignAutoApproveCheckbox.checked = false;
    setDappSignCancelEnabled(true);

    if (dappSignSite) {
      dappSignSite.textContent = permissionKey;
    }

    if (method === 'personal_sign') {
      displayPersonalSignMessage(params);
    } else if (method === 'eth_signTypedData_v4') {
      displayTypedDataMessage(params);
    }

    checkDappSignUnlockStatus().then(() => {
      // Another surface may have started a device signature while we were
      // checking vault status (the user could still click Pay on an x402
      // card, say). It owns the sidebar now — refuse rather than paint
      // over a live confirmation.
      if (isSignatureInFlight()) {
        if (dappSignPending === request) dappSignPending = null;
        reject(signatureInFlightError());
        return;
      }
      hideAllSubscreens();
      walletState.identityView?.classList.add('hidden');
      dappSignScreen?.classList.remove('hidden');

      openSidebarPanel();
    });
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
    } catch {
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
    if (bypassUnlockGateForDevice(dappSignPending?.walletIndex, dappSignUnlock, dappSignApproveBtn)) {
      return;
    }

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
  if (!dappSignPending || dappSignPending.signing) return;

  const request = dappSignPending;
  const { permissionKey, walletIndex, method, params, resolve } = request;
  // Snapshot the auto-approve intent now: the checkbox is shared DOM that
  // a later request can repopulate while this signature is in flight.
  const autoApprove = Boolean(dappSignAutoApproveCheckbox?.checked);

  try {
    request.signing = true;
    // Claim the sidebar for the whole flight: no other approval surface
    // may repaint over or tear down a live device confirmation.
    beginSignatureFlight(request);
    if (dappSignApproveBtn) {
      dappSignApproveBtn.disabled = true;
      dappSignApproveBtn.textContent = signingButtonLabel(walletIndex);
    }
    setDappSignCancelEnabled(false);

    const signature = await executeSign(method, params, walletIndex);

    if (autoApprove && permissionKey) {
      await window.dappPermissions.setSigningAutoApprove(permissionKey, true);
      console.log('[WalletUI] Signing auto-approve enabled for:', permissionKey);
    }

    console.log('[WalletUI] dApp message signed');
    resolve(signature);
    // Only tear down the screen if it is still showing *this* request.
    if (dappSignPending === request) {
      closeDappSign();
    }
  } catch (err) {
    console.error('[WalletUI] dApp signing failed:', err);
    showDappSignError(err.message || 'Signing failed');
    if (dappSignApproveBtn) {
      dappSignApproveBtn.disabled = false;
      dappSignApproveBtn.textContent = 'Sign';
    }
    setDappSignCancelEnabled(true);
  } finally {
    request.signing = false;
    endSignatureFlight(request);
  }
}

/**
 * Enable/disable the two ways out of the signing screen (Reject, Back).
 * Both are disabled while a signature is in flight.
 */
function setDappSignCancelEnabled(enabled) {
  if (dappSignRejectBtn) dappSignRejectBtn.disabled = !enabled;
  if (dappSignBackBtn) dappSignBackBtn.disabled = !enabled;
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
  if (dappSignAutoApproveCheckbox) dappSignAutoApproveCheckbox.checked = false;
  if (dappSignApproveBtn) {
    dappSignApproveBtn.disabled = false;
    dappSignApproveBtn.textContent = 'Sign';
  }
  setDappSignCancelEnabled(true);
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
