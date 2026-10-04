/** Combine two unchanged collectors over one authenticated visit. All returned
 * associations stay private. A caller-supplied capsule is a selector, not owned
 * operation evidence; this helper confers no source or account authority.
 */
const assert = require('assert/strict');
const { collectRailgunOwnSource } = require('./railgun-own-source');
const {
  collectRailgunPoiCreator,
  collectRailgunPoiTransactCreator,
} = require('./railgun-poi-creator');
const { normalizeRailgunPrivateCapsule } = require('./railgun-private-capsule');
const { railgunTransactIntentBinding } = require('./railgun-transact-intent');
const fail = () =>
  Object.assign(new Error('Railgun POI source evidence unavailable'), {
    code: 'RAILGUN_POI_SOURCE_EVIDENCE_REFUSED',
  });
async function collect(
  { capsule, record, transaction, receipt, checkpoint, visit, assertCurrent },
  transact = false
) {
  assert.ok(typeof visit === 'function' && typeof assertCurrent === 'function');
  const text = JSON.stringify({ capsule, record, transaction, receipt, checkpoint });
  assert.ok(Buffer.byteLength(text) <= 192 * 1024);
  const input = JSON.parse(text);
  input.capsule = normalizeRailgunPrivateCapsule(input.capsule);
  const binding = railgunTransactIntentBinding(input.capsule.preparation.transaction);
  assert.equal(input.capsule.selection.tree, binding.tree);
  for (const [key, value] of Object.entries(binding)) assert.equal(input.record.intent[key], value);
  let resolve, reject;
  const callbacks = [];
  const completion = new Promise((ok, bad) => {
    resolve = ok;
    reject = bad;
  });
  completion.catch(() => {});
  const register = (callback) => {
    assert.equal(typeof callback, 'function');
    assert.ok(callbacks.length < 2);
    callbacks.push(callback);
    return completion;
  };
  const common = { checkpoint: input.checkpoint, visit: register, assertCurrent };
  // These collectors register synchronously, before their first await. Observe
  // both promises immediately, including refusal before visitor registration.
  const settled = Promise.allSettled([
    (transact ? collectRailgunPoiTransactCreator : collectRailgunPoiCreator)({
      ...common,
      capsule: input.capsule,
    }),
    collectRailgunOwnSource({
      ...common,
      record: input.record,
      transaction: input.transaction,
      receipt: input.receipt,
    }),
  ]);
  try {
    assert.equal(callbacks.length, 2);
    assertCurrent();
    const totals = await visit(async (log) => {
      // Resource failures propagate to the genuine coordinator. Ordinary
      // semantic mismatches/local cancellation are latched by each collector.
      for (const callback of callbacks) await callback(log);
    });
    resolve(totals);
  } catch (error) {
    reject(error);
  }
  const results = await settled;
  assert.ok(results.every((r) => r.status === 'fulfilled'));
  assertCurrent();
  const [creator, own] = results.map((r) => r.value);
  assert.equal(creator.checkpointHash, own.checkpointHash);
  assert.deepEqual(creator.source, own.source);
  // This temporal check prevents a supplied creator from appearing after the
  // completed transaction, without claiming membership or capsule ownership.
  assert.ok(
    creator.origin.blockNumber < own.blockNumber ||
      (creator.origin.blockNumber === own.blockNumber &&
        creator.origin.transactionIndex < own.transactionIndex)
  );
  return Object.freeze({
    creator,
    own,
    checkpointHash: own.checkpointHash,
    source: own.source,
    sourceAuthenticated: false,
    ownershipAuthenticated: false,
    currentCanonicalityVerified: false,
    disclosureEnabled: false,
    spendingEnabled: false,
  });
}
exports.collectRailgunPoiSourceEvidence = async (options) => {
  try {
    return await collect(options);
  } catch {
    throw fail();
  }
};

exports.collectRailgunPoiTransactSourceEvidence = async (options) => {
  try {
    return await collect(options, true);
  } catch {
    throw fail();
  }
};
