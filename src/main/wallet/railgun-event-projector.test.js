const { createHash } = require('crypto');
const { createRailgunEventProjector } = require('./railgun-event-projector');
const { ZERO_NODES, emptyPublicState } = require('./railgun-public-records');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
const cipher = {
  ciphertext: {
    iv: '00'.repeat(16),
    tag: '00'.repeat(16),
    data: ['00'.repeat(32), '00'.repeat(32), '00'.repeat(32)],
  },
  blindedSenderViewingKey: '00'.repeat(32),
  blindedReceiverViewingKey: '00'.repeat(32),
  annotationData: '0x',
  memo: '0x',
};
// Deterministic non-cryptographic test substitute. Real Poseidon and official
// formatting are exercised against all 14,822 captured logs by qualification.
function poseidonHex(values) {
  const index = ZERO_NODES.indexOf(values[0]);
  if (index >= 0 && values[0] === values[1]) return ZERO_NODES[index + 1];
  return hex(BigInt('0x' + createHash('sha256').update(values.join(':')).digest('hex')) % FIELD);
}
function fixture(qualifiedThrough = 0) {
  const V2Events = {
    formatTransactEvent: jest.fn((args, txid, blockNumber) => ({
      commitments: args.hash.map((hash, i) => ({
        commitmentType: 'TransactCommitmentV2',
        hash: hex(hash),
        txid,
        blockNumber,
        utxoTree: Number(args.treeNumber),
        utxoIndex: Number(args.startPosition) + i,
        ciphertext: cipher,
      })),
    })),
  };
  return {
    V2Events,
    projector: createRailgunEventProjector({
      abi: { parseLog: (log) => log.event },
      V2Events,
      qualifiedThrough,
      poseidonHex,
      zero: ZERO_NODES[0],
    }),
  };
}
function event({ block = 1, index = 0, tree = 0, start = 0, hashes = [1n] } = {}) {
  return {
    blockNumber: block,
    logIndex: index,
    transactionHash: '0x' + hex(99),
    event: {
      name: 'Transact',
      args: {
        treeNumber: BigInt(tree),
        startPosition: BigInt(start),
        hash: hashes,
        ciphertext: hashes.map(() => ({
          ciphertext: [0n, 0n, 0n, 0n],
          blindedSenderViewingKey: 0n,
          blindedReceiverViewingKey: 0n,
          annotationData: '0x',
          memo: '0x',
        })),
      },
    },
  };
}
test('empty and governance-only history has exactly the empty public state', () => {
  const { projector } = fixture();
  projector.add({ blockNumber: 0, logIndex: 0, event: { name: 'ProxyUpgrade', args: {} } });
  expect(projector.finish('a'.repeat(64))).toEqual(emptyPublicState('a'.repeat(64)));
  expect(() => projector.add(event())).toThrow();
  expect(() => projector.finish('a'.repeat(64))).toThrow();
});
test.each([
  'out-of-order',
  'same-position',
  'gap',
  'tree-gap',
  'premature-rollover',
  'wrong-format-hash',
  'wrong-format-position',
])('refuses %s source history', (mode) => {
  const { projector, V2Events } = fixture();
  projector.add(event());
  let next = event({ block: 2, start: 1, hashes: [2n] });
  if (mode === 'out-of-order') next = event({ block: 0, start: 1 });
  if (mode === 'same-position') next = event({ start: 1 });
  if (mode === 'gap') next = event({ block: 2, start: 2 });
  if (mode === 'tree-gap') next = event({ block: 2, tree: 2 });
  if (mode === 'premature-rollover') next = event({ block: 2, tree: 1 });
  if (mode.startsWith('wrong-format')) {
    const original = V2Events.formatTransactEvent.getMockImplementation();
    V2Events.formatTransactEvent.mockImplementation((...args) => {
      const value = original(...args);
      value.commitments[0][mode === 'wrong-format-hash' ? 'hash' : 'utxoIndex'] =
        mode === 'wrong-format-hash' ? hex(77) : 9;
      return value;
    });
  }
  expect(() => projector.add(next)).toThrow();
});
test('record projections preserve cumulative source state across event boundaries', () => {
  const first = fixture(),
    second = fixture();
  first.projector.add(event({ hashes: [1n, 2n] }));
  second.projector.add(event());
  second.projector.add(event({ index: 1, start: 1, hashes: [2n] }));
  const a = first.projector.finish('a'.repeat(64)),
    b = second.projector.finish('a'.repeat(64));
  expect(a).toEqual(b);
  expect(a.trees[0].length).toBe(2);
  expect(a.commitments.count).toBe(2);
});

test('unknown and post-baseline governance events poison the projection', () => {
  for (const name of ['Unknown', 'VerifyingKeySet', 'ProxyUpgrade', 'ProxyPause']) {
    const { projector } = fixture();
    expect(() =>
      projector.add({ blockNumber: 1, logIndex: 0, event: { name, args: {} } })
    ).toThrow();
    expect(() => projector.finish('a'.repeat(64))).toThrow();
  }
});
test('ciphertext corruption cannot pass with a correct commitment hash', () => {
  const { projector, V2Events } = fixture();
  const original = V2Events.formatTransactEvent.getMockImplementation();
  V2Events.formatTransactEvent.mockImplementation((...args) => {
    const value = original(...args);
    value.commitments[0].ciphertext = { ...cipher, memo: '0xab' };
    return value;
  });
  expect(() => projector.add(event())).toThrow();
});
test('empty shields preserve the current cursor without creating an empty tree', () => {
  for (const initialized of [false, true]) {
    const { projector, V2Events } = fixture();
    if (initialized) projector.add(event());
    V2Events.formatShieldEvent = () => ({ commitments: [] });
    const log = {
      ...event({ block: 2 }),
      event: {
        name: 'Shield',
        args: {
          treeNumber: 0n,
          startPosition: initialized ? 1n : 0n,
          commitments: [],
          shieldCiphertext: [],
          fees: [],
        },
      },
    };
    expect(projector.add(log).leaves).toEqual([]);
    const state = projector.finish('a'.repeat(64));
    expect(state.trees.length).toBe(initialized ? 1 : 0);
    expect(state.commitments.count).toBe(initialized ? 1 : 0);
  }
});
