const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');

const PACKAGE = '@freedom/railgun-kohaku-adapter';
const root = path.resolve(__dirname, '../../..');
const installed = path.join(root, 'node_modules', PACKAGE);
const record = require('../../../vendor/railgun-kohaku-adapter/OWNER-0.6.0.json');

// Parse reviewed npm pack bytes; refuse aliases, duplicate or nonordinary members.
function unpack(bytes) {
  const tar = zlib.gunzipSync(bytes),
    files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, end) =>
      header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    expect(field(156, 157)).toMatch(/^0?$/);
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join('/');
    expect(name.startsWith('package/')).toBe(true);
    expect(name.split('/').some((part) => part === '..' || part === '')).toBe(false);
    expect(files.has(name.slice(8))).toBe(false);
    const size = parseInt(field(124, 136).trim(), 8);
    expect(Number.isSafeInteger(size) && size >= 0).toBe(true);
    expect(offset + 512 + size).toBeLessThanOrEqual(tar.length);
    files.set(name.slice(8), tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
function installedFiles(directory, prefix = '') {
  return fs
    .readdirSync(directory)
    .flatMap((name) => {
      const file = path.join(directory, name),
        stat = fs.lstatSync(file);
      expect(stat.isSymbolicLink()).toBe(false);
      if (stat.isDirectory()) return installedFiles(file, prefix + name + '/');
      expect(stat.isFile()).toBe(true);
      return [prefix + name];
    })
    .sort();
}

test('the installed owner package exactly matches the reviewed tarball and lock', () => {
  const pkg = require('../../../package.json'),
    lock = require('../../../package-lock.json');
  const entry = lock.packages['node_modules/' + PACKAGE];
  const bytes = fs.readFileSync(path.join(root, record.tarball));
  expect(record.packageSource).toBe('9231d71718a63634b6a4f66df8a5e64ac079e197');
  expect(record.sha256).toBe('2ad2b4ad09f84c80936a78dbcbb5a2441ba53a863e9f8570a53ce80a78986f80');
  expect(record.files).toBe(280);
  expect(pkg.dependencies[PACKAGE]).toBe('file:' + record.tarball);
  expect(entry.resolved).toBe('file:' + record.tarball);
  expect(entry.version).toBe('0.6.0');
  expect(entry.integrity).toBe(record.integrity);
  expect(entry.integrity).toBe('sha512-' + createHash('sha512').update(bytes).digest('base64'));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.sha256);
  const files = unpack(bytes);
  expect([...files.keys()].sort()).toEqual(record.members);
  expect(files.size).toBe(record.files);
  expect(installedFiles(installed)).toEqual(record.members);
  for (const [name, content] of files)
    expect(fs.readFileSync(path.join(installed, name))).toEqual(content);
  const manifest = JSON.parse(files.get('package.json'));
  expect([manifest.name, manifest.version, manifest.license, manifest.private]).toEqual([
    PACKAGE,
    '0.6.0',
    'MPL-2.0',
    true,
  ]);
  expect(manifest.peerDependencies).toEqual({ ethers: '^6.17.0', 'better-sqlite3': '13.0.3' });
  expect(manifest.peerDependenciesMeta).toEqual({ 'better-sqlite3': { optional: true } });
});

test('main imports resolve one package with identical CJS and ESM public functions', () => {
  const lock = require('../../../package-lock.json');
  expect(
    Object.keys(lock.packages).filter((key) => key.endsWith('node_modules/' + PACKAGE))
  ).toEqual(['node_modules/' + PACKAGE]);
  const entries = ['', '/read', '/host/data', '/host/poi', '/host/owner', '/host/journal-data'];
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        `
    const assert = require('assert/strict');
    (async () => {
      const specs = ${JSON.stringify(entries)}.map(s => ${JSON.stringify(PACKAGE)} + s);
      for (const spec of specs) {
        const cjs = require(spec), esm = await import(spec);
        for (const [key, value] of Object.entries(cjs)) assert.equal(esm[key], value);
      }
      assert.deepEqual(Object.keys(require(specs[4])), ['initializeRailgunMain']);
      const files = Object.keys(require.cache).filter(p => p.includes('/railgun-kohaku-adapter/'));
      process.stdout.write(JSON.stringify({ entries: specs.map(s => require.resolve(s)), files }));
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `,
      ],
      { cwd: root, encoding: 'utf8' }
    )
  );
  expect(result.entries).toEqual(
    [
      'index.cjs',
      'read.cjs',
      'host-data.cjs',
      'host-poi.cjs',
      'host-owner.cjs',
      'host-journal-data.cjs',
    ].map((name) => path.join(installed, name))
  );
  expect(result.files.length).toBeGreaterThan(0);
  expect(new Set(result.files).size).toBe(result.files.length);
  for (const file of result.files) {
    expect(file.startsWith(installed + path.sep)).toBe(true);
    expect(record.members).toContain(path.relative(installed, file));
  }
});

test('package internals cannot be loaded through application package subpaths', () => {
  for (const name of [
    'src/owners/host-bindings.js',
    'src/owners/railgun-account-wallet.js',
    'src/execution/railgun-private-operate-job.js',
    'package.json',
  ])
    expect(() => require.resolve(PACKAGE + '/' + name)).toThrow();
});

test('trusted owner authority refuses fabricated receipts before initialization', () => {
  const authority = require(PACKAGE + '/host/owner-authority');
  expect(Object.keys(authority)).toHaveLength(6);
  for (const assertReceipt of Object.values(authority))
    expect(() => assertReceipt(Object.freeze({}))).toThrow();
});
