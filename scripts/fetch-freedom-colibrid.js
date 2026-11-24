const path = require('path');
const { createReleaseFetcher } = require('./lib/freedom-core-release');

// Fetches `freedom-colibrid`, the Colibri service (solardev-xyz/freedom-core,
// design 0014), into `freedom-colibrid-bin/<os>-<arch>/`. freedom-core
// releases it beside the core, on tags of its own, with the same archive
// layout and SHA256SUMS; scripts/lib/freedom-core-release.js fetches and
// verifies all four. It is Colibri's verifier, for chain reads and Myotis's
// checkpoint check.
// The known-good release this app version is built and CI-tested against.
// Bump deliberately (with a CI run); never float on `latest`. Override with
// FREEDOM_COLIBRID_RELEASE_TAG for local testing.
const PINNED_RELEASE_TAG = 'colibrid-v0.1.1';
// In-repo trust root: the sha256 of the pinned release's SHA256SUMS asset
// (the freedom-core release workflow prints it). Without it, a compromised
// release could swap binaries and checksums together. Update with the tag.
// colibrid-v0.1.1: published as an immutable release (run 45343760707, from
// freedom-core 032130ba); this digest matches the one its publish job
// printed and the release API's asset digest, and was re-checked against the
// downloaded assets (every archive verified against it).
const PINNED_SHA256SUMS_DIGEST = '9181b8ab9b2ba5f9524d59feebc8178b6d451a91a757aa71707fae5f3ce1ee5a';

// freedom-core tags the service's releases `colibrid-vX.Y.Z`. Any other
// family is refused, including a core, IPFS or Radicle service release that
// `latest` might name. The archives keep `vX.Y.Z` in their names.
const TAG_PATTERN = /^colibrid-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

module.exports = createReleaseFetcher({
  binary: 'freedom-colibrid',
  outputDir: path.join(__dirname, '..', 'freedom-colibrid-bin'),
  pinnedTag: PINNED_RELEASE_TAG,
  pinnedDigest: PINNED_SHA256SUMS_DIGEST,
  tagEnv: 'FREEDOM_COLIBRID_RELEASE_TAG',
  tagPattern: TAG_PATTERN,
  tagPrefix: 'colibrid-',
  // What builds and attests colibrid-v* releases; CI verifies against it.
  provenanceWorkflow: 'release-colibrid.yml',
});

if (require.main === module) {
  module.exports.main();
}
