const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, createHmac } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPrivacyProfileGuard } = require('./privacy-profile-guard');
const { createPrivacyStorage } = require('./privacy-storage');
const seed = Buffer.alloc(64, 1),
  key = Buffer.alloc(32, 2);
let profile, scope, handle;
function bind() {
  scope = createPrivacyScope({
    profileId: createHash('sha256')
      .update(JSON.stringify([profile.id, profile.userDataDir]))
      .digest('hex'),
    signal: new AbortController().signal,
  });
  handle = scope.getContext({
    kind: 'private-account',
    principal: 'ppv2:0',
    protocol: 'privacy-pools-v2',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'storage',
  });
}
const guard = () => createPrivacyProfileGuard({ handle, profile, seed });
const store = (name, profileGuard = guard()) =>
  createPrivacyStorage({
    handle,
    directory: path.join(profile.userDataDir, name),
    key,
    profileGuard,
  });
beforeEach(() => {
  profile = {
    id: 'fixture',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-inventory-')),
  };
  bind();
});
afterEach(() => {
  scope.close();
  jest.restoreAllMocks();
});
test('capacity refusal preserves a valid inventory and existing PPv2 reads and writes', async () => {
  const inventory = guard(),
    storage = store('wallet-ppv2-relays', inventory);
  await storage.set('record', 'existing pending operation');
  const marker = path.join(profile.userDataDir, 'wallet-privacy-inventory.json');
  const record = JSON.parse(fs.readFileSync(marker));
  const directory = path.join(profile.userDataDir, 'wallet-railgun-accounts');
  fs.mkdirSync(directory);
  for (let n = 0; n < 4095; n++) {
    const name = n.toString(16).padStart(64, '0') + '.json';
    fs.writeFileSync(path.join(directory, name), 'retained fixture');
    record.state.files.push('wallet-railgun-accounts/' + name);
  }
  // Seed a valid capacity-boundary fixture directly; avoid 4,096 fsynced setup
  // registrations. The production guard still authenticates and checks all files.
  const markerKey = createHmac('sha256', seed)
    .update('Freedom privacy inventory v1\0')
    .update(profile.id)
    .digest();
  record.mac = createHmac('sha256', markerKey).update(JSON.stringify(record.state)).digest('hex');
  markerKey.fill(0);
  fs.writeFileSync(marker, JSON.stringify(record));
  const before = fs.readFileSync(marker),
    extra = path.join(directory, 'f'.repeat(64) + '.json');
  fs.writeFileSync(extra, 'unregistered retained fixture');
  expect(() => inventory.remember(extra)).toThrow(
    expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_FULL' })
  );
  expect(fs.readFileSync(marker)).toEqual(before);
  const late = store('wallet-private-submissions', inventory);
  await expect(late.set('record', 'durable but unregistered')).rejects.toMatchObject({
    code: 'PRIVATE_PROFILE_INVENTORY_FULL',
    storageCommitted: true,
  });
  const lateDirectory = path.join(profile.userDataDir, 'wallet-private-submissions');
  const lateFile = path.join(lateDirectory, fs.readdirSync(lateDirectory)[0]);
  const retained = fs.readFileSync(lateFile);
  await expect(late.get('record')).rejects.toMatchObject({
    code: 'PRIVATE_PROFILE_INVENTORY_FULL',
  });
  await expect(late.set('record', 'must not replace')).rejects.toMatchObject({
    code: 'PRIVATE_PROFILE_INVENTORY_FULL',
  });
  expect(fs.readFileSync(lateFile)).toEqual(retained);
  expect(fs.readFileSync(marker)).toEqual(before);
  expect(await storage.get('record')).toBe('existing pending operation');
  await storage.set('record', 'still usable');
  scope.close();
  bind();
  expect(await store('wallet-ppv2-relays').get('record')).toBe('still usable');
  expect(JSON.parse(fs.readFileSync(marker)).state.files).toHaveLength(4096);
});

test.each([
  'wallet-ppv2-experiment',
  'wallet-ppv2-relays',
  'wallet-private-submissions',
  'wallet-railgun-accounts',
])('missing initialized %s fails across a fresh scope', async (name) => {
  await store(name).set('record', 'pending');
  const directory = path.join(profile.userDataDir, name),
    file = path.join(directory, fs.readdirSync(directory)[0]);
  fs.renameSync(file, `${file}.preserved`);
  scope.close();
  bind();
  expect(guard).toThrow(expect.objectContaining({ code: 'PRIVATE_PROFILE_STORE_MISSING' }));
});

test.each([
  'source.sqlite',
  'public.sqlite',
  'a'.repeat(64) + '.json',
  'railgun-public-' + 'b'.repeat(64) + '/source.sqlite',
  'railgun-public-' + 'b'.repeat(64) + '/public.sqlite',
  'railgun-public-' + 'b'.repeat(64) + '/txid-' + 'd'.repeat(64) + '.sqlite',
  'railgun-public-' + 'b'.repeat(64) + '/' + 'c'.repeat(64) + '.json',
  'railgun-cache-' + 'b'.repeat(64) + '/wallet.sqlite',
  'railgun-cache-' + 'b'.repeat(64) + '/' + 'c'.repeat(64) + '.json',
])('Railgun nested inventory retains and requires %s', (name) => {
  const inventory = guard(),
    file = path.join(
      profile.userDataDir,
      'wallet-railgun-accounts',
      'account-' + 'd'.repeat(64),
      name
    );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'authenticated-by-owner-fixture');
  inventory.remember(file);
  inventory.assert(file);
  fs.renameSync(file, file + '.preserved');
  expect(() => inventory.assert(file)).toThrow(
    expect.objectContaining({ code: 'PRIVATE_PROFILE_STORE_MISSING' })
  );
});
test.each([
  'private.key',
  'wallet.sqlite',
  'source.sqlite-wal',
  'railgun-cache-' + 'b'.repeat(64) + '/other.sqlite',
  'railgun-cache-short/wallet.sqlite',
  'railgun-public-' + 'b'.repeat(64) + '/wallet.sqlite',
  'railgun-public-short/public.sqlite',
  'railgun-public-' + 'b'.repeat(64) + '/txid-short.sqlite',
  'railgun-cache-' + 'b'.repeat(64) + '/txid-' + 'd'.repeat(64) + '.sqlite',
  'nested/' + 'c'.repeat(64) + '.json',
])('Railgun inventory refuses unrelated nested path %s', (name) => {
  const inventory = guard(),
    file = path.join(
      profile.userDataDir,
      'wallet-railgun-accounts',
      'account-' + 'd'.repeat(64),
      name
    );
  expect(() => inventory.assert(file)).toThrow();
});

test('a moved profile is recognized without interpreting its journals as empty', async () => {
  await store('wallet-ppv2-relays').set('record', 'pending');
  const moved = `${profile.userDataDir}-moved`;
  fs.renameSync(profile.userDataDir, moved);
  scope.close();
  profile.userDataDir = moved;
  bind();
  expect(guard).toThrow(expect.objectContaining({ code: 'PRIVATE_PROFILE_MOVED' }));
});

test('missing, modified or foreign-key inventory is refused', async () => {
  await store('wallet-ppv2-relays').set('record', 'pending');
  const marker = path.join(profile.userDataDir, 'wallet-privacy-inventory.json'),
    original = fs.readFileSync(marker);
  expect(() => createPrivacyProfileGuard({ handle, profile, seed: Buffer.alloc(64, 3) })).toThrow(
    expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_INVALID' })
  );
  const record = JSON.parse(original);
  record.state.files = [];
  fs.writeFileSync(marker, JSON.stringify(record));
  expect(guard).toThrow(expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_INVALID' }));
  fs.renameSync(marker, `${marker}.preserved`);
  expect(guard).toThrow(expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_MISSING' }));
});

test('a crash after durable store write but before inventory update authenticates and adopts that file', async () => {
  const original = guard();
  const storage = store('wallet-ppv2-relays', {
    assert: original.assert,
    remember: () => {
      throw new Error('crash');
    },
  });
  await expect(storage.set('record', 'pending')).rejects.toMatchObject({
    code: 'PRIVATE_STORAGE_WRITE_FAILED',
  });
  scope.close();
  bind();
  expect(await store('wallet-ppv2-relays').get('record')).toBe('pending');
  const marker = JSON.parse(
    fs.readFileSync(path.join(profile.userDataDir, 'wallet-privacy-inventory.json'))
  );
  expect(marker.state.files).toHaveLength(1);
});

test('an unlisted ciphertext must authenticate before it is adopted', async () => {
  const original = guard();
  await expect(
    store('wallet-ppv2-relays', {
      assert: original.assert,
      remember: () => {
        throw new Error('crash');
      },
    }).set('record', 'pending')
  ).rejects.toThrow();
  const dir = path.join(profile.userDataDir, 'wallet-ppv2-relays'),
    file = path.join(dir, fs.readdirSync(dir)[0]);
  fs.writeFileSync(file, '{}');
  await expect(store('wallet-ppv2-relays').get('record')).rejects.toMatchObject({
    code: 'PRIVATE_STORAGE_UNREADABLE',
  });
  expect(
    JSON.parse(fs.readFileSync(path.join(profile.userDataDir, 'wallet-privacy-inventory.json')))
      .state.files
  ).toEqual([]);
});
