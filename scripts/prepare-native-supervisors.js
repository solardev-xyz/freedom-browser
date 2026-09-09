const workspace = require('./build-macos-workspace-supervisor');
const myotis = require('./build-myotis-supervisor');

function prepareDevelopment() {
  if (process.platform === 'darwin') workspace.buildMacosWorkspaceSupervisor();
  myotis.buildSupervisor();
}

async function beforePack(context) {
  await workspace.default(context);
  const { Arch } = require('electron-builder');
  const arch = typeof context.arch === 'string' ? context.arch : Arch[context.arch];
  const platform = { darwin: 'mac', linux: 'linux', win32: 'win' }[context.electronPlatformName];
  myotis.buildForTargets(platform, [arch]);
}

exports.default = beforePack;
exports.prepareDevelopment = prepareDevelopment;
if (require.main === module) prepareDevelopment();
