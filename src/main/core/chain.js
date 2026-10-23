/**
 * Chain data in main (freedom-core design 0005, implementation step 5): it
 * attaches the chain configuration, main's executors for the chain
 * thread's `shell.*` requests and the drivers of `chain.*` to the core
 * client before the client starts. Reads, fee quotes and broadcasts run in
 * the core alone: without a driver (the core not attached yet, or stopped
 * for good), a call fails as the driver's does when no core process serves
 * it.
 */

const log = require('../logger');
const { ChainConfig } = require('./chain-config');
const { BroadcastRecords } = require('./chain-broadcasts');
const { registerChainShell } = require('./chain-shell');
const { registerChainVerified } = require('./chain-verified');
const { ChainDriver } = require('./chain-driver');
const { defaultAsk } = require('./endpoint-checks');

let driver = null;
let config = null;
let standaloneAsk = null;

/**
 * Attaches chain data to `client`, before it starts.
 *
 * @param {import('./core-client').CoreClient} client
 * @param {object} [options] - running: the verifier operations naming's
 *   executor counts, which chain data's share
 */
function attachChain(client, { running } = {}) {
  const registry = require('../networks/network-registry');
  const myotis = require('../myotis/myotis-manager');
  const { LOG_INDEX_URLS } = require('../networks/blockscout-logs');
  config = new ChainConfig({
    client,
    sources: { registry, myotis, logIndexUrls: LOG_INDEX_URLS },
    log,
  });
  const broadcasts = new BroadcastRecords();
  registerChainShell(client, config, { broadcasts });
  registerChainVerified(client, config, { running, broadcasts });
  driver = new ChainDriver({ client, config, broadcasts });
  // A Myotis chain's readiness changed: the core takes it, for the reads
  // after it (deviation `myotis-readiness`).
  myotis.onAvailabilityTransition(() => {
    if (config) config.availability().catch(() => {});
  });
  return { config, driver };
}

/** The core has stopped for good: calls fail from now on, as the driver's
 * do when no core process serves them. */
function detachChain() {
  // Its endpoint checks stop with it.
  config?.dispose();
  driver = null;
  config = null;
}

/** The drivers while the core runs chain data, or null. */
function chainDriver() {
  return driver;
}

/** A registry change (network-ipc's refreshDownstream): the core gets
 * every chain's snapshot again, ahead of the calls made after it. */
function chainSettingsChanged() {
  if (config) config.configure().catch(() => {});
}

/**
 * For a source being saved as one of chain `chainId`'s endpoints: the
 * chain ID `url` answers to `eth_chainId`, or null when the check failed
 * (endpoint-checks.js). The answer is kept for the snapshot while the core
 * runs chain data.
 */
function checkEndpointChain(chainId, url) {
  if (config) return config.checkEndpoint(chainId, url);
  standaloneAsk ??= defaultAsk();
  return standaloneAsk(url);
}

module.exports = {
  attachChain,
  detachChain,
  chainDriver,
  chainSettingsChanged,
  checkEndpointChain,
};
