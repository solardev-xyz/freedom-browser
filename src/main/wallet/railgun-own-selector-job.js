/** Detached keyless 1x1 TXID derivation. No provider, store or wallet key. */
const assert = require('assert/strict');
const path = require('path');
const { createRequire } = require('module');
const { createHash } = require('crypto');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
exports.run = async function run(text, { request, signal, guardReport }) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  assert.ok(!signal.aborted);
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), ['archive', 'bindingDigest', 'facts']);
  assert.match(input.bindingDigest, /^[0-9a-f]{64}$/);
  const facts = input.facts;
  assert.deepEqual(Object.keys(facts).sort(), ['boundParamsHash', 'commitments', 'nullifiers']);
  assert.ok(Array.isArray(facts.nullifiers) && facts.nullifiers.length === 1);
  assert.ok(Array.isArray(facts.commitments) && facts.commitments.length === 1);
  for (const field of [...facts.nullifiers, ...facts.commitments, facts.boundParamsHash]) {
    assert.match(field, /^0x[0-9a-f]{64}$/);
    assert.ok(BigInt(field) < FIELD);
  }
  const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive);
  const r = createRequire(path.join(archive, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  await require(path.join(root, 'utils/poseidon')).initPoseidonPromise;
  assert.ok(!signal.aborted);
  const { getRailgunTransactionIDHex } = require(path.join(root, 'transaction/railgun-txid'));
  const railgunTxid = getRailgunTransactionIDHex(facts);
  assert.match(railgunTxid, /^[0-9a-f]{64}$/);
  assert.ok(BigInt('0x' + railgunTxid) < FIELD);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(
      await request(
        JSON.stringify({
          id: 1,
          method: 'result',
          value: {
            inputSha256: createHash('sha256').update(text).digest('hex'),
            bindingDigest: input.bindingDigest,
            railgunTxid,
            selectorDerived: true,
            sourceAuthenticated: false,
            rootAccepted: false,
            spendingEnabled: false,
            guards,
            inventory: require('./railgun-engine-manifest.json').inventory.sha256,
          },
        })
      )
    ),
    { id: 1, value: null }
  );
  assert.ok(!signal.aborted);
};
