const { Interface, Transaction, Wallet } = require('ethers');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const {
  extractRailgunTransactIntent: extract,
  railgunTransactIntentBinding: binding,
  validRailgunTransactIntent: valid,
} = require('./railgun-transact-intent');
const { validateRailgunPrivateSigningIntent } = require('./railgun-private-intent');
const { fixture } = require('../../../scripts/fixtures/railgun-transact-data');
const pins = require('./railgun-shield-pins.json');
const abi = new Interface([TRANSACT_ABI]);
test.each([false, true])(
  'derives %s metadata and original intent from calldata only',
  async (unshield) => {
    const f = fixture(unshield),
      tx = f.transaction(),
      result = extract(tx);
    expect(result.intentDigest).toBe(
      validateRailgunPrivateSigningIntent(result.intent, result.expected).digest
    );
    expect(result.transaction).toEqual({
      chainId: tx.chainId,
      to: tx.to,
      value: tx.value,
      data: tx.data,
    });
    expect(
      binding({ ...tx, holdId: 'forged', nullifier: 'forged', intentDigest: 'forged' })
    ).toEqual(binding(tx));
    const record = { kind: 'railgun-transact', digest: '0x' + '1'.repeat(64), ...binding(tx) };
    expect(valid(record)).toBe(true);
    expect(JSON.parse(JSON.stringify(record))).toStrictEqual(record);
    expect(binding(tx).operation).toBe(
      unshield ? 'railgun-token-unshield' : 'railgun-private-transfer'
    );
    expect(binding(tx).recipient).toBe(unshield ? f.recipient : undefined);
    const wallet = new Wallet('0x' + '11'.repeat(32));
    const signed = await wallet.signTransaction({
      ...tx,
      from: wallet.address,
      nonce: 0,
      gasLimit: 1000000,
      gasPrice: 1,
    });
    expect(binding(Transaction.from(signed))).toEqual(binding(tx));
    f.inner.proof.a.x = 12n;
    expect(f.transaction().data).not.toBe(tx.data);
    expect(binding(f.transaction())).toEqual(binding(tx));
    f.inner.merkleRoot = '0x' + '1'.repeat(64);
    expect(binding(f.transaction()).intentDigest).not.toBe(record.intentDigest);
  }
);
test.each([
  { chainId: 1 },
  { to: pins.implementation },
  { to: pins.relayAdapt },
  { value: '1' },
  { data: '0x' },
  { data: '0x' + 'ff'.repeat(4097) },
])('refuses unsupported transaction %j', (change) => {
  expect(() => binding({ ...fixture().transaction(), ...change })).toThrow(
    'Railgun transact intent unavailable'
  );
});
test.each([
  (f) => {
    f.inner.boundParams.adaptContract = pins.relayAdapt;
  },
  (f) => {
    f.inner.boundParams.unshield = 2n;
  },
  (f) => {
    f.inner.nullifiers.push(f.inner.nullifiers[0]);
  },
  (f) => {
    f.inner.commitments.push(f.inner.commitments[0]);
  },
  (f) => {
    f.inner.boundParams.minGasPrice = 1n;
  },
  (f) => {
    f.inner.boundParams.chainID = 1n;
  },
  (f) => {
    f.inner.boundParams.commitmentCiphertext = [];
  },
  (f) => {
    f.inner.unshieldPreimage.value = 1n;
  },
])('refuses unsupported routing or private transaction shape %#', (change) => {
  const f = fixture();
  change(f);
  expect(() => binding(f.transaction())).toThrow();
});
test('refuses noncanonical bytes and batched transactions', () => {
  const f = fixture(),
    tx = f.transaction();
  expect(() => binding({ ...tx, data: tx.data + '00'.repeat(32) })).toThrow();
  expect(() =>
    binding({ ...tx, data: abi.encodeFunctionData('transact', [[f.inner, f.inner]]) })
  ).toThrow();
});
test.each([
  'kind',
  'digest',
  'operation',
  'tree',
  'merkleRoot',
  'nullifier',
  'commitment',
  'boundParamsHash',
  'intentDigest',
  'recipient',
  'amount',
])('rejects malformed journal %s', (key) => {
  const value = {
    kind: 'railgun-transact',
    digest: '0x' + '1'.repeat(64),
    ...binding(fixture(true).transaction()),
  };
  expect(valid({ ...value, [key]: null })).toBe(false);
  const missing = { ...value };
  delete missing[key];
  expect(valid(missing)).toBe(false);
  expect(valid({ ...value, extra: true })).toBe(false);
});
