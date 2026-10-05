const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
};

function callLogger(logger, method, message) {
  if (logger && typeof logger[method] === 'function') {
    logger[method](message);
  }
}

function registerShutdownSignalHandlers({
  app,
  logger = console,
  processTarget = process,
  // Runs right before a forced exit: app.exit() skips every quit event, so
  // anything still buffered (an async log file) has to be written here.
  beforeForceExit = null,
} = {}) {
  if (!app || typeof app.quit !== 'function') {
    throw new Error('Electron app with quit() is required for shutdown signal handling');
  }
  if (!processTarget || typeof processTarget.on !== 'function') {
    throw new Error('Process target with on() is required for shutdown signal handling');
  }

  let gracefulShutdownStarted = false;

  const handleSignal = (signal) => {
    if (gracefulShutdownStarted) {
      const exitCode = SIGNAL_EXIT_CODES[signal] || 1;
      callLogger(
        logger,
        'warn',
        `[App] Received ${signal} again; forcing shutdown with exit code ${exitCode}`
      );
      if (typeof beforeForceExit === 'function') {
        try {
          beforeForceExit();
        } catch {
          // A failed flush must not stop the forced exit.
        }
      }
      if (typeof app.exit === 'function') {
        app.exit(exitCode);
      } else if (typeof processTarget.exit === 'function') {
        processTarget.exit(exitCode);
      }
      return;
    }

    gracefulShutdownStarted = true;
    callLogger(
      logger,
      'info',
      `[App] Received ${signal}; starting graceful shutdown. Send ${signal} again to force exit.`
    );
    app.quit();
  };

  const handleSigint = () => handleSignal('SIGINT');
  const handleSigterm = () => handleSignal('SIGTERM');

  processTarget.on('SIGINT', handleSigint);
  processTarget.on('SIGTERM', handleSigterm);

  return () => {
    if (typeof processTarget.off === 'function') {
      processTarget.off('SIGINT', handleSigint);
      processTarget.off('SIGTERM', handleSigterm);
      return;
    }
    if (typeof processTarget.removeListener === 'function') {
      processTarget.removeListener('SIGINT', handleSigint);
      processTarget.removeListener('SIGTERM', handleSigterm);
    }
  };
}

module.exports = {
  SIGNAL_EXIT_CODES,
  registerShutdownSignalHandlers,
};
