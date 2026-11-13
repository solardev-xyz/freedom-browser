/**
 * What runs the profile's Radicle node (freedom-core design 0008, step 7):
 * `service`, the freedom-radicled service process, or `addon`, the
 * libradicle add-on in main. radicle-manager.js runs the node on it, and
 * radicle-embedded.js sends the reads to it, so both ask here.
 *
 * Packaged builds always run the service, whatever FREEDOM_RADICLE_BACKEND
 * says: the add-on is selectable in development builds only (0008,
 * Rollback). Development builds run the service by default, and the add-on
 * with FREEDOM_RADICLE_BACKEND=addon, the rollback, which radicle-manager.js
 * runs only under freedom-radicled's hold-lock and only on a home that still
 * has `keys/radicle`; any other value is warned of, once, and runs the
 * default.
 */

const { app } = require('electron');
const log = require('../logger');

let warnedBackend = null;

function radicleBackendKind({ packaged = Boolean(app?.isPackaged), env = process.env } = {}) {
  if (packaged) return 'service';
  const kind = env.FREEDOM_RADICLE_BACKEND || 'service';
  if (kind === 'service' || kind === 'addon') return kind;
  if (warnedBackend !== kind) {
    warnedBackend = kind;
    log.warn(`[Radicle] Unknown FREEDOM_RADICLE_BACKEND=${kind}; using freedom-radicled`);
  }
  return 'service';
}

module.exports = { radicleBackendKind };
