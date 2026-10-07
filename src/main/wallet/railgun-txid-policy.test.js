jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: jest.fn((p) => p) }));
const fs = require('fs');
const path = require('path');
const { getRailgunTxidPolicy, railgunTxidBinding, SOURCES } = require('./railgun-txid-policy');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
afterEach(() => jest.restoreAllMocks());
test('TXID policy binds every listed validator and authenticated engine independently of location', () => {
  const expected = getRailgunTxidPolicy('/fixture/engine.asar');
  expect(getRailgunTxidPolicy('/elsewhere/engine.asar')).toBe(expected);
  for (const source of SOURCES) {
    const original = fs.readFileSync;
    const spy = jest
      .spyOn(fs, 'readFileSync')
      .mockImplementation((name, ...args) =>
        String(name).endsWith('/' + source + '.js')
          ? Buffer.from('changed')
          : original(name, ...args)
      );
    expect(getRailgunTxidPolicy('/fixture/engine.asar')).not.toBe(expected);
    spy.mockRestore();
  }
  verifyRailgunEngineRuntime.mockImplementationOnce(() => {
    throw Error('archive');
  });
  expect(() => getRailgunTxidPolicy('/bad')).toThrow('archive');
});
test('TXID binding is account-specific and separate from ordinary account storage', () => {
  const input = '1'.repeat(64);
  expect(railgunTxidBinding(input)).toMatch(/^[0-9a-f]{64}$/);
  expect(railgunTxidBinding(input)).not.toBe(input);
  expect(railgunTxidBinding(input)).not.toBe(railgunTxidBinding('2'.repeat(64)));
  for (const v of [null, {}, 'A'.repeat(64), '1']) expect(() => railgunTxidBinding(v)).toThrow();
});
test('TXID computation, persistence and service validators have a closed policy dependency set', () => {
  const adapter = path.dirname(require.resolve('@freedom/railgun-kohaku-adapter/host/poi'));
  const read = jest.spyOn(fs, 'readFileSync');
  getRailgunTxidPolicy('/engine.asar');
  const included = new Set(read.mock.calls.map(([name]) => name));
  read.mockRestore();
  expect(included.has(path.join(adapter, 'package.json'))).toBe(true);
  const terminal = new Set(
    [
      'railgun-engine-runtime',
      'railgun-engine-manifest.json',
      'railgun-session-worker',
      'railgun-process',
      'privacy-storage',
    ].map((name) => require.resolve('./' + name))
  );
  const visited = new Set();
  function walk(filename) {
    if (visited.has(filename) || terminal.has(filename)) return;
    visited.add(filename);
    expect(included.has(filename)).toBe(true);
    for (const [, name] of fs
      .readFileSync(filename, 'utf8')
      .matchAll(/require\(['"]((?:\.\.?\/|@freedom\/railgun-kohaku-adapter)[^'"]*)['"]\)/g)) {
      const dependency = name.startsWith('.')
        ? require.resolve(path.resolve(path.dirname(filename), name))
        : require.resolve(name, { paths: [path.dirname(filename)] });
      if (path.dirname(dependency) === __dirname || dependency.startsWith(adapter + path.sep))
        walk(dependency);
    }
  }
  for (const name of [
    'railgun-txid-job',
    'railgun-txid-runner',
    'railgun-txid-journal',
    'railgun-txid-root',
  ])
    walk(require.resolve('./' + name));
  expect(visited.size).toBe(36);
  expect([...visited].filter((name) => name.startsWith(adapter + path.sep)).length).toBe(20);
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
  'src/data/railgun-private-capsule.js',
  'src/data/railgun-private-offer.js',
  'src/data/railgun-private-policy.js',
  'src/data/railgun-private-intent.js',
  'src/data/railgun-private-destination.js',
  'src/railgun-shield-pins.json',
])('TXID policy binds eagerly loaded package file %s', (name) => {
  const expected = getRailgunTxidPolicy('/engine.asar');
  const filename = path.join(
    path.dirname(require.resolve('@freedom/railgun-kohaku-adapter/host/poi')),
    name
  );
  const original = fs.readFileSync;
  jest
    .spyOn(fs, 'readFileSync')
    .mockImplementation((file, ...args) =>
      file === filename ? Buffer.from('changed') : original(file, ...args)
    );
  expect(getRailgunTxidPolicy('/engine.asar')).not.toBe(expected);
});
