/** Repository-relative files that qualifier source inventories pin for
 * @freedom/railgun-kohaku-adapter. src/main/wallet/railgun-kohaku-*.js only
 * re-export it, so the code that runs is the installed copy; package-lock.json
 * carries the entry integrity `npm ci` checked that copy's tarball against.
 */
const PACKAGE = 'node_modules/@freedom/railgun-kohaku-adapter/';
const SOURCES = Object.freeze([
  'scripts/fixtures/railgun-kohaku-adapter-sources.js',
  'package-lock.json',
  ...[
    'package.json',
    'index.cjs',
    'read.cjs',
    'host-data.cjs',
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
    'src/data/railgun-private-policy.js',
    'src/data/railgun-private-intent.js',
    'src/data/railgun-private-offer.js',
    'src/data/railgun-private-capsule.js',
    'src/data/railgun-private-destination.js',
    'src/data/railgun-private-signature.js',
    'src/data/railgun-private-preparation.js',
    'src/data/railgun-private-results.js',
    'src/data/railgun-private-recovery-data.js',
    'src/railgun-engine-manifest.json',
    'src/railgun-prover-manifest.json',
    'src/railgun-kohaku-private-adapter.js',
    'src/railgun-kohaku-public-adapter.js',
    'src/railgun-kohaku-read-data.js',
    'src/railgun-kohaku-read-dispatch.js',
    'src/railgun-kohaku-snapshot-plugin.js',
    'src/railgun-shield-pins.json',
  ].map((name) => PACKAGE + name),
]);
module.exports = { SOURCES };
