const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPrivacyStorage } = require('./privacy-storage');
let directory, scope, handle, storage;
const key = Buffer.alloc(32, 7);
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-storage-fixture-'));
  scope = createPrivacyScope({ profileId: 'test', signal: new AbortController().signal });
  handle = scope.getContext({ kind: 'private-account', principal: 'a', protocol: 'railgun', deployment: 'sepolia', chainId: 11155111, role: 'storage' });
  storage = createPrivacyStorage({ handle, directory, key });
});
afterEach(() => scope.close());
test('encrypts persisted state, restores it, and serializes overlapping writes without losing keys', async () => {
  await Promise.all([storage.set('notes', 'sensitive-note-fixture'), storage.set('__proto__', 'literal-key')]);
  const file = path.join(directory, fs.readdirSync(directory)[0]);
  expect(fs.readFileSync(file, 'utf8')).not.toContain('sensitive-note-fixture');
  const restored = createPrivacyStorage({ handle, directory, key });
  expect(await restored.get('notes')).toBe('sensitive-note-fixture');
  expect(await restored.get('__proto__')).toBe('literal-key');
  expect(await restored.get('constructor')).toBeNull();
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});
test('rejects modified ciphertext, wrong key and cross-account file substitution', async () => {
  await storage.set('notes', 'fixture');
  const file = path.join(directory, fs.readdirSync(directory)[0]);
  await expect(createPrivacyStorage({ handle, directory, key: Buffer.alloc(32, 9) }).get('notes')).rejects.toMatchObject({ code: 'PRIVATE_STORAGE_UNREADABLE' });
  const other = scope.getContext({ kind: 'private-account', principal: 'b', protocol: 'railgun', deployment: 'sepolia', chainId: 11155111, role: 'storage' });
  const second = createPrivacyStorage({ handle: other, directory, key });
  await second.set('notes', 'different');
  const secondFile = fs.readdirSync(directory).map((name) => path.join(directory, name)).find((name) => name !== file);
  fs.copyFileSync(file, secondFile);
  await expect(second.get('notes')).rejects.toMatchObject({ code: 'PRIVATE_STORAGE_UNREADABLE' });
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.tag = Buffer.alloc(16).toString('base64'); fs.writeFileSync(file, JSON.stringify(record));
  await expect(storage.get('notes')).rejects.toMatchObject({ code: 'PRIVATE_STORAGE_UNREADABLE' });
});
test('failed rename preserves the previous complete snapshot and lock refuses queued work', async () => {
  await storage.set('notes', 'old');
  const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('injected'); });
  await expect(storage.set('notes', 'new')).rejects.toMatchObject({ code: 'PRIVATE_STORAGE_WRITE_FAILED' });
  rename.mockRestore();
  expect(await storage.get('notes')).toBe('old');
  const work = Promise.resolve().then(() => storage.set('notes', 'late'));
  scope.close();
  await expect(work).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  await expect(storage.get('notes')).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
});
