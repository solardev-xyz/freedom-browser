/**
 * Standalone Vault Unlock Screen
 *
 * A minimal unlock prompt shown when an auto-approved action needs the
 * vault unlocked but the user has already granted the underlying permission.
 * Unlike the full approval screens, this shows only the unlock UI — no
 * identity mode choice, no action details, no auto-approve checkbox.
 *
 * Returns a promise that resolves on successful unlock or rejects on cancel.
 *
 * From freedom-core design 0011 PRQ-5a, a page's request under a site's rule
 * that finds the vault locked is main's prompt (`vault.unlock`, through
 * page-prompts.js): this screen renders it for the site main attested, and
 * answers the handle once the vault is unlocked, or with a rejection when
 * the user cancels. The unlock itself stays here until APS-2.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { isSignatureInFlight, signatureInFlightError } from './signature-flight.js';
import { open as openSidebarPanel } from '../sidebar.js';
import { registerPagePromptRenderer, pagePromptDisplaced } from '../page-prompt-renderers.js';

let screen;
let siteLabel;
let backBtn;
let cancelBtn;
let touchIdBtn;
let passwordLink;
let passwordSection;
let passwordInput;
let passwordSubmit;
let errorEl;

let pending = null; // { resolve, reject }
// Main's prompt this screen shows, `{ handle, deciding }`, or null.
let pagePending = null;
// While the screen paints a page prompt, the hider it runs is its own.
let presentingPagePrompt = false;

export function initVaultUnlock() {
  screen = document.getElementById('sidebar-vault-unlock');
  siteLabel = document.getElementById('vault-unlock-site');
  backBtn = document.getElementById('vault-unlock-back');
  cancelBtn = document.getElementById('vault-unlock-cancel');
  touchIdBtn = document.getElementById('vault-unlock-touchid-btn');
  passwordLink = document.getElementById('vault-unlock-password-link');
  passwordSection = document.getElementById('vault-unlock-password-section');
  passwordInput = document.getElementById('vault-unlock-password-input');
  passwordSubmit = document.getElementById('vault-unlock-password-submit');
  errorEl = document.getElementById('vault-unlock-error');

  registerScreenHider(() => {
    const wasVisible = screen && !screen.classList.contains('hidden');
    screen?.classList.add('hidden');
    if (wasVisible && pending) {
      pending.reject({ code: 4001, message: 'User dismissed unlock prompt' });
      pending = null;
    }
    // A page prompt another screen hides stays main's shown prompt: it is
    // told, so it can show again once that screen is done.
    if (!presentingPagePrompt && pagePending && !pagePending.deciding) {
      const { handle } = pagePending;
      pagePending = null;
      walletState.identityView?.classList.remove('hidden');
      pagePromptDisplaced(handle);
    }
  });
  registerPagePromptRenderer('vault.unlock', {
    show: showPageVaultUnlock,
    close: closePageVaultUnlock,
    isShowing: shownPageVaultUnlock,
  });

  const dismiss = () => {
    if (pagePending) {
      decidePageUnlock(false);
      return;
    }
    if (pending) {
      pending.reject({ code: 4001, message: 'User cancelled unlock' });
      pending = null;
    }
    close();
  };

  backBtn?.addEventListener('click', dismiss);
  cancelBtn?.addEventListener('click', dismiss);
  touchIdBtn?.addEventListener('click', handleTouchIdUnlock);
  passwordSubmit?.addEventListener('click', handlePasswordUnlock);
  passwordInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handlePasswordUnlock();
  });
  passwordLink?.addEventListener('click', () => {
    passwordSection?.classList.remove('hidden');
    passwordLink?.classList.add('hidden');
    passwordInput?.focus();
  });
}

/**
 * Show the vault unlock screen.
 * @param {string} permissionKey - Origin requesting the unlock (shown to user)
 * @returns {Promise<void>} Resolves when vault is unlocked, rejects on cancel
 */
export function showVaultUnlock(permissionKey) {
  return new Promise((resolve, reject) => {
    // A live device confirmation owns the sidebar — an auto-approved
    // action's unlock prompt must not paint over it (see
    // signature-flight.js). The caller retries once the device is done.
    if (isSignatureInFlight()) {
      reject(signatureInFlightError());
      return;
    }

    if (pending) {
      pending.reject({ code: 4001, message: 'Superseded by new unlock request' });
    }
    pending = { resolve, reject };

    if (siteLabel) siteLabel.textContent = permissionKey || 'Unknown';

    hideError();
    if (passwordInput) passwordInput.value = '';

    hideAllSubscreens();
    walletState.identityView?.classList.add('hidden');
    screen?.classList.remove('hidden');

    openSidebarPanel();

    checkUnlockMethods();
  });
}

/**
 * Render main's unlock prompt (`page:prompt`, kind `vault.unlock`) for the
 * site main attested. The caller shows it only while nothing else holds the
 * sidebar (`page-prompts.js`).
 */
export function showPageVaultUnlock(prompt) {
  // An unlock on the chrome's own path gives way, as to a newer request.
  if (pending) {
    pending.reject({ code: 4001, message: 'Superseded by new unlock request' });
    pending = null;
  }
  pagePending = { handle: prompt.handle, deciding: false };
  if (siteLabel) siteLabel.textContent = prompt?.site?.label || prompt?.site?.key || 'Unknown';
  hideError();
  if (passwordInput) passwordInput.value = '';
  presentingPagePrompt = true;
  try {
    hideAllSubscreens();
  } finally {
    presentingPagePrompt = false;
  }
  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');
  openSidebarPanel();
  checkUnlockMethods();
}

/** Take down main's prompt `handle` (hidden, closed, or refused). */
export function closePageVaultUnlock(handle) {
  if (!pagePending || pagePending.handle !== handle) return false;
  pagePending = null;
  close();
  return true;
}

/** The page prompt the screen shows, or null. */
export function shownPageVaultUnlock() {
  return pagePending && screen && !screen.classList.contains('hidden') ? pagePending.handle : null;
}

// Answer main's prompt: unlocked, or cancelled. Main checks the vault
// itself before anything is signed.
async function decidePageUnlock(approve) {
  const request = pagePending;
  if (!request || request.deciding) return;
  request.deciding = true;
  if (pagePending === request) pagePending = null;
  close();
  try {
    await window.pagePrompts?.decide?.(request.handle, approve, {});
  } catch (err) {
    console.error('[VaultUnlock] The decision did not reach main:', err);
  }
}

async function checkUnlockMethods() {
  try {
    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();
    const hasTouchId = canUseTouchId && touchIdEnabled;

    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    touchIdBtn?.classList.toggle('hidden', !hasTouchId);

    if (hasTouchId && userKnowsPassword) {
      passwordLink?.classList.remove('hidden');
      passwordSection?.classList.add('hidden');
    } else if (userKnowsPassword) {
      passwordLink?.classList.add('hidden');
      passwordSection?.classList.remove('hidden');
    } else {
      // No Touch ID and user doesn't know password — show password field
      // as a fallback (they may remember or reset)
      passwordLink?.classList.add('hidden');
      passwordSection?.classList.remove('hidden');
    }
  } catch (err) {
    console.error('[VaultUnlock] Failed to check unlock methods:', err);
    touchIdBtn?.classList.add('hidden');
    passwordLink?.classList.add('hidden');
    passwordSection?.classList.remove('hidden');
  }
}

async function handleTouchIdUnlock() {
  try {
    const result = await window.quickUnlock.unlock();
    if (!result.success) {
      throw new Error(result.error || 'Touch ID failed');
    }

    onUnlockSuccess();
  } catch (err) {
    console.error('[VaultUnlock] Touch ID unlock failed:', err);
    if (err.message !== 'Touch ID cancelled') {
      showError(err.message || 'Touch ID failed');
    }
  }
}

async function handlePasswordUnlock() {
  const password = passwordInput?.value;
  if (!password) return;

  try {
    const result = await window.identity.unlock(password);
    if (!result.success) {
      throw new Error(result.error || 'Incorrect password');
    }

    onUnlockSuccess();
  } catch (err) {
    console.error('[VaultUnlock] Password unlock failed:', err);
    showError(err.message || 'Failed to unlock');
  }
}

function onUnlockSuccess() {
  if (pagePending) {
    decidePageUnlock(true);
    return;
  }
  if (!pending) return;
  const { resolve } = pending;
  pending = null;
  close();
  resolve();
}

function close() {
  screen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  if (passwordInput) passwordInput.value = '';
  hideError();
}

function showError(msg) {
  if (errorEl) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  }
}

function hideError() {
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }
}
