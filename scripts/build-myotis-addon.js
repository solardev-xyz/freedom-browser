// Freedom's additive checkpoint-import extension, built from authenticated source.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const source = require('./myotis-native/source.json');

const ROOT = path.join(__dirname, '..');
const PATCH = path.join(__dirname, 'myotis-native/checkpoint-import-v1.patch');
const TARGETS = {
  'darwin-arm64': { dir: 'mac-arm64', library: 'libmyotis_node.dylib' },
  'darwin-x64': { dir: 'mac-x64', library: 'libmyotis_node.dylib' },
  'linux-arm64': { dir: 'linux-arm64', library: 'libmyotis_node.so' },
  'linux-x64': { dir: 'linux-x64', library: 'libmyotis_node.so' },
  'win32-x64': { dir: 'win-x64', library: 'myotis_node.dll' },
};

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function selectedTarget(requested = '', platform = process.platform, arch = process.arch) {
  const runtime = requested || `${platform}-${arch}`;
  if (!TARGETS[runtime]) throw new Error(`Unsupported Myotis target: ${runtime}`);
  if (runtime !== `${platform}-${arch}`) {
    throw new Error(
      `Build the Myotis checkpoint addon on its ${runtime} host; cross-target vanilla downloads are not supported`
    );
  }
  return { runtime, ...TARGETS[runtime] };
}

function validateManifest(manifest, addonBytes, platformDir) {
  if (
    !manifest ||
    manifest.extensionVersion !== source.extensionVersion ||
    manifest.abi !== source.abi ||
    manifest.releaseTag !== source.releaseTag ||
    manifest.sourceCommit !== source.sourceCommit ||
    manifest.sourceSha256 !== source.sourceSha256 ||
    manifest.patchSha256 !== source.patchSha256 ||
    manifest.rustToolchain !== source.rustToolchain ||
    manifest.profile !== 'release' ||
    TARGETS[manifest.runtime]?.dir !== platformDir
  ) {
    return 'missing or incompatible checkpoint-addon build provenance';
  }
  if (manifest.addonSha256 !== sha256(addonBytes)) return 'checkpoint-addon checksum mismatch';
  return null;
}

function validateInstalledAddon(directory) {
  try {
    if (sha256(fs.readFileSync(PATCH)) !== source.patchSha256)
      return 'tracked checkpoint patch checksum mismatch';
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'myotis-build.json'), 'utf8'));
    return validateManifest(
      manifest,
      fs.readFileSync(path.join(directory, 'myotis-node.node')),
      path.basename(directory)
    );
  } catch {
    return 'missing or unreadable checkpoint-addon build provenance';
  }
}

async function downloadSource(url, redirects = 0) {
  if (new URL(url).protocol !== 'https:' || redirects > 5)
    throw new Error('Invalid source archive redirect');
  const headers = { 'User-Agent': 'Freedom-Myotis-Builder', Accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  // The API token never follows the archive redirect to another host.
  if (new URL(url).hostname === 'api.github.com' && token)
    headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(60000),
    headers,
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel();
    return downloadSource(new URL(response.headers.get('location'), url).href, redirects + 1);
  }
  if (!response.ok) throw new Error(`Myotis source download returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 32 * 1024 * 1024) {
      await reader.cancel();
      throw new Error('Myotis source archive exceeds the 32 MiB limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function preserveExisting(file) {
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.previous-${Date.now()}`);
}

async function buildAddon() {
  for (const key of ['MYOTIS_REPO', 'MYOTIS_RELEASE_TAG']) {
    if (process.env[key])
      throw new Error(`${key} overrides are incompatible with the pinned checkpoint extension`);
  }
  const target = selectedTarget(process.env.MYOTIS_DOWNLOAD_TARGET);
  const patchBytes = fs.readFileSync(PATCH);
  if (sha256(patchBytes) !== source.patchSha256)
    throw new Error('Tracked Myotis patch checksum mismatch');
  const cache =
    process.env.MYOTIS_BUILD_CACHE ||
    path.join(os.tmpdir(), `freedom-myotis-${source.sourceSha256.slice(0, 12)}`);
  fs.mkdirSync(cache, { recursive: true });
  const archive = process.env.MYOTIS_SOURCE_ARCHIVE || path.join(cache, 'source.tar.gz');
  if (!fs.existsSync(archive)) {
    if (process.env.MYOTIS_SOURCE_ARCHIVE) throw new Error('MYOTIS_SOURCE_ARCHIVE does not exist');
    const bytes = await downloadSource(source.sourceUrl);
    if (sha256(bytes) !== source.sourceSha256)
      throw new Error('Downloaded Myotis source checksum mismatch');
    fs.writeFileSync(archive, bytes, { flag: 'wx' });
  }
  if (sha256(fs.readFileSync(archive)) !== source.sourceSha256)
    throw new Error('Myotis source archive checksum mismatch');
  // Each invocation gets authenticated fresh source, including concurrent builds.
  const checkout = fs.mkdtempSync(path.join(cache, `source-${source.patchSha256.slice(0, 12)}-`));
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', checkout], {
    stdio: 'inherit',
  });
  execFileSync('git', ['apply', '--check', PATCH], { cwd: checkout, stdio: 'inherit' });
  execFileSync('git', ['apply', PATCH], { cwd: checkout, stdio: 'inherit' });
  const targetDir = process.env.MYOTIS_CARGO_TARGET_DIR || path.join(cache, 'target');
  const cargoArgs = [
    `+${source.rustToolchain}`,
    'build',
    '--locked',
    '--release',
    '-p',
    'myotis-node',
    '--target-dir',
    targetDir,
  ];
  execFileSync('cargo', cargoArgs, { cwd: path.join(checkout, 'rust'), stdio: 'inherit' });
  const outputDir = path.join(ROOT, 'myotis-bin', target.dir);
  fs.mkdirSync(outputDir, { recursive: true });
  const addon = path.join(outputDir, 'myotis-node.node');
  const candidate = path.join(outputDir, `myotis-node.candidate-${Date.now()}.node`);
  fs.copyFileSync(path.join(targetDir, 'release', target.library), candidate);
  execFileSync(
    process.execPath,
    [path.join(__dirname, 'verify-myotis-checkpoint-addon.js'), candidate],
    { stdio: 'inherit', timeout: 30000 }
  );
  const manifest = {
    ...source,
    runtime: target.runtime,
    profile: 'release',
    addonSha256: sha256(fs.readFileSync(candidate)),
    rustc: execFileSync('rustc', [`+${source.rustToolchain}`, '--version'], {
      encoding: 'utf8',
    }).trim(),
  };
  preserveExisting(addon);
  fs.renameSync(candidate, addon);
  const manifestPath = path.join(outputDir, 'myotis-build.json');
  preserveExisting(manifestPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(
    `Built Myotis ${source.releaseTag} + checkpoint import v${source.extensionVersion}: ${addon}`
  );
  return addon;
}

if (require.main === module)
  buildAddon().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = {
  source,
  TARGETS,
  sha256,
  selectedTarget,
  validateManifest,
  validateInstalledAddon,
  buildAddon,
};
