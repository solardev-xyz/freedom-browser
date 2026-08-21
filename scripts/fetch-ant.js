const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Fetches the Ant (`antd`) Swarm light node. Ant is a bee-compatible drop-in
// published at solardev-xyz/ant; its release assets follow a bee-style os/arch
// keyword scheme, which the per-target matcher below relies on. The binary
// shipped is `antd` (not `bee`) and it installs into `ant-bin/<os>-<arch>/`.
const OUTPUT_DIR = path.join(__dirname, '..', 'ant-bin');
const ANT_REPO = process.env.ANT_REPO || 'solardev-xyz/ant';
// The known-good Ant release this app version is built and CI-tested against.
// Bump deliberately (with a CI run) — do NOT float on `latest`, or releases
// could ship a different Ant than CI validated. Override via ANT_RELEASE_TAG
// for local testing of newer releases; set it to `latest` to resolve the
// repo's most recent published release.
const PINNED_RELEASE_TAG = 'v0.5.43';
// In-repo trust root for the pinned release: the sha256 of its SHA256SUMS
// asset, recorded at pin time (trust-on-first-use by the author). The release
// downloads its SHA256SUMS from the same GitHub release as the binaries, so
// without this pin a compromised release could swap binaries *and* checksums
// together. Verifying the sums file against a digest committed here makes
// that tampering detectable. Update alongside PINNED_RELEASE_TAG on every
// deliberate bump: `shasum -a 256` the freshly downloaded SHA256SUMS.
const PINNED_SHA256SUMS_DIGEST =
  'ba9d97564a0e8631371bf036bdb33e0a9c7986493a7dca2406907f30e9bb900d';
const ANT_RELEASE_TAG = process.env.ANT_RELEASE_TAG || PINNED_RELEASE_TAG;

function fetchReleaseOnce() {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const headers = {
      'User-Agent': 'Freedom-Updater',
      Accept: 'application/vnd.github+json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const releasePath =
      ANT_RELEASE_TAG === 'latest'
        ? `/repos/${ANT_REPO}/releases/latest`
        : `/repos/${ANT_REPO}/releases/tags/${ANT_RELEASE_TAG}`;

    const options = {
      hostname: 'api.github.com',
      path: releasePath,
      headers,
    };

    https
      .get(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`Failed to fetch release (${releasePath}): ${res.statusCode}`));
          }
        });
      })
      .on('error', reject);
  });
}

async function fetchRelease() {
  const maxAttempts = 4;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchReleaseOnce();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delayMs = 1000 * attempt;
        console.warn(
          `Release fetch attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms...`
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// Abort a stalled request instead of letting it hang until the CI job-level
// timeout (a hung binary download can otherwise burn a whole e2e job).
const REQUEST_TIMEOUT_MS = 60000;

function downloadFileOnce(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const fail = (err) => {
      file.close();
      fs.unlink(dest, () => reject(err));
    };
    const req = https
      .get(url, { headers: { 'User-Agent': 'Freedom-Updater' } }, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          file.close();
          fs.unlink(dest, () => {
            downloadFileOnce(response.headers.location, dest).then(resolve).catch(reject);
          });
          return;
        }
        if (response.statusCode !== 200) {
          fail(new Error(`HTTP ${response.statusCode} for ${url}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close(resolve);
        });
        file.on('error', fail);
      })
      .on('error', fail);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Download timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`));
    });
  });
}

async function downloadFile(url, dest) {
  console.log(`Downloading ${url} to ${dest}...`);
  const maxAttempts = 4;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await downloadFileOnce(url, dest);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delayMs = 1000 * attempt;
        console.warn(
          `Download attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms...`
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
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
    await downloadFile(sumsAsset.browser_download_url, sumsPath);

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
          a.name !== 'SHA256SUMS' &&
          target.keywords.every((k) => a.name.toLowerCase().includes(k))
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
        throw new Error(
          `Checksum mismatch for ${asset.name}: expected ${expected}, got ${actual}`
        );
      }
      console.log(`Verified checksum for ${asset.name}`);

      // execFileSync with an args vector: the asset name is attacker-influenced
      // (the checksum above covers content, not filename) and must never reach
      // a shell.
      if (asset.name.endsWith('.tar.gz') || asset.name.endsWith('.tgz')) {
        console.log(`Extracting ${asset.name}...`);
        execFileSync('tar', ['-xzf', tempDest, '-C', targetDir]);
        fs.unlinkSync(tempDest);
      } else if (asset.name.endsWith('.zip')) {
        console.log(`Extracting ${asset.name}...`);
        execFileSync('unzip', ['-o', tempDest, '-d', targetDir]);
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

main();
