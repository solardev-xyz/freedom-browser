/** Explicitly provision a NEW disposable Sepolia profile. No existing wallet is
 * opened, copied or replaced. The credential is protected by OS safeStorage.
 * Beside the vault it writes the public metadata identity-manager's
 * createNewVault writes (identity/vault-meta.json): production's recovered
 * submission binds a held proof's submitter to its wallet-0 address.
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { randomBytes } = require('crypto');
const { app, safeStorage } = require('electron');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
const {
  vaultMetaRecord,
  renderVaultMeta,
  createVaultMetaExclusive,
} = require('./lib/railgun-vault-meta');
let lock;
// The vault and its public metadata, as an app-made vault has them; the
// password is random and held only through safeStorage, as for Quick Setup.
// Production must resolve identityDir as its identity data directory, and reads
// the record back. Returns nothing secret.
async function provisionTestProfileVault(identityDir, password, now = new Date()) {
  const identity = require('../src/main/identity');
  assert.equal(require('../src/main/identity-manager').getIdentityDataDir(), identityDir);
  const keys = identity.deriveAllKeys(await identity.createVault(identityDir, password));
  createVaultMetaExclusive(
    identityDir,
    renderVaultMeta(
      vaultMetaRecord(keys, { userKnowsPassword: false, createdAt: now.toISOString() })
    )
  );
  const submitter = require('../src/main/identity/railgun-submitter-host')
    .createRailgunSubmitterHost()
    .readMetadata();
  assert.equal(submitter.address, keys.userWallet.address.toLowerCase());
}
async function main() {
  const [directory] = process.argv.slice(2);
  assert.equal(process.argv.length, 3);
  assert.ok(
    !app.isPackaged &&
      !process.env.FREEDOM_IDENTITY_DATA &&
      typeof directory === 'string' &&
      path.isAbsolute(directory)
  );
  assert.ok(
    !fs.existsSync(directory) &&
      fs.realpathSync(path.dirname(directory)) === path.dirname(directory)
  );
  fs.mkdirSync(directory, { mode: 0o700 });
  const profile = require('../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: directory },
  });
  lock = acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  assert.ok(safeStorage.isEncryptionAvailable());
  if (process.platform === 'linux')
    assert.notEqual(safeStorage.getSelectedStorageBackend(), 'basic_text');
  const vault = require('../src/main/identity/vault');
  const password = randomBytes(32).toString('base64');
  try {
    fs.writeFileSync(
      path.join(directory, 'qualification-password.bin'),
      safeStorage.encryptString(password),
      { flag: 'wx', mode: 0o600 }
    );
    await provisionTestProfileVault(path.join(directory, 'identity'), password);
    fs.writeFileSync(
      path.join(directory, 'railgun-test-profile.json'),
      JSON.stringify({ version: 1, chainId: 11155111, profileId: profile.id, disposable: true }),
      { flag: 'wx', mode: 0o600 }
    );
  } finally {
    vault.lockVault();
  }
  console.log('New disposable Railgun profile provisioned; no funds or submissions');
}
if (
  require.main === module ||
  (process.versions.electron &&
    process.type === 'browser' &&
    typeof process.argv[1] === 'string' &&
    path.resolve(process.argv[1]) === path.resolve(__filename))
) {
  main().then(
    () => {
      if (lock) releaseProfileLock(lock);
      app.exit(0);
    },
    () => {
      if (lock) releaseProfileLock(lock);
      console.error('Profile provisioning refused');
      app.exit(1);
    }
  );
}

module.exports = { provisionTestProfileVault };
