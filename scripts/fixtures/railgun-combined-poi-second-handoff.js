/** Disposable B process boundary. Only hashes/public wire cross; original
 * signatures/proofs and receipts are reread from genuine encrypted stores. */
const fs = require('fs');
const path = require('path');
const { assert } = require('./railgun-native-assertions');
const data = require('./railgun-combined-poi-restart-data');
const exact = (value, keys) => {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Object.keys(value).sort(), keys.slice().sort());
};
const hash = (value) => assert.match(value, /^[0-9a-f]{64}$/);
function firstImmutable(record) {
  const { revision: _revision, observation, ...stable } = record;
  const { observedAt: _observedAt, confirmations: _confirmations, ...anchor } = observation;
  return data.digest({ ...stable, observation: anchor });
}
function pairHashes(first, second, record) {
  assert.notEqual(first.entry.id, second.entry.id);
  assert.equal(first.entry.state, 'signing');
  assert.equal(second.entry.state, 'signing');
  assert.equal(first.stored.capsule.version, 2);
  assert.equal(second.stored.capsule.version, 1);
  assert.equal(second.stored.capsule.selection.kind, 'railgun-token-unshield');
  for (const value of [first, second]) {
    assert.equal(value.stored.holdId, value.entry.id);
    assert.ok(value.stored.signature && value.stored.provedTransaction);
  }
  assert.equal(
    second.stored.capsule.noteHash,
    first.stored.capsule.preparation.expected.changeCommitment
  );
  assert.equal(
    second.stored.capsule.preparation.expected.amount,
    first.stored.capsule.preparation.changeAmount
  );
  assert.notEqual(second.entry.facts.nullifier, first.entry.facts.nullifier);
  assert.equal(second.entry.signing.submitter, first.entry.signing.submitter);
  assert.equal(second.stored.capsule.selection.recipient, first.entry.signing.submitter);
  const summarize = ({ entry, stored }) =>
    Object.fromEntries(
      Object.entries({
        holdId: entry.id,
        entry,
        stored,
        capsule: stored.capsule,
        signature: stored.signature,
        provedTransaction: stored.provedTransaction,
      }).map(([key, value]) => [key, data.digest(value)])
    );
  return {
    first: summarize(first),
    second: summarize(second),
    record: data.digest(record),
    immutableRecord: firstImmutable(record),
  };
}
function check(value) {
  exact(value, [
    'schema',
    'runID',
    'setupPID',
    'provePID',
    'inputCreator',
    'profile',
    'sourceHashes',
    'runtimes',
    'sourceSha256',
    'publicWireSha256',
    'setupReportSha256',
    'predecessorSha256',
    'proveReportSha256',
    'files',
    'records',
    'retained',
    'drainedAndProfileReleased',
  ]);
  assert.equal(value.schema, 'railgun-combined-second-proved-v1');
  assert.match(value.runID, /^[0-9a-f-]{36}$/);
  assert.ok(['Shield', 'Transact'].includes(value.inputCreator));
  assert.equal(value.drainedAndProfileReleased, true);
  for (const name of [
    'sourceSha256',
    'publicWireSha256',
    'setupReportSha256',
    'predecessorSha256',
    'proveReportSha256',
  ])
    hash(value[name]);
  exact(value.records, ['first', 'second', 'record', 'immutableRecord']);
  for (const name of ['first', 'second']) {
    exact(value.records[name], [
      'holdId',
      'entry',
      'stored',
      'capsule',
      'signature',
      'provedTransaction',
    ]);
    Object.values(value.records[name]).forEach(hash);
  }
  hash(value.records.record);
  hash(value.records.immutableRecord);
  assert.notEqual(value.records.first.holdId, value.records.second.holdId);
  exact(value.retained, ['entrySha256', 'inspectSha256']);
  Object.values(value.retained).forEach(hash);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 524288);
  return value;
}
function seal({ directory, predecessor, report, records, retained }) {
  assert.equal(report.secondProveStopQualified, true);
  assert.equal(report.secondColdSubmitQualified, false);
  assert.equal(report.provePID, process.pid);
  assert.equal(report.runID, predecessor.runID);
  data.assertGone(predecessor.setupPID);
  const reportFile = path.join(directory, 'second-prove-report.json');
  assert.deepEqual(data.readJson(reportFile), report);
  const handoff = check({
    schema: 'railgun-combined-second-proved-v1',
    runID: predecessor.runID,
    setupPID: predecessor.setupPID,
    provePID: process.pid,
    inputCreator: predecessor.inputCreator,
    profile: path.resolve(directory, 'profile'),
    sourceHashes: predecessor.sourceHashes,
    runtimes: predecessor.runtimes,
    sourceSha256: predecessor.sourceSha256,
    publicWireSha256: predecessor.publicWireSha256,
    setupReportSha256: predecessor.setupReportSha256,
    predecessorSha256: data.sha(fs.readFileSync(path.join(directory, 'restart-handoff.json'))),
    proveReportSha256: data.sha(fs.readFileSync(reportFile)),
    files: data.profileSnapshot(directory),
    records,
    retained,
    drainedAndProfileReleased: true,
  });
  fs.writeFileSync(
    path.join(directory, 'second-proved-handoff.json'),
    JSON.stringify(handoff, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 }
  );
  return handoff;
}
function load(directory, { inputCreator }) {
  const handoff = check(data.readJson(path.join(directory, 'second-proved-handoff.json')));
  assert.equal(handoff.inputCreator, inputCreator);
  assert.equal(handoff.profile, path.resolve(directory, 'profile'));
  assert.notEqual(handoff.setupPID, handoff.provePID);
  data.assertGone(handoff.setupPID);
  data.assertGone(handoff.provePID);
  for (const [file, field] of [
    ['restart-handoff.json', 'predecessorSha256'],
    ['report.json', 'setupReportSha256'],
    ['second-prove-report.json', 'proveReportSha256'],
  ])
    assert.equal(data.sha(fs.readFileSync(path.join(directory, file))), handoff[field]);
  const predecessor = data.readJson(path.join(directory, 'restart-handoff.json'));
  for (const name of [
    'runID',
    'setupPID',
    'inputCreator',
    'profile',
    'sourceHashes',
    'runtimes',
    'sourceSha256',
    'publicWireSha256',
    'setupReportSha256',
  ])
    assert.deepEqual(handoff[name], predecessor[name]);
  const report = data.readJson(path.join(directory, 'second-prove-report.json'));
  assert.equal(report.provePID, handoff.provePID);
  assert.equal(report.runID, handoff.runID);
  assert.equal(report.secondProveStopQualified, true);
  assert.equal(report.secondColdSubmitQualified, false);
  const wire = data.checkWire(data.readJson(path.join(directory, 'restart-wire.json'), 262144));
  assert.equal(data.digest(wire), handoff.publicWireSha256);
  assert.equal(wire.inputCreator, inputCreator);
  for (const key of ['entry', 'stored', 'capsule', 'signature', 'provedTransaction'])
    assert.equal(handoff.records.first[key], wire.privateHashes[key]);
  assert.deepEqual(data.profileSnapshot(directory), handoff.files);
  return { handoff, wire };
}
module.exports = { firstImmutable, pairHashes, check, seal, load };
