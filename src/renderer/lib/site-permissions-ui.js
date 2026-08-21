/**
 * Site Permissions UI
 *
 * Two chrome surfaces for per-site web permissions (camera, mic,
 * notifications, clipboard-read, geolocation, MIDI):
 *
 * 1. The permission prompt anchored under the address bar. Main queues
 *    requests per requesting webContents (tab) and sends one per tab at
 *    a time over `permissions:prompt-request`; each payload carries the
 *    requesting webview's webContents id (`guestId`) and is only shown
 *    while that tab is the active one — a background tab's request is
 *    held and surfaces when the user switches to it. The answer goes
 *    back via `permissions:prompt-response`. Dismissing (Esc, clicking
 *    away) denies once without recording anything. Navigation-driven
 *    invalidation is owned by main: it watches the REQUESTING
 *    webContents and withdraws its prompts via
 *    `permissions:prompt-cancel`, so navigating the active tab never
 *    dismisses a background tab's pending request.
 *
 * 2. The address-bar indicator + popover: a small icon when the current
 *    site holds granted permissions, listing decisions with quick revoke.
 *    Mirrors the ENS trust shield's popover interaction pattern.
 */

import { getActiveWebview, getDisplayUrlForWebview } from './tabs.js';
import { getPermissionKey } from './origin-utils.js';
import { pushDebug } from './debug.js';

// Storage-key → human noun (indicator popover, settings mirror this).
const PERMISSION_LABELS = {
  camera: 'Camera',
  microphone: 'Microphone',
  notifications: 'Notifications',
  'clipboard-read': 'Clipboard reading',
  geolocation: 'Location',
  midi: 'MIDI devices',
};

// Storage-key → prompt verb phrase ("example.com wants to <phrase>").
const PERMISSION_PHRASES = {
  camera: 'use your camera',
  microphone: 'use your microphone',
  notifications: 'show notifications',
  'clipboard-read': 'read text and images from your clipboard',
  geolocation: 'know your location',
  midi: 'use your MIDI devices',
};

export const permissionLabel = (key) => PERMISSION_LABELS[key] || key;

/**
 * Build the "wants to …" phrase for a prompt's storage keys.
 * Camera + microphone collapse into one natural sentence; anything
 * else joins with "and".
 *
 * @param {string[]} keys
 * @returns {string}
 */
export const describePermissionRequest = (keys = []) => {
  const unique = [...new Set(keys)];
  if (unique.includes('camera') && unique.includes('microphone')) {
    const rest = unique.filter((k) => k !== 'camera' && k !== 'microphone');
    const phrases = ['use your camera and microphone', ...rest.map((k) => PERMISSION_PHRASES[k] || `use ${k}`)];
    return phrases.join(' and ');
  }
  const phrases = unique.map((k) => PERMISSION_PHRASES[k] || `use ${k}`);
  return phrases.join(' and ') || 'use a device';
};

/**
 * Caveat line shown under the prompt sentence, or null.
 * Geolocation gets an honesty note: Electron lacks Chromium's network
 * location service, so grants may still not produce a position.
 *
 * @param {string[]} keys
 * @returns {string|null}
 */
export const permissionRequestNote = (keys = []) => {
  if (keys.includes('geolocation')) {
    return 'Location may not work reliably in Freedom.';
  }
  return null;
};

// DOM references
let promptEl;
let promptOriginEl;
let promptActionEl;
let promptNoteEl;
let promptRememberLabel;
let promptRememberCheckbox;
let promptAllowBtn;
let promptBlockBtn;
let indicatorBtn;
let popoverEl;
let popoverTitleEl;
let popoverListEl;

// Prompt state. Requests are tab-scoped: each carries the requesting
// webview's webContents id (`guestId`) and only shows while that tab is
// active; requests for background tabs are held in `pendingPrompts`
// until the user switches to the requesting tab. os-denied notices are
// window-scoped and always eligible. Entries:
// {type: 'request'|'os-denied', ...payload}.
let pendingPrompts = [];
let noticeQueue = [];
let activePrompt = null;

// Indicator state for the popover renderer.
let indicatorOrigin = null;
let indicatorDecisions = {};

const sitePermissions = () => window.sitePermissions;

const hidePromptElement = () => {
  if (promptEl) promptEl.hidden = true;
  activePrompt = null;
};

// webContents id of the active tab's webview, or null when unavailable
// (no tab yet, or the webview is not attached).
const activeGuestId = () => {
  const webview = getActiveWebview();
  if (!webview || typeof webview.getWebContentsId !== 'function') return null;
  try {
    return webview.getWebContentsId();
  } catch {
    return null;
  }
};

// Next prompt eligible for display: notices first (window-scoped), then
// the first held request whose requesting tab is the active one.
const takeNextPrompt = () => {
  if (noticeQueue.length > 0) return noticeQueue.shift();
  const guestId = activeGuestId();
  const index = pendingPrompts.findIndex(
    (p) => typeof p.guestId !== 'number' || p.guestId === guestId
  );
  if (index === -1) return null;
  return pendingPrompts.splice(index, 1)[0];
};

const showNextPrompt = () => {
  if (activePrompt || !promptEl) return;
  const next = takeNextPrompt();
  if (!next) return;
  activePrompt = next;

  const isNotice = activePrompt.type === 'os-denied';
  const keys = activePrompt.keys || activePrompt.permissions || [];

  if (isNotice) {
    const devices = keys.map((k) => permissionLabel(k).toLowerCase()).join(' and ');
    if (promptOriginEl) promptOriginEl.textContent = '';
    if (promptActionEl) {
      promptActionEl.textContent = `macOS is blocking Freedom's access to your ${devices || 'camera'}.`;
    }
    if (promptNoteEl) {
      promptNoteEl.textContent =
        'Allow Freedom under System Settings → Privacy & Security, then try again.';
      promptNoteEl.classList.remove('hidden');
    }
    promptRememberLabel?.classList.add('hidden');
    promptBlockBtn?.classList.add('hidden');
    if (promptAllowBtn) promptAllowBtn.textContent = 'OK';
  } else {
    if (promptOriginEl) promptOriginEl.textContent = activePrompt.origin || 'This site';
    if (promptActionEl) {
      promptActionEl.textContent = ` wants to ${describePermissionRequest(keys)}`;
    }
    const note = permissionRequestNote(keys);
    if (promptNoteEl) {
      promptNoteEl.textContent = note || '';
      promptNoteEl.classList.toggle('hidden', !note);
    }
    promptRememberLabel?.classList.remove('hidden');
    if (promptRememberCheckbox) promptRememberCheckbox.checked = true;
    promptBlockBtn?.classList.remove('hidden');
    if (promptAllowBtn) promptAllowBtn.textContent = 'Allow';
  }

  promptEl.hidden = false;
  pushDebug(
    isNotice
      ? `[permissions] showing macOS-denied notice (${keys.join('+')})`
      : `[permissions] prompt for ${activePrompt.origin}: ${keys.join('+')}`
  );
};

const respondToActivePrompt = (decision) => {
  if (!activePrompt) return;

  if (activePrompt.type === 'os-denied') {
    hidePromptElement();
    showNextPrompt();
    return;
  }

  const remember =
    decision !== 'dismiss' && promptRememberCheckbox ? promptRememberCheckbox.checked : false;
  const id = activePrompt.id;
  hidePromptElement();
  sitePermissions()
    ?.respondToPrompt({ id, decision, remember })
    .catch((err) => pushDebug(`[permissions] prompt response failed: ${err.message}`));
  showNextPrompt();
};

// Dismiss = deny once, nothing recorded (Esc, click-away). Safe to call
// when no prompt is showing.
const dismissActivePrompt = (reason = 'unknown') => {
  if (!activePrompt) return;
  pushDebug(`[permissions] prompt dismissed (${reason})`);
  respondToActivePrompt('dismiss');
};

const setPopoverOpen = (open) => {
  if (!popoverEl || !indicatorBtn) return;
  popoverEl.hidden = !open;
  indicatorBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
};

const renderPopover = () => {
  if (!popoverEl || !popoverTitleEl || !popoverListEl) return;

  popoverTitleEl.textContent = indicatorOrigin || '';
  popoverListEl.textContent = '';

  for (const [key, entry] of Object.entries(indicatorDecisions)) {
    const row = document.createElement('div');
    row.className = 'permission-popover-row';

    const label = document.createElement('div');
    label.className = 'permission-popover-row-label';

    const name = document.createElement('div');
    name.className = 'permission-popover-row-name';
    name.textContent = permissionLabel(key);

    const status = document.createElement('div');
    status.className = 'permission-popover-row-status';
    const scope = entry.remembered ? '' : ' (this session)';
    if (entry.decision === 'allow') {
      status.textContent = `Allowed${scope}`;
    } else {
      status.textContent = `Blocked${scope}`;
      status.classList.add('blocked');
    }

    label.appendChild(name);
    label.appendChild(status);

    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'permission-popover-revoke';
    revoke.textContent = 'Reset';
    revoke.setAttribute('aria-label', `Reset ${permissionLabel(key)} permission`);
    revoke.addEventListener('click', () => {
      const origin = indicatorOrigin;
      sitePermissions()
        ?.revoke(origin, key)
        .catch((err) => pushDebug(`[permissions] revoke failed: ${err.message}`));
    });

    row.appendChild(label);
    row.appendChild(revoke);
    popoverListEl.appendChild(row);
  }
};

/**
 * Recompute the indicator for the active tab's committed origin.
 * Shown when the site holds at least one granted permission (stored or
 * session-scoped); the popover lists blocks too once open.
 */
const refreshIndicator = async () => {
  if (!indicatorBtn) return;

  const webview = getActiveWebview();
  const displayUrl = webview ? getDisplayUrlForWebview(webview) : '';
  const origin = displayUrl ? getPermissionKey(displayUrl) : null;

  if (!origin || !sitePermissions()?.getForOrigin) {
    indicatorOrigin = null;
    indicatorDecisions = {};
    indicatorBtn.classList.add('hidden');
    setPopoverOpen(false);
    return;
  }

  let decisions = {};
  try {
    decisions = (await sitePermissions().getForOrigin(origin)) || {};
  } catch (err) {
    pushDebug(`[permissions] getForOrigin failed: ${err.message}`);
  }

  indicatorOrigin = origin;
  indicatorDecisions = decisions;

  const hasGrant = Object.values(decisions).some((entry) => entry?.decision === 'allow');
  indicatorBtn.classList.toggle('hidden', !hasGrant);

  if (!popoverEl?.hidden) {
    if (Object.keys(decisions).length === 0) {
      setPopoverOpen(false);
    } else {
      renderPopover();
    }
  }
};

export const initSitePermissionsUi = () => {
  promptEl = document.getElementById('permission-prompt');
  promptOriginEl = document.getElementById('permission-prompt-origin');
  promptActionEl = document.getElementById('permission-prompt-action');
  promptNoteEl = document.getElementById('permission-prompt-note');
  promptRememberLabel = document.getElementById('permission-prompt-remember-label');
  promptRememberCheckbox = document.getElementById('permission-prompt-remember');
  promptAllowBtn = document.getElementById('permission-prompt-allow');
  promptBlockBtn = document.getElementById('permission-prompt-block');
  indicatorBtn = document.getElementById('permission-indicator');
  popoverEl = document.getElementById('permission-popover');
  popoverTitleEl = document.getElementById('permission-popover-title');
  popoverListEl = document.getElementById('permission-popover-list');

  const api = sitePermissions();
  if (!api || !promptEl) {
    pushDebug('[permissions] site permissions UI unavailable (missing API or DOM)');
    return;
  }

  api.onPromptRequest((payload) => {
    if (!payload || typeof payload.id !== 'number') return;
    pendingPrompts.push({ type: 'request', ...payload });
    showNextPrompt();
  });

  // Main invalidated a request (its document navigated away or its
  // webContents died) — drop it without answering; main already denied.
  api.onPromptCancel?.((payload) => {
    const id = payload?.id;
    if (typeof id !== 'number') return;
    pendingPrompts = pendingPrompts.filter((p) => p.id !== id);
    if (activePrompt?.type === 'request' && activePrompt.id === id) {
      pushDebug('[permissions] prompt withdrawn by main (requester gone)');
      hidePromptElement();
      showNextPrompt();
    }
  });

  api.onOsDenied((payload) => {
    noticeQueue.push({ type: 'os-denied', ...(payload || {}) });
    showNextPrompt();
  });

  api.onChanged(() => {
    refreshIndicator();
  });

  promptAllowBtn?.addEventListener('click', () => respondToActivePrompt('allow'));
  promptBlockBtn?.addEventListener('click', () => respondToActivePrompt('deny'));

  indicatorBtn?.addEventListener('click', () => {
    if (!popoverEl) return;
    if (popoverEl.hidden) {
      renderPopover();
      setPopoverOpen(true);
    } else {
      setPopoverOpen(false);
    }
  });

  // Click-away / Esc dismissal, mirroring the trust popover's handlers.
  document.addEventListener('click', (e) => {
    if (activePrompt && !promptEl.hidden && !promptEl.contains(e.target)) {
      dismissActivePrompt('click-away');
    }
    if (popoverEl && !popoverEl.hidden) {
      if (!popoverEl.contains(e.target) && !(indicatorBtn && indicatorBtn.contains(e.target))) {
        setPopoverOpen(false);
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    dismissActivePrompt('escape');
    if (popoverEl && !popoverEl.hidden) setPopoverOpen(false);
  });

  // Focus loss only closes the indicator popover — never the prompt.
  // The guest <webview> takes focus asynchronously while its page
  // activates, and pages typically request permissions right after
  // load, so dismissing on blur deny-onces the prompt the page just
  // triggered via the blur from its own load stealing focus. Keeping
  // the prompt pending across focus changes matches Chrome and
  // Firefox; it still dismisses on click-away in the chrome and Esc,
  // is withdrawn by main when the requesting document navigates or
  // dies, and grants nothing by itself.
  window.addEventListener('blur', () => {
    setPopoverOpen(false);
  });

  // Navigation-driven invalidation lives in main (it watches the
  // REQUESTING webContents and sends prompt-cancel), so an active-tab
  // navigation never touches a background tab's pending request. This
  // event only refreshes the address-bar indicator.
  document.addEventListener('navigation-completed', () => {
    refreshIndicator();
  });

  // Prompts are tab-scoped: when the requesting tab goes to the
  // background its prompt is held (unanswered) and re-surfaces when the
  // user switches back; switching TO a tab shows its held prompt.
  document.addEventListener('active-tab-changed', () => {
    if (activePrompt && activePrompt.type === 'request') {
      pendingPrompts.unshift(activePrompt);
      hidePromptElement();
    }
    setPopoverOpen(false);
    refreshIndicator();
    // Surface the incoming tab's held prompt on the next task, never
    // inline. switchTab() dispatches active-tab-changed synchronously
    // from the tab strip's click handler, so showing the prompt here
    // would put it on screen mid-dispatch — the very same click then
    // reaches the document click-away listener below (target = the tab
    // element, outside promptEl) and deny-onces the request before the
    // user ever sees it. Deferring lets the click dispatch finish first.
    setTimeout(showNextPrompt, 0);
  });

  refreshIndicator();
};

// Test-only: reset module state between cases.
export const _resetForTests = () => {
  pendingPrompts = [];
  noticeQueue = [];
  activePrompt = null;
  indicatorOrigin = null;
  indicatorDecisions = {};
};
