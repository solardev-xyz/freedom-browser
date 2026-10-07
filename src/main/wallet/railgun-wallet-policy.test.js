jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: jest.fn((p) => p) }));
const fs = require('fs');
const path = require('path');
const { getRailgunWalletPolicy } = require('./railgun-wallet-policy');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const engine = require('./railgun-engine-manifest.json');
const adapter = path.dirname(require.resolve('@freedom/railgun-kohaku-adapter/read'));
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
  expect(
    read.mock.calls.filter(
      ([name]) =>
        String(name).includes('/src/main/wallet/') || String(name).startsWith(adapter + path.sep)
    )
  ).toEqual([]);
});
test.each([
  'package.json',
  'host-poi.cjs',
  'src/data/railgun-poi-records.js',
  'src/data/railgun-poi-payload.js',
  'src/data/railgun-poi-creator-data.js',
  'src/data/railgun-poi-shield-selector-data.js',
  'src/data/railgun-poi-transact-selector-data.js',
  'src/data/railgun-own-poi-binding.js',
  'src/data/railgun-own-poi-shape-data.js',
  'src/data/railgun-owned-poi-records.js',
  'src/data/railgun-poi-submit-data.js',
  'src/data/railgun-txid-note-witness.js',
  'src/data/railgun-txid-projection.js',
  'src/data/railgun-txid-omissions.js',
  'src/data/railgun-own-poi-payload-binding.js',

  'read.cjs',
  'host-data.cjs',
  'src/data/railgun-private-policy.js',
  'src/data/railgun-private-intent.js',
  'src/data/railgun-private-offer.js',
  'src/data/railgun-private-capsule.js',
  'src/data/railgun-private-destination.js',
  'src/data/railgun-private-signature.js',
  'src/data/railgun-private-preparation.js',
  'src/data/railgun-private-results.js',
  'src/data/railgun-private-recovery-data.js',
  'src/railgun-engine-manifest.json',
  'src/railgun-prover-manifest.json',
  'src/railgun-shield-pins.json',
  'src/railgun-kohaku-read-data.js',
  'src/railgun-kohaku-read-dispatch.js',
])('policy binds the installed adapter %s that Freedom data wrappers load', (name) => {
  const first = getRailgunWalletPolicy('/first/engine.asar');
  const filename = path.join(adapter, name);
  const original = fs.readFileSync;
  jest
    .spyOn(fs, 'readFileSync')
    .mockImplementation((file, ...args) =>
      file === filename ? Buffer.from('changed validation') : original(file, ...args)
    );
  expect(getRailgunWalletPolicy('/first/engine.asar')).not.toBe(first);
  fs.readFileSync.mockRestore();
  expect(getRailgunWalletPolicy('/first/engine.asar')).toBe(first);
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
    for (const [, name] of text.matchAll(
      /require\(['"]((?:\.\.?\/|@freedom\/railgun-kohaku-adapter)[^'"]*)['"]\)/g
    )) {
      // Package re-exports are traversed into the installed files they load.
      const dependency = name.startsWith('.')
        ? require.resolve(path.resolve(path.dirname(filename), name))
        : require.resolve(name, { paths: [path.dirname(filename)] });
      if (path.dirname(dependency) === __dirname || dependency.startsWith(adapter + path.sep))
        walk(dependency);
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
  expect(visited.size).toBe(87);
  expect([...visited].filter((name) => name.startsWith(adapter + path.sep)).sort()).toEqual(
    [
      'read.cjs',
      'src/railgun-kohaku-read-data.js',
      'src/railgun-kohaku-read-dispatch.js',
      'host-data.cjs',
      'host-poi.cjs',
      'src/data/railgun-poi-records.js',
      'src/data/railgun-poi-payload.js',
      'src/data/railgun-poi-creator-data.js',
      'src/data/railgun-poi-shield-selector-data.js',
      'src/data/railgun-poi-transact-selector-data.js',
      'src/data/railgun-own-poi-binding.js',
      'src/data/railgun-own-poi-shape-data.js',
      'src/data/railgun-owned-poi-records.js',
      'src/data/railgun-poi-submit-data.js',
      'src/data/railgun-txid-note-witness.js',
      'src/data/railgun-txid-projection.js',
      'src/data/railgun-txid-omissions.js',
      'src/data/railgun-own-poi-payload-binding.js',

      'src/data/railgun-private-policy.js',
      'src/data/railgun-private-intent.js',
      'src/data/railgun-private-offer.js',
      'src/data/railgun-private-capsule.js',
      'src/data/railgun-private-destination.js',
      'src/data/railgun-private-signature.js',
      'src/data/railgun-private-preparation.js',
      'src/data/railgun-private-results.js',
      'src/data/railgun-private-recovery-data.js',
      'src/railgun-engine-manifest.json',
      'src/railgun-prover-manifest.json',
      'src/railgun-shield-pins.json',
    ]
      .map((name) => path.join(adapter, name))
      .sort()
  );
  // The exports map in package.json selects which installed file runs.
  expect(included.has(path.join(adapter, 'package.json'))).toBe(true);
});

// The extraction is staged: main/legacy helpers and kernel helpers are separate
// implementations with disjoint issuers, both bound by this derived-cache policy.
const provenance = JSON.parse(
  fs.readFileSync(path.join(adapter, 'docs/execution/PROVENANCE.json'), 'utf8')
);
const hash = (bytes) => require('crypto').createHash('sha256').update(bytes).digest('hex');
test('all forty retained source and installed destination pins match the reviewed staged provenance', () => {
  expect(provenance.files).toHaveLength(40);
  expect(provenance.freedomIntegrationBasis.revision).toBe(
    '0f2616b28062d5b107a361bfa0e9fdb876f8def9'
  );
  expect(
    provenance.files.filter((row) => row.integrationSourceChange === 'existing .3/.4 data wrapper')
  ).toHaveLength(6);
  const read = jest.spyOn(fs, 'readFileSync');
  getRailgunWalletPolicy('/engine.asar');
  const included = new Set(read.mock.calls.map(([name]) => name));
  read.mockRestore();
  for (const row of provenance.files) {
    const local = path.resolve(__dirname, '../../..', row.source);
    const installed = path.join(adapter, row.destination);
    expect(included.has(local)).toBe(true);
    expect(included.has(installed)).toBe(true);
    expect(hash(fs.readFileSync(local))).toBe(row.integrationSourceSha256);
    expect(hash(fs.readFileSync(installed))).toBe(row.sha256);
  }
});
test.each(provenance.files.map((row) => [row.source, row]))(
  'policy binds both staged implementations of %s',
  (_name, row) => {
    const original = fs.readFileSync,
      first = getRailgunWalletPolicy('/engine.asar');
    for (const file of [
      path.resolve(__dirname, '../../..', row.source),
      path.join(adapter, row.destination),
    ]) {
      const read = jest
        .spyOn(fs, 'readFileSync')
        .mockImplementation((name, ...args) =>
          name === file ? Buffer.from('changed staged implementation') : original(name, ...args)
        );
      try {
        expect(getRailgunWalletPolicy('/engine.asar')).not.toBe(first);
      } finally {
        read.mockRestore();
      }
    }
  }
);
test('installed kernel fixed bootstrap and job imports remain inside the pinned package closure', () => {
  const read = jest.spyOn(fs, 'readFileSync');
  getRailgunWalletPolicy('/engine.asar');
  const included = new Set(read.mock.calls.map(([name]) => name));
  read.mockRestore();
  const visited = new Set();
  function walk(file) {
    if (visited.has(file)) return;
    visited.add(file);
    expect(included.has(file)).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    for (const [, name] of text.matchAll(/require\(['"](\.\.?\/[^'"]*)['"]\)/g)) {
      const target = require.resolve(path.resolve(path.dirname(file), name));
      expect(target.startsWith(adapter + path.sep)).toBe(true);
      walk(target);
    }
  }
  walk(require.resolve('@freedom/railgun-kohaku-adapter/host/bootstrap'));
  walk(require.resolve('@freedom/railgun-kohaku-adapter/host/execution'));
  const locate = require('@freedom/railgun-kohaku-adapter/host/execution').getRailgunExecutionJob;
  for (const purpose of [
    'spending-public',
    'viewing-identity',
    'spending-sign',
    'wallet-viewing',
    'private-prepare',
    'private-operate',
    'private-recover',
    'private-receive',
    'private-verify',
  ])
    walk(locate(purpose));
  expect(visited.has(path.join(adapter, 'src/execution/host-bindings.js'))).toBe(true);
  expect(visited.has(path.join(adapter, 'src/execution/railgun-artifacts.js'))).toBe(true);
  expect(visited.has(path.join(adapter, 'src/execution/railgun-private-reconstruct.js'))).toBe(
    true
  );
  expect(visited.has(path.join(adapter, 'src/data/railgun-private-signature.js'))).toBe(true);
  // Dynamic authenticated archive entries are covered by their unchanged fixed
  // engine/prover manifests and loaders, not treated as local literal imports.
  expect(visited.has(path.join(adapter, 'src/execution/railgun-engine-manifest.json'))).toBe(true);
  expect(visited.has(path.join(adapter, 'src/execution/railgun-prover-manifest.json'))).toBe(true);
});
