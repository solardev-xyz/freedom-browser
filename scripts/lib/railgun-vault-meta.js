/** The public vault metadata identity-manager saves beside an app-made vault
 * (createNewVault, importExistingMnemonic): the wallet addresses it shows
 * without unlock. Production's recovered submission binds a held proof's
 * submitter to its wallet-0 address before any disclosure
 * (railgun-private-submission.js readRailgunSubmitterMetadata), so a disposable
 * Railgun profile needs the same record. These helpers build it field for field
 * and create it exclusively; they never replace or rewrite an existing file.
 */
const fs = require('fs'),
  path = require('path');

// identity-manager's VAULT_META_FILE, in its identity data directory.
const VAULT_META_FILE = 'vault-meta.json';

// The object identity-manager passes to saveVaultMeta, in the same field order:
// the addresses are deriveAllKeys' checksummed userWallet (BIP-44 account 0)
// and beeWallet. Only public addresses: never a key.
function vaultMetaRecord(keys, { userKnowsPassword, createdAt }) {
  if (typeof userKnowsPassword !== 'boolean' || typeof createdAt !== 'string')
    throw new Error('Vault metadata fields refused');
  return {
    userKnowsPassword,
    createdAt,
    addresses: {
      userWallet: keys.userWallet.address,
      beeWallet: keys.beeWallet.address,
    },
  };
}

// saveVaultMeta's encoding: two-space JSON in UTF-8, without a trailing newline.
function renderVaultMeta(meta) {
  return JSON.stringify(meta, null, 2);
}

function syncDirectory(fsImpl, directory) {
  const fd = fsImpl.openSync(directory, 'r');
  try {
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

// Creates the file with O_CREAT|O_EXCL, so an existing file (or a symlink in its
// place) is never followed or replaced: EEXIST reaches the caller. Returns only
// after the file and its directory entry are synced.
function createVaultMetaExclusive(identityDir, text, fsImpl = fs, onCreated = () => {}) {
  const file = path.join(identityDir, VAULT_META_FILE);
  const bytes = Buffer.from(text, 'utf8');
  const fd = fsImpl.openSync(file, 'wx', 0o600);
  try {
    onCreated();
    if (fsImpl.writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length)
      throw new Error('Vault metadata write incomplete');
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
  syncDirectory(fsImpl, identityDir);
  return file;
}

module.exports = {
  VAULT_META_FILE,
  vaultMetaRecord,
  renderVaultMeta,
  createVaultMetaExclusive,
};
