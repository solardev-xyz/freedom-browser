const fs = require('fs');
const path = require('path');

const KEEP_LOCALES = ['en.lproj', 'en_US.lproj'];

exports.default = async function (context) {
  const appDir = context.appOutDir;

  // Find all Resources directories that might contain locale folders
  const resourcesPaths = [];

  if (process.platform === 'darwin') {
    // macOS: Check Electron Framework and other frameworks
    const frameworksPath = path.join(
      appDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Frameworks'
    );

    if (fs.existsSync(frameworksPath)) {
      const frameworks = fs.readdirSync(frameworksPath);
      for (const framework of frameworks) {
        const resourcesPath = path.join(frameworksPath, framework, 'Versions', 'A', 'Resources');
        if (fs.existsSync(resourcesPath)) {
          resourcesPaths.push(resourcesPath);
        }
        // Also check direct Resources folder
        const directResources = path.join(frameworksPath, framework, 'Resources');
        if (fs.existsSync(directResources)) {
          resourcesPaths.push(directResources);
        }
      }
    }
  }

  let removedCount = 0;

  for (const resourcesPath of resourcesPaths) {
    const items = fs.readdirSync(resourcesPath);

    for (const item of items) {
      if (item.endsWith('.lproj') && !KEEP_LOCALES.includes(item)) {
        const localePath = path.join(resourcesPath, item);
        fs.rmSync(localePath, { recursive: true, force: true });
        removedCount++;
      }
    }
  }

  if (removedCount > 0) {
    console.log(`  • Removed ${removedCount} unwanted locale directories`);
  }
};
