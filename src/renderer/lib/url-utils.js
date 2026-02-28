export const ensureTrailingSlash = (value = '') => (value.endsWith('/') ? value : `${value}/`);

// Check if a string looks like a valid Swarm hash (64 hex characters)
const isValidSwarmHash = (str) => /^[a-fA-F0-9]{64}$/.test(str);

// Check if a string looks like a valid IPFS CID
// CIDv0: Starts with Qm, 46 characters, base58
// CIDv1: Starts with bafy (bafyb...), variable length, base32
export const isValidCid = (str) => {
  if (!str || typeof str !== 'string') return false;

  // CIDv0: Qm followed by 44 base58 characters (total 46)
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(str)) {
    return true;
  }

  // CIDv1 with base32 (most common): starts with bafy, bafk, etc.
  // Typically 59 characters for raw/dag-pb, but can vary
  if (/^baf[a-z2-7]{50,}$/i.test(str)) {
    return true;
  }

  // CIDv1 with base58btc: starts with z
  if (/^z[1-9A-HJ-NP-Za-km-z]{40,}$/.test(str)) {
    return true;
  }

  return false;
};

// Check if a string looks like a valid Radicle ID (RID)
// RIDs are base58 strings starting with 'z', variable length
export const isValidRadicleId = (str) => {
  if (!str || typeof str !== 'string') return false;

  // Radicle IDs start with 'z' followed by base58 characters
  // Length varies - e.g. z3gqcJUoA1n9HaHKufZs5FCSGazv5 is 30 chars
  if (/^z[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(str)) {
    return true;
  }

  return false;
};

// Check if a string looks like a domain name (not a Swarm hash)
const looksLikeDomain = (str) => {
  // Must contain at least one dot
  if (!str.includes('.')) return false;

  // Extract the part before any path/query
  const hostPart = str.split(/[/?#]/)[0];

  // Should not be a valid Swarm hash
  if (isValidSwarmHash(hostPart)) return false;

  // Check for common domain patterns
  // - Has a TLD-like ending (2-10 chars after last dot)
  // - No spaces
  // - Reasonable characters for a domain
  const domainRegex =
    /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,10}$/;
  return domainRegex.test(hostPart);
};

export const parseHashInput = (rawInput, bzzRoutePrefix) => {
  const withoutScheme = rawInput.replace(/^bzz:\/\//i, '').replace(/^\/+/, '');
  if (!withoutScheme) {
    return null;
  }

  let working = withoutScheme;
  let fragment = '';
  let query = '';

  const hashIndex = working.indexOf('#');
  if (hashIndex !== -1) {
    fragment = working.slice(hashIndex);
    working = working.slice(0, hashIndex);
  }

  const queryIndex = working.indexOf('?');
  if (queryIndex !== -1) {
    query = working.slice(queryIndex);
    working = working.slice(0, queryIndex);
  }

  const slashIndex = working.indexOf('/');
  let hash = working;
  let path = '';
  if (slashIndex !== -1) {
    hash = working.slice(0, slashIndex);
    path = working.slice(slashIndex);
  }

  if (!hash) {
    return null;
  }

  const tail = `${path}${query}${fragment}`;
  const baseUrl = ensureTrailingSlash(`${bzzRoutePrefix}${hash}`);

  return {
    hash,
    tail,
    baseUrl,
    displayValue: `bzz://${hash}${tail}`,
  };
};

export const composeTargetUrl = (baseUrl, suffix = '') => {
  // Ensure suffix doesn't start with / if we want to append it relative to base
  const cleanSuffix = suffix.startsWith('/') ? suffix.slice(1) : suffix;
  try {
    return new URL(cleanSuffix, baseUrl).toString();
  } catch {
    return `${baseUrl}${cleanSuffix}`;
  }
};

export const deriveBzzBaseFromUrl = (input) => {
  if (!input) {
    return null;
  }
  try {
    const parsed = typeof input === 'string' ? new URL(input) : input;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length >= 2 && segments[0].toLowerCase() === 'bzz') {
      const hash = segments[1];
      if (hash) {
        return ensureTrailingSlash(`${parsed.origin}/bzz/${hash}`);
      }
    }
  } catch {
    return null;
  }
  return null;
};

export const formatBzzUrl = (input, bzzRoutePrefix) => {
  const raw = (input || '').trim();
  if (!raw) {
    return null;
  }

  try {
    const asUrl = new URL(raw);
    if (asUrl.protocol === 'bzz:') {
      const hashInput = `${asUrl.hostname}${asUrl.pathname}${asUrl.search}${asUrl.hash}`;
      const parsedBzz = parseHashInput(hashInput, bzzRoutePrefix);
      if (!parsedBzz) {
        return null;
      }
      return {
        targetUrl: composeTargetUrl(parsedBzz.baseUrl, parsedBzz.tail || ''),
        displayValue: parsedBzz.displayValue,
        baseUrl: parsedBzz.baseUrl,
      };
    }
    const derivedBase = deriveBzzBaseFromUrl(asUrl);
    const displayValue = deriveDisplayValue(asUrl.toString(), bzzRoutePrefix, '');
    return {
      targetUrl: asUrl.toString(),
      displayValue,
      baseUrl: derivedBase,
    };
  } catch {
    // URL parsing failed - could be a domain without protocol or a Swarm hash

    // Check if it looks like a regular domain (e.g., "spiegel.de", "example.com/path")
    if (looksLikeDomain(raw)) {
      const urlWithProtocol = `https://${raw}`;
      return {
        targetUrl: urlWithProtocol,
        displayValue: urlWithProtocol,
        baseUrl: null,
      };
    }

    // Extract potential hash (first segment before /)
    const firstSegment = raw.split('/')[0].replace(/^bzz:\/\//i, '');

    // Only treat as Swarm hash if it's valid hex (64 chars)
    if (!isValidSwarmHash(firstSegment)) {
      return null;
    }

    const parsed = parseHashInput(raw, bzzRoutePrefix);
    if (!parsed) {
      return null;
    }
    return {
      targetUrl: composeTargetUrl(parsed.baseUrl, parsed.tail || ''),
      displayValue: parsed.displayValue,
      baseUrl: parsed.baseUrl,
    };
  }
};

/**
 * Apply ENS name preservation to a display URL.
 * If the URL is a bzz/ipfs/ipns URL with a hash/CID that has a known ENS name,
 * replace it with the ens:// URL format.
 * @param {string} displayUrl - Display URL like "bzz://abc123/path" or "ipfs://QmHash/path"
 * @param {Map} knownEnsNames - Map of hash/CID -> ENS name
 * @returns {string} Display URL with ENS name substituted if applicable
 */
export const applyEnsNamePreservation = (displayUrl, knownEnsNames) => {
  if (!displayUrl || !knownEnsNames || knownEnsNames.size === 0) {
    return displayUrl;
  }

  // Handle view-source: prefix - apply ENS preservation to inner URL and prepend view-source:
  if (displayUrl.startsWith('view-source:')) {
    const innerUrl = displayUrl.slice(12); // 'view-source:'.length === 12
    const innerResult = applyEnsNamePreservation(innerUrl, knownEnsNames);
    return `view-source:${innerResult}`;
  }

  let derived = displayUrl;

  // Apply ENS name preservation for Swarm
  const bzzMatch = derived.match(/^bzz:\/\/([a-fA-F0-9]+)/);
  if (bzzMatch) {
    const hash = bzzMatch[1].toLowerCase();
    const name = knownEnsNames.get(hash);
    if (name) {
      const prefixLen = bzzMatch[0].length;
      const path = derived.slice(prefixLen);
      derived = `ens://${name}${path}`;
    }
  }

  // Apply ENS name preservation for IPFS
  const ipfsMatch = derived.match(/^ipfs:\/\/([A-Za-z0-9]+)/);
  if (ipfsMatch) {
    const cid = ipfsMatch[1];
    const name = knownEnsNames.get(cid);
    if (name) {
      const prefixLen = ipfsMatch[0].length;
      const path = derived.slice(prefixLen);
      derived = `ens://${name}${path}`;
    }
  }

  // Apply ENS name preservation for IPNS
  const ipnsMatch = derived.match(/^ipns:\/\/([A-Za-z0-9.-]+)/);
  if (ipnsMatch) {
    const id = ipnsMatch[1];
    const name = knownEnsNames.get(id);
    if (name) {
      const prefixLen = ipnsMatch[0].length;
      const path = derived.slice(prefixLen);
      derived = `ens://${name}${path}`;
    }
  }

  return derived;
};

export const deriveDisplayValue = (
  url,
  bzzRoutePrefix,
  homeUrlNormalized,
  ipfsRoutePrefix = null,
  ipnsRoutePrefix = null,
  radicleApiPrefix = null
) => {
  if (!url) {
    return '';
  }

  if (url === 'about:blank' || url === homeUrlNormalized) {
    return '';
  }

  // Handle view-source: prefix - derive display value for inner URL and prepend view-source:
  if (url.startsWith('view-source:')) {
    const innerUrl = url.slice(12); // 'view-source:'.length === 12
    const innerDisplay = deriveDisplayValue(
      innerUrl,
      bzzRoutePrefix,
      homeUrlNormalized,
      ipfsRoutePrefix,
      ipnsRoutePrefix
    );
    return innerDisplay ? `view-source:${innerDisplay}` : url;
  }

  if (url.startsWith(bzzRoutePrefix)) {
    const remainder = url.slice(bzzRoutePrefix.length);
    try {
      const decoded = decodeURIComponent(remainder).replace(/\/+$/, '');
      return decoded ? `bzz://${decoded}` : '';
    } catch {
      const cleaned = remainder.replace(/\/+$/, '');
      return cleaned ? `bzz://${cleaned}` : '';
    }
  }

  if (ipfsRoutePrefix && url.startsWith(ipfsRoutePrefix)) {
    const remainder = url.slice(ipfsRoutePrefix.length);
    try {
      const decoded = decodeURIComponent(remainder).replace(/\/+$/, '');
      return decoded ? `ipfs://${decoded}` : '';
    } catch {
      const cleaned = remainder.replace(/\/+$/, '');
      return cleaned ? `ipfs://${cleaned}` : '';
    }
  }

  if (ipnsRoutePrefix && url.startsWith(ipnsRoutePrefix)) {
    const remainder = url.slice(ipnsRoutePrefix.length);
    try {
      const decoded = decodeURIComponent(remainder).replace(/\/+$/, '');
      return decoded ? `ipns://${decoded}` : '';
    } catch {
      const cleaned = remainder.replace(/\/+$/, '');
      return cleaned ? `ipns://${cleaned}` : '';
    }
  }

  if (radicleApiPrefix && url.startsWith(radicleApiPrefix)) {
    const remainder = url.slice(radicleApiPrefix.length);
    try {
      const decoded = decodeURIComponent(remainder).replace(/\/+$/, '');
      return decoded ? `rad://${decoded}` : '';
    } catch {
      const cleaned = remainder.replace(/\/+$/, '');
      return cleaned ? `rad://${cleaned}` : '';
    }
  }

  return url;
};

// ============ IPFS URL Utilities ============

/**
 * Parse an IPFS input (CID with optional path/query/fragment)
 * @param {string} rawInput - Input like "QmHash/path" or "ipfs://QmHash/path"
 * @param {string} ipfsRoutePrefix - Gateway prefix like "http://127.0.0.1:8080/ipfs/"
 * @returns {object|null} Parsed result with cid, tail, baseUrl, displayValue
 */
export const parseIpfsInput = (rawInput, ipfsRoutePrefix) => {
  // Remove ipfs:// or ipns:// scheme
  let withoutScheme = rawInput
    .replace(/^ipfs:\/\//i, '')
    .replace(/^ipns:\/\//i, '')
    .replace(/^\/+/, '');
  const isIpns = /^ipns:\/\//i.test(rawInput);

  if (!withoutScheme) {
    return null;
  }

  let working = withoutScheme;
  let fragment = '';
  let query = '';

  const hashIndex = working.indexOf('#');
  if (hashIndex !== -1) {
    fragment = working.slice(hashIndex);
    working = working.slice(0, hashIndex);
  }

  const queryIndex = working.indexOf('?');
  if (queryIndex !== -1) {
    query = working.slice(queryIndex);
    working = working.slice(0, queryIndex);
  }

  const slashIndex = working.indexOf('/');
  let cid = working;
  let path = '';
  if (slashIndex !== -1) {
    cid = working.slice(0, slashIndex);
    path = working.slice(slashIndex);
  }

  if (!cid) {
    return null;
  }

  const tail = `${path}${query}${fragment}`;
  const protocol = isIpns ? 'ipns' : 'ipfs';
  // For IPNS, use ipns route prefix instead
  const routePrefix = isIpns ? ipfsRoutePrefix.replace('/ipfs/', '/ipns/') : ipfsRoutePrefix;
  const baseUrl = ensureTrailingSlash(`${routePrefix}${cid}`);

  return {
    cid,
    tail,
    baseUrl,
    protocol,
    displayValue: `${protocol}://${cid}${tail}`,
  };
};

/**
 * Derive IPFS base URL from a gateway URL
 * @param {string|URL} input - URL like "http://127.0.0.1:8080/ipfs/QmHash/path"
 * @returns {string|null} Base URL like "http://127.0.0.1:8080/ipfs/QmHash/"
 */
export const deriveIpfsBaseFromUrl = (input) => {
  if (!input) {
    return null;
  }
  try {
    const parsed = typeof input === 'string' ? new URL(input) : input;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const prefix = segments[0].toLowerCase();
      if (prefix === 'ipfs' || prefix === 'ipns') {
        const cid = segments[1];
        if (cid) {
          return ensureTrailingSlash(`${parsed.origin}/${prefix}/${cid}`);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
};

/**
 * Format user input into an IPFS gateway URL
 * @param {string} input - User input (CID, ipfs://CID, ipns://name, etc.)
 * @param {string} ipfsRoutePrefix - Gateway prefix like "http://127.0.0.1:8080/ipfs/"
 * @returns {object|null} Object with targetUrl, displayValue, baseUrl, protocol
 */
export const formatIpfsUrl = (input, ipfsRoutePrefix) => {
  const raw = (input || '').trim();
  if (!raw) {
    return null;
  }

  try {
    const asUrl = new URL(raw);

    // Handle ipfs:// protocol
    if (asUrl.protocol === 'ipfs:') {
      const cidInput = `${asUrl.hostname}${asUrl.pathname}${asUrl.search}${asUrl.hash}`;
      const parsed = parseIpfsInput(cidInput, ipfsRoutePrefix);
      if (!parsed) {
        return null;
      }
      return {
        targetUrl: composeTargetUrl(parsed.baseUrl, parsed.tail || ''),
        displayValue: parsed.displayValue,
        baseUrl: parsed.baseUrl,
        protocol: 'ipfs',
      };
    }

    // Handle ipns:// protocol
    if (asUrl.protocol === 'ipns:') {
      const nameInput = `ipns://${asUrl.hostname}${asUrl.pathname}${asUrl.search}${asUrl.hash}`;
      const parsed = parseIpfsInput(nameInput, ipfsRoutePrefix);
      if (!parsed) {
        return null;
      }
      return {
        targetUrl: composeTargetUrl(parsed.baseUrl, parsed.tail || ''),
        displayValue: parsed.displayValue,
        baseUrl: parsed.baseUrl,
        protocol: 'ipns',
      };
    }

    // Check if it's already a gateway URL
    const derivedBase = deriveIpfsBaseFromUrl(asUrl);
    if (derivedBase) {
      const isIpns = asUrl.pathname.toLowerCase().startsWith('/ipns/');
      return {
        targetUrl: asUrl.toString(),
        displayValue: deriveDisplayValue(
          asUrl.toString(),
          '',
          '',
          ipfsRoutePrefix,
          ipfsRoutePrefix.replace('/ipfs/', '/ipns/')
        ),
        baseUrl: derivedBase,
        protocol: isIpns ? 'ipns' : 'ipfs',
      };
    }

    return null;
  } catch {
    // URL parsing failed - check if it's a raw CID
    const firstSegment = raw
      .split('/')[0]
      .replace(/^ipfs:\/\//i, '')
      .replace(/^ipns:\/\//i, '');

    // Check if it looks like a CID
    if (isValidCid(firstSegment)) {
      const parsed = parseIpfsInput(raw, ipfsRoutePrefix);
      if (!parsed) {
        return null;
      }
      return {
        targetUrl: composeTargetUrl(parsed.baseUrl, parsed.tail || ''),
        displayValue: parsed.displayValue,
        baseUrl: parsed.baseUrl,
        protocol: parsed.protocol,
      };
    }

    return null;
  }
};

// ============ Radicle URL Utilities ============

/**
 * Parse a Radicle input (RID with optional path)
 * Accepts both rad:RID and rad://RID formats
 * @param {string} rawInput - Input like "zRID", "rad:zRID/tree/main/path", or "rad://zRID"
 * @param {string} radicleApiPrefix - API prefix like "http://127.0.0.1:8080/api/v1/repos/"
 * @returns {object|null} Parsed result with rid, tail, baseUrl, displayValue
 */
export const parseRadicleInput = (rawInput, radicleApiPrefix) => {
  // Remove rad: or rad:// prefix
  let withoutScheme = rawInput.replace(/^rad:\/\//i, '').replace(/^rad:/i, '').replace(/^\/+/, '');

  if (!withoutScheme) {
    return null;
  }

  let working = withoutScheme;
  let fragment = '';
  let query = '';

  const hashIndex = working.indexOf('#');
  if (hashIndex !== -1) {
    fragment = working.slice(hashIndex);
    working = working.slice(0, hashIndex);
  }

  const queryIndex = working.indexOf('?');
  if (queryIndex !== -1) {
    query = working.slice(queryIndex);
    working = working.slice(0, queryIndex);
  }

  const slashIndex = working.indexOf('/');
  let rid = working;
  let path = '';
  if (slashIndex !== -1) {
    rid = working.slice(0, slashIndex);
    path = working.slice(slashIndex);
  }

  if (!rid) {
    return null;
  }

  const tail = `${path}${query}${fragment}`;
  const baseUrl = ensureTrailingSlash(`${radicleApiPrefix}${rid}`);

  return {
    rid,
    tail,
    baseUrl,
    displayValue: `rad://${rid}${tail}`,
  };
};

/**
 * Derive Radicle base URL from an API URL
 * @param {string|URL} input - URL like "http://127.0.0.1:8080/api/v1/repos/zRID/tree/main"
 * @returns {string|null} Base URL like "http://127.0.0.1:8080/api/v1/repos/zRID/"
 */
export const deriveRadBaseFromUrl = (input) => {
  if (!input) {
    return null;
  }
  try {
    const parsed = typeof input === 'string' ? new URL(input) : input;
    const segments = parsed.pathname.split('/').filter(Boolean);
    // Look for /api/v1/repos/RID pattern
    if (segments.length >= 4 &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'repos') {
      const rid = segments[3];
      if (isValidRadicleId(rid)) {
        return ensureTrailingSlash(`${parsed.origin}/api/v1/repos/${rid}`);
      }
    }
  } catch {
    return null;
  }
  return null;
};

/**
 * Format user input into a Radicle browser page URL
 * @param {string} input - User input (RID, rad:RID, etc.)
 * @param {string} radicleBase - Radicle httpd base URL like "http://127.0.0.1:8780"
 * @returns {object|null} Object with targetUrl, displayValue, protocol
 */
export const formatRadicleUrl = (input, radicleBase) => {
  const raw = (input || '').trim();
  if (!raw) {
    return null;
  }

  // Helper to build rad-browser.html URL
  const buildBrowserUrl = (rid, path) => {
    const browserUrl = new URL('pages/rad-browser.html', window.location.href);
    browserUrl.searchParams.set('rid', rid);
    browserUrl.searchParams.set('base', radicleBase);
    if (path) {
      browserUrl.searchParams.set('path', path);
    }
    return browserUrl.toString();
  };

  // Check if it starts with rad: or rad:// prefix
  if (raw.toLowerCase().startsWith('rad:')) {
    // Handle both rad:RID and rad://RID formats
    const withoutScheme = raw.replace(/^rad:\/\//i, '').replace(/^rad:/i, '').replace(/^\/+/, '');
    if (!withoutScheme) return null;

    const slashIndex = withoutScheme.indexOf('/');
    const rid = slashIndex === -1 ? withoutScheme : withoutScheme.slice(0, slashIndex);
    const path = slashIndex === -1 ? '' : withoutScheme.slice(slashIndex);

    if (!rid || !isValidRadicleId(rid)) return null;

    return {
      targetUrl: buildBrowserUrl(rid, path),
      displayValue: `rad://${rid}${path}`,
      protocol: 'radicle',
    };
  }

  // Check if it's a raw Radicle ID (starts with z)
  const slashIndex = raw.indexOf('/');
  const firstSegment = slashIndex === -1 ? raw : raw.slice(0, slashIndex);

  if (isValidRadicleId(firstSegment)) {
    const rid = firstSegment;
    const path = slashIndex === -1 ? '' : raw.slice(slashIndex);

    return {
      targetUrl: buildBrowserUrl(rid, path),
      displayValue: `rad://${rid}${path}`,
      protocol: 'radicle',
    };
  }

  return null;
};

/**
 * Derive display value for Radicle URLs
 * @param {string} url - API URL like "http://127.0.0.1:8080/api/v1/repos/zRID/tree/main"
 * @param {string} radicleApiPrefix - API prefix to strip
 * @returns {string} Display value like "rad://zRID/tree/main"
 */
export const deriveRadicleDisplayValue = (url, radicleApiPrefix) => {
  if (!url || !radicleApiPrefix) return url;

  if (url.startsWith(radicleApiPrefix)) {
    const remainder = url.slice(radicleApiPrefix.length);
    try {
      const decoded = decodeURIComponent(remainder).replace(/\/+$/, '');
      return decoded ? `rad://${decoded}` : '';
    } catch {
      const cleaned = remainder.replace(/\/+$/, '');
      return cleaned ? `rad://${cleaned}` : '';
    }
  }

  return url;
};
