const { AbiCoder, Interface, keccak256 } = require('ethers');
const { transactionIntent, validIntent } = require('./private-transaction-intent');
const { RAGEQUIT_ABI } = require('./ppv2-ragequit-policy');
const { FIELD, NATIVE } = require('./ppv2-deposit-policy');
const abi = new Interface([RAGEQUIT_ABI]);
const owner = `0x${'22'.repeat(20)}`,
  pool = `0x${'11'.repeat(20)}`;
const signals = [1n, 7n, 3n, BigInt(owner), 100n, BigInt(NATIVE), 4n];
const encode = (s) =>
  abi.encodeFunctionData('ragequit', [
    [
      [1n, 2n],
      [
        [3n, 4n],
        [5n, 6n],
      ],
      [7n, 8n],
      s,
    ],
  ]);
const tx = { chainId: 11155111, from: owner, to: pool, value: 0n, data: encode(signals) };
test('calldata-derived exit binding preserves the exact legacy intent digest', () => {
  const value = transactionIntent('ppv2-native-ragequit', {
    ...tx,
    commitment: `0x${'ff'.repeat(32)}`,
  });
  expect(value.pool).toBe(pool);
  expect(BigInt(value.commitment)).toBe(7n);
  expect(Object.isFrozen(value)).toBe(true);
  expect(value.digest).toBe(
    keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['string', 'uint256', 'address', 'address', 'uint256', 'bytes'],
        ['ppv2-native-ragequit', tx.chainId, owner, pool, 0n, tx.data]
      )
    )
  );
  expect(validIntent(value)).toBe(true);
  expect(validIntent({ kind: value.kind, digest: value.digest })).toBe(true);
});
test.each([
  { data: '0xabcd' },
  { data: `${tx.data}00` },
  { value: 1n },
  { chainId: 1 },
  { from: pool },
  { data: encode(signals.map((v, i) => (i === 1 ? FIELD : v))) },
  { data: encode(signals.map((v, i) => (i === 4 ? 0n : v))) },
  { data: encode(signals.map((v, i) => (i === 5 ? BigInt(pool) : v))) },
])('refuses noncanonical or mismatched exit calldata %#', (change) => {
  expect(() => transactionIntent('ppv2-native-ragequit', { ...tx, ...change })).toThrow(
    expect.objectContaining({ code: 'PRIVATE_INTENT_INVALID' })
  );
});
test('token exit binds the same note and refuses native kind confusion', () => {
  const value = transactionIntent('ppv2-token-ragequit', {
    ...tx,
    data: encode(signals.map((v, i) => (i === 5 ? BigInt(pool) : v))),
  });
  expect(BigInt(value.commitment)).toBe(7n);
  expect(validIntent(value)).toBe(true);
  expect(() => transactionIntent('ppv2-token-ragequit', tx)).toThrow();
  expect(validIntent({ ...value, pool: null })).toBe(false);
  expect(validIntent({ ...value, commitment: `0x${FIELD.toString(16)}` })).toBe(false);
  expect(validIntent({ ...value, kind: 'ppv2-native-deposit' })).toBe(false);
});

test('a ragequit cannot be disguised as a non-exit intent', () => {
  for (const kind of [
    'ppv2-register-auth',
    'ppv2-native-deposit',
    'ppv2-token-deposit',
    'ppv2-token-approval',
  ]) {
    expect(() => transactionIntent(kind, tx)).toThrow(
      expect.objectContaining({ code: 'PRIVATE_INTENT_INVALID' })
    );
  }
});
test.each([false, true])(
  'Railgun private %s uses full calldata metadata and refuses other labels',
  (unshield) => {
    const transaction = require('../../../scripts/fixtures/railgun-transact-data')
      .fixture(unshield)
      .transaction();
    const classified = transactionIntent('railgun-transact', transaction);
    expect(validIntent(classified)).toBe(true);
    expect(validIntent({ kind: classified.kind, digest: classified.digest })).toBe(false);
    for (const kind of ['railgun-native-shield', 'ppv2-native-deposit', 'ppv2-token-approval'])
      expect(() => transactionIntent(kind, transaction)).toThrow();
    expect(() => transactionIntent('railgun-transact', tx)).toThrow();
  }
);
