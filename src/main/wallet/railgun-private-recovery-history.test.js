/** Real encrypted reservation/capsule stores and receipt binding; enrollment,
 * identity/destination issuers and account phase are explicit structural seams.
 * No genuine wallet enrollment or native cryptographic qualification claimed. */
let mock;
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (value) => value === mock.owners.enrollment,
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (...args) => mock.identity(...args),
}));
jest.mock('./railgun-account-public', () => ({
  assertRailgunAccountPublicDestination: (...args) => mock.destination(...args),
}));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPrivacyStorage } = require('./privacy-storage');
const { createRailgunPrivateReservations } = require('./railgun-private-reservations');
const {
  createRailgunPrivateCapsuleStore,
  consumeRailgunCapsuleSigningPermit,
} = require('./railgun-private-capsule-store');
const { validateRailgunPrivateSigningIntent } = require('./railgun-private-intent');
const {
  createRailgunLegacyCapsuleData,
  createRailgunPartialCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
const { readRailgunPrivateRecoveryHistory: read } = require('./railgun-private-recovery-history');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const errorCode = 'RAILGUN_PRIVATE_RECOVERY_HISTORY_REFUSED';
const error = (code) => Object.assign(new Error('private store detail'), { code });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let scope, reservations, capsules, directory, reservationOptions, capsuleOptions, n;
const files = () =>
  Object.fromEntries(
    fs
      .readdirSync(directory)
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(directory, name)).toString('hex')])
  );
async function openStores(create) {
  reservations = await createRailgunPrivateReservations({ ...reservationOptions, create });
  capsules = await createRailgunPrivateCapsuleStore({ ...capsuleOptions, reservations, create });
  return { reservations, capsules };
}
beforeEach(async () => {
  n = 0;
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  scope = createPrivacyScope({
    profileId: 'recovery-history-fixture',
    signal: controllers[0].signal,
  });
  const walletId = '5'.repeat(64),
    descriptor = Object.freeze({ walletId, accountIndex: 0 }),
    subject = {
      kind: 'private-account',
      principal: 'railgun:0',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      role: 'storage',
    };
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-history-')));
  mock = {
    controllers,
    floors: { reservation: null, capsule: null },
    phaseBusy: false,
    phaseReleases: 0,
  };
  reservationOptions = {
    handle: scope.getContext({
      ...subject,
      operation: 'railgun-private-reservations-v1:' + walletId,
    }),
    directory,
    key: Buffer.alloc(32, 6),
    binding: '6'.repeat(64),
    walletId,
    readFloor: async () => mock.floors.reservation,
    advanceFloor: jest.fn(async (value) => {
      mock.floors.reservation = value;
    }),
    authorizeSigning: (permit, store, receipt, evidence) =>
      consumeRailgunCapsuleSigningPermit(permit, capsules, store, receipt, evidence),
    claimRecovery: () => {
      if (mock.phaseBusy) throw Error('phase busy');
      mock.phaseBusy = true;
      return {
        assertCurrent() {
          if (!mock.phaseBusy) throw Error('phase stale');
        },
        release() {
          mock.phaseBusy = false;
          mock.phaseReleases++;
        },
      };
    },
  };
  capsuleOptions = {
    handle: scope.getContext({ ...subject, operation: 'railgun-private-capsules-v1:' + walletId }),
    directory,
    key: Buffer.alloc(32, 7),
    binding: '6'.repeat(64),
    walletId,
    readFloor: async () => mock.floors.capsule,
    advanceFloor: jest.fn(async (value) => {
      mock.floors.capsule = value;
    }),
  };
  await openStores(true);
  const parent = Object.freeze({});
  mock.owners = {
    identity: { descriptor, signal: controllers[1].signal },
    enrollment: {
      descriptor,
      signal: controllers[0].signal,
      getContext: jest.fn(() => parent),
      openPrivateRecoveryStores: jest.fn(async () => ({ reservations, capsules })),
    },
    coordinator: { signal: controllers[2].signal },
  };
  mock.identity = jest.fn((identity, context) => {
    expect(identity).toBe(mock.owners.identity);
    expect(context).toBe(parent);
    return identity.descriptor;
  });
  const destination = Object.freeze({});
  mock.destination = jest.fn((coordinator, enrollment, value) => {
    expect(coordinator).toBe(mock.owners.coordinator);
    expect(enrollment).toBe(mock.owners.enrollment);
    expect(value).toBe(destination);
  });
  mock.options = { owners: mock.owners, destination, signal: controllers[3].signal, after: null };
});
afterEach(() => {
  capsules?.close();
  reservations?.close();
  scope.close();
  jest.restoreAllMocks();
});
async function add(kind = 'railgun-token-unshield', state = 'signed-unfinished') {
  const f =
    kind === 'railgun-partial-unshield'
      ? createRailgunPartialCapsuleData()
      : createRailgunLegacyCapsuleData(kind);
  const c = f.capsule;
  c.walletId = capsuleOptions.walletId;
  c.selection.position = ++n;
  c.preparation.expected.nullifier = hex(n);
  f.inner.nullifiers = [hex(n)];
  c.preparation.transaction.data = f.encode();
  const receipt = await reservations.reserve({
    tree: c.selection.tree,
    position: n,
    nullifier: c.preparation.expected.nullifier,
    noteHash: c.noteHash,
    kind,
    intentDigest: validateRailgunPrivateSigningIntent(
      c.preparation.transaction,
      c.preparation.expected
    ).digest,
    checkpointHash: 'a'.repeat(64),
    poiDigest: 'b'.repeat(64),
  });
  if (state === 'abandoned') {
    await reservations.abandon(receipt);
    return;
  }
  const stored = await capsules.put(receipt, c, '9'.repeat(64));
  if (state === 'held') return stored.holdId;
  const signed = await capsules.markSigning(receipt, {
    submitter: '0x' + '12'.repeat(20),
    operationId: '8'.repeat(64),
    gatesDigest: '9'.repeat(64),
  });
  if (state !== 'signature-unavailable')
    await capsules.saveSignature(signed, { R8: [hex(1), hex(2)], S: hex(3) });
  if (state === 'proof-present') {
    f.inner.proof.a.x = 1;
    await capsules.saveProvedTransaction(signed, {
      ...c.preparation.transaction,
      data: f.encode(),
    });
  }
  return stored.holdId;
}
test('real stores authenticate all kinds/states; warm discovery preserves exact files and floors', async () => {
  const expected = [];
  for (const kind of [
    'railgun-private-transfer',
    'railgun-token-unshield',
    'railgun-partial-unshield',
  ])
    for (const localState of ['signed-unfinished', 'proof-present', 'signature-unavailable'])
      expected.push({ holdId: await add(kind, localState), kind, localState });
  await add('railgun-token-unshield', 'held');
  await add('railgun-token-unshield', 'abandoned');
  const before = files(),
    floors = { ...mock.floors };
  const page = await read(mock.options);
  expect(page).toEqual({
    records: expected.sort((a, b) => a.holdId.localeCompare(b.holdId)),
    nextAfter: null,
    totalSigning: 9,
  });
  expect(Object.isFrozen(page)).toBe(true);
  expect(Object.isFrozen(page.records)).toBe(true);
  page.records.forEach((v) => {
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.keys(v)).toEqual(['holdId', 'kind', 'localState']);
    Object.values(v).forEach((x) => expect(typeof x).toBe('string'));
  });
  expect(files()).toEqual(before);
  expect(mock.floors).toEqual(floors);
  expect(mock.phaseBusy).toBe(false);
  expect(await reservations.inspect()).toEqual({ held: 1, signing: 9, abandoned: 1, legacy: 0 });
});
test('real 17-record pagination authenticates each page and later additions independently', async () => {
  const ids = [];
  for (let i = 0; i < 17; i++) ids.push(await add());
  ids.sort();
  const first = await read(mock.options);
  expect(first.records.map((v) => v.holdId)).toEqual(ids.slice(0, 16));
  expect(first.nextAfter).toBe(ids[15]);
  expect(first.totalSigning).toBe(17);
  const next = await read({ ...mock.options, after: first.nextAfter });
  expect(next.records.map((v) => v.holdId)).toEqual(ids.slice(16));
  expect(next.nextAfter).toBe(null);
  const fresh = await add();
  const reread = await read(mock.options);
  expect(reread.totalSigning).toBe(18);
  expect([...ids, fresh].sort().slice(0, 16)).toEqual(reread.records.map((v) => v.holdId));
  expect(await read({ ...mock.options, after: 'f'.repeat(64) })).toEqual({
    records: [],
    nextAfter: null,
    totalSigning: 18,
  });
});
test('empty history is authenticated; absent existing stores never become an empty success', async () => {
  expect(await read(mock.options)).toEqual({ records: [], nextAfter: null, totalSigning: 0 });
  const before = files();
  mock.owners.enrollment.openPrivateRecoveryStores.mockRejectedValue(
    error('MISSING_REGISTERED_HISTORY')
  );
  await expect(read(mock.options)).rejects.toMatchObject({ code: errorCode });
  expect(files()).toEqual(before);
});
test('cold genuine store reopen changes leases without changing entries or sequence; warm reread is byte-identical', async () => {
  const id = await add();
  const before = files(),
    floors = { ...mock.floors };
  capsules.close();
  reservations.close();
  await openStores(false);
  const reopened = files();
  expect(reopened).not.toEqual(before);
  expect(mock.floors).toEqual(floors);
  const page = await read(mock.options);
  expect(page.records).toEqual([
    { holdId: id, kind: 'railgun-token-unshield', localState: 'signed-unfinished' },
  ]);
  expect(files()).toEqual(reopened);
  expect(await capsules.inspect()).toEqual({ records: 1, signatures: 1, proofs: 0, capacity: 32 });
});
test('copied recovery receipt refuses even though unscoped get can retrieve the genuine capsule', async () => {
  const id = await add();
  expect((await capsules.get(id)).holdId).toBe(id);
  const real = reservations.withSigningRecovery;
  mock.owners.enrollment.openPrivateRecoveryStores.mockResolvedValue({
    capsules,
    reservations: {
      withSigningRecovery: (use, opts) =>
        real(
          (values, context) =>
            use(
              values.map((v) => ({ ...v, receipt: Object.freeze({ ...v.receipt }) })),
              context
            ),
          opts
        ),
    },
  });
  await expect(read(mock.options)).rejects.toMatchObject({ code: errorCode });
});
test('signature-unavailable is binding checked, expected NOT_READY preserves later genuine read', async () => {
  const id = await add('railgun-token-unshield', 'signature-unavailable');
  expect((await read(mock.options)).records[0]).toEqual({
    holdId: id,
    kind: 'railgun-token-unshield',
    localState: 'signature-unavailable',
  });
  expect(capsules.signal.aborted).toBe(false);
  expect(reservations.signal.aborted).toBe(false);
  await expect(read(mock.options)).resolves.toMatchObject({ totalSigning: 1 });
});
test('unexpected attestation corruption refuses whole page with sanitized error, not a diagnostic row', async () => {
  await add();
  const file = path.join(directory, Object.keys(files())[0]);
  fs.writeFileSync(file, 'secret-corrupt-ciphertext');
  const result = await read(mock.options).catch((e) => e);
  expect(result.code).toBe(errorCode);
  expect(result.message).toBe('Railgun recovery history unavailable');
  expect(Object.keys(result)).toEqual(['code']);
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(reservations.signal.aborted).toBe(true);
});
test.each(['identity', 'enrollment', 'coordinator'])(
  'copied %s refused before store open',
  (key) => {
    return expect(
      read({ ...mock.options, owners: { ...mock.owners, [key]: { ...mock.owners[key] } } })
    )
      .rejects.toMatchObject({ code: errorCode })
      .then(() => expect(mock.owners.enrollment.openPrivateRecoveryStores).not.toHaveBeenCalled());
  }
);
test.each([undefined, 'A'.repeat(64), 'x', 0, {}, null])(
  'invalid options/cursor boundary %p',
  async (value) => {
    const options = value === null ? null : { ...mock.options, after: value };
    await expect(read(options)).rejects.toMatchObject({ code: errorCode });
    expect(mock.owners.enrollment.openPrivateRecoveryStores).not.toHaveBeenCalled();
  }
);
test('no caller accessors or proxy traps execute', async () => {
  const hook = jest.fn(() => {
    throw Error('hook');
  });
  for (const value of [
    new Proxy({}, { getPrototypeOf: hook }),
    Object.defineProperty({ ...mock.options }, 'owners', { get: hook }),
    { ...mock.options, extra: true },
  ])
    await expect(read(value)).rejects.toMatchObject({ code: errorCode });
  expect(hook).not.toHaveBeenCalled();
});
test('abort during admitted original open waits then refuses; owner remains borrowed', async () => {
  const d = deferred();
  mock.owners.enrollment.openPrivateRecoveryStores.mockReturnValue(d.promise);
  const p = read(mock.options);
  let settled = false;
  p.catch(() => {
    settled = true;
  });
  mock.controllers[3].abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  d.resolve({ reservations, capsules });
  await expect(p).rejects.toMatchObject({ code: errorCode });
  expect(mock.owners.enrollment.signal.aborted).toBe(false);
  expect(mock.phaseReleases).toBe(0);
});
test('owner drift after store opening refuses before phase', async () => {
  mock.owners.enrollment.openPrivateRecoveryStores.mockImplementation(async () => {
    mock.owners.enrollment.descriptor = { walletId: 'f'.repeat(64) };
    return { reservations, capsules };
  });
  await expect(read(mock.options)).rejects.toMatchObject({ code: errorCode });
  expect(mock.phaseReleases).toBe(0);
});
test('original phase is retained across held genuine receipt read; abort returns no partial page', async () => {
  await add();
  const d = deferred(),
    entered = deferred(),
    real = capsules.readSignedUnfinished;
  mock.owners.enrollment.openPrivateRecoveryStores.mockResolvedValue({
    reservations,
    capsules: {
      readSignedUnfinished: async (receipt) => {
        const value = await real(receipt);
        entered.resolve();
        await d.promise;
        return value;
      },
      readSigned: capsules.readSigned,
    },
  });
  const p = read(mock.options);
  p.catch(() => {});
  await entered.promise;
  expect(mock.phaseBusy).toBe(true);
  mock.controllers[3].abort();
  await Promise.resolve();
  expect(mock.phaseBusy).toBe(true);
  d.resolve();
  await expect(p).rejects.toMatchObject({ code: errorCode });
  expect(mock.phaseBusy).toBe(false);
  expect(reservations.signal.aborted).toBe(true);
});
// Synthetic upper-bound/data-error projections below test the reader boundary;
// they do not claim 512 signed capsules are constructible under the 32 cap.
function projected(records, reader) {
  mock.owners.enrollment.openPrivateRecoveryStores.mockResolvedValue({
    reservations: { withSigningRecovery: async (use) => use(records, { assertCurrent() {} }) },
    capsules: { readSignedUnfinished: reader, readSigned: reader },
  });
}
const rows = (count) =>
  Array.from({ length: count }, (_, i) => ({
    entry: {
      id: (count - i).toString(16).padStart(64, '0'),
      state: 'signing',
      facts: { kind: 'railgun-token-unshield' },
    },
    receipt: { i: count - i },
  }));
test('512 bound sorts copy, retains real row objects inside phase and exposes only 16 detached primitives', async () => {
  const values = rows(512),
    before = [...values];
  const reader = jest.fn(async (receipt) => ({
    holdId: receipt.i.toString(16).padStart(64, '0'),
    capsule: { walletId: mock.owners.enrollment.descriptor.walletId },
  }));
  projected(values, reader);
  const page = await read(mock.options);
  expect(page.totalSigning).toBe(512);
  expect(page.records).toHaveLength(16);
  expect(page.nextAfter).toBe('10'.padStart(64, '0'));
  expect(values).toEqual(before);
  expect(reader.mock.calls.map((v) => v[0])).toEqual(
    before
      .slice(-16)
      .reverse()
      .map((v) => v.receipt)
  );
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(4096);
});
test.each([
  'oversize',
  'duplicate',
  'wrong-state',
  'unknown-kind',
  'wallet-mismatch',
  'id-mismatch',
])('malformed projected %s refuses', async (mode) => {
  const values = rows(mode === 'oversize' ? 513 : 2);
  if (mode === 'duplicate') values[1] = values[0];
  if (mode === 'wrong-state') values[0].entry.state = 'held';
  if (mode === 'unknown-kind') values[0].entry.facts.kind = 'other';
  projected(values, async (receipt) => ({
    holdId: mode === 'id-mismatch' ? 'f'.repeat(64) : receipt.i.toString(16).padStart(64, '0'),
    capsule: {
      walletId:
        mode === 'wallet-mismatch' ? 'f'.repeat(64) : mock.owners.enrollment.descriptor.walletId,
    },
  }));
  await expect(read(mock.options)).rejects.toMatchObject({ code: errorCode });
});
test('missing capsule is reservation-only diagnostic; unexpected refusal never becomes a row', async () => {
  projected(rows(1), async () => {
    throw error('RAILGUN_CAPSULE_NOT_FOUND');
  });
  expect((await read(mock.options)).records[0].localState).toBe('capsule-unavailable');
  projected(rows(1), async () => {
    throw error('RAILGUN_CAPSULE_REFUSED');
  });
  await expect(read(mock.options)).rejects.toMatchObject({ code: errorCode });
});

test('canonical encrypted record with wrong signing digest refuses instead of reporting a signed state', async () => {
  await add();
  capsules.close();
  const storage = createPrivacyStorage(capsuleOptions);
  await storage.update('railgun-private-capsules-v1', (text) => {
    const value = JSON.parse(text);
    value.entries[0].signingDigest = '0'.repeat(64);
    return JSON.stringify(value);
  });
  capsules = await createRailgunPrivateCapsuleStore({
    ...capsuleOptions,
    reservations,
    create: false,
  });
  await expect(read(mock.options)).rejects.toMatchObject({ code: errorCode });
  expect(capsules.signal.aborted).toBe(true);
  expect(reservations.signal.aborted).toBe(true);
});
test('canonical encrypted capsule facts mismatch cannot become signature-unavailable', async () => {
  await add('railgun-token-unshield', 'signature-unavailable');
  capsules.close();
  const storage = createPrivacyStorage(capsuleOptions);
  await storage.update('railgun-private-capsules-v1', (text) => {
    const value = JSON.parse(text);
    value.entries[0].factsDigest = '0'.repeat(64);
    return JSON.stringify(value);
  });
  capsules = await createRailgunPrivateCapsuleStore({
    ...capsuleOptions,
    reservations,
    create: false,
  });
  await expect(read(mock.options)).rejects.toMatchObject({ code: errorCode });
  expect(capsules.signal.aborted).toBe(true);
});
test('fixed history deadline revokes acceptance but does not race original open', async () => {
  jest.useFakeTimers();
  try {
    const d = deferred();
    mock.owners.enrollment.openPrivateRecoveryStores.mockReturnValue(d.promise);
    const pending = read(mock.options);
    let settled = false;
    pending.catch(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(45001);
    expect(settled).toBe(false);
    d.resolve({ reservations, capsules });
    await expect(pending).rejects.toMatchObject({ code: errorCode });
    expect(mock.phaseReleases).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test('caller signal proxy/accessors/substituted prototype refuse without executing hooks', async () => {
  const hook = jest.fn(() => {
    throw Error('signal hook');
  });
  const ownAborted = new AbortController().signal;
  Object.defineProperty(ownAborted, 'aborted', { get: hook });
  const ownReason = new AbortController().signal;
  Object.defineProperty(ownReason, 'reason', { get: hook });
  const replacedPrototype = new AbortController().signal;
  Object.setPrototypeOf(replacedPrototype, Object.create(AbortSignal.prototype));
  for (const signal of [
    new Proxy(new AbortController().signal, { getPrototypeOf: hook, get: hook }),
    ownAborted,
    ownReason,
    replacedPrototype,
  ])
    await expect(read({ ...mock.options, signal })).rejects.toMatchObject({ code: errorCode });
  expect(hook).not.toHaveBeenCalled();
  expect(mock.owners.enrollment.openPrivateRecoveryStores).not.toHaveBeenCalled();
});
test('foreign coordinator is authenticated before its signal can be read', async () => {
  const hook = jest.fn(() => {
    throw Error('coordinator hook');
  });
  mock.destination.mockImplementation((coordinator) => {
    if (coordinator !== mock.owners.coordinator) throw Error('foreign coordinator');
  });
  const getter = Object.defineProperty({}, 'signal', { get: hook });
  const proxy = new Proxy({}, { get: hook, getPrototypeOf: hook });
  for (const coordinator of [getter, proxy])
    await expect(
      read({ ...mock.options, owners: { ...mock.owners, coordinator } })
    ).rejects.toMatchObject({ code: errorCode });
  expect(hook).not.toHaveBeenCalled();
  expect(mock.owners.enrollment.openPrivateRecoveryStores).not.toHaveBeenCalled();
});
