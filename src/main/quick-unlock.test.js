const fs = require('fs');
const path = require('path');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalFreedomIdentityData = process.env.FREEDOM_IDENTITY_DATA;

function setPlatform(value) {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value,
  });
}

function restorePlatform() {
  Object.defineProperty(process, 'platform', originalPlatform);
}

function makeProfile(id, userDataDir) {
  return {
    id,
    displayName: id,
    userDataDir,
  };
}

function writeVault(identityDir, label = 'vault-a') {
  fs.mkdirSync(identityDir, { recursive: true });
  fs.writeFileSync(path.join(identityDir, 'identity-vault.json'), JSON.stringify({ label }));
}

function loadQuickUnlock({
  activeProfile,
  userDataDir,
  verifyPasswordImpl = jest.fn().mockResolvedValue(undefined),
  identityManager = makeIdentityManager(),
} = {}) {
  const profileResolverPath = require.resolve('./profile-resolver');
  const identityManagerPath = require.resolve('./identity-manager');
  const ipcHandlers = new Map();
  const ipcMain = { handle: jest.fn((channel, fn) => ipcHandlers.set(channel, fn)) };
  const vaultModulePath = require.resolve('./identity/vault');
  const systemPreferences = {
    canPromptTouchID: jest.fn(() => true),
    promptTouchID: jest.fn().mockResolvedValue(undefined),
  };
  const safeStorage = {
    isEncryptionAvailable: jest.fn(() => true),
    encryptString: jest.fn((password) => Buffer.from(`encrypted:${password}`)),
    decryptString: jest.fn((buffer) => buffer.toString().replace(/^encrypted:/, '')),
  };

  const { mod } = loadMainModule(require.resolve('./quick-unlock'), {
    userDataDir,
    electronOverrides: {
      ipcMain,
      systemPreferences,
      safeStorage,
    },
    extraMocks: {
      [profileResolverPath]: () => ({
        getActiveProfile: () => activeProfile,
      }),
      [identityManagerPath]: () => identityManager,
      [vaultModulePath]: () => ({
        getVaultPath: (dataDir) => path.join(dataDir, 'identity-vault.json'),
        verifyPassword: verifyPasswordImpl,
      }),
    },
  });

  return {
    mod,
    ipcHandlers,
    identityManager,
    systemPreferences,
    safeStorage,
    verifyPassword: verifyPasswordImpl,
  };
}

function makeIdentityManager() {
  return {
    unlockVault: jest.fn().mockResolvedValue(undefined),
    exportMnemonic: jest.fn().mockResolvedValue('word '.repeat(23) + 'word'),
    assertPrivateKeyExportable: jest.fn(),
    exportPrivateKeyForAccount: jest.fn().mockResolvedValue('0x' + '11'.repeat(32)),
  };
}

describe('quick-unlock', () => {
  let tempDirs = [];

  beforeEach(() => {
    tempDirs = [];
    setPlatform('darwin');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    if (originalFreedomIdentityData === undefined) {
      delete process.env.FREEDOM_IDENTITY_DATA;
    } else {
      process.env.FREEDOM_IDENTITY_DATA = originalFreedomIdentityData;
    }
  });

  afterEach(() => {
    restorePlatform();
    if (originalFreedomIdentityData === undefined) {
      delete process.env.FREEDOM_IDENTITY_DATA;
    } else {
      process.env.FREEDOM_IDENTITY_DATA = originalFreedomIdentityData;
    }
    for (const dir of tempDirs) {
      removeTempUserDataDir(dir);
    }
    jest.restoreAllMocks();
  });

  function tempUserData() {
    const dir = createTempUserDataDir('quick-unlock-test-');
    tempDirs.push(dir);
    return dir;
  }

  test('stores and unlocks a profile-bound credential', async () => {
    const userDataDir = tempUserData();
    const identityDir = path.join(userDataDir, 'identity');
    writeVault(identityDir);
    const profile = makeProfile('work', userDataDir);
    const { mod, verifyPassword } = loadQuickUnlock({
      activeProfile: profile,
      userDataDir,
    });

    await expect(mod.enableQuickUnlock('password-a')).resolves.toEqual({ success: true });

    const credentialPath = path.join(identityDir, 'quick-unlock.dat');
    const payload = JSON.parse(fs.readFileSync(credentialPath, 'utf-8'));
    expect(payload).toEqual(
      expect.objectContaining({
        version: mod.CREDENTIAL_VERSION,
        profileId: 'work',
        encrypted: Buffer.from('encrypted:password-a').toString('base64'),
      })
    );

    await expect(mod.unlockWithTouchId()).resolves.toEqual({ success: true });
    expect(verifyPassword).toHaveBeenCalledWith(identityDir, 'password-a');
  });

  test('hides a bound credential when the active profile does not match', async () => {
    const sharedIdentityDir = tempUserData();
    process.env.FREEDOM_IDENTITY_DATA = sharedIdentityDir;
    writeVault(sharedIdentityDir);

    const profileA = makeProfile('profile-a', tempUserData());
    const first = loadQuickUnlock({
      activeProfile: profileA,
      userDataDir: profileA.userDataDir,
    });
    await first.mod.enableQuickUnlock('password-a');

    const profileB = makeProfile('profile-b', tempUserData());
    const second = loadQuickUnlock({
      activeProfile: profileB,
      userDataDir: profileB.userDataDir,
    });

    expect(second.mod.isQuickUnlockEnabled()).toBe(false);
    await expect(second.mod.unlockWithTouchId()).resolves.toEqual({
      success: false,
      error: 'Quick unlock not enabled',
    });
    expect(second.systemPreferences.promptTouchID).not.toHaveBeenCalled();
  });

  test('migrates a legacy raw credential after a successful unlock', async () => {
    const userDataDir = tempUserData();
    const identityDir = path.join(userDataDir, 'identity');
    writeVault(identityDir);
    fs.writeFileSync(path.join(identityDir, 'quick-unlock.dat'), Buffer.from('encrypted:legacy'));

    const { mod, identityManager } = loadQuickUnlock({
      activeProfile: makeProfile('default', userDataDir),
      userDataDir,
    });

    await expect(mod.unlockWithTouchId()).resolves.toEqual({ success: true });
    expect(identityManager.unlockVault).toHaveBeenCalledWith('legacy');

    const payload = JSON.parse(fs.readFileSync(path.join(identityDir, 'quick-unlock.dat'), 'utf-8'));
    expect(payload.version).toBe(mod.CREDENTIAL_VERSION);
    expect(payload.profileId).toBe('default');
  });

  test('rejects a decrypted credential that does not unlock the current vault', async () => {
    const userDataDir = tempUserData();
    const identityDir = path.join(userDataDir, 'identity');
    writeVault(identityDir);
    fs.writeFileSync(path.join(identityDir, 'quick-unlock.dat'), Buffer.from('encrypted:wrong'));

    const verifyPassword = jest.fn().mockRejectedValue(new Error('Incorrect password'));
    const { mod } = loadQuickUnlock({
      activeProfile: makeProfile('default', userDataDir),
      userDataDir,
      verifyPasswordImpl: verifyPassword,
    });

    await expect(mod.unlockWithTouchId()).resolves.toEqual({
      success: false,
      error: 'Incorrect password',
    });
  });

  // Security audit O-8: after Touch ID, main finishes the job itself and
  // the stored vault password never crosses IPC to any renderer.
  describe('never returns the vault password', () => {
    async function enabled(options = {}) {
      const userDataDir = tempUserData();
      writeVault(path.join(userDataDir, 'identity'));
      const loaded = loadQuickUnlock({
        activeProfile: makeProfile('default', userDataDir),
        userDataDir,
        ...options,
      });
      await loaded.mod.enableQuickUnlock('s3cret-vault-pw');
      loaded.systemPreferences.promptTouchID.mockClear();
      loaded.mod.registerQuickUnlockIpc();
      return loaded;
    }

    function leaks(result) {
      return JSON.stringify(result).includes('s3cret-vault-pw');
    }

    test('quick-unlock:unlock unlocks the vault in main and returns success only', async () => {
      const { ipcHandlers, identityManager, systemPreferences } = await enabled();

      const result = await ipcHandlers.get('quick-unlock:unlock')({});

      expect(result).toEqual({ success: true });
      expect(leaks(result)).toBe(false);
      expect(systemPreferences.promptTouchID).toHaveBeenCalledTimes(1);
      expect(identityManager.unlockVault).toHaveBeenCalledWith('s3cret-vault-pw');
    });

    test('a vault that fails to unlock reports failure, still without the password', async () => {
      const identityManager = makeIdentityManager();
      identityManager.unlockVault.mockRejectedValue(new Error('Vault is corrupted'));
      const { ipcHandlers } = await enabled({ identityManager });

      const result = await ipcHandlers.get('quick-unlock:unlock')({});

      expect(result).toEqual({ success: false, error: 'Vault is corrupted' });
      expect(leaks(result)).toBe(false);
    });

    test('quick-unlock:export-mnemonic returns the phrase, not the password', async () => {
      const { ipcHandlers, identityManager } = await enabled();

      const result = await ipcHandlers.get('quick-unlock:export-mnemonic')({});

      expect(result).toEqual({ success: true, mnemonic: 'word '.repeat(23) + 'word' });
      expect(leaks(result)).toBe(false);
      expect(identityManager.unlockVault).toHaveBeenCalledWith('s3cret-vault-pw');
    });

    test('quick-unlock:export-private-key returns the key, not the password', async () => {
      const { ipcHandlers, identityManager } = await enabled();

      const result = await ipcHandlers.get('quick-unlock:export-private-key')({}, 3);

      expect(result).toEqual({ success: true, privateKey: '0x' + '11'.repeat(32) });
      expect(leaks(result)).toBe(false);
      expect(identityManager.exportPrivateKeyForAccount).toHaveBeenCalledWith(3);
    });

    test('export-private-key refuses a device account before prompting Touch ID', async () => {
      const identityManager = makeIdentityManager();
      identityManager.assertPrivateKeyExportable.mockImplementation(() => {
        throw new Error('This account has no exportable private key');
      });
      const { ipcHandlers, systemPreferences } = await enabled({ identityManager });

      const result = await ipcHandlers.get('quick-unlock:export-private-key')({}, 1000000);

      expect(result).toEqual({ success: false, error: 'This account has no exportable private key' });
      expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
      expect(identityManager.exportPrivateKeyForAccount).not.toHaveBeenCalled();
    });

    test('no quick-unlock IPC handler returns the password', async () => {
      const { ipcHandlers, identityManager } = await enabled();
      // enable takes the password as its input (the user just typed it);
      // disable would delete the credential the others need.
      const channels = [...ipcHandlers.keys()].filter(
        (c) => c !== 'quick-unlock:enable' && c !== 'quick-unlock:disable'
      );
      expect(channels).toEqual(expect.arrayContaining([
        'quick-unlock:unlock',
        'quick-unlock:export-mnemonic',
        'quick-unlock:export-private-key',
      ]));
      for (const channel of channels) {
        const result = await ipcHandlers.get(channel)({}, 0);
        expect({ channel, leaks: leaks(result) }).toEqual({ channel, leaks: false });
      }
      // The Touch ID paths really ran (and really had the password in main).
      expect(identityManager.unlockVault).toHaveBeenCalledWith('s3cret-vault-pw');
    });
  });
});
