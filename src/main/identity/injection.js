/**
 * Key injection for nodes
 *
 * Writes derived keys to the correct locations for each node:
 * - Bee: keys/swarm.key (JSON keystore)
 * - IPFS: config (Identity fields)
 * - Radicle: keys/radicle + keys/radicle.pub
 */

const fs = require('fs');
const path = require('path');
const { createBeeKeystore, createIpfsIdentity, createRadicleIdentity } = require('./formats');
const { withPrivateDir } = require('../private-files');

/**
 * Inject Bee key into data directory
 * @param {string} dataDir - Bee data directory
 * @param {string} privateKey - 0x-prefixed hex private key
 * @param {string} password - Password to encrypt the keystore
 * @returns {Promise<void>}
 */
async function injectBeeKey(dataDir, privateKey, password) {
  // Owner-only keys directory and keystore (K-3). keys/ is opened before
  // the keystore is encrypted and the keystore is written through that
  // handle, so a keys/ swapped for a link during the await cannot redirect
  // the write.
  return withPrivateDir(dataDir, async (data) => {
    const keys = data.openDir('keys');
    const keystore = await createBeeKeystore(privateKey, password);
    keys.write('swarm.key', keystore);
    console.log(`[Identity] Bee key injected at ${path.join(keys.path, 'swarm.key')}`);
  });
}

/**
 * Inject IPFS identity into config
 * @param {string} ipfsPath - IPFS repo directory (contains config file)
 * @param {Uint8Array} privateKey - 32-byte Ed25519 private key
 * @param {Uint8Array} publicKey - 32-byte Ed25519 public key
 */
function injectIpfsKey(ipfsPath, privateKey, publicKey) {
  const configPath = path.join(ipfsPath, 'config');

  // Config must exist (run ipfs init first, or create minimal config)
  if (!fs.existsSync(configPath)) {
    throw new Error(`IPFS config not found at ${configPath}. Run 'ipfs init' first.`);
  }

  // Read existing config
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Generate identity fields
  const identity = createIpfsIdentity(privateKey, publicKey);

  // Update config
  config.Identity = config.Identity || {};
  config.Identity.PrivKey = identity.privKey;
  config.Identity.PeerID = identity.peerId;

  // Write back
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log(`[Identity] IPFS identity injected: PeerID=${identity.peerId}`);
  return identity.peerId;
}

/**
 * Inject Radicle key into data directory
 * @param {string} radHome - Radicle home directory
 * @param {Uint8Array} privateKey - 32-byte Ed25519 private key
 * @param {Uint8Array} publicKey - 32-byte Ed25519 public key
 * @param {string} alias - Node alias (e.g., "FreedomBrowser")
 */
function injectRadicleKey(radHome, privateKey, publicKey, alias = 'FreedomBrowser') {
  // Generate identity
  const identity = createRadicleIdentity(privateKey, publicKey, alias);

  // Owner-only keys directory and secret key (K-3), both written through
  // the home's handle; the public key keeps its usual 0644.
  withPrivateDir(radHome, (home) => {
    const keys = home.openDir('keys');
    keys.write('radicle', identity.privateKeyFile);
    keys.write('radicle.pub', identity.publicKeyFile, { mode: 0o644 });
  });

  // Ensure config has the alias, but preserve existing settings (e.g. preferredSeeds).
  // The full config (including seeds) is managed by radicle-manager's ensureConfig().
  const configPath = path.join(radHome, 'config.json');
  let config = {};
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { /* recreate */ }
  }
  config.node = config.node || {};
  config.node.alias = alias;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log(`[Identity] Radicle identity injected: DID=${identity.did}`);
  return identity.did;
}

/**
 * Create a minimal IPFS config for testing
 * @param {string} ipfsPath - IPFS repo directory
 * @param {number} apiPort - API port
 * @param {number} gatewayPort - Gateway port
 */
function createMinimalIpfsConfig(ipfsPath, apiPort = 5001, gatewayPort = 8080) {
  if (!fs.existsSync(ipfsPath)) {
    fs.mkdirSync(ipfsPath, { recursive: true });
  }

  const config = {
    Identity: {},
    Addresses: {
      Swarm: [],
      API: `/ip4/127.0.0.1/tcp/${apiPort}`,
      Gateway: `/ip4/127.0.0.1/tcp/${gatewayPort}`,
    },
    Bootstrap: [],
    Routing: {
      Type: 'dhtclient',
    },
  };

  const configPath = path.join(ipfsPath, 'config');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Create required directories
  fs.mkdirSync(path.join(ipfsPath, 'blocks'), { recursive: true });
  fs.mkdirSync(path.join(ipfsPath, 'datastore'), { recursive: true });

  console.log(`[Identity] Created minimal IPFS config at ${ipfsPath}`);
}

/**
 * Create Bee config for testing
 * @param {string} dataDir - Bee data directory
 * @param {string|null} password - Password for the keystore, or null when
 *   it is sealed in the OS keychain instead (swarm/ant-keystore-password.js)
 * @param {number} apiPort - API port
 * @param {number} p2pPort - P2P port
 */
function createBeeConfig(dataDir, password, apiPort, p2pPort) {
  if (!Number.isInteger(apiPort) || apiPort <= 0) {
    throw new Error('Bee API port is required to create Bee config');
  }
  if (!Number.isInteger(p2pPort) || p2pPort <= 0) {
    throw new Error('Bee P2P port is required to create Bee config');
  }

  const configContent = `# Bee Configuration (generated by identity injection)
api-addr: 127.0.0.1:${apiPort}
p2p-addr: :${p2pPort}
swap-enable: false
mainnet: true
full-node: false
skip-postage-snapshot: true
resolver-options: https://ethereum.publicnode.com
storage-incentives-enable: false
data-dir: ${dataDir}
${password ? `password: ${password}\n` : ''}`;

  // Holds the keystore password: owner-only (K-3).
  const configPath = path.join(dataDir, 'config.yaml');
  withPrivateDir(dataDir, (data) => data.write('config.yaml', configContent));

  console.log(`[Identity] Created Bee config at ${configPath}`);
  return configPath;
}

module.exports = {
  injectBeeKey,
  injectIpfsKey,
  injectRadicleKey,
  createMinimalIpfsConfig,
  createBeeConfig,
};
