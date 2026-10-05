/** Offline fixture construction only: a genuine Poseidon path for the exact
 * already-recovered selected note. No keys, stores, network or authority. */
const assert = require('assert/strict');
const path = require('path');
exports.run = async function run(text, { request, signal, guardReport }) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 4096);
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), ['archive', 'note']);
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const records = require('../../src/main/wallet/railgun-poi-records');
  const [note] = records.normalizePoiNotes([input.note]);
  assert.deepEqual(note, input.note);
  const root = path.join(archive, 'node_modules/@railgun-community/engine/dist');
  const { initPoseidonPromise, poseidonHex } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  assert.ok(!signal.aborted);
  const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
  const index = 5;
  const elements = Array.from({ length: 16 }, (_, i) => hex(i + 31));
  let merkleroot = note.blindedCommitment.slice(2);
  for (let level = 0; level < elements.length; level++)
    merkleroot = poseidonHex(
      index & (1 << level) ? [elements[level], merkleroot] : [merkleroot, elements[level]]
    );
  const proof = {
    leaf: note.blindedCommitment.slice(2),
    elements,
    indices: hex(index),
    root: merkleroot,
  };
  records.verifyPoiMembership([proof], [note], (a, b) => poseidonHex([a, b]));
  assert.ok(!signal.aborted);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(
      await request(
        JSON.stringify({
          id: 1,
          method: 'result',
          value: {
            proof,
            guards,
            inventory: require('../../src/main/wallet/railgun-engine-manifest.json').inventory
              .sha256,
          },
        })
      )
    ),
    { id: 1, value: null }
  );
  assert.ok(!signal.aborted);
};
