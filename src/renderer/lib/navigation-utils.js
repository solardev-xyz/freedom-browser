import { applyEnsNamePreservation, deriveDisplayValue } from './url-utils.js';
import { getInternalPageName } from './page-urls.js';
import { cidV0ToV1Base32 } from './cid-utils.js';

export const resolveProtocolIconType = ({
  value = '',
  ensProtocols = new Map(),
  enableRadicleIntegration = false,
  currentPageSecure = false,
} = {}) => {
  const normalizedValue = value.toLowerCase();
  let protocol = 'http';

  if (normalizedValue.startsWith('ens://') || normalizedValue.endsWith('.eth') || normalizedValue.endsWith('.box')) {
    const ensName = normalizedValue.startsWith('ens://')
      ? normalizedValue.slice(6).split('/')[0]
      : normalizedValue.split('/')[0];
    protocol = ensProtocols.get(ensName) || 'http';
  } else if (normalizedValue.startsWith('bzz://')) {
    protocol = 'swarm';
  } else if (normalizedValue.startsWith('ipfs://')) {
    protocol = 'ipfs';
  } else if (normalizedValue.startsWith('ipns://')) {
    protocol = 'ipns';
  } else if (normalizedValue.startsWith('rad://') && enableRadicleIntegration) {
    protocol = 'radicle';
  } else if (normalizedValue.startsWith('freedom://')) {
    protocol = null;
  } else if (normalizedValue.startsWith('https://') || currentPageSecure) {
    protocol = 'https';
  }

  return protocol;
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
    // `ens://name` after the redirect lands.
    if (ipfsMatch[1].startsWith('Qm')) {
      const cidV1 = cidV0ToV1Base32(ipfsMatch[1]);
      if (cidV1) knownEnsPairs.push([cidV1, ensName]);
    }
    resolvedProtocol = 'ipfs';
  }

  const ipnsMatch = targetUri.match(/^ipns:\/\/([A-Za-z0-9.-]+)/);
  if (ipnsMatch) {
    knownEnsPairs.push([ipnsMatch[1], ensName]);
    resolvedProtocol = 'ipfs';
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
  if (bzzMatch) {
    const hash = bzzMatch[1];
    const path = bzzMatch[2] || '/';
    return {
      addressValue: value,
      loadUrl: `view-source:${bzzRoutePrefix}${hash}${path}`,
    };
  }

  const ipfsMatch = innerUrl.match(/^ipfs:\/\/([A-Za-z0-9]+)(\/.*)?$/);
  if (ipfsMatch) {
    const cid = ipfsMatch[1];
    const path = ipfsMatch[2] || '';
    return {
      addressValue: value,
      loadUrl: `view-source:${ipfsRoutePrefix}${cid}${path}`,
    };
  }

  const ipnsMatch = innerUrl.match(/^ipns:\/\/([A-Za-z0-9.-]+)(\/.*)?$/);
  if (ipnsMatch) {
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
