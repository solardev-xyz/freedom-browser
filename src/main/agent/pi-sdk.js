'use strict';

const PI_SDK_PACKAGE = '@earendil-works/pi-coding-agent';
const REQUIRED_EXPORTS = Object.freeze([
  'createAgentSession',
  'createExtensionRuntime',
  'defineTool',
  'ModelRuntime',
  'SessionManager',
  'SettingsManager',
]);

class PiSdkLoadError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'PiSdkLoadError';
    this.code = 'PI_SDK_UNAVAILABLE';
  }
}

function validatePiSdk(moduleNamespace) {
  const missing = REQUIRED_EXPORTS.filter((name) => typeof moduleNamespace?.[name] !== 'function');
  if (missing.length > 0) {
    throw new PiSdkLoadError(`Pi SDK is missing required exports: ${missing.join(', ')}`);
  }
  return moduleNamespace;
}

function createPiSdkLoader(options = {}) {
  const importModule = options.importModule || (() => import(PI_SDK_PACKAGE));
  let pendingLoad = null;

  return function loadPiSdk() {
    if (!pendingLoad) {
      pendingLoad = Promise.resolve()
        .then(() => importModule())
        .then(validatePiSdk)
        .catch((error) => {
          pendingLoad = null;
          if (error instanceof PiSdkLoadError) throw error;
          throw new PiSdkLoadError('Unable to load the embedded Pi SDK', { cause: error });
        });
    }
    return pendingLoad;
  };
}

const loadPiSdk = createPiSdkLoader();

module.exports = {
  PI_SDK_PACKAGE,
  PiSdkLoadError,
  createPiSdkLoader,
  loadPiSdk,
  validatePiSdk,
};
