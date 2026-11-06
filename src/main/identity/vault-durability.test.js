/**
 * K-2 review: a process killed in the middle of a vault write leaves a
 * complete vault: the old one when it dies before the rename, the new one
 * when it dies right after. Real password hashing, in a child process that
 * exits at the chosen step.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const vault = require('./vault');

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const CHILD = `
const vault = require(process.env.VAULT_MODULE);
vault._setVaultWriteObserver((step) => {
  if (step === process.env.CRASH_AT) process.exit(42);
});
vault.changePassword(process.env.VAULT_DIR, 'oldpassword', 'newpassword').then(
  () => process.exit(0),
  (err) => { console.error(err); process.exit(1); }
);
`;

function crashDuringChange(dir, step) {
  return spawnSync(process.execPath, ['-e', CHILD], {
    env: {
      ...process.env,
      VAULT_MODULE: require.resolve('./vault'),
      VAULT_DIR: dir,
      CRASH_AT: step,
    },
    encoding: 'utf8',
    timeout: 60000,
  });
}

async function opensWith(dir, password) {
  vault.lockVault();
  await vault.unlockVault(dir, password, 0);
  const mnemonic = vault.getMnemonic();
  vault.lockVault();
  return mnemonic;
}

describe('vault writes survive a crash (K-2 review)', () => {
  let dir;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-crash-'));
    await vault.importVault(dir, 'oldpassword', MNEMONIC);
  }, 30000);
  afterEach(() => {
    vault.lockVault();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('killed after the temp file is synced, before the rename: the old vault stands', async () => {
    const before = fs.readFileSync(vault.getVaultPath(dir));
    const child = crashDuringChange(dir, 'file-synced');
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 42, stderr: '' });

    expect(fs.readFileSync(vault.getVaultPath(dir)).equals(before)).toBe(true);
    await expect(opensWith(dir, 'oldpassword')).resolves.toBe(MNEMONIC);
  }, 60000);

  test('killed right after the rename: the new vault is complete', async () => {
    const child = crashDuringChange(dir, 'renamed');
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 42, stderr: '' });

    await expect(opensWith(dir, 'newpassword')).resolves.toBe(MNEMONIC);
    await expect(opensWith(dir, 'oldpassword')).rejects.toThrow('Incorrect password');
  }, 60000);

  test('a write that runs to the end reports every step', async () => {
    const child = crashDuringChange(dir, 'never');
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
    await expect(opensWith(dir, 'newpassword')).resolves.toBe(MNEMONIC);
  }, 60000);
});
