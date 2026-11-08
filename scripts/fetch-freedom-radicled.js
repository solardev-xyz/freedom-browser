const path = require('path');
const { createReleaseFetcher } = require('./lib/freedom-core-release');

// Fetches `freedom-radicled`, the Radicle service (solardev-xyz/freedom-core,
// design 0008), into `freedom-radicled-bin/<os>-<arch>/`. freedom-core
// releases it beside the core, on tags of its own, with the same archive
// layout and SHA256SUMS; scripts/lib/freedom-core-release.js fetches and
// verifies all three. Nothing in the app runs it yet: Radicle still runs on
// the libradicle add-on until main moves onto the service (0008, step 6 on).
// The known-good release this app version is built and CI-tested against.
// Bump deliberately (with a CI run); never float on `latest`. Override with
// FREEDOM_RADICLED_RELEASE_TAG for local testing.
const PINNED_RELEASE_TAG = 'radicled-v0.1.0';
// In-repo trust root: the sha256 of the pinned release's SHA256SUMS asset
// (the freedom-core release workflow prints it). Without it, a compromised
// release could swap binaries and checksums together. Update with the tag.
// radicled-v0.1.0: published as an immutable release (run 42471460591, from
// freedom-core 184a05f1); this digest matches the one its publish job
// printed and was re-checked against the downloaded assets (every archive
// verified against it).
const PINNED_SHA256SUMS_DIGEST = 'aa5af95becf45b240fc6f17c644a95cc3cbd75371212c716e1730d6a5d9b200d';

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
