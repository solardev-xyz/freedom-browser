const log = require('./logger');
const { activeBzzBases, activeIpfsBases } = require('./state');
const { getBeeApiUrl, getIpfsGatewayUrl } = require('./service-registry');
const { URL } = require('url');

const sanitizeUrlForLog = (rawUrl) => {
  if (!rawUrl || typeof rawUrl !== 'string') return 'unknown';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'file:') {
      return 'file://<redacted>';
    }
    if (
      parsed.protocol === 'bzz:' ||
      parsed.protocol === 'ipfs:' ||
      parsed.protocol === 'ipns:' ||
      parsed.protocol === 'freedom:'
    ) {
      return `${parsed.protocol}//<redacted>`;
    }
    return parsed.origin;
  } catch {
    if (
      rawUrl.startsWith('bzz://') ||
      rawUrl.startsWith('ipfs://') ||
      rawUrl.startsWith('ipns://') ||
      rawUrl.startsWith('freedom://')
    ) {
      return `${rawUrl.split('://')[0]}://<redacted>`;
    }
    return 'unknown';
  }
};

// Validate IPFS CID format (mirrors src/renderer/lib/url-utils.js)
function isValidCid(str) {
  if (!str) return false;
  // CIDv0: Qm + 44 base58 chars
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(str)) return true;
  // CIDv1 base32: baf + 50+ lowercase base32 chars
  if (/^baf[a-z2-7]{50,}$/i.test(str)) return true;
  // CIDv1 base58btc: z + 40+ base58 chars
  if (/^z[1-9A-HJ-NP-Za-km-z]{40,}$/.test(str)) return true;
  return false;
}

// Validate IPNS name: DNS name (e.g., docs.ipfs.io) or libp2p key (k51..., 12D3...)
function isValidIpnsName(str) {
  if (!str) return false;
  // Only allow alphanumeric, dots, hyphens, underscores (covers DNS names and base36/base58 keys)
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(str);
}

/**
 * Convert a custom protocol URL (bzz://, ipfs://, ipns://) to a gateway URL
 * Uses service registry for dynamic port resolution.
 * Validates that the URL contains a non-empty hash/CID/name before converting,
 * to avoid sending malformed paths to the gateway.
 * @param {string} url - The URL to check/convert
 * @returns {{ converted: boolean, url: string }} Result with converted flag and URL
 */
function convertProtocolUrl(url) {
  if (!url) {
    return { converted: false, url };
  }

  // Handle bzz:// protocol
  if (url.startsWith('bzz://')) {
    const afterScheme = url.slice(6).replace(/^\/+/, '');
    if (!afterScheme) {
      return { converted: false, url };
    }
    const hash = afterScheme.split(/[/?#]/)[0];
    if (!hash || !/^[a-fA-F0-9]{64}([a-fA-F0-9]{64})?$/.test(hash)) {
      return { converted: false, url };
    }
    const beeApiUrl = getBeeApiUrl();
    const gatewayUrl = `${beeApiUrl}/bzz/${afterScheme}`;
    return { converted: true, url: gatewayUrl };
  }

  // Handle ipfs:// protocol
  if (url.startsWith('ipfs://')) {
    const afterScheme = url.slice(7).replace(/^\/+/, '');
    if (!afterScheme) {
      return { converted: false, url };
    }
    const cid = afterScheme.split(/[/?#]/)[0];
    if (!cid || !isValidCid(cid)) {
      return { converted: false, url };
    }
    const ipfsGatewayUrl = getIpfsGatewayUrl();
    const gatewayUrl = `${ipfsGatewayUrl}/ipfs/${afterScheme}`;
    return { converted: true, url: gatewayUrl };
  }

  // Handle ipns:// protocol
  if (url.startsWith('ipns://')) {
    const afterScheme = url.slice(7).replace(/^\/+/, '');
    if (!afterScheme) {
      return { converted: false, url };
    }
    const name = afterScheme.split(/[/?#]/)[0];
    if (!name || !isValidIpnsName(name)) {
      return { converted: false, url };
    }
    const ipfsGatewayUrl = getIpfsGatewayUrl();
    const gatewayUrl = `${ipfsGatewayUrl}/ipns/${afterScheme}`;
    return { converted: true, url: gatewayUrl };
  }

  return { converted: false, url };
}

/**
 * Determines if a request should be rewritten to stay within a content-addressed context.
 * @param {string} requestUrl - The URL being requested
 * @param {string} baseUrl - The current base URL (bzz or ipfs)
 * @param {string} type - 'bzz' or 'ipfs'
 * @returns {{ shouldRewrite: boolean, reason?: string }} Result with reason if not rewriting
 */
function shouldRewriteRequest(requestUrl, baseUrl) {
  if (!baseUrl) {
    return { shouldRewrite: false, reason: 'no_base_url' };
  }

  let requested;
  let base;
  try {
    requested = new URL(requestUrl);
    base = new URL(baseUrl);
  } catch {
    return { shouldRewrite: false, reason: 'invalid_url' };
  }

  const normalizedPath = requested.pathname.toLowerCase();

  // Don't rewrite requests that are already content-addressed paths
  if (normalizedPath.startsWith('/bzz/')) {
    return { shouldRewrite: false, reason: 'already_bzz_path' };
  }
  if (normalizedPath.startsWith('/ipfs/') || normalizedPath.startsWith('/ipns/')) {
    return { shouldRewrite: false, reason: 'already_ipfs_path' };
  }

  // Don't rewrite cross-origin requests
  if (requested.origin !== base.origin) {
    return { shouldRewrite: false, reason: 'cross_origin' };
  }

  return { shouldRewrite: true };
}

/**
 * Builds the rewritten URL for a request that should stay within the Swarm hash context.
 * @param {string} requestUrl - The URL being requested
 * @param {string} baseUrl - The current bzz base URL (e.g., http://127.0.0.1:1633/bzz/hash/)
 * @returns {string|null} The rewritten URL, or null if URLs are invalid
 */
function buildRewriteTarget(requestUrl, baseUrl) {
  let requested;
  let base;
  try {
    requested = new URL(requestUrl);
    base = new URL(baseUrl);
  } catch {
    return null;
  }

  const relativePath = requested.pathname.replace(/^\//, '');
  return `${base.href}${relativePath}${requested.search}${requested.hash}`;
}

/**
 * Check if a URL targets the Bee API's /bzz/ endpoint with an invalid hash.
 * Blocks requests that would cause "bzz download: invalid path" errors on the Bee node.
 * @param {string} url - The final URL about to be sent
 * @returns {boolean} True if the request should be blocked
 */
function shouldBlockInvalidBzzRequest(url) {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length >= 1 && pathParts[0] === 'bzz') {
      // /bzz/ with no hash or an invalid hash
      const hash = pathParts[1] || '';
      if (!hash || !/^[a-fA-F0-9]{64}([a-fA-F0-9]{64})?$/.test(hash)) {
        return true;
      }
    }
  } catch {
    // Not a valid URL, let it through (will fail naturally)
  }
  return false;
}

function registerRequestRewriter(targetSession) {
  if (!targetSession) {
    return;
  }

  targetSession.webRequest.onBeforeRequest((details, callback) => {
    const webContentsId = details.webContentsId;

    // First, check for custom protocol URLs (bzz://, ipfs://, ipns://)
    const { converted, url: convertedUrl } = convertProtocolUrl(details.url);
    if (converted) {
      log.info(
        `[rewrite:protocol] ${sanitizeUrlForLog(details.url)} -> ${sanitizeUrlForLog(convertedUrl)}`
      );
      callback({ redirectURL: convertedUrl });
      return;
    }

    // Check for Swarm (bzz) base first
    const bzzBaseUrl = activeBzzBases.get(webContentsId);
    if (bzzBaseUrl) {
      const { shouldRewrite } = shouldRewriteRequest(details.url, bzzBaseUrl);
      if (shouldRewrite) {
        const redirectTarget = buildRewriteTarget(details.url, bzzBaseUrl);
        if (redirectTarget) {
          log.info(
            `[rewrite:bzz] ${sanitizeUrlForLog(details.url)} -> ${sanitizeUrlForLog(redirectTarget)}`
          );
          callback({ redirectURL: redirectTarget });
          return;
        }
      }
    }

    // Check for IPFS base
    const ipfsBaseUrl = activeIpfsBases.get(webContentsId);
    if (ipfsBaseUrl) {
      const { shouldRewrite } = shouldRewriteRequest(details.url, ipfsBaseUrl);
      if (shouldRewrite) {
        const redirectTarget = buildRewriteTarget(details.url, ipfsBaseUrl);
        if (redirectTarget) {
          log.info(
            `[rewrite:ipfs] ${sanitizeUrlForLog(details.url)} -> ${sanitizeUrlForLog(redirectTarget)}`
          );
          callback({ redirectURL: redirectTarget });
          return;
        }
      }
    }

    // Final guard: block requests to /bzz/ with missing or invalid hash
    // to prevent "bzz download: invalid path" errors on the Bee node
    if (shouldBlockInvalidBzzRequest(details.url)) {
      callback({ cancel: true });
      return;
    }

    // No rewrite needed
    callback({});
  });
}

module.exports = {
  registerRequestRewriter,
  shouldRewriteRequest,
  buildRewriteTarget,
  convertProtocolUrl,
  shouldBlockInvalidBzzRequest,
};
