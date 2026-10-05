jest.mock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
const { expected, assertCounts, canonical } = require('./railgun-public-cold-counts');
const baseline = { from: 0, to: 3, anchor: { number: 100 } },
  next = { from: 4, to: 4, anchor: { number: 100 } };
const actual = (w) => ({
  attempted: {
    source: { ...w.source },
    deployment: { ...w.deployment },
    transaction: { ...w.transaction },
  },
  validated: {
    source: { ...w.source },
    deployment: { ...w.deployment },
    transaction: { ...w.transaction },
  },
  jobs: { ...w.jobs },
  keyPurposes: { ...w.keyPurposes },
  workers: w.workers,
  workerKinds: { ...w.workerKinds },
  viewing: w.viewing,
  eoaSigns: w.eoaSigns,
  credentialBuffersWiped: true,
  unexpected: 0,
});
test('canonical deduplicates boundary/anchor and includes finalized', () => {
  expect(canonical(baseline)).toBe(4);
  expect(canonical(next)).toBe(4);
  expect(canonical({ from: 0, to: 0, anchor: { number: 0 } })).toBe(2);
});
for (const phase of ['setup', 'resolve', 'restore']) {
  const w = expected(phase, baseline, next, 3);
  test(phase + ' exact map', () => {
    assertCounts(actual(w), w);
  });
  for (const lane of ['source', 'deployment', 'transaction'])
    for (const mutation of ['missing', 'extra'])
      test(phase + ' balanced ' + lane + ' ' + mutation, () => {
        const a = actual(w),
          key = Object.keys(a.attempted[lane])[0] ?? 'eth_call';
        if (mutation === 'missing' && Object.keys(a.attempted[lane]).length) {
          delete a.attempted[lane][key];
          delete a.validated[lane][key];
        } else {
          a.attempted[lane][key] = (a.attempted[lane][key] ?? 0) + 1;
          a.validated[lane][key] = a.attempted[lane][key];
        }
        expect(() => assertCounts(a, w)).toThrow();
      });
  test.each(['jobs', 'workers', 'viewing', 'eoaSigns', 'credentialBuffersWiped', 'unexpected'])(
    phase + ' wrong %s',
    (key) => {
      const a = actual(w);
      if (key === 'jobs') a.jobs['railgun-private-operate-job'] = 1;
      else if (key === 'credentialBuffersWiped') a[key] = false;
      else a[key]++;
      expect(() => assertCounts(a, w)).toThrow();
    }
  );
}
test('recovery map includes missing, bad cipher, observe and resolve all canonical reads', () =>
  expect(expected('resolve', baseline, next, 3).transaction).toEqual({
    eth_chainId: 1,
    eth_getTransactionReceipt: 12,
    eth_getTransactionByHash: 5,
    eth_getBlockByNumber: 14,
    eth_blockNumber: 9,
  }));

test('setup counts every initializer plus published reopen and denied-review wallet reopen', () => {
  const value = expected('setup', baseline, next, 3);
  expect(value.workers).toBe(7);
  expect(value.workerKinds).toEqual({
    'source.initialize': 1,
    'source.open': 1,
    'public.initialize': 1,
    'public.open': 1,
    'wallet.initialize': 1,
    'wallet.open': 2,
  });
});
for (const phase of ['setup', 'resolve', 'restore']) {
  test.each(['omit', 'extra', 'balanced-substitution'])(
    phase + ' refuses worker category %s',
    (mode) => {
      const w = expected(phase, baseline, next, 3),
        a = actual(w);
      if (mode === 'omit') delete a.workerKinds['source.open'];
      if (mode === 'extra') a.workerKinds['source.open']++;
      if (mode === 'balanced-substitution') {
        a.workerKinds['source.open']--;
        a.workerKinds['wallet.initialize'] = (a.workerKinds['wallet.initialize'] ?? 0) + 1;
      }
      // Total stays correct: checking only workers would miss these changes.
      expect(a.workers).toBe(w.workers);
      expect(() => assertCounts(a, w)).toThrow();
    }
  );
}
test('completed restore specifically requires read-only wallet rather than writable reopen', () => {
  const w = expected('restore', baseline, next, 3),
    a = actual(w);
  delete a.workerKinds['wallet.readOnly'];
  a.workerKinds['wallet.open'] = 1;
  expect(() => assertCounts(a, w)).toThrow();
});
