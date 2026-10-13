const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { RELEASE_TAG, PINNED_SOURCE_COMMIT } = require('../src/shared/ton-version');

const OUTPUT_DIR = path.join(__dirname, '..', 'ton-bin');
const RELEASE_REPO = 'xssnick/Tonutils-Proxy';
const BINARY_NAME = 'tonutils-freedom-cli';
const TARGETS = [
  { os: 'mac', arch: 'arm64' },
  { os: 'mac', arch: 'x64' },
  { os: 'linux', arch: 'x64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'win', arch: 'x64', exe: true },
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
  if (!target) throw new Error(`No TON proxy build target for ${selected.os}-${selected.arch}`);
  return [target];
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
  const run = options.run || execFileSync;
  const sourceDir =
    options.sourceDir || fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ton-source-'));
  const outputDir = options.outputDir || OUTPUT_DIR;
  const targetDir = path.join(outputDir, `${target.os}-${target.arch}`);
  fs.mkdirSync(targetDir, { recursive: true });
  if (!options.sourceDir) {
    run('git', ['init', sourceDir], { stdio: 'pipe' });
    run(
      'git',
      [
        '-C',
        sourceDir,
        'fetch',
        '--depth=1',
        `https://github.com/${RELEASE_REPO}.git`,
        PINNED_SOURCE_COMMIT,
      ],
      { stdio: 'pipe' }
    );
    run('git', ['-C', sourceDir, 'checkout', '--detach', PINNED_SOURCE_COMMIT], { stdio: 'pipe' });
  }
  const commit = String(
    run('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  ).trim();
  if (commit !== PINNED_SOURCE_COMMIT) throw new Error('Unexpected TON proxy source commit');
  const dirty = String(
    run('git', ['-C', sourceDir, 'status', '--porcelain'], { encoding: 'utf8' })
  ).trim();
  if (dirty) throw new Error('TON proxy source must be unmodified');
  const destFile = path.join(targetDir, target.exe ? `${BINARY_NAME}.exe` : BINARY_NAME);
  const tempFile = `${destFile}.build`;
  run(
    'go',
    [
      'build',
      '-mod=readonly',
      '-trimpath',
      '-buildvcs=false',
      '-ldflags',
      `-s -w -X main.GitCommit=${PINNED_SOURCE_COMMIT}`,
      '-o',
      tempFile,
      './cmd/proxy-cli',
    ],
    {
      cwd: sourceDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        CGO_ENABLED: '0',
        GOOS: { mac: 'darwin', win: 'windows', linux: 'linux' }[target.os],
        GOARCH: target.arch === 'x64' ? 'amd64' : 'arm64',
      },
    }
  );
  if (!target.exe) fs.chmodSync(tempFile, 0o755);
  fs.renameSync(tempFile, destFile);
  return destFile;
}

async function main() {
  try {
    console.log(
      `Building ${BINARY_NAME} ${RELEASE_TAG} (source ${PINNED_SOURCE_COMMIT.slice(0, 12)})...`
    );

    const targets = selectedTargets(process.argv.slice(2));
    for (const target of targets) {
      await installTarget(target);
    }

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

    console.log('All builds complete.');
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
  checkBinary,
  installTarget,
  BINARY_NAME,
  PINNED_SOURCE_COMMIT,
  RELEASE_REPO,
  RELEASE_TAG,
  runtimeTarget,
  selectedTargets,
  TARGETS,
};
