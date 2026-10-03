/** Compare main-loop delay with synchronous vs worker storage. Synthetic public
 * leaves only. Main measurements stop before post-exit synchronous inspection.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');
const { app } = require('electron');
const { createPrivacyScope } = require('../src/main/networks/privacy-context');
const { startRailgunProcess } = require('../src/main/wallet/railgun-process');
const { createRailgunPagedStore } = require('../src/main/wallet/railgun-paged-store');
const { readRailgunFrontier } = require('../src/main/wallet/railgun-frontier');
const sources = [
  'scripts/measure-railgun-electron-storage.js',
  'scripts/fixtures/railgun-electron-volume-job.js',
  'scripts/railgun-fixture-integrity.js',
  'scripts/fixtures/railgun-engine/runtime-integrity.json',
  ...[
    'process',
    'process-entry',
    'process-guards',
    'session',
    'session-worker',
    'session-worker-entry',
    'paged-store',
    'store-cursor',
    'remote',
    'tree-transactions',
    'frontier',
  ].map((name) => 'src/main/wallet/railgun-' + name + '.js'),
];
async function main() {
  const directory = process.argv[2];
  const storageWorker = process.argv[3] === '--worker';
  assert.ok(directory && path.isAbsolute(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const profileId = 'synthetic-electron-volume';
  const subject = {
    kind: 'private-account',
    principal: 'fixture',
    protocol: 'railgun',
    deployment: 'offline',
    chainId: 11155111,
  };
  const storage = {
    format: 'paged-v2',
    filename: path.join(directory, 'state.sqlite'),
    key: Buffer.alloc(32, 59),
    binding: 'd'.repeat(64),
  };
  const runs = [];
  for (const write of [true, false]) {
    const scope = createPrivacyScope({ profileId, signal: new AbortController().signal });
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const started = performance.now();
    const task = startRailgunProcess({
      handle: scope.getContext({ ...subject, role: 'engine' }),
      storageWorker,
      storage: { ...storage, create: write },
      filename: require.resolve('./fixtures/railgun-electron-volume-job'),
      input: JSON.stringify({ write }),
      startupMs: 120000,
      lifetimeMs: 180000,
      heapMb: 512,
      rssMb: 1024,
      createProvider: ({ signal }) => ({
        signal,
        request: async () => {
          throw new Error('No RPC in synthetic volume run');
        },
      }),
    });
    try {
      await task.ready;
    } finally {
      task.close();
    }
    const closed = await task.closed;
    assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
    const elapsedMs = performance.now() - started;
    delay.disable();
    const eventLoop = {
      p50Ms: delay.percentile(50) / 1e6,
      p99Ms: delay.percentile(99) / 1e6,
      maxMs: delay.max / 1e6,
      targetP99Ms: 20,
      targetMet: delay.percentile(99) / 1e6 < 20,
    };
    scope.close();
    const inspection = createPrivacyScope({ profileId, signal: new AbortController().signal });
    const store = createRailgunPagedStore({
      ...storage,
      handle: inspection.getContext({ ...subject, role: 'storage' }),
      onFatal: () => inspection.close(),
    });
    try {
      const report = JSON.parse(store.get(Buffer.from('public-electron-volume-report')).toString());
      const frontier = readRailgunFrontier((key) => store.get(key));
      assert.equal(frontier.status, 'persisted-unverified');
      assert.deepEqual(frontier.reasons, []);
      assert.equal(frontier.trees.length, 2);
      for (const tree of report.trees) {
        assert.equal(frontier.trees[tree.tree].root, '0x' + tree.root);
        assert.equal(frontier.trees[tree.tree].length, tree.count);
      }
      assert.ok(store.stats().keys >= 210032);
      assert.ok(report.maxFrameBytes <= 2 * 1024 * 1024);
      runs.push({ write, elapsedMs, eventLoop, closed, stats: store.stats(), report });
    } finally {
      store.close();
      inspection.close();
    }
  }
  const report = {
    electron: process.versions.electron,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    storageWorker,
    syntheticPublicData: true,
    liveRpc: false,
    sourceSha256: Object.fromEntries(
      sources.map((file) => [
        file,
        createHash('sha256')
          .update(fs.readFileSync(path.join(__dirname, '..', file)))
          .digest('hex'),
      ])
    ),
    runs,
  };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(
    JSON.stringify(
      runs.map(({ write, elapsedMs, eventLoop, stats }) => ({
        write,
        elapsedMs,
        eventLoop,
        stats,
      })),
      null,
      2
    )
  );
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error.stack);
    app.exit(1);
  }
);
