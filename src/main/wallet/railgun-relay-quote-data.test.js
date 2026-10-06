const {
  normalizeRailgunRelayQuote: normalize,
  assertQuoteCurrent,
  EXPECTED_GUARDS,
  normalizeQuoteVerification,
  digest,
} = require('./railgun-relay-quote-data');
const pins = require('./railgun-shield-pins.json');
function input() {
  const fields = {
    fees: { [pins.wrappedNative]: '0xde0b6b3a7640000' },
    feeExpiration: 200000,
    feesID: 'public-test',
    railgunAddress: '0zk1' + 'q'.repeat(123),
    identifier: 'public test',
    availableWallets: 1,
    version: '8.0.0',
    relayAdapt: pins.relayAdapt,
    requiredPOIListKeys: ['44'.repeat(32)],
    reliability: 0.5,
  };
  return {
    fields,
    quote: {
      data: Buffer.from(JSON.stringify(fields)).toString('hex'),
      signature: '03'.repeat(32) + '00'.repeat(32),
    },
    gas: { transactionType: 0, gasEstimate: '84', gasPrice: '1', minGasPrice: '1' },
  };
}
test('detaches exact signed bytes, legacy rounding, fee and unsigned local deployment', () => {
  const i = input(),
    value = normalize(i.quote, i.gas);
  expect(value).toMatchObject({
    feeAmount: '100',
    gasLimit: '100',
    maximumGasWei: '100',
    proxy: pins.proxy,
  });
  expect(value.quote.data).toBe(i.quote.data);
  i.quote.data = '';
  i.gas.gasPrice = '9';
  i.fields.feesID = 'changed';
  expect(value.fields.feesID).toBe('public-test');
  expect(value.gas.gasPrice).toBe('1');
  expect(Object.isFrozen(value.fields.fees)).toBe(true);
});
test.each([
  ['4', '4'],
  ['5', '6'],
  ['84', '100'],
])('gas floor %s -> %s', (estimate, result) => {
  const i = input();
  i.gas.gasEstimate = estimate;
  expect(normalize(i.quote, i.gas).feeAmount).toBe(result);
});
test.each([
  ['0xde0b6b3a7640000', '1'],
  ['0xf4240', '1000000000000'],
])('rate units %s with price %s', (rate, price) => {
  const i = input();
  i.fields.fees[pins.wrappedNative] = rate;
  i.gas.gasPrice = price;
  i.quote.data = Buffer.from(JSON.stringify(i.fields)).toString('hex');
  expect(normalize(i.quote, i.gas).feeAmount).toBe('100');
});
test('uint48 common boundary accepts maximum and rejects 2^48 without changing selector policy', () => {
  const i = input();
  i.gas.gasPrice = ((1n << 48n) - 1n).toString();
  i.gas.minGasPrice = i.gas.gasPrice;
  i.fields.fees[pins.wrappedNative] = '0x1000';
  i.quote.data = Buffer.from(JSON.stringify(i.fields)).toString('hex');
  expect(normalize(i.quote, i.gas).gas.gasPrice).toBe(i.gas.gasPrice);
  i.gas.minGasPrice = (1n << 48n).toString();
  expect(() => normalize(i.quote, i.gas)).toThrow();
});
test.each([
  (i) => {
    i.gas.transactionType = 2;
  },
  (i) => {
    i.gas.gasEstimate = '0';
  },
  (i) => {
    i.gas.minGasPrice = '2';
  },
  (i) => {
    i.gas.gasPrice = '01';
  },
  (i) => {
    i.gas.gasPrice = 1;
  },
  (i) => {
    i.gas.gasEstimate = '3000001';
  },
  (i) => {
    i.fields.fees[pins.wrappedNative] = '0x0';
  },
  (i) => {
    i.fields.fees.other = '0x1';
  },
  (i) => {
    i.fields.relayAdapt = '0x' + '00'.repeat(20);
  },
  (i) => {
    i.fields.requiredPOIListKeys.push(i.fields.requiredPOIListKeys[0]);
  },
  (i) => {
    i.fields.version = '9.0.0';
  },
  (i) => {
    i.fields.extra = true;
  },
])('closed data/gas refusal %s', (change) => {
  const i = input();
  change(i);
  i.quote.data = Buffer.from(JSON.stringify(i.fields)).toString('hex');
  expect(() => normalize(i.quote, i.gas)).toThrow();
});
test.each(['duplicate', 'space', 'escaped-key', 'utf8', 'oversize', 'signature'])(
  'signed byte ambiguity/bounds %s',
  (kind) => {
    const i = input();
    let text = Buffer.from(i.quote.data, 'hex').toString();
    if (kind === 'duplicate') text = text.replace('{', '{"feeExpiration":1,');
    if (kind === 'space') text += ' ';
    if (kind === 'escaped-key') text = text.replace('feesID', 'fees\\u0049D');
    i.quote.data = Buffer.from(text).toString('hex');
    if (kind === 'utf8') i.quote.data = 'ff';
    if (kind === 'oversize') i.quote.data = '00'.repeat(8193);
    if (kind === 'signature') i.quote.signature = '00';
    expect(() => normalize(i.quote, i.gas)).toThrow();
  }
);
test('refuses getters and proxies without invoking them', () => {
  const i = input(),
    getter = jest.fn();
  Object.defineProperty(i.gas, 'gasPrice', { get: getter });
  expect(() => normalize(i.quote, i.gas)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() => normalize(new Proxy(i.quote, {}), input().gas)).toThrow();
});
test('absolute expiry and backward wall time refuse even without timer dispatch', () => {
  const i = input(),
    v = normalize(i.quote, i.gas);
  expect(() => assertQuoteCurrent(v, 199999, 190000)).not.toThrow();
  expect(() => assertQuoteCurrent(v, 200000, 190000)).toThrow();
  expect(() => assertQuoteCurrent(v, 190000, 190001)).toThrow();
});
test('result requires exact 91 guards, input digest and false authority flags', () => {
  const i = input(),
    b = normalize(i.quote, i.gas),
    hash = digest('input');
  const value = {
    inputSha256: hash,
    quoteSha256: b.quoteSha256,
    viewingPublicKey: '02'.repeat(32),
    masterPublicKey: '7',
    signatureVerified: true,
    operatorTrusted: false,
    spendingEnabled: false,
    disclosureEnabled: false,
    engineSha256: require('./railgun-engine-manifest.json').sha256,
    guards: JSON.parse(JSON.stringify(EXPECTED_GUARDS)),
  };
  expect(normalizeQuoteVerification(value, b, hash).signatureVerified).toBe(true);
  for (const mutate of [
    (v) => v.guards.hooks.pop(),
    (v) => v.guards.attempts++,
    (v) => (v.guards.canaries = 90),
    (v) => (v.inputSha256 = '00'.repeat(32)),
    (v) => (v.operatorTrusted = true),
    (v) => (v.signatureVerified = 1),
    (v) => (v.masterPublicKey = '0'),
  ]) {
    const copy = structuredClone(value);
    mutate(copy);
    expect(() => normalizeQuoteVerification(copy, b, hash)).toThrow();
  }
});
test('ordinary multi-token advert, omitted identifier and unknown reliability retain exact signed bytes', () => {
  const i = input();
  delete i.fields.identifier;
  i.fields.reliability = -1;
  i.fields.fees['0x' + '12'.repeat(20)] = '0xf4240';
  i.quote.data = Buffer.from(JSON.stringify(i.fields)).toString('hex');
  const value = normalize(i.quote, i.gas);
  expect(value.quote.data).toBe(i.quote.data);
  expect(value.feeAmount).toBe('100');
  expect(value.fields).not.toHaveProperty('identifier');
  expect(value.fields.reliability).toBe(-1);
  expect(Object.keys(value.fields.fees)).toHaveLength(2);
});
test.each(['missing-weth', 'uppercase', 'zero-rate', 'too-many', 'bad-reliability'])(
  'advertisement data refuses %s',
  (kind) => {
    const i = input();
    if (kind === 'missing-weth') delete i.fields.fees[pins.wrappedNative];
    if (kind === 'uppercase') i.fields.fees['0x' + 'AB'.repeat(20)] = '0x1';
    if (kind === 'zero-rate') i.fields.fees['0x' + '12'.repeat(20)] = '0x0';
    if (kind === 'too-many')
      for (let n = 1; n <= 32; n++) i.fields.fees['0x' + n.toString(16).padStart(40, '0')] = '0x1';
    if (kind === 'bad-reliability') i.fields.reliability = -0.5;
    i.quote.data = Buffer.from(JSON.stringify(i.fields)).toString('hex');
    expect(() => normalize(i.quote, i.gas)).toThrow();
  }
);
test('source Sepolia relay-adapt checksum spelling and empty advertised lists preserve raw signed bytes', () => {
  const i = input();
  i.fields.relayAdapt = '0x7e3d929EbD5bDC84d02Bd3205c777578f33A214D';
  i.fields.requiredPOIListKeys = [];
  i.quote.data = Buffer.from(JSON.stringify(i.fields)).toString('hex');
  const value = normalize(i.quote, i.gas);
  expect(value.fields.relayAdapt).toBe(i.fields.relayAdapt);
  expect(value.quote.data).toBe(i.quote.data);
  expect(value.fields.requiredPOIListKeys).toEqual([]);
});
test('wrong checksum spelling refuses without rewriting signed bytes', () => {
  const i = input();
  i.fields.relayAdapt = '0x7e3D929EbD5bDC84d02Bd3205c777578f33A214D';
  i.quote.data = Buffer.from(JSON.stringify(i.fields)).toString('hex');
  expect(() => normalize(i.quote, i.gas)).toThrow();
});
test.each([
  ['8.0.0', true],
  ['8.998.1234', true],
  ['8.999.0', true],
  ['8.999.1', false],
  ['8.1000.0', false],
  ['7.9.0', false],
])('source client compatibility boundary %s', (version, admitted) => {
  const i = input();
  i.fields.version = version;
  i.quote.data = Buffer.from(JSON.stringify(i.fields)).toString('hex');
  if (admitted) expect(normalize(i.quote, i.gas).fields.version).toBe(version);
  else expect(() => normalize(i.quote, i.gas)).toThrow();
});
