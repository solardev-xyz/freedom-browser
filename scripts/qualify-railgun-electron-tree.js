/** Actual Electron main/utility tree groups, public leaves, no live RPC or funds. */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { app } = require('electron');
const { createPrivacyScope } = require('../src/main/networks/privacy-context');
const { createRailgunPagedStore } = require('../src/main/wallet/railgun-paged-store');
const { readRailgunFrontier, readRailgunPosition } = require('../src/main/wallet/railgun-frontier');
const { startRailgunProcess } = require('../src/main/wallet/railgun-process');
const storageWorker = process.argv[3] === '--worker';
const sources = [
  'scripts/qualify-railgun-electron-tree.js',
  'scripts/fixtures/railgun-electron-tree-job.js',
  'scripts/railgun-fixture-integrity.js',
  'src/main/wallet/railgun-process.js',
  'src/main/wallet/railgun-process-entry.js',
  'src/main/wallet/railgun-process-guards.js',
  'src/main/wallet/railgun-session.js',
  'src/main/wallet/railgun-session-worker.js',
  'src/main/wallet/railgun-session-worker-entry.js',
  'src/main/wallet/railgun-remote.js',
  'src/main/wallet/railgun-paged-store.js',
  'src/main/wallet/railgun-store-cursor.js',
  'src/main/wallet/railgun-frontier.js',
  'src/main/wallet/railgun-tree-transactions.js',
  'scripts/fixtures/railgun-engine/runtime-integrity.json',
];
const hashes = () =>
  Object.fromEntries(
    sources.map((file) => [
      file,
      createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '..', file)))
        .digest('hex'),
    ])
  );
async function main() {
  const directory = process.argv[2];
  assert.ok(directory && path.isAbsolute(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const sourceSha256 = hashes(),
    runs = [];
  const storage = {
    format: 'paged-v2',
    filename: path.join(directory, 'state.sqlite'),
    key: Buffer.alloc(32, 53),
    binding: 'f'.repeat(64),
  };
  const profileId = 'public-electron-tree';
  const subject = {
    kind: 'private-account',
    principal: 'fixture',
    protocol: 'railgun',
    deployment: 'offline',
    chainId: 11155111,
  };
  for (const [mode, start, target, expected, write] of [
    ['create', 0, 1024, 1024, true],
    ['cold', 0, 1024, 1024, false],
    ['update', 1024, 2048, 2048, true],
    ['cold', 0, 2048, 2048, false],
    ['lock', 2048, 4096, 2048, true],
    ['cold', 0, 2048, 2048, false],
    ['crash-before', 2048, 4096, 2048, true],
    ['cold', 0, 2048, 2048, false],
    ['crash-after', 2048, 4096, 4096, true],
    ['cold', 0, 4096, 4096, false],
  ]) {
    const interrupted = ['lock', 'crash-before', 'crash-after'].includes(mode);
    const scope = createPrivacyScope({ profileId, signal: new AbortController().signal });
    let locked = false,
      crashMarker = false;
    const task = startRailgunProcess({
      storageWorker,
      handle: scope.getContext({ ...subject, role: 'engine' }),
      filename: require.resolve('./fixtures/railgun-electron-tree-job'),
      input: JSON.stringify({ mode, start, target, write }),
      storage: { ...storage, create: mode === 'create' },
      startupMs: 120000,
      lifetimeMs: 180000,
      createProvider: ({ signal }) => ({
        signal,
        request: async ({ method }) => {
          if (mode.startsWith('crash')) {
            assert.equal(method, 'eth_chainId');
            assert.equal(crashMarker, false);
            crashMarker = true;
            return '0xaa36a7';
          }
          assert.equal(mode, 'lock');
          assert.equal(method, 'eth_blockNumber');
          locked = true;
          scope.close();
          return '0x123';
        },
      }),
    });
    try {
      if (interrupted) await assert.rejects(task.ready);
      else {
        await task.ready;
        task.close();
      }
      const closed = await task.closed;
      assert.equal(locked, mode === 'lock');
      assert.equal(crashMarker, mode.startsWith('crash'));
      if (crashMarker) {
        assert.ok(
          ['RAILGUN_PROCESS_EXITED', 'RAILGUN_PROCESS_CHANNEL_CLOSED'].includes(closed.code)
        );
        assert.equal(closed.exitCode, 9);
        assert.equal(closed.escalated, false);
      }
      if (mode === 'lock') assert.equal(closed.code, 'PRIVACY_CONTEXT_REVOKED');
      else if (!interrupted) assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
      const inspection = createPrivacyScope({ profileId, signal: new AbortController().signal });
      const store = createRailgunPagedStore({
        ...storage,
        handle: inspection.getContext({ ...subject, role: 'storage' }),
        onFatal: () => inspection.close(),
      });
      let frontier, report, stats;
      try {
        frontier = readRailgunFrontier((k) => store.get(k));
        assert.equal(frontier.status, 'persisted-unverified');
        assert.deepEqual(frontier.reasons, []);
        assert.equal(frontier.trees.length, 1);
        assert.equal(frontier.trees[0].length, expected);
        const position = readRailgunPosition((k) => store.get(k), frontier, 0, expected - 1);
        assert.ok(position);
        assert.throws(() => readRailgunPosition((k) => store.get(k), frontier, 0, expected));
        report = JSON.parse(store.get(Buffer.from('public-electron-tree-report')).toString());
        if (!interrupted) {
          assert.equal(report.target, expected);
          assert.equal(report.guards.attempts, 0);
          assert.equal(frontier.trees[0].root, '0x' + report.root);
          assert.ok(report.maxFrameBytes <= 2 * 1024 * 1024);
        }
        stats = store.stats();
      } finally {
        store.close();
        inspection.close();
      }
      runs.push({
        mode,
        start,
        target,
        expected,
        passed: true,
        crashMarker,
        frontier,
        stats,
        closed,
        report: interrupted ? null : report,
      });
    } finally {
      task.close();
      await task.closed;
      scope.close();
    }
  }
  // Each crash/lock observation must match a freshly reopened real-engine run
  // that independently reduces all synthetic leaves and checks a Merkle proof.
  for (const run of runs) {
    const recovered = runs.find(
      (candidate) => candidate.mode === 'cold' && candidate.expected === run.expected
    );
    assert.ok(recovered?.report);
    assert.equal(run.frontier.trees[0].root, '0x' + recovered.report.root);
  }
  assert.deepEqual(hashes(), sourceSha256);
  const report = {
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    sourceSha256,
    syntheticPublicData: true,
    liveRpc: false,
    rootBinding: 'unverified',
    storageWorker,
    runs,
  };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => app.exit(0));
}
main().catch((error) => process.stderr.write(error.stack + '\n', () => app.exit(1)));
