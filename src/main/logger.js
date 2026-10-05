const log = require('electron-log');
const path = require('path');
const { createLogFileHook, flushLogFileSync, wantsSyncLogFile } = require('./log-file-flush');

// Detect environment safely (app.isPackaged is unavailable in test runners)
let isPackaged = false;
try {
  isPackaged = require('electron').app.isPackaged;
} catch {
  // Running outside Electron (e.g., Jest)
}

const isTestEnv =
  process.env.NODE_ENV === 'test' || Boolean(process.env.JEST_WORKER_ID);

if (isTestEnv) {
  // Jest should not try to write to the user's log directory.
  log.transports.file.level = false;
  log.transports.console.level = process.env.DEBUG ? 'verbose' : false;
} else {
  // Keep E2E logs alongside the fixture's other per-run data. Electron's
  // default logs path is independent of userData (for example,
  // ~/Library/Logs/Freedom Dev on macOS), so redirect the file transport
  // explicitly before its first write.
  if (process.env.FREEDOM_TEST_USER_DATA) {
    log.transports.file.resolvePathFn = () =>
      path.join(process.env.FREEDOM_TEST_USER_DATA, 'logs', 'main.log');
  }

  // File transport captures everything for post-mortem debugging
  log.transports.file.level = 'info';

  // Append off the main thread (#511): electron-log's sync default does an
  // fs.writeFileSync (open, write, close) per line. Set before the first line,
  // which is when electron-log creates the File with this mode.
  //
  // warn and error lines stay crash-safe: the hook writes everything pending
  // and then the warn/error line itself synchronously, in order, before
  // log.warn()/log.error() returns. Only info-and-below lines logged since the
  // last warn/error can be lost on a hang or hard crash (SIGKILL/SIGSEGV run
  // no handler); see log-file-flush.js. Async mode has no flush of its own:
  // this covers process exit, and index.js drains it at the end of the quit
  // wind-down and flushes it before a forced exit. FREEDOM_LOG_SYNC=1 keeps
  // electron-log's all-sync transport, for chasing exactly those cases.
  const syncLogFile = wantsSyncLogFile();
  log.transports.file.sync = syncLogFile;
  if (!syncLogFile) log.hooks.push(createLogFileHook());
  process.on('exit', () => flushLogFileSync(log.transports.file));

  // Console transport: production shows only warnings+errors, dev shows all
  // Set DEBUG=1 to enable verbose console output in production
  if (isPackaged && !process.env.DEBUG) {
    log.transports.console.level = 'warn';
  } else {
    log.transports.console.level = process.env.DEBUG ? 'verbose' : 'info';
  }
}

module.exports = log;
