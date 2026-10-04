const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
let mock;
// Only authority boundaries are substituted. The context, payload binder,
// strict capture comparator, encryption and atomic file writes are real.
// Floor callbacks model enrollment counters and injected interruptions.
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (value) => mock.enrollments.has(value),
}));
jest.mock('./railgun-own-poi-proof', () => ({
  assertRailgunOwnPoiProof: jest.fn((proof, enrollment, coordinator) => {
    const entry = mock.proofs.get(proof);
    if (
      !entry ||
      entry.enrollment !== enrollment ||
      entry.coordinator !== coordinator ||
      !entry.current ||
      enrollment.signal.aborted ||
      coordinator.signal.aborted
    )
      throw Error('private registry diagnostic');
    return entry.history;
  }),
}));
jest.mock('./railgun-own-operation', () => ({
  withRailgunOwnOperationRecovery: jest.fn(async (options, use) => {
    if (mock.phase) return { status: 'refused', stage: 'busy' };
    mock.phase = true;
    let live = true;
    const current = () => {
      if (
        !live ||
        !mock.windowCurrent ||
        options.signal.aborted ||
        options.enrollment.signal.aborted
      )
        throw Error('private recovery diagnostic');
    };
    try {
      mock.recoveryOptions = options;
      await mock.enterRecovery();
      current();
      const capture = mock.copy(mock.capture);
      mock.changeInitial(capture);
      let reads = 0;
      const value = await use({
        capture,
        signal: options.signal,
        assertCurrent: current,
        reattest: async () => {
          current();
          const fresh = mock.copy(mock.capture);
          await mock.reattest(++reads, fresh);
          current();
          return fresh;
        },
      });
      live = false;
      // Model the real outer recovery post-attestation, after callback return.
      await mock.postRecovery();
      if (options.signal.aborted) throw Error('private post-attestation diagnostic');
      return { status: 'used', value };
    } catch {
      return { status: 'refused', stage: 'recovery' };
    } finally {
      live = false;
      mock.phase = false;
    }
  }),
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const { withRailgunOwnOperationRecovery } = require('./railgun-own-operation');
const { createRailgunPoiIntentStore } = require('./railgun-poi-intent-store');
const RECORD = 'railgun-poi-intents-v1';
const REFUSED = { code: 'RAILGUN_POI_INTENT_STORE_REFUSED' };
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const copy = (v) => JSON.parse(JSON.stringify(v));
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
let options, stores, scopes, minimum, sample, caller;
function account(profileId = 'poi-intent-unit', subjectChanges = {}) {
  const controller = new AbortController();
  const scope = createPrivacyScope({ profileId, signal: controller.signal });
  scopes.push(scope);
  const subject = {
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'storage',
    ...subjectChanges,
  };
  const enrollment = {
    binding: options.binding,
    descriptor: { walletId: options.walletId },
    directory: options.directory,
    signal: controller.signal,
    getContext: (role) => scope.getContext({ ...subject, role }),
  };
  mock.enrollments.add(enrollment);
  return {
    enrollment,
    handle: scope.getContext({ ...subject, operation: RECORD + ':' + options.walletId }),
    scope,
    controller,
  };
}
function issue(n = 1, revision = 1, change = () => {}) {
  const payload = normalizeRailgunPoiPayload({
    listKey: REQUIRED_LIST,
    proof: {
      pi_a: [String(revision), '2'],
      pi_b: [
        ['3', '4'],
        ['5', '6'],
      ],
      pi_c: ['7', '8'],
    },
    poiMerkleroots: [hex(5)],
    txidMerkleroot: hex(6),
    txidMerklerootIndex: 4,
    blindedCommitmentsOut: ['0x' + hex(8)],
    railgunTxidIfHasUnshield: '0x00',
  });
  const history = {
    payload,
    expected: { ...payload, outputCount: 1 },
    payloadSha256: sha(payload),
    inputSha256: hex(100 + revision),
    capture: {
      capsuleDigest: hex(n),
      bindingDigest: hex(200 + n),
      selector: { tree: 0, position: n, nullifier: '0x' + hex(n), noteHash: '0x' + hex(80) },
      facts: { kind: 'railgun-private-transfer', amount: '1000' },
      submitter: '0x' + '12'.repeat(20),
      capsule: { walletId: options.walletId, selection: { position: n } },
      provedTransaction: { data: '0x1234' },
      intent: { digest: hex(40) },
      projection: { included: true, blockHash: '0x' + hex(50) },
      record: { state: 'submitted', revision: 1 },
    },
  };
  change(history);
  const proof = Object.freeze({ status: 'proved', payloadSha256: history.payloadSha256 });
  const entry = {
    history: freeze(history),
    enrollment: options.enrollment,
    coordinator: mock.coordinator,
    current: true,
  };
  mock.proofs.set(proof, entry);
  return { proof, history: entry.history, entry };
}
async function open(create = true, changes = {}) {
  const store = await createRailgunPoiIntentStore({ ...options, create, ...changes });
  stores.push(store);
  return store;
}
function prepare(store, issued = sample, changes = {}) {
  mock.capture = copy(issued.history.capture);
  return store.prepare({
    proof: issued.proof,
    coordinator: mock.coordinator,
    signal: caller.signal,
    ...changes,
  });
}
const filename = () => getPrivacyStoragePath(options.handle, options.directory);
async function alter(change) {
  await createPrivacyStorage(options).update(RECORD, (text) => {
    const value = JSON.parse(text);
    change(value);
    return JSON.stringify(value);
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  stores = [];
  scopes = [];
  minimum = null;
  caller = new AbortController();
  mock = {
    copy,
    enrollments: new WeakSet(),
    proofs: new WeakMap(),
    coordinator: { signal: new AbortController().signal },
    phase: false,
    windowCurrent: true,
    enterRecovery: async () => {},
    changeInitial: () => {},
    reattest: async () => {},
    postRecovery: async () => {},
  };
  options = {
    directory: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-poi-intent-unit-'))),
    key: Buffer.alloc(32, 7),
    binding: hex(60),
    walletId: hex(61),
    readFloor: jest.fn(async () => minimum),
    advanceFloor: jest.fn(async (value) => {
      if (minimum !== null && value < minimum) throw Error('floor rollback');
      minimum = value;
    }),
  };
  Object.assign(options, account());
  sample = issue();
});
afterEach(async () => {
  stores.forEach((store) => store.close());
  scopes.forEach((scope) => scope.close());
  await Promise.all(stores.map((store) => store.closed));
  jest.restoreAllMocks();
});

test('persists only prepared data encrypted, then reopens without proof authority', async () => {
  const store = await open();
  expect(await store.inspect()).toEqual({
    records: 0,
    sequence: 0,
    capacity: 32,
    reservedTransitions: 0,
    freeTransitions: 128,
  });
  const result = await prepare(store);
  expect(result).toEqual({
    status: 'prepared',
    capsuleDigest: hex(1),
    payloadSha256: sample.history.payloadSha256,
    revision: 1,
    proofAuthenticated: false,
    disclosureEnabled: false,
    spendingEnabled: false,
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(mock.recoveryOptions).toMatchObject({
    enrollment: options.enrollment,
    selector: sample.history.capture.selector,
    timeoutMs: 15000,
  });
  const saved = await store.get(hex(1));
  expect(saved).toEqual({
    capsuleDigest: hex(1),
    bindingDigest: sample.history.capture.bindingDigest,
    selector: sample.history.capture.selector,
    payload: sample.history.payload,
    payloadSha256: sample.history.payloadSha256,
    inputSha256: sample.history.inputSha256,
    revision: 1,
    state: 'prepared',
  });
  for (const value of [saved, saved.selector, saved.payload, saved.payload.proof.pi_b[0]])
    expect(Object.isFrozen(value)).toBe(true);
  const ciphertext = fs.readFileSync(filename(), 'utf8');
  for (const secret of [hex(1), sample.history.payloadSha256, REQUIRED_LIST, 'prepared', 'pi_a'])
    expect(ciphertext).not.toContain(secret);
  expect(Object.keys(JSON.parse(ciphertext)).sort()).toEqual([
    'ciphertext',
    'iv',
    'tag',
    'version',
  ]);
  store.close();
  await store.closed;
  sample.entry.current = false;
  const cold = await open(false);
  expect(await cold.get(hex(1))).toEqual(saved);
  expect(await prepare(cold)).toEqual({ status: 'refused', stage: 'context' });
  expect(await cold.list()).toEqual([
    {
      capsuleDigest: hex(1),
      state: 'prepared',
      revision: 1,
      payloadSha256: sample.history.payloadSha256,
    },
  ]);
  expect(minimum).toBe(1);
});

test('exposes no raw writer, sender, attempted transition, or recovered proof receipt', async () => {
  const store = await open();
  expect(Object.keys(store).sort()).toEqual([
    'close',
    'closed',
    'get',
    'inspect',
    'list',
    'prepare',
    'signal',
  ]);
  expect(Object.isFrozen(store)).toBe(true);
  expect(await store.get(hex(999))).toBeNull();
  await prepare(store);
  const list = await store.list();
  expect(Object.isFrozen(list)).toBe(true);
  expect(Object.isFrozen(list[0])).toBe(true);
  expect(list[0]).not.toHaveProperty('payload');
});

test.each([
  'copied enrollment',
  'binding',
  'wallet',
  'directory',
  'profile',
  'principal',
  'role',
  'operation',
  'protocol',
  'deployment',
  'chain',
  'copied handle',
  'key',
  'readFloor',
  'advanceFloor',
  'create',
])('constructor refuses %s without retaining the valid filename owner', async (kind) => {
  let changes;
  if (kind === 'copied enrollment') changes = { enrollment: { ...options.enrollment } };
  if (kind === 'binding') changes = { binding: hex(99) };
  if (kind === 'wallet') changes = { walletId: hex(99) };
  if (kind === 'directory') changes = { directory: path.dirname(options.directory) };
  if (kind === 'profile') changes = { handle: account('foreign-profile').handle };
  if (kind === 'principal')
    changes = { handle: account(undefined, { principal: 'railgun:1' }).handle };
  if (kind === 'role') changes = { handle: account(undefined, { role: 'poi' }).handle };
  if (kind === 'operation') changes = { handle: options.enrollment.getContext('storage') };
  if (kind === 'protocol') changes = { handle: account(undefined, { protocol: 'foreign' }).handle };
  if (kind === 'deployment')
    changes = { handle: account(undefined, { deployment: 'mainnet' }).handle };
  if (kind === 'chain') changes = { handle: account(undefined, { chainId: 1 }).handle };
  if (kind === 'copied handle') changes = { handle: { ...options.handle } };
  if (kind === 'key') changes = { key: Buffer.alloc(31) };
  if (kind === 'readFloor') changes = { readFloor: null };
  if (kind === 'advanceFloor') changes = { advanceFloor: null };
  if (kind === 'create') changes = { create: 1 };
  await expect(open(true, changes)).rejects.toMatchObject({
    ...REFUSED,
    message: 'Railgun POI intent store unavailable',
  });
  expect((await (await open()).inspect()).records).toBe(0);
});

test.each(['copy', 'json', 'forged', 'refused', 'coordinator', 'enrollment', 'revoked'])(
  '%s proof cannot write or enter recovery',
  async (kind) => {
    const store = await open();
    const before = fs.readFileSync(filename());
    let proof = sample.proof;
    const changes = {};
    if (kind === 'copy') proof = { ...proof };
    if (kind === 'json') proof = copy(proof);
    if (kind === 'forged') proof = { status: 'proved', payload: sample.history.payload };
    if (kind === 'refused') proof = { status: 'refused', stage: 'verify' };
    if (kind === 'coordinator') changes.coordinator = { signal: new AbortController().signal };
    if (kind === 'enrollment') sample.entry.enrollment = account().enrollment;
    if (kind === 'revoked') sample.entry.current = false;
    expect(await prepare(store, sample, { ...changes, proof })).toEqual({
      status: 'refused',
      stage: 'context',
    });
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    expect(fs.readFileSync(filename())).toEqual(before);
    expect(store.signal.aborted).toBe(false);
  }
);

test.each([
  'extra option',
  'missing signal',
  'aborted signal',
  'payload digest',
  'payload binding',
])('refuses %s before recovery and persistence', async (kind) => {
  const store = await open();
  let issued = sample;
  const changes = {};
  if (kind === 'extra option') changes.attempt = true;
  if (kind === 'missing signal') changes.signal = undefined;
  if (kind === 'aborted signal') caller.abort();
  if (kind === 'payload digest')
    issued = issue(1, 1, (h) => {
      h.payloadSha256 = hex(999);
    });
  if (kind === 'payload binding')
    issued = issue(1, 1, (h) => {
      h.expected.txidMerkleroot = hex(999);
    });
  expect(await prepare(store, issued, changes)).toEqual({ status: 'refused', stage: 'context' });
  expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
  expect(minimum).toBe(0);
});

const driftCases = [
  [
    'binding',
    (c) => {
      c.bindingDigest = hex(900);
    },
  ],
  [
    'selector',
    (c) => {
      c.selector.position++;
    },
  ],
  [
    'capsule',
    (c) => {
      c.capsule.selection.position++;
    },
  ],
  [
    'capsule digest',
    (c) => {
      c.capsuleDigest = hex(900);
    },
  ],
  [
    'transaction',
    (c) => {
      c.provedTransaction.data = '0x5678';
    },
  ],
  [
    'projection',
    (c) => {
      c.projection.blockHash = '0x' + hex(900);
    },
  ],
  [
    'facts',
    (c) => {
      c.facts.amount = '1001';
    },
  ],
  [
    'intent',
    (c) => {
      c.intent.digest = hex(900);
    },
  ],
  [
    'submitter',
    (c) => {
      c.submitter = '0x' + '34'.repeat(20);
    },
  ],
  [
    'archive transition',
    (c) => {
      c.record.archivedAt = 1;
      c.record.finalized = { number: 300, hash: hex(300) };
    },
  ],
];
describe.each(['initial', 'before write', 'after write'])('%s strict capture', (point) => {
  test.each(driftCases)(
    'refuses changed %s and preserves the correct durable state',
    async (_name, change) => {
      const store = await open();
      if (point === 'initial') mock.changeInitial = change;
      else
        mock.reattest = async (n, c) => {
          if (n === (point === 'before write' ? 1 : 2)) change(c);
        };
      expect(await prepare(store)).toEqual({
        status: 'refused',
        stage: point === 'after write' ? 'reattest' : 'recovery',
      });
      expect(store.signal.aborted).toBe(false);
      expect((await store.inspect()).records).toBe(point === 'after write' ? 1 : 0);
      expect(minimum).toBe(point === 'after write' ? 1 : 0);
      if (point === 'after write') {
        store.close();
        await store.closed;
        expect((await (await open(false)).get(hex(1))).state).toBe('prepared');
      }
    }
  );
});

test('rejects changed archived finalized anchor, even with unchanged stable projection', async () => {
  const store = await open();
  const archived = issue(1, 1, (h) => {
    h.capture.record = { archivedAt: 1, finalized: { number: 300, hash: hex(300) } };
  });
  mock.reattest = async (n, c) => {
    if (n === 2) c.record.finalized.number++;
  };
  expect(await prepare(store, archived)).toEqual({ status: 'refused', stage: 'reattest' });
  expect((await store.get(hex(1))).revision).toBe(1);
});

test('routine active journal revision and confirmation refresh is accepted', async () => {
  const store = await open();
  mock.reattest = async (n, c) => {
    c.record.revision += n;
    c.record.confirmations = 12 + n;
  };
  expect((await prepare(store)).status).toBe('prepared');
});

test('post-recovery failure never reports prepared but retains its durable record', async () => {
  const store = await open();
  mock.postRecovery = async () => {
    throw Error('private post failure');
  };
  expect(await prepare(store)).toEqual({ status: 'refused', stage: 'reattest' });
  expect((await store.get(hex(1))).state).toBe('prepared');
});

test('identical prepare is byte-preserving and a changed proof advances only that record', async () => {
  const store = await open();
  await prepare(store);
  const bytes = fs.readFileSync(filename());
  const advances = options.advanceFloor.mock.calls.length;
  expect((await prepare(store)).revision).toBe(1);
  expect(fs.readFileSync(filename())).toEqual(bytes);
  expect(options.advanceFloor).toHaveBeenCalledTimes(advances);
  const changed = issue(1, 2);
  expect((await prepare(store, changed)).revision).toBe(2);
  expect((await store.get(hex(1))).payloadSha256).toBe(changed.history.payloadSha256);
  expect(await store.inspect()).toEqual({
    records: 1,
    sequence: 2,
    capacity: 32,
    reservedTransitions: 3,
    freeTransitions: 123,
  });
});

test('selector property order is canonical and cannot create a spurious revision', async () => {
  const store = await open();
  await prepare(store);
  const reordered = issue(1, 1, (h) => {
    const s = h.capture.selector;
    h.capture.selector = {
      noteHash: s.noteHash,
      nullifier: s.nullifier,
      position: s.position,
      tree: s.tree,
    };
  });
  const bytes = fs.readFileSync(filename());
  expect((await prepare(store, reordered)).revision).toBe(1);
  expect(fs.readFileSync(filename())).toEqual(bytes);
});

test('revision four accepts an identical no-op but refuses a fifth distinct proof', async () => {
  const store = await open();
  for (let revision = 1; revision <= 4; revision++)
    expect((await prepare(store, issue(1, revision))).revision).toBe(revision);
  const before = fs.readFileSync(filename());
  expect((await prepare(store, issue(1, 4))).revision).toBe(4);
  expect(await prepare(store, issue(1, 5))).toEqual({ status: 'refused', stage: 'persist' });
  expect(fs.readFileSync(filename())).toEqual(before);
  expect(store.signal.aborted).toBe(false);
  expect((await store.inspect()).sequence).toBe(4);
});

test.each(['selector', 'nullifier'])(
  'conflicting %s is refused without closing the store',
  async (kind) => {
    const store = await open();
    await prepare(store);
    const conflict =
      kind === 'selector'
        ? issue(1, 2, (h) => {
            h.capture.selector.position++;
          })
        : issue(2, 1, (h) => {
            h.capture.selector.nullifier = sample.history.capture.selector.nullifier;
          });
    const before = fs.readFileSync(filename());
    expect(await prepare(store, conflict)).toEqual({ status: 'refused', stage: 'persist' });
    expect(fs.readFileSync(filename())).toEqual(before);
    expect(store.signal.aborted).toBe(false);
    expect((await store.inspect()).sequence).toBe(1);
  }
);

test('32 preparations consume exactly all reserved capacity, survive reopen and refuse additions or revisions', async () => {
  const store = await open();
  for (let n = 1; n <= 32; n++) expect((await prepare(store, issue(n))).status).toBe('prepared');
  expect(await store.inspect()).toEqual({
    records: 32,
    sequence: 32,
    capacity: 32,
    reservedTransitions: 96,
    freeTransitions: 0,
  });
  expect(await prepare(store, issue(33))).toEqual({ status: 'refused', stage: 'persist' });
  expect(await prepare(store, issue(1, 2))).toEqual({ status: 'refused', stage: 'persist' });
  expect((await prepare(store, issue(1))).revision).toBe(1);
  expect(store.signal.aborted).toBe(false);
  store.close();
  await store.closed;
  expect((await (await open(false)).list()).length).toBe(32);
});

test('reserved transitions bound capacity before MAX32 when prior revisions consumed history', async () => {
  const store = await open();
  for (let n = 1; n <= 31; n++) await prepare(store, issue(n));
  for (let revision = 2; revision <= 4; revision++)
    expect((await prepare(store, issue(1, revision))).revision).toBe(revision);
  expect(await store.inspect()).toEqual({
    records: 31,
    sequence: 34,
    capacity: 32,
    reservedTransitions: 93,
    freeTransitions: 1,
  });
  expect(await prepare(store, issue(32))).toEqual({ status: 'refused', stage: 'persist' });
  expect((await store.inspect()).records).toBe(31);
});

const corruptions = [
  [
    'version',
    (v) => {
      v.version = 2;
    },
  ],
  [
    'binding',
    (v) => {
      v.binding = hex(999);
    },
  ],
  [
    'wallet',
    (v) => {
      v.walletId = hex(999);
    },
  ],
  [
    'lease',
    (v) => {
      v.lease = 'bad';
    },
  ],
  [
    'sequence sum',
    (v) => {
      v.sequence++;
    },
  ],
  [
    'attempted',
    (v) => {
      v.entries[0].state = 'attempted';
    },
  ],
  [
    'extra state',
    (v) => {
      v.attempts = [];
    },
  ],
  [
    'extra record field',
    (v) => {
      v.entries[0].attemptedAt = 1;
    },
  ],
  [
    'revision zero',
    (v) => {
      // Keep the document at the persisted floor so rollback cannot mask the
      // positive-revision invariant. Every other entry invariant remains valid.
      const other = copy(v.entries[0]);
      other.capsuleDigest = hex(2);
      other.selector.nullifier = '0x' + hex(2);
      other.selector.position = 2;
      v.entries.push(other);
      v.entries[0].revision = 0;
      v.sequence = 1;
    },
  ],
  [
    'revision five',
    (v) => {
      v.entries[0].revision = 5;
      v.sequence = 5;
    },
  ],
  [
    'duplicate capsule',
    (v) => {
      v.entries.push(copy(v.entries[0]));
      v.entries[1].selector.nullifier = '0x' + hex(999);
      v.sequence++;
    },
  ],
  [
    'duplicate nullifier',
    (v) => {
      v.entries.push(copy(v.entries[0]));
      v.entries[1].capsuleDigest = hex(999);
      v.sequence++;
    },
  ],
  [
    'payload hash',
    (v) => {
      v.entries[0].payloadSha256 = hex(999);
    },
  ],
  [
    'payload shape',
    (v) => {
      v.entries[0].payload.endpoint = 'https://invalid.test';
    },
  ],
  [
    'selector shape',
    (v) => {
      v.entries[0].selector.holdId = hex(999);
    },
  ],
  [
    'tree bound',
    (v) => {
      v.entries[0].selector.tree = 65536;
    },
  ],
  [
    'position bound',
    (v) => {
      v.entries[0].selector.position = -1;
    },
  ],
  [
    'nullifier field',
    (v) => {
      v.entries[0].selector.nullifier = '0x' + 'f'.repeat(64);
    },
  ],
  [
    'note case',
    (v) => {
      v.entries[0].selector.noteHash = '0x' + 'A'.repeat(64);
    },
  ],
];
test.each(corruptions)('authenticated but invalid %s cannot reopen', async (_name, change) => {
  const store = await open();
  await prepare(store);
  store.close();
  await store.closed;
  await alter(change);
  await expect(open(false)).rejects.toMatchObject(REFUSED);
});

test('valid revision sum still refuses an exhausted future-transition reserve on reopen', async () => {
  const store = await open();
  await prepare(store);
  store.close();
  await store.closed;
  await alter((v) => {
    const first = v.entries[0];
    v.entries = Array.from({ length: 32 }, (_, i) => ({
      ...copy(first),
      capsuleDigest: hex(i + 1),
      selector: { ...first.selector, nullifier: '0x' + hex(i + 1) },
      revision: i === 0 ? 2 : 1,
    }));
    v.sequence = 33;
  });
  await expect(open(false)).rejects.toMatchObject(REFUSED);
});

test('same-sequence authenticated live substitution is detected by full readback', async () => {
  const store = await open();
  await prepare(store);
  await alter((v) => {
    v.entries[0].bindingDigest = hex(999);
  });
  await expect(store.list()).rejects.toMatchObject(REFUSED);
  expect(store.signal.aborted).toBe(true);
});

test('rollback to older ciphertext refuses on both live read and cold floor check', async () => {
  const store = await open();
  const old = fs.readFileSync(filename());
  await prepare(store);
  fs.writeFileSync(filename(), old);
  await expect(store.inspect()).rejects.toMatchObject(REFUSED);
  await store.closed;
  expect(minimum).toBe(1);
  await expect(open(false)).rejects.toMatchObject(REFUSED);
});

test.each(['wrong key', 'ciphertext', 'missing record', 'existing create', 'missing open'])(
  'refuses %s without resetting durable history',
  async (kind) => {
    if (kind === 'missing open') {
      await expect(open(false)).rejects.toMatchObject(REFUSED);
      return;
    }
    const store = await open();
    await prepare(store);
    store.close();
    await store.closed;
    let changes = {};
    if (kind === 'wrong key') changes = { key: Buffer.alloc(32, 8) };
    if (kind === 'ciphertext') {
      const value = JSON.parse(fs.readFileSync(filename(), 'utf8'));
      const bytes = Buffer.from(value.ciphertext, 'base64');
      bytes[0] ^= 1;
      value.ciphertext = bytes.toString('base64');
      fs.writeFileSync(filename(), JSON.stringify(value));
    }
    if (kind === 'missing record') fs.writeFileSync(filename(), '{}');
    await expect(open(kind === 'existing create', changes)).rejects.toMatchObject(REFUSED);
    expect(minimum).toBe(1);
  }
);

test.each([-1, 129, 1.5, undefined, '1'])(
  'invalid floor %p refuses initialization',
  async (value) => {
    await expect(open(true, { readFloor: async () => value })).rejects.toMatchObject(REFUSED);
  }
);

test('interrupted floor advancement retains the committed record and cold open repairs the floor', async () => {
  const store = await open(true, {
    advanceFloor: async (value) => {
      if (value === 1) throw Error('private floor detail');
      minimum = value;
    },
  });
  expect(await prepare(store)).toEqual({ status: 'refused', stage: 'persist' });
  expect(store.signal.aborted).toBe(true);
  await store.closed;
  expect(minimum).toBe(0);
  const cold = await open(false);
  expect(minimum).toBe(1);
  expect((await cold.get(hex(1))).revision).toBe(1);
});

test('readback failure after rename refuses but cold recovery sees the prepared record', async () => {
  const store = await open();
  const read = fs.readFileSync.bind(fs);
  let failRead = false;
  const rename = fs.renameSync.bind(fs);
  jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    rename(from, to);
    if (to === filename()) failRead = true;
  });
  const reader = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
    if (failRead && file === filename()) throw Error('private readback detail');
    return read(file, ...args);
  });
  expect(await prepare(store)).toEqual({ status: 'refused', stage: 'persist' });
  expect(store.signal.aborted).toBe(true);
  await store.closed;
  reader.mockRestore();
  expect((await (await open(false)).get(hex(1))).state).toBe('prepared');
});

// Every gate is released in finally, so a failed assertion cannot strand work.
test('blocked initialization retains filename ownership after cancellation until its floor read drains', async () => {
  const gate = deferred(),
    entered = deferred();
  const opening = open(true, {
    readFloor: async () => {
      entered.resolve();
      await gate.promise;
      return minimum;
    },
  });
  const observed = opening.then(
    () => 'opened',
    (error) => error.code
  );
  await entered.promise;
  options.controller.abort();
  Object.assign(options, account());
  try {
    await expect(open()).rejects.toMatchObject(REFUSED);
  } finally {
    gate.resolve();
  }
  expect(await observed).toBe(REFUSED.code);
  expect((await (await open()).inspect()).records).toBe(0);
});

test.each(['recovery', 'post-attestation', 'floor'])(
  'close revokes immediately but retains owner while %s drains',
  async (where) => {
    const gate = deferred(),
      entered = deferred();
    const block = async () => {
      entered.resolve();
      await gate.promise;
    };
    const store = await open(
      true,
      where === 'floor'
        ? {
            advanceFloor: async (value) => {
              minimum = value;
              if (value === 1) await block();
            },
          }
        : {}
    );
    if (where === 'recovery') mock.enterRecovery = block;
    if (where === 'post-attestation') mock.postRecovery = block;
    const work = prepare(store);
    await entered.promise;
    let closed = false,
      settled = false;
    store.closed.then(() => {
      closed = true;
    });
    work.then(() => {
      settled = true;
    });
    store.close();
    expect(store.signal.aborted).toBe(true);
    try {
      await tick();
      expect(closed).toBe(false);
      expect(settled).toBe(false);
      await expect(open(false)).rejects.toMatchObject(REFUSED);
    } finally {
      gate.resolve();
    }
    expect((await work).status).toBe('refused');
    await store.closed;
    const cold = await open(false);
    expect((await cold.inspect()).records).toBe(where === 'recovery' ? 0 : 1);
  }
);

test('concurrent prepare refuses before a second recovery and leaves first call healthy', async () => {
  const store = await open();
  const gate = deferred(),
    entered = deferred();
  mock.enterRecovery = async () => {
    entered.resolve();
    await gate.promise;
  };
  const work = prepare(store);
  await entered.promise;
  try {
    expect(await prepare(store)).toEqual({ status: 'refused', stage: 'busy' });
    expect(withRailgunOwnOperationRecovery).toHaveBeenCalledTimes(1);
    expect(store.signal.aborted).toBe(false);
  } finally {
    gate.resolve();
  }
  expect((await work).status).toBe('prepared');
  expect((await store.inspect()).sequence).toBe(1);
});

test('stale calls and repeated close cannot release a newer filename owner', async () => {
  const old = await open();
  old.close();
  await old.closed;
  const current = await open(false);
  expect(await prepare(old)).toEqual({ status: 'refused', stage: 'context' });
  await expect(old.inspect()).rejects.toMatchObject(REFUSED);
  old.close();
  await expect(open(false)).rejects.toMatchObject(REFUSED);
  expect((await prepare(current)).status).toBe('prepared');
  expect(current.signal.aborted).toBe(false);
});

test.each(['before write', 'after write'])(
  'caller cancellation %s refuses and awaits the recovery callback',
  async (when) => {
    const store = await open();
    const gate = deferred(),
      entered = deferred();
    mock.reattest = async (n) => {
      if (n === (when === 'before write' ? 1 : 2)) {
        entered.resolve();
        await gate.promise;
      }
    };
    const work = prepare(store);
    await entered.promise;
    let settled = false;
    work.then(() => {
      settled = true;
    });
    caller.abort();
    try {
      await tick();
      expect(settled).toBe(false);
      expect(mock.phase).toBe(true);
      expect(await prepare(store)).toEqual({ status: 'refused', stage: 'busy' });
    } finally {
      gate.resolve();
    }
    expect(await work).toEqual({
      status: 'refused',
      stage: when === 'before write' ? 'recovery' : 'reattest',
    });
    expect(mock.phase).toBe(false);
    expect(store.signal.aborted).toBe(false);
    expect((await store.inspect()).records).toBe(when === 'before write' ? 0 : 1);
  }
);

test.each(['registry', 'enrollment', 'context'])(
  '%s revocation during recovery prevents persistence',
  async (kind) => {
    const store = await open();
    mock.reattest = async () => {
      if (kind === 'registry') sample.entry.current = false;
      if (kind === 'enrollment') options.controller.abort();
      if (kind === 'context') options.scope.close();
    };
    expect(await prepare(store)).toEqual({ status: 'refused', stage: 'recovery' });
    expect(minimum).toBe(0);
  }
);

describe.each(['caller', 'window', 'proof'])(
  '%s currency loss inside exclusive persistence',
  (kind) => {
    test.each(['start', 'update callback', 'committed readback'])(
      '%s is a healthy refusal, with only committed state retained',
      async (point) => {
        const revoke = () => {
          if (kind === 'caller') caller.abort();
          if (kind === 'window') mock.windowCurrent = false;
          if (kind === 'proof') sample.entry.current = false;
        };
        let armed = false;
        const store = await open(true, {
          readFloor: async () => {
            if (armed && point === 'start') {
              armed = false;
              revoke();
            }
            return minimum;
          },
        });
        const read = fs.readFileSync.bind(fs);
        let reads = 0;
        const target = filename();
        const reader = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
          const result = read(file, ...args);
          if (armed && file === target) {
            reads++;
            // First read attests; second feeds the atomic update callback;
            // third authenticates the committed file. Nothing bypasses real I/O.
            if (
              (point === 'update callback' && reads === 2) ||
              (point === 'committed readback' && reads === 3)
            ) {
              armed = false;
              revoke();
            }
          }
          return result;
        });
        armed = true;
        expect(await prepare(store)).toEqual({ status: 'refused', stage: 'persist' });
        expect(armed).toBe(false);
        reader.mockRestore();
        expect(store.signal.aborted).toBe(false);
        expect((await store.inspect()).records).toBe(point === 'committed readback' ? 1 : 0);
        expect(minimum).toBe(point === 'committed readback' ? 1 : 0);
        if (point === 'committed readback')
          expect((await store.get(hex(1))).payloadSha256).toBe(sample.history.payloadSha256);
        // A later fresh caller/proof/window can still use the same healthy store.
        caller = new AbortController();
        mock.windowCurrent = true;
        expect((await prepare(store, issue())).status).toBe('prepared');
        expect((await store.inspect()).sequence).toBe(1);
      }
    );
  }
);

test('a genuine authenticated CAS change after initial attestation is an integrity failure', async () => {
  let armed = false;
  const store = await open(true, {
    readFloor: async () => {
      if (armed) {
        armed = false;
        await alter((v) => {
          v.lease = hex(999);
        });
      }
      return minimum;
    },
  });
  armed = true;
  expect(await prepare(store)).toEqual({ status: 'refused', stage: 'persist' });
  expect(armed).toBe(false);
  expect(store.signal.aborted).toBe(true);
  expect(minimum).toBe(0);
});

test('overlapping read operations refuse busy without revoking an in-flight attestation', async () => {
  const gate = deferred(),
    entered = deferred();
  let armed = false;
  const store = await open(true, {
    readFloor: async () => {
      if (armed) {
        armed = false;
        entered.resolve();
        await gate.promise;
      }
      return minimum;
    },
  });
  armed = true;
  const inspection = store.inspect();
  await entered.promise;
  try {
    await expect(store.list()).rejects.toMatchObject({ code: 'RAILGUN_POI_INTENT_STORE_BUSY' });
    expect(store.signal.aborted).toBe(false);
  } finally {
    gate.resolve();
  }
  expect((await inspection).records).toBe(0);
  expect((await prepare(store)).status).toBe('prepared');
});

test('independent live account cannot decrypt a copied encrypted file with the same key', async () => {
  const store = await open();
  await prepare(store);
  const bytes = fs.readFileSync(filename());
  const foreign = account(undefined, { principal: 'railgun:1' });
  const foreignPath = getPrivacyStoragePath(foreign.handle, options.directory);
  expect(foreignPath).not.toBe(filename());
  fs.writeFileSync(foreignPath, bytes);
  await expect(open(false, foreign)).rejects.toMatchObject(REFUSED);
  expect((await store.inspect()).sequence).toBe(1);
});

test('authenticated oversized JSON document refuses even when only trailing whitespace was added', async () => {
  const store = await open();
  expect((await prepare(store)).status).toBe('prepared');
  store.close();
  await store.closed;
  await createPrivacyStorage(options).update(RECORD, (text) => {
    const padded = text + ' '.repeat(800 * 1024 + 1 - Buffer.byteLength(text));
    expect(JSON.parse(padded)).toEqual(JSON.parse(text));
    return padded;
  });
  await expect(open(false)).rejects.toMatchObject(REFUSED);
});
