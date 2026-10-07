/** Offline fixture-only POI preparation. Every fault gets a fresh utility to
 * exclude SDK proof-cache reuse. No wallet enrollment or disclosure authority.
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
    'scripts/qualify-railgun-poi-reconstruction.js',
    'scripts/fixtures/railgun-poi-reconstruction-job.js',
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
      for (const fault of [
        null,
        'random',
        'nullifying',
        kind === 'transfer' ? 'output' : 'unshield',
        'txid',
        'list',
        kind === 'transfer' ? 'marker-added' : 'marker-omitted',
      ]) {
        let value;
        const started = performance.now();
        task = require('../src/main/wallet/railgun-process').startRailgunProcess({
          handle,
          filename: require.resolve('./fixtures/railgun-poi-reconstruction-job'),
          input: JSON.stringify({ archive, proverArchive, artifactDirectory, kind, fault }),
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
        assert.equal(value.kind, kind);
        assert.equal(value.fault, fault);
        const markerCharacterization = fault?.startsWith('marker-') === true;
        assert.equal(value.verified, !fault || markerCharacterization);
        assert.equal(value.circuitRejected, !!fault && !markerCharacterization);
        assert.equal(value.transactionProofVerified, true);
        assert.equal(value.reconstructionCompared, true);
        assert.equal(value.guards.attempts, 0);
        assert.deepEqual(
          Object.keys(value).sort(),
          [
            'kind',
            'fault',
            'transactionProofVerified',
            'reconstructionCompared',
            'controls',
            'verified',
            'circuitRejected',
            'elapsedMs',
            'membershipSynthetic',
            'inclusionSynthetic',
            'submissions',
            'liveQueries',
            'spendingEnabled',
            'guards',
          ].sort()
        );
        assert.deepEqual(value.controls, [
          'position',
          'net-value',
          'note-hash',
          'wrong-viewing-key',
          'foreign-identity',
          'creator-ciphertext',
        ]);
        assert.deepEqual(Object.keys(value.guards).sort(), ['attempts', 'canaries', 'hooks']);
        assert.ok(
          Array.isArray(value.guards.hooks) &&
            value.guards.hooks.length >= 80 &&
            value.guards.hooks.length <= 128
        );
        assert.ok(value.guards.hooks.every((v) => typeof v === 'string' && v.length <= 128));
        assert.equal(value.guards.canaries, value.guards.hooks.length);
        assert.ok(
          Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= 180000
        );
        assert.equal(value.membershipSynthetic, true);
        assert.equal(value.inclusionSynthetic, true);
        assert.equal(value.submissions, 0);
        assert.equal(value.liveQueries, 0);
        assert.equal(value.spendingEnabled, false);
        assert.deepEqual(hashes(), sourceSha256);
        runs.push({
          kind,
          fault,
          transactionProofVerified: true,
          reconstructionCompared: true,
          reconstructionRefusals: value.controls.length,
          markerMatchesDerivedKind: !markerCharacterization && fault !== 'unshield',
          verified: value.verified,
          circuitRejected: value.circuitRejected,
          proofMs: value.elapsedMs,
          guardHooks: value.guards.hooks.length,
          guardCanaries: value.guards.canaries,
          guardAttempts: 0,
          totalMs: Math.round(performance.now() - started),
          utilityExitObserved: true,
          peakRssBytes: closed.peakRssBytes,
        });
        console.log(
          JSON.stringify({
            kind,
            fault,
            verified: value.verified,
            circuitRejected: value.circuitRejected,
            totalMs: runs.at(-1).totalMs,
          })
        );
      }
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
