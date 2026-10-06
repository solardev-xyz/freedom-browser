const { Interface, AbiCoder, keccak256 } = require('ethers');
const { TRANSACT_ABI, BOUND_PARAMS } = require('./railgun-private-policy');
const {
  selectRailgunPrivatePreparation,
  normalizeRailgunPrivatePreparation,
  normalizeRailgunPrivateOffer,
  normalizeRailgunPrivateOperation,
} = require('./railgun-private-preparation');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let owned, request, selection, result, tx;
const abi = new Interface([TRANSACT_ABI]);
const encode = () => abi.encodeFunctionData('transact', [[tx]]);
beforeEach(() => {
  owned = {
    read: {
      instanceId: 'self',
      received: [
        {
          id: '0:1',
          tree: 0,
          position: 1,
          amount: 1000n,
          spentTxid: false,
          asset: { __type: 'erc20', contract: pins.wrappedNative },
        },
      ],
    },
    ownedPoi: [{ id: '0:1', nullifier: hex(2) }],
    trees: [{ tree: 0, root: hex(1), length: 2 }],
  };
  request = { kind: 'railgun-token-unshield', noteId: '0:1', recipient: '0x' + '12'.repeat(20) };
  selection = selectRailgunPrivatePreparation(owned, request);
  const bound = [0, 0, 1, pins.chainId, '0x' + '0'.repeat(40), hex(0), []];
  const expected = {
    kind: request.kind,
    tree: 0,
    merkleRoot: hex(1),
    nullifier: hex(2),
    commitment: hex(3),
    boundParamsHash: hex(
      BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bound]))) %
        21888242871839275222246405745257275088548364400416034343698204186575808495617n
    ),
    recipient: request.recipient,
    amount: '1000',
  };
  tx = [
    [
      [0, 0],
      [
        [0, 0],
        [0, 0],
      ],
      [0, 0],
    ],
    hex(1),
    [hex(2)],
    [hex(3)],
    bound,
    [hex(BigInt(request.recipient)), [0, pins.wrappedNative, 0], 1000],
  ];
  result = {
    transaction: { chainId: pins.chainId, to: pins.proxy, value: '0', data: encode() },
    expected,
    expectedHash: hex(4),
    recipient: request.recipient,
    amount: '1000',
  };
});
const normalize = () => normalizeRailgunPrivatePreparation(result, { selection, ...owned });
test('copies bounded intent data and explicitly retains no witness or spending authority', () => {
  const value = normalize();
  result.expected.nullifier = hex(9);
  expect(value.expected.nullifier).toBe(hex(2));
  expect(Object.isFrozen(value.transaction)).toBe(true);
  expect(value).toMatchObject({
    witnessRetained: false,
    recipientVerified: false,
    reservationsChecked: false,
    poiVerified: false,
    spendingEnabled: false,
  });
});
test.each(['kind', 'noteId', 'recipient', 'extra'])(
  'invalid request %s refuses before opening a window',
  (key) => {
    request[key] = 'invalid';
    expect(() => selectRailgunPrivatePreparation(owned, request)).toThrow();
  }
);
test('a structural offer is immutable data and does not establish ownership', () => {
  tx[1] = result.expected.merkleRoot = hex(9);
  result.transaction.data = encode();
  const offer = normalizeRailgunPrivateOffer(result, selection);
  expect(Object.isFrozen(offer)).toBe(true);
  expect(Object.isFrozen(offer.expected)).toBe(true);
  expect(() => normalize()).toThrow();
  result.expected.merkleRoot = hex(8);
  expect(offer.expected.merkleRoot).toBe(hex(9));
});
test('refusal carries no transaction, signature or authority', () => {
  expect(normalizeRailgunPrivateOperation({ status: 'refused' }, normalize())).toEqual({
    status: 'refused',
  });
  expect(() =>
    normalizeRailgunPrivateOperation({ status: 'refused', signature: {} }, normalize())
  ).toThrow();
});
test('proof result accepts only proof-coordinate changes and never attests verification', () => {
  const preparation = normalize();
  tx[0][0][0] = 1;
  const transaction = { ...result.transaction, data: encode() };
  const digest = require('./railgun-private-intent').matchRailgunPrivateProvedTransaction(
    preparation.transaction,
    transaction,
    preparation.expected
  ).digest;
  const operation = {
    status: 'proved',
    transaction,
    transactionDigest: digest,
    independentlyVerified: false,
  };
  const normalized = normalizeRailgunPrivateOperation(operation, preparation);
  expect(Object.isFrozen(normalized.transaction)).toBe(true);
  for (const changed of [
    { independentlyVerified: true },
    { transactionDigest: '0'.repeat(64) },
    { status: 'signed' },
    { witness: {} },
  ])
    expect(() =>
      normalizeRailgunPrivateOperation({ ...operation, ...changed }, preparation)
    ).toThrow();
  tx[3][0] = hex(9);
  operation.transaction.data = encode();
  expect(() => normalizeRailgunPrivateOperation(operation, preparation)).toThrow();
  expect(normalized.transaction.data).not.toBe(operation.transaction.data);
});
test('only a self-transfer destination can be requested', () => {
  request.kind = 'railgun-private-transfer';
  expect(() => selectRailgunPrivatePreparation(owned, request)).toThrow();
  request.recipient = 'self';
  expect(selectRailgunPrivatePreparation(owned, request).recipient).toBe('self');
});
test.each(['spent', 'zero', 'cap', 'asset', 'missing-record'])('rejects %s input', (kind) => {
  const note = owned.read.received[0];
  if (kind === 'spent') note.spentTxid = hex(7);
  if (kind === 'zero') note.amount = 0n;
  if (kind === 'cap') note.amount = BigInt(pins.maxQualificationAmount) + 1n;
  if (kind === 'asset') note.asset.contract = '0x' + '12'.repeat(20);
  if (kind === 'missing-record') owned.ownedPoi = [];
  expect(() => selectRailgunPrivatePreparation(owned, request)).toThrow();
  expect(normalize).toThrow();
});
test.each(['root', 'nullifier', 'amount', 'recipient', 'proof', 'message', 'witness'])(
  'refuses changed %s',
  (kind) => {
    if (kind === 'root') {
      tx[1] = result.expected.merkleRoot = hex(9);
    }
    if (kind === 'nullifier') {
      tx[2][0] = result.expected.nullifier = hex(9);
    }
    if (kind === 'amount') {
      tx[5][2] = 999;
      result.amount = result.expected.amount = '999';
    }
    if (kind === 'recipient') {
      result.recipient = result.expected.recipient = '0x' + '34'.repeat(20);
      tx[5][0] = hex(BigInt(result.recipient));
    }
    if (kind === 'proof') tx[0][0][0] = 1;
    if (kind === 'message') result.expectedHash = '0x' + 'f'.repeat(64);
    if (kind === 'witness') result.witness = {};
    result.transaction.data = encode();
    expect(normalize).toThrow();
  }
);

const {
  createRailgunPartialCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
test('partial request and offer separate recovered input, gross withdrawal and derived change', () => {
  const f = createRailgunPartialCapsuleData();
  const selected = selectRailgunPrivatePreparation(f.owned, f.request);
  expect(selected).toEqual(f.capsule.selection);
  const value = normalizeRailgunPrivatePreparation(f.capsule.preparation, {
    ...f.owned,
    selection: selected,
  });
  expect(value).toMatchObject({
    inputAmount: '1000',
    unshieldAmount: '400',
    changeAmount: '600',
    spendingEnabled: false,
    recipientVerified: false,
  });
  expect(value).not.toHaveProperty('amount');
  expect(value.expectedHash).toBe(f.capsule.preparation.expectedHash);
  f.capsule.preparation.changeAmount = '1';
  expect(value.changeAmount).toBe('600');
});
test.each(['0', '-1', '0400', '+400', '400.0', '4e2', 400, 400n, null, undefined, '1000', '1001'])(
  'partial request rejects invalid or non-partial amount %s',
  (amount) => {
    const f = createRailgunPartialCapsuleData();
    f.request.unshieldAmount = amount;
    expect(() => selectRailgunPrivatePreparation(f.owned, f.request)).toThrow();
  }
);
test.each(['inputAmount', 'unshieldAmount', 'changeAmount'])(
  'partial offer enforces canonical positive capped %s',
  (key) => {
    for (const value of [
      '0',
      '-1',
      '01',
      '1.0',
      '1e3',
      1,
      1n,
      null,
      undefined,
      (BigInt(pins.maxQualificationAmount) + 1n).toString(),
    ]) {
      const f = createRailgunPartialCapsuleData();
      f.capsule.preparation[key] = value;
      expect(() =>
        normalizeRailgunPrivateOffer(f.capsule.preparation, f.capsule.selection)
      ).toThrow();
    }
  }
);
test.each([
  'under-change',
  'over-change',
  'equal-input',
  'above-input',
  'selected-amount',
  'public-amount',
  'extra-amount',
  'extra-public-input',
  'extra-selection',
])('partial offer refuses %s', (mode) => {
  const f = createRailgunPartialCapsuleData(),
    p = f.capsule.preparation;
  if (mode === 'under-change') p.changeAmount = '599';
  if (mode === 'over-change') p.changeAmount = '601';
  if (mode === 'equal-input') p.inputAmount = '400';
  if (mode === 'above-input') p.inputAmount = '399';
  if (mode === 'selected-amount') f.capsule.selection.unshieldAmount = '399';
  if (mode === 'public-amount') p.unshieldAmount = '399';
  if (mode === 'extra-amount') p.amount = '1000';
  if (mode === 'extra-public-input') p.expected.inputAmount = '1000';
  if (mode === 'extra-selection') f.capsule.selection.amount = '1000';
  expect(() => normalizeRailgunPrivateOffer(p, f.capsule.selection)).toThrow();
});
test('coherent private amounts remain untrusted until compared with the recovered note', () => {
  const f = createRailgunPartialCapsuleData();
  f.capsule.preparation.inputAmount = '1001';
  f.capsule.preparation.changeAmount = '601';
  expect(normalizeRailgunPrivateOffer(f.capsule.preparation, f.capsule.selection).inputAmount).toBe(
    '1001'
  );
  expect(() =>
    normalizeRailgunPrivatePreparation(f.capsule.preparation, {
      ...f.owned,
      selection: f.capsule.selection,
    })
  ).toThrow();
});
test.each(['1', (BigInt(pins.maxQualificationAmount) - 1n).toString()])(
  'partial accepts bounded edge U=%s with cap V',
  (unshieldAmount) => {
    const f = createRailgunPartialCapsuleData({
      inputAmount: pins.maxQualificationAmount,
      unshieldAmount,
    });
    const selection = selectRailgunPrivatePreparation(f.owned, f.request);
    expect(
      normalizeRailgunPrivatePreparation(f.capsule.preparation, { ...f.owned, selection })
        .inputAmount
    ).toBe(pins.maxQualificationAmount);
  }
);
test('legacy request cannot acquire a partial amount field', () => {
  request.unshieldAmount = '400';
  expect(() => selectRailgunPrivatePreparation(owned, request)).toThrow();
});

test('partial offer still refuses a nonzero proof in the pre-signing intent', () => {
  const f = createRailgunPartialCapsuleData();
  f.inner.proof.a.x = 1;
  f.capsule.preparation.transaction.data = f.encode();
  expect(() => normalizeRailgunPrivateOffer(f.capsule.preparation, f.capsule.selection)).toThrow();
});
test.each(['spent', 'wrong-token', 'missing-owned', 'wrong-root', 'wrong-nullifier', 'cap'])(
  'partial preparation retains recovered input check: %s',
  (mode) => {
    const f = createRailgunPartialCapsuleData();
    if (mode === 'spent') f.owned.read.received[0].spentTxid = hex(8);
    if (mode === 'wrong-token') f.owned.read.received[0].asset.contract = '0x' + '34'.repeat(20);
    if (mode === 'missing-owned') f.owned.ownedPoi = [];
    if (mode === 'wrong-root') f.owned.trees[0].root = hex(8);
    if (mode === 'wrong-nullifier') f.owned.ownedPoi[0].nullifier = hex(8);
    if (mode === 'cap') f.owned.read.received[0].amount = BigInt(pins.maxQualificationAmount) + 1n;
    expect(() =>
      normalizeRailgunPrivatePreparation(f.capsule.preparation, {
        ...f.owned,
        selection: f.capsule.selection,
      })
    ).toThrow();
  }
);
describe('full-value transfer to a different account', () => {
  const OTHER = '0zk1' + 'p'.repeat(123);
  const transfer = () => {
    const f =
      require('../../../scripts/fixtures/railgun-partial-capsule-data').createRailgunLegacyCapsuleData(
        'railgun-private-transfer'
      );
    const self = f.request.recipient;
    return { f, self, request: { ...f.request, recipient: OTHER } };
  };
  test('the self request keeps its exact selection; another address gains only the marker', () => {
    const { f, self, request } = transfer();
    const unchanged = selectRailgunPrivatePreparation(f.owned, f.request);
    expect(unchanged).toEqual(f.capsule.selection);
    expect(Object.keys(unchanged)).toEqual(['kind', 'tree', 'position', 'recipient']);
    expect(unchanged.recipient).toBe(self);
    const foreign = selectRailgunPrivatePreparation(f.owned, request);
    expect(foreign).toEqual({
      kind: 'railgun-private-transfer',
      tree: 0,
      position: 1,
      recipient: OTHER,
      recipientRelationship: 'foreign',
    });
    expect(Object.keys(foreign)).toEqual([
      'kind',
      'tree',
      'position',
      'recipient',
      'recipientRelationship',
    ]);
    expect(Object.isFrozen(foreign)).toBe(true);
  });
  test.each([
    ['uppercase', '0ZK1' + 'P'.repeat(123)],
    ['short', '0zk1' + 'p'.repeat(122)],
    ['public address', '0x' + '12'.repeat(20)],
    ['empty', ''],
    ['object', {}],
  ])('a malformed %s destination refuses before a window opens', (_label, recipient) => {
    const { f } = transfer();
    expect(() => selectRailgunPrivatePreparation(f.owned, { ...f.request, recipient })).toThrow();
  });
  test('the request cannot inject a marker or relationship', () => {
    const { f, request } = transfer();
    for (const extra of [{ recipientRelationship: 'foreign' }, { relationship: 'self' }])
      expect(() => selectRailgunPrivatePreparation(f.owned, { ...request, ...extra })).toThrow();
  });
  test('the reviewed destination binds the utility offer exactly', () => {
    const { f, request } = transfer();
    const selection = selectRailgunPrivatePreparation(f.owned, request);
    const preparation = { ...f.capsule.preparation, recipient: OTHER };
    expect(
      normalizeRailgunPrivatePreparation(preparation, { ...f.owned, selection }).recipient
    ).toBe(OTHER);
    // A destination altered after review, on either side, is refused.
    expect(() =>
      normalizeRailgunPrivatePreparation(
        { ...preparation, recipient: '0zk1' + 'r'.repeat(123) },
        { ...f.owned, selection }
      )
    ).toThrow();
    expect(() =>
      normalizeRailgunPrivatePreparation(preparation, {
        ...f.owned,
        selection: { ...selection, recipient: '0zk1' + 'r'.repeat(123) },
      })
    ).toThrow();
    // Removing the marker restores self semantics, which this destination fails.
    const { recipientRelationship: _marker, ...unmarked } = selection;
    expect(() =>
      normalizeRailgunPrivatePreparation(preparation, { ...f.owned, selection: unmarked })
    ).toThrow();
    // A foreign marker never applies to this account's own instance address.
    expect(() =>
      normalizeRailgunPrivatePreparation(f.capsule.preparation, {
        ...f.owned,
        selection: { ...f.capsule.selection, recipientRelationship: 'foreign' },
      })
    ).toThrow();
  });
});
