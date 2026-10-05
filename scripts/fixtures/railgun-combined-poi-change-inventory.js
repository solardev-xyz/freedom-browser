/** Fixture-only full account inventory. An ordinary wallet scan may update only
 * this genuine active wallet's SQLite/coverage and journal files. */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { assert } = require('./railgun-native-assertions');
const sha = (value) => createHash('sha256').update(value).digest('hex');
function snapshot(root) {
  const files = {};
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name),
        stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) visit(file);
      else {
        assert.equal(stat.isFile(), true);
        files[path.relative(root, file)] = sha(fs.readFileSync(file));
      }
    }
  };
  visit(root);
  return files;
}
function assertChanges(before, after, allowed) {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  const changed = Object.keys(before).filter((name) => before[name] !== after[name]);
  for (const name of changed) assert.ok(Object.hasOwn(allowed, name));
  return Object.freeze(changed.map((name) => allowed[name]).sort());
}
function observeWalletInventory({ enrollment, coordinator, archive }) {
  const { getRailgunAccountWalletPolicy } = require('../../src/main/wallet/railgun-account-wallet');
  const { getPrivacyStoragePath } = require('../../src/main/wallet/privacy-storage');
  const generation = enrollment.catalog.activeFor(
    getRailgunAccountWalletPolicy({ enrollment, coordinator, archive })
  );
  assert.ok(generation);
  const root = path.dirname(enrollment.directory),
    walletId = enrollment.descriptor.walletId;
  const targets = {
    walletAndCoverage: path.join(generation.directory, 'wallet.sqlite'),
    walletJournal: getPrivacyStoragePath(
      enrollment.getContext('storage', 'railgun-wallet-v1:' + walletId),
      generation.directory
    ),
  };
  const allowed = Object.fromEntries(
    Object.entries(targets).map(([label, file]) => {
      const name = path.relative(root, file);
      assert.ok(!name.startsWith('..') && !path.isAbsolute(name));
      assert.equal(fs.lstatSync(file).isFile(), true);
      return [name, label];
    })
  );
  const marker = path.join(path.dirname(root), 'wallet-privacy-inventory.json');
  const inventory = () => {
    const stat = fs.lstatSync(marker);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    return { ...snapshot(root), '@profile-inventory': sha(fs.readFileSync(marker)) };
  };
  const before = inventory();
  return Object.freeze({
    assertAfter() {
      return assertChanges(before, inventory(), allowed);
    },
  });
}
module.exports = { observeWalletInventory, assertChanges };
