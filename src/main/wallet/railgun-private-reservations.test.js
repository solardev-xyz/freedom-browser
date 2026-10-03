const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const {
  createRailgunPrivateReservations,
  isRailgunPrivateReservations,
} = require('./railgun-private-reservations');
let scope, options, floor, stores;
const input = (n = 1, tree = 0) => ({
  tree,
  position: n,
  nullifier: '0x' + n.toString(16).padStart(64, '0'),
  noteHash: '0x' + '1'.repeat(64),
  kind: 'railgun-private-transfer',
  intentDigest: '0x' + '2'.repeat(64),
  checkpointHash: '3'.repeat(64),
  poiDigest: '4'.repeat(64),
});
beforeEach(() => {
  floor = null;
  stores = [];
  scope = createPrivacyScope({
    profileId: 'reservation-test',
    signal: new AbortController().signal,
  });
  const walletId = '5'.repeat(64);
  options = {
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'railgun:0',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      role: 'storage',
      operation: 'railgun-private-reservations-v1:' + walletId,
    }),
    directory: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-reservations-'))),
    key: Buffer.alloc(32, 7),
    binding: '6'.repeat(64),
    walletId,
    readFloor: async () => floor,
    advanceFloor: async (v) => {
      if (floor !== null && v < floor) throw Error('floor');
      floor = v;
    },
  };
});
afterEach(() => {
  stores.forEach((s) => s.close());
  scope.close();
  jest.restoreAllMocks();
});
async function open(create = true, extra = {}) {
  const s = await createRailgunPrivateReservations({ ...options, create, ...extra });
  stores.push(s);
  return s;
}
const filename = () => getPrivacyStoragePath(options.handle, options.directory);
test('durable permanent holds bind exact facts and return only genuine live receipts', async () => {
  const s = await open(),
    value = input(),
    receipt = await s.reserve(value);
  value.intentDigest = '0x' + '9'.repeat(64);
  expect(isRailgunPrivateReservations(s)).toBe(true);
  expect(isRailgunPrivateReservations({ ...s })).toBe(false);
  expect((await s.assertReceipt(receipt)).facts).toEqual(input());
  expect(Object.isFrozen((await s.assertReceipt(receipt)).facts)).toBe(true);
  await expect(s.assertReceipt({ ...receipt })).rejects.toThrow();
  expect(await s.inspect()).toEqual({ held: 1 });
  expect(Object.keys(s).sort()).toEqual(['assertReceipt', 'close', 'inspect', 'reserve', 'signal']);
  const disk = fs.readFileSync(filename(), 'utf8');
  expect(disk).not.toContain(input().nullifier);
  expect(disk).not.toContain(input().intentDigest);
  s.close();
  const cold = await open(false);
  expect(await cold.inspect()).toEqual({ held: 1 });
  await expect(cold.assertReceipt(receipt)).rejects.toThrow();
  await expect(cold.reserve(input())).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
  });
  expect(await cold.inspect()).toEqual({ held: 1 });
});
test('atomic duplicate exclusion preserves tree scoping and refuses concurrent writers', async () => {
  const s = await open();
  const first = s.reserve(input());
  await expect(s.reserve(input())).rejects.toThrow();
  await first;
  await expect(s.reserve(input())).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
  });
  await s.reserve(input(1, 1));
  expect(await s.inspect()).toEqual({ held: 2 });
});
test('capacity refuses without dropping any held input', async () => {
  const s = await open();
  s.close();
  const storage = createPrivacyStorage(options);
  await storage.update('railgun-private-reservations-v1', (text) => {
    const v = JSON.parse(text);
    v.sequence = 512;
    v.entries = Array.from({ length: 512 }, (_, i) => ({
      id: (i + 1).toString(16).padStart(64, '0'),
      facts: input(i + 1),
    }));
    return JSON.stringify(v);
  });
  const cold = await open(false);
  await expect(cold.reserve(input(513))).rejects.toMatchObject({
    code: 'RAILGUN_RESERVATIONS_CAPACITY',
  });
  expect(await cold.inspect()).toEqual({ held: 512 });
  expect(floor).toBe(512);
});
test('reservation-file rollback below manifest floor refuses; restoring both is outside this guarantee', async () => {
  const s = await open(),
    old = fs.readFileSync(filename());
  await s.reserve(input());
  s.close();
  fs.writeFileSync(filename(), old);
  await expect(open(false)).rejects.toThrow();
  expect(floor).toBe(1);
});
test('write before failed manifest update retains the input and repairs the lower floor on reopen', async () => {
  let refuse = false;
  const s = await open(true, {
    advanceFloor: async (v) => {
      if (refuse) throw Error('interrupted');
      floor = v;
    },
  });
  refuse = true;
  await expect(s.reserve(input())).rejects.toThrow('interrupted');
  expect(s.signal.aborted).toBe(true);
  expect(floor).toBe(0);
  const cold = await open(false);
  expect(await cold.inspect()).toEqual({ held: 1 });
  expect(floor).toBe(1);
  await expect(cold.reserve(input())).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
  });
});
test('missing initialized file never becomes empty even with create requested', async () => {
  (await open()).close();
  fs.renameSync(filename(), filename() + '.retained');
  await expect(open()).rejects.toThrow();
  await expect(open(false)).rejects.toThrow();
  expect(fs.existsSync(filename())).toBe(false);
});
test('duplicate open, foreign binding, wrong key and corruption refuse', async () => {
  const s = await open();
  await expect(open(false)).rejects.toThrow();
  s.close();
  await expect(open(false, { binding: 'f'.repeat(64) })).rejects.toThrow();
  await expect(open(false, { key: Buffer.alloc(32, 8) })).rejects.toThrow();
  fs.writeFileSync(filename(), '{}');
  await expect(open(false)).rejects.toThrow();
});
test('live file replay closes the store instead of granting a stale receipt', async () => {
  const s = await open(),
    old = fs.readFileSync(filename()),
    receipt = await s.reserve(input());
  fs.writeFileSync(filename(), old);
  await expect(s.assertReceipt(receipt)).rejects.toThrow();
  expect(s.signal.aborted).toBe(true);
});
test.each([
  ['tree', -1],
  ['tree', 65536],
  ['position', 65536],
  ['nullifier', '1'],
  ['nullifier', '0x' + 'f'.repeat(64)],
  ['noteHash', '0x' + 'F'.repeat(64)],
  ['kind', 'shield'],
  ['intentDigest', 'a'],
  ['checkpointHash', 'a'],
  ['poiDigest', 'a'],
  ['extra', true],
])('invalid %s refuses before any durable hold', async (key, value) => {
  const s = await open();
  await expect(s.reserve({ ...input(), [key]: value })).rejects.toThrow();
  expect(await s.inspect()).toEqual({ held: 0 });
});
test('vault lifetime cancellation revokes all receipt and mutation access', async () => {
  const s = await open(),
    receipt = await s.reserve(input());
  scope.close();
  await expect(s.assertReceipt(receipt)).rejects.toThrow();
  await expect(s.reserve(input(2))).rejects.toThrow();
});
