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
// A `WeakMap` keyed by the `<webview>` element needs no teardown when a tab
// closes, and keeps the mark attached to the guest that was actually asked to
// traverse rather than to "the active tab", which can change before the commit
// lands.
//
// The mark is a *count*, not a boolean (R4-M3), and what counting buys is a
// bound in one direction only: the queue can never come up short, so no
// commit a traversal asked for goes unrecognised. It can run long.
//
// Chromium does not queue a second history navigation behind one that is
// already pending — it replaces it, and the single commit that lands is the
// newer request's target. Probed at head on Electron 44 (harness,
// `[traversal.eth, b.example, c.example]`, the renderer's own
// `History traversal re-verifying` line counted; observed 2026-09-22): two
// `#back-btn` clicks in one task committed **once**, on
// `ipfs://traversal.eth/` — two entries back, not one — and a second Back
// issued 800ms into a still-pending first one likewise committed once, on
// the newer target. Each pair marked twice and spent one mark, so a
// coalesced traversal leaves one surplus mark standing. That is the real
// bound: at most one surplus per coalesced traversal, never a shortfall.
//
// A surplus is zeroed by `clearHistoryTraversal` on the next
// shell-initiated navigation (`loadTarget`), or spent by the next
// cross-document commit on this guest, whichever comes first. Spending it
// costs a redundant re-resolution and nothing else — the observed case is
// the page context menu's Reload (`reloadIgnoringCache()`, the one route
// that neither goes through `loadTarget` nor changes the URL) being reported
// as a traversal, so the name on screen is re-checked under today's settings
// a second time, which is what a reload does anyway.
//
// Counting is kept over the boolean it replaced because erring long is the
// safe direction: a mark that is one short leaves a restored entry wearing
// the trust object its *first* load wrote, which is the #86 symptom itself,
// while a mark that is one over is bounded, self-clearing and idempotent —
// and the count cannot under-report if Chromium's coalescing above ever
// changes.
const pendingTraversals = new WeakMap();

const markTraversalPending = (webview) => {
  pendingTraversals.set(webview, (pendingTraversals.get(webview) || 0) + 1);
};

/**
 * Restore the previous history entry for `webview`, marking the commit it
 * produces as a history traversal.
 *
 * @param {object|null} webview - guest `<webview>` element
 * @returns {boolean} true when the traversal was requested
 */
export const goBackInHistory = (webview) => {
  if (!webview?.canGoBack?.()) return false;
  markTraversalPending(webview);
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
  markTraversalPending(webview);
  webview.goForward();
  return true;
};

/**
 * Spend one pending traversal for `webview`.
 *
 * Call this on every *cross-document* commit, not just the ones the caller
 * cares about: a traversal that never commits (a restored entry that turns out
 * to be a download, a `stop()` mid-flight) would otherwise leave its mark
 * standing and let the *next*, unrelated navigation be taken for a traversal.
 * Consuming unconditionally bounds each stale mark to a single commit.
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
  const pending = webview ? pendingTraversals.get(webview) || 0 : 0;
  if (pending <= 0) return false;
  if (pending === 1) pendingTraversals.delete(webview);
  else pendingTraversals.set(webview, pending - 1);
  return true;
};

/**
 * Drop *every* pending traversal for `webview` without reporting a commit.
 *
 * Called by every shell-initiated navigation (`loadTarget`). Two cases need
 * it, and neither can be recognised from a commit alone:
 *
 *   * the user asks for something else before the traversal commits (types a
 *     URL, picks a bookmark) — the traversal is superseded, so the commit
 *     that eventually lands belongs to the new navigation, not to it. That
 *     supersedes the whole queue, however many traversals are pending, which
 *     is why the count is zeroed rather than decremented;
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
