const path = require('path');

// Preserve electron-builder's signer (including retries) and its per-file
// options. The native supervisor runs no JIT and needs no Electron entitlements.
module.exports = async function signMyotisHelper(options) {
  const { sign } = require('app-builder-lib/out/codeSign/macCodeSign');
  const helperPath = path.resolve(options.app, 'Contents/Resources/myotis-node/myotis-supervisor');
  const entitlements = path.resolve(__dirname, '../config/entitlements.myotis-supervisor.plist');
  return sign({
    ...options,
    optionsForFile(filePath) {
      const original = options.optionsForFile(filePath);
      return path.resolve(filePath) === helperPath
        ? { ...original, entitlements, hardenedRuntime: true }
        : original;
    },
  });
};
