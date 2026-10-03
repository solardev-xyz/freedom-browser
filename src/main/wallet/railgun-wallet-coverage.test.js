const {
  checkpointHash,
  assertRailgunWalletCheckpointFollows,
  normalizeRailgunWalletCoverage,
  summarizeRailgunWalletCoverage,
  assertRailgunWalletCoverageExtends,
} = require('./railgun-wallet-coverage');
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
function plan(count = 5) {
  return {
    from: 0,
    previousHash: hash(0),
    to: { number: 10, hash: hash(10) },
    anchor: { number: 100, hash: hash(100) },
    logs: { count, sha256: 'a'.repeat(64) },
    source: {
      level: 'unverified-rpc',
      providersSha256: 'b'.repeat(64),
      ledgerId: 'c'.repeat(64),
      ledgerSha256: 'd'.repeat(64),
    },
    state: {
      schema: 'public-records-v1',
      storeId: 'e'.repeat(64),
      trees: [{ tree: 0, length: count, root: hash(count) }],
      commitments: { count, sha256: 'f'.repeat(64) },
      nullifiers: { count: 0, sha256: '1'.repeat(64) },
      unshields: { count: 0, sha256: '2'.repeat(64) },
    },
  };
}
function values() {
  return {
    scannedLeaves: 5,
    expectedReceived: [
      { tree: 0, position: 1 },
      { tree: 0, position: 0 },
    ],
    expectedSent: [{ tree: 0, position: 1 }],
    quarantine: [{ tree: 0, position: 3, txid: hash(3), reason: 'commitment-mismatch' }],
    unrecoverableSent: [{ tree: 0, position: 4, txid: hash(4), reason: 'sent-note-unrecoverable' }],
  };
}
test('canonical sets are immutable, order-independent and keep self-transfers in both sets', () => {
  const input = values(),
    first = normalizeRailgunWalletCoverage(plan(), input);
  input.expectedReceived.reverse();
  const second = normalizeRailgunWalletCoverage(plan(), input);
  expect(first).toEqual(second);
  expect(first.expectedReceived[0].position).toBe(0);
  expect(Object.isFrozen(first.quarantine[0])).toBe(true);
  expect(summarizeRailgunWalletCoverage(first)).toEqual(summarizeRailgunWalletCoverage(second));
  expect(summarizeRailgunWalletCoverage(first).expectedSent.count).toBe(1);
});
test.each([
  'duplicate',
  'outside',
  'wrong-reason',
  'unknown-field',
  'missing-history',
  'overlap',
  'invalid-txid',
])('refuses %s rather than issuing coverage', (mode) => {
  const value = values();
  if (mode === 'duplicate') value.expectedReceived.push({ tree: 0, position: 0 });
  if (mode === 'outside') value.expectedSent[0].position = 5;
  if (mode === 'wrong-reason') value.unrecoverableSent[0].reason = 'commitment-mismatch';
  if (mode === 'unknown-field') value.spendableGranted = true;
  if (mode === 'missing-history') value.scannedLeaves = 4;
  if (mode === 'overlap') value.quarantine[0].position = 1;
  if (mode === 'invalid-txid') value.quarantine[0].txid = 'untrusted';
  expect(() => normalizeRailgunWalletCoverage(plan(), value)).toThrow();
});
test('set summaries distinguish receive quarantine from sent-only diagnostics', () => {
  const value = normalizeRailgunWalletCoverage(plan(), values()),
    summary = summarizeRailgunWalletCoverage(value);
  expect(summary.quarantine.sha256).not.toBe(summary.unrecoverableSent.sha256);
});
test('later coverage must preserve every earlier classification and cannot shrink history', () => {
  const previous = normalizeRailgunWalletCoverage(plan(), values()),
    next = values();
  next.scannedLeaves = 6;
  next.expectedReceived.push({ tree: 0, position: 5 });
  expect(() =>
    assertRailgunWalletCoverageExtends(previous, normalizeRailgunWalletCoverage(plan(6), next))
  ).not.toThrow();
  next.expectedReceived.shift();
  expect(() =>
    assertRailgunWalletCoverageExtends(previous, normalizeRailgunWalletCoverage(plan(6), next))
  ).toThrow();
});
test('checkpoint content excludes provider provenance but includes the source ledger hash', () => {
  const first = plan(),
    second = plan();
  second.source.providersSha256 = '9'.repeat(64);
  expect(checkpointHash(first)).toBe(checkpointHash(second));
  second.source.ledgerSha256 = '8'.repeat(64);
  expect(checkpointHash(first)).not.toBe(checkpointHash(second));
});

test.each(['ledger', 'store', 'anchor', 'root', 'shrink', 'count'])(
  'higher block cannot bypass %s lineage',
  (mode) => {
    const old = plan(),
      next = plan();
    next.to = { number: 20, hash: hash(20) };
    if (mode === 'ledger') next.source.ledgerId = '9'.repeat(64);
    if (mode === 'store') next.state.storeId = '9'.repeat(64);
    if (mode === 'anchor') next.anchor.hash = hash(101);
    if (mode === 'root') next.state.trees[0].root = hash(99);
    if (mode === 'shrink') next.state.trees[0].length--;
    if (mode === 'count') {
      old.state.nullifiers.count = 1;
    }
    expect(() => assertRailgunWalletCheckpointFollows(old, next)).toThrow();
  }
);
