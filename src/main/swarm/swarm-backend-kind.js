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
 * **One backend per process** (design 0015's 2026-11-28 amendment, "SWM-6
 * to SWM-9's plan": the store move follows the switch):
 * `swarmBackendKind()` reads the switch once, the first time it is asked,
 * and gives that answer for the rest of the process, as the Ledger's switch
 * does (wallet/ledger/ledger-backend-kind.js). The hello's store list
 * depends on it (core-client.js `storeMovedFor`: `swarm_stores` is named
 * only on `core`), so the stores' writer and the executor's registry can't
 * change during a run, and both backends never run in one process.
 * `readSwarmBackendKind()` is the reading itself, for tests.
 *
 * The executor's handlers are registered whichever runs, so a stray ask of
 * the core's is answered `ended` (an `unknown_method` would end the
 * connection); its registry admits no parent unless this says `core`.
 */

const { app } = require('electron');
const log = require('../logger');

const KINDS = new Set(['js', 'core']);

let warnedBackend = null;
let chosen = null;

/** The switch as it reads now: `js` or `core`. */
function readSwarmBackendKind({ packaged = Boolean(app?.isPackaged), env = process.env } = {}) {
  if (packaged) return 'js';
  const kind = env.FREEDOM_SWARM_BACKEND || 'js';
  if (KINDS.has(kind)) return kind;
  if (warnedBackend !== kind) {
    warnedBackend = kind;
    log.warn(`[Swarm] Unknown FREEDOM_SWARM_BACKEND=${kind}; using the JS backend`);
  }
  return 'js';
}

/** The process's Swarm backend, read once and kept: `js` or `core`. */
function swarmBackendKind() {
  if (chosen === null) chosen = readSwarmBackendKind();
  return chosen;
}

module.exports = { swarmBackendKind, readSwarmBackendKind };
