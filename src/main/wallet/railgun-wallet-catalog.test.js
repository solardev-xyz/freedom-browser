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
const { createPrivacyStorage } = require('./privacy-storage');
const { startRailgunSessionWorker } = require('./railgun-session-worker');
const { claimRailgunAccountStore } = require('./railgun-store-owners');
const walletId = '1'.repeat(64),
  policy = '2'.repeat(64);
let scope, options, catalogs, workers;
beforeEach(() => {
  catalogs = [];
  workers = [];
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
afterEach(async () => {
  catalogs.forEach((c) => c.close());
  scope.close();
  workers.forEach((worker) => worker.close());
  await Promise.all(workers.map((worker) => worker.closed));
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
  expect((await c.inspect()).pending.directory).toBeUndefined();
  expect(await c.retireInactive()).toHaveLength(7);
  expect((await c.inspectRetention()).retired).toHaveLength(7);
  expect(dirs.every((dir) => fs.statSync(dir).isDirectory())).toBe(true);
  await c.begin(policy);
});
test('closed inactive generations retire without touching files or active/pending pointers and survive reopen', async () => {
  const c = await open(),
    first = await c.begin(policy);
  await c.publish(first, journal(first));
  const abandoned = await c.begin(policy),
    pending = await c.begin(policy);
  const sentinel = path.join(abandoned.directory, 'wallet.sqlite');
  fs.writeFileSync(sentinel, 'retained encrypted-cache fixture');
  const before = await c.inspect();
  mockGenerationOpen = true;
  await expect(c.retireInactive()).rejects.toThrow('generation still open');
  expect(await c.inspect()).toEqual(before);
  mockGenerationOpen = false;
  expect(await c.retireInactive()).toEqual([abandoned.id]);
  expect(await c.inspect()).toEqual(before);
  expect(fs.readFileSync(sentinel, 'utf8')).toBe('retained encrypted-cache fixture');
  await expect(c.publish(pending, journal(pending))).rejects.toThrow();
  const resumed = await c.resume();
  await c.publish(resumed, journal(resumed));
  c.close();
  const cold = await open(false);
  expect((await cold.inspectRetention()).retired).toEqual([abandoned.id]);
  expect((await cold.inspectRetention()).inactive).toEqual([first.id]);
  expect(await cold.retireInactive()).toEqual([first.id]);
  expect(cold.activeFor(policy).id).toBe(pending.id);
});
test('an opening or live storage worker blocks retirement before any wallet journal exists', async () => {
  const c = await open(),
    old = await c.begin(policy);
  await c.begin(policy);
  const worker = startRailgunSessionWorker({
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'fixture',
      protocol: 'railgun',
      deployment: 'fixture',
      chainId: 11155111,
      role: 'engine',
    }),
    storage: {
      format: 'paged-v2',
      filename: path.join(old.directory, 'wallet.init-fixture.sqlite'),
      key: Buffer.alloc(32, 7),
      binding: options.binding,
      create: true,
    },
    createProvider: ({ signal }) => ({
      signal,
      request: async () => {
        throw Error('no RPC');
      },
    }),
    onClose: () => {},
  });
  workers.push(worker);
  await expect(c.retireInactive()).rejects.toMatchObject({
    code: 'RAILGUN_SESSION_DIRECTORY_BUSY',
  });
  await worker.ready;
  await expect(c.retireInactive()).rejects.toMatchObject({
    code: 'RAILGUN_SESSION_DIRECTORY_BUSY',
  });
  worker.close();
  await worker.closed;
  expect(await c.retireInactive()).toEqual([old.id]);
});
test('more than eight successive cache versions retain authenticated retirement history without deletion', async () => {
  const c = await open(),
    ids = [];
  for (let n = 0; n < 12; n++) {
    const token = await c.begin(n.toString(16).padStart(64, '0'));
    ids.push(token.id);
    await c.publish(token, journal(token));
    await c.retireInactive();
  }
  expect((await c.inspectRetention()).retired).toEqual(ids.slice(0, -1));
  expect((await c.inspect()).active.id).toBe(ids.at(-1));
  expect(
    ids.every((id) =>
      fs.statSync(path.join(options.directory, 'railgun-cache-' + id)).isDirectory()
    )
  ).toBe(true);
});
test('legacy catalog upgrades to retirement-aware version without discarding retained generations', async () => {
  const c = await open(),
    first = await c.begin(policy);
  c.close();
  const storage = createPrivacyStorage(options),
    key = 'railgun-wallet-catalog-v1';
  const record = JSON.parse(await storage.get(key));
  delete record.retired;
  record.version = 1;
  await storage.set(key, JSON.stringify(record));
  const cold = await open(false);
  expect((await cold.inspect()).pending.id).toBe(first.id);
  expect(await cold.inspectRetention()).toEqual({
    inactive: [],
    retired: [],
    retiredLimit: 64,
    listed: 1,
  });
  expect(JSON.parse(await storage.get(key))).toMatchObject({
    version: 2,
    generations: [first.id],
    retired: [],
  });
});
test('logical initializer ownership blocks retirement even between staging and final workers', async () => {
  const c = await open(),
    old = await c.begin(policy);
  await c.begin(policy);
  const filename = path.join(old.directory, 'wallet.sqlite');
  const release = claimRailgunAccountStore(filename);
  try {
    await expect(c.retireInactive()).rejects.toMatchObject({ code: 'RAILGUN_ACCOUNT_STORE_BUSY' });
  } finally {
    release();
  }
  const later = claimRailgunAccountStore(filename);
  release();
  try {
    await expect(c.retireInactive()).rejects.toThrow();
  } finally {
    later();
  }
  expect(await c.retireInactive()).toEqual([old.id]);
});
test('retirement uses remaining capacity oldest first without discarding other inactive ids', async () => {
  const c = await open(),
    first = await c.begin(policy),
    second = await c.begin(policy);
  await c.begin(policy);
  c.close();
  const storage = createPrivacyStorage(options),
    key = 'railgun-wallet-catalog-v1';
  const record = JSON.parse(await storage.get(key));
  record.retired = Array.from({ length: 63 }, (_, n) => n.toString(16).padStart(64, '0'));
  await storage.set(key, JSON.stringify(record));
  const cold = await open(false);
  expect(await cold.retireInactive()).toEqual([first.id]);
  expect((await cold.inspectRetention()).retired).toHaveLength(64);
  expect((await cold.inspectRetention()).inactive).toEqual([second.id]);
});
test('retired capacity refuses before mutation and keeps current catalog access available', async () => {
  const c = await open(),
    first = await c.begin(policy);
  await c.begin(policy);
  c.close();
  const storage = createPrivacyStorage(options),
    key = 'railgun-wallet-catalog-v1';
  const record = JSON.parse(await storage.get(key));
  record.retired = Array.from({ length: 64 }, (_, n) => n.toString(16).padStart(64, '0'));
  await storage.set(key, JSON.stringify(record));
  const cold = await open(false),
    before = await storage.get(key);
  await expect(cold.retireInactive()).rejects.toMatchObject({
    code: 'RAILGUN_WALLET_RETIRED_CAPACITY',
  });
  expect(await storage.get(key)).toBe(before);
  expect((await cold.inspectRetention()).inactive).toEqual([first.id]);
  expect((await cold.inspectRetention()).retired).toHaveLength(64);
  await cold.resume();
});
test('an authenticated abandoned candidate recorded before mkdir can retire without creating its missing directory', async () => {
  const c = await open(),
    original = fs.mkdirSync;
  const spy = jest.spyOn(fs, 'mkdirSync').mockImplementation((name, ...args) => {
    if (path.basename(name).startsWith('railgun-cache-')) throw Error('interrupted mkdir');
    return original(name, ...args);
  });
  try {
    await expect(c.begin(policy)).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
  const cold = await open(false),
    old = (await cold.inspect()).pending;
  await cold.begin(policy);
  expect(await cold.retireInactive()).toEqual([old.id]);
  expect(fs.existsSync(path.join(options.directory, 'railgun-cache-' + old.id))).toBe(false);
});
