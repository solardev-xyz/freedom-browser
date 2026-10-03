/** Read the existing disposable Railgun profile's vault-backed public funding
 * address. Never creates a vault, signs, starts Tor or submits a transaction.
 * electron script EXISTING_PROFILE NEW_OUTPUT
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { app, safeStorage } = require('electron');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
let lock;
async function main() {
  const [directory, output] = process.argv.slice(2);
  assert.equal(process.argv.length, 4);
  assert.ok(!app.isPackaged && !process.env.FREEDOM_IDENTITY_DATA);
  assert.ok([directory, output].every(path.isAbsolute));
  assert.equal(fs.realpathSync(directory), directory);
  assert.ok(!fs.existsSync(output));
  assert.ok(
    !fs.existsSync(
      path.join(directory, require('../src/main/networks/direct-testnet-transport').MARKER)
    )
  );
  const profile = require('../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: directory },
  });
  lock = acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  const marker = JSON.parse(fs.readFileSync(path.join(directory, 'railgun-test-profile.json')));
  assert.deepEqual(marker, {
    version: 1,
    chainId: 11155111,
    profileId: profile.id,
    disposable: true,
  });
  assert.ok(safeStorage.isEncryptionAvailable());
  if (process.platform === 'linux')
    assert.notEqual(safeStorage.getSelectedStorageBackend(), 'basic_text');
  const vault = require('../src/main/identity/vault');
  const vaultDirectory = path.join(directory, 'identity');
  assert.ok(vault.vaultExists(vaultDirectory));
  try {
    let password = safeStorage.decryptString(
      fs.readFileSync(path.join(directory, 'qualification-password.bin'))
    );
    await vault.unlockVault(vaultDirectory, password, 0);
    password = undefined;
    const signer = require('../src/main/wallet/signers').getSigner(0);
    const address = (await signer.getAddress()).toLowerCase();
    assert.match(address, /^0x[0-9a-f]{40}$/);
    const report = {
      observedAt: new Date().toISOString(),
      version: 1,
      profileId: profile.id,
      profileDirectory: directory,
      disposable: true,
      chainId: 11155111,
      walletIndex: 0,
      address,
      signer: 'vault-backed',
      signed: false,
      submissions: 0,
    };
    fs.mkdirSync(output, { mode: 0o700 });
    fs.writeFileSync(path.join(output, 'funding.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(JSON.stringify({ address, submissions: 0 }));
  } finally {
    vault.lockVault();
  }
}
main().then(
  () => {
    if (lock) releaseProfileLock(lock);
    app.exit(0);
  },
  () => {
    if (lock) releaseProfileLock(lock);
    console.error('Railgun funding identity refused');
    app.exit(1);
  }
);
