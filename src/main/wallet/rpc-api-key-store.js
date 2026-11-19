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

const path = require('path');
const { app } = require('electron');
const { readPrivateFile, repairPrivateFile, writePrivateFileSync } = require('../private-files');

const API_KEYS_FILE = 'rpc-api-keys.json';

function getApiKeysPath() {
  return path.join(app.getPath('userData'), API_KEYS_FILE);
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
