// Page URLs, internal page routing, and stateless navigation helpers
//
// Canonical source of truth: src/shared/internal-pages.json
// Served to the renderer via sync IPC → preload → window.internalPages

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

// Detect protocol from display URL for history recording
export const detectProtocol = (url) => {
  if (!url) return 'unknown';
  if (url.startsWith('ens://')) return 'ens';
  if (url.startsWith('bzz://')) return 'swarm';
  if (url.startsWith('ipfs://')) return 'ipfs';
  if (url.startsWith('ipns://')) return 'ipns';
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

// Convert internal page URL back to freedom:// format
export const getInternalPageName = (url) => {
  for (const [name, pageUrl] of Object.entries(internalPages)) {
    if (url === pageUrl || url === pageUrl.replace(/\/$/, '')) {
      return name;
    }
  }
  return null;
};

// Parse ENS input (ens:// prefix or .eth/.box domain)
export const parseEnsInput = (raw) => {
  let value = (raw || '').trim();
  if (!value) return null;

  if (value.toLowerCase().startsWith('ens://')) {
    value = value.slice(6);
  }

  let name = value;
  let suffix = '';
  const match = value.match(/^([^\/?#]+)([\/?#].*)?$/);
  if (match) {
    name = match[1];
    suffix = match[2] || '';
  }

  const lower = name.toLowerCase();
  if (!lower.endsWith('.eth') && !lower.endsWith('.box')) {
    return null;
  }

  return { name: lower, suffix };
};
