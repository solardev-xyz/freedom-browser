// "Continue once" consent for a blocked name, and how far it reaches.
//
// `ens-unverified.html` is the one block page with a way through it: its
// "Continue once" button sends `ens:continue-unverified`, and the shell
// re-navigates with `allowUnverifiedOnce` so the follow-up load skips the
// check that raised the page. That much predates #86 and is unchanged.
//
// What #86 added was a re-verification on *history traversal*, and with it a
// second place a block can be raised over a name: pressing Back onto the page
// the consent produced re-resolved the name, found the same `unverified`
// verdict, and put the block page back up — over an entry the user had
// already looked at that page for and chosen to go on from. Before #86 a
// traversal raised nothing at all, so this was a regression against `main`
// rather than a new rule, and it cost the forward history too (raising the
// page is a real navigation, so it replaces whatever was ahead).
//
// So a grant is recorded here when the user clicks the button, and the
// traversal refresh declines to block on it. Its scope is deliberately the
// narrowest thing that covers the report:
//
//   * **the name** the user actually continued past — not the tab's other
//     names, and not the resolved CID, which is exactly what may have changed
//     underneath;
//   * **the tab** it was given in, keyed by that tab's `<webview>` element. A
//     `WeakMap` needs no teardown when the tab closes and cannot be confused
//     by a later tab reusing an id (same reasoning as `history-traversal.js`);
//   * **this session**: the map lives as long as the renderer does, and a
//     grant is never written to disk or to settings.
//
// What it is *not* is an allow-list entry. Nothing here is consulted by
// `loadTarget`, so every fresh request for the name still blocks: typing it in
// the address bar again, following a link to it, reloading the page (reload
// re-resolves by design — #82/PR #84). Only a traversal back onto an entry
// this tab already consented to is covered, which is the one case where the
// user is returning to a decision rather than making a new one. "Once" still
// means once per visit.
const grantedNamesByWebview = new WeakMap();

// Names are compared case-insensitively: the traversal refresh reads the name
// out of `parseEnsInput` (already folded), while the grant comes back from the
// block page's own `?name=` parameter, which carries whatever case the load
// that raised it used.
const normalize = (name) => (typeof name === 'string' ? name.trim().toLowerCase() : '');

/**
 * Record that the user chose "Continue once" for `name` in this tab.
 *
 * @param {object|null} webview - guest `<webview>` element of the consenting tab
 * @param {string} name - the blocked name, as the interstitial reported it
 * @returns {void}
 */
export const grantContinueOnce = (webview, name) => {
  const key = normalize(name);
  if (!webview || !key) return;
  let names = grantedNamesByWebview.get(webview);
  if (!names) {
    names = new Set();
    grantedNamesByWebview.set(webview, names);
  }
  names.add(key);
};

/**
 * Whether this tab already carries a "Continue once" grant for `name`.
 *
 * Only the history-traversal refresh asks: a grant covers returning to the
 * entry it was given for, never a fresh navigation.
 *
 * @param {object|null} webview - guest `<webview>` element of the tab
 * @param {string} name - the name a traversal is re-verifying
 * @returns {boolean}
 */
export const hasContinueOnceGrant = (webview, name) => {
  const key = normalize(name);
  if (!webview || !key) return false;
  return grantedNamesByWebview.get(webview)?.has(key) === true;
};
