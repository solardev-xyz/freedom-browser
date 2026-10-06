/**
 * Pop-up-blocked icon (#442).
 *
 * Main's popup blocker (src/main/popup-blocker.js) refuses a tab page's
 * `window.open` / scripted `target="_blank"` that came without a user
 * gesture, and tells this window over `popups:blocked`
 * ({guestId, url, targetName, reuseOnly, origin}). This module keeps the
 * blocked popups per tab and shows a small icon in the address bar while the
 * active tab has any. Its popover lists them (capped), each with "Open", and
 * offers "Always allow pop-ups on this site" — the `popups` site permission,
 * which then shows in the permission indicator and in Settings > Privacy
 * and security > Site Permissions, where it is removed.
 *
 * Like Chrome, the list belongs to the page: a committed main-frame
 * navigation of that tab clears it. "Open" opens the popup as a tab, exactly
 * as if it had been allowed; it is a chrome action, so it does not go through
 * the gate again.
 *
 * A blocked plain named-target open (`reuseOnly`) is first offered to the
 * tab that already carries that name: Chrome needs no gesture to navigate an
 * existing named browsing context, only to create one. Only when there is no
 * such tab (or it isn't this tab's to navigate) is it recorded as blocked.
 */

import { getActiveTab, getTabByGuestId, openInNewTabWithTarget } from './tabs.js';
import { isModalDialogOpen } from './modal-dialog.js';
import { pushDebug } from './debug.js';
import { boundPopoverToViewport } from './popover-bounds.js';

// How many blocked popups the popover lists; the rest are counted.
export const MAX_LISTED_POPUPS = 5;

// Blocked popups per tab object (a closed tab's entry goes with it):
// { origin, entries: [{ url, targetName }], total, allowed }
let blockedByTab = new WeakMap();
// Webviews whose navigation already clears their tab's list.
let watchedWebviews = new WeakSet();

let indicatorBtn;
let popoverEl;
let originEl;
let listEl;
let moreEl;
let allowBtn;
let allowedEl;

const setPopoverOpen = (open) => {
  if (!popoverEl || !indicatorBtn) return;
  popoverEl.hidden = !open;
  indicatorBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    popoverEl.scrollTop = 0;
    boundPopoverToViewport(popoverEl);
  }
};

// For the chrome's shared dismissal paths (index.js), like
// `closePermissionPopover`.
export const closePopupBlockedPopover = () => {
  if (popoverEl && !popoverEl.hidden) setPopoverOpen(false);
};

/**
 * The blocked-popup state of a tab, or null when it has none.
 * @param {object} tab
 */
export const getBlockedPopups = (tab) => (tab ? blockedByTab.get(tab) || null : null);

const clearTab = (tab) => {
  if (!blockedByTab.has(tab)) return;
  blockedByTab.delete(tab);
  if (getActiveTab() === tab) refresh();
};

// A committed cross-document navigation of the tab's main frame replaces the
// page that tried to open the popups, so its list goes (Chrome does the same).
// `did-navigate` on the <webview> is exactly that event: same-document and
// subframe commits have their own.
const watchNavigation = (tab) => {
  const webview = tab.webview;
  if (!webview || watchedWebviews.has(webview)) return;
  watchedWebviews.add(webview);
  webview.addEventListener('did-navigate', () => clearTab(tab));
};

const renderPopover = (state) => {
  if (!listEl) return;
  if (originEl) originEl.textContent = state?.origin || '';
  listEl.replaceChildren();
  for (const [index, entry] of (state?.entries || []).entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'popup-blocked-open';
    button.dataset.test = 'popup-blocked-open';
    // The whole URL, so it can be read before it is opened.
    button.textContent = `Open ${entry.url}`;
    button.addEventListener('click', () => openBlocked(index));
    listEl.appendChild(button);
  }
  const unlisted = (state?.total || 0) - (state?.entries?.length || 0);
  if (moreEl) {
    moreEl.textContent =
      unlisted > 0 ? `and ${unlisted} more blocked pop-up${unlisted === 1 ? '' : 's'}` : '';
    moreEl.classList.toggle('hidden', unlisted <= 0);
  }
  // No site to allow (a page with no site origin) → no allow action.
  const canAllow = !!state?.origin && !state.allowed;
  allowBtn?.classList.toggle('hidden', !canAllow);
  allowedEl?.classList.toggle('hidden', !state?.allowed);
};

/**
 * Show or hide the icon for the active tab, and keep an open popover current.
 */
export const refresh = () => {
  if (!indicatorBtn) return;
  const state = getBlockedPopups(getActiveTab());
  const show = !!state && (state.entries.length > 0 || state.total > 0);
  indicatorBtn.classList.toggle('hidden', !show);
  if (!show) {
    setPopoverOpen(false);
    return;
  }
  const count = state.total;
  const label = count === 1 ? 'Pop-up blocked' : `${count} pop-ups blocked`;
  indicatorBtn.setAttribute('aria-label', label);
  indicatorBtn.title = label;
  if (!popoverEl?.hidden) renderPopover(state);
};

// "Open <url>": open the blocked popup as a tab, as if it had been allowed.
function openBlocked(index) {
  const tab = getActiveTab();
  const state = getBlockedPopups(tab);
  const entry = state?.entries[index];
  if (!entry) return;
  state.entries.splice(index, 1);
  state.total = Math.max(0, state.total - 1);
  pushDebug(`[popups] opening blocked pop-up ${entry.url}`);
  openInNewTabWithTarget(entry.url, entry.targetName || null, { openerTabId: tab.id });
  if (state.entries.length === 0) {
    // Everything listed has been opened; the unlisted rest can't be reached
    // from here any more, so the icon has done its job.
    blockedByTab.delete(tab);
  }
  refresh();
}

async function allowSite() {
  const tab = getActiveTab();
  const state = getBlockedPopups(tab);
  if (!state?.origin) return;
  let allowed = false;
  try {
    allowed = (await window.sitePermissions?.allowPopups?.(state.origin)) === true;
  } catch (err) {
    pushDebug(`[popups] always-allow failed: ${err.message}`);
  }
  if (!allowed) return;
  // The allow covers the whole site from now on; the popover says so, and
  // the blocked popups already listed stay available to open.
  state.allowed = true;
  refresh();
}

/**
 * Handle one `popups:blocked` report from main.
 * @param {{guestId:number, url:string, targetName?:string|null,
 *          reuseOnly?:boolean, origin?:string|null}} payload
 */
export const handlePopupBlocked = (payload) => {
  const url = typeof payload?.url === 'string' ? payload.url : '';
  if (!url) return;
  const tab = getTabByGuestId(payload.guestId);
  if (!tab) return;
  const targetName =
    typeof payload.targetName === 'string' && payload.targetName ? payload.targetName : null;

  if (payload.reuseOnly === true && targetName) {
    const reused = openInNewTabWithTarget(url, targetName, {
      reuseOnly: true,
      openerTabId: tab.id,
    });
    if (reused) return;
  }

  watchNavigation(tab);
  let state = blockedByTab.get(tab);
  if (!state) {
    state = { origin: null, entries: [], total: 0, allowed: false };
    blockedByTab.set(tab, state);
  }
  if (typeof payload.origin === 'string' && payload.origin) state.origin = payload.origin;
  state.total += 1;
  if (state.entries.length < MAX_LISTED_POPUPS) state.entries.push({ url, targetName });
  pushDebug(`[popups] blocked a pop-up in tab ${tab.id}`);
  if (getActiveTab() === tab) refresh();
};

export const initPopupBlockerUi = () => {
  indicatorBtn = document.getElementById('popup-blocked-indicator');
  popoverEl = document.getElementById('popup-blocked-popover');
  originEl = document.getElementById('popup-blocked-origin');
  listEl = document.getElementById('popup-blocked-list');
  moreEl = document.getElementById('popup-blocked-more');
  allowBtn = document.getElementById('popup-blocked-allow');
  allowedEl = document.getElementById('popup-blocked-allowed');
  if (!indicatorBtn || !popoverEl) {
    pushDebug('[popups] pop-up-blocked icon unavailable (missing DOM)');
    return;
  }

  window.electronAPI?.onPopupBlocked?.(handlePopupBlocked);

  indicatorBtn.addEventListener('click', () => {
    if (popoverEl.hidden) {
      renderPopover(getBlockedPopups(getActiveTab()));
      setPopoverOpen(true);
    } else {
      setPopoverOpen(false);
    }
  });
  allowBtn?.addEventListener('click', () => {
    allowSite();
  });

  // Click-away / Esc / focus loss, as for the permission indicator's popover.
  // The "Open" buttons are inside the popover and close it only through the
  // refresh that follows (when nothing is left to list).
  document.addEventListener('click', (e) => {
    if (isModalDialogOpen() || popoverEl.hidden) return;
    if (!popoverEl.contains(e.target) && !indicatorBtn.contains(e.target)) {
      setPopoverOpen(false);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || isModalDialogOpen() || popoverEl.hidden) return;
    e.preventDefault();
    setPopoverOpen(false);
  });
  window.addEventListener('blur', () => setPopoverOpen(false));

  document.addEventListener('active-tab-changed', () => {
    setPopoverOpen(false);
    refresh();
  });

  refresh();
};

// Test-only: reset module state between cases.
export const _resetForTests = () => {
  blockedByTab = new WeakMap();
  watchedWebviews = new WeakSet();
  indicatorBtn = popoverEl = originEl = listEl = moreEl = allowBtn = allowedEl = undefined;
};
