/** One-time, separately authorized provisioning of the public wallet-0 record
 * (PROFILE/identity/vault-meta.json) on a disposable Sepolia Railgun profile
 * whose vault create-railgun-test-profile.js made through identity/vault alone.
 * Without that record identity-manager getWalletRecord(0) is null, and
 * production's recovered history refuses the profile's held submission at
 * submitter-metadata before any disclosure.
 *
 *   electron scripts/write-railgun-submitter-metadata.js PROFILE EXPECTED_ADDRESS
 *
 * - Read-only until the one create. An existing file is never replaced: it is
 *   reported already-present, unchanged, only when production's reader returns
 *   its wallet 0 as the vault's index-0 EOA; anything else refuses.
 * - The EOA is derived from the unlocked vault as identity-manager derives it
 *   (identity deriveAllKeys, userWallet), and must equal the vault signer's
 *   index-0 address (the live qualifier's enrolled EOA) and EXPECTED_ADDRESS.
 *   Any mismatch refuses before a write.
 * - The record is identity-manager's createNewVault/importExistingMnemonic
 *   shape, field for field; userKnowsPassword is false because the profile's
 *   password is random and held only through safeStorage, as for Quick Setup.
 *   It is created with O_CREAT|O_EXCL, synced with its directory entry, and read
 *   back through production's readRailgunSubmitterMetadata.
 * - Nothing else changes: identity-vault.json and every other entry of the
 *   identity directory keep their bytes, compared before and after.
 * Output: one aggregate JSON line, never an address, key, mnemonic or password.
 */
const fs = require('fs'),
  path = require('path');
const { createHash } = require('crypto');
const { isDeepStrictEqual } = require('util');
const {
  VAULT_META_FILE,
  vaultMetaRecord,
  renderVaultMeta,
  createVaultMetaExclusive,
} = require('./lib/railgun-vault-meta');

const CHAIN_ID = 11155111;
const VAULT_FILE = 'identity-vault.json';
const ADDRESS_ARGUMENT = /^0x[0-9a-fA-F]{40}$/;

function refusal(step) {
  return Object.assign(new Error('Railgun submitter metadata refused'), {
    code: 'RAILGUN_SUBMITTER_METADATA_REFUSED',
    step,
  });
}
function check(condition, step) {
  if (!condition) throw refusal(step);
}
// A file-system predicate that is false, never a throw, for an unusable path.
function holds(read) {
  try {
    return read() === true;
  } catch {
    return false;
  }
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// EXPECTED_ADDRESS, lowercase. Mixed case must carry a valid checksum.
function expectedAddress(value) {
  check(typeof value === 'string' && ADDRESS_ARGUMENT.test(value), 'expected-address');
  try {
    return require('ethers').getAddress(value).toLowerCase();
  } catch {
    throw refusal('expected-address');
  }
}

// The public half of what identity-manager derives after unlock, in the shape
// vaultMetaRecord takes. The vault must be unlocked; nothing secret is returned.
async function deriveSubmitter({ identity, signers }) {
  const mnemonic = identity.getMnemonic();
  check(typeof mnemonic === 'string', 'vault-locked');
  const keys = identity.deriveAllKeys(mnemonic);
  const derived = {
    userWallet: { address: keys.userWallet.address },
    beeWallet: { address: keys.beeWallet.address },
  };
  // The live qualifier's enrolled EOA is the vault signer at index 0.
  const signer = await signers.getSigner(0).getAddress();
  check(
    typeof signer === 'string' && signer.toLowerCase() === derived.userWallet.address.toLowerCase(),
    'signer'
  );
  return derived;
}

// Every other entry of the identity directory, by name: a regular file by its
// bytes' digest, anything else by its kind. Kept in memory, never reported.
function snapshotIdentity(fsImpl, identityDir) {
  const entries = {};
  for (const name of fsImpl.readdirSync(identityDir).sort()) {
    if (name === VAULT_META_FILE) continue;
    const stat = fsImpl.lstatSync(path.join(identityDir, name));
    entries[name] = stat.isFile()
      ? sha(fsImpl.readFileSync(path.join(identityDir, name)))
      : stat.isDirectory()
        ? 'directory'
        : 'other';
  }
  return entries;
}
function readSubmitterMetadata() {
  try {
    return require('../src/main/wallet/railgun-private-submission').readRailgunSubmitterMetadata();
  } catch {
    return null;
  }
}

// The one write, or a refusal. derived: deriveSubmitter's result for the vault
// in identityDir, which production must resolve as its identity data directory.
function provisionSubmitterMetadata({
  identityDir,
  derived,
  expected,
  now = new Date(),
  fsImpl = fs,
}) {
  const address = expectedAddress(expected);
  check(
    ADDRESS_ARGUMENT.test(derived?.userWallet?.address ?? '') &&
      ADDRESS_ARGUMENT.test(derived?.beeWallet?.address ?? ''),
    'derived'
  );
  check(derived.userWallet.address.toLowerCase() === address, 'expected-address');
  check(
    typeof identityDir === 'string' &&
      path.isAbsolute(identityDir) &&
      holds(
        () =>
          fsImpl.lstatSync(identityDir).isDirectory() &&
          fsImpl.realpathSync(identityDir) === identityDir
      ),
    'identity-directory'
  );
  // Production's reader reads exactly the file this writes.
  check(
    require('../src/main/identity-manager').getIdentityDataDir() === identityDir,
    'identity-directory'
  );
  check(
    holds(() => fsImpl.lstatSync(path.join(identityDir, VAULT_FILE)).isFile()),
    'vault'
  );
  const before = snapshotIdentity(fsImpl, identityDir);
  const file = path.join(identityDir, VAULT_META_FILE);
  const record = { index: 0, type: 'mnemonic', address };
  const unchanged = () => isDeepStrictEqual(snapshotIdentity(fsImpl, identityDir), before);
  const summary = (result, bytes, entries) => ({
    tool: 'railgun-submitter-metadata',
    version: 1,
    result,
    walletIndex: 0,
    type: 'mnemonic',
    submitter: 'expected-eoa',
    readback: 'production-reader',
    metadataSha256: sha(bytes),
    identityEntries: entries,
    otherEntriesUnchanged: true,
  });
  let present = true;
  try {
    fsImpl.lstatSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw refusal('metadata-unreadable');
    present = false;
  }
  if (present) {
    // lstat: a symlink or directory in its place is never followed.
    check(
      holds(() => fsImpl.lstatSync(file).isFile()),
      'metadata-present-different'
    );
    const bytes = fsImpl.readFileSync(file);
    check(isDeepStrictEqual(readSubmitterMetadata(), record), 'metadata-present-different');
    check(fsImpl.readFileSync(file).equals(bytes) && unchanged(), 'changed');
    const entries = Object.keys(before).length + 1;
    return summary('already-present', bytes, { before: entries, after: entries });
  }
  const text = renderVaultMeta(
    vaultMetaRecord(derived, { userKnowsPassword: false, createdAt: now.toISOString() })
  );
  try {
    createVaultMetaExclusive(identityDir, text, fsImpl);
  } catch (error) {
    // Another writer created it since the read: never replaced, never read as ours.
    if (error?.code === 'EEXIST') throw refusal('metadata-raced');
    throw refusal('metadata-write');
  }
  const bytes = fsImpl.readFileSync(file);
  check(bytes.toString('utf8') === text, 'readback');
  check(isDeepStrictEqual(readSubmitterMetadata(), record), 'readback');
  check(unchanged(), 'changed');
  const names = fsImpl.readdirSync(identityDir).sort();
  const expectedNames = [...Object.keys(before), VAULT_META_FILE].sort();
  check(
    names.length === expectedNames.length && names.every((name, i) => name === expectedNames[i]),
    'changed'
  );
  return summary('created', bytes, {
    before: Object.keys(before).length,
    after: Object.keys(before).length + 1,
  });
}

// ---------------------------------------------------------------------------
// Electron process: profile, lock, safeStorage and the vault unlock, as the live
// qualifiers open a disposable profile. Only main() runs under Electron.
// ---------------------------------------------------------------------------
let lock;
async function main() {
  const { app, safeStorage } = require('electron');
  check(process.argv.length === 4, 'arguments');
  const [directory, expected] = process.argv.slice(2);
  check(
    !app.isPackaged &&
      !process.env.FREEDOM_IDENTITY_DATA &&
      typeof directory === 'string' &&
      path.isAbsolute(directory),
    'environment'
  );
  expectedAddress(expected);
  check(
    holds(() => fs.lstatSync(directory).isDirectory() && fs.realpathSync(directory) === directory),
    'profile'
  );
  const profile = require('../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: directory },
  });
  lock = require('../src/main/profile-lock').acquireProfileLock(profile, {
    onCompromised: () => app.exit(1),
  });
  app.dock?.hide();
  await app.whenReady();
  const marker = JSON.parse(fs.readFileSync(path.join(directory, 'railgun-test-profile.json')));
  check(
    isDeepStrictEqual(marker, {
      version: 1,
      chainId: CHAIN_ID,
      profileId: profile.id,
      disposable: true,
    }),
    'profile'
  );
  check(safeStorage.isEncryptionAvailable(), 'profile');
  if (process.platform === 'linux')
    check(safeStorage.getSelectedStorageBackend() !== 'basic_text', 'profile');
  const identityDir = path.join(directory, 'identity');
  // identity-manager's identity module: the vault and the derivation it uses.
  const identity = require('../src/main/identity');
  check(identity.vaultExists(identityDir), 'vault');
  let derived;
  try {
    let password = safeStorage.decryptString(
      fs.readFileSync(path.join(directory, 'qualification-password.bin'))
    );
    await identity.unlockVault(identityDir, password, 0);
    password = undefined;
    derived = await deriveSubmitter({ identity, signers: require('../src/main/wallet/signers') });
  } finally {
    identity.lockVault();
  }
  return provisionSubmitterMetadata({ identityDir, derived, expected });
}

if (
  require.main === module ||
  (process.versions.electron &&
    process.type === 'browser' &&
    typeof process.argv[1] === 'string' &&
    path.resolve(process.argv[1]) === path.resolve(__filename))
) {
  const release = () => {
    if (lock) require('../src/main/profile-lock').releaseProfileLock(lock);
  };
  main().then(
    (report) => {
      release();
      console.log(JSON.stringify(report));
      require('electron').app.exit(0);
    },
    (error) => {
      release();
      const step = /^[a-z][a-z-]{0,63}$/.test(error?.step ?? '') ? error.step : null;
      console.log(JSON.stringify({ tool: 'railgun-submitter-metadata', result: 'refused', step }));
      require('electron').app.exit(1);
    }
  );
}

module.exports = {
  VAULT_FILE,
  expectedAddress,
  deriveSubmitter,
  provisionSubmitterMetadata,
  main,
};
