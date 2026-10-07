const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');

const PACKAGE = '@freedom/railgun-kohaku-adapter';
const TARBALL = 'vendor/railgun-kohaku-adapter/freedom-railgun-kohaku-adapter-0.4.0.tgz';
const root = path.resolve(__dirname, '../../..');
const installed = path.join(root, 'node_modules', PACKAGE);
const modules = {
  'railgun-private-destination': [
    PACKAGE + '/host/data',
    [
      'isRailgunForeignTransfer',
      'assertRailgunPrivateTransferRecipient',
      'decodeRailgunForeignDestination',
      'verifyRailgunForeignOutput',
    ],
  ],
  'railgun-private-signature': [PACKAGE + '/host/data', ['normalizeRailgunSignature']],
  'railgun-private-preparation': [
    PACKAGE + '/host/data',
    [
      'selectRailgunPrivatePreparation',
      'normalizeRailgunPrivatePreparation',
      'normalizeRailgunPrivateOffer',
      'normalizeRailgunPrivateOperation',
    ],
  ],
  'railgun-private-results': [
    PACKAGE + '/host/data',
    [
      'normalizeRailgunSignature',
      'normalizeRailgunSpendSignature',
      'normalizeRailgunSpendKeyRequest',
      'normalizeRailgunPrivateVerification',
      'normalizeRailgunPrivateReceiver',
    ],
  ],
  'railgun-private-recovery-data': [
    PACKAGE + '/host/data',
    ['normalizeRailgunPrivateRecoveryInput', 'normalizeRailgunPrivateRecoveryResult'],
  ],

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
modules['railgun-poi-records'] = [
  PACKAGE + '/host/poi',
  [
    'REQUIRED_LIST',
    'MAX_NOTES',
    'normalizePoiNotes',
    'normalizePoiStatuses',
    'normalizePoiProofs',
    'verifyPoiMembership',
    'verifyPoiEvent',
  ],
];
modules['railgun-poi-payload'] = [PACKAGE + '/host/poi', ['normalizeRailgunPoiPayload']];
modules['railgun-poi-creator-data'] = [
  PACKAGE + '/host/poi',
  [
    'assertRailgunPoiCreatorEvents',
    'normalizeRailgunPoiCreatorWitness',
    'assertRailgunPoiCreatorVerification',
  ],
];
modules['railgun-poi-shield-selector-data'] = [
  PACKAGE + '/host/poi',
  ['normalizeRailgunPoiShieldFacts', 'normalizeRailgunPoiShieldInput'],
];
modules['railgun-poi-transact-selector-data'] = [
  PACKAGE + '/host/poi',
  ['prepareRailgunPoiTransactSelectorInput', 'normalizeRailgunPoiTransactSelectorInput'],
];
modules['railgun-own-poi-binding'] = [
  PACKAGE + '/host/poi',
  ['assertRailgunOwnPoiCapture', 'assertRailgunOwnPoiStableCapture'],
];
modules['railgun-own-poi-shape-data'] = [
  PACKAGE + '/host/poi',
  ['getRailgunOwnPoiShape', 'assertRailgunOwnPoiPayloadShape'],
];
modules['railgun-owned-poi-records'] = [
  PACKAGE + '/host/poi',
  ['projectRailgunOwnedPoiRecord', 'normalizeRailgunOwnedPoiRecords', 'POI_LAUNCH_BLOCK'],
];
modules['railgun-poi-submit-data'] = [
  PACKAGE + '/host/poi',
  ['prepareRailgunPoiSubmission', 'normalizeRailgunPoiSubmission', 'inspectRailgunPoiResponse'],
];
modules['railgun-txid-note-witness'] = [
  PACKAGE + '/host/poi',
  ['findRailgunNoteTxidWitness', 'normalizeRailgunTxidWitness', 'normalizeRailgunNoteTxidWitness'],
];
modules['railgun-txid-projection'] = [
  PACKAGE + '/host/poi',
  ['createRailgunTxidProjection', 'validateRailgunTxidRow'],
];
modules['railgun-txid-omissions'] = [PACKAGE + '/host/poi', ['classifyRailgunTxidContinuity']];

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
        ['TRANSACT_ABI', 'BOUND_PARAMS', 'REQUIRED_LIST'].includes(key)
          ? 'string'
          : ['MAX_NOTES', 'POI_LAUNCH_BLOCK'].includes(key)
            ? 'number'
            : 'function'
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
    '35ea07c1f9c64926c94a0b24f39333db75412a7771eae78675743bcae2a6a0a1'
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
      'read.mjs',
      'data.cjs',
      'data.mjs',
      'host-data.mjs',
      'host-poi.mjs',
      'types/host-poi.d.ts',
      'types/host-poi.d.mts',
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

test('Freedom keeps new-capsule creation while sharing preparation and recovery data', () => {
  const host = require(PACKAGE + '/host/data');
  const capsule = require('./railgun-private-capsule');
  expect(capsule.normalizeRailgunPrivateCapsule).toBe(host.normalizeRailgunPrivateCapsule);
  expect(capsule.digestRailgunPrivateCapsule).toBe(host.digestRailgunPrivateCapsule);
  expect(typeof capsule.normalizeRailgunNewCapsule).toBe('function');
  expect(require('./railgun-private-preparation').normalizeRailgunPrivateOffer).toBe(
    host.normalizeRailgunPrivateOffer
  );
});

// Result validators and runtime authentication must bind the same build.
test.each(['engine', 'prover'])(
  'package %s manifest matches the authenticated Freedom runtime',
  (name) => {
    expect(fs.readFileSync(path.join(__dirname, `railgun-${name}-manifest.json`))).toEqual(
      fs.readFileSync(path.join(installed, `src/railgun-${name}-manifest.json`))
    );
  }
);

test('only the pure own-POI binder moves; host launch helpers stay local', () => {
  const local = require('./railgun-own-poi-proof-data');
  expect(local.bindRailgunOwnPoiPayload).toBe(
    require(PACKAGE + '/host/poi').bindRailgunOwnPoiPayload
  );
});
