/**
 * The Radicle home's gate, held from main (freedom-core design 0008, "Spawn
 * and lock" and "Rollback"): `freedom-radicled hold-lock --home …
 * --lock-dir …` takes the same OS lock the service takes on the home,
 * `<lock-dir>/radicle-<sha256(canonical home)>.lock`, writes `locked` once
 * it holds it, and holds it until its stdin closes. The kernel releases it
 * when the process ends, so a main that dies releases it too.
 *
 * - **Who takes it:** the service, for its whole life; the core, for an
 *   identity write on the home (so main never holds it while the core may
 *   need it); the add-on, from before its start until its shutdown proves
 *   it stopped, so it is a writer the gate excludes too; the alias rewrite,
 *   with the node stopped; and profile delete, on a catalog profile's
 *   `R/<slot>` home, while it removes it (design 0013, "Deletion", in main
 *   until the core deletes profiles).
 * - **Its answers** (fc-service's `hold_lock`) are the core's and
 *   freedom-ipfsd's: see hold-lock.js.
 * - **The binary** is the one the service runs (radicled-binary.js), in the
 *   shared client's scrubbed environment.
 * - **Without the binary:** a packaged build ships it (check-binaries
 *   requires it), so its absence there is a broken installation, and what
 *   needs the gate fails. A development build without `npm run
 *   radicled:download` goes on ungated, with a warning: there, only a
 *   service run from the same checkout could share the home, and that needs
 *   the binary.
 *
 * **The add-on on a switched home** (0008, "The switch" and Rollback): the
 * service's first start on a home removes `keys/radicle`, and the add-on's
 * start on a home without one generates a key of its own, a new identity
 * with a key at rest again. So the add-on is refused on a home the service
 * has switched (`switchedHomeRefusal`). Until the service is the default,
 * only where the service has run: the switch leaves `node/dirty` naming the
 * old identity, and every start's reconciliation leaves its quarantine
 * record, `node/reconcile.db`. A home with neither is one the add-on has
 * always run, and a profile without a vault, whose key libradicle
 * generates at its first start, still starts.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const defaultLog = require('../logger');
const { holdLock, withHold, LOCK_TIMEOUT_MS, RELEASE_KILL_MS } = require('../hold-lock');
const { getLockDir } = require('../service-locks');
const { getRadicledBinaryPath } = require('./radicled-binary');

const MESSAGES = {
  lock_held: 'The Radicle data is in use by another process. Close it and try again.',
  storage: "The Radicle home's lock can't be taken on this storage",
  usage: 'freedom-radicled refused the hold-lock command',
  missing: 'freedom-radicled is missing from this installation. Reinstall Freedom.',
  cancelled: "Taking the Radicle home's lock was cancelled",
  failed: "freedom-radicled couldn't hold the Radicle home's lock",
};

/** The gate couldn't be had: `code` is `lock_held` (75), `storage` (74),
 * `usage` (64), `missing`, `cancelled` (its signal) or `failed`. */
class RadicleGateError extends Error {
  constructor(code, message = MESSAGES[code]) {
    super(message);
    this.name = 'RadicleGateError';
    this.code = code;
  }
}

/** The freedom-radicled binary this build would run, if it is there. */
function isRadicledAvailable() {
  return fs.existsSync(getRadicledBinaryPath());
}

/**
 * Takes the gate of `home` with `hold-lock` (hold-lock.js's `holdLock`).
 * Resolves once the holder has written `locked`, to a hold whose `release()`
 * closes its stdin and resolves once it has exited (killed after 1 s);
 * rejects with a RadicleGateError. `onLost(exit)` runs if the holder ends
 * without being released. `signal` gives up a wait for `locked` (the holder
 * is killed): a stop never waits out another writer's hold.
 *
 * @param {object} options
 * @param {string} options.home - the Radicle home the service would use
 *   (`getRadicleDataDir()`)
 * @param {string} [options.lockDir] - the per-user lock directory
 * @param {Function} [options.onLost] - ({ code, signal }) once a held gate is
 *   lost
 * @param {AbortSignal} [options.signal] - cancels the wait for `locked`
 * @param {string} [options.command]
 * @param {Function} [options.spawn]
 * @param {object} [options.log]
 * @param {Function} [options.setTimer]
 * @param {Function} [options.clearTimer]
 */
function holdRadicleGate({
  home,
  lockDir = getLockDir(),
  command = getRadicledBinaryPath(),
  log = defaultLog,
  ...options
}) {
  return holdLock({
    ...options,
    command,
    dataDir: home,
    dataDirFlag: '--home',
    lockDir,
    log,
    gateError: (code) => new RadicleGateError(code),
    logPrefix: '[Radicle] freedom-radicled',
  });
}

/**
 * The gate of `home` for a caller that must hold it, under this build's
 * rule for a missing binary: a hold, or null in a development build
 * without freedom-radicled (logged); a RadicleGateError otherwise.
 */
async function takeRadicleGate(home, { onLost = null, log = defaultLog, ...options } = {}) {
  if (!isRadicledAvailable()) {
    if (app.isPackaged) throw new RadicleGateError('missing');
    log.warn(
      "[Radicle] freedom-radicled isn't downloaded (npm run radicled:download): going on without the Radicle home's gate"
    );
    return null;
  }
  return holdRadicleGate({ home, onLost, log, ...options });
}

/**
 * Runs `fn(gate)` holding the gate of `home` (`takeRadicleGate`'s rules), and
 * releases it once `fn` has settled. `gate.gated` says whether a gate is
 * held at all; `gate.held()` whether it still is: false once its holder has
 * ended unreleased, which a destructive `fn` checks, with nothing awaited,
 * right before each step that must not run ungated.
 */
async function withRadicleGate(home, fn, { onLost = null, ...options } = {}) {
  return withHold((lost) => takeRadicleGate(home, { ...options, onLost: lost }), fn, onLost);
}

const SWITCHED_HOME_MESSAGE =
  'This Radicle home has moved to the freedom-radicled service, which removed its key file. ' +
  "The add-on would start it as a new identity, so it doesn't start on it.";

// Whether anything is at `target`, as lstat sees it: a link counts, even a
// dangling one, as the service counts it (0008, "No fallback").
function isThere(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
}

/**
 * Why the add-on mustn't start on `home`, or null: the service has switched
 * it (see the module's doc). Read under the home's gate, so no service can
 * switch it meanwhile.
 */
function switchedHomeRefusal(home) {
  if (isThere(path.join(home, 'keys', 'radicle'))) return null;
  const serviceRan =
    isThere(path.join(home, 'node', 'dirty')) || isThere(path.join(home, 'node', 'reconcile.db'));
  return serviceRan ? SWITCHED_HOME_MESSAGE : null;
}

module.exports = {
  RadicleGateError,
  holdRadicleGate,
  isRadicledAvailable,
  takeRadicleGate,
  withRadicleGate,
  switchedHomeRefusal,
  SWITCHED_HOME_MESSAGE,
  LOCK_TIMEOUT_MS,
  RELEASE_KILL_MS,
};
