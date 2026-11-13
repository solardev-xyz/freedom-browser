// Startup order around the profile gate (freedom-core design 0013, "The
// lock"; PRF-4): main writes none of the profile's stores and takes no
// hand-off before the gate's holder says `locked`. A launch refused the gate
// must leave the profile as it found it.
//
// The real main process (src/main/index.js) runs against a stand-in
// freedom-cored (FREEDOM_CORED_PATH): its `hold-profile` waits, saying
// nothing, until the test answers, then either exits 65 (the catalog no
// longer lists the profile: refused) or becomes the real holder, which says
// `locked`. Every other subcommand is the real binary. While the holder
// waits, startup has run all its top-level code (it logs the active profile
// at the end of it) and is parked on whenLocked(); the profile's settings
// file, which needs a migration written back, and a second launch's focus
// request must still be as they were.
//
// The stand-in is a POSIX shell script, which Windows can't spawn; the order
// is the same JavaScript on every platform. The `locked` half needs the real
// binary (`npm run core:download`; CI's e2e-desktop job has it).

const { test, expect } = require('@playwright/test');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const realCored = path.join(
  repoRoot,
  'freedom-cored-bin',
  `${{ darwin: 'mac', linux: 'linux' }[process.platform] || process.platform}-${process.arch}`,
  'freedom-cored'
);

// What src/main/settings-store.js migrates on load: a Bee-era key renamed,
// a retired one dropped. loadSettings() writes the result back.
const SETTINGS = { theme: 'dark', startBeeAtLaunch: false, antNodeMode: 'light' };

const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function writeStandIn(dir) {
  const script = path.join(dir, 'freedom-cored');
  const started = path.join(dir, 'hold-started');
  const answer = path.join(dir, 'answer');
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      'PATH=/usr/bin:/bin',
      'if [ "$1" = hold-profile ]; then',
      `  : > ${shQuote(started)}`,
      `  while [ ! -e ${shQuote(answer)} ]; do sleep 0.05; done`,
      `  if [ "$(cat ${shQuote(answer)})" = refuse ]; then exit 65; fi`,
      'fi',
      `exec ${shQuote(realCored)} "$@"`,
      '',
    ].join('\n')
  );
  fs.chmodSync(script, 0o755);
  return { script, started, answer };
}

// A second launch's focus request, as requestProfileFocusSync writes it: its
// own file, and the shared one older builds read.
function writeFocusRequest(userDataDir) {
  const nonce = `startup${Date.now()}`;
  const request = {
    type: 'focus-window',
    nonce,
    profileId: null,
    requestedAtMs: Date.now(),
    pid: process.pid,
  };
  const requestDir = path.join(userDataDir, 'profile-focus-requests');
  fs.mkdirSync(requestDir, { recursive: true });
  const own = path.join(requestDir, `${nonce}.json`);
  const shared = path.join(userDataDir, 'profile-focus-request.json');
  fs.writeFileSync(own, JSON.stringify(request));
  fs.writeFileSync(shared, JSON.stringify(request));
  return {
    nonce,
    own,
    shared,
    ownAck: path.join(userDataDir, 'profile-focus-acks', `${nonce}.json`),
    sharedAck: path.join(userDataDir, 'profile-focus-ack.json'),
  };
}

function launch(userDataDir, coredPath) {
  // As Playwright's electron.launch() does, without its debugger: nothing
  // here may wait for a window.
  const child = spawn(require('electron'), ['--no-sandbox', '.'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      FREEDOM_TEST_MODE: '1',
      FREEDOM_TEST_USER_DATA: userDataDir,
      FREEDOM_CORED_PATH: coredPath,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      LANG: 'en_US.UTF-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const waiters = [];
  const onData = (chunk) => {
    output += chunk.toString('utf8');
    for (const waiter of waiters.splice(0)) waiter();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal }))
  );
  // After the exit, once its output has all been read.
  let closed = false;
  child.on('close', () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter();
  });
  return {
    child,
    exited,
    output: () => output,
    async waitForOutput(text, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (!output.includes(text)) {
        if (closed) throw new Error(`main exited before "${text}":\n${output}`);
        if (Date.now() > deadline)
          throw new Error(`no "${text}" within ${timeoutMs} ms:\n${output}`);
        await new Promise((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 100);
        });
      }
    },
  };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// The Electron process tree, SIGKILLed: a refused launch sits in its error
// dialog, and a held one is done with once the files say what they must.
function killTree(pid) {
  let children = [];
  try {
    children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    // No children, or no pgrep.
  }
  for (const child of children) killTree(child);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

async function stop(app) {
  if (app.child.exitCode !== null || app.child.signalCode !== null) return;
  // A held launch quits on SIGTERM (shutdown-signals.js), releasing its lock
  // and the gate; a refused one sits in its error dialog.
  app.child.kill('SIGTERM');
  const quit = await Promise.race([
    app.exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 20_000)),
  ]);
  if (!quit) killTree(app.child.pid);
  await app.exited;
}

test.describe('profile gate: startup order', () => {
  test.skip(process.platform === 'win32', 'the stand-in freedom-cored is a POSIX shell script');

  let dir;
  let userDataDir;
  let standIn;
  let settingsPath;
  let settingsBytes;
  let app;

  test.beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-e2e-gate-order-'));
    userDataDir = path.join(dir, 'user-data');
    fs.mkdirSync(userDataDir);
    standIn = writeStandIn(dir);
    settingsPath = path.join(userDataDir, 'settings.json');
    settingsBytes = JSON.stringify(SETTINGS, null, 2);
    fs.writeFileSync(settingsPath, settingsBytes);
    app = null;
  });

  test.afterEach(async () => {
    if (app) await stop(app);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Main has spawned the holder and run its top-level code; the holder hasn't
  // answered. Returns the hand-off it must not have taken.
  async function startHeldBeforeLocked() {
    app = launch(userDataDir, standIn.script);
    await waitFor(() => fs.existsSync(standIn.started), 30_000, 'hold-profile to start');
    const request = writeFocusRequest(userDataDir);
    await app.waitForOutput('[profile] Active profile', 30_000);
    // The focus watcher checks every 200 ms: give it several.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expectUntouched(request);
    return request;
  }

  function expectUntouched(request) {
    expect(fs.readFileSync(settingsPath, 'utf8'), 'settings.json before `locked`').toBe(
      settingsBytes
    );
    expect(fs.existsSync(request.own), "the focus request's own file").toBe(true);
    expect(fs.existsSync(request.shared), 'the shared focus request file').toBe(true);
    expect(fs.existsSync(request.ownAck), 'an acknowledgement for the request').toBe(false);
    expect(fs.existsSync(request.sharedAck), 'the shared acknowledgement').toBe(false);
  }

  test('a refused gate leaves the settings and a pending hand-off untouched', async () => {
    test.setTimeout(90_000);
    const request = await startHeldBeforeLocked();

    fs.writeFileSync(standIn.answer, 'refuse');
    await app.waitForOutput('The profile gate could not be taken', 30_000);
    // Main's last steps: the lock released, the error shown, the exit.
    await Promise.race([app.exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    expectUntouched(request);
  });

  test('once the gate is held, the settings are migrated and the hand-off taken', async () => {
    test.skip(!fs.existsSync(realCored), 'needs freedom-cored: npm run core:download');
    test.setTimeout(120_000);
    const request = await startHeldBeforeLocked();

    fs.writeFileSync(standIn.answer, 'lock');
    await waitFor(() => fs.existsSync(request.sharedAck), 60_000, "the hand-off's acknowledgement");
    expect(JSON.parse(fs.readFileSync(request.sharedAck, 'utf8'))).toMatchObject({
      nonce: request.nonce,
      ok: true,
    });
    expect(fs.existsSync(request.own)).toBe(false);
    expect(fs.existsSync(request.shared)).toBe(false);
    await waitFor(
      () => !fs.readFileSync(settingsPath, 'utf8').includes('antNodeMode'),
      60_000,
      'the migrated settings to be written back'
    );
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings).toMatchObject({ theme: 'dark', startAntAtLaunch: false });
    expect(settings).not.toHaveProperty('startBeeAtLaunch');
  });
});
