/** Standalone combined POI cryptography with disposable public fixture keys.
 * Real spend/POI proofs, synthetic chain/list history, no enrolled authority.
 * Usage: electron script ENGINE_ASAR PROVER_ASAR ARTIFACTS NEW_DIR
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
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
  const repo = path.join(__dirname, '..');
  const directories = ['src/main/wallet', 'src/main/networks', 'src/main/identity'];
  const files = [
    'scripts/qualify-railgun-combined-poi.js',
    'scripts/fixtures/railgun-poi-verifier-input-job.js',
    'scripts/fixtures/railgun-poi-witness-data.js',
    ...directories.flatMap((dir) =>
      fs
        .readdirSync(path.join(repo, dir))
        .filter((name) => /\.(js|json)$/.test(name))
        .map((name) => dir + '/' + name)
    ),
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
  ].sort();
  const hashes = () =>
    Object.fromEntries(
      files.map((file) => [
        file,
        createHash('sha256')
          .update(fs.readFileSync(path.join(repo, file)))
          .digest('hex'),
      ])
    );
  const sourceSha256 = hashes();
  const { createPrivacyScope } = require('../src/main/networks/privacy-context');
  const scope = createPrivacyScope({
    profileId: 'combined-poi-fixture',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'fixture',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'prover',
    operation: 'poi-verify',
  });
  const { verifyRailgunPoiPayload } = require('../src/main/wallet/railgun-poi-verifier');
  const runs = [];
  let task;
  try {
    for (const [kind, creatorKind] of [
      ['partial', 'Shield'],
      ['partial', 'Transact'],
      ['transfer', 'Shield'],
      ['unshield', 'Shield'],
    ]) {
      const started = performance.now();
      let result;
      task = require('../src/main/wallet/railgun-process').startRailgunProcess({
        handle,
        filename: require.resolve('./fixtures/railgun-poi-verifier-input-job'),
        input: JSON.stringify({
          archive,
          proverArchive,
          artifactDirectory,
          kind,
          creatorKind,
          combinedQualification: true,
        }),
        startupMs: 120000,
        lifetimeMs: 180000,
        heapMb: 256,
        rssMb: 768,
        broker: {
          signal: scope.signal,
          dispatch: async (wire) => {
            assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 16384);
            const message = JSON.parse(wire);
            assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
            assert.equal(message.id, 1);
            assert.equal(message.method, 'result');
            assert.equal(result, undefined);
            result = message.value;
            return JSON.stringify({ id: 1, value: null });
          },
        },
      });
      await task.ready;
      task.close();
      const closed = await task.closed;
      assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
      assert.equal(result.kind, kind);
      assert.equal(result.creatorKind, creatorKind);
      for (const name of [
        'verified',
        'transactionProofVerified',
        'reconstructionCompared',
        'allPublicSignalsCompared',
        'derivedMarkerMatched',
        'repeatedAssemblyMatched',
        'localProverMatched',
        'secondAttemptRefused',
        'combinedBindingVerified',
      ])
        assert.equal(result[name], true);
      assert.equal(result.changedPublicSignalsRefused, 8);
      assert.equal(result.authorityGranted, false);
      for (const name of ['guardAttempts', 'liveQueries', 'submissions'])
        assert.equal(result[name], 0);
      assert.deepEqual(result.controls, [
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
      assert.deepEqual(result.reconstructionControls, [
        'wrong-viewing-key',
        'creator-position',
        'position-nullifier',
        'nullifier-binding',
        'ciphertext-data',
        ...(creatorKind === 'Transact' ? ['ciphertext-tag', 'creator-hash'] : []),
        'note-hash',
        ...(creatorKind === 'Transact' ? ['sent-only-foreign-recipient'] : []),
        'amount',
        'non-weth',
        'creator-shape',
        'ciphertext-shape',
        ...(kind === 'partial'
          ? [
              'change-value-conservation',
              'change-foreign-npk-same-viewing-key',
              'change-transfer-annotation',
              'change-memo',
              'change-hidden-sender',
              'final-unshield-preimage-hash',
              'reversed-output-commitments',
            ]
          : []),
      ]);
      assert.equal(result.txidLeafIndex, 5);
      assert.equal(result.txidRootIndex, 6);
      const verify = async (payload) => {
        const diagnostic = await verifyRailgunPoiPayload({
          handle,
          proverArchive,
          artifactDirectory,
          payload,
          signal: scope.signal,
        });
        assert.equal(diagnostic.proofVerified, true);
        assert.equal(diagnostic.independentlyVerified, true);
        assert.equal(diagnostic.utilityExitObserved, true);
        assert.equal(diagnostic.disclosureEnabled, false);
        assert.equal(diagnostic.spendingEnabled, false);
        return true;
      };
      await verify(result.payload);
      let markerControl = null;
      if (kind !== 'unshield') {
        assert.equal(result.markerControl.cryptographicallyVerified, true);
        assert.equal(result.markerControl.applicationRefused, true);
        await verify(result.markerControl.payload);
        markerControl = {
          wrongMarker: kind === 'partial' ? 'zero' : 'own-txid',
          resultingShape: kind === 'partial' ? 'transfer' : 'partial-unshield',
          cryptographicallyVerified: true,
          independentlyVerified: true,
          applicationRefused: true,
        };
      } else assert.equal(result.markerControl, undefined);
      assert.deepEqual(hashes(), sourceSha256);
      const run = {
        kind,
        creatorKind,
        actualSignedSpendProof: true,
        actualPoiProof: true,
        independentlyVerified: true,
        reconstructionControls: result.reconstructionControls,
        assemblyControls: result.controls,
        changedPublicSignalsRefused: 8,
        markerControl,
        utilityExitObserved: true,
        peakRssBytes: closed.peakRssBytes,
        totalMs: Math.round(performance.now() - started),
      };
      runs.push(run);
      console.log(JSON.stringify(run));
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
          syntheticChainHistory: true,
          syntheticMembership: true,
          genuineOperationHold: false,
          durablePrepare: false,
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
