const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');

const PACKAGE = '@freedom/railgun-kohaku-adapter';
const TARBALL = 'vendor/railgun-kohaku-adapter/freedom-railgun-kohaku-adapter-0.2.0.tgz';
const root = path.resolve(__dirname, '../../..');
const installed = path.join(root, 'node_modules', PACKAGE);
const modules = {
  'railgun-private-policy': [
    PACKAGE + '/host/data',
    ['TRANSACT_ABI', 'BOUND_PARAMS', 'validateRailgunPrivateTransaction'],
  ],
  'railgun-private-intent': [
    PACKAGE + '/host/data',
    ['validateRailgunPrivateSigningIntent', 'matchRailgunPrivateProvedTransaction'],
  ],
  'railgun-kohaku-private-adapter': [
    PACKAGE,
    ['createRailgunKohakuPrivateAdapter', 'createRailgunKohakuPrivateAdapterBroadcaster'],
  ],
  'railgun-kohaku-public-adapter': [
    PACKAGE,
    ['createRailgunKohakuPublicAdapter', 'createRailgunKohakuPublicAdapterSubmitter'],
  ],
  'railgun-kohaku-snapshot-plugin': [PACKAGE, ['createRailgunKohakuSnapshotPlugin']],
  'railgun-kohaku-read-data': [
    PACKAGE + '/read',
    [
      'normalizeRailgunKohakuReadFilter',
      'projectRailgunKohakuBalance',
      'projectRailgunKohakuNotes',
    ],
  ],
  'railgun-kohaku-read-dispatch': [PACKAGE + '/read', ['dispatchRailgunKohakuRead']],
};
// npm pack output: plain ustar entries under package/, gzip-compressed.
function untar(bytes) {
  const tar = zlib.gunzipSync(bytes),
    files = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, end) =>
      header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    expect(field(156, 157)).toMatch(/^0?$/);
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join('/');
    const size = parseInt(field(124, 136).trim(), 8);
    expect(Object.hasOwn(files, name)).toBe(false);
    files[name] = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

test.each(Object.entries(modules))(
  '%s keeps its export shape and re-exports the package function objects',
  (name, [specifier, keys]) => {
    const freedom = require('./' + name);
    const upstream = require(specifier);
    expect(Object.getPrototypeOf(freedom)).toBe(Object.prototype);
    expect(Object.keys(freedom)).toEqual(keys);
    for (const key of keys) {
      expect(typeof upstream[key]).toBe(
        ['TRANSACT_ABI', 'BOUND_PARAMS'].includes(key) ? 'string' : 'function'
      );
      expect(freedom[key]).toBe(upstream[key]);
    }
  }
);

test('the package resolves to one installed copy from the wallet modules', () => {
  expect(require.resolve(PACKAGE, { paths: [__dirname] })).toBe(path.join(installed, 'index.cjs'));
  expect(require.resolve(PACKAGE + '/read', { paths: [__dirname] })).toBe(
    path.join(installed, 'read.cjs')
  );
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  expect(
    Object.keys(lock.packages).filter((key) => key.endsWith('node_modules/' + PACKAGE))
  ).toEqual(['node_modules/' + PACKAGE]);
  // Real Node module cache, not Jest's per-file registry: every loaded package
  // file comes from one directory, each implementation file exactly once.
  const loaded = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        `for (const name of ${JSON.stringify(Object.keys(modules))}) require(${JSON.stringify(
          __dirname
        )} + '/' + name);
        process.stdout.write(JSON.stringify(Object.keys(require.cache).filter((file) =>
          file.includes('railgun-kohaku-adapter'))));`,
      ],
      { cwd: root, encoding: 'utf8' }
    )
  );
  expect(loaded.sort()).toEqual(
    [
      'index.cjs',
      'read.cjs',
      'host-data.cjs',
      'src/data/railgun-private-policy.js',
      'src/data/railgun-private-intent.js',
      'src/data/railgun-private-offer.js',
      'src/data/railgun-private-capsule.js',
      'src/railgun-kohaku-private-adapter.js',
      'src/railgun-kohaku-public-adapter.js',
      'src/railgun-kohaku-read-data.js',
      'src/railgun-kohaku-read-dispatch.js',
      'src/railgun-kohaku-snapshot-plugin.js',
      'src/railgun-shield-pins.json',
    ]
      .map((name) => path.join(installed, name))
      .sort()
  );
});

test('the installed package is the committed tarball the lockfile names', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  expect(pkg.dependencies[PACKAGE]).toBe('file:' + TARBALL);
  const entry = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages[
    'node_modules/' + PACKAGE
  ];
  const bytes = fs.readFileSync(path.join(root, TARBALL));
  expect(entry.resolved).toBe('file:' + TARBALL);
  expect(entry.integrity).toBe('sha512-' + createHash('sha512').update(bytes).digest('base64'));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '752ace2fbd3fa08a5ec036aa688021e322785ff7903da7555082f88d92b4c610'
  );
  const files = untar(bytes);
  expect(Object.keys(files).sort()).toEqual(
    [
      'LICENSE',
      'NOTICE.md',
      'README.md',
      'index.cjs',
      'index.mjs',
      'package.json',
      'read.cjs',
      'host-data.cjs',
      'src/data/railgun-private-policy.js',
      'src/data/railgun-private-intent.js',
      'src/data/railgun-private-offer.js',
      'src/data/railgun-private-capsule.js',
      'read.mjs',
      'data.cjs',
      'data.mjs',
      'host-data.mjs',
      'src/data/index.js',
      'types/data.d.ts',
      'types/data.d.mts',
      'types/host-data.d.ts',
      'types/host-data.d.mts',
      'src/railgun-kohaku-private-adapter.js',
      'src/railgun-kohaku-public-adapter.js',
      'src/railgun-kohaku-read-data.js',
      'src/railgun-kohaku-read-dispatch.js',
      'src/railgun-kohaku-snapshot-plugin.js',
      'src/railgun-shield-pins.json',
      'types/index.d.mts',
      'types/index.d.ts',
      'types/railgun-kohaku-private-contract.d.ts',
      'types/railgun-kohaku-public-contract.d.ts',
      'types/railgun-kohaku-read-contract.d.ts',
      'types/railgun-kohaku-snapshot-contract.d.ts',
      'types/read.d.mts',
      'types/read.d.ts',
    ]
      .map((name) => 'package/' + name)
      .sort()
  );
  for (const [name, content] of Object.entries(files))
    expect([name, fs.readFileSync(path.join(installed, name.slice('package/'.length)))]).toEqual([
      name,
      content,
    ]);
  const manifest = JSON.parse(files['package/package.json']);
  expect([manifest.name, manifest.version, manifest.license]).toEqual([
    PACKAGE,
    entry.version,
    'MPL-2.0',
  ]);
  expect(manifest.peerDependencies).toEqual({ ethers: '^6.17.0' });
});

test('Freedom keeps the shield pins the package adapters read, byte for byte', () => {
  expect(fs.readFileSync(path.join(__dirname, 'railgun-shield-pins.json'))).toEqual(
    fs.readFileSync(path.join(installed, 'src/railgun-shield-pins.json'))
  );
});

test('Freedom retains owned preparation and new-capsule checks around host data exports', () => {
  const host = require(PACKAGE + '/host/data');
  const capsule = require('./railgun-private-capsule');
  expect(capsule.normalizeRailgunPrivateCapsule).toBe(host.normalizeRailgunPrivateCapsule);
  expect(capsule.digestRailgunPrivateCapsule).toBe(host.digestRailgunPrivateCapsule);
  expect(typeof capsule.normalizeRailgunNewCapsule).toBe('function');
  expect(require('./railgun-private-preparation').normalizeRailgunPrivateOffer).toBe(
    host.normalizeRailgunPrivateOffer
  );
});
