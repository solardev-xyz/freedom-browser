/**
 * Ledger device transport (main process).
 *
 * Wraps `@ledgerhq/hw-transport-node-hid` + `@ledgerhq/hw-app-eth` behind
 * a small API. The device speaks one APDU exchange at a time, so all
 * access is serialized through a queue — concurrent IPC calls (e.g. a
 * dApp signing request racing account discovery) wait their turn instead
 * of corrupting the exchange.
 *
 * The transport is opened per operation and closed afterwards: cheap,
 * and it keeps the device usable by other apps (Ledger Live) between
 * our calls.
 *
 * Every Eth instance is built with hosted clear-signing DISABLED (see
 * OFFLINE_LOAD_CONFIG) — same rule as the signer's null transaction
 * resolution: no user data leaves the machine to sign.
 */

const { mapLedgerError } = require('./errors');

// Lazy-required so the app doesn't pay node-hid's native-module load cost
// (or crash on unsupported platforms) until a Ledger feature is touched.
let TransportNodeHid = null;
let EthApp = null;
function loadLedgerLibs() {
  if (!TransportNodeHid) {
    TransportNodeHid = require('@ledgerhq/hw-transport-node-hid').default;
    EthApp = require('@ledgerhq/hw-app-eth').default;
  }
}

// Derivation path schemes offered during account discovery. Paths are in
// device format (no leading "m/") — exactly what hw-app-eth consumes and
// what we persist on the account record.
const PATH_SCHEMES = {
  live: {
    label: 'Ledger Live',
    buildPath: (i) => `44'/60'/${i}'/0/0`,
  },
  legacy: {
    label: 'Legacy (MEW / MyCrypto)',
    buildPath: (i) => `44'/60'/0'/${i}`,
  },
};

// hw-app-eth resolves clear-signing metadata through Ledger's hosted
// services by default (crypto-assets-service.api.ledger.com,
// cdn.live.ledger.com, nft.api.live.ledger.com). Those lookups are not
// limited to `signTransaction`'s opt-in resolution: `signEIP712Message`
// posts the chain id, the verifying contract and a schema hash of the
// typed data to the registry on every EIP-712 signature, from the user's
// IP, before the device is touched — and it does so while this module
// holds the exclusive device queue, so a hung request stalls all device
// access. Nulling every service URL makes the library skip the lookups
// entirely (each call site is guarded by its URL), keeping signing
// fully offline. Consequence is the same as the signer's null
// resolution: contract calls show as raw data on the device.
const OFFLINE_LOAD_CONFIG = {
  nftExplorerBaseURL: null,
  pluginBaseURL: null,
  extraPlugins: null,
  cryptoassetsBaseURL: null,
  calServiceURL: null,
};

let deviceQueue = Promise.resolve();

/**
 * Run `task` with an open Ethereum app instance, serialized against all
 * other device access. The transport is always closed afterwards.
 *
 * @template T
 * @param {(eth: import('@ledgerhq/hw-app-eth').default) => Promise<T>} task
 * @returns {Promise<T>}
 */
function withEthApp(task) {
  const run = deviceQueue.then(async () => {
    loadLedgerLibs();
    let transport;
    try {
      transport = await TransportNodeHid.open('');
    } catch (err) {
      throw mapLedgerError(err);
    }
    try {
      // scrambleKey stays at hw-app-eth's default; the third argument is
      // the load config that keeps clear-signing lookups offline.
      return await task(new EthApp(transport, undefined, OFFLINE_LOAD_CONFIG));
    } catch (err) {
      throw mapLedgerError(err);
    } finally {
      await transport.close().catch(() => {});
    }
  });
  // Keep the queue alive after failures; errors surface to the caller only.
  deviceQueue = run.catch(() => {});
  return run;
}

/**
 * List addresses on the device for a derivation-path scheme.
 *
 * Requires the device to be unlocked with the Ethereum app open;
 * otherwise rejects with a mapped LEDGER_* error the UI can act on.
 * Addresses are NOT shown on the device screen during discovery
 * (`display: false`) — verification on-device happens when the user
 * confirms their first signature.
 *
 * @param {{scheme?: string, start?: number, count?: number}} [options]
 * @returns {Promise<Array<{path: string, address: string}>>}
 */
async function listAccounts({ scheme = 'live', start = 0, count = 5 } = {}) {
  const pathScheme = PATH_SCHEMES[scheme];
  if (!pathScheme) {
    throw new Error(`Unknown derivation scheme: ${scheme}`);
  }
  const safeStart = Math.max(0, Math.trunc(start));
  const safeCount = Math.min(20, Math.max(1, Math.trunc(count)));

  return withEthApp(async (eth) => {
    const accounts = [];
    for (let i = safeStart; i < safeStart + safeCount; i++) {
      const path = pathScheme.buildPath(i);
      const { address } = await eth.getAddress(path, false);
      accounts.push({ path, address });
    }
    return accounts;
  });
}

module.exports = { withEthApp, listAccounts, PATH_SCHEMES, OFFLINE_LOAD_CONFIG };
