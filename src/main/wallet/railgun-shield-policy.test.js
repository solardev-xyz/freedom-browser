const { Interface } = require('ethers');
const {
  SHIELD_ABI,
  shieldAmount,
  validateRailgunNativeShield,
} = require('./railgun-shield-policy');
const pins = require('./railgun-shield-pins.json');
const abi = new Interface(SHIELD_ABI);
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
const amount = '100000000000000';
const expected = { amount, npk: hex(7) };
function fixture() {
  const request = {
    preimage: {
      npk: expected.npk,
      token: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: 0 },
      value: amount,
    },
    ciphertext: { encryptedBundle: [hex(1), hex(2), hex(3)], shieldKey: hex(4) },
  };
  return {
    request,
    calls: [
      { to: pins.relayAdapt, value: 0, data: abi.encodeFunctionData('wrapBase', [amount]) },
      { to: pins.relayAdapt, value: 0, data: '' },
    ],
  };
}
function build({ request, calls }, required = true, list = [request]) {
  if (calls[1].data === '') calls[1].data = abi.encodeFunctionData('shield', [list]);
  return {
    chainId: pins.chainId,
    to: pins.relayAdapt,
    value: amount,
    data: abi.encodeFunctionData('multicall', [required, calls]),
  };
}
test('only the exact atomic native shield is accepted and binds all calldata', () => {
  const tx = build(fixture());
  const checked = validateRailgunNativeShield(tx, expected);
  expect(checked).toMatchObject({
    kind: 'railgun-native-shield',
    token: pins.wrappedNative,
    npk: expected.npk,
    noteValue: '99750000000000',
    shieldFeeBps: 25,
  });
  expect(Object.isFrozen(checked)).toBe(true);
  const changed = fixture();
  changed.request.ciphertext.encryptedBundle[2] = hex(5);
  expect(validateRailgunNativeShield(build(changed), expected).digest).not.toBe(checked.digest);
});
test.each(['0', '-1', '01', '1.5', '10000000000000001', '1e10', 1n, 1, undefined])(
  'invalid/beyond-qualification amount %s refuses',
  (value) => {
    expect(() => shieldAmount(value)).toThrow();
  }
);
test.each(['chain', 'target', 'value', 'extra', 'trailing', 'selector'])(
  'outer %s mutation refuses',
  (kind) => {
    const tx = build(fixture());
    if (kind === 'chain') tx.chainId = 1;
    if (kind === 'target') tx.to = pins.proxy;
    if (kind === 'value') tx.value = '100000000000001';
    if (kind === 'extra') tx.from = pins.proxy;
    if (kind === 'trailing') tx.data += '00';
    if (kind === 'selector') tx.data = abi.encodeFunctionData('wrapBase', [amount]);
    expect(() => validateRailgunNativeShield(tx, expected)).toThrow();
  }
);
test.each([
  'wrap-zero',
  'wrap-value',
  'call-value',
  'external',
  'calls',
  'success',
  'npk',
  'npk-zero',
  'token',
  'token-type',
  'sub-id',
  'note-value',
  'key-zero',
  'batch',
  'inner-trailing',
  'order',
])('nested %s mutation refuses', (kind) => {
  const value = fixture();
  let required = true,
    list;
  if (kind === 'wrap-zero') value.calls[0].data = abi.encodeFunctionData('wrapBase', [0]);
  if (kind === 'wrap-value')
    value.calls[0].data = abi.encodeFunctionData('wrapBase', [BigInt(amount) + 1n]);
  if (kind === 'call-value') value.calls[0].value = 1;
  if (kind === 'external') value.calls[1].to = pins.proxy;
  if (kind === 'calls') value.calls.push({ ...value.calls[0] });
  if (kind === 'success') required = false;
  if (kind === 'npk') value.request.preimage.npk = hex(8);
  if (kind === 'npk-zero') value.request.preimage.npk = hex(0);
  if (kind === 'token') value.request.preimage.token.tokenAddress = pins.proxy;
  if (kind === 'token-type') value.request.preimage.token.tokenType = 1;
  if (kind === 'sub-id') value.request.preimage.token.tokenSubID = 1;
  if (kind === 'note-value') value.request.preimage.value = 0;
  if (kind === 'key-zero') value.request.ciphertext.shieldKey = hex(0);
  if (kind === 'batch') list = [value.request, value.request];
  if (kind === 'inner-trailing') value.calls[0].data += '00';
  if (kind === 'order') {
    value.calls[1].data = value.calls[0].data;
    value.calls[0].data = abi.encodeFunctionData('shield', [[value.request]]);
  }
  expect(() => validateRailgunNativeShield(build(value, required, list), expected)).toThrow();
});
test('deployment pins match both-provider captured code and fee state', () => {
  const report = require('../../../docs/qualification/railgun-sepolia-deployment-2026-10-03.json');
  for (const name of ['proxy', 'relayAdapt', 'wrappedNative']) {
    expect(pins[name]).toBe(report.code[name].address.toLowerCase());
    expect(pins.codeHashes[name]).toBe(report.code[name].keccak256);
  }
  expect(pins.shieldFeeBps).toBe(Number(report.state.shieldFee));
});
