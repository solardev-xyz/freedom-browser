/** Stable POI account comparison. General recovery deliberately has a weaker
 * representation policy; POI callers also bind the checked archival anchor.
 */
const assert = require('assert/strict');
function assertRailgunOwnPoiCapture(current, baseline) {
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
  const anchor = (record) =>
    Object.hasOwn(record, 'archivedAt')
      ? { archived: true, finalized: record.finalized }
      : { archived: false };
  assert.deepEqual(anchor(current.record), anchor(baseline.record));
}
module.exports = { assertRailgunOwnPoiCapture };
