/**
 * "Open without gateway" pill (#70).
 *
 * A page on an ENS/Swarm gateway — `vitalik.eth.limo`, `vitalik.eth.link`,
 * `vitalik.bzz.link`, `<swarm-cid>.bzz.link` — is an https page like any
 * other, and the address bar keeps saying so: Freedom never rewrites a
 * gateway URL on its own. What it does is *offer* the native version. Main
 * (src/main/gateway-offer.js) works out whether there is one — an ENS lookup
 * for the name shapes, a CID decode for `<cid>.bzz.link` — and when there
 * is, a labelled pill at the right end of the address bar says "Open without
 * gateway", its icon the target protocol and its tooltip the destination.
 * Clicking it opens a small popover anchored to the pill: the destination,
 * one line on what changes, an "Always open without gateway" checkbox, and
 * Cancel / "Open without gateway". Opening navigates to the native URL with
 * the path, query and fragment the gateway page had.
 *
 * The offer is worked out on arrival — a typed URL, a bookmark and a link
 * clicked inside a page all get it the same way, once the gateway page has
 * committed. Nothing intercepts the click. A gateway can also answer by
 * sending the navigation elsewhere: bzz.link redirects any `<cid>.bzz.link`
 * not on its allowlist to `https://bzz.link/forbidden?hash=…`. When it
 * lands on a page of the gateway's own domain like that, the
 * offer is worked out for the address the navigation *started* at (with its
 * own path, query and fragment) and shown on the page it ended on, since
 * that is exactly where opening natively helps. A redirect off the
 * gateway's domain (a site's own `_redirects` rule pointing at some other
 * site) gets no offer: that page is not the native version's stand-in.
 * Only for that navigation:
 * the next page the tab moves to gets its own offer or none.
 *
 * "Always open without gateway" (the `openWithoutGateway` setting, off by
 * default) is the one case that navigates by itself: a gateway navigation
 * starting in any tab is looked up at once and, when there is a native
 * version, sent there instead. It goes through the same `loadTarget` as a
 * typed `ipfs://` / `bzz://` URL, so the transport assertion and the trust
 * checks behind those still apply. A gateway page reached by Back/Forward is
 * left alone (and shows the pill), as is one this tab was just redirected
 * away from — otherwise Back could never get past it — unless the address
 * bar or a bookmark asked for it again. The same setting is a
 * checkbox at the bottom of the trust popover and a row in Settings →
 * Networks → Name Resolution.
 */

import { getActiveTab, onWebviewCreated } from './tabs.js';
import { historyTraversalRequestCount } from './history-traversal.js';
import { isModalDialogOpen } from './modal-dialog.js';
import { pushDebug } from './debug.js';
import { boundPopoverToViewport } from './popover-bounds.js';

// The gateway suffixes main knows. Only a pre-filter, so that ordinary pages
// never cost an IPC round-trip: main makes the real decision.
const GATEWAY_HOST = /^https?:\/\/[^/?#]+\.(?:eth\.limo|eth\.link|bzz\.link)\.?(?:[/?#]|$)/i;

export const looksLikeGatewayUrl = (url) => typeof url === 'string' && GATEWAY_HOST.test(url);

const GATEWAY_APEXES = ['eth.limo', 'eth.link', 'bzz.link'];

const hostOf = (url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
};

/**
 * Whether `landedUrl` is a page of the same gateway service `startedUrl` was
 * on: its apex (`bzz.link`, as in bzz.link's forbidden page) or a host under
 * it. A gateway-served site can redirect anywhere (an IPFS `_redirects` 302
 * to an unrelated site), and that page is not the gateway refusing the
 * address, so it must not be offered the started address's native version.
 */
export const isSameGatewayService = (startedUrl, landedUrl) => {
  const started = hostOf(startedUrl);
  const landed = hostOf(landedUrl);
  if (!started || !landed) return false;
  const apex = GATEWAY_APEXES.find((a) => started.endsWith(`.${a}`));
  return !!apex && (landed === apex || landed.endsWith(`.${apex}`));
};

const PROTOCOL_NAMES = { ipfs: 'IPFS', ipns: 'IPNS', bzz: 'Swarm' };

/**
 * The popover's one-line explanation for an offer.
 * @param {{protocol: string, gateway: string}} offer
 */
export const describeOffer = (offer) =>
  `Loads directly from ${PROTOCOL_NAMES[offer?.protocol] || 'the network'} instead of ` +
  `through the ${offer?.gateway || ''} gateway.`;

// Per <webview>:
//   seq          bumped on every main-frame commit; an offer answer for an
//                older commit is dropped.
//   committedUrl the page the offer belongs to.
//   offer        main's answer for committedUrl, or null.
//   startedUrl   the last main-frame navigation started, for the "always"
//                redirect: its answer only counts while nothing newer began.
//   pendingStartUrl  the same URL, but consumed by the cross-document commit
//                that ends that navigation. When that commit is somewhere
//                else (a server redirect), a gateway-shaped start is what the
//                offer is worked out for. Cleared on commit so it can never
//                speak for a later page.
//   redirectedFrom  the gateway URL this tab was last sent away from by
//                "always", which it then may come back to (Back by a route
//                that leaves no traversal mark, a page link) once without
//                being sent away again. Only while the tab is still where
//                "always" sent it: see `redirectLanded`. The address bar or a
//                bookmark asking for a URL again (`noteUserNavigation`) is
//                never that Back, so it drops the guard: typing the same
//                gateway address twice is redirected twice.
//   redirectLanded  set once a non-gateway page has committed after the
//                redirect (the native destination). From then on, the first
//                main-frame start to anywhere *other* than redirectedFrom
//                means the tab has moved on, and the guard is dropped, so a
//                later visit to the same gateway URL — typed, bookmarked,
//                linked an hour on — is redirected like any other.
//   seenTraversals  how many of this tab's Back/Forward requests
//                (`historyTraversalRequestCount`, a running total) are already
//                accounted for. A main-frame start is a traversal only when
//                the total has grown past it, and every start then accounts
//                for all of them (Chromium serves several pending requests
//                with one navigation). A main-frame same-document commit
//                accounts for at most *one*: a Back that resolved in place
//                (an anchor, an SPA route) is one request, and a second Back
//                already asked for by the time that commit is seen is still
//                on its way. Requests never answered by a main-frame
//                navigation at all (a Back that resolved in a subframe) keep
//                the next start counted as a traversal, which only leaves the
//                gateway page in place with the pill showing.
let stateByWebview = new WeakMap();
let alwaysOpen = false;
let navigate = null;

let pillEl;
let pillIconEl;
let popoverEl;
let popoverIconEl;
let destinationEl;
let explanationEl;
let alwaysEl;
let openBtn;
let cancelBtn;
let trustToggleEl;

const stateFor = (webview) => {
  let st = stateByWebview.get(webview);
  if (!st) {
    st = {
      seq: 0,
      committedUrl: '',
      offer: null,
      startedUrl: '',
      pendingStartUrl: '',
      redirectedFrom: '',
      redirectLanded: false,
      seenTraversals: 0,
    };
    stateByWebview.set(webview, st);
  }
  return st;
};

const activeWebview = () => getActiveTab()?.webview || null;

/** The offer for the active tab's page, or null. */
export const getActiveOffer = () => {
  const webview = activeWebview();
  return webview ? stateByWebview.get(webview)?.offer || null : null;
};

const requestOffer = async (url) => {
  try {
    return (await window.electronAPI?.getGatewayOffer?.(url)) || null;
  } catch (err) {
    pushDebug(`[gateway] offer lookup failed: ${err?.message}`);
    return null;
  }
};

// The target protocol's glyph, copied from the address bar's protocol icon
// so the pill and the bar draw IPFS and Swarm the same way.
const protocolGlyph = (protocol) => {
  const cls = protocol === 'bzz' ? 'icon-swarm' : 'icon-ipfs';
  const source = document.querySelector?.(`#protocol-icon .${cls}`);
  return source ? source.cloneNode(true) : null;
};

const paintIcon = (el, protocol) => {
  if (!el) return;
  const glyph = protocolGlyph(protocol);
  el.replaceChildren(...(glyph ? [glyph] : []));
  el.dataset.protocol = protocol === 'bzz' ? 'swarm' : 'ipfs';
};

const setPopoverOpen = (open) => {
  if (!popoverEl || !pillEl) return;
  popoverEl.hidden = !open;
  pillEl.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    // Anchored to the pill: its right edge lines up with the pill's.
    const wrapper = popoverEl.offsetParent;
    if (wrapper?.getBoundingClientRect && pillEl.getBoundingClientRect) {
      const right = wrapper.getBoundingClientRect().right - pillEl.getBoundingClientRect().right;
      popoverEl.style.right = `${Math.max(0, Math.round(right))}px`;
    }
    popoverEl.scrollTop = 0;
    boundPopoverToViewport(popoverEl);
  }
};

// For the chrome's shared dismissal paths (index.js), like
// `closePopupBlockedPopover`.
export const closeGatewayOfferPopover = () => {
  if (popoverEl && !popoverEl.hidden) setPopoverOpen(false);
};

// `resetChoice` on opening only: a refresh while the popover is up (an
// in-page navigation moving the destination) keeps what the user ticked.
const renderPopover = (offer, { resetChoice = true } = {}) => {
  if (!offer) return;
  paintIcon(popoverIconEl, offer.protocol);
  // The whole destination, wrapped rather than cut: it is what the user is
  // deciding on.
  if (destinationEl) destinationEl.textContent = offer.destination;
  if (explanationEl) explanationEl.textContent = describeOffer(offer);
  if (alwaysEl && resetChoice) alwaysEl.checked = alwaysOpen;
};

/**
 * Show or hide the pill for the active tab, and keep an open popover current.
 */
export const refresh = () => {
  if (!pillEl) return;
  const offer = getActiveOffer();
  pillEl.classList.toggle('hidden', !offer);
  if (!offer) {
    setPopoverOpen(false);
    return;
  }
  paintIcon(pillIconEl, offer.protocol);
  const hint = `Open ${offer.destination}`;
  pillEl.title = hint;
  pillEl.setAttribute('aria-label', `Open without gateway: ${offer.destination}`);
  if (!popoverEl?.hidden) renderPopover(offer, { resetChoice: false });
};

const saveAlwaysOpen = async (value) => {
  alwaysOpen = value === true;
  syncToggles();
  try {
    await window.electronAPI?.saveSettings?.({ openWithoutGateway: alwaysOpen });
  } catch (err) {
    pushDebug(`[gateway] saving "always open without gateway" failed: ${err?.message}`);
  }
};

const syncToggles = () => {
  if (trustToggleEl) trustToggleEl.checked = alwaysOpen;
  // The pill popover's box is part of a pending decision (it applies on
  // "Open without gateway"), so an open popover keeps what the user ticked.
  if (alwaysEl && popoverEl?.hidden !== false) alwaysEl.checked = alwaysOpen;
};

/** Apply the `openWithoutGateway` setting from a settings payload. */
export const applyGatewaySettings = (settings) => {
  alwaysOpen = settings?.openWithoutGateway === true;
  syncToggles();
};

const openOffer = async () => {
  const webview = activeWebview();
  const offer = getActiveOffer();
  if (!webview || !offer) return;
  const wantsAlways = alwaysEl?.checked === true;
  setPopoverOpen(false);
  if (wantsAlways !== alwaysOpen) await saveAlwaysOpen(wantsAlways);
  pushDebug(`[gateway] opening ${offer.destination} instead of ${offer.gatewayHost}`);
  navigate?.(offer.destination, webview, { auto: false });
};

// A main-frame commit (cross-document or in-page): the offer belongs to the
// new URL, so the old one goes at once and a fresh one is asked for.
const onCommitted = (webview, url, { inPage = false } = {}) => {
  const st = stateFor(webview);
  st.seq += 1;
  // The URL the navigation ending here started at. A same-document commit
  // has no start of its own (those are skipped in `watchWebview`), so it
  // neither reads nor consumes it.
  let startedAt = '';
  if (!inPage) {
    startedAt = st.pendingStartUrl;
    st.pendingStartUrl = '';
  }
  if (inPage) {
    // At most one request per in-place move. The one way this errs: the page
    // being left moving itself (`pushState`/`replaceState`) while a real Back
    // is in flight accounts for that Back, so the gateway page it restores is
    // redirected once. That goes forward to the native page, not back where
    // the user came from, so it cannot loop; the same-document commit that
    // would tell the two apart does not exist (see tabs.js,
    // `did-navigate-in-page`).
    st.seenTraversals = Math.min(historyTraversalRequestCount(webview), st.seenTraversals + 1);
  }
  // The gateway's own redirect target (bzz.link's forbidden page) is not
  // where "always" sent the tab, so it does not count as landing.
  if (st.redirectedFrom && !looksLikeGatewayUrl(url) && startedAt !== st.redirectedFrom) {
    st.redirectLanded = true;
  }
  st.committedUrl = url || '';
  const hadOffer = !!st.offer;
  st.offer = null;
  if (hadOffer && activeWebview() === webview) refresh();
  // A gateway address the gateway itself redirected to one of its own pages
  // that is not a gateway address (bzz.link's forbidden page): offer the
  // address that was asked for. A redirect off the gateway's domain is the
  // site sending the user elsewhere, which gets no offer from it.
  const offerFor = looksLikeGatewayUrl(url)
    ? url
    : startedAt &&
        startedAt !== url &&
        looksLikeGatewayUrl(startedAt) &&
        isSameGatewayService(startedAt, url)
      ? startedAt
      : '';
  if (!offerFor) return;
  const seq = st.seq;
  requestOffer(offerFor).then((offer) => {
    if (st.seq !== seq || !offer) return;
    st.offer = offer;
    if (activeWebview() === webview) refresh();
  });
};

// "Always open without gateway": send a gateway navigation that has a native
// version there instead, as soon as main has an answer.
const onStarted = (webview, url) => {
  const st = stateFor(webview);
  st.startedUrl = url || '';
  st.pendingStartUrl = url || '';
  // Read before anything returns: this start accounts for every request
  // made so far (see `seenTraversals`), whether or not it ever commits, so a
  // Back onto a download cannot shield the next link click either.
  const requested = historyTraversalRequestCount(webview);
  const traversal = requested > st.seenTraversals;
  st.seenTraversals = requested;
  if (st.redirectedFrom && st.redirectLanded && url !== st.redirectedFrom) {
    // The tab has left the page "always" sent it to: the guard is spent.
    st.redirectedFrom = '';
    st.redirectLanded = false;
  }
  if (!alwaysOpen || !looksLikeGatewayUrl(url)) return;
  if (traversal) return;
  if (st.redirectedFrom && st.redirectedFrom === url) {
    // Back on the page "always" just took this tab away from: stay. The
    // next navigation to it is redirected again.
    st.redirectedFrom = '';
    st.redirectLanded = false;
    return;
  }
  requestOffer(url).then((offer) => {
    if (!offer || !alwaysOpen || st.startedUrl !== url) return;
    st.redirectedFrom = url;
    st.redirectLanded = false;
    pushDebug(`[gateway] always open without gateway: ${url} → ${offer.destination}`);
    navigate?.(offer.destination, webview, { auto: true });
  });
};

/**
 * The address bar or a bookmark (a user-driven `loadTarget`) is about to
 * navigate this tab. That is never the Back the redirect guard protects, so
 * the guard goes: the "always" redirect then treats the address like any
 * other, however often it is entered.
 */
export const noteUserNavigation = (webview) => {
  const st = webview ? stateByWebview.get(webview) : null;
  if (!st) return;
  st.redirectedFrom = '';
  st.redirectLanded = false;
};

const watchWebview = (webview) => {
  if (!webview?.addEventListener) return;
  webview.addEventListener('did-start-navigation', (event) => {
    if (event.isMainFrame === false || event.isInPlace) return;
    onStarted(webview, event.url);
  });
  webview.addEventListener('did-navigate', (event) => {
    onCommitted(webview, event.url);
  });
  webview.addEventListener('did-navigate-in-page', (event) => {
    if (event.isMainFrame === false) return;
    onCommitted(webview, event.url, { inPage: true });
  });
};

/**
 * @param {{ navigate: (url: string, webview: object, opts: {auto: boolean}) => void }} deps
 *   `navigate` opens the native URL in that tab (index.js wires `loadTarget`).
 */
export const initGatewayOfferUi = ({ navigate: navigateFn } = {}) => {
  navigate = navigateFn || null;
  pillEl = document.getElementById('gateway-offer-pill');
  pillIconEl = document.getElementById('gateway-offer-pill-icon');
  popoverEl = document.getElementById('gateway-offer-popover');
  popoverIconEl = document.getElementById('gateway-offer-popover-icon');
  destinationEl = document.getElementById('gateway-offer-destination');
  explanationEl = document.getElementById('gateway-offer-explanation');
  alwaysEl = document.getElementById('gateway-offer-always');
  openBtn = document.getElementById('gateway-offer-open');
  cancelBtn = document.getElementById('gateway-offer-cancel');
  trustToggleEl = document.getElementById('trust-popover-gateway-toggle');
  if (!pillEl || !popoverEl) {
    pushDebug('[gateway] open-without-gateway pill unavailable (missing DOM)');
    return;
  }

  onWebviewCreated(watchWebview);

  window.electronAPI
    ?.getSettings?.()
    .then(applyGatewaySettings)
    .catch(() => {});
  window.addEventListener('settings:updated', (event) => applyGatewaySettings(event.detail));

  pillEl.addEventListener('click', () => {
    if (popoverEl.hidden) {
      renderPopover(getActiveOffer());
      setPopoverOpen(true);
      openBtn?.focus();
    } else {
      setPopoverOpen(false);
    }
  });
  openBtn?.addEventListener('click', () => {
    openOffer();
  });
  cancelBtn?.addEventListener('click', () => setPopoverOpen(false));
  trustToggleEl?.addEventListener('change', () => {
    saveAlwaysOpen(trustToggleEl.checked);
  });

  // Click-away / Esc / focus loss, as for the pop-up-blocked popover.
  document.addEventListener('click', (e) => {
    if (isModalDialogOpen() || popoverEl.hidden) return;
    if (!popoverEl.contains(e.target) && !pillEl.contains(e.target)) {
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
  stateByWebview = new WeakMap();
  alwaysOpen = false;
  navigate = null;
  pillEl = pillIconEl = popoverEl = popoverIconEl = undefined;
  destinationEl = explanationEl = alwaysEl = openBtn = cancelBtn = trustToggleEl = undefined;
};
