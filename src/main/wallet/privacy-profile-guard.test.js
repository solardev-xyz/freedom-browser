const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
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

test.each(['wallet-ppv2-experiment', 'wallet-ppv2-relays', 'wallet-private-submissions'])(
  'missing initialized %s fails across a fresh scope',
  async (name) => {
    await store(name).set('record', 'pending');
    const directory = path.join(profile.userDataDir, name),
      file = path.join(directory, fs.readdirSync(directory)[0]);
    fs.renameSync(file, `${file}.preserved`);
    scope.close();
    bind();
    expect(guard).toThrow(expect.objectContaining({ code: 'PRIVATE_PROFILE_STORE_MISSING' }));
  }
);

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
