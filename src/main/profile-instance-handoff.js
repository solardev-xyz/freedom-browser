/**
 * Linux: a second launch of an already-running profile hands over through
 * Electron's single-instance lock (issue #142).
 *
 * Electron keys that lock on the userData directory, and index.js only takes
 * it after profile-resolver.js has pointed userData at the profile's own
 * directory, so there is one lock per profile. A launch of a running profile
 * (the dock, the app grid, `freedom --profile=<id>`, an `x-freedom-profile:`
 * switch through xdg-open) then reaches the running process as a
 * 'second-instance' event — and Electron carries the launch's XDG activation
 * token with it and sets it before the event fires, so the running process's
 * next focus() is allowed to raise its window. GNOME on Wayland refuses
 * activation without one and posts "'Freedom' is ready" instead; the
 * profile-focus file hand-off (profile-focus-handoff.js) has no way to carry
 * the token.
 *
 * A launch only asks for that lock after the running profile has answered an
 * instance-lock probe through the focus-request files, from its main thread,
 * saying it listens on the lock (profile-focus-handoff.js). Asking blind is
 * not safe: Chromium waits up to 20 s for the holder to acknowledge and then
 * SIGKILLs it, so a profile showing a modal error box or busy on its main
 * thread would be killed by a dock click. The probe also means no launch ever
 * takes the lock while a cold-starting profile has not yet taken it itself.
 *
 * The file hand-off stays as the fallback: on macOS and Windows (which keep
 * their own, working, activation paths), and on Linux whenever the running
 * process does not answer the probe or does not hold the lock (an older
 * Freedom version still running across an upgrade, a blocked main thread,
 * a profile still cold-starting).
 */

const { buildColdStartUrls } = require('./launch-urls');
const { isProfileSwitchArg, writeProfileSwitchAck } = require('./profile-switch-scheme');

// For a launch whose profile is locked by a running process: true when the
// launch was handed to that process through the single-instance lock (the
// caller exits), false when the caller should use the file hand-off.
//
// `requestSingleInstanceLock()` returning false *is* the hand-over: Electron
// has passed this process's argv (and activation token) to the lock holder.
// Returning true means the holder went away since it answered the probe; this
// process then holds the lock only until it exits a moment later.
//
// `probe` (requestInstanceLockProbeSync bound to the profile) must answer true
// first: see the header for why the lock is never asked for blind.
function handOverToRunningProfile(app, { platform = process.platform, probe } = {}) {
  if (platform !== 'linux') return false;
  if (typeof probe !== 'function') return false;
  let listening;
  try {
    listening = probe() === true;
  } catch {
    listening = false;
  }
  if (!listening) return false;
  return !app.requestSingleInstanceLock();
}

// Record how an `x-freedom-profile:` switch launch is getting on, in the
// target profile's userData dir, for the in-app switch waiting on it
// (profile-switch-scheme.js). Best effort: the waiting side times out anyway.
function recordProfileSwitch(
  profile,
  state,
  { writeSwitchAck = writeProfileSwitchAck, logger } = {}
) {
  if (!profile?.switchOnly || !profile.userDataDir) return;
  try {
    writeSwitchAck(profile.userDataDir, { state });
  } catch (error) {
    logger?.warn?.(
      `[profile] Could not record a profile switch as ${state}:`,
      error?.message || error
    );
  }
}

// Everything a launch does when it finds its profile locked by a running
// process; the caller exits afterwards. Through the single-instance lock when
// the holder answers the probe (it then acknowledges a switch itself), else
// through the focus-request file.
//
// An `x-freedom-profile:` switch launch is a short-lived helper of an in-app
// switch in another profile, which waits for its outcome and runs the file
// hand-off itself when it fails. So when such a launch has to fall back to the
// file, it records whether that focus landed (sparing the switching profile a
// second focus) and never shows an error box of its own: the switching profile
// reports a switch that cannot land, once. That also keeps a page in another
// browser firing the scheme from popping up a Freedom dialog.
function handleLockedProfileLaunch({
  app,
  profile,
  launchUrls = [],
  probe,
  requestFocus,
  showError,
  writeSwitchAck = writeProfileSwitchAck,
  logger,
  platform = process.platform,
}) {
  if (handOverToRunningProfile(app, { platform, probe })) return;
  let focusResult;
  try {
    focusResult = requestFocus(profile, { urls: launchUrls });
  } catch (error) {
    focusResult = { ok: false, error: error?.message || String(error) };
  }
  const ok = focusResult?.ok === true;
  if (profile?.switchOnly) {
    recordProfileSwitch(profile, ok ? 'done' : 'failed', { writeSwitchAck, logger });
    if (!ok) {
      logger?.warn?.(
        `[profile] An x-freedom-profile switch could not focus "${profile.id}"; ` +
          'the profile that asked for it reports the failure'
      );
    }
    return;
  }
  if (!ok) {
    const profileName = profile?.displayName || profile?.id || 'selected';
    showError(
      'Freedom profile is already open',
      `The "${profileName}" profile is already open, but Freedom could not focus it.\n\nClose that Freedom window or stop its automation runtime, or launch a different profile.`
    );
  }
}

// What a 'second-instance' launch asks the running profile to open: Profile
// settings for a Profiles-manager launch carrying --open-settings, else the
// links among its arguments (checked like any other launch's). A plain launch
// opens nothing and just raises the most recently used window.
function secondInstanceUrls(argv, { settingsUrl }) {
  return buildColdStartUrls(argv, { settingsUrl });
}

// The 'second-instance' listener. Links that land while this process is still
// cold-starting go to the first window bootstrap() is about to open (the same
// queue the file hand-off uses); after that, focusWindow opens them in the
// most recently focused window and raises it. focusWindow is called in the
// same turn as the event when the app is ready, so it activates with the
// token Electron has just set for this launch.
//
// A launch carrying an `x-freedom-profile:` switch (an in-app switch through
// xdg-open) is acknowledged in userDataDir: `done` once the window was raised,
// `failed` when raising it threw, so the profile that asked can tell a switch
// that landed from one that did not without waiting out its budget.
function createSecondInstanceHandler({
  app,
  settingsUrl,
  firstWindowLinks,
  focusWindow,
  logger,
  userDataDir = null,
  writeSwitchAck = writeProfileSwitchAck,
}) {
  return (_event, argv) => {
    const urls = secondInstanceUrls(argv, { settingsUrl });
    const isSwitch = Array.isArray(argv) && argv.slice(1).some(isProfileSwitchArg);
    const ackSwitch = (state = 'done') => {
      if (!isSwitch || !userDataDir) return;
      try {
        writeSwitchAck(userDataDir, { state });
      } catch (error) {
        logger?.warn?.(
          '[profile] Could not acknowledge a profile switch:',
          error?.message || error
        );
      }
    };
    if (firstWindowLinks.queue(urls)) {
      ackSwitch();
      return;
    }
    const focus = () => {
      try {
        focusWindow(urls);
      } catch (error) {
        logger?.error?.('[profile] Could not focus this profile for a second launch:', error);
        // Tell a waiting switch at once, rather than leaving it at `received`
        // until its time runs out: it then reports the failure itself.
        ackSwitch('failed');
        return;
      }
      ackSwitch();
    };
    if (app.isReady()) focus();
    else app.whenReady().then(focus);
  };
}

// Take this profile's single-instance lock and listen for later launches of
// it. Returns whether this process now holds the lock; when it does not,
// it answers instance-lock probes with "no" and later launches fall back to
// the file hand-off, which this process keeps watching either way. (No other
// launch asks for the lock before this process says it holds it, so this
// should not fail; the fallback is for the unforeseen.)
function listenForProfileRelaunches(app, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'linux' || options.runtimeMode === true) return false;
  if (!app.requestSingleInstanceLock()) {
    options.logger?.warn?.(
      "[profile] Another process holds this profile's single-instance lock; " +
        'later launches of it hand over through the focus-request file instead'
    );
    return false;
  }
  app.on('second-instance', createSecondInstanceHandler({ app, ...options }));
  return true;
}

module.exports = {
  createSecondInstanceHandler,
  handleLockedProfileLaunch,
  handOverToRunningProfile,
  listenForProfileRelaunches,
  recordProfileSwitch,
  secondInstanceUrls,
};
