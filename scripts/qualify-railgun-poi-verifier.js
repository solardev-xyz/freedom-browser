/** Offline separate-process POI verification. All proof payloads remain in memory;
 * only selected redacted evidence is reported. No disclosure authority.
 * Usage: electron script ENGINE_ASAR PROVER_ASAR ARTIFACTS NEW_DIR [Shield|Transact]
 * Transact mode qualifies current V2 encryption, not legacy encrypted creators.
 */
const { app } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
async function main() {
  const [archive, proverArchive, artifactDirectory, directory, creatorKind = 'Shield'] =
    process.argv.slice(2);
  assert.ok(process.argv.length === 6 || process.argv.length === 7);
  assert.ok(['Shield', 'Transact'].includes(creatorKind));
  for (const p of [archive, proverArchive, artifactDirectory, directory])
    assert.ok(path.isAbsolute(p));
  assert.ok(!fs.existsSync(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const files = [
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
    'src/main/wallet/railgun-poi-verifier.js',
    'src/main/wallet/railgun-poi-verifier.test.js',
    'src/main/wallet/railgun-poi-verify-job.js',
    'src/main/wallet/railgun-poi-verify-job.test.js',
    'scripts/qualify-railgun-poi-verifier.js',
    'scripts/fixtures/railgun-poi-verifier-input-job.js',
    'scripts/fixtures/railgun-poi-witness-data.js',
    'src/main/wallet/railgun-poi-witness.js',
    'src/main/wallet/railgun-poi-prover.js',
    'src/main/wallet/railgun-poi-prover.test.js',
    'src/main/wallet/railgun-poi-payload.js',
    'src/main/wallet/railgun-poi-payload.test.js',
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
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'prover',
    operation: 'poi-verify',
  });
  const { normalizeRailgunPoiPayload } = require('../src/main/wallet/railgun-poi-payload');
  const { verifyRailgunPoiPayload } = require('../src/main/wallet/railgun-poi-verifier');
  const runs = [];
  let task;
  try {
    for (const kind of ['transfer', 'unshield']) {
      let payload, provingMs;
      const reconstructionControls = [
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
      ];
      task = require('../src/main/wallet/railgun-process').startRailgunProcess({
        handle,
        filename: require.resolve('./fixtures/railgun-poi-verifier-input-job'),
        input: JSON.stringify({ archive, proverArchive, artifactDirectory, kind, creatorKind }),
        startupMs: 120000,
        lifetimeMs: 180000,
        heapMb: 256,
        rssMb: 768,
        broker: {
          signal: scope.signal,
          dispatch: async (wire) => {
            assert.equal(payload, undefined);
            assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 16384);
            const msg = JSON.parse(wire);
            assert.deepEqual(Object.keys(msg).sort(), ['id', 'method', 'value']);
            assert.equal(msg.id, 1);
            assert.equal(msg.method, 'result');
            const v = msg.value;
            assert.deepEqual(
              Object.keys(v).sort(),
              [
                'payload',
                'kind',
                'creatorKind',
                'creatorSender',
                'creatorSenderVisible',
                'reconstructionControls',
                'reconstructionCompared',
                'legacyEncryptionQualified',
                'verified',
                'transactionProofVerified',
                'controls',
                'txidLeafIndex',
                'txidRootIndex',
                'allPublicSignalsCompared',
                'changedPublicSignalsRefused',
                'derivedMarkerMatched',
                'repeatedAssemblyMatched',
                'localProverMatched',
                'secondAttemptRefused',
                'elapsedMs',
                'guardAttempts',
                'authorityGranted',
                'liveQueries',
                'submissions',
              ].sort()
            );
            assert.equal(v.kind, kind);
            assert.equal(v.creatorKind, creatorKind);
            assert.equal(v.creatorSender, creatorKind === 'Transact' ? 'foreign' : null);
            assert.equal(v.creatorSenderVisible, creatorKind === 'Transact');
            assert.equal(v.reconstructionCompared, true);
            assert.equal(v.legacyEncryptionQualified, false);
            assert.deepEqual(v.reconstructionControls, reconstructionControls);
            assert.deepEqual(v.controls, [
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
            assert.ok(
              Number.isSafeInteger(v.elapsedMs) && v.elapsedMs >= 0 && v.elapsedMs <= 180000
            );
            provingMs = v.elapsedMs;
            for (const k of [
              'verified',
              'transactionProofVerified',
              'allPublicSignalsCompared',
              'derivedMarkerMatched',
              'repeatedAssemblyMatched',
              'localProverMatched',
              'secondAttemptRefused',
            ])
              assert.equal(v[k], true);
            assert.equal(v.txidLeafIndex, 5);
            assert.equal(v.txidRootIndex, 6);
            assert.equal(v.changedPublicSignalsRefused, 8);
            assert.equal(v.authorityGranted, false);
            for (const k of ['guardAttempts', 'liveQueries', 'submissions']) assert.equal(v[k], 0);
            payload = normalizeRailgunPoiPayload(v.payload);
            assert.equal(payload.txidMerklerootIndex, 6);
            assert.equal(payload.blindedCommitmentsOut.length, kind === 'transfer' ? 1 : 0);
            return JSON.stringify({ id: 1, value: null });
          },
        },
      });
      await task.ready;
      assert.ok(payload);
      task.close();
      assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
      task = undefined;
      const started = performance.now();
      const verify = (value) =>
        verifyRailgunPoiPayload({
          handle,
          proverArchive,
          artifactDirectory,
          payload: value,
          signal: scope.signal,
        });
      const result = await verify(payload);
      assert.equal(result.proofVerified, true);
      assert.equal(result.independentlyVerified, true);
      assert.equal(result.utilityExitObserved, true);
      for (const k of [
        'sourceAuthenticated',
        'membershipAuthenticated',
        'rootAccepted',
        'metadataAuthenticated',
        'ownershipAuthenticated',
        'disclosureEnabled',
        'spendingEnabled',
      ])
        assert.equal(result[k], false);
      const changedIndex = await verify({ ...payload, txidMerklerootIndex: 7 });
      assert.equal(changedIndex.proofVerified, true);
      assert.notEqual(changedIndex.payloadSha256, result.payloadSha256);
      const refusals = [];
      const bump = (v, prefix = false) =>
        (prefix ? '0x' : '') + (BigInt(prefix ? v : '0x' + v) + 1n).toString(16).padStart(64, '0');
      for (const fault of ['proof', 'txid-root', 'poi-root', 'output-or-marker']) {
        const v = structuredClone(payload);
        if (fault === 'proof') v.proof.pi_a[0] = (BigInt(v.proof.pi_a[0]) + 1n).toString();
        if (fault === 'txid-root') v.txidMerkleroot = bump(v.txidMerkleroot);
        if (fault === 'poi-root') v.poiMerkleroots[0] = bump(v.poiMerkleroots[0]);
        if (fault === 'output-or-marker') {
          if (kind === 'transfer')
            v.blindedCommitmentsOut[0] = bump(v.blindedCommitmentsOut[0], true);
          else v.railgunTxidIfHasUnshield = bump(v.railgunTxidIfHasUnshield, true);
        }
        normalizeRailgunPoiPayload(v); // Well-shaped changes must reach cryptographic verification.
        await assert.rejects(() => verify(v), { code: 'RAILGUN_POI_VERIFICATION_REFUSED' });
        refusals.push(fault);
      }
      runs.push({
        kind,
        creatorKind,
        creatorSender: creatorKind === 'Transact' ? 'foreign' : null,
        creatorSenderVisible: creatorKind === 'Transact',
        reconstructionCompared: true,
        reconstructionControls,
        legacyEncryptionQualified: false,
        actualTransactionProof: true,
        localPoiProofVerified: true,
        assemblyRefusals: 12,
        alteredPublicSignalsRefused: 8,
        secondProvingAttemptRefused: true,
        // Local POI proving plus its same-process verification/control checks.
        provingMs,
        proofVerified: true,
        separateProcess: true,
        proverExitObserved: true,
        verifierExitObserved: true,
        changedCheckpointStillVerifies: true,
        changedCheckpointDigestDiffers: true,
        refusals,
        elapsedMs: Math.round(performance.now() - started),
        authorityGranted: false,
        liveQueries: 0,
        submissions: 0,
      });
    }
    assert.deepEqual(hashes(), sourceSha256);
    fs.writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify(
        {
          fixture: 'synthetic-poi-separate-verifier',
          creatorKind,
          legacyEncryptionQualified: false,
          proverSha256: require('../src/main/wallet/railgun-prover-manifest.json').sha256,
          vkeySha256: require('../src/main/wallet/railgun-artifacts').manifest.POI_3x3.find(
            (v) => v.kind === 'vkey'
          ).sha256,
          sourceSha256,
          runs,
          liveQueries: 0,
          submissions: 0,
          authorityGranted: false,
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    );
    console.log(
      JSON.stringify({
        runs: runs.length,
        sourceFiles: files.length,
        liveQueries: 0,
        submissions: 0,
      })
    );
  } finally {
    task?.close();
    if (task) await task.closed;
    scope.close();
  }
}
main()
  .then(() => app.exit(0))
  .catch(() => {
    console.error('Railgun separate POI verifier qualification failed');
    app.exit(1);
  });
