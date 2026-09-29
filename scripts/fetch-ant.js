const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { fetchJson, downloadToFile, TIMEOUTS } = require('./lib/fetch-with-retry');

// Fetches the Ant (`antd`) Swarm light node. Ant is a bee-compatible drop-in
// published at freedom-hq/ant (formerly solardev-xyz/ant); its release assets
// follow a bee-style os/arch keyword scheme, which the per-target matcher below
// relies on. The binary shipped is `antd` (not `bee`) and it installs into
// `ant-bin/<os>-<arch>/`.
const OUTPUT_DIR = path.join(__dirname, '..', 'ant-bin');
const ANT_REPO = process.env.ANT_REPO || 'freedom-hq/ant';
// The known-good Ant release this app version is built and CI-tested against.
// Bump deliberately (with a CI run) — do NOT float on `latest`, or releases
// could ship a different Ant than CI validated. Override via ANT_RELEASE_TAG
// for local testing of newer releases; set it to `latest` to resolve the
// repo's most recent published release.
const PINNED_RELEASE_TAG = 'v0.5.45';
// In-repo trust root for the pinned release: the sha256 of its SHA256SUMS
// asset, recorded at pin time (trust-on-first-use by the author). The release
// downloads its SHA256SUMS from the same GitHub release as the binaries, so
// without this pin a compromised release could swap binaries *and* checksums
// together. Verifying the sums file against a digest committed here makes
// that tampering detectable. Update alongside PINNED_RELEASE_TAG on every
// deliberate bump: `shasum -a 256` the freshly downloaded SHA256SUMS.
const PINNED_SHA256SUMS_DIGEST = '0f508420704f5796f6551452df00ca302160abe4d403b8ccf1a02f44789e97ef';
const ANT_RELEASE_TAG = process.env.ANT_RELEASE_TAG || PINNED_RELEASE_TAG;

const API_HOST = 'api.github.com';
// GitHub answers an API request for a *renamed* repo with a 301 to the new
// canonical location rather than serving it, so a fetch that treats anything
// other than 200 as fatal turns an upstream rename into a hard CI failure
// (solardev-xyz/ant → freedom-hq/ant broke every job that downloads antd).
// Redirects are followed by scripts/lib/fetch-with-retry.js, which makes the
// next rename degrade to an extra hop.

function releaseUrl() {
  const releasePath =
    ANT_RELEASE_TAG === 'latest'
      ? `/repos/${ANT_REPO}/releases/latest`
      : `/repos/${ANT_REPO}/releases/tags/${ANT_RELEASE_TAG}`;
  return `https://${API_HOST}${releasePath}`;
}

/**
 * Headers for one hop of the release lookup. Computed per hop, not once:
 * only ever send the token to GitHub's own API host, because a redirect can
 * point anywhere and forwarding Authorization off-host would leak CI's
 * GITHUB_TOKEN to a third party.
 * @param {string} url
 */
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
 * The release JSON, retried on 5xx/429/connection failures and never on a
 * plain 404 (see scripts/lib/fetch-with-retry.js).
 * @param {string} [url]
 * @param {object} [options] retry-loop overrides, used by the unit tests
 */
function fetchRelease(url = releaseUrl(), options = {}) {
  return fetchJson(url, {
    label: `Ant release lookup (${ANT_REPO} @ ${ANT_RELEASE_TAG})`,
    headers: releaseRequestHeaders,
    timeoutMs: TIMEOUTS.metadata,
    onRedirect: (location) => {
      console.warn(`Release fetch redirected to ${location.href} — upstream repo may have moved`);
    },
    ...options,
  });
}

/**
 * Download one release asset. `timeoutMs` is the per-attempt deadline: the
 * archives are tens of megabytes on a runner link, SHA256SUMS is a few lines.
 * @param {string} url
 * @param {string} dest
 * @param {object} [options] `timeoutMs`, plus retry-loop overrides used by the tests
 */
function downloadFile(url, dest, options = {}) {
  console.log(`Downloading ${url} to ${dest}...`);
  return downloadToFile(url, dest, {
    label: `Ant asset ${path.basename(dest)}`,
    headers: { 'User-Agent': 'Freedom-Updater' },
    timeoutMs: TIMEOUTS.binary,
    ...options,
  });
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

// Parse a `sha256sum`-style SHA256SUMS file into { filename: hash }. Lines look
// like `<hex>␠␠<filename>` (two spaces) or `<hex> *<filename>` (binary mode).
function parseChecksums(text) {
  const map = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match) {
      map[path.basename(match[2].trim())] = match[1].toLowerCase();
    }
  }
  return map;
}

async function main() {
  try {
    console.log(`Fetching Ant release info from ${ANT_REPO} @ ${ANT_RELEASE_TAG}...`);
    const release = await fetchRelease();
    console.log(`Ant version: ${release.tag_name}`);

    const assets = release.assets || [];

    // Download + parse SHA256SUMS up front so each archive is verified before
    // extraction. Missing checksums are a hard error (a published Ant release
    // always ships SHA256SUMS — see the release workflow).
    const sumsAsset = assets.find((a) => a.name === 'SHA256SUMS');
    if (!sumsAsset) {
      throw new Error(
        `Release ${release.tag_name} has no SHA256SUMS asset — refusing to install unverified binaries.`
      );
    }
    const sumsPath = path.join(OUTPUT_DIR, 'SHA256SUMS');
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    await downloadFile(sumsAsset.browser_download_url, sumsPath, {
      timeoutMs: TIMEOUTS.metadata,
    });

    // Anchor the downloaded checksums to the in-repo trust root. Only applies
    // to the pinned tag — an ANT_RELEASE_TAG override is a local-testing
    // escape hatch with no committed digest to check against.
    if (ANT_RELEASE_TAG === PINNED_RELEASE_TAG) {
      const sumsDigest = sha256File(sumsPath);
      if (sumsDigest !== PINNED_SHA256SUMS_DIGEST) {
        throw new Error(
          `SHA256SUMS for ${PINNED_RELEASE_TAG} does not match the digest pinned in this repo ` +
            `(expected ${PINNED_SHA256SUMS_DIGEST}, got ${sumsDigest}). ` +
            'The release assets may have been re-published or tampered with — refusing to install.'
        );
      }
      console.log('Verified SHA256SUMS against the in-repo pinned digest');
    } else {
      console.warn(
        `ANT_RELEASE_TAG=${ANT_RELEASE_TAG} overrides the pinned release — ` +
          'skipping the in-repo SHA256SUMS digest check (local testing only).'
      );
    }
    const checksums = parseChecksums(fs.readFileSync(sumsPath, 'utf-8'));

    const targets = [
      { os: 'mac', arch: 'arm64', keywords: ['darwin', 'arm64'] },
      { os: 'mac', arch: 'x64', keywords: ['darwin', 'amd64'] },
      { os: 'linux', arch: 'x64', keywords: ['linux', 'amd64'] },
      { os: 'linux', arch: 'arm64', keywords: ['linux', 'arm64'] },
      { os: 'win', arch: 'x64', keywords: ['windows', 'amd64'], exe: true },
      // Ant (like bee) ships no Windows ARM64 build — copied from x64 below.
    ];

    for (const target of targets) {
      const asset = assets.find(
        (a) =>
          a.name !== 'SHA256SUMS' && target.keywords.every((k) => a.name.toLowerCase().includes(k))
      );

      if (!asset) {
        throw new Error(
          `Release ${release.tag_name} has no asset for ${target.os}-${target.arch} — refusing to produce an incomplete install.`
        );
      }

      const targetDir = path.join(OUTPUT_DIR, `${target.os}-${target.arch}`);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const binName = target.exe ? 'antd.exe' : 'antd';
      const destFile = path.join(targetDir, binName);

      const tempDest = path.join(targetDir, path.basename(asset.name));
      await downloadFile(asset.browser_download_url, tempDest);

      const expected = checksums[asset.name];
      if (!expected) {
        throw new Error(`No checksum entry for ${asset.name} in SHA256SUMS`);
      }
      const actual = sha256File(tempDest);
      if (actual !== expected) {
        throw new Error(`Checksum mismatch for ${asset.name}: expected ${expected}, got ${actual}`);
      }
      console.log(`Verified checksum for ${asset.name}`);

      // execFileSync with an args vector: the asset name is attacker-influenced
      // (the checksum above covers content, not filename) and must never reach
      // a shell.
      //
      // Archives are extracted with cwd = targetDir and a bare file name: on
      // Windows the absolute path `D:\a\...` makes GNU tar (first on PATH in
      // Git Bash) treat `D` as a remote host and fail. Windows also ships no
      // `unzip`, so use its own bsdtar, which reads zip and tar.gz alike.
      const isWindows = process.platform === 'win32';
      const tarBin = isWindows
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
      const extractOpts = { cwd: targetDir, stdio: 'inherit' };
      if (asset.name.endsWith('.tar.gz') || asset.name.endsWith('.tgz')) {
        console.log(`Extracting ${asset.name}...`);
        execFileSync(tarBin, ['-xzf', path.basename(tempDest)], extractOpts);
        fs.unlinkSync(tempDest);
      } else if (asset.name.endsWith('.zip')) {
        console.log(`Extracting ${asset.name}...`);
        if (isWindows) {
          execFileSync(tarBin, ['-xf', path.basename(tempDest)], extractOpts);
        } else {
          execFileSync('unzip', ['-o', path.basename(tempDest)], extractOpts);
        }
        fs.unlinkSync(tempDest);
      } else {
        fs.renameSync(tempDest, destFile);
      }

      if (fs.existsSync(destFile)) {
        if (!target.exe) fs.chmodSync(destFile, '755');
        console.log(`Successfully installed Ant for ${target.os}-${target.arch}`);
      } else {
        const findAnt = (dir) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if ((entry.name === 'antd' || entry.name === 'antd.exe') && entry.isFile())
              return path.join(dir, entry.name);
            if (entry.isDirectory()) {
              const found = findAnt(path.join(dir, entry.name));
              if (found) return found;
            }
          }
          return null;
        };

        const foundBin = findAnt(targetDir);
        if (!foundBin) {
          throw new Error(
            `Failed to locate 'antd' binary after download/extraction for ${target.os}-${target.arch}`
          );
        }
        fs.renameSync(foundBin, destFile);
        if (!target.exe) fs.chmodSync(destFile, '755');
        console.log(`Found and installed Ant binary for ${target.os}-${target.arch}`);
      }
    }

    // Copy win-x64 binary to win-arm64 (Ant doesn't provide ARM64 builds, but Windows ARM64 can run x64 via emulation)
    const winX64Dir = path.join(OUTPUT_DIR, 'win-x64');
    const winArm64Dir = path.join(OUTPUT_DIR, 'win-arm64');
    const winX64Bin = path.join(winX64Dir, 'antd.exe');
    const winArm64Bin = path.join(winArm64Dir, 'antd.exe');

    if (fs.existsSync(winX64Bin)) {
      if (!fs.existsSync(winArm64Dir)) {
        fs.mkdirSync(winArm64Dir, { recursive: true });
      }
      fs.copyFileSync(winX64Bin, winArm64Bin);
      console.log('Copied win-x64 Ant binary to win-arm64 (emulation fallback)');
    }

    console.log('All downloads complete.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// Exported for unit tests; `npm run ant:download` still runs main() above.
module.exports = {
  fetchRelease,
  releaseRequestHeaders,
  releaseUrl,
  downloadFile,
  parseChecksums,
  ANT_REPO,
  PINNED_RELEASE_TAG,
};
