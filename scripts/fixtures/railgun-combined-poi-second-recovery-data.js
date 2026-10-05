/** C-only signed/proof-stored boundaries. Saved hashes never issue a receipt. */
const fs = require('fs');
const path = require('path');
const { assert } = require('./railgun-native-assertions');
const data = require('./railgun-combined-poi-restart-data');
const proved = require('./railgun-combined-poi-second-handoff');
const copy = (v) => JSON.parse(JSON.stringify(v));
const exact = (v, keys) => {
  assert.ok(v && Object.getPrototypeOf(v) === Object.prototype);
  assert.deepEqual(Object.keys(v).sort(), keys.slice().sort());
};
function signedHashes(first, second, record) {
  assert.notEqual(first.entry.id, second.entry.id);
  for (const item of [first, second]) {
    assert.equal(item.entry.state, 'signing');
    assert.equal(item.entry.id, item.stored.holdId);
    assert.ok(item.stored.signature);
  }
  assert.equal(first.stored.capsule.version, 2);
  assert.ok(first.stored.provedTransaction);
  assert.equal(second.stored.capsule.version, 1);
  assert.equal(second.stored.capsule.selection.kind, 'railgun-token-unshield');
  assert.equal(second.stored.provedTransaction, null);
  assert.equal(
    second.stored.capsule.noteHash,
    first.stored.capsule.preparation.expected.changeCommitment
  );
  assert.equal(
    second.stored.capsule.preparation.expected.amount,
    first.stored.capsule.preparation.changeAmount
  );
  assert.equal(second.entry.signing.submitter, first.entry.signing.submitter);
  assert.equal(second.stored.capsule.selection.recipient, first.entry.signing.submitter);
  assert.notEqual(second.entry.facts.nullifier, first.entry.facts.nullifier);
  const summarize = ({ entry, stored }) =>
    Object.fromEntries(
      Object.entries({
        holdId: entry.id,
        entry,
        stored,
        capsule: stored.capsule,
        signature: stored.signature,
        provedTransaction: stored.provedTransaction,
      }).map(([k, v]) => [k, k === 'provedTransaction' && v === null ? null : data.digest(v)])
    );
  return {
    first: summarize(first),
    second: summarize(second),
    record: data.digest(record),
    immutableRecord: proved.firstImmutable(record),
  };
}
async function readUnfinishedPair(enrollment, expected) {
  const { reservations, capsules } = await enrollment.openPrivateRecoveryStores();
  const pair = {};
  await reservations.withSigningRecovery(async (records, context) => {
    context.assertCurrent();
    assert.equal(records.length, 2);
    for (const name of ['first', 'second']) {
      const matches = records.filter(
        ({ entry }) => data.digest(entry.id) === expected[name].holdId
      );
      assert.equal(matches.length, 1);
      const item = matches[0];
      const stored = await (name === 'first'
        ? capsules.readSigned(item.receipt)
        : capsules.readSignedUnfinished(item.receipt));
      context.assertCurrent();
      pair[name] = { entry: copy(item.entry), stored: copy(stored) };
      for (const [k, v] of Object.entries({
        entry: item.entry,
        stored,
        capsule: stored.capsule,
        signature: stored.signature,
        provedTransaction: stored.provedTransaction,
      }))
        assert.equal(
          k === 'provedTransaction' && v === null ? null : data.digest(v),
          expected[name][k]
        );
    }
    context.assertCurrent();
  });
  return pair;
}
const filenames = {
  'signed-unfinished': [
    'second-signed-handoff.json',
    'second-sign-report.json',
    'restart-handoff.json',
  ],
  'proof-stored': [
    'second-recovered-handoff.json',
    'second-recover-report.json',
    'second-signed-handoff.json',
  ],
};
function check(value, stage) {
  exact(value, [
    'schema',
    'stage',
    'runID',
    'setupPID',
    'signPID',
    'recoverPID',
    'inputCreator',
    'profile',
    'sourceHashes',
    'runtimes',
    'sourceSha256',
    'publicWireSha256',
    'setupReportSha256',
    'predecessorSha256',
    'reportSha256',
    'files',
    'records',
    'retained',
    'drainedAndProfileReleased',
  ]);
  assert.equal(value.schema, 'railgun-combined-second-recovery-v1');
  assert.equal(value.stage, stage);
  assert.ok(filenames[stage]);
  assert.equal(value.drainedAndProfileReleased, true);
  assert.match(value.runID, /^[0-9a-f-]{36}$/);
  assert.ok(['Shield', 'Transact'].includes(value.inputCreator));
  for (const key of [
    'sourceSha256',
    'publicWireSha256',
    'setupReportSha256',
    'predecessorSha256',
    'reportSha256',
  ])
    assert.match(value[key], /^[a-f0-9]{64}$/);
  for (const key of ['setupPID', 'signPID'])
    assert.ok(Number.isSafeInteger(value[key]) && value[key] > 0);
  assert.notEqual(value.setupPID, value.signPID);
  if (stage === 'signed-unfinished') assert.equal(value.recoverPID, null);
  else {
    assert.ok(Number.isSafeInteger(value.recoverPID) && value.recoverPID > 0);
    assert.ok(![value.setupPID, value.signPID].includes(value.recoverPID));
  }
  for (const key of ['encryptedVault', 'publicVaultMetadata'])
    assert.match(value.files[key], /^[a-f0-9]{64}$/);
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
    for (const [key, v] of Object.entries(value.records[name])) {
      if (stage === 'signed-unfinished' && name === 'second' && key === 'provedTransaction')
        assert.equal(v, null);
      else assert.match(v, /^[a-f0-9]{64}$/);
    }
  }
  assert.notEqual(value.records.first.holdId, value.records.second.holdId);
  for (const key of ['record', 'immutableRecord'])
    assert.match(value.records[key], /^[a-f0-9]{64}$/);
  exact(value.retained, ['entrySha256', 'inspectSha256']);
  Object.values(value.retained).forEach((v) => assert.match(v, /^[a-f0-9]{64}$/));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 524288);
  return value;
}
function seal({ directory, predecessor, report, records, retained }, stage) {
  const [filename, reportName, priorName] = filenames[stage];
  const signed = stage === 'signed-unfinished';
  assert.equal(report.secondSignStopQualified, signed);
  assert.equal(report.secondRecoveryStopQualified, !signed);
  assert.equal(report.secondColdSubmitQualified, false);
  assert.equal(report[signed ? 'signPID' : 'recoverPID'], process.pid);
  assert.equal(report.runID, predecessor.runID);
  data.assertGone(predecessor.setupPID);
  if (!signed) {
    check(predecessor, 'signed-unfinished');
    data.assertGone(predecessor.signPID);
  }
  const reportFile = path.join(directory, reportName);
  assert.deepEqual(data.readJson(reportFile), report);
  const v = check(
    {
      schema: 'railgun-combined-second-recovery-v1',
      stage,
      runID: predecessor.runID,
      setupPID: predecessor.setupPID,
      signPID: signed ? process.pid : predecessor.signPID,
      recoverPID: signed ? null : process.pid,
      inputCreator: predecessor.inputCreator,
      profile: path.resolve(directory, 'profile'),
      sourceHashes: predecessor.sourceHashes,
      runtimes: predecessor.runtimes,
      sourceSha256: predecessor.sourceSha256,
      publicWireSha256: predecessor.publicWireSha256,
      setupReportSha256: predecessor.setupReportSha256,
      predecessorSha256: data.sha(fs.readFileSync(path.join(directory, priorName))),
      reportSha256: data.sha(fs.readFileSync(reportFile)),
      files: data.profileSnapshot(directory),
      records,
      retained,
      drainedAndProfileReleased: true,
    },
    stage
  );
  for (const key of ['encryptedVault', 'publicVaultMetadata'])
    assert.equal(v.files[key], predecessor.files[key]);
  if (!signed) {
    assert.deepEqual(v.records.first, predecessor.records.first);
    for (const key of ['holdId', 'entry', 'capsule', 'signature'])
      assert.equal(v.records.second[key], predecessor.records.second[key]);
    assert.equal(v.records.record, predecessor.records.record);
    assert.equal(v.records.immutableRecord, predecessor.records.immutableRecord);
    assert.deepEqual(v.retained, predecessor.retained);
  }
  fs.writeFileSync(path.join(directory, filename), JSON.stringify(v, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return v;
}
function readChain(directory, stage) {
  const [filename, reportName, priorName] = filenames[stage];
  const v = check(data.readJson(path.join(directory, filename)), stage);
  assert.equal(v.profile, path.resolve(directory, 'profile'));
  for (const key of ['setupPID', 'signPID', ...(stage === 'proof-stored' ? ['recoverPID'] : [])])
    data.assertGone(v[key]);
  const prior =
    stage === 'proof-stored'
      ? readChain(directory, 'signed-unfinished')
      : data.readJson(path.join(directory, priorName));
  for (const key of [
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
    assert.deepEqual(v[key], prior[key]);
  for (const key of ['encryptedVault', 'publicVaultMetadata'])
    assert.equal(v.files[key], prior.files[key]);
  assert.equal(data.sha(fs.readFileSync(path.join(directory, priorName))), v.predecessorSha256);
  assert.equal(data.sha(fs.readFileSync(path.join(directory, reportName))), v.reportSha256);
  assert.equal(data.sha(fs.readFileSync(path.join(directory, 'report.json'))), v.setupReportSha256);
  const report = data.readJson(path.join(directory, reportName));
  assert.equal(report.runID, v.runID);
  assert.equal(
    report[stage === 'proof-stored' ? 'recoverPID' : 'signPID'],
    v[stage === 'proof-stored' ? 'recoverPID' : 'signPID']
  );
  assert.equal(report.secondSignStopQualified, stage === 'signed-unfinished');
  assert.equal(report.secondRecoveryStopQualified, stage === 'proof-stored');
  assert.equal(report.secondColdSubmitQualified, false);
  if (stage === 'proof-stored') {
    assert.equal(v.signPID, prior.signPID);
    assert.deepEqual(v.records.first, prior.records.first);
    for (const k of ['holdId', 'entry', 'capsule', 'signature'])
      assert.equal(v.records.second[k], prior.records.second[k]);
    for (const k of ['record', 'immutableRecord']) assert.equal(v.records[k], prior.records[k]);
    assert.deepEqual(v.retained, prior.retained);
  }
  return v;
}
function load(directory, options, stage) {
  const handoff = readChain(directory, stage);
  assert.equal(handoff.inputCreator, options.inputCreator);
  const wire = data.checkWire(data.readJson(path.join(directory, 'restart-wire.json'), 262144));
  assert.equal(data.digest(wire), handoff.publicWireSha256);
  assert.equal(wire.inputCreator, handoff.inputCreator);
  for (const k of ['entry', 'stored', 'capsule', 'signature', 'provedTransaction'])
    assert.equal(handoff.records.first[k], wire.privateHashes[k]);
  assert.deepEqual(data.profileSnapshot(directory), handoff.files);
  return { handoff, wire };
}
module.exports = {
  signedHashes,
  readUnfinishedPair,
  check,
  sealSigned: (o) => seal(o, 'signed-unfinished'),
  sealRecovered: (o) => seal(o, 'proof-stored'),
  loadSigned: (d, o) => load(d, o, 'signed-unfinished'),
  loadRecovered: (d, o) => load(d, o, 'proof-stored'),
};
