/**
 * Read-only Ant API access for the chrome renderer, over IPC.
 *
 * The chrome used to `fetch()` the node's HTTP API itself, which is why the
 * node's config carried `cors-allowed-origins: "null"` (the chrome's `file:`
 * origin) — an entry that also let any `data:` frame or sandboxed iframe read
 * API responses (docs/security-audit-electron.md, O-1; #428). The chrome now
 * asks the main process instead, so the node allows no browser origin at all.
 *
 * GET only, and only the endpoints the chrome's node-status, wallet and
 * publish-setup screens read. The channel is chrome-only: it has no webview
 * tier in ipc-sender-policy.js, so a tab cannot call it.
 */

const log = require('../logger');
const { getAntApiUrl } = require('../service-registry');

const CHROME_ANT_ENDPOINTS = new Set([
  '/addresses',
  '/chequebook/address',
  '/chequebook/balance',
  '/health',
  '/node',
  '/peers',
  '/readiness',
  '/stamps',
  '/status',
  '/topology',
  '/wallet',
]);

const REQUEST_TIMEOUT_MS = 15_000;

function antApiBase() {
  // Same fallback order as the renderer's old `buildAntUrl`: the registry,
  // then the ANT_API / BEE_API developer override.
  const base = getAntApiUrl() || process.env.ANT_API || process.env.BEE_API || null;
  return typeof base === 'string' && base ? base.replace(/\/$/, '') : null;
}

/**
 * @returns {Promise<{ ok: boolean, status: number, data: any, error?: string }>}
 *   `error` is set when no response was received (node not ready,
 *   unreachable, timed out) — the renderer rethrows it, matching the thrown
 *   `fetch` rejection callers handled before.
 */
async function antApiGet(endpoint, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (typeof endpoint !== 'string' || !CHROME_ANT_ENDPOINTS.has(endpoint)) {
    return { ok: false, status: 0, data: null, error: 'Unsupported Ant API endpoint' };
  }
  const base = antApiBase();
  if (!base) {
    return { ok: false, status: 0, data: null, error: 'Ant endpoint is not ready' };
  }
  let response;
  let text;
  try {
    response = await fetchImpl(`${base}${endpoint}`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (err) {
    log.debug(`[ant-api] GET ${endpoint} failed: ${err?.message || err}`);
    return { ok: false, status: 0, data: null, error: 'Ant API unreachable' };
  }
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: response.ok, status: response.status, data };
}

module.exports = {
  antApiGet,
  CHROME_ANT_ENDPOINTS,
};
