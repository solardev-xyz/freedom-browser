const mockJournals = new WeakSet();
let mockGenerationOpen = false;
jest.mock('./railgun-wallet-journal', () => ({
  isRailgunWalletJournal: (v) => mockJournals.has(v),
  assertRailgunWalletGenerationClosed: () => {
    if (mockGenerationOpen) throw Error('generation still open');
  },
}));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunWalletCatalog } = require('./railgun-wallet-catalog');
const walletId = '1'.repeat(64),
  policy = '2'.repeat(64);
let scope, options, catalogs;
beforeEach(() => {
  catalogs = [];
  mockGenerationOpen = false;
  scope = createPrivacyScope({
    profileId: 'wallet-catalog-test',
    signal: new AbortController().signal,
  });
  options = {
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'fixture',
      protocol: 'railgun',
      deployment: 'fixture',
      chainId: 11155111,
      role: 'storage',
      operation: 'railgun-wallet-catalog-v1:' + walletId,
    }),
    directory: fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-wallet-catalog-')),
    key: Buffer.alloc(32, 66),
    binding: '3'.repeat(64),
    walletId,
  };
});
afterEach(() => {
  catalogs.forEach((c) => c.close());
  scope.close();
});
async function open(create = true) {
  const c = await createRailgunWalletCatalog({ ...options, create });
  catalogs.push(c);
  return c;
}
function journal(token) {
  const result = {
    identity: {
      walletId,
      policy: token.policy,
      directory: token.directory,
      storeId: '4'.repeat(64),
    },
    assertReady: () => ({
      status: 'wallet-scanned-unverified',
      spendableGranted: false,
      to: { number: 10, hash: '0x' + '5'.repeat(64) },
    }),
  };
  mockJournals.add(result);
  return result;
}
test('fresh generations publish only after validation; rebuild leaves old files and pointer intact until ready', async () => {
  const c = await open(),
    first = await c.begin(policy);
  expect((await c.inspect()).active).toBeNull();
  fs.writeFileSync(path.join(first.directory, 'sentinel'), 'old cache');
  await c.publish(first, journal(first));
  expect(c.activeFor(policy)?.directory).toBe(first.directory);
  const second = await c.begin('6'.repeat(64));
  expect(c.activeFor(policy)?.directory).toBe(first.directory);
  expect((await c.inspect()).pending.id).toBe(second.id);
  await c.publish(second, journal(second));
  expect(c.activeFor('6'.repeat(64))?.directory).toBe(second.directory);
  expect(c.activeFor(policy)).toBeNull();
  expect(fs.readFileSync(path.join(first.directory, 'sentinel'), 'utf8')).toBe('old cache');
  await expect(c.publish(second, journal(second))).rejects.toThrow();
});
test('interrupted candidate resumes across restart without replacing the old active generation', async () => {
  const c = await open(),
    first = await c.begin(policy);
  await c.publish(first, journal(first));
  const pending = await c.begin('6'.repeat(64));
  c.close();
  const cold = await open(false),
    resumed = await cold.resume();
  expect(resumed).toEqual(pending);
  expect(cold.activeFor(policy)?.directory).toBe(first.directory);
  await expect(cold.publish(pending, journal(pending))).rejects.toThrow();
  await cold.publish(resumed, journal(resumed));
  expect(cold.activeFor('6'.repeat(64))?.directory).toBe(resumed.directory);
});
test.each(['wallet', 'policy', 'directory', 'not-ready', 'forged'])(
  'refuses %s publication without changing the active pointer',
  async (mode) => {
    const c = await open(),
      first = await c.begin(policy);
    await c.publish(first, journal(first));
    const pending = await c.begin(policy),
      j = journal(pending);
    if (mode === 'wallet') j.identity.walletId = '9'.repeat(64);
    if (mode === 'policy') j.identity.policy = '9'.repeat(64);
    if (mode === 'directory') j.identity.directory = first.directory;
    if (mode === 'not-ready')
      j.assertReady = () => {
        throw Error('pending');
      };
    await expect(c.publish(mode === 'forged' ? { ...pending } : pending, j)).rejects.toThrow();
    c.close();
    const cold = await open(false);
    expect(cold.activeFor(policy)?.directory).toBe(first.directory);
  }
);
test('abandoning a candidate preserves it and invalidates its publication authority', async () => {
  const c = await open(),
    first = await c.begin(policy),
    next = await c.begin(policy);
  expect(fs.statSync(first.directory).isDirectory()).toBe(true);
  await expect(c.publish(first, journal(first))).rejects.toThrow();
  await c.publish(next, journal(next));
});
test('missing cold catalog refuses implicit recreation', async () => {
  await expect(open(false)).rejects.toThrow();
  const c = await open();
  await expect(open()).rejects.toThrow();
  c.close();
});

test('forged journal and living previous generation cannot publish', async () => {
  const c = await open(),
    first = await c.begin(policy);
  await expect(c.publish(first, { ...journal(first) })).rejects.toThrow();
  await c.publish(first, journal(first));
  const second = await c.begin(policy);
  mockGenerationOpen = true;
  await expect(c.publish(second, journal(second))).rejects.toThrow();
  expect(c.activeFor(policy).directory).toBe(first.directory);
  expect((await c.inspect()).pending.id).toBe(second.id);
  mockGenerationOpen = false;
  await c.publish(second, journal(second));
  expect(c.activeFor(policy).directory).toBe(second.directory);
});
test('development retention cap bounds abandoned caches without deleting files', async () => {
  const c = await open();
  const dirs = [];
  for (let i = 0; i < 8; i++) dirs.push((await c.begin(policy)).directory);
  await expect(c.begin(policy)).rejects.toThrow();
  expect(dirs.every((dir) => fs.statSync(dir).isDirectory())).toBe(true);
  expect(dirs.some((dir) => dir.includes(walletId))).toBe(false);
});
