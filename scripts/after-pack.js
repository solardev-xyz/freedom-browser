// electron-builder's afterPack hook (package.json build.afterPack): runs on
// the unpacked app of every target, before it is signed and wrapped into the
// .dmg / installer / AppImage.
const { Arch } = require('builder-util');
const removeLocales = require('./remove-locales').default;
const { bundleVcRuntime, findRedistDir } = require('./win-vcruntime');

exports.default = async function afterPack(context) {
  await removeLocales(context);

  if (context.electronPlatformName === 'win32') {
    const arch = Arch[context.arch];
    const placed = bundleVcRuntime(context.appOutDir, {
      redistDir: findRedistDir(arch),
      log: (line) => console.log(`  • VC++ runtime beside ${line}`),
    });
    if (placed.length === 0) console.log('  • no bundled binary imports the VC++ runtime');
  }
};
