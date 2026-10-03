/** Cache compatibility for the pinned Sepolia public-state planner/apply pair.
 * Governance after the qualified historical capture requires fresh review.
 */
const fs = require('fs'),
  path = require('path');
const { createHash } = require('crypto');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const manifest = require('./railgun-engine-manifest.json');
const QUALIFIED_THROUGH = 11829346;
const SOURCES = Object.freeze([
  'railgun-public-policy.js',
  'railgun-public-run.js',
  'railgun-public-job.js',
  'railgun-event-projector.js',
  'railgun-public-records.js',
  'railgun-frontier.js',
  'railgun-tree-transactions.js',
  'railgun-remote.js',
  'railgun-scan-journal.js',
  'railgun-scan-coordinator.js',
  'railgun-scan-source.js',
  'railgun-source-ledger.js',
]);
function getRailgunPublicPolicy(archive) {
  verifyRailgunEngineRuntime(archive);
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  return sha(
    JSON.stringify({
      schema: 'freedom:railgun:public-policy-v1',
      chainId: 11155111,
      qualifiedThrough: QUALIFIED_THROUGH,
      engine: manifest.sha256,
      inventory: manifest.inventory.sha256,
      sources: SOURCES.map((name) => [name, sha(fs.readFileSync(path.join(__dirname, name)))]),
    })
  );
}
module.exports = { QUALIFIED_THROUGH, SOURCES, getRailgunPublicPolicy };
