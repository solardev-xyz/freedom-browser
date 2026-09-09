// Page URLs, internal page routing, and stateless navigation helpers
//
// Canonical source of truth: src/shared/internal-pages.json
// Served to the renderer via sync IPC → preload → window.internalPages

import { isEnsHost, isTezosDomainHost } from './origin-utils.js';

const ROUTABLE_PAGES = window.internalPages?.routable || {};

// Resolve an internal page file to the shell's own `pages/<file>` URL.
const internalPageUrl = (pageFile) => new URL(`pages/${pageFile}`, window.location.href).toString();

// "Is this committed URL one of our own chrome pages?" Every such test must
// compare against the *resolved* base URL above, never a `/<file>.html`
// substring: a remote page is free to serve `https://evil.test/error.html` or
// `https://evil.test/ens-conflict.html`, and a substring test would let it
// impersonate chrome — taking over the address bar with its own `?url=` /
// `?name=` value while the webview renders attacker HTML. Only the exact base
// (optionally with a query string or fragment) counts. See issue #235.
const matchesInternalPage = (url, base) =>
  typeof url === 'string' &&
  (url === base || url.startsWith(`${base}?`) || url.startsWith(`${base}#`));

// URLs for pages
export const homeUrl = internalPageUrl('home.html');
export const homeUrlNormalized = homeUrl;
export const errorUrlBase = internalPageUrl('error.html');

export const isErrorPageUrl = (url) => matchesInternalPage(url, errorUrlBase);

// Internal pages map for freedom:// protocol
export const internalPages = Object.fromEntries(
  Object.entries(ROUTABLE_PAGES).map(([name, file]) => [
    name,
    new URL(`pages/${file}`, window.location.href).toString(),
  ])
);

// Build a file:// URL for an internal page with optional query parameters.
// `params` is a plain object; values are stringified. Used by navigation
// dispatch (interstitials, error pages, etc.) — centralises the pattern so
// page-name strings don't proliferate.
export const buildInternalPageUrl = (pageFile, params = null) => {
  const url = new URL(`pages/${pageFile}`, window.location.href);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
};

// Name-resolution interstitials. These are chrome, not content: the shell
// loads them into the webview when an ENS/Tezos name is blocked (unverified
// soft block, head/contenthash conflict hard block). Like `error.html` they
// carry the user-facing target in a query param, and — also like the error
// page — their own `file:///…/pages/*.html` URL must never reach the address
// bar, history, or any other chrome surface. See issue #235.
const INTERSTITIAL_PAGE_URLS = ['ens-unverified.html', 'ens-conflict.html'].map(internalPageUrl);

export const isInterstitialPageUrl = (url) =>
  INTERSTITIAL_PAGE_URLS.some((base) => matchesInternalPage(url, base));

// The user-facing name an interstitial is blocking (`lagged.tez`), or null
// when `url` isn't an interstitial / carries no name. Mirrors
// `getOriginalUrlFromErrorPage` for the error page.
export const getInterstitialDisplayName = (url) => {
  if (!isInterstitialPageUrl(url)) return null;
  try {
    return new URL(url).searchParams.get('name') || null;
  } catch {
    return null;
  }
};

// Detect protocol from display URL for history recording
export const detectProtocol = (url) => {
  if (!url) return 'unknown';
  if (url.startsWith('ens://')) return 'ens';
  if (url.startsWith('bzz://')) return 'swarm';
  if (url.startsWith('ipfs://')) return 'ipfs';
  if (url.startsWith('ipns://')) return 'ipns';
  if (url.startsWith('web3://')) return 'onchain';
  if (url.startsWith('rad:')) return 'radicle';
  if (url.startsWith('https://')) return 'https';
  if (url.startsWith('http://')) return 'http';
  return 'unknown';
};

// Check if URL should be recorded in history
export const isHistoryRecordable = (displayUrl, internalUrl) => {
  if (!displayUrl || displayUrl === '') return false;
  if (displayUrl.startsWith('freedom://')) return false;
  if (displayUrl.startsWith('view-source:')) return false;
  if (isErrorPageUrl(internalUrl)) return false;
  // A blocked name never lands on real content, so the interstitial is no
  // more history-worthy than the error page — and recording it would put the
  // interstitial's `file://` path (and its "RPC servers disagreed" title)
  // into the history list and the autocomplete dropdown.
  if (isInterstitialPageUrl(internalUrl)) return false;
  // Same for the onchain trust gate: the app's code has not run (soft block)
  // or was refused outright (conflict hard block), so the `web3://` display
  // URL never became a visit. Recording it would file the gate's warning
  // title ("RPC servers disagreed about this app") against the app itself in
  // history and autocomplete — and the once-per-URL dedup would then keep a
  // later, actually-loaded visit from replacing it.
  if (isOnchainInterstitialPageUrl(internalUrl)) return false;
  if (internalUrl === homeUrl || internalUrl === homeUrlNormalized) return false;
  return true;
};

// Convert internal page URL back to freedom:// format.
// A fragment on the internal URL (e.g. settings.html#appearance) becomes a
// sub-path on the friendly name (e.g. "settings/appearance"), which the
// address-bar code turns into freedom://settings/appearance.
export const getInternalPageName = (url) => {
  if (!url) return null;
  const hashIndex = url.indexOf('#');
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const fragment = hashIndex >= 0 ? url.slice(hashIndex + 1) : '';
  for (const [name, pageUrl] of Object.entries(internalPages)) {
    if (base === pageUrl || base === pageUrl.replace(/\/$/, '')) {
      return fragment ? `${name}/${fragment}` : name;
    }
  }
  return null;
};

// The internal pages that act as a window's *new-tab page*: `home` in a normal
// window, `private` in a private window (`tabs.js#defaultNewTabUrl`). Chrome
// treats its NTP and its Incognito NTP identically in the omnibox — both show
// an EMPTY address bar and both take focus when the tab is opened — so both
// names have to derive to an empty display value and both have to satisfy the
// "this is a fresh empty tab" focus test. See issue #312.
const NEW_TAB_PAGE_NAMES = new Set(['home', 'private']);

// True for an internal page *name* (`home`, `private`, with or without a
// sub-path) that acts as a new-tab page. The URL form below is derived from
// this; `tabs.js` needs the name form because the singleton-tab rules for the
// internal pages are keyed on the page name, and a new-tab page is explicitly
// not a singleton — see `routeInternalPageNavigation`.
export const isNewTabPageName = (pageName) =>
  typeof pageName === 'string' && NEW_TAB_PAGE_NAMES.has(pageName.toLowerCase().split('/')[0]);

// True for a new-tab-page URL in either form it appears in: the friendly
// `freedom://home` / `freedom://private` one `tab.url` carries while the page
// is still resolving, and the resolved `file://…/pages/<page>.html` one
// Chromium commits.
export const isNewTabPageUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  const friendly = /^freedom:\/\/([a-z0-9-]+)\/?$/i.exec(url);
  const name = friendly ? friendly[1].toLowerCase() : getInternalPageName(url);
  return !!name && isNewTabPageName(name);
};

// Trust interstitials are deliberately not routable freedom:// pages, but the
// browser chrome must keep showing the app the user asked for while one is
// visible. Like the ENS interstitials above, the onchain gate's own
// `file:///…/pages/onchain-unverified.html?…` URL must never reach the
// address bar, history, or any other chrome surface — it carries the
// single-use approval token in a query param. Only `file:` URLs count, so a
// remote look-alike path can never impersonate the gate. See issue #235.
export const isOnchainInterstitialPageUrl = (url) => {
  if (typeof url !== 'string' || !url || url.length > 8192) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'file:' && parsed.pathname.endsWith('/pages/onchain-unverified.html')
    );
  } catch {
    return false;
  }
};

// Either family of browser-owned trust interstitial: the name-resolution
// pages above and the onchain gate. These are the shell's own documents, not
// content the user navigated to, so chrome must never publish their
// `file:///…/pages/*.html` URL — and `view-source:` of one is refused
// outright rather than rendered, since the gate's URL carries the single-use
// approval token. See issue #235.
export const isTrustInterstitialPageUrl = (url) =>
  isInterstitialPageUrl(url) || isOnchainInterstitialPageUrl(url);

// Return only the bounded web3: target carried by our bundled gate page.
export const getOnchainInterstitialTarget = (url) => {
  if (!isOnchainInterstitialPageUrl(url)) return null;
  try {
    const target = new URL(url).searchParams.get('target');
    return target && target.length <= 2048 && /^web3:\/\//i.test(target) ? target : null;
  } catch {
    return null;
  }
};

// Parse Ethereum name input. Accepts:
//   - bare names (vitalik.eth, name.box, name.wei, name.gwei, with optional path/query/fragment)
//   - legacy ens:// URLs (kept for bookmark + history compatibility)
//   - transport-aware ENS URLs (bzz://name.eth/, ipfs://name.eth/, ipns://name.eth/)
//
// Transport URLs whose host is NOT a supported Ethereum name
// (e.g. bzz://<hash>, ipfs://<cid>)
// are returned as null so the caller can fall through to direct content
// navigation. This is what makes `bzz://meinhard.eth/` work the same way as
// `ens://meinhard.eth/` while leaving raw-hash navigation untouched.
//
// `assertedTransport` is the scheme the user explicitly typed (`bzz`, `ipfs`,
// or `ipns`) when present; `null` for bare names and the legacy `ens://`
// form. Callers gate the cross-transport assertion on this — if the user
// typed `bzz://name.eth` and the contenthash is IPFS, the assertion fails
// rather than silently switching transports.
const ENS_INPUT_PREFIXES = [
  { prefix: 'ens://', assertedTransport: null },
  { prefix: 'bzz://', assertedTransport: 'bzz' },
  { prefix: 'ipfs://', assertedTransport: 'ipfs' },
  { prefix: 'ipns://', assertedTransport: 'ipns' },
];

export const parseEnsInput = (raw) => {
  let value = (raw || '').trim();
  if (!value) return null;

  const lower = value.toLowerCase();
  let assertedTransport = null;
  let legacyEnsScheme = false;
  for (const { prefix, assertedTransport: assertion } of ENS_INPUT_PREFIXES) {
    if (lower.startsWith(prefix)) {
      value = value.slice(prefix.length);
      assertedTransport = assertion;
      legacyEnsScheme = prefix === 'ens://';
      break;
    }
  }

  let name = value;
  let suffix = '';
  const match = value.match(/^([^\/?#]+)([\/?#].*)?$/);
  if (match) {
    name = match[1];
    suffix = match[2] || '';
  }

  const isTezos = isTezosDomainHost(name);
  if ((!isEnsHost(name) && !isTezos) || (legacyEnsScheme && isTezos)) {
    return null;
  }

  return {
    name: name.toLowerCase(),
    suffix,
    assertedTransport,
    ...(isTezos ? { system: 'tezos' } : {}),
  };
};
