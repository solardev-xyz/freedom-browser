const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SOURCES } = require('./railgun-kohaku-adapter-sources');

const root = path.resolve(__dirname, '../..');
const installed = path.dirname(
  require.resolve('@freedom/railgun-kohaku-adapter', { paths: [root] })
);

test('pins this list, the lockfile and every installed adapter file that can load', () => {
  expect(Object.isFrozen(SOURCES)).toBe(true);
  expect(new Set(SOURCES).size).toBe(SOURCES.length);
  expect(SOURCES.slice(0, 4)).toEqual([
    path.relative(root, __filename).replace(/\.test\.js$/, '.js'),
    'scripts/fixtures/railgun-job-observer.js',
    'src/main/wallet/railgun-kernel-entry.js',
    'package-lock.json',
  ]);
  for (const name of SOURCES) {
    expect(path.isAbsolute(name) || name.split('/').includes('..')).toBe(false);
    expect(fs.statSync(path.join(root, name)).isFile()).toBe(true);
  }
  // Every installed file reached by the Freedom adapter and private-data wrappers.
  const loaded = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        `for (const name of ['private-adapter', 'public-adapter', 'snapshot-plugin', 'read-data',
          'read-dispatch']) require('./src/main/wallet/railgun-kohaku-' + name);
        for (const name of ['policy', 'intent', 'capsule', 'preparation'])
          require('./src/main/wallet/railgun-private-' + name);
        require('@freedom/railgun-kohaku-adapter/host/poi');
        process.stdout.write(JSON.stringify(Object.keys(require.cache)));`,
      ],
      { cwd: root, encoding: 'utf8' }
    )
  )
    .filter((file) => file.startsWith(installed + path.sep))
    .map((file) => path.relative(root, file));
  expect(loaded.length).toBe(32);
  // Exports select the installed entry; result validators lazily read both manifest pins.
  expect(SOURCES.slice(4).sort()).toEqual(
    [
      ...loaded,
      ...[
        'host-bootstrap.cjs',
        'host-execution.cjs',
        'host-execution.mjs',
        ...fs
          .readdirSync(path.join(installed, 'src/execution'))
          .map((name) => 'src/execution/' + name),
      ].map((name) => path.relative(root, path.join(installed, name))),
      ...[
        'package.json',
        'src/railgun-engine-manifest.json',
        'src/railgun-prover-manifest.json',
      ].map((name) => path.relative(root, path.join(installed, name))),
    ].sort()
  );
});

// Evaluate only the literal inventory expressions, never the Electron/live entry.
// An empty prior scan proves these pins cannot be inherited accidentally from
// historical evidence that predates the installed package.
test.each([
  'note-provenance',
  'owned-poi-vector',
  'owned-poi-live',
  'poi-root',
  'poi-read',
  'txid-storage',
  'txid-projection',
  'txid-historical',
  'txid-journal',
  'txid-coverage',
  'txid-tree',
  'txid-root',
  'coordinated-electron',
  'coordinated-replay',
  'electron-tree',
  'electron',
  'funding',
  'identity',
  'proof-artifacts',
  'public-services',
  'shield-build',
  'shield-live',
  'wallet-aes',
  'wallet-synthetic',
])('%s direct qualifier pins the complete installed closure', (name) => {
  const filename = path.join(root, 'scripts/qualify-railgun-' + name + '.js');
  const source = fs.readFileSync(filename, 'utf8');
  const match = /const (?:sources|names|SOURCES|sourceNames|files) = (\[)/.exec(source);
  expect(match).not.toBeNull();
  const start = match.index + match[0].length - 1;
  const end = source.indexOf('];', start) + 1;
  expect(end).toBeGreaterThan(start);
  const values = require('vm').runInNewContext(source.slice(start, end), {
    require: require('module').createRequire(filename),
    scan: { sourceSha256: {} },
  });
  for (const file of SOURCES) expect(values).toContain(file);
});

test('delegated relay and live inventories include actual installed bytes', () => {
  const map = require('./railgun-relay-retained-run').sourceHashes();
  const live = require('../qualify-railgun-private-live').FIXED_SOURCES;
  for (const name of SOURCES) {
    expect(map[name]).toBe(
      require('crypto')
        .createHash('sha256')
        .update(fs.readFileSync(path.join(root, name)))
        .digest('hex')
    );
    if (name.startsWith('node_modules/')) expect(live).toContain(name);
  }
});

test('cold handoff refuses omitted installed source pins before reading payload files', () => {
  const filename = path.join(root, 'scripts/qualify-railgun-cold-submission.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('const verifyPriorSources = () => {');
  const end = source.indexOf('\n  };', start) + '\n  };'.length;
  expect(start).toBeGreaterThan(0);
  const sha = (bytes) => require('crypto').createHash('sha256').update(bytes).digest('hex');
  const pinned = Object.fromEntries(
    SOURCES.map((name) => [name, sha(fs.readFileSync(path.join(root, name)))])
  );
  const read = jest.fn(fs.readFileSync);
  const handoff = { sourceHashes: { ...pinned } };
  const verify = require('vm').runInNewContext(source.slice(start, end) + '\nverifyPriorSources;', {
    require: require('module').createRequire(filename),
    assert: require('assert/strict'),
    root,
    path,
    fs: { readFileSync: read },
    handoff,
    sha,
  });
  expect(() => verify()).not.toThrow();
  for (const absent of [
    'host-poi.cjs',
    'src/data/railgun-private-capsule.js',
    'src/data/railgun-txid-omissions.js',
  ]) {
    handoff.sourceHashes = Object.fromEntries(
      Object.entries(pinned).filter(
        ([name]) => name !== 'node_modules/@freedom/railgun-kohaku-adapter/' + absent
      )
    );
    read.mockClear();
    expect(() => verify()).toThrow('Installed source pin missing');
    expect(read).not.toHaveBeenCalled();
  }
});
