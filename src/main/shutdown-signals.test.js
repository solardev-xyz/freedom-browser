const { EventEmitter } = require('events');

const {
  SIGNAL_EXIT_CODES,
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

  test('runs beforeForceExit before a forced exit, and only then', () => {
    const { app, logger, processTarget } = createHarness();
    const order = [];
    const beforeForceExit = jest.fn(() => order.push('flush'));
    app.exit.mockImplementation(() => order.push('exit'));

    registerShutdownSignalHandlers({ app, logger, processTarget, beforeForceExit });
    processTarget.emit('SIGINT');
    expect(beforeForceExit).not.toHaveBeenCalled();
    processTarget.emit('SIGINT');

    expect(order).toEqual(['flush', 'exit']);
  });

  test('a throwing beforeForceExit does not stop the forced exit', () => {
    const { app, logger, processTarget } = createHarness();
    const beforeForceExit = () => {
      throw new Error('disk full');
    };

    registerShutdownSignalHandlers({ app, logger, processTarget, beforeForceExit });
    processTarget.emit('SIGTERM');
    processTarget.emit('SIGTERM');

    expect(app.exit).toHaveBeenCalledWith(SIGNAL_EXIT_CODES.SIGTERM);
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
