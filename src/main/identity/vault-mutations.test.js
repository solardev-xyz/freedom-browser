/**
 * K-2 review: vault mutations run one at a time per data directory, a write
 * never replaces a vault that is not the one it started from, a vault that
 * does not parse is still narrowed to 0600, and the write keeps its file
 * fsync, rename, directory fsync order.
 *
 * The password hashing is stubbed so steps can be held to order them.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each encrypt waits for the next queued hold, if any.
const mockEncryptHolds = [];
jest.mock('@metamask/browser-passworder', () => ({
  encrypt: async (password, value) => {
    const hold = mockEncryptHolds.shift();
    if (hold) await hold;
    return JSON.stringify({ password, value });
  },
  decrypt: async (password, text) => {
    const stored = JSON.parse(text);
    if (stored.password !== password) throw new Error('Incorrect password');
    return stored.value;
  },
}));

const vault = require('./vault');

const MNEMONIC_A =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MNEMONIC_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function opensWith(dir, password) {
  vault.lockVault();
  await vault.unlockVault(dir, password, 0);
  const mnemonic = vault.getMnemonic();
  vault.lockVault();
  return mnemonic;
}

describe('vault mutations (K-2 review)', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mutations-'));
    mockEncryptHolds.length = 0;
    vault.lockVault();
  });
  afterEach(() => {
    vault._setVaultWriteObserver(null);
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a held password change cannot overwrite a vault deleted and re-imported meanwhile', async () => {
    await vault.importVault(dir, 'oldpassword', MNEMONIC_A);

    const held = deferred();
    mockEncryptHolds.push(held.promise);
    const changing = vault.changePassword(dir, 'oldpassword', 'changedpassword');
    await settle();
    // Queued behind the change, not interleaved with it.
    const deleting = vault.deleteVault(dir, 'oldpassword');
    const importing = vault.importVault(dir, 'replacementpassword', MNEMONIC_B);
    deleting.catch(() => {});
    importing.catch(() => {});
    await settle();
    expect(fs.existsSync(vault.getVaultPath(dir))).toBe(true);

    held.resolve();
    await changing;
    // The delete then checks the password the vault has now, and the import
    // finds a vault: neither silently loses a recovery phrase.
    await expect(deleting).rejects.toThrow('Incorrect password');
    await expect(importing).rejects.toThrow('Vault already exists');
    await expect(opensWith(dir, 'changedpassword')).resolves.toBe(MNEMONIC_A);
  });

  test('deleted and re-imported while a change waits: the change never lands on top', async () => {
    await vault.importVault(dir, 'oldpassword', MNEMONIC_A);
    const deleting = vault.deleteVault(dir, 'oldpassword');
    const importing = vault.importVault(dir, 'replacementpassword', MNEMONIC_B);
    const changing = vault.changePassword(dir, 'oldpassword', 'changedpassword');
    changing.catch(() => {});

    await deleting;
    await importing;
    await expect(changing).rejects.toThrow('Incorrect password');
    await expect(opensWith(dir, 'replacementpassword')).resolves.toBe(MNEMONIC_B);
  });

  test('two concurrent creates hand out one recovery phrase, the one on disk', async () => {
    const results = await Promise.allSettled([
      vault.createVault(dir, 'password123'),
      vault.createVault(dir, 'password123'),
    ]);
    const created = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason.message).toMatch('Vault already exists');
    await expect(opensWith(dir, 'password123')).resolves.toBe(created[0].value);
  });

  test('a vault replaced from outside mid-write is not overwritten', async () => {
    await vault.importVault(dir, 'oldpassword', MNEMONIC_A);
    const vaultPath = vault.getVaultPath(dir);
    const foreign = JSON.stringify({ version: 1, encrypted: JSON.stringify({ password: 'other', value: { mnemonic: MNEMONIC_B } }) });
    vault._setVaultWriteObserver((step) => {
      if (step === 'file-synced') fs.writeFileSync(vaultPath, foreign);
    });

    await expect(vault.changePassword(dir, 'oldpassword', 'changedpassword')).rejects.toThrow(
      'The vault changed while it was being saved'
    );
    expect(fs.readFileSync(vaultPath, 'utf8')).toBe(foreign);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  (process.platform === 'win32' ? test.skip : test)(
    'a world-readable vault that does not parse is still narrowed',
    async () => {
      await vault.importVault(dir, 'oldpassword', MNEMONIC_A);
      const vaultPath = vault.getVaultPath(dir);
      fs.appendFileSync(vaultPath, 'not-json');
      fs.chmodSync(vaultPath, 0o644);

      await expect(vault.unlockVault(dir, 'oldpassword', 0)).rejects.toThrow();
      expect(fs.statSync(vaultPath).mode & 0o777).toBe(0o600);
    }
  );

  (process.platform === 'win32' ? test.skip : test)(
    'the vault is never read through a link planted at its name',
    async () => {
      const elsewhere = path.join(dir, 'elsewhere.json');
      fs.writeFileSync(elsewhere, '{}');
      fs.symlinkSync(elsewhere, vault.getVaultPath(dir));
      await expect(vault.unlockVault(dir, 'oldpassword', 0)).rejects.toMatchObject({
        code: 'ELOOP',
      });
    }
  );

  (process.platform === 'win32' ? test.skip : test)(
    'the temp file is fsynced, then renamed into place, then the directory fsynced',
    async () => {
      const opened = new Map();
      const steps = [];
      const realOpen = fs.openSync;
      jest.spyOn(fs, 'openSync').mockImplementation((file, ...rest) => {
        const fd = realOpen(file, ...rest);
        opened.set(fd, String(file));
        return fd;
      });
      const realFsync = fs.fsyncSync;
      jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        const target = opened.get(fd) || '';
        steps.push(target === dir ? 'fsync directory' : target.endsWith('.tmp') ? 'fsync temp file' : `fsync ${target}`);
        return realFsync(fd);
      });
      const realRename = fs.renameSync;
      jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        steps.push(to === vault.getVaultPath(dir) ? 'rename into place' : `rename ${to}`);
        return realRename(from, to);
      });

      await vault.importVault(dir, 'oldpassword', MNEMONIC_A);
      expect(steps).toEqual(['fsync temp file', 'rename into place', 'fsync directory']);
    }
  );
});
