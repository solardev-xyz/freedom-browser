// Official, checksum-pinned Myotis release addons. No local native patch/build.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const release = require('./myotis-release.json');
const { fetchBuffer, TIMEOUTS } = require('./lib/fetch-with-retry');
const PINNED_RELEASE_TAG = release.releaseTag;
const OUTPUT_DIR = path.join(__dirname, '..', 'myotis-bin');
// The published addons are ~10 MB; anything an order of magnitude larger is
// not the asset this script came for, and is refused rather than buffered.
const MAX_ASSET_BYTES = 32 * 1024 * 1024;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function selectedTargets(requested = '') {
  const targets = release.targets.filter((target) => !requested || target.runtime === requested);
  if (!targets.length) throw new Error(`Unsupported Myotis target: ${requested}`);
  return targets;
}

function verifyBytes(target, bytes) {
  if (sha256(bytes) !== target.sha256) throw new Error('checkpoint-addon checksum mismatch');
}

// Pre-signing packaging check: the committed release hashes authorize the bytes,
// not a sidecar supplied alongside a locally built or downloaded addon.
function validateInstalledAddon(directory) {
  try {
    const target = release.targets.find((entry) => entry.dir === path.basename(directory));
    if (!target) return 'unsupported Myotis target';
    verifyBytes(target, fs.readFileSync(path.join(directory, 'myotis-node.node')));
    return null;
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing official Myotis addon' : error.message;
  }
}

// Bounded and retried by scripts/lib/fetch-with-retry.js: 5xx/429/connection
// failures and per-attempt timeouts buy another attempt, any other 4xx and a
// non-HTTPS redirect do not. The checksum comparisons below stay outside that
// loop — a mismatch is tampering or corruption, never weather.
function download(url, options = {}) {
  return fetchBuffer(url, {
    label: `Myotis ${url.split('/').pop()}`,
    headers: { 'User-Agent': 'Freedom-Myotis-Downloader' },
    timeoutMs: TIMEOUTS.binary,
    maxBytes: MAX_ASSET_BYTES,
    ...options,
  });
}

function fetchAsset(asset, options) {
  return download(`https://github.com/${release.repository}/releases/download/${release.releaseTag}/${asset}`, options);
}

// A replaced or half-installed addon copy would otherwise be left behind on
// every re-run or failed verification. Removal is best effort: a copy still
// mapped by a running process cannot be deleted on Windows and is retried on
// the next run. Only this script's own temporary names are considered.
const LEFTOVER = /^myotis-node\.(candidate-[0-9a-f-]+\.node|node\.previous-[0-9a-f-]+)$/;

function pruneLeftoverAddons(directory) {
  for (const name of fs.readdirSync(directory)) {
    if (!LEFTOVER.test(name)) continue;
    try {
      fs.rmSync(path.join(directory, name), { force: true });
    } catch {
      /* still mapped by a running process; retried on the next run */
    }
  }
}

async function main() {
  for (const key of ['MYOTIS_REPO', 'MYOTIS_RELEASE_TAG']) {
    if (process.env[key]) throw new Error(`${key} overrides are incompatible with the pinned official release`);
  }
  const targets = selectedTargets(process.env.MYOTIS_DOWNLOAD_TARGET);
  const sums = await fetchAsset('myotis-node.SHA256SUMS');
  if (sha256(sums) !== release.checksumsSha256) throw new Error('Myotis release checksum manifest mismatch');
  for (const target of targets) {
    const bytes = await fetchAsset(target.asset);
    verifyBytes(target, bytes);
    const directory = path.join(OUTPUT_DIR, target.dir);
    fs.mkdirSync(directory, { recursive: true });
    pruneLeftoverAddons(directory);
    const candidate = path.join(directory, `myotis-node.candidate-${crypto.randomUUID()}.node`);
    fs.writeFileSync(candidate, bytes, { flag: 'wx' });
    const installed = path.join(directory, 'myotis-node.node');
    let displaced = null;
    try {
      if (target.runtime === `${process.platform}-${process.arch}`) {
        execFileSync(process.execPath, [path.join(__dirname, 'verify-myotis-checkpoint-addon.js'), candidate], {
          stdio: 'inherit', timeout: 30000,
        });
      }
      // The displaced copy keeps a temporary name because a loaded addon can be
      // renamed but not removed while it is mapped.
      if (fs.existsSync(installed)) {
        displaced = `${installed}.previous-${crypto.randomUUID()}`;
        fs.renameSync(installed, displaced);
      }
      fs.renameSync(candidate, installed);
    } catch (error) {
      fs.rmSync(candidate, { force: true });
      throw error;
    }
    if (displaced) pruneLeftoverAddons(directory);
    console.log(`Installed official Myotis ${release.releaseTag} (${target.runtime})`);
  }
}

if (require.main === module) main().catch((error) => {
  console.error(`fetch-myotis failed: ${error.message}`);
  process.exitCode = 1;
});
module.exports = { PINNED_RELEASE_TAG, release, sha256, selectedTargets, verifyBytes, validateInstalledAddon, download, pruneLeftoverAddons, main };
