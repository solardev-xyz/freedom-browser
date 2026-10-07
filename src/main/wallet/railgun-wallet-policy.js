/** Conservative main-owned derived-cache policy. Source bytes deliberately bind
 * host validation as well as the authenticated engine; even a comment-only
 * change can require a fresh generation. No caller supplies a policy override.
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const engine = require('./railgun-engine-manifest.json');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const sources = [
  'railgun-wallet-job',
  'railgun-relay-wallet-job',
  'railgun-relay-wallet-data',
  'railgun-relay-witness',
  'railgun-relay-reconstruct',
  'railgun-relay-intent',
  'railgun-relay-capsule',
  'railgun-relay-quote-data',
  'railgun-relay-review-summary',
  'railgun-relay-poi-history',
  'railgun-poi-records',
  'railgun-relay-pre-poi-data',
  'railgun-relay-record-stream',
  'railgun-relay-recovery-data',
  'railgun-relay-transaction',
  'railgun-relay-proof-results',
  'railgun-relay-pre-poi-job',
  'railgun-relay-pre-poi-witness',
  'railgun-relay-prove-job',
  'railgun-relay-prover',
  'railgun-relay-verify-job',
  'railgun-relay-proof-verifier',
  'railgun-relay-pre-poi-math',
  'railgun-relay-proof',
  'railgun-private-prepare-job',
  'railgun-private-operate-job',
  'railgun-private-recover-job',
  'railgun-private-recovery-data',
  'railgun-private-capsule',
  'railgun-private-reconstruct',
  'railgun-private-prover',
  'railgun-private-signature',
  'railgun-prover-runtime',
  'railgun-prover-manifest.json',
  'railgun-artifacts',
  'railgun-private-witness',
  'railgun-private-preparation',
  'railgun-private-intent',
  'railgun-private-policy',
  'railgun-private-destination',
  'railgun-shield-pins.json',
  'railgun-wallet-runner',
  'railgun-wallet-run',
  'railgun-wallet-scan',
  'railgun-wallet-records',
  'railgun-owned-poi-records',
  'railgun-wallet-coverage',
  'railgun-wallet-coverage-store',
  'railgun-wallet-state',
  'railgun-wallet-read',
  'railgun-kohaku-read',
  'railgun-kohaku-read-data',
  'railgun-wallet-storage',
  'railgun-remote',
  'railgun-frontier',
  'railgun-scan-journal',
  'railgun-public-records',
];
// railgun-kohaku-read-data re-exports @freedom/railgun-kohaku-adapter/read, so
// the installed package bytes it loads (and the exports map that selects them)
// bind host validation just as wallet modules do.
const adapter = '@freedom/railgun-kohaku-adapter';
const adapterSources = [
  'package.json',
  'read.cjs',
  'src/railgun-kohaku-read-data.js',
  'src/railgun-kohaku-read-dispatch.js',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function getRailgunWalletPolicy(archive) {
  verifyRailgunEngineRuntime(archive);
  return hash(
    JSON.stringify([
      'freedom:railgun:wallet-policy-v1',
      'sepolia',
      11155111,
      engine.sha256,
      engine.inventory.sha256,
      getRailgunPublicPolicy(archive),
      [
        ...sources.map((name) => [name, hash(fs.readFileSync(require.resolve('./' + name)))]),
        ...adapterSources.map((name) => [
          adapter + '/' + name,
          hash(fs.readFileSync(path.join(path.dirname(require.resolve(adapter + '/read')), name))),
        ]),
      ],
    ])
  );
}
module.exports = { getRailgunWalletPolicy };
