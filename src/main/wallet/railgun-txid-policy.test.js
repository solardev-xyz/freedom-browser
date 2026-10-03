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
  const included = new Set(SOURCES.map((name) => require.resolve('./' + name)));
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
      .matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)) {
      const dependency = require.resolve(path.resolve(path.dirname(filename), name));
      if (path.dirname(dependency) === __dirname) walk(dependency);
    }
  }
  for (const name of [
    'railgun-txid-job',
    'railgun-txid-runner',
    'railgun-txid-journal',
    'railgun-txid-root',
  ])
    walk(require.resolve('./' + name));
  expect(visited.size).toBe(16);
});
