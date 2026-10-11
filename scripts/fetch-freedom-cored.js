const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { fetchJson, downloadToFile, TIMEOUTS } = require('./lib/fetch-with-retry');

// Fetches `freedom-cored`, the Rust identity core (solardev-xyz/freedom-core,
// design 0001), into `freedom-cored-bin/<os>-<arch>/`. Its release workflow
// publishes one archive per platform, named with the same os/arch keywords as
// Ant's, plus SHA256SUMS.
const OUTPUT_DIR = path.join(__dirname, '..', 'freedom-cored-bin');
const CORE_REPO = process.env.FREEDOM_CORE_REPO || 'solardev-xyz/freedom-core';
// The known-good release this app version is built and CI-tested against.
// Bump deliberately (with a CI run); never float on `latest`. Override with
// FREEDOM_CORE_RELEASE_TAG for local testing.
const PINNED_RELEASE_TAG = 'v0.1.0';
// In-repo trust root: the sha256 of the pinned release's SHA256SUMS asset
// (the freedom-core release workflow prints it). Without it, a compromised
// release could swap binaries and checksums together. Update with the tag.
// PLACEHOLDER: v0.1.0 has not been published. Replace this with the independently
// verified manifest digest before merging; the pinned download fails closed.
const PINNED_SHA256SUMS_DIGEST = 'PENDING_RELEASE';
const CORE_RELEASE_TAG = process.env.FREEDOM_CORE_RELEASE_TAG || PINNED_RELEASE_TAG;

const API_HOST = 'api.github.com';

const TARGETS = [
  { os: 'mac', arch: 'arm64', keywords: ['darwin', 'arm64'] },
  { os: 'mac', arch: 'x64', keywords: ['darwin', 'amd64'] },
  { os: 'linux', arch: 'x64', keywords: ['linux', 'amd64'] },
  { os: 'linux', arch: 'arm64', keywords: ['linux', 'arm64'] },
  { os: 'win', arch: 'x64', keywords: ['windows', 'amd64'], exe: true },
];

function releaseUrl() {
  const releasePath =
    CORE_RELEASE_TAG === 'latest'
      ? `/repos/${CORE_REPO}/releases/latest`
      : `/repos/${CORE_REPO}/releases/tags/${encodeURIComponent(CORE_RELEASE_TAG)}`;
  return `https://${API_HOST}${releasePath}`;
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

function fetchRelease(url = releaseUrl(), options = {}) {
  return fetchJson(url, {
    label: `freedom-cored release lookup (${CORE_REPO} @ ${CORE_RELEASE_TAG})`,
    headers: releaseRequestHeaders,
    timeoutMs: TIMEOUTS.metadata,
    ...options,
  });
}

function downloadFile(url, dest, options = {}) {
  console.log(`Downloading ${url} to ${dest}...`);
  return downloadToFile(url, dest, {
    label: `freedom-cored asset ${path.basename(dest)}`,
    headers: { 'User-Agent': 'Freedom-Updater' },
    timeoutMs: TIMEOUTS.binary,
    ...options,
  });
}

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

/** Exact names exclude sidecars, wrong releases and ambiguous keyword matches. */
function assetFor(assets, target, tag = CORE_RELEASE_TAG) {
  const name = `freedom-cored-${tag}-${target.keywords.join('-')}.${target.exe ? 'zip' : 'tar.gz'}`;
  const matches = assets.filter((asset) => asset.name === name);
  if (matches.length > 1) throw new Error(`Duplicate release asset ${name}`);
  return matches[0];
}

async function main({ outputDir = OUTPUT_DIR } = {}) {
  try {
    console.log(`Fetching freedom-cored release info from ${CORE_REPO} @ ${CORE_RELEASE_TAG}...`);
    const release = await fetchRelease();
    if (
      !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(release.tag_name) ||
      (CORE_RELEASE_TAG !== 'latest' && release.tag_name !== CORE_RELEASE_TAG) ||
      release.draft
    ) {
      throw new Error('Unexpected freedom-cored release tag or draft release');
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
    if (CORE_RELEASE_TAG === PINNED_RELEASE_TAG) {
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
        `FREEDOM_CORE_RELEASE_TAG=${CORE_RELEASE_TAG} overrides the pinned release — ` +
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
      // Extract only the known binary into a fresh directory. Never unpack a
      // whole archive into an existing install or discard it before verification.
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
        const binName = target.exe ? 'freedom-cored.exe' : 'freedom-cored';
        const isWindows = process.platform === 'win32';
        const tarBin = isWindows
          ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
          : 'tar';
        const opts = { cwd: stage, stdio: 'inherit' };
        if (target.exe && !isWindows) {
          execFileSync('unzip', ['-o', asset.name, binName], opts);
        } else {
          execFileSync(tarBin, ['-xf', asset.name, binName], opts);
        }
        const bin = path.join(stage, binName);
        if (!fs.existsSync(bin) || !fs.lstatSync(bin).isFile() || fs.lstatSync(bin).nlink !== 1) {
          throw new Error(`The ${asset.name} archive has no regular ${binName} binary`);
        }
        if (!target.exe) fs.chmodSync(bin, 0o755);
        const targetDir = path.join(outputDir, `${target.os}-${target.arch}`);
        fs.mkdirSync(targetDir, { recursive: true });
        fs.renameSync(bin, path.join(targetDir, binName));
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
      }
      console.log(`Installed freedom-cored for ${target.os}-${target.arch}`);
    }
    // Windows ARM64 uses the verified x64 build via OS emulation, like Ant.
    const winArmDir = path.join(outputDir, 'win-arm64');
    fs.mkdirSync(winArmDir, { recursive: true });
    const stage = fs.mkdtempSync(path.join(outputDir, '.fetch-'));
    try {
      const bin = path.join(stage, 'freedom-cored.exe');
      fs.copyFileSync(path.join(outputDir, 'win-x64', 'freedom-cored.exe'), bin);
      fs.renameSync(bin, path.join(winArmDir, 'freedom-cored.exe'));
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

if (require.main === module) {
  main();
}

module.exports = {
  fetchRelease,
  downloadFile,
  main,
  releaseRequestHeaders,
  releaseUrl,
  parseChecksums,
  assetFor,
  TARGETS,
  CORE_REPO,
  PINNED_RELEASE_TAG,
};
