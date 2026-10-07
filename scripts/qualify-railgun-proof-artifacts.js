/** Guarded Electron transaction/POI proofs using the independent pinned serial prover closure. */
const { app } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
async function main() {
  const [artifactDirectory, archive, vectorFilename, directory] = process.argv.slice(2);
  for (const p of [artifactDirectory, archive, vectorFilename, directory])
    assert.ok(path.isAbsolute(p));
  assert.ok(!fs.existsSync(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const sources = [
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
    'scripts/qualify-railgun-proof-artifacts.js',
    'scripts/fixtures/railgun-proof-artifacts-job.js',
    'scripts/fixtures/railgun-proof-inputs.js',
    'src/main/wallet/railgun-artifacts.js',
    'src/main/wallet/privacy-artifacts.js',
    'src/main/wallet/railgun-process.js',
    'src/main/wallet/railgun-process-entry.js',
    'src/main/wallet/railgun-process-guards.js',
    'src/main/wallet/railgun-prover-runtime.js',
    'src/main/wallet/railgun-prover-manifest.json',
    'src/main/networks/privacy-context.js',
    'scripts/railgun-fixture-integrity.js',
    'scripts/fixtures/railgun-engine/runtime-integrity.json',
  ];
  const hashes = () =>
    Object.fromEntries(
      sources.map((p) => [
        p,
        createHash('sha256')
          .update(fs.readFileSync(path.join(__dirname, '..', p)))
          .digest('hex'),
      ])
    );
  const sourceSha256 = hashes();
  const { createPrivacyScope } = require('../src/main/networks/privacy-context');
  const scope = createPrivacyScope({
    profileId: 'railgun-artifact-proof-qualification',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'public-vector',
    protocol: 'railgun',
    deployment: 'offline',
    chainId: 11155111,
    role: 'prover',
  });
  let task, value;
  const runs = [];
  try {
    for (const variant of ['01x01', '01x02', '01x03', '02x02', '02x03', 'POI_3x3']) {
      value = undefined;
      task = require('../src/main/wallet/railgun-process').startRailgunProcess({
        handle,
        startupMs: 120000,
        lifetimeMs: 180000,
        heapMb: 256,
        rssMb: 768,
        filename: require.resolve('./fixtures/railgun-proof-artifacts-job'),
        input: JSON.stringify({ artifactDirectory, archive, vectorFilename, variant }),
        broker: {
          signal: scope.signal,
          dispatch: async (wire) => {
            const msg = JSON.parse(wire);
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
      assert.equal(value?.verified, true);
      assert.equal(value.guards.attempts, 0);
      assert.deepEqual(hashes(), sourceSha256);
      runs.push({ ...value, closed });
      console.log(
        JSON.stringify({
          variant,
          verified: value.verified,
          elapsedMs: value.elapsedMs,
          peakRssBytes: closed.peakRssBytes,
        })
      );
    }

    fs.writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          sourceSha256,
          heapMb: 256,
          rssMb: 768,
          startupMs: 120000,
          lifetimeMs: 180000,
          runs,
          submissions: 0,
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
  (e) => {
    console.error(e.stack);
    app.exit(1);
  }
);
