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
  getMnemonic,
  changePassword,
  deleteVault,
  exportMnemonic,
} = require('./vault');
const { isValidMnemonic } = require('./derivation');

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
      expect(getMnemonic()).toBe(TEST_MNEMONIC);
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
      expect(getMnemonic()).toBe(newMnemonic);
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
      expect(getMnemonic()).toBe(TEST_MNEMONIC);
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
      expect(getMnemonic()).toBeNull();
    });

    test('throws when no vault exists', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));

      await expect(unlockVault(emptyDir, 'password', 0)).rejects.toThrow('No vault found');

      fs.rmSync(emptyDir, { recursive: true });
    });
  });

  describe('getMnemonic', () => {
    test('returns null when locked', () => {
      expect(getMnemonic()).toBeNull();
    });

    test('returns mnemonic when unlocked', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);
      await unlockVault(tempDir, 'password123', 0);

      expect(getMnemonic()).toBe(TEST_MNEMONIC);
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
      expect(getMnemonic()).toBe(TEST_MNEMONIC);
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

  describe('exportMnemonic', () => {
    test('returns mnemonic when unlocked', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);
      await unlockVault(tempDir, 'password123', 0);

      expect(exportMnemonic()).toBe(TEST_MNEMONIC);
    });

    test('throws when locked', () => {
      expect(() => exportMnemonic()).toThrow('Vault is locked');
    });
  });

  describe('vault file writes (K-2)', () => {
    const unix = process.platform === 'win32' ? test.skip : test;
    const tempFiles = () => fs.readdirSync(tempDir).filter((name) => name.endsWith('.tmp'));

    unix('the vault file is owner read/write only', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);
      expect(fs.statSync(getVaultPath(tempDir)).mode & 0o777).toBe(0o600);

      await changePassword(tempDir, 'password123', 'password456');
      expect(fs.statSync(getVaultPath(tempDir)).mode & 0o777).toBe(0o600);
    });

    unix('an existing world-readable vault is narrowed when read', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);
      fs.chmodSync(getVaultPath(tempDir), 0o644);

      await unlockVault(tempDir, 'password123', 0);
      expect(fs.statSync(getVaultPath(tempDir)).mode & 0o777).toBe(0o600);
    });

    test('a save leaves no temp file behind', async () => {
      await importVault(tempDir, 'password123', TEST_MNEMONIC);
      await changePassword(tempDir, 'password123', 'password456');
      expect(tempFiles()).toEqual([]);
    });

    test('a failed replace keeps the old vault and its password', async () => {
      await importVault(tempDir, 'oldpassword', TEST_MNEMONIC);
      const before = fs.readFileSync(getVaultPath(tempDir), 'utf-8');
      const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      });
      try {
        await expect(changePassword(tempDir, 'oldpassword', 'newpassword')).rejects.toThrow(
          'no space left'
        );
      } finally {
        rename.mockRestore();
      }

      expect(fs.readFileSync(getVaultPath(tempDir), 'utf-8')).toBe(before);
      expect(tempFiles()).toEqual([]);
      await unlockVault(tempDir, 'oldpassword', 0);
      expect(getMnemonic()).toBe(TEST_MNEMONIC);
    });

    test('a new copy that does not decrypt never replaces the vault', async () => {
      await importVault(tempDir, 'oldpassword', TEST_MNEMONIC);
      const before = fs.readFileSync(getVaultPath(tempDir), 'utf-8');
      const realRead = fs.readFileSync;
      // The read-back of the freshly written copy sees the old ciphertext,
      // which the new password cannot open.
      const read = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) =>
        String(file).endsWith('.tmp') ? before : realRead(file, ...rest)
      );
      try {
        await expect(changePassword(tempDir, 'oldpassword', 'newpassword')).rejects.toThrow(
          'Incorrect password'
        );
      } finally {
        read.mockRestore();
      }

      expect(fs.readFileSync(getVaultPath(tempDir), 'utf-8')).toBe(before);
      expect(tempFiles()).toEqual([]);
      await expect(unlockVault(tempDir, 'newpassword', 0)).rejects.toThrow('Incorrect password');
    });

    test('changing the password leaves a locked vault locked', async () => {
      await importVault(tempDir, 'oldpassword', TEST_MNEMONIC);
      expect(isUnlocked()).toBe(false);

      await changePassword(tempDir, 'oldpassword', 'newpassword');
      expect(isUnlocked()).toBe(false);
      expect(getMnemonic()).toBeNull();
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
});
