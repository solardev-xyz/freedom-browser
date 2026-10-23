'use strict';

/**
 * Verifies the build provenance of a freedom-core release this app pins, in
 * CI (freedom-core design 0001, "Packaging and release"): every asset of the
 * release a fetch script installs from, `SHA256SUMS` and each platform's
 * archive, must carry a build-provenance attestation from freedom-core's
 * release workflow for that binary, at exactly the release's tag, built on a
 * GitHub-hosted runner. `gh attestation verify` checks each one.
 *
 *   node scripts/ci/verify-core-provenance.js cored|ipfsd
 *
 * The release is the one the fetch script uses (scripts/fetch-freedom-cored.js
 * or scripts/fetch-freedom-ipfsd.js: its pinned tag, or its override), found
 * the way it finds it. Before anything is verified, `SHA256SUMS` must have the
 * pinned digest, and every archive its digest in `SHA256SUMS`, as the fetch
 * script requires. So what the fetch installed is what was verified. Any
 * failure fails the job.
 *
 * This runs in CI only, where the runner has `gh`: the download scripts take
 * no Sigstore dependency, and the SHA-256 pins stay what a local build checks.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FETCHERS = {
  cored: '../fetch-freedom-cored',
  ipfsd: '../fetch-freedom-ipfsd',
};

/** `gh attestation verify`'s arguments for `file` of `fetcher`'s release `tag`. */
function attestationArgs(fetcher, file, tag) {
  return [
    'attestation',
    'verify',
    file,
    '--repo',
    fetcher.CORE_REPO,
    '--signer-workflow',
    `${fetcher.CORE_REPO}/.github/workflows/${fetcher.provenanceWorkflow}`,
    '--source-ref',
    `refs/tags/${tag}`,
    '--deny-self-hosted-runners',
  ];
}

/**
 * Downloads `fetcher`'s release into a fresh directory under `workDir`,
 * checks the digests as the fetch does, then verifies each file's
 * provenance. Throws on the first failure.
 */
async function verify(fetcher, { workDir = os.tmpdir() } = {}) {
  const tag = fetcher.RELEASE_TAG;
  if (!fetcher.provenanceWorkflow) {
    throw new Error(`${fetcher.binary} names no provenance workflow`);
  }
  if (tag === 'latest') {
    throw new Error('Refusing to verify a floating release: provenance names a tag');
  }
  const release = await fetcher.fetchRelease();
  if (release.tag_name !== tag || release.draft) {
    throw new Error(`Unexpected ${fetcher.binary} release tag or draft release`);
  }
  const assets = release.assets || [];
  const sumsAssets = assets.filter((asset) => asset.name === 'SHA256SUMS');
  if (sumsAssets.length !== 1) {
    throw new Error(`Release ${tag} must have exactly one SHA256SUMS`);
  }
  const stage = fs.mkdtempSync(path.join(workDir, 'provenance-'));
  try {
    const sumsPath = path.join(stage, 'SHA256SUMS');
    await fetcher.downloadFile(sumsAssets[0].browser_download_url, sumsPath);
    if (tag === fetcher.PINNED_RELEASE_TAG) {
      const digest = fetcher.sha256File(sumsPath);
      if (digest !== fetcher.PINNED_SHA256SUMS_DIGEST) {
        throw new Error(
          `SHA256SUMS for ${tag} does not match the pinned digest ` +
            `(expected ${fetcher.PINNED_SHA256SUMS_DIGEST}, got ${digest})`
        );
      }
    }
    const checksums = fetcher.parseChecksums(fs.readFileSync(sumsPath, 'utf-8'));
    const files = [sumsPath];
    for (const target of fetcher.TARGETS) {
      const asset = fetcher.assetFor(assets, target, tag);
      if (!asset) throw new Error(`Release ${tag} has no asset for ${target.os}-${target.arch}`);
      const expected = checksums[asset.name];
      if (!expected) throw new Error(`No checksum entry for ${asset.name} in SHA256SUMS`);
      const archive = path.join(stage, asset.name);
      await fetcher.downloadFile(asset.browser_download_url, archive);
      const actual = fetcher.sha256File(archive);
      if (actual !== expected) {
        throw new Error(`Checksum mismatch for ${asset.name}: expected ${expected}, got ${actual}`);
      }
      files.push(archive);
    }
    for (const file of files) {
      console.log(`Verifying the build provenance of ${path.basename(file)}...`);
      execFileSync('gh', attestationArgs(fetcher, file, tag), { stdio: 'inherit' });
    }
    console.log(
      `Verified ${files.length} assets of ${fetcher.binary} ${tag}: built by ` +
        `${fetcher.CORE_REPO}'s ${fetcher.provenanceWorkflow} at refs/tags/${tag}`
    );
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    const module = Object.hasOwn(FETCHERS, argv[0]) ? FETCHERS[argv[0]] : null;
    if (!module || argv.length !== 1) {
      throw new Error('Usage: node scripts/ci/verify-core-provenance.js cored|ipfsd');
    }
    await verify(require(module));
  } catch (err) {
    console.error('Error:', err.message || err);
    process.exitCode = 1;
  }
  // No process.exit() (see fetch-ant.js, #544).
}

if (require.main === module) {
  main();
}

module.exports = { attestationArgs, verify, main, FETCHERS };
