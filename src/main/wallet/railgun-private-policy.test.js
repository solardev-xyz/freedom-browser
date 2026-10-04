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

const {
  createRailgunPartialCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
const partialFixture = () => {
  const f = createRailgunPartialCapsuleData();
  return {
    ...f,
    expected: f.capsule.preparation.expected,
    tx: () => ({ ...f.capsule.preparation.transaction, data: f.encode() }),
  };
};
test('partial public intent binds two ordered commitments, one ciphertext and gross withdrawal only', () => {
  const f = partialFixture();
  const value = validateRailgunPrivateTransaction(f.tx(), f.expected);
  expect(value).toMatchObject({
    ...f.expected,
    proofVerified: false,
    recipientVerified: false,
    spendingEnabled: false,
  });
  expect(value).not.toHaveProperty('inputAmount');
  expect(value).not.toHaveProperty('changeAmount');
  expect(value).not.toHaveProperty('commitment');
  expect(Object.isFrozen(value)).toBe(true);
});
test.each([
  ['swapped outputs', (f) => f.inner.commitments.reverse()],
  ['missing unshield', (f) => f.inner.commitments.pop()],
  ['extra output', (f) => f.inner.commitments.push(hex(20))],
  ['changed change', (f) => (f.inner.commitments[0] = hex(20))],
  ['changed unshield', (f) => (f.inner.commitments[1] = hex(20))],
  ['extra input', (f) => f.inner.nullifiers.push(hex(20))],
  ['missing ciphertext', (f) => (f.inner.boundParams.commitmentCiphertext = [])],
  [
    'extra ciphertext',
    (f) =>
      f.inner.boundParams.commitmentCiphertext.push(f.inner.boundParams.commitmentCiphertext[0]),
  ],
  ['no unshield flag', (f) => (f.inner.boundParams.unshield = 0)],
  ['override', (f) => (f.inner.boundParams.unshield = 2)],
  ['foreign chain', (f) => (f.inner.boundParams.chainID = 1)],
  ['adapt contract', (f) => (f.inner.boundParams.adaptContract = pins.relayAdapt)],
  ['adapt parameters', (f) => (f.inner.boundParams.adaptParams = hex(20))],
  ['gas price', (f) => (f.inner.boundParams.minGasPrice = 1)],
  ['foreign token', (f) => (f.inner.unshieldPreimage.token.tokenAddress = zero)],
  ['token type', (f) => (f.inner.unshieldPreimage.token.tokenType = 1)],
  ['token sub-id', (f) => (f.inner.unshieldPreimage.token.tokenSubID = 1)],
  ['foreign recipient', (f) => (f.inner.unshieldPreimage.npk = hex(20))],
  ['wrong amount', (f) => (f.inner.unshieldPreimage.value = 401)],
  [
    'oversized memo',
    (f) => (f.inner.boundParams.commitmentCiphertext[0].memo = '0x' + '11'.repeat(257)),
  ],
  [
    'oversized annotation',
    (f) => (f.inner.boundParams.commitmentCiphertext[0].annotationData = '0x' + '11'.repeat(257)),
  ],
  [
    'zero sender',
    (f) => (f.inner.boundParams.commitmentCiphertext[0].blindedSenderViewingKey = hex(0)),
  ],
  [
    'zero receiver',
    (f) => (f.inner.boundParams.commitmentCiphertext[0].blindedReceiverViewingKey = hex(0)),
  ],
])('partial refuses %s even with a coherently recomputed bound hash', (_label, change) => {
  const f = partialFixture();
  change(f);
  f.expected.boundParamsHash = hex(
    BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [f.inner.boundParams]))) %
      FIELD
  );
  expect(() => validateRailgunPrivateTransaction(f.tx(), f.expected)).toThrow(
    'Railgun private transaction refused'
  );
});
test.each([
  '0',
  '-1',
  '0400',
  '+400',
  '400.0',
  '4e2',
  ' 400',
  400,
  400n,
  null,
  undefined,
  '99999999999999999',
])('partial refuses noncanonical or excessive public amount %s', (amount) => {
  const f = partialFixture();
  f.expected.unshieldAmount = amount;
  expect(() => validateRailgunPrivateTransaction(f.tx(), f.expected)).toThrow();
});
test.each(['inputAmount', 'changeAmount', 'amount', 'commitment', 'authority'])(
  'partial public expected refuses extra %s',
  (key) => {
    const f = partialFixture();
    f.expected[key] = '1';
    expect(() => validateRailgunPrivateTransaction(f.tx(), f.expected)).toThrow();
  }
);
test.each(['changeCommitment', 'unshieldCommitment'])(
  'partial validates %s field boundary and case',
  (key) => {
    for (const value of [hex(FIELD), '0x' + 'AB'.repeat(32), '0x01', 1]) {
      const f = partialFixture();
      f.expected[key] = value;
      expect(() => validateRailgunPrivateTransaction(f.tx(), f.expected)).toThrow();
    }
  }
);
