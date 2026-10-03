/** Main-owned TXID compatibility. A changed policy selects a separate mirror
 * within the public generation; existing encrypted files are retained.
 */
const fs = require('fs');
const { createHash } = require('crypto');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const engine = require('./railgun-engine-manifest.json');
const SOURCES = Object.freeze([
  'railgun-txid-policy',
  'railgun-txid-projection',
  'railgun-txid-note-witness',
  'railgun-txid-omissions',
  'railgun-txid-events',
  'railgun-txid-coverage',
  'railgun-source-feed',
  'railgun-event-projector',
  'railgun-public-policy',
  'railgun-txid-job',
  'railgun-txid-runner',
  'railgun-txid-journal',
  'railgun-txid-root',
  'railgun-public-services',
  'railgun-public-records',
  'railgun-frontier',
  'railgun-remote',
]);
const sha = (v) => createHash('sha256').update(v).digest('hex');
function railgunTxidBinding(binding) {
  if (typeof binding !== 'string' || !/^[0-9a-f]{64}$/.test(binding))
    throw Object.assign(new Error('Railgun TXID binding unavailable'), {
      code: 'RAILGUN_TXID_BINDING_REFUSED',
    });
  return sha(JSON.stringify(['freedom:railgun:txid-store-v1', binding]));
}
function getRailgunTxidPolicy(archive) {
  verifyRailgunEngineRuntime(archive);
  return sha(
    JSON.stringify([
      'freedom:railgun:txid-policy-v1',
      'sepolia',
      11155111,
      engine.sha256,
      engine.inventory.sha256,
      SOURCES.map((name) => [name, sha(fs.readFileSync(require.resolve('./' + name)))]),
    ])
  );
}
module.exports = { getRailgunTxidPolicy, railgunTxidBinding, SOURCES };
