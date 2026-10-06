// Isolated recovery-writer state tests use a test-only issuer seam. Paired
// ledger tests fall through to the real module-private issuer/consumer below.
const mockMutationTokens = new WeakMap();
const mockMutationCalls = [];
let mockMutationProbe;
jest.mock('./railgun-private-reservations', () => {
  const actual = jest.requireActual('./railgun-private-reservations');
  return {
    ...actual,
    consumeRailgunRelayReservationMutation(token, store, method, input) {
      const test = mockMutationTokens.get(token);
      if (!test) {
        if (mockMutationProbe) mockMutationProbe(actual, token, store, method, input);
        const check = actual.consumeRailgunRelayReservationMutation(token, store, method, input);
        mockMutationCalls.push({ token, store, method, input });
        return check;
      }
      if (test.used || test.store !== store || test.method !== method)
        throw Error('test mutation refused');
      test.used = true;
      return () => {
        if (!test.used) throw Error('test mutation expired');
      };
    },
  };
});
const testPermit = (store, method) => {
  const token = Object.freeze({});
  mockMutationTokens.set(token, { store, method, used: false });
  return token;
};
// Real encrypted disposable files; only enrollment issuance is a structural seam.
const mockOwners = new WeakMap();
jest.mock('./railgun-account-enrollment', () => ({
  assertRailgunFencedAccountEnrollment(owner) {
    const current = mockOwners.get(owner);
    if (!current || !current.live) throw Error('foreign or revoked fixture issuer');
  },
}));
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const { createPrivacyProfileGuard } = require('./privacy-profile-guard');
const { createRailgunRelayRecoveryStore } = require('./railgun-relay-recovery-store');
const {
  createRailgunRelayUnsignedData,
} = require('../../../scripts/fixtures/railgun-relay-unsigned-data');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { normalizeRailgunRelayPoiHistory } = require('./railgun-relay-poi-history');
const { normalizeRailgunRelayPrePoiBinding } = require('./railgun-relay-pre-poi-data');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const {
  decodeRailgunRelayLocalDocument,
  digestRailgunRelayLocalIntent,
} = require('./railgun-relay-recovery-data');
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
const refused = expect.objectContaining({ code: 'RAILGUN_RELAY_RECOVERY_STORE_REFUSED' });
function fixture(state = 'held') {
  const draft = createRailgunRelayUnsignedData().draft,
    draftDigest = normalizeRailgunRelayDraftCapsule(draft).digest;
  const proof = { leaf: hex(1), root: hex(2), indices: hex(5), elements: Array(16).fill(hex(3)) };
  const history = {
    schema: 'railgun-relay-input-poi-history-v1',
    draftDigest,
    listKey: REQUIRED_LIST,
    note: { blindedCommitment: '0x' + hex(1), type: 'Transact' },
    proof,
    event: {
      signedPOIEvent: {
        index: 5,
        blindedCommitment: '0x' + hex(1),
        type: 'Transact',
        signature: '12'.repeat(64),
      },
      validatedMerkleroot: hex(4),
    },
  };
  const prePoiBinding = {
    schema: 'railgun-relay-pre-poi-binding-v1',
    draftDigest,
    chainId: 11155111,
    txidVersion: 'V2_PoseidonMerkle',
    listKey: REQUIRED_LIST,
    listWitness: proof,
    txidLeafHash: hex(10),
    txidMerkleroot: hex(11),
    blindedCommitmentsOut: ['0x' + hex(12), '0x' + hex(13)],
  };
  const signature = ['signed', 'ready-local'].includes(state)
    ? { R8: ['0x' + hex(1), '0x' + hex(2)], S: '0x' + hex(3) }
    : null;
  const proved =
    state === 'ready-local'
      ? {
          transaction: draft.intent.transaction,
          payload: {
            snarkProof: {
              pi_a: ['1', '2'],
              pi_b: [
                ['3', '4'],
                ['5', '6'],
              ],
              pi_c: ['7', '8'],
            },
            txidMerkleroot: prePoiBinding.txidMerkleroot,
            poiMerkleroots: [proof.root],
            blindedCommitmentsOut: prePoiBinding.blindedCommitmentsOut,
            railgunTxidIfHasUnshield: '0x00',
          },
        }
      : null;
  return JSON.parse(
    JSON.stringify({
      schema: 'railgun-relay-local-record-v4',
      id: hex(100),
      binding: hex(101),
      walletId: draft.walletId,
      generationId: hex(102),
      checkpointHash: hex(103),
      authorizationDigest: hex(104),
      draft: normalizeRailgunRelayDraftCapsule(draft).data,
      history: normalizeRailgunRelayPoiHistory(history).data,
      prePoiBinding: normalizeRailgunRelayPrePoiBinding(prePoiBinding),
      state,
      signature,
      proved,
    })
  );
}
const RECORD = 'railgun-relay-local-recovery-v4';
const FLOOR = 'railgun-relay-local-recovery-floor-v4';
let scope, options, ownerState, stores, storage, floors, profile, guard;
const serialize = JSON.stringify;
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const filename = () => getPrivacyStoragePath(options.handle, options.directory);
const floorValue = (sequence) => ({
  version: 4,
  binding: options.binding,
  walletId: options.walletId,
  sequence,
});
async function open(create = true, extra = {}) {
  const store = await createRailgunRelayRecoveryStore({ ...options, create, ...extra });
  stores.push(store);
  return store;
}
async function document() {
  return decodeRailgunRelayLocalDocument(await storage.get(RECORD), {
    binding: options.binding,
    walletId: options.walletId,
  });
}
beforeEach(() => {
  stores = [];
  mockMutationCalls.length = 0;
  mockMutationProbe = undefined;
  profile = {
    id: 'public-relay-recovery-test',
    userDataDir: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-recovery-store-'))),
  };
  const profileId = createHash('sha256')
    .update(serialize([profile.id, profile.userDataDir]))
    .digest('hex');
  scope = createPrivacyScope({ profileId, signal: new AbortController().signal });
  const subject = {
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'storage',
  };
  const handleFor = (operation) => scope.getContext({ ...subject, operation });
  guard = createPrivacyProfileGuard({
    handle: handleFor('guard'),
    profile,
    seed: Buffer.alloc(64, 8),
  });
  const directory = path.join(
    profile.userDataDir,
    'wallet-railgun-accounts',
    'account-' + hex(900)
  );
  fs.mkdirSync(directory, { recursive: true });
  const row = fixture();
  const enrollment = Object.freeze({
    binding: row.binding,
    descriptor: { walletId: row.walletId },
    directory,
    profileGuard: guard,
    signal: scope.signal,
    getContext: (role, operation) => {
      if (role !== 'storage') throw Error('role');
      return handleFor(operation);
    },
  });
  ownerState = { live: true };
  mockOwners.set(enrollment, ownerState);
  floors = createPrivacyStorage({
    handle: handleFor(FLOOR + ':' + row.walletId),
    directory,
    key: Buffer.alloc(32, 9),
    profileGuard: guard,
  });
  options = {
    enrollment,
    handle: handleFor(RECORD + ':' + row.walletId),
    directory,
    key: Buffer.alloc(32, 7),
    binding: row.binding,
    walletId: row.walletId,
    profileGuard: guard,
    readFloor: async () => {
      const value = await floors.get(FLOOR);
      return value === null ? null : JSON.parse(value);
    },
    advanceFloor: async (next) =>
      floors.update(FLOOR, (previous) => {
        if (previous !== null && JSON.parse(previous).sequence > next.sequence)
          throw Error('floor rollback');
        return serialize(next);
      }),
  };
  storage = createPrivacyStorage({
    handle: options.handle,
    directory,
    key: options.key,
    profileGuard: guard,
  });
});
afterEach(() => {
  stores.forEach((store) => store.close());
  scope.close();
  jest.restoreAllMocks();
});
test('encrypted held/signing/signature/proof/terminal history survives cold lease rotation', async () => {
  const store = await open(),
    held = fixture(),
    ready = fixture('ready-local');
  const saved = await store.appendHeld(testPermit(store, 'appendHeld'), serialize(held));
  expect(Object.isFrozen(saved.history.proof.elements)).toBe(true);
  expect(await store.read(held.id)).toEqual(held);
  await store.markSigning(testPermit(store, 'markSigning'), held.id);
  await store.saveSignature(held.id, ready.signature);
  await store.saveProof(held.id, ready.proved);
  const discarded = await store.discardLocal(testPermit(store, 'discardLocal'), held.id);
  expect(discarded.state).toBe('discarded-signed');
  expect(discarded.signature).toEqual(ready.signature);
  expect(discarded.proved).toEqual(ready.proved);
  expect(digestRailgunRelayLocalIntent(serialize(discarded))).toBe(
    digestRailgunRelayLocalIntent(serialize(held))
  );
  expect(await options.readFloor()).toEqual(floorValue(5));
  const before = await document();
  expect(fs.readFileSync(filename(), 'utf8')).not.toContain(held.draft.intent.transaction.data);
  store.close();
  const cold = await open(false),
    after = await document();
  expect(after.lease).not.toBe(before.lease);
  expect(after.entries).toEqual(before.entries);
  expect(await cold.inspect()).toEqual({
    records: 1,
    sequence: 5,
    capacity: 10,
    states: [{ id: held.id, state: 'discarded-signed' }],
  });
  expect(scope.signal.aborted).toBe(false);
});
test.each(['held', 'signing-local', 'signed', 'ready-local'])(
  'discard from %s retains slots and never prunes ID',
  async (state) => {
    const store = await open(),
      row = fixture(),
      ready = fixture('ready-local');
    await store.appendHeld(testPermit(store, 'appendHeld'), serialize(row));
    if (state !== 'held') await store.markSigning(testPermit(store, 'markSigning'), row.id);
    if (['signed', 'ready-local'].includes(state))
      await store.saveSignature(row.id, ready.signature);
    if (state === 'ready-local') await store.saveProof(row.id, ready.proved);
    const before = await store.read(row.id),
      after = await store.discardLocal(testPermit(store, 'discardLocal'), row.id);
    expect(after).toEqual({
      ...before,
      state: state === 'held' ? 'cancelled-unsigned' : 'discarded-signed',
    });
    await expect(store.appendHeld(testPermit(store, 'appendHeld'), serialize(row))).rejects.toEqual(
      refused
    );
  }
);
test('ten terminal rows retain lifetime capacity and permit no eleventh ID', async () => {
  const store = await open();
  for (let i = 0; i < 10; i++) {
    const row = { ...fixture(), id: hex(200 + i) };
    await store.appendHeld(testPermit(store, 'appendHeld'), serialize(row));
    await store.discardLocal(testPermit(store, 'discardLocal'), row.id);
  }
  const before = fs.readFileSync(filename());
  await expect(
    store.appendHeld(testPermit(store, 'appendHeld'), serialize({ ...fixture(), id: hex(999) }))
  ).rejects.toMatchObject({ code: 'RAILGUN_RELAY_RECOVERY_CAPACITY' });
  expect(fs.readFileSync(filename())).toEqual(before);
  expect((await document()).entries).toHaveLength(10);
});
test.each(['markSigning', 'saveSignature', 'saveProof', 'discardLocal'])(
  'terminal row refuses %s without persistence',
  async (method) => {
    const store = await open(),
      row = fixture(),
      ready = fixture('ready-local');
    await store.appendHeld(testPermit(store, 'appendHeld'), serialize(row));
    await store.discardLocal(testPermit(store, 'discardLocal'), row.id);
    const before = fs.readFileSync(filename());
    await expect(
      ['markSigning', 'discardLocal'].includes(method)
        ? store[method](testPermit(store, method), row.id)
        : store[method](row.id, method === 'saveSignature' ? ready.signature : ready.proved)
    ).rejects.toEqual(refused);
    expect(fs.readFileSync(filename())).toEqual(before);
  }
);
test('filled signature and proof are never overwritten, even identically', async () => {
  const store = await open(),
    row = fixture(),
    ready = fixture('ready-local');
  await store.appendHeld(testPermit(store, 'appendHeld'), serialize(row));
  await store.markSigning(testPermit(store, 'markSigning'), row.id);
  await store.saveSignature(row.id, ready.signature);
  const before = fs.readFileSync(filename());
  await expect(store.saveSignature(row.id, ready.signature)).rejects.toEqual(refused);
  expect(fs.readFileSync(filename())).toEqual(before);
  const cold = await open(false);
  await cold.saveProof(row.id, ready.proved);
  const proved = fs.readFileSync(filename());
  await expect(cold.saveProof(row.id, ready.proved)).rejects.toEqual(refused);
  expect(fs.readFileSync(filename())).toEqual(proved);
});
test.each(['binding', 'walletId', 'directory', 'handle', 'profileGuard', 'enrollment'])(
  'foreign %s refuses before file work',
  async (key) => {
    const read = jest.spyOn(fs, 'readFileSync'),
      write = jest.spyOn(fs, 'renameSync');
    const changes = {
      binding: hex(22),
      walletId: hex(33),
      directory: profile.userDataDir,
      handle: {},
      profileGuard: {},
      enrollment: { ...options.enrollment },
    };
    await expect(open(true, { [key]: changes[key] })).rejects.toEqual(refused);
    expect(write).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  }
);
test('same-looking context from another scope does not join enrollment', async () => {
  const foreign = createPrivacyScope({
    profileId: 'foreign',
    signal: new AbortController().signal,
  });
  const handle = foreign.getContext({
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'storage',
    operation: RECORD + ':' + options.walletId,
  });
  await expect(open(true, { handle })).rejects.toEqual(refused);
  foreign.close();
});
test('second same-path owner refuses; closing a store preserves borrowed enrollment', async () => {
  const store = await open();
  await expect(open(false)).rejects.toEqual(refused);
  expect((await store.inspect()).records).toBe(0);
  store.close();
  expect(scope.signal.aborted).toBe(false);
  expect(ownerState.live).toBe(true);
  expect((await (await open(false)).inspect()).sequence).toBe(0);
});
test.each([
  'read',
  'inspect',
  'appendHeld',
  'markSigning',
  'saveSignature',
  'saveProof',
  'discardLocal',
])('revoked genuine issuer refuses %s before storage', async (method) => {
  const store = await open();
  ownerState.live = false;
  const read = jest.spyOn(fs, 'readFileSync');
  const argument = method === 'appendHeld' ? serialize(fixture()) : fixture().id;
  await expect(
    Promise.resolve().then(() =>
      ['appendHeld', 'markSigning', 'discardLocal'].includes(method)
        ? store[method](testPermit(store, method), argument)
        : store[method](argument, {})
    )
  ).rejects.toEqual(refused);
  expect(read).not.toHaveBeenCalled();
  expect(store.signal.aborted).toBe(true);
});
test('signature and proof inputs are detached before authenticated-read await', async () => {
  const store = await open(),
    row = fixture(),
    ready = fixture('ready-local');
  await store.appendHeld(testPermit(store, 'appendHeld'), serialize(row));
  await store.markSigning(testPermit(store, 'markSigning'), row.id);
  const signature = JSON.parse(serialize(ready.signature));
  const saving = store.saveSignature(row.id, signature);
  signature.S = '0x' + hex(99);
  expect((await saving).signature).toEqual(ready.signature);
  const proof = JSON.parse(serialize(ready.proved));
  const proving = store.saveProof(row.id, proof);
  proof.payload.snarkProof.pi_a[0] = '99';
  proof.transaction.data = '0x';
  expect((await proving).proved).toEqual(ready.proved);
});
test('input accessors and proxies are refused without invoking callbacks', async () => {
  const store = await open(),
    getter = jest.fn(),
    trap = jest.fn();
  const sig = { R8: ['0x' + hex(1), '0x' + hex(2)] };
  Object.defineProperty(sig, 'S', { enumerable: true, get: getter });
  await expect(store.saveSignature(fixture().id, sig)).rejects.toThrow();
  await expect(
    store.saveProof(fixture().id, new Proxy({}, { getPrototypeOf: trap, ownKeys: trap }))
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(trap).not.toHaveBeenCalled();
});
test.each(['absent', 'older', 'wrong-binding', 'wrong-wallet', 'future-version', 'extra'])(
  'normal reads refuse %s floor without repairs',
  async (kind) => {
    const store = await open();
    await store.appendHeld(testPermit(store, 'appendHeld'), serialize(fixture()));
    let next = floorValue(1);
    if (kind === 'absent') {
      const p = getPrivacyStoragePath(
        options.enrollment.getContext('storage', FLOOR + ':' + options.walletId),
        options.directory
      );
      fs.renameSync(p, p + '.retained');
    } else {
      if (kind === 'older') next.sequence = 0;
      if (kind === 'wrong-binding') next.binding = hex(33);
      if (kind === 'wrong-wallet') next.walletId = hex(44);
      if (kind === 'future-version') next.version = 5;
      if (kind === 'extra') next.extra = true;
      await floors.set(FLOOR, serialize(next));
    }
    const before = fs.readFileSync(filename());
    await expect(store.inspect()).rejects.toEqual(refused);
    expect(store.signal.aborted).toBe(true);
    expect(fs.readFileSync(filename())).toEqual(before);
  }
);
test('cold open repairs only a present lower authenticated floor before return', async () => {
  const store = await open();
  await store.appendHeld(testPermit(store, 'appendHeld'), serialize(fixture()));
  store.close();
  await floors.set(FLOOR, serialize(floorValue(0)));
  const cold = await open(false);
  expect(await options.readFloor()).toEqual(floorValue(1));
  expect((await cold.read(fixture().id)).state).toBe('held');
  cold.close();
  await floors.set(FLOOR, serialize(floorValue(2)));
  const before = fs.readFileSync(filename());
  await expect(open(false)).rejects.toEqual(refused);
  expect(fs.readFileSync(filename())).toEqual(before);
});
test('existing document with no authenticated floor cannot be implicitly adopted', async () => {
  const store = await open();
  store.close();
  const before = fs.readFileSync(filename());
  await expect(open(false, { readFloor: async () => null })).rejects.toEqual(refused);
  expect(fs.readFileSync(filename())).toEqual(before);
});
test('stale genuine inventory cannot recreate a missing document while its floor survives', async () => {
  const marker = path.join(profile.userDataDir, 'wallet-privacy-inventory.json'),
    stale = fs.readFileSync(marker);
  const store = await open();
  await store.appendHeld(testPermit(store, 'appendHeld'), serialize(fixture()));
  store.close();
  fs.renameSync(filename(), filename() + '.retained');
  fs.writeFileSync(marker, stale);
  expect(await options.readFloor()).toEqual(floorValue(1));
  await expect(open(true)).rejects.toEqual(refused);
  await expect(open(false)).rejects.toEqual(refused);
  expect(fs.existsSync(filename())).toBe(false);
});
test.each(['before-rename', 'after-rename', 'before-floor', 'after-floor', 'readback'])(
  'fault %s closes writer without retry or compensation',
  async (stage) => {
    let armed = false,
      commits = 0;
    const advanceFloor = async (value) => {
      if (armed && stage === 'before-floor') throw Error('floor fault');
      await options.advanceFloor(value);
      if (armed && stage === 'after-floor') throw Error('floor fault');
    };
    const store = await open(true, { advanceFloor });
    armed = true;
    const rename = fs.renameSync,
      read = fs.readFileSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === filename()) {
        if (stage === 'before-rename') throw Error('rename fault');
        rename(from, to);
        commits++;
        if (stage === 'after-rename') throw Error('rename fault');
        return;
      }
      return rename(from, to);
    });
    jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (stage === 'readback' && commits === 1 && file === filename())
        throw Error('readback fault');
      return read(file, ...args);
    });
    await expect(
      store.appendHeld(testPermit(store, 'appendHeld'), serialize(fixture()))
    ).rejects.toEqual(refused);
    expect(store.signal.aborted).toBe(true);
    expect(commits).toBe(stage === 'before-rename' ? 0 : 1);
    jest.restoreAllMocks();
    const stored = await document(),
      floor = await options.readFloor();
    expect(stored.entries.length).toBe(stage === 'before-rename' ? 0 : 1);
    expect(floor.sequence).toBe(['after-floor', 'readback'].includes(stage) ? 1 : 0);
    const cold = await open(false);
    expect((await cold.inspect()).records).toBe(stored.entries.length);
  }
);
test('missing floor from failed first creation does not reopen or recreate', async () => {
  await expect(
    open(true, {
      advanceFloor: async () => {
        throw Error('initial floor fault');
      },
    })
  ).rejects.toEqual(refused);
  expect(await options.readFloor()).toBe(null);
  await expect(open(false)).rejects.toEqual(refused);
  await expect(open(true)).rejects.toEqual(refused);
});
test('authenticated lease substitution refuses before writes', async () => {
  const store = await open(),
    before = await document();
  await storage.set(RECORD, serialize({ ...before, lease: hex(999) }));
  const changed = fs.readFileSync(filename());
  await expect(
    store.appendHeld(testPermit(store, 'appendHeld'), serialize(fixture()))
  ).rejects.toEqual(refused);
  expect(fs.readFileSync(filename())).toEqual(changed);
});
test('close retains pending floor work and same-path ownership until original settlement', async () => {
  const held = deferred(),
    entered = deferred();
  let arm = false;
  const store = await open(true, {
    advanceFloor: async (value) => {
      await options.advanceFloor(value);
      if (arm) {
        entered.resolve();
        await held.promise;
      }
    },
  });
  arm = true;
  const original = store.appendHeld(testPermit(store, 'appendHeld'), serialize(fixture()));
  original.catch(() => {});
  await entered.promise;
  store.close();
  let settled = false;
  original
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  await Promise.resolve();
  expect(settled).toBe(false);
  try {
    await expect(open(false)).rejects.toEqual(refused);
  } finally {
    held.resolve();
    await original.catch(() => {});
  }
  await expect(original).rejects.toEqual(refused);
  expect((await (await open(false)).inspect()).records).toBe(1);
});
test('busy admission refuses without poisoning the original pending read', async () => {
  const held = deferred(),
    entered = deferred();
  let arm = false;
  const store = await open(true, {
    readFloor: async () => {
      const f = await options.readFloor();
      if (arm) {
        entered.resolve();
        await held.promise;
      }
      return f;
    },
  });
  arm = true;
  const original = store.inspect();
  await entered.promise;
  await expect(store.inspect()).rejects.toMatchObject({
    code: 'RAILGUN_RELAY_RECOVERY_STORE_BUSY',
  });
  expect(store.signal.aborted).toBe(false);
  held.resolve();
  expect((await original).records).toBe(0);
});
test('ten largest histories complete all fifty transitions without exhausting reserved capacity', async () => {
  const store = await open(),
    ready = fixture('ready-local');
  for (let i = 0; i < 10; i++)
    await store.appendHeld(
      testPermit(store, 'appendHeld'),
      serialize({ ...fixture(), id: hex(300 + i) })
    );
  for (let i = 0; i < 10; i++) {
    const id = hex(300 + i);
    await store.markSigning(testPermit(store, 'markSigning'), id);
    await store.saveSignature(id, ready.signature);
    await store.saveProof(id, ready.proved);
    await store.discardLocal(testPermit(store, 'discardLocal'), id);
  }
  expect((await store.inspect()).sequence).toBe(50);
  expect(await options.readFloor()).toEqual(floorValue(50));
  const data = await document();
  expect(data.entries.every((row) => row.signature !== null && row.proved !== null)).toBe(true);
  expect(Buffer.byteLength(serialize(data))).toBeLessThanOrEqual(987136);
});
test.each(['read-floor', 'advance-floor'])(
  'issuer revocation during awaited %s prevents outward success',
  async (stage) => {
    const entered = deferred(),
      held = deferred();
    let arm = false;
    const readFloor = async () => {
      const result = await options.readFloor();
      if (arm && stage === 'read-floor') {
        entered.resolve();
        await held.promise;
      }
      return result;
    };
    const advanceFloor = async (value) => {
      await options.advanceFloor(value);
      if (arm && stage === 'advance-floor') {
        entered.resolve();
        await held.promise;
      }
    };
    const store = await open(true, { readFloor, advanceFloor });
    arm = true;
    const original =
      stage === 'read-floor'
        ? store.inspect()
        : store.appendHeld(testPermit(store, 'appendHeld'), serialize(fixture()));
    original.catch(() => {});
    await entered.promise;
    ownerState.live = false;
    held.resolve();
    await expect(original).rejects.toEqual(refused);
    expect(store.signal.aborted).toBe(true);
    expect(scope.signal.aborted).toBe(false);
  }
);
test('revocation immediately after real rename refuses before floor advancement', async () => {
  const store = await open(),
    originalRename = fs.renameSync;
  jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    originalRename(from, to);
    if (to === filename()) ownerState.live = false;
  });
  await expect(
    store.appendHeld(testPermit(store, 'appendHeld'), serialize(fixture()))
  ).rejects.toEqual(refused);
  expect(store.signal.aborted).toBe(true);
  jest.restoreAllMocks();
  expect((await document()).sequence).toBe(1);
  expect((await options.readFloor()).sequence).toBe(0);
});
test.each(['noop', 'higher'])(
  'floor callback %s is rejected by exact postwrite readback',
  async (kind) => {
    let arm = false;
    const store = await open(true, {
      advanceFloor: async (value) => {
        if (!arm) return options.advanceFloor(value);
        if (kind === 'higher')
          await options.advanceFloor({ ...value, sequence: value.sequence + 1 });
      },
    });
    arm = true;
    await expect(
      store.appendHeld(testPermit(store, 'appendHeld'), serialize(fixture()))
    ).rejects.toEqual(refused);
    expect(store.signal.aborted).toBe(true);
    expect((await document()).sequence).toBe(1);
    expect((await options.readFloor()).sequence).toBe(kind === 'noop' ? 0 : 2);
  }
);
test('authenticated document change between attestation and CAS cannot be overwritten', async () => {
  let arm = false;
  const store = await open(true, {
    readFloor: async () => {
      const result = await options.readFloor();
      if (arm) {
        arm = false;
        const value = await document();
        await storage.set(RECORD, serialize({ ...value, lease: hex(808) }));
      }
      return result;
    },
  });
  arm = true;
  await expect(
    store.appendHeld(testPermit(store, 'appendHeld'), serialize(fixture()))
  ).rejects.toEqual(refused);
  const value = await document();
  expect(value.lease).toBe(hex(808));
  expect(value.sequence).toBe(0);
});
test('postwrite exact readback rejects authenticated same-sequence lease substitution', async () => {
  let arm = false;
  const store = await open(true, {
    advanceFloor: async (value) => {
      await options.advanceFloor(value);
      if (arm) {
        const row = await document();
        await storage.set(RECORD, serialize({ ...row, lease: hex(909) }));
      }
    },
  });
  arm = true;
  await expect(
    store.appendHeld(testPermit(store, 'appendHeld'), serialize(fixture()))
  ).rejects.toEqual(refused);
  expect(store.signal.aborted).toBe(true);
  expect((await document()).lease).toBe(hex(909));
});
test('proof object field order is normalized into the canonical serialized document', async () => {
  const store = await open(),
    row = fixture(),
    ready = fixture('ready-local');
  await store.appendHeld(testPermit(store, 'appendHeld'), serialize(row));
  await store.markSigning(testPermit(store, 'markSigning'), row.id);
  await store.saveSignature(row.id, ready.signature);
  const reverse = (value) => Object.fromEntries(Object.entries(value).reverse());
  const result = await store.saveProof(row.id, {
    payload: reverse(ready.proved.payload),
    transaction: reverse(ready.proved.transaction),
  });
  expect(result.proved).toEqual(ready.proved);
  expect((await document()).entries[0]).toEqual(result);
});

// Fixed pair composition with genuine encrypted stores; enrollment/fence issuer
// is the existing test seam above. No controller, key permit or native custody.
const { createRailgunPrivateReservations } = require('./railgun-private-reservations');
const { assertRailgunRelayRecoveryStoreOwner } = require('./railgun-relay-recovery-store');
async function custodyPair(create = true, hooks = {}) {
  const record = 'railgun-private-reservations-v1';
  const handle = options.enrollment.getContext('storage', record + ':' + options.walletId);
  const floorKey = 'paired-private-floor';
  const ledgerOptions = {
    enrollment: options.enrollment,
    handle,
    directory: options.directory,
    key: Buffer.alloc(32, 17),
    binding: options.binding,
    walletId: options.walletId,
    profileGuard: guard,
    create,
    readFloor: async () => {
      if (hooks.ledgerRead) await hooks.ledgerRead();
      const text = await floors.get(floorKey);
      return text === null ? null : JSON.parse(text);
    },
    advanceFloor: async (value) => {
      if (hooks.ledgerAdvance) await hooks.ledgerAdvance(value);
      await floors.set(floorKey, JSON.stringify(value));
    },
    claimRecovery: () => {
      if (hooks.recoveryPhase) return hooks.recoveryPhase;
      throw Error('relay must not claim a recovery phase');
    },
    authorizeSigning: () => {
      throw Error('relay must not use private signing permit');
    },
  };
  const recovery = await open(create);
  const ledger = await createRailgunPrivateReservations(ledgerOptions);
  stores.push(ledger);
  const ledgerStorage = createPrivacyStorage(ledgerOptions);
  return { ledger, recovery, ledgerOptions, ledgerStorage, floorKey, record, hooks };
}
async function ledgerDoc(pair) {
  return JSON.parse(await pair.ledgerStorage.get(pair.record));
}
const privateFor = (row) => ({
  tree: row.draft.selection.tree,
  position: row.draft.selection.position,
  nullifier: row.draft.intent.expected.nullifier,
  noteHash: row.draft.noteHash,
  kind: 'railgun-private-transfer',
  intentDigest: '0x' + hex(800),
  checkpointHash: row.checkpointHash,
  poiDigest: hex(801),
});
test('fixed recovery owner and optional lookup authenticate original factory and absence', async () => {
  const store = await open();
  expect(assertRailgunRelayRecoveryStoreOwner(store, options.enrollment)).toBeUndefined();
  expect(() => assertRailgunRelayRecoveryStoreOwner({ ...store }, options.enrollment)).toThrow();
  expect(() => assertRailgunRelayRecoveryStoreOwner(store, { ...options.enrollment })).toThrow();
  expect(await store.lookup(hex(100))).toBeNull();
  expect(await store.assertHeldAvailable(serialize(fixture()))).toBeUndefined();
  expect((await store.inspect()).sequence).toBe(0);
  store.close();
  expect(() => assertRailgunRelayRecoveryStoreOwner(store, options.enrollment)).toThrow();
});
test('fixed pair holds, marks signing and tombstones before releasing a shared conflict', async () => {
  const pair = await custodyPair(),
    row = fixture();
  const held = await pair.ledger.reserveRelay(pair.recovery, serialize(row));
  expect(held.entry.origin).toBe('relay-local-v4');
  expect(held.record).toEqual(row);
  expect(held.authorityGranted).toBe(false);
  expect((await ledgerDoc(pair)).sequence).toBe(1);
  expect((await document()).sequence).toBe(1);
  await expect(pair.ledger.reserve(privateFor(row))).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
  });
  const signing = await pair.ledger.markRelaySigning(pair.recovery, held.receipt);
  expect(signing.entry.signing.recordDigest).toBe(digestRailgunRelayLocalIntent(serialize(row)));
  expect(signing.record.state).toBe('signing-local');
  expect((await pair.ledger.inspect()).signing).toBe(0);
  const discarded = await pair.ledger.discardRelayLocal(pair.recovery, signing.receipt);
  expect(discarded.entry.state).toBe('discarded-signed');
  expect(discarded.record.state).toBe('discarded-signed');
  expect(discarded.entry.signing).toEqual(signing.entry.signing);
  const privateReceipt = await pair.ledger.reserve(privateFor(row));
  expect((await pair.ledger.assertReceipt(privateReceipt)).facts).toEqual(privateFor(row));
  expect((await ledgerDoc(pair)).sequence).toBe(4);
});
test.each(['assertReceipt', 'abandon', 'markSigning'])(
  'private %s API refuses a genuine relay receipt',
  async (method) => {
    const pair = await custodyPair();
    const held = await pair.ledger.reserveRelay(pair.recovery, serialize(fixture()));
    const extra =
      method === 'markSigning'
        ? [{ submitter: '0x' + '1'.repeat(40), operationId: hex(9), gatesDigest: hex(8) }, {}]
        : [];
    await expect(pair.ledger[method](held.receipt, ...extra)).rejects.toThrow();
    expect((await document()).entries[0].state).toBe('held');
  }
);
test.each(['clone', 'foreign-enrollment', 'foreign-receipt'])(
  'relay custody refuses %s before mutating records',
  async (kind) => {
    const pair = await custodyPair();
    const held = await pair.ledger.reserveRelay(pair.recovery, serialize(fixture()));
    const before = await ledgerDoc(pair);
    if (kind === 'clone')
      await expect(pair.ledger.readRelay({ ...pair.recovery }, held.entry.id)).rejects.toThrow();
    if (kind === 'foreign-enrollment') {
      expect(() =>
        assertRailgunRelayRecoveryStoreOwner(pair.recovery, { ...options.enrollment })
      ).toThrow();
    }
    if (kind === 'foreign-receipt')
      await expect(
        pair.ledger.markRelaySigning(pair.recovery, { ...held.receipt })
      ).rejects.toThrow();
    expect(await ledgerDoc(pair)).toEqual(before);
  }
);
test('recovery capacity refuses before the first ledger hold write', async () => {
  const pair = await custodyPair();
  for (let i = 0; i < 10; i++)
    await pair.recovery.appendHeld(
      testPermit(pair.recovery, 'appendHeld'),
      serialize({ ...fixture(), id: hex(100 + i) })
    );
  const before = await ledgerDoc(pair);
  await expect(
    pair.ledger.reserveRelay(pair.recovery, serialize({ ...fixture(), id: hex(999) }))
  ).rejects.toThrow();
  expect(await ledgerDoc(pair)).toEqual(before);
});
test('ledger future-transition budget refuses before creating recovery row', async () => {
  let pair = await custodyPair();
  pair.ledger.close();
  pair.recovery.close();
  const entries = Array.from({ length: 511 }, (_, i) => ({
    id: hex(i + 1),
    origin: 'private',
    facts: { ...privateFor(fixture()), nullifier: '0x' + hex(i + 1) },
    state: 'abandoned',
    signing: null,
  }));
  const before = await ledgerDoc(pair);
  await pair.ledgerStorage.set(pair.record, serialize({ ...before, sequence: 1022, entries }));
  await floors.set(
    pair.floorKey,
    serialize({ version: 4, binding: options.binding, walletId: options.walletId, sequence: 1022 })
  );
  pair = await custodyPair(false);
  const observed = await ledgerDoc(pair);
  await expect(
    pair.ledger.reserveRelay(pair.recovery, serialize({ ...fixture(), id: hex(999) }))
  ).rejects.toMatchObject({ code: 'RAILGUN_RESERVATIONS_CAPACITY' });
  expect(await ledgerDoc(pair)).toEqual(observed);
  expect(pair.ledger.signal.aborted).toBe(false);
  expect(pair.recovery.signal.aborted).toBe(false);
  expect(await pair.recovery.lookup(hex(999))).toBeNull();
  const unrelated = { ...privateFor(fixture()), nullifier: '0x' + hex(990) };
  const receipt = await pair.ledger.reserve(unrelated);
  expect((await pair.ledger.assertReceipt(receipt)).facts).toEqual(unrelated);
});
test('recovery capacity proposal validates canonical bytes without writing', async () => {
  const store = await open(),
    before = await document();
  await expect(store.assertHeldAvailable(serialize(fixture()) + ' ')).rejects.toThrow();
  expect(await document()).toEqual(before);
});

// Inject an exact write/floor cut in the existing fixed callbacks, reopen both
// actual encrypted stores, and assert the authenticated pair repair semantics.
test('ledger hold without record is cold cancellable only after authenticated absence', async () => {
  const hooks = {},
    pair = await custodyPair(true, hooks);
  hooks.ledgerAdvance = async (value) => {
    if (value.sequence === 1) throw Error('cut after ledger rename');
  };
  await expect(pair.ledger.reserveRelay(pair.recovery, serialize(fixture()))).rejects.toThrow();
  pair.recovery.close();
  const cold = await custodyPair(false);
  const orphan = await cold.ledger.readRelay(cold.recovery, fixture().id);
  expect(await cold.ledger.listRelay(cold.recovery)).toEqual([{ id: fixture().id, state: 'held' }]);
  expect(orphan.record).toBeNull();
  expect(orphan.interruptedStep).toBe('append-held');
  const cancelled = await cold.ledger.discardRelayLocal(cold.recovery, orphan.receipt);
  expect(cancelled.entry.state).toBe('cancelled-unsigned');
  expect(cancelled.entry.signing).toBeNull();
  expect((await cold.ledger.readRelay(cold.recovery, fixture().id)).entry.state).toBe(
    'cancelled-unsigned'
  );
  await cold.ledger.reserve(privateFor(fixture()));
});
test('signing ledger plus held record repairs signing history before signed discard', async () => {
  const hooks = {},
    pair = await custodyPair(true, hooks);
  const held = await pair.ledger.reserveRelay(pair.recovery, serialize(fixture()));
  hooks.ledgerAdvance = async (value) => {
    if (value.sequence === 2) throw Error('cut after signing ledger rename');
  };
  await expect(pair.ledger.markRelaySigning(pair.recovery, held.receipt)).rejects.toThrow();
  pair.recovery.close();
  const cold = await custodyPair(false);
  const pending = await cold.ledger.readRelay(cold.recovery, fixture().id);
  expect(pending.interruptedStep).toBe('mark-recovery-signing');
  expect(pending.record.state).toBe('held');
  const result = await cold.ledger.discardRelayLocal(cold.recovery, pending.receipt);
  expect(result.entry.state).toBe('discarded-signed');
  expect(result.record.state).toBe('discarded-signed');
  expect(result.record.signature).toBeNull();
  expect((await document()).sequence).toBe(3);
});
test('signing ledger with missing record refuses and never releases conflict', async () => {
  const pair = await custodyPair();
  const held = await pair.ledger.reserveRelay(pair.recovery, serialize(fixture()));
  const signing = await pair.ledger.markRelaySigning(pair.recovery, held.receipt);
  pair.ledger.close();
  pair.recovery.close();
  const old = await document();
  await storage.set(RECORD, serialize({ ...old, sequence: 0, entries: [] }));
  await floors.set(FLOOR, serialize(floorValue(0)));
  const cold = await custodyPair(false),
    before = await ledgerDoc(cold);
  await expect(cold.ledger.readRelay(cold.recovery, signing.entry.id)).rejects.toThrow();
  expect(await ledgerDoc(cold)).toEqual(before);
});
test.each(['unsigned', 'signed'])(
  'tombstone-first %s release survives ledger-floor cut and repeats without another record mutation',
  async (kind) => {
    const hooks = {},
      pair = await custodyPair(true, hooks);
    let value = await pair.ledger.reserveRelay(pair.recovery, serialize(fixture()));
    if (kind === 'signed') value = await pair.ledger.markRelaySigning(pair.recovery, value.receipt);
    const sequence = kind === 'signed' ? 3 : 2;
    hooks.ledgerAdvance = async (next) => {
      if (next.sequence === sequence) throw Error('cut after release rename');
    };
    await expect(pair.ledger.discardRelayLocal(pair.recovery, value.receipt)).rejects.toThrow();
    const tombstone = await document();
    expect(tombstone.entries[0].state).toBe(
      kind === 'signed' ? 'discarded-signed' : 'cancelled-unsigned'
    );
    pair.recovery.close();
    const cold = await custodyPair(false),
      read = await cold.ledger.readRelay(cold.recovery, value.entry.id);
    await cold.ledger.discardRelayLocal(cold.recovery, read.receipt);
    const final = await document();
    expect(final.sequence).toBe(tombstone.sequence);
    expect(final.entries).toEqual(tombstone.entries);
  }
);
test('close retains original nested recovery floor callback and blocks both same-path writers', async () => {
  const held = deferred(),
    entered = deferred();
  const original = options.advanceFloor;
  options.advanceFloor = async (value) => {
    if (value.sequence === 1) {
      entered.resolve();
      await held.promise;
    }
    return original(value);
  };
  const pair = await custodyPair();
  let settled = false;
  const pending = pair.ledger.reserveRelay(pair.recovery, serialize(fixture()));
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await entered.promise;
  pair.ledger.close();
  pair.recovery.close();
  await expect(
    createRailgunPrivateReservations({ ...pair.ledgerOptions, create: false })
  ).rejects.toThrow();
  await expect(open(false)).rejects.toThrow();
  expect(settled).toBe(false);
  held.resolve();
  await expect(pending).rejects.toThrow();
  const cold = await custodyPair(false);
  const value = await cold.ledger.readRelay(cold.recovery, fixture().id);
  expect(value.entry.state).toBe('held');
  expect(value.record.state).toBe('held');
});
test('private receipts cannot be repurposed by the relay writer', async () => {
  const pair = await custodyPair();
  const privateReceipt = await pair.ledger.reserve({
    ...privateFor(fixture()),
    nullifier: '0x' + hex(999),
  });
  await expect(pair.ledger.markRelaySigning(pair.recovery, privateReceipt)).rejects.toThrow();
  expect((await document()).entries).toEqual([]);
});

test.each(['unsigned', 'signed'])(
  'failed original %s tombstone floor retains ledger conflict until cold repair',
  async (kind) => {
    let cut = false;
    const advance = options.advanceFloor;
    options.advanceFloor = async (value) => {
      if (cut) throw Error('tombstone renamed, floor failed');
      return advance(value);
    };
    const pair = await custodyPair();
    let value = await pair.ledger.reserveRelay(pair.recovery, serialize(fixture()));
    if (kind === 'signed') value = await pair.ledger.markRelaySigning(pair.recovery, value.receipt);
    const before = await ledgerDoc(pair);
    cut = true;
    await expect(pair.ledger.discardRelayLocal(pair.recovery, value.receipt)).rejects.toThrow();
    expect(await ledgerDoc(pair)).toEqual(before);
    const record = await document();
    expect(record.entries[0].state).toBe(
      kind === 'signed' ? 'discarded-signed' : 'cancelled-unsigned'
    );
    cut = false;
    const cold = await custodyPair(false);
    const joined = await cold.ledger.readRelay(cold.recovery, value.entry.id);
    expect(joined.interruptedStep).toBe(kind === 'signed' ? 'release-signed' : 'release-unsigned');
    await cold.ledger.discardRelayLocal(cold.recovery, joined.receipt);
    await cold.ledger.reserve(privateFor(fixture()));
  }
);
test('same live pair refuses interleaving while a nested recovery floor write is original pending work', async () => {
  const held = deferred(),
    entered = deferred(),
    advance = options.advanceFloor;
  options.advanceFloor = async (value) => {
    if (value.sequence === 1) {
      entered.resolve();
      await held.promise;
    }
    return advance(value);
  };
  const pair = await custodyPair();
  const pending = pair.ledger.reserveRelay(pair.recovery, serialize(fixture()));
  await entered.promise;
  await expect(
    pair.ledger.reserve({ ...privateFor(fixture()), nullifier: '0x' + hex(999) })
  ).rejects.toThrow();
  await expect(pair.ledger.readRelay(pair.recovery, fixture().id)).rejects.toThrow();
  await expect(pair.recovery.lookup(fixture().id)).rejects.toThrow();
  held.resolve();
  const result = await pending;
  expect(result.record.state).toBe('held');
});
test('historical never-signed relay rows cannot be upgraded by current relay APIs', async () => {
  const pair = await custodyPair();
  const held = await pair.ledger.reserveRelay(pair.recovery, serialize(fixture()));
  pair.ledger.close();
  pair.recovery.close();
  const value = await ledgerDoc(pair);
  value.entries[0].origin = 'relay-v3-never-signed';
  await pair.ledgerStorage.set(pair.record, serialize(value));
  const cold = await custodyPair(false);
  await expect(cold.ledger.readRelay(cold.recovery, held.entry.id)).rejects.toThrow();
  expect((await ledgerDoc(cold)).entries[0].origin).toBe('relay-v3-never-signed');
});

test('bounded relay selectors omit private and historical rows and carry no action receipt', async () => {
  let pair = await custodyPair();
  const held = await pair.ledger.reserveRelay(pair.recovery, serialize(fixture()));
  await pair.ledger.reserve({ ...privateFor(fixture()), nullifier: '0x' + hex(998) });
  pair.ledger.close();
  pair.recovery.close();
  const value = await ledgerDoc(pair);
  value.sequence++;
  value.entries.push({
    ...held.entry,
    id: hex(998),
    origin: 'relay-v3-never-signed',
    facts: { ...held.entry.facts, nullifier: '0x' + hex(997) },
  });
  await pair.ledgerStorage.set(pair.record, serialize(value));
  await floors.set(
    pair.floorKey,
    serialize({
      version: 4,
      binding: options.binding,
      walletId: options.walletId,
      sequence: value.sequence,
    })
  );
  pair = await custodyPair(false);
  const selectors = await pair.ledger.listRelay(pair.recovery);
  expect(selectors).toEqual([{ id: fixture().id, state: 'held' }]);
  expect(Object.isFrozen(selectors)).toBe(true);
  expect(Object.isFrozen(selectors[0])).toBe(true);
  await expect(pair.ledger.markRelaySigning(pair.recovery, selectors[0])).rejects.toThrow();
});
test('relay selector listing checks the actual recovery floor as well as ledger floor', async () => {
  const pair = await custodyPair();
  await pair.ledger.reserveRelay(pair.recovery, serialize(fixture()));
  const before = await ledgerDoc(pair);
  await floors.set(FLOOR, serialize(floorValue(2)));
  await expect(pair.ledger.listRelay(pair.recovery)).rejects.toThrow();
  expect(await ledgerDoc(pair)).toEqual(before);
});
test('private recovery scope cannot invoke the relay pair and retains ordinary phase settlement', async () => {
  const phase = { assertCurrent: jest.fn(), release: jest.fn() };
  const pair = await custodyPair(true, { recoveryPhase: phase });
  await pair.ledger.withSigningRecovery(async (records) => {
    expect(records).toEqual([]);
    await expect(pair.ledger.listRelay(pair.recovery)).rejects.toThrow();
    expect(phase.release).not.toHaveBeenCalled();
  });
  expect(phase.release).toHaveBeenCalledTimes(1);
});

test.each(['appendHeld', 'markSigning', 'discardLocal'])(
  'raw recovery %s cannot bypass paired ledger with absent or forged capability',
  async (method) => {
    const pair = await custodyPair();
    const row = fixture();
    if (method !== 'appendHeld') await pair.ledger.reserveRelay(pair.recovery, serialize(row));
    const before = await document(),
      ledgerBefore = await ledgerDoc(pair);
    const input = method === 'appendHeld' ? serialize(row) : row.id;
    for (const token of [undefined, {}, Object.freeze({ custody: true })])
      await expect(
        Promise.resolve().then(() => pair.recovery[method](token, input))
      ).rejects.toThrow();
    expect(await document()).toEqual(before);
    expect(await ledgerDoc(pair)).toEqual(ledgerBefore);
    expect(pair.ledger.signal.aborted).toBe(false);
  }
);
test('paired mutation capabilities are single-use and dead after original operation settlement', async () => {
  const pair = await custodyPair();
  const held = await pair.ledger.reserveRelay(pair.recovery, serialize(fixture()));
  const signing = await pair.ledger.markRelaySigning(pair.recovery, held.receipt);
  await pair.ledger.discardRelayLocal(pair.recovery, signing.receipt);
  expect(mockMutationCalls.map(({ method }) => method)).toEqual([
    'appendHeld',
    'markSigning',
    'discardLocal',
  ]);
  const before = await document();
  for (const { token, store, method, input } of mockMutationCalls.slice())
    await expect(Promise.resolve().then(() => store[method](token, input))).rejects.toThrow();
  expect(await document()).toEqual(before);
});
test('pre-write relay conflict preserves unrelated private ledger use', async () => {
  const pair = await custodyPair(),
    row = fixture();
  await pair.ledger.reserve(privateFor(row));
  await expect(pair.ledger.reserveRelay(pair.recovery, serialize(row))).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
  });
  expect(pair.ledger.signal.aborted).toBe(false);
  const unrelated = { ...privateFor(row), nullifier: '0x' + hex(991) };
  const receipt = await pair.ledger.reserve(unrelated);
  expect((await pair.ledger.assertReceipt(receipt)).facts).toEqual(unrelated);
  expect(await pair.recovery.lookup(row.id)).toBeNull();
});
test('pre-write recovery capacity refusal preserves unrelated private ledger use', async () => {
  const pair = await custodyPair();
  for (let i = 0; i < 10; i++)
    await pair.recovery.appendHeld(
      testPermit(pair.recovery, 'appendHeld'),
      serialize({ ...fixture(), id: hex(i + 1) })
    );
  const before = await ledgerDoc(pair);
  await expect(pair.ledger.reserveRelay(pair.recovery, serialize(fixture()))).rejects.toMatchObject(
    { code: 'RAILGUN_RELAY_RECOVERY_CAPACITY' }
  );
  expect(pair.ledger.signal.aborted).toBe(false);
  expect(pair.recovery.signal.aborted).toBe(false);
  expect(await ledgerDoc(pair)).toEqual(before);
  await pair.ledger.reserve(privateFor(fixture()));
});
test('pre-write busy recovery refusal leaves ledger live while original recovery read drains', async () => {
  const gate = deferred(),
    entered = deferred(),
    read = options.readFloor;
  let arm = false;
  options.readFloor = async () => {
    const result = await read();
    if (arm) {
      entered.resolve();
      await gate.promise;
    }
    return result;
  };
  const pair = await custodyPair();
  arm = true;
  const original = pair.recovery.inspect();
  await entered.promise;
  await expect(pair.ledger.reserveRelay(pair.recovery, serialize(fixture()))).rejects.toMatchObject(
    { code: 'RAILGUN_RELAY_RECOVERY_STORE_BUSY' }
  );
  expect(pair.ledger.signal.aborted).toBe(false);
  await pair.ledger.reserve(privateFor(fixture()));
  arm = false;
  gate.resolve();
  await original;
});

test('live paired mutation capability binds the exact store, method, input and one consumption', async () => {
  const pair = await custodyPair(),
    results = [];
  mockMutationProbe = (actual, token, store, method, input) => {
    for (const args of [
      [{}, store, method, input],
      [token, {}, method, input],
      [token, store, method === 'appendHeld' ? 'markSigning' : 'appendHeld', input],
      [token, store, method, input + ' '],
    ]) {
      try {
        actual.consumeRailgunRelayReservationMutation(...args);
        results.push(false);
      } catch {
        results.push(true);
      }
    }
  };
  const held = await pair.ledger.reserveRelay(pair.recovery, serialize(fixture()));
  const signing = await pair.ledger.markRelaySigning(pair.recovery, held.receipt);
  await pair.ledger.discardRelayLocal(pair.recovery, signing.receipt);
  expect(results).toEqual(Array(12).fill(true));
});
test('revoked ledger capability cannot cross the authenticated recovery write boundary', async () => {
  const pair = await custodyPair();
  const before = await document();
  mockMutationProbe = () => pair.ledger.close();
  await expect(pair.ledger.reserveRelay(pair.recovery, serialize(fixture()))).rejects.toThrow();
  expect(await document()).toEqual(before);
  expect((await ledgerDoc(pair)).entries[0].state).toBe('held');
});

test.each(['RAILGUN_RELAY_RECOVERY_CAPACITY', 'RAILGUN_RELAY_RECOVERY_STORE_BUSY'])(
  'forged harmless %s from authenticated floor work still closes both stores',
  async (code) => {
    const read = options.readFloor;
    let arm = false;
    options.readFloor = async () => {
      if (arm) throw Object.assign(Error('fixture authentication failure'), { code });
      return read();
    };
    const pair = await custodyPair();
    const before = await ledgerDoc(pair);
    arm = true;
    await expect(pair.ledger.reserveRelay(pair.recovery, serialize(fixture()))).rejects.toThrow();
    expect(pair.ledger.signal.aborted).toBe(true);
    expect(pair.recovery.signal.aborted).toBe(true);
    expect(await ledgerDoc(pair)).toEqual(before);
  }
);
