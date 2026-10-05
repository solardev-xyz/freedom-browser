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

describe('assertRegistered', () => {
  const marker = () => path.join(profile.userDataDir, 'wallet-privacy-inventory.json');
  const relative =
    'wallet-railgun-accounts/account-' +
    'a'.repeat(64) +
    '/railgun-cache-' +
    'b'.repeat(64) +
    '/wallet.sqlite';
  const file = () => path.join(profile.userDataDir, relative);
  function createFile(location = file()) {
    fs.mkdirSync(path.dirname(location), { recursive: true });
    fs.writeFileSync(location, 'retained store fixture');
  }
  function snapshot(directory = profile.userDataDir) {
    return fs
      .readdirSync(directory)
      .sort()
      .map((name) => {
        const location = path.join(directory, name);
        return [
          name,
          fs.statSync(location).isDirectory() ? snapshot(location) : fs.readFileSync(location),
        ];
      });
  }
  function resign(record, signingSeed = seed) {
    const markerKey = createHmac('sha256', signingSeed)
      .update('Freedom privacy inventory v1\0')
      .update(profile.id)
      .digest();
    record.mac = createHmac('sha256', markerKey).update(JSON.stringify(record.state)).digest('hex');
    markerKey.fill(0);
    fs.writeFileSync(marker(), JSON.stringify(record));
  }
  test('authenticates registered files with no writes or return capability', () => {
    const inventory = guard();
    createFile();
    inventory.remember(file());
    const before = snapshot();
    const write = jest.spyOn(fs, 'writeFileSync'),
      rename = jest.spyOn(fs, 'renameSync'),
      mkdir = jest.spyOn(fs, 'mkdirSync');
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(inventory.assertRegistered(file())).toBeUndefined();
    expect(inventory.assertRegistered(file())).toBeUndefined();
    expect(snapshot()).toEqual(before);
    expect(write).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });
  test('refuses an unregistered existing file without adoption, while ordinary assert and remember remain compatible', () => {
    const inventory = guard();
    createFile();
    const before = snapshot();
    expect(() => inventory.assertRegistered(file())).toThrow(
      expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_INVALID' })
    );
    inventory.assert(file());
    expect(snapshot()).toEqual(before);
    inventory.remember(file());
    expect(inventory.assertRegistered(file())).toBeUndefined();
  });
  test.each(['empty-profile', 'empty-store-directory'])(
    'missing inventory in %s refuses without recreating a marker',
    (kind) => {
      const inventory = guard();
      fs.renameSync(marker(), marker() + '.preserved');
      if (kind === 'empty-store-directory')
        fs.mkdirSync(path.join(profile.userDataDir, 'wallet-railgun-accounts'));
      const before = snapshot();
      expect(() => inventory.assertRegistered(file())).toThrow(
        expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_MISSING' })
      );
      expect(fs.existsSync(marker())).toBe(false);
      expect(snapshot()).toEqual(before);
      // The existing general assertion still initializes an empty inventory.
      inventory.assert(file());
      expect(fs.existsSync(marker())).toBe(true);
    }
  );
  test('reads current authenticated membership instead of retaining a prior registration', () => {
    const inventory = guard();
    createFile();
    inventory.remember(file());
    inventory.assertRegistered(file());
    // Authenticated inventory replacement fixture; no replay-protection claim.
    const record = JSON.parse(fs.readFileSync(marker()));
    record.state.files = [];
    resign(record);
    const before = snapshot();
    expect(() => inventory.assertRegistered(file())).toThrow(
      expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_INVALID' })
    );
    expect(snapshot()).toEqual(before);
  });
  test.each(['requested', 'other-required'])(
    'missing %s registered file refuses without rewriting inventory',
    (which) => {
      const inventory = guard(),
        other = path.join(profile.userDataDir, 'wallet-railgun-accounts', 'c'.repeat(64) + '.json');
      createFile();
      createFile(other);
      inventory.remember(file());
      inventory.remember(other);
      const missing = which === 'requested' ? file() : other;
      fs.renameSync(missing, missing + '.preserved');
      const before = snapshot();
      expect(() => inventory.assertRegistered(file())).toThrow(
        expect.objectContaining({ code: 'PRIVATE_PROFILE_STORE_MISSING' })
      );
      expect(snapshot()).toEqual(before);
    }
  );
  test.each(['modified', 'foreign-key', 'moved'])(
    '%s current inventory refuses without mutation',
    (fault) => {
      const inventory = guard();
      createFile();
      inventory.remember(file());
      const record = JSON.parse(fs.readFileSync(marker()));
      if (fault === 'modified') {
        record.state.files = [];
        fs.writeFileSync(marker(), JSON.stringify(record));
      } else if (fault === 'foreign-key') resign(record, Buffer.alloc(64, 3));
      else {
        // Same profile/seed at another path authenticates but is not this profile.
        record.state.profileId = createHash('sha256')
          .update(JSON.stringify([profile.id, profile.userDataDir + '-moved']))
          .digest('hex');
        resign(record);
      }
      const before = snapshot();
      expect(() => inventory.assertRegistered(file())).toThrow(
        expect.objectContaining({
          code: fault === 'moved' ? 'PRIVATE_PROFILE_MOVED' : 'PRIVATE_PROFILE_INVENTORY_INVALID',
        })
      );
      expect(snapshot()).toEqual(before);
    }
  );
  test.each([null, undefined, {}, '', '../outside.json', 'private.key', 'source.sqlite-wal'])(
    'refuses invalid file %p before inventory I/O',
    (value) => {
      const inventory = guard(),
        before = snapshot();
      const read = jest.spyOn(fs, 'readFileSync');
      expect(() =>
        inventory.assertRegistered(
          typeof value === 'string' ? path.join(profile.userDataDir, value) : value
        )
      ).toThrow(expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_INVALID' }));
      expect(read).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    }
  );
  test('refuses cancellation before any inventory read', () => {
    const inventory = guard();
    createFile();
    inventory.remember(file());
    const before = snapshot();
    scope.close();
    const read = jest.spyOn(fs, 'readFileSync');
    expect(() => inventory.assertRegistered(file())).toThrow(
      expect.objectContaining({ code: 'PRIVACY_CONTEXT_REVOKED' })
    );
    expect(read).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });
  test('rechecks lifetime after authenticated file-existence checks', () => {
    const inventory = guard();
    createFile();
    inventory.remember(file());
    const before = snapshot(),
      exists = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((location) => {
      const present = exists(location);
      if (location === file()) scope.close();
      return present;
    });
    expect(() => inventory.assertRegistered(file())).toThrow(
      expect.objectContaining({ code: 'PRIVACY_CONTEXT_REVOKED' })
    );
    expect(snapshot()).toEqual(before);
  });
});

describe('fixed existing-only registered file reader', () => {
  const { readRegisteredPrivacyProfileFile } = require('./privacy-profile-guard');
  const { getPrivacyStoragePath } = require('./privacy-storage');
  const file = () =>
    getPrivacyStoragePath(handle, path.join(profile.userDataDir, 'wallet-private-submissions'));
  const read = (target = file(), maximumBytes = 8 * 1024 * 1024) =>
    readRegisteredPrivacyProfileFile({ handle, profile, seed, file: target, maximumBytes });
  const marker = () => path.join(profile.userDataDir, 'wallet-privacy-inventory.json');
  test('reads registered ciphertext without writers, registration, or retained abort listeners', async () => {
    await store('wallet-private-submissions').set('state', 'value');
    const expected = fs.readFileSync(file());
    const inventory = fs.readFileSync(marker());
    const { signal } = require('../networks/privacy-context').getPrivacyContext(handle);
    const add = jest.spyOn(signal, 'addEventListener'),
      remove = jest.spyOn(signal, 'removeEventListener');
    const writers = ['mkdirSync', 'writeFileSync', 'writeSync', 'renameSync', 'fsyncSync'].map(
      (method) => jest.spyOn(fs, method)
    );
    const open = jest.spyOn(fs, 'openSync');
    expect(read()).toEqual(expected);
    expect(fs.readFileSync(marker())).toEqual(inventory);
    writers.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    expect(open.mock.calls.length).toBeGreaterThan(0);
    open.mock.calls.forEach(([, flags]) =>
      expect(
        flags &
          (fs.constants.O_WRONLY |
            fs.constants.O_RDWR |
            fs.constants.O_CREAT |
            fs.constants.O_TRUNC)
      ).toBe(0)
    );
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
  });
  test('missing inventory never creates an empty marker or directory', () => {
    const before = fs.readdirSync(profile.userDataDir);
    expect(read).toThrow(expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_MISSING' }));
    expect(fs.readdirSync(profile.userDataDir)).toEqual(before);
  });
  test('authenticated empty inventory cannot adopt an existing file', async () => {
    guard();
    const inventory = fs.readFileSync(marker());
    await store('wallet-private-submissions', undefined).set('state', 'value');
    // Restore genuine pre-registration bytes; this models omission, not rollback protection.
    fs.writeFileSync(marker(), inventory);
    const ciphertext = fs.readFileSync(file());
    const remember = jest.spyOn(fs, 'writeFileSync');
    expect(read).toThrow(expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_INVALID' }));
    expect(remember).not.toHaveBeenCalled();
    expect(fs.readFileSync(file())).toEqual(ciphertext);
    expect(fs.readFileSync(marker())).toEqual(inventory);
  });
  test.each(['marker', 'file', 'directory', 'root', 'dangling'])(
    'refuses %s symlink without following it',
    async (kind) => {
      await store('wallet-private-submissions').set('state', 'value');
      const target =
        kind === 'marker' || kind === 'dangling'
          ? marker()
          : kind === 'file'
            ? file()
            : kind === 'directory'
              ? path.dirname(file())
              : profile.userDataDir;
      fs.renameSync(target, `${target}.preserved`);
      fs.symlinkSync(kind === 'dangling' ? `${target}.missing` : `${target}.preserved`, target);
      expect(read).toThrow();
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    }
  );
  test.each([
    '../outside.json',
    'wallet-private-submissions/../../outside.json',
    'not-registered.json',
  ])('rejects forbidden relative target %s', async (relative) => {
    await store('wallet-private-submissions').set('state', 'value');
    expect(() => read(path.join(profile.userDataDir, relative))).toThrow();
  });
  test.each([0, -1, 8 * 1024 * 1024 + 1, NaN, 1.5])(
    'rejects invalid read bound %s',
    async (bound) => {
      await store('wallet-private-submissions').set('state', 'value');
      expect(() => read(file(), bound)).toThrow();
    }
  );
  test('refuses oversized, missing registered, and non-regular files', async () => {
    await store('wallet-private-submissions').set('state', 'value');
    expect(() => read(file(), 1)).toThrow();
    fs.renameSync(file(), `${file()}.preserved`);
    expect(read).toThrow(expect.objectContaining({ code: 'PRIVATE_PROFILE_STORE_MISSING' }));
    fs.mkdirSync(file());
    expect(read).toThrow(expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_INVALID' }));
  });
  test('detects registered inode replacement during open and closes the admitted descriptor', async () => {
    await store('wallet-private-submissions').set('state', 'value');
    const original = fs.openSync,
      originalClose = fs.closeSync;
    let replaced = false,
      opened;
    jest.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      if (target === file() && !replaced) {
        replaced = true;
        const bytes = fs.readFileSync(target);
        fs.renameSync(target, `${target}.preserved`);
        fs.writeFileSync(target, bytes);
        opened = original(target, ...args);
        return opened;
      }
      return original(target, ...args);
    });
    const close = jest.spyOn(fs, 'closeSync').mockImplementation(originalClose);
    expect(read).toThrow(expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_INVALID' }));
    expect(close).toHaveBeenCalledWith(opened);
  });
  test('rechecks inventory authentication after the selected file read and releases the listener', async () => {
    await store('wallet-private-submissions').set('state', 'value');
    const { signal } = require('../networks/privacy-context').getPrivacyContext(handle);
    const add = jest.spyOn(signal, 'addEventListener'),
      remove = jest.spyOn(signal, 'removeEventListener');
    const original = fs.readSync;
    let selected;
    const open = fs.openSync;
    jest.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      const fd = open(target, ...args);
      if (target === file()) selected = fd;
      return fd;
    });
    jest.spyOn(fs, 'readSync').mockImplementation((fd, ...args) => {
      const result = original(fd, ...args);
      if (fd === selected) {
        selected = undefined;
        const value = JSON.parse(fs.readFileSync(marker()));
        value.mac = '0'.repeat(64);
        fs.writeFileSync(marker(), JSON.stringify(value));
      }
      return result;
    });
    expect(read).toThrow(expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_INVALID' }));
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
  });
  test.each([
    'healthy',
    'marker',
    'dangling-marker',
    'selected-file',
    'selected-directory',
    'profile-root',
    'required-file',
    'required-directory',
  ])('strict no-follow metadata for %s uses neither existsSync nor statSync', async (kind) => {
    await store('wallet-private-submissions').set('state', 'value');
    const otherDirectory = path.join(profile.userDataDir, 'wallet-ppv2-experiment');
    await store('wallet-ppv2-experiment').set('state', 'other');
    const otherFile = getPrivacyStoragePath(handle, otherDirectory);
    const targets = {
      marker: marker(),
      'dangling-marker': marker(),
      'selected-file': file(),
      'selected-directory': path.dirname(file()),
      'profile-root': profile.userDataDir,
      'required-file': otherFile,
      'required-directory': otherDirectory,
    };
    const target = targets[kind];
    if (target) {
      fs.renameSync(target, `${target}.preserved`);
      fs.symlinkSync(
        kind === 'dangling-marker' ? `${target}.missing` : `${target}.preserved`,
        target
      );
    }
    const exists = jest.spyOn(fs, 'existsSync'),
      stat = jest.spyOn(fs, 'statSync');
    const opens = jest.spyOn(fs, 'openSync');
    if (kind === 'healthy') expect(read().length).toBeGreaterThan(0);
    else
      expect(read).toThrow(expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_INVALID' }));
    expect(exists).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    if (kind.startsWith('required'))
      expect(opens.mock.calls.some(([target]) => target === file())).toBe(false);
  });
  test('strict missing marker avoids followed metadata and leaves absence unchanged', () => {
    const exists = jest.spyOn(fs, 'existsSync'),
      stat = jest.spyOn(fs, 'statSync');
    expect(read).toThrow(expect.objectContaining({ code: 'PRIVATE_PROFILE_INVENTORY_MISSING' }));
    expect(exists).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(fs.readdirSync(profile.userDataDir)).toEqual([]);
  });
});
