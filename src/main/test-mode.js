/**
 * Whether the E2E test harness (src/main/test-harness.js: stub protocols,
 * `test:*` IPC, fixture-served content) may be switched on for this process.
 * Every reader of FREEDOM_TEST_MODE goes through here so the rule lives in one
 * place.
 *
 * docs/security-audit-electron.md, O-12: the harness used to follow the
 * `FREEDOM_TEST_MODE=1` env var alone, in shipped builds too. Now:
 *
 *   source tree (`!app.isPackaged`)                        → env var decides
 *   packaged build, env var + an honoured CDP debug port   → on
 *   packaged build otherwise                               → off, always
 *
 * The packaged exception exists for the release smoke tests
 * (test-e2e/packaged, `npm run test:e2e:packaged` in release.yml), which drive
 * the *shipped* binary through the harness. Packaged builds ship with the
 * `EnableNodeCliInspectArguments` fuse off (O-4), so those tests cannot use
 * Playwright's `_electron.launch()` (it needs `--inspect`); the launcher in
 * test-e2e/packaged-launch.js starts the binary with
 * `--remote-debugging-port=0` and attaches over CDP instead. So the second
 * condition is that switch, as it survives src/main/remote-debugging-gate.js:
 * a packaged build keeps it only when FREEDOM_TEST_USER_DATA points the launch
 * at a scratch profile, and removes it otherwise, before this is read.
 *
 * Why that adds nothing a launch with the port does not already have: the CDP
 * endpoint gives whoever reaches it full control of every renderer, the
 * privileged chrome window included — it can read and drive the chrome, call
 * every IPC the chrome's preload exposes, and make any tab show anything. The
 * harness adds `test:*` IPC reachable only from that same chrome window,
 * fixture-backed stubs for bzz:/ipfs:/ipns:/web3:/ENS, and no-op node
 * start/stop, all scoped to the scratch profile the gate already required. It
 * adds no main-process code execution (there is no evaluate hook; `test:*` ops
 * are fixed and `test:app-facts` is read-only) and nothing that outlives the
 * process. The env var alone (a stray export, a launcher script, another
 * program's environment) still never turns the harness on in a shipped build;
 * only a launch that has already opened a debugging port on a scratch profile
 * does. Both are read once, at startup: the switch cannot be added to a
 * running process's command line from outside.
 *
 * Only `--remote-debugging-port` with a plain decimal port (0–65534, the
 * launcher passes 0) counts; `--remote-debugging-pipe` is not what the launcher
 * uses. Anything else is refused on purpose, not because it opens no endpoint:
 * observed 2026-09-28 on the Electron 44 Linux build, `abc`, `-1` and `65535`
 * all fall back to an ephemeral port and still listen. Refusing them only means
 * the harness never depends on that fallback, and it errs towards "off".
 */

const DEBUG_PORT_SWITCH = 'remote-debugging-port';

// Passed to the chrome window's renderer (webPreferences.additionalArguments)
// when the harness is on, so preload.js exposes its bridge from this verdict
// instead of re-reading the env var.
const TEST_HARNESS_RENDERER_ARG = '--freedom-test-harness';

// The shapes Chromium's DevTools handler parses as a real port: 0 (ephemeral)
// through 65534, decimal digits only.
function isListenablePort(value) {
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) return false;
  const port = Number(value);
  return port >= 0 && port < 65535;
}

function remoteDebuggingPortOpen({ app, env = process.env } = {}) {
  try {
    if (!app) app = require('electron').app;
    const { remoteDebuggingAllowed } = require('./remote-debugging-gate');
    // Re-applies the gate's own rule, so the answer does not depend on
    // whether applyRemoteDebuggingGate already ran when this is first read.
    if (!remoteDebuggingAllowed({ isPackaged: app.isPackaged, env })) return false;
    if (!app.commandLine.hasSwitch(DEBUG_PORT_SWITCH)) return false;
    return isListenablePort(app.commandLine.getSwitchValue(DEBUG_PORT_SWITCH));
  } catch {
    return false;
  }
}

/**
 * @param {Object} [options]
 * @param {Object} [options.env]
 * @param {boolean} [options.isPackaged]
 * @param {() => boolean} [options.debugPortOpen]
 */
function isTestModeRequested({
  env = process.env,
  isPackaged = require('electron').app?.isPackaged === true,
  debugPortOpen = () => remoteDebuggingPortOpen({ env }),
} = {}) {
  if (env.FREEDOM_TEST_MODE !== '1') return false;
  if (!isPackaged) return true;
  return debugPortOpen() === true;
}

module.exports = {
  TEST_HARNESS_RENDERER_ARG,
  isTestModeRequested,
  remoteDebuggingPortOpen,
  isListenablePort,
};
