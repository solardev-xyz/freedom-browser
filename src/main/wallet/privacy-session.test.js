// Exercise the real vault and manager lock paths; stub only disk and crypto.
jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(() => JSON.stringify({ version: 1, encrypted: 'fixture' })),
}));
jest.mock('@metamask/browser-passworder', () => ({
  decrypt: jest.fn(async () => ({ mnemonic: 'valid fixture' })),
}));
jest.mock('../identity/derivation', () => ({ isValidMnemonic: (value) => value === 'valid fixture' }));
jest.mock('../profile-resolver', () => ({ getActiveProfile: jest.fn() }));
jest.mock('electron', () => ({ ipcMain: {} }));
jest.mock('../profile-paths', () => ({}));
jest.mock('../identity', () => require('../identity/vault'));

const { getActiveProfile } = require('../profile-resolver');
const vault = require('../identity/vault');
const manager = require('../identity-manager');
const { decrypt } = require('@metamask/browser-passworder');
const { openPrivacySession, shutdownPrivacySessions } = require('./privacy-session');
const { getPrivacyContext } = require('../networks/privacy-context');
const subject = { kind: 'public-address', principal: `0x${'1'.repeat(40)}`, chainId: 1, role: 'rpc' };

describe('wallet privacy lifecycle', () => {
  beforeEach(() => {
    vault.lockVault();
    getActiveProfile.mockReturnValue({ id: 'one', userDataDir: '/profiles/one' });
    decrypt.mockResolvedValue({ mnemonic: 'valid fixture' });
  });
  afterEach(() => {
    vault.lockVault();
    jest.useRealTimers();
  });

  test('requires an unlocked vault and reuses only the current profile/unlock session', async () => {
    expect(() => openPrivacySession()).toThrow('Vault is locked');
    await vault.unlockVault('/fixture', 'password', 0);
    const old = openPrivacySession();
    expect(openPrivacySession()).toBe(old);
    const handle = old.getContext(subject);
    await manager.lockVault();
    expect(old.signal.aborted).toBe(true);
    await vault.unlockVault('/fixture', 'password', 0);
    expect(openPrivacySession()).not.toBe(old);
    expect(() => getPrivacyContext(handle)).toThrow('Privacy session ended');
  });

  test('automatic vault lock cancels running work without an IPC or manager callback', async () => {
    jest.useFakeTimers();
    await vault.unlockVault('/fixture', 'password', 10);
    const session = openPrivacySession();
    const task = jest.fn(() => new Promise(() => {}));
    const work = session.run(session.getContext(subject), task);
    await Promise.resolve();
    const rejected = expect(work).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
    jest.advanceTimersByTime(10);
    await rejected;
    expect(vault.isUnlocked()).toBe(false);
    expect(session.signal.aborted).toBe(true);
  });

  test('changing the active profile revokes the previous scope before opening another', async () => {
    await vault.unlockVault('/fixture', 'password', 0);
    const previous = openPrivacySession();
    const handle = previous.getContext(subject);
    getActiveProfile.mockReturnValue({ id: 'two', userDataDir: '/profiles/two' });
    expect(() => previous.commit(handle, () => {})).toThrow('Privacy session ended');
    expect(openPrivacySession()).not.toBe(previous);
    expect(previous.signal.aborted).toBe(true);
  });

  test('a lock during async decryption prevents a late unlock from reviving the vault', async () => {
    let finish;
    decrypt.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const unlocking = vault.unlockVault('/fixture', 'password', 0);
    vault.lockVault();
    finish({ mnemonic: 'valid fixture' });
    await expect(unlocking).rejects.toThrow('cancelled');
    expect(vault.isUnlocked()).toBe(false);
    expect(vault.getSessionSignal().aborted).toBe(true);
  });

  test('replacement unlock revokes old contexts and cancels an earlier auto-lock timer', async () => {
    jest.useFakeTimers();
    await vault.unlockVault('/fixture', 'password', 10);
    const previous = openPrivacySession();
    await vault.unlockVault('/fixture', 'password', 0);
    expect(previous.signal.aborted).toBe(true);
    const current = openPrivacySession();
    jest.advanceTimersByTime(20);
    expect(vault.isUnlocked()).toBe(true);
    expect(current.signal.aborted).toBe(false);
  });

  // Shutdown is terminal for the process; keep this last.
  test('runtime shutdown revokes queued work and prevents any session from reopening', async () => {
    await vault.unlockVault('/fixture', 'password', 0);
    const session = openPrivacySession();
    const task = jest.fn();
    const work = session.run(session.getContext(subject), task);
    const rejected = expect(work).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
    shutdownPrivacySessions();
    await rejected;
    expect(task).not.toHaveBeenCalled();
    expect(() => openPrivacySession()).toThrow('Privacy runtime stopped');
  });
});
