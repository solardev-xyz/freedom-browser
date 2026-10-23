const path = require('path');
const { createReleaseFetcher } = require('./lib/freedom-core-release');

// Fetches `freedom-cored`, the Rust identity core (solardev-xyz/freedom-core,
// design 0001), into `freedom-cored-bin/<os>-<arch>/`. Its release workflow
// publishes one archive per platform, named with the same os/arch keywords as
// Ant's, plus SHA256SUMS; scripts/lib/freedom-core-release.js fetches and
// verifies them.
// The known-good release this app version is built and CI-tested against.
// Bump deliberately (with a CI run); never float on `latest`. Override with
// FREEDOM_CORE_RELEASE_TAG for local testing.
const PINNED_RELEASE_TAG = 'cored-v0.6.0';
// In-repo trust root: the sha256 of the pinned release's SHA256SUMS asset
// (the freedom-core release workflow prints it). Without it, a compromised
// release could swap binaries and checksums together. Update with the tag.
// cored-v0.6.0: published as an immutable release; this digest matches the
// one its publish job printed and was re-checked against the downloaded
// assets (every archive verified against it).
const PINNED_SHA256SUMS_DIGEST = '139be530981a692407a6337f456b4a460485362c2d551bc1b634b58039f6a7e4';

// freedom-core tags the core's releases `cored-vX.Y.Z` from 0.6.0 on (its
// service binaries get tags of their own, `ipfsd-v*` and `radicled-v*`), and
// tagged them `vX.Y.Z` up to 0.5.0. Any other family is refused, including a
// service release that `latest` might name.
const TAG_PATTERN = /^(?:cored-)?v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// The archives keep `vX.Y.Z` in their names under a `cored-vX.Y.Z` tag.
module.exports = createReleaseFetcher({
  binary: 'freedom-cored',
  outputDir: path.join(__dirname, '..', 'freedom-cored-bin'),
  pinnedTag: PINNED_RELEASE_TAG,
  pinnedDigest: PINNED_SHA256SUMS_DIGEST,
  tagEnv: 'FREEDOM_CORE_RELEASE_TAG',
  tagPattern: TAG_PATTERN,
  tagPrefix: 'cored-',
  // What builds and attests cored-v* releases; CI verifies against it.
  provenanceWorkflow: 'release.yml',
});

if (require.main === module) {
  module.exports.main();
}
