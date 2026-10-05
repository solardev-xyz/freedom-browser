jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
}));
const { create } = require('./railgun-combined-poi-second-recovery-storage');
const copy = (v) => JSON.parse(JSON.stringify(v));
function sample() {
  const second = {
    entry: { id: 'second' },
    stored: {
      holdId: 'second',
      signature: ['original'],
      capsule: { data: 'original' },
      provedTransaction: null,
    },
  };
  const before = {
    version: 1,
    sequence: 7,
    lease: 'retained',
    entries: [{ holdId: 'first', provedTransaction: { first: true } }, second.stored],
  };
  const after = copy(before);
  after.sequence++;
  after.entries[1].provedTransaction = { data: 'proof' };
  return { second, before, after };
}
test('one original proof slot and following floor, no lease or first-record change', () => {
  const { second, before, after } = sample(),
    o = create();
  o.arm(second);
  o.inspect(
    'railgun-private-capsules-v1',
    JSON.stringify(before),
    JSON.stringify(after),
    'capsules'
  );
  o.inspect(
    'railgun-private-capsules-floor-v1',
    JSON.stringify({ version: 1, binding: 'same', sequence: 7 }),
    JSON.stringify({ version: 1, binding: 'same', sequence: 8 }),
    'manifest'
  );
  o.assertComplete();
  expect(o.report()).toEqual({
    proofWrites: 1,
    floorWrites: 1,
    files: ['capsules', 'manifest'],
  });
  expect(() =>
    o.inspect(
      'railgun-private-capsules-v1',
      JSON.stringify(before),
      JSON.stringify(after),
      'capsules'
    )
  ).toThrow();
});
test.each(['signature', 'capsule', 'first', 'lease', 'sequence', 'wrong-slot', 'missing-proof'])(
  'recovery write cannot mutate %s',
  (fault) => {
    const { second, before, after } = sample(),
      o = create();
    o.arm(second);
    if (fault === 'signature') after.entries[1].signature = ['new'];
    if (fault === 'capsule') after.entries[1].capsule.data = 'new';
    if (fault === 'first') after.entries[0].provedTransaction = { changed: true };
    if (fault === 'lease') after.lease = 'new';
    if (fault === 'sequence') after.sequence++;
    if (fault === 'wrong-slot') after.entries[1].holdId = 'other';
    if (fault === 'missing-proof') after.entries[1].provedTransaction = null;
    expect(() =>
      o.inspect(
        'railgun-private-capsules-v1',
        JSON.stringify(before),
        JSON.stringify(after),
        'capsules'
      )
    ).toThrow();
  }
);
test.each(['floor-first', 'floor-skips', 'floor-binding', 'other-record'])(
  'rejects %s',
  (fault) => {
    const { second, before, after } = sample(),
      o = create();
    o.arm(second);
    if (fault !== 'floor-first')
      o.inspect(
        'railgun-private-capsules-v1',
        JSON.stringify(before),
        JSON.stringify(after),
        'capsules'
      );
    const old = { version: 1, binding: 'same', sequence: 7 },
      next = { ...old, sequence: 8 };
    if (fault === 'floor-skips') next.sequence = 9;
    if (fault === 'floor-binding') next.binding = 'other';
    expect(() =>
      o.inspect(
        fault === 'other-record'
          ? 'railgun-private-reservations-v1'
          : 'railgun-private-capsules-floor-v1',
        JSON.stringify(old),
        JSON.stringify(next),
        'manifest'
      )
    ).toThrow();
  }
);
test('rejected/unobserved storage never satisfies complete', () => {
  const { second, before, after } = sample(),
    o = create();
  o.arm(second);
  expect(() => o.assertComplete()).toThrow();
  o.inspect(
    'railgun-private-capsules-v1',
    JSON.stringify(before),
    JSON.stringify(after),
    'capsules'
  );
  expect(() => o.assertComplete()).toThrow();
});
