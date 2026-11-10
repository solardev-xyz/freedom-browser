/**
 * Sign-In with Ethereum over HTTP authentication (#1152): the sign-in card.
 *
 * Main (src/main/siwe-auth/) sees a top-level page answer `401` with a
 * `WWW-Authenticate: SIWE …` challenge for the page actually loaded and
 * sends `siwe:challenge`. This card is the Sign Message screen in a
 * sign-in mode plus the Connect screen's account picker: the user picks an
 * account, reads the exact ERC-4361 message main built for it, and signs
 * through the wallet's normal confirmation path. Main then checks the
 * signature and reloads the page with `Authorization: SIWE …`.
 *
 * Always asks: there is no "always allow". The account used last on the
 * site is preselected. The card belongs to one tab and shows only while
 * that tab is active; a challenge from a background tab waits for it.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import {
  isSignatureInFlight,
  beginSignatureFlight,
  endSignatureFlight,
  onSignatureFlightChange,
} from './signature-flight.js';
import { open as openSidebarPanel } from '../sidebar.js';
import {
  escapeHtml,
  truncateAddress,
  isSafeAccount,
  isDeviceAccount,
  deviceLabel,
  signingButtonLabel,
} from './wallet-utils.js';
import { registerDappPrompt, isDappPromptShowing } from './dapp-prompt-guard.js';
import { confirmSigning } from './signing-confirmation.js';
import { getActiveWebview, subscribeTabPresentation } from '../tabs.js';

// DOM references
let screen;
let backBtn;
let siteEl;
let selectorEl;
let accountBtn;
let accountNameEl;
let accountAddressEl;
let accountKindEl;
let dropdownEl;
let accountListEl;
let rememberedEl;
let messageEl;
let noteEl;
let unlockEl;
let touchIdBtn;
let passwordLink;
let passwordSection;
let passwordInput;
let passwordSubmit;
let unlockErrorEl;
let errorEl;
let cancelBtn;
let approveBtn;

// Challenges not on screen yet, by tab (webContentsId); the newest per tab.
const waiting = new Map();
// The challenge on screen: { challenge, walletIndex, accounts, prepared,
// preparing, unlocked, signing, dead }.
let current = null;
let lastActiveGuestId = null;
// While another prompt holds the sidebar a waiting challenge is retried on
// this timer: prompts announce showing, not leaving.
const RETRY_MS = 1000;
let retryTimer = null;

export function initSiweSignin() {
  screen = document.getElementById('sidebar-siwe-signin');
  if (!screen) return;
  backBtn = document.getElementById('siwe-signin-back');
  siteEl = document.getElementById('siwe-signin-site');
  selectorEl = document.getElementById('siwe-signin-selector');
  accountBtn = document.getElementById('siwe-signin-account-btn');
  accountNameEl = document.getElementById('siwe-signin-account-name');
  accountAddressEl = document.getElementById('siwe-signin-account-address');
  accountKindEl = document.getElementById('siwe-signin-account-kind');
  dropdownEl = document.getElementById('siwe-signin-dropdown');
  accountListEl = document.getElementById('siwe-signin-account-list');
  rememberedEl = document.getElementById('siwe-signin-remembered');
  messageEl = document.getElementById('siwe-signin-message');
  noteEl = document.getElementById('siwe-signin-note');
  unlockEl = document.getElementById('siwe-signin-unlock');
  touchIdBtn = document.getElementById('siwe-signin-touchid-btn');
  passwordLink = document.getElementById('siwe-signin-password-link');
  passwordSection = document.getElementById('siwe-signin-password-section');
  passwordInput = document.getElementById('siwe-signin-password-input');
  passwordSubmit = document.getElementById('siwe-signin-password-submit');
  unlockErrorEl = document.getElementById('siwe-signin-unlock-error');
  errorEl = document.getElementById('siwe-signin-error');
  cancelBtn = document.getElementById('siwe-signin-cancel');
  approveBtn = document.getElementById('siwe-signin-approve');

  // Another screen taking the sidebar parks the card: the challenge waits
  // and comes back the next time its tab is shown.
  registerScreenHider(() => {
    if (current && !current.signing) park();
    screen?.classList.add('hidden');
  });
  // While the card shows an undecided sign-in, dApp prompts wait.
  registerDappPrompt(() => current !== null && !screen.classList.contains('hidden'));

  backBtn?.addEventListener('click', cancelCurrent);
  cancelBtn?.addEventListener('click', cancelCurrent);
  approveBtn?.addEventListener('click', approve);
  accountBtn?.addEventListener('click', toggleDropdown);
  touchIdBtn?.addEventListener('click', unlockWithTouchId);
  passwordSubmit?.addEventListener('click', unlockWithPassword);
  passwordInput?.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') unlockWithPassword();
  });
  passwordLink?.addEventListener('click', () => {
    passwordLink.classList.add('hidden');
    passwordSection?.classList.remove('hidden');
    passwordInput?.focus();
  });
  document.addEventListener('click', (event) => {
    if (selectorEl && !selectorEl.contains(event.target)) closeDropdown();
  });

  window.electronAPI?.onSiweChallenge?.(onChallenge);
  window.electronAPI?.onSiweChallengeClosed?.(onChallengeClosed);
  subscribeTabPresentation(onTabsChanged);
  // A device signature elsewhere held the sidebar: try again once it ends.
  onSignatureFlightChange(() => {
    if (!isSignatureInFlight()) tryShow();
  });
}

function activeGuestId() {
  try {
    return getActiveWebview()?.getWebContentsId?.() ?? null;
  } catch {
    return null;
  }
}

function onChallenge(challenge) {
  if (!challenge?.id || !Number.isInteger(challenge.webContentsId)) return;
  // A newer 401 in the same tab replaces the one on screen (main already
  // dropped the old one). One mid-signature finishes first, but is dead.
  if (current && current.challenge.webContentsId === challenge.webContentsId) {
    if (current.signing) current.dead = true;
    else closeCard();
  }
  waiting.set(challenge.webContentsId, challenge);
  tryShow();
}

function onChallengeClosed({ id } = {}) {
  for (const [guestId, challenge] of waiting) {
    if (challenge.id === id) waiting.delete(guestId);
  }
  if (current?.challenge.id !== id) return;
  if (current.signing) {
    // The page went away under a signature: main refuses to complete it.
    current.dead = true;
    return;
  }
  closeCard();
}

function onTabsChanged() {
  const guestId = activeGuestId();
  if (guestId === lastActiveGuestId) return;
  lastActiveGuestId = guestId;
  leaveIfTabChanged();
  tryShow();
}

/**
 * The card speaks for the page in the address bar: when another tab is
 * shown, it leaves (its challenge waits for its tab). Not mid-signature —
 * a device prompt can't be recalled; the card leaves once that settles.
 * @returns {boolean} whether it left
 */
function leaveIfTabChanged() {
  if (!current || current.signing || current.challenge.webContentsId === activeGuestId())
    return false;
  park();
  screen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  return true;
}

/**
 * Put the card's challenge back in the queue and clear the card. A dead
 * challenge isn't queued, and never in place of a newer one for its tab.
 */
function park() {
  if (!current) return;
  const tabId = current.challenge.webContentsId;
  if (!current.dead && !waiting.has(tabId)) waiting.set(tabId, current.challenge);
  current = null;
  closeDropdown();
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    tryShow();
  }, RETRY_MS);
}

async function tryShow() {
  if (current) return;
  const guestId = activeGuestId();
  const queued = guestId === null ? null : waiting.get(guestId);
  if (!queued) return;
  if (isSignatureInFlight() || isDappPromptShowing()) {
    scheduleRetry();
    return;
  }
  waiting.delete(guestId);

  // Main's view, freshly: the challenge may have expired while it waited.
  const challenge = await window.electronAPI.siweGetChallenge({ id: queued.id });
  if (!challenge) return;
  if (current || isSignatureInFlight() || isDappPromptShowing() || activeGuestId() !== guestId) {
    waiting.set(guestId, challenge);
    scheduleRetry();
    return;
  }
  await show(challenge);
}

async function loadAccounts() {
  // Main's list, not the sidebar's copy: that one may predate an unlock (and
  // so lack derived addresses) or a newly added account.
  let wallets = walletState.derivedWallets;
  try {
    const result = await window.wallet.getDerivedWallets();
    if (result?.success) wallets = result.wallets;
  } catch (err) {
    console.warn('[SIWE] Could not refresh the account list:', err);
  }
  // v1 signs with accounts that can personal_sign; a Safe would need
  // ERC-1271/6492 support on the site's side.
  return (wallets || []).filter((wallet) => wallet.address && !isSafeAccount(wallet.index));
}

function defaultAccount(accounts, rememberedAddress) {
  const remembered =
    rememberedAddress &&
    accounts.find((wallet) => wallet.address.toLowerCase() === rememberedAddress.toLowerCase());
  if (remembered) return remembered;
  return (
    accounts.find((wallet) => wallet.index === walletState.activeWalletIndex) || accounts[0] || null
  );
}

async function show(challenge) {
  hideAllSubscreens();
  const card = {
    challenge,
    walletIndex: null,
    accounts: [],
    prepared: null,
    preparing: null,
    unlocked: false,
    signing: false,
    dead: false,
  };
  current = card;

  if (siteEl) siteEl.textContent = challenge.domain;
  if (noteEl) {
    noteEl.textContent =
      `Signing in shows ${challenge.domain} this account's address. ` +
      "It can't move funds or approve anything else.";
  }
  if (messageEl) messageEl.textContent = '';
  hideError();
  hideUnlockError();
  setApproveLabel('Sign in');
  setControlsEnabled(true);
  updateApprove();

  walletState.identityView?.classList.add('hidden');
  screen.classList.remove('hidden');
  openSidebarPanel();

  card.accounts = await loadAccounts();
  if (current !== card) return;
  const chosen = defaultAccount(card.accounts, challenge.rememberedAddress);
  if (!chosen) {
    renderAccount(null);
    showError('Add an Ethereum account to your wallet to sign in.');
    return;
  }
  await selectAccount(chosen.index);
}

function renderAccount(wallet) {
  if (accountNameEl) accountNameEl.textContent = wallet ? wallet.name : 'No account';
  if (accountAddressEl)
    accountAddressEl.textContent = wallet ? truncateAddress(wallet.address) : '--';
  const kind = wallet ? accountKind(wallet.index) : null;
  if (accountKindEl) {
    accountKindEl.textContent = kind || '';
    accountKindEl.classList.toggle('hidden', !kind);
  }
  const remembered = current?.challenge.rememberedAddress;
  rememberedEl?.classList.toggle(
    'hidden',
    !wallet || !remembered || wallet.address.toLowerCase() !== remembered.toLowerCase()
  );
}

function accountKind(walletIndex) {
  const where = deviceLabel(walletIndex);
  return where ? where.replace(/^your /, '').replace(/^./, (c) => c.toUpperCase()) : null;
}

async function selectAccount(walletIndex) {
  const card = current;
  if (!card || card.signing) return;
  closeDropdown();
  const wallet = card.accounts.find((w) => w.index === walletIndex);
  if (!wallet) return;
  card.walletIndex = walletIndex;
  card.prepared = null;
  renderAccount(wallet);
  hideError();
  updateApprove();

  // The message names the account, so it is built (by main) per account.
  const token = {};
  card.preparing = token;
  if (messageEl) messageEl.textContent = '';
  const result = await window.electronAPI.siwePrepare({ id: card.challenge.id, walletIndex });
  if (current !== card || card.preparing !== token) return;
  card.preparing = null;
  if (!result?.success) {
    showError(result?.error || 'Could not prepare the sign-in.');
    if (result?.code === 'stale' || result?.code === 'expired') card.dead = true;
    updateApprove();
    return;
  }
  card.prepared = { walletIndex, address: result.address, message: result.message };
  if (messageEl) messageEl.textContent = result.message;
  await checkUnlock(card);
}

async function checkUnlock(card) {
  const { walletIndex } = card;
  // Answers for an account the user has since moved away from paint nothing.
  const stale = () => current !== card || card.walletIndex !== walletIndex;
  if (isDeviceAccount(walletIndex)) {
    card.unlocked = true;
    unlockEl?.classList.add('hidden');
    updateApprove();
    return;
  }
  try {
    const status = await window.identity.getStatus();
    if (stale()) return;
    if (status?.isUnlocked) {
      card.unlocked = true;
      unlockEl?.classList.add('hidden');
      updateApprove();
      return;
    }
    card.unlocked = false;
    updateApprove();
    const [canUseTouchId, touchIdEnabled, vaultMeta] = await Promise.all([
      window.quickUnlock.canUseTouchId(),
      window.quickUnlock.isEnabled(),
      window.identity.getVaultMeta(),
    ]);
    if (stale()) return;
    const hasTouchId = canUseTouchId && touchIdEnabled;
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;
    touchIdBtn?.classList.toggle('hidden', !hasTouchId);
    passwordLink?.classList.toggle('hidden', !(hasTouchId && userKnowsPassword));
    passwordSection?.classList.toggle('hidden', hasTouchId || !userKnowsPassword);
    unlockEl?.classList.remove('hidden');
  } catch (err) {
    console.error('[SIWE] Failed to check vault status:', err);
    if (stale()) return;
    card.unlocked = false;
    touchIdBtn?.classList.add('hidden');
    passwordLink?.classList.add('hidden');
    passwordSection?.classList.remove('hidden');
    unlockEl?.classList.remove('hidden');
    updateApprove();
  }
}

function unlocked() {
  if (!current) return;
  current.unlocked = true;
  unlockEl?.classList.add('hidden');
  if (passwordInput) passwordInput.value = '';
  hideUnlockError();
  updateApprove();
}

async function unlockWithTouchId() {
  try {
    const result = await window.quickUnlock.unlock();
    if (!result?.success) throw new Error(result?.error || 'Touch ID failed');
    unlocked();
  } catch (err) {
    if (err.message !== 'Touch ID cancelled') showUnlockError(err.message || 'Touch ID failed');
  }
}

async function unlockWithPassword() {
  const password = passwordInput?.value;
  if (!password) return;
  try {
    const result = await window.identity.unlock(password);
    if (!result?.success) throw new Error(result?.error || 'Incorrect password');
    unlocked();
  } catch (err) {
    showUnlockError(err.message || 'Failed to unlock');
  }
}

async function approve() {
  const card = current;
  if (!card || card.signing || card.dead || !card.prepared || !card.unlocked) return;
  // Only for the page in the address bar.
  if (leaveIfTabChanged()) {
    tryShow();
    return;
  }
  const { walletIndex, message } = card.prepared;

  card.signing = true;
  // Claim the sidebar for the whole flight: a device prompt can't be recalled.
  beginSignatureFlight(card);
  setApproveLabel(signingButtonLabel(walletIndex));
  setControlsEnabled(false);
  updateApprove();
  hideError();

  try {
    // Main's word that the request is still open and the tab still the
    // user's (the Agent may have taken it), before any signer is asked.
    const stillOpen = await window.electronAPI.siweGetChallenge({ id: card.challenge.id });
    if (!stillOpen) card.dead = true;
    assertStillShowing(card);
    const authorization = await confirmSigning('sign-message', walletIndex, message);
    // The last moment to stop: past here a device may already be asking.
    assertStillShowing(card);
    const signed = await window.wallet.signMessage(message, walletIndex, authorization);
    if (!signed?.success) throw new Error(signed?.error || 'Signing failed');
    const done = await window.electronAPI.siweComplete({
      id: card.challenge.id,
      walletIndex,
      signature: signed.signature,
    });
    if (!done?.success) {
      if (done?.code === 'stale' || done?.code === 'expired') card.dead = true;
      throw new Error(done?.error || 'Sign-in failed');
    }
    card.signing = false;
    endSignatureFlight(card);
    if (current === card) closeCard();
    tryShow();
    return;
  } catch (err) {
    console.error('[SIWE] Sign-in failed:', err);
    card.signing = false;
    endSignatureFlight(card);
    if (current !== card) return;
    setApproveLabel('Sign in');
    setControlsEnabled(true);
    // Another tab was shown while the device was asking: the card goes
    // with its page instead of coming back over the other one. A newer
    // challenge from the same page takes over from a dead one.
    if (leaveIfTabChanged()) {
      tryShow();
      return;
    }
    if (card.dead && waiting.has(card.challenge.webContentsId)) {
      closeCard();
      tryShow();
      return;
    }
    showError(err.message || 'Sign-in failed');
    updateApprove();
    // The vault may have locked while the card was open: show the unlock.
    if (!isDeviceAccount(card.walletIndex)) checkUnlock(card);
  }
}

/**
 * Before the signer is asked: the request must be open and its tab shown.
 * The failure path then takes the card away with its tab, or says why.
 */
function assertStillShowing(card) {
  if (card.dead) throw new Error('This sign-in request is no longer open.');
  if (card.challenge.webContentsId !== activeGuestId()) throw new Error('Another tab is showing.');
}

function cancelCurrent() {
  const card = current;
  if (!card || card.signing) return;
  window.electronAPI.siweCancel({ id: card.challenge.id });
  closeCard();
  tryShow();
}

function closeCard() {
  current = null;
  closeDropdown();
  screen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  hideError();
  hideUnlockError();
  if (passwordInput) passwordInput.value = '';
  if (messageEl) messageEl.textContent = '';
  setApproveLabel('Sign in');
  setControlsEnabled(true);
}

// --- Account picker ---------------------------------------------------------

function toggleDropdown() {
  if (!current || current.signing) return;
  if (selectorEl?.classList.contains('open')) {
    closeDropdown();
    return;
  }
  renderAccountList();
  selectorEl?.classList.add('open');
  dropdownEl?.classList.remove('hidden');
  accountBtn?.setAttribute('aria-expanded', 'true');
}

function closeDropdown() {
  selectorEl?.classList.remove('open');
  dropdownEl?.classList.add('hidden');
  accountBtn?.setAttribute('aria-expanded', 'false');
}

function renderAccountList() {
  if (!accountListEl || !current) return;
  accountListEl.innerHTML = '';
  for (const wallet of current.accounts) {
    const selected = wallet.index === current.walletIndex;
    const kind = accountKind(wallet.index);
    const item = document.createElement('div');
    item.className = `dapp-connect-wallet-item${selected ? ' selected' : ''}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(selected));
    item.innerHTML = `
      <div class="dapp-connect-wallet-item-info">
        <span class="dapp-connect-wallet-item-name">${escapeHtml(wallet.name)}</span>
        <code class="dapp-connect-wallet-item-address">${escapeHtml(truncateAddress(wallet.address))}</code>
      </div>
      ${kind ? `<span class="siwe-kind">${escapeHtml(kind)}</span>` : ''}
      ${
        selected
          ? `
        <svg class="dapp-connect-wallet-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      `
          : ''
      }
    `;
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      selectAccount(wallet.index);
    });
    accountListEl.appendChild(item);
  }
}

// --- Small helpers ----------------------------------------------------------

function updateApprove() {
  if (!approveBtn) return;
  const card = current;
  approveBtn.disabled = !card || card.signing || card.dead || !card.prepared || !card.unlocked;
}

function setApproveLabel(text) {
  if (approveBtn) approveBtn.textContent = text;
}

function setControlsEnabled(enabled) {
  if (cancelBtn) cancelBtn.disabled = !enabled;
  if (backBtn) backBtn.disabled = !enabled;
  if (accountBtn) accountBtn.disabled = !enabled;
}

function showError(message) {
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

function hideError() {
  errorEl?.classList.add('hidden');
}

function showUnlockError(message) {
  if (!unlockErrorEl) return;
  unlockErrorEl.textContent = message;
  unlockErrorEl.classList.remove('hidden');
}

function hideUnlockError() {
  unlockErrorEl?.classList.add('hidden');
}
