'use strict';

const path = require('path');

const RUNTIME_PROTOCOL_VERSION = 1;
const RUNTIME_DIR_NAME = 'automation-runtime';
const DISCOVERY_FILE_NAME = 'runtime.json';
const TOKEN_FILE_NAME = 'token';

function getRuntimePaths(profile) {
  if (!profile?.userDataDir || !profile?.id) {
    throw new TypeError('Runtime paths require a profile with id and userDataDir');
  }
  const runtimeDir = path.join(profile.userDataDir, RUNTIME_DIR_NAME);
  return {
    runtimeDir,
    discoveryPath: path.join(runtimeDir, DISCOVERY_FILE_NAME),
    tokenPath: path.join(runtimeDir, TOKEN_FILE_NAME),
  };
}

module.exports = {
  DISCOVERY_FILE_NAME,
  RUNTIME_DIR_NAME,
  RUNTIME_PROTOCOL_VERSION,
  TOKEN_FILE_NAME,
  getRuntimePaths,
};
