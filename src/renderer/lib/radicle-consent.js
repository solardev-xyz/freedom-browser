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
 *
 * Main's own prompts for a page's request (freedom-core design 0011, "The
 * prompt protocol"; PRQ-8a: `radicle.connect`; PRQ-8b: `radicle.node`)
 * show in the same screen,
 * from what main sends: its site and its view. The screen answers them by
 * handle (`page:decide`) once its input protection has passed, writes no
 * grant, and takes itself down when main hides or closes the prompt. The
 * prompts that still take the chrome's own path (signing) keep
 * the promise-based flow below until their parts move them.
 */

import { registerScreenHider, hideAllSubscreens, walletState } from './wallet/wallet-state.js';
import {
  openForConsent as openSidebarForConsent,
  close as closeSidebar,
  isVisible as isSidebarVisible,
} from './sidebar.js';
import { PROMPT_ARM_DELAY_MS, setButtonsDisabled } from './wallet/prompt-queue.js';
import { registerPagePromptRenderer, pagePromptDisplaced } from './page-prompt-renderers.js';

// DOM references
let screen;
let titleEl;
let siteEl;
let wantsEl;
let allowsEl;
let warningEl;
let alwaysRow;
let alwaysInput;
let alwaysLabel;
let approveBtn;
let rejectBtn;
let backBtn;

// { resolve, reject, sidebarWasOpen, owner } while a prompt is showing.
// `owner` is an opaque token (the requesting webview) identifying which
// document the prompt belongs to, so it can be dismissed when that
// document navigates away or its tab closes.
let pending = null;

// Main's prompt on screen: { handle, sidebarWasOpen, armed, deciding }.
let pagePending = null;
// True while this screen shows main's prompt: its own hideAllSubscreens()
// is the transition, not a dismissal.
let presentingPagePrompt = false;
let armTimer = null;

export function initRadicleConsent() {
  screen = document.getElementById('sidebar-radicle-consent');
  titleEl = document.getElementById('radicle-consent-title');
  siteEl = document.getElementById('radicle-consent-site');
  wantsEl = document.getElementById('radicle-consent-wants');
  allowsEl = document.getElementById('radicle-consent-allows');
  warningEl = document.getElementById('radicle-consent-warning');
  alwaysRow = document.getElementById('radicle-consent-always-row');
  alwaysInput = document.getElementById('radicle-consent-always');
  alwaysLabel = document.getElementById('radicle-consent-always-label');
  approveBtn = document.getElementById('radicle-consent-approve');
  rejectBtn = document.getElementById('radicle-consent-reject');
  backBtn = document.getElementById('radicle-consent-back');

  if (!screen) {
    console.error('[RadicleConsent] Sidebar subscreen not found');
    return;
  }

  approveBtn?.addEventListener('click', () => (pagePending ? decidePage(true) : finish(true)));
  rejectBtn?.addEventListener('click', () => (pagePending ? decidePage(false) : finish(false)));
  backBtn?.addEventListener('click', () => (pagePending ? decidePage(false) : finish(false)));
  // Closing the panel (X button, toggle, Cmd+Shift+W) rejects the request.
  document.addEventListener('sidebar-closed', () => {
    if (pagePending) decidePage(false, { keepSidebar: true, armedOrNot: true });
    else if (pending) finish(false, { keepSidebar: true });
  });

  registerScreenHider(() => {
    if (presentingPagePrompt) return;
    screen.classList.add('hidden');
    // Main's prompt another screen hides stays main's shown prompt: it is
    // told, so it shows again once that screen is done.
    if (pagePending && !pagePending.deciding) {
      const { handle } = pagePending;
      clearPagePending();
      pagePromptDisplaced(handle);
    }
  });

  for (const kind of Object.keys(PAGE_COPY)) {
    registerPagePromptRenderer(kind, {
      show: showPagePrompt,
      close: closePagePrompt,
      isShowing: shownPagePrompt,
    });
  }

  console.log('[RadicleConsent] Initialized');
}

function finish(approved, { keepSidebar = false } = {}) {
  if (!pending) return;
  const { resolve, reject, sidebarWasOpen, offersAlways } = pending;
  pending = null;
  const alwaysAllow = offersAlways ? alwaysInput?.checked === true : undefined;
  alwaysRow?.classList.add('hidden');

  screen.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  // If the panel was opened just for this prompt, close it again rather
  // than leaving the wallet view behind (which may not even be enabled).
  if (!keepSidebar && !sidebarWasOpen) closeSidebar();

  if (approved) resolve(offersAlways ? { alwaysAllow } : undefined);
  else reject({ code: 4001, message: 'User rejected the request' });
}

function render({ title, origin, wants, allows, warning, approveLabel }) {
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
}

// What each of main's prompts says, from its view (design 0011, "What a
// prompt shows"): connecting has nothing of the page's; a seed or an unseed
// names its repository, as main checked it. A view off its form shows
// nothing.
const PAGE_COPY = Object.freeze({
  'radicle.connect': () => CONNECT_COPY,
  'radicle.node': (view) => {
    if (typeof view.rid !== 'string' || !view.rid) return null;
    if (view.method === 'radicle_seed') return seedCopy(view.rid);
    if (view.method === 'radicle_unseed') return unseedCopy(view.rid);
    return null;
  },
});

function clearPagePending() {
  pagePending = null;
  if (armTimer) clearTimeout(armTimer);
  armTimer = null;
  setButtonsDisabled([approveBtn, rejectBtn], false);
}

/**
 * Show main's prompt `{ handle, kind, site, view }`. While a prompt of the
 * chrome's own path holds the screen, main's waits: it is reported
 * displaced, and shows once the sidebar is free again.
 */
function showPagePrompt(prompt) {
  if (!screen || pagePending?.handle === prompt?.handle) return;
  const copy = PAGE_COPY[prompt?.kind]?.(prompt.view || {});
  if (!copy) return;
  if (pending) {
    pagePromptDisplaced(prompt.handle);
    return;
  }
  const sidebarWasOpen = pagePending ? pagePending.sidebarWasOpen : isSidebarVisible();
  clearPagePending();
  render({ ...copy, origin: prompt.site?.label || prompt.site?.key || 'Unknown' });
  alwaysRow?.classList.add('hidden');
  pagePending = { handle: prompt.handle, sidebarWasOpen, armed: false, deciding: false };
  presentingPagePrompt = true;
  try {
    hideAllSubscreens();
  } finally {
    presentingPagePrompt = false;
  }
  walletState.identityView?.classList.add('hidden');
  screen.classList.remove('hidden');
  openSidebarForConsent();
  // Input protection: a click that lands before the user could read the
  // prompt does nothing.
  setButtonsDisabled([approveBtn, rejectBtn], true);
  const shown = pagePending;
  armTimer = setTimeout(() => {
    armTimer = null;
    if (pagePending !== shown) return;
    shown.armed = true;
    setButtonsDisabled([approveBtn, rejectBtn], false);
  }, PROMPT_ARM_DELAY_MS);
}

function takeDownPage() {
  screen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
}

/** Main hid or closed its prompt `handle`: take it down. */
function closePagePrompt(handle) {
  if (!pagePending || pagePending.handle !== handle) return;
  clearPagePending();
  takeDownPage();
}

/** The handle of main's prompt on screen now, or null. */
function shownPagePrompt() {
  return pagePending && screen && !screen.classList.contains('hidden') ? pagePending.handle : null;
}

async function decidePage(approve, { keepSidebar = false, armedOrNot = false } = {}) {
  const current = pagePending;
  if (!current || current.deciding || (!current.armed && !armedOrNot)) return;
  current.deciding = true;
  const { handle, sidebarWasOpen } = current;
  clearPagePending();
  takeDownPage();
  if (!keepSidebar && !sidebarWasOpen) closeSidebar();
  try {
    await window.pagePrompts?.decide?.(handle, approve, {});
  } catch (err) {
    console.error('[RadicleConsent] The decision did not reach main:', err);
  }
}

/**
 * Show a consent prompt. Resolves on approve, rejects {code:4001} on
 * cancel/back/panel-close. Only one prompt can be active; a second request
 * while one is showing is rejected immediately (prevents prompt-queue
 * confusion from spammy pages).
 *
 * With `always: { label, checked }` the prompt also shows that checkbox,
 * and resolves to `{ alwaysAllow }`, its state when approved.
 */
function prompt({ title, origin, wants, allows, warning, approveLabel, owner, always = null }) {
  return new Promise((resolve, reject) => {
    if (!screen) {
      reject({ code: -32603, message: 'Consent UI unavailable' });
      return;
    }
    if (pending) {
      reject({ code: 4001, message: 'Another consent prompt is already open' });
      return;
    }

    render({ title, origin, wants, allows, warning, approveLabel });
    const offersAlways = Boolean(always && alwaysRow && alwaysInput);
    if (offersAlways) {
      if (alwaysLabel) alwaysLabel.textContent = always.label;
      alwaysInput.checked = always.checked === true;
      alwaysRow.classList.remove('hidden');
    } else {
      alwaysRow?.classList.add('hidden');
    }

    pending = { resolve, reject, sidebarWasOpen: isSidebarVisible(), owner, offersAlways };

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

const CONNECT_COPY = Object.freeze({
  title: 'Connect Radicle node?',
  wants: 'wants to interact with your Radicle node',
  allows: Object.freeze([
    'See node status and your seeded repositories',
    'Ask to seed or sync repositories (with approval)',
  ]),
  warning:
    'This site cannot write anything as you without a separate approval for your Radicle identity.',
  approveLabel: 'Connect',
});

export function showRadicleConnect(permissionKey, owner) {
  return prompt({ owner, origin: permissionKey, ...CONNECT_COPY });
}

function seedCopy(rid) {
  return {
    title: 'Seed this repository?',
    wants: `asks your node to seed ${rid}`,
    allows: [
      'Download the repository to your node',
      'Share it with the Radicle network from your node',
    ],
    warning: 'Seeding uses disk space and bandwidth until you unseed the repository.',
    approveLabel: 'Seed repository',
  };
}

function unseedCopy(rid) {
  return {
    title: 'Stop seeding this repository?',
    wants: `asks your node to stop seeding ${rid}`,
    allows: [
      'Remove the seeding policy for this repository',
      'Cancel any fetch of it still in progress',
    ],
    warning:
      'Your node stops sharing this repository with the Radicle network until you seed it again.',
    approveLabel: 'Stop seeding',
  };
}

export function showRadicleSeedApproval(permissionKey, rid, owner) {
  return prompt({ owner, origin: permissionKey, ...seedCopy(rid) });
}

export function showRadicleUnseedApproval(permissionKey, rid, owner) {
  return prompt({ owner, origin: permissionKey, ...unseedCopy(rid) });
}

export function showRadicleSigningApproval(permissionKey, owner) {
  return prompt({
    owner,
    title: 'Act as your Radicle identity?',
    origin: permissionKey,
    wants: 'wants to author content as your Radicle identity',
    allows: [
      'Know your Radicle DID and alias',
      'Ask to open issues, comment, and change issue states as you. You approve each one.',
    ],
    warning:
      'Everything it writes is signed with your Radicle identity, published to the Radicle network, and cannot be unpublished.',
    approveLabel: 'Allow',
  });
}

// What one signed write does, in the prompt's own words. Every parameter
// main signs with is shown — a parameter the prompt leaves out (a patch
// revision, a reply target, labels) is one the page could steer unseen.
// Page-supplied text only ever lands in textContent.
const shown = (value) => (value === undefined || value === null ? '' : String(value));

function describeSignedWrite(method, params = {}) {
  const rid = shown(params.rid);
  switch (method) {
    case 'radicle_createIssue': {
      const allows = [`Title: ${shown(params.title)}`, `Description: ${shown(params.description)}`];
      if (params.labels !== undefined) {
        const labels = Array.isArray(params.labels) ? params.labels : [params.labels];
        for (const label of labels) allows.push(`Label: ${shown(label)}`);
      }
      return {
        title: 'Open this issue as you?',
        wants: `asks to open an issue in ${rid}`,
        allows,
        approveLabel: 'Open issue',
      };
    }
    case 'radicle_commentIssue': {
      const allows = [`Comment: ${shown(params.body)}`];
      if (params.replyTo !== undefined) allows.push(`In reply to comment ${shown(params.replyTo)}`);
      return {
        title: 'Post this comment as you?',
        wants: `asks to comment on issue ${shown(params.issueId)} in ${rid}`,
        allows,
        approveLabel: 'Post comment',
      };
    }
    case 'radicle_editIssueState':
      return {
        title: 'Change this issue as you?',
        wants: `asks to change issue ${shown(params.issueId)} in ${rid}`,
        allows: [`Set its state to ${shown(params.state)}`],
        approveLabel: 'Change state',
      };
    case 'radicle_commentPatch': {
      // Main signs against revisionId when one is given, not patchId, so
      // the prompt names the revision that actually receives the comment.
      const target =
        params.revisionId !== undefined && params.revisionId !== params.patchId
          ? `revision ${shown(params.revisionId)} (the page says it belongs to patch ${shown(params.patchId)})`
          : `patch ${shown(params.patchId)}`;
      return {
        title: 'Post this comment as you?',
        wants: `asks to comment on ${target} in ${rid}`,
        allows: [`Comment: ${shown(params.body)}`],
        approveLabel: 'Post comment',
      };
    }
    default: {
      // A signed write this prompt has no wording for still shows every
      // parameter rather than borrowing another method's summary.
      let detail;
      try {
        detail = JSON.stringify(params);
      } catch {
        detail = '(unreadable parameters)';
      }
      return {
        title: 'Sign this as you?',
        wants: `asks to sign ${shown(method)} in ${rid}`,
        allows: [`Parameters: ${detail}`],
        approveLabel: 'Sign',
      };
    }
  }
}

const SIGNED_WRITE_WARNING =
  'This is signed with your Radicle identity and published to the Radicle network. It is public and permanent: it cannot be edited away or unpublished.';

/**
 * Per-write prompt: the user sees and approves the exact content before it
 * is signed (R-6). Outside Agent custody it also offers the site's "always
 * allow writes" rule, checked when the rule is already on (the prompt then
 * shows because main's rate limit stopped an automatic write), and resolves
 * to `{ alwaysAllow }`.
 */
export function showRadicleSignedWriteApproval(
  permissionKey,
  method,
  params,
  owner,
  { agentHeld = false, alwaysAllow = false } = {}
) {
  return prompt({
    owner,
    origin: permissionKey,
    ...describeSignedWrite(method, params),
    warning: agentHeld
      ? `Freedom Agent is using this tab. ${SIGNED_WRITE_WARNING}`
      : SIGNED_WRITE_WARNING,
    always: agentHeld
      ? null
      : {
          label: 'Always allow this site to write as you without asking (at most 50 writes a day)',
          checked: alwaysAllow,
        },
  });
}
