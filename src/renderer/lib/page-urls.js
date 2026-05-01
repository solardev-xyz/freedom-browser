// Page URLs, internal page routing, and stateless navigation helpers
//
// Canonical source of truth: src/shared/internal-pages.json
// Served to the renderer via sync IPC → preload → window.internalPages

import { isEnsHost } from './origin-utils.js';

const ROUTABLE_PAGES = window.internalPages?.routable || {};

// URLs for pages
export const homeUrl = new URL('pages/home.html', window.location.href).toString();
export const homeUrlNormalized = homeUrl;
export const errorUrlBase = new URL('pages/error.html', window.location.href).toString();

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

// Detect protocol from display URL for history recording
export const detectProtocol = (url) => {
  if (!url) return 'unknown';
  if (url.startsWith('ens://')) return 'ens';
  if (url.startsWith('bzz://')) return 'swarm';
  if (url.startsWith('ipfs://')) return 'ipfs';
  if (url.startsWith('ipns://')) return 'ipns';
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
  if (internalUrl?.includes('/error.html')) return false;
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

// Parse ENS input. Accepts:
//   - bare ENS names (vitalik.eth, name.box, with optional path/query/fragment)
//   - legacy ens:// URLs (kept for bookmark + history compatibility)
//   - transport-aware ENS URLs (bzz://name.eth/, ipfs://name.eth/, ipns://name.eth/)
//
// Transport URLs whose host is NOT an ENS name (e.g. bzz://<hash>, ipfs://<cid>)
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
  for (const { prefix, assertedTransport: assertion } of ENS_INPUT_PREFIXES) {
    if (lower.startsWith(prefix)) {
      value = value.slice(prefix.length);
      assertedTransport = assertion;
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

  if (!isEnsHost(name)) {
    return null;
  }

  return { name: name.toLowerCase(), suffix, assertedTransport };
};
