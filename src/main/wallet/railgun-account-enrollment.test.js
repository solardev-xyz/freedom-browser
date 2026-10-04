const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createHash } = require('crypto');
let mockProfile, mockParent, mockIdentity, mockVault, mockMnemonic, mockPoiFactoryHook;
jest.mock('./railgun-poi-intent-store', () => {
  const actual = jest.requireActual('./railgun-poi-intent-store');
  return {
    createRailgunPoiIntentStore: (options) =>
      mockPoiFactoryHook
        ? mockPoiFactoryHook(options, actual.createRailgunPoiIntentStore)
        : actual.createRailgunPoiIntentStore(options),
  };
});
const mockCoordinators = new WeakSet();
jest.mock('./railgun-scan-coordinator', () => ({
  assertRailgunScanCoordinator: (v) => {
    if (!mockCoordinators.has(v)) throw Error('coordinator');
  },
}));
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
  mockPoiFactoryHook = undefined;
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
const reservationInput = () => ({
  tree: 0,
  position: 1,
  nullifier: '0x' + '1'.repeat(64),
  noteHash: '0x' + '2'.repeat(64),
  kind: 'railgun-private-transfer',
  intentDigest: '0x' + '3'.repeat(64),
  checkpointHash: '4'.repeat(64),
  poiDigest: '5'.repeat(64),
});
const reservationRecoveryInput = () => ({
  tree: 0,
  position: 1,
  nullifier: '0x' + '1'.repeat(64),
  noteHash: '0x' + '2'.repeat(64),
});
const reservationFile = (entry) =>
  require('./privacy-storage').getPrivacyStoragePath(
    entry.getContext('storage', 'railgun-private-reservations-v1:' + entry.descriptor.walletId),
    entry.directory
  );
test('account reservations migrate lazily, survive generation replacement and revoke with enrollment', async () => {
  const entry = await open(true),
    previousInventory = inventory();
  const pending = entry.openReservations();
  await expect(entry.openReservations()).rejects.toThrow();
  const store = await pending;
  expect(await entry.openReservations()).toBe(store);
  expect(inventory()).toHaveLength(previousInventory.length + 1);
  const receipt = await store.reserve(reservationInput());
  await entry.catalog.begin('6'.repeat(64));
  await entry.catalog.begin('7'.repeat(64));
  expect(await store.inspect()).toEqual({ held: 1, signing: 0, abandoned: 0, legacy: 0 });
  entry.close();
  await expect(store.assertReceipt(receipt)).rejects.toThrow();
  const cold = await open(),
    reopened = await cold.openReservations();
  expect(await reopened.inspect()).toEqual({ held: 1, signing: 0, abandoned: 0, legacy: 0 });
  await expect(reopened.reserve(reservationInput())).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
  });
});
test('account manifest floor rejects an older reservation file across restart', async () => {
  const entry = await open(true),
    store = await entry.openReservations(),
    file = reservationFile(entry);
  const empty = fs.readFileSync(file);
  await store.reserve(reservationInput());
  entry.close();
  fs.writeFileSync(file, empty);
  const cold = await open();
  await expect(cold.openReservations()).rejects.toThrow();
});
test('cold hold recovery excludes active wallet/TXID phases and cannot release signing records', async () => {
  const entry = await open(true),
    store = await entry.openReservations();
  await store.reserve(reservationInput());
  entry.close();
  const cold = await open(),
    restored = await cold.openReservations();
  const { claimRailgunAccountPhase } = require('./railgun-account-phase');
  for (const kind of ['wallet', 'txid']) {
    const phase = claimRailgunAccountPhase(cold, kind);
    try {
      await expect(restored.abandonRecovered(reservationRecoveryInput())).rejects.toMatchObject({
        code: 'RAILGUN_ACCOUNT_PHASE_BUSY',
      });
      expect(await restored.inspect()).toEqual({ held: 1, signing: 0, abandoned: 0, legacy: 0 });
    } finally {
      phase.release();
    }
  }
  await restored.abandonRecovered(reservationRecoveryInput());
  expect(await restored.inspect()).toEqual({ held: 0, signing: 0, abandoned: 1, legacy: 0 });
  const data = require('../../../scripts/fixtures/railgun-capsule-data');
  const capsule = data.capsule(cold.descriptor.walletId, 2);
  const held = await restored.reserve(data.facts(capsule));
  const capsuleStore = await cold.openPrivateCapsules();
  await capsuleStore.put(held, capsule, 'b'.repeat(64));
  await capsuleStore.markSigning(held, {
    submitter: '0x' + '1'.repeat(40),
    operationId: 'a'.repeat(64),
    gatesDigest: 'b'.repeat(64),
  });
  await expect(
    restored.abandonRecovered({
      ...reservationRecoveryInput(),
      position: 2,
      nullifier: capsule.preparation.expected.nullifier,
      noteHash: capsule.noteHash,
    })
  ).rejects.toThrow();
  const phase = claimRailgunAccountPhase(cold, 'wallet');
  phase.release();
});
test('missing reservation file is detected by the profile inventory before enrollment reopens', async () => {
  const entry = await open(true);
  await entry.openReservations();
  const file = reservationFile(entry);
  entry.close();
  fs.renameSync(file, file + '.retained');
  await expect(open()).rejects.toMatchObject({ code: 'PRIVATE_PROFILE_STORE_MISSING' });
  expect(fs.existsSync(file)).toBe(false);
});
test('reservation commit before failed floor write remains held after cold reopen', async () => {
  const entry = await open(true),
    store = await entry.openReservations();
  const rename = fs.renameSync.bind(fs);
  let armed = true;
  jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (armed && /wallet-railgun-accounts\/[0-9a-f]{64}\.json$/.test(to)) {
      armed = false;
      throw Error('floor write interrupted');
    }
    return rename(from, to);
  });
  await expect(store.reserve(reservationInput())).rejects.toThrow();
  expect(store.signal.aborted).toBe(true);
  entry.close();
  const cold = await open(),
    restored = await cold.openReservations();
  expect(await restored.inspect()).toEqual({ held: 1, signing: 0, abandoned: 0, legacy: 0 });
  await expect(restored.reserve(reservationInput())).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
  });
});
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
  expect(getPrivacyContext(entry.getContext('prover', 'private-verify')).subject.operation).toBe(
    'private-verify'
  );
  expect(() => entry.getContext('prover')).toThrow();
  expect(getPrivacyContext(entry.getContext('prover', 'poi-verify')).subject.operation).toBe(
    'poi-verify'
  );
  expect(() => entry.getContext('prover', 'poi-prove')).toThrow();
  expect(() => entry.getContext('prover', 'private-sign')).toThrow();
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
test('TXID keys require active catalog ownership and separate policy, public store and account generation', async () => {
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
  async function publish(generation, storeId) {
    const coordinator = {
      identity: {
        directory: generation.directory,
        binding: entry.binding,
        policy: generation.policy,
        ledgerId: '4'.repeat(64),
      },
      assertSnapshot: () => ({
        to: { number: 10 },
        source: { ledgerId: '4'.repeat(64) },
        state: { storeId },
      }),
    };
    mockCoordinators.add(coordinator);
    await catalog.publish(generation, coordinator, {});
  }
  const first = await catalog.begin('2'.repeat(64)),
    policy = 'a'.repeat(64);
  await expect(entry.withTxidGenerationKeys(catalog, first.id, policy, () => {})).rejects.toThrow();
  await publish(first, '5'.repeat(64));
  let firstKeys, buffers;
  await entry.withTxidGenerationKeys(catalog, first.id, policy, (keys) => {
    buffers = Object.values(keys);
    firstKeys = buffers.map((k) => k.toString('hex'));
  });
  expect(new Set(firstKeys).size).toBe(2);
  expect(buffers.every((k) => k.every((v) => v === 0))).toBe(true);
  await entry.withTxidGenerationKeys(catalog, first.id, 'b'.repeat(64), (keys) =>
    expect(new Set([...firstKeys, ...Object.values(keys).map((k) => k.toString('hex'))]).size).toBe(
      4
    )
  );
  await expect(
    entry.withTxidGenerationKeys({ ...catalog }, first.id, policy, () => {})
  ).rejects.toThrow();
  const second = await catalog.begin('3'.repeat(64));
  await publish(second, '6'.repeat(64));
  await expect(entry.withTxidGenerationKeys(catalog, first.id, policy, () => {})).rejects.toThrow();
  await entry.withTxidGenerationKeys(catalog, second.id, policy, (keys) =>
    expect(new Set([...firstKeys, ...Object.values(keys).map((k) => k.toString('hex'))]).size).toBe(
      4
    )
  );
  catalog.close();
});

const capsuleFile = (entry) =>
  require('./privacy-storage').getPrivacyStoragePath(
    entry.getContext('storage', 'railgun-private-capsules-v1:' + entry.descriptor.walletId),
    entry.directory
  );
test('capsule storage is enrollment-owned, inventoried once, cold reopenable and revoked on lock', async () => {
  const entry = await open(true),
    before = inventory().length;
  const pending = entry.openPrivateCapsules();
  await expect(entry.openPrivateCapsules()).rejects.toThrow();
  const store = await pending;
  expect(await entry.openPrivateCapsules()).toBe(store);
  expect(inventory()).toHaveLength(before + 2);
  expect(capsuleFile(entry)).not.toBe(reservationFile(entry));
  expect(await store.inspect()).toEqual({ records: 0, signatures: 0, proofs: 0, capacity: 32 });
  mockVault.abort();
  await expect(store.inspect()).rejects.toThrow();
  mockParent.close();
  bind();
  const cold = await open();
  expect(await (await cold.openPrivateCapsules()).inspect()).toEqual({
    records: 0,
    signatures: 0,
    proofs: 0,
    capacity: 32,
  });
  expect(inventory()).toHaveLength(before + 2);
});
test('missing capsule file prevents reopening instead of silently resetting recovery state', async () => {
  const entry = await open(true);
  await entry.openPrivateCapsules();
  const file = capsuleFile(entry);
  entry.close();
  fs.renameSync(file, file + '.retained');
  await expect(open()).rejects.toMatchObject({ code: 'PRIVATE_PROFILE_STORE_MISSING' });
  expect(fs.existsSync(file)).toBe(false);
});
test('capsule initialization survives its file write before the account floor commits', async () => {
  const entry = await open(true);
  await entry.openReservations();
  const rename = fs.renameSync.bind(fs);
  let armed = true;
  jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (armed && /wallet-railgun-accounts\/[0-9a-f]{64}\.json$/.test(to)) {
      armed = false;
      throw Error('capsule floor interrupted');
    }
    return rename(from, to);
  });
  await expect(entry.openPrivateCapsules()).rejects.toThrow();
  entry.close();
  const cold = await open();
  expect(await (await cold.openPrivateCapsules()).inspect()).toEqual({
    records: 0,
    signatures: 0,
    proofs: 0,
    capacity: 32,
  });
});

test('signing requires a persisted capsule and recovery enumerates receipts only under an exclusive phase', async () => {
  const data = require('../../../scripts/fixtures/railgun-capsule-data');
  const entry = await open(true),
    capsules = await entry.openPrivateCapsules(),
    reservations = await entry.openReservations();
  const capsule = data.capsule(entry.descriptor.walletId),
    held = await reservations.reserve(data.facts(capsule));
  const record = await capsules.put(held, capsule, '9'.repeat(64));
  const evidence = {
    submitter: '0x' + '12'.repeat(20),
    operationId: '8'.repeat(64),
    gatesDigest: '9'.repeat(64),
  };
  const receipt = await capsules.markSigning(held, evidence);
  expect((await reservations.assertReceipt(receipt)).signing.gatesDigest).not.toBe(
    evidence.gatesDigest
  );
  entry.close();
  const cold = await open(),
    recoveredCapsules = await cold.openPrivateCapsules(),
    recovered = await cold.openReservations();
  const { claimRailgunAccountPhase } = require('./railgun-account-phase');
  const phase = claimRailgunAccountPhase(cold, 'wallet');
  await expect(recovered.withSigningRecovery(() => {})).rejects.toMatchObject({
    code: 'RAILGUN_ACCOUNT_PHASE_BUSY',
  });
  phase.release();
  await recovered.withSigningRecovery(async (records) => {
    expect(records).toHaveLength(1);
    expect(records[0].entry.id).toBe(record.holdId);
    expect(() => claimRailgunAccountPhase(cold, 'wallet')).toThrow();
    const signature = {
      R8: ['0x' + '0'.repeat(63) + '1', '0x' + '0'.repeat(63) + '2'],
      S: '0x' + '0'.repeat(63) + '3',
    };
    await recoveredCapsules.saveSignature(records[0].receipt, signature);
  });
  expect((await recoveredCapsules.get(record.holdId)).signature).not.toBeNull();
  const next = claimRailgunAccountPhase(cold, 'wallet');
  next.release();
});
test('direct signing without the enrollment-owned capsule permit is refused', async () => {
  const entry = await open(true),
    reservations = await entry.openReservations();
  const held = await reservations.reserve(reservationInput());
  await expect(
    reservations.markSigning(held, {
      submitter: '0x' + '12'.repeat(20),
      operationId: '8'.repeat(64),
      gatesDigest: '9'.repeat(64),
    })
  ).rejects.toThrow();
  expect(reservations.signal.aborted).toBe(true);
});

const poiIntentFile = (entry) =>
  require('./privacy-storage').getPrivacyStoragePath(
    entry.getContext('storage', 'railgun-poi-intents-v1:' + entry.descriptor.walletId),
    entry.directory
  );
const emptyPoiIntents = {
  records: 0,
  sequence: 0,
  capacity: 32,
  reservedTransitions: 0,
  freeTransitions: 128,
};
function deferredPoi() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}
test('POI intent storage opens lazily in one separate encrypted inventoried file', async () => {
  const entry = await open(true),
    previousInventory = inventory(),
    file = poiIntentFile(entry);
  expect(fs.existsSync(file)).toBe(false);
  const pending = entry.openPoiIntents();
  await expect(entry.openPoiIntents()).rejects.toThrow();
  const store = await pending;
  expect(await entry.openPoiIntents()).toBe(store);
  expect(await store.inspect()).toEqual(emptyPoiIntents);
  expect(await store.list()).toEqual([]);
  expect(inventory()).toHaveLength(previousInventory.length + 1);
  expect(inventory().filter((name) => !previousInventory.includes(name))).toEqual([
    path.relative(mockProfile.userDataDir, file),
  ]);
  expect(fs.existsSync(reservationFile(entry))).toBe(false);
  expect(fs.existsSync(capsuleFile(entry))).toBe(false);
  const bytes = fs.readFileSync(file, 'utf8'),
    encrypted = JSON.parse(bytes);
  expect(Object.keys(encrypted).sort()).toEqual(['ciphertext', 'iv', 'tag', 'version']);
  for (const privateText of [mockMnemonic, 'public-fixture', 'entries', entry.binding])
    expect(bytes).not.toContain(privateText);
  expect(inventory()).toHaveLength(previousInventory.length + 1);
});
test.each(['close', 'vault-lock'])(
  'POI intent store revokes on %s, drains and reopens retained empty state',
  async (reason) => {
    const entry = await open(true),
      store = await entry.openPoiIntents(),
      file = poiIntentFile(entry),
      files = inventory();
    if (reason === 'close') entry.close();
    else mockVault.abort();
    expect(store.signal.aborted).toBe(true);
    await expect(store.inspect()).rejects.toThrow();
    await expect(entry.openPoiIntents()).rejects.toThrow();
    await store.closed;
    expect(fs.existsSync(file)).toBe(true);
    if (reason === 'vault-lock') {
      mockParent.close();
      bind();
    }
    const cold = await open(),
      restored = await cold.openPoiIntents();
    expect(restored).not.toBe(store);
    expect(await restored.inspect()).toEqual(emptyPoiIntents);
    expect(inventory()).toEqual(files);
  }
);
test('missing POI intent file refuses enrollment reopen without recreating it', async () => {
  const entry = await open(true),
    store = await entry.openPoiIntents(),
    file = poiIntentFile(entry);
  entry.close();
  await store.closed;
  fs.renameSync(file, file + '.retained');
  await expect(open()).rejects.toMatchObject({ code: 'PRIVATE_PROFILE_STORE_MISSING' });
  expect(fs.existsSync(file)).toBe(false);
  expect(fs.existsSync(file + '.retained')).toBe(true);
});
test('POI initialization file survives an interrupted manifest floor write and restart', async () => {
  const entry = await open(true),
    file = poiIntentFile(entry),
    rename = fs.renameSync.bind(fs);
  let armed = true;
  jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (armed && /wallet-railgun-accounts\/[0-9a-f]{64}\.json$/.test(to)) {
      armed = false;
      throw Error('POI floor interrupted');
    }
    return rename(from, to);
  });
  await expect(entry.openPoiIntents()).rejects.toMatchObject({
    code: 'RAILGUN_POI_INTENT_STORE_REFUSED',
  });
  expect(armed).toBe(false);
  expect(fs.existsSync(file)).toBe(true);
  expect(inventory()).toContain(path.relative(mockProfile.userDataDir, file));
  entry.close();
  const cold = await open(),
    store = await cold.openPoiIntents();
  expect(await store.inspect()).toEqual(emptyPoiIntents);
  expect(await store.list()).toEqual([]);
});
test.each(['close', 'vault-lock'])(
  'POI initialization retains its owner and wipes its borrowed key during %s',
  async (reason) => {
    const entry = await open(true),
      entered = deferredPoi(),
      release = deferredPoi();
    let key,
      lateFloorCalls = 0;
    mockPoiFactoryHook = (options, create) => {
      mockPoiFactoryHook = undefined;
      key = options.key;
      return create({
        ...options,
        async advanceFloor(sequence) {
          entered.resolve();
          await release.promise;
          lateFloorCalls++;
          return options.advanceFloor(sequence);
        },
      });
    };
    const pending = entry.openPoiIntents(),
      settled = pending.then(
        (value) => ({ value }),
        (error) => ({ error })
      );
    try {
      await Promise.race([
        entered.promise,
        settled.then(() => {
          throw Error('POI initialization settled before held floor');
        }),
      ]);
      expect(key.some((byte) => byte !== 0)).toBe(true);
      if (reason === 'close') entry.close();
      else mockVault.abort();
      expect(key.every((byte) => byte === 0)).toBe(true);
      if (reason === 'vault-lock') {
        mockParent.close();
        bind();
      }
      const cold = await open(),
        manifest = path.join(
          mockProfile.userDataDir,
          inventory().find((name) => !name.includes('/account-'))
        ),
        before = fs.readFileSync(manifest);
      await expect(cold.openPoiIntents()).rejects.toMatchObject({
        code: 'RAILGUN_POI_INTENT_STORE_REFUSED',
      });
      expect(lateFloorCalls).toBe(0);
      release.resolve();
      expect((await settled).error).toMatchObject({ code: 'RAILGUN_POI_INTENT_STORE_REFUSED' });
      expect(lateFloorCalls).toBe(1);
      expect(fs.readFileSync(manifest)).toEqual(before);
      expect(await (await cold.openPoiIntents()).inspect()).toEqual(emptyPoiIntents);
    } finally {
      entry.close();
      release.resolve();
      await settled;
      mockPoiFactoryHook = undefined;
    }
  }
);
test('cold enrollment and POI store opening do not import proof, recovery or membership controllers', async () => {
  const forbidden = [
    './railgun-own-poi-proof',
    './railgun-own-operation',
    './railgun-own-poi-checks',
    './railgun-own-poi-membership',
    './railgun-own-poi-binding',
  ];
  const loaded = [],
    parent = mockParent;
  for (const name of forbidden)
    jest.doMock(name, () => {
      loaded.push(name);
      throw Error('Unexpected controller import');
    });
  try {
    await jest.isolateModulesAsync(async () => {
      // The outer hook's actual factory belongs to the outer privacy-context
      // and enrollment registries. This cold load must use one isolated graph.
      jest.dontMock('./railgun-poi-intent-store');
      const { createPrivacyScope: createScope } = require('../networks/privacy-context');
      mockParent = createScope({
        profileId: createHash('sha256')
          .update(JSON.stringify([mockProfile.id, mockProfile.userDataDir]))
          .digest('hex'),
        signal: mockVault.signal,
      });
      let entry, store;
      try {
        const { openRailgunAccountEnrollment: openCold } = require('./railgun-account-enrollment');
        entry = await openCold({ identity: mockIdentity, create: true });
        store = await entry.openPoiIntents();
        expect(await store.inspect()).toEqual(emptyPoiIntents);
        expect(loaded).toEqual([]);
      } finally {
        entry?.close();
        if (store) await store.closed;
        mockParent.close();
      }
    });
  } finally {
    mockParent = parent;
    jest.doMock('./railgun-poi-intent-store', () => {
      const actual = jest.requireActual('./railgun-poi-intent-store');
      return {
        createRailgunPoiIntentStore: (options) =>
          mockPoiFactoryHook
            ? mockPoiFactoryHook(options, actual.createRailgunPoiIntentStore)
            : actual.createRailgunPoiIntentStore(options),
      };
    });
    for (const name of forbidden) jest.dontMock(name);
  }
});

function poiPhysicalSnapshot() {
  const files = [];
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (fs.lstatSync(file).isDirectory()) walk(file);
      else files.push([path.relative(mockProfile.userDataDir, file), fs.readFileSync(file)]);
    }
  };
  walk(mockProfile.userDataDir);
  return files;
}
function watchPoiDerivation() {
  const hmac = require('crypto').createHmac('sha256', Buffer.alloc(32));
  return jest.spyOn(Object.getPrototypeOf(hmac), 'update');
}
function expectNoPoiDerivation(spy) {
  expect(
    spy.mock.calls.filter(([value]) => value === JSON.stringify([1, 'poi-intents', null]))
  ).toEqual([]);
}

test.each([undefined, {}, { existingOnly: false }])(
  'POI opening preserves default creation for options %#',
  async (options) => {
    const entry = await open(true);
    const creations = [];
    mockPoiFactoryHook = (input, create) => {
      creations.push(input.create);
      return create(input);
    };
    const store = await entry.openPoiIntents(options);
    expect(await store.inspect()).toEqual(emptyPoiIntents);
    expect(creations).toEqual([true]);
    expect(fs.existsSync(poiIntentFile(entry))).toBe(true);
  }
);
test('existing-only missing POI file refuses before derivation, factory or any write', async () => {
  const entry = await open(true),
    before = poiPhysicalSnapshot(),
    derive = watchPoiDerivation(),
    rename = jest.spyOn(fs, 'renameSync'),
    factory = jest.fn();
  mockPoiFactoryHook = factory;
  await expect(entry.openPoiIntents({ existingOnly: true })).rejects.toMatchObject({
    code: 'RAILGUN_ACCOUNT_ENROLLMENT_REFUSED',
  });
  expectNoPoiDerivation(derive);
  expect(factory).not.toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
  expect(poiPhysicalSnapshot()).toEqual(before);
  mockPoiFactoryHook = undefined;
  expect(await (await entry.openPoiIntents()).inspect()).toEqual(emptyPoiIntents);
});
test.each([false, true])('invalid POI options refuse before cached=%s return', async (cached) => {
  const entry = await open(true);
  if (cached) await entry.openPoiIntents();
  const before = poiPhysicalSnapshot(),
    derive = watchPoiDerivation(),
    factory = jest.fn();
  mockPoiFactoryHook = factory;
  for (const options of [
    null,
    false,
    true,
    1,
    'PRIVATE',
    [],
    { existingOnly: undefined },
    { existingOnly: null },
    { existingOnly: 1 },
    { existingOnly: 'true' },
    { extra: true },
    { existingOnly: true, extra: false },
    { [Symbol('extra')]: true },
  ])
    await expect(entry.openPoiIntents(options)).rejects.toMatchObject({
      code: 'RAILGUN_ACCOUNT_ENROLLMENT_REFUSED',
    });
  expectNoPoiDerivation(derive);
  expect(factory).not.toHaveBeenCalled();
  expect(poiPhysicalSnapshot()).toEqual(before);
});
test('existing-only healthy cached POI store is reused without initialization', async () => {
  const entry = await open(true),
    store = await entry.openPoiIntents(),
    before = poiPhysicalSnapshot(),
    derive = watchPoiDerivation(),
    factory = jest.fn();
  mockPoiFactoryHook = factory;
  expect(await entry.openPoiIntents({ existingOnly: true })).toBe(store);
  expectNoPoiDerivation(derive);
  expect(factory).not.toHaveBeenCalled();
  expect(poiPhysicalSnapshot()).toEqual(before);
});
test('existing-only refuses a renamed cached POI store without recreating it', async () => {
  const entry = await open(true),
    store = await entry.openPoiIntents(),
    file = poiIntentFile(entry);
  fs.renameSync(file, file + '.retained');
  const before = poiPhysicalSnapshot(),
    derive = watchPoiDerivation(),
    factory = jest.fn();
  mockPoiFactoryHook = factory;
  await expect(entry.openPoiIntents({ existingOnly: true })).rejects.toThrow();
  expectNoPoiDerivation(derive);
  expect(factory).not.toHaveBeenCalled();
  expect(poiPhysicalSnapshot()).toEqual(before);
  expect(fs.existsSync(file)).toBe(false);
  fs.renameSync(file + '.retained', file);
  expect(await entry.openPoiIntents({ existingOnly: true })).toBe(store);
});
test('existing-only cold POI reopen authenticates retained state with creation disabled', async () => {
  const entry = await open(true),
    store = await entry.openPoiIntents();
  entry.close();
  await store.closed;
  const cold = await open(),
    creations = [];
  mockPoiFactoryHook = (input, create) => {
    creations.push(input.create);
    return create(input);
  };
  expect(await (await cold.openPoiIntents({ existingOnly: true })).inspect()).toEqual(
    emptyPoiIntents
  );
  expect(creations).toEqual([false]);
});
test('existing-only raced removal after presence check cannot create an empty POI file', async () => {
  const entry = await open(true),
    store = await entry.openPoiIntents(),
    file = poiIntentFile(entry);
  store.close();
  await store.closed;
  const before = poiPhysicalSnapshot(),
    creations = [];
  mockPoiFactoryHook = (input, create) => {
    creations.push(input.create);
    fs.renameSync(file, file + '.retained');
    return create(input);
  };
  await expect(entry.openPoiIntents({ existingOnly: true })).rejects.toThrow();
  expect(creations).toEqual([false]);
  expect(fs.existsSync(file)).toBe(false);
  fs.renameSync(file + '.retained', file);
  expect(poiPhysicalSnapshot()).toEqual(before);
  mockPoiFactoryHook = undefined;
  expect(await (await entry.openPoiIntents({ existingOnly: true })).inspect()).toEqual(
    emptyPoiIntents
  );
});
test('existing-only repeats missing-file check after an old store drain', async () => {
  const entry = await open(true),
    gate = deferredPoi();
  let original;
  mockPoiFactoryHook = async (input, create) => {
    original = await create(input);
    return Object.freeze({ ...original, closed: gate.promise });
  };
  const store = await entry.openPoiIntents(),
    file = poiIntentFile(entry);
  store.close();
  await original.closed;
  const factory = jest.fn(),
    derive = watchPoiDerivation();
  mockPoiFactoryHook = factory;
  const pending = entry.openPoiIntents({ existingOnly: true });
  const settled = pending.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  try {
    fs.renameSync(file, file + '.retained');
    const before = poiPhysicalSnapshot();
    gate.resolve();
    expect((await settled).error).toBeDefined();
    expect(factory).not.toHaveBeenCalled();
    expectNoPoiDerivation(derive);
    expect(poiPhysicalSnapshot()).toEqual(before);
  } finally {
    gate.resolve();
    await settled;
    fs.renameSync(file + '.retained', file);
  }
});
test.each(['directory', 'symlink', 'hardlink'])(
  'existing-only rejects a %s POI target before key or factory',
  async (kind) => {
    const entry = await open(true),
      file = poiIntentFile(entry);
    if (kind === 'directory') fs.mkdirSync(file);
    else {
      const retained = file + '.retained';
      fs.writeFileSync(retained, 'not an encrypted POI document');
      if (kind === 'symlink') fs.symlinkSync(retained, file);
      else fs.linkSync(retained, file);
    }
    const derive = watchPoiDerivation(),
      factory = jest.fn(),
      rename = jest.spyOn(fs, 'renameSync');
    mockPoiFactoryHook = factory;
    await expect(entry.openPoiIntents({ existingOnly: true })).rejects.toThrow();
    expectNoPoiDerivation(derive);
    expect(factory).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  }
);
test('existing-only initialization refuses concurrent opens and wipes borrowed key on close', async () => {
  const entry = await open(true),
    previous = await entry.openPoiIntents();
  previous.close();
  await previous.closed;
  const entered = deferredPoi(),
    release = deferredPoi();
  let key, createFlag;
  mockPoiFactoryHook = (input, create) => {
    key = input.key;
    createFlag = input.create;
    return create({
      ...input,
      async advanceFloor(sequence) {
        entered.resolve();
        await release.promise;
        return input.advanceFloor(sequence);
      },
    });
  };
  const pending = entry.openPoiIntents({ existingOnly: true }),
    settled = pending.then(
      (value) => ({ value }),
      (error) => ({ error })
    );
  try {
    await Promise.race([
      entered.promise,
      settled.then(() => {
        throw Error('initialization ended early');
      }),
    ]);
    expect(createFlag).toBe(false);
    expect(key.some((byte) => byte !== 0)).toBe(true);
    await expect(entry.openPoiIntents({ existingOnly: true })).rejects.toThrow();
    entry.close();
    expect(key.every((byte) => byte === 0)).toBe(true);
    release.resolve();
    expect((await settled).error).toBeDefined();
  } finally {
    release.resolve();
    await settled;
  }
});
