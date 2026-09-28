/**
 * Remote-debugging gate for packaged builds (docs/security-audit-electron.md,
 * O-4; issue #431).
 *
 * The `EnableNodeCliInspectArguments` fuse is off in packaged builds, so
 * `--inspect`, `--inspect-brk` and SIGUSR1 no longer open a Node inspector on
 * the main process. Chromium's own `--remote-debugging-port` /
 * `--remote-debugging-pipe` switches are not covered by any fuse: a packaged
 * Electron app honours them on every launch unless the app removes them.
 * They give CDP control of the browser chrome (every renderer and webview,
 * clicks included) against whatever profile the app opens.
 *
 * The packaged smoke tests need exactly that CDP endpoint now that they
 * cannot attach over `--inspect` (test-e2e/packaged-launch.js). So instead of
 * leaving it open for every launch, keep it only for a launch that has been
 * pointed at a scratch profile with `FREEDOM_TEST_USER_DATA` — the variable
 * every E2E fixture already sets, and the one that stops the app opening the
 * user's own profile tree. Any other packaged launch has the switches removed
 * before Chromium starts its DevTools handler (which reads them after the main
 * script has run, in PreMainMessageLoopRun), so no CDP endpoint is opened.
 *
 * This is a narrowing, not a boundary against code already running as the
 * user: that code can set the same variable (and copy a profile into the
 * directory it names). What it does guarantee is that an ordinary launch of
 * the shipped app — the one that holds the user's real profile — never
 * listens for a debugger, and that the remaining test path is renderer-level
 * CDP rather than Node in the main process.
 *
 * Source-tree runs (`app.isPackaged === false`) are left alone: a developer's
 * `electron .` has no fuses and no signed identity to protect.
 */

const GATED_SWITCHES = Object.freeze(['remote-debugging-port', 'remote-debugging-pipe']);
const TEST_PROFILE_VAR = 'FREEDOM_TEST_USER_DATA';

function remoteDebuggingAllowed({ isPackaged, env }) {
  if (!isPackaged) return true;
  return typeof env?.[TEST_PROFILE_VAR] === 'string' && env[TEST_PROFILE_VAR].trim() !== '';
}

// Removes the gated switches from this process's command line unless the
// launch is allowed to keep them. Returns the switches it removed, so the
// caller can log that a debugging request was refused.
function applyRemoteDebuggingGate({ app, env = process.env }) {
  if (remoteDebuggingAllowed({ isPackaged: app.isPackaged, env })) return [];
  const removed = [];
  for (const name of GATED_SWITCHES) {
    if (app.commandLine.hasSwitch(name)) {
      app.commandLine.removeSwitch(name);
      removed.push(name);
    }
  }
  return removed;
}

module.exports = {
  GATED_SWITCHES,
  TEST_PROFILE_VAR,
  remoteDebuggingAllowed,
  applyRemoteDebuggingGate,
};
