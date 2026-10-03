/** Real guarded utilities and pinned Poseidon; synthetic public data only.
 * No live RPC, POI, keys, wallet store, signing or spending is used.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { app } = require('electron');
const { createPrivacyScope } = require('../src/main/networks/privacy-context');
const { startRailgunProcess } = require('../src/main/wallet/railgun-process');
const { deriveRailgunOwnSelector } = require('../src/main/wallet/railgun-own-selector');
const { extractRailgunTransactIntent } = require('../src/main/wallet/railgun-transact-intent');
const sources = [
  'scripts/qualify-railgun-own-selector.js',
  'scripts/fixtures/railgun-own-txid-job.js',
  'scripts/fixtures/railgun-own-txid-data.js',
  'scripts/fixtures/railgun-transact-data.js',
  'src/main/wallet/railgun-shield-pins.json',
  ...[
    'railgun-own-selector',
    'railgun-own-selector-job',
    'railgun-own-txid',
    'railgun-private-capsule',
    'railgun-private-preparation',
    'railgun-private-intent',
    'railgun-private-policy',
    'railgun-transact-intent',
    'railgun-transact-receipt',
    'railgun-transact-resolution',
    'privacy-journal-retention',
    'private-transaction-intent',
    'ordinary-submission-policy',
    'railgun-shield-resolution',
    'railgun-shield-intent',
    'ppv2-ragequit-policy',
    'ppv2-deposit-policy',
    'railgun-own-txid-job',
    'railgun-txid-projection',
    'railgun-txid-note-witness',
    'railgun-txid-events',
    'railgun-txid-omissions',
    'railgun-public-records',
    'railgun-frontier',
    'railgun-engine-runtime',
    'railgun-process',
    'railgun-process-entry',
    'railgun-process-guards',
    'railgun-session',
    'railgun-session-worker',
    'railgun-session-worker-entry',
  ].map((name) => 'src/main/wallet/' + name + '.js'),
  'src/main/wallet/railgun-engine-manifest.json',
  'src/main/networks/privacy-context.js',
];
const sha = (v) => createHash('sha256').update(v).digest('hex');
const hashes = () =>
  Object.fromEntries(
    sources.map((file) => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))])
  );
let phase = 'setup',
  fixtureWireBytes = 0;
async function main() {
  const [directory, archive] = process.argv.slice(2);
  assert.ok(path.isAbsolute(directory) && path.isAbsolute(archive));
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const before = hashes();
  const scope = createPrivacyScope({
    profileId: 'synthetic-own-selector',
    signal: new AbortController().signal,
  });
  const subject = {
    kind: 'private-account',
    principal: 'synthetic',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
    operation: 'own-txid-selector',
  };
  const handle = scope.getContext(subject);
  let task, payload;
  const started = performance.now();
  try {
    phase = 'fixture-build';
    task = startRailgunProcess({
      handle,
      filename: require.resolve('./fixtures/railgun-own-txid-job'),
      input: JSON.stringify({ archive }),
      lifetimeMs: 60000,
      broker: {
        signal: scope.signal,
        async dispatch(wire) {
          fixtureWireBytes = typeof wire === 'string' ? Buffer.byteLength(wire) : 0;
          assert.ok(typeof wire === 'string' && fixtureWireBytes <= 128 * 1024);
          const message = JSON.parse(wire);
          assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
          assert.equal(message.id, 1);
          assert.equal(message.method, 'result');
          assert.equal(payload, undefined);
          assert.deepEqual(Object.keys(message.value).sort(), ['guards', 'samples']);
          assert.equal(message.value.guards.attempts, 0);
          payload = message.value;
          return JSON.stringify({ id: 1, value: null });
        },
      },
    });
    await task.ready;
    phase = 'fixture-exit';
    task.close();
    assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
    assert.ok(payload);
    const runs = [];
    assert.deepEqual(
      payload.samples.map((sample) => sample.name),
      ['transfer', 'unshield', 'archived-unshield', 'wrong-preimage']
    );
    for (const sample of payload.samples) {
      phase = sample.name;
      const { input: data, ...fields } = sample.evidence.transaction;
      const provedTransaction = { ...fields, data };
      const derive = (transaction) =>
        deriveRailgunOwnSelector({
          handle,
          archive,
          provedTransaction: transaction,
          signal: scope.signal,
        });
      const result = await derive(provedTransaction);
      assert.equal(result.railgunTxid, sample.witness.railgunTxid);
      assert.equal(result.selectorDerived, true);
      assert.equal(result.utilityExitObserved, true);
      for (const flag of [
        'accountAuthenticated',
        'pathVerified',
        'sourceAuthenticated',
        'rootAccepted',
        'currentCanonicalityVerified',
        'finalityVerified',
        'rowMetadataAuthenticated',
        'poiVerified',
        'globalTxidCompleteness',
        'spendingEnabled',
      ])
        assert.equal(result[flag], false);
      const zeroProof = extractRailgunTransactIntent(provedTransaction).intent;
      const changed = await derive(zeroProof);
      assert.equal(changed.railgunTxid, result.railgunTxid);
      assert.notEqual(changed.bindingDigest, result.bindingDigest);
      assert.notEqual(changed.inputSha256, result.inputSha256);
      runs.push({
        mode: sample.name,
        selectorMatchesMirror: true,
        proofBytesDoNotChangeSelector: true,
        proofBytesChangeBinding: true,
        utilityExitObserved: true,
        authorityGranted: false,
      });
    }
    phase = 'malformed-transaction';
    await assert.rejects(
      deriveRailgunOwnSelector({
        handle,
        archive,
        provedTransaction: { data: '0x' },
        signal: scope.signal,
      }),
      { code: 'RAILGUN_OWN_SELECTOR_REFUSED' }
    );
    runs.push({ mode: phase, refused: true });
    phase = 'closed-context';
    scope.close();
    const { input: data, ...fields } = payload.samples[0].evidence.transaction;
    await assert.rejects(
      deriveRailgunOwnSelector({
        handle,
        archive,
        provedTransaction: { ...fields, data },
        signal: scope.signal,
      }),
      { code: 'RAILGUN_OWN_SELECTOR_REFUSED' }
    );
    runs.push({ mode: phase, refused: true });
    phase = 'source-check';
    assert.deepEqual(hashes(), before);
    fs.writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - started),
          engineSha256: require('../src/main/wallet/railgun-engine-manifest.json').sha256,
          sourceSha256: before,
          runs,
          syntheticDataOnly: true,
          keyTransfers: 0,
          storageRequests: 0,
          sourceAuthenticated: false,
          pathVerified: false,
          rootAccepted: false,
          liveQueries: 0,
          submissions: 0,
          spendingEnabled: false,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
    console.log(JSON.stringify({ report: path.join(directory, 'report.json'), runs: runs.length }));
  } finally {
    scope.close();
    task?.close();
    if (task) await task.closed;
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(JSON.stringify({ phase, fixtureWireBytes, code: error?.code }));
    app.exit(1);
  }
);
