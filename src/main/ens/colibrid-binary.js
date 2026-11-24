/**
 * Where the freedom-colibrid binary is (freedom-core design 0014, Spawn):
 * `<resources>/freedom-colibrid/` in a packaged build, which ships it
 * (check-binaries requires it). Nothing runs it yet; the service's client
 * will spawn it from here.
 */

const path = require('path');
const { app } = require('electron');

/** `FREEDOM_COLIBRID_PATH` or the downloaded binary in a development build;
 * packaged builds always use their resources. */
function getColibridBinaryPath() {
  if (!app.isPackaged && process.env.FREEDOM_COLIBRID_PATH) {
    return process.env.FREEDOM_COLIBRID_PATH;
  }
  const name = process.platform === 'win32' ? 'freedom-colibrid.exe' : 'freedom-colibrid';
  if (!app.isPackaged) {
    const os =
      { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform] || process.platform;
    return path.join(
      __dirname,
      '..',
      '..',
      '..',
      'freedom-colibrid-bin',
      `${os}-${process.arch}`,
      name
    );
  }
  return path.join(process.resourcesPath, 'freedom-colibrid', name);
}

module.exports = { getColibridBinaryPath };
