/** Canonical public disposable draft only; no witness/key crosses the broker. */
const assert = require('assert/strict');
const { createVector, sha } = require('./railgun-relay-core-data');
let attempted = false;
exports.run = async (text, { request, signal, guardReport }) => {
  assert.equal(attempted, false);
  attempted = true;
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 4096);
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input), ['archive']);
  let vector;
  try {
    vector = await createVector(input.archive, signal);
    const draft =
      await require('../../src/main/wallet/railgun-relay-witness').prepareRailgunRelayDraft({
        ...vector.args,
        request: vector.request,
      });
    vector.active();
    const draftText = JSON.stringify(draft);
    assert.ok(Buffer.byteLength(draftText) <= 65536);
    const value = {
      draftText,
      draftSha256: sha(draftText),
      syntheticQuoteUnsigned: true,
      guards: guardReport(),
    };
    assert.deepEqual(value.guards, require('../qualify-railgun-relay-proof').EXPECTED_GUARDS);
    const wire = JSON.stringify({ id: 1, method: 'result', value });
    assert.ok(Buffer.byteLength(wire) <= 65536);
    assert.deepEqual(JSON.parse(await request(wire)), { id: 1, value: null });
    vector.active();
  } finally {
    vector?.close();
  }
};
