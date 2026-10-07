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
 * - Identity files (including nested stores) keep their bytes except metadata.
 *   Electron userData and profile-lock side effects outside identity/ are not
 *   measured. Metadata is mode 0600, stricter than the app's default mode.
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

// Recursively cover the identity stores, including nested recovery records.
// Links and special files are refused, never followed. Kept in memory only.
function snapshotIdentity(fsImpl, identityDir, root = true) {
  const entries = {};
  for (const name of fsImpl.readdirSync(identityDir).sort()) {
    if (root && name === VAULT_META_FILE) continue;
    const filename = path.join(identityDir, name);
    const stat = fsImpl.lstatSync(filename);
    check(stat.isFile() || stat.isDirectory(), 'identity-entry');
    entries[name] = stat.isFile()
      ? sha(fsImpl.readFileSync(filename))
      : snapshotIdentity(fsImpl, filename, false);
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
function provisionSubmitterMetadata(options) {
  const state = { written: false };
  try {
    return { ...provisionMetadata(options, state), written: state.written };
  } catch (error) {
    error.written = state.written;
    error.metadataSha256 = null;
    if (state.written) {
      try {
        const fsImpl = options.fsImpl ?? fs;
        const file = path.join(options.identityDir, VAULT_META_FILE);
        if (fsImpl.lstatSync(file).isFile()) error.metadataSha256 = sha(fsImpl.readFileSync(file));
      } catch {
        /* A failed readback cannot establish the final bytes. */
      }
    }
    throw error;
  }
}

function provisionMetadata({ identityDir, derived, expected, fsImpl = fs }, state) {
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
    createdAtSource: result === 'created' ? 'existing-vault' : 'existing-metadata',
    identityEntries: entries,
    otherEntriesUnchanged: true,
    preservationScope: 'identity-directory-recursive-except-vault-meta',
    profileSideEffects: 'profile-lock-and-electron-userData-not-measured',
    verification: result === 'created' ? 'full-created-record' : 'wallet-0-binding-only',
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
    // Reject malformed JSON locally; identity-manager logs parser messages that
    // can quote file contents. No raw file text belongs in this tool's output.
    try {
      JSON.parse(bytes.toString('utf8'));
    } catch {
      throw refusal('metadata-present-different');
    }
    check(isDeepStrictEqual(readSubmitterMetadata(), record), 'metadata-present-different');
    check(fsImpl.readFileSync(file).equals(bytes) && unchanged(), 'changed');
    const entries = Object.keys(before).length + 1;
    return summary('already-present', bytes, { before: entries, after: entries });
  }
  let createdAt;
  try {
    const vault = JSON.parse(fsImpl.readFileSync(path.join(identityDir, VAULT_FILE), 'utf8'));
    check(vault.version === 1, 'vault-created-at');
    createdAt = vault.createdAt;
    check(
      typeof createdAt === 'string' && new Date(createdAt).toISOString() === createdAt,
      'vault-created-at'
    );
  } catch {
    throw refusal('vault-created-at');
  }
  const text = renderVaultMeta(vaultMetaRecord(derived, { userKnowsPassword: false, createdAt }));
  try {
    createVaultMetaExclusive(identityDir, text, fsImpl, () => {
      state.written = true;
    });
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

// Read-only operator checks, before reserving repair evidence or acquiring a
// profile lock. SafeStorage availability is checked after Electron is ready.
function validateRepairArguments() {
  const { app } = require('electron');
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
  const profile = require('../src/main/profile-resolver').resolveProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: directory },
  });
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
  const identityDir = path.join(directory, 'identity');
  check(
    holds(
      () =>
        fs.lstatSync(identityDir).isDirectory() &&
        fs.realpathSync(identityDir) === identityDir &&
        fs.lstatSync(path.join(identityDir, VAULT_FILE)).isFile()
    ),
    'vault'
  );
}

// A fresh evidence directory is the operator's durable repair reservation.
// An interruption keeps pending.json and never silently repeats the write.
async function recordRepair(directory, run, fsImpl = fs) {
  check(
    fsImpl.realpathSync(path.dirname(directory)) === path.dirname(directory),
    'report-directory'
  );
  fsImpl.mkdirSync(directory, { mode: 0o700 });
  const save = (name, value) => {
    const fd = fsImpl.openSync(path.join(directory, name), 'wx', 0o600);
    try {
      const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
      check(fsImpl.writeSync(fd, bytes) === bytes.length, 'report-write');
      fsImpl.fsyncSync(fd);
    } finally {
      fsImpl.closeSync(fd);
    }
    const dir = fsImpl.openSync(directory, 'r');
    try {
      fsImpl.fsyncSync(dir);
    } finally {
      fsImpl.closeSync(dir);
    }
  };
  // Sync the newly created directory's entry as well as its pending record.
  const parent = fsImpl.openSync(path.dirname(directory), 'r');
  try {
    fsImpl.fsyncSync(parent);
  } finally {
    fsImpl.closeSync(parent);
  }
  save('pending.json', {
    tool: 'railgun-submitter-metadata',
    version: 1,
    state: 'pending',
    observedAt: new Date().toISOString(),
  });
  let completed;
  try {
    completed = await run();
    save('metadata-report.json', completed);
    return completed;
  } catch (error) {
    const step = /^[a-z][a-z-]{0,63}$/.test(error?.step ?? '') ? error.step : null;
    // If report persistence itself fails, keep pending as the authority: no
    // later invocation may infer that the profile was untouched.
    if (!fsImpl.existsSync(path.join(directory, 'metadata-report.json')))
      save('metadata-report.json', {
        tool: 'railgun-submitter-metadata',
        version: 1,
        result: 'refused',
        step,
        written: error.written ?? completed?.written ?? null,
        metadataSha256: error.metadataSha256 ?? completed?.metadataSha256 ?? null,
      });
    throw error;
  }
}

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
  const result = provisionSubmitterMetadata({ identityDir, derived, expected });
  return {
    ...result,
    profileId: profile.id,
    observedAt: new Date().toISOString(),
    sourceSha256: Object.fromEntries(
      ['scripts/write-railgun-submitter-metadata.js', 'scripts/lib/railgun-vault-meta.js'].map(
        (name) => [name, sha(fs.readFileSync(path.join(__dirname, '..', name)))]
      )
    ),
  };
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
  const evidence = require('./lib/railgun-metadata-continuation').continuationDirectory(
    path.join(__dirname, '..')
  );
  Promise.resolve()
    .then(() => {
      validateRepairArguments();
      return recordRepair(evidence, main);
    })
    .then(
      (report) => {
        release();
        console.log(JSON.stringify(report));
        require('electron').app.exit(0);
      },
      (error) => {
        release();
        const step = /^[a-z][a-z-]{0,63}$/.test(error?.step ?? '') ? error.step : null;
        console.log(
          JSON.stringify({
            tool: 'railgun-submitter-metadata',
            result: 'refused',
            step,
            written: error.written ?? null,
            metadataSha256: error.metadataSha256 ?? null,
          })
        );
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
  recordRepair,
  validateRepairArguments,
};
