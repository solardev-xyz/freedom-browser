/** No-network membership computation with the authenticated engine archive.
 * No vault material, storage or signing capability is available to this job.
 */
const assert = require('assert/strict'),
  path = require('path');
const { createRequire } = require('module');
exports.run = async function run(text, { request, signal, guardReport }) {
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input), ['archive']);
  const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive);
  const r = createRequire(path.join(archive, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  assert.ok(root.startsWith(archive + path.sep));
  const { initPoseidonPromise, poseidonHex } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  const reply = JSON.parse(await request(JSON.stringify({ id: 1, method: 'input' })));
  assert.deepEqual(Object.keys(reply).sort(), ['id', 'value']);
  assert.equal(reply.id, 1);
  const { notes, proofs } = reply.value;
  assert.deepEqual(Object.keys(reply.value).sort(), ['notes', 'proofs']);
  assert.ok(!signal.aborted);
  const verified = require('./railgun-poi-records').verifyPoiMembership(proofs, notes, (a, b) =>
    poseidonHex([a, b])
  );
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(
      await request(
        JSON.stringify({
          id: 2,
          method: 'result',
          value: {
            proofs: verified,
            inventory: require('./railgun-engine-manifest.json').inventory.sha256,
            guards,
          },
        })
      )
    ),
    { id: 2, value: null }
  );
};
