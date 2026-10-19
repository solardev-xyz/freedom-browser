const path = require('path');
const { spawn } = require('child_process');

function getMacAppBundlePath(execPath = process.execPath) {
  const normalized = path.normalize(execPath);
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) return null;
  return normalized.slice(0, markerIndex);
}

function buildProfileLaunchCommand(activeProfile, profileId, options = {}) {
  const platform = options.platform || process.platform;
  const execPath = options.execPath || process.execPath;
  const profileArg = `--profile=${profileId}`;
  // Intent flag only — the cold-started process maps it to the internal
  // settings deep-link, so no URL travels on the command line.
  const extraArgs = options.openSettings ? ['--open-settings'] : [];

  if (activeProfile?.isDev) {
    const repoRoot = activeProfile.repoRoot || path.join(__dirname, '..', '..');
    return {
      command: execPath,
      args: [repoRoot, profileArg, ...extraArgs],
      cwd: repoRoot,
    };
  }

  if (platform === 'darwin') {
    const appBundlePath = options.appBundlePath || getMacAppBundlePath(execPath);
    if (appBundlePath) {
      return {
        command: 'open',
        args: ['-n', appBundlePath, '--args', profileArg, ...extraArgs],
        cwd: undefined,
      };
    }
  }

  return {
    command: execPath,
    args: [profileArg, ...extraArgs],
    cwd: undefined,
  };
}

function launchProfile(activeProfile, profileId, options = {}) {
  const command = buildProfileLaunchCommand(activeProfile, profileId, options);

  // E2E test mode: the harness installs a recorder so "open profile" doesn't
  // cold-start a real second Electron instance against the shared dev-home —
  // it records the intended launch for the spec to assert on instead. Mirrors
  // how the harness stubs ant/ipfs spawns (see src/main/test-harness.js). An
  // explicitly-injected `options.spawn` (unit tests) always wins over the hook.
  const recorder = !options.spawn && globalThis.__FREEDOM_TEST_PROFILE_LAUNCH__;
  if (typeof recorder === 'function') {
    recorder({ profileId, command, openSettings: options.openSettings === true });
    return command;
  }

  const spawnImpl = options.spawn || spawn;
  const child = spawnImpl(command.command, command.args, {
    cwd: command.cwd,
    detached: true,
    env: options.env || process.env,
    stdio: 'ignore',
  });

  if (typeof child?.unref === 'function') {
    child.unref();
  }

  return command;
}

// Open a profile, shared by the renderer IPC path and the native menu so both
// behave identically. If the target profile is already running, focus its
// window (fast — no new process); otherwise cold-start it. Deps are injectable
// for testing.
//
// Returns one of:
//   { focused: true }              — a running profile acknowledged the focus
//                                    (on GNOME Wayland possibly through an
//                                    xdg-open switch, which it acknowledges
//                                    once its window is raised)
//   { focused: false, launch }     — cold-started a new process
//   { focused: false, error }      — the profile is running but did not respond
//                                    to the focus request (we don't cold-start a
//                                    duplicate against its live lock)
//
// The ack round-trip is what lets callers report a *confirmed* focus instead of
// merely "the request was written" — see requestProfileFocusAsyncAwait.
async function openOrFocusProfile(activeProfile, profileId, options = {}) {
  // Test seam (E2E): simulate a profile that is already running, so the
  // focus-fast-path can be exercised without spawning a real second process.
  // When the harness has registered a simulated result for this id we return it
  // verbatim ({ focused: true } or { focused: false, error }) and never reach
  // launchProfile — mirroring the launch-recorder global used below. Inert in
  // production, where the global is undefined.
  const focusSim = globalThis.__FREEDOM_TEST_FOCUS_SIM__;
  if (typeof focusSim === 'function') {
    const simulated = focusSim(profileId, { openSettings: options.openSettings === true });
    if (simulated) return simulated;
  }

  // Lazy-required so this module stays loadable in isolation (and to avoid any
  // load-order coupling with profile-resolver).
  const resolveFocusTarget =
    options.getFocusTarget || require('./profile-resolver').getProfileFocusTargetForActiveApp;
  const requestFocus =
    options.requestFocus || require('./profile-focus-handoff').requestProfileFocusAsyncAwait;

  const target = resolveFocusTarget(profileId);
  // GNOME on Wayland raises the running profile's window only with an XDG
  // activation token, which this process can mint for it only through
  // shell.openExternal: xdg-open launches `freedom x-freedom-profile:<id>`
  // with the token, and that launch hands it to the running profile through
  // its single-instance lock (profile-switch-scheme.js, #142). Everywhere
  // else, and whenever that path is unavailable, the focus-request file below
  // does the switch. An --open-settings switch keeps to the file: the scheme
  // carries a profile id and nothing else. A switch the running profile never
  // confirms (deleted or quit meanwhile, the launch went elsewhere) falls
  // through to the file too, which reports one that cannot land.
  if (target?.isLocked && !options.openSettings) {
    const switchViaXdgOpen =
      options.switchViaXdgOpen || require('./profile-switch-scheme').switchProfileViaXdgOpen;
    if (await switchViaXdgOpen(target)) {
      return { focused: true };
    }
  }
  if (target?.isLocked) {
    const focus = await requestFocus(target, { openSettings: options.openSettings === true });
    if (focus?.ok) {
      return { focused: true };
    }
    // Cold-start ONLY when the focus request could not even be written (e.g. the
    // profile's data dir is gone) — there is no live process to focus, so a fresh
    // launch is correct. In every other failure mode the request reached a
    // running process that holds the lock: it may have acked a failure (its focus
    // handler isn't ready yet) or never acked in time (focus.timedOut). Launching
    // then would just spawn a duplicate that bounces off ELOCKED, so surface the
    // failure instead of falling through.
    if (focus?.requestWritten !== false) {
      return { focused: false, error: focus?.error || 'The running profile did not respond' };
    }
    // requestWritten === false: fall through and cold-start.
  }

  const launch = launchProfile(activeProfile, profileId, options);
  return { focused: false, launch };
}

module.exports = {
  buildProfileLaunchCommand,
  getMacAppBundlePath,
  launchProfile,
  openOrFocusProfile,
};
