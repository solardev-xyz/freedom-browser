const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createHash } = require('crypto');
let mockProfile, mockParent, mockIdentity, mockVault, mockMnemonic;
jest.mock('../profile-resolver', () => ({ getActiveProfile: () => mockProfile }));
jest.mock('./privacy-session', () => ({ openPrivacySession: () => mockParent }));
jest.mock('../identity/vault', () => ({
  getSessionSignal: () => mockVault.signal,
  getMnemonic: () => (mockVault.signal.aborted ? null : mockMnemonic),
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (identity, handle) => {
    if (identity !== mockIdentity || identity.signal.aborted) throw Error('identity');
    if (handle) {
      const context = require('../networks/privacy-context').getPrivacyContext(handle);
      if (context.subject.principal !== `railgun:${identity.descriptor.accountIndex}`)
        throw Error('account');
    }
    return identity.descriptor;
  },
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { openRailgunAccountEnrollment } = require('./railgun-account-enrollment');
let enrollments;
function bind(index = 0) {
  mockVault = new AbortController();
  mockParent = createPrivacyScope({
    profileId: createHash('sha256')
      .update(JSON.stringify([mockProfile.id, mockProfile.userDataDir]))
      .digest('hex'),
    signal: mockVault.signal,
  });
  mockIdentity = {
    signal: mockVault.signal,
    descriptor: Object.freeze({
      accountIndex: index,
      walletId: '1'.repeat(64),
      instanceId: 'public-fixture',
    }),
  };
}
beforeEach(() => {
  enrollments = [];
  mockProfile = {
    id: 'fixture',
    userDataDir: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-enrollment-'))),
  };
  mockMnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  bind();
});
afterEach(() => {
  enrollments.forEach((entry) => entry.close());
  mockParent.close();
  jest.restoreAllMocks();
});
async function open(create = false) {
  const result = await openRailgunAccountEnrollment({ identity: mockIdentity, create });
  enrollments.push(result);
  return result;
}
function inventory() {
  return JSON.parse(
    fs.readFileSync(path.join(mockProfile.userDataDir, 'wallet-privacy-inventory.json'))
  ).state.files;
}
test('explicit enrollment persists identity/catalog, separates storage keys and reopens unchanged', async () => {
  await expect(open()).rejects.toThrow();
  const first = await open(true),
    pending = await first.catalog.begin('2'.repeat(64));
  let publicKeys, walletKeys;
  await first.withPublicKeys((keys) => {
    publicKeys = Object.values(keys).map((k) => k.toString('hex'));
  });
  await first.withGenerationKeys(pending.id, (keys) => {
    walletKeys = Object.values(keys).map((k) => k.toString('hex'));
  });
  expect(new Set([...publicKeys, ...walletKeys]).size).toBe(5);
  expect(inventory()).toHaveLength(2);
  const contents = inventory()
    .map((f) => fs.readFileSync(path.join(mockProfile.userDataDir, f), 'utf8'))
    .join('');
  expect(contents).not.toContain('public-fixture');
  expect(contents).not.toContain(mockMnemonic);
  const originalDirectory = first.directory;
  first.close();
  const restored = await open();
  expect(restored.directory).toBe(originalDirectory);
  expect((await restored.catalog.inspect()).pending.id).toBe(pending.id);
  await restored.withPublicKeys((keys) =>
    expect(Object.values(keys).map((k) => k.toString('hex'))).toEqual(publicKeys)
  );
  await restored.withGenerationKeys(pending.id, (keys) =>
    expect(Object.values(keys).map((k) => k.toString('hex'))).toEqual(walletKeys)
  );
});
test('duplicate create, concurrent open, forged identity and foreign generations refuse', async () => {
  const entry = await open(true);
  const { getPrivacyContext } = require('../networks/privacy-context');
  expect(getPrivacyContext(entry.getContext('engine')).subject.operation).toBeNull();
  expect(getPrivacyContext(entry.getContext('storage', 'scan-journal')).subject.operation).toBe(
    'scan-journal'
  );
  expect(() => entry.getContext('keystore')).toThrow();
  await expect(open()).rejects.toThrow();
  await expect(entry.withGenerationKeys('f'.repeat(64), () => {})).rejects.toThrow();
  await expect(openRailgunAccountEnrollment({ identity: { ...mockIdentity } })).rejects.toThrow();
  entry.close();
  await expect(open(true)).rejects.toThrow();
  expect((await open()).descriptor).toEqual(mockIdentity.descriptor);
});
test('borrowed keys wipe on success, exception and vault lock before callback completion', async () => {
  const entry = await open(true);
  let borrowed;
  await entry.withPublicKeys((keys) => {
    borrowed = Object.values(keys);
  });
  expect(borrowed.every((k) => k.every((v) => v === 0))).toBe(true);
  await expect(
    entry.withPublicKeys((keys) => {
      borrowed = Object.values(keys);
      throw Error('callback');
    })
  ).rejects.toThrow('callback');
  expect(borrowed.every((k) => k.every((v) => v === 0))).toBe(true);
  await expect(
    entry.withPublicKeys(async (keys) => {
      borrowed = Object.values(keys);
      mockVault.abort();
      expect(borrowed.every((k) => k.every((v) => v === 0))).toBe(true);
    })
  ).rejects.toThrow();
  await expect(entry.withPublicKeys(() => {})).rejects.toThrow();
});
test.each(['manifest', 'catalog', 'directory'])(
  'missing active %s is refused without recreating it',
  async (kind) => {
    const entry = await open(true),
      files = inventory();
    const target =
      kind === 'directory'
        ? entry.directory
        : path.join(
            mockProfile.userDataDir,
            files.find((f) =>
              kind === 'manifest' ? !f.includes('/account-') : f.includes('/account-')
            )
          );
    entry.close();
    fs.renameSync(target, target + '.preserved');
    await expect(open()).rejects.toThrow();
    await expect(open(true)).rejects.toThrow();
    expect(fs.existsSync(target)).toBe(false);
  }
);
test.each(['descriptor', 'seed'])(
  'a changed %s cannot silently recreate an enrolled account',
  async (kind) => {
    (await open(true)).close();
    if (kind === 'seed')
      mockMnemonic = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    else
      mockIdentity = {
        ...mockIdentity,
        descriptor: { ...mockIdentity.descriptor, walletId: 'a'.repeat(64) },
      };
    await expect(open()).rejects.toThrow();
    await expect(open(true)).rejects.toThrow();
  }
);
test.each(['directory', 'activation'])(
  'pending enrollment resumes after interrupted %s creation without deleting files',
  async (phase) => {
    const originalMkdir = fs.mkdirSync,
      originalRename = fs.renameSync;
    let armed = true,
      manifestWrites = 0;
    jest.spyOn(fs, 'mkdirSync').mockImplementation((name, ...args) => {
      if (armed && phase === 'directory' && /\/account-[0-9a-f]{64}$/.test(name)) {
        armed = false;
        throw Error('interrupt');
      }
      return originalMkdir(name, ...args);
    });
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (/wallet-railgun-accounts\/[0-9a-f]{64}\.json$/.test(to)) manifestWrites++;
      if (armed && phase === 'activation' && manifestWrites === 2) {
        armed = false;
        throw Error('interrupt');
      }
      return originalRename(from, to);
    });
    await expect(open(true)).rejects.toThrow();
    jest.restoreAllMocks();
    const restored = await open();
    expect((await restored.catalog.inspect()).active).toBeNull();
    expect(inventory()).toHaveLength(2);
    restored.close();
    expect((await open()).directory).toBe(restored.directory);
  }
);
test('generation and account indices separate derived-store keys', async () => {
  const first = await open(true),
    a = await first.catalog.begin('2'.repeat(64));
  let firstKey;
  await first.withGenerationKeys(a.id, (keys) => {
    firstKey = keys['wallet-store'].toString('hex');
  });
  const b = await first.catalog.begin('3'.repeat(64));
  await first.withGenerationKeys(b.id, (keys) =>
    expect(keys['wallet-store'].toString('hex')).not.toBe(firstKey)
  );
  await expect(first.withGenerationKeys(a.id, () => {})).rejects.toThrow();
  let publicKey;
  await first.withPublicKeys((keys) => {
    publicKey = keys['source-ledger'].toString('hex');
  });
  first.close();
  mockParent.close();
  bind(1);
  const second = await open(true);
  await second.withPublicKeys((keys) =>
    expect(keys['source-ledger'].toString('hex')).not.toBe(publicKey)
  );
  expect(second.directory).not.toBe(first.directory);
});
test.each(['manifest', 'catalog', 'directory'])(
  'symbolic-link substitution of %s refuses',
  async (kind) => {
    const entry = await open(true),
      files = inventory();
    const target =
      kind === 'directory'
        ? entry.directory
        : path.join(
            mockProfile.userDataDir,
            files.find((f) =>
              kind === 'manifest' ? !f.includes('/account-') : f.includes('/account-')
            )
          );
    entry.close();
    fs.renameSync(target, target + '.preserved');
    fs.symlinkSync(target + '.preserved', target, kind === 'directory' ? 'dir' : 'file');
    await expect(open()).rejects.toThrow();
  }
);
test('moved profile requires recovery instead of deriving a fresh empty slot', async () => {
  (await open(true)).close();
  mockParent.close();
  const moved = mockProfile.userDataDir + '-moved';
  fs.renameSync(mockProfile.userDataDir, moved);
  mockProfile = { ...mockProfile, userDataDir: moved };
  bind();
  await expect(open()).rejects.toMatchObject({ code: 'PRIVATE_PROFILE_MOVED' });
  await expect(open(true)).rejects.toMatchObject({ code: 'PRIVATE_PROFILE_MOVED' });
});
test('public generation keys are catalog-bound, separated from legacy keys and wiped after use', async () => {
  const entry = await open(true);
  const { createRailgunPublicCatalog } = require('./railgun-public-catalog');
  const catalog = await entry.withPublicCatalogKey((keys) =>
    createRailgunPublicCatalog({
      handle: entry.getContext('storage', 'railgun-public-catalog-v1'),
      directory: entry.directory,
      binding: entry.binding,
      key: keys['public-catalog'],
      create: true,
      profileGuard: entry.profileGuard,
    })
  );
  const first = await catalog.begin('2'.repeat(64));
  let legacy, firstKeys, borrowed;
  await entry.withPublicKeys((keys) => {
    legacy = Object.values(keys).map((k) => k.toString('hex'));
  });
  await entry.withPublicGenerationKeys(catalog, first.id, (keys) => {
    borrowed = Object.values(keys);
    firstKeys = borrowed.map((k) => k.toString('hex'));
  });
  expect(borrowed.every((k) => k.every((v) => v === 0))).toBe(true);
  expect(new Set([...legacy, ...firstKeys]).size).toBe(6);
  await expect(
    entry.withPublicGenerationKeys({ ...catalog }, first.id, () => {})
  ).rejects.toThrow();
  const second = await catalog.begin('3'.repeat(64));
  await expect(entry.withPublicGenerationKeys(catalog, first.id, () => {})).rejects.toThrow();
  await entry.withPublicGenerationKeys(catalog, second.id, (keys) => {
    expect(new Set([...firstKeys, ...Object.values(keys).map((k) => k.toString('hex'))]).size).toBe(
      6
    );
  });
  entry.close();
  expect(catalog.signal.aborted).toBe(true);
});
