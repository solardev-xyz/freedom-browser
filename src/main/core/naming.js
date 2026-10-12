/**
 * The naming core in main (freedom-core design 0004, implementation step
 * 3): it attaches the configuration, main's executors and the resolvers'
 * driver to the core client before the client starts. ENS and Tezos names
 * resolve in the core alone: without a driver (the core not attached yet,
 * or stopped for good), a lookup fails as the driver's does when no core
 * process serves it.
 */

const log = require('../logger');
const { NamingConfig } = require('./naming-config');
const { registerNamingShell } = require('./naming-shell');
const { registerNamingVerified } = require('./naming-verified');
const { NamingDriver } = require('./naming-driver');

let driver = null;
let config = null;

/**
 * Attaches naming to `client`, before it starts.
 *
 * @param {import('./core-client').CoreClient} client
 */
function attachNaming(client) {
  // Loaded here: they load this module back, when they resolve.
  const ens = require('../ens-resolver');
  const tezos = require('../tezos-domains-resolver');
  const registry = require('../networks/network-registry');
  const myotis = require('../myotis/myotis-manager');
  config = new NamingConfig({ client, sources: { ens, tezos, registry, myotis }, log });
  registerNamingShell(client, config);
  registerNamingVerified(client, config);
  driver = new NamingDriver({ client, config, normalize: ens.fastNormalize });
  // A Myotis transition, for chain 1: the core clears and advances its own
  // lifecycle.
  myotis.onAvailabilityTransition((event) => {
    if (event?.chainId != null && Number(event.chainId) !== 1) return;
    if (config) config.availability().catch(() => {});
  });
  return { config, driver };
}

/** The core has stopped for good: lookups fail from now on, as the
 * driver's do when no core process serves them. */
function detachNaming() {
  driver = null;
  config = null;
}

/** The resolvers' driver while the core runs naming, or null. */
function namingDriver() {
  return driver;
}

/** A settings change, where today's code calls invalidateCachedProvider:
 * the core gets the snapshot again, its providers reset. */
function namingSettingsChanged() {
  if (config) config.configure({ reset: true }).catch(() => {});
}

/** Every cached ENS resolution dropped (clearEnsResolutionCaches): the
 * core clears its content, address and reverse caches and advances its
 * lifecycle, as `naming.availability` does (design 0004, Configuration). */
function namingCachesCleared() {
  if (config) config.availability().catch(() => {});
}

module.exports = {
  attachNaming,
  detachNaming,
  namingDriver,
  namingSettingsChanged,
  namingCachesCleared,
};
