/** POI account comparisons. Before an attempt, callers also bind the checked
 * archival representation. After persistence, stable account facts remain bound
 * while genuine recovery separately authenticates valid journal evolution.
 */
const assert = require('assert/strict');
function assertRailgunOwnPoiStableCapture(current, baseline) {
  for (const key of [
    'bindingDigest',
    'selector',
    'facts',
    'submitter',
    'capsule',
    'capsuleDigest',
    'provedTransaction',
    'intent',
    'projection',
  ])
    assert.deepEqual(current[key], baseline[key]);
}
function assertRailgunOwnPoiCapture(current, baseline) {
  assertRailgunOwnPoiStableCapture(current, baseline);
  const anchor = (record) =>
    Object.hasOwn(record, 'archivedAt')
      ? { archived: true, finalized: record.finalized }
      : { archived: false };
  assert.deepEqual(anchor(current.record), anchor(baseline.record));
}
module.exports = { assertRailgunOwnPoiCapture, assertRailgunOwnPoiStableCapture };
