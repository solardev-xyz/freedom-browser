/**
 * What runs Colibri's verifier (freedom-core design 0014, COL-5): `wasm`,
 * the package's WASM verifier in a worker thread per chain
 * (colibri-worker-host.js), or `service`, the freedom-colibrid process.
 * colibri-resolver.js asks here which one to use, and the checkpoint path
 * will (COL-5 PR 9).
 *
 * Packaged builds always run WASM, whatever FREEDOM_COLIBRI_BACKEND says: the
 * service is a development switch until COL-6 makes it the default (0014,
 * Migration). Development builds run WASM by default, and the service with
 * FREEDOM_COLIBRI_BACKEND=service; any other value is warned of, once, and
 * runs the default.
 */

const { app } = require('electron');
const log = require('../logger');

let warnedBackend = null;

function colibriBackendKind({ packaged = Boolean(app?.isPackaged), env = process.env } = {}) {
  if (packaged) return 'wasm';
  const kind = env.FREEDOM_COLIBRI_BACKEND || 'wasm';
  if (kind === 'wasm' || kind === 'service') return kind;
  if (warnedBackend !== kind) {
    warnedBackend = kind;
    log.warn(`[colibri] Unknown FREEDOM_COLIBRI_BACKEND=${kind}; using the WASM verifier`);
  }
  return 'wasm';
}

module.exports = { colibriBackendKind };
