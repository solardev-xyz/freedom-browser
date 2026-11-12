/**
 * Page prompts in the chrome (freedom-core design 0011, "The prompt
 * protocol", before APS; step PRQ-4).
 *
 * Main issues every prompt a page's request needs and decides which one
 * this window shows: the oldest of the tab in front. A background tab's
 * prompt waits, with a badge on its tab and a count on the wallet button,
 * until the user switches to it. This module only renders what main says:
 *
 *   - `page:prompt-pending` / `page:prompt-closed`: the badges and the
 *     count, which follow every open handle, shown or not;
 *   - `page:prompt`: show this prompt now; `page:prompt-hidden`: take it
 *     down, it keeps its place in main;
 *   - the user's decision goes back for that handle alone
 *     (`page:decide`), and main refuses one for a handle it no longer shows.
 *
 * The tab in front is reported to main by tabs.js (`page:foreground`).
 *
 * With the approvals document's flag on (APS-1, `FREEDOM_APPROVALS_DOCUMENT`),
 * main sends `page:prompt` and `page:prompt-hidden` to the window's
 * approvals document instead, and refuses this window's decisions; the
 * badges and the count work as before. This module also tells main where
 * the content area starts (`anchor`), so the approvals panel sits beside
 * the content below the toolbar, where the sidebar shows prompts.
 *
 * The sidebar is shared with the chrome's own screens (the wallet's
 * management, its own sends). A prompt main
 * shows waits while one of those holds the sidebar or a device signature is
 * in flight, and shows once the sidebar is back on the wallet's own view.
 *
 * The screens by kind: the Connect screen (`eth.connect`, PRQ-4), from
 * PRQ-5a the Sign screen (`eth.sign`), the vault unlock (`vault.unlock`)
 * and a Safe's signing board (`eth.safe_message`), and from PRQ-5b the
 * transaction screen (`eth.send`) and a Safe send's signing board
 * (`eth.safe_send`), from PRQ-7b Swarm's connect, messaging and
 * permission-manifest screens (`swarm.connect`, `swarm.messaging`,
 * `swarm.manifest`), from PRQ-7c its publish screen (`swarm.publish`), from
 * PRQ-7d its feed screen (`swarm.feed`), and from PRQ-8a Radicle's consent
 * screen (`radicle.connect`, from PRQ-8b `radicle.node` and from PRQ-8c
 * `radicle.sign`), which register themselves
 * (`page-prompt-renderers.js`).
 */

import { isDappPromptShowing } from './wallet/dapp-prompt-guard.js';
import { isSignatureInFlight } from './wallet/signature-flight.js';
import { walletState } from './wallet/wallet-state.js';
import {
  showPageConnect,
  closePageConnect,
  shownPageConnect,
  onPageConnectDisplaced,
  updateConnectionBanner,
} from './wallet/dapp-connect.js';
import { updateSwarmConnectionBanner } from './wallet/swarm-connect.js';
import { setWalletPromptCounts, setChromePromptShown } from './tabs.js';
import { pagePromptRenderer, onPagePromptDisplaced } from './page-prompt-renderers.js';

// How often a prompt that couldn't show yet looks again.
const RETRY_MS = 250;

// handle -> guest, for every open prompt of this window.
const pending = new Map();
// What main shows now: the last `page:prompt`, until it is hidden or closed.
let shown = null;
let retryTimer = null;
let countEl = null;

// The renderers, by kind: connecting here, and the screens that register
// themselves.
const CONNECT = { show: showPageConnect, close: closePageConnect, isShowing: shownPageConnect };
const rendererFor = (kind) => (kind === 'eth.connect' ? CONNECT : pagePromptRenderer(kind));

function countsByGuest() {
  const counts = new Map();
  for (const guest of pending.values()) counts.set(guest, (counts.get(guest) || 0) + 1);
  return counts;
}

function paintCounts() {
  setWalletPromptCounts(countsByGuest());
  if (!countEl) return;
  const total = pending.size;
  countEl.textContent = total > 0 ? String(total) : '';
  countEl.classList.toggle('hidden', total === 0);
  countEl.title = total === 1 ? '1 request waiting' : `${total} requests waiting`;
}

const identityViewShowing = () =>
  Boolean(walletState.identityView) && !walletState.identityView.classList.contains('hidden');

// Whether the sidebar is free for a prompt. On arrival, anything but a
// prompt deciding something or a device signature gives way, as before;
// after waiting, the sidebar must be back on the wallet's own view.
function sidebarFree({ waited }) {
  if (isSignatureInFlight() || isDappPromptShowing()) return false;
  return !waited || identityViewShowing();
}

function stopRetry() {
  if (retryTimer !== null) clearInterval(retryTimer);
  retryTimer = null;
}

function render({ waited = false } = {}) {
  const prompt = shown;
  if (!prompt) {
    stopRetry();
    return;
  }
  const renderer = rendererFor(prompt.kind);
  if (!renderer || renderer.isShowing() === prompt.handle) {
    stopRetry();
    return;
  }
  // The screen holding a decided prompt of this request, while main still
  // works on it, takes the request's next prompt in its place (a send's fee
  // asked again at the press): its own lock isn't another prompt's.
  const inPlace = renderer.takesOver?.(prompt) === true;
  if (!inPlace && !sidebarFree({ waited })) {
    if (retryTimer === null) retryTimer = setInterval(() => render({ waited: true }), RETRY_MS);
    return;
  }
  stopRetry();
  try {
    renderer.show(prompt);
  } catch (err) {
    console.error('[PagePrompts] Failed to show a prompt:', err);
  }
}

function takeDown(handle) {
  if (shown?.handle !== handle) return;
  const renderer = rendererFor(shown.kind);
  shown = null;
  setChromePromptShown(false);
  stopRetry();
  renderer?.close(handle);
}

function refreshBanners() {
  Promise.resolve()
    .then(() => Promise.all([updateConnectionBanner(), updateSwarmConnectionBanner()]))
    .catch(() => {});
}

// Report where the content area starts, now and whenever it moves (the
// bookmarks bar, full screen, the window's size).
function reportAnchor(api) {
  const body = document.querySelector?.('.app-body');
  if (!body || typeof api.anchor !== 'function') return;
  let last = null;
  const report = () => {
    const top = Math.round(body.getBoundingClientRect().top);
    if (!Number.isFinite(top) || top === last) return;
    last = top;
    api.anchor(top);
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(report).observe(body);
  window.addEventListener?.('resize', report);
  report();
}

export function initPagePrompts() {
  const api = window.pagePrompts;
  if (!api) return;
  countEl = document.getElementById('wallet-prompt-count');
  reportAnchor(api);
  api.onPending?.((message) => {
    if (typeof message?.handle !== 'string' || !Number.isInteger(message.guest)) return;
    pending.set(message.handle, message.guest);
    paintCounts();
  });
  api.onClosed?.((message) => {
    if (typeof message?.handle !== 'string') return;
    pending.delete(message.handle);
    takeDown(message.handle);
    paintCounts();
    // A decision in the approvals document may have connected a site: the
    // sidebar's connection banners read the grants again (APS-2).
    if (api.approvalsDocument === true) refreshBanners();
  });
  api.onHidden?.((message) => {
    if (typeof message?.handle === 'string') takeDown(message.handle);
  });
  api.onPrompt?.((message) => {
    if (typeof message?.handle !== 'string' || !rendererFor(message.kind)) return;
    if (shown && shown.handle !== message.handle) takeDown(shown.handle);
    shown = message;
    setChromePromptShown(true);
    render();
  });
  // Another screen took the sidebar from a prompt main still shows: it
  // shows again once the sidebar is free.
  const displaced = (handle) => {
    if (shown?.handle !== handle) return;
    if (retryTimer === null) retryTimer = setInterval(() => render({ waited: true }), RETRY_MS);
  };
  onPageConnectDisplaced(displaced);
  onPagePromptDisplaced(displaced);
}

/** For tests: forget everything. */
export function _resetPagePrompts() {
  pending.clear();
  shown = null;
  stopRetry();
  countEl = null;
}
