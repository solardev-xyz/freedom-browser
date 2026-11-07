/**
 * Tests for Identity Vault
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  getVaultPath,
  vaultExists,
  createVault,
  importVault,
  unlockVault,
  lockVault,
  isUnlocked,
  getSeedSecret,
  changePassword,
  deleteVault,
  exportRecoveryPhrase,
  exportPrivateKey,
} = require('./vault');
const { decrypt } = require('@metamask/browser-passworder');
const { isValidMnemonic, deriveUserWallet, deriveWalletAtPath } = require('./derivation');

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('vault', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
    // Ensure vault is locked before each test
    lockVault();
  });

  afterEach(() => {
    lockVault();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('vaultExists', () => {
    test('returns false when no vault exists', () => {
      expect(vaultExists(tempDir)).toBe(false);
    });

    test('returns true after vault is created', async () => {
      await createVault(tempDir, 'password123');
      expect(vaultExists(tempDir)).toBe(true);
    });
  });

  describe('createVault', () => {
    test('creates vault and returns valid 24-word mnemonic', async () => {
      const mnemonic = await createVault(tempDir, 'password123');

      expect(isValidMnemonic(mnemonic)).toBe(true);
      expect(mnemonic.split(' ').length).toBe(24);
      expect(vaultExists(tempDir)).toBe(true);
    });

    test('creates 12-word mnemonic with strength=128', async () => {
      const mnemonic = await createVault(tempDir, 'password123', 128);

      expect(isValidMnemonic(mnemonic)).toBe(true);
      expect(mnemonic.split(' ').length).toBe(12);
    });

    test('throws if vault already exists', async () => {
      await createVault(tempDir, 'password123');

      await expect(createVault(tempDir, 'password456')).rejects.toThrow('already exists');
    });

    test('vault file has correct structure', async () => {
      await createVault(tempDir, 'password123');

      const vaultPath = getVaultPath(tempDir);
      const vaultData = JSON.parse(fs.readFileSync(vaultPath, 'utf-8'));

      expect(vaultData.version).toBe(1);
      expect(vaultData.encrypted).toBeDefined();
      expect(vaultData.createdAt).toBeDefined();
    });
  });

  describe('importVault', () => {
    test('imports valid mnemonic', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);

      expect(vaultExists(tempDir)).toBe(true);

      // Verify we can unlock and get the same mnemonic
      await unlockVault(tempDir, 'password123', 0);
      expect(getSeedSecret().mnemonic).toBe(TEST_MNEMONIC);
    });

    test('throws on invalid mnemonic', async () => {
      await expect(importVault(tempDir, 'password123', 'invalid mnemonic words')).rejects.toThrow(
        'Invalid mnemonic'
      );
    });

    test('throws if vault exists and overwrite=false', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);

      await expect(importVault(tempDir, 'password456', TEST_MNEMONIC, false)).rejects.toThrow(
        'already exists'
      );
    });

    test('overwrites vault when overwrite=true', async () => {
      // Use the 24-word test vector instead
      const newMnemonic =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

      await importVault(tempDir, 'oldpassword', TEST_MNEMONIC);
      await importVault(tempDir, 'newpassword', newMnemonic, true);

      await unlockVault(tempDir, 'newpassword', 0);
      expect(getSeedSecret().mnemonic).toBe(newMnemonic);
    });
  });

  describe('unlockVault / lockVault', () => {
    beforeEach(async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);
    });

    test('unlocks vault with correct password', async () => {
      expect(isUnlocked()).toBe(false);

      await unlockVault(tempDir, 'password123', 0);

      expect(isUnlocked()).toBe(true);
      expect(getSeedSecret().mnemonic).toBe(TEST_MNEMONIC);
    });

    test('throws on incorrect password', async () => {
      await expect(unlockVault(tempDir, 'wrongpassword', 0)).rejects.toThrow('Incorrect password');

      expect(isUnlocked()).toBe(false);
    });

    test('lockVault clears mnemonic from memory', async () => {
      await unlockVault(tempDir, 'password123', 0);
      expect(isUnlocked()).toBe(true);

      lockVault();

      expect(isUnlocked()).toBe(false);
      expect(getSeedSecret()).toBeNull();
    });

    test('throws when no vault exists', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));

      await expect(unlockVault(emptyDir, 'password', 0)).rejects.toThrow('No vault found');

      fs.rmSync(emptyDir, { recursive: true });
    });
  });

  describe('getSeedSecret', () => {
    test('returns null when locked', () => {
      expect(getSeedSecret()).toBeNull();
    });

    test('returns mnemonic when unlocked', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);
      await unlockVault(tempDir, 'password123', 0);

      expect(getSeedSecret().mnemonic).toBe(TEST_MNEMONIC);
    });
  });

  describe('changePassword', () => {
    beforeEach(async () => {
      await importVault(tempDir, 'oldpassword', TEST_MNEMONIC);
    });

    test('changes password successfully', async () => {
      await changePassword(tempDir, 'oldpassword', 'newpassword');

      // Old password should fail
      lockVault();
      await expect(unlockVault(tempDir, 'oldpassword', 0)).rejects.toThrow('Incorrect password');

      // New password should work
      await unlockVault(tempDir, 'newpassword', 0);
      expect(getSeedSecret().mnemonic).toBe(TEST_MNEMONIC);
    });

    test('throws on incorrect current password', async () => {
      await expect(changePassword(tempDir, 'wrongpassword', 'newpassword')).rejects.toThrow(
        'Incorrect password'
      );
    });
  });

  describe('deleteVault', () => {
    beforeEach(async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);
    });

    test('deletes vault with correct password', async () => {
      expect(vaultExists(tempDir)).toBe(true);

      await deleteVault(tempDir, 'password123');

      expect(vaultExists(tempDir)).toBe(false);
      expect(isUnlocked()).toBe(false);
    });

    test('throws on incorrect password', async () => {
      await expect(deleteVault(tempDir, 'wrongpassword')).rejects.toThrow('Incorrect password');

      // Vault should still exist
      expect(vaultExists(tempDir)).toBe(true);
    });
  });

  describe('exportRecoveryPhrase', () => {
    test('returns mnemonic when unlocked', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);
      await unlockVault(tempDir, 'password123', 0);

      expect(exportRecoveryPhrase()).toEqual({ mnemonic: TEST_MNEMONIC, passphrase: '' });
    });

    test('throws when locked', () => {
      expect(() => exportRecoveryPhrase()).toThrow('Vault is locked');
    });
  });

  describe('auto-lock', () => {
    test('auto-locks after timeout', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);

      // Unlock with very short timeout (100ms)
      await unlockVault(tempDir, 'password123', 100);
      expect(isUnlocked()).toBe(true);

      // Wait for auto-lock
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(isUnlocked()).toBe(false);
      // Generous outer timeout: the body runs two PBKDF2 key derivations
      // (importVault + unlockVault, ~800ms each on slower hardware) plus the
      // 200ms wait, so ~1.8s total. The 100ms auto-lock window above still
      // carries the assertion; this only stops the test flaking on slow VMs.
    }, 5000);

    test('does not auto-lock when timeout is 0', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);

      await unlockVault(tempDir, 'password123', 0);
      expect(isUnlocked()).toBe(true);

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should still be unlocked
      expect(isUnlocked()).toBe(true);
    });
  });

  describe('exportPrivateKey', () => {
    const PATH = "m/44'/60'/0'/0/2";

    beforeEach(async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);
      await unlockVault(tempDir, 'password123');
    });

    test('derives from the account index when there is no stored path', () => {
      expect(exportPrivateKey(2)).toBe(deriveUserWallet(TEST_MNEMONIC, 2).privateKey);
    });

    test('derives at the stored path, not the index, when there is one', () => {
      const key = exportPrivateKey(1000000, PATH);
      expect(key).toBe(deriveWalletAtPath(TEST_MNEMONIC, PATH).privateKey);
      expect(key).not.toBe(deriveUserWallet(TEST_MNEMONIC, 1000000).privateKey);
    });

    test('refuses a reserved path read back from vault-meta', () => {
      expect(() => exportPrivateKey(1000000, "m/44'/60'/0'/0/1")).toThrow('Swarm node');
    });

    test('throws while the vault is locked', () => {
      lockVault();
      expect(() => exportPrivateKey(1000000, PATH)).toThrow('locked');
    });
  });

  describe('passphrase', () => {
    const PASSPHRASE = 'TREZOR ';
    const SECRET = { mnemonic: TEST_MNEMONIC, passphrase: PASSPHRASE };

    function readVaultFile() {
      return JSON.parse(fs.readFileSync(getVaultPath(tempDir), 'utf-8'));
    }

    test('a vault with no passphrase is written as before, at version 1', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);
      expect(readVaultFile().version).toBe(1);

      const decrypted = await decrypt('password123', readVaultFile().encrypted);
      expect(decrypted).toEqual({ mnemonic: TEST_MNEMONIC });
    });

    test('an empty passphrase means none', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC, false, '');
      expect(readVaultFile().version).toBe(1);
    });

    test('createVault writes a vault with no passphrase', async () => {
      await createVault(tempDir, 'password123');
      expect(readVaultFile().version).toBe(1);
    });

    test('a passphrase is encrypted with the words, at version 2, exactly as typed', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC, false, PASSPHRASE);

      const file = readVaultFile();
      expect(file.version).toBe(2);
      expect(fs.readFileSync(getVaultPath(tempDir), 'utf-8')).not.toContain('TREZOR');
      expect(await decrypt('password123', file.encrypted)).toEqual(SECRET);

      await unlockVault(tempDir, 'password123', 0);
      expect(getSeedSecret()).toEqual(SECRET);
    });

    test('whitespace alone is a real passphrase', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC, false, ' ');
      expect(readVaultFile().version).toBe(2);
      await unlockVault(tempDir, 'password123', 0);
      expect(getSeedSecret().passphrase).toBe(' ');
    });

    test('changing the password keeps the passphrase and the version', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC, false, PASSPHRASE);

      await changePassword(tempDir, 'password123', 'newpassword');
      lockVault();

      expect(readVaultFile().version).toBe(2);
      await unlockVault(tempDir, 'newpassword', 0);
      expect(getSeedSecret()).toEqual(SECRET);
    });

    test('changing the password keeps a vault with no passphrase at version 1', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);
      await changePassword(tempDir, 'password123', 'newpassword');
      expect(readVaultFile().version).toBe(1);
    });

    test('locking clears the passphrase with the words', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC, false, PASSPHRASE);
      await unlockVault(tempDir, 'password123', 0);

      lockVault();

      expect(getSeedSecret()).toBeNull();
      expect(() => exportRecoveryPhrase()).toThrow('Vault is locked');
    });

    test('the recovery export includes it, and exported keys are derived with it', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC, false, PASSPHRASE);
      await unlockVault(tempDir, 'password123', 0);

      expect(exportRecoveryPhrase()).toEqual(SECRET);
      const path = "m/44'/60'/0'/0/2";
      expect(exportPrivateKey(0)).toBe(deriveUserWallet(SECRET, 0).privateKey);
      expect(exportPrivateKey(0)).not.toBe(deriveUserWallet(TEST_MNEMONIC, 0).privateKey);
      expect(exportPrivateKey(1000000, path)).toBe(deriveWalletAtPath(SECRET, path).privateKey);
    });

    test('offers no way to read the words alone for deriving keys', () => {
      expect(require('./vault').getMnemonic).toBeUndefined();
    });

    test('refuses a passphrase that is not text', async () => {
      await expect(importVault(tempDir, 'password123', TEST_MNEMONIC, false, 123)).rejects.toThrow(
        'Passphrase must be text'
      );
      expect(vaultExists(tempDir)).toBe(false);
    });

    test('refuses a vault version it does not know', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);
      fs.writeFileSync(getVaultPath(tempDir), JSON.stringify({ ...readVaultFile(), version: 3 }));

      await expect(unlockVault(tempDir, 'password123', 0)).rejects.toThrow(
        'Unsupported vault version: 3'
      );
    });
  });
});
