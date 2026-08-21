const log = require('electron-log');
const path = require('path');

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

  // Console transport: production shows only warnings+errors, dev shows all
  // Set DEBUG=1 to enable verbose console output in production
  if (isPackaged && !process.env.DEBUG) {
    log.transports.console.level = 'warn';
  } else {
    log.transports.console.level = process.env.DEBUG ? 'verbose' : 'info';
  }
}

module.exports = log;
