const {
  createRailgunRelayUnsignedData,
} = require('../../../scripts/fixtures/railgun-relay-unsigned-data');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const { normalizeRailgunRelayPoiHistory } = require('./railgun-relay-poi-history');
const { normalizeRailgunRelayPrePoiBinding } = require('./railgun-relay-pre-poi-data');
const {
  decodeRailgunRelayLocalRecord: decode,
  digestRailgunRelayLocalIntent: digest,
  matchRailgunRelayLocalReservation: matchReservation,
  decodeRailgunRelayLocalDocument: document,
  RAILGUN_RELAY_LOCAL_LIMITS: limits,
} = require('./railgun-relay-recovery-data');
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
const refused = expect.objectContaining({ code: 'RAILGUN_RELAY_RECOVERY_DATA_REFUSED' });
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
const text = JSON.stringify;
function envelope(entries, sequence) {
  return {
    version: 4,
    binding: hex(101),
    walletId: fixture().walletId,
    lease: hex(105),
    sequence,
    entries,
  };
}
const context = (value) => ({ binding: value.binding, walletId: value.walletId });
function reservation(value, state = 'held') {
  return {
    id: value.id,
    origin: 'relay-local-v4',
    facts: {
      ...value.draft.selection,
      nullifier: value.draft.intent.expected.nullifier,
      noteHash: value.draft.noteHash,
      kind: 'railgun-relay-self-transfer',
      checkpointHash: value.checkpointHash,
      draftDigest: normalizeRailgunRelayDraftCapsule(value.draft).digest,
      expectedHash: value.draft.intent.expectedHash,
    },
    state,
    signing: ['signing-local', 'discarded-signed'].includes(state)
      ? { gatesDigest: value.authorizationDigest, recordDigest: digest(text(value)) }
      : null,
  };
}
const joins = {
  held: { held: null, 'cancelled-unsigned': 'release-unsigned' },
  'signing-local': {
    held: 'mark-recovery-signing',
    'signing-local': null,
    signed: null,
    'ready-local': null,
    'discarded-signed': 'release-signed',
  },
  'cancelled-unsigned': { 'cancelled-unsigned': null },
  'discarded-signed': { 'discarded-signed': null },
};
test.each(
  Object.keys(joins).flatMap((ledger) =>
    [
      'held',
      'signing-local',
      'signed',
      'ready-local',
      'cancelled-unsigned',
      'discarded-signed',
    ].map((record) => [ledger, record])
  )
)('ledger %s / record %s obeys marker-first and tombstone-first writes', (ledger, state) => {
  const value = fixture(state),
    entry = reservation(value, ledger);
  if (!Object.hasOwn(joins[ledger], state)) {
    expect(() => matchReservation(text(value), entry)).toThrow(refused);
    return;
  }
  const result = matchReservation(text(value), entry);
  expect(result).toEqual({
    record: value,
    recordDigest: digest(text(value)),
    draftDigest: normalizeRailgunRelayDraftCapsule(value.draft).digest,
    reservationState: ledger,
    interruptedStep: joins[ledger][state],
    authorityGranted: false,
  });
  expect(Object.isFrozen(result.record.draft)).toBe(true);
});
test.each([
  'id',
  'origin',
  'state',
  ...Object.keys(reservation(fixture()).facts).map((k) => 'facts.' + k),
  'signing.gatesDigest',
  'signing.recordDigest',
])('cross-store mismatch %s refuses', (key) => {
  const value = fixture('signed'),
    entry = reservation(value, 'signing-local');
  const parts = key.split('.'),
    target = parts.length === 1 ? entry : entry[parts[0]];
  target[parts.at(-1)] = 'wrong';
  expect(() => matchReservation(text(value), entry)).toThrow(refused);
});
test.each(['private', 'relay-v3-never-signed'])(
  'historical %s rows never gain local relay authority through a matching record',
  (origin) => {
    const value = fixture(),
      entry = reservation(value);
    entry.origin = origin;
    expect(() => matchReservation(text(value), entry)).toThrow(refused);
  }
);
test.each(['row', 'facts', 'signing'])(
  'rejects %s accessors/proxies without invoking them',
  (part) => {
    const value = fixture('signed');
    for (const proxy of [false, true]) {
      let entry = reservation(value, 'signing-local');
      const original = part === 'row' ? entry : entry[part];
      const trap = jest.fn(() => {
        throw new Error('must not execute');
      });
      let changed;
      if (proxy) changed = new Proxy(original, { get: trap, ownKeys: trap, getPrototypeOf: trap });
      else {
        changed = { ...original };
        Object.defineProperty(changed, Object.keys(original)[0], { enumerable: true, get: trap });
      }
      if (part === 'row') entry = changed;
      else entry[part] = changed;
      expect(() => matchReservation(text(value), entry)).toThrow(refused);
      expect(trap).not.toHaveBeenCalled();
    }
  }
);
test('terminal signed join preserves signature and proof; rebinding another record refuses', () => {
  const value = { ...fixture('ready-local'), state: 'discarded-signed' };
  const entry = reservation(value, 'discarded-signed');
  expect(matchReservation(text(value), entry).record).toEqual(value);
  const changed = { ...value, generationId: hex(999) };
  expect(() => matchReservation(text(changed), entry)).toThrow(refused);
  entry.signing.recordDigest = digest(text(changed));
  // Pure equality cannot authenticate an attacker changing both stores. The
  // account owner must establish custody, floors and generation separately.
  expect(matchReservation(text(changed), entry).authorityGranted).toBe(false);
});
test.each([
  'held',
  'signing-local',
  'signed',
  'ready-local',
  'cancelled-unsigned',
  'discarded-signed',
])('decodes structurally coherent %s without claiming cryptographic validity', (state) => {
  const v = fixture(state),
    result = decode(text(v));
  expect(result).toEqual(v);
  expect(Object.isFrozen(result.history.proof.elements)).toBe(true);
  expect(result.signature).toEqual(v.signature);
});
test('immutable intent digest survives signature/proof/terminal slots but binds original history and ownership', () => {
  const held = fixture(),
    signed = fixture('signed'),
    ready = fixture('ready-local');
  expect(digest(text(held))).toBe(digest(text(signed)));
  expect(digest(text(held))).toBe(digest(text(ready)));
  expect(digest(text(held))).toBe(digest(text({ ...ready, state: 'discarded-signed' })));
  const changed = fixture();
  changed.history.event.signedPOIEvent.signature = '34'.repeat(64);
  expect(digest(text(changed))).not.toBe(digest(text(held)));
  for (const key of ['id', 'binding', 'generationId', 'checkpointHash', 'authorizationDigest']) {
    const other = { ...held, [key]: hex(999) };
    expect(digest(text(other))).not.toBe(digest(text(held)));
  }
});
test.each([
  [
    'future format',
    (v) => {
      v.schema = 'railgun-relay-local-record-v5';
    },
  ],
  [
    'exported state',
    (v) => {
      v.state = 'sent';
    },
  ],
  [
    'unsigned signature',
    (v) => {
      v.state = 'held';
    },
  ],
  [
    'unsigned cancellation',
    (v) => {
      v.state = 'cancelled-unsigned';
    },
  ],
  [
    'missing signature',
    (v) => {
      v.signature = null;
    },
  ],
  [
    'missing proof',
    (v) => {
      v.proved = null;
    },
  ],
  [
    'history draft join',
    (v) => {
      v.history.draftDigest = hex(999);
    },
  ],
  [
    'binding draft join',
    (v) => {
      v.prePoiBinding.draftDigest = hex(999);
    },
  ],
  [
    'wallet join',
    (v) => {
      v.walletId = hex(999);
    },
  ],
  [
    'changed output order',
    (v) => {
      v.proved.payload.blindedCommitmentsOut = [
        ...v.proved.payload.blindedCommitmentsOut,
      ].reverse();
    },
  ],
  [
    'changed transaction',
    (v) => {
      v.proved.transaction = { ...v.proved.transaction, value: '1' };
    },
  ],
])('refuses inconsistent %s', (_name, mutate) => {
  const v = JSON.parse(text(fixture('ready-local')));
  mutate(v);
  expect(() => decode(text(v))).toThrow(refused);
});
test('original list witness cannot silently change between history and pre-POI binding', () => {
  const v = JSON.parse(text(fixture()));
  v.history.proof.elements[0] = hex(99);
  expect(() => decode(text(v))).toThrow(refused);
});
test('duplicate fields and oversized serialized input refuse before normalization', () => {
  const v = fixture();
  expect(() => decode(text(v).replace('{', '{"state":"sent",'))).toThrow(refused);
  expect(() => decode(' '.repeat(limits.record + 1))).toThrow(refused);
});
test('noncanonical top-level and nested key ordering cannot rewrite retained bytes', () => {
  const v = fixture('ready-local');
  for (const changed of [
    { state: v.state, ...v },
    { ...v, history: { event: v.history.event, ...v.history } },
    {
      ...v,
      proved: {
        ...v.proved,
        transaction: { data: v.proved.transaction.data, ...v.proved.transaction },
      },
    },
  ])
    expect(() => decode(text(changed))).toThrow(refused);
  const doc = envelope([v], 4);
  expect(() => document(text({ entries: doc.entries, ...doc }), context(doc))).toThrow(refused);
});
test('ten retained complete rows reserve bounded completion and outer-map encoding space', () => {
  const maximumComponents =
    limits.draft +
    limits.history +
    limits.prePoiBinding +
    limits.signature +
    limits.transaction +
    limits.payload +
    limits.metadata;
  expect(maximumComponents).toBeLessThan(limits.record);
  expect(limits.records * limits.record + limits.envelope).toBe(limits.document);
  expect(limits.document).toBeLessThan(1024 * 1024);
  // Canonical nested JSON contains no unescaped control characters. Encoding
  // it as a storage string at most doubles UTF-8 bytes plus two quote bytes.
  expect(2 * limits.document + 2 + 1024).toBeLessThan(4 * 1024 * 1024);
  const entries = Array.from({ length: 10 }, (_, i) => ({
    ...fixture('ready-local'),
    id: hex(1000 + i),
    state: 'discarded-signed',
  }));
  const v = envelope(entries, 50);
  expect(document(text(v), context(v)).entries).toHaveLength(10);
  const extra = { ...v, entries: [...entries, { ...entries[0], id: hex(2000) }], sequence: 55 };
  expect(() => document(text(extra), context(v))).toThrow(refused);
});
test.each([
  ['signing-local', 2],
  ['signed', 3],
  ['ready-local', 4],
  ['cancelled-unsigned', 2],
  ['discarded-signed', 3],
])(
  'retains exact %s history cost including a signing marker without a saved signature',
  (state, sequence) => {
    const v = envelope([fixture(state)], sequence);
    expect(document(text(v), context(v)).sequence).toBe(sequence);
    expect(() => document(text({ ...v, sequence: sequence - 1 }), context(v))).toThrow(refused);
  }
);
test('document refuses wrong account, lease, sequence, duplicate IDs and future version', () => {
  const v = envelope([fixture()], 1);
  for (const altered of [
    { ...v, binding: hex(99) },
    { ...v, walletId: hex(99) },
    { ...v, lease: 'short' },
    { ...v, sequence: 0 },
    { ...v, version: 5 },
    { ...v, entries: [fixture(), fixture()], sequence: 2 },
  ])
    expect(() => document(text(altered), context(v))).toThrow(refused);
});
