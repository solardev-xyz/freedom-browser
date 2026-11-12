/**
 * What runs the profile's Radicle node (freedom-core design 0008, step 6
 * on): `addon`, the libradicle add-on in main, or `service`, the
 * freedom-radicled service process. radicle-manager.js runs the node on it,
 * and radicle-embedded.js sends the reads to it, so both ask here.
 *
 * Packaged builds always run the add-on, whatever FREEDOM_RADICLE_BACKEND
 * says: the service is development only until the default switches.
 * Development builds run the add-on by default, and the service with
 * FREEDOM_RADICLE_BACKEND=service; any other value is warned of, once, and
 * runs the default.
 */

const { app } = require('electron');
const log = require('../logger');

let warnedBackend = null;

function radicleBackendKind({ packaged = Boolean(app?.isPackaged), env = process.env } = {}) {
  if (packaged) return 'addon';
  const kind = env.FREEDOM_RADICLE_BACKEND || 'addon';
  if (kind === 'addon' || kind === 'service') return kind;
  if (warnedBackend !== kind) {
    warnedBackend = kind;
    log.warn(`[Radicle] Unknown FREEDOM_RADICLE_BACKEND=${kind}; using the add-on`);
  }
  return 'addon';
}

module.exports = { radicleBackendKind };
