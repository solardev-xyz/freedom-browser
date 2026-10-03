const { createHash } = require('crypto');
const { createRailgunTxidProjection } = require('./railgun-txid-projection');
const {
  findRailgunNoteTxidWitness,
  normalizeRailgunTxidWitness,
  normalizeRailgunNoteTxidWitness,
} = require('./railgun-txid-note-witness');
// Deterministic hash for relationship tests; production projection uses Poseidon.
const hash = (text) => '0' + createHash('sha256').update(text).digest('hex').slice(1);
const pair = (a, b) => hash(a + b);
const zeros = [hash('zero')];
for (let i = 0; i < 16; i++) zeros.push(pair(zeros[i], zeros[i]));
const verification = (previous, nullifier) => '0x' + hash((previous ?? '') + nullifier);
const unshield = {
  tokenData: {
    tokenType: 0,
    tokenAddress: '0x' + '1'.repeat(40),
    tokenSubID: '0x' + '0'.repeat(64),
  },
  toAddress: '0x' + '2'.repeat(40),
  value: '1',
};
async function fixture(change = () => {}) {
  const projection = createRailgunTxidProjection({
    hashPair: pair,
    transactionHash: (row) => ({
      hash: hash(JSON.stringify(row)),
      railgunTxid: hash(row.nullifiers[0]),
    }),
    verificationHash: verification,
    zeroNodes: zeros,
  });
  let previous;
  const rows = Array.from({ length: 3 }, (_, i) => {
    const nullifier = '0x' + hash('nullifier' + i);
    previous = verification(previous, nullifier);
    return {
      version: 'V2',
      graphID: '0x' + (i + 1).toString(16).padStart(64, '0') + '0'.repeat(128),
      commitments: ['0x' + hash('output' + i), '0x' + hash('change' + i)],
      nullifiers: [nullifier],
      boundParamsHash: '0x' + hash('params'),
      blockNumber: i + 1,
      txid: hash('ethereum' + i),
      timestamp: i,
      utxoTreeIn: 0,
      utxoTreeOut: 7,
      utxoBatchStartPositionOut: 100 + i * 2,
      verificationHash: previous,
    };
  });
  change(rows);
  const values = new Map();
  const read = async (key) => values.get(key) ?? null;
  const result = await projection.append(projection.empty(), rows, read);
  result.writes.forEach(({ key, value }) => values.set(key, value));
  const row = rows[1];
  const note = {
    type: 'Transact',
    txid: '0x' + row.txid,
    hash: row.commitments[1],
    tree: row.utxoTreeOut,
    position: row.utxoBatchStartPositionOut + 1,
    blockNumber: row.blockNumber,
  };
  return { projection, read, state: result.state, values, rows, note };
}
test('binds an output position and hash to its creating transaction and immutable witness', async () => {
  const f = await fixture();
  const found = await findRailgunNoteTxidWitness(f);
  expect(found.outputIndex).toBe(1);
  expect(found.witness.index).toBe(1);
  expect(found.witness.row).toEqual(f.rows[1]);
  expect(found.witness.elements).toHaveLength(16);
  expect(found.witness.root).toBe(f.state.root);
  expect(found.witness.globalTxidCompleteness).toBe(false);
  expect(found).toMatchObject({
    ownershipVerified: false,
    eventCoverageVerified: false,
    rootAccepted: false,
    spendingEnabled: false,
  });
  expect(Object.isFrozen(found.note)).toBe(true);
  expect(Object.isFrozen(found.witness.row)).toBe(true);
});
test.each([
  ['type', 'Shield'],
  ['txid', '0x' + hash('other transaction')],
  ['hash', '0x' + hash('other commitment')],
  ['blockNumber', 20],
  ['tree', 8],
  ['position', 102],
  ['position', -1],
  ['position', 65536],
  ['tree', 99999],
  ['extra', true],
  ['hash', '0x' + 'f'.repeat(64)],
])('refuses a wrong or malformed %s selector', async (key, value) => {
  const f = await fixture();
  f.note[key] = value;
  await expect(findRailgunNoteTxidWitness(f)).rejects.toThrow();
});
test('does not mistake the last unshield commitment for a private output', async () => {
  const f = await fixture((rows) => {
    rows[1].unshield = unshield;
  });
  await expect(findRailgunNoteTxidWitness(f)).rejects.toThrow();
  f.note.position--;
  f.note.hash = f.rows[1].commitments[0];
  expect((await findRailgunNoteTxidWitness(f)).outputIndex).toBe(0);
});
test('refuses an ambiguous relation even when each row has a valid independent Merkle path', async () => {
  const f = await fixture((rows) => {
    rows[2] = {
      ...rows[2],
      blockNumber: rows[1].blockNumber,
      graphID: rows[1].graphID.slice(0, -1) + '1',
      txid: rows[1].txid,
      commitments: [...rows[1].commitments],
      utxoBatchStartPositionOut: rows[1].utxoBatchStartPositionOut,
    };
  });
  await expect(findRailgunNoteTxidWitness(f)).rejects.toThrow();
});
test.each(['unrelated-row', 'lookup', 'sibling', 'root'])(
  'refuses a corrupt %s instead of returning a partially trusted match',
  async (kind) => {
    const f = await fixture();
    if (kind === 'unrelated-row') f.values.set('txid:row:2', '{}');
    if (kind === 'lookup') {
      const record = JSON.parse(f.values.get('txid:row:1'));
      f.values.set('txid:lookup:' + record.railgunTxid, '0');
    }
    if (kind === 'sibling') f.values.set('txid:node:0:0', hash('corrupt'));
    if (kind === 'root') f.state = { ...f.state, root: hash('corrupt') };
    await expect(findRailgunNoteTxidWitness(f)).rejects.toThrow();
  }
);
test('copies selector and checkpoint before asynchronous reads', async () => {
  const f = await fixture();
  f.state = JSON.parse(JSON.stringify(f.state));
  const original = structuredClone(f.note);
  const read = f.read;
  f.read = async (key) => {
    f.note.txid = '0x' + hash('mutated');
    f.state.root = hash('mutated');
    return read(key);
  };
  const result = await findRailgunNoteTxidWitness(f);
  expect(result.note).toEqual(original);
  expect(result.witness.root).not.toBe(f.state.root);
});
test('empty and over-capacity mirrors refuse before reading', async () => {
  const f = await fixture();
  f.read = jest.fn();
  f.state = f.projection.empty();
  await expect(findRailgunNoteTxidWitness(f)).rejects.toThrow();
  f.state = { ...f.state, count: 8001 };
  await expect(findRailgunNoteTxidWitness(f)).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled();
});
test('main normalizes a separate deeply frozen value without granting acceptance', async () => {
  const f = await fixture();
  const found = await findRailgunNoteTxidWitness(f);
  const copied = structuredClone(found);
  const result = normalizeRailgunNoteTxidWitness(copied, f.state, f.note);
  expect(result).toEqual(found);
  expect(result.witness).not.toBe(copied.witness);
  copied.witness.elements[0] = hash('changed');
  expect(result.witness.elements[0]).toBe(found.witness.elements[0]);
  expect(Object.isFrozen(result.witness.elements)).toBe(true);
  expect(normalizeRailgunTxidWitness(found.witness, f.state, found.witness.railgunTxid)).toEqual(
    found.witness
  );
  expect(() => normalizeRailgunTxidWitness(found.witness, f.state, hash('other'))).toThrow();
});
test.each([
  (v) => {
    v.extra = true;
  },
  (v) => {
    v.spendingEnabled = true;
  },
  (v) => {
    v.ownershipVerified = true;
  },
  (v) => {
    v.note.position++;
  },
  (v) => {
    v.outputIndex = 0;
  },
  (v) => {
    v.witness.extra = true;
  },
  (v) => {
    v.witness.root = hash('different');
  },
  (v) => {
    v.witness.index = 3;
  },
  (v) => {
    v.witness.checkpointIndex++;
  },
  (v) => {
    v.witness.transcript = hash('different');
  },
  (v) => {
    v.witness.elements.pop();
  },
  (v) => {
    v.witness.elements[0] = 'f'.repeat(64);
  },
  (v) => {
    v.witness.railgunTxid = 'f'.repeat(64);
  },
  (v) => {
    v.witness.row.txid = hash('different');
  },
  (v) => {
    v.witness.rowSha256 = hash('different');
  },
  (v) => {
    v.witness.globalTxidCompleteness = true;
  },
  (v) => {
    v.witness.continuity.status = 'complete';
  },
])('main refuses a malformed or inconsistent guarded result %#', async (change) => {
  const f = await fixture();
  const found = structuredClone(await findRailgunNoteTxidWitness(f));
  change(found);
  expect(() => normalizeRailgunNoteTxidWitness(found, f.state, f.note)).toThrow();
});
