// Bounded app teardown for every E2E fixture that launches Freedom (#535).
//
// Playwright's `ElectronApplication.close()` (playwright-core 1.63) runs
// `app.quit()` in the main process and then waits for the process to exit with
// no deadline of its own. A quit that never finishes — a `will-quit` handler
// awaiting something that never settles, a helper process keeping the main
// process alive — therefore parks the fixture's teardown on that promise.
// What the job log shows then is, at best, Playwright's generic "exceeded
// while tearing down electronApp", and at worst nothing until the job's
// `timeout-minutes` cancels the whole run with no log at all.
//
// `closeApp` gives the quit a deadline. If the app is still running when it
// passes, it prints what is still alive (the Electron process tree, and on
// macOS a short `sample` of the main process's stacks), SIGKILLs the tree, and
// throws, so the test fails right there with the diagnostics in the log.
//
// Errors from `close()` itself are still swallowed, as every fixture did
// before: a spec may already have closed the window or quit the app.
//
// It also owns the failure screenshot. `playwright.config.js` used to ask for
// `screenshot: 'only-on-failure'`, and Playwright implements that by
// screenshotting *every* page of the context, pass or fail, just before the
// context closes (playwright 1.63 `ArtifactsRecorder.willCloseBrowserContext`
// → `captureTemporary`, 5 s timeout per page) and keeping the files only if
// the test failed. An Electron context lists each tab's `<webview>` guest as a
// page, and a background tab's guest never produces a frame, so every test
// that left a second tab open paid the full 5 s at teardown: measured on
// `tabs.spec.js`, 14 of 20 closes took 5.13–5.30 s; with this file taking the
// screenshot instead, all 20 took 0.13–0.18 s. Here only the chrome window is captured, only on failure.

const { execFileSync } = require('child_process');
const { test } = require('@playwright/test');

// A harness app quits in well under a second (measured locally: 0.13–0.18 s
// across all of `tabs.spec.js`). Fifteen seconds is long enough that only a
// stuck quit reaches it, and short enough to fit inside a 30 s test budget.
const DEFAULT_CLOSE_TIMEOUT_MS = 15_000;

class AppCloseTimeoutError extends Error {}

function run(cmd, args, timeout = 10_000) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `(${cmd} failed: ${err.message.split('\n')[0]})\n${err.stdout || ''}`;
  }
}

// Every process whose ancestry reaches `rootPid`, from one `ps` snapshot.
// Returns [{ pid, line }], root first.
function processTree(rootPid) {
  if (process.platform === 'win32') {
    const out = run('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }',
    ]);
    return treeFrom(out, rootPid);
  }
  return treeFrom(run('ps', ['-axo', 'pid=,ppid=,etime=,stat=,command=']), rootPid);
}

function treeFrom(psOutput, rootPid) {
  const rows = psOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid] = line.split(/\s+/, 2).map(Number);
      return { pid, ppid, line };
    })
    .filter((row) => Number.isInteger(row.pid));
  const keep = new Set([rootPid]);
  // Iterate to a fixpoint: `ps` order is not guaranteed to put parents first.
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (!keep.has(row.pid) && keep.has(row.ppid)) {
        keep.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => keep.has(row.pid));
}

function describeStuckApp(pid) {
  const tree = processTree(pid);
  const parts = [
    `Electron main process pid ${pid}; process tree (${tree.length}):`,
    ...tree.map((row) => `  ${row.line}`),
  ];
  if (process.platform === 'darwin') {
    // `sample` ships with macOS; two seconds of the main process's stacks show
    // which handler the quit is parked in.
    const sample = run('sample', [String(pid), '2'], 20_000);
    parts.push('sample of the main process (first 80 lines):', ...sample.split('\n').slice(0, 80));
  }
  return parts.join('\n');
}

function killTree(pid) {
  const pids = processTree(pid).map((row) => row.pid);
  for (const target of pids.length ? pids : [pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

// Same pattern packaged-launch.js uses: the browser window's chrome document,
// as opposed to the tab `<webview>` guests that are pages of the same context.
const CHROME_PAGE = /\/renderer\/index\.html(?:[?#]|$)/;

async function attachFailureScreenshots(app, label) {
  let info;
  try {
    info = test.info();
  } catch {
    return; // not inside a test
  }
  if (info.status === info.expectedStatus) return;
  let pages;
  try {
    pages = app.windows().filter((page) => CHROME_PAGE.test(page.url()));
  } catch {
    return;
  }
  await Promise.all(
    pages.map(async (page, i) => {
      try {
        // A file under the test's output dir, not an in-memory body: CI
        // uploads `test-results/`, and only the HTML reporter keeps bodies.
        const file = info.outputPath(`${label}-window-${i + 1}-failed.png`);
        await page.screenshot({ path: file, timeout: 5_000, caret: 'initial' });
        await info.attach(`${label}-window-${i + 1}`, { path: file, contentType: 'image/png' });
      } catch {
        // A window that cannot paint any more is not worth failing teardown over.
      }
    })
  );
}

function isRunning(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

async function closeApp(app, { timeout = DEFAULT_CLOSE_TIMEOUT_MS, label = 'electronApp' } = {}) {
  let child = null;
  try {
    child = app.process();
  } catch {
    // Not every app object exposes the process; then there is nothing to kill.
  }

  await attachFailureScreenshots(app, label);

  let timer = null;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeout);
  });
  const closed = Promise.resolve()
    .then(() => app.close())
    .then(
      () => 'closed',
      () => 'closed' // already closed by the spec, or the connection is gone
    );

  let outcome;
  try {
    outcome = await Promise.race([closed, timedOut]);
  } finally {
    clearTimeout(timer);
  }
  if (outcome === 'closed' || !isRunning(child)) return;

  const diagnostics = describeStuckApp(child.pid);
  killTree(child.pid);
  const message =
    `${label}: app.close() did not return within ${timeout / 1000}s and the app ` +
    `was still running, so it was killed (#535).\n${diagnostics}`;
  // Printed as well as thrown: a teardown error can be reported after the
  // test's own failure and is easy to miss in a long list-reporter log.
  console.error(message);
  throw new AppCloseTimeoutError(message);
}

module.exports = { closeApp, AppCloseTimeoutError, DEFAULT_CLOSE_TIMEOUT_MS, treeFrom };
