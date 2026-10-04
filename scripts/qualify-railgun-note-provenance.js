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
const { verifyRailgunNoteProvenance } = require('../src/main/wallet/railgun-note-provenance');
const sources = [
  'scripts/qualify-railgun-note-provenance.js',
  'scripts/fixtures/railgun-note-provenance-job.js',
  'src/main/wallet/railgun-note-provenance.test.js',
  ...[
    'railgun-note-provenance',
    'railgun-note-provenance-job',
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
async function main() {
  const [directory, archive] = process.argv.slice(2);
  assert.ok(path.isAbsolute(directory) && path.isAbsolute(archive));
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const before = hashes();
  const scope = createPrivacyScope({
    profileId: 'synthetic-note-provenance',
    signal: new AbortController().signal,
  });
  const subject = {
    kind: 'private-account',
    principal: 'synthetic',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
    operation: 'note-provenance',
  };
  const handle = scope.getContext(subject);
  let task, payload;
  const started = performance.now();
  try {
    task = startRailgunProcess({
      handle,
      filename: require.resolve('./fixtures/railgun-note-provenance-job'),
      input: JSON.stringify({ archive }),
      lifetimeMs: 60000,
      broker: {
        signal: scope.signal,
        async dispatch(wire) {
          assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 65536);
          const message = JSON.parse(wire);
          assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
          assert.equal(message.id, 1);
          assert.equal(message.method, 'result');
          assert.equal(payload, undefined);
          assert.deepEqual(Object.keys(message.value).sort(), [
            'events',
            'guards',
            'note',
            'noteWitness',
            'state',
          ]);
          assert.equal(message.value.guards.attempts, 0);
          payload = message.value;
          return JSON.stringify({ id: 1, value: null });
        },
      },
    });
    await task.ready;
    task.close();
    assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
    assert.ok(payload);
    const { guards: _guards, ...evidence } = payload;
    const runs = [];
    const verify = (value) =>
      verifyRailgunNoteProvenance({ handle, archive, ...value, signal: scope.signal });
    const result = await verify(evidence);
    assert.equal(result.pathVerified, true);
    assert.equal(result.utilityExitObserved, true);
    for (const flag of [
      'ownershipVerified',
      'eventSourceAuthenticated',
      'rootAccepted',
      'spendingEnabled',
    ])
      assert.equal(result[flag], false);
    runs.push({ mode: 'valid', result });
    for (const mode of [
      'sibling',
      'index',
      'row-hash',
      'txid',
      'note',
      'events',
      'omitted-creator',
    ]) {
      const altered = structuredClone(evidence);
      if (mode === 'sibling') altered.noteWitness.witness.elements[0] = '0'.repeat(64);
      if (mode === 'index') altered.noteWitness.witness.index = 0;
      if (mode === 'row-hash') {
        altered.noteWitness.witness.row.boundParamsHash = '0x' + '0'.repeat(64);
        altered.noteWitness.witness.rowSha256 = sha(
          JSON.stringify(altered.noteWitness.witness.row)
        );
      }
      if (mode === 'txid') altered.noteWitness.witness.railgunTxid = '0'.repeat(64);
      if (mode === 'note') altered.note.position++;
      if (mode === 'events') altered.events[1].hashes[0] = '0x' + '0'.repeat(64);
      if (mode === 'omitted-creator') {
        const txid = '4b78372a9f06a8ab7ccb8a02373d279fc385515139c6ef157d2fe79ee147e932';
        altered.note.txid = altered.noteWitness.note.txid = '0x' + txid;
        altered.noteWitness.witness.row.txid = txid;
        altered.noteWitness.witness.rowSha256 = sha(
          JSON.stringify(altered.noteWitness.witness.row)
        );
      }
      await assert.rejects(verify(altered), { code: 'RAILGUN_NOTE_PROVENANCE_REFUSED' });
      runs.push({ mode, refused: true });
    }
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
  () => {
    console.error('Detached note provenance qualification failed');
    app.exit(1);
  }
);
