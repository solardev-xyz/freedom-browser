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
    preparation: { creator: { type: 'Shield' } },
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

test('exposes only bounded persistence methods without sender or recovered proof receipt', async () => {
  const store = await open();
  expect(Object.keys(store).sort()).toEqual([
    'beginAttempt',
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
      v.version = 3;
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

const {
  prepareRailgunPoiSubmission,
  normalizeRailgunPoiSubmission,
} = require('./railgun-poi-submit-data');
const attemptOptions = (issued = sample, changes = {}) => ({
  capsuleDigest: issued.history.capture.capsuleDigest,
  expectedRevision: 1,
  expectedPayloadSha256: issued.history.payloadSha256,
  signal: caller.signal,
  ...changes,
});
const begin = (store, issued = sample, changes = {}) => {
  mock.capture = copy(issued.history.capture);
  return store.beginAttempt(attemptOptions(issued, changes));
};
const readDocument = async () => JSON.parse(await createPrivacyStorage(options).get(RECORD));
const assertAttempted = (entry, prepared) => {
  expect(entry).toEqual({
    ...prepared,
    state: 'attempted',
    attempt: {
      attemptedAt: expect.any(Number),
      submission: expect.any(Object),
    },
  });
  expect(entry.attempt.attemptedAt).toBeGreaterThan(0);
  expect(Number.isSafeInteger(entry.attempt.attemptedAt)).toBe(true);
  expect(entry.attempt.submission.requestId).toBe(entry.attempt.attemptedAt);
  expect(entry.attempt.submission).toEqual(
    prepareRailgunPoiSubmission({
      payload: prepared.payload,
      requestId: entry.attempt.attemptedAt,
    })
  );
  expect(normalizeRailgunPoiSubmission(entry.attempt.submission)).toEqual(entry.attempt.submission);
};

describe('durable attempted POI records', () => {
  test('persists one exact encrypted envelope and returns bounded persistence facts only', async () => {
    const store = await open();
    await prepare(store);
    const prepared = await store.get(hex(1));
    const now = jest.spyOn(Date, 'now').mockReturnValue(1791111111111);
    const result = await begin(store);
    expect(result).toMatchObject({
      status: 'attempted',
      capsuleDigest: hex(1),
      revision: 1,
      payloadSha256: prepared.payloadSha256,
      disclosureEnabled: false,
      spendingEnabled: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toHaveProperty('submission');
    expect(result).not.toHaveProperty('payload');
    expect(result).not.toHaveProperty('receipt');
    expect(result).not.toHaveProperty('assertCurrent');
    expect(now).toHaveBeenCalledTimes(1);
    const saved = await store.get(hex(1));
    assertAttempted(saved, prepared);
    expect(saved.attempt.attemptedAt).toBe(1791111111111);
    expect(result.bodySha256).toBe(saved.attempt.submission.bodySha256);
    for (const value of [
      saved,
      saved.attempt,
      saved.attempt.submission,
      saved.attempt.submission.payload.proof.pi_b[0],
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(await store.inspect()).toEqual({
      records: 1,
      sequence: 2,
      capacity: 32,
      reservedTransitions: 2,
      freeTransitions: 124,
    });
    expect(minimum).toBe(2);
    const document = await readDocument();
    expect(document.version).toBe(2);
    expect(document.sequence).toBe(2);
    expect(document.entries).toEqual([saved]);
    expect(Object.keys(JSON.parse(fs.readFileSync(filename(), 'utf8')))).toEqual([
      'version',
      'iv',
      'tag',
      'ciphertext',
    ]);
    const ciphertext = fs.readFileSync(filename(), 'utf8');
    for (const secret of [
      'attempted',
      'ppoi_submit_transact_proof',
      saved.attempt.submission.bodySha256,
      saved.payloadSha256,
    ])
      expect(ciphertext).not.toContain(secret);
    expect(mock.recoveryOptions.selector).toEqual(prepared.selector);
    expect(mock.recoveryOptions.timeoutMs).toBe(15000);
  });

  test.each(['identical', 'changed'])(
    'genuine current %s proof cannot reprepare an attempted record',
    async (kind) => {
      const store = await open();
      await prepare(store);
      expect((await begin(store)).status).toBe('attempted');
      const issued = kind === 'identical' ? sample : issue(1, 2);
      expect(
        require('./railgun-own-poi-proof').assertRailgunOwnPoiProof(
          issued.proof,
          options.enrollment,
          mock.coordinator
        )
      ).toBe(issued.history);
      const bytes = fs.readFileSync(filename()),
        saved = await store.get(hex(1));
      const now = jest.spyOn(Date, 'now');
      expect((await prepare(store, issued)).status).toBe('refused');
      expect(fs.readFileSync(filename())).toEqual(bytes);
      expect(await store.get(hex(1))).toEqual(saved);
      expect((await store.inspect()).sequence).toBe(2);
      expect(now).not.toHaveBeenCalled();
      expect(store.signal.aborted).toBe(false);
    }
  );
  test('second begin refuses without allocating another request or changing bytes', async () => {
    const store = await open();
    await prepare(store);
    await begin(store);
    const before = fs.readFileSync(filename()),
      saved = await store.get(hex(1));
    const recoveries = withRailgunOwnOperationRecovery.mock.calls.length;
    const now = jest.spyOn(Date, 'now');
    expect((await begin(store)).status).toBe('refused');
    expect(now).not.toHaveBeenCalled();
    expect(withRailgunOwnOperationRecovery).toHaveBeenCalledTimes(recoveries);
    expect(fs.readFileSync(filename())).toEqual(before);
    expect(await store.get(hex(1))).toEqual(saved);
    expect(store.signal.aborted).toBe(false);
  });
  test('lost completion reopens the identical attempted bytes without old proof authority', async () => {
    const store = await open();
    await prepare(store);
    const prepared = await store.get(hex(1));
    await begin(store); // Caller intentionally discards the success object.
    const saved = await store.get(hex(1));
    store.close();
    await store.closed;
    sample.entry.current = false;
    const cold = await open(false);
    const recovered = await cold.get(hex(1));
    expect(recovered).toEqual(saved);
    assertAttempted(recovered, prepared);
    expect((await begin(cold)).status).toBe('refused');
    expect((await cold.inspect()).sequence).toBe(2);
    expect((await cold.list())[0]).toEqual({
      capsuleDigest: hex(1),
      state: 'attempted',
      revision: 1,
      payloadSha256: saved.payloadSha256,
    });
    expect((await cold.list())[0]).not.toHaveProperty('attempt');
  });
  test('cold prepared record can begin through fresh local recovery without a live proof receipt', async () => {
    const store = await open();
    await prepare(store);
    store.close();
    await store.closed;
    sample.entry.current = false;
    const cold = await open(false);
    const calls = require('./railgun-own-poi-proof').assertRailgunOwnPoiProof.mock.calls.length;
    expect((await begin(cold)).status).toBe('attempted');
    expect(require('./railgun-own-poi-proof').assertRailgunOwnPoiProof).toHaveBeenCalledTimes(
      calls
    );
  });

  test.each([
    'missing',
    'revision',
    'payload',
    'capsule',
    'revision-zero',
    'revision-five',
    'signal',
    'aborted',
  ])(
    'refuses %s selection before local recovery and preserves healthy prepared bytes',
    async (kind) => {
      const store = await open();
      await prepare(store);
      const before = fs.readFileSync(filename());
      const value = attemptOptions();
      if (kind === 'missing') value.capsuleDigest = hex(999);
      if (kind === 'revision') value.expectedRevision = 2;
      if (kind === 'payload') value.expectedPayloadSha256 = hex(999);
      if (kind === 'capsule') value.capsuleDigest = '0x' + hex(1);
      if (kind === 'revision-zero') value.expectedRevision = 0;
      if (kind === 'revision-five') value.expectedRevision = 5;
      if (kind === 'signal') value.signal = {};
      if (kind === 'aborted') caller.abort();
      const recovered = withRailgunOwnOperationRecovery.mock.calls.length;
      expect((await store.beginAttempt(value)).status).toBe('refused');
      expect(withRailgunOwnOperationRecovery).toHaveBeenCalledTimes(recovered);
      expect(fs.readFileSync(filename())).toEqual(before);
      expect(store.signal.aborted).toBe(false);
    }
  );
  test.each([
    'payload',
    'selector',
    'submission',
    'requestId',
    'attemptedAt',
    'coordinator',
    'archive',
    'receipt',
    'approved',
    'run',
  ])('rejects caller-supplied %s', async (key) => {
    const store = await open();
    await prepare(store);
    const before = fs.readFileSync(filename());
    const recovered = withRailgunOwnOperationRecovery.mock.calls.length;
    expect((await store.beginAttempt({ ...attemptOptions(), [key]: {} })).status).toBe('refused');
    expect(withRailgunOwnOperationRecovery).toHaveBeenCalledTimes(recovered);
    expect(fs.readFileSync(filename())).toEqual(before);
  });
  test.each([undefined, null, [], 'PRIVATE', 7])('rejects malformed options %p', async (value) => {
    const store = await open();
    expect((await store.beginAttempt(value)).status).toBe('refused');
  });
  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'invalid wall clock %p cannot persist an attempt',
    async (at) => {
      const store = await open();
      await prepare(store);
      const before = fs.readFileSync(filename());
      jest.spyOn(Date, 'now').mockReturnValue(at);
      expect((await begin(store)).status).toBe('refused');
      expect(fs.readFileSync(filename())).toEqual(before);
      expect(minimum).toBe(1);
    }
  );

  test.each(['prepare', 'attempt'])(
    'v1 %s mutation consumes one sequence and only an attempt upgrades the document',
    async (operation) => {
      let store = await open();
      await prepare(store);
      const prepared = await store.get(hex(1));
      store.close();
      await store.closed;
      await alter((v) => {
        v.version = 1;
      });
      const beforePath = filename();
      store = await open(false);
      expect((await readDocument()).version).toBe(1);
      expect(await store.get(hex(1))).toEqual(prepared);
      expect((await prepare(store)).status).toBe('prepared');
      expect((await readDocument()).version).toBe(1);
      if (operation === 'attempt') expect((await begin(store)).status).toBe('attempted');
      else expect((await prepare(store, issue(1, 2))).status).toBe('prepared');
      expect(filename()).toBe(beforePath);
      expect((await readDocument()).version).toBe(operation === 'attempt' ? 2 : 1);
      expect((await store.inspect()).sequence).toBe(2);
      expect(minimum).toBe(2);
    }
  );
  test('v2 preparation and reopen never downgrade an existing attempted record', async () => {
    const store = await open();
    await prepare(store);
    await begin(store);
    await prepare(store, issue(2));
    const saved = await store.get(hex(1));
    store.close();
    await store.closed;
    const cold = await open(false);
    expect((await readDocument()).version).toBe(2);
    expect(await cold.get(hex(1))).toEqual(saved);
    expect((await cold.inspect()).sequence).toBe(3);
  });
  test('all 32 attempts consume reserved transitions without reclaiming preparation capacity', async () => {
    const store = await open();
    const issued = Array.from({ length: 32 }, (_, n) => issue(n + 1));
    for (const proof of issued) await prepare(store, proof);
    expect((await begin(store, issued[0])).status).toBe('attempted');
    expect(await store.inspect()).toEqual({
      records: 32,
      sequence: 33,
      capacity: 32,
      reservedTransitions: 95,
      freeTransitions: 0,
    });
    for (const proof of issued.slice(1))
      expect((await begin(store, proof)).status).toBe('attempted');
    expect(await store.inspect()).toEqual({
      records: 32,
      sequence: 64,
      capacity: 32,
      reservedTransitions: 64,
      freeTransitions: 0,
    });
    expect((await prepare(store, issue(33))).status).toBe('refused');
    expect((await prepare(store, issue(1, 2))).status).toBe('refused');
    store.close();
    await store.closed;
    expect((await (await open(false)).inspect()).sequence).toBe(64);
  });
  test('revision four is preserved when its attempt consumes one transition', async () => {
    const store = await open();
    let issued;
    for (let revision = 1; revision <= 4; revision++) {
      issued = issue(1, revision);
      await prepare(store, issued);
    }
    expect((await begin(store, issued, { expectedRevision: 4 })).status).toBe('attempted');
    expect((await store.get(hex(1))).revision).toBe(4);
    expect(await store.inspect()).toEqual({
      records: 1,
      sequence: 5,
      capacity: 32,
      reservedTransitions: 2,
      freeTransitions: 121,
    });
  });
  test('duplicate nullifier conflicts across prepared and attempted records', async () => {
    const store = await open();
    await prepare(store);
    await begin(store);
    const other = issue(2, 1, (h) => {
      h.capture.selector.nullifier = sample.history.capture.selector.nullifier;
    });
    expect((await prepare(store, other)).status).toBe('refused');
    expect((await store.inspect()).records).toBe(1);
    expect(store.signal.aborted).toBe(false);
  });
  test.each(['capsuleDigest', 'bindingDigest', 'selector'])(
    'initial account capture binds stored %s',
    async (field) => {
      const store = await open();
      await prepare(store);
      mock.changeInitial = (capture) => {
        if (field === 'selector') capture.selector.position++;
        else capture[field] = hex(999);
      };
      const before = fs.readFileSync(filename());
      expect((await begin(store)).status).toBe('refused');
      expect(fs.readFileSync(filename())).toEqual(before);
      expect(store.signal.aborted).toBe(false);
    }
  );
  describe.each(['before', 'after'])('%s attempt write account reattestation', (point) => {
    test.each(driftCases.filter(([name]) => name !== 'archive transition'))(
      'detects stable %s drift and retains only committed state',
      async (_name, change) => {
        const store = await open();
        await prepare(store);
        mock.reattest = async (n, capture) => {
          if (n === (point === 'before' ? 1 : 2)) change(capture);
        };
        const result = await begin(store);
        expect(result.status).toBe(point === 'before' ? 'refused' : 'recovery-required');
        expect(store.signal.aborted).toBe(false);
        const entry = await store.get(hex(1));
        expect(entry.state).toBe(point === 'before' ? 'prepared' : 'attempted');
        expect(minimum).toBe(point === 'before' ? 1 : 2);
        if (point === 'after') expect((await begin(store)).status).toBe('refused');
      }
    );
  });
  describe.each(['before', 'after'])('%s attempt write archive evolution', (point) => {
    test.each(['active to archived', 'archived anchor refresh'])(
      '%s is strict before persistence and stable after persistence',
      async (transition) => {
        const store = await open();
        const issued =
          transition === 'active to archived'
            ? sample
            : issue(1, 1, (history) => {
                history.capture.record = {
                  archivedAt: 1,
                  finalized: { number: 300, hash: hex(300) },
                };
              });
        await prepare(store, issued);
        const prepared = await store.get(hex(1));
        const before = fs.readFileSync(filename());
        mock.reattest = async (n, capture) => {
          if (n !== (point === 'before' ? 1 : 2)) return;
          capture.record = {
            archivedAt: 2,
            finalized: { number: 301, hash: hex(301) },
          };
        };
        const result = await begin(store, issued);
        expect(result.status).toBe(point === 'before' ? 'refused' : 'attempted');
        expect(store.signal.aborted).toBe(false);
        expect((await store.inspect()).sequence).toBe(point === 'before' ? 1 : 2);
        expect(minimum).toBe(point === 'before' ? 1 : 2);
        if (point === 'before') {
          expect(fs.readFileSync(filename())).toEqual(before);
          expect(await store.get(hex(1))).toEqual(prepared);
        } else {
          const attempted = await store.get(hex(1));
          assertAttempted(attempted, prepared);
          expect(result.disclosureEnabled).toBe(false);
          expect(result.spendingEnabled).toBe(false);
          const committed = fs.readFileSync(filename());
          expect((await begin(store, issued)).status).toBe('refused');
          expect(fs.readFileSync(filename())).toEqual(committed);
          store.close();
          await store.closed;
          const reopened = await open(false);
          expect(await reopened.get(hex(1))).toEqual(attempted);
          expect((await begin(reopened, issued)).status).toBe('refused');
          expect(await reopened.get(hex(1))).toEqual(attempted);
        }
      }
    );
  });
  test('failed outer post-attestation reports recovery-required and never erases the attempt', async () => {
    const store = await open();
    await prepare(store);
    mock.postRecovery = async () => {
      throw Error('PRIVATE post attestation');
    };
    const result = await begin(store);
    expect(result.status).toBe('recovery-required');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect((await store.get(hex(1))).state).toBe('attempted');
    expect(store.signal.aborted).toBe(false);
    expect((await begin(store)).status).toBe('refused');
  });
  test.each(['prepare', 'attempt'])(
    'pending %s excludes both mutation methods without disturbing its owner',
    async (first) => {
      const store = await open();
      await prepare(store);
      const gate = deferred(),
        entered = deferred();
      mock.enterRecovery = async () => {
        entered.resolve();
        await gate.promise;
      };
      const work = first === 'prepare' ? prepare(store) : begin(store);
      await entered.promise;
      try {
        expect((await prepare(store)).status).toBe('refused');
        expect((await begin(store)).status).toBe('refused');
        expect(mock.phase).toBe(true);
        expect(store.signal.aborted).toBe(false);
      } finally {
        gate.resolve();
      }
      expect((await work).status).toBe(first === 'prepare' ? 'prepared' : 'attempted');
    }
  );
  test('snapshots scalar attempt selection before asynchronous attestation', async () => {
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
    await prepare(store);
    const supplied = attemptOptions();
    armed = true;
    const pending = store.beginAttempt(supplied);
    await entered.promise;
    try {
      supplied.capsuleDigest = hex(999);
      supplied.expectedRevision = 4;
      supplied.expectedPayloadSha256 = hex(999);
      supplied.signal = new AbortController().signal;
    } finally {
      gate.resolve();
    }
    expect((await pending).status).toBe('attempted');
    expect((await store.get(hex(1))).state).toBe('attempted');
  });
  test('fresh recovered record cannot replace the original baseline with the same revision and digest', async () => {
    const store = await open();
    await prepare(store);
    mock.reattest = async (n) => {
      if (n === 1)
        await alter((v) => {
          v.entries[0].inputSha256 = hex(999);
        });
    };
    expect((await begin(store)).status).not.toBe('attempted');
    expect(store.signal.aborted).toBe(true);
    await store.closed;
    expect((await readDocument()).entries[0].state).toBe('prepared');
  });
  test.each(['before-rename', 'after-rename', 'floor', 'readback'])(
    'physical %s failure preserves actual durable state and refuses successful completion',
    async (fault) => {
      let armed = false;
      const store = await open(true, {
        advanceFloor: async (value) => {
          if (armed && fault === 'floor' && value === 2) throw Error('PRIVATE floor');
          minimum = value;
        },
      });
      await prepare(store);
      const prepared = await store.get(hex(1));
      const target = filename();
      const rename = fs.renameSync.bind(fs),
        read = fs.readFileSync.bind(fs);
      let renamed = false;
      const renamer = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (armed && to === target && fault === 'before-rename')
          throw Error('PRIVATE before rename');
        rename(from, to);
        if (armed && to === target) {
          renamed = true;
          if (fault === 'after-rename') throw Error('PRIVATE after rename');
        }
      });
      const reader = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
        if (armed && renamed && file === target && fault === 'readback')
          throw Error('PRIVATE readback');
        return read(file, ...args);
      });
      armed = true;
      let result;
      try {
        result = await begin(store);
      } finally {
        armed = false;
        renamer.mockRestore();
        reader.mockRestore();
      }
      expect(result.status).toBe('recovery-required');
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
      expect(store.signal.aborted).toBe(true);
      await store.closed;
      const cold = await open(false),
        recovered = await cold.get(hex(1));
      if (fault === 'before-rename') {
        expect(recovered).toEqual(prepared);
        expect(minimum).toBe(1);
      } else {
        assertAttempted(recovered, prepared);
        expect(minimum).toBe(2);
        expect((await begin(cold)).status).toBe('refused');
      }
    }
  );
  test('advanced floor refuses rollback to prepared ciphertext after a successful attempt', async () => {
    const store = await open();
    await prepare(store);
    const preparedBytes = fs.readFileSync(filename());
    await begin(store);
    expect(minimum).toBe(2);
    store.close();
    await store.closed;
    fs.writeFileSync(filename(), preparedBytes);
    await expect(open(false)).rejects.toMatchObject(REFUSED);
  });
  test.each(['before', 'after'])(
    'caller cancellation %s commit preserves healthy storage and correct state',
    async (point) => {
      const store = await open();
      await prepare(store);
      mock.reattest = async (n) => {
        if (n === (point === 'before' ? 1 : 2)) caller.abort();
      };
      const result = await begin(store);
      expect(result.status).toBe(point === 'before' ? 'refused' : 'recovery-required');
      expect(store.signal.aborted).toBe(false);
      expect((await store.get(hex(1))).state).toBe(point === 'before' ? 'prepared' : 'attempted');
      caller = new AbortController();
      mock.reattest = async () => {};
      expect((await begin(store)).status).toBe(point === 'before' ? 'attempted' : 'refused');
    }
  );
  test.each(['recovery', 'floor', 'post-attestation'])(
    'close retains filename ownership until ignored attempt %s work drains',
    async (point) => {
      const gate = deferred(),
        entered = deferred();
      let armed = false;
      const block = async () => {
        entered.resolve();
        await gate.promise;
      };
      const store = await open(true, {
        advanceFloor: async (value) => {
          minimum = value;
          if (armed && point === 'floor' && value === 2) await block();
        },
      });
      await prepare(store);
      if (point === 'recovery') mock.enterRecovery = block;
      if (point === 'post-attestation') mock.postRecovery = block;
      armed = true;
      let settled = false,
        drained = false;
      const pending = begin(store).then((value) => {
        settled = true;
        return value;
      });
      store.closed.then(() => {
        drained = true;
      });
      await entered.promise;
      store.close();
      try {
        await tick();
        expect(store.signal.aborted).toBe(true);
        expect(settled).toBe(false);
        expect(drained).toBe(false);
        await expect(open(false)).rejects.toMatchObject(REFUSED);
      } finally {
        gate.resolve();
      }
      expect((await pending).status).toBe(point === 'recovery' ? 'refused' : 'recovery-required');
      await store.closed;
      const cold = await open(false);
      expect((await cold.get(hex(1))).state).toBe(point === 'recovery' ? 'prepared' : 'attempted');
      store.close();
      expect((await begin(store)).status).toBe('refused');
      await expect(open(false)).rejects.toMatchObject(REFUSED);
      expect(cold.signal.aborted).toBe(false);
    }
  );
  test('maximal valid normalized payload fits future attempted shape and survives legacy migration', async () => {
    const field = (
      21888242871839275222246405745257275088548364400416034343698204186575808495617n - 1n
    )
      .toString(16)
      .padStart(64, '0');
    const point = (
      21888242871839275222246405745257275088696311157297823662689037894645226208583n - 1n
    ).toString();
    const issued = issue(1, 1, (h) => {
      h.payload = normalizeRailgunPoiPayload({
        ...h.payload,
        proof: {
          pi_a: [point, point],
          pi_b: [
            [point, point],
            [point, point],
          ],
          pi_c: [point, point],
        },
        poiMerkleroots: [field],
        txidMerkleroot: field,
        txidMerklerootIndex: 7999,
        blindedCommitmentsOut: ['0x' + field],
      });
      h.payloadSha256 = sha(h.payload);
      h.expected = { ...h.payload, outputCount: 1 };
    });
    const store = await open();
    expect((await prepare(store, issued)).status).toBe('prepared');
    store.close();
    await store.closed;
    await alter((v) => {
      v.version = 1;
    });
    const cold = await open(false);
    jest.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);
    expect((await begin(cold, issued)).status).toBe('attempted');
    const saved = await cold.get(hex(1));
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(await readDocument()))).toBeLessThanOrEqual(800 * 1024);
    expect(saved.attempt.submission.requestId).toBe(Number.MAX_SAFE_INTEGER);
  });
  const attemptCorruptions = [
    [
      'missing-attempt',
      (v) => {
        delete v.entries[0].attempt;
      },
    ],
    [
      'prepared-with-attempt',
      (v) => {
        v.entries[0].state = 'prepared';
        v.sequence--;
      },
    ],
    [
      'unknown-state',
      (v) => {
        v.entries[0].state = 'submitted';
      },
    ],
    [
      'attempt-extra',
      (v) => {
        v.entries[0].attempt.accepted = true;
      },
    ],
    [
      'timestamp-zero',
      (v) => {
        v.entries[0].attempt.attemptedAt = 0;
      },
    ],
    [
      'timestamp-mismatch',
      (v) => {
        v.entries[0].attempt.attemptedAt++;
      },
    ],
    [
      'endpoint',
      (v) => {
        v.entries[0].attempt.submission.endpoint = 'https://wrong.invalid';
      },
    ],
    [
      'payload-digest',
      (v) => {
        v.entries[0].attempt.submission.payloadSha256 = hex(999);
      },
    ],
    [
      'body-digest',
      (v) => {
        v.entries[0].attempt.submission.bodySha256 = hex(999);
      },
    ],
    [
      'body-bytes',
      (v) => {
        const sub = v.entries[0].attempt.submission;
        sub.body += ' ';
        sub.bodySha256 = createHash('sha256').update(sub.body).digest('hex');
      },
    ],
    [
      'foreign-valid-envelope',
      (v) => {
        const entry = v.entries[0];
        const payload = { ...entry.payload, txidMerkleroot: hex(999) };
        entry.attempt.submission = prepareRailgunPoiSubmission({
          payload,
          requestId: entry.attempt.attemptedAt,
        });
      },
    ],
    [
      'missing-transition-count',
      (v) => {
        v.sequence--;
      },
    ],
    [
      'extra-transition-count',
      (v) => {
        v.sequence++;
      },
    ],
    [
      'attempted-v1',
      (v) => {
        v.version = 1;
      },
    ],
  ];
  test.each(attemptCorruptions)(
    'authenticated invalid %s attempt cannot reopen',
    async (_name, change) => {
      const store = await open();
      await prepare(store);
      await begin(store);
      store.close();
      await store.closed;
      await alter(change);
      // Suppress the scalar floor for this decoder test, so exact record validation
      // rather than a coincidentally lower sequence must reject the document.
      await expect(open(false, { readFloor: async () => null })).rejects.toMatchObject(REFUSED);
    }
  );
});

test('unadvanced floor cannot detect restoring old prepared ciphertext after an interrupted attempt', async () => {
  let armed = false;
  const store = await open(true, {
    advanceFloor: async (value) => {
      if (armed && value === 2) throw Error('PRIVATE floor interruption');
      minimum = value;
    },
  });
  await prepare(store);
  const prepared = await store.get(hex(1));
  const previousCiphertext = fs.readFileSync(filename());
  armed = true;
  expect((await begin(store)).status).toBe('recovery-required');
  await store.closed;
  expect((await readDocument()).entries[0].state).toBe('attempted');
  expect(minimum).toBe(1);
  // Explicit limitation: data replacement and manifest-floor advancement are
  // separate durable writes. Restoring old data before floor repair is not
  // detected by this scalar floor. No sender or transport authority exists here.
  fs.writeFileSync(filename(), previousCiphertext);
  const cold = await open(false);
  expect(await cold.get(hex(1))).toEqual(prepared);
  expect(minimum).toBe(1);
});

describe.each(['caller', 'window'])(
  '%s cancellation inside actual attempt persistence',
  (source) => {
    test.each(['update-callback', 'committed-readback'])(
      '%s refuses while preserving healthy storage and the actual committed state',
      async (point) => {
        const store = await open();
        await prepare(store);
        const read = fs.readFileSync.bind(fs),
          rename = fs.renameSync.bind(fs);
        let reads = 0,
          renamed = false,
          revoked = false;
        const target = filename();
        const revoke = () => {
          revoked = true;
          if (source === 'caller') caller.abort();
          else mock.windowCurrent = false;
        };
        const renamer = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
          rename(from, to);
          if (to === target) renamed = true;
        });
        const reader = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
          const value = read(file, ...args);
          if (file === target) {
            reads++;
            // Selected-record attest, persistence attest, then atomic updater's
            // authenticated read. Post-rename readback is detected independently.
            if (
              !revoked &&
              ((point === 'update-callback' && reads === 3) ||
                (point === 'committed-readback' && renamed))
            )
              revoke();
          }
          return value;
        });
        let result;
        try {
          result = await begin(store);
        } finally {
          reader.mockRestore();
          renamer.mockRestore();
        }
        expect(revoked).toBe(true);
        expect(result.status).toBe(point === 'update-callback' ? 'refused' : 'recovery-required');
        expect(store.signal.aborted).toBe(false);
        expect((await store.get(hex(1))).state).toBe(
          point === 'update-callback' ? 'prepared' : 'attempted'
        );
        expect(minimum).toBe(point === 'update-callback' ? 1 : 2);
      }
    );
  }
);

test.each(['empty', 'prepared', 'attempted'])(
  'mock-registry Transact proof refuses before recovery and leaves %s encrypted store unchanged',
  async (state) => {
    const store = await open();
    if (state !== 'empty') expect((await prepare(store)).status).toBe('prepared');
    if (state === 'attempted') expect((await begin(store)).status).toBe('attempted');
    const inspect = await store.inspect(),
      list = await store.list();
    const ciphertext = fs.readFileSync(filename());
    const floor = minimum,
      advances = options.advanceFloor.mock.calls.length;
    const recoveries = withRailgunOwnOperationRecovery.mock.calls.length;
    const issued = issue(2, 1, (history) => {
      history.preparation.creator.type = 'Transact';
    });
    expect(await prepare(store, issued)).toEqual({ status: 'refused', stage: 'context' });
    expect(withRailgunOwnOperationRecovery).toHaveBeenCalledTimes(recoveries);
    expect(options.advanceFloor).toHaveBeenCalledTimes(advances);
    expect(minimum).toBe(floor);
    expect(await store.inspect()).toEqual(inspect);
    expect(await store.list()).toEqual(list);
    expect(fs.readFileSync(filename())).toEqual(ciphertext);
    expect(await store.get(hex(2))).toBeNull();
    expect(store.signal.aborted).toBe(false);
    // The rejected mutation released ownership; no reset/reopen is needed.
    expect((await prepare(store, issue(2))).status).toBe('prepared');
  }
);
test.each(['missing-preparation', 'missing-creator', 'unknown-type'])(
  'incomplete mock proof history %s cannot write an intent',
  async (fault) => {
    const store = await open();
    const issued = issue(2, 1, (history) => {
      if (fault === 'missing-preparation') delete history.preparation;
      if (fault === 'missing-creator') delete history.preparation.creator;
      if (fault === 'unknown-type') history.preparation.creator.type = 'Other';
    });
    const ciphertext = fs.readFileSync(filename()),
      floor = minimum;
    expect(await prepare(store, issued)).toEqual({ status: 'refused', stage: 'context' });
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    expect(fs.readFileSync(filename())).toEqual(ciphertext);
    expect(minimum).toBe(floor);
    expect((await prepare(store)).status).toBe('prepared');
  }
);
