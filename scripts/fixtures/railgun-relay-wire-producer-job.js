/** The original proof producer remains unchanged. Admission carries the exact
 * preselected public quote; this wrapper cannot authenticate a peer itself. */
const assert = require('assert/strict');
const data = require('./railgun-relay-wire-composition');
const parser = require('./railgun-relay-wire/policy');
let attempted = false;
exports.run = async function run(text, context) {
  assert.equal(attempted, false);
  attempted = true;
  const input = parser.parseBoundedJson(Buffer.from(text), data.LIMITS, data.LIMITS.resultBytes);
  assert.deepEqual(Object.keys(input).sort(), [
    'archive',
    'artifactDirectory',
    'proverArchive',
    'selection',
  ]);
  const { selection } = input;
  const snapshot = data.selectRelayWireInput(
    Buffer.from(
      JSON.stringify({ data: selection.signedDataHex, signature: selection.signatureHex })
    ),
    selection.recipient,
    selection.selectedAt,
    '100'
  );
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), JSON.parse(JSON.stringify(selection)));
  let previousWallMs = Date.now();
  data.assertSelectionCurrent(snapshot, previousWallMs, snapshot.selectedAt);
  assert.ok(!context.signal.aborted);
  const request = async (message) => {
    const now = Date.now();
    data.assertSelectionCurrent(snapshot, now, previousWallMs);
    previousWallMs = now;
    assert.ok(!context.signal.aborted);
    return context.request(message);
  };
  await require('./railgun-relay-proof-job').run(
    JSON.stringify({
      archive: input.archive,
      proverArchive: input.proverArchive,
      artifactDirectory: input.artifactDirectory,
      minGasPrice: 1,
    }),
    { ...context, request }
  );
};
