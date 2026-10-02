const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
};

function createShutdownDiagnostics({
  app,
  logger = console,
  processTarget = process,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let startedAt = null;
  let lastPhase = 'running';
  let timer = null;
  const record = (event, details = {}) => {
    try {
      logger.info('[AppShutdown]', {
        event,
        pid: processTarget.pid,
        parentPid: processTarget.ppid,
        elapsedMs: startedAt === null ? 0 : Date.now() - startedAt,
        ...details,
      });
    } catch {
      // Logging cannot block shutdown.
    }
  };
  const phase = (event) => {
    lastPhase = event;
    record(event);
  };
  const beforeQuit = () => {
    if (startedAt === null) {
      startedAt = Date.now();
      timer = setTimer(() => {
        timer = null;
        const resources = {};
        let processes = [];
        try {
          for (const name of (processTarget.getActiveResourcesInfo?.() || []).slice(0, 256)) {
            if (typeof name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(name)) {
              resources[name] = (resources[name] || 0) + 1;
            }
          }
          processes = (app.getAppMetrics?.() || []).slice(0, 32).map(({ pid, type }) => ({
            pid,
            type: typeof type === 'string' ? type.slice(0, 40) : 'unknown',
          }));
        } catch {
          // Electron metrics may already be unavailable late in shutdown.
        }
        record('shutdown_still_pending', { lastPhase, resources, processes });
      }, 5_000);
      timer.unref?.();
    }
    phase('before_quit');
  };
  const willQuit = () => phase('will_quit');
  const quit = (_event, exitCode) => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    lastPhase = 'quit';
    record('quit', { exitCode });
  };
  const exit = (exitCode) => record('process_exit', { exitCode, lastPhase });
  const signal = (name) => record('signal_received', {
    signal: name,
    stdinIsTTY: processTarget.stdin?.isTTY === true,
    stdoutIsTTY: processTarget.stdout?.isTTY === true,
  });
  app.on('before-quit', beforeQuit);
  app.on('will-quit', willQuit);
  app.on('quit', quit);
  processTarget.on('exit', exit);
  return {
    phase,
    signal,
    dispose() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      app.removeListener('before-quit', beforeQuit);
      app.removeListener('will-quit', willQuit);
      app.removeListener('quit', quit);
      processTarget.removeListener('exit', exit);
    },
  };
}

function callLogger(logger, method, message) {
  if (logger && typeof logger[method] === 'function') {
    logger[method](message);
  }
}

function registerShutdownSignalHandlers({
  app,
  logger = console,
  processTarget = process,
  onSignal = () => {},
} = {}) {
  if (!app || typeof app.quit !== 'function') {
    throw new Error('Electron app with quit() is required for shutdown signal handling');
  }
  if (!processTarget || typeof processTarget.on !== 'function') {
    throw new Error('Process target with on() is required for shutdown signal handling');
  }

  let gracefulShutdownStarted = false;

  const handleSignal = (signal) => {
    try {
      onSignal(signal);
    } catch {
      // Diagnostic observers cannot alter signal handling.
    }
    if (gracefulShutdownStarted) {
      const exitCode = SIGNAL_EXIT_CODES[signal] || 1;
      callLogger(
        logger,
        'warn',
        `[App] Received ${signal} again; forcing shutdown with exit code ${exitCode}`
      );
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
  createShutdownDiagnostics,
  SIGNAL_EXIT_CODES,
  registerShutdownSignalHandlers,
};
