/**
 * Where the freedom-cored binary is: core-process.js runs `serve` from it,
 * and core-gate.js `hold-lock`.
 */

const path = require('path');
const { app } = require('electron');

/** Dev overrides or downloaded binaries; packaged builds always use resources. */
function getCoredBinaryPath() {
  if (!app.isPackaged && process.env.FREEDOM_CORED_PATH) {
    return process.env.FREEDOM_CORED_PATH;
  }
  const name = process.platform === 'win32' ? 'freedom-cored.exe' : 'freedom-cored';
  if (!app.isPackaged) {
    const os =
      { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform] || process.platform;
    return path.join(
      __dirname,
      '..',
      '..',
      '..',
      'freedom-cored-bin',
      `${os}-${process.arch}`,
      name
    );
  }
  return path.join(process.resourcesPath, 'freedom-cored', name);
}

module.exports = { getCoredBinaryPath };
