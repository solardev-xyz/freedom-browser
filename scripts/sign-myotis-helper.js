const path = require('path');

// Preserve electron-builder's signer (including retries) and its per-file
// options. These bundled native helpers run no JIT and need none of Electron's
// entitlements (camera, microphone, network, JIT), which `entitlementsInherit`
// would otherwise give every nested executable.
const RESTRICTED_HELPERS = {
  'Contents/Resources/myotis-node/myotis-supervisor': '../config/entitlements.myotis-supervisor.plist',
  'Contents/Resources/dictation-runtime/whisper-cli': '../config/entitlements.dictation-runtime.plist',
};

module.exports = async function signMyotisHelper(options) {
  const { sign } = require('app-builder-lib/out/codeSign/macCodeSign');
  const restricted = new Map(Object.entries(RESTRICTED_HELPERS).map(([helper, entitlements]) =>
    [path.resolve(options.app, helper), path.resolve(__dirname, entitlements)]));
  return sign({
    ...options,
    optionsForFile(filePath) {
      const original = options.optionsForFile(filePath);
      const entitlements = restricted.get(path.resolve(filePath));
      return entitlements ? { ...original, entitlements, hardenedRuntime: true } : original;
    },
  });
};
