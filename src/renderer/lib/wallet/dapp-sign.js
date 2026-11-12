/**
 * dApp Message Signing Module
 *
 * Message signing approval screen for dApp-initiated signing requests.
 *
 * From freedom-core design 0011 PRQ-5a a page's signature is main's: main
 * shows its prompt (`eth.sign`, through page-prompts.js) and this screen
 * renders main's view, the site main attested and what main says the
 * request signs, and answers the handle (`page:decide`) with the one choice
 * it offers, "always allow". Main mints the approval's token and signs. An
 * approved signature on a device keeps the screen, its Sign button showing
 * the device step, until main has answered the page. The old path
 * (`showDappSignApproval`) stays for rollback until PRQ-9; main refuses its
 * token.
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
import {
  bypassUnlockGateForDevice,
  bypassUnlockGateForSafe,
  signingButtonLabel,
  isSafeAccount,
} from './wallet-utils.js';
import { isSafeSigningBoardOpen } from './safe-signing.js';
import { hexToBytes, utf8Text } from './personal-sign.js';
import {
  formatTypedDataView,
  typedDataWarningTexts,
  ignoredText,
} from './typed-data-view.js';
import {
  registerDappPrompt,
  assertNoDappPromptShowing,
  isDappPromptShowing,
  requestPendingError,
} from './dapp-prompt-guard.js';
import { registerPagePromptRenderer, pagePromptDisplaced } from '../page-prompt-renderers.js';

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
let dappSignRawWarning;
let dappSignTypedWarning;
let dappSignTypedWarningText;
let dappSignTypedIgnored;

// Local state. `dappSignPending.signing` is true while the signature is
// in flight: a hardware signature is a device prompt we cannot recall, so
// there is no cancellation path once it starts — rejecting behind it
// would settle the dApp promise with 4001 while the device still signs.
let dappSignPending = null;
// While the screen paints a page prompt, the hider it runs is its own.
let presentingPagePrompt = false;

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
  dappSignRawWarning = document.getElementById('dapp-sign-raw-warning');
  dappSignTypedWarning = document.getElementById('dapp-sign-typed-warning');
  dappSignTypedWarningText = document.getElementById('dapp-sign-typed-warning-text');
  dappSignTypedIgnored = document.getElementById('dapp-sign-typed-ignored');

  // Register screen hider. A page prompt another screen hides stays main's
  // shown prompt: it is told, so it can show again once that screen is done.
  registerScreenHider(() => {
    dappSignScreen?.classList.add('hidden');
    const request = dappSignPending;
    if (!presentingPagePrompt && request?.handle && !request.deciding) {
      dappSignPending = null;
      walletState.identityView?.classList.remove('hidden');
      pagePromptDisplaced(request.handle);
    }
  });
  registerPagePromptRenderer('eth.sign', { show: showPageSign, close: closePageSign, isShowing: shownPageSign });
  // Showing an undecided message: newcomers wait (dapp-prompt-guard.js).
  registerDappPrompt(
    () => dappSignPending !== null && Boolean(dappSignScreen) && !dappSignScreen.classList.contains('hidden')
  );

  setupDappSignScreen();
}

function setupDappSignScreen() {
  const reject = () => {
    if (dappSignPending?.signing || dappSignPending?.deciding) return;
    if (dappSignPending?.handle) {
      decidePageSign(dappSignPending, false);
      return;
    }
    rejectDappSign();
    closeDappSign();
  };
  dappSignBackBtn?.addEventListener('click', reject);
  dappSignRejectBtn?.addEventListener('click', reject);

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
 *
 * `prepared` is what main says the request signs (dapp-provider.js,
 * freedom-core #88): `{ message: { hex, rawHash } }` for personal_sign,
 * `{ typedData: { hash, view, warnings }, chainId }` for typed data. The
 * screen shows only that, never the dApp's own text.
 */
export async function showDappSignApproval(webview, permissionKey, method, params, prepared = {}) {
  assertNoSignatureInFlight();
  assertNoDappPromptShowing();

  const permission = await window.dappPermissions.getPermission(permissionKey);
  if (!permission) {
    throw Object.assign(new Error('Unauthorized - not connected'), { code: 4100 });
  }

  return new Promise((resolve, reject) => {
    // Re-checked after the awaits above: the screen must still be free at
    // the moment we take it over.
    assertNoSignatureInFlight();
    assertNoDappPromptShowing();
    const request = { permissionKey, walletIndex: permission.walletIndex, method, params, resolve, reject, webview };
    // A request still being prepared gives way and is answered now; one
    // that is signing (a Safe ceremony) carries on with its own reference.
    const previous = dappSignPending;
    dappSignPending = request;
    if (previous && !previous.signing) previous.reject({ code: 4001, message: 'Replaced by a newer request' });
    if (dappSignAutoApproveCheckbox) dappSignAutoApproveCheckbox.checked = false;
    setDappSignCancelEnabled(true);
    // A Safe request parked on its board leaves its "Signing…" label and
    // error behind; this request starts clean.
    if (dappSignApproveBtn) dappSignApproveBtn.textContent = 'Sign';
    hideDappSignError();

    if (dappSignSite) {
      dappSignSite.textContent = permissionKey;
    }

    dappSignRawWarning?.classList.add('hidden');
    dappSignTypedWarning?.classList.add('hidden');
    dappSignTypedIgnored?.classList.add('hidden');
    try {
      if (method === 'personal_sign') {
        displayPersonalSignMessage(prepared.message);
      } else if (method === 'eth_signTypedData_v4') {
        displayTypedDataView(prepared.typedData, prepared.chainId, prepared.chains);
      }
    } catch (err) {
      // A message that can't be displayed is never shown, so never signed.
      if (dappSignPending === request) dappSignPending = null;
      throw err;
    }

    // Multi-owner accounts sign as a smart contract — be upfront that
    // not every dApp can verify EIP-1271 signatures.
    document
      .getElementById('dapp-sign-safe-note')
      ?.classList.toggle('hidden', !isSafeAccount(permission.walletIndex));

    checkDappSignUnlockStatus(request).then(() => {
      // Replaced while it was being prepared: answered then, never shown.
      if (dappSignPending !== request) return;
      // Another surface may have started a device signature while we were
      // checking vault status (the user could still click Pay on an x402
      // card, say). It owns the sidebar now — refuse rather than paint
      // over a live confirmation.
      if (isSignatureInFlight()) {
        if (dappSignPending === request) dappSignPending = null;
        reject(signatureInFlightError());
        return;
      }
      // Another prompt was shown meanwhile: it keeps the screen.
      if (isDappPromptShowing()) {
        dappSignPending = null;
        reject(requestPendingError());
        return;
      }
      hideAllSubscreens();
      walletState.identityView?.classList.add('hidden');
      dappSignScreen?.classList.remove('hidden');

      openSidebarPanel();
    }).catch((err) => {
      if (dappSignPending === request) dappSignPending = null;
      reject(err);
    });
  });
}

/**
 * personal_sign, shown from the bytes main sends to sign (#88): as text
 * when they are UTF-8, else as hex. Exactly 32 bytes are always hex, with
 * a warning (#89): their signature can be a Swarm feed update, which
 * nothing here could show.
 */
function displayPersonalSignMessage(message) {
  // A view whose bytes aren't hex can't be shown, so it is never signed
  // (showDappSignApproval refuses the request).
  if (message && hexToBytes(message.hex) === null) {
    throw new Error("This message can't be shown, so it can't be signed");
  }
  if (dappSignMessage) {
    dappSignMessage.parentElement?.classList.remove('hidden');
  }
  dappSignTypedDataSection?.classList.add('hidden');

  const rawHash = Boolean(message?.rawHash);
  dappSignRawWarning?.classList.toggle('hidden', !rawHash);

  if (dappSignMessage) {
    const hex = message?.hex ?? '0x';
    const text = rawHash ? null : utf8Text(hexToBytes(hex));
    dappSignMessage.textContent = text ?? hex;
  }
}

/**
 * Typed data, shown from the identity core's view of what is signed (#88):
 * every field whole. Keys the site sent that the types don't declare are
 * listed as not signed, and the view's reports are warned about.
 */
function displayTypedDataView(typedData, siteChainId, chains) {
  if (dappSignMessage) {
    dappSignMessage.parentElement?.classList.add('hidden');
  }
  dappSignTypedDataSection?.classList.remove('hidden');

  const view = typedData?.view;
  if (dappSignTypedData) {
    dappSignTypedData.textContent = formatTypedDataView(view);
  }

  const ignored = ignoredText(view);
  if (dappSignTypedIgnored) {
    dappSignTypedIgnored.textContent = ignored || '';
    dappSignTypedIgnored.classList.toggle('hidden', !ignored);
  }

  const warnings = typedDataWarningTexts(typedData?.warnings || [], { view, siteChainId, chains });
  if (dappSignTypedWarningText) {
    dappSignTypedWarningText.textContent = warnings.join('\n\n');
  }
  dappSignTypedWarning?.classList.toggle('hidden', warnings.length === 0);
}

// Writes the unlock UI only while `request` is still the pending one.
async function checkDappSignUnlockStatus(request) {
  try {
    if (
      bypassUnlockGateForDevice(request?.walletIndex, dappSignUnlock, dappSignApproveBtn) ||
      bypassUnlockGateForSafe(request?.walletIndex, dappSignUnlock, dappSignApproveBtn)
    ) {
      return;
    }

    const status = await window.identity.getStatus();
    if (dappSignPending !== request) return;

    if (status.isUnlocked) {
      dappSignUnlock?.classList.add('hidden');
      if (dappSignApproveBtn) dappSignApproveBtn.disabled = false;
      return;
    }

    dappSignUnlock?.classList.remove('hidden');
    if (dappSignApproveBtn) dappSignApproveBtn.disabled = true;

    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    if (dappSignPending !== request) return;
    const touchIdEnabled = await window.quickUnlock.isEnabled();
    if (dappSignPending !== request) return;
    const hasTouchId = canUseTouchId && touchIdEnabled;

    const vaultMeta = await window.identity.getVaultMeta();
    if (dappSignPending !== request) return;
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
    // A replaced request's failure paints nothing on its successor.
    if (dappSignPending !== request) return;
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

/**
 * Render main's signing prompt (`page:prompt`, kind `eth.sign`): the site
 * main attested, the account and chain, and what main says the request
 * signs (#88). The page's own text and images aren't shown. The caller
 * shows it only while nothing else holds the sidebar (`page-prompts.js`).
 */
export function showPageSign(prompt) {
  const view = prompt?.view || {};
  const account = view.account || {};
  const previous = dappSignPending;
  const request = {
    handle: prompt.handle,
    walletIndex: account.index,
    method: view.method,
    safe: account.type === 'safe',
    deciding: false,
    signing: false,
  };
  dappSignPending = request;
  // An old-path request still being prepared gives way, as before.
  if (previous && !previous.handle && !previous.signing) {
    previous.reject({ code: 4001, message: 'Replaced by a newer request' });
  }
  if (dappSignAutoApproveCheckbox) dappSignAutoApproveCheckbox.checked = false;
  setDappSignCancelEnabled(true);
  if (dappSignApproveBtn) dappSignApproveBtn.textContent = 'Sign';
  hideDappSignError();
  if (dappSignSite) dappSignSite.textContent = prompt?.site?.label || prompt?.site?.key || 'Unknown';
  dappSignRawWarning?.classList.add('hidden');
  dappSignTypedWarning?.classList.add('hidden');
  dappSignTypedIgnored?.classList.add('hidden');
  try {
    if (view.method === 'personal_sign') {
      displayPersonalSignMessage(view.message);
    } else {
      displayTypedDataView(view.typedData, view.chain?.id, view.chains);
    }
  } catch (err) {
    // What can't be shown is never signed.
    console.error('[WalletUI] A signing prompt main sent can’t be shown:', err);
    dappSignPending = null;
    decideHandle(request.handle, false);
    return;
  }
  document.getElementById('dapp-sign-safe-note')?.classList.toggle('hidden', !request.safe);
  // Sign waits for the unlock check (a vault account needs the vault open).
  if (dappSignApproveBtn) dappSignApproveBtn.disabled = true;
  checkDappSignUnlockStatus(request);

  presentingPagePrompt = true;
  try {
    hideAllSubscreens();
  } finally {
    presentingPagePrompt = false;
  }
  walletState.identityView?.classList.add('hidden');
  dappSignScreen?.classList.remove('hidden');
  openSidebarPanel();
}

/**
 * Take down main's prompt `handle` (hidden, closed, or refused). An approved
 * signature on its device keeps the screen until main answers.
 */
export function closePageSign(handle) {
  const request = dappSignPending;
  if (!request?.handle || request.handle !== handle) return false;
  if (request.signing) return true;
  closeDappSign();
  return true;
}

/** The page prompt the screen shows, or null. */
export function shownPageSign() {
  return dappSignPending?.handle && dappSignScreen && !dappSignScreen.classList.contains('hidden')
    ? dappSignPending.handle
    : null;
}

async function decideHandle(handle, approve, choices = {}) {
  try {
    return await window.pagePrompts?.decide?.(handle, approve, choices);
  } catch (err) {
    console.error('[WalletUI] The decision did not reach main:', err);
    return null;
  }
}

// Answer main's prompt: the decision counts only for the handle main shows
// at this moment. Main signs, and answers once the page has its answer.
// A Safe's approval goes on to its signing board, which main shows next.
async function decidePageSign(request, approve) {
  if (request.deciding) return;
  request.deciding = true;
  const alwaysAllow = approve && Boolean(dappSignAutoApproveCheckbox?.checked);
  if (approve && !request.safe) {
    // The signature may be a device's: nothing may paint over it.
    request.signing = true;
    beginSignatureFlight(request);
    if (dappSignApproveBtn) {
      dappSignApproveBtn.disabled = true;
      dappSignApproveBtn.textContent = signingButtonLabel(request.walletIndex);
    }
    setDappSignCancelEnabled(false);
  }
  if (!approve || request.safe) {
    if (dappSignPending === request) closeDappSign();
  }
  try {
    await decideHandle(request.handle, approve, approve ? { alwaysAllow } : {});
  } finally {
    request.signing = false;
    request.deciding = false;
    endSignatureFlight(request);
    if (dappSignPending === request) closeDappSign();
  }
}

async function approveDappSign() {
  if (!dappSignPending || dappSignPending.signing) return;
  if (dappSignPending.handle) {
    await decidePageSign(dappSignPending, true);
    return;
  }

  const request = dappSignPending;
  const { permissionKey, walletIndex, method, params, resolve, webview } = request;
  // Snapshot the auto-approve intent now: the checkbox is shared DOM that
  // a later request can repopulate while this signature is in flight.
  const autoApprove = Boolean(dappSignAutoApproveCheckbox?.checked);
  const safeAccount = isSafeAccount(walletIndex);

  try {
    request.signing = true;
    // Claim the sidebar for the whole flight: no other approval surface
    // may repaint over or tear down a live device confirmation.
    if (!safeAccount) beginSignatureFlight(request);
    if (dappSignApproveBtn) {
      dappSignApproveBtn.disabled = true;
      dappSignApproveBtn.textContent = signingButtonLabel(walletIndex);
    }
    setDappSignCancelEnabled(false);

    const signature = await executeSign(method, params, walletIndex, permissionKey, webview);

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
    if (err?.code === 4001) {
      // The user closed the Safe signing board — that IS the rejection.
      // Answer this request, not whichever one holds the screen now.
      request.reject({ code: 4001, message: 'User rejected the request' });
      if (dappSignPending === request) closeDappSign();
      return;
    }
    console.error('[WalletUI] dApp signing failed:', err);
    // A newer request took the screen while the Safe board was parked: this
    // one is no longer on screen to retry, so answer it with the failure.
    if (dappSignPending !== request) {
      request.reject(err);
      return;
    }
    showDappSignError(err.message || 'Signing failed');
    if (dappSignApproveBtn) {
      dappSignApproveBtn.disabled = false;
      dappSignApproveBtn.textContent = 'Sign';
    }
    setDappSignCancelEnabled(true);
    // The signing board may have replaced this screen (a Safe signature
    // that failed to complete) — bring the approval back.
    if (safeAccount) {
      walletState.identityView?.classList.add('hidden');
      dappSignScreen?.classList.remove('hidden');
    }
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
  dappSignRawWarning?.classList.add('hidden');
  dappSignTypedWarning?.classList.add('hidden');
  dappSignTypedIgnored?.classList.add('hidden');
  // A Safe flow may still be showing the signing board (in-flow, not a
  // modal) — restoring the identity view under it would double-render.
  if (!isSafeSigningBoardOpen()) {
    walletState.identityView?.classList.remove('hidden');
  }
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
