const path = require('path');

// Preserve electron-builder's signer (including retries) and its per-file
// options. Native helpers run no JIT and need no Electron entitlements.
module.exports = async function signMyotisHelper(options) {
  const { sign } = require('app-builder-lib/out/codeSign/macCodeSign');
  const helperPaths = new Set([
    path.resolve(options.app, 'Contents/Resources/myotis-node/myotis-supervisor'),
    path.resolve(options.app, 'Contents/Resources/freedom-cored/freedom-cored'),
  ]);
  const entitlements = path.resolve(__dirname, '../config/entitlements.myotis-supervisor.plist');
  return sign({
    ...options,
    optionsForFile(filePath) {
      const original = options.optionsForFile(filePath);
      return helperPaths.has(path.resolve(filePath))
        ? { ...original, entitlements, hardenedRuntime: true }
        : original;
    },
  });
};
