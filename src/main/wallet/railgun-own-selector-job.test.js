jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: jest.fn() }));
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
beforeEach(() => jest.clearAllMocks());
const { run } = require('./railgun-own-selector-job');
const field = '0x' + '1'.repeat(64);
const valid = () => ({
  archive: '/unused.asar',
  bindingDigest: '2'.repeat(64),
  facts: { nullifiers: [field], commitments: [field], boundParamsHash: field },
});
test.each([
  'extra',
  'binding',
  'nullifiers',
  'commitments',
  'field',
  'prefix',
  'extra-fact',
  'oversize',
])('refuses invalid %s before runtime loading or requests', async (mode) => {
  const input = valid();
  if (mode === 'extra') input.extra = true;
  if (mode === 'binding') input.bindingDigest = 'x';
  if (mode === 'nullifiers') input.facts.nullifiers.push(field);
  if (mode === 'commitments') input.facts.commitments = [];
  if (mode === 'field') input.facts.boundParamsHash = '0x' + 'f'.repeat(64);
  if (mode === 'prefix') input.facts.nullifiers[0] = field.slice(2);
  if (mode === 'extra-fact') input.facts.extra = true;
  if (mode === 'oversize') input.archive = 'x'.repeat(65536);
  const request = jest.fn();
  await expect(
    run(JSON.stringify(input), {
      request,
      signal: new AbortController().signal,
      guardReport: jest.fn(),
    })
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  expect(verifyRailgunEngineRuntime).not.toHaveBeenCalled();
});

test.each(['untagged-two', 'unknown-kind', 'partial-one', 'partial-three', 'partial-extra-fact'])(
  'refuses %s before the engine or any broker request',
  async (mode) => {
    const input = valid();
    input.intentKind = 'railgun-partial-unshield';
    input.facts.commitments.push(field);
    if (mode === 'untagged-two') delete input.intentKind;
    if (mode === 'unknown-kind') input.intentKind = 'railgun-private-transfer';
    if (mode === 'partial-one') input.facts.commitments.pop();
    if (mode === 'partial-three') input.facts.commitments.push(field);
    if (mode === 'partial-extra-fact') input.facts.unshieldAmount = '400';
    const request = jest.fn();
    await expect(
      run(JSON.stringify(input), {
        request,
        signal: new AbortController().signal,
        guardReport: jest.fn(),
      })
    ).rejects.toThrow();
    expect(verifyRailgunEngineRuntime).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  }
);
