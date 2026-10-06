jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: jest.fn((p) => p) }));
const fs = require('fs');
const path = require('path');
const { getRailgunWalletPolicy } = require('./railgun-wallet-policy');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const engine = require('./railgun-engine-manifest.json');
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});
test.each([
  'railgun-wallet-records',
  'railgun-kohaku-read-data',
  'railgun-relay-wallet-job',
  'railgun-relay-wallet-data',
  'railgun-relay-witness',
  'railgun-relay-reconstruct',
  'railgun-relay-intent',
  'railgun-relay-capsule',
  'railgun-relay-quote-data',
  'railgun-relay-review-summary',
  'railgun-relay-pre-poi-job',
  'railgun-relay-pre-poi-witness',
  'railgun-relay-proof-results',
  'railgun-relay-proof-verifier',
  'railgun-relay-recovery-data',
  'railgun-relay-proof',
  'railgun-private-destination',
])('policy is location-independent but binds the engine and %s bytes', (validator) => {
  const first = getRailgunWalletPolicy('/first/engine.asar');
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(getRailgunWalletPolicy('/other/engine.asar')).toBe(first);
  const original = fs.readFileSync;
  const read = jest
    .spyOn(fs, 'readFileSync')
    .mockImplementation((name, ...args) =>
      String(name).endsWith('/' + validator + '.js')
        ? Buffer.from('changed validation')
        : original(name, ...args)
    );
  expect(getRailgunWalletPolicy('/first/engine.asar')).not.toBe(first);
  read.mockRestore();
  const saved = engine.sha256;
  try {
    engine.sha256 = 'f'.repeat(64);
    expect(getRailgunWalletPolicy('/first/engine.asar')).not.toBe(first);
  } finally {
    engine.sha256 = saved;
  }
  expect(getRailgunWalletPolicy('/first/engine.asar')).toBe(first);
});
test('an unauthenticated archive cannot obtain a wallet policy', () => {
  verifyRailgunEngineRuntime.mockImplementationOnce(() => {
    throw Error('archive');
  });
  const read = jest.spyOn(fs, 'readFileSync');
  expect(() => getRailgunWalletPolicy('/bad/engine.asar')).toThrow('archive');
  expect(read.mock.calls.filter(([name]) => String(name).includes('/src/main/wallet/'))).toEqual(
    []
  );
});
test('local wallet job and host validation dependencies are pinned or cross explicit infrastructure boundaries', () => {
  const read = jest.spyOn(fs, 'readFileSync');
  getRailgunWalletPolicy('/engine.asar');
  const included = new Set(read.mock.calls.map(([name]) => name));
  read.mockRestore();
  const terminal = new Set([
    require.resolve('./railgun-engine-runtime'),
    require.resolve('./railgun-engine-manifest.json'),
    require.resolve('./railgun-identity'),
    // Enrollment owns the genuine account/fence, not derived scan semantics.
    require.resolve('./railgun-account-enrollment'),
    require.resolve('./railgun-process'),
    // Worker transport/storage provenance is an infrastructure boundary;
    // derived wallet and recovery semantics remain traversed and source-pinned.
    require.resolve('./railgun-session-worker'),
    require.resolve('./railgun-wallet-journal'),
    require.resolve('./privacy-storage'),
    require.resolve('./privacy-artifacts'),
  ]);
  const visited = new Set();
  function walk(filename) {
    if (visited.has(filename) || terminal.has(filename)) return;
    visited.add(filename);
    expect(included.has(filename)).toBe(true);
    const text = fs.readFileSync(filename, 'utf8');
    for (const [, name] of text.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)) {
      const dependency = require.resolve(path.resolve(path.dirname(filename), name));
      if (path.dirname(dependency) === __dirname) walk(dependency);
    }
  }
  for (const root of [
    'railgun-wallet-job',
    'railgun-relay-wallet-job',
    'railgun-relay-review-summary',
    'railgun-private-prepare-job',
    'railgun-private-operate-job',
    'railgun-private-recover-job',
    'railgun-private-recovery-data',
    'railgun-wallet-runner',
    'railgun-wallet-run',
    'railgun-wallet-coverage-store',
    'railgun-wallet-state',
    'railgun-kohaku-read',
    'railgun-relay-pre-poi-job',
    'railgun-relay-prove-job',
    'railgun-relay-verify-job',
    'railgun-relay-proof',
  ])
    walk(require.resolve('./' + root));
  expect(visited.size).toBe(57);
});
