/**
 * Download the prebuilt libradicle napi addon from the GitHub release and
 * install it as radicle-bin/<platform>/libradicle.node, where
 * radicle-embedded.js looks for it.
 *
 * Usage:
 *   npm run radicle:download
 *   npm run radicle:download -- --win --x64
 *   npm run radicle:download -- --win --arm64
 *
 * The addon is verified twice before it lands: the release's SHA256SUMS
 * asset must match the in-repo pinned digest (PINNED_SHA256SUMS), and the
 * downloaded binary must match its line in those checksums.
 *
 * Source repo: solardev-xyz/libradicle (canonical Radicle home:
 * rad:z2SzCC9zYnP17QRPZUhrP2RTEwZHj). To build from source instead, use
 * `npm run radicle:build-addon` with a sibling libradicle checkout.
 */

const https = require('https');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { RADICLE_ADDON_RELEASE_TAG } = require('../src/shared/radicle-addon-version');

const RELEASE_BASE = `https://github.com/solardev-xyz/libradicle/releases/download/${RADICLE_ADDON_RELEASE_TAG}`;

// Bound every request and retry transient failures — this runs inside the
// `dist:linux:*:docker` release recipes, where a stalled GitHub connection
// would otherwise hang until the outer CI timeout (fetch-ant / fetch-myotis
// convention: 60s per request, 4 attempts).
const REQUEST_TIMEOUT_MS = 60000;
const MAX_ATTEMPTS = 4;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

// In-repo trust root for the pinned release: sha256 of that release's
// SHA256SUMS asset, recorded at pin time. SHA256SUMS ships from the same
// mutable GitHub release as the addon, so on its own it proves nothing —
// anyone able to re-publish the release swaps the binary and its checksums
// together. This addon is loaded into the main process and ships inside
// signed packages, so the digest is pinned here and verified before the
// checksums are trusted. Bump alongside RADICLE_ADDON_VERSION:
//   curl -sL <release>/SHA256SUMS | sha256sum
const PINNED_SHA256SUMS = {
  tag: 'v0.7.1',
  digest: 'aa6b92f357984d8cfaa6e4f551da8794fe6f9dc613d13c9bbbdaffce2aa459b3',
};

function platformKey(
  args = process.argv.slice(2),
  hostPlatform = process.platform,
  hostArch = process.arch
) {
  const requestedPlatforms = ['mac', 'linux', 'win'].filter((name) => args.includes(`--${name}`));
  const requestedArchs = ['arm64', 'x64'].filter((arch) => args.includes(`--${arch}`));

  if (requestedPlatforms.length > 1) {
    throw new Error('specify at most one target platform: --mac, --linux, or --win');
  }
  if (requestedArchs.length > 1) {
    throw new Error('specify at most one target architecture: --arm64 or --x64');
  }

  const hostOs = hostPlatform === 'darwin' ? 'mac' : hostPlatform === 'win32' ? 'win' : 'linux';
  const os = requestedPlatforms[0] || hostOs;
  const hostTargetArch = hostArch === 'arm64' ? 'arm64' : 'x64';
  const arch =
    requestedArchs[0] || (requestedPlatforms.length && os === 'win' ? 'x64' : hostTargetArch);

  return `${os}-${arch}`;
}

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = https
      .get(url, (res) => {
        res.on('error', fail);
        if (REDIRECT_CODES.has(res.statusCode)) {
          let location;
          try {
            location = new URL(res.headers.location, url);
          } catch {
            res.resume();
            return fail(new Error(`invalid redirect from ${url}`));
          }
          if (location.protocol !== 'https:') {
            res.resume();
            return fail(new Error(`refusing non-HTTPS redirect from ${url}`));
          }
          // The redirected request owns completion from here; this response
          // is deliberately drained, so its late errors are not ours.
          settled = true;
          res.resume();
          return fetchBuffer(location.href, redirects + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve(Buffer.concat(chunks));
        });
      })
      .on('error', fail);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`));
    });
  });
}

async function withRetries(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        const delayMs = 1000 * attempt;
        console.warn(`${label} attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms…`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

async function main(...platformArgs) {
  const key = platformKey(...platformArgs);
  const assetName = `libradicle-${key}.node`;

  if (RADICLE_ADDON_RELEASE_TAG !== PINNED_SHA256SUMS.tag) {
    throw new Error(
      `No in-repo SHA256SUMS digest is pinned for ${RADICLE_ADDON_RELEASE_TAG} ` +
        `(scripts/fetch-radicle-addon.js pins ${PINNED_SHA256SUMS.tag}). Record the new ` +
        'release\'s SHA256SUMS digest in PINNED_SHA256SUMS before downloading.'
    );
  }

  console.log(`Downloading ${assetName} (${RADICLE_ADDON_RELEASE_TAG})…`);
  const [binary, sums] = await Promise.all([
    withRetries('Addon download', () => fetchBuffer(`${RELEASE_BASE}/${assetName}`)),
    withRetries('SHA256SUMS download', () => fetchBuffer(`${RELEASE_BASE}/SHA256SUMS`)),
  ]);

  const sumsDigest = crypto.createHash('sha256').update(sums).digest('hex');
  if (sumsDigest !== PINNED_SHA256SUMS.digest) {
    throw new Error(
      `SHA256SUMS for ${RADICLE_ADDON_RELEASE_TAG} does not match the in-repo pinned digest ` +
        `(expected ${PINNED_SHA256SUMS.digest}, got ${sumsDigest}). The release assets may have ` +
        'been re-published or tampered with — refusing to install.'
    );
  }

  const expected = sums
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === assetName)?.[0];
  if (!expected) {
    throw new Error(`${assetName} not listed in SHA256SUMS`);
  }
  const actual = crypto.createHash('sha256').update(binary).digest('hex');
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${assetName}: ${actual} != ${expected}`);
  }

  const destDir = path.join(__dirname, '..', 'radicle-bin', key);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'libradicle.node');
  fs.writeFileSync(dest, binary);
  if (!key.startsWith('win-')) fs.chmodSync(dest, 0o755);
  console.log(`Installed ${dest} (${(binary.length / 1e6).toFixed(1)} MB, sha256 verified)`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = {
  platformKey,
  fetchBuffer,
  withRetries,
  main,
  PINNED_SHA256SUMS,
  REQUEST_TIMEOUT_MS,
  MAX_ATTEMPTS,
};
