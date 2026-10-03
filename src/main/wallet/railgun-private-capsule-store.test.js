const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { Interface, AbiCoder, keccak256 } = require('ethers');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const { createRailgunPrivateReservations } = require('./railgun-private-reservations');
const {
  createRailgunPrivateCapsuleStore,
  isRailgunPrivateCapsuleStore,
} = require('./railgun-private-capsule-store');
const { TRANSACT_ABI, BOUND_PARAMS } = require('./railgun-private-policy');
const { validateRailgunPrivateSigningIntent } = require('./railgun-private-intent');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const field = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const abi = new Interface([TRANSACT_ABI]);
const signature = { R8: [hex(1), hex(2)], S: hex(3) };
const signing = {
  submitter: '0x' + '12'.repeat(20),
  operationId: '8'.repeat(64),
  gatesDigest: '9'.repeat(64),
};
let scope, reservations, stores, options, floor;
function capsule(n = 1) {
  const recipient = '0x' + '12'.repeat(20),
    kind = 'railgun-token-unshield';
  const bound = [0, 0, 1, pins.chainId, '0x' + '0'.repeat(40), hex(0), []];
  const tx = [
    [
      [0, 0],
      [
        [0, 0],
        [0, 0],
      ],
      [0, 0],
    ],
    hex(1),
    [hex(n)],
    [hex(3)],
    bound,
    [hex(BigInt(recipient)), [0, pins.wrappedNative, 0], 1000],
  ];
  return {
    version: 1,
    walletId: options.walletId,
    engineSha256: '7'.repeat(64),
    selection: { kind, tree: 0, position: n, recipient },
    noteHash: hex(5),
    pathElements: Array(16).fill(hex(6)),
    preparation: {
      transaction: {
        chainId: pins.chainId,
        to: pins.proxy,
        value: '0',
        data: abi.encodeFunctionData('transact', [[tx]]),
      },
      expected: {
        kind,
        tree: 0,
        merkleRoot: hex(1),
        nullifier: hex(n),
        commitment: hex(3),
        boundParamsHash: hex(
          BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bound]))) % field
        ),
        recipient,
        amount: '1000',
      },
      expectedHash: hex(4),
      recipient,
      amount: '1000',
    },
  };
}
async function hold(c, overrides = {}) {
  return reservations.reserve({
    tree: c.selection.tree,
    position: c.selection.position,
    nullifier: c.preparation.expected.nullifier,
    noteHash: c.noteHash,
    kind: c.selection.kind,
    intentDigest: validateRailgunPrivateSigningIntent(
      c.preparation.transaction,
      c.preparation.expected
    ).digest,
    checkpointHash: 'a'.repeat(64),
    poiDigest: 'b'.repeat(64),
    ...overrides,
  });
}
async function open(create = true, extra = {}) {
  const s = await createRailgunPrivateCapsuleStore({ ...options, create, ...extra });
  stores.push(s);
  return s;
}
const filename = () => getPrivacyStoragePath(options.handle, options.directory);
beforeEach(async () => {
  stores = [];
  floor = null;
  scope = createPrivacyScope({
    profileId: 'capsule-store-fixture',
    signal: new AbortController().signal,
  });
  const walletId = '5'.repeat(64),
    subject = {
      kind: 'private-account',
      principal: 'railgun:0',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      role: 'storage',
    };
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-capsules-')));
  let reservationFloor = null;
  reservations = await createRailgunPrivateReservations({
    handle: scope.getContext({
      ...subject,
      operation: 'railgun-private-reservations-v1:' + walletId,
    }),
    directory,
    key: Buffer.alloc(32, 6),
    binding: '6'.repeat(64),
    walletId,
    create: true,
    readFloor: async () => reservationFloor,
    advanceFloor: async (v) => {
      reservationFloor = v;
    },
    authorizeSigning: (permit, heldStore, receipt, evidence) =>
      require('./railgun-private-capsule-store').consumeRailgunCapsuleSigningPermit(
        permit,
        stores.at(-1),
        heldStore,
        receipt,
        evidence
      ),
    claimRecovery: () => ({ assertCurrent() {}, release() {} }),
  });
  options = {
    handle: scope.getContext({ ...subject, operation: 'railgun-private-capsules-v1:' + walletId }),
    directory,
    key: Buffer.alloc(32, 7),
    binding: '6'.repeat(64),
    walletId,
    reservations,
    readFloor: async () => floor,
    advanceFloor: async (v) => {
      if (floor !== null && v < floor) throw Error('rollback');
      floor = v;
    },
  };
});
afterEach(() => {
  stores.forEach((s) => s.close());
  reservations.close();
  scope.close();
  jest.restoreAllMocks();
});
test('binds a durable intent to its hold, then fills signature and transaction once', async () => {
  const s = await open(),
    c = capsule(),
    r = await hold(c),
    entry = await s.put(r, c, signing.gatesDigest);
  expect(isRailgunPrivateCapsuleStore(s)).toBe(true);
  expect(isRailgunPrivateCapsuleStore({ ...s })).toBe(false);
  expect((await s.put(r, c, signing.gatesDigest)).capsuleDigest).toBe(entry.capsuleDigest);
  expect(floor).toBe(1);
  expect(Object.isFrozen(entry.capsule.pathElements)).toBe(true);
  const signed = await s.markSigning(r, signing);
  const saved = await s.saveSignature(signed, signature);
  expect(saved.signingDigest).toMatch(/^[0-9a-f]{64}$/);
  await s.saveSignature(signed, signature);
  expect(floor).toBe(2);
  const tx = abi.decodeFunctionData('transact', c.preparation.transaction.data)[0][0].toArray(true);
  tx[0][0][0] = 1n;
  const proved = { ...c.preparation.transaction, data: abi.encodeFunctionData('transact', [[tx]]) };
  await s.saveProvedTransaction(signed, proved);
  await s.saveProvedTransaction(signed, proved);
  expect(floor).toBe(3);
  expect(await s.inspect()).toEqual({ records: 1, signatures: 1, proofs: 1, capacity: 32 });
  const text = fs.readFileSync(filename(), 'utf8');
  expect(text).not.toContain(entry.holdId);
  expect(text).not.toContain(c.preparation.transaction.data);
  s.close();
  const cold = await open(false);
  expect((await cold.get(entry.holdId)).provedTransaction).toEqual(proved);
  await expect(cold.saveSignature(signed, { ...signature, S: hex(4) })).rejects.toMatchObject({
    code: 'RAILGUN_CAPSULE_CONFLICT',
  });
  expect(cold.signal.aborted).toBe(false);
});
test('substitution of a held input, recipient or note refuses before storage', async () => {
  const s = await open(),
    c = capsule(),
    r = await hold(c);
  c.noteHash = hex(8);
  await expect(s.put(r, c, signing.gatesDigest)).rejects.toThrow();
  expect(floor).toBe(0);
  expect(s.signal.aborted).toBe(true);
});
test('copies caller state and preserves every unrelated record through fills', async () => {
  const s = await open(),
    a = capsule(),
    b = capsule(2),
    ra = await hold(a),
    rb = await hold(b);
  const ea = await s.put(ra, a, signing.gatesDigest),
    eb = await s.put(rb, b, signing.gatesDigest);
  a.pathElements[0] = hex(9);
  const original = JSON.stringify(await s.get(eb.holdId));
  await s.saveSignature(await s.markSigning(ra, signing), signature);
  expect(JSON.stringify(await s.get(eb.holdId))).toBe(original);
  expect((await s.get(ea.holdId)).capsule.pathElements[0]).toBe(hex(6));
});
test.each(['signature-before-signing', 'proof-before-signature', 'changed-proof'])(
  '%s refuses without granting partial state',
  async (mode) => {
    const s = await open(),
      c = capsule(),
      r = await hold(c);
    await s.put(r, c, signing.gatesDigest);
    if (mode === 'signature-before-signing')
      await expect(s.saveSignature(r, signature)).rejects.toThrow();
    else {
      const signed = await s.markSigning(r, signing);
      if (mode === 'changed-proof') await s.saveSignature(signed, signature);
      await expect(
        s.saveProvedTransaction(signed, {
          ...c.preparation.transaction,
          to: '0x' + '34'.repeat(20),
        })
      ).rejects.toThrow();
    }
    expect(s.signal.aborted).toBe(true);
  }
);
test('write-before-floor failure recovers the retained record and advances the floor on reopen', async () => {
  let fail = false;
  const s = await open(true, {
      advanceFloor: async (v) => {
        if (fail) throw Error('interrupted');
        floor = v;
      },
    }),
    c = capsule(),
    r = await hold(c);
  fail = true;
  await expect(s.put(r, c, signing.gatesDigest)).rejects.toThrow('interrupted');
  expect(floor).toBe(0);
  const cold = await open(false);
  expect((await cold.inspect()).records).toBe(1);
  expect(floor).toBe(1);
  expect((await cold.get((await reservations.assertReceipt(r)).id)).capsule).toEqual(c);
});
test.each(['rollback', 'missing'])(
  'old or %s storage cannot recreate an empty account',
  async (mode) => {
    const s = await open(),
      old = fs.readFileSync(filename()),
      c = capsule();
    await s.put(await hold(c), c, signing.gatesDigest);
    s.close();
    if (mode === 'rollback') fs.writeFileSync(filename(), old);
    else fs.renameSync(filename(), filename() + '.retained');
    await expect(open(mode === 'missing')).rejects.toThrow();
    expect(floor).toBe(1);
  }
);
test('live replay, wrong binding, foreign key and duplicate owners refuse', async () => {
  const s = await open(),
    old = fs.readFileSync(filename()),
    c = capsule();
  await s.put(await hold(c), c, signing.gatesDigest);
  await expect(open(false)).rejects.toThrow();
  fs.writeFileSync(filename(), old);
  await expect(s.inspect()).rejects.toThrow();
  expect(s.signal.aborted).toBe(true);
  await expect(open(false, { binding: 'f'.repeat(64) })).rejects.toThrow();
  await expect(open(false, { key: Buffer.alloc(32, 8) })).rejects.toThrow();
});
test('capacity retains unused history and refuses new records without closing the store', async () => {
  const s = await open();
  for (let i = 1; i <= 32; i++) {
    const c = capsule(i);
    await s.put(await hold(c), c, signing.gatesDigest);
  }
  const c = capsule(33);
  await expect(s.put(await hold(c), c, signing.gatesDigest)).rejects.toMatchObject({
    code: 'RAILGUN_CAPSULE_STORE_CAPACITY',
  });
  expect(await s.inspect()).toEqual({ records: 32, signatures: 0, proofs: 0, capacity: 32 });
  expect(floor).toBe(32);
});
test('concurrent writers and cancelled reservation lifetime cannot mutate recovery data', async () => {
  const s = await open(),
    c = capsule(),
    r = await hold(c),
    first = s.put(r, c, signing.gatesDigest);
  await expect(s.put(r, c, signing.gatesDigest)).rejects.toThrow();
  await first;
  reservations.close();
  await expect(s.inspect()).rejects.toThrow();
  expect(s.signal.aborted).toBe(true);
});
test('tampered sequence and malformed nested data cannot reopen', async () => {
  const s = await open(),
    c = capsule();
  await s.put(await hold(c), c, signing.gatesDigest);
  s.close();
  await createPrivacyStorage(options).update('railgun-private-capsules-v1', (text) => {
    const v = JSON.parse(text);
    v.sequence = 2;
    return JSON.stringify(v);
  });
  await expect(open(false)).rejects.toThrow();
});

test('genuine reservations from a different directory or account cannot back the store', async () => {
  const foreignDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-foreign-capsules-'))
  );
  await expect(open(true, { directory: foreignDirectory })).rejects.toThrow();
  await expect(open(true, { binding: 'f'.repeat(64) })).rejects.toThrow();
  await expect(open(true, { reservations: { ...reservations } })).rejects.toThrow();
  expect(await (await open()).inspect()).toEqual({
    records: 0,
    signatures: 0,
    proofs: 0,
    capacity: 32,
  });
});

test.each(['signature', 'proof'])(
  'interrupted %s fill remains recoverable and cannot be overwritten',
  async (mode) => {
    let interrupted = false;
    const s = await open(true, {
      advanceFloor: async (value) => {
        if (interrupted) throw Error('floor interrupted');
        floor = value;
      },
    });
    const c = capsule(),
      held = await hold(c),
      entry = await s.put(held, c, signing.gatesDigest);
    const signed = await s.markSigning(held, signing);
    if (mode === 'proof') await s.saveSignature(signed, signature);
    const previousFloor = floor;
    interrupted = true;
    const write =
      mode === 'signature'
        ? s.saveSignature(signed, signature)
        : s.saveProvedTransaction(signed, c.preparation.transaction);
    await expect(write).rejects.toThrow('floor interrupted');
    expect(floor).toBe(previousFloor);
    const cold = await open(false),
      recovered = await cold.get(entry.holdId);
    expect(floor).toBe(previousFloor + 1);
    expect(recovered.signature).toEqual(signature);
    expect(recovered.provedTransaction !== null).toBe(mode === 'proof');
    await expect(cold.saveSignature(signed, { ...signature, S: hex(4) })).rejects.toMatchObject({
      code: 'RAILGUN_CAPSULE_CONFLICT',
    });
  }
);
test('a modified authenticated document during a live lease refuses even at the same sequence', async () => {
  const s = await open(),
    c = capsule(),
    entry = await s.put(await hold(c), c, signing.gatesDigest);
  await createPrivacyStorage(options).update('railgun-private-capsules-v1', (text) => {
    const v = JSON.parse(text);
    v.entries[0].factsDigest = 'f'.repeat(64);
    return JSON.stringify(v);
  });
  await expect(s.get(entry.holdId)).rejects.toThrow();
  expect(s.signal.aborted).toBe(true);
});
test('unknown record lookup is not an integrity error and cannot grant a new record', async () => {
  const s = await open();
  await expect(s.get('f'.repeat(64))).rejects.toMatchObject({ code: 'RAILGUN_CAPSULE_NOT_FOUND' });
  expect((await s.inspect()).records).toBe(0);
  expect(floor).toBe(0);
});

test.each([
  ['tree', 1],
  ['position', 2],
  ['nullifier', '0x' + '0'.repeat(63) + '9'],
  ['kind', 'railgun-private-transfer'],
  ['intentDigest', '0x' + 'd'.repeat(64)],
])('mismatched held %s cannot bind a capsule', async (name, value) => {
  const s = await open(),
    c = capsule(),
    r = await hold(c, { [name]: value });
  await expect(s.put(r, c, signing.gatesDigest)).rejects.toThrow();
  expect(floor).toBe(0);
});
test('32 fully filled records reopen at the exact maximum sequence 96', async () => {
  const s = await open();
  for (let n = 1; n <= 32; n++) {
    const c = capsule(n),
      held = await hold(c);
    await s.put(held, c, signing.gatesDigest);
    const signed = await s.markSigning(held, signing);
    await s.saveSignature(signed, signature);
    await s.saveProvedTransaction(signed, c.preparation.transaction);
  }
  expect(floor).toBe(96);
  s.close();
  const cold = await open(false);
  expect(await cold.inspect()).toEqual({ records: 32, signatures: 32, proofs: 32, capacity: 32 });
});
test('a hold abandoned during capsule persistence cannot return a usable put result', async () => {
  let held;
  const s = await open(true, {
      advanceFloor: async (n) => {
        floor = n;
        if (n === 1) await reservations.abandon(held);
      },
    }),
    c = capsule();
  held = await hold(c);
  await expect(s.put(held, c, signing.gatesDigest)).rejects.toMatchObject({
    code: 'RAILGUN_RESERVATION_RECEIPT_STALE',
  });
  expect(s.signal.aborted).toBe(true);
  expect((await reservations.inspect()).abandoned).toBe(1);
  expect((await (await open(false)).inspect()).records).toBe(1);
});
