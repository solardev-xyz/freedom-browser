'use strict';

/**
 * Verifies the build provenance of a freedom-core release this app would
 * fetch, as every fetch in CI does (scripts/lib/freedom-core-release.js): for
 * a bump, run it on the new release before pinning it.
 *
 *   GH_TOKEN=$(gh auth token) node scripts/ci/verify-core-provenance.js cored|ipfsd
 *
 * The release is the one the fetch script names (scripts/fetch-freedom-cored.js
 * or scripts/fetch-freedom-ipfsd.js: its pinned tag, or its override). The
 * fetch runs into a temporary directory with provenance verification on, so
 * `SHA256SUMS` and every archive are checked as CI checks them, and the
 * directory is then removed. Any failure exits 1.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const FETCHERS = {
  cored: '../fetch-freedom-cored',
  ipfsd: '../fetch-freedom-ipfsd',
};

async function main(argv = process.argv.slice(2), { workDir = os.tmpdir() } = {}) {
  const module = Object.hasOwn(FETCHERS, argv[0]) ? FETCHERS[argv[0]] : null;
  if (!module || argv.length !== 1) {
    console.error('Usage: node scripts/ci/verify-core-provenance.js cored|ipfsd');
    process.exitCode = 1;
    return;
  }
  const outputDir = fs.mkdtempSync(path.join(workDir, 'provenance-'));
  try {
    // The fetch reports a failure through process.exitCode, as it does in CI.
    await require(module).main({ outputDir, verifyProvenance: true });
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  // No process.exit() (see fetch-ant.js, #544).
}

if (require.main === module) {
  main();
}

module.exports = { main, FETCHERS };
