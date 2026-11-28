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
 *
 * **The JS backend's own paths refuse to run on `core`** (SWM-7's flip, the
 * SWM-6 to SWM-9 plan's PR 7.4 and section 5): there window.swarm goes
 * through the core, the hello names `swarm_stores`, and the core mines GSOC
 * keys, so the JS provider (swarm-provider-ipc.js `executeSwarmMethod`)
 * and main's GSOC miner (gsoc-miner.js) assert the backend
 * (`assertJsBackend`) before anything of theirs runs. A call that reaches
 * one is main's bug, answered as an internal error, never run as a
 * fallback. Main's writers of the three Swarm stores refuse the same way,
 * by the hello's list (core-client.js `swarmStoresNamed()`).
 */

const { app } = require('electron');

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
    // Loaded only to warn: the modules that assert the backend
    // (`assertJsBackend`) load this one with them.
    require('../logger').warn(`[Swarm] Unknown FREEDOM_SWARM_BACKEND=${kind}; using the JS backend`);
  }
  return 'js';
}

/** The process's Swarm backend, read once and kept: `js` or `core`. */
function swarmBackendKind() {
  if (chosen === null) chosen = readSwarmBackendKind();
  return chosen;
}

/**
 * Throws, before anything of `what` runs, in a process whose Swarm backend
 * is the core's: `what` is one of the JS backend's own paths, which can't
 * run there (PR 7.4). The error is a `SwarmBackendError`, code
 * `swarm_backend_core`, whose message names `what`.
 *
 * @param {string} what - the path, as its message names it
 */
function assertJsBackend(what) {
  if (swarmBackendKind() !== 'core') return;
  const err = new Error(`${what} can't run on the core's Swarm backend`);
  err.name = 'SwarmBackendError';
  err.code = 'swarm_backend_core';
  throw err;
}

module.exports = { swarmBackendKind, readSwarmBackendKind, assertJsBackend };
