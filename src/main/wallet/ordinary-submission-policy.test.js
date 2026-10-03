const { Transaction } = require('ethers');
const {
  ordinaryFacts,
  assertOrdinaryRequest,
  validOrdinaryFacts,
  isClassifiedOrdinary,
} = require('./ordinary-submission-policy');
const pins = require('./ppv2-sepolia-pins.json');
const to = `0x${'22'.repeat(20)}`;
const tx = { chainId: 11155111, to, gasPrice: 1n, gasLimit: 21000n, value: 1n, nonce: 0, type: 0 };
const targets = [
  ...Object.values(pins.contracts).flatMap((c) => [c.address, c.implementation?.address]),
  ...Object.values(pins.verifiers).map((c) => c.address),
].filter(Boolean);

test.each(targets)('refuses pinned protocol target %s', (target) => {
  expect(() => assertOrdinaryRequest({ ...tx, to: target })).toThrow(
    expect.objectContaining({ code: 'PRIVATE_ORDINARY_TRANSACTION_REFUSED' })
  );
  expect(() => ordinaryFacts(Transaction.from({ ...tx, to: target }))).toThrow();
});
test.each([{ type: 4 }, { type: 3 }, { authorizationList: [] }, { to: null }])(
  'refuses unsupported request %j',
  (extra) => {
    expect(() => assertOrdinaryRequest({ ...tx, ...extra })).toThrow();
  }
);
test.each(['0x', '0xa9059cbb00000000'])(
  'records canonical calldata selector facts for %s',
  (data) => {
    const facts = ordinaryFacts({ ...tx, data });
    expect(facts).toEqual({
      to,
      selector: data === '0x' ? null : '0xa9059cbb',
      type: 0,
      senderCode: '0x',
      trust: 'unverified-rpc',
    });
    expect(validOrdinaryFacts(facts)).toBe(true);
    expect(isClassifiedOrdinary({ route: 'ordinary', ordinary: facts })).toBe(true);
    for (const changed of [
      { extra: true },
      { type: 4 },
      { senderCode: '0xef01' },
      { trust: 'verified' },
      { selector: '0x01' },
    ])
      expect(validOrdinaryFacts({ ...facts, ...changed })).toBe(false);
  }
);
test('classification reevaluates deployment targets without rewriting encrypted facts', () => {
  const record = { route: 'ordinary', ordinary: ordinaryFacts(tx) };
  pins.contracts.testOnly = { address: to };
  try {
    expect(isClassifiedOrdinary(record)).toBe(false);
  } finally {
    delete pins.contracts.testOnly;
  }
  expect(isClassifiedOrdinary(record)).toBe(true);
  expect(isClassifiedOrdinary({ ...record, intent: { kind: 'ppv2-native-deposit' } })).toBe(false);
});

test('refusal set covers all twelve current deployment addresses', () => {
  expect(new Set(targets).size).toBe(12);
});
