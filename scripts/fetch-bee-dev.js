/**
 * Fetches Bee in its dev mode (`bee dev`) for the e2e suites, and only for
 * them: it is never packaged (no `extraResources` entry names
 * `bee-dev-bin/`) and nothing the app runs reads it.
 *
 * Why: the bundled antd is a light node. Offline it can't finish an upload
 * (every push needs a peer) or read anything past a single chunk, and it
 * peers only with full Bee nodes, so two antd instances can't keep each
 * other's uploads. `bee dev` is one process, offline, with mocked postage
 * and chain and a real local store: it accepts an upload, answers it with
 * its reference and serves it back (`/bzz`, `/bytes`, `/chunks`). The
 * window.swarm e2e (src/main/page/page-swarm-node.integration.test.js) uses
 * it for its upload-success leg, where both backends' references and what
 * the node actually stored are compared.
 *
 * Pinned: Bee v2.8.0, the last release with `bee dev` (v2.8.1 removed it,
 * ethersphere/bee#5436). Each asset's SHA-256 is the release's
 * `bee_2.8.0_checksums.txt` entry, recorded here at pin time, so a release
 * asset swapped later fails the download instead of running. Only the
 * host's binary is fetched, to `bee-dev-bin/<os>-<arch>/bee[.exe]`.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { downloadToFile, TIMEOUTS } = require('./lib/fetch-with-retry');

const PINNED_RELEASE_TAG = 'v2.8.0';
const OUTPUT_DIR = path.join(__dirname, '..', 'bee-dev-bin');
// Each binary's line in the release's bee_2.8.0_checksums.txt.
const ASSETS = {
  'linux-x64': {
    asset: 'bee-linux-amd64',
    sha256: '377275e431546fa890906e9be2c202f89896dce6737889e4659022ab7419ec71',
  },
  'linux-arm64': {
    asset: 'bee-linux-arm64',
    sha256: '66a954ab360113af54235fb86c42182b1a69815fd40aa5b30c60da6227ca8b0e',
  },
  'mac-x64': {
    asset: 'bee-darwin-amd64',
    sha256: '6396f01b4413dca5d3cfb38cdc62d8a16e7fb91af59354309d6c01fc6dabc21d',
  },
  'mac-arm64': {
    asset: 'bee-darwin-arm64',
    sha256: '9ca9937e662a8050dc5fb2a9c513fbb33eb07cdf71dbfb75715e8610761692f7',
  },
  'win-x64': {
    asset: 'bee-windows-amd64.exe',
    sha256: 'f0d3c4f19623ea80369e32c86e319ea8668c6748cc32a87517e37f8335ec9964',
  },
};

/** The `<os>-<arch>` of `platform` and `arch`, as ant-bin/ and bee-dev-bin/ name it. */
function targetOf(platform = process.platform, arch = process.arch) {
  const os = { darwin: 'mac', linux: 'linux', win32: 'win' }[platform];
  return os ? `${os}-${arch}` : null;
}

/** Where the binary for `target` goes. */
function binaryPath(target = targetOf(), outputDir = OUTPUT_DIR) {
  return path.join(outputDir, target, target.startsWith('win-') ? 'bee.exe' : 'bee');
}

/** The SHA-256 of `file`, hex. */
function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Puts the pinned Bee for `target` at its `binaryPath`, its digest checked
 * before it takes that name; one already there with the pinned digest is
 * kept. Throws for a target the release has no binary for, or a digest
 * that isn't the pinned one.
 */
async function fetchBeeDev({
  target = targetOf(),
  outputDir = OUTPUT_DIR,
  download = downloadToFile,
  assets = ASSETS,
} = {}) {
  const pinned = assets[target];
  if (!pinned) {
    throw new Error(`Bee ${PINNED_RELEASE_TAG} has no dev-mode binary for ${target} here`);
  }
  const dest = binaryPath(target, outputDir);
  if (fs.existsSync(dest) && sha256Of(dest) === pinned.sha256) {
    console.log(`Bee ${PINNED_RELEASE_TAG} (${target}) already at ${dest}`);
    return dest;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const fetched = `${dest}.download`;
  const url = `https://github.com/ethersphere/bee/releases/download/${PINNED_RELEASE_TAG}/${pinned.asset}`;
  try {
    await download(url, fetched, {
      label: `Bee ${PINNED_RELEASE_TAG} ${pinned.asset}`,
      headers: { 'User-Agent': 'Freedom-Updater' },
      timeoutMs: TIMEOUTS.binary,
    });
    const got = sha256Of(fetched);
    if (got !== pinned.sha256) {
      throw new Error(`${pinned.asset}: SHA-256 ${got}, pinned ${pinned.sha256}`);
    }
    fs.chmodSync(fetched, 0o755);
    fs.renameSync(fetched, dest);
  } finally {
    fs.rmSync(fetched, { force: true });
  }
  console.log(`Bee ${PINNED_RELEASE_TAG} (${target}) at ${dest}`);
  return dest;
}

async function main() {
  try {
    await fetchBeeDev();
  } catch (err) {
    console.error('Error:', err);
    process.exitCode = 1;
  }
  // Returns rather than calling process.exit() (#544, fetch-ant.js).
}

if (require.main === module) {
  main();
}

module.exports = { ASSETS, PINNED_RELEASE_TAG, binaryPath, fetchBeeDev, sha256Of, targetOf };
