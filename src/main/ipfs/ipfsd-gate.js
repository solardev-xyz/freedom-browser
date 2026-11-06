/**
 * The IPFS data directory's gate, held from main (freedom-core design 0007,
 * "Lifetime lock" and "Rollback"): `freedom-ipfsd hold-lock --data-dir …
 * --lock-dir …` takes the same OS lock the service takes, writes `locked`
 * once it holds it, and holds it until its stdin closes. The kernel releases
 * it when the process ends, so a main that dies releases it too.
 *
 * - **Who takes it:** the service, for its whole life; every operation that
 *   removes the directory, while it does (profile delete); and the add-on,
 *   from before it opens its store until after it has closed it, so it is a
 *   writer the gate excludes too.
 * - **Its answers** (fc-service's `hold_lock`) are the core's: see
 *   hold-lock.js.
 * - **The binary and environment** are the service's (`ipfsd-client.js`):
 *   the same resolution, and the shared client's scrubbed environment.
 * - **Without the binary:** a packaged build ships it (check-binaries
 *   requires it), so its absence there is a broken installation, and what
 *   needs the gate fails. A development build without `npm run
 *   ipfsd:download` goes on ungated, with a warning: there, only a service
 *   run from the same checkout could share the directory, and that needs
 *   the binary.
 */

const fs = require('fs');
const { app } = require('electron');
const defaultLog = require('../logger');
const { holdLock, withHold, LOCK_TIMEOUT_MS, RELEASE_KILL_MS } = require('../hold-lock');
const { getLockDir } = require('../service-locks');
const { getIpfsdBinaryPath } = require('./ipfsd-client');

const MESSAGES = {
  lock_held: 'The IPFS data is in use by another process. Close it and try again.',
  storage: "The IPFS data directory's lock can't be taken on this storage",
  usage: 'freedom-ipfsd refused the hold-lock command',
  missing: 'freedom-ipfsd is missing from this installation. Reinstall Freedom.',
  cancelled: "Taking the IPFS data directory's lock was cancelled",
  failed: "freedom-ipfsd couldn't hold the IPFS data directory's lock",
};

/** The gate couldn't be had: `code` is `lock_held` (75), `storage` (74),
 * `usage` (64), `missing`, `cancelled` (its signal) or `failed`. */
class IpfsGateError extends Error {
  constructor(code, message = MESSAGES[code]) {
    super(message);
    this.name = 'IpfsGateError';
    this.code = code;
  }
}

/** The freedom-ipfsd binary this build would run, if it is there. */
function isIpfsdAvailable() {
  return fs.existsSync(getIpfsdBinaryPath());
}

/**
 * Takes the gate of `dataDir` with `hold-lock` (hold-lock.js's `holdLock`).
 * Resolves once the holder has written `locked`, to a hold whose `release()`
 * closes its stdin and resolves once it has exited (killed after 1 s);
 * rejects with an IpfsGateError. `onLost(exit)` runs if the holder ends
 * without being released. `signal` gives up a wait for `locked` (the holder
 * is killed): a stop never waits out another writer's hold.
 *
 * @param {object} options
 * @param {string} options.dataDir - the directory the service would use
 *   (`<ipfs-data>/freedom-ipfs`)
 * @param {string} [options.lockDir] - the core's lock directory
 * @param {Function} [options.onLost] - ({ code, signal }) once a held gate is
 *   lost
 * @param {AbortSignal} [options.signal] - cancels the wait for `locked`
 * @param {string} [options.command]
 * @param {Function} [options.spawn]
 * @param {object} [options.log]
 * @param {Function} [options.setTimer]
 * @param {Function} [options.clearTimer]
 */
function holdIpfsGate({
  dataDir,
  lockDir = getLockDir(),
  command = getIpfsdBinaryPath(),
  log = defaultLog,
  ...options
}) {
  return holdLock({
    ...options,
    command,
    dataDir,
    lockDir,
    log,
    gateError: (code) => new IpfsGateError(code),
    logPrefix: '[IPFS] freedom-ipfsd',
  });
}

/**
 * The gate of `dataDir` for a caller that must hold it, under this build's
 * rule for a missing binary: a hold, or null in a development build
 * without freedom-ipfsd (logged); an IpfsGateError otherwise.
 */
async function takeIpfsGate(dataDir, { onLost = null, log = defaultLog, ...options } = {}) {
  if (!isIpfsdAvailable()) {
    if (app.isPackaged) throw new IpfsGateError('missing');
    log.warn(
      "[IPFS] freedom-ipfsd isn't downloaded (npm run ipfsd:download): going on without the IPFS data directory's gate"
    );
    return null;
  }
  return holdIpfsGate({ dataDir, onLost, log, ...options });
}

/**
 * Runs `fn(gate)` holding the gate of `dataDir` (`takeIpfsGate`'s rules), and
 * releases it once `fn` has settled. `gate.gated` says whether a gate is
 * held at all; `gate.held()` whether it still is: false once its holder has
 * ended unreleased, which a destructive `fn` checks, with nothing awaited,
 * right before each step that must not run ungated.
 */
async function withIpfsGate(dataDir, fn, { onLost = null, ...options } = {}) {
  return withHold((lost) => takeIpfsGate(dataDir, { ...options, onLost: lost }), fn, onLost);
}

module.exports = {
  IpfsGateError,
  holdIpfsGate,
  isIpfsdAvailable,
  takeIpfsGate,
  withIpfsGate,
  LOCK_TIMEOUT_MS,
  RELEASE_KILL_MS,
};
