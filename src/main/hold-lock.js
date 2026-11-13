/**
 * A gate held from main through a binary's `hold-lock` subcommand
 * (freedom-core designs 0001 and 0007, "Lifetime lock"): `<binary> hold-lock
 * --data-dir … --lock-dir …` takes the same OS lock the binary's own
 * process takes on that directory, writes `locked` once it holds it, and
 * holds it until its stdin closes. The kernel releases it when the process
 * ends, so a main that dies releases it too.
 *
 * freedom-cored's, freedom-ipfsd's and freedom-radicled's give the same
 * answers: `locked`, then exit 0 at stdin's EOF; 75 when another owner holds
 * the gate after 5 s of retries, 74 for storage it refuses (a network
 * filesystem, a directory that isn't the user's own, any other locking
 * error), 64 for usage. They take the same arguments, but freedom-radicled
 * names its directory `--home` (design 0008, "Spawn and lock"). Each
 * service's module (core/core-gate.js, ipfs/ipfsd-gate.js,
 * radicle/radicled-gate.js) names its binary, its errors and its log lines.
 */

const { spawn: spawnProcess } = require('child_process');
const { scrubbedEnv } = require('./core/service-client');

/** Contention is retried for 5 s by the holder; this is the rest of the
 * margin before main gives up on hearing `locked`. */
const LOCK_TIMEOUT_MS = 15_000;
/** A released holder exits at its stdin's EOF; past this it is killed. */
const RELEASE_KILL_MS = 1_000;
const LOCKED = 'locked';
const MAX_STDOUT = 64;
const MAX_STDERR = 4096;

const EXIT_CODES = new Map([
  [64, 'usage'],
  // freedom-cored's `hold-profile` only: a catalog profile no longer listed
  // at its directory (freedom-core design 0013, "The lock").
  [65, 'refused'],
  [74, 'storage'],
  [75, 'lock_held'],
]);

/**
 * Takes the gate of `dataDir` with `command`'s `hold-lock`. Resolves once the
 * holder has written `locked`, to a hold whose `release()` closes its stdin
 * and resolves once it has exited (killed after 1 s); rejects with
 * `gateError(code)`, `code` being `lock_held` (75), `storage` (74), `usage`
 * (64), `cancelled` (its signal) or `failed`. `onLost(exit)` runs if the
 * holder ends without being released. `signal` gives up a wait for `locked`
 * (the holder is killed): a stop never waits out another writer's hold.
 *
 * @param {object} options
 * @param {string} options.command - the binary
 * @param {string} options.dataDir - the directory its process would use
 * @param {string} [options.dataDirFlag] - the flag that names it:
 *   `--data-dir`, or freedom-radicled's `--home`
 * @param {string} options.lockDir - the per-user lock directory
 * @param {Function} options.gateError - (code) → the Error to reject with
 * @param {string} options.logPrefix - names the holder in log lines, e.g.
 *   `[IPFS] freedom-ipfsd`
 * @param {Function} [options.onLost] - ({ code, signal }) once a held gate is
 *   lost
 * @param {string[]} [options.args] - the holder's arguments, in place of
 *   `hold-lock <dataDirFlag> <dataDir> --lock-dir <lockDir>`: freedom-cored's
 *   `hold-profile` (profile-gate.js)
 * @param {number} [options.lockTimeoutMs] - how long to wait for `locked`
 * @param {AbortSignal} [options.signal] - cancels the wait for `locked`
 * @param {Function} [options.spawn]
 * @param {object} options.log
 * @param {Function} [options.setTimer]
 * @param {Function} [options.clearTimer]
 */
function holdLock({
  command,
  dataDir,
  dataDirFlag = '--data-dir',
  lockDir,
  gateError,
  logPrefix,
  onLost = null,
  args = null,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
  signal = null,
  spawn = spawnProcess,
  log,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(gateError('cancelled'));
      return;
    }
    let child;
    try {
      child = spawn(command, args || ['hold-lock', dataDirFlag, dataDir, '--lock-dir', lockDir], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: scrubbedEnv(),
        windowsHide: true,
      });
    } catch {
      reject(gateError('failed'));
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

    const onAbort = () => {
      if (state !== 'pending') return;
      fail(gateError('cancelled'), null);
      child.kill('SIGKILL');
    };
    const fail = (error, detail) => {
      if (state !== 'pending') return;
      state = 'failed';
      clearTimer(lockTimer);
      signal?.removeEventListener('abort', onAbort);
      // A cancelled wait is the caller's own doing: nothing to report.
      if (detail) log.warn(`${logPrefix} hold-lock failed`, { code: error.code, ...detail });
      reject(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    lockTimer = setTimer(() => {
      if (state !== 'pending') return;
      fail(gateError('failed'), { reason: 'no answer' });
      child.kill('SIGKILL');
    }, lockTimeoutMs);

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
        signal?.removeEventListener('abort', onAbort);
        resolve(hold);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR);
    });
    child.on('error', () => fail(gateError('failed'), { reason: 'spawn' }));
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
        fail(gateError(EXIT_CODES.get(code) || 'failed'), { exit: code, signal, cause });
        return;
      }
      if (state === 'locked' && !releasing) {
        log.error(`${logPrefix} hold-lock ended while holding the gate`, {
          exit: code,
          signal,
        });
        onLost?.(exited);
      }
    });
  });
}

/**
 * Runs `fn(gate)` holding a gate `take(onLost)` resolves to (a hold, or null
 * for none), and releases it once `fn` has settled. `gate.gated` says
 * whether a gate is held at all; `gate.held()` whether it still is: false
 * once its holder has ended unreleased, which a destructive `fn` checks,
 * with nothing awaited, right before each step that must not run ungated.
 */
async function withHold(take, fn, onLost = null) {
  let lost = false;
  const hold = await take((exit) => {
    lost = true;
    onLost?.(exit);
  });
  try {
    return await fn({ gated: hold !== null, held: () => hold !== null && !lost });
  } finally {
    await hold?.release();
  }
}

module.exports = { holdLock, withHold, LOCK_TIMEOUT_MS, RELEASE_KILL_MS };
