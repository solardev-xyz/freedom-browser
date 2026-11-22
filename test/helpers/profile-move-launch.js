// A launch through index.js's profile steps, for
// profile-move.integration.test.js (freedom-core design 0013, PRF-9 B3):
// `profile open` through freedom-cored, a journal settled, the
// held-elsewhere check, the starting move, then the profile gate and the
// profile lock, with main's own modules and in index.js's order.
//
//   node profile-move-launch.js <freedom-cored> <lock dir> <app root> <id> <release file> [<pause>]
//
// `<pause>` is a FREEDOM_CORED_TEST_PROFILE_MIGRATE_PAUSE spec
// (`<step>=<marker>=<release>`) for the starting move's run, which a
// testhooks build of freedom-cored honours.
//
// Writes one line: `opened <move outcome> <layout>` once it holds the gate
// and the lock (then, once `<release file>` exists, lets both go and writes
// `released`), or `handed-over <step> <move outcome>` where index.js would
// hand over.

const fs = require('fs');
const Module = require('module');
const { spawnSync } = require('child_process');

// Main's profile-paths.js requires 'electron' when it loads. In plain Node
// that package only resolves the Electron binary's path, downloading the
// binary first if it is missing and saying so on stdout, which is this
// helper's protocol. Nothing here runs Electron, so a stub stands in, as
// jest.mock does in the test.
const electron = require.resolve('electron');
const stub = new Module(electron);
stub.filename = electron;
stub.loaded = true;
stub.exports = {};
require.cache[electron] = stub;

const { profileLayout } = require('../../src/main/freedom-root');
const {
  isProfileGateHeldSync,
  isProfileHeldElsewhere,
  startProfileGate,
} = require('../../src/main/profile-gate');
const {
  acquireProfileLock,
  hasStaleProfileLock,
  isLockUnavailableError,
  releaseProfileLock,
} = require('../../src/main/profile-lock');
const {
  finishProfileMove,
  openProfile,
  startProfileMove,
} = require('../../src/main/profile-resolver');

const [command, lockDir, appRoot, id, release, pause] = process.argv.slice(2);
const app = { isPackaged: true, getPath: () => appRoot, setPath() {} };
const log = { info() {}, debug() {}, warn() {}, error: (...args) => console.error(...args) };
const say = (line) => process.stdout.write(`${line}\n`);
const handOver = (step, outcome) => {
  say(`handed-over ${step} ${outcome}`);
  process.exit(0);
};
const options = {
  command,
  lockDir,
  ...(pause
    ? {
        spawnSync: (file, args, spawnOptions) =>
          spawnSync(file, args, {
            ...spawnOptions,
            env: { ...spawnOptions.env, FREEDOM_CORED_TEST_PROFILE_MIGRATE_PAUSE: pause },
          }),
      }
    : {}),
};

const { profile, report } = openProfile(app, {
  backend: 'core',
  argv: ['freedom', '--profile', id],
  env: {},
  command,
  lockDir,
});
if (report.layout === 'pending' && finishProfileMove(profile, options) === 'busy') {
  handOver('pending', 'skipped');
}
if (
  isProfileHeldElsewhere(report, profile, {
    hasStaleLock: hasStaleProfileLock,
    askGate: (p) => isProfileGateHeldSync(p, { command, lockDir, log }),
  })
) {
  handOver('held', 'skipped');
}
let moved = { outcome: 'skipped', reason: 'layout' };
if (report.layout === 'root') {
  moved = startProfileMove(app, profile, report, options);
  if (moved.outcome === 'busy') handOver('move', 'busy');
}
const gate = startProfileGate(profile, { packaged: true, log, command, lockDir });
let lock;
try {
  lock = acquireProfileLock(profile, { logger: log });
} catch (error) {
  if (!isLockUnavailableError(error)) throw error;
  gate.release().then(() => handOver('lock', moved.outcome));
}
if (lock) {
  gate.whenLocked().then(
    async () => {
      say(`opened ${moved.outcome} ${profileLayout(profile.userDataDir)}`);
      const deadline = Date.now() + 120_000;
      while (!fs.existsSync(release) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      releaseProfileLock(lock, { logger: log });
      await gate.release();
      say('released');
      process.exit(0);
    },
    (error) => {
      releaseProfileLock(lock, { logger: log });
      handOver(`gate-${error.code}`, moved.outcome);
    }
  );
}
