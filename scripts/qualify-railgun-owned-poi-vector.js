/** Offline public-vector qualification using the integrity-checked engine fixture.
 * No account is opened. This is cryptographic compatibility, not guarded runtime
 * or ownership evidence. node script NEW_OUTPUT_JSON
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
async function main() {
  const output = process.argv[2];
  assert.equal(process.argv.length, 3);
  assert.ok(path.isAbsolute(output) && !fs.existsSync(output));
  const fixture = path.join(__dirname, 'fixtures/railgun-engine/node_modules');
  const inventory = require('./railgun-fixture-integrity').assertRailgunFixture(fixture);
  assert.equal(
    inventory.sha256,
    require('../src/main/wallet/railgun-engine-manifest.json').inventory.sha256
  );
  const root = path.join(fixture, '@railgun-community/engine/dist');
  await require(path.join(root, 'utils/poseidon')).initPoseidonPromise;
  const runtime = {
    ...require(path.join(root, 'note/transact-note')),
    ...require(path.join(root, 'poi/blinded-commitment')),
    ...require(path.join(root, 'poi/global-tree-position')),
  };
  const vector = require('./fixtures/railgun-owned-poi-public-vector.json');
  const { signedPOIEvent: event } = require('./fixtures/railgun-poi-signed-event.json')[0];
  assert.equal(vector.blindedCommitment, event.blindedCommitment);
  assert.equal(event.type, 'Shield');
  const leaf = {
    utxoTree: vector.tree,
    utxoIndex: vector.position,
    hash: vector.hash,
    txid: vector.transactionHash,
    blockNumber: vector.blockNumber,
    commitmentType: 'ShieldCommitment',
    preImage: { npk: vector.npk },
  };
  const txo = {
    tree: vector.tree,
    position: vector.position,
    commitmentType: leaf.commitmentType,
    blindedCommitment: vector.blindedCommitment,
    note: {
      hash: BigInt(vector.hash),
      notePublicKey: BigInt(vector.npk),
      tokenHash: vector.tokenHash,
      value: BigInt(vector.value),
    },
  };
  const {
    projectRailgunOwnedPoiRecord: project,
    normalizeRailgunOwnedPoiRecords: normalize,
  } = require('../src/main/wallet/railgun-owned-poi-records');
  const record = project(txo, leaf, runtime);
  assert.equal(record.blindedCommitment, event.blindedCommitment);
  const read = {
    received: [
      { id: `${vector.tree}:${vector.position}`, hash: vector.hash, txid: vector.transactionHash },
    ],
  };
  assert.deepEqual(normalize([record], read, { to: { number: vector.blockNumber } }), [record]);
  assert.throws(() =>
    project(
      { ...txo, note: { ...txo.note, notePublicKey: txo.note.notePublicKey + 1n } },
      leaf,
      runtime
    )
  );
  assert.throws(() =>
    project(
      { ...txo, position: txo.position + 1 },
      { ...leaf, utxoIndex: leaf.utxoIndex + 1 },
      runtime
    )
  );
  assert.throws(() => project({ ...txo, blindedCommitment: '0x' + '0'.repeat(64) }, leaf, runtime));
  const sources = [
    'scripts/qualify-railgun-owned-poi-vector.js',
    'scripts/fixtures/railgun-owned-poi-public-vector.json',
    'scripts/fixtures/railgun-poi-signed-event.json',
    'scripts/railgun-fixture-integrity.js',
    'src/main/wallet/railgun-engine-manifest.json',
    'src/main/wallet/railgun-owned-poi-records.js',
  ];
  const report = {
    observedAt: new Date().toISOString(),
    publicVector: true,
    accountsOpened: 0,
    runtime: 'integrity-checked Node fixture; not guarded Electron',
    inventory,
    transactionHash: vector.transactionHash,
    blockNumber: vector.blockNumber,
    projectionMatchedSignedEvent: true,
    wrongNoteKeyRejected: true,
    wrongPositionRejected: true,
    wrongCachedBlindingRejected: true,
    sourceSha256: Object.fromEntries(
      sources.map((name) => [
        name,
        createHash('sha256')
          .update(fs.readFileSync(path.join(__dirname, '..', name)))
          .digest('hex'),
      ])
    ),
    passed: true,
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ passed: true, publicVector: true }));
}
main().catch(() => {
  console.error('Railgun owned POI public vector refused');
  process.exitCode = 1;
});
