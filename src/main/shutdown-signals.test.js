const { EventEmitter } = require('events');

const {
  SIGNAL_EXIT_CODES,
  createShutdownDiagnostics,
  registerShutdownSignalHandlers,
} = require('./shutdown-signals');

function createHarness() {
  return {
    app: {
      quit: jest.fn(),
      exit: jest.fn(),
    },
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
    },
    processTarget: new EventEmitter(),
  };
}

describe('shutdown signal handlers', () => {
  test('reports a stalled shutdown using only bounded resource and process metadata', () => {
    jest.useFakeTimers();
    const app = new EventEmitter();
    app.getAppMetrics = () => [{ pid: 123, type: 'Utility', name: 'private-path', cpu: {} }];
    const processTarget = new EventEmitter();
    processTarget.pid = 456;
    processTarget.ppid = 455;
    processTarget.getActiveResourcesInfo = () => ['PipeWrap', 'PipeWrap', 'Timeout'];
    const logger = { info: jest.fn() };
    const diagnostics = createShutdownDiagnostics({ app, processTarget, logger });
    try {
      app.emit('before-quit');
      diagnostics.phase('final_quit_requested');
      app.emit('before-quit');
      app.emit('will-quit');
      jest.advanceTimersByTime(5_000);
      expect(logger.info).toHaveBeenCalledWith('[AppShutdown]', expect.objectContaining({
        event: 'shutdown_still_pending',
        lastPhase: 'will_quit',
        resources: { PipeWrap: 2, Timeout: 1 },
        processes: [{ pid: 123, type: 'Utility' }],
      }));
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain('private-path');
      expect(processTarget.listenerCount('SIGTERM')).toBe(0);
      app.emit('quit', {}, 0);
      processTarget.emit('exit', 0);
      expect(logger.info).toHaveBeenLastCalledWith('[AppShutdown]', expect.objectContaining({
        event: 'process_exit', exitCode: 0, lastPhase: 'quit',
      }));
    } finally {
      diagnostics.dispose();
      jest.useRealTimers();
    }
  });

  test('successful shutdown cancels diagnostic timers without changing signal behavior', () => {
    jest.useFakeTimers();
    const app = Object.assign(new EventEmitter(), { quit: jest.fn(), exit: jest.fn() });
    const processTarget = new EventEmitter();
    const logger = { info: jest.fn(), warn: jest.fn() };
    const diagnostics = createShutdownDiagnostics({ app, processTarget, logger });
    const unregister = registerShutdownSignalHandlers({
      app, processTarget, logger, onSignal: diagnostics.signal,
    });
    try {
      processTarget.emit('SIGINT');
      expect(app.quit).toHaveBeenCalledTimes(1);
      app.emit('before-quit');
      app.emit('quit', {}, 0);
      jest.advanceTimersByTime(6_000);
      expect(logger.info.mock.calls.some(([, event]) => event?.event === 'shutdown_still_pending'))
        .toBe(false);
      unregister();
      expect(processTarget.listenerCount('SIGINT')).toBe(0);
      expect(processTarget.listenerCount('SIGTERM')).toBe(0);
    } finally {
      unregister();
      diagnostics.dispose();
      jest.useRealTimers();
    }
  });

  test('turns the first SIGINT into a graceful app quit', () => {
    const { app, logger, processTarget } = createHarness();

    registerShutdownSignalHandlers({ app, logger, processTarget });
    processTarget.emit('SIGINT');

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.exit).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      '[App] Received SIGINT; starting graceful shutdown. Send SIGINT again to force exit.'
    );
  });

  test('forces exit on a repeated SIGINT', () => {
    const { app, logger, processTarget } = createHarness();

    registerShutdownSignalHandlers({ app, logger, processTarget });
    processTarget.emit('SIGINT');
    processTarget.emit('SIGINT');

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.exit).toHaveBeenCalledWith(SIGNAL_EXIT_CODES.SIGINT);
    expect(logger.warn).toHaveBeenCalledWith(
      '[App] Received SIGINT again; forcing shutdown with exit code 130'
    );
  });

  test('uses the SIGTERM exit code when SIGTERM repeats', () => {
    const { app, logger, processTarget } = createHarness();

    registerShutdownSignalHandlers({ app, logger, processTarget });
    processTarget.emit('SIGTERM');
    processTarget.emit('SIGTERM');

    expect(app.exit).toHaveBeenCalledWith(SIGNAL_EXIT_CODES.SIGTERM);
  });

  test('unregisters signal handlers', () => {
    const { app, logger, processTarget } = createHarness();
    const unregister = registerShutdownSignalHandlers({ app, logger, processTarget });

    unregister();
    processTarget.emit('SIGINT');

    expect(app.quit).not.toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();
  });
});
