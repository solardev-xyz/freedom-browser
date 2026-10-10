const workspace = require('./build-macos-workspace-supervisor');
const linuxWorkspace = require('./build-linux-workspace-supervisor');
const myotis = require('./build-myotis-supervisor');
const windowsWorkspace = require('./build-windows-workspace');

function prepareDevelopment(platform = process.platform) {
  if (platform === 'linux') { linuxWorkspace.buildLinuxWorkspaceSupervisor(process.arch, { development: true }); return; }
  if (platform !== 'darwin') return;
  workspace.buildMacosWorkspaceSupervisor();
  myotis.buildSupervisor();
}

async function beforePack(context) {
  await workspace.default(context);
  await linuxWorkspace.default(context);
  const { Arch } = require('electron-builder');
  const arch = typeof context.arch === 'string' ? context.arch : Arch[context.arch];
  if (context.electronPlatformName === 'win32') await windowsWorkspace.buildWindowsWorkspace(arch);
  const platform = { darwin: 'mac', linux: 'linux', win32: 'win' }[context.electronPlatformName];
  myotis.buildForTargets(platform, [arch]);
}

exports.default = beforePack;
exports.prepareDevelopment = prepareDevelopment;
if (require.main === module) prepareDevelopment();
