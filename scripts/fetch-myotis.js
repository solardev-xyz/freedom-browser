const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// Fetches the Myotis Node addon — the fully-P2P Ethereum light client
// (biafra23/myotis) as a prebuilt napi-rs binding for the current platform.
// Runs invisibly inside Freedom like the ant/IPFS nodes; see
// src/main/myotis/myotis-manager.js. Installs into `myotis-bin/`.
const OUTPUT_DIR = path.join(__dirname, '..', 'myotis-bin');
const MYOTIS_REPO = process.env.MYOTIS_REPO || 'biafra23/myotis';
// The known-good Myotis release this app version is built and tested against.
// Bump deliberately (with a live e2e run) — do NOT float on `latest`. The
// engine ABI the addon reports must match myotis-manager's EXPECTED_ABI.
const PINNED_RELEASE_TAG = 'v0.1.7';
// In-repo trust root for the pinned release: sha256 of its
// myotis-node.SHA256SUMS asset, recorded at pin time. The sums file comes
// from the same GitHub release as the addons, so without this pin a
// compromised release could swap binaries *and* checksums together. Update
// alongside PINNED_RELEASE_TAG on every deliberate bump.
const PINNED_SHA256SUMS_DIGEST =
  '458743f281a7886e953a32ccef599bc253781e278c12cfe05a5addc23aa2569a';
const MYOTIS_RELEASE_TAG = process.env.MYOTIS_RELEASE_TAG || PINNED_RELEASE_TAG;

// Every target the release publishes, installed in one run (fetch-ant.js
// convention — cross-target dist builds and the Docker recipes then need no
// --target flags). Dir names are electron-builder's ${os}-${arch}. Windows
// ARM64 is deliberately absent: no upstream artifact, and check-binaries.js
// skips it — the app degrades to Colibri/quorum there.
const TARGETS = [
  { runtime: 'darwin-arm64', dir: 'mac-arm64', asset: 'myotis-node.darwin-arm64.node' },
  { runtime: 'darwin-x64', dir: 'mac-x64', asset: 'myotis-node.darwin-x64.node' },
  { runtime: 'linux-x64', dir: 'linux-x64', asset: 'myotis-node.linux-x64-gnu.node' },
  { runtime: 'linux-arm64', dir: 'linux-arm64', asset: 'myotis-node.linux-arm64-gnu.node' },
  { runtime: 'win32-x64', dir: 'win-x64', asset: 'myotis-node.win32-x64-msvc.node' },
];

const REQUEST_TIMEOUT_MS = 60000;

function httpsGetJson(pathName) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const headers = {
      'User-Agent': 'Freedom-Updater',
      Accept: 'application/vnd.github+json',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    https
      .get({ hostname: 'api.github.com', path: pathName, headers }, (res) => {
        let data = '';
        res.on('error', reject);
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Failed to fetch ${pathName}: ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Invalid JSON from ${pathName}: ${err.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

function downloadFileOnce(url, dest, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      file.close();
      fs.unlink(dest, () => reject(err));
    };
    const req = https
      .get(url, { headers: { 'User-Agent': 'Freedom-Updater' } }, (response) => {
        response.on('error', fail);
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          if (redirectCount >= 5) {
            fail(new Error(`Too many redirects while downloading ${url}`));
            return;
          }
          let location;
          try {
            location = new URL(response.headers.location, url);
          } catch {
            fail(new Error(`Invalid redirect while downloading ${url}`));
            return;
          }
          if (location.protocol !== 'https:') {
            fail(new Error(`Refusing non-HTTPS redirect while downloading ${url}`));
            return;
          }
          // The redirected request owns completion from here. Ignore any late
          // error emitted by the response we are deliberately draining.
          settled = true;
          response.resume();
          file.close();
          fs.unlink(dest, () => {
            downloadFileOnce(location.href, dest, redirectCount + 1).then(resolve).catch(reject);
          });
          return;
        }
        if (response.statusCode !== 200) {
          fail(new Error(`HTTP ${response.statusCode} for ${url}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => file.close(() => {
          if (settled) return;
          settled = true;
          resolve();
        }));
        file.on('error', fail);
      })
      .on('error', fail);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Download timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`));
    });
  });
}

async function withRetries(label, fn) {
  const maxAttempts = 4;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delayMs = 1000 * attempt;
        console.warn(`${label} attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

function sha256Bytes(bytes) {
  const hash = crypto.createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

// `sha256sum`-style lines: `<hex>␠␠<filename>` or `<hex> *<filename>`.
function parseChecksums(text) {
  const map = {};
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match) map[path.basename(match[2].trim())] = match[1].toLowerCase();
  }
  return map;
}

async function main() {
  try {
    const requestedTarget = process.env.MYOTIS_DOWNLOAD_TARGET || '';
    const targets = requestedTarget
      ? TARGETS.filter((target) => target.runtime === requestedTarget)
      : TARGETS;
    if (!targets.length) {
      throw new Error(`Unknown MYOTIS_DOWNLOAD_TARGET: ${requestedTarget}`);
    }
    console.log(`Fetching Myotis release info from ${MYOTIS_REPO} @ ${MYOTIS_RELEASE_TAG}...`);
    const releasePath =
      MYOTIS_RELEASE_TAG === 'latest'
        ? `/repos/${MYOTIS_REPO}/releases/latest`
        : `/repos/${MYOTIS_REPO}/releases/tags/${MYOTIS_RELEASE_TAG}`;
    const release = await withRetries('Release fetch', () => httpsGetJson(releasePath));
    console.log(`Myotis version: ${release.tag_name}`);
    const assets = release.assets || [];

    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // Checksums first — a Myotis release always ships myotis-node.SHA256SUMS.
    const sumsAsset = assets.find((a) => a.name === 'myotis-node.SHA256SUMS');
    if (!sumsAsset) {
      throw new Error(
        `Release ${release.tag_name} has no myotis-node.SHA256SUMS — refusing to install unverified addon.`
      );
    }
    const sumsPath = path.join(OUTPUT_DIR, 'myotis-node.SHA256SUMS');
    await withRetries('SHA256SUMS download', () =>
      downloadFileOnce(sumsAsset.browser_download_url, sumsPath)
    );

    // Anchor to the in-repo trust root (pinned tag only — a tag override is a
    // local-testing escape hatch with no committed digest).
    let checksums;
    if (MYOTIS_RELEASE_TAG === PINNED_RELEASE_TAG) {
      const sumsBytes = fs.readFileSync(sumsPath);
      const sumsDigest = sha256Bytes(sumsBytes);
      if (sumsDigest !== PINNED_SHA256SUMS_DIGEST) {
        throw new Error(
          `myotis-node.SHA256SUMS for ${PINNED_RELEASE_TAG} does not match the in-repo pinned digest ` +
            `(expected ${PINNED_SHA256SUMS_DIGEST}, got ${sumsDigest}). ` +
            'The release assets may have been re-published or tampered with — refusing to install.'
        );
      }
      console.log('Verified myotis-node.SHA256SUMS against the in-repo pinned digest');
      checksums = parseChecksums(sumsBytes.toString('utf8'));
    } else {
      checksums = parseChecksums(fs.readFileSync(sumsPath, 'utf8'));
    }

    // Stable install name under an electron-builder-style ${os}-${arch} dir —
    // packaging copies myotis-bin/<os>-<arch>/ into resources/myotis-node/,
    // and myotis-manager loads the dev path directly.
    for (const target of targets) {
      const asset = assets.find((a) => a.name === target.asset);
      if (!asset) {
        throw new Error(
          `Release ${release.tag_name} has no asset ${target.asset} — refusing to produce an incomplete install.`
        );
      }
      const platformDir = path.join(OUTPUT_DIR, target.dir);
      if (!fs.existsSync(platformDir)) fs.mkdirSync(platformDir, { recursive: true });
      const destPath = path.join(platformDir, 'myotis-node.node');
      await withRetries('Addon download', () =>
        downloadFileOnce(asset.browser_download_url, destPath)
      );

      const expected = checksums[target.asset];
      if (!expected) {
        throw new Error(`${target.asset} missing from myotis-node.SHA256SUMS`);
      }
      const actual = sha256File(destPath);
      if (actual !== expected) {
        fs.unlinkSync(destPath);
        throw new Error(
          `Checksum mismatch for ${target.asset}: expected ${expected}, got ${actual} — deleted.`
        );
      }
      console.log(`Verified and installed ${target.asset} → ${destPath}`);
    }
  } catch (err) {
    console.error(`fetch-myotis failed: ${err.message}`);
    process.exit(1);
  }
}

main();
