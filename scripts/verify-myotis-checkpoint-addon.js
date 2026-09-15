// Constructor-only native checks: no network nodes are started or user data used.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function verifyAddon(addonPath) {
  const addon = require(path.resolve(addonPath));
  assert.equal(addon.init(), 25);
  assert.equal(addon.checkpointImportVersion(), 1);
  assert.equal(typeof addon.createWithCheckpoint, 'function');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-myotis-constructor-'));
  const untouched = path.join(directory, 'invalid-must-not-exist');
  // Synthetic syntax fixtures only. No claim that this root belongs to a chain:
  // root authentication is the host's responsibility before real startup.
  const root = `0x${'11'.repeat(32)}`;
  for (const slot of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(addon.createWithCheckpoint('gnosis', untouched, root, slot), -1);
  }
  for (const malformed of ['0x00', `0x${'00'.repeat(32)}`, `0x${'gg'.repeat(32)}`]) {
    assert.equal(addon.createWithCheckpoint('gnosis', untouched, malformed, 1), -1);
  }
  assert.equal(addon.createWithCheckpoint('unknown', untouched, root, 1), -1);
  assert.ok(addon.createWithCheckpoint('sepolia', untouched, root, 1) < 0);
  assert.equal(addon.createWithCheckpoint('gnosis', 'relative-directory', root, 1), -1);
  assert.equal(addon.createWithCheckpoint('gnosis', untouched, root, Number.MAX_SAFE_INTEGER), -1);
  assert.equal(fs.existsSync(untouched), false);

  for (const [network, filename] of [
    ['mainnet', 'sync-state.snapshot'],
    ['gnosis', 'sync-state-gnosis.snapshot'],
  ]) {
    const dataDir = path.join(directory, network);
    const handle = addon.createWithCheckpoint(network, dataDir, root, 1);
    assert.ok(handle > 0);
    addon.stop(handle);
    // A real host only sets resume=true after verifying its immutable generation
    // record. Here we check the explicit constructor switch without starting it.
    fs.writeFileSync(path.join(dataDir, filename), 'constructor-only fixture');
    assert.equal(addon.createWithCheckpoint(network, dataDir, root, 1), -1);
    assert.equal(addon.createWithCheckpoint(network, dataDir, root, 1, false), -1);
    const resumed = addon.createWithCheckpoint(network, dataDir, root, 1, true);
    assert.ok(resumed > 0);
    addon.stop(resumed);
    assert.equal(fs.readFileSync(path.join(dataDir, filename), 'utf8'), 'constructor-only fixture');
  }
  console.log('Myotis ABI 25 / checkpoint import v1 constructor checks passed (no networking)');
}

if (require.main === module) verifyAddon(process.argv[2]);
module.exports = { verifyAddon };
