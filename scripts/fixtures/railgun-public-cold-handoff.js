/** Public-vector handoff and encrypted-file seals, never a serialized capability. */
const fs = require('fs');
const path = require('path');
const { assert } = require('./railgun-native-assertions');
const { digest, exact, inventory, validateChain } = require('./railgun-public-cold-data');
const PHASES = ['setup', 'resolve', 'restore'];
function read(file) {
  const s = fs.lstatSync(file);
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size > 0 && s.size < 16000000);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function write(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
function profileFiles(profile) {
  // Explicit encrypted wallet scope; excludes Chromium caches/preferences and
  // the ephemeral profile-open lock. Metadata/vault are included, not inferred.
  const result = {};
  for (const name of ['identity', 'wallet-railgun-accounts', 'wallet-private-submissions']) {
    const directory = path.join(profile, name);
    assert.ok(fs.lstatSync(directory).isDirectory());
    for (const [file, hash] of Object.entries(inventory(directory)))
      result[name + '/' + file] = hash;
  }
  const marker = 'wallet-privacy-inventory.json';
  result[marker] = digest(fs.readFileSync(path.join(profile, marker)));
  assert.ok(Object.hasOwn(result, 'identity/identity-vault.json'));
  assert.ok(Object.hasOwn(result, 'identity/vault-meta.json'));
  return result;
}
function assertHandoff(value, { phase, mode, inputs, sourceHashes, pid, isAlive }) {
  exact(value, [
    'schema',
    'phase',
    'mode',
    'pid',
    'inputs',
    'sourceHashes',
    'profileFiles',
    'chainSha256',
    'owner',
    'baseline',
    'creditSha256',
    'record',
  ]);
  assert.equal(value.schema, 'railgun-public-cold-credit-v1');
  assert.equal(value.phase, PHASES[PHASES.indexOf(phase) - 1]);
  assert.equal(value.mode, mode);
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid !== pid);
  assert.equal(isAlive(value.pid), false, 'Predecessor must exit before cold resume');
  assert.deepEqual(value.inputs, inputs);
  assert.deepEqual(value.sourceHashes, sourceHashes);
  assert.match(value.owner, /^0x[0-9a-f]{40}$/);
  assert.match(value.chainSha256, /^[0-9a-f]{64}$/);
  exact(value.baseline, ['notesSha256', 'balanceSha256', 'checkpoint']);
  for (const key of ['notesSha256', 'balanceSha256'])
    assert.match(value.baseline[key], /^[0-9a-f]{64}$/);
  exact(value.record, ['hash', 'nonce', 'intentSha256', 'attemptedAt']);
  assert.match(value.record.hash, /^0x[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(value.record.nonce) && value.record.nonce >= 0);
  assert.match(value.record.intentSha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(value.record.attemptedAt));
  if (value.phase === 'setup') assert.equal(value.creditSha256, null);
  else assert.match(value.creditSha256, /^[0-9a-f]{64}$/);
  return value;
}
function recordBinding(record) {
  return {
    hash: record.hash,
    nonce: record.nonce,
    intentSha256: digest(record.intent),
    attemptedAt: record.attemptedAt,
  };
}
function load(directory, options) {
  const value = assertHandoff(
    read(path.join(directory, PHASES[PHASES.indexOf(options.phase) - 1] + '-handoff.json')),
    options
  );
  assert.deepEqual(profileFiles(path.join(directory, 'profile')), value.profileFiles);
  const chain = read(path.join(directory, 'public-wire.json'));
  assert.equal(digest(chain), value.chainSha256);
  validateChain(chain);
  assert.equal(chain.transaction.from, value.owner);
  assert.equal(chain.transaction.hash, value.record.hash);
  return { value, chain };
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
module.exports = { PHASES, read, write, profileFiles, assertHandoff, recordBinding, load, isAlive };
