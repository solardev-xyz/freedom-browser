/** Public-vector wallet semantics and validation matrix. No live chain or funds. */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { execFileSync } = require('child_process'),
  { createHash } = require('crypto');
const directory = process.argv[2];
assert.ok(directory && path.isAbsolute(directory) && !fs.existsSync(directory));
fs.mkdirSync(directory, { mode: 0o700 });
const sources = [
  'scripts/qualify-railgun-wallet-notes.js',
  'scripts/fixtures/railgun-wallet-notes-job.js',
  'scripts/railgun-fixture-integrity.js',
  'src/main/wallet/railgun-wallet-records.js',
  'src/main/wallet/railgun-leveldown.js',
  'src/main/wallet/railgun-paged-store.js',
  'src/main/wallet/railgun-store-cursor.js',
  'src/main/wallet/railgun-event-projector.js',
  'src/main/wallet/railgun-public-records.js',
  'src/main/wallet/railgun-frontier.js',
  'src/main/wallet/railgun-process-guards.js',
  'src/main/networks/privacy-context.js',
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
const sourceSha256 = hashes(),
  runs = [];
const scanMode = 'guarded';
{
  for (const scenario of [
    'normal',
    'foreign',
    'corrupt',
    'wrong-npk',
    'nft-missing',
    'same-range-spent',
    'transact',
    'transact-mismatch',
    'engine-drop',
    'nft-known',
    'wrong-npk-nft',
  ]) {
    const folder = path.join(directory, scanMode + '-' + scenario);
    fs.mkdirSync(folder, { mode: 0o700 });
    const modes =
      scenario === 'normal'
        ? ['create', 'cold', 'spent', 'cold-spent']
        : ['wrong-npk', 'nft-known', 'transact', 'transact-mismatch'].includes(scenario)
          ? ['create', 'cold']
          : ['create'];
    for (const mode of modes) {
      const start = performance.now();
      execFileSync(
        process.execPath,
        [
          '--max-old-space-size=256',
          path.join(__dirname, 'fixtures/railgun-wallet-notes-job.js'),
          folder,
          mode,
          scenario,
        ],
        { env: {}, timeout: 60000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const result = JSON.parse(fs.readFileSync(path.join(folder, mode + '.json')));
      assert.equal(result.guards.attempts, 0);
      assert.equal(result.poiCalls, 0);
      runs.push({ elapsedMs: Math.round(performance.now() - start), ...result });
      console.log(
        JSON.stringify({
          scanMode,
          scenario,
          mode,
          balance: result.observedBalance,
          refused: result.scanRefused ?? false,
        })
      );
    }
  }
}
assert.deepEqual(hashes(), sourceSha256);
fs.writeFileSync(
  path.join(directory, 'report.json'),
  JSON.stringify(
    {
      observedAt: new Date().toISOString(),
      sourceSha256,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      syntheticHistory: true,
      inProcessAdapter: true,
      coordinatorWalletWindowQualified: false,
      walletCoverageGranted: false,
      spendableGranted: false,
      submissions: 0,
      runs,
    },
    null,
    2
  ) + '\n',
  { flag: 'wx', mode: 0o600 }
);
