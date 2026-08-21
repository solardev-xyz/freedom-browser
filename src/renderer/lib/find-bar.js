// In-page find bar (Cmd/Ctrl+F) — Chrome-style overlay anchored to the
// top-right of the webview area.
//
// The bar drives the active tab's <webview> through Electron's
// findInPage()/stopFindInPage() API (case-insensitive Chromium find) and
// reads match counts back from the webview's `found-in-page` event.
//
// Find state is deliberately window-global rather than per-tab: switching
// tabs closes the bar and clears the outgoing page's highlights, and a
// navigation in the active tab resets the result count while keeping the
// query, so Enter re-runs the search on the new page. tabs.js calls the
// two exported reset hooks (closeFindBar / notifyFindBarNavigated) from
// its tab-switch and did-navigate paths.

import { pushDebug } from './debug.js';
import { matchesShortcut } from './shortcuts.js';

// Debounce for find-as-you-type. Exported so the unit tests advance fake
// timers by the real value instead of a magic number.
export const FIND_DEBOUNCE_MS = 200;

// Cap when prefilling the input from the page's text selection — huge or
// multi-line selections are almost never what the user wants to search for.
const MAX_PREFILL_LENGTH = 256;

// DOM elements (initialized in initFindBar)
let findBarEl = null;
let findInput = null;
let findCount = null;
let prevBtn = null;
let nextBtn = null;
let closeBtn = null;

// Resolves the active tab's <webview>. Injected by index.js so this module
// never imports tabs.js — tabs.js imports us for the tab-switch/navigation
// resets, and importing back would create a cycle.
let getActiveWebview = null;

// The webview the current find session runs against, captured when the
// session starts. Close/clear must talk to the webview that owns the
// highlights even if the active tab already changed (switchTab flips
// activeTabId before its cleanup hooks run).
let sessionWebview = null;

// The last query actually submitted to findInPage. Reset whenever the
// session ends (close, tab switch, navigation) so the next Enter starts a
// fresh search instead of findNext-ing a dead session.
let submittedQuery = '';

let debounceTimer = null;

// Monotonic id for selection-prefill requests. The selection read is
// asynchronous, so by the time it resolves the world may have moved on;
// only the latest request is allowed to apply its result.
let prefillGeneration = 0;

const handleFoundInPage = (event) => {
  const result = event.result || {};
  // Chromium streams interim updates while it scans; render them all so
  // long pages show the count converging, the finalUpdate lands last.
  const matches = result.matches ?? 0;
  // Interim events may carry activeMatchOrdinal 0 while matches is already
  // counted — painting "0/N" reads as a bug. Hold those until the ordinal
  // arrives (the finalUpdate always carries it).
  if (!result.finalUpdate && matches > 0 && !(result.activeMatchOrdinal > 0)) {
    return;
  }
  const active = matches === 0 ? 0 : (result.activeMatchOrdinal ?? 0);
  if (findCount) {
    findCount.textContent = `${active}/${matches}`;
  }
  findInput?.classList.toggle('find-bar-input--no-matches', matches === 0);
  if (prevBtn) prevBtn.disabled = matches === 0;
  if (nextBtn) nextBtn.disabled = matches === 0;
};

// Drop a scheduled find-as-you-type run. Anything that submits or ends the
// session must call this first: a timer that survives fires startFind()
// against whatever webview is active *then*, resurrecting a session the
// user already dismissed (highlights + found-in-page listener with no
// visible bar) or searching the tab they just switched to.
const cancelPendingFind = () => {
  if (!debounceTimer) return;
  clearTimeout(debounceTimer);
  debounceTimer = null;
};

// Invalidate any in-flight selection prefill. The selection read is async
// and can resolve hundreds of milliseconds after the bar opened, by which
// time the user may already have stated their own query — typing one, or
// submitting the visible one with Enter/prev/next. The user's intent always
// wins over a selection captured before they acted, so every such action
// bumps the generation and the late read is dropped in prefillFromSelection.
const cancelPendingPrefill = () => {
  prefillGeneration++;
};

// Blank counter, no error tint, prev/next disabled — the "no live results"
// presentation used when the bar opens, the query empties, or the page
// navigates away from the highlighted results.
const resetResultUi = () => {
  if (findCount) findCount.textContent = '';
  findInput?.classList.remove('find-bar-input--no-matches');
  if (prevBtn) prevBtn.disabled = true;
  if (nextBtn) nextBtn.disabled = true;
};

// End the current find session. `clearHighlights` is skipped on navigation
// resets — Chromium already dropped the old page's highlights, and calling
// stopFindInPage mid-load can race the new document.
const detachSession = ({ clearHighlights = true } = {}) => {
  submittedQuery = '';
  if (!sessionWebview) return;
  const webview = sessionWebview;
  sessionWebview = null;
  webview.removeEventListener('found-in-page', handleFoundInPage);
  if (!clearHighlights) return;
  try {
    webview.stopFindInPage('clearSelection');
  } catch (err) {
    pushDebug(`[FindBar] stopFindInPage failed: ${err.message}`);
  }
};

// Start (or restart) a find session for `query` on the active webview.
// An empty query ends the session and blanks the counter.
const startFind = (query) => {
  const webview = getActiveWebview?.();
  if (!webview) return;
  if (sessionWebview && sessionWebview !== webview) {
    detachSession();
  }
  if (!query) {
    detachSession();
    resetResultUi();
    return;
  }
  if (sessionWebview !== webview) {
    webview.addEventListener('found-in-page', handleFoundInPage);
    sessionWebview = webview;
  }
  submittedQuery = query;
  try {
    webview.findInPage(query);
  } catch (err) {
    pushDebug(`[FindBar] findInPage failed: ${err.message}`);
  }
};

// Advance to the next/previous match, falling back to a fresh search when
// the query changed since the last submission or the session was reset
// (navigation, tab switch) — findNext on a dead session silently no-ops.
const findNext = (forward) => {
  // Enter / prev / next all submit the query the user can see; a selection
  // read still in flight must not overwrite it afterwards.
  cancelPendingPrefill();
  const query = findInput?.value || '';
  if (!query) return;
  if (!sessionWebview || query !== submittedQuery) {
    startFind(query);
    return;
  }
  try {
    sessionWebview.findInPage(query, { forward, findNext: true });
  } catch (err) {
    pushDebug(`[FindBar] findInPage failed: ${err.message}`);
  }
};

// Prefill the input from the page's current text selection (Chrome
// behavior). Fire-and-forget: if the page can't answer (still loading,
// crashed renderer) the bar keeps whatever query it already had.
const prefillFromSelection = async () => {
  const webview = getActiveWebview?.();
  if (!webview || typeof webview.executeJavaScript !== 'function' || !findInput) return;
  const generation = ++prefillGeneration;
  let selection;
  try {
    selection = await webview.executeJavaScript('window.getSelection().toString()');
  } catch {
    return;
  }
  // The read can resolve after the world moved on: the bar closed, a later
  // open superseded this request, the active tab changed, or the page
  // navigated (which bumps the generation — see notifyFindBarNavigated).
  // Applying the stale result then would rewrite the input and start a
  // find session against the wrong page.
  if (generation !== prefillGeneration || !isFindBarOpen() || getActiveWebview?.() !== webview) {
    return;
  }
  if (typeof selection !== 'string') return;
  const text = selection.replace(/\s+/g, ' ').trim().slice(0, MAX_PREFILL_LENGTH);
  if (!text || text === findInput.value) return;
  findInput.value = text;
  findInput.select();
  startFind(text);
};

export const isFindBarOpen = () => !!findBarEl && !findBarEl.hidden;

export const openFindBar = () => {
  if (!findBarEl || !findInput) return;
  const wasOpen = !findBarEl.hidden;
  findBarEl.hidden = false;
  // Re-opening keeps the previous query selected so typing replaces it and
  // Enter re-runs it; a live page selection (below) wins over both.
  findInput.focus();
  findInput.select();
  prefillFromSelection();
  if (!wasOpen) {
    pushDebug('[FindBar] opened');
  }
};

// Close the bar and clear the searched page's highlights. Also the
// per-tab reset: tabs.js calls this on every tab switch so find state
// never leaks across tabs.
export const closeFindBar = () => {
  // Before the open check: a close must never leave a queued search behind,
  // whatever state the bar is in.
  cancelPendingFind();
  if (!findBarEl || findBarEl.hidden) return;
  // Captured before detachSession nulls it: focus returns to the searched
  // page, but only when it is still the foreground tab (on tab-switch
  // closes it isn't, and stealing focus there would break the switch).
  // With no session (bar opened, nothing searched) fall back to the active
  // webview so closing doesn't strand focus on the hidden bar's input.
  const searchedWebview = sessionWebview || getActiveWebview?.();
  detachSession();
  resetResultUi();
  findBarEl.hidden = true;
  if (searchedWebview && searchedWebview === getActiveWebview?.()) {
    try {
      searchedWebview.focus();
    } catch {
      // Webview may already be detached (tab closed mid-session).
    }
  }
  pushDebug('[FindBar] closed');
};

// Called by tabs.js when the active tab commits a navigation. Chromium
// drops the old page's highlights itself; ending the session here clears
// the stale match count while the query stays in the input, so Enter (or
// typing) starts a fresh search against the new page.
export const notifyFindBarNavigated = () => {
  if (!isFindBarOpen()) return;
  // Navigation keeps the same webview object, so the prefill guards can't
  // see the document change — invalidate any in-flight selection read
  // explicitly, or a selection from the old document could still apply.
  cancelPendingPrefill();
  detachSession({ clearHighlights: false });
  resetResultUi();
};

export const initFindBar = ({ getActiveWebview: getWebview } = {}) => {
  getActiveWebview = getWebview || null;
  findBarEl = document.getElementById('find-bar');
  findInput = document.getElementById('find-bar-input');
  findCount = document.getElementById('find-bar-count');
  prevBtn = document.getElementById('find-bar-prev');
  nextBtn = document.getElementById('find-bar-next');
  closeBtn = document.getElementById('find-bar-close');
  if (!findBarEl || !findInput) return;

  // Find-as-you-type, debounced so fast typers don't spam findInPage.
  findInput.addEventListener('input', () => {
    // The user is typing their own query — drop any selection prefill still
    // in flight so a slow read can't rewrite what they just typed.
    cancelPendingPrefill();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      startFind(findInput.value);
    }, FIND_DEBOUNCE_MS);
  });

  findInput.addEventListener('keydown', (event) => {
    // During an IME composition session Enter commits and Escape cancels
    // the composition itself — neither may act on the find bar (keyCode
    // 229 is the legacy in-composition marker some engines report).
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      // Cancel a pending find-as-you-type run; findNext falls back to a
      // fresh search itself when the visible query was never submitted.
      cancelPendingFind();
      findNext(!event.shiftKey);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // Keep the Escape from also triggering the document-level handlers
      // (context-menu dismissal, address bar restore).
      event.stopPropagation();
      closeFindBar();
    }
  });

  // Same "submit" action class as Enter — cancel the pending
  // find-as-you-type run so it can't restart the session right after
  // the button advanced the active match.
  prevBtn?.addEventListener('click', () => {
    cancelPendingFind();
    findNext(false);
  });
  nextBtn?.addEventListener('click', () => {
    cancelPendingFind();
    findNext(true);
  });
  closeBtn?.addEventListener('click', () => closeFindBar());

  // Cmd/Ctrl+F fallback for when focus is in the browser chrome. With the
  // page itself focused the keystroke lands inside the webview and reaches
  // us via the Edit-menu accelerator instead (main → find:open → below).
  window.addEventListener('keydown', (event) => {
    if (matchesShortcut(event, 'page.findInPage')) {
      event.preventDefault();
      openFindBar();
    }
  });

  // Edit menu / accelerator (main process → renderer).
  window.electronAPI?.onOpenFindBar?.(() => openFindBar());

  resetResultUi();
};
