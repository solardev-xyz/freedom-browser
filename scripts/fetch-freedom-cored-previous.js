const path = require('path');
const { createReleaseFetcher } = require('./lib/freedom-core-release');
const { TAG_PATTERN } = require('./fetch-freedom-cored');

// Fetches the previous `freedom-cored` release into
// `freedom-cored-bin-previous/<os>-<arch>/`: design 0013's "previous core
// release" for PRF-6's rollout tests (store-handover.integration.test.js),
// where this build's modules run against a core that echoes no store. Only
// tests use it; the app is built against scripts/fetch-freedom-cored.js's
// pin. It moves only when a later step needs it. Override with
// FREEDOM_CORE_PREVIOUS_RELEASE_TAG for local testing.
const PINNED_RELEASE_TAG = 'cored-v0.22.0';
// In-repo trust root: the sha256 of cored-v0.22.0's SHA256SUMS asset, as the
// app's own pin carried it (release run 44568701547, from freedom-core
// 4bff981f; matched against its publish job's print and the release API's
// asset digest).
const PINNED_SHA256SUMS_DIGEST = '82cb1566adf8b681e7f4009e9a0ebbaf0ff1202f714ca6e99e71f0ece4a807ef';

module.exports = createReleaseFetcher({
  binary: 'freedom-cored',
  outputDir: path.join(__dirname, '..', 'freedom-cored-bin-previous'),
  pinnedTag: PINNED_RELEASE_TAG,
  pinnedDigest: PINNED_SHA256SUMS_DIGEST,
  tagEnv: 'FREEDOM_CORE_PREVIOUS_RELEASE_TAG',
  tagPattern: TAG_PATTERN,
  tagPrefix: 'cored-',
  // What builds and attests cored-v* releases; CI verifies against it.
  provenanceWorkflow: 'release.yml',
});

if (require.main === module) {
  module.exports.main();
}
