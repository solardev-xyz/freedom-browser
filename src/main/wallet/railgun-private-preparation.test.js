const { Interface, AbiCoder, keccak256 } = require('ethers');
const { TRANSACT_ABI, BOUND_PARAMS } = require('./railgun-private-policy');
const {
  selectRailgunPrivatePreparation,
  normalizeRailgunPrivatePreparation,
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
