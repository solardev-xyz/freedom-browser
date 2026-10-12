/**
 * Integration: postage-stamp owner + publisher identity continuity across the
 * v0.8.0 upgrade (issue #107). Crypto-level, but binary-free (no antd) — so it
 * runs in CI on macOS, Windows, and Linux on every push.
 *
 * Why this matters for upgraders' funds:
 *
 *  - A postage batch in `stamperstore` is owned by the node's Swarm overlay,
 *    which is the Ethereum address of the injected Bee wallet (keys/swarm.key,
 *    decrypted with the password in config.yaml). The chequebook funds sit on
 *    that same address. If the bee-data → ant-data migration carried the
 *    keystore and the password out of sync — or carried a different key — antd
 *    would come up as a *different* overlay that does not own the migrated
 *    stamps, silently abandoning the user's paid-for storage and funds.
 *
 *  - The identity vault (identity/identity-vault.json) holds the mnemonic that
 *    regenerates BOTH the Bee wallet (overlay) and the per-origin Swarm feed
 *    *publisher* keys. The bee-data → ant-data migration must leave it intact,
 *    and the key it derives for the node must stay equal to the address baked
 *    into the migrated keystore.
 *
 * The real-antd integration test (bee-to-ant-migration.test.js) proves antd
 * *adopts* the migrated overlay, but it's skipped without the binary. These
 * tests assert the same identity invariants from the keystore/vault crypto so
 * the continuity contract has unconditional coverage.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Wallet } = require('ethers');
const { deriveAllKeys, derivePublisherKey } = require('../../derivation');
const { createBeeKeystore, getBeeAddress } = require('../../formats');
const { createBeeConfig } = require('../../injection');
const vault = require('../../vault');
const {
  createAppMock,
  loadMainModule,
} = require('../../../helpers/main-process-test-utils');

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const KEYSTORE_PASSWORD = 'bee-era-keystore-password';
const VAULT_PASSWORD = 'vault-password-1234';

// Read the `password:` line out of a (migrated) Bee/Ant config.yaml — this is
// the secret antd uses to decrypt keys/swarm.key on start.
function readConfigPassword(antDataDir) {
  const config = fs.readFileSync(path.join(antDataDir, 'config.yaml'), 'utf-8');
  const match = config.match(/^password:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

// Snapshot a directory tree to a { relPath: contentHex } map so byte-identical
// carry-over of opaque LevelDB files (stamperstore) can be asserted.
function snapshotDir(dir) {
  const out = {};
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else {
        out[rel] = fs.readFileSync(abs).toString('hex');
      }
    }
  };
  walk(dir, '');
  return out;
}

// A believable postage stamperstore: LevelDB-shaped files holding the batch
// owner's purchased batches. The bytes are opaque to us; the test only cares
// that they survive byte-for-byte.
function writeStamperstore(beeDataDir) {
  const store = path.join(beeDataDir, 'stamperstore');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'CURRENT'), 'MANIFEST-000001\n');
  fs.writeFileSync(path.join(store, '000003.ldb'), Buffer.from('postage-batch-0xdeadbeef', 'utf-8'));
  fs.writeFileSync(path.join(store, 'LOG'), 'stamperstore opened\n');
  return store;
}

function loadMigrationModule(userDataDir) {
  return loadMainModule(require.resolve('../../../../src/main/migrate-user-data'), {
    app: createAppMock({ isPackaged: true, userDataDir }),
    extraMocks: {
      [require.resolve('../../../../src/main/logger')]: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    },
  }).mod;
}

describe('postage-stamp owner + publisher identity continuity (binary-free)', () => {
  let keys;
  let overlayOwner;
  let keystoreJson;
  let tmpDirs;

  beforeAll(async () => {
    keys = deriveAllKeys(TEST_MNEMONIC);
    // The overlay/wallet that owns the postage stamps and chequebook.
    overlayOwner = getBeeAddress(keys.beeWallet.privateKey);
    expect(overlayOwner).toBe(keys.beeWallet.address);
    // Encrypt the keystore once (scrypt is slow) and reuse it across tests.
    keystoreJson = await createBeeKeystore(keys.beeWallet.privateKey, KEYSTORE_PASSWORD);
  }, 60000);

  beforeEach(() => {
    tmpDirs = [];
    delete process.env.FREEDOM_ANT_DATA;
  });

  afterEach(() => {
    vault.lockVault();
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.FREEDOM_ANT_DATA;
  });

  function makeUserData() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postage-continuity-'));
    tmpDirs.push(dir);
    return dir;
  }

  function writeBeeData(userDataDir) {
    const beeDataDir = path.join(userDataDir, 'bee-data');
    fs.mkdirSync(path.join(beeDataDir, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(beeDataDir, 'keys', 'swarm.key'), keystoreJson);
    createBeeConfig(beeDataDir, KEYSTORE_PASSWORD, 1633, 1634);
    return beeDataDir;
  }

  test(
    'the migrated keystore decrypts to the same overlay that owns the carried stamps',
    async () => {
      const userDataDir = makeUserData();
      writeBeeData(userDataDir);
      const stamperstore = writeStamperstore(path.join(userDataDir, 'bee-data'));
      const stampsBefore = snapshotDir(stamperstore);

      const mod = loadMigrationModule(userDataDir);
      expect(mod.migrateBeeDataToAntData()).toBe(true);

      const antDataDir = path.join(userDataDir, 'ant-data');

      // The password that decrypts the keystore must have ridden along with it.
      const carriedPassword = readConfigPassword(antDataDir);
      expect(carriedPassword).toBe(KEYSTORE_PASSWORD);

      // Decrypting the migrated keystore must recover the SAME overlay owner —
      // proving the carried stamps (owned by that overlay) stay usable.
      const migratedKeystore = fs.readFileSync(
        path.join(antDataDir, 'keys', 'swarm.key'),
        'utf-8'
      );
      const recovered = await Wallet.fromEncryptedJson(migratedKeystore, carriedPassword);
      expect(recovered.address).toBe(overlayOwner);

      // The stamperstore is carried byte-for-byte.
      expect(snapshotDir(path.join(antDataDir, 'stamperstore'))).toEqual(stampsBefore);
    },
    60000
  );

  test(
    'on the merge path the carried bee-era password wins over a throwaway one',
    async () => {
      const userDataDir = makeUserData();
      writeBeeData(userDataDir);
      writeStamperstore(path.join(userDataDir, 'bee-data'));

      // antd already ran once on an empty ant-data and self-generated a
      // throwaway identity with a DIFFERENT keystore password. The merge must
      // leave the keystore and the password consistent — i.e. the carried
      // bee-era password (which matches the carried keystore), not the
      // throwaway one.
      const antDataDir = path.join(userDataDir, 'ant-data');
      fs.mkdirSync(antDataDir, { recursive: true });
      fs.writeFileSync(path.join(antDataDir, 'identity.json'), '{"throwaway":true}');
      fs.writeFileSync(path.join(antDataDir, 'signing.key'), 'throwaway-signing-key');
      createBeeConfig(antDataDir, 'a-totally-different-password', 11633, 12633);

      const mod = loadMigrationModule(userDataDir);
      expect(mod.migrateBeeDataToAntData()).toBe(true);

      const carriedPassword = readConfigPassword(antDataDir);
      expect(carriedPassword).toBe(KEYSTORE_PASSWORD);

      const migratedKeystore = fs.readFileSync(
        path.join(antDataDir, 'keys', 'swarm.key'),
        'utf-8'
      );
      // If the throwaway password had won, this decrypt would throw.
      const recovered = await Wallet.fromEncryptedJson(migratedKeystore, carriedPassword);
      expect(recovered.address).toBe(overlayOwner);

      // The throwaway identity antd minted must be gone, so it can't win over
      // the migrated keystore on the next start.
      expect(fs.existsSync(path.join(antDataDir, 'identity.json'))).toBe(false);
      expect(fs.existsSync(path.join(antDataDir, 'signing.key'))).toBe(false);
    },
    60000
  );

  test(
    'the vault regenerates the same publisher keys and stays consistent with the migrated overlay',
    async () => {
      const userDataDir = makeUserData();

      // A v0.7.x install: the vault lives under identity/, the injected node
      // identity + stamps under bee-data/. The bee → ant migration only
      // touches bee-data/; the vault stays in place.
      const identityDir = path.join(userDataDir, 'identity');
      await vault.importVault(identityDir, VAULT_PASSWORD, TEST_MNEMONIC);
      writeBeeData(userDataDir);
      writeStamperstore(path.join(userDataDir, 'bee-data'));

      // Capture the publisher + overlay identities the vault regenerates today.
      const publisher0Before = derivePublisherKey(TEST_MNEMONIC, 0).address;
      const publisher1Before = derivePublisherKey(TEST_MNEMONIC, 1).address;

      // Run the node-data migration exactly as startup does.
      const beeAntMod = loadMigrationModule(userDataDir);
      expect(beeAntMod.migrateBeeDataToAntData()).toBe(true);

      // The vault is untouched and still unlocks to the same mnemonic.
      expect(vault.vaultExists(identityDir)).toBe(true);
      await vault.unlockVault(identityDir, VAULT_PASSWORD, 0);
      const mnemonic = vault.getMnemonic();
      expect(mnemonic).toBe(TEST_MNEMONIC);

      // Feed-signing publisher keys regenerate identically after the upgrade.
      expect(derivePublisherKey(mnemonic, 0).address).toBe(publisher0Before);
      expect(derivePublisherKey(mnemonic, 1).address).toBe(publisher1Before);

      // The vault-derived Bee wallet equals the address inside the migrated
      // keystore — the node overlay and the vault identity stay in lockstep.
      const vaultBeeWallet = deriveAllKeys(mnemonic).beeWallet.address;
      const migratedKeystore = fs.readFileSync(
        path.join(userDataDir, 'ant-data', 'keys', 'swarm.key'),
        'utf-8'
      );
      const carriedPassword = readConfigPassword(path.join(userDataDir, 'ant-data'));
      const recovered = await Wallet.fromEncryptedJson(migratedKeystore, carriedPassword);
      expect(recovered.address).toBe(vaultBeeWallet);
      expect(recovered.address).toBe(overlayOwner);
    },
    60000
  );
});
