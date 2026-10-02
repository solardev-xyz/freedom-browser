const { paths } = require('./railgun-frontier');
const {
  ZERO_NODES,
  projectPublicRecord,
  createPublicRecordDigest,
  inspectPublicRecords,
  emptyPublicState,
} = require('./railgun-public-records');
const segment = (n) => BigInt(n).toString(16).padStart(64, '0');
const bytes = (n, length = 32) => n.toString(16).padStart(length * 2, '0');
const prefix = paths.metadata().toString();
const nullifierKey = (n = 1) =>
  Buffer.from([prefix, segment(0), segment(0xfffffffe), segment(n)].join(':'));
const unshieldKey = (n = 1) =>
  Buffer.from([prefix, segment(0xfffffffd), bytes(55), segment(n)].join(':'));
const shield = () => ({
  commitmentType: 'ShieldCommitment',
  hash: bytes(1),
  txid: bytes(55),
  blockNumber: 100,
  utxoTree: 0,
  utxoIndex: 0,
  preImage: {
    npk: bytes(2),
    token: { tokenType: 0, tokenAddress: '0x' + bytes(3, 20), tokenSubID: '0x' + bytes(0) },
    value: bytes(4, 16),
  },
  encryptedBundle: [1, 2, 3].map((n) => '0x' + bytes(n)),
  shieldKey: '0x' + bytes(9),
  fee: '1',
});
const transact = () => ({
  commitmentType: 'TransactCommitmentV2',
  hash: bytes(1),
  txid: bytes(55),
  blockNumber: 100,
  utxoTree: 0,
  utxoIndex: 0,
  ciphertext: {
    ciphertext: { iv: bytes(1, 16), tag: bytes(2, 16), data: [1, 2, 3].map((n) => bytes(n)) },
    blindedSenderViewingKey: bytes(4),
    blindedReceiverViewingKey: bytes(5),
    annotationData: '0x1234',
    memo: '0x',
  },
});
const unshield = () => ({
  txid: bytes(55),
  toAddress: '0x' + bytes(5, 20),
  tokenType: 0,
  tokenAddress: '0x' + bytes(3, 20),
  tokenSubID: '0',
  amount: '100',
  fee: '1',
  blockNumber: 100,
  eventLogIndex: 1,
});
const trees = [{ tree: 0, length: 1, root: '0x' + bytes(1) }];
const encode = (v) => Buffer.from(JSON.stringify(v));
function store(records) {
  const rows = records.slice().sort(([a], [b]) => Buffer.compare(a, b));
  return {
    getInstanceId: () => 'a'.repeat(64),
    openSnapshot: () => {
      let index = 0;
      return {
        next: () => rows[index++]?.map((value) => Buffer.from(value)) ?? null,
        close: jest.fn(),
      };
    },
  };
}
const inspect = (records) =>
  inspectPublicRecords(store(records), { status: 'persisted-unverified', trees });
test('public projections preserve event fields and ignore only declared later enrichment', () => {
  for (const value of [shield(), transact()]) {
    const baseline = projectPublicRecord(paths.data(0, 0), encode(value), trees);
    value.timestamp = 1234;
    if (value.commitmentType === 'ShieldCommitment') value.from = '0x' + bytes(10, 20);
    else value.railgunTxid = bytes(20);
    expect(projectPublicRecord(paths.data(0, 0), encode(value), trees)).toEqual(baseline);
  }
  const value = unshield(),
    baseline = projectPublicRecord(unshieldKey(), encode(value), trees);
  value.timestamp = 1234;
  value.railgunTxid = bytes(20);
  value.poisPerList = { fixture: 'unchecked' };
  expect(projectPublicRecord(unshieldKey(), encode(value), trees)).toEqual(baseline);
});
// Every immutable payload field must affect the digest, not merely parse.
const mutations = {
  shield: {
    hash: bytes(22),
    txid: bytes(22),
    blockNumber: 101,
    'preImage.npk': bytes(22),
    'preImage.value': bytes(22, 16),
    'preImage.token.tokenType': 1,
    'preImage.token.tokenAddress': '0x' + bytes(22, 20),
    'preImage.token.tokenSubID': '0x' + bytes(22),
    'encryptedBundle.0': '0x' + bytes(22),
    'encryptedBundle.1': '0x' + bytes(22),
    'encryptedBundle.2': '0x' + bytes(22),
    shieldKey: '0x' + bytes(22),
    fee: '22',
  },
  transact: {
    hash: bytes(22),
    txid: bytes(22),
    blockNumber: 101,
    'ciphertext.ciphertext.iv': bytes(22, 16),
    'ciphertext.ciphertext.tag': bytes(22, 16),
    'ciphertext.ciphertext.data.0': bytes(22),
    'ciphertext.ciphertext.data.1': bytes(22),
    'ciphertext.ciphertext.data.2': bytes(22),
    'ciphertext.blindedSenderViewingKey': bytes(22),
    'ciphertext.blindedReceiverViewingKey': bytes(22),
    'ciphertext.annotationData': '0x00',
    'ciphertext.memo': '0x00',
  },
  unshield: {
    blockNumber: 101,
    toAddress: '0x' + bytes(22, 20),
    tokenType: 1,
    tokenAddress: '0x' + bytes(22, 20),
    tokenSubID: '22',
    amount: '22',
    fee: '22',
  },
};
test.each(
  Object.entries(mutations).flatMap(([kind, fields]) =>
    Object.entries(fields).map(([field, changed]) => [kind, field, changed])
  )
)('%s %s affects its public digest', (kind, field, changed) => {
  const value = { shield, transact, unshield }[kind]();
  const key = kind === 'unshield' ? unshieldKey() : paths.data(0, 0);
  const digest = () => {
    const [namespace, tuple] = projectPublicRecord(key, encode(value), trees);
    const hash = createPublicRecordDigest(namespace);
    hash.add(key, tuple);
    return hash.finish().sha256;
  };
  const baseline = digest();
  const parts = field.split('.');
  const target = parts.slice(0, -1).reduce((object, part) => object[part], value);
  target[parts.at(-1)] = changed;
  expect(digest()).not.toBe(baseline);
});
test('whole inspection includes identity, tree and all three exact digests, frozen together', () => {
  const records = [
    [paths.data(0, 0), encode(shield())],
    [nullifierKey(), Buffer.from(bytes(55), 'hex')],
    [unshieldKey(), encode(unshield())],
  ];
  const result = inspect(records);
  expect(result.storeId).toBe('a'.repeat(64));
  expect(result.trees).toEqual(trees);
  for (const name of ['commitments', 'nullifiers', 'unshields']) {
    expect(result[name].count).toBe(1);
    expect(result[name].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(result[name])).toBe(true);
  }
  expect(Object.isFrozen(result.trees[0])).toBe(true);
  const extra = inspect([...records, [nullifierKey(2), Buffer.from(bytes(56), 'hex')]]);
  expect(extra.nullifiers.count).toBe(2);
  expect(extra.nullifiers.sha256).not.toBe(result.nullifiers.sha256);
  expect(inspect(records.slice(0, 1)).nullifiers.sha256).not.toBe(result.nullifiers.sha256);
});
test('empty state has domain-separated digests and no accepted legacy identity', () => {
  const result = inspectPublicRecords(store([]), { status: 'unscanned', trees: [] });
  expect(result).toEqual(emptyPublicState('a'.repeat(64)));
  expect(
    new Set(['commitments', 'nullifiers', 'unshields'].map((name) => result[name].sha256)).size
  ).toBe(3);
  expect(() =>
    inspectPublicRecords(
      { ...store([]), getInstanceId: () => null },
      { status: 'unscanned', trees: [] }
    )
  ).toThrow();
});
test.each([
  'unknown-field',
  'wrong-position',
  'future-tree',
  'unknown-key',
  'oversized-integer',
  'invalid-utf8',
  'missing-leaf',
])('refuses malformed or incomplete public state: %s', (mode) => {
  const value = shield();
  let key = paths.data(0, 0),
    bytes = encode(value);
  if (mode === 'unknown-field') {
    value.unreviewed = true;
    bytes = encode(value);
  }
  if (mode === 'wrong-position') {
    value.utxoIndex = 1;
    bytes = encode(value);
  }
  if (mode === 'future-tree') key = paths.data(1, 0);
  if (mode === 'unknown-key') key = Buffer.from(prefix + ':' + [0, 17, 0].map(segment).join(':'));
  if (mode === 'oversized-integer') {
    value.blockNumber = Number.MAX_SAFE_INTEGER + 1;
    bytes = encode(value);
  }
  if (mode === 'invalid-utf8') bytes = Buffer.from([0xff]);
  expect(() => inspect(mode === 'missing-leaf' ? [] : [[key, bytes]])).toThrow();
});
test('digest framing and ordering reject duplicate or reordered rows', () => {
  const digest = createPublicRecordDigest('nullifiers');
  digest.add(nullifierKey(2), [0, bytes(2), bytes(55)]);
  expect(() => digest.add(nullifierKey(1), [0, bytes(1), bytes(55)])).toThrow();
  expect(() => digest.add(nullifierKey(2), [0, bytes(2), bytes(55)])).toThrow();
  digest.finish();
  expect(() => digest.finish()).toThrow();
});
test('missing shield fee remains distinct from a stored zero fee', () => {
  const value = shield();
  delete value.fee;
  const absent = projectPublicRecord(paths.data(0, 0), encode(value), trees);
  value.fee = '0';
  expect(projectPublicRecord(paths.data(0, 0), encode(value), trees)).not.toEqual(absent);
});
test('allows only pinned zero padding at the one outside-tree node and no extra leaf', () => {
  for (let level = 1; level <= 16; level++) {
    const key = paths.node(0, level, 65536 >> level);
    expect(projectPublicRecord(key, Buffer.from(ZERO_NODES[level], 'hex'), trees)).toBeNull();
    expect(() => projectPublicRecord(key, Buffer.from(bytes(1), 'hex'), trees)).toThrow();
    expect(() =>
      projectPublicRecord(
        paths.node(0, level, (65536 >> level) + 1),
        Buffer.from(ZERO_NODES[level], 'hex'),
        trees
      )
    ).toThrow();
  }
  expect(() =>
    projectPublicRecord(paths.node(0, 0, 1), Buffer.from(ZERO_NODES[0], 'hex'), trees)
  ).toThrow();
});
test('the same public set has the same digest regardless of insertion order', () => {
  const records = [
    [paths.data(0, 0), encode(shield())],
    [nullifierKey(), Buffer.from(bytes(55), 'hex')],
    [unshieldKey(), encode(unshield())],
  ];
  expect(inspect(records)).toEqual(inspect(records.slice().reverse()));
});
