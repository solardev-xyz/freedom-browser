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

test('detached verification recomputes a cold witness without reading a store', async () => {
  const p = create(),
    db = store(),
    input = rows(3);
  const result = await p.append(p.empty(), input, db.read);
  db.apply(result);
  for (const index of [0, 1, 2]) {
    const proof = await p.witness(result.state, transaction(input[index]).railgunTxid, db.read);
    const detached = structuredClone(proof);
    expect(create().verifyWitness(structuredClone(result.state), detached)).toEqual(proof);
    const verified = create().verifyWitness(result.state, detached);
    detached.elements[0] = hash('changed');
    expect(verified.elements).toEqual(proof.elements);
    expect(Object.isFrozen(verified.elements)).toBe(true);
  }
});
test.each(Array.from({ length: 16 }, (_, n) => n))(
  'detached verification refuses a changed sibling at level %i',
  async (level) => {
    const p = create(),
      db = store(),
      input = rows(3);
    const result = await p.append(p.empty(), input, db.read);
    db.apply(result);
    const proof = structuredClone(
      await p.witness(result.state, transaction(input[1]).railgunTxid, db.read)
    );
    proof.elements[level] = hash('corrupt');
    expect(() => p.verifyWitness(result.state, proof)).toThrow();
  }
);
test.each([
  'index',
  'leaf',
  'railgunTxid',
  'row',
  'root',
  'checkpoint',
  'transcript',
  'continuity',
  'extra',
  'empty-sibling',
])('detached verification refuses altered %s evidence', async (kind) => {
  const p = create(),
    db = store(),
    input = rows(3);
  const result = await p.append(p.empty(), input, db.read);
  db.apply(result);
  const state = structuredClone(result.state);
  const proof = structuredClone(await p.witness(state, transaction(input[1]).railgunTxid, db.read));
  if (kind === 'index') proof.index = 0;
  if (kind === 'leaf' || kind === 'railgunTxid') proof[kind] = hash('corrupt');
  if (kind === 'row') {
    proof.row.boundParamsHash = '0x' + hash('corrupt');
    proof.rowSha256 = createHash('sha256').update(JSON.stringify(proof.row)).digest('hex');
  }
  if (kind === 'root') proof.root = state.root = hash('corrupt');
  if (kind === 'checkpoint') proof.checkpointIndex--;
  if (kind === 'transcript') proof.transcript = hash('corrupt');
  if (kind === 'continuity') proof.continuity.status = 'complete';
  if (kind === 'extra') proof.verified = true;
  if (kind === 'empty-sibling') {
    // Even a path/root recomputed around a fabricated outside-tree sibling
    // must refuse: positions beyond the checkpoint are canonical zeros.
    proof.elements[15] = hash('corrupt');
    let node = proof.leaf,
      cursor = proof.index;
    for (const sibling of proof.elements) {
      node = cursor & 1 ? pair(sibling, node) : pair(node, sibling);
      cursor >>= 1;
    }
    proof.root = state.root = node;
  }
  expect(() => p.verifyWitness(state, proof)).toThrow();
});

// Dense prefix oracle: build whole levels from leaves, independent of the
// historical boundary-path algorithm and the append frontier.
function prefixRoot(input, count) {
  let nodes = input.slice(0, count).map((item) => transaction(item).hash);
  for (let level = 0; level < 16; level++) {
    if (nodes.length % 2) nodes.push(zeros[level]);
    const parents = [];
    for (let i = 0; i < nodes.length; i += 2) parents.push(pair(nodes[i], nodes[i + 1]));
    nodes = parents;
  }
  return nodes[0];
}
async function historicalFixture(count, factory = create) {
  const input = rows(count),
    db = store();
  let state = factory().empty();
  for (let i = 0; i < input.length; i += 100) {
    const result = await factory().append(state, input.slice(i, i + 100), db.read);
    db.apply(result);
    state = result.state;
  }
  return { input, db, state };
}
test('every historical prefix matches an independent dense oracle after later rows overwrite ancestors', async () => {
  const { input, db, state } = await historicalFixture(257);
  const before = [...db.values];
  for (let index = 0; index < input.length; index++) {
    const reads = [];
    const result = await create().historicalRoot(state, index, async (key) => {
      reads.push(key);
      return db.read(key);
    });
    expect(result).toEqual({
      version: 1,
      tree: 0,
      index,
      root: prefixRoot(input, index + 1),
      checkpointIndex: 256,
      checkpointRoot: state.root,
      transcript: state.transcript,
      localPrefixComputed: true,
      globalTxidCompleteness: false,
      ownershipVerified: false,
      eventCoverageVerified: false,
      rootAccepted: false,
      spendingEnabled: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(reads.length).toBeLessThanOrEqual(19);
    expect(reads.filter((key) => key.startsWith('txid:row:'))).toEqual([
      `txid:row:${index}`,
      `txid:row:${index}`,
    ]);
  }
  expect([...db.values]).toEqual(before);
});
test('old prefix roots stay equal across coherent append checkpoints while current roots advance', async () => {
  const early = await historicalFixture(5),
    later = await historicalFixture(105);
  expect(early.state.root).not.toBe(later.state.root);
  for (let index = 0; index < 5; index++) {
    const first = await create().historicalRoot(early.state, index, early.db.read);
    const second = await create().historicalRoot(later.state, index, later.db.read);
    expect(second.root).toBe(first.root);
    expect(second.checkpointRoot).not.toBe(first.checkpointRoot);
    expect(second.transcript).not.toBe(first.transcript);
  }
});
test('maximum historical capacity matches the oracle with synthetic continuity classification', async () => {
  // The production continuity policy requires the exact live omission at 4188.
  // This synthetic capacity/crypto test isolates only that classification;
  // all other tests above/below use the real policy, and no source is changed.
  let capacityCreate;
  jest.isolateModules(() => {
    jest.doMock('./railgun-txid-omissions', () => ({
      classifyRailgunTxidContinuity: () => ({
        status: 'synthetic-capacity-fixture',
        globalTxidCompleteness: false,
      }),
    }));
    const { createRailgunTxidProjection: factory } = require('./railgun-txid-projection');
    capacityCreate = () =>
      factory({
        hashPair: pair,
        transactionHash: transaction,
        verificationHash: verification,
        zeroNodes: zeros,
      });
  });
  jest.dontMock('./railgun-txid-omissions');
  const { input, db, state } = await historicalFixture(8000, capacityCreate);
  for (const index of [4095, 4096, 7998, 7999]) {
    const result = await capacityCreate().historicalRoot(state, index, db.read);
    expect(result.root).toBe(prefixRoot(input, index + 1));
    expect(result.checkpointIndex).toBe(7999);
    if (index === 7999) expect(result.root).toBe(state.root);
  }
  const read = jest.fn();
  await expect(capacityCreate().historicalRoot(state, 8000, read)).rejects.toThrow();
  await expect(
    capacityCreate().historicalRoot({ ...state, count: 8001 }, 7999, read)
  ).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
  // The ordinary production factory still refuses an uninterrupted synthetic
  // checkpoint beyond the pinned omission; the isolated mock did not escape.
  await expect(create().historicalRoot(state, 7999, read)).rejects.toThrow();
});
test('real continuity admits the pre-omission boundary and refuses an unqualified later checkpoint', async () => {
  const { input, db, state } = await historicalFixture(4188);
  expect((await create().historicalRoot(state, 4187, db.read)).root).toBe(prefixRoot(input, 4188));
  const read = jest.fn();
  await expect(
    create().historicalRoot({ ...state, count: 4189 }, 4187, read)
  ).rejects.toMatchObject({ code: 'RAILGUN_TXID_CONTINUITY_REFUSED' });
  expect(read).not.toHaveBeenCalled();
});
test.each([-1, 0.5, NaN, Infinity, '0', null, undefined, 3, 7999, 8000])(
  'invalid or beyond-checkpoint historical index %s refuses before reading',
  async (index) => {
    const { state } = await historicalFixture(3),
      read = jest.fn();
    await expect(create().historicalRoot(state, index, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  }
);
test.each(['empty', 'over-capacity', 'malformed', 'no-reader'])(
  'historical root refuses %s context before reading',
  async (kind) => {
    const { state } = await historicalFixture(3),
      changed = structuredClone(state),
      read = jest.fn();
    if (kind === 'over-capacity') changed.count = 8001;
    if (kind === 'malformed') changed.extra = true;
    await expect(
      create().historicalRoot(
        kind === 'empty' ? create().empty() : changed,
        0,
        kind === 'no-reader' ? null : read
      )
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  }
);
test.each([
  'missing-row',
  'changed-row',
  'changed-leaf',
  'missing-lookup',
  'wrong-lookup',
  'wrong-root',
  'valid-other-boundary',
])('historical root refuses %s even when deriving a prefix', async (kind) => {
  const { db, state } = await historicalFixture(5),
    changed = structuredClone(state),
    text = db.values.get('txid:row:1'),
    record = JSON.parse(text);
  if (kind === 'missing-row') db.values.set('txid:row:1', null);
  if (kind === 'changed-row') {
    record.row.timestamp++;
    db.values.set('txid:row:1', JSON.stringify(record));
  }
  if (kind === 'changed-leaf') {
    record.leaf = hash('changed');
    db.values.set('txid:row:1', JSON.stringify(record));
  }
  if (kind === 'missing-lookup') db.values.set('txid:lookup:' + record.railgunTxid, null);
  if (kind === 'wrong-lookup') db.values.set('txid:lookup:' + record.railgunTxid, '2');
  if (kind === 'wrong-root') changed.root = hash('changed');
  // A genuine record/path for index 3 still cannot answer a request for 1.
  if (kind === 'valid-other-boundary') db.values.set('txid:row:1', db.values.get('txid:row:3'));
  await expect(create().historicalRoot(changed, 1, db.read)).rejects.toThrow();
});
test.each([0, 1, 2, 3, 4, 5, 6, 7, 8])(
  'historical index zero still authenticates discarded current right sibling at level %i',
  async (level) => {
    const { db, state } = await historicalFixture(257);
    db.values.set(`txid:node:${level}:1`, hash('corrupt-right'));
    await expect(create().historicalRoot(state, 0, db.read)).rejects.toThrow();
  }
);
test('historical root authenticates a completed left subtree and ignores mutable caller state', async () => {
  const { input, db, state } = await historicalFixture(5),
    mutable = structuredClone(state);
  let first = true;
  const result = await create().historicalRoot(mutable, 3, async (key) => {
    if (first) {
      first = false;
      mutable.root = hash('changed');
      mutable.count = 1;
      mutable.transcript = hash('changed');
    }
    return db.read(key);
  });
  expect(result.root).toBe(prefixRoot(input, 4));
  expect(result.checkpointRoot).toBe(state.root);
  db.values.set('txid:node:1:0', hash('corrupt-left'));
  await expect(create().historicalRoot(state, 3, db.read)).rejects.toThrow();
});
test('historical computation awaits borrowed reads and propagates their refusal without writes', async () => {
  const { db, state } = await historicalFixture(3),
    before = [...db.values];
  let rejectRead,
    settled = false;
  const pending = create().historicalRoot(
    state,
    0,
    () =>
      new Promise((_resolve, reject) => {
        rejectRead = reject;
      })
  );
  const observed = pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  rejectRead(Error('read refused'));
  await expect(pending).rejects.toThrow('read refused');
  await observed;
  expect([...db.values]).toEqual(before);
});
