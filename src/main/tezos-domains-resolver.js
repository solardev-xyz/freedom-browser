const log = require('./logger');
const { ipcMain } = require('electron');
const IPC = require('../shared/ipc-channels');
const { UNAVAILABLE } = require('./core/naming-driver');
const { runWithPrivateLogContext, redactForLog } = require('./private/private-log-context');
const { isPrivateWebContents } = require('./private/private-windows');

// Tezos Domains (.tez) names are resolved by the naming core (freedom-core
// design 0004) from the registry on Tezos mainnet, through the endpoints
// below: the lookups go to its driver, which returns the core's results in
// the shapes the renderer and the dweb protocol handlers read.
//
// PRIVATE MODE GUARD (name logging): same contract as the ENS resolver —
// the .tez name being resolved is the browsing history of the tab that
// asked, and log.warn/error land in the persistent main.log. See
// src/main/private/private-log-context.js.
const nameForLog = (name) => redactForLog(name);

const DEFAULT_RPC_ENDPOINTS = [
  'https://tezos-mainnet.octez.io',
  'https://rpc.tzkt.io/mainnet',
  'https://rpc.tzbeta.net',
];

// The Tezos endpoints the naming core is configured with (NamingConfig),
// TEZOS_RPC first.
function getRpcEndpoints() {
  const override = String(process.env.TEZOS_RPC || '').trim();
  const candidates = override ? [override, ...DEFAULT_RPC_ENDPOINTS] : DEFAULT_RPC_ENDPOINTS;
  const seen = new Set();
  const endpoints = [];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
      // Keep the slash-normalized form, not the raw candidate — request
      // paths are appended directly, so TEZOS_RPC=https://node/ would
      // otherwise produce https://node//chains/… .
      const normalized = parsed.toString().replace(/\/$/, '');
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      endpoints.push(normalized);
    } catch {
      // Unparseable candidate — skip.
    }
  }
  return endpoints;
}

// Every lookup goes to the naming core's driver. Without one (the core not
// attached yet, or stopped for good), a lookup fails as the driver's own
// does when no core process serves it.
async function resolveTezosDomain(name) {
  const driver = require('./core/naming').namingDriver();
  if (!driver) throw new Error(UNAVAILABLE);
  return driver.resolveTezos(String(name || ''));
}

// Drops the core's cached result for `name`, or every Tezos result without
// one. Nothing is cached without a core.
function invalidateTezosDomain(name) {
  const driver = require('./core/naming').namingDriver();
  if (driver) driver.invalidateTezos(name ? String(name) : undefined).catch(() => {});
}

function registerTezosDomainsIpc() {
  ipcMain.handle(IPC.TEZOS_DOMAINS_RESOLVE, async (event, { name } = {}) => {
    return runWithPrivateLogContext(isPrivateWebContents(event?.sender), async () => {
      try {
        return await resolveTezosDomain(name);
      } catch (err) {
        // The message can name the domain (the naming core's "changed
        // repeatedly"): redacted like the name in a private window.
        log.error(
          `[tezos-domains] Resolution failed for ${nameForLog(name)}: ${redactForLog(err.message)}`
        );
        return { type: 'error', reason: err.message, system: 'tezos' };
      }
    });
  });
  ipcMain.handle(IPC.TEZOS_DOMAINS_INVALIDATE, (_event, { name } = {}) => {
    invalidateTezosDomain(name);
    return { ok: true };
  });
}

module.exports = {
  getRpcEndpoints,
  invalidateTezosDomain,
  registerTezosDomainsIpc,
  resolveTezosDomain,
};
