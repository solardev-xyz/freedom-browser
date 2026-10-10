jest.mock('../identity/vault', () => ({
  getMnemonic: () => 'test test test test test test test test test test test junk',
  getSessionSignal: () => mockVault.signal,
}));
jest.mock('../profile-resolver', () => ({ getActiveProfile: () => mockProfile }));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPPv2Storage, createPPv2ScanStorage } = require('./ppv2-storage');
const { getPrivacyStoragePath } = require('./privacy-storage');
let mockVault, mockProfile, scope, args, directory;
beforeEach(() => {
  mockVault = new AbortController();
  mockProfile = {
    id: 'scan-fixture',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ppv2-scan-store-')),
  };
  const profileId = createHash('sha256')
    .update(JSON.stringify([mockProfile.id, mockProfile.userDataDir]))
    .digest('hex');
  scope = createPrivacyScope({ profileId, signal: mockVault.signal });
  const subject = {
    kind: 'private-account',
    principal: 'ppv2:0',
    protocol: 'privacy-pools-v2',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'storage',
  };
  args = {
    handle: scope.getContext(subject),
    cacheHandle: scope.getContext({ ...subject, operation: 'scan-cache-v1' }),
    accountIndex: 0,
    binding: { candidate: 'fixture' },
  };
  directory = path.join(mockProfile.userDataDir, 'wallet-ppv2-experiment');
});
afterEach(() => {
  scope.close();
  jest.restoreAllMocks();
});
const value = JSON.stringify({ version: 1, pages: [] });

test('scan pages have their own encrypted inventoried file and cannot consume SDK note capacity', async () => {
  const sdk = await createPPv2Storage(args),
    cache = await createPPv2ScanStorage(args);
  await cache.update(() => JSON.stringify({ data: 'c'.repeat(512 * 1024) }));
  for (let i = 0; i < 4; i++) await sdk.set(`ppv2:controlled:notes:${i}`, 'n'.repeat(1000 * 1024));
  expect(await sdk.get('ppv2:controlled:notes:3')).toHaveLength(1000 * 1024);
  expect(JSON.parse(await (await createPPv2ScanStorage(args)).get()).data).toHaveLength(512 * 1024);
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
  expect(files).toHaveLength(2);
  for (const name of files)
    expect(fs.readFileSync(path.join(directory, name), 'utf8')).not.toContain('cccccccc');
  const inventory = JSON.parse(
    fs.readFileSync(path.join(mockProfile.userDataDir, 'wallet-privacy-inventory.json'))
  );
  expect(inventory.state.files).toHaveLength(2);
  await expect(sdk.get('freedom-ppv2-scan-pages-v1')).rejects.toMatchObject({
    code: 'PRIVATE_PPV2_STORAGE_REFUSED',
  });
});

test('binding changes discard only disposable pages and rewrite the same inventoried file', async () => {
  const sdk = await createPPv2Storage(args),
    cache = await createPPv2ScanStorage(args);
  await sdk.set('ppv2:controlled:notes', 'retained note');
  await cache.update(() => value);
  const file = getPrivacyStoragePath(args.cacheHandle, directory);
  const replacement = await createPPv2ScanStorage({ ...args, binding: { candidate: 'new' } });
  expect(await replacement.get()).toBeNull();
  await replacement.update(() => value);
  expect(fs.existsSync(file)).toBe(true);
  expect(await replacement.get()).toBe(value);
  expect(await sdk.get('ppv2:controlled:notes')).toBe('retained note');
});

test('unauthenticated disposable cache is preserved and bypassed while SDK state stays usable', async () => {
  const sdk = await createPPv2Storage(args),
    cache = await createPPv2ScanStorage(args);
  await sdk.set('ppv2:controlled:notes', 'retained note');
  await cache.update(() => value);
  const file = getPrivacyStoragePath(args.cacheHandle, directory);
  fs.writeFileSync(file, '{"damaged":true}');
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await cache.get()).toBeNull();
  expect(cache.available).toBe(false);
  await cache.update(() => value);
  expect(fs.readFileSync(file, 'utf8')).toBe('{"damaged":true}');
  expect(warning).toHaveBeenCalledTimes(1);
  expect(await sdk.get('ppv2:controlled:notes')).toBe('retained note');
});

test('inventory failure is never treated as a disposable cache error', async () => {
  const cache = await createPPv2ScanStorage(args);
  await cache.update(() => value);
  const file = getPrivacyStoragePath(args.cacheHandle, directory);
  fs.renameSync(file, path.join(mockProfile.userDataDir, 'retained-missing-cache-fixture'));
  await expect(cache.get()).rejects.toMatchObject({ code: 'PRIVATE_PROFILE_STORE_MISSING' });
  expect(cache.available).toBe(true);
});

test('wrong scope and expired vault prevent using the checkpoint capability', async () => {
  await expect(createPPv2ScanStorage({ ...args, cacheHandle: args.handle })).rejects.toMatchObject({
    code: 'PRIVATE_PPV2_SCOPE',
  });
  const cache = await createPPv2ScanStorage(args);
  await cache.update(() => value);
  mockVault.abort();
  await expect(cache.get()).rejects.toThrow();
  await expect(cache.update(() => value)).rejects.toThrow();
});
