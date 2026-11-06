/**
 * A profile's core gate, held from main (freedom-core design 0001, "Lifetime
 * lock"): `freedom-cored hold-lock --data-dir <identity dir> --lock-dir …`
 * takes the lock `freedom-cored serve` holds on that identity directory for
 * its whole life, writes `locked` once it holds it, and holds it until its
 * stdin closes (hold-lock.js). The lock lives in the per-user lock
 * directory, outside the identity directory, so no core can start on it
 * while the gate is held.
 *
 * - **Who takes it:** the profile's core, for its whole life; profile
 *   delete, for the whole destructive operation (0001), before it takes
 *   freedom-ipfsd's gate: the core's lifetime lock, then a node's gate
 *   (0008, "Lock order").
 * - **Without the binary:** every build runs the core (core-process.js), so
 *   a packaged build ships it, and its absence there is a broken
 *   installation: what needs the gate fails. A development build without
 *   `npm run core:download` goes on ungated, with a warning: no core runs
 *   from that checkout without the binary.
 */

const fs = require('fs');
const { app } = require('electron');
const defaultLog = require('../logger');
const { holdLock, withHold } = require('../hold-lock');
const { getLockDir } = require('../service-locks');
const { getCoredBinaryPath } = require('./cored-binary');

const MESSAGES = {
  lock_held:
    "The profile's identity data is in use by another process. Close the profile and try again.",
  storage: "The profile's core lock can't be taken on this storage",
  usage: 'freedom-cored refused the hold-lock command',
  missing: 'freedom-cored is missing from this installation. Reinstall Freedom.',
  cancelled: "Taking the profile's core lock was cancelled",
  failed: "freedom-cored couldn't hold the profile's core lock",
};

/** The gate couldn't be had: `code` is `lock_held` (75), `storage` (74),
 * `usage` (64), `missing`, `cancelled` (its signal) or `failed`. */
class CoreGateError extends Error {
  constructor(code, message = MESSAGES[code]) {
    super(message);
    this.name = 'CoreGateError';
    this.code = code;
  }
}

/** The freedom-cored binary this build would run, if it is there. */
function isCoredAvailable() {
  return fs.existsSync(getCoredBinaryPath());
}

/**
 * Takes the core gate of `identityDir` with `hold-lock` (hold-lock.js's
 * `holdLock`): a hold whose `release()` lets it go, or a CoreGateError.
 *
 * @param {object} options
 * @param {string} options.identityDir - the directory the profile's core
 *   would use (`<profile>/identity`)
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
function holdCoreGate({
  identityDir,
  lockDir = getLockDir(),
  command = getCoredBinaryPath(),
  log = defaultLog,
  ...options
}) {
  return holdLock({
    ...options,
    command,
    dataDir: identityDir,
    lockDir,
    log,
    gateError: (code) => new CoreGateError(code),
    logPrefix: '[Core] freedom-cored',
  });
}

/**
 * The core gate of `identityDir` for a caller that must hold it, under this
 * build's rule for a missing binary: a hold, or null in a development build
 * without freedom-cored (logged); a CoreGateError otherwise.
 */
async function takeCoreGate(identityDir, { onLost = null, log = defaultLog, ...options } = {}) {
  if (!isCoredAvailable()) {
    if (app.isPackaged) throw new CoreGateError('missing');
    log.warn(
      "[Core] freedom-cored isn't downloaded (npm run core:download): going on without the profile's core gate"
    );
    return null;
  }
  return holdCoreGate({ identityDir, onLost, log, ...options });
}

/**
 * Runs `fn(gate)` holding the core gate of `identityDir` (`takeCoreGate`'s
 * rules), and releases it once `fn` has settled. `gate.gated` says whether a
 * gate is held at all; `gate.held()` whether it still is (hold-lock.js's
 * `withHold`).
 */
async function withCoreGate(identityDir, fn, { onLost = null, ...options } = {}) {
  return withHold((lost) => takeCoreGate(identityDir, { ...options, onLost: lost }), fn, onLost);
}

module.exports = {
  CoreGateError,
  holdCoreGate,
  isCoredAvailable,
  takeCoreGate,
  withCoreGate,
};
