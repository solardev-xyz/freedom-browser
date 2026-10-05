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
    authorizeSigning: () => () => {},
    claimRecovery: () => ({ assertCurrent() {}, release() {} }),
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
test('durable holds bind exact facts and return only genuine live receipts', async () => {
  const s = await open(),
    value = input(),
    receipt = await s.reserve(value);
  value.intentDigest = '0x' + '9'.repeat(64);
  expect(isRailgunPrivateReservations(s)).toBe(true);
  expect(isRailgunPrivateReservations({ ...s })).toBe(false);
  expect((await s.assertReceipt(receipt)).facts).toEqual(input());
  expect(Object.isFrozen((await s.assertReceipt(receipt)).facts)).toBe(true);
  await expect(s.assertReceipt({ ...receipt })).rejects.toThrow();
  expect(await s.inspect()).toEqual({ held: 1, signing: 0, abandoned: 0, legacy: 0 });
  expect(Object.keys(s).sort()).toEqual([
    'abandon',
    'abandonRecovered',
    'assertAvailable',
    'assertReceipt',
    'assertReceiptContext',
    'close',
    'inspect',
    'markSigning',
    'reserve',
    'signal',
    'withSigningRecovery',
  ]);
  const disk = fs.readFileSync(filename(), 'utf8');
  expect(disk).not.toContain(input().nullifier);
  expect(disk).not.toContain(input().intentDigest);
  s.close();
  const cold = await open(false);
  expect(await cold.inspect()).toEqual({ held: 1, signing: 0, abandoned: 0, legacy: 0 });
  await expect(cold.assertReceipt(receipt)).rejects.toThrow();
  await expect(cold.reserve(input())).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
  });
  expect(await cold.inspect()).toEqual({ held: 1, signing: 0, abandoned: 0, legacy: 0 });
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
  expect(await s.inspect()).toEqual({ held: 2, signing: 0, abandoned: 0, legacy: 0 });
});
test('capacity refuses without dropping any held input', async () => {
  const s = await open();
  s.close();
  const storage = createPrivacyStorage(options);
  await storage.update('railgun-private-reservations-v1', (text) => {
    const v = JSON.parse(text);
    v.version = 1;
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
  expect(await cold.inspect()).toEqual({ held: 0, signing: 0, abandoned: 0, legacy: 512 });
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
  expect(await cold.inspect()).toEqual({ held: 1, signing: 0, abandoned: 0, legacy: 0 });
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
  expect(await s.inspect()).toEqual({ held: 0, signing: 0, abandoned: 0, legacy: 0 });
});
test('vault lifetime cancellation revokes all receipt and mutation access', async () => {
  const s = await open(),
    receipt = await s.reserve(input());
  scope.close();
  await expect(s.assertReceipt(receipt)).rejects.toThrow();
  await expect(s.reserve(input(2))).rejects.toThrow();
});

const signing = () => ({
  submitter: '0x' + '7'.repeat(40),
  operationId: '8'.repeat(64),
  gatesDigest: '9'.repeat(64),
});
// Reconstructible owned-note identity; no original randomized intent or POI
// observation is needed after a crash.
const recoveryInput = () => ({
  tree: 0,
  position: 1,
  nullifier: '0x' + '0'.repeat(63) + '1',
  noteHash: '0x' + '1'.repeat(64),
});
test('abandonment retains history, invalidates old receipts and permits a new hold', async () => {
  const s = await open(),
    held = await s.reserve(input());
  const abandoned = await s.abandon(held);
  expect((await s.assertReceipt(abandoned)).state).toBe('abandoned');
  await expect(s.assertReceipt(held)).rejects.toMatchObject({
    code: 'RAILGUN_RESERVATION_RECEIPT_STALE',
  });
  await expect(s.abandon(held)).rejects.toThrow();
  expect(s.signal.aborted).toBe(false);
  expect(await s.inspect()).toEqual({ held: 0, signing: 0, abandoned: 1, legacy: 0 });
  const next = await s.reserve(input());
  expect((await s.assertReceipt(next)).id).not.toBe((await s.assertReceipt(abandoned)).id);
  expect(floor).toBe(3);
  const disk = JSON.parse(
    await createPrivacyStorage(options).get('railgun-private-reservations-v1')
  );
  expect(disk.version).toBe(2);
  expect(disk.entries.map((e) => e.state)).toEqual(['abandoned', 'held']);
});
test('signing binds immutable submitter and operation gates and can never be abandoned', async () => {
  const s = await open(),
    held = await s.reserve(input()),
    evidence = signing();
  const pending = s.markSigning(held, evidence);
  evidence.submitter = '0x' + 'a'.repeat(40);
  await expect(s.abandon(held)).rejects.toThrow();
  const signed = await pending;
  expect(await s.assertReceipt(signed)).toMatchObject({ state: 'signing', signing: signing() });
  expect(Object.isFrozen((await s.assertReceipt(signed)).signing)).toBe(true);
  await expect(s.assertReceipt(held)).rejects.toThrow();
  await expect(s.abandon(signed)).rejects.toThrow();
  await expect(s.markSigning(held, signing())).rejects.toThrow();
  expect(floor).toBe(2);
  s.close();
  const cold = await open(false);
  await expect(cold.abandonRecovered(recoveryInput())).rejects.toMatchObject({
    code: 'RAILGUN_RESERVATION_NOT_RECOVERABLE',
  });
  await expect(cold.reserve(input())).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
  });
  expect(await cold.inspect()).toEqual({ held: 0, signing: 1, abandoned: 0, legacy: 0 });
});
test.each(['signing', 'abandoned'])(
  'interrupted %s floor write preserves the committed transition',
  async (state) => {
    let refuse = false;
    const s = await open(true, {
      advanceFloor: async (v) => {
        if (refuse) throw Error('transition floor interrupted');
        floor = v;
      },
    });
    const held = await s.reserve(input());
    refuse = true;
    await expect(
      state === 'signing' ? s.markSigning(held, signing()) : s.abandon(held)
    ).rejects.toThrow();
    expect(s.signal.aborted).toBe(true);
    expect(floor).toBe(1);
    const cold = await open(false);
    expect(floor).toBe(2);
    expect(await cold.inspect()).toEqual({
      held: 0,
      signing: state === 'signing' ? 1 : 0,
      abandoned: state === 'abandoned' ? 1 : 0,
      legacy: 0,
    });
    if (state === 'signing') await expect(cold.abandonRecovered(recoveryInput())).rejects.toThrow();
    else await cold.reserve(input());
  }
);
test.each(['signing', 'abandoned'])(
  'rollback of %s transition refuses on cold reopen',
  async (state) => {
    const s = await open(),
      held = await s.reserve(input()),
      before = fs.readFileSync(filename());
    if (state === 'signing') await s.markSigning(held, signing());
    else await s.abandon(held);
    s.close();
    fs.writeFileSync(filename(), before);
    await expect(open(false)).rejects.toThrow();
  }
);
test('cold held recovery owns the phase throughout durable update and always releases it', async () => {
  const s = await open();
  await s.reserve({ ...input(), intentDigest: '0x' + 'a'.repeat(64), poiDigest: 'b'.repeat(64) });
  s.close();
  let claimed = false,
    checks = 0;
  const cold = await open(false, {
    authorizeSigning: () => () => {},
    claimRecovery: () => {
      expect(claimed).toBe(false);
      claimed = true;
      return {
        assertCurrent() {
          expect(claimed).toBe(true);
          checks++;
        },
        release() {
          expect(claimed).toBe(true);
          claimed = false;
        },
      };
    },
    advanceFloor: async (v) => {
      if (v === 2) expect(claimed).toBe(true);
      floor = v;
    },
  });
  await expect(cold.abandonRecovered({ ...recoveryInput(), position: 2 })).rejects.toThrow();
  expect(claimed).toBe(false);
  await cold.abandonRecovered(recoveryInput());
  expect(checks).toBeGreaterThan(3);
  expect(claimed).toBe(false);
  expect(await cold.inspect()).toEqual({ held: 0, signing: 0, abandoned: 1, legacy: 0 });
  await cold.reserve(input());
});
test('busy account recovery refusal does not mutate or close the reservation store', async () => {
  const s = await open(true, {
    authorizeSigning: () => () => {},
    claimRecovery: () => {
      throw Error('phase busy');
    },
  });
  const receipt = await s.reserve(input());
  await expect(s.abandonRecovered(recoveryInput())).rejects.toThrow('phase busy');
  expect((await s.assertReceipt(receipt)).state).toBe('held');
  expect(floor).toBe(1);
});
test('v1 migration preserves facts as legacy holds and never invents signing or release authority', async () => {
  const s = await open();
  await s.reserve(input());
  s.close();
  await createPrivacyStorage(options).update('railgun-private-reservations-v1', (text) => {
    const v = JSON.parse(text);
    v.version = 1;
    v.entries = v.entries.map(({ id, facts }) => ({ id, facts }));
    return JSON.stringify(v);
  });
  const cold = await open(false);
  await expect(cold.abandonRecovered(recoveryInput())).rejects.toThrow();
  await expect(cold.reserve(input())).rejects.toThrow();
  const disk = JSON.parse(
    await createPrivacyStorage(options).get('railgun-private-reservations-v1')
  );
  expect(disk.version).toBe(2);
  expect(disk.entries[0]).toMatchObject({ facts: input(), state: 'legacy', signing: null });
  expect(floor).toBe(1);
});
test.each(['signing', 'abandoned'])(
  'all 512 retained %s entries reach sequence 1024 without freeing capacity',
  async (state) => {
    const s = await open();
    s.close();
    await createPrivacyStorage(options).update('railgun-private-reservations-v1', (text) => {
      const v = JSON.parse(text);
      v.sequence = 1024;
      v.entries = Array.from({ length: 512 }, (_, i) => ({
        id: (i + 1).toString(16).padStart(64, '0'),
        facts: input(i + 1),
        state,
        signing: state === 'signing' ? signing() : null,
      }));
      return JSON.stringify(v);
    });
    const cold = await open(false);
    expect(floor).toBe(1024);
    await expect(cold.reserve(input(513))).rejects.toMatchObject({
      code: 'RAILGUN_RESERVATIONS_CAPACITY',
    });
    expect(await cold.inspect()).toEqual({
      held: 0,
      signing: state === 'signing' ? 512 : 0,
      abandoned: state === 'abandoned' ? 512 : 0,
      legacy: 0,
    });
  }
);
test.each([
  (v) => {
    v.entries[0].state = 'resolved';
  },
  (v) => {
    v.entries[0].state = 'signing';
    v.sequence++;
  },
  (v) => {
    v.entries[0].signing = signing();
  },
  (v) => {
    v.entries[0].state = 'abandoned';
  },
  (v) => {
    v.sequence = 1025;
  },
])('invalid state or sequence refuses on open (%#)', async (corrupt) => {
  const s = await open();
  await s.reserve(input());
  s.close();
  await createPrivacyStorage(options).update('railgun-private-reservations-v1', (text) => {
    const v = JSON.parse(text);
    corrupt(v);
    return JSON.stringify(v);
  });
  await expect(open(false)).rejects.toThrow();
});
test.each([
  { submitter: '0x' + '0'.repeat(40) },
  { operationId: 'short' },
  { gatesDigest: 'A'.repeat(64) },
  { extra: true },
])('invalid signing evidence never changes the hold (%#)', async (invalid) => {
  const s = await open(),
    receipt = await s.reserve(input());
  expect(() => s.markSigning(receipt, { ...signing(), ...invalid })).toThrow();
  expect((await s.assertReceipt(receipt)).state).toBe('held');
  expect(floor).toBe(1);
});

test('recovery receipts expire after callback and distinguish operation receipts', async () => {
  const s = await open(),
    operation = await s.markSigning(await s.reserve(input()), signing());
  expect(() => s.assertReceiptContext(operation, 'operation')).not.toThrow();
  let retained;
  await s.withSigningRecovery(async (records) => {
    retained = records[0].receipt;
    expect(() => s.assertReceiptContext(retained, 'recovery')).not.toThrow();
    expect(() => s.assertReceiptContext(retained, 'operation')).toThrow();
    expect((await s.assertReceipt(retained)).state).toBe('signing');
    return { status: 'refused' };
  });
  await expect(s.assertReceipt(retained)).rejects.toThrow();
  expect(() => s.assertReceiptContext(retained, 'recovery')).toThrow();
  expect((await s.assertReceipt(operation)).state).toBe('signing');
});
test('expiry revokes recovery receipts but holds the account phase until the callback drains', async () => {
  jest.useFakeTimers();
  let released = false,
    observed = false,
    finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  try {
    const s = await open(true, {
      claimRecovery: () => ({
        assertCurrent() {},
        release() {
          released = true;
        },
      }),
    });
    await s.markSigning(await s.reserve(input()), signing());
    const pending = s.withSigningRecovery(
      async (records, context) => {
        observed = true;
        await new Promise((resolve) =>
          context.signal.addEventListener('abort', resolve, { once: true })
        );
        expect(() => s.assertReceiptContext(records[0].receipt, 'recovery')).toThrow();
        expect(released).toBe(false);
        await done;
      },
      { timeoutMs: 10 }
    );
    const rejected = expect(pending).rejects.toThrow();
    for (let i = 0; i < 20 && !observed; i++) await Promise.resolve();
    expect(observed).toBe(true);
    await jest.advanceTimersByTimeAsync(11);
    expect(released).toBe(false);
    finish();
    await rejected;
    expect(released).toBe(true);
    expect(s.signal.aborted).toBe(true);
  } finally {
    finish();
    jest.useRealTimers();
  }
});

test('availability checks are local and repeatable, never a reservation grant', async () => {
  const s = await open();
  const { tree, position, nullifier, noteHash } = input();
  const selected = { tree, position, nullifier, noteHash };
  await s.assertAvailable(selected);
  await s.assertAvailable(selected);
  expect(await s.inspect()).toEqual({ held: 0, signing: 0, abandoned: 0, legacy: 0 });
  const receipt = await s.reserve(input());
  await expect(s.assertAvailable(selected)).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
  });
  await s.assertAvailable({ ...selected, tree: 1 });
  await s.abandon(receipt);
  await s.assertAvailable(selected);
});

test('partial holds share encrypted v2 durability, nullifier exclusion and cold signing recovery with legacy entries', async () => {
  const s = await open();
  const legacy = await s.reserve(input());
  const legacyEntry = await s.assertReceipt(legacy);
  const facts = { ...input(2), kind: 'railgun-partial-unshield' };
  const held = await s.reserve(facts);
  const signed = await s.markSigning(held, signing());
  const partial = await s.assertReceipt(signed);
  expect(partial.facts).toEqual(facts);
  expect(partial.state).toBe('signing');
  await expect(s.abandon(signed)).rejects.toThrow();
  await expect(s.reserve({ ...facts, kind: 'railgun-token-unshield' })).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
  });
  expect(await s.assertReceipt(legacy)).toEqual(legacyEntry);
  const document = JSON.parse(
    await createPrivacyStorage(options).get('railgun-private-reservations-v1')
  );
  expect(document.version).toBe(2);
  expect(document.sequence).toBe(3);
  expect(document.entries).toEqual([legacyEntry, partial]);
  const minimum = floor;
  s.close();
  const cold = await open(false);
  expect(await cold.inspect()).toEqual({ held: 1, signing: 1, abandoned: 0, legacy: 0 });
  expect(floor).toBe(minimum);
  const reopened = JSON.parse(
    await createPrivacyStorage(options).get('railgun-private-reservations-v1')
  );
  expect(reopened.entries).toEqual(document.entries);
  expect(reopened.sequence).toBe(document.sequence);
  await expect(
    cold.abandonRecovered({
      tree: facts.tree,
      position: facts.position,
      nullifier: facts.nullifier,
      noteHash: facts.noteHash,
    })
  ).rejects.toMatchObject({ code: 'RAILGUN_RESERVATION_NOT_RECOVERABLE' });
});
test('partial reservation does not admit unknown kind or malformed facts', async () => {
  const s = await open();
  for (const value of [
    { ...input(), kind: 'railgun-partial-unshield', unshieldAmount: '1' },
    { ...input(), kind: 'partial' },
  ])
    await expect(s.reserve(value)).rejects.toThrow();
  expect(await s.inspect()).toEqual({ held: 0, signing: 0, abandoned: 0, legacy: 0 });
});
