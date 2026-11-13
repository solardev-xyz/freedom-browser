/**
 * The profile gate, held from main (freedom-core design 0013, "The lock";
 * step PRF-4): `freedom-cored hold-profile --user-data-dir <dir> --lock-dir
 * <dir> [--app-root <dir> --id <id>]` takes
 * `<lock-dir>/profile-<sha256(canonical userData)>.lock`, an OS lock, checks
 * that the catalog still lists a catalog profile at its directory (so a
 * launch that raced a delete fails instead of opening an empty profile),
 * writes `locked`, and holds the gate until its stdin closes. The kernel
 * releases it when the holder ends, so a main that dies releases it too.
 *
 * - **From before the lock to after it:** index.js starts the holder after
 *   `app.setPath` (and after `profile migrate`, when one runs) and before it
 *   takes the profile lock. It waits for `locked` (10 s at most) before it
 *   starts the core, any node, any store write or its first window, and at
 *   quit it closes the holder's stdin only after releasing the lock. So
 *   whenever this build holds the profile lock, the gate is held too:
 *   before `serve` starts, while the core restarts after a crash, and while
 *   main's loop is stalled. The moment between taking the lock and
 *   `locked` lies inside the lock's first 30 s, while it is fresh.
 * - **"Open", in new builds:** the lock fresh, or this gate held. A stale
 *   lock with the gate held is a live profile whose main has stalled: a
 *   launch hands over or reports it busy, and a delete is refused.
 * - **The holder dies while main runs:** another starts at once; the lock,
 *   still fresh, covers the moment. One that can't take the gate within its
 *   own 5 s of retries ends main (`onFatal`), as a compromised lock does.
 * - **The lock directory** is created (0700) before the holder starts:
 *   `hold-profile` (cored-v0.13.0) fails with 74 (storage) where it doesn't
 *   exist yet, unlike `hold-lock`, which creates it. On a machine no new
 *   build has run on, nothing has made it before the first launch's gate.
 * - **Without the binary:** a packaged build ships it, so its absence there
 *   is a broken installation and the profile doesn't open. A development
 *   build without `npm run core:download` goes on ungated, with a warning,
 *   as core-gate.js does.
 */

const fs = require('fs');
const { spawnSync: spawnSyncProcess } = require('child_process');
const { holdLock } = require('./hold-lock');
const subcommands = require('./profile-subcommands');

/** How long main waits for `locked` (0013, "The lock"). */
const LOCKED_TIMEOUT_MS = 10_000;

/** `hold-profile`'s exits beyond `hold-lock`'s (64, 74, 75): 65, a catalog
 * profile no longer listed at its directory, and 77, confinement refused
 * (freedom-core's profile subcommands). */
const HOLD_PROFILE_EXITS = new Map([
  [65, 'refused'],
  [77, 'confinement'],
]);

const MESSAGES = {
  lock_held: 'This profile is open in another Freedom window.',
  refused: 'This profile was deleted while Freedom was opening it.',
  storage: "The profile's lock can't be taken on this storage",
  confinement: "freedom-cored couldn't confine itself on this system",
  usage: 'freedom-cored refused the hold-profile command',
  missing: 'freedom-cored is missing from this installation. Reinstall Freedom.',
  cancelled: "Taking the profile's lock was cancelled",
  failed: "freedom-cored couldn't hold the profile's lock",
};

/** The gate couldn't be had: `code` is `lock_held` (75: another new build
 * holds the profile), `refused` (65: a catalog profile no longer listed at
 * its directory), `storage` (74), `confinement` (77), `usage` (64),
 * `missing`, `cancelled` or `failed`. */
class ProfileGateError extends Error {
  constructor(code, message = MESSAGES[code] || MESSAGES.failed) {
    super(message);
    this.name = 'ProfileGateError';
    this.code = code;
  }
}

/** `hold-profile`'s arguments for `profile`: a catalog profile's id and app
 * root too, for the holder's check that it is still listed. */
function profileGateArgs(profile, lockDir) {
  const args = ['hold-profile', '--user-data-dir', profile.userDataDir, '--lock-dir', lockDir];
  if (profile.source === 'catalog' && profile.appRoot && profile.id) {
    args.push('--app-root', profile.appRoot, '--id', profile.id);
  }
  return args;
}

function defaultCommand() {
  return require('./core/cored-binary').getCoredBinaryPath();
}

function defaultLockDir() {
  return require('./service-locks').getLockDir();
}

/**
 * Starts holding `profile`'s gate. Returns at once, the holder spawned, with
 * a controller:
 *
 * - `gated`: false only in a development build without freedom-cored;
 * - `whenLocked()`: resolves once the first holder has said `locked`;
 *   rejects with a ProfileGateError (10 s at most);
 * - `held()`: whether a holder holds the gate right now;
 * - `release()`: closes the holder's stdin (or gives up a wait for
 *   `locked`); resolves once it has exited. Call it after the profile lock's
 *   release.
 *
 * @param {object} profile - the active profile (`userDataDir`, and `source`,
 *   `appRoot` and `id` for a catalog profile)
 * @param {object} options
 * @param {boolean} options.packaged - app.isPackaged
 * @param {object} options.log
 * @param {Function} [options.onFatal] - (error) once a lost holder couldn't
 *   be replaced
 * @param {string} [options.command]
 * @param {string} [options.lockDir]
 * @param {Function} [options.spawn]
 * @param {Function} [options.exists]
 * @param {Function} [options.mkdir]
 * @param {Function} [options.setTimer]
 * @param {Function} [options.clearTimer]
 */
function startProfileGate(
  profile,
  {
    packaged,
    log,
    onFatal = null,
    command = defaultCommand(),
    lockDir = defaultLockDir(),
    spawn,
    exists = fs.existsSync,
    mkdir = fs.mkdirSync,
    setTimer,
    clearTimer,
  }
) {
  if (!exists(command)) {
    if (packaged) {
      const missing = Promise.reject(new ProfileGateError('missing'));
      missing.catch(() => {});
      return { gated: true, whenLocked: () => missing, held: () => false, release: async () => {} };
    }
    log.warn(
      "[profile] freedom-cored isn't downloaded (npm run core:download): going on without the profile gate"
    );
    return { gated: false, whenLocked: async () => {}, held: () => false, release: async () => {} };
  }

  try {
    mkdir(lockDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    // The holder then fails with `storage`, which says what is wrong.
    log.warn("[profile] Couldn't create the lock directory", { code: error.code });
  }

  let current = null;
  let released = false;
  const abort = new AbortController();
  const args = profileGateArgs(profile, lockDir);

  const take = () =>
    holdLock({
      command,
      dataDir: profile.userDataDir,
      lockDir,
      args,
      lockTimeoutMs: LOCKED_TIMEOUT_MS,
      exitCodes: HOLD_PROFILE_EXITS,
      gateError: (code) => new ProfileGateError(code),
      logPrefix: '[profile] freedom-cored',
      onLost,
      signal: abort.signal,
      ...(spawn ? { spawn } : {}),
      log,
      ...(setTimer ? { setTimer } : {}),
      ...(clearTimer ? { clearTimer } : {}),
    }).then((hold) => {
      if (released) {
        hold.release();
        throw new ProfileGateError('cancelled');
      }
      current = hold;
      return hold;
    });

  function onLost(exit) {
    current = null;
    if (released) return;
    log.warn('[profile] The profile gate\'s holder ended; taking the gate again', exit);
    take().then(
      () => log.info('[profile] The profile gate is held again'),
      (error) => {
        if (released) return;
        log.error("[profile] The profile gate couldn't be taken again", { code: error.code });
        onFatal?.(error);
      }
    );
  }

  const first = take();
  first.catch(() => {});

  return {
    gated: true,
    whenLocked: () => first.then(() => undefined),
    held: () => current !== null,
    release() {
      released = true;
      abort.abort();
      const hold = current;
      current = null;
      return hold ? hold.release() : Promise.resolve();
    },
  };
}

/**
 * Whether another new build's main holds `profile`'s gate, asked with
 * `profile status` (0013, "Asking the gate"), for a launch about to take a
 * stale lock over where `profile open` didn't run (`--profile-dir`, a test
 * user-data directory, and Windows until its qualification). Blocks main,
 * which holds no lease yet. A run that fails reads as not held, logged: the
 * holder main starts next still refuses a gate another holds.
 */
function isProfileGateHeldSync(
  profile,
  { command = defaultCommand(), lockDir = defaultLockDir(), log = console, spawnSync = spawnSyncProcess } = {}
) {
  const args = ['profile', 'status', '--lock-dir', lockDir];
  if (profile.isDev) args.push('--dev');
  args.push('--user-data-dir', profile.userDataDir);
  try {
    const { result } = subcommands.runSync(command, args, { spawnSync });
    return Array.isArray(result) && result[0]?.gate_held === true;
  } catch (error) {
    log.warn?.("[profile] Couldn't ask the profile gate; taking the stale lock", {
      code: error.code,
    });
    return false;
  }
}

/**
 * Whether another new build's main holds this launch's profile, its lock
 * stale or not (0013, "What 'open' means"): `profile open`'s `gate_held`
 * (`report.gateHeld`), or, where it didn't run (`gateHeld: null`),
 * `askGate(profile)` for a lock that reads stale (`hasStaleLock(profile)`);
 * a fresh lock already reads open when main tries to take it.
 */
function isProfileHeldElsewhere(report, profile, { hasStaleLock, askGate }) {
  if (typeof report?.gateHeld === 'boolean') return report.gateHeld;
  return hasStaleLock(profile) && askGate(profile);
}

module.exports = {
  LOCKED_TIMEOUT_MS,
  ProfileGateError,
  isProfileGateHeldSync,
  isProfileHeldElsewhere,
  profileGateArgs,
  startProfileGate,
};
