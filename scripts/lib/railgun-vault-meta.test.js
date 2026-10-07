const fs = require('fs'),
  os = require('os'),
  path = require('path');
const {
  VAULT_META_FILE,
  vaultMetaRecord,
  renderVaultMeta,
  createVaultMetaExclusive,
} = require('./railgun-vault-meta');

// Public fixture addresses only.
const keys = {
  userWallet: { address: '0x' + 'Ab'.repeat(20), privateKey: '0x' + '11'.repeat(32) },
  beeWallet: { address: '0x' + 'Cd'.repeat(20), privateKey: '0x' + '22'.repeat(32) },
};
let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-vault-meta-')));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("builds identity-manager's record from public addresses only, in its field order", () => {
  const meta = vaultMetaRecord(keys, {
    userKnowsPassword: false,
    createdAt: '2026-10-07T00:00:00.000Z',
  });
  expect(meta).toEqual({
    userKnowsPassword: false,
    createdAt: '2026-10-07T00:00:00.000Z',
    addresses: { userWallet: keys.userWallet.address, beeWallet: keys.beeWallet.address },
  });
  expect(Object.keys(meta)).toEqual(['userKnowsPassword', 'createdAt', 'addresses']);
  expect(Object.keys(meta.addresses)).toEqual(['userWallet', 'beeWallet']);
  expect(renderVaultMeta(meta)).toBe(JSON.stringify(meta, null, 2));
  expect(renderVaultMeta(meta)).not.toContain('11'.repeat(32));
  for (const fields of [
    { userKnowsPassword: 'false', createdAt: '2026-10-07T00:00:00.000Z' },
    { userKnowsPassword: false },
  ])
    expect(() => vaultMetaRecord(keys, fields)).toThrow();
});

test('creates the file exclusively and never replaces or follows an existing one', () => {
  const text = renderVaultMeta(
    vaultMetaRecord(keys, { userKnowsPassword: true, createdAt: '2026-10-07T00:00:00.000Z' })
  );
  const file = createVaultMetaExclusive(root, text);
  expect(file).toBe(path.join(root, VAULT_META_FILE));
  expect(fs.readFileSync(file, 'utf8')).toBe(text);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(() => createVaultMetaExclusive(root, '{}')).toThrow(
    expect.objectContaining({ code: 'EEXIST' })
  );
  expect(fs.readFileSync(file, 'utf8')).toBe(text);
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  const target = path.join(root, 'target.json');
  fs.writeFileSync(target, 'kept');
  fs.symlinkSync(target, path.join(other, VAULT_META_FILE));
  expect(() => createVaultMetaExclusive(other, text)).toThrow(
    expect.objectContaining({ code: 'EEXIST' })
  );
  expect(fs.readFileSync(target, 'utf8')).toBe('kept');
});

test('an incomplete write throws after syncing nothing as complete', () => {
  const short = { ...fs, writeSync: (fd, bytes) => fs.writeSync(fd, bytes, 0, 3, 0) };
  const synced = [];
  short.fsyncSync = (fd) => synced.push(fd);
  expect(() => createVaultMetaExclusive(root, '{"a":1}', short)).toThrow(
    'Vault metadata write incomplete'
  );
  expect(synced).toEqual([]);
});
