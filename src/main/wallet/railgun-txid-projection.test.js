const { createHash } = require('crypto');
const { createRailgunTxidProjection } = require('./railgun-txid-projection');
// Deterministic test hash only. The actual-engine qualification uses Poseidon.
const hash = (s) => '0' + createHash('sha256').update(s).digest('hex').slice(1);
const pair = (a, b) => hash(a + b);
const zeros = [hash('zero')];
for (let n = 0; n < 16; n++) zeros.push(pair(zeros[n], zeros[n]));
const verification = (previous, nullifier) => '0x' + hash((previous ?? '') + nullifier);
const transaction = (row) => ({
  hash: hash(JSON.stringify(row)),
  railgunTxid: hash(row.nullifiers[0]),
});
const create = () =>
  createRailgunTxidProjection({
    hashPair: pair,
    transactionHash: transaction,
    verificationHash: verification,
    zeroNodes: zeros,
  });
function rows(count) {
  let previous;
  return Array.from({ length: count }, (_, i) => {
    const nullifier = '0x' + hash('nullifier' + i);
    previous = verification(previous, nullifier);
    return {
      version: 'V2',
      graphID: '0x' + (i + 1).toString(16).padStart(64, '0') + '0'.repeat(128),
      commitments: ['0x' + hash('commitment' + i)],
      nullifiers: [nullifier],
      boundParamsHash: '0x' + hash('params'),
      blockNumber: i + 1,
      txid: hash('tx' + i),
      timestamp: i,
      utxoTreeIn: 0,
      utxoTreeOut: 0,
      utxoBatchStartPositionOut: i,
      verificationHash: previous,
    };
  });
}
function store() {
  const values = new Map();
  return {
    values,
    read: async (key) => values.get(key) ?? null,
    apply: (result) => result.writes.forEach(({ key, value }) => values.set(key, value)),
  };
}
test('page boundaries and cold restoration preserve the tree and independently checked paths', async () => {
  const input = rows(105),
    db = store();
  let state = create().empty();
  for (const page of [input.slice(0, 100), input.slice(100)]) {
    const result = await create().append(state, page, db.read);
    expect(db.values.get('txid:state')).toBe(state.count ? JSON.stringify(state) : undefined);
    db.apply(result);
    state = JSON.parse(db.values.get('txid:state'));
  }
  let level = input.map((item) => transaction(item).hash);
  for (let depth = 0; depth < 16; depth++) {
    if (level.length % 2) level.push(zeros[depth]);
    const next = [];
    for (let n = 0; n < level.length; n += 2) next.push(pair(level[n], level[n + 1]));
    level = next;
  }
  expect(state.root).toBe(level[0]);
  for (const index of [0, 1, 63, 99, 100, 104]) {
    const proof = await create().witness(state, transaction(input[index]).railgunTxid, db.read);
    expect(proof.index).toBe(index);
    expect(proof.checkpointIndex).toBe(104);
    expect(proof.row).toEqual(input[index]);
    expect(proof.elements).toHaveLength(16);
    expect(proof.globalTxidCompleteness).toBe(false);
    expect(Object.isFrozen(proof.elements)).toBe(true);
  }
});
test('a pending page can be replayed against its unchanged base without writes during projection', async () => {
  const projection = create(),
    db = store(),
    initial = projection.empty(),
    input = rows(5);
  const first = await projection.append(initial, input, db.read);
  const replay = await projection.append(initial, input, db.read);
  expect(replay).toEqual(first);
  expect(db.values.size).toBe(0);
  expect(initial.count).toBe(0);
  expect(first.state.count).toBe(5);
});
test('record inspection recomputes the row digest and transaction hashes before coverage can use it', async () => {
  const p = create(),
    db = store(),
    input = rows(1);
  db.apply(await p.append(p.empty(), input, db.read));
  const text = await db.read('txid:row:0'),
    record = JSON.parse(text);
  expect(p.inspectRecord(text)).toEqual(record);
  expect(Object.isFrozen(p.inspectRecord(text).row)).toBe(true);
  for (const field of ['leaf', 'railgunTxid', 'rowSha256']) {
    expect(() => p.inspectRecord(JSON.stringify({ ...record, [field]: '0'.repeat(64) }))).toThrow();
  }
  record.row.timestamp++;
  expect(() => p.inspectRecord(JSON.stringify(record))).toThrow();
});
test('unknown verification breaks, malformed records, duplicate rows and duplicate txids refuse', async () => {
  const p = create(),
    db = store(),
    input = rows(3);
  for (const value of [
    [{ ...input[0], verificationHash: '0x' + hash('different') }],
    [{ ...input[0], blockNumber: 2 }],
    [{ ...input[0], approval: true }],
    [{ ...input[0], utxoTreeOut: 99999 }],
    [{ ...input[0], nullifiers: ['0x' + 'f'.repeat(64)] }],
    [input[0], input[0]],
    [],
    Array(101).fill(input[0]),
  ])
    await expect(p.append(p.empty(), value, db.read)).rejects.toThrow();
  db.values.set('txid:lookup:' + transaction(input[0]).railgunTxid, '0');
  await expect(p.append(p.empty(), input, db.read)).rejects.toThrow();
});
test.each(['lookup', 'row', 'node', 'root'])(
  'a corrupted %s cannot produce a witness',
  async (kind) => {
    const p = create(),
      db = store(),
      input = rows(3);
    const result = await p.append(p.empty(), input, db.read);
    db.apply(result);
    const state = JSON.parse(JSON.stringify(result.state));
    const txid = transaction(input[0]).railgunTxid;
    if (kind === 'lookup') db.values.set('txid:lookup:' + txid, '2');
    if (kind === 'row') {
      const record = JSON.parse(db.values.get('txid:row:0'));
      record.row.commitments[0] = '0x' + hash('changed');
      db.values.set('txid:row:0', JSON.stringify(record));
    }
    if (kind === 'node') db.values.set('txid:node:0:1', hash('changed'));
    if (kind === 'root') state.root = hash('changed');
    await expect(p.witness(state, txid, db.read)).rejects.toThrow();
  }
);
test('a missing TXID or out-of-tree checkpoint refuses', async () => {
  const p = create(),
    db = store();
  await expect(p.witness(p.empty(), hash('absent'), db.read)).rejects.toThrow();
  await expect(p.append({ ...p.empty(), count: 65537 }, rows(1), db.read)).rejects.toThrow();
  expect(() =>
    createRailgunTxidProjection({
      hashPair: pair,
      transactionHash: transaction,
      verificationHash: verification,
      zeroNodes: Array(17).fill(zeros[0]),
    })
  ).toThrow();
});
