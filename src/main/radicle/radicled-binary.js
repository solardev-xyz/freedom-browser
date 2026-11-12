/**
 * Where the freedom-radicled binary is (freedom-core design 0008, "Spawn and
 * lock"): `<resources>/freedom-radicled/` in a packaged build, which ships
 * it (check-binaries requires it). radicled-gate.js runs `hold-lock` from
 * it; the service's client will run `serve` from the same place.
 */

const path = require('path');
const { app } = require('electron');

/** `FREEDOM_RADICLED_PATH` or the downloaded binary in a development build;
 * packaged builds always use their resources. */
function getRadicledBinaryPath() {
  if (!app.isPackaged && process.env.FREEDOM_RADICLED_PATH) {
    return process.env.FREEDOM_RADICLED_PATH;
  }
  const name = process.platform === 'win32' ? 'freedom-radicled.exe' : 'freedom-radicled';
  if (!app.isPackaged) {
    const os =
      { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform] || process.platform;
    return path.join(
      __dirname,
      '..',
      '..',
      '..',
      'freedom-radicled-bin',
      `${os}-${process.arch}`,
      name
    );
  }
  return path.join(process.resourcesPath, 'freedom-radicled', name);
}

module.exports = { getRadicledBinaryPath };
