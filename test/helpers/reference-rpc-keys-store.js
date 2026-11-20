// The reference: src/main/wallet/rpc-api-key-store.js as the build before
// PRF-6(e) has it (freedom-browser integration/rust-core at 9d4ea6251,
// freedom-core's STORES_REFERENCE_COMMIT), verbatim but for its require
// paths. It is how an older build reads and writes rpc-api-keys.json, for
// the rollout and rollback tests of the RPC API keys the identity core
// keeps from PRF-6(e) (freedom-core design 0013, "RPC API keys"): never
// main's code.
/**
 * The one reader and writer of `<userData>/rpc-api-keys.json` (K-5), the
 * user's RPC provider API keys in plain JSON. rpc-manager and the network
 * registry both go through it, so either can be the first to read the file
 * and it is repaired either way.
 *
 * Through private-files.js: read from a no-follow descriptor after checking
 * it is a regular file this account owns and narrowing it to 0600; written
 * through an exclusive 0600 temp file renamed into place. Encrypting the
 * file belongs to the Rust core's profile secrets store (#644).
 */

const { getFreedomDataPath } = require('../../src/main/freedom-root');
const { readPrivateFile, repairPrivateFile, writePrivateFileSync } = require('../../src/main/private-files');

const API_KEYS_FILE = 'rpc-api-keys.json';

function getApiKeysPath() {
  return getFreedomDataPath(API_KEYS_FILE);
}

/**
 * The stored API keys, `{}` when there are none.
 * @throws when the file is a link, not ours, or not JSON
 */
function readRpcApiKeys() {
  const bytes = readPrivateFile(getApiKeysPath());
  return bytes ? JSON.parse(bytes.toString('utf-8')) : {};
}

function writeRpcApiKeys(keys) {
  writePrivateFileSync(getApiKeysPath(), JSON.stringify(keys, null, 2));
}

/** Startup repair: narrow an older 0644 file before any reader runs. */
function repairRpcApiKeys() {
  return repairPrivateFile(getApiKeysPath());
}

module.exports = { getApiKeysPath, readRpcApiKeys, writeRpcApiKeys, repairRpcApiKeys };
