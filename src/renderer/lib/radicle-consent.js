/**
 * Radicle provider consent prompts — sidebar subscreens.
 *
 * One parametrized subscreen (#sidebar-radicle-consent in index.html)
 * covers the three consent moments of the window.radicle provider:
 *  - connect: origin wants access to the user's Radicle node
 *  - seed: origin asks the node to seed a repository (disk + bandwidth)
 *  - signing: origin wants to act as the user's Radicle identity
 *
 * Renders in the same right-hand sidebar as the wallet/swarm prompts for
 * a unified consent UX, but stays functionally independent of the
 * identity-wallet feature: it opens the panel via sidebar.openForConsent()
 * (which honors the Radicle flag) and never touches vault or wallet state.
 */

import { registerScreenHider, hideAllSubscreens, walletState } from './wallet/wallet-state.js';
import {
  openForConsent as openSidebarForConsent,
  close as closeSidebar,
  isVisible as isSidebarVisible,
} from './sidebar.js';

// DOM references
let screen;
let titleEl;
let siteEl;
let wantsEl;
let allowsEl;
let warningEl;
let approveBtn;
let rejectBtn;
let backBtn;

// { resolve, reject, sidebarWasOpen, owner } while a prompt is showing.
// `owner` is an opaque token (the requesting webview) identifying which
// document the prompt belongs to, so it can be dismissed when that
// document navigates away or its tab closes.
let pending = null;

export function initRadicleConsent() {
  screen = document.getElementById('sidebar-radicle-consent');
  titleEl = document.getElementById('radicle-consent-title');
  siteEl = document.getElementById('radicle-consent-site');
  wantsEl = document.getElementById('radicle-consent-wants');
  allowsEl = document.getElementById('radicle-consent-allows');
  warningEl = document.getElementById('radicle-consent-warning');
  approveBtn = document.getElementById('radicle-consent-approve');
  rejectBtn = document.getElementById('radicle-consent-reject');
  backBtn = document.getElementById('radicle-consent-back');

  if (!screen) {
    console.error('[RadicleConsent] Sidebar subscreen not found');
    return;
  }

  approveBtn?.addEventListener('click', () => finish(true));
  rejectBtn?.addEventListener('click', () => finish(false));
  backBtn?.addEventListener('click', () => finish(false));
  // Closing the panel (X button, toggle, Cmd+Shift+W) rejects the request.
  document.addEventListener('sidebar-closed', () => {
    if (pending) finish(false, { keepSidebar: true });
  });

  registerScreenHider(() => screen.classList.add('hidden'));

  console.log('[RadicleConsent] Initialized');
}

function finish(approved, { keepSidebar = false } = {}) {
  if (!pending) return;
  const { resolve, reject, sidebarWasOpen } = pending;
  pending = null;

  screen.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  // If the panel was opened just for this prompt, close it again rather
  // than leaving the wallet view behind (which may not even be enabled).
  if (!keepSidebar && !sidebarWasOpen) closeSidebar();

  if (approved) resolve();
  else reject({ code: 4001, message: 'User rejected the request' });
}

/**
 * Show a consent prompt. Resolves on approve, rejects {code:4001} on
 * cancel/back/panel-close. Only one prompt can be active; a second request
 * while one is showing is rejected immediately (prevents prompt-queue
 * confusion from spammy pages).
 */
function prompt({ title, origin, wants, allows, warning, approveLabel, owner }) {
  return new Promise((resolve, reject) => {
    if (!screen) {
      reject({ code: -32603, message: 'Consent UI unavailable' });
      return;
    }
    if (pending) {
      reject({ code: 4001, message: 'Another consent prompt is already open' });
      return;
    }

    titleEl.textContent = title;
    siteEl.textContent = origin;
    wantsEl.textContent = wants;
    allowsEl.replaceChildren(
      ...allows.map((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        return li;
      })
    );
    warningEl.textContent = warning;
    approveBtn.textContent = approveLabel;

    pending = { resolve, reject, sidebarWasOpen: isSidebarVisible(), owner };

    hideAllSubscreens();
    walletState.identityView?.classList.add('hidden');
    screen.classList.remove('hidden');
    openSidebarForConsent();
  });
}

/**
 * Dismiss (reject) the pending prompt if it belongs to `owner` — called by
 * the provider when the requesting document navigates away or its webview
 * is destroyed, so a moot prompt can't be approved on behalf of a document
 * that no longer exists. A no-op when the pending prompt has another owner.
 */
export function dismissRadicleConsent(owner) {
  if (pending && pending.owner === owner) finish(false);
}

export function showRadicleConnect(permissionKey, owner) {
  return prompt({
    owner,
    title: 'Connect Radicle node?',
    origin: permissionKey,
    wants: 'wants to interact with your Radicle node',
    allows: [
      'See node status and your seeded repositories',
      'Ask to seed or sync repositories (with approval)',
    ],
    warning:
      'This site cannot write anything as you without a separate approval for your Radicle identity.',
    approveLabel: 'Connect',
  });
}

export function showRadicleSeedApproval(permissionKey, rid, owner) {
  return prompt({
    owner,
    title: 'Seed this repository?',
    origin: permissionKey,
    wants: `asks your node to seed ${rid}`,
    allows: [
      'Download the repository to your node',
      'Share it with the Radicle network from your node',
    ],
    warning: 'Seeding uses disk space and bandwidth until you unseed the repository.',
    approveLabel: 'Seed repository',
  });
}

export function showRadicleUnseedApproval(permissionKey, rid, owner) {
  return prompt({
    owner,
    title: 'Stop seeding this repository?',
    origin: permissionKey,
    wants: `asks your node to stop seeding ${rid}`,
    allows: [
      'Remove the seeding policy for this repository',
      'Cancel any fetch of it still in progress',
    ],
    warning:
      'Your node stops sharing this repository with the Radicle network until you seed it again.',
    approveLabel: 'Stop seeding',
  });
}

export function showRadicleSigningApproval(permissionKey, owner) {
  return prompt({
    owner,
    title: 'Act as your Radicle identity?',
    origin: permissionKey,
    wants: 'wants to author content as your Radicle identity',
    allows: [
      'Know your Radicle DID and alias',
      'Open issues, comment, and change issue states as you',
    ],
    warning:
      'Everything it writes is signed with your key, published to the Radicle network, and cannot be unpublished.',
    approveLabel: 'Allow',
  });
}
