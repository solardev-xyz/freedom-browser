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
  const vaultBackendPath = require.resolve('./core/vault-backend');
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
      [vaultBackendPath]: () => ({
        vaultBackend: { verifyPassword: (...args) => verifyPasswordImpl(...args) },
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
    expect(verifyPassword).toHaveBeenCalledWith('password-a');
  });

  test('completeQuickSetup stores a verified password without prompting', async () => {
    const userDataDir = tempUserData();
    const identityDir = path.join(userDataDir, 'identity');
    writeVault(identityDir);
    const profile = makeProfile('work', userDataDir);
    const { mod, verifyPassword, systemPreferences } = loadQuickUnlock({
      activeProfile: profile,
      userDataDir,
    });

    await expect(mod.completeQuickSetup('random-pass')).resolves.toBe(true);
    expect(verifyPassword).toHaveBeenCalledWith('random-pass');
    expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
    const payload = JSON.parse(
      fs.readFileSync(path.join(identityDir, 'quick-unlock.dat'), 'utf-8')
    );
    expect(payload.encrypted).toBe(Buffer.from('encrypted:random-pass').toString('base64'));

    // A password the vault doesn't take (it was replaced) is never stored,
    // and not retried.
    verifyPassword.mockRejectedValueOnce(
      Object.assign(new Error('Incorrect password'), { code: 'incorrect_password' })
    );
    await expect(mod.completeQuickSetup('wrong')).resolves.toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(identityDir, 'quick-unlock.dat'), 'utf-8')).encrypted)
      .toBe(Buffer.from('encrypted:random-pass').toString('base64'));
  });

  test('completeQuickSetup keeps the password and retries until it is stored', async () => {
    jest.useFakeTimers();
    try {
      const userDataDir = tempUserData();
      const identityDir = path.join(userDataDir, 'identity');
      writeVault(identityDir);
      const { mod, verifyPassword } = loadQuickUnlock({
        activeProfile: makeProfile('work', userDataDir),
        userDataDir,
      });
      const credentialPath = path.join(identityDir, 'quick-unlock.dat');
      // The core is down at first.
      verifyPassword.mockRejectedValueOnce(
        Object.assign(new Error('The core is not running'), { code: 'core_unavailable' })
      );
      await expect(mod.completeQuickSetup('random-pass')).resolves.toBe(false);
      expect(fs.existsSync(credentialPath)).toBe(false);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(verifyPassword).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fs.readFileSync(credentialPath, 'utf-8')).encrypted).toBe(
        Buffer.from('encrypted:random-pass').toString('base64')
      );
      // Stored: no more retries.
      await jest.advanceTimersByTimeAsync(120_000);
      expect(verifyPassword).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('disabling quick unlock cancels a pending Quick Setup credential', async () => {
    jest.useFakeTimers();
    try {
      const userDataDir = tempUserData();
      const identityDir = path.join(userDataDir, 'identity');
      writeVault(identityDir);
      let releaseVerify;
      const verifyPasswordImpl = jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('The core is not running'), { code: 'core_unavailable' })
        )
        .mockImplementationOnce(() => new Promise((resolve) => (releaseVerify = resolve)));
      const { mod } = loadQuickUnlock({
        activeProfile: makeProfile('work', userDataDir),
        userDataDir,
        verifyPasswordImpl,
      });
      const credentialPath = path.join(identityDir, 'quick-unlock.dat');
      await expect(mod.completeQuickSetup('random-pass')).resolves.toBe(false);
      // A scheduled retry: disable cancels it.
      expect(mod.disableQuickUnlock()).toEqual({ success: true });
      await jest.advanceTimersByTimeAsync(120_000);
      expect(verifyPasswordImpl).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(credentialPath)).toBe(false);
      // An attempt in flight when disabled doesn't write either.
      const attempt = mod.completeQuickSetup('random-pass');
      await Promise.resolve();
      mod.disableQuickUnlock();
      releaseVerify();
      await expect(attempt).resolves.toBe(false);
      expect(fs.existsSync(credentialPath)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
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

  // K-3: the credential is read, written, refreshed and removed through the
  // identity directory's handle, so a link planted at its name after the
  // startup repair is never followed.
  describe('never through a link at the credential name (K-3)', () => {
    const posixTest = originalPlatform.value === 'win32' ? test.skip : test;
    const modeOf = (target) => fs.statSync(target).mode & 0o777;

    function setUp() {
      const userDataDir = tempUserData();
      const identityDir = path.join(userDataDir, 'identity');
      writeVault(identityDir);
      const credentialPath = path.join(identityDir, 'quick-unlock.dat');
      // A file a link could point at, holding what would pass for a legacy
      // credential if it were followed.
      const outside = path.join(userDataDir, 'outside.dat');
      fs.writeFileSync(outside, 'encrypted:planted');
      fs.chmodSync(outside, 0o644);
      const plantLink = () => {
        fs.rmSync(credentialPath, { force: true });
        fs.symlinkSync(outside, credentialPath);
      };
      const outsideUntouched = () => {
        expect(fs.readFileSync(outside, 'utf8')).toBe('encrypted:planted');
        expect(modeOf(outside)).toBe(0o644);
      };
      const ctx = loadQuickUnlock({ activeProfile: makeProfile('default', userDataDir), userDataDir });
      return { ...ctx, credentialPath, plantLink, outsideUntouched };
    }

    const expectOwnCredential = (mod, credentialPath) => {
      expect(fs.lstatSync(credentialPath).isSymbolicLink()).toBe(false);
      expect(modeOf(credentialPath)).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(credentialPath, 'utf8')).version).toBe(
        mod.CREDENTIAL_VERSION
      );
    };

    beforeEach(() => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    posixTest('reading refuses a planted link; disabling removes the link only', async () => {
      const { mod, credentialPath, plantLink, outsideUntouched, systemPreferences, identityManager } =
        setUp();
      plantLink();

      expect(mod.isQuickUnlockEnabled()).toBe(false);
      await expect(mod.unlockWithTouchId()).resolves.toEqual({
        success: false,
        error: 'Quick unlock not enabled',
      });
      expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
      expect(identityManager.unlockVault).not.toHaveBeenCalled();

      expect(mod.disableQuickUnlock()).toEqual({ success: true });
      expect(fs.lstatSync(credentialPath, { throwIfNoEntry: false })).toBeUndefined();
      outsideUntouched();
    });

    posixTest('enabling replaces a planted link, its target untouched', async () => {
      const { mod, credentialPath, plantLink, outsideUntouched } = setUp();
      plantLink();

      await expect(mod.enableQuickUnlock('password-a')).resolves.toEqual({ success: true });
      expectOwnCredential(mod, credentialPath);
      outsideUntouched();
      expect(mod.isQuickUnlockEnabled()).toBe(true);
    });

    posixTest('a legacy refresh replaces a link planted during the Touch ID prompt', async () => {
      const { mod, credentialPath, plantLink, outsideUntouched, systemPreferences, identityManager } =
        setUp();
      fs.writeFileSync(credentialPath, Buffer.from('encrypted:legacy'));
      systemPreferences.promptTouchID.mockImplementation(async () => plantLink());

      await expect(mod.unlockWithTouchId()).resolves.toEqual({ success: true });
      expect(identityManager.unlockVault).toHaveBeenCalledWith('legacy');
      expectOwnCredential(mod, credentialPath);
      outsideUntouched();
    });

    posixTest('an older 0644 credential is replaced owner-only, never rewritten in place', async () => {
      const { mod, credentialPath } = setUp();
      fs.writeFileSync(credentialPath, Buffer.from('encrypted:legacy'));
      fs.chmodSync(credentialPath, 0o644);
      // A second name for the old file: what an open reader would still see.
      const oldInode = `${credentialPath}.old`;
      fs.linkSync(credentialPath, oldInode);

      await expect(mod.enableQuickUnlock('password-a')).resolves.toEqual({ success: true });
      expectOwnCredential(mod, credentialPath);
      expect(fs.readFileSync(oldInode, 'utf8')).toBe('encrypted:legacy');
      fs.rmSync(oldInode);
    });

    // On integration the core writes the vault; main only hashes it, to bind
    // a credential to it, and reads it through the identity directory's
    // handle as well.
    posixTest('a vault that is a link is never hashed: quick unlock is off, nothing prompted', async () => {
      const { mod, credentialPath, systemPreferences, identityManager, verifyPassword } = setUp();
      await expect(mod.enableQuickUnlock('password-a')).resolves.toEqual({ success: true });
      expect(mod.isQuickUnlockEnabled()).toBe(true);

      // The same vault bytes, now behind a link at the vault's name.
      const identityDir = path.dirname(credentialPath);
      const vaultPath = path.join(identityDir, 'identity-vault.json');
      const outsideVault = path.join(path.dirname(identityDir), 'outside-vault.json');
      fs.renameSync(vaultPath, outsideVault);
      fs.chmodSync(outsideVault, 0o644);
      fs.symlinkSync(outsideVault, vaultPath);
      systemPreferences.promptTouchID.mockClear();
      verifyPassword.mockClear();
      const credential = fs.readFileSync(credentialPath);

      expect(mod.isQuickUnlockEnabled()).toBe(false);
      await expect(mod.unlockWithTouchId()).resolves.toEqual({
        success: false,
        error: 'Quick unlock not enabled',
      });
      expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
      expect(verifyPassword).not.toHaveBeenCalled();
      expect(identityManager.unlockVault).not.toHaveBeenCalled();

      // Nor is a new credential bound to it.
      await expect(mod.enableQuickUnlock('password-a')).resolves.toEqual({
        success: false,
        error: expect.stringContaining('symbolic link'),
      });
      expect(fs.readFileSync(credentialPath)).toEqual(credential);
      expect(modeOf(outsideVault)).toBe(0o644);
    });

    // completeQuickSetup (freedom-core design 0001) stores the credential
    // for a Quick Setup whose reply was lost: the same handle and writer.
    posixTest("a lost Quick Setup's credential is stored owner-only, a planted link replaced", async () => {
      const { mod, credentialPath, plantLink, outsideUntouched } = setUp();
      const identityDir = path.dirname(credentialPath);
      fs.chmodSync(identityDir, 0o755);
      plantLink();

      await expect(mod.completeQuickSetup('random-pass')).resolves.toBe(true);
      expectOwnCredential(mod, credentialPath);
      expect(modeOf(identityDir)).toBe(0o700);
      outsideUntouched();
      expect(mod.isQuickUnlockEnabled()).toBe(true);
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
      // The core verifies the unsealed password again before exporting.
      expect(identityManager.exportMnemonic).toHaveBeenCalledWith('s3cret-vault-pw');
    });

    test('quick-unlock:export-private-key returns the key, not the password', async () => {
      const { ipcHandlers, identityManager } = await enabled();

      const result = await ipcHandlers.get('quick-unlock:export-private-key')({}, 3);

      expect(result).toEqual({ success: true, privateKey: '0x' + '11'.repeat(32) });
      expect(leaks(result)).toBe(false);
      expect(identityManager.exportPrivateKeyForAccount).toHaveBeenCalledWith(3, 's3cret-vault-pw');
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
