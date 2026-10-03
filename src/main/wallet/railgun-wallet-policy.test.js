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
test('policy is location-independent but changes when the pinned engine or a wallet validator changes', () => {
  const first = getRailgunWalletPolicy('/first/engine.asar');
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(getRailgunWalletPolicy('/other/engine.asar')).toBe(first);
  const original = fs.readFileSync;
  const read = jest
    .spyOn(fs, 'readFileSync')
    .mockImplementation((name, ...args) =>
      String(name).endsWith('/railgun-wallet-records.js')
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
    require.resolve('./railgun-process'),
    require.resolve('./railgun-wallet-journal'),
    require.resolve('./privacy-storage'),
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
    'railgun-private-prepare-job',
    'railgun-wallet-runner',
    'railgun-wallet-run',
    'railgun-wallet-coverage-store',
    'railgun-wallet-state',
    'railgun-kohaku-read',
  ])
    walk(require.resolve('./' + root));
  expect(visited.size).toBe(22);
});
