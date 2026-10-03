jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: jest.fn((p) => p) }));
const fs = require('fs');
const path = require('path');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const engine = require('./railgun-engine-manifest.json');
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});
test('policy is location-independent but changes when the pinned engine or a public validator changes', () => {
  const first = getRailgunPublicPolicy('/first/engine.asar');
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(getRailgunPublicPolicy('/other/engine.asar')).toBe(first);
  const original = fs.readFileSync;
  const read = jest
    .spyOn(fs, 'readFileSync')
    .mockImplementation((name, ...args) =>
      String(name).endsWith('/railgun-public-records.js')
        ? Buffer.from('changed validation')
        : original(name, ...args)
    );
  expect(getRailgunPublicPolicy('/first/engine.asar')).not.toBe(first);
  read.mockRestore();
  const saved = engine.sha256;
  try {
    engine.sha256 = 'f'.repeat(64);
    expect(getRailgunPublicPolicy('/first/engine.asar')).not.toBe(first);
  } finally {
    engine.sha256 = saved;
  }
  expect(getRailgunPublicPolicy('/first/engine.asar')).toBe(first);
});
test('an unauthenticated archive cannot obtain a public policy', () => {
  verifyRailgunEngineRuntime.mockImplementationOnce(() => {
    throw Error('archive');
  });
  const read = jest.spyOn(fs, 'readFileSync');
  expect(() => getRailgunPublicPolicy('/bad/engine.asar')).toThrow('archive');
  expect(read.mock.calls.filter(([name]) => String(name).includes('/src/main/wallet/'))).toEqual(
    []
  );
});
test('public job and host transport dependency closure is pinned with explicit infrastructure terminals', () => {
  const { SOURCES } = require('./railgun-public-policy');
  const included = new Set(SOURCES.map((name) => require.resolve('./' + name)));
  const terminals = new Set(
    [
      'railgun-engine-runtime',
      'railgun-engine-manifest.json',
      'railgun-process',
      'privacy-storage',
      'railgun-session-worker',
      'railgun-account-store',
      'railgun-account-enrollment',
      'railgun-store-owners',
      'railgun-account-public',
      'railgun-public-catalog',
    ].map((name) => require.resolve('./' + name))
  );
  const visited = new Set();
  function walk(filename) {
    if (visited.has(filename) || terminals.has(filename)) return;
    visited.add(filename);
    expect(included.has(filename)).toBe(true);
    for (const [, name] of fs
      .readFileSync(filename, 'utf8')
      .matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)) {
      const dependency = require.resolve(path.resolve(path.dirname(filename), name));
      if (path.dirname(dependency) === __dirname) walk(dependency);
    }
  }
  walk(require.resolve('./railgun-public-run'));
  walk(require.resolve('./railgun-public-job'));
  walk(require.resolve('./railgun-scan-coordinator'));
  walk(require.resolve('./railgun-scan-source'));
  walk(require.resolve('./railgun-source-ledger'));
  walk(require.resolve('./railgun-account-public'));
  expect(visited.size).toBe(13);
});
