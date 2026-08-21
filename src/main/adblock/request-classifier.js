/**
 * Pure request-classification helpers for the adblock service: Electron
 * resourceType mapping, URL scope checks, and host normalization /
 * allowlist matching with the same subdomain semantics as Freedom iOS
 * (`m.bild.de` is covered by an allowlisted `bild.de`; `evilbild.de` is not).
 */

const { URL } = require('url');

// Electron webRequest resourceType -> adblock engine request type.
const RESOURCE_TYPE_MAP = {
  mainFrame: 'main_frame',
  subFrame: 'sub_frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xhr',
  fetch: 'xhr',
  ping: 'ping',
  cspReport: 'csp_report',
  media: 'media',
  webSocket: 'websocket',
};

function mapResourceType(resourceType) {
  return RESOURCE_TYPE_MAP[resourceType] || 'other';
}

/**
 * Only ordinary web traffic is classified. Internal schemes (file:,
 * freedom:, devtools:) and decentralized protocols (bzz:, ipfs:, ipns:)
 * are out of scope — the latter are served by custom protocol handlers
 * and never carry third-party ad traffic directly; their https:
 * subresources still arrive here as regular requests.
 */
function isInterceptableUrl(url) {
  return (
    typeof url === 'string' &&
    (url.startsWith('http://') ||
      url.startsWith('https://') ||
      url.startsWith('ws://') ||
      url.startsWith('wss://'))
  );
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Local node APIs (Ant/Bee on 1633, IPFS, Radicle, and bzz-rewritten
 * subresources) must never be blocked, whatever the lists say.
 */
function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(hostname);
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function normalizeHost(host) {
  if (!host || typeof host !== 'string') return null;
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith('www.')) normalized = normalized.slice(4);
  if (normalized.endsWith('.')) normalized = normalized.slice(0, -1);
  return normalized || null;
}

/**
 * Both sides must already be normalized via `normalizeHost` — entries at
 * store time, the host once per request — so the hot path is pure string
 * comparison.
 */
function isHostAllowlisted(normalizedHost, normalizedEntries) {
  if (!normalizedHost) return false;
  for (const entry of normalizedEntries) {
    if (!entry) continue;
    if (normalizedHost === entry || normalizedHost.endsWith(`.${entry}`)) return true;
  }
  return false;
}

module.exports = {
  mapResourceType,
  isInterceptableUrl,
  isLoopbackHost,
  hostnameFromUrl,
  normalizeHost,
  isHostAllowlisted,
};
