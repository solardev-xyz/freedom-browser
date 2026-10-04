const {
  assertRailgunOwnPoiCapture: strict,
  assertRailgunOwnPoiStableCapture: stable,
} = require('./railgun-own-poi-binding');
const copy = (value) => JSON.parse(JSON.stringify(value));
// These are comparison fixtures, not genuine recovery or proof capabilities.
const capture = () => ({
  bindingDigest: 'binding',
  selector: { tree: 0, position: 1, nullifier: 'nullifier' },
  facts: { kind: 'railgun-private-transfer', amount: '1000' },
  submitter: 'submitter',
  capsule: { walletId: 'wallet', selection: { position: 1 } },
  capsuleDigest: 'capsule',
  provedTransaction: { to: 'proxy', data: '0x1234', value: '0' },
  intent: { digest: 'intent' },
  projection: { included: true, blockHash: 'block', transactionIndex: 0 },
  record: { state: 'submitted', revision: 1 },
});
const fields = [
  'bindingDigest',
  'selector',
  'facts',
  'submitter',
  'capsule',
  'capsuleDigest',
  'provedTransaction',
  'intent',
  'projection',
];
const archive = (number) => ({
  archivedAt: number,
  finalized: { number, hash: 'block-' + number },
});
describe.each([
  ['strict', strict],
  ['stable', stable],
])('%s capture comparison', (_name, compare) => {
  test('accepts detached identical facts without modifying either capture', () => {
    const baseline = capture(),
      current = copy(baseline),
      serialized = JSON.stringify(baseline);
    expect(() => compare(current, baseline)).not.toThrow();
    expect(JSON.stringify(current)).toBe(serialized);
    expect(JSON.stringify(baseline)).toBe(serialized);
  });
  test.each(fields)('rejects changed %s', (field) => {
    const baseline = capture(),
      current = copy(baseline);
    baseline.record = archive(300);
    current.record = archive(300);
    current[field] =
      typeof current[field] === 'string'
        ? current[field] + '-changed'
        : { ...current[field], changedStableField: true };
    expect(() => compare(current, baseline)).toThrow();
  });
  test.each(fields)('rejects missing %s', (field) => {
    const baseline = capture(),
      current = copy(baseline);
    const { [field]: _removed, ...missing } = current;
    expect(() => compare(missing, baseline)).toThrow();
  });
  test('accepts routine active journal metadata changes', () => {
    const baseline = capture(),
      current = copy(baseline);
    current.record.revision = 2;
    current.record.confirmations = 12;
    expect(() => compare(current, baseline)).not.toThrow();
  });
});
test.each(['active to archived', 'archived anchor refresh'])(
  '%s is accepted only by stable comparison',
  (transition) => {
    const baseline = capture(),
      current = copy(baseline);
    if (transition === 'archived anchor refresh') baseline.record = archive(300);
    current.record = archive(301);
    expect(() => stable(current, baseline)).not.toThrow();
    expect(() => strict(current, baseline)).toThrow();
  }
);
test('both comparisons allow archival timestamp refresh with unchanged checked anchor', () => {
  const baseline = capture(),
    current = copy(baseline);
  baseline.record = archive(300);
  current.record = { ...archive(300), archivedAt: 301 };
  expect(() => stable(current, baseline)).not.toThrow();
  expect(() => strict(current, baseline)).not.toThrow();
});
