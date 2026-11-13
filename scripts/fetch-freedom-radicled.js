const path = require('path');
const { createReleaseFetcher } = require('./lib/freedom-core-release');

// Fetches `freedom-radicled`, the Radicle service (solardev-xyz/freedom-core,
// design 0008), into `freedom-radicled-bin/<os>-<arch>/`. freedom-core
// releases it beside the core, on tags of its own, with the same archive
// layout and SHA256SUMS; scripts/lib/freedom-core-release.js fetches and
// verifies all three. Radicle runs on it (0008, step 7), and its
// `hold-lock` is the Radicle home's gate, under which the libradicle
// add-on, development builds' rollback, runs.
// The known-good release this app version is built and CI-tested against.
// Bump deliberately (with a CI run); never float on `latest`. Override with
// FREEDOM_RADICLED_RELEASE_TAG for local testing.
const PINNED_RELEASE_TAG = 'radicled-v0.1.2';
// In-repo trust root: the sha256 of the pinned release's SHA256SUMS asset
// (the freedom-core release workflow prints it). Without it, a compromised
// release could swap binaries and checksums together. Update with the tag.
// radicled-v0.1.2: published as an immutable release (run 43362387058, from
// freedom-core cdd13a8d); this digest matches the one its publish job
// printed and was re-checked against the downloaded assets (every archive
// verified against it).
const PINNED_SHA256SUMS_DIGEST = 'ff4dfa2fdbbe9a89ccfc50299d234e80b29fd8c34d0ce2fde8785602c5a12a21';

// freedom-core tags the service's releases `radicled-vX.Y.Z`. Any other
// family is refused, including a core or IPFS service release that `latest`
// might name. The archives keep `vX.Y.Z` in their names.
const TAG_PATTERN = /^radicled-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

module.exports = createReleaseFetcher({
  binary: 'freedom-radicled',
  outputDir: path.join(__dirname, '..', 'freedom-radicled-bin'),
  pinnedTag: PINNED_RELEASE_TAG,
  pinnedDigest: PINNED_SHA256SUMS_DIGEST,
  tagEnv: 'FREEDOM_RADICLED_RELEASE_TAG',
  tagPattern: TAG_PATTERN,
  tagPrefix: 'radicled-',
  // What builds and attests radicled-v* releases; CI verifies against it.
  provenanceWorkflow: 'release-radicled.yml',
});

if (require.main === module) {
  module.exports.main();
}
