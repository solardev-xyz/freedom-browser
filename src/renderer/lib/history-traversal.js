// Back/forward history traversal for a guest webview, and the mark that lets
// a navigation commit be recognised as the one a traversal asked for (#86).
//
// Traversal itself stays Chromium's: these helpers call `goBack()`/
// `goForward()` exactly as the call sites did before, so the historical entry
// is restored and unsubmitted address-bar text is never navigated to. The only
// thing added is a per-webview mark, consumed by the commit that follows, so
// `navigation.js` can re-verify an ENS-backed restored entry under today's
// verification settings instead of leaving the trust badge on whatever method
// was configured when the entry first loaded.
//
// The mark lives here, in a leaf module, rather than on `tabs.js`'
// `navigationState`: `page-context-menu.js` is one of the two traversal call
// sites and deliberately does not import `tabs.js` (it resolves the active
// guest off the DOM), and `tabs.js` already imports `page-context-menu.js`, so
// putting the setter there would close an import cycle.
//
// A `WeakSet` keyed by the `<webview>` element needs no teardown when a tab
// closes, and keeps the mark attached to the guest that was actually asked to
// traverse rather than to "the active tab", which can change before the commit
// lands.
const pendingTraversals = new WeakSet();

/**
 * Restore the previous history entry for `webview`, marking the commit it
 * produces as a history traversal.
 *
 * @param {object|null} webview - guest `<webview>` element
 * @returns {boolean} true when the traversal was requested
 */
export const goBackInHistory = (webview) => {
  if (!webview?.canGoBack?.()) return false;
  pendingTraversals.add(webview);
  webview.goBack();
  return true;
};

/**
 * Restore the next history entry for `webview`, marking the commit it
 * produces as a history traversal.
 *
 * @param {object|null} webview - guest `<webview>` element
 * @returns {boolean} true when the traversal was requested
 */
export const goForwardInHistory = (webview) => {
  if (!webview?.canGoForward?.()) return false;
  pendingTraversals.add(webview);
  webview.goForward();
  return true;
};

/**
 * Read *and clear* the traversal mark for `webview`.
 *
 * Call this on every *cross-document* commit, not just the ones the caller
 * cares about: a traversal that never commits (a restored entry that turns out
 * to be a download, a `stop()` mid-flight) would otherwise leave its mark
 * standing and let the *next*, unrelated navigation be taken for a traversal.
 * Consuming unconditionally bounds a stale mark to a single commit.
 *
 * Same-document commits (`did-navigate-in-page`) deliberately do not call
 * this. Chromium reports a page's own `pushState`/`replaceState` through the
 * same event as a same-document traversal, with nothing on either the commit
 * or its preceding `did-start-navigation` to separate them, so a page
 * rewriting its own URL on a timer could otherwise eat the mark out from under
 * a traversal still in flight; see the `did-navigate-in-page` handler in
 * tabs.js for the probe that established this.
 *
 * @param {object|null} webview - guest `<webview>` element
 * @returns {boolean} true when this commit is the one a traversal asked for
 */
export const consumeHistoryTraversal = (webview) => {
  if (!webview || !pendingTraversals.has(webview)) return false;
  pendingTraversals.delete(webview);
  return true;
};

/**
 * Drop any traversal mark for `webview` without reporting a commit.
 *
 * Called by every shell-initiated navigation (`loadTarget`). Two cases need
 * it, and neither can be recognised from a commit alone:
 *
 *   * the user asks for something else before the traversal commits (types a
 *     URL, picks a bookmark) — the traversal is superseded, so the commit
 *     that eventually lands belongs to the new navigation, not to it;
 *   * the traversal restores an entry Chromium can serve without a
 *     cross-document commit — one that differs only in a *subframe*, or one
 *     in the same document (an in-page anchor, an SPA route). Nothing then
 *     consumes the mark, because no same-document commit is allowed to (see
 *     `consumeHistoryTraversal`), and it would otherwise stand until some
 *     later, unrelated cross-document commit was taken for the traversal.
 *
 * A cross-document navigation the *page* starts (a form submit,
 * `location.assign()`, a meta refresh) does not call this, so it consumes a
 * mark left standing rather than clearing it — but it cannot reach the
 * refresh with one: see the `did-navigate-in-page` handler in tabs.js for the
 * probe, and for what that conclusion rests on.
 *
 * @param {object|null} webview - guest `<webview>` element
 * @returns {void}
 */
export const clearHistoryTraversal = (webview) => {
  if (webview) pendingTraversals.delete(webview);
};
