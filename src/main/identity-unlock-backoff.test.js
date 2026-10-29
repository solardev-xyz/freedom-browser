/**
 * K-4: identity:unlock (and every other vault password check) backs off
 * after repeated wrong passwords. Real vault and identity-manager IPC; the
 * password hashing is stubbed and counted.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMainModule } = require('../../test/helpers/main-process-test-utils');

const mockDecrypts = { count: 0 };
jest.mock('@metamask/browser-passworder', () => ({
  encrypt: async (password, value) => JSON.stringify({ password, value }),
  decrypt: async (password, text) => {
    mockDecrypts.count += 1;
    const stored = JSON.parse(text);
    if (stored.password !== password) throw new Error('Incorrect password');
    return stored.value;
  },
}));

const IPC = require('../shared/ipc-channels');

describe('vault password back-off over IPC (K-4)', () => {
  let tempRoot;
  let previousIdentityData;
  let now;
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-unlock-backoff-'));
    previousIdentityData = process.env.FREEDOM_IDENTITY_DATA;
    process.env.FREEDOM_IDENTITY_DATA = path.join(tempRoot, 'identity');
    fs.mkdirSync(path.join(tempRoot, 'user-data'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockDecrypts.count = 0;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (previousIdentityData === undefined) delete process.env.FREEDOM_IDENTITY_DATA;
    else process.env.FREEDOM_IDENTITY_DATA = previousIdentityData;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('wrong passwords back off unlock and export alike; the right one resets', async () => {
    const { mod, ipcMain } = loadMainModule(require.resolve('./identity-manager'), {
      userDataDir: path.join(tempRoot, 'user-data'),
    });
    require('./identity/password-attempts')._resetPasswordAttempts();
    mod.registerIdentityIpc();
    await mod.createNewVault('right-password');
    await mod.lockVault();
    mockDecrypts.count = 0;

    for (let i = 0; i < 3; i += 1) {
      await expect(ipcMain.invoke(IPC.IDENTITY_UNLOCK, 'wrong-password')).resolves.toEqual({
        success: false,
        error: 'Incorrect password',
      });
    }
    expect(mockDecrypts.count).toBe(3);

    // Locked out for 1 s: no check runs, through any handler.
    const locked = await ipcMain.invoke(IPC.IDENTITY_UNLOCK, 'right-password');
    expect(locked).toMatchObject({ success: false });
    expect(locked.error).toMatch(/Too many wrong passwords/);
    const exported = await ipcMain.invoke(IPC.IDENTITY_EXPORT_MNEMONIC, 'right-password');
    expect(exported.error).toMatch(/Too many wrong passwords/);
    expect(mockDecrypts.count).toBe(3);

    now += 1000;
    await expect(ipcMain.invoke(IPC.IDENTITY_UNLOCK, 'right-password')).resolves.toEqual({
      success: true,
    });
    // Reset: wrong passwords are free again.
    await expect(ipcMain.invoke(IPC.IDENTITY_EXPORT_MNEMONIC, 'wrong-password')).resolves.toEqual({
      success: false,
      error: 'Incorrect password',
    });
  });
});
