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

const coreError = (code, message, data) => Object.assign(new Error(message), { code, data });

/**
 * A stand-in for the core behind vault-backend: the vault password, quick
 * unlock's credential (the password the core holds, or null) and whether
 * the vault is unlocked. `password: null` takes any password.
 */
function makeCore({ password = null } = {}) {
  const state = { password, credential: null, unlocked: false };
  const check = (pw) => {
    if (state.password !== null && pw !== state.password) {
      throw coreError('incorrect_password', 'Incorrect password');
    }
  };
  const throughCredential = () => {
    if (state.credential === null) throw coreError('not_found', 'Quick unlock not enabled');
    check(state.credential);
    state.unlocked = true;
  };
  const backend = {
    verifyPassword: jest.fn(async (pw) => check(pw)),
    quickUnlockStatus: jest.fn(async () => ({
      enabled: state.credential !== null,
      policy: state.credential === null ? null : 'unattended',
      available: true,
    })),
    quickUnlockEnroll: jest.fn(async (pw) => {
      check(pw);
      state.credential = pw;
    }),
    quickUnlockDisable: jest.fn(async () => {
      state.credential = null;
    }),
    // The core re-wraps its credential in the change.
    changePassword: jest.fn(async (current, next) => {
      check(current);
      state.password = next;
      if (state.credential !== null) state.credential = next;
    }),
  };
  return { state, backend, check, throughCredential };
}

function makeIdentityManager(core = makeCore()) {
  return {
    unlockVault: jest.fn(async (pw) => {
      core.check(pw);
      core.state.unlocked = true;
    }),
    quickUnlockVault: jest.fn(async () => core.throughCredential()),
    exportMnemonic: jest.fn().mockResolvedValue('word '.repeat(23) + 'word'),
    quickExportMnemonic: jest.fn(async () => {
      core.throughCredential();
      return 'word '.repeat(23) + 'word';
    }),
    assertPrivateKeyExportable: jest.fn(),
    exportPrivateKeyForAccount: jest.fn().mockResolvedValue('0x' + '11'.repeat(32)),
    quickExportPrivateKeyForAccount: jest.fn(async () => {
      core.throughCredential();
      return '0x' + '11'.repeat(32);
    }),
    importExistingMnemonic: jest.fn(async (pw) => {
      core.state.password = pw;
      core.state.credential = pw;
      core.state.unlocked = true;
    }),
    deleteVaultData: jest.fn(),
  };
}

function loadQuickUnlock({
  activeProfile,
  userDataDir,
  core = makeCore(),
  verifyPasswordImpl = null,
  identityManager = makeIdentityManager(core),
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
  if (verifyPasswordImpl) core.backend.verifyPassword = verifyPasswordImpl;

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
      [vaultBackendPath]: () => ({ vaultBackend: core.backend }),
    },
  });

  return {
    mod,
    core,
    ipcHandlers,
    identityManager,
    systemPreferences,
    safeStorage,
    verifyPassword: core.backend.verifyPassword,
    // The reference quick-unlock.js (what builds before PRF-2b run), on the
    // same mocks and files.
    reference: () => require('../../test/reference/quick-unlock'),
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
    const { mod, core, identityManager, safeStorage, systemPreferences } = loadQuickUnlock({
      activeProfile: profile,
      userDataDir,
      core: makeCore({ password: 'password-a' }),
    });

    await expect(mod.enableQuickUnlock('password-a')).resolves.toEqual({ success: true });
    // The core holds it (enroll, after Touch ID) ...
    expect(core.backend.quickUnlockEnroll).toHaveBeenCalledWith('password-a');
    expect(systemPreferences.promptTouchID.mock.invocationCallOrder[0]).toBeLessThan(
      core.backend.quickUnlockEnroll.mock.invocationCallOrder[0]
    );
    // ... and quick-unlock.dat is written for older builds.
    const credentialPath = path.join(identityDir, 'quick-unlock.dat');
    const payload = JSON.parse(fs.readFileSync(credentialPath, 'utf-8'));
    expect(payload).toEqual(
      expect.objectContaining({
        version: mod.CREDENTIAL_VERSION,
        profileId: 'work',
        encrypted: Buffer.from('encrypted:password-a').toString('base64'),
      })
    );

    // The unlock goes through the core: main never unseals the file.
    await expect(mod.unlockWithTouchId()).resolves.toEqual({ success: true });
    expect(identityManager.quickUnlockVault).toHaveBeenCalledTimes(1);
    expect(identityManager.unlockVault).not.toHaveBeenCalled();
    expect(safeStorage.decryptString).not.toHaveBeenCalled();
  });

  test('enable: a wrong password prompts nothing; a key-store refusal writes nothing', async () => {
    const userDataDir = tempUserData();
    const identityDir = path.join(userDataDir, 'identity');
    writeVault(identityDir);
    const { mod, core, systemPreferences } = loadQuickUnlock({
      activeProfile: makeProfile('work', userDataDir),
      userDataDir,
      core: makeCore({ password: 'password-a' }),
    });
    const credentialPath = path.join(identityDir, 'quick-unlock.dat');

    await expect(mod.enableQuickUnlock('wrong')).resolves.toEqual({
      success: false,
      error: 'Incorrect password',
    });
    expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
    expect(core.backend.quickUnlockEnroll).not.toHaveBeenCalled();

    const refusal = coreError('key_store_cancelled', 'The keychain request was cancelled.');
    core.backend.quickUnlockEnroll.mockRejectedValueOnce(refusal);
    await expect(mod.enableQuickUnlock('password-a')).resolves.toEqual({
      success: false,
      error: 'The keychain request was cancelled.',
    });
    expect(fs.existsSync(credentialPath)).toBe(false);
    await expect(mod.isQuickUnlockEnabled()).resolves.toBe(false);
  });

  // quick-unlock.dat after the core committed its own credential (Quick
  // Setup, or a lost one found again): sealed at once, never the password
  // kept; a failed write's sealed bytes only, for three tries (#1262 r1).
  describe('completeQuickSetup', () => {
    function setUp() {
      const userDataDir = tempUserData();
      const identityDir = path.join(userDataDir, 'identity');
      writeVault(identityDir);
      const loaded = loadQuickUnlock({ activeProfile: makeProfile('work', userDataDir), userDataDir });
      const credentialPath = path.join(identityDir, 'quick-unlock.dat');
      // A directory at the credential's name: every write fails.
      const blockWrites = () => {
        fs.mkdirSync(credentialPath);
        fs.writeFileSync(path.join(credentialPath, 'x'), 'x');
      };
      const unblockWrites = () => fs.rmSync(credentialPath, { recursive: true, force: true });
      return { ...loaded, userDataDir, identityDir, credentialPath, blockWrites, unblockWrites };
    }

    /** Whether `value` holds `needle` anywhere: a string, or a Buffer's text. */
    function holds(value, needle, seen = new Set()) {
      if (typeof value === 'string') return value.includes(needle);
      if (Buffer.isBuffer(value)) return value.toString('utf8').includes(needle);
      if (!value || typeof value !== 'object' || seen.has(value)) return false;
      seen.add(value);
      return Object.values(value).some((v) => holds(v, needle, seen));
    }

    const logged = () =>
      [...console.error.mock.calls, ...console.log.mock.calls].flat().map(String).join('\n');

    test('seals and writes the file, without prompting or asking the core', async () => {
      const { mod, verifyPassword, systemPreferences, safeStorage, credentialPath } = setUp();
      await expect(mod.completeQuickSetup('random-pass')).resolves.toBe(true);
      expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
      expect(verifyPassword).not.toHaveBeenCalled();
      expect(safeStorage.encryptString).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(fs.readFileSync(credentialPath, 'utf-8'));
      expect(payload.encrypted).toBe(Buffer.from('encrypted:random-pass').toString('base64'));
      expect(mod._internal.pendingSetup()).toBeNull();
    });

    test('a failed write keeps only the sealed bytes, and writes them on a retry', async () => {
      jest.useFakeTimers();
      try {
        const { mod, safeStorage, credentialPath, blockWrites, unblockWrites, identityDir } = setUp();
        blockWrites();
        await expect(mod.completeQuickSetup('random-pass')).resolves.toBe(false);
        const pending = mod._internal.pendingSetup();
        expect(pending).not.toBeNull();
        expect(holds(pending, 'random-pass')).toBe(false);
        expect(logged()).not.toContain(identityDir);
        unblockWrites();
        await jest.advanceTimersByTimeAsync(30_000);
        expect(JSON.parse(fs.readFileSync(credentialPath, 'utf-8')).encrypted).toBe(
          Buffer.from('encrypted:random-pass').toString('base64')
        );
        // Sealed once: the retry wrote the bytes it kept.
        expect(safeStorage.encryptString).toHaveBeenCalledTimes(1);
        expect(mod._internal.pendingSetup()).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    test('three failed writes, and the sealed bytes are dropped', async () => {
      jest.useFakeTimers();
      try {
        const { mod, safeStorage, credentialPath, blockWrites, unblockWrites, identityDir } = setUp();
        blockWrites();
        await expect(mod.completeQuickSetup('random-pass')).resolves.toBe(false);
        await jest.advanceTimersByTimeAsync(30_000);
        expect(mod._internal.pendingSetup()).not.toBeNull();
        await jest.advanceTimersByTimeAsync(30_000);
        expect(mod._internal.pendingSetup()).toBeNull();
        unblockWrites();
        await jest.advanceTimersByTimeAsync(10 * 60_000);
        expect(fs.existsSync(credentialPath)).toBe(false);
        expect(safeStorage.encryptString).toHaveBeenCalledTimes(1);
        expect(logged()).not.toContain(identityDir);
      } finally {
        jest.useRealTimers();
      }
    });

    test('a password that cannot be sealed is dropped at once: no file, no retry, nothing kept', async () => {
      jest.useFakeTimers();
      try {
        const thrown = setUp();
        thrown.safeStorage.encryptString.mockImplementation(() => {
          throw new Error('Encryption is not available');
        });
        await expect(thrown.mod.completeQuickSetup('random-pass')).resolves.toBe(false);
        expect(thrown.mod._internal.pendingSetup()).toBeNull();
        await jest.advanceTimersByTimeAsync(10 * 60_000);
        expect(thrown.safeStorage.encryptString).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(thrown.credentialPath)).toBe(false);
        expect(logged()).toMatch(/could not be sealed/);
        expect(logged()).not.toContain('random-pass');

        const unavailable = setUp();
        unavailable.safeStorage.isEncryptionAvailable.mockReturnValue(false);
        await expect(unavailable.mod.completeQuickSetup('random-pass')).resolves.toBe(false);
        expect(unavailable.mod._internal.pendingSetup()).toBeNull();
        await jest.advanceTimersByTimeAsync(10 * 60_000);
        expect(unavailable.safeStorage.encryptString).not.toHaveBeenCalled();
        expect(fs.existsSync(unavailable.credentialPath)).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    test('a vault replaced before the retry: the sealed bytes are dropped, not written', async () => {
      jest.useFakeTimers();
      try {
        const { mod, credentialPath, blockWrites, unblockWrites, identityDir } = setUp();
        blockWrites();
        await expect(mod.completeQuickSetup('random-pass')).resolves.toBe(false);
        unblockWrites();
        writeVault(identityDir, 'vault-b');
        await jest.advanceTimersByTimeAsync(30_000);
        expect(mod._internal.pendingSetup()).toBeNull();
        await jest.advanceTimersByTimeAsync(10 * 60_000);
        expect(fs.existsSync(credentialPath)).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    test('disabling quick unlock drops a pending write', async () => {
      jest.useFakeTimers();
      try {
        const { mod, credentialPath, blockWrites, unblockWrites } = setUp();
        blockWrites();
        await expect(mod.completeQuickSetup('random-pass')).resolves.toBe(false);
        unblockWrites();
        await expect(mod.disableQuickUnlock()).resolves.toEqual({ success: true });
        expect(mod._internal.pendingSetup()).toBeNull();
        await jest.advanceTimersByTimeAsync(10 * 60_000);
        expect(fs.existsSync(credentialPath)).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });
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

    await expect(second.mod.isQuickUnlockEnabled()).resolves.toBe(false);
    await expect(second.mod.unlockWithTouchId()).resolves.toEqual({
      success: false,
      error: 'Quick unlock not enabled',
    });
    expect(second.systemPreferences.promptTouchID).not.toHaveBeenCalled();
  });

  test('rejects a decrypted credential that does not unlock the current vault', async () => {
    const userDataDir = tempUserData();
    const identityDir = path.join(userDataDir, 'identity');
    writeVault(identityDir);
    fs.writeFileSync(path.join(identityDir, 'quick-unlock.dat'), Buffer.from('encrypted:wrong'));

    const { mod, core } = loadQuickUnlock({
      activeProfile: makeProfile('default', userDataDir),
      userDataDir,
      core: makeCore({ password: 'right' }),
    });

    await expect(mod.unlockWithTouchId()).resolves.toEqual({
      success: false,
      error: 'Incorrect password',
    });
    // Nothing is enrolled from a password the vault didn't take.
    expect(core.backend.quickUnlockEnroll).not.toHaveBeenCalled();
  });

  // K-3: the credential is read, written, refreshed and removed through the
  // identity directory's handle, so a link planted at its name after the
  // startup repair is never followed.
  // #1262 r1: the file is checked against the vault again after the Touch ID
  // prompt, right before use; a vault swapped meanwhile fails closed.
  describe('a vault swapped during the Touch ID prompt', () => {
    async function onTheFile() {
      const userDataDir = tempUserData();
      const identityDir = path.join(userDataDir, 'identity');
      writeVault(identityDir, 'vault-a');
      const loaded = loadQuickUnlock({
        activeProfile: makeProfile('default', userDataDir),
        userDataDir,
        // Both vaults take the same password: only the binding tells them apart.
        core: makeCore({ password: 'same-pw' }),
      });
      await loaded.reference().enableQuickUnlock('same-pw');
      loaded.core.backend.quickUnlockEnroll.mockClear();
      loaded.safeStorage.decryptString.mockClear();
      loaded.systemPreferences.promptTouchID.mockClear();
      return { ...loaded, identityDir };
    }

    test('a v2 file bound to the vault before it: no unlock, no enroll, nothing unsealed', async () => {
      const { mod, core, identityManager, safeStorage, systemPreferences, identityDir } = await onTheFile();
      systemPreferences.promptTouchID.mockImplementation(async () => writeVault(identityDir, 'vault-b'));
      await expect(mod.unlockWithTouchId()).resolves.toEqual({
        success: false,
        error: 'Quick unlock changed during the Touch ID prompt. Try again.',
      });
      expect(identityManager.unlockVault).not.toHaveBeenCalled();
      expect(core.backend.quickUnlockEnroll).not.toHaveBeenCalled();
      expect(safeStorage.decryptString).not.toHaveBeenCalled();
      expect(core.state.credential).toBeNull();
      // The exports too, with the first vault back before the prompt.
      writeVault(identityDir, 'vault-a');
      await expect(mod.exportMnemonicWithTouchId()).resolves.toEqual({
        success: false,
        error: 'Quick unlock changed during the Touch ID prompt. Try again.',
      });
      expect(systemPreferences.promptTouchID).toHaveBeenCalledTimes(2);
      expect(identityManager.exportMnemonic).not.toHaveBeenCalled();
    });

    test('the file replaced during the prompt by another one for the same vault: refused too', async () => {
      const { mod, core, identityManager, systemPreferences, identityDir } = await onTheFile();
      const credentialPath = path.join(identityDir, 'quick-unlock.dat');
      systemPreferences.promptTouchID.mockImplementation(async () => {
        const other = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
        other.encrypted = Buffer.from('encrypted:other-pw').toString('base64');
        fs.writeFileSync(credentialPath, JSON.stringify(other));
      });
      await expect(mod.unlockWithTouchId()).resolves.toEqual({
        success: false,
        error: 'Quick unlock changed during the Touch ID prompt. Try again.',
      });
      expect(identityManager.unlockVault).not.toHaveBeenCalled();
      expect(core.backend.quickUnlockEnroll).not.toHaveBeenCalled();
    });

    test('the vault swapped and the v2 file turned legacy (its own ciphertext, unbound): refused', async () => {
      const { mod, core, identityManager, systemPreferences, identityDir } = await onTheFile();
      const credentialPath = path.join(identityDir, 'quick-unlock.dat');
      systemPreferences.promptTouchID.mockImplementation(async () => {
        const { encrypted } = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
        fs.writeFileSync(credentialPath, Buffer.from(encrypted, 'base64'));
        writeVault(identityDir, 'vault-b');
      });
      await expect(mod.unlockWithTouchId()).resolves.toEqual({
        success: false,
        error: 'Quick unlock changed during the Touch ID prompt. Try again.',
      });
      expect(identityManager.unlockVault).not.toHaveBeenCalled();
      expect(core.backend.quickUnlockEnroll).not.toHaveBeenCalled();
    });

    test('the vault unchanged: the file still unlocks once, then enrolls', async () => {
      const { mod, core, identityManager } = await onTheFile();
      await expect(mod.unlockWithTouchId()).resolves.toEqual({ success: true });
      expect(identityManager.unlockVault).toHaveBeenCalledWith('same-pw');
      expect(core.state.credential).toBe('same-pw');
    });
  });

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

      await expect(mod.isQuickUnlockEnabled()).resolves.toBe(false);
      await expect(mod.unlockWithTouchId()).resolves.toEqual({
        success: false,
        error: 'Quick unlock not enabled',
      });
      expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
      expect(identityManager.unlockVault).not.toHaveBeenCalled();

      await expect(mod.disableQuickUnlock()).resolves.toEqual({ success: true });
      expect(fs.lstatSync(credentialPath, { throwIfNoEntry: false })).toBeUndefined();
      outsideUntouched();
    });

    posixTest('enabling replaces a planted link, its target untouched', async () => {
      const { mod, credentialPath, plantLink, outsideUntouched } = setUp();
      plantLink();

      await expect(mod.enableQuickUnlock('password-a')).resolves.toEqual({ success: true });
      expectOwnCredential(mod, credentialPath);
      outsideUntouched();
      await expect(mod.isQuickUnlockEnabled()).resolves.toBe(true);
    });

    // PRF-2b: nothing is written after the Touch ID prompt (0013:
    // quick-unlock.dat is left byte for byte), and the file is read again
    // after it (#1262 r1): a link planted then fails the unlock closed, and
    // is left alone.
    posixTest('a link planted during the Touch ID prompt: no unlock, no enroll, the link left alone', async () => {
      const { mod, core, credentialPath, plantLink, outsideUntouched, systemPreferences, identityManager } =
        setUp();
      fs.writeFileSync(credentialPath, Buffer.from('encrypted:legacy'));
      systemPreferences.promptTouchID.mockImplementation(async () => plantLink());

      await expect(mod.unlockWithTouchId()).resolves.toEqual({
        success: false,
        error: 'Quick unlock changed during the Touch ID prompt. Try again.',
      });
      expect(identityManager.unlockVault).not.toHaveBeenCalled();
      expect(core.backend.quickUnlockEnroll).not.toHaveBeenCalled();
      expect(fs.lstatSync(credentialPath).isSymbolicLink()).toBe(true);
      outsideUntouched();
      // The refused link is logged by its code, not its path.
      const warned = console.warn.mock.calls.flat().map(String).join('\n');
      expect(warned).toContain('UNSAFE_PRIVATE_PATH');
      expect(warned).not.toContain(credentialPath);
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
      const { mod, core, credentialPath, systemPreferences, identityManager, verifyPassword } = setUp();
      await expect(mod.enableQuickUnlock('password-a')).resolves.toEqual({ success: true });
      // quick-unlock.dat alone, as before the migration.
      core.state.credential = null;
      await expect(mod.isQuickUnlockEnabled()).resolves.toBe(true);

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

      await expect(mod.isQuickUnlockEnabled()).resolves.toBe(false);
      await expect(mod.unlockWithTouchId()).resolves.toEqual({
        success: false,
        error: 'Quick unlock not enabled',
      });
      expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
      expect(verifyPassword).not.toHaveBeenCalled();
      expect(identityManager.unlockVault).not.toHaveBeenCalled();

      // Nor is a new quick-unlock.dat bound to it. (The core checks the
      // vault itself before it enrolls; here it stands in and takes it.)
      await expect(mod.enableQuickUnlock('password-a')).resolves.toEqual({ success: true });
      expect(console.error).toHaveBeenCalledWith(
        '[QuickUnlock] quick-unlock.dat not written for older builds:',
        'UNSAFE_PRIVATE_PATH'
      );
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
      await expect(mod.isQuickUnlockEnabled()).resolves.toBe(true);
    });
  });

  // Security audit O-8: after Touch ID, main finishes the job itself and
  // the stored vault password never crosses IPC to any renderer: neither
  // through the core's credential (main never has it) nor through
  // quick-unlock.dat (the migration's one pass).
  describe.each(['core', 'file'])('never returns the vault password (%s)', (through) => {
    async function enabled(options = {}) {
      const userDataDir = tempUserData();
      writeVault(path.join(userDataDir, 'identity'));
      const loaded = loadQuickUnlock({
        activeProfile: makeProfile('default', userDataDir),
        userDataDir,
        ...options,
      });
      await loaded.mod.enableQuickUnlock('s3cret-vault-pw');
      if (through === 'file') loaded.core.state.credential = null;
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
      if (through === 'core') {
        expect(identityManager.quickUnlockVault).toHaveBeenCalledTimes(1);
        expect(identityManager.unlockVault).not.toHaveBeenCalled();
      } else {
        expect(identityManager.unlockVault).toHaveBeenCalledWith('s3cret-vault-pw');
      }
    });

    test('a vault that fails to unlock reports failure, still without the password', async () => {
      const core = makeCore();
      const identityManager = makeIdentityManager(core);
      identityManager.unlockVault.mockRejectedValue(new Error('Vault is corrupted'));
      identityManager.quickUnlockVault.mockRejectedValue(new Error('Vault is corrupted'));
      const { ipcHandlers } = await enabled({ core, identityManager });

      const result = await ipcHandlers.get('quick-unlock:unlock')({});

      expect(result).toEqual({ success: false, error: 'Vault is corrupted' });
      expect(leaks(result)).toBe(false);
    });

    test('quick-unlock:export-mnemonic returns the phrase, not the password', async () => {
      const { ipcHandlers, identityManager } = await enabled();

      const result = await ipcHandlers.get('quick-unlock:export-mnemonic')({});

      expect(result).toEqual({ success: true, mnemonic: 'word '.repeat(23) + 'word' });
      expect(leaks(result)).toBe(false);
      if (through === 'core') {
        expect(identityManager.quickExportMnemonic).toHaveBeenCalledTimes(1);
        expect(identityManager.exportMnemonic).not.toHaveBeenCalled();
      } else {
        expect(identityManager.unlockVault).toHaveBeenCalledWith('s3cret-vault-pw');
        // The core verifies the unsealed password again before exporting.
        expect(identityManager.exportMnemonic).toHaveBeenCalledWith('s3cret-vault-pw');
      }
    });

    test('quick-unlock:export-private-key returns the key, not the password', async () => {
      const { ipcHandlers, identityManager } = await enabled();

      const result = await ipcHandlers.get('quick-unlock:export-private-key')({}, 3);

      expect(result).toEqual({ success: true, privateKey: '0x' + '11'.repeat(32) });
      expect(leaks(result)).toBe(false);
      if (through === 'core') {
        expect(identityManager.quickExportPrivateKeyForAccount).toHaveBeenCalledWith(3);
        expect(identityManager.exportPrivateKeyForAccount).not.toHaveBeenCalled();
      } else {
        expect(identityManager.exportPrivateKeyForAccount).toHaveBeenCalledWith(3, 's3cret-vault-pw');
      }
    });

    test('export-private-key refuses a device account before prompting Touch ID', async () => {
      const core = makeCore();
      const identityManager = makeIdentityManager(core);
      identityManager.assertPrivateKeyExportable.mockImplementation(() => {
        throw new Error('This account has no exportable private key');
      });
      const { ipcHandlers, systemPreferences } = await enabled({ core, identityManager });

      const result = await ipcHandlers.get('quick-unlock:export-private-key')({}, 1000000);

      expect(result).toEqual({ success: false, error: 'This account has no exportable private key' });
      expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
      expect(identityManager.exportPrivateKeyForAccount).not.toHaveBeenCalled();
      expect(identityManager.quickExportPrivateKeyForAccount).not.toHaveBeenCalled();
    });

    test('no quick-unlock IPC handler returns the password', async () => {
      const { ipcHandlers, identityManager } = await enabled();
      // enable takes the password as its input (the user just typed it);
      // disable would delete the credential the others need; Quick Setup
      // makes a vault.
      const channels = [...ipcHandlers.keys()].filter(
        (c) =>
          c !== 'quick-unlock:enable' &&
          c !== 'quick-unlock:disable' &&
          c !== 'quick-unlock:quick-setup'
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
      // The Touch ID paths really ran.
      if (through === 'core') expect(identityManager.quickUnlockVault).toHaveBeenCalled();
      else expect(identityManager.unlockVault).toHaveBeenCalledWith('s3cret-vault-pw');
    });
  });

  // freedom-core design 0013, PRF-2's row: "a profile with a v2 and one with
  // a legacy quick-unlock.dat unlocks once through it and then through the
  // core, with the file's bytes unchanged. Downgrade: the reference
  // quick-unlock.js still unlocks from it." (Against the real core and the
  // Keychain: quick-unlock.integration.test.js, on macOS CI.)
  describe.each([
    ['v2', 'enable'],
    ['legacy', 'raw'],
  ])('the migration of a %s quick-unlock.dat', (kind, how) => {
    async function fileOnly() {
      const userDataDir = tempUserData();
      const identityDir = path.join(userDataDir, 'identity');
      writeVault(identityDir);
      const loaded = loadQuickUnlock({
        activeProfile: makeProfile('default', userDataDir),
        userDataDir,
        core: makeCore({ password: 'vault-pw' }),
      });
      const credentialPath = path.join(identityDir, 'quick-unlock.dat');
      if (how === 'enable') {
        // Written by an older build: the reference module's own enable.
        await expect(loaded.reference().enableQuickUnlock('vault-pw')).resolves.toEqual({
          success: true,
        });
        expect(JSON.parse(fs.readFileSync(credentialPath, 'utf8')).version).toBe(2);
      } else {
        fs.writeFileSync(credentialPath, Buffer.from('encrypted:vault-pw'));
      }
      loaded.systemPreferences.promptTouchID.mockClear();
      loaded.core.backend.verifyPassword.mockClear();
      return { ...loaded, credentialPath, bytes: fs.readFileSync(credentialPath) };
    }

    test('unlocks once through the file, then through the core; the bytes stay', async () => {
      const ctx = await fileOnly();
      const { mod, core, identityManager, safeStorage, systemPreferences, credentialPath, bytes } =
        ctx;
      await expect(mod.isQuickUnlockEnabled()).resolves.toBe(true);

      // First: through the file, as before, then the enroll.
      await expect(mod.unlockWithTouchId()).resolves.toEqual({ success: true });
      expect(systemPreferences.promptTouchID).toHaveBeenCalledTimes(1);
      expect(safeStorage.decryptString).toHaveBeenCalledTimes(1);
      expect(identityManager.unlockVault).toHaveBeenCalledWith('vault-pw');
      expect(core.backend.quickUnlockEnroll).toHaveBeenCalledWith('vault-pw');
      expect(identityManager.unlockVault.mock.invocationCallOrder[0]).toBeLessThan(
        core.backend.quickUnlockEnroll.mock.invocationCallOrder[0]
      );
      expect(core.state.credential).toBe('vault-pw');
      expect(fs.readFileSync(credentialPath)).toEqual(bytes);

      // Then: through the core, behind Touch ID; the file isn't unsealed.
      core.state.unlocked = false;
      await expect(mod.unlockWithTouchId()).resolves.toEqual({ success: true });
      expect(systemPreferences.promptTouchID).toHaveBeenCalledTimes(2);
      expect(identityManager.quickUnlockVault).toHaveBeenCalledTimes(1);
      expect(systemPreferences.promptTouchID.mock.invocationCallOrder[1]).toBeLessThan(
        identityManager.quickUnlockVault.mock.invocationCallOrder[0]
      );
      expect(safeStorage.decryptString).toHaveBeenCalledTimes(1);
      expect(identityManager.unlockVault).toHaveBeenCalledTimes(1);
      expect(core.backend.quickUnlockEnroll).toHaveBeenCalledTimes(1);
      expect(core.state.unlocked).toBe(true);

      // And the exports too.
      await expect(mod.exportMnemonicWithTouchId()).resolves.toMatchObject({ success: true });
      expect(identityManager.quickExportMnemonic).toHaveBeenCalledTimes(1);
      expect(safeStorage.decryptString).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(credentialPath)).toEqual(bytes);
    });

    test('an export migrates too: once through the file, then through the core', async () => {
      const { mod, core, identityManager, safeStorage, credentialPath, bytes } = await fileOnly();

      await expect(mod.exportPrivateKeyWithTouchId(2)).resolves.toMatchObject({ success: true });
      expect(identityManager.exportPrivateKeyForAccount).toHaveBeenCalledWith(2, 'vault-pw');
      expect(core.backend.quickUnlockEnroll).toHaveBeenCalledWith('vault-pw');

      await expect(mod.exportPrivateKeyWithTouchId(2)).resolves.toMatchObject({ success: true });
      expect(identityManager.quickExportPrivateKeyForAccount).toHaveBeenCalledWith(2);
      expect(safeStorage.decryptString).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(credentialPath)).toEqual(bytes);
    });

    test('downgrade: the reference quick-unlock.js still unlocks from the file', async () => {
      const ctx = await fileOnly();
      const { mod, core, identityManager, credentialPath, bytes } = ctx;
      await mod.unlockWithTouchId();
      await mod.unlockWithTouchId();
      expect(core.state.credential).toBe('vault-pw');
      expect(fs.readFileSync(credentialPath)).toEqual(bytes);

      // An older build reads only quick-unlock.dat.
      identityManager.unlockVault.mockClear();
      expect(ctx.reference().isQuickUnlockEnabled()).toBe(true);
      await expect(ctx.reference().unlockWithTouchId()).resolves.toEqual({ success: true });
      expect(identityManager.unlockVault).toHaveBeenCalledWith('vault-pw');
      // (The reference upgrades a legacy file at its use, as it always did.)
      if (kind === 'v2') expect(fs.readFileSync(credentialPath)).toEqual(bytes);
    });

    test('an enroll that fails leaves the unlock done; the next Touch ID tries again', async () => {
      const { mod, core, identityManager, credentialPath, bytes } = await fileOnly();
      core.backend.quickUnlockEnroll.mockRejectedValueOnce(
        coreError('key_store_unavailable', 'The system keychain reported an error.', {
          reason: 'backend',
        })
      );

      await expect(mod.unlockWithTouchId()).resolves.toEqual({ success: true });
      expect(core.state.credential).toBeNull();
      await expect(mod.unlockWithTouchId()).resolves.toEqual({ success: true });
      expect(identityManager.unlockVault).toHaveBeenCalledTimes(2);
      expect(core.backend.quickUnlockEnroll).toHaveBeenCalledTimes(2);
      expect(core.state.credential).toBe('vault-pw');
      expect(fs.readFileSync(credentialPath)).toEqual(bytes);
    });
  });

  describe("the core's credential", () => {
    async function enrolled({ withFile = true } = {}) {
      const userDataDir = tempUserData();
      const identityDir = path.join(userDataDir, 'identity');
      writeVault(identityDir);
      const loaded = loadQuickUnlock({
        activeProfile: makeProfile('default', userDataDir),
        userDataDir,
        core: makeCore({ password: 'vault-pw' }),
      });
      await loaded.mod.enableQuickUnlock('vault-pw');
      const credentialPath = path.join(identityDir, 'quick-unlock.dat');
      if (!withFile) fs.rmSync(credentialPath);
      loaded.systemPreferences.promptTouchID.mockClear();
      loaded.core.backend.quickUnlockEnroll.mockClear();
      return { ...loaded, credentialPath };
    }

    test.each(['not_found', 'invalidated', 'entry_refused'])(
      'a dead credential (%s) goes through the file once, and the enroll replaces it',
      async (reason) => {
        const { mod, core, identityManager, safeStorage, credentialPath } = await enrolled();
        const bytes = fs.readFileSync(credentialPath);
        identityManager.quickUnlockVault.mockRejectedValueOnce(
          coreError('key_store_unavailable', 'gone', { reason })
        );
        jest.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(mod.unlockWithTouchId()).resolves.toEqual({ success: true });
        expect(safeStorage.decryptString).toHaveBeenCalledTimes(1);
        expect(identityManager.unlockVault).toHaveBeenCalledWith('vault-pw');
        expect(core.backend.quickUnlockEnroll).toHaveBeenCalledWith('vault-pw');
        expect(fs.readFileSync(credentialPath)).toEqual(bytes);
      }
    );

    test('any other refusal is the answer: no file, no enroll', async () => {
      const { mod, identityManager, safeStorage, core } = await enrolled();
      for (const refusal of [
        coreError('key_store_cancelled', 'The keychain request was cancelled.'),
        coreError('key_store_unavailable', 'Denied.', { reason: 'denied' }),
        coreError('key_store_unavailable', 'Timed out.', { reason: 'timeout' }),
        coreError('storage', 'Damaged.', { kind: 'malformed', file: 'secrets' }),
      ]) {
        identityManager.quickUnlockVault.mockRejectedValueOnce(refusal);
        await expect(mod.unlockWithTouchId()).resolves.toEqual({
          success: false,
          error: refusal.message,
        });
      }
      expect(safeStorage.decryptString).not.toHaveBeenCalled();
      expect(identityManager.unlockVault).not.toHaveBeenCalled();
      expect(core.backend.quickUnlockEnroll).not.toHaveBeenCalled();
    });

    test('a dead credential with no file left is the answer', async () => {
      const { mod, identityManager, core } = await enrolled({ withFile: false });
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      identityManager.quickUnlockVault.mockRejectedValueOnce(
        coreError('key_store_unavailable', "Touch ID unlock's keychain item is missing.", {
          reason: 'not_found',
        })
      );
      await expect(mod.unlockWithTouchId()).resolves.toEqual({
        success: false,
        error: "Touch ID unlock's keychain item is missing.",
      });
      expect(identityManager.unlockVault).not.toHaveBeenCalled();
      expect(core.backend.quickUnlockEnroll).not.toHaveBeenCalled();
    });

    test('Touch ID cancelled: the core is asked nothing', async () => {
      const { mod, identityManager, systemPreferences } = await enrolled();
      systemPreferences.promptTouchID.mockRejectedValueOnce(new Error('User cancelled'));
      await expect(mod.unlockWithTouchId()).resolves.toEqual({
        success: false,
        error: 'User cancelled',
      });
      expect(identityManager.quickUnlockVault).not.toHaveBeenCalled();
    });

    test('status: the core, the file, either, or neither', async () => {
      const { mod, core, credentialPath } = await enrolled({ withFile: false });
      await expect(mod.isQuickUnlockEnabled()).resolves.toBe(true);
      core.state.credential = null;
      await expect(mod.isQuickUnlockEnabled()).resolves.toBe(false);
      fs.writeFileSync(credentialPath, Buffer.from('encrypted:vault-pw'));
      await expect(mod.isQuickUnlockEnabled()).resolves.toBe(true);
      // The core unreachable: the file decides.
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      core.backend.quickUnlockStatus.mockRejectedValue(coreError('core_unavailable', 'down'));
      await expect(mod.isQuickUnlockEnabled()).resolves.toBe(true);
      fs.rmSync(credentialPath);
      await expect(mod.isQuickUnlockEnabled()).resolves.toBe(false);
    });

    test('Touch ID unavailable: nothing is asked', async () => {
      const { mod, identityManager, systemPreferences } = await enrolled();
      systemPreferences.canPromptTouchID.mockReturnValue(false);
      await expect(mod.unlockWithTouchId()).resolves.toEqual({
        success: false,
        error: 'Touch ID not available',
      });
      expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
      expect(identityManager.quickUnlockVault).not.toHaveBeenCalled();
    });
  });

  describe('disable removes both credentials', () => {
    async function both() {
      const userDataDir = tempUserData();
      const identityDir = path.join(userDataDir, 'identity');
      writeVault(identityDir);
      const loaded = loadQuickUnlock({
        activeProfile: makeProfile('default', userDataDir),
        userDataDir,
        core: makeCore({ password: 'vault-pw' }),
      });
      await loaded.mod.enableQuickUnlock('vault-pw');
      const credentialPath = path.join(identityDir, 'quick-unlock.dat');
      expect(fs.existsSync(credentialPath)).toBe(true);
      expect(loaded.core.state.credential).toBe('vault-pw');
      return { ...loaded, credentialPath };
    }

    test('the file, then the core', async () => {
      const { mod, core, credentialPath } = await both();
      await expect(mod.disableQuickUnlock()).resolves.toEqual({ success: true });
      expect(fs.existsSync(credentialPath)).toBe(false);
      expect(core.state.credential).toBeNull();
      await expect(mod.isQuickUnlockEnabled()).resolves.toBe(false);
      // Again: nothing left, still success.
      await expect(mod.disableQuickUnlock()).resolves.toEqual({ success: true });
    });

    test("the core refusing: the error, the file gone, and the core's still on", async () => {
      const { mod, core, credentialPath } = await both();
      core.backend.quickUnlockDisable.mockRejectedValueOnce(
        coreError('storage', 'Damaged.', { kind: 'malformed', file: 'secrets' })
      );
      await expect(mod.disableQuickUnlock()).resolves.toEqual({ success: false, error: 'Damaged.' });
      expect(fs.existsSync(credentialPath)).toBe(false);
      await expect(mod.isQuickUnlockEnabled()).resolves.toBe(true);
      // Tried again, it finishes.
      await expect(mod.disableQuickUnlock()).resolves.toEqual({ success: true });
      expect(core.state.credential).toBeNull();
    });

    test('the file not removed: fixed words, no path; the core is left alone', async () => {
      const { mod, core, credentialPath } = await both();
      // A directory at the credential's name can't be removed as a file.
      fs.rmSync(credentialPath);
      fs.mkdirSync(credentialPath);
      fs.writeFileSync(path.join(credentialPath, 'x'), 'x');
      const result = await mod.disableQuickUnlock();
      expect(result).toEqual({ success: false, error: mod.FILE_NOT_REMOVED });
      expect(core.backend.quickUnlockDisable).not.toHaveBeenCalled();
      expect(core.state.credential).toBe('vault-pw');
      const logged = console.error.mock.calls.flat().map(String).join('\n');
      expect(logged).toContain('quick-unlock.dat not removed');
      expect(logged).not.toContain(path.dirname(credentialPath));
    });
  });

  describe('a password change keeps quick unlock', () => {
    async function profile({ inCore, withFile }) {
      const userDataDir = tempUserData();
      const identityDir = path.join(userDataDir, 'identity');
      writeVault(identityDir);
      const loaded = loadQuickUnlock({
        activeProfile: makeProfile('default', userDataDir),
        userDataDir,
        core: makeCore({ password: 'old-pw' }),
      });
      const credentialPath = path.join(identityDir, 'quick-unlock.dat');
      if (withFile) await loaded.reference().enableQuickUnlock('old-pw');
      if (inCore) loaded.core.state.credential = 'old-pw';
      loaded.core.backend.quickUnlockEnroll.mockClear();
      return { ...loaded, credentialPath, bytes: withFile ? fs.readFileSync(credentialPath) : null };
    }

    test("enrolled: the core's re-wrap; main enrolls nothing", async () => {
      const { mod, core } = await profile({ inCore: true, withFile: true });
      await mod.changePasswordKeepingQuickUnlock('old-pw', 'new-pw');
      expect(core.backend.changePassword).toHaveBeenCalledWith('old-pw', 'new-pw');
      expect(core.backend.quickUnlockEnroll).not.toHaveBeenCalled();
      expect(core.state.credential).toBe('new-pw');
    });

    test('quick-unlock.dat alone: the current password is enrolled first, and the change re-wraps it; the file stays', async () => {
      const { mod, core, credentialPath, bytes } = await profile({ inCore: false, withFile: true });
      await mod.changePasswordKeepingQuickUnlock('old-pw', 'new-pw');
      expect(core.backend.quickUnlockEnroll).toHaveBeenCalledTimes(1);
      expect(core.backend.quickUnlockEnroll).toHaveBeenCalledWith('old-pw');
      expect(core.backend.quickUnlockEnroll.mock.invocationCallOrder[0]).toBeLessThan(
        core.backend.changePassword.mock.invocationCallOrder[0]
      );
      expect(core.state.password).toBe('new-pw');
      expect(core.state.credential).toBe('new-pw');
      expect(fs.readFileSync(credentialPath)).toEqual(bytes);
      await expect(mod.isQuickUnlockEnabled()).resolves.toBe(true);
    });

    test('quick-unlock.dat alone, the enroll refused: the change is refused too, nothing changed', async () => {
      const { mod, core, credentialPath, bytes } = await profile({ inCore: false, withFile: true });
      core.backend.quickUnlockEnroll.mockRejectedValueOnce(
        coreError('key_store_unavailable', 'The keychain did not answer in time. Try again.', {
          reason: 'timeout',
        })
      );
      const refused = mod.changePasswordKeepingQuickUnlock('old-pw', 'new-pw');
      await expect(refused).rejects.toMatchObject({
        code: 'key_store_unavailable',
        data: { reason: 'timeout' },
        message:
          'The password was not changed: Touch ID unlock could not be kept. The keychain did not answer in time. Try again.',
      });
      expect(core.backend.changePassword).not.toHaveBeenCalled();
      expect(core.state.password).toBe('old-pw');
      expect(fs.readFileSync(credentialPath)).toEqual(bytes);
      // Quick unlock is still on, through the file, for the vault as it was.
      await expect(mod.isQuickUnlockEnabled()).resolves.toBe(true);
      // Tried again, the change keeps quick unlock.
      await mod.changePasswordKeepingQuickUnlock('old-pw', 'new-pw');
      expect(core.state.credential).toBe('new-pw');
    });

    test('no quick unlock, a wrong password, or no key store: nothing enrolled', async () => {
      const none = await profile({ inCore: false, withFile: false });
      await none.mod.changePasswordKeepingQuickUnlock('old-pw', 'new-pw');
      expect(none.core.backend.quickUnlockEnroll).not.toHaveBeenCalled();

      // A wrong current password: the enroll refuses it, in the change's own words.
      const refused = await profile({ inCore: false, withFile: true });
      await expect(refused.mod.changePasswordKeepingQuickUnlock('wrong', 'new-pw')).rejects.toThrow(
        /^Incorrect password$/
      );
      expect(refused.core.backend.changePassword).not.toHaveBeenCalled();
      expect(refused.core.state.credential).toBeNull();

      const linux = await profile({ inCore: false, withFile: true });
      setPlatform('linux');
      await linux.mod.changePasswordKeepingQuickUnlock('old-pw', 'new-pw');
      expect(linux.core.backend.quickUnlockEnroll).not.toHaveBeenCalled();
    });
  });

  // freedom-core design 0013, PRF-2b: Touch ID first, then the vault with
  // quick unlock's credential (`quick_unlock: true`); quick-unlock.dat still
  // written. Its failure path deletes nothing the core committed.
  describe('Quick Setup', () => {
    function setUp() {
      const userDataDir = tempUserData();
      const identityDir = path.join(userDataDir, 'identity');
      fs.mkdirSync(identityDir, { recursive: true });
      const core = makeCore();
      const identityManager = makeIdentityManager(core);
      // The core writes the vault (and its credential) in the import.
      identityManager.importExistingMnemonic.mockImplementation(async (pw) => {
        writeVault(identityDir, 'quick-setup');
        core.state.password = pw;
        core.state.credential = pw;
      });
      const loaded = loadQuickUnlock({
        activeProfile: makeProfile('default', userDataDir),
        userDataDir,
        core,
        identityManager,
      });
      loaded.mod.registerQuickUnlockIpc();
      return { ...loaded, identityDir, credentialPath: path.join(identityDir, 'quick-unlock.dat') };
    }

    test('Touch ID, then the vault with the credential, then quick-unlock.dat', async () => {
      const { ipcHandlers, identityManager, systemPreferences, safeStorage, core, credentialPath } =
        setUp();

      const result = await ipcHandlers.get('quick-unlock:quick-setup')({}, 'abandon about');

      expect(result).toEqual({ success: true });
      expect(systemPreferences.promptTouchID).toHaveBeenCalledTimes(1);
      expect(systemPreferences.promptTouchID.mock.invocationCallOrder[0]).toBeLessThan(
        identityManager.importExistingMnemonic.mock.invocationCallOrder[0]
      );
      const [password, mnemonic, userKnowsPassword, options] =
        identityManager.importExistingMnemonic.mock.calls[0];
      expect(password).toMatch(/^[0-9a-f]{64}$/);
      expect(mnemonic).toBe('abandon about');
      expect(userKnowsPassword).toBe(false);
      expect(options).toEqual({ quickUnlock: true });
      // The file holds the same password, bound to the new vault.
      const payload = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
      expect(payload.version).toBe(2);
      expect(safeStorage.decryptString(Buffer.from(payload.encrypted, 'base64'))).toBe(password);
      expect(core.state.credential).toBe(password);
      expect(JSON.stringify(result)).not.toContain(password);
      // No separate enroll: the credential came with the vault.
      expect(core.backend.quickUnlockEnroll).not.toHaveBeenCalled();
      expect(identityManager.deleteVaultData).not.toHaveBeenCalled();
    });

    test('Touch ID cancelled, or missing: no vault is made', async () => {
      const { mod, identityManager, systemPreferences, safeStorage, credentialPath } = setUp();
      systemPreferences.promptTouchID.mockRejectedValueOnce(new Error('User cancelled'));
      await expect(mod.quickSetup('abandon about')).resolves.toEqual({
        success: false,
        error: 'User cancelled',
      });
      systemPreferences.canPromptTouchID.mockReturnValueOnce(false);
      await expect(mod.quickSetup('abandon about')).resolves.toEqual({
        success: false,
        error: 'Touch ID not available',
      });
      safeStorage.isEncryptionAvailable.mockReturnValueOnce(false);
      await expect(mod.quickSetup('abandon about')).resolves.toEqual({
        success: false,
        error: 'Secure storage not available',
      });
      expect(systemPreferences.promptTouchID).toHaveBeenCalledTimes(1);
      expect(identityManager.importExistingMnemonic).not.toHaveBeenCalled();
      expect(fs.existsSync(credentialPath)).toBe(false);
    });

    test('the core refusing: its message, nothing written, nothing deleted', async () => {
      const { mod, identityManager, identityDir, credentialPath } = setUp();
      identityManager.importExistingMnemonic.mockRejectedValueOnce(
        coreError('key_store_unavailable', 'The system keychain reported an error.', {
          reason: 'backend',
        })
      );
      await expect(mod.quickSetup('abandon about')).resolves.toEqual({
        success: false,
        error: 'The system keychain reported an error.',
      });
      expect(fs.existsSync(credentialPath)).toBe(false);
      expect(fs.existsSync(path.join(identityDir, 'identity-vault.json'))).toBe(false);
      expect(identityManager.deleteVaultData).not.toHaveBeenCalled();
    });

    test('quick-unlock.dat not sealed after the commit: the setup stands, nothing deleted, the password not kept', async () => {
      jest.useFakeTimers();
      try {
        const { mod, identityManager, safeStorage, core, identityDir, credentialPath } = setUp();
        const vault = () => fs.readFileSync(path.join(identityDir, 'identity-vault.json'));
        safeStorage.encryptString.mockImplementation(() => {
          throw new Error('Encryption is not available');
        });

        await expect(mod.quickSetup('abandon about')).resolves.toEqual({ success: true });
        const committed = vault();
        expect(core.state.credential).not.toBeNull();
        expect(fs.existsSync(credentialPath)).toBe(false);
        expect(identityManager.deleteVaultData).not.toHaveBeenCalled();
        expect(mod._internal.pendingSetup()).toBeNull();

        // Not retried: the password was dropped; the core's credential works.
        await jest.advanceTimersByTimeAsync(10 * 60_000);
        expect(safeStorage.encryptString).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(credentialPath)).toBe(false);
        expect(vault()).toEqual(committed);
        await expect(mod.isQuickUnlockEnabled()).resolves.toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    test('quick-unlock.dat not written after the commit: the sealed bytes are retried, then written', async () => {
      jest.useFakeTimers();
      try {
        const { mod, safeStorage, core, credentialPath } = setUp();
        fs.mkdirSync(credentialPath);
        fs.writeFileSync(path.join(credentialPath, 'x'), 'x');
        await expect(mod.quickSetup('abandon about')).resolves.toEqual({ success: true });
        expect(mod._internal.pendingSetup()).not.toBeNull();
        fs.rmSync(credentialPath, { recursive: true });
        await jest.advanceTimersByTimeAsync(30_000);
        const payload = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
        expect(safeStorage.decryptString(Buffer.from(payload.encrypted, 'base64'))).toBe(
          core.state.credential
        );
        expect(safeStorage.encryptString).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    test('a failure after the core committed (the metadata) deletes nothing', async () => {
      const { mod, identityManager, identityDir, core } = setUp();
      identityManager.importExistingMnemonic.mockImplementationOnce(async (pw) => {
        writeVault(identityDir, 'quick-setup');
        core.state.password = pw;
        core.state.credential = pw;
        throw new Error('ENOSPC: no space left on device');
      });
      await expect(mod.quickSetup('abandon about')).resolves.toEqual({
        success: false,
        error: 'ENOSPC: no space left on device',
      });
      expect(fs.existsSync(path.join(identityDir, 'identity-vault.json'))).toBe(true);
      expect(core.state.credential).not.toBeNull();
      expect(identityManager.deleteVaultData).not.toHaveBeenCalled();
    });

    // The renderer's half: its old cleanup deleted the vault when enabling
    // Touch ID failed after the vault was written.
    test('onboarding never deletes the vault Quick Setup made', () => {
      const source = fs.readFileSync(
        path.join(__dirname, '..', 'renderer', 'lib', 'onboarding.js'),
        'utf8'
      );
      const body = source.slice(
        source.indexOf('async function performQuickSetup('),
        source.indexOf('async function restartNodes(')
      );
      expect(body).toContain('window.quickUnlock.quickSetup(currentMnemonic)');
      expect(body).not.toMatch(/deleteVault|importMnemonic|quickUnlock\.enable/);
      expect(source).not.toMatch(/deleteVault/);
    });
  });
});
