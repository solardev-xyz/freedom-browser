const log = require('electron-log');

// Detect environment safely (app.isPackaged is unavailable in test runners)
let isPackaged = false;
try {
  isPackaged = require('electron').app.isPackaged;
} catch {
  // Running outside Electron (e.g., Jest)
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

module.exports = log;
