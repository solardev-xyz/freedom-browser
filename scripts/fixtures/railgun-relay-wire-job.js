/** Fresh guarded quote or wire job; only public fixed fixture data leaves. */
const assert = require('assert/strict');
const wire = require('./railgun-relay-wire-crypto');
const data = require('./railgun-relay-wire-composition');
const parser = require('./railgun-relay-wire/policy');
let attempted = false;
exports.run = async function run(text, { request, signal, guardReport }) {
  assert.equal(attempted, false);
  attempted = true;
  const input = parser.parseBoundedJson(Buffer.from(text), data.LIMITS, data.LIMITS.resultBytes);
  assert.ok(input.mode === 'quote' || input.mode === 'wire');
  const keys = ['mode', 'archive', 'wireBuild', 'wireBuildSha256', 'gasBundle', 'gasBundleSha256'];
  if (input.mode === 'wire') keys.push('selection', 'publicCase');
  assert.deepEqual(Object.keys(input).sort(), keys.sort());
  const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
  active();
  const context = await wire.loadContext(input);
  active();
  let value;
  if (input.mode === 'quote') {
    const selection = await wire.createSelection(context, Date.now());
    active();
    data.assertSelectionCurrent(selection, Date.now(), selection.selectedAt);
    value = {
      selection,
      originalByteSignaturesVerified: true,
      independentRecipientMatched: true,
      sourceFeeEquals100: true,
      authorityGranted: false,
    };
  } else {
    value = await wire.compose(context, input.selection, input.publicCase, active);
  }
  active();
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  const message = JSON.stringify({ id: 1, method: 'result', value: { ...value, guards } });
  assert.ok(Buffer.byteLength(message) <= data.LIMITS.resultBytes);
  assert.deepEqual(JSON.parse(await request(message)), { id: 1, value: null });
};
