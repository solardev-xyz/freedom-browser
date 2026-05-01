import { applyEnsNamePreservation, deriveDisplayValue } from './url-utils.js';
import { getInternalPageName, parseEnsInput } from './page-urls.js';
import { cidV0ToV1Base32 } from './cid-utils.js';
import { isEnsHost } from './origin-utils.js';

// Extract the ENS name from an address bar value, or null if the value isn't
// an ENS resolution input. Thin wrapper around `parseEnsInput` so the
// render-loop helpers (protocol icon, trust shield) share the single
// parsing implementation in `page-urls.js`.
const extractEnsName = (normalizedValue) => parseEnsInput(normalizedValue)?.name ?? null;

// Trust-shield state for the address bar. Returns `null` to hide the shield
// (non-ENS URLs, or ENS name we haven't resolved this session). Otherwise
// returns `{ level, name, trust }` so the shield can render and the popover
// can fill in details.
export const resolveTrustBadge = ({ value = '', ensTrustByName = new Map() } = {}) => {
  const normalizedValue = value.toLowerCase();
  const ensName = extractEnsName(normalizedValue);
  if (!ensName) return null;
  const trust = ensTrustByName.get(ensName);
  if (!trust || !trust.level) return null;
  return { level: trust.level, name: ensName, trust };
};

export const resolveProtocolIconType = ({
  value = '',
  ensProtocols = new Map(),
  enableRadicleIntegration = false,
  currentPageSecure = false,
} = {}) => {
  const normalizedValue = value.toLowerCase();

  // Transport scheme wins first: the URL itself tells us what protocol the
  // page uses, regardless of whether the host happens to be an ENS name. This
  // matters for the post-resolution display forms (`bzz://name.eth`,
  // `ipfs://name.eth`, `ipns://name.eth`) — the protocol icon should match
  // the transport even before we've cached an `ensProtocols` entry.
  if (normalizedValue.startsWith('bzz://')) return 'swarm';
  if (normalizedValue.startsWith('ipfs://')) return 'ipfs';
  if (normalizedValue.startsWith('ipns://')) return 'ipns';
  if (normalizedValue.startsWith('rad://')) {
    return enableRadicleIntegration ? 'radicle' : 'http';
  }
  if (normalizedValue.startsWith('freedom://')) return null;

  // Bare ENS / legacy `ens://` falls back to the cached resolved protocol.
  const ensName = extractEnsName(normalizedValue);
  if (ensName) {
    return ensProtocols.get(ensName) || 'http';
  }

  if (normalizedValue.startsWith('https://') || currentPageSecure) {
    return 'https';
  }

  return 'http';
};

export const buildRadicleDisabledUrl = (baseHref, inputValue = '') => {
  const errorUrl = new URL('pages/rad-browser.html', baseHref);
  errorUrl.searchParams.set('error', 'disabled');
  if (inputValue) {
    errorUrl.searchParams.set('input', inputValue);
  }
  return errorUrl.toString();
};

export const getRadicleDisplayUrl = (url) => {
  if (!url || !url.includes('rad-browser.html')) return null;
  try {
    const parsed = new URL(url);
    const rid = parsed.searchParams.get('rid');
    const path = parsed.searchParams.get('path') || '';
    if (rid) {
      return `rad://${rid}${path}`;
    }
  } catch {
    // Ignore parse errors.
  }
  return null;
};

export const applyEnsSuffix = (targetUri, suffix = '') => {
  if (!suffix) {
    return targetUri;
  }

  try {
    return new URL(suffix, targetUri).toString();
  } catch {
    return `${targetUri.replace(/\/+$/, '')}${suffix}`;
  }
};

export const extractEnsResolutionMetadata = (targetUri, ensName) => {
  const knownEnsPairs = [];
  let resolvedProtocol = null;

  const bzzMatch = targetUri.match(/^bzz:\/\/([a-fA-F0-9]+)/);
  if (bzzMatch) {
    knownEnsPairs.push([bzzMatch[1].toLowerCase(), ensName]);
    resolvedProtocol = 'swarm';
  }

  const ipfsMatch = targetUri.match(/^ipfs:\/\/([A-Za-z0-9]+)/);
  if (ipfsMatch) {
    knownEnsPairs.push([ipfsMatch[1], ensName]);
    // Kubo's subdomain gateway redirects CIDv0 ("Qm...") to CIDv1 base32
    // ("bafybei..."). Store both so the address bar still collapses back to
    // the ENS name after the redirect lands.
    if (ipfsMatch[1].startsWith('Qm')) {
      const cidV1 = cidV0ToV1Base32(ipfsMatch[1]);
      if (cidV1) knownEnsPairs.push([cidV1, ensName]);
    }
    resolvedProtocol = 'ipfs';
  }

  const ipnsMatch = targetUri.match(/^ipns:\/\/([A-Za-z0-9.-]+)/);
  if (ipnsMatch) {
    knownEnsPairs.push([ipnsMatch[1], ensName]);
    // Track IPNS distinctly from IPFS so the protocol icon and transport
    // display reflect the actual contenthash transport (an IPNS-backed
    // ENS name was being mis-displayed as `ipfs://name.eth` otherwise).
    resolvedProtocol = 'ipns';
  }

  return {
    knownEnsPairs,
    resolvedProtocol,
  };
};

export const deriveDisplayAddress = ({
  url = '',
  bzzRoutePrefix,
  homeUrlNormalized,
  ipfsRoutePrefix = null,
  ipnsRoutePrefix = null,
  radicleApiPrefix = null,
  knownEnsNames = new Map(),
} = {}) => {
  const display = deriveDisplayValue(
    url,
    bzzRoutePrefix,
    homeUrlNormalized,
    ipfsRoutePrefix,
    ipnsRoutePrefix,
    radicleApiPrefix
  );

  return applyEnsNamePreservation(display, knownEnsNames);
};

// ENS-host transport URLs (`bzz://name.eth/...`, `ipfs://name.eth/...`,
// `ipns://name.eth/...`) cannot be turned into a gateway path here — the
// host has to be resolved to a CID/hash first via the ENS resolver. The
// caller (`loadTarget` view-source branch) handles that and passes the
// already-resolved transport URI back through this function, so we only
// need to skip ENS hosts in the strict "host is hex/CID/IPNS-id" branches
// below.

export const buildViewSourceNavigation = ({
  value = '',
  bzzRoutePrefix,
  homeUrlNormalized,
  ipfsRoutePrefix = null,
  ipnsRoutePrefix = null,
  radicleApiPrefix = null,
  knownEnsNames = new Map(),
} = {}) => {
  const innerUrl = value.startsWith('view-source:') ? value.slice(12) : value;

  const bzzMatch = innerUrl.match(/^bzz:\/\/([a-fA-F0-9]+)(\/.*)?$/);
  if (bzzMatch && !isEnsHost(bzzMatch[1])) {
    const hash = bzzMatch[1];
    const path = bzzMatch[2] || '/';
    return {
      addressValue: value,
      loadUrl: `view-source:${bzzRoutePrefix}${hash}${path}`,
    };
  }

  const ipfsMatch = innerUrl.match(/^ipfs:\/\/([A-Za-z0-9]+)(\/.*)?$/);
  if (ipfsMatch && !isEnsHost(ipfsMatch[1])) {
    const cid = ipfsMatch[1];
    const path = ipfsMatch[2] || '';
    return {
      addressValue: value,
      loadUrl: `view-source:${ipfsRoutePrefix}${cid}${path}`,
    };
  }

  const ipnsMatch = innerUrl.match(/^ipns:\/\/([A-Za-z0-9.-]+)(\/.*)?$/);
  if (ipnsMatch && !isEnsHost(ipnsMatch[1])) {
    const name = ipnsMatch[1];
    const path = ipnsMatch[2] || '';
    return {
      addressValue: value,
      loadUrl: `view-source:${ipnsRoutePrefix}${name}${path}`,
    };
  }

  const displayInner = deriveDisplayAddress({
    url: innerUrl,
    bzzRoutePrefix,
    homeUrlNormalized,
    ipfsRoutePrefix,
    ipnsRoutePrefix,
    radicleApiPrefix,
    knownEnsNames,
  });

  return {
    addressValue: `view-source:${displayInner || innerUrl}`,
    loadUrl: value,
  };
};

export const deriveSwitchedTabDisplay = ({
  url = '',
  isLoading = false,
  addressBarSnapshot = '',
  isViewingSource = false,
  bzzRoutePrefix,
  homeUrlNormalized,
  ipfsRoutePrefix = null,
  ipnsRoutePrefix = null,
  radicleApiPrefix = null,
  knownEnsNames = new Map(),
} = {}) => {
  if (isLoading && addressBarSnapshot) {
    return addressBarSnapshot;
  }

  const urlToDerive = url.startsWith('view-source:') ? url.slice(12) : url;
  const internalPageName = getInternalPageName(urlToDerive);
  if (internalPageName && internalPageName !== 'home') {
    return `freedom://${internalPageName}`;
  }

  let display = deriveDisplayAddress({
    url: urlToDerive,
    bzzRoutePrefix,
    homeUrlNormalized,
    ipfsRoutePrefix,
    ipnsRoutePrefix,
    radicleApiPrefix,
    knownEnsNames,
  });

  if (display === homeUrlNormalized) {
    display = '';
  }

  if (isViewingSource && display) {
    return `view-source:${display}`;
  }

  return display;
};

export const getBookmarkBarState = ({
  url = '',
  bookmarkBarOverride = false,
  homeUrl = '',
  homeUrlNormalized = '',
} = {}) => {
  const isHomePage = url === homeUrlNormalized || url === homeUrl || !url;

  return {
    isHomePage,
    visible: isHomePage || bookmarkBarOverride,
  };
};

export const getOriginalUrlFromErrorPage = (url, errorUrlBase = '') => {
  if (!url) {
    return null;
  }

  const isErrorPage =
    (errorUrlBase && url.startsWith(errorUrlBase)) || url.includes('/error.html?');
  if (!isErrorPage) {
    return null;
  }

  try {
    return new URL(url).searchParams.get('url');
  } catch {
    return null;
  }
};
