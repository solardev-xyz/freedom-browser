const {
  paths,
  decodeMetadata,
  readRailgunFrontier,
  readRailgunPosition,
} = require('./railgun-frontier');
const vectors = require('../../../docs/qualification/railgun-frontier-vectors-2026-10-02.json');
let records;
const value = (n) => Buffer.from(BigInt(n).toString(16).padStart(64, '0'), 'hex');
const read = (key) => records.get(key.toString()) ?? null;
beforeEach(() => {
  records = new Map([
    [vectors.keys.metadata, Buffer.from(vectors.metadata[0].hex, 'hex')],
    [vectors.keys.history, Buffer.from('13')],
    [vectors.keys.synced, Buffer.from('9000000')],
    [vectors.keys.root0, value(123)],
    [vectors.keys.leaf31, value(32)],
    [
      vectors.keys.data31,
      Buffer.from(JSON.stringify({ hash: value(32).toString('hex'), blockNumber: 1 })),
    ],
  ]);
});
test('main path construction matches exact engine-generated Sepolia paths', () => {
  expect(paths.metadata().toString()).toBe(vectors.keys.metadata);
  expect(paths.history().toString()).toBe(vectors.keys.history);
  expect(paths.synced().toString()).toBe(vectors.keys.synced);
  expect(paths.node(0, 16, 0).toString()).toBe(vectors.keys.root0);
  expect(paths.node(0, 0, 31).toString()).toBe(vectors.keys.leaf31);
  expect(paths.data(0, 31).toString()).toBe(vectors.keys.data31);
});
test.each(vectors.metadata)('decodes an upstream MessagePack golden vector', (v) => {
  expect(decodeMetadata(Buffer.from(v.hex, 'hex'))).toEqual(v.value);
});
test('a structurally valid frontier remains unverified and bounds candidate positions', () => {
  const frontier = readRailgunFrontier(read);
  expect(frontier.status).toBe('persisted-unverified');
  expect(frontier.lastSyncedBlock).toBe(9000000);
  expect(frontier.trees).toEqual([
    { tree: 0, length: 32, root: '0x' + value(123).toString('hex'), invalidRoot: false },
  ]);
  expect(readRailgunPosition(read, frontier, 0, 31).status).toBe('persisted-unverified');
  for (const [tree, index] of [
    [0, 32],
    [1, 0],
    [0, -1],
    [0, 1.5],
  ])
    expect(() => readRailgunPosition(read, frontier, tree, index)).toThrow();
  expect(frontier).not.toHaveProperty('balance');
  expect(frontier).not.toHaveProperty('complete');
  expect(Object.isFrozen(frontier.trees[0])).toBe(true);
});
test('a missing store is unscanned, never a zero balance', () => {
  records.clear();
  const frontier = readRailgunFrontier(read);
  expect(frontier.status).toBe('unscanned');
  expect(frontier.trees).toEqual([]);
  expect(() => readRailgunPosition(read, frontier, 0, 0)).toThrow();
});
test.each(['history', 'synced', 'metadata', 'root0'])('missing %s stays incomplete', (name) => {
  records.delete(vectors.keys[name]);
  expect(readRailgunFrontier(read).status).toBe('incomplete');
});
test.each(['12', '14'])('unsupported history version %s stays incomplete', (v) => {
  records.set(vectors.keys.history, Buffer.from(v));
  expect(readRailgunFrontier(read).status).toBe('incomplete');
});
test('invalid-root details and empty/reset metadata stay incomplete', () => {
  for (const i of [2, 3]) {
    records.set(vectors.keys.metadata, Buffer.from(vectors.metadata[i].hex, 'hex'));
    expect(readRailgunFrontier(read).status).toBe('incomplete');
  }
});
test('earlier trees need not be full when a batch rotated into a new tree', () => {
  records.set(vectors.keys.metadata, Buffer.from(vectors.metadata[1].hex, 'hex'));
  records.set(paths.node(1, 16, 0).toString(), value(124));
  for (const [tree, index] of [
    [0, 49999],
    [1, 2],
  ]) {
    records.set(paths.node(tree, 0, index).toString(), value(32));
    records.set(paths.data(tree, index).toString(), Buffer.from('{}'));
  }
  expect(readRailgunFrontier(read).status).toBe('persisted-unverified');
  expect(readRailgunFrontier(read).trees.map((t) => t.length)).toEqual([50000, 3]);
});
test.each(['leaf', 'data'])('a %s beyond the published frontier is incomplete', (kind) => {
  const key = kind === 'leaf' ? paths.node(0, 0, 32) : paths.data(0, 32);
  records.set(key.toString(), value(33));
  const frontier = readRailgunFrontier(read);
  expect(frontier.status).toBe('incomplete');
  expect(frontier.reasons).toContain('records-beyond-length');
  expect(() => readRailgunPosition(read, frontier, 0, 31)).toThrow(
    expect.objectContaining({ code: 'RAILGUN_FRONTIER_NOT_ELIGIBLE' })
  );
});
test.each(['leaf31', 'data31'])('missing boundary %s is incomplete', (name) => {
  records.delete(vectors.keys[name]);
  expect(readRailgunFrontier(read).reasons).toContain('frontier-leaf-missing');
});
test.each([paths.node(1, 0, 0), paths.data(1, 0)])(
  'an unpublished next tree is incomplete',
  (key) => {
    records.set(key.toString(), value(1));
    const frontier = readRailgunFrontier(read);
    expect(frontier.status).toBe('incomplete');
    expect(frontier.reasons).toContain('records-beyond-last-tree');
  }
);
test.each([paths.node(0, 16, 0), paths.data(0, 0)])(
  'orphan records do not look unscanned',
  (key) => {
    records.clear();
    records.set(key.toString(), value(1));
    const frontier = readRailgunFrontier(read);
    expect(frontier.status).toBe('incomplete');
    expect(frontier.reasons).toContain('tree-records-without-metadata');
  }
);
test.each(['12x', '-1', '01', '1.0', ' 12', '9007199254740992', ''])(
  'cursor %j is refused rather than parseInt-truncated',
  (s) => {
    records.set(vectors.keys.synced, Buffer.from(s));
    expect(() => readRailgunFrontier(read)).toThrow();
  }
);
test.each([
  '90',
  'c2',
  'ca42000000',
  'cb4040000000000000',
  'c40100',
  'd40000',
  'ff',
  'de0101',
  'cf0020000000000000',
  '82a5747265657380a5747265657380',
  '81a95f5f70726f746f5f5f80',
])('unsupported or unsafe MessagePack %s is refused', (s) => {
  expect(() => decodeMetadata(Buffer.from(s, 'hex'))).toThrow();
});
test('every truncated prefix, trailing byte and oversized metadata is refused', () => {
  const bytes = Buffer.from(vectors.metadata[2].hex, 'hex');
  for (let i = 0; i < bytes.length; i++)
    expect(() => decodeMetadata(bytes.subarray(0, i))).toThrow();
  expect(() => decodeMetadata(Buffer.concat([bytes, Buffer.from([0])]))).toThrow();
  expect(() => decodeMetadata(Buffer.alloc(65537))).toThrow();
});
test('root byte width and scalar-field range are checked', () => {
  for (const bytes of [Buffer.alloc(31), Buffer.alloc(33), Buffer.alloc(32, 255)]) {
    records.set(vectors.keys.root0, bytes);
    expect(() => readRailgunFrontier(read)).toThrow();
  }
});
test.each(['missing-data', 'mismatched-data', 'missing-leaf'])(
  '%s refuses a candidate even within metadata bounds',
  (mode) => {
    const frontier = readRailgunFrontier(read);
    if (mode === 'missing-data') records.delete(vectors.keys.data31);
    else if (mode === 'missing-leaf') records.delete(vectors.keys.leaf31);
    else
      records.set(
        vectors.keys.data31,
        Buffer.from(JSON.stringify({ hash: value(33).toString('hex') }))
      );
    expect(() => readRailgunPosition(read, frontier, 0, 31)).toThrow();
  }
);
