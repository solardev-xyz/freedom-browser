/** Assertion-only observer of genuine recovery writes; never substitutes data. */
const { assert } = require('./railgun-native-assertions');
const copy = (v) => JSON.parse(JSON.stringify(v));
function create() {
  let baseline,
    sequence,
    proofs = 0,
    floors = 0;
  const files = new Set();
  return Object.freeze({
    arm(second) {
      assert.equal(baseline, undefined);
      assert.equal(second.stored.provedTransaction, null);
      baseline = copy(second);
    },
    inspect(name, previous, next, filename) {
      assert.ok(baseline);
      assert.notEqual(previous, null);
      const old = JSON.parse(previous),
        value = JSON.parse(next);
      if (name === 'railgun-private-capsules-v1') {
        assert.equal(proofs, 0);
        assert.equal(old.entries.length, 2);
        const found = old.entries.filter((v) => v.holdId === baseline.entry.id);
        assert.deepEqual(found, [baseline.stored]);
        const replaced = value.entries.filter((v) => v.holdId === baseline.entry.id);
        assert.equal(replaced.length, 1);
        assert.ok(replaced[0].provedTransaction);
        assert.deepEqual(replaced[0], {
          ...baseline.stored,
          provedTransaction: replaced[0].provedTransaction,
        });
        assert.deepEqual(value, {
          ...old,
          sequence: old.sequence + 1,
          entries: old.entries.map((v) => (v.holdId === baseline.entry.id ? replaced[0] : v)),
        });
        sequence = value.sequence;
        proofs++;
      } else {
        assert.equal(name, 'railgun-private-capsules-floor-v1');
        assert.equal(proofs, 1);
        assert.equal(floors, 0);
        assert.equal(value.sequence, sequence);
        assert.deepEqual(value, { ...old, sequence: old.sequence + 1 });
        floors++;
      }
      files.add(filename);
    },
    assertComplete() {
      assert.equal(proofs, 1);
      assert.equal(floors, 1);
      assert.equal(files.size, 2);
    },
    report: () => ({
      proofWrites: proofs,
      floorWrites: floors,
      files: [...files].sort(),
    }),
  });
}
module.exports = { create };
