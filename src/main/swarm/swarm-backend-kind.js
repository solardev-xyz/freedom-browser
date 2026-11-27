/**
 * What serves Swarm (freedom-core design 0015, SWM-5's calls: the switch):
 * `js`, today's bee-js modules in main, or `core`, freedom-cored's swarm
 * thread, whose node calls main runs through its executor
 * (`core/swarm-shell.js`).
 *
 * Packaged builds always run `js`, whatever FREEDOM_SWARM_BACKEND says,
 * until SWM-9 makes the core the default: the core's backend is selectable
 * in development builds only. Development builds run `js` by default, and
 * the core with FREEDOM_SWARM_BACKEND=core; any other value is warned of,
 * once, and runs the default.
 *
 * The executor's handlers are registered whichever runs, so a stray ask of
 * the core's is answered `ended` (an `unknown_method` would end the
 * connection); its registry admits no parent unless this says `core`.
 */

const { app } = require('electron');
const log = require('../logger');

const KINDS = new Set(['js', 'core']);

let warnedBackend = null;

function swarmBackendKind({ packaged = Boolean(app?.isPackaged), env = process.env } = {}) {
  if (packaged) return 'js';
  const kind = env.FREEDOM_SWARM_BACKEND || 'js';
  if (KINDS.has(kind)) return kind;
  if (warnedBackend !== kind) {
    warnedBackend = kind;
    log.warn(`[Swarm] Unknown FREEDOM_SWARM_BACKEND=${kind}; using the JS backend`);
  }
  return 'js';
}

module.exports = { swarmBackendKind };
