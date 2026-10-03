const { AbiCoder, Interface, keccak256 } = require('ethers');
const {
  TRANSACT_ABI,
  BOUND_PARAMS,
  validateRailgunPrivateTransaction,
} = require('./railgun-private-policy');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const zero = '0x' + '0'.repeat(40);
const abi = new Interface([TRANSACT_ABI]);
function fixture(unshield = false) {
  const bound = {
    treeNumber: 0,
    minGasPrice: 0,
    unshield: unshield ? 1 : 0,
    chainID: pins.chainId,
    adaptContract: zero,
    adaptParams: hex(0),
    commitmentCiphertext: unshield
      ? []
      : [
          {
            ciphertext: [hex(1), hex(2), hex(3), hex(4)],
            blindedSenderViewingKey: hex(5),
            blindedReceiverViewingKey: hex(6),
            annotationData: '0x1122',
            memo: '0x',
          },
        ],
  };
  const recipient = '0x' + '12'.repeat(20);
  const expected = {
    kind: unshield ? 'railgun-token-unshield' : 'railgun-private-transfer',
    tree: 0,
    merkleRoot: hex(7),
    nullifier: hex(8),
    commitment: hex(9),
    boundParamsHash: hex(
      BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bound]))) % FIELD
    ),
    ...(unshield ? { recipient, amount: '1000' } : {}),
  };
  const inner = {
    proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } },
    merkleRoot: expected.merkleRoot,
    nullifiers: [expected.nullifier],
    commitments: [expected.commitment],
    boundParams: bound,
    unshieldPreimage: {
      npk: unshield ? hex(BigInt(recipient)) : hex(0),
      token: { tokenType: 0, tokenAddress: unshield ? pins.wrappedNative : zero, tokenSubID: 0 },
      value: unshield ? 1000 : 0,
    },
  };
  const tx = () => ({
    chainId: pins.chainId,
    to: pins.proxy,
    value: '0',
    data: abi.encodeFunctionData('transact', [[inner]]),
  });
  return { expected, inner, tx };
}
test.each([false, true])(
  'checks canonical %s intent without treating dummy proof bytes as verified',
  (unshield) => {
    const f = fixture(unshield);
    const result = validateRailgunPrivateTransaction(f.tx(), f.expected);
    expect(result).toMatchObject({
      ...f.expected,
      proofVerified: false,
      recipientVerified: false,
      reservationsChecked: false,
      spendingEnabled: false,
    });
    expect(result.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
  }
);
test.each([
  ['merkleRoot', hex(10)],
  ['nullifier', hex(10)],
  ['commitment', hex(10)],
  ['boundParamsHash', hex(10)],
  ['tree', 1],
  ['extra', true],
])('refuses changed expected %s', (key, value) => {
  const f = fixture(),
    tx = f.tx();
  f.expected[key] = value;
  expect(() => validateRailgunPrivateTransaction(tx, f.expected)).toThrow();
});
test.each([
  (tx) => {
    tx.merkleRoot = hex(10);
  },
  (tx) => {
    tx.nullifiers.push(hex(10));
  },
  (tx) => {
    tx.commitments.push(hex(10));
  },
  (tx) => {
    tx.boundParams.minGasPrice = 1;
  },
  (tx) => {
    tx.boundParams.treeNumber = 1;
  },
  (tx) => {
    tx.boundParams.chainID = 1;
  },
  (tx) => {
    tx.boundParams.adaptContract = pins.relayAdapt;
  },
  (tx) => {
    tx.boundParams.adaptParams = hex(10);
  },
  (tx) => {
    tx.boundParams.unshield = 2;
  },
  (tx) => {
    tx.boundParams.commitmentCiphertext[0].ciphertext[0] = hex(10);
  },
  (tx) => {
    tx.boundParams.commitmentCiphertext[0].memo = '0x' + '11'.repeat(257);
  },
  (tx) => {
    tx.boundParams.commitmentCiphertext = [];
  },
  (tx) => {
    tx.unshieldPreimage.value = 1;
  },
])('refuses altered transaction, routing or output ciphertext %#', (change) => {
  const f = fixture();
  change(f.inner);
  expect(() => validateRailgunPrivateTransaction(f.tx(), f.expected)).toThrow();
});
test.each([
  (tx) => {
    tx.unshieldPreimage.npk = hex(10);
  },
  (tx) => {
    tx.unshieldPreimage.value = 999;
  },
  (tx) => {
    tx.unshieldPreimage.token.tokenAddress = zero;
  },
  (tx) => {
    tx.unshieldPreimage.token.tokenSubID = 1;
  },
  (tx) => {
    tx.unshieldPreimage.token.tokenType = 1;
  },
])('refuses changed unshield receiver, amount or token %#', (change) => {
  const f = fixture(true);
  change(f.inner);
  expect(() => validateRailgunPrivateTransaction(f.tx(), f.expected)).toThrow();
});
test('refuses batches, trailing bytes, noncanonical encoding and outer transaction changes', () => {
  const f = fixture();
  for (const tx of [
    { ...f.tx(), value: '1' },
    { ...f.tx(), chainId: 1 },
    { ...f.tx(), to: pins.relayAdapt },
    { ...f.tx(), extra: true },
    { ...f.tx(), data: f.tx().data + '00' },
    { ...f.tx(), data: f.tx().data.toUpperCase() },
    { ...f.tx(), data: abi.encodeFunctionData('transact', [[f.inner, f.inner]]) },
  ])
    expect(() => validateRailgunPrivateTransaction(tx, f.expected)).toThrow();
});
