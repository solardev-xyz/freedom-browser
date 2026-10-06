const {
  createResultBroker,
  assertVerification,
  EXPECTED_GUARDS,
} = require('../qualify-railgun-relay-proof');
const signal = new AbortController().signal;
test('result-only broker returns original bounded value, refuses second request stickily', async () => {
  const validate = jest.fn(),
    reader = createResultBroker(signal, validate);
  const wire = JSON.stringify({ id: 1, method: 'result', value: { public: true } });
  expect(() => reader.result()).toThrow();
  expect(await reader.broker.dispatch(wire)).toBe('{"id":1,"value":null}');
  expect(reader.result()).toBe(validate.mock.calls[0][0]);
  await expect(reader.broker.dispatch(wire)).rejects.toThrow('broker refused');
  expect(() => reader.result()).toThrow();
});
test.each(['key', 'storage', 'fetch', 'rpc', 'sign'])(
  'broker refuses %s before callback and later healthy-looking result cannot erase it',
  async (method) => {
    const validate = jest.fn(),
      reader = createResultBroker(signal, validate);
    await expect(
      reader.broker.dispatch(JSON.stringify({ id: 1, method, value: {} }))
    ).rejects.toThrow();
    expect(validate).not.toHaveBeenCalled();
    await reader.broker.dispatch(JSON.stringify({ id: 1, method: 'result', value: {} }));
    expect(() => reader.result()).toThrow();
  }
);
test('shape validation failure is sticky without exposing raw error details', async () => {
  const reader = createResultBroker(signal, () => {
    throw new Error('private detail');
  });
  await expect(reader.broker.dispatch('{"id":1,"method":"result","value":{}}')).rejects.toThrow(
    'Relay fixture broker refused'
  );
  expect(() => reader.result()).toThrow();
});
const report = {
  minGasPrice: 1,
  transactionVerified: true,
  prePoiVerified: true,
  feeAndSelfCommitmentsMatched: true,
  sameTransactionPrePoiRootMatched: true,
  syntheticListRootMatched: true,
  productionPolicyRefused: true,
  productionPayloadRefused: true,
  changedSignalsRefused: 13,
  authorityGranted: false,
  serviceAcceptanceQualified: false,
  guards: EXPECTED_GUARDS,
};
test('report admits the complete independent verification contract', () =>
  expect(() => assertVerification(report, 1)).not.toThrow());
test.each(Object.keys(report).filter((k) => k !== 'guards'))('report rejects altered %s', (key) => {
  const v = { ...report, [key]: typeof report[key] === 'boolean' ? !report[key] : report[key] + 1 };
  expect(() => assertVerification(v, 1)).toThrow();
});
test('report refuses guard attempt and missing checks', () => {
  expect(() =>
    assertVerification({ ...report, guards: { attempts: 1, canaries: 1, hooks: ['x'] } }, 1)
  ).toThrow();
  const { prePoiVerified: _unused, ...missing } = report;
  expect(() => assertVerification(missing, 1)).toThrow();
});

test.each(['missing', 'replaced', 'extra', 'reordered', 'canary'])(
  'both guard catalogs refuse %s drift',
  (kind) => {
    const guards = { ...EXPECTED_GUARDS, hooks: [...EXPECTED_GUARDS.hooks] };
    if (kind === 'missing') guards.hooks.pop();
    if (kind === 'replaced') guards.hooks[0] = 'unknown.hook';
    if (kind === 'extra') guards.hooks.push('unknown.hook');
    if (kind === 'reordered') guards.hooks.reverse();
    if (kind === 'canary') guards.canaries--;
    expect(() => assertVerification({ ...report, guards }, 1)).toThrow();
  }
);
