'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { SOURCE_PATH, SUPERVISOR_NAME, MINIMUM_MACOS, validMachExecutable } =
  require('../src/main/agent/workspace-execution/macos-supervisor-runtime');

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function installedToolchain() {
  const candidates = [
    { clang: '/Library/Developer/CommandLineTools/usr/bin/clang',
      sdk: '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk' },
    { clang: '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang',
      sdk: '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk' },
  ];
  const found = candidates.find(({ clang, sdk }) => fs.existsSync(clang) && fs.existsSync(sdk));
  if (!found) throw new Error('An installed Apple C toolchain is required to build the workspace supervisor; no installer will be launched');
  return found;
}

function buildMacosWorkspaceSupervisor(architecture = process.arch) {
  if (process.platform !== 'darwin') throw new Error('Build the macOS workspace supervisor on macOS');
  if (!['arm64', 'x64'].includes(architecture)) throw new Error('Unsupported workspace supervisor architecture');
  const source = fs.readFileSync(SOURCE_PATH);
  const sourceSha256 = hash(source);
  const directory = path.resolve(__dirname, '../out/macos-supervisor', architecture);
  const binaryPath = path.join(directory, SUPERVISOR_NAME);
  const manifestPath = path.join(directory, 'manifest.json');
  try {
    const binary = fs.readFileSync(binaryPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.sourceSha256 === sourceSha256 && manifest.binarySha256 === hash(binary) &&
        manifest.architecture === architecture && manifest.protocol === 1 &&
        manifest.minimumMacos === MINIMUM_MACOS && validMachExecutable(binary, architecture)) return;
  } catch { /* Missing/stale artifacts are rebuilt from repository-owned source. */ }
  const { clang, sdk } = installedToolchain();
  fs.mkdirSync(directory, { recursive: true });
  const pending = path.join(directory, `${SUPERVISOR_NAME}.building-${process.pid}`);
  execFileSync(clang, [
    '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-fstack-protector-strong',
    '-D_FORTIFY_SOURCE=2', `-DFREEDOM_SUPERVISOR_BUILD_ID="${sourceSha256}"`,
    '-arch', architecture === 'x64' ? 'x86_64' : 'arm64',
    `-mmacosx-version-min=${MINIMUM_MACOS}`, '-isysroot', sdk,
    SOURCE_PATH, '-o', pending,
  ], { stdio: 'inherit', timeout: 60000,
    env: { PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR || '/tmp' } });
  const binary = fs.readFileSync(pending);
  if (!validMachExecutable(binary, architecture)) throw new Error('Compiled supervisor has an unexpected architecture or minimum OS');
  fs.chmodSync(pending, 0o755);
  fs.renameSync(pending, binaryPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    protocol: 1, architecture, minimumMacos: MINIMUM_MACOS,
    sourceSha256, binarySha256: hash(binary),
  }, null, 2)}\n`);
  console.log(`Built native workspace supervisor for macOS ${architecture}`);
}

exports.buildMacosWorkspaceSupervisor = buildMacosWorkspaceSupervisor;
exports.default = function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { Arch } = require('electron-builder');
  buildMacosWorkspaceSupervisor(typeof context.arch === 'string' ? context.arch : Arch[context.arch]);
};

if (require.main === module && process.platform === 'darwin') {
  buildMacosWorkspaceSupervisor(process.argv[2] || process.arch);
}
