const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert/strict');
const api = require('./qualify-railgun-relay-positive');
const original = fs.readFileSync(path.join(__dirname, '../src/main/wallet/railgun-poi-records.js'));
test('pure copy transformation changes exactly one reviewed literal, never the real source', () => {
  const before = Buffer.from(original);
  const isolated = api.deriveIsolatedPoiSource(original);
  expect(original).toEqual(before);
  expect(crypto.createHash('sha256').update(isolated).digest('hex')).toBe(api.ISOLATED_SHA);
  expect(
    isolated
      .toString()
      .replace(
        '43a72e714401762df66b68c26dfbdf2682aaec9f2474eca4613e424a0fbafd3c',
        'efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88'
      )
  ).toBe(original.toString());
  expect(() => api.assertIsolation()).toThrow();
});
test.each(['already-isolated', 'comment', 'duplicate', 'buffer-type'])(
  'rejects unreviewed source %s',
  (kind) => {
    const changed =
      kind === 'already-isolated'
        ? api.deriveIsolatedPoiSource(original)
        : kind === 'comment'
          ? Buffer.concat([original, Buffer.from('//extra')])
          : kind === 'duplicate'
            ? Buffer.concat([original, original])
            : original.toString();
    expect(() => api.deriveIsolatedPoiSource(changed)).toThrow();
  }
);
test('source import does not activate Electron, profile, engine, or runner', () => {
  const source = fs.readFileSync(__filename.replace('.test.js', '.js'), 'utf8');
  const imports = [];
  const req = (name) => {
    imports.push(name);
    return require(name);
  };
  req.main = {};
  vm.runInNewContext(source, {
    require: req,
    module: { exports: {} },
    __dirname,
    __filename: __filename.replace('.test.js', '.js'),
    Buffer,
    process: { argv: [], versions: {}, env: {} },
    console,
  });
  expect(imports).toEqual(['assert/strict', 'path', 'fs', 'crypto']);
});
test('Electron entry fallback activates only its exact filename', async () => {
  const source = fs.readFileSync(__filename.replace('.test.js', '.js'), 'utf8');
  const runner = { select: jest.fn(() => ({})), execute: jest.fn(async () => {}) };
  const filename = path.resolve('/fixture/scripts/qualify-railgun-relay-positive.js');
  const isolated = api.deriveIsolatedPoiSource(original);
  const app = { exit: jest.fn() };
  const req = (name) => {
    if (name === 'original-fs')
      return {
        realpathSync: (p) => p,
        lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
        readFileSync: () => isolated,
      };
    if (name === 'electron') return { app };
    if (name === './fixtures/railgun-relay-positive-native') return runner;
    return require(name);
  };
  req.main = {};
  const p = {
    argv: ['electron', filename],
    versions: { electron: 'test' },
    type: 'browser',
    env: { FREEDOM_RAILGUN_RELAY_POSITIVE: 'synthetic-list' },
  };
  vm.runInNewContext(source, {
    require: req,
    module: { exports: {} },
    __dirname: path.dirname(filename),
    __filename: filename,
    Buffer,
    process: p,
    console,
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(runner.execute).toHaveBeenCalledTimes(1);
  expect(app.exit).toHaveBeenCalledWith(0);
});
test('missing opt-in refuses before isolation checks or runner import', async () => {
  const source = fs.readFileSync(__filename.replace('.test.js', '.js'), 'utf8');
  const filename = path.resolve('/fixture/scripts/qualify-railgun-relay-positive.js');
  const app = { exit: jest.fn() },
    imports = [];
  const req = (name) => {
    imports.push(name);
    if (name === 'electron') return { app };
    if (name === 'original-fs') return { readFileSync: () => assert.fail('isolation read') };
    return require(name);
  };
  req.main = {};
  vm.runInNewContext(source, {
    require: req,
    module: { exports: {} },
    __dirname: path.dirname(filename),
    __filename: filename,
    Buffer,
    process: {
      argv: ['electron', filename],
      versions: { electron: 'test' },
      type: 'browser',
      env: {},
    },
    console: { error: () => {} },
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(app.exit).toHaveBeenCalledWith(1);
  expect(imports).not.toContain('./fixtures/railgun-relay-positive-native');
});
