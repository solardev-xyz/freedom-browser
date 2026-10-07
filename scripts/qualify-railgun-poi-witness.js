/** Offline assembly qualification. Each operation has its own utility; refusal
 * controls happen before the only POI proving call. No disclosure authority.
 * Usage: electron script ENGINE_ASAR PROVER_ASAR ARTIFACTS NEW_DIR
 */
const { app } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
async function main() {
  const [archive, proverArchive, artifactDirectory, directory] = process.argv.slice(2);
  assert.equal(process.argv.length, 6);
  for (const p of [archive, proverArchive, artifactDirectory, directory])
    assert.ok(path.isAbsolute(p));
  assert.ok(!fs.existsSync(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const files = [
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
    'scripts/qualify-railgun-poi-witness.js',
    'scripts/fixtures/railgun-poi-witness-job.js',
    'scripts/fixtures/railgun-poi-witness-data.js',
    'src/main/wallet/railgun-poi-witness.js',
    'src/main/wallet/railgun-poi-witness.test.js',
    'src/main/wallet/railgun-own-txid.js',
    'src/main/wallet/railgun-txid-note-witness.js',
    'src/main/wallet/railgun-txid-projection.js',
    'src/main/wallet/railgun-txid-omissions.js',
    'src/main/wallet/railgun-public-records.js',
    'src/main/wallet/railgun-transact-intent.js',
    'src/main/wallet/railgun-transact-receipt.js',
    'src/main/wallet/railgun-transact-resolution.js',
    'src/main/wallet/privacy-journal-retention.js',
    'src/main/wallet/railgun-poi-records.js',
    'src/main/wallet/railgun-poi-reconstruct.js',
    'src/main/wallet/railgun-private-destination.js',
    'src/main/wallet/railgun-poi-reconstruct.test.js',
    'src/main/wallet/railgun-private-capsule.js',
    'src/main/wallet/railgun-private-preparation.js',
    'src/main/wallet/railgun-private-intent.js',
    'src/main/wallet/railgun-private-policy.js',
    'src/main/wallet/railgun-shield-pins.json',
    'src/main/identity/railgun-key-derivation.js',
    'src/main/wallet/railgun-artifacts.js',
    'src/main/wallet/privacy-artifacts.js',
    'src/main/wallet/railgun-engine-runtime.js',
    'src/main/wallet/railgun-engine-manifest.json',
    'src/main/wallet/railgun-prover-runtime.js',
    'src/main/wallet/railgun-prover-manifest.json',
    'src/main/wallet/railgun-process.js',
    'src/main/wallet/railgun-process-entry.js',
    'src/main/wallet/railgun-process-guards.js',
    'src/main/networks/privacy-context.js',
  ];
  const hashes = () =>
    Object.fromEntries(
      files.map((f) => [
        f,
        createHash('sha256')
          .update(fs.readFileSync(path.join(__dirname, '..', f)))
          .digest('hex'),
      ])
    );
  const sourceSha256 = hashes();
  const scope = require('../src/main/networks/privacy-context').createPrivacyScope({
    profileId: 'poi-reconstruction-qualification',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'synthetic',
    protocol: 'railgun',
    deployment: 'offline',
    chainId: 11155111,
    role: 'prover',
  });
  const runs = [];
  let task;
  try {
    for (const kind of ['transfer', 'unshield']) {
      let value;
      const started = performance.now();
      task = require('../src/main/wallet/railgun-process').startRailgunProcess({
        handle,
        filename: require.resolve('./fixtures/railgun-poi-witness-job'),
        input: JSON.stringify({ archive, proverArchive, artifactDirectory, kind }),
        startupMs: 120000,
        lifetimeMs: 180000,
        heapMb: 256,
        rssMb: 768,
        broker: {
          signal: scope.signal,
          dispatch: async (wire) => {
            assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 16384);
            const msg = JSON.parse(wire);
            assert.deepEqual(Object.keys(msg).sort(), ['id', 'method', 'value']);
            assert.equal(value, undefined);
            assert.equal(msg.id, 1);
            assert.equal(msg.method, 'result');
            value = msg.value;
            return JSON.stringify({ id: 1, value: null });
          },
        },
      });
      await task.ready;
      task.close();
      const closed = await task.closed;
      assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
      const keys = [
        'kind',
        'verified',
        'transactionProofVerified',
        'controls',
        'txidLeafIndex',
        'txidRootIndex',
        'allPublicSignalsCompared',
        'changedPublicSignalsRefused',
        'derivedMarkerMatched',
        'repeatedAssemblyMatched',
        'elapsedMs',
        'guardAttempts',
        'authorityGranted',
        'liveQueries',
        'submissions',
      ];
      assert.deepEqual(Object.keys(value).sort(), keys.sort());
      assert.equal(value.kind, kind);
      for (const k of [
        'verified',
        'transactionProofVerified',
        'allPublicSignalsCompared',
        'derivedMarkerMatched',
        'repeatedAssemblyMatched',
      ])
        assert.equal(value[k], true);
      assert.equal(value.txidLeafIndex, 5);
      assert.equal(value.txidRootIndex, 6);
      assert.equal(value.changedPublicSignalsRefused, 8);
      assert.equal(value.authorityGranted, false);
      for (const k of ['guardAttempts', 'liveQueries', 'submissions']) assert.equal(value[k], 0);
      assert.ok(
        Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= 180000
      );
      assert.deepEqual(value.controls, [
        'caller-marker',
        'caller-output-position',
        'wrong-membership-leaf',
        'wrong-membership-root',
        'membership-index-overflow',
        'extra-membership',
        'wrong-output-row',
        'wrong-kind',
        'wrong-checkpoint-index',
        'wrong-txid-path',
        'wrong-capsule',
        'extra-evidence',
      ]);
      assert.deepEqual(hashes(), sourceSha256);
      runs.push({
        kind,
        verified: true,
        actualTransactionProof: true,
        assemblyRefusals: value.controls.length,
        leafIndex: value.txidLeafIndex,
        rootIndex: value.txidRootIndex,
        changedPublicSignalsRefused: 8,
        markerDerivedInternally: true,
        repeatedAssemblyMatched: true,
        guardAttempts: 0,
        proofMs: value.elapsedMs,
        totalMs: Math.round(performance.now() - started),
        utilityExitObserved: true,
        peakRssBytes: closed.peakRssBytes,
      });
      console.log(JSON.stringify(runs.at(-1)));
    }
    fs.writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          sourceSha256,
          engineSha256: require('../src/main/wallet/railgun-engine-manifest.json').sha256,
          proverSha256: require('../src/main/wallet/railgun-prover-manifest.json').sha256,
          publicMnemonic: true,
          syntheticMembership: true,
          syntheticInclusion: true,
          runs,
          liveQueries: 0,
          submissions: 0,
          productionKeyRelease: false,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  } finally {
    task?.close();
    if (task) await task.closed;
    scope.close();
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error.stack);
    app.exit(1);
  }
);
