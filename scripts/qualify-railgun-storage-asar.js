/** Minimal ASAR loading qualification of the trusted storage worker and native
 * SQLite closure. Not a full packaged application or cross-platform result.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { app } = require('electron');
const sources = [
  'src/main/networks/privacy-context.js',
  ...[
    'session',
    'session-worker',
    'session-worker-entry',
    'store',
    'paged-store',
    'store-cursor',
    'frontier',
  ].map((name) => 'src/main/wallet/railgun-' + name + '.js'),
];
async function main() {
  const directory = process.argv[2];
  assert.ok(directory && path.isAbsolute(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  const relative = path.relative(
    fs.realpathSync(path.join(__dirname, '..')),
    fs.realpathSync(directory)
  );
  assert.ok(
    relative.startsWith('..' + path.sep) || path.isAbsolute(relative),
    'ASAR fixture must be outside the repository'
  );
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const stage = path.join(directory, 'stage');
  fs.mkdirSync(stage);
  for (const file of sources) {
    const target = path.join(stage, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', file), target);
  }
  const sqlite = path.dirname(require.resolve('better-sqlite3/package.json'));
  fs.cpSync(sqlite, path.join(stage, 'node_modules/better-sqlite3'), { recursive: true });
  fs.writeFileSync(
    path.join(stage, 'package.json'),
    JSON.stringify({ name: 'public-railgun-storage-fixture', version: '1.0.0' })
  );
  const archive = path.join(directory, 'app.asar');
  await require('@electron/asar').createPackageWithOptions(stage, archive, {
    unpackDir: 'node_modules/better-sqlite3',
  });
  const { createPrivacyScope } = require(path.join(archive, 'src/main/networks/privacy-context'));
  const { startRailgunSessionWorker } = require(
    path.join(archive, 'src/main/wallet/railgun-session-worker')
  );
  const scope = createPrivacyScope({
    profileId: 'public-asar-fixture',
    signal: new AbortController().signal,
  });
  const options = {
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'fixture',
      chainId: 11155111,
      protocol: 'railgun',
      deployment: 'offline',
      role: 'engine',
    }),
    storage: {
      filename: path.join(directory, 'state.sqlite'),
      format: 'paged-v2',
      key: Buffer.alloc(32, 61),
      binding: 'e'.repeat(64),
    },
    createProvider: ({ signal }) => ({
      signal,
      request: async () => {
        throw new Error('No RPC');
      },
    }),
    onClose: () => {},
  };
  const value = Buffer.from('synthetic-public-asar-value').toString('base64');
  for (const create of [true, false]) {
    const worker = startRailgunSessionWorker({
      ...options,
      storage: { ...options.storage, create },
    });
    try {
      await worker.ready;
      let id = 0;
      if (create)
        await worker.dispatch(
          JSON.stringify({
            id: ++id,
            method: 'batch',
            args: {
              operations: [{ type: 'put', key: 'YQ==', value }],
            },
          })
        );
      assert.equal(
        JSON.parse(
          await worker.dispatch(JSON.stringify({ id: ++id, method: 'get', args: { key: 'YQ==' } }))
        ).value,
        value
      );
      worker.assertFresh(await worker.inspectFrontier());
    } finally {
      worker.close();
      await worker.closed;
    }
  }
  scope.close();
  assert.equal(
    fs.readFileSync(options.storage.filename).includes(Buffer.from(value, 'base64')),
    false
  );
  const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const native = [];
  const walk = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.name.endsWith('.node'))
        native.push({ path: path.relative(directory, file), sha256: hash(file) });
    }
  };
  walk(path.join(archive + '.unpacked', 'node_modules/better-sqlite3'));
  assert.ok(native.length);
  const selectedVirtualPath = require(
    path.join(archive, 'node_modules/better-sqlite3/lib/binding')
  ).getPrebuildPath();
  assert.ok(selectedVirtualPath?.startsWith(archive + path.sep));
  const selectedPath = selectedVirtualPath.replace(archive, archive + '.unpacked');
  assert.ok(fs.existsSync(selectedPath));
  const report = {
    electron: process.versions.electron,
    node: process.version,
    moduleAbi: process.versions.modules,
    platform: process.platform,
    architecture: process.arch,
    minimalAsar: true,
    fullPackagedApp: false,
    createAndReopen: true,
    noLiveRpc: true,
    publicSyntheticData: true,
    archiveSha256: createHash('sha256')
      .update(require('original-fs').readFileSync(archive))
      .digest('hex'),
    native,
    selectedNative: { path: path.relative(directory, selectedPath), sha256: hash(selectedPath) },
    sourceSha256: Object.fromEntries(
      [...sources, 'scripts/qualify-railgun-storage-asar.js'].map((file) => [
        file,
        hash(path.join(__dirname, '..', file)),
      ])
    ),
  };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(JSON.stringify(report, null, 2));
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error.stack);
    app.exit(1);
  }
);
