const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { downloadToFile, TIMEOUTS } = require('./lib/fetch-with-retry');

// Pin to a specific release. Update src/shared/ton-version.js to upgrade.
const { RELEASE_TAG } = require('../src/shared/ton-version');

const OUTPUT_DIR = path.join(__dirname, '..', 'ton-bin');
const RELEASE_REPO = 'TONresistor/Tonutils-Proxy';
const BINARY_NAME = 'tonutils-freedom-cli';
// Source commit behind v0.1.0-freedom. This documents the reviewed source;
// the binary trust roots are the per-asset SHA-256 values below.
const PINNED_SOURCE_COMMIT = '0b4eb46be7c073d6b3e94421b4b80e9b807a246c';

const TARGETS = [
  {
    os: 'mac',
    arch: 'arm64',
    asset: `${BINARY_NAME}-darwin-arm64`,
    sha256: 'fc8f5605ebe36dc48606504cad468a9d00990dc8892297d8e9183c583ef2fddd',
  },
  {
    os: 'mac',
    arch: 'x64',
    asset: `${BINARY_NAME}-darwin-amd64`,
    sha256: 'cd59cc9bbfb906d0622e5ecbb649c8c17b5f1e42f457680f480ed2de7b948c34',
  },
  {
    os: 'linux',
    arch: 'x64',
    asset: `${BINARY_NAME}-linux-amd64`,
    sha256: 'a81387bd03342a31f6747d808955cde7b18c304c23194a2521b1cfa80927f726',
  },
  {
    os: 'linux',
    arch: 'arm64',
    asset: `${BINARY_NAME}-linux-arm64`,
    sha256: 'cc73061c9129fd68c883830e0d457c0dfdb5fe4b788f65ee8f1d6d8117bba266',
  },
  {
    os: 'win',
    arch: 'x64',
    asset: `${BINARY_NAME}-windows-amd64.exe`,
    sha256: '21debf32524f5d4b97e91619909afbbd80aa477ec6c4b9151900598ce76a6992',
    exe: true,
  },
];

function runtimeTarget(platform = process.platform, arch = process.arch) {
  const os = { darwin: 'mac', linux: 'linux', win32: 'win' }[platform];
  if (!os) return null;
  const normalizedArch = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!normalizedArch) return null;
  if (os === 'win' && normalizedArch === 'arm64') return { os, arch: 'x64' };
  return { os, arch: normalizedArch };
}

function selectedTargets(args = [], platform = process.platform, arch = process.arch) {
  const osFlags = [
    ['--mac', 'mac'],
    ['--linux', 'linux'],
    ['--win', 'win'],
  ].filter(([flag]) => args.includes(flag));
  const archFlags = [
    ['--arm64', 'arm64'],
    ['--x64', 'x64'],
  ].filter(([flag]) => args.includes(flag));
  if (osFlags.length > 1 || archFlags.length > 1) {
    throw new Error(`Conflicting TON proxy target flags: ${args.join(' ')}`);
  }
  const requestedOs = osFlags[0]?.[1];
  const requestedArch = archFlags[0]?.[1] || null;
  const runtime = runtimeTarget(platform, arch);
  if (!runtime) throw new Error(`Unsupported TON proxy target: ${platform}-${arch}`);
  const selected = {
    os: requestedOs || runtime.os,
    arch: requestedArch || (requestedOs === 'win' ? 'x64' : runtime.arch),
  };
  if (selected.os === 'win' && selected.arch === 'arm64') selected.arch = 'x64';
  const target = TARGETS.find(
    ({ os, arch: targetArch }) => os === selected.os && targetArch === selected.arch
  );
  if (!target) throw new Error(`No pinned TON proxy asset for ${selected.os}-${selected.arch}`);
  return [target];
}

function buildDownloadUrl(tag, asset) {
  return `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${asset}`;
}

function downloadFile(url, dest, options = {}) {
  console.log(`Downloading ${url} to ${dest}...`);
  return downloadToFile(url, dest, {
    label: `TON proxy asset ${path.basename(dest)}`,
    headers: { 'User-Agent': 'Freedom-Updater' },
    timeoutMs: TIMEOUTS.binary,
    ...options,
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function checkBinary() {
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const os = platformMap[process.platform] || process.platform;
  const arch = process.arch;

  const basePath = path.join(__dirname, '..', 'ton-bin');
  const binName = process.platform === 'win32' ? `${BINARY_NAME}.exe` : BINARY_NAME;
  const binPath = path.join(basePath, `${os}-${arch}`, binName);
  const available = fs.existsSync(binPath);
  return {
    available,
    path: available ? binPath : null,
    version: null,
  };
}

async function installTarget(target, options = {}) {
  const outputDir = options.outputDir || OUTPUT_DIR;
  const downloader = options.download || downloadFile;
  const targetDir = path.join(outputDir, `${target.os}-${target.arch}`);
  fs.mkdirSync(targetDir, { recursive: true });

  const binName = target.exe ? `${BINARY_NAME}.exe` : BINARY_NAME;
  const destFile = path.join(targetDir, binName);
  const tempFile = `${destFile}.download`;

  try {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    await downloader(buildDownloadUrl(RELEASE_TAG, target.asset), tempFile);
    const actual = await sha256File(tempFile);
    if (actual !== target.sha256) {
      throw new Error(
        `Checksum mismatch for ${target.asset}: expected ${target.sha256}, got ${actual}`
      );
    }
    if (!target.exe) fs.chmodSync(tempFile, 0o755);
    fs.renameSync(tempFile, destFile);
    console.log(`Installed ${BINARY_NAME} for ${target.os}-${target.arch} (sha256: ${actual})`);
    return destFile;
  } catch (err) {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    throw err;
  }
}

async function main() {
  try {
    console.log(
      `Fetching ${BINARY_NAME} ${RELEASE_TAG} (source ${PINNED_SOURCE_COMMIT.slice(0, 12)})...`
    );

    const targets = selectedTargets(process.argv.slice(2));
    for (const target of targets) {
      await installTarget(target);
    }

    // Copy win-x64 to win-arm64 as emulation fallback
    const winX64Bin = path.join(OUTPUT_DIR, 'win-x64', `${BINARY_NAME}.exe`);
    const winArm64Dir = path.join(OUTPUT_DIR, 'win-arm64');
    const winArm64Bin = path.join(winArm64Dir, `${BINARY_NAME}.exe`);

    if (targets.some(({ os }) => os === 'win') && fs.existsSync(winX64Bin)) {
      if (!fs.existsSync(winArm64Dir)) {
        fs.mkdirSync(winArm64Dir, { recursive: true });
      }
      fs.copyFileSync(winX64Bin, winArm64Bin);
      console.log('Copied win-x64 binary to win-arm64 (emulation fallback)');
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

module.exports = {
  buildDownloadUrl,
  checkBinary,
  downloadFile,
  installTarget,
  sha256File,
  BINARY_NAME,
  PINNED_SOURCE_COMMIT,
  RELEASE_REPO,
  RELEASE_TAG,
  runtimeTarget,
  selectedTargets,
  TARGETS,
};
