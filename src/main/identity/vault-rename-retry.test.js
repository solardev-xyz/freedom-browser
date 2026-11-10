/**
 * R1-M2: on Windows, renaming the temp file over a vault that antivirus or
 * the indexer holds open fails for a moment with EPERM/EACCES/EBUSY. The
 * write retries those, re-checking the vault before each attempt; anything
 * else, or the same codes on POSIX, fails at once with the old vault kept.
 *
 * The platform is faked per test (the module reads it at load), and the
 * password hashing is stubbed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('@metamask/browser-passworder', () => ({
  encrypt: async (password, value) => JSON.stringify({ password, value }),
  decrypt: async (password, text) => {
    const stored = JSON.parse(text);
    if (stored.password !== password) throw new Error('Incorrect password');
    return stored.value;
  },
}));

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function loadVaultOn(platform) {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: platform });
  let vault;
  jest.isolateModules(() => {
    vault = require('./vault');
  });
  Object.defineProperty(process, 'platform', realPlatform);
  return vault;
}

function failRenames(codes) {
  const realRename = fs.renameSync;
  const queue = [...codes];
  return jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    const code = queue.shift();
    if (code) throw Object.assign(new Error(`${code}: rename`), { code });
    return realRename(from, to);
  });
}

async function opensWith(vault, dir, password) {
  vault.lockVault();
  await vault.unlockVault(dir, password, 0);
  const mnemonic = vault.getMnemonic();
  vault.lockVault();
  return mnemonic;
}

describe('renaming over a held vault (R1-M2)', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-rename-'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Windows: transient EPERM/EACCES/EBUSY are retried until the rename lands', async () => {
    const vault = loadVaultOn('win32');
    await vault.importVault(dir, 'oldpassword', MNEMONIC);
    const retries = [];
    vault._setVaultWriteObserver((step, detail) => {
      if (step === 'rename-retry') retries.push(detail);
    });
    const rename = failRenames(['EPERM', 'EBUSY', 'EACCES']);

    await vault.changePassword(dir, 'oldpassword', 'newpassword');
    expect(retries).toEqual(['EPERM', 'EBUSY', 'EACCES']);
    expect(rename).toHaveBeenCalledTimes(4);
    await expect(opensWith(vault, dir, 'newpassword')).resolves.toBe(MNEMONIC);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('Windows: a hold that never clears gives up, keeps the old vault and the temp is removed', async () => {
    const vault = loadVaultOn('win32');
    await vault.importVault(dir, 'oldpassword', MNEMONIC);
    failRenames(Array(20).fill('EPERM'));

    await expect(vault.changePassword(dir, 'oldpassword', 'newpassword')).rejects.toMatchObject({
      code: 'EPERM',
    });
    jest.restoreAllMocks();
    await expect(opensWith(vault, dir, 'oldpassword')).resolves.toBe(MNEMONIC);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  }, 15000);

  test('Windows: a vault replaced during the retry wait is not overwritten', async () => {
    const vault = loadVaultOn('win32');
    await vault.importVault(dir, 'oldpassword', MNEMONIC);
    const vaultPath = vault.getVaultPath(dir);
    const foreign = '{"version":1,"encrypted":"{}"}';
    vault._setVaultWriteObserver((step) => {
      if (step === 'rename-retry') fs.writeFileSync(vaultPath, foreign);
    });
    failRenames(['EBUSY']);

    await expect(vault.changePassword(dir, 'oldpassword', 'newpassword')).rejects.toThrow(
      'The vault changed while it was being saved'
    );
    expect(fs.readFileSync(vaultPath, 'utf8')).toBe(foreign);
  });

  test('Windows: other rename errors are not retried', async () => {
    const vault = loadVaultOn('win32');
    await vault.importVault(dir, 'oldpassword', MNEMONIC);
    const rename = failRenames(['ENOSPC']);
    await expect(vault.changePassword(dir, 'oldpassword', 'newpassword')).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    expect(rename).toHaveBeenCalledTimes(1);
  });

  (process.platform === 'win32' ? test.skip : test)(
    'POSIX: EPERM is permanent and fails at once',
    async () => {
      const vault = loadVaultOn(process.platform);
      await vault.importVault(dir, 'oldpassword', MNEMONIC);
      const rename = failRenames(['EPERM']);
      await expect(vault.changePassword(dir, 'oldpassword', 'newpassword')).rejects.toMatchObject({
        code: 'EPERM',
      });
      expect(rename).toHaveBeenCalledTimes(1);
      jest.restoreAllMocks();
      await expect(opensWith(vault, dir, 'oldpassword')).resolves.toBe(MNEMONIC);
    }
  );
});
