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
  handle = scope.getContext({
    kind: 'private-account',
    principal: 'a',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'storage',
  });
  storage = createPrivacyStorage({ handle, directory, key });
});
afterEach(() => {
  scope.close();
  jest.restoreAllMocks();
});
test('encrypts persisted state, restores it, and serializes overlapping writes without losing keys', async () => {
  await Promise.all([
    storage.set('notes', 'sensitive-note-fixture'),
    storage.set('__proto__', 'literal-key'),
  ]);
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
  await expect(
    createPrivacyStorage({ handle, directory, key: Buffer.alloc(32, 9) }).get('notes')
  ).rejects.toMatchObject({ code: 'PRIVATE_STORAGE_UNREADABLE' });
  const other = scope.getContext({
    kind: 'private-account',
    principal: 'b',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'storage',
  });
  const second = createPrivacyStorage({ handle: other, directory, key });
  await second.set('notes', 'different');
  const secondFile = fs
    .readdirSync(directory)
    .map((name) => path.join(directory, name))
    .find((name) => name !== file);
  fs.copyFileSync(file, secondFile);
  await expect(second.get('notes')).rejects.toMatchObject({ code: 'PRIVATE_STORAGE_UNREADABLE' });
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.tag = Buffer.alloc(16).toString('base64');
  fs.writeFileSync(file, JSON.stringify(record));
  await expect(storage.get('notes')).rejects.toMatchObject({ code: 'PRIVATE_STORAGE_UNREADABLE' });
});
test('failed rename preserves the previous complete snapshot and lock refuses queued work', async () => {
  await storage.set('notes', 'old');
  const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('injected');
  });
  await expect(storage.set('notes', 'new')).rejects.toMatchObject({
    code: 'PRIVATE_STORAGE_WRITE_FAILED',
  });
  rename.mockRestore();
  expect(await storage.get('notes')).toBe('old');
  const work = Promise.resolve().then(() => storage.set('notes', 'late'));
  scope.close();
  await expect(work).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  await expect(storage.get('notes')).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
});

describe('existing-only encrypted value reader', () => {
  const { readExistingPrivacyStorageValue, getPrivacyStoragePath } = require('./privacy-storage');
  const { createPrivacyProfileGuard } = require('./privacy-profile-guard');
  const seed = Buffer.alloc(64, 8);
  let profile, options;
  beforeEach(() => {
    scope.close();
    profile = { id: 'existing-storage-fixture', userDataDir: directory };
    const profileId = require('crypto')
      .createHash('sha256')
      .update(JSON.stringify([profile.id, directory]))
      .digest('hex');
    scope = createPrivacyScope({ profileId, signal: new AbortController().signal });
    handle = scope.getContext({
      kind: 'public-address',
      principal: `0x${'1'.repeat(40)}`,
      role: 'transaction-rpc',
      chainId: 11155111,
    });
    options = {
      handle,
      directory: path.join(directory, 'wallet-private-submissions'),
      profile,
      seed,
      key,
    };
    storage = createPrivacyStorage({
      ...options,
      profileGuard: createPrivacyProfileGuard(options),
    });
  });
  test('decrypts the existing value and missing key without returning a writable adapter', async () => {
    await storage.set('state', 'original');
    const before = fs.readFileSync(getPrivacyStoragePath(handle, options.directory));
    expect(readExistingPrivacyStorageValue(options, 'state')).toBe('original');
    expect(readExistingPrivacyStorageValue(options, 'absent')).toBeNull();
    expect(fs.readFileSync(getPrivacyStoragePath(handle, options.directory))).toEqual(before);
  });
  test('refuses missing store instead of the ordinary empty get behavior', async () => {
    expect(await storage.get('state')).toBeNull();
    expect(() => readExistingPrivacyStorageValue(options, 'state')).toThrow();
  });
  test('refuses wrong encryption key and altered authenticated ciphertext', async () => {
    await storage.set('state', 'original');
    expect(() =>
      readExistingPrivacyStorageValue({ ...options, key: Buffer.alloc(32, 9) }, 'state')
    ).toThrow(expect.objectContaining({ code: 'PRIVATE_STORAGE_UNREADABLE' }));
    const file = getPrivacyStoragePath(handle, options.directory);
    const value = JSON.parse(fs.readFileSync(file));
    value.tag = Buffer.alloc(16).toString('base64');
    fs.writeFileSync(file, JSON.stringify(value));
    expect(() => readExistingPrivacyStorageValue(options, 'state')).toThrow(
      expect.objectContaining({ code: 'PRIVATE_STORAGE_UNREADABLE' })
    );
  });
  test('observes cancellation during the file read before releasing plaintext', async () => {
    await storage.set('state', 'original');
    const original = fs.readSync;
    jest.spyOn(fs, 'readSync').mockImplementation((...args) => {
      const result = original(...args);
      scope.close();
      return result;
    });
    expect(() => readExistingPrivacyStorageValue(options, 'state')).toThrow(
      expect.objectContaining({ code: 'PRIVACY_CONTEXT_REVOKED' })
    );
    jest.restoreAllMocks();
  });
  test.each(
    ['ordinary', 'existing'].flatMap((mode) =>
      ['good', 'bad-tag', 'bad-json'].map((outcome) => [mode, outcome])
    )
  )('real AES-GCM wipes update/final/plaintext buffers for %s / %s', async (mode, outcome) => {
    const crypto = require('crypto');
    const { getPrivacyContext } = require('../networks/privacy-context');
    const file = getPrivacyStoragePath(handle, options.directory);
    await storage.set('state', 'public-wiping-fixture');
    if (outcome === 'bad-json') {
      const iv = Buffer.alloc(12, 9),
        cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const context = getPrivacyContext(handle);
      cipher.setAAD(Buffer.from(JSON.stringify([1, context.profileId, context.subject])));
      const ciphertext = Buffer.concat([cipher.update('{invalid-json'), cipher.final()]);
      fs.writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'),
        })
      );
    } else if (outcome === 'bad-tag') {
      const record = JSON.parse(fs.readFileSync(file));
      const tag = Buffer.from(record.tag, 'base64');
      tag[0] ^= 1;
      record.tag = tag.toString('base64');
      fs.writeFileSync(file, JSON.stringify(record));
    }
    const prototype = Object.getPrototypeOf(
      crypto.createDecipheriv('aes-256-gcm', key, Buffer.alloc(12))
    );
    const update = prototype.update,
      final = prototype.final,
      concat = Buffer.concat;
    const head = [],
      tail = [],
      combined = [];
    const updateSpy = jest.spyOn(prototype, 'update').mockImplementation(function (...args) {
      const result = update.apply(this, args);
      head.push({ buffer: result, hadPlaintext: result.some((byte) => byte !== 0) });
      return result;
    });
    const finalSpy = jest.spyOn(prototype, 'final').mockImplementation(function (...args) {
      const result = final.apply(this, args);
      tail.push(result);
      return result;
    });
    jest.spyOn(Buffer, 'concat').mockImplementation((buffers, ...args) => {
      const result = concat.call(Buffer, buffers, ...args);
      if (head.some(({ buffer }) => buffers.includes(buffer))) combined.push(result);
      return result;
    });
    const read = () =>
      mode === 'ordinary'
        ? storage.get('state')
        : Promise.resolve().then(() => readExistingPrivacyStorageValue(options, 'state'));
    if (outcome === 'good') await expect(read()).resolves.toBe('public-wiping-fixture');
    else await expect(read()).rejects.toMatchObject({ code: 'PRIVATE_STORAGE_UNREADABLE' });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(finalSpy).toHaveBeenCalledTimes(1);
    expect(head).toHaveLength(1);
    expect(head[0].hadPlaintext).toBe(true);
    expect(tail).toHaveLength(outcome === 'bad-tag' ? 0 : 1);
    expect(combined).toHaveLength(outcome === 'bad-tag' ? 0 : 1);
    for (const buffer of [...head.map(({ buffer }) => buffer), ...tail, ...combined])
      expect(buffer.every((byte) => byte === 0)).toBe(true);
  });
});
