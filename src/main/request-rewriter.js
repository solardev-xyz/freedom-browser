const log = require('./logger');
const { activeBzzBases, activeRadBases } = require('./state');
const { loadSettings } = require('./settings-store');
const { registerWebRequestHandler } = require('./webrequest-dispatcher');
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

// Note: `bzz://`, `ipfs://`, `ipns://`, and `rad:`/`rad://` are handled
// by custom protocol handlers in `src/main/swarm/bzz-protocol.js`,
// `src/main/ipfs/ipfs-protocol.js`, and `src/main/radicle/rad-protocol.js`;
// see README "Swarm Content Retrieval" and "IPFS / IPNS Content
// Retrieval". Requests for these schemes never reach the webRequest
// rewriter — they're dispatched to the protocol handlers before
// webRequest sees them, so this module only rewrites http(s) requests
// relative to an active bzz/rad base.

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
  if (normalizedPath.startsWith('/api/v1/repos/')) {
    return { shouldRewrite: false, reason: 'already_rad_path' };
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
 * @param {string} baseUrl - The current bzz base URL (e.g., <bee-api>/bzz/hash/)
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

/**
 * Pure dispatcher handler — examines a request and returns an action
 * object (`{redirectURL}` or `{cancel}`) or `null` to pass through.
 * Exported separately from the install step so tests can drive it
 * without mocking `session.webRequest`.
 */
function rewriteRequestForDispatch(details) {
  const webContentsId = details.webContentsId;

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
        return { redirectURL: redirectTarget };
      }
    }
  }

  // No IPFS rewriter arm — `ipfs://` and `ipns://` are standard schemes
  // dispatched to `src/main/ipfs/ipfs-protocol.js`, so the page origin is
  // `ipfs://<cid|name>/` and same-origin sub-resources never reach
  // webRequest as gateway URLs.

  // Check for Radicle base
  const radBaseUrl = activeRadBases.get(webContentsId);
  if (radBaseUrl && loadSettings().enableRadicleIntegration === true) {
    const { shouldRewrite } = shouldRewriteRequest(details.url, radBaseUrl);
    if (shouldRewrite) {
      const redirectTarget = buildRewriteTarget(details.url, radBaseUrl);
      if (redirectTarget) {
        log.info(
          `[rewrite:rad] ${sanitizeUrlForLog(details.url)} -> ${sanitizeUrlForLog(redirectTarget)}`
        );
        return { redirectURL: redirectTarget };
      }
    }
  }

  // Final guard: block requests to /bzz/ with missing or invalid hash
  // to prevent "bzz download: invalid path" errors on the Bee node
  if (shouldBlockInvalidBzzRequest(details.url)) {
    return { cancel: true };
  }

  return null;
}

/**
 * Register the request rewriter as an onBeforeRequest handler. Must run
 * before `attachWebRequestDispatcher()`.
 */
function installRequestRewriter() {
  registerWebRequestHandler('onBeforeRequest', 'request-rewriter', rewriteRequestForDispatch);
}

module.exports = {
  installRequestRewriter,
  rewriteRequestForDispatch,
  shouldRewriteRequest,
  buildRewriteTarget,
  shouldBlockInvalidBzzRequest,
  sanitizeUrlForLog,
};
