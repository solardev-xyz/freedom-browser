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
 * - **Its answers** (fc-service's `hold_lock`): `locked`, then exit 0 at
 *   stdin's EOF. 75 when another owner holds the gate after 5 s of retries,
 *   74 for storage it refuses (a network filesystem, a directory that isn't
 *   the user's own, any other locking error), 64 for usage.
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
const { spawn: spawnProcess } = require('child_process');
const { app } = require('electron');
const defaultLog = require('../logger');
const { scrubbedEnv } = require('../core/service-client');
const { getLockDir } = require('../service-locks');
const { getIpfsdBinaryPath } = require('./ipfsd-client');

/** Contention is retried for 5 s by the holder; this is the rest of the
 * margin before main gives up on hearing `locked`. */
const LOCK_TIMEOUT_MS = 15_000;
/** A released holder exits at its stdin's EOF; past this it is killed. */
const RELEASE_KILL_MS = 1_000;
const LOCKED = 'locked';
const MAX_STDOUT = 64;
const MAX_STDERR = 4096;

const MESSAGES = {
  lock_held: 'The IPFS data is in use by another process. Close it and try again.',
  storage: "The IPFS data directory's lock can't be taken on this storage",
  usage: 'freedom-ipfsd refused the hold-lock command',
  missing: 'freedom-ipfsd is missing from this installation. Reinstall Freedom.',
  failed: "freedom-ipfsd couldn't hold the IPFS data directory's lock",
};
const EXIT_CODES = new Map([
  [64, 'usage'],
  [74, 'storage'],
  [75, 'lock_held'],
]);

/** The gate couldn't be had: `code` is `lock_held` (75), `storage` (74),
 * `usage` (64), `missing` or `failed`. */
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
 * Takes the gate of `dataDir` with `hold-lock`. Resolves once the holder has
 * written `locked`, to a hold whose `release()` closes its stdin and resolves
 * once it has exited (killed after 1 s); rejects with an IpfsGateError.
 * `onLost(exit)` runs if the holder ends without being released.
 *
 * @param {object} options
 * @param {string} options.dataDir - the directory the service would use
 *   (`<ipfs-data>/freedom-ipfs`)
 * @param {string} [options.lockDir] - the core's lock directory
 * @param {Function} [options.onLost] - ({ code, signal }) once a held gate is
 *   lost
 * @param {string} [options.command]
 * @param {Function} [options.spawn]
 * @param {object} [options.log]
 * @param {Function} [options.setTimer]
 * @param {Function} [options.clearTimer]
 */
function holdIpfsGate({
  dataDir,
  lockDir = getLockDir(),
  onLost = null,
  command = getIpfsdBinaryPath(),
  spawn = spawnProcess,
  log = defaultLog,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, ['hold-lock', '--data-dir', dataDir, '--lock-dir', lockDir], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: scrubbedEnv(),
        windowsHide: true,
      });
    } catch {
      reject(new IpfsGateError('failed'));
      return;
    }
    let stdout = '';
    let stderr = '';
    // pending → locked (resolved), or failed (rejected); then the exit.
    let state = 'pending';
    let exited = null;
    let releasing = null;
    const exitWaiters = [];
    let lockTimer = null;

    const fail = (error, detail) => {
      if (state !== 'pending') return;
      state = 'failed';
      clearTimer(lockTimer);
      log.warn('[IPFS] freedom-ipfsd hold-lock failed', { code: error.code, ...detail });
      reject(error);
    };
    lockTimer = setTimer(() => {
      if (state !== 'pending') return;
      fail(new IpfsGateError('failed'), { reason: 'no answer' });
      child.kill('SIGKILL');
    }, LOCK_TIMEOUT_MS);

    const hold = {
      /** Closes the holder's stdin; resolves once it has exited. */
      release() {
        if (!releasing) {
          releasing = new Promise((done) => {
            if (exited) {
              done();
              return;
            }
            const killTimer = setTimer(() => child.kill('SIGKILL'), RELEASE_KILL_MS);
            exitWaiters.push(() => {
              clearTimer(killTimer);
              done();
            });
            try {
              child.stdin.end();
            } catch {
              child.kill('SIGKILL');
            }
          });
        }
        return releasing;
      },
    };

    // A holder that dies takes nothing with it but its pipes.
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      if (state !== 'pending' || stdout.length > MAX_STDOUT) return;
      stdout += chunk.toString('utf8');
      if (stdout.startsWith(`${LOCKED}\n`)) {
        state = 'locked';
        clearTimer(lockTimer);
        resolve(hold);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR);
    });
    child.on('error', () => fail(new IpfsGateError('failed'), { reason: 'spawn' }));
    child.on('exit', (code, signal) => {
      if (exited) return;
      exited = { code, signal };
      for (const waiter of exitWaiters.splice(0)) waiter();
      if (state === 'pending') {
        // The holder's last log line names the cause, without a path.
        let cause = null;
        try {
          cause = JSON.parse(stderr.trim().split('\n').at(-1)).error ?? null;
        } catch {
          // Not one of its JSON lines.
        }
        fail(new IpfsGateError(EXIT_CODES.get(code) || 'failed'), { exit: code, signal, cause });
        return;
      }
      if (state === 'locked' && !releasing) {
        log.error('[IPFS] freedom-ipfsd hold-lock ended while holding the gate', {
          exit: code,
          signal,
        });
        onLost?.(exited);
      }
    });
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

/** Runs `fn` holding the gate of `dataDir` (`takeIpfsGate`'s rules), and
 * releases it once `fn` has settled. */
async function withIpfsGate(dataDir, fn, options = {}) {
  const hold = await takeIpfsGate(dataDir, options);
  try {
    return await fn();
  } finally {
    await hold?.release();
  }
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
