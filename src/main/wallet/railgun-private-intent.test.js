const { Interface, AbiCoder, keccak256 } = require('ethers');
const { TRANSACT_ABI, BOUND_PARAMS } = require('./railgun-private-policy');
const {
  validateRailgunPrivateSigningIntent,
  matchRailgunPrivateProvedTransaction,
} = require('./railgun-private-intent');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const zero = '0x' + '0'.repeat(40),
  abi = new Interface([TRANSACT_ABI]);
const field = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function fixture() {
  const bound = [0, 0, 1, pins.chainId, zero, hex(0), []];
  const expected = {
    kind: 'railgun-token-unshield',
    tree: 0,
    merkleRoot: hex(1),
    nullifier: hex(2),
    commitment: hex(3),
    boundParamsHash: hex(
      BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bound]))) % field
    ),
    recipient: '0x' + '12'.repeat(20),
    amount: '1000',
  };
  const tx = [
    [
      [0, 0],
      [
        [0, 0],
        [0, 0],
      ],
      [0, 0],
    ],
    expected.merkleRoot,
    [expected.nullifier],
    [expected.commitment],
    bound,
    [hex(BigInt(expected.recipient)), [0, pins.wrappedNative, 0], 1000],
  ];
  const encode = () => ({
    chainId: pins.chainId,
    to: pins.proxy,
    value: '0',
    data: abi.encodeFunctionData('transact', [[tx]]),
  });
  return { expected, tx, encode };
}
test('only proof coordinates can change, without granting proof verification', () => {
  const f = fixture(),
    intent = f.encode();
  validateRailgunPrivateSigningIntent(intent, f.expected);
  f.tx[0] = [
    [1, 2],
    [
      [3, 4],
      [5, 6],
    ],
    [7, 8],
  ];
  const result = matchRailgunPrivateProvedTransaction(intent, f.encode(), f.expected);
  expect(result.proofVerified).toBe(false);
  expect(result.spendingEnabled).toBe(false);
  expect(() => validateRailgunPrivateSigningIntent(f.encode(), f.expected)).toThrow();
});
test.each([
  [0, 0],
  [0, 1],
  [1, 0, 0],
  [1, 0, 1],
  [1, 1, 0],
  [1, 1, 1],
  [2, 0],
  [2, 1],
])('refuses a nonzero proof placeholder at %j', (...indices) => {
  const f = fixture();
  let target = f.tx[0];
  for (const index of indices.slice(0, -1)) target = target[index];
  target[indices.at(-1)] = 1;
  expect(() => validateRailgunPrivateSigningIntent(f.encode(), f.expected)).toThrow();
});
test.each([
  (f) => {
    f.tx[1] = hex(9);
  },
  (f) => {
    f.tx[2] = [hex(9)];
  },
  (f) => {
    f.tx[3] = [hex(9)];
  },
  (f) => {
    f.tx[4][1] = 1;
  },
  (f) => {
    f.tx[5][0] = hex(9);
  },
  (f) => {
    f.tx[5][2] = 999;
  },
])('refuses changed public intent %#', (change) => {
  const f = fixture(),
    intent = f.encode();
  change(f);
  expect(() => matchRailgunPrivateProvedTransaction(intent, f.encode(), f.expected)).toThrow();
});
test('refuses using a different equally policy-valid signed intent', () => {
  const f = fixture(),
    intent = f.encode();
  f.tx[1] = hex(9);
  f.expected.merkleRoot = hex(9);
  expect(() => matchRailgunPrivateProvedTransaction(intent, f.encode(), f.expected)).toThrow();
});
