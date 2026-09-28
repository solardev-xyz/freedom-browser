// Where an E2E launch points: the repo checkout, or a packaged artifact.
//
// Both fixture files have to answer that question the same way before they do
// anything else, and they answer nothing else the same way (`fixtures.js`
// launches with FREEDOM_TEST_MODE and harness stubs, `live-fixtures.js`
// deliberately without). Keeping just the target decision here is what lets
// the live-style launch drive a package too — that is the `packaged-live`
// project (test-e2e/packaged-live/), which starts the real node managers
// inside a built artifact.
//
// With FREEDOM_E2E_EXECUTABLE unset this reproduces what both fixtures did
// before: `args: ['.']`, no executablePath, no --no-sandbox.
//
// It also owns *how* a packaged artifact is launched (`launchApp`). Playwright's
// `_electron.launch` cannot drive one: it attaches to the main process over
// `--inspect`, and packaged builds ship with the EnableNodeCliInspectArguments
// fuse off (docs/security-audit-electron.md, O-4), so the flag is ignored and
// the launch would wait forever for a Node inspector. A packaged run instead
// starts the binary itself with `--remote-debugging-port=0` and connects
// Playwright over CDP. The app only honours that switch when the launch points
// at a scratch profile through FREEDOM_TEST_USER_DATA (src/main/
// remote-debugging-gate.js), which both fixture files always set.
//
// What that costs: there is no `electronApp.evaluate()` in the main process.
// Packaged specs read main-process facts through the FREEDOM_TEST_MODE
// harness's fixed operations instead (`electronApp.appFacts()` /
// `electronApp.testOp()`, see src/main/test-harness.js), and everything else
// through the chrome window like any renderer spec.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { _electron: electron, chromium } = require('@playwright/test');

const EXECUTABLE_VAR = 'FREEDOM_E2E_EXECUTABLE';
const NO_SANDBOX_VAR = 'FREEDOM_E2E_NO_SANDBOX';
// Set by `npm run test:e2e:screenshots` (#261 item 1c). Chromium promotes a
// composited layer to greyscale text antialiasing and demotes it back to
// subpixel (LCD) as layers come and go, which repaints every glyph on the
// surface with different colour fringes — ~1% of the frame, on a page nothing
// changed on. That is bistable rather than random, so it does not settle with
// a longer wait; turning LCD text off makes the rasterisation deterministic.
// Only the screenshot spec sets it, so nothing else changes how it renders.
const STABLE_TEXT_VAR = 'FREEDOM_E2E_STABLE_TEXT';

// Trimmed, because shells (and YAML `env:` blocks) capture stray whitespace
// into a value and `executablePath: '/opt/Freedom/freedom '` would fail with
// a confusing ENOENT. `preflight.setup.js` trims the same way.
function packagedExecutable() {
  return (process.env[EXECUTABLE_VAR] || '').trim();
}

// True when this run drives a built artifact rather than the source tree.
function isPackagedRun() {
  return packagedExecutable() !== '';
}

// The electron.launch() options that differ between the two targets. A source
// run passes `.` so Electron loads the repo as its app directory; a packaged
// binary already embeds its app, so it gets no positional argument at all.
function packagedLaunchTarget() {
  const executable = packagedExecutable();
  const args = [];

  if (!executable) {
    args.push('.');
  } else if ((process.env[NO_SANDBOX_VAR] || '').trim() === '1') {
    // Headless CI runners generally cannot use Chromium's setuid/namespace
    // sandbox. Only ever passed in packaged mode — a source run under
    // `npm run test:e2e` / `npm run test:e2e:live` keeps the sandbox on.
    args.push('--no-sandbox');
  }

  if ((process.env[STABLE_TEXT_VAR] || '').trim() === '1') {
    args.push('--disable-lcd-text', '--disable-font-subpixel-positioning');
  }

  return {
    ...(executable ? { executablePath: executable } : {}),
    args,
  };
}

// The chrome of a BrowserWindow. `context().pages()` also lists every tab
// webview, which Playwright's ElectronApplication.windows() counted too; the
// fixtures only ever want the browser window.
const CHROME_PAGE = /\/renderer\/index\.html(?:[?#]|$)/;
const DEVTOOLS_LINE = /^DevTools listening on (ws:\/\/\S+)\s*$/m;
const OUTPUT_TAIL_BYTES = 64 * 1024;
// How long a graceful quit (CDP Browser.close → app.quit(), with every node
// manager stopping) may take before the process is killed. Generous on
// purpose: a hard kill is reported as such (see live-fixtures' watchProcessExit)
// rather than hidden, but it should only ever mean "hung".
const QUIT_TIMEOUT_MS = 90_000;

function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// Stand-in for Playwright's ElectronApplication for a packaged binary driven
// over CDP. Implements what the fixtures and packaged specs use; anything that
// needs the main-process inspector fails loudly instead of hanging.
class PackagedElectronApp extends EventEmitter {
  constructor(child, browser, output, readOutput) {
    super();
    this._child = child;
    this._browser = browser;
    this._output = output;
    this._readOutput = readOutput;
    this._closing = null;
    child.once('exit', () => this.emit('close'));
  }

  process() {
    return this._child;
  }

  // The last 64 KiB the app wrote to stdout/stderr since launch.
  outputText() {
    return this._readOutput();
  }

  context() {
    return this._browser.contexts()[0];
  }

  windows() {
    return this.context()
      .pages()
      .filter((page) => CHROME_PAGE.test(page.url()));
  }

  async firstWindow({ timeout = 30_000 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const [window] = this.windows();
      if (window) return window;
      if (this._child.exitCode !== null || this._child.signalCode !== null) {
        throw new Error(`The packaged app exited before opening a window.\n${this._output()}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`No browser window appeared within ${timeout}ms.\n${this._output()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // A named FREEDOM_TEST_MODE harness operation (see preload.js `freedomTest`).
  async testOp(op, payload) {
    const chrome = await this.firstWindow();
    return chrome.evaluate(
      async ([name, data]) => {
        if (!window.freedomTest) {
          throw new Error('The test harness bridge is missing: launch with FREEDOM_TEST_MODE=1');
        }
        return window.freedomTest.invoke(name, data);
      },
      [op, payload]
    );
  }

  appFacts() {
    return this.testOp('app-facts');
  }

  evaluate() {
    throw new Error(
      'electronApp.evaluate() is not available against a packaged build: its ' +
        'EnableNodeCliInspectArguments fuse is off, so there is no main-process inspector to ' +
        'evaluate in. Use electronApp.appFacts() / electronApp.testOp() or evaluate in a window.'
    );
  }

  // Quit the way a user does: CDP Browser.close runs Electron's app.quit()
  // (before-quit, will-quit, the app's own shutdown), then wait for the
  // process to exit. Idempotent, like ElectronApplication.close().
  close() {
    if (!this._closing) {
      this._closing = (async () => {
        if (this._child.exitCode === null && this._child.signalCode === null) {
          try {
            const session = await this._browser.newBrowserCDPSession();
            // Not awaited: Electron quits without ever answering the command
            // (the reply stays pending even after the process has exited), so
            // the process exit below is the only completion signal.
            session.send('Browser.close').catch(() => {});
          } catch {
            // Connection already gone; the exit wait below decides.
          }
          if (!(await waitForExit(this._child, QUIT_TIMEOUT_MS))) {
            this._child.kill('SIGKILL');
            await waitForExit(this._child, 10_000);
          }
        }
        // Drop Playwright's side of the connection; bounded, since the peer
        // is already gone.
        await Promise.race([
          this._browser.close().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
      })();
    }
    return this._closing;
  }
}

async function launchPackagedApp({ executablePath, args = [], env, cwd, timeout = 45_000 }) {
  const launchEnv = { ...(env || process.env) };
  delete launchEnv.NODE_OPTIONS;
  const child = spawn(executablePath, [...args, '--remote-debugging-port=0'], {
    cwd,
    env: launchEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let tail = '';
  const collect = (chunk) => {
    tail = (tail + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
  };
  const output = () => (tail ? `--- app output ---\n${tail}` : '(the app printed nothing)');
  child.stdout.on('data', collect);

  const wsEndpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const fail = (message) => {
      cleanup();
      child.kill('SIGKILL');
      reject(new Error(`${message}\n${output()}`));
    };
    const onData = (chunk) => {
      collect(chunk);
      stderr += chunk.toString();
      const match = DEVTOOLS_LINE.exec(stderr);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onExit = (code, signal) =>
      fail(
        `The packaged app exited (code ${code}, signal ${signal}) before its DevTools endpoint came up.`
      );
    const onError = (error) => fail(`Could not start ${executablePath}: ${error.message}`);
    const timer = setTimeout(
      () =>
        fail(
          `No "DevTools listening" line from ${executablePath} within ${timeout}ms. A packaged ` +
            'build only honours --remote-debugging-port when FREEDOM_TEST_USER_DATA names a ' +
            'scratch profile (src/main/remote-debugging-gate.js).'
        ),
      timeout
    );
    function cleanup() {
      clearTimeout(timer);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      // Keep draining stderr so a chatty app never blocks on a full pipe.
      child.stderr.on('data', collect);
    }
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });

  let browser;
  try {
    browser = await chromium.connectOverCDP(wsEndpoint, { timeout });
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`Could not attach over CDP to ${wsEndpoint}: ${error.message}\n${output()}`, {
      cause: error,
    });
  }
  return new PackagedElectronApp(child, browser, output, () => tail);
}

// The one launch entry point for both fixture files: Playwright's own Electron
// launcher for a source run, the CDP launcher above for a packaged artifact.
function launchApp(options) {
  return isPackagedRun() ? launchPackagedApp(options) : electron.launch(options);
}

module.exports = {
  EXECUTABLE_VAR,
  NO_SANDBOX_VAR,
  STABLE_TEXT_VAR,
  packagedExecutable,
  isPackagedRun,
  packagedLaunchTarget,
  launchApp,
  launchPackagedApp,
  CHROME_PAGE,
};
