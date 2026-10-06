let mockOwners = new WeakMap(),
  mockAfterCheck;
// Explicit structural issuer seam only. No enrollment, SQLite, profile, engine
// or original-work lifecycle is qualified by these synchronous codec tests.
jest.mock('./railgun-account-enrollment', () => ({
  assertRailgunFencedAccountEnrollment: jest.fn((owner) => {
    if (!owner || require('util').types.isProxy(owner) || !mockOwners.get(owner)?.live)
      throw Error('synthetic fenced owner refused');
    mockAfterCheck?.();
  }),
}));
const { createRailgunReservationLedgerCodec } = require('./railgun-reservation-ledger');
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
const field = (n) => '0x' + hex(n);
const BINDING = hex(100),
  WALLET = hex(101),
  LEASE = hex(102),
  FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const privateFacts = (n = 1) => ({
  tree: 0,
  position: n,
  nullifier: field(n),
  noteHash: field(1000 + n),
  kind: 'railgun-private-transfer',
  intentDigest: field(2000 + n),
  checkpointHash: hex(103),
  poiDigest: hex(104),
});
const relayFacts = (n = 1) => ({
  tree: 0,
  position: n,
  nullifier: field(n),
  noteHash: field(1000 + n),
  kind: 'railgun-relay-self-transfer',
  checkpointHash: hex(103),
  draftDigest: hex(2000 + n),
  expectedHash: field(3000 + n),
});
const privateSigning = () => ({
  submitter: '0x' + '1'.repeat(40),
  operationId: hex(105),
  gatesDigest: hex(106),
});
const relaySigning = () => ({ gatesDigest: hex(107), recordDigest: hex(108) });
const historicalRow = (n, state = 'held', relay = false) => ({
  id: hex(n),
  facts: (relay ? relayFacts : privateFacts)(n),
  state,
  signing: state === 'signing' ? privateSigning() : null,
});
const document = (entries = [], version = 2, sequence = entries.length) =>
  JSON.stringify({ version, binding: BINDING, walletId: WALLET, lease: LEASE, sequence, entries });
let owner, codec;
beforeEach(() => {
  mockOwners = new WeakMap();
  mockAfterCheck = undefined;
  owner = Object.freeze({ binding: BINDING, descriptor: Object.freeze({ walletId: WALLET }) });
  mockOwners.set(owner, { live: true });
  codec = createRailgunReservationLedgerCodec({
    enrollment: owner,
    binding: BINDING,
    walletId: WALLET,
  });
});
const decode = (text) => codec.decode(text);
const empty = () => codec.create(LEASE);
const reserve = (text, n = 1, relay = false) =>
  codec.apply(text, {
    type: relay ? 'reserve-relay' : 'reserve-private',
    id: hex(n),
    facts: (relay ? relayFacts : privateFacts)(n),
  });
const action = (text, type, n = 1, signing) =>
  codec.apply(text, { type, id: hex(n), ...(signing === undefined ? {} : { signing }) });

test('v1 normalization preserves original sequence and permanently conflicting legacy state', () => {
  const facts = privateFacts(),
    text = document([{ id: hex(1), facts }], 1);
  expect(decode(text)).toMatchObject({
    version: 2,
    sequence: 1,
    entries: [{ state: 'legacy', signing: null }],
  });
  const upgraded = codec.upgrade(text, hex(9));
  expect(decode(upgraded)).toMatchObject({
    version: 4,
    sequence: 1,
    lease: hex(9),
    entries: [{ origin: 'private', facts, state: 'legacy' }],
  });
  expect(() => action(upgraded, 'abandon-private')).toThrow();
  expect(() => reserve(upgraded, 1, true)).toThrow();
});
test.each([2, 3])(
  'historical v%s private states/signing fields and exact sequence survive upgrade',
  (version) => {
    const entries = ['legacy', 'held', 'signing', 'abandoned'].map((state, i) =>
      historicalRow(i + 1, state)
    );
    const text = document(entries, version, 6),
      result = decode(codec.upgrade(text, LEASE));
    expect(result.sequence).toBe(6);
    expect(result.entries).toEqual(
      entries.map((entry) => ({
        id: entry.id,
        origin: 'private',
        facts: entry.facts,
        state: entry.state,
        signing: entry.signing,
      }))
    );
  }
);
test('v3 migrated origin never becomes signing authority after upgrade or reopening', () => {
  const text = document(
    [historicalRow(1, 'held', true), historicalRow(2, 'abandoned', true)],
    3,
    3
  );
  let next = codec.upgrade(text, hex(10));
  expect(decode(next).entries.map((e) => [e.origin, e.state])).toEqual([
    ['relay-v3-never-signed', 'held'],
    ['relay-v3-never-signed', 'cancelled-unsigned'],
  ]);
  next = codec.upgrade(next, hex(11));
  expect(() => action(next, 'mark-relay-signing', 1, relaySigning())).toThrow();
  expect(() => action(next, 'mark-private-signing', 1, privateSigning())).toThrow();
  const cancelled = action(next, 'cancel-relay-unsigned');
  expect(decode(cancelled).sequence).toBe(4);
  expect(decode(cancelled).entries[0]).toMatchObject({
    origin: 'relay-v3-never-signed',
    state: 'cancelled-unsigned',
    signing: null,
  });
});
test('new relay signing/discard retains immutable origin, facts, ID and signing history', () => {
  const held = reserve(empty(), 1, true),
    signing = relaySigning(),
    signed = action(held, 'mark-relay-signing', 1, signing);
  signing.gatesDigest = hex(99);
  const discarded = action(signed, 'discard-relay-local');
  expect(decode(discarded)).toMatchObject({
    sequence: 3,
    entries: [
      {
        id: hex(1),
        origin: 'relay-local-v4',
        facts: relayFacts(),
        state: 'discarded-signed',
        signing: relaySigning(),
      },
    ],
  });
  expect(codec.upgrade(discarded, hex(90))).toContain('"version":4');
  expect(decode(codec.upgrade(discarded, hex(90))).entries).toEqual(decode(discarded).entries);
});
test('private transitions remain private and cannot release signing or legacy rows', () => {
  const held = reserve(empty()),
    signed = action(held, 'mark-private-signing', 1, privateSigning());
  expect(decode(signed).entries[0]).toMatchObject({
    origin: 'private',
    state: 'signing',
    signing: privateSigning(),
  });
  for (const type of ['abandon-private', 'cancel-relay-unsigned', 'discard-relay-local'])
    expect(() => action(signed, type)).toThrow();
  expect(decode(action(held, 'abandon-private')).sequence).toBe(2);
});
test.each([false, true])(
  'same tree/nullifier conflicts across kinds regardless position/hash (%s first)',
  (relay) => {
    const held = reserve(empty(), 1, relay),
      facts = (relay ? privateFacts : relayFacts)(2);
    facts.nullifier = field(1);
    expect(() =>
      codec.apply(held, { type: relay ? 'reserve-private' : 'reserve-relay', id: hex(2), facts })
    ).toThrow(expect.objectContaining({ code: 'RAILGUN_PRIVATE_INPUT_RESERVED' }));
    facts.tree = 1;
    expect(
      decode(
        codec.apply(held, { type: relay ? 'reserve-private' : 'reserve-relay', id: hex(2), facts })
      ).entries
    ).toHaveLength(2);
  }
);
test.each(['abandon-private', 'cancel-relay-unsigned', 'discard-relay-local'])(
  'terminal %s releases only input conflict, preserving lifetime ID/history',
  (type) => {
    let text = reserve(empty(), 1, type !== 'abandon-private');
    if (type === 'discard-relay-local')
      text = action(text, 'mark-relay-signing', 1, relaySigning());
    text = action(text, type);
    const facts = relayFacts(2);
    facts.nullifier = field(1);
    expect(() => codec.apply(text, { type: 'reserve-relay', id: hex(1), facts })).toThrow();
    const next = codec.apply(text, { type: 'reserve-relay', id: hex(2), facts });
    expect(decode(next).entries[0]).toEqual(decode(text).entries[0]);
    expect(decode(next).entries).toHaveLength(2);
  }
);
test.each([
  ['relay', 'abandon-private'],
  ['relay', 'discard-relay-local'],
  ['private', 'cancel-relay-unsigned'],
  ['private', 'discard-relay-local'],
  ['relay', 'unknown'],
])('held %s refuses incompatible %s', (kind, type) => {
  expect(() => action(reserve(empty(), 1, kind === 'relay'), type)).toThrow();
});
test('unsigned cancellation is two transitions and never becomes signed discard or resign', () => {
  const text = action(reserve(empty(), 1, true), 'cancel-relay-unsigned');
  expect(decode(text)).toMatchObject({
    sequence: 2,
    entries: [{ state: 'cancelled-unsigned', signing: null }],
  });
  for (const type of ['cancel-relay-unsigned', 'discard-relay-local'])
    expect(() => action(text, type)).toThrow();
  expect(() => action(text, 'mark-relay-signing', 1, relaySigning())).toThrow();
});
test('signing-local cannot be cancelled unsigned or signed twice', () => {
  const text = action(reserve(empty(), 1, true), 'mark-relay-signing', 1, relaySigning());
  expect(() => action(text, 'cancel-relay-unsigned')).toThrow();
  expect(() => action(text, 'mark-relay-signing', 1, relaySigning())).toThrow();
});

function v4Row(n, state = 'held', origin = 'relay-local-v4') {
  return {
    id: hex(n),
    origin,
    facts: origin === 'private' ? privateFacts(n) : relayFacts(n),
    state,
    signing:
      state === 'signing'
        ? privateSigning()
        : ['signing-local', 'discarded-signed'].includes(state)
          ? relaySigning()
          : null,
  };
}
test('future transition budget refuses 342 held relay rows before sequence itself is exhausted', () => {
  const rows = Array.from({ length: 341 }, (_, i) => v4Row(i + 1));
  const text = document(rows, 4, 341);
  expect(decode(text).sequence).toBe(341);
  expect(() => reserve(text, 342, true)).toThrow(
    expect.objectContaining({ code: 'RAILGUN_RESERVATIONS_CAPACITY' })
  );
  expect(() => decode(document([...rows, v4Row(342)], 4, 342))).toThrow();
});
test('exact 1024 remaining budget permits completion; one extra transition is refused', () => {
  const rows = [
    ...Array.from({ length: 340 }, (_, i) => v4Row(i + 1)),
    v4Row(341, 'held', 'private'),
    v4Row(342, 'held', 'private'),
  ];
  const text = document(rows, 4, 342); // 340*3 + 2*2 = 1024 reserved lifetime.
  expect(decode(text).entries).toHaveLength(342);
  expect(() => reserve(text, 343)).toThrow();
  const signed = action(text, 'mark-relay-signing', 1, relaySigning());
  expect(decode(signed).sequence).toBe(343);
  expect(decode(action(signed, 'discard-relay-local')).sequence).toBe(344);
});
test('unsigned cancellation frees unused future budget but never past sequence or row capacity', () => {
  const rows = Array.from({ length: 341 }, (_, i) => v4Row(i + 1));
  let text = document(rows, 4, 341);
  text = action(text, 'cancel-relay-unsigned'); // now total reserved cost 1022.
  text = reserve(text, 342, false); // exactly 1024 with a new private row.
  expect(decode(text).sequence).toBe(343);
  expect(decode(text).entries).toHaveLength(342);
  expect(() => reserve(text, 343)).toThrow();
});
test('512 retained private lifetimes can complete at 1024 but never admit a 513th', () => {
  const rows = Array.from({ length: 512 }, (_, i) => v4Row(i + 1, 'abandoned', 'private'));
  const text = document(rows, 4, 1024);
  expect(decode(text).entries).toHaveLength(512);
  expect(() => reserve(text, 513)).toThrow(
    expect.objectContaining({ code: 'RAILGUN_RESERVATIONS_CAPACITY' })
  );
  expect(() => decode(document([...rows, v4Row(513, 'legacy', 'private')], 4, 1025))).toThrow();
});
test('terminal signing history must contribute three exact transitions, not two', () => {
  const row = v4Row(1, 'discarded-signed');
  expect(decode(document([row], 4, 3)).sequence).toBe(3);
  expect(() => decode(document([row], 4, 2))).toThrow();
  row.signing = null;
  expect(() => decode(document([row], 4, 3))).toThrow();
});
test('maximum canonical row/document bound covers future terminal fields below 512KiB', () => {
  const d = 'f'.repeat(64),
    f = field(FIELD - 1n);
  const privateKinds = [
    'railgun-private-transfer',
    'railgun-token-unshield',
    'railgun-partial-unshield',
  ];
  const maxPrivate = {
    id: d,
    origin: 'private',
    facts: {
      tree: 65535,
      position: 65535,
      nullifier: f,
      noteHash: f,
      kind: privateKinds.reduce((a, b) => (a.length >= b.length ? a : b)),
      intentDigest: '0x' + d,
      checkpointHash: d,
      poiDigest: d,
    },
    state: 'signing',
    signing: { submitter: '0x' + 'f'.repeat(40), operationId: d, gatesDigest: d },
  };
  const relay = {
    id: d,
    origin: 'relay-local-v4',
    facts: {
      tree: 65535,
      position: 65535,
      nullifier: f,
      noteHash: f,
      kind: 'railgun-relay-self-transfer',
      checkpointHash: d,
      draftDigest: d,
      expectedHash: f,
    },
    state: 'discarded-signed',
    signing: { gatesDigest: d, recordDigest: d },
  };
  const migrated = {
    ...relay,
    origin: 'relay-v3-never-signed',
    state: 'cancelled-unsigned',
    signing: null,
  };
  expect(
    [maxPrivate, migrated, relay].map((row) => Buffer.byteLength(JSON.stringify(row)))
  ).toEqual([823, 637, 788]);
  const rows = Array.from({ length: 512 }, (_, i) => ({
    ...maxPrivate,
    id: hex(i + 1),
    facts: { ...maxPrivate.facts, nullifier: field(i + 1) },
  }));
  const max = document(rows, 4, 1024);
  expect(Buffer.byteLength(max)).toBe(422159);
  expect(Buffer.byteLength(max)).toBeLessThan(512 * 1024);
  expect(decode(max).entries).toHaveLength(512);
});

test.each([1, 2, 3, 4])(
  'v%s rejects wrong sequence, versions and altered owner joins',
  (version) => {
    const entry =
      version === 1
        ? { id: hex(1), facts: privateFacts() }
        : version === 4
          ? v4Row(1, 'held', 'private')
          : historicalRow(1);
    const valid = JSON.parse(document([entry], version));
    for (const changed of [
      { sequence: 0 },
      { sequence: 2 },
      { version: 5 },
      { binding: hex(9) },
      { walletId: hex(9) },
      { lease: 'x' },
    ])
      expect(() => decode(JSON.stringify({ ...valid, ...changed }))).toThrow();
  }
);
test.each([1, 2])('relay facts are impossible in historical v%s', (version) => {
  const row = version === 1 ? { id: hex(1), facts: relayFacts() } : historicalRow(1, 'held', true);
  expect(() => decode(document([row], version))).toThrow();
});
test('v3 relay signed row and v4 migrated signing-local are refused', () => {
  expect(() => decode(document([historicalRow(1, 'signing', true)], 3, 2))).toThrow();
  expect(() =>
    decode(document([v4Row(1, 'signing-local', 'relay-v3-never-signed')], 4, 2))
  ).toThrow();
});
test.each([
  'tree',
  'position',
  'nullifier',
  'noteHash',
  'kind',
  'checkpointHash',
  'draftDigest',
  'expectedHash',
])('relay fact %s mutation refuses without inventing a normalized value', (key) => {
  const facts = relayFacts();
  facts[key] =
    key === 'tree' || key === 'position'
      ? 65536
      : key === 'nullifier' || key === 'noteHash' || key === 'expectedHash'
        ? field(FIELD)
        : 'invalid';
  expect(() => codec.apply(empty(), { type: 'reserve-relay', id: hex(1), facts })).toThrow();
});
test.each(['submitter', 'operationId', 'gatesDigest'])(
  'private signing %s is still constrained',
  (key) => {
    const signing = privateSigning();
    signing[key] = key === 'submitter' ? '0x' + '0'.repeat(40) : 'wrong';
    expect(() => action(reserve(empty()), 'mark-private-signing', 1, signing)).toThrow();
  }
);
test.each(['gatesDigest', 'recordDigest'])(
  'relay signing requires bounded %s but grants no verification',
  (key) => {
    const signing = relaySigning();
    signing[key] = 'wrong';
    expect(() => action(reserve(empty(), 1, true), 'mark-relay-signing', 1, signing)).toThrow();
  }
);
test('decoded/action data are detached, frozen and do not accept a decoded-object shortcut', () => {
  const facts = relayFacts(),
    next = codec.apply(empty(), { type: 'reserve-relay', id: hex(1), facts });
  facts.nullifier = field(9);
  const value = decode(next);
  expect(value.entries[0].facts.nullifier).toBe(field(1));
  for (const item of [value, value.entries, value.entries[0], value.entries[0].facts])
    expect(Object.isFrozen(item)).toBe(true);
  expect(Reflect.set(value.entries[0].facts, 'nullifier', field(7))).toBe(false);
  expect(decode(next)).toEqual(value);
  expect(() => decode(value)).toThrow();
  expect(() => codec.upgrade(value, LEASE)).toThrow();
});
test('accessor/proxy/unknown action input refuses with zero callbacks', () => {
  let calls = 0;
  const getter = () => {
    calls++;
    return 'reserve-relay';
  };
  const text = empty();
  const bad = [
    new Proxy({}, { getPrototypeOf: getter, get: getter, ownKeys: getter }),
    {
      get type() {
        return getter();
      },
      id: hex(1),
      facts: relayFacts(),
    },
    {
      type: 'reserve-relay',
      id: hex(1),
      get facts() {
        return getter();
      },
    },
    { type: 'reserve-relay', id: hex(1), facts: relayFacts(), extra: true },
    {
      type: 'reserve-relay',
      id: hex(1),
      facts: {
        ...relayFacts(),
        get noteHash() {
          return getter();
        },
      },
    },
  ];
  for (const input of bad) expect(() => codec.apply(text, input)).toThrow();
  expect(calls).toBe(0);
});
test('symbol/nonenumerable/prototype and forged origin fields cannot enter exact actions', () => {
  const a = { type: 'reserve-relay', id: hex(1), facts: relayFacts() };
  const values = [
    Object.assign({ ...a }, { [Symbol('x')]: 1 }),
    Object.assign(Object.create(null), a),
    { ...a, origin: 'relay-v3-never-signed' },
  ];
  const hidden = { ...a };
  Object.defineProperty(hidden, 'facts', { value: relayFacts(), enumerable: false });
  values.push(hidden);
  for (const value of values) expect(() => codec.apply(empty(), value)).toThrow();
});
test('factory joins genuine owner before reading any foreign enrollment properties', () => {
  let calls = 0;
  const foreign = {
    get binding() {
      calls++;
      return BINDING;
    },
  };
  expect(() =>
    createRailgunReservationLedgerCodec({ enrollment: foreign, binding: BINDING, walletId: WALLET })
  ).toThrow();
  expect(calls).toBe(0);
  for (const changed of [{ binding: hex(10) }, { walletId: hex(10) }])
    expect(() =>
      createRailgunReservationLedgerCodec({
        enrollment: owner,
        binding: BINDING,
        walletId: WALLET,
        ...changed,
      })
    ).toThrow();
});
test('factory context rejects proxy, accessor and unknown fields without invoking them', () => {
  let calls = 0;
  const read = () => {
    calls++;
    return owner;
  };
  const good = { enrollment: owner, binding: BINDING, walletId: WALLET };
  for (const options of [
    new Proxy(good, { get: read, getPrototypeOf: read, ownKeys: read }),
    {
      ...good,
      get enrollment() {
        return read();
      },
    },
    { ...good, authority: true },
  ])
    expect(() => createRailgunReservationLedgerCodec(options)).toThrow();
  expect(calls).toBe(0);
  const codecOptions = { ...good };
  const detached = createRailgunReservationLedgerCodec(codecOptions);
  codecOptions.binding = hex(900);
  codecOptions.enrollment = {};
  expect(JSON.parse(detached.create(LEASE)).binding).toBe(BINDING);
});
test.each(['decode', 'upgrade', 'create', 'apply'])(
  'every %s operation rechecks genuine live fence after factory admission',
  (method) => {
    const text = reserve(empty());
    mockOwners.get(owner).live = false;
    const args = {
      decode: [text],
      upgrade: [text, LEASE],
      create: [LEASE],
      apply: [text, { type: 'abandon-private', id: hex(1) }],
    };
    expect(() => codec[method](...args[method])).toThrow('synthetic fenced owner refused');
  }
);
test('revocation after admission check cannot escape the final synchronous lifetime check', () => {
  const text = reserve(empty());
  mockAfterCheck = () => {
    mockOwners.get(owner).live = false;
  };
  expect(() => codec.apply(text, { type: 'abandon-private', id: hex(1) })).toThrow();
});
test('noncanonical shape, duplicate IDs/active input, malformed JSON and byte excess refuse safely', () => {
  const row = v4Row(1);
  for (const text of [
    '{bad public fixture',
    ' '.repeat(512 * 1024 + 1),
    JSON.stringify({ ...JSON.parse(empty()), unexpected: true }),
    document([row, row], 4, 2),
    document([row, { ...row, id: hex(2) }], 4, 2),
    document([{ ...row, signing: relaySigning() }], 4, 1),
    document([{ ...row, origin: 'future-v5' }], 4, 1),
  ])
    expect(() => decode(text)).toThrow('Railgun reservation proposal refused');
});

test('private availability predicts the same conflict and future budget as reserve without a proposal', () => {
  const selected = { tree: 0, nullifier: field(600) };
  expect(codec.assertPrivateAvailable(codec.create(LEASE), selected)).toBeUndefined();
  const occupied = codec.apply(codec.create(LEASE), {
    type: 'reserve-relay',
    id: hex(1),
    facts: relayFacts(600),
  });
  expect(() => codec.assertPrivateAvailable(occupied, selected)).toThrow(
    expect.objectContaining({ code: 'RAILGUN_PRIVATE_INPUT_RESERVED' })
  );
  let text = codec.create(LEASE);
  for (let i = 1; i <= 341; i++)
    text = codec.apply(text, { type: 'reserve-relay', id: hex(i), facts: relayFacts(i) });
  expect(() => codec.assertPrivateAvailable(text, selected)).toThrow(
    expect.objectContaining({ code: 'RAILGUN_RESERVATIONS_CAPACITY' })
  );
  expect(() =>
    codec.apply(text, { type: 'reserve-private', id: hex(600), facts: privateFacts(600) })
  ).toThrow(expect.objectContaining({ code: 'RAILGUN_RESERVATIONS_CAPACITY' }));
});

test('availability refuses proxy/getter/extra identity without executing caller code', () => {
  const effect = jest.fn();
  const text = codec.create(LEASE),
    selected = { tree: 0, nullifier: field(1) };
  expect(() =>
    codec.assertPrivateAvailable(text, new Proxy(selected, { get: effect, ownKeys: effect }))
  ).toThrow();
  expect(() => codec.assertPrivateAvailable(text, { ...selected, extra: 1 })).toThrow();
  expect(() =>
    codec.assertPrivateAvailable(text, {
      get tree() {
        effect();
        return 0;
      },
      nullifier: field(1),
    })
  ).toThrow();
  expect(effect).not.toHaveBeenCalled();
});
