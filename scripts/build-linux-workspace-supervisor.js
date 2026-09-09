'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SOURCE_PATH, SUPERVISOR_NAME, digest, validElf } =
  require('../src/main/agent/workspace-execution/linux-supervisor-runtime');

function buildLinuxWorkspaceSupervisor(architecture = process.arch, { development = false } = {}) {
  if (process.platform !== 'linux') throw new Error('Linux workspace owner requires a Linux build host');
  if (!['x64', 'arm64', 'armv7l', 'ia32', 'universal'].includes(architecture)) throw new Error('Unknown target architecture');
  if (architecture !== 'x64') {
    // Keep the package resource path present, but never ship a guessed helper.
    fs.mkdirSync(path.resolve(__dirname, '../out/linux-workspace-owner', architecture), { recursive: true });
    return;
  }
  const compiler = '/usr/bin/gcc';
  const sourceSha256 = digest(fs.readFileSync(SOURCE_PATH));
  const directory = path.resolve(__dirname, '../out/linux-workspace-owner/x64');
  const binaryPath = path.join(directory, SUPERVISOR_NAME);
  const manifestPath = path.join(directory, 'manifest.json');
  try {
    const binary = fs.readFileSync(binaryPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.protocol === 1 && manifest.architecture === architecture && manifest.minimumKernel === '5.9' &&
        manifest.sourceSha256 === sourceSha256 && manifest.binarySha256 === digest(binary) && validElf(binary)) return;
  } catch { /* Build only from installed tools and this checkout's source. */ }
  if (!fs.existsSync(compiler)) {
    if (development) {
      console.warn('Linux workspace owner unavailable: installed GCC missing; application startup continues');
      return;
    }
    throw new Error('Installed GCC required; no compiler will be downloaded');
  }
  fs.mkdirSync(directory, { recursive: true });
  const pending = path.join(directory, `${SUPERVISOR_NAME}.building-${process.pid}`);
  execFileSync(compiler, ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
    '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', '-Wl,-z,relro,-z,now',
    `-DFREEDOM_SUPERVISOR_BUILD_ID="${sourceSha256}"`, SOURCE_PATH, '-o', pending],
  { stdio: 'inherit', timeout: 60000, env: { PATH: '/usr/bin:/bin', TMPDIR: '/tmp' } });
  const binary = fs.readFileSync(pending);
  if (!validElf(binary)) throw new Error('Invalid Linux x64 owner executable');
  if (fs.existsSync(binaryPath)) fs.renameSync(binaryPath, `${binaryPath}.previous-${Date.now()}`);
  if (fs.existsSync(manifestPath)) fs.renameSync(manifestPath, `${manifestPath}.previous-${Date.now()}`);
  fs.chmodSync(pending, 0o755); fs.renameSync(pending, binaryPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify({ protocol: 1, architecture, minimumKernel: '5.9',
    sourceSha256, binarySha256: digest(binary) }, null, 2)}\n`, { mode: 0o644 });
}
exports.buildLinuxWorkspaceSupervisor = buildLinuxWorkspaceSupervisor;
exports.default = (context) => {
  if (context.electronPlatformName !== 'linux') return;
  const { Arch } = require('electron-builder');
  buildLinuxWorkspaceSupervisor(typeof context.arch === 'string' ? context.arch : Arch[context.arch]);
};
if (require.main === module) buildLinuxWorkspaceSupervisor(process.argv[2] || process.arch);
