/** Main-owned TXID compatibility. A changed policy selects a separate mirror
 * within the public generation; existing encrypted files are retained.
 */
const fs = require('fs');
const path = require('path');
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
const adapterSources = Object.freeze([
  'package.json',
  'host-poi.cjs',
  'src/data/railgun-poi-records.js',
  'src/data/railgun-poi-payload.js',
  'src/data/railgun-poi-creator-data.js',
  'src/data/railgun-poi-shield-selector-data.js',
  'src/data/railgun-poi-transact-selector-data.js',
  'src/data/railgun-own-poi-binding.js',
  'src/data/railgun-own-poi-shape-data.js',
  'src/data/railgun-owned-poi-records.js',
  'src/data/railgun-poi-submit-data.js',
  'src/data/railgun-txid-note-witness.js',
  'src/data/railgun-txid-projection.js',
  'src/data/railgun-txid-omissions.js',
  'src/data/railgun-own-poi-payload-binding.js',
  'src/data/railgun-private-capsule.js',
  'src/data/railgun-private-offer.js',
  'src/data/railgun-private-policy.js',
  'src/data/railgun-private-intent.js',
  'src/data/railgun-private-destination.js',
  'src/railgun-shield-pins.json',
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
      [
        ...SOURCES.map((name) => [name, sha(fs.readFileSync(require.resolve('./' + name)))]),
        ...adapterSources.map((name) => [
          '@freedom/railgun-kohaku-adapter/' + name,
          sha(
            fs.readFileSync(
              path.join(
                path.dirname(require.resolve('@freedom/railgun-kohaku-adapter/host/poi')),
                name
              )
            )
          ),
        ]),
      ],
    ])
  );
}
module.exports = { getRailgunTxidPolicy, railgunTxidBinding, SOURCES };
