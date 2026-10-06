let mockFencedOwners = new WeakSet();
jest.mock('./railgun-account-enrollment', () => ({
  assertRailgunFencedAccountEnrollment: (owner) => {
    if (!mockFencedOwners.has(owner)) throw Error('fenced enrollment refused');
  },
}));
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
  mockFencedOwners = new WeakSet();
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
  expect(await s.assertReceipt(receipt)).toBe(await s.assertReceipt(receipt));
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

// Issuer seam for the inactive cooperative store mode. These tests use genuine
// privacy contexts and encrypted storage, not native enrollment/SQLite custody.
function cooperativeOptions() {
  const owner = Object.freeze({
    directory: options.directory,
    binding: options.binding,
    descriptor: Object.freeze({ walletId: options.walletId }),
    getContext: (role, operation) => {
      if (role !== 'storage' || operation !== 'railgun-private-reservations-v1:' + options.walletId)
        throw Error('context');
      return options.handle;
    },
  });
  mockFencedOwners.add(owner);
  return { enrollment: owner };
}
const typedFloor = (sequence) => ({
  version: 4,
  binding: options.binding,
  walletId: options.walletId,
  sequence,
});
const selectedInput = (n = 1) => {
  const { tree, position, nullifier, noteHash } = input(n);
  return { tree, position, nullifier, noteHash };
};
const relayInput = (n = 1) => {
  const { tree, position, nullifier, noteHash, checkpointHash } = input(n);
  return {
    tree,
    position,
    nullifier,
    noteHash,
    checkpointHash,
    kind: 'railgun-relay-self-transfer',
    draftDigest: 'a'.repeat(64),
    expectedHash: '0x' + '1'.repeat(64),
  };
};
async function writeDocument(document) {
  await createPrivacyStorage(options).update('railgun-private-reservations-v1', () =>
    JSON.stringify(document)
  );
}
async function readDocument() {
  return JSON.parse(await createPrivacyStorage(options).get('railgun-private-reservations-v1'));
}
async function mixedDocument(extra = cooperativeOptions()) {
  const codec = require('./railgun-reservation-ledger').createRailgunReservationLedgerCodec({
    enrollment: extra.enrollment,
    binding: options.binding,
    walletId: options.walletId,
  });
  let text = codec.create('7'.repeat(64));
  text = codec.apply(text, { type: 'reserve-private', id: '1'.repeat(64), facts: input(1) });
  text = codec.apply(text, {
    type: 'mark-private-signing',
    id: '1'.repeat(64),
    signing: signing(),
  });
  text = codec.apply(text, { type: 'reserve-relay', id: '2'.repeat(64), facts: relayInput(2) });
  text = codec.apply(text, {
    type: 'mark-relay-signing',
    id: '2'.repeat(64),
    signing: { gatesDigest: '8'.repeat(64), recordDigest: '9'.repeat(64) },
  });
  text = codec.apply(text, { type: 'reserve-relay', id: '3'.repeat(64), facts: relayInput(3) });
  const document = JSON.parse(text);
  await writeDocument(document);
  floor = typedFloor(document.sequence);
  return { extra, document, codec };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('cooperative factory authenticates exact issuer and context before paths or storage', async () => {
  const extra = cooperativeOptions();
  const realpath = jest.spyOn(fs, 'realpathSync');
  for (const patch of [
    { enrollment: { ...extra.enrollment } },
    { binding: 'a'.repeat(64) },
    { walletId: 'b'.repeat(64) },
    { directory: options.directory + '-other' },
    {
      handle: scope.getContext({
        ...require('../networks/privacy-context').getPrivacyContext(options.handle).subject,
        principal: 'railgun:1',
      }),
    },
  ]) {
    await expect(open(true, { ...extra, ...patch })).rejects.toThrow();
  }
  expect(realpath).not.toHaveBeenCalled();
  expect(fs.readdirSync(options.directory)).toEqual([]);
});

test('cooperative private operations write v4, typed floors and preserve old private receipt shape', async () => {
  const extra = cooperativeOptions(),
    calls = [];
  const s = await open(true, {
    ...extra,
    advanceFloor: async (value) => {
      const document = await readDocument();
      expect(document.version).toBe(4);
      expect(document.sequence).toBe(value.sequence);
      calls.push(value);
      floor = value;
    },
  });
  expect(floor).toEqual(typedFloor(0));
  const receipt = await s.reserve(input());
  expect(Object.keys(await s.assertReceipt(receipt))).toEqual(['id', 'facts', 'state', 'signing']);
  expect((await readDocument()).entries[0].origin).toBe('private');
  const signed = await s.markSigning(receipt, signing());
  expect((await s.assertReceipt(signed)).state).toBe('signing');
  expect(calls.map((v) => v.sequence)).toEqual([0, 1, 2]);
  expect(floor).toEqual(typedFloor(2));
  expect(Object.keys(s)).toEqual(
    expect.arrayContaining(['reserveRelay', 'readRelay', 'markRelaySigning', 'discardRelayLocal'])
  );
  await expect(s.readRelay({}, 'f'.repeat(64))).rejects.toThrow();
  s.close();
  await expect(open(false)).rejects.toThrow();
  const cold = await open(false, extra);
  expect(await cold.inspect()).toEqual({ held: 0, signing: 1, abandoned: 0, legacy: 0 });
});

test.each([1, 2, 3])(
  'cooperative opening upgrades version %i and its numeric floor before receipts',
  async (version) => {
    const extra = cooperativeOptions();
    const entry = {
      id: '1'.repeat(64),
      facts: version === 3 ? relayInput() : input(),
      ...(version === 1 ? {} : { state: version === 3 ? 'abandoned' : 'held', signing: null }),
    };
    const sequence = version === 3 ? 2 : 1;
    await writeDocument({
      version,
      binding: options.binding,
      walletId: options.walletId,
      lease: '7'.repeat(64),
      sequence,
      entries: [entry],
    });
    floor = sequence;
    const s = await open(false, extra);
    const document = await readDocument();
    expect(document.version).toBe(4);
    expect(floor).toEqual(typedFloor(sequence));
    expect(document.entries[0].origin).toBe(version === 3 ? 'relay-v3-never-signed' : 'private');
    expect(document.entries[0].state).toBe(
      version === 1 ? 'legacy' : version === 3 ? 'cancelled-unsigned' : 'held'
    );
    if (version === 3) await s.assertAvailable(selectedInput());
  }
);

test('v4 document with numeric floor completes only historical/private migration', async () => {
  const extra = cooperativeOptions();
  const s = await open(true, extra);
  await s.reserve(input());
  s.close();
  floor = 0;
  (await open(false, extra)).close();
  expect(floor).toEqual(typedFloor(1));
  const { document } = await mixedDocument(extra);
  floor = document.sequence;
  const before = fs.readFileSync(filename());
  await expect(open(false, extra)).rejects.toThrow();
  expect(fs.readFileSync(filename())).toEqual(before);
});

test('typed floor repairs a postrename lag but ahead floor or typed-floor old document refuses before writes', async () => {
  const { extra, document } = await mixedDocument();
  floor = typedFloor(document.sequence - 1);
  (await open(false, extra)).close();
  expect(floor).toEqual(typedFloor(document.sequence));
  floor = typedFloor(document.sequence + 1);
  let before = fs.readFileSync(filename());
  await expect(open(false, extra)).rejects.toThrow();
  expect(fs.readFileSync(filename())).toEqual(before);
  await writeDocument({
    version: 2,
    binding: options.binding,
    walletId: options.walletId,
    lease: '7'.repeat(64),
    sequence: 0,
    entries: [],
  });
  floor = typedFloor(0);
  before = fs.readFileSync(filename());
  await expect(open(false, extra)).rejects.toThrow();
  expect(fs.readFileSync(filename())).toEqual(before);
});

test('cooperative existing missing floor and new document with existing floor both refuse', async () => {
  const extra = cooperativeOptions();
  floor = typedFloor(0);
  await expect(open(true, extra)).rejects.toThrow();
  expect(fs.readdirSync(options.directory)).toEqual([]);
  floor = null;
  (await open(true, extra)).close();
  floor = null;
  const before = fs.readFileSync(filename());
  await expect(open(false, extra)).rejects.toThrow();
  expect(fs.readFileSync(filename())).toEqual(before);
});

test.each(['lower', 'higher', 'wrong-wallet', 'wrong-binding', 'extra', 'getter', 'proxy'])(
  'ordinary cooperative attest refuses %s floor without invoking accessors',
  async (kind) => {
    const s = await open(true, cooperativeOptions());
    await s.reserve(input());
    const getter = jest.fn();
    floor = typedFloor(1);
    if (kind === 'lower') floor.sequence = 0;
    if (kind === 'higher') floor.sequence = 2;
    if (kind === 'wrong-wallet') floor.walletId = 'a'.repeat(64);
    if (kind === 'wrong-binding') floor.binding = 'b'.repeat(64);
    if (kind === 'extra') floor.extra = true;
    if (kind === 'getter')
      Object.defineProperty(floor, 'sequence', { enumerable: true, get: getter });
    if (kind === 'proxy')
      floor = new Proxy(floor, {
        // The trusted async producer's Promise resolution checks .then itself.
        get: (target, key) => (key === 'then' ? undefined : getter()),
        ownKeys: getter,
        getPrototypeOf: getter,
      });
    await expect(s.inspect()).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(s.signal.aborted).toBe(true);
  }
);

test('mixed origins conflict together but only private rows enter receipts/recovery/counts', async () => {
  const { extra, document } = await mixedDocument();
  const s = await open(false, extra);
  expect(await s.inspect()).toEqual({ held: 0, signing: 1, abandoned: 0, legacy: 0 });
  await expect(s.reserve(input(2))).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
  });
  await expect(s.assertAvailable(selectedInput(3))).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
  });
  await expect(s.abandonRecovered(selectedInput(3))).rejects.toMatchObject({
    code: 'RAILGUN_RESERVATION_NOT_RECOVERABLE',
  });
  await s.withSigningRecovery(async (records) => {
    expect(records).toHaveLength(1);
    expect(records[0].entry.facts).toEqual(input());
    expect(records[0].entry).not.toHaveProperty('origin');
    expect((await s.assertReceipt(records[0].receipt)).state).toBe('signing');
  });
  const receipt = await s.reserve(input(4));
  await s.abandon(receipt);
  const next = await readDocument();
  expect(next.entries.slice(0, 3)).toEqual(document.entries);
  expect(next.sequence).toBe(document.sequence + 2);
});

test('cooperative availability budgets future transitions even with fewer than 512 rows', async () => {
  const extra = cooperativeOptions();
  const entries = Array.from({ length: 341 }, (_, i) => ({
    id: (i + 1).toString(16).padStart(64, '0'),
    origin: 'relay-local-v4',
    facts: relayInput(i + 1),
    state: 'held',
    signing: null,
  }));
  await writeDocument({
    version: 4,
    binding: options.binding,
    walletId: options.walletId,
    lease: '7'.repeat(64),
    sequence: 341,
    entries,
  });
  floor = typedFloor(341);
  const s = await open(false, extra);
  await expect(s.assertAvailable(selectedInput(400))).rejects.toMatchObject({
    code: 'RAILGUN_RESERVATIONS_CAPACITY',
  });
  await expect(s.reserve(input(400))).rejects.toMatchObject({
    code: 'RAILGUN_RESERVATIONS_CAPACITY',
  });
  expect(s.signal.aborted).toBe(false);
});

test('close retains same-path writer ownership until an admitted floor read settles', async () => {
  let gate;
  const entered = deferred();
  const s = await open(true, {
    readFloor: async () => {
      if (gate) {
        entered.resolve();
        await gate.promise;
      }
      return floor;
    },
  });
  gate = deferred();
  const pending = s.inspect();
  const refused = expect(pending).rejects.toThrow();
  await entered.promise;
  s.close();
  await expect(open(false)).rejects.toThrow();
  gate.resolve();
  await refused;
  expect(await (await open(false)).inspect()).toEqual({
    held: 0,
    signing: 0,
    abandoned: 0,
    legacy: 0,
  });
});

test('close during opening retains same-path ownership until original floor callback settles', async () => {
  const gate = deferred(),
    entered = deferred();
  const pending = open(true, {
    readFloor: async () => {
      entered.resolve();
      await gate.promise;
      return floor;
    },
  });
  const refused = expect(pending).rejects.toThrow();
  await entered.promise;
  const subject = require('../networks/privacy-context').getPrivacyContext(options.handle).subject;
  scope.close();
  scope = createPrivacyScope({
    profileId: 'reservation-test',
    signal: new AbortController().signal,
  });
  options.handle = scope.getContext(subject);
  await expect(open()).rejects.toThrow();
  gate.resolve();
  await refused;
  await open();
});

test('recovery keeps phase and writer while unawaited nested admitted work drains', async () => {
  let hold = false;
  const gate = deferred(),
    entered = deferred(),
    release = jest.fn();
  const s = await open(true, {
    claimRecovery: () => ({ assertCurrent() {}, release }),
    readFloor: async () => {
      if (hold) {
        entered.resolve();
        await gate.promise;
      }
      return floor;
    },
  });
  let nested;
  const pending = s.withSigningRecovery(async () => {
    hold = true;
    nested = s.inspect().catch((error) => error);
    await entered.promise;
  });
  await expect(pending).rejects.toThrow();
  expect(release).not.toHaveBeenCalled();
  await expect(open(false)).rejects.toThrow();
  gate.resolve();
  expect(await nested).toBeInstanceOf(Error);
  expect(release).toHaveBeenCalledTimes(1);
  await open(false);
});

test.each(['thenable', 'constructor'])(
  'unobservable %s recovery callback permanently retains phase and path',
  async (kind) => {
    const release = jest.fn(),
      then = jest.fn();
    const s = await open(true, { claimRecovery: () => ({ assertCurrent() {}, release }) });
    let result;
    if (kind === 'thenable') result = { then };
    else {
      result = Promise.resolve();
      Object.defineProperty(result, 'constructor', {
        get() {
          throw Error('unobservable');
        },
      });
    }
    await expect(s.withSigningRecovery(() => result)).rejects.toMatchObject({
      code: 'RAILGUN_RESERVATIONS_DRAIN_UNOBSERVED',
    });
    expect(then).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    await expect(open(false)).rejects.toThrow();
  }
);

test.each([
  'reserve',
  'assertAvailable',
  'assertReceipt',
  'markSigning',
  'abandon',
  'abandonRecovered',
  'withSigningRecovery',
])(
  'close during admitted %s preserves writer until original floor read settles',
  async (method) => {
    let held = false;
    const gate = deferred(),
      entered = deferred(),
      release = jest.fn();
    const s = await open(true, {
      readFloor: async () => {
        if (held) {
          entered.resolve();
          await gate.promise;
        }
        return floor;
      },
      claimRecovery: () => ({ assertCurrent() {}, release }),
    });
    const receipt = await s.reserve(input());
    held = true;
    const pending =
      method === 'reserve'
        ? s.reserve(input(2))
        : method === 'assertAvailable'
          ? s.assertAvailable(selectedInput(2))
          : method === 'assertReceipt'
            ? s.assertReceipt(receipt)
            : method === 'markSigning'
              ? s.markSigning(receipt, signing())
              : method === 'abandon'
                ? s.abandon(receipt)
                : method === 'abandonRecovered'
                  ? s.abandonRecovered(selectedInput())
                  : s.withSigningRecovery(async () => {});
    const refused = expect(pending).rejects.toThrow();
    await entered.promise;
    s.close();
    expect(release).not.toHaveBeenCalled();
    await expect(open(false)).rejects.toThrow();
    gate.resolve();
    await refused;
    if (['abandonRecovered', 'withSigningRecovery'].includes(method))
      expect(release).toHaveBeenCalledTimes(1);
    await open(false);
  }
);

test('post-write pending floor completion retains exclusion after close until original settlement', async () => {
  let held = false;
  const gate = deferred(),
    entered = deferred();
  const s = await open(true, {
    advanceFloor: async (value) => {
      if (held) {
        entered.resolve();
        await gate.promise;
      }
      floor = value;
    },
  });
  held = true;
  const pending = s.reserve(input()),
    refused = expect(pending).rejects.toThrow();
  await entered.promise;
  expect((await readDocument()).sequence).toBe(1);
  s.close();
  await expect(open(false)).rejects.toThrow();
  gate.resolve();
  await refused;
  expect((await (await open(false)).inspect()).held).toBe(1);
});

test('unobservable floor during recovery retains the account phase and writer even after local rejection', async () => {
  let broken = false;
  const release = jest.fn();
  const s = await open(true, {
    readFloor: () => {
      const value = Promise.resolve(floor);
      if (broken)
        Object.defineProperty(value, 'constructor', {
          get() {
            throw Error('unknown');
          },
        });
      return value;
    },
    claimRecovery: () => ({ assertCurrent() {}, release }),
  });
  await s.reserve(input());
  broken = true;
  await expect(s.abandonRecovered(selectedInput())).rejects.toMatchObject({
    code: 'RAILGUN_RESERVATIONS_DRAIN_UNOBSERVED',
  });
  expect(release).not.toHaveBeenCalled();
  await expect(open(false)).rejects.toThrow();
});

test('ordinary synchronous legacy floor, advance and recovery return values remain supported', async () => {
  const s = await open(true, {
    readFloor: () => floor,
    advanceFloor: (value) => {
      floor = value;
    },
  });
  const receipt = await s.reserve(input());
  expect((await s.assertReceipt(receipt)).state).toBe('held');
  expect(await s.withSigningRecovery(() => ({ done: true }))).toEqual({ done: true });
  await s.abandon(receipt);
  expect(floor).toBe(2);
});

test.each(['own-getter', 'inherited-getter', 'inherited-then', 'proxy-prototype'])(
  'synchronous %s completion refuses without invoking accessors and retains owner',
  async (kind) => {
    const effect = jest.fn(),
      release = jest.fn();
    const s = await open(true, { claimRecovery: () => ({ assertCurrent() {}, release }) });
    let result;
    if (kind === 'own-getter') result = Object.defineProperty({}, 'then', { get: effect });
    if (kind === 'inherited-getter')
      result = Object.create(Object.defineProperty({}, 'then', { get: effect }));
    if (kind === 'inherited-then') result = Object.create({ then: effect });
    if (kind === 'proxy-prototype')
      result = Object.create(
        new Proxy({}, { get: effect, getOwnPropertyDescriptor: effect, getPrototypeOf: effect })
      );
    await expect(s.withSigningRecovery(() => result)).rejects.toMatchObject({
      code: 'RAILGUN_RESERVATIONS_DRAIN_UNOBSERVED',
    });
    expect(effect).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    await expect(open(false)).rejects.toThrow();
  }
);

test('synchronous callback exception is settled, closes recovery and releases phase and writer', async () => {
  const release = jest.fn(),
    error = Error('completed failure');
  const s = await open(true, { claimRecovery: () => ({ assertCurrent() {}, release }) });
  await expect(
    s.withSigningRecovery(() => {
      throw error;
    })
  ).rejects.toBe(error);
  expect(release).toHaveBeenCalledTimes(1);
  expect(s.signal.aborted).toBe(true);
  await open(false);
});

test.each([false, true])(
  'trusted original recovery rejection unknown=%s retains only unknown writer and phase',
  async (unknown) => {
    const release = jest.fn();
    const s = await open(true, { claimRecovery: () => ({ assertCurrent() {}, release }) });
    let rejectOriginal, entered;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const original = new Promise((_resolve, reject) => {
      rejectOriginal = reject;
    });
    const error = Object.assign(Error('fixed verifier failure'), {
      code: unknown ? 'RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED' : 'RAILGUN_NOTE_PROVENANCE_REFUSED',
    });
    let settled = false;
    const work = s
      .withSigningRecovery(() => {
        entered();
        return original;
      })
      .catch((e) => {
        settled = true;
        return e;
      });
    await ready;
    expect(settled).toBe(false);
    expect(release).not.toHaveBeenCalled();
    rejectOriginal(error);
    expect(await work).toBe(error);
    if (unknown) {
      expect(release).not.toHaveBeenCalled();
      await expect(open(false)).rejects.toThrow();
      await expect(s.withSigningRecovery(() => 'no authority')).rejects.toThrow();
    } else {
      expect(release).toHaveBeenCalledTimes(1);
      await expect(open(false)).resolves.toBeDefined();
    }
  }
);
