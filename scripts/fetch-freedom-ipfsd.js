const path = require('path');
const { createReleaseFetcher } = require('./lib/freedom-core-release');

// Fetches `freedom-ipfsd`, the IPFS service (solardev-xyz/freedom-core,
// design 0007), into `freedom-ipfsd-bin/<os>-<arch>/`. freedom-core releases
// it beside the core, on tags of its own, with the same archive layout and
// SHA256SUMS; scripts/lib/freedom-core-release.js fetches and verifies both.
// The known-good release this app version is built and CI-tested against.
// Bump deliberately (with a CI run); never float on `latest`. Override with
// FREEDOM_IPFSD_RELEASE_TAG for local testing.
const PINNED_RELEASE_TAG = 'ipfsd-v0.4.0';
// In-repo trust root: the sha256 of the pinned release's SHA256SUMS asset
// (the freedom-core release workflow prints it). Without it, a compromised
// release could swap binaries and checksums together. Update with the tag.
// ipfsd-v0.4.0: published as an immutable release (run 42300426177, from
// freedom-core f788a430); this digest matches the one its publish job
// printed and was re-checked against the downloaded assets (every archive
// verified against it).
const PINNED_SHA256SUMS_DIGEST = '9053868bb997912c6dba2eb674c3c0fe56f1a60f246a9e964d666756bc8877b7';

// freedom-core tags the service's releases `ipfsd-vX.Y.Z`. Any other family
// is refused, including a core or Radicle service release that `latest` might
// name. The archives keep `vX.Y.Z` in their names.
const TAG_PATTERN = /^ipfsd-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

module.exports = createReleaseFetcher({
  binary: 'freedom-ipfsd',
  outputDir: path.join(__dirname, '..', 'freedom-ipfsd-bin'),
  pinnedTag: PINNED_RELEASE_TAG,
  pinnedDigest: PINNED_SHA256SUMS_DIGEST,
  tagEnv: 'FREEDOM_IPFSD_RELEASE_TAG',
  tagPattern: TAG_PATTERN,
  tagPrefix: 'ipfsd-',
  // What builds and attests ipfsd-v* releases; CI verifies against it.
  provenanceWorkflow: 'release-ipfsd.yml',
});

if (require.main === module) {
  module.exports.main();
}
