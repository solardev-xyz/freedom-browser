const { Wallet, Transaction, Interface } = require('ethers');
const { transactionIntent, validIntent } = require('./private-transaction-intent');
const { assertOrdinaryRequest, isClassifiedOrdinary } = require('./ordinary-submission-policy');
const { SHIELD_ABI } = require('./railgun-shield-policy');
const pins = require('./railgun-shield-pins.json');
const prepared = require('../../../docs/qualification/railgun-shield-account-2026-10-03.json')
  .prepared[0];
const abi = new Interface(SHIELD_ABI);
const signer = new Wallet('0x' + '11'.repeat(32)); // Public test fixture only.
const tx = {
  chainId: 11155111,
  from: signer.address,
  to: prepared.to,
  value: BigInt(prepared.value),
  data: prepared.data,
};
test('journal metadata comes from real qualified calldata and signed bytes, not caller note fields', async () => {
  const unsigned = transactionIntent('railgun-native-shield', { ...tx, npk: 'forged' });
  expect(unsigned).toMatchObject({
    kind: 'railgun-native-shield',
    npk: prepared.npk,
    token: pins.wrappedNative,
    amount: prepared.value,
    noteValue: prepared.noteValue,
  });
  expect(validIntent(unsigned)).toBe(true);
  expect(validIntent({ kind: unsigned.kind, digest: unsigned.digest })).toBe(false);
  const raw = await signer.signTransaction({
    ...tx,
    nonce: 0,
    gasLimit: 500000n,
    gasPrice: 1n,
    type: 0,
  });
  expect(transactionIntent('railgun-native-shield', Transaction.from(raw))).toEqual(unsigned);
  expect(Object.isFrozen(unsigned)).toBe(true);
  for (const change of [
    { npk: '0x' + '0'.repeat(64) },
    { npk: '0x' + 'f'.repeat(64) },
    { amount: '0' },
    { noteValue: '0' },
    { noteValue: (BigInt(prepared.value) + 1n).toString() },
    { token: pins.proxy },
    { extra: 1 },
  ])
    expect(validIntent({ ...unsigned, ...change })).toBe(false);
});
test.each([{ chainId: 1 }, { to: pins.proxy }, { value: 0n }, { data: prepared.data + '00' }])(
  'rejects changed signed shield structure %#',
  (change) => {
    expect(() => transactionIntent('railgun-native-shield', { ...tx, ...change })).toThrow(
      expect.objectContaining({ code: 'PRIVATE_INTENT_INVALID' })
    );
  }
);
test('an altered nested wrap or shield value cannot be journaled', () => {
  const [, decoded] = abi.decodeFunctionData('multicall', tx.data);
  const calls = decoded.map((call) => ({ to: call.to, value: call.value, data: call.data }));
  calls[0].data = abi.encodeFunctionData('wrapBase', [0]);
  expect(() =>
    transactionIntent('railgun-native-shield', {
      ...tx,
      data: abi.encodeFunctionData('multicall', [true, calls]),
    })
  ).toThrow();
});
test.each([pins.proxy, pins.implementation, pins.relayAdapt])(
  'pinned target %s cannot be disguised as PPv2 or ordinary',
  (to) => {
    expect(() => transactionIntent('ppv2-native-deposit', { ...tx, to })).toThrow();
    expect(() => assertOrdinaryRequest({ ...tx, to })).toThrow();
    expect(
      isClassifiedOrdinary({
        route: 'ordinary',
        ordinary: {
          to,
          selector: tx.data.slice(0, 10),
          type: 0,
          senderCode: '0x',
          trust: 'unverified-rpc',
        },
      })
    ).toBe(false);
  }
);
test('ordinary WETH transfer remains distinct from a RelayAdapt shield', () => {
  expect(() =>
    assertOrdinaryRequest({ ...tx, to: pins.wrappedNative, data: '0xa9059cbb' })
  ).not.toThrow();
});
