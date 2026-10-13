/**
 * Chain data in main (freedom-core design 0005, implementation step 5).
 * Main's executors for the chain thread's `shell.*` requests are attached
 * to the core client before it starts. The drivers that configure the
 * chains and send `chain.*` requests are a later step: until they keep
 * main's chain configuration, main knows no chain endpoint and no current
 * generation, so the executors perform nothing and answer every chain
 * request `not_sent`. With no chain configured, the core sends none.
 */

const { registerChainShell } = require('./chain-shell');
const { registerChainVerified } = require('./chain-verified');

/** Main's chain configuration while none is kept: no endpoint reference,
 * and no generation current. */
const UNCONFIGURED = Object.freeze({
  endpoint: () => null,
  generation: () => Infinity,
});

/**
 * Attaches chain data's executors to `client`, before it starts.
 *
 * @param {import('./core-client').CoreClient} client
 * @param {object} [options] - running: the verifier operations naming's
 *   executor counts, which chain data's share
 */
function attachChain(client, { running } = {}) {
  registerChainShell(client, UNCONFIGURED);
  registerChainVerified(client, UNCONFIGURED, { running });
}

module.exports = { attachChain };
