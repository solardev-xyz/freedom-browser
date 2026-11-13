// A launch held before `serve`, for profile-open.integration.test.js
// (freedom-core design 0013, PRF-4's tests): main's own modules take the
// profile gate and the profile lock in index.js's order, then the loop stops
// for `holdMs`, as a main stalled after its lock and before its core starts.
// Nothing refreshes the lock meanwhile, so it reads stale after 30 s, while
// the gate's holder, a process of its own, keeps the gate.
//
//   node profile-held-launch.js <freedom-cored> <lock dir> <userData> <app root> <id> <holdMs>
//
// Writes `held` once both are taken, and `released` after the hold.

const { acquireProfileLock, releaseProfileLock } = require('../../src/main/profile-lock');
const { startProfileGate } = require('../../src/main/profile-gate');

const [command, lockDir, userDataDir, appRoot, id, holdMs] = process.argv.slice(2);
const profile = { id, source: 'catalog', appRoot, userDataDir, isDev: false };
const log = {
  info() {},
  debug() {},
  warn() {},
  error: (...args) => console.error(...args),
};

const gate = startProfileGate(profile, { packaged: true, log, command, lockDir });
// Past the stale time the lock's next refresh finds it compromised, as a
// stalled main's would: nothing to do here but go on to the release.
const lock = acquireProfileLock(profile, { logger: log, onCompromised: () => {} });
gate.whenLocked().then(
  async () => {
    process.stdout.write('held\n');
    // The loop stops: no lock refresh, no timer, no I/O.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
    releaseProfileLock(lock, { logger: log });
    await gate.release();
    process.stdout.write('released\n');
    process.exit(0);
  },
  (error) => {
    console.error(`gate: ${error.code}`);
    process.exit(3);
  }
);
