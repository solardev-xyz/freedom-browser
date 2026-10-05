/** Disposable fixture integrity manifest, never wallet/consent authority. Public
 * wire is separate from encrypted profile state and must not contain a capsule,
 * plaintext note, seed, loan, live receipt, or acceptance implementation. */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { assert } = require('./railgun-native-assertions');
const sha = (v) => createHash('sha256').update(v).digest('hex');
const digest = (v) => sha(JSON.stringify(v));
function readJson(filename, max = 4 * 1024 * 1024) {
  const st = fs.lstatSync(filename);
  assert.ok(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size > 0 && st.size <= max);
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function snapshot(root) {
  const result = {};
  const visit = (dir) => {
    assert.ok(fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink());
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name),
        st = fs.lstatSync(file);
      assert.equal(st.isSymbolicLink(), false);
      if (st.isDirectory()) visit(file);
      else {
        assert.ok(st.isFile() && st.nlink === 1);
        result[path.relative(root, file)] = sha(fs.readFileSync(file));
      }
    }
  };
  visit(root);
  assert.ok(Object.keys(result).length > 0 && Object.keys(result).length <= 512);
  return result;
}
function profileSnapshot(directory) {
  const profile = path.join(directory, 'profile');
  const single = (name) => {
    const file = path.join(profile, name),
      st = fs.lstatSync(file);
    assert.ok(st.isFile() && !st.isSymbolicLink() && st.nlink === 1);
    return sha(fs.readFileSync(file));
  };
  return {
    accounts: snapshot(path.join(profile, 'wallet-railgun-accounts')),
    submissions: snapshot(path.join(profile, 'wallet-private-submissions')),
    inventory: single('wallet-privacy-inventory.json'),
    encryptedVault: single('identity/identity-vault.json'),
  };
}
function exact(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), keys.slice().sort());
}
function checkWire(value) {
  exact(value, [
    'schema',
    'transaction',
    'receipt',
    'history',
    'publicIdentity',
    'checkpoint',
    'retained',
    'privateHashes',
    'list',
    'acceptedBodySha256',
    'inputCreator',
  ]);
  assert.equal(value.schema, 'railgun-combined-change-public-wire-v1');
  assert.ok(['Shield', 'Transact'].includes(value.inputCreator));
  exact(value.history, ['rows', 'state', 'checkpoints', 'finalized']);
  assert.equal(value.history.rows.length, value.inputCreator === 'Shield' ? 1 : 2);
  assert.equal(value.history.checkpoints.length, value.history.rows.length);
  assert.deepEqual(value.history.checkpoints.at(-1), value.history.state);
  assert.equal(value.history.state.count, value.history.rows.length);
  assert.equal(value.history.rows.at(-1).txid, value.transaction.hash.slice(2));
  assert.equal(value.receipt.transactionHash, value.transaction.hash);
  assert.equal(value.receipt.from, value.transaction.from);
  assert.equal(value.receipt.blockHash, value.transaction.blockHash);
  exact(value.privateHashes, [
    'entry',
    'stored',
    'capsule',
    'signature',
    'provedTransaction',
    'record',
  ]);
  for (const hash of Object.values(value.privateHashes)) assert.match(hash, /^[a-f0-9]{64}$/);
  exact(value.retained, ['capsuleDigest', 'entrySha256', 'inspect']);
  assert.match(value.retained.capsuleDigest, /^[a-f0-9]{64}$/);
  assert.match(value.retained.entrySha256, /^[a-f0-9]{64}$/);
  assert.equal(value.retained.inspect.reservedTransitions, 2);
  assert.match(value.acceptedBodySha256, /^[a-f0-9]{64}$/);
  // All nested wire fields are later parsed by genuine production normalizers.
  // Explicit top-level whitelist prevents serializing the private continuation.
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 262144);
  return JSON.parse(JSON.stringify(value));
}
function assertGone(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  assert.throws(
    () => process.kill(pid, 0),
    (e) => e.code === 'ESRCH'
  );
}
function runtimeHashes({ archive, proverArchive, artifactDirectory, bytecodes }) {
  const originalFs = require('original-fs');
  return {
    engine: sha(originalFs.readFileSync(archive)),
    prover: sha(originalFs.readFileSync(proverArchive)),
    bytecodes: sha(fs.readFileSync(bytecodes)),
    artifacts: Object.fromEntries(
      ['01x01', '01x02', 'POI_3x3'].flatMap((c) =>
        ['wasm', 'zkey', 'vkey'].map((ext) => {
          const name = c + '.' + ext;
          return [name, sha(fs.readFileSync(path.join(artifactDirectory, name)))];
        })
      )
    ),
  };
}
function seal({ directory, wire, report, sourceHashes, runtimes, sourceSha256, runID }) {
  checkWire(wire);
  assert.equal(report.runID, runID);
  assert.equal(report.setupPID, process.pid);
  assert.equal(report.connected.disposableChangeMembershipVerified, true);
  assert.equal(report.connected.acceptance.accepted, true);
  assert.equal(report.connected.acceptance.verifierExits, 1);
  assert.equal(report.connected.acceptance.bindingExits, 1);
  assert.equal(report.secondSpendQualified, false);
  const reportFile = path.join(directory, 'report.json');
  assert.deepEqual(readJson(reportFile), report);
  const handoff = {
    schema: 'railgun-combined-change-restart-v1',
    runID,
    setupPID: process.pid,
    inputCreator: wire.inputCreator,
    profile: path.resolve(directory, 'profile'),
    sourceHashes,
    runtimes,
    sourceSha256,
    publicWireSha256: digest(wire),
    setupReportSha256: sha(fs.readFileSync(reportFile)),
    files: profileSnapshot(directory),
    drainedAndProfileReleased: true,
  };
  for (const [name, value] of [
    ['restart-wire.json', wire],
    ['restart-handoff.json', handoff],
  ])
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  return handoff;
}
function load(directory, { inputCreator }) {
  const handoff = readJson(path.join(directory, 'restart-handoff.json'));
  exact(handoff, [
    'schema',
    'runID',
    'setupPID',
    'inputCreator',
    'profile',
    'sourceHashes',
    'runtimes',
    'sourceSha256',
    'publicWireSha256',
    'setupReportSha256',
    'files',
    'drainedAndProfileReleased',
  ]);
  assert.equal(handoff.schema, 'railgun-combined-change-restart-v1');
  assert.match(
    handoff.runID,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
  );
  assert.equal(handoff.drainedAndProfileReleased, true);
  assert.equal(handoff.inputCreator, inputCreator);
  assert.equal(handoff.profile, path.resolve(directory, 'profile'));
  assertGone(handoff.setupPID);
  const wire = checkWire(readJson(path.join(directory, 'restart-wire.json'), 262144));
  assert.equal(wire.inputCreator, inputCreator);
  assert.equal(digest(wire), handoff.publicWireSha256);
  assert.equal(
    sha(fs.readFileSync(path.join(directory, 'report.json'))),
    handoff.setupReportSha256
  );
  const report = readJson(path.join(directory, 'report.json'));
  assert.equal(report.runID, handoff.runID);
  assert.equal(report.setupPID, handoff.setupPID);
  assert.equal(report.connected.disposableChangeMembershipVerified, true);
  assert.deepEqual(profileSnapshot(directory), handoff.files);
  return { handoff, wire };
}
module.exports = {
  sha,
  digest,
  readJson,
  profileSnapshot,
  checkWire,
  assertGone,
  runtimeHashes,
  seal,
  load,
};
