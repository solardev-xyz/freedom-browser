const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert/strict');
const api = require('./qualify-railgun-relay-positive');
const original = fs.readFileSync(
  path.join(
    path.dirname(require.resolve('@freedom/railgun-kohaku-adapter/host/poi')),
    'src/data/railgun-poi-records.js'
  )
);
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
        lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1 }),
        readFileSync: () => isolated,
      };
    if (name === 'electron') return { app };
    if (name === './fixtures/railgun-relay-positive-native') return runner;
    return require(name);
  };
  req.resolve = () => '/fixture/node_modules/@freedom/railgun-kohaku-adapter/host-poi.cjs';
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

test.each(['physical', 'shared-package', 'shadow-entry', 'symlink-source', 'real-list'])(
  'isolated package source guard handles %s',
  (kind) => {
    const filename = '/fixture/scripts/qualify-railgun-relay-positive.js';
    const packageRoot = '/fixture/node_modules/@freedom/railgun-kohaku-adapter';
    const sourceFile = packageRoot + '/src/data/railgun-poi-records.js';
    const read = jest.fn(() =>
      kind === 'real-list' ? original : api.deriveIsolatedPoiSource(original)
    );
    const req = (name) =>
      name === 'fs'
        ? {
            realpathSync: (file) =>
              kind === 'shared-package' && file === packageRoot ? '/shared/package' : file,
            lstatSync: () => ({
              isFile: () => true,
              isSymbolicLink: () => kind === 'symlink-source',
              nlink: 1,
            }),
            readFileSync: read,
          }
        : require(name);
    req.resolve = () =>
      kind === 'shadow-entry' ? '/other/host-poi.cjs' : packageRoot + '/host-poi.cjs';
    req.main = {};
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(__filename.replace('.test.js', '.js'), 'utf8'), {
      require: req,
      module,
      __dirname: path.dirname(filename),
      __filename: filename,
      Buffer,
      process: { versions: {}, argv: [], env: {} },
      console,
    });
    if (kind === 'physical') {
      expect(module.exports.assertIsolation()).toEqual({
        originalPoiSourceSha256: api.ORIGINAL_SHA,
        isolatedPoiSourceSha256: api.ISOLATED_SHA,
      });
      expect(read).toHaveBeenCalledWith(sourceFile);
    } else {
      expect(() => module.exports.assertIsolation()).toThrow();
      if (kind !== 'real-list') expect(read).not.toHaveBeenCalled();
    }
  }
);

// This exercises real inode/link metadata without touching an installed package.
// The files are disposable public fixture bytes retained in the system temp tree.
test('a real hardlink to transformed fixture bytes is refused before reading the source', () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(require('os').tmpdir(), 'railgun-poi-hardlink-'))
  );
  const packageRoot = path.join(directory, 'node_modules/@freedom/railgun-kohaku-adapter');
  const sourceFile = path.join(packageRoot, 'src/data/railgun-poi-records.js');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, api.deriveIsolatedPoiSource(original), { flag: 'wx' });
  const read = jest.fn((filename) => fs.readFileSync(filename));
  const req = (name) =>
    name === 'fs'
      ? {
          realpathSync: fs.realpathSync,
          lstatSync: fs.lstatSync,
          readFileSync: read,
        }
      : require(name);
  req.resolve = () => path.join(packageRoot, 'host-poi.cjs');
  req.main = {};
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(__filename.replace('.test.js', '.js'), 'utf8'), {
    require: req,
    module,
    __dirname: path.join(directory, 'scripts'),
    __filename: path.join(directory, 'scripts/qualify-railgun-relay-positive.js'),
    Buffer,
    process: { versions: {}, argv: [], env: {} },
    console,
  });
  expect(() => module.exports.assertIsolation()).not.toThrow();
  const alias = path.join(directory, 'shared-records.js');
  fs.linkSync(sourceFile, alias);
  const current = fs.lstatSync(sourceFile),
    linked = fs.lstatSync(alias);
  expect([current.dev, current.ino, current.nlink]).toEqual([linked.dev, linked.ino, 2]);
  expect(fs.realpathSync(sourceFile)).toBe(sourceFile);
  read.mockClear();
  expect(() => module.exports.assertIsolation()).toThrow();
  expect(read).not.toHaveBeenCalled();
});
