const mockCoordinators = new WeakSet();
jest.mock('./railgun-scan-coordinator', () => ({
  assertRailgunScanCoordinator: (v) => {
    if (!mockCoordinators.has(v)) throw Error('forged');
  },
}));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunPublicCatalog } = require('./railgun-public-catalog');
const { createPrivacyStorage } = require('./privacy-storage');
const { claimRailgunAccountStore } = require('./railgun-store-owners');
let scope, options, opened;
const policy = '2'.repeat(64);
beforeEach(() => {
  opened = [];
  scope = createPrivacyScope({
    profileId: 'public-catalog-test',
    signal: new AbortController().signal,
  });
  options = {
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'fixture',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      role: 'storage',
      operation: 'railgun-public-catalog-v1',
    }),
    directory: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-public-catalog-'))),
    key: Buffer.alloc(32, 74),
    binding: '3'.repeat(64),
  };
});
afterEach(() => {
  opened.forEach((v) => v.close());
  scope.close();
});
async function open(create = true, initialHeight = -1) {
  const value = await createRailgunPublicCatalog({ ...options, create, initialHeight });
  opened.push(value);
  return value;
}
function coordinator(generation, to = 10) {
  const evidence = {};
  const value = {
    identity: {
      directory: generation.directory,
      binding: options.binding,
      policy: generation.policy,
      ledgerId: '4'.repeat(64),
    },
    assertSnapshot: (token) => {
      if (token !== evidence) throw Error('stale');
      return {
        to: { number: to },
        source: { ledgerId: '4'.repeat(64) },
        state: { storeId: '5'.repeat(64) },
      };
    },
  };
  mockCoordinators.add(value);
  return [value, evidence];
}
test('rebuild publishes only a fresh snapshot at the protected height and retains old files', async () => {
  const c = await open(),
    first = await c.begin(policy);
  await c.publish(first, ...coordinator(first));
  fs.writeFileSync(path.join(first.directory, 'source.sqlite'), 'retained');
  await c.protect(first.id, 20);
  const next = await c.begin('6'.repeat(64));
  await c.protect(next.id, 100); // Unpublished attempts never raise the active floor.
  expect(c.inspect().highWater).toBe(20);
  await expect(c.publish(next, ...coordinator(next, 19))).rejects.toThrow();
  expect(c.activeFor(policy).id).toBe(first.id);
  const release = claimRailgunAccountStore(path.join(first.directory, 'source.sqlite'));
  await expect(c.publish(next, ...coordinator(next, 20))).rejects.toThrow();
  release();
  await c.publish(next, ...coordinator(next, 20));
  expect(c.activeFor(next.policy).id).toBe(next.id);
  expect(() => c.assertActive(first.id, policy)).toThrow();
  expect(fs.readFileSync(path.join(first.directory, 'source.sqlite'), 'utf8')).toBe('retained');
});
test('interrupted acquisition keeps its floor across restart and pending tokens cannot be replayed', async () => {
  const c = await open(),
    first = await c.begin(policy);
  await c.publish(first, ...coordinator(first));
  await c.protect(first.id, 30);
  const next = await c.begin('6'.repeat(64));
  c.close();
  const cold = await open(false);
  expect(cold.inspect().highWater).toBe(30);
  await expect(cold.publish(next, ...coordinator(next, 30))).rejects.toThrow();
  const resumed = cold.resume();
  await cold.publish(resumed, ...coordinator(resumed, 30));
  expect(cold.inspect().active.to).toBe(30);
});
test.each(['forged', 'policy', 'directory', 'binding', 'ledger', 'stale'])(
  '%s snapshot cannot publish a generation',
  async (kind) => {
    const c = await open(),
      pending = await c.begin(policy);
    let [v, token] = coordinator(pending);
    if (kind === 'forged') v = { ...v };
    if (kind === 'stale') token = {};
    if (kind === 'policy') v.identity.policy = 'f'.repeat(64);
    if (kind === 'directory') v.identity.directory = options.directory;
    if (kind === 'binding') v.identity.binding = 'f'.repeat(64);
    if (kind === 'ledger') v.identity.ledgerId = 'f'.repeat(64);
    await expect(c.publish(pending, v, token)).rejects.toThrow();
    expect(c.inspect().active).toBeNull();
  }
);
test('all 72 generations fit; capacity refuses before mutation and leaves active state usable', async () => {
  const c = await open();
  for (let n = 0; n < 72; n++) {
    const pending = await c.begin(policy);
    await c.publish(pending, ...coordinator(pending));
  }
  const before = c.inspect();
  await expect(c.begin(policy)).rejects.toMatchObject({ code: 'RAILGUN_PUBLIC_CATALOG_CAPACITY' });
  expect(c.inspect()).toEqual(before);
  c.close();
  expect((await open(false)).inspect()).toEqual(before);
  expect(
    fs.readdirSync(options.directory).filter((f) => f.startsWith('railgun-public-'))
  ).toHaveLength(72);
});
test('obsolete pending generation can be abandoned; current candidate must be resumed', async () => {
  const c = await open(true, 40),
    pending = await c.begin(policy);
  await expect(c.begin(policy)).rejects.toThrow();
  const next = await c.begin('6'.repeat(64));
  expect(fs.existsSync(pending.directory)).toBe(true);
  await expect(c.publish(pending, ...coordinator(pending, 40))).rejects.toThrow();
  expect(c.inspect().highWater).toBe(40);
  await c.publish(next, ...coordinator(next, 40));
});
test('malformed authenticated catalog and missing existing catalog refuse', async () => {
  const c = await open();
  c.close();
  const storage = createPrivacyStorage(options);
  await storage.update('railgun-public-catalog-v1', () => JSON.stringify({ version: 1 }));
  await expect(open(false)).rejects.toThrow();
});
test('begin refuses an owned active directory before mutation and remains usable after release', async () => {
  const c = await open(),
    first = await c.begin(policy);
  await c.publish(first, ...coordinator(first));
  const before = c.inspect();
  const release = claimRailgunAccountStore(path.join(first.directory, 'source.sqlite'));
  await expect(c.begin('6'.repeat(64))).rejects.toMatchObject({
    code: 'RAILGUN_ACCOUNT_STORE_BUSY',
  });
  expect(c.inspect()).toEqual(before);
  release();
  expect((await c.begin('6'.repeat(64))).policy).toBe('6'.repeat(64));
});
test('inspection never exposes mutable internal active or pending pointers', async () => {
  const c = await open(),
    candidate = await c.begin(policy);
  const pending = c.inspect().pending;
  expect(Object.isFrozen(pending)).toBe(true);
  expect(Reflect.set(pending, 'policy', 'f'.repeat(64))).toBe(false);
  expect(c.resume().policy).toBe(policy);
  await c.publish(candidate, ...coordinator(candidate));
  const active = c.inspect().active;
  expect(Object.isFrozen(active)).toBe(true);
  expect(Reflect.set(active, 'storeId', 'f'.repeat(64))).toBe(false);
  expect(c.activeFor(policy).storeId).toBe('5'.repeat(64));
});
