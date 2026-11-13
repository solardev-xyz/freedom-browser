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
 *   with the node stopped; an identity re-key's wipe of the home's state,
 *   let go before the core's write takes the gate; a legacy home's
 *   carry-over into the short home (profile-paths.js); the removal of a
 *   control socket the add-on left, before the service's first spawn on the
 *   home (`removeStaleControlSocket`); and profile delete, on a catalog
 *   profile's `R/<slot>` home, while it removes it (design 0013,
 *   "Deletion", in main until the core deletes profiles).
 * - **Its answers** (fc-service's `hold_lock`) are the core's and
 *   freedom-ipfsd's: see hold-lock.js.
 * - **The binary** is the one the service runs (radicled-binary.js), in the
 *   shared client's scrubbed environment.
 * - **Without the binary:** a packaged build ships it (check-binaries
 *   requires it), so its absence there is a broken installation, and what
 *   needs the gate fails. In a development build without `npm run
 *   radicled:download`, the add-on, the rollback, doesn't start: it runs
 *   only under the gate (0008, Rollback; `takeRadicleGate`'s `required`).
 *   The other callers go on ungated there, with a warning: only a service
 *   run from the same checkout could share the home, and that needs the
 *   binary.
 *
 * **The add-on on a home without its key file** (0008, "The switch" and
 * Rollback): the service's first start on a home removes `keys/radicle`,
 * and the add-on's start on a home without one generates a key of its own,
 * a new identity with a key at rest again. So the add-on, the development
 * builds' rollback since the service became the default (0008, step 7),
 * starts only on a home that still has `keys/radicle` (`addonHomeRefusal`):
 * one the service never switched, whose key the core wrote for a vault, or
 * libradicle generated before the switch.
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
  // A development build's add-on, which runs only under the gate.
  addonMissing:
    "The Radicle add-on runs only under freedom-radicled's hold-lock: run npm run radicled:download",
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
 * without freedom-radicled (logged); a RadicleGateError otherwise. With
 * `required` (the add-on's start, 0008 Rollback), a development build
 * without the binary rejects too, with `missing` and the download to run.
 */
async function takeRadicleGate(
  home,
  { onLost = null, log = defaultLog, required = false, ...options } = {}
) {
  if (!isRadicledAvailable()) {
    if (app.isPackaged) throw new RadicleGateError('missing');
    if (required) throw new RadicleGateError('missing', MESSAGES.addonMissing);
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

const ADDON_HOME_MESSAGE =
  'The Radicle add-on starts only on a home that still has its key file (keys/radicle): ' +
  'without one it would start as a new identity. freedom-radicled removes the key file at its ' +
  'first start on a home.';

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
 * Why the add-on mustn't start on `home`, or null: it has no `keys/radicle`
 * (see the module's doc). Read under the home's gate, so no service can
 * switch it meanwhile.
 */
function addonHomeRefusal(home) {
  return isThere(path.join(home, 'keys', 'radicle')) ? null : ADDON_HOME_MESSAGE;
}

// Whether `target` is a socket, as lstat sees it: a link to one isn't.
function isSocketAt(target) {
  try {
    return fs.lstatSync(target).isSocket();
  } catch {
    return false;
  }
}

// Whether `dir` is a directory, not a link to one.
function isRealDir(dir) {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Removes the control socket heartwood in the add-on left in `home` if it
 * ended without unbinding it (a crash, a kill): `<home>/node/control.sock`,
 * exactly that path, only when it is a socket, and only under the home's
 * gate, before the service's first spawn on the home. The service binds no
 * control socket (0008, deviation `control-socket`), and main's check of its
 * grant refuses a home that holds a special file (design 0010, step 7), so a
 * home the add-on crashed on would never start on the service. Under the
 * gate no other gated writer, the add-on among them, can be using it.
 *
 * Nothing is taken or removed when there is no socket there. Nothing is
 * removed without the gate: in a development build without the binary
 * (ungated), when another writer holds the gate, when the gate is lost
 * before the removal, or when `node` is a link. Resolves whether it removed
 * the socket; never rejects.
 *
 * @param {string} home - the Radicle home (`getRadicleDataDir()`)
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - gives up the gate's wait (a stop)
 * @param {Function} [options.withGate] - `withRadicleGate` (injectable)
 * @param {object} [options.log]
 */
async function removeStaleControlSocket(
  home,
  { signal = null, withGate = withRadicleGate, log = defaultLog } = {}
) {
  const nodeDir = path.join(home, 'node');
  const socket = path.join(nodeDir, 'control.sock');
  if (!isRealDir(nodeDir) || !isSocketAt(socket)) return false;
  try {
    return await withGate(
      home,
      (gate) => {
        if (!gate.gated) {
          log.warn(
            "[Radicle] A control socket is left in the Radicle home; without the home's gate it stays"
          );
          return false;
        }
        // Again under the gate, with nothing awaited before the removal.
        if (!gate.held() || !isRealDir(nodeDir) || !isSocketAt(socket)) return false;
        fs.unlinkSync(socket);
        log.info('[Radicle] Removed the control socket the add-on left in the Radicle home');
        return true;
      },
      { signal, log }
    );
  } catch (err) {
    log.warn("[Radicle] The add-on's control socket wasn't removed from the Radicle home", {
      code: err?.code || 'error',
    });
    return false;
  }
}

module.exports = {
  RadicleGateError,
  holdRadicleGate,
  isRadicledAvailable,
  takeRadicleGate,
  withRadicleGate,
  addonHomeRefusal,
  removeStaleControlSocket,
  ADDON_HOME_MESSAGE,
  LOCK_TIMEOUT_MS,
  RELEASE_KILL_MS,
};
