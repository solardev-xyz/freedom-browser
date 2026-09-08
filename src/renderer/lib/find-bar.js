// In-page find bar (Cmd/Ctrl+F) — Chrome-style overlay anchored to the
// top-right of the webview area.
//
// The bar drives a tab's <webview> through Electron's findInPage()/
// stopFindInPage() API (case-insensitive Chromium find) and reads match
// counts back from the webview's `found-in-page` event.
//
// Find state is per tab, the way Chrome models it (`FindTabHelper` hangs
// off the WebContents, so every tab owns its query, its open/closed bar
// and its own match count). The bar element itself is a single piece of
// window chrome that renders whichever session belongs to the foreground
// tab; sessions for background tabs keep running, exactly as in Chrome,
// where switching back to a searched tab shows its bar and count again
// with the highlights still painted.
//
// Chrome's navigation rule (chrome/browser/ui/find_bar/
// find_bar_controller.cc, NavigationEntryCommitted) is: on a main-frame
// navigation to a different document, if the bar was visible when the
// navigation *started* the find session ends and the bar hides; if the
// user opened the bar after the navigation started the bar stays open but
// the search is stopped, so the previous origin's query is never re-run
// automatically. Same-document navigations leave everything alone. We
// mirror that here, with one implementation detail Chrome does not need:
// the outgoing document's highlights are cleared at did-start-navigation
// rather than at commit, because a document that reaches the back/forward
// cache with a live find session comes back — on Back — still painted
// (issue #300).
//
// tabs.js drives the four hooks below (tab switch, navigation start,
// navigation commit, tab close); sessions are keyed by the tab's webview
// element so this module never has to import tabs.js (which imports us).

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
// never imports tabs.js — tabs.js imports us for the per-tab hooks, and
// importing back would create a cycle.
let getActiveWebview = null;

// Per-tab find state, keyed by the tab's <webview> element. The key is the
// webview rather than a tab id because every hook tabs.js calls already has
// the element in hand, and a webview is 1:1 with the WebContents whose find
// session it owns.
const sessions = new Map();

// Key for the "no active webview yet" case (startup, a tab whose guest has
// not attached). The bar can still be opened and typed into; the session
// simply has nothing to search.
const NO_WEBVIEW = Symbol('find-bar-no-webview');

const createSession = () => ({
  // Find UI active for this tab (Chrome's find_ui_active).
  open: false,
  // Text in the bar. Survives navigation and close so re-opening prepopulates
  // it, like Chrome.
  query: '',
  // The query actually handed to findInPage; '' means no live session, so
  // Enter starts a fresh search instead of findNext-ing a dead one.
  submitted: '',
  // The webview a live session runs against (null when stopped).
  webview: null,
  // The `found-in-page` listener bound to this session.
  listener: null,
  // Last result rendered for this tab: { active, matches } or null.
  result: null,
  // Chrome's close_find_bar_on_navigation_commit_: whether the bar was
  // visible when the pending navigation started. null = no navigation
  // pending.
  closeOnCommit: null,
});

const sessionKey = (webview) => webview || NO_WEBVIEW;

const getSession = (webview, { create = false } = {}) => {
  const key = sessionKey(webview);
  let session = sessions.get(key);
  if (!session && create) {
    session = createSession();
    sessions.set(key, session);
  }
  return session || null;
};

const activeWebview = () => getActiveWebview?.() || null;

const activeSession = () => getSession(activeWebview());

let debounceTimer = null;

// Monotonic id for selection-prefill requests. The selection read is
// asynchronous, so by the time it resolves the world may have moved on;
// only the latest request is allowed to apply its result.
let prefillGeneration = 0;

// Paint a result (or the blank "no live results" state) into the bar. Only
// ever called for the foreground tab's session — a background tab's count
// updates its own session object and is rendered when the user switches
// back to it.
const paintResult = (result) => {
  const matches = result?.matches ?? 0;
  if (findCount) {
    findCount.textContent = result ? `${result.active}/${matches}` : '';
  }
  findInput?.classList.toggle('find-bar-input--no-matches', !!result && matches === 0);
  const disabled = !result || matches === 0;
  if (prevBtn) prevBtn.disabled = disabled;
  if (nextBtn) nextBtn.disabled = disabled;
};

// Render whichever session belongs to the foreground tab into the shared
// bar element: hidden when that tab has no open bar, otherwise its own
// query and its own count.
const renderActiveSession = () => {
  if (!findBarEl || !findInput) return;
  const session = activeSession();
  if (!session || !session.open) {
    findBarEl.hidden = true;
    paintResult(null);
    return;
  }
  findBarEl.hidden = false;
  findInput.value = session.query;
  paintResult(session.result);
};

const handleFoundInPage = (session) => (event) => {
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
  session.result = {
    active: matches === 0 ? 0 : (result.activeMatchOrdinal ?? 0),
    matches,
  };
  if (session === activeSession()) {
    paintResult(session.result);
  }
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

// End a tab's find session: detach the result listener and tell Chromium to
// stop finding. `clearHighlights` is only skipped for a webview that is
// already gone (tab closed), where the call would throw anyway.
//
// Chrome ends a session with SelectionAction::kKeep (the active match stays
// selected as ordinary text); we use 'clearSelection' so closing leaves no
// visible residue at all, which is what issue #300 asks for.
const stopSession = (session, { clearHighlights = true } = {}) => {
  if (!session) return;
  session.submitted = '';
  session.result = null;
  const webview = session.webview;
  if (!webview) return;
  session.webview = null;
  if (session.listener) {
    webview.removeEventListener('found-in-page', session.listener);
    session.listener = null;
  }
  if (!clearHighlights) return;
  try {
    webview.stopFindInPage('clearSelection');
  } catch (err) {
    pushDebug(`[FindBar] stopFindInPage failed: ${err.message}`);
  }
};

// Stop a tab's live search because its page is going away, keeping the bar
// and its query as they are — whether the bar closes is decided at commit.
// Shared by the navigation-start and navigation-commit hooks so a
// navigation that never reports a start still ends the session exactly once.
const endSessionForNavigation = (session) => {
  // The debounce and prefill timers are window-global because only the
  // foreground tab can own them — a background tab's navigation must leave
  // them alone.
  const isForeground = session === activeSession();
  if (isForeground) {
    // A queued find-as-you-type would otherwise fire against the incoming
    // document and resurrect the session the navigation just ended.
    cancelPendingFind();
    // The webview object survives navigation, so the prefill guards can't
    // see the document change — invalidate any in-flight selection read
    // explicitly, or a selection from the old document could still apply.
    cancelPendingPrefill();
  }
  if (!session.webview) return;
  stopSession(session);
  if (isForeground) {
    paintResult(null);
  }
};

// Start (or restart) a find session for `query` on the active webview.
// An empty query ends the session and blanks the counter.
const startFind = (query) => {
  const webview = activeWebview();
  const session = getSession(webview, { create: true });
  session.query = query;
  if (!webview) return;
  if (!query) {
    stopSession(session);
    paintResult(null);
    return;
  }
  if (!session.webview) {
    session.listener = handleFoundInPage(session);
    webview.addEventListener('found-in-page', session.listener);
    session.webview = webview;
  }
  session.submitted = query;
  try {
    webview.findInPage(query);
  } catch (err) {
    pushDebug(`[FindBar] findInPage failed: ${err.message}`);
  }
};

// Advance to the next/previous match, falling back to a fresh search when
// the query changed since the last submission or the session was reset
// (navigation) — findNext on a dead session silently no-ops.
const findNext = (forward) => {
  // Enter / prev / next all submit the query the user can see; a selection
  // read still in flight must not overwrite it afterwards.
  cancelPendingPrefill();
  const query = findInput?.value || '';
  if (!query) return;
  const session = activeSession();
  if (!session?.webview || query !== session.submitted) {
    startFind(query);
    return;
  }
  try {
    session.webview.findInPage(query, { forward, findNext: true });
  } catch (err) {
    pushDebug(`[FindBar] findInPage failed: ${err.message}`);
  }
};

// Prefill the input from the page's current text selection (Chrome
// behavior). Fire-and-forget: if the page can't answer (still loading,
// crashed renderer) the bar keeps whatever query it already had.
const prefillFromSelection = async () => {
  const webview = activeWebview();
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
  // navigated (which bumps the generation — see the navigation hooks).
  // Applying the stale result then would rewrite the input and start a
  // find session against the wrong page.
  if (generation !== prefillGeneration || !isFindBarOpen() || activeWebview() !== webview) {
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
  const session = getSession(activeWebview(), { create: true });
  session.open = true;
  findBarEl.hidden = false;
  // Re-opening keeps this tab's previous query selected so typing replaces
  // it and Enter re-runs it; a live page selection (below) wins over both.
  findInput.value = session.query;
  paintResult(session.result);
  findInput.focus();
  findInput.select();
  prefillFromSelection();
  if (!wasOpen) {
    pushDebug('[FindBar] opened');
  }
};

// Close the bar for the foreground tab (Esc or the close button) and clear
// that page's highlights. Other tabs' sessions are untouched.
export const closeFindBar = () => {
  // Before the open check: a close must never leave a queued search behind,
  // whatever state the bar is in.
  cancelPendingFind();
  cancelPendingPrefill();
  if (!findBarEl || findBarEl.hidden) return;
  const webview = activeWebview();
  const session = getSession(webview);
  if (session) {
    session.open = false;
    stopSession(session);
  }
  paintResult(null);
  findBarEl.hidden = true;
  // Focus returns to the searched page (Chrome restores focus to the page
  // content when the find session ends).
  if (webview) {
    try {
      webview.focus();
    } catch {
      // Webview may already be detached (tab closed mid-session).
    }
  }
  pushDebug('[FindBar] closed');
};

// Called by tabs.js after the foreground tab changed. Find state travels
// with the tab, so this only re-renders: the incoming tab's bar, query and
// count. The outgoing tab keeps its session — including its highlights —
// so switching back shows exactly what the user left there, as Chrome does.
export const notifyFindBarTabSwitched = () => {
  // The pending find-as-you-type keystrokes belong to the tab the user just
  // left; running them now would search the incoming tab instead.
  cancelPendingFind();
  cancelPendingPrefill();
  renderActiveSession();
};

// Called by tabs.js on `did-start-navigation` for a main-frame,
// cross-document navigation, before the new document commits.
//
// Two things happen here. First, Chrome's race rule: it records whether the
// find bar was visible when the navigation started, and only closes the bar
// at commit if it was (a bar opened *during* the load is the user asking to
// search the incoming page). Second, the live search is stopped while the
// outgoing document is still the current one — Chromium keeps a
// back/forward-cached document's find highlights painted, so a session that
// is merely abandoned comes back on Back with stale highlights and no bar
// (issue #300).
export const notifyFindBarNavigationStarted = (webview) => {
  // Created even for a tab that has never opened the bar: the recorded
  // "was it visible when this navigation started?" answer is what lets a
  // bar opened mid-load survive the commit.
  const session = getSession(webview, { create: true });
  if (session.closeOnCommit === null) {
    session.closeOnCommit = session.open;
  }
  endSessionForNavigation(session);
};

// Called by tabs.js when a tab commits a main-frame navigation (its
// `did-navigate`). Ends the find session Chrome-style: the bar closes if it
// was open when the navigation started, and stays open — with the search
// stopped — if the user opened it mid-load. The query survives either way,
// so re-opening prepopulates it.
export const notifyFindBarNavigated = (webview) => {
  const session = getSession(webview);
  if (!session) return;
  // `value_or(true)` in Chrome's terms: a navigation that never reported a
  // start (or one that started before the bar existed) closes the bar.
  const closeBar = session.closeOnCommit !== false;
  session.closeOnCommit = null;
  // No-op when did-start-navigation already ended the session; covers the
  // navigations that never report a start.
  endSessionForNavigation(session);
  if (closeBar) {
    session.open = false;
  }
  if (session === activeSession()) {
    renderActiveSession();
  }
};

// Called by tabs.js when a tab is closed: drop its find state instead of
// keeping the (now detached) webview alive in the session map.
export const notifyFindBarTabClosed = (webview) => {
  const session = getSession(webview);
  if (!session) return;
  const wasForeground = !!webview && webview === activeWebview();
  // The guest is being torn down — stopFindInPage on it would only throw.
  stopSession(session, { clearHighlights: false });
  sessions.delete(sessionKey(webview));
  if (wasForeground) {
    renderActiveSession();
  }
};

export const initFindBar = ({ getActiveWebview: getWebview } = {}) => {
  getActiveWebview = getWebview || null;
  sessions.clear();
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
    // Keep the tab's stored query in step with every keystroke, not just
    // with the ones that survive the debounce: anything that re-renders the
    // bar (a navigation commit, a tab switch) paints session.query back
    // into the input and would otherwise undo what was typed since the last
    // search.
    const typingSession = getSession(activeWebview(), { create: true });
    typingSession.query = findInput.value;
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

  paintResult(null);
};
