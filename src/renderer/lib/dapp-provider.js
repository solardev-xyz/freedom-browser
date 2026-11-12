/**
 * The visible tab's site, for the chrome's connection banners.
 *
 * A page's window.ethereum, window.swarm and window.radicle requests go
 * from its preload to main (freedom-core design 0011; src/main/page/), which
 * decides who asked from the sending frame and answers the page itself. The
 * chrome sees no page request. What stays here is the tab in front, which
 * tabs.js reports, and the site its banners describe.
 */

import { updateConnectionBanner, updateSwarmConnectionBanner, updateX402ConnectionBanner } from './wallet-ui.js';
import { parseOnchainAppUrl, applyDnsNameIdentity } from './url-utils.js';
import { state } from './state.js';
import { getDisplayUrlForWebview } from './tabs.js';

// Current active webview reference (set by tabs.js)
let activeWebview = null;

function getOnchainApp(webview) {
  try {
    return parseOnchainAppUrl(webview?.getURL?.());
  } catch {
    return null;
  }
}

/**
 * The user-facing identity of the page in `webview`: its tab's own
 * committed URL (`committedDisplayUrl`, which keeps ENS/bzz/ipfs names),
 * never the address bar, which shows the visible tab or a half-typed draft
 * (#764). A DNS-named ENS site over IPNS commits as `ipns://<key>`;
 * `applyDnsNameIdentity` maps it back to the `ens://<name>` its address bar
 * shows, the key its grants are stored under.
 */
function getDisplayIdentity(webview) {
  return getOnchainApp(webview)?.url ||
    applyDnsNameIdentity(getDisplayUrlForWebview(webview), state.knownEnsNames);
}

/**
 * The dApp identity of the visible tab's committed page ('' when none), for
 * the chrome's dApp connection banner.
 */
export function getActiveDisplayUrl() {
  return activeWebview ? getDisplayIdentity(activeWebview) : '';
}

/**
 * The visible tab's committed page URL ('' when none), without the dApp-only
 * DNS-name mapping above: the Swarm and x402 banners key on the page URL
 * itself.
 */
export function getActivePageUrl() {
  return activeWebview ? getDisplayUrlForWebview(activeWebview) : '';
}

/**
 * Set the active webview (tabs.js, at every tab switch).
 */
export function setActiveWebview(webview) {
  activeWebview = webview;

  // Repaint the connection banners for the newly visible tab (they read its
  // committed page identity via getActiveDisplayUrl)
  setTimeout(() => {
    updateConnectionBanner();
    updateSwarmConnectionBanner();
    updateX402ConnectionBanner();
  }, 50);
}
