'use strict';

/**
 * Fetches and verifies one of the binaries solardev-xyz/freedom-core
 * releases: `freedom-cored` (scripts/fetch-freedom-cored.js) and
 * `freedom-ipfsd` (scripts/fetch-freedom-ipfsd.js). Each is released on tags
 * of its own by the same kind of workflow, which publishes one archive per
 * platform, named with the same os/arch keywords as Ant's, plus SHA256SUMS.
 * Each archive holds the executable and the notices of the third-party code
 * it statically links.
 *
 * Each fetch script owns what differs: the binary's name, its pinned tag and
 * the pinned digest of that release's SHA256SUMS (the in-repo trust root),
 * the tag family it accepts and the env var that overrides the pin. The
 * fetching, verifying and installing is this module's, so they cannot drift
 * apart.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { fetchJson, downloadToFile, TIMEOUTS } = require('./fetch-with-retry');

const DEFAULT_REPO = 'solardev-xyz/freedom-core';
const API_HOST = 'api.github.com';
// Shipped beside the binary in every archive: the notices of the third-party
// code it statically links (crates, and the Rust toolchain's runtime).
const NOTICE_FILES = ['THIRD-PARTY-NOTICES', 'THIRD-PARTY-NOTICES-rust-std.html'];

const TARGETS = [
  { os: 'mac', arch: 'arm64', keywords: ['darwin', 'arm64'] },
  { os: 'mac', arch: 'x64', keywords: ['darwin', 'amd64'] },
  { os: 'linux', arch: 'x64', keywords: ['linux', 'amd64'] },
  { os: 'linux', arch: 'arm64', keywords: ['linux', 'arm64'] },
  { os: 'win', arch: 'x64', keywords: ['windows', 'amd64'], exe: true },
];

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** `sha256sum` output (`<hex>  <name>` or `<hex> *<name>`) → { name: hex }. */
function parseChecksums(text) {
  const map = Object.create(null);
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?([^\s/\\]+)$/);
    if (!match || match[2] === '.' || match[2] === '..') {
      throw new Error('Invalid SHA256SUMS entry');
    }
    if (Object.hasOwn(map, match[2])) throw new Error(`Duplicate checksum for ${match[2]}`);
    map[match[2]] = match[1].toLowerCase();
  }
  return map;
}

/** Sends the token only to GitHub's API host, never across a redirect. */
function releaseRequestHeaders(url) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = {
    'User-Agent': 'Freedom-Updater',
    Accept: 'application/vnd.github+json',
  };
  if (token && new URL(url).host === API_HOST) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * @param {object} options
 * @param {string} options.binary        the executable, without `.exe`
 * @param {string} options.outputDir     where `<os>-<arch>/` directories go
 * @param {string} options.pinnedTag     the release this app version ships
 * @param {string} options.pinnedDigest  the sha256 of that release's SHA256SUMS
 * @param {string} options.tagEnv        the env var that overrides `pinnedTag`
 * @param {RegExp} options.tagPattern    the tags this binary is released under
 * @param {string} options.tagPrefix     dropped from a tag to name its archives
 * @param {string} options.provenanceWorkflow  the freedom-core workflow that
 *   builds and attests this binary's releases; CI verifies their build
 *   provenance against it (scripts/ci/verify-core-provenance.js)
 */
function createReleaseFetcher({
  binary,
  outputDir: OUTPUT_DIR,
  pinnedTag: PINNED_RELEASE_TAG,
  pinnedDigest: PINNED_SHA256SUMS_DIGEST,
  tagEnv,
  tagPattern: TAG_PATTERN,
  tagPrefix,
  provenanceWorkflow,
}) {
  const CORE_REPO = process.env.FREEDOM_CORE_REPO || DEFAULT_REPO;
  const RELEASE_TAG = process.env[tagEnv] || PINNED_RELEASE_TAG;

  /** The archives keep `vX.Y.Z` in their names under a prefixed tag. */
  function archiveVersion(tag) {
    return tag.startsWith(tagPrefix) ? tag.slice(tagPrefix.length) : tag;
  }

  function releaseUrl() {
    const releasePath =
      RELEASE_TAG === 'latest'
        ? `/repos/${CORE_REPO}/releases/latest`
        : `/repos/${CORE_REPO}/releases/tags/${encodeURIComponent(RELEASE_TAG)}`;
    return `https://${API_HOST}${releasePath}`;
  }

  function fetchRelease(url = releaseUrl(), options = {}) {
    return fetchJson(url, {
      label: `${binary} release lookup (${CORE_REPO} @ ${RELEASE_TAG})`,
      headers: releaseRequestHeaders,
      timeoutMs: TIMEOUTS.metadata,
      ...options,
    });
  }

  function downloadFile(url, dest, options = {}) {
    console.log(`Downloading ${url} to ${dest}...`);
    return downloadToFile(url, dest, {
      label: `${binary} asset ${path.basename(dest)}`,
      headers: { 'User-Agent': 'Freedom-Updater' },
      timeoutMs: TIMEOUTS.binary,
      ...options,
    });
  }

  /** Exact names exclude sidecars, wrong releases and ambiguous keyword matches. */
  function assetFor(assets, target, tag = RELEASE_TAG) {
    const name = `${binary}-${archiveVersion(tag)}-${target.keywords.join('-')}.${target.exe ? 'zip' : 'tar.gz'}`;
    const matches = assets.filter((asset) => asset.name === name);
    if (matches.length > 1) throw new Error(`Duplicate release asset ${name}`);
    return matches[0];
  }

  async function main({ outputDir = OUTPUT_DIR } = {}) {
    try {
      console.log(`Fetching ${binary} release info from ${CORE_REPO} @ ${RELEASE_TAG}...`);
      const release = await fetchRelease();
      if (
        !TAG_PATTERN.test(release.tag_name) ||
        (RELEASE_TAG !== 'latest' && release.tag_name !== RELEASE_TAG) ||
        release.draft
      ) {
        throw new Error(`Unexpected ${binary} release tag or draft release`);
      }
      const assets = release.assets || [];
      const sumsAssets = assets.filter((a) => a.name === 'SHA256SUMS');
      if (sumsAssets.length !== 1) {
        throw new Error(
          `Release ${release.tag_name} must have exactly one SHA256SUMS — refusing unverified binaries.`
        );
      }
      fs.mkdirSync(outputDir, { recursive: true });
      const sumsPath = path.join(outputDir, 'SHA256SUMS');
      await downloadFile(sumsAssets[0].browser_download_url, sumsPath, {
        timeoutMs: TIMEOUTS.metadata,
      });
      if (RELEASE_TAG === PINNED_RELEASE_TAG) {
        const digest = sha256File(sumsPath);
        if (digest !== PINNED_SHA256SUMS_DIGEST) {
          throw new Error(
            `SHA256SUMS for ${PINNED_RELEASE_TAG} does not match the pinned digest ` +
              `(expected ${PINNED_SHA256SUMS_DIGEST}, got ${digest}) — refusing to install.`
          );
        }
        console.log('Verified SHA256SUMS against the in-repo pinned digest');
      } else {
        console.warn(
          `${tagEnv}=${RELEASE_TAG} overrides the pinned release — ` +
            'skipping the pinned digest check (local testing only).'
        );
      }
      const checksums = parseChecksums(fs.readFileSync(sumsPath, 'utf-8'));
      const downloads = TARGETS.map((target) => {
        const asset = assetFor(assets, target, release.tag_name);
        if (!asset) {
          throw new Error(
            `Release ${release.tag_name} has no asset for ${target.os}-${target.arch}.`
          );
        }
        const expected = checksums[asset.name];
        if (!expected) throw new Error(`No checksum entry for ${asset.name} in SHA256SUMS`);
        return { target, asset, expected };
      });

      for (const { target, asset, expected } of downloads) {
        // Extract only the known binary and notices into a fresh directory.
        // Never unpack a whole archive into an existing install or discard it
        // before verification.
        const stage = fs.mkdtempSync(path.join(outputDir, '.fetch-'));
        try {
          const archive = path.join(stage, asset.name);
          await downloadFile(asset.browser_download_url, archive);
          const actual = sha256File(archive);
          if (actual !== expected) {
            throw new Error(
              `Checksum mismatch for ${asset.name}: expected ${expected}, got ${actual}`
            );
          }
          const binName = target.exe ? `${binary}.exe` : binary;
          const isWindows = process.platform === 'win32';
          const tarBin = isWindows
            ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
            : 'tar';
          const opts = { cwd: stage, stdio: 'inherit' };
          const members = [binName, ...NOTICE_FILES];
          if (target.exe && !isWindows) {
            execFileSync('unzip', ['-o', asset.name, ...members], opts);
          } else {
            execFileSync(tarBin, ['-xf', asset.name, ...members], opts);
          }
          for (const member of members) {
            const file = path.join(stage, member);
            if (
              !fs.existsSync(file) ||
              !fs.lstatSync(file).isFile() ||
              fs.lstatSync(file).nlink !== 1
            ) {
              throw new Error(`The ${asset.name} archive has no regular ${member}`);
            }
          }
          if (!target.exe) fs.chmodSync(path.join(stage, binName), 0o755);
          const targetDir = path.join(outputDir, `${target.os}-${target.arch}`);
          fs.mkdirSync(targetDir, { recursive: true });
          // Notices first: the binary's presence marks a complete install.
          for (const member of [...NOTICE_FILES, binName]) {
            fs.renameSync(path.join(stage, member), path.join(targetDir, member));
          }
        } finally {
          fs.rmSync(stage, { recursive: true, force: true });
        }
        console.log(`Installed ${binary} for ${target.os}-${target.arch}`);
      }
      // Windows ARM64 uses the verified x64 build via OS emulation, like Ant.
      const winArmDir = path.join(outputDir, 'win-arm64');
      fs.mkdirSync(winArmDir, { recursive: true });
      const stage = fs.mkdtempSync(path.join(outputDir, '.fetch-'));
      try {
        for (const member of [...NOTICE_FILES, `${binary}.exe`]) {
          const file = path.join(stage, member);
          fs.copyFileSync(path.join(outputDir, 'win-x64', member), file);
          fs.renameSync(file, path.join(winArmDir, member));
        }
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
      }
      console.log('All downloads complete.');
    } catch (err) {
      console.error('Error:', err);
      process.exitCode = 1;
    }
    // No process.exit() (see fetch-ant.js, #544).
  }

  return {
    fetchRelease,
    downloadFile,
    main,
    releaseRequestHeaders,
    releaseUrl,
    parseChecksums,
    assetFor,
    archiveVersion,
    sha256File,
    TARGETS,
    NOTICE_FILES,
    CORE_REPO,
    PINNED_RELEASE_TAG,
    PINNED_SHA256SUMS_DIGEST,
    RELEASE_TAG,
    binary,
    provenanceWorkflow,
  };
}

module.exports = { createReleaseFetcher };
