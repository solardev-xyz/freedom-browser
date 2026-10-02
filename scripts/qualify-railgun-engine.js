/** Runs synthetic engine jobs in separate Node processes, without live RPC. */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const expectedInventory = require('./fixtures/railgun-engine/runtime-integrity.json').inventory;
const expectedChecks = [
  'identity-public-key-vectors',
  'product-path-hardware-address-equivalence',
  'upstream-address-vector',
  'engine-database-encodings-and-atomic-batch',
  'ordered-snapshot-range-seek-and-atomic-clear',
  'hardware-wallet-create-or-fresh-process-restore',
  'actual-engine-provider-host-only-and-revoked',
  'unqualified-artifacts-and-validation-refused',
  'write-failure-or-lock-revokes-session',
];
const sourceFiles = [
  'scripts/fixtures/railgun-engine-job.js',
  'scripts/qualify-railgun-engine.js',
  'scripts/railgun-fixture-integrity.js',
  'scripts/fixtures/ppv2-egress-tripwire.js',
  'src/main/networks/privacy-context.js',
  'scripts/fixtures/railgun-engine/runtime-integrity.json',
  'src/main/wallet/railgun-store.js',
  'src/main/wallet/railgun-leveldown.js',
  'src/main/networks/railgun-host-provider.js',
  'src/main/identity/railgun-key-derivation.js',
];
const hashSources = () =>
  Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '..', file)))
        .digest('hex'),
    ])
  );
const sourceSha256 = hashSources();
const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory))
  throw new Error('Fresh absolute output directory required');
fs.mkdirSync(directory, { mode: 0o700 });
const runs = [];
for (const mode of ['create', 'fault', 'restore']) {
  const output = execFileSync(
    process.execPath,
    [
      '--max-old-space-size=256',
      path.join(__dirname, 'fixtures/railgun-engine-job.js'),
      directory,
      mode,
    ],
    {
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, TMPDIR: directory },
    }
  );
  const report = JSON.parse(output.trim());
  assert.equal(report.mode, mode);
  assert.deepEqual(report.checks, expectedChecks);
  assert.deepEqual(report.inventory, expectedInventory);
  assert.equal(report.directAttempts, 0);
  assert.equal(report.refusalCanaries, report.hooks.length);
  assert.equal(report.hooks.length, 87);
  assert.equal(report.termination, 'explicit-process-exit-after-revocation');
  assert.equal(report.actualEngine, true);
  assert.equal(report.signingEnabled, false);
  assert.equal(report.controlledNetworkLoaded, true);
  assert.equal(report.contractHistoryScanned, false);
  assert.equal(report.productionEnabled, false);
  fs.writeFileSync(path.join(directory, mode + '.json'), JSON.stringify(report, null, 2) + '\n');
  runs.push(report);
}
assert.deepEqual(hashSources(), sourceSha256);
process.stdout.write(
  JSON.stringify(
    { sourceSha256, runs, freshProcessRestore: true, publicTestKeysOnly: true },
    null,
    2
  ) + '\n'
);
