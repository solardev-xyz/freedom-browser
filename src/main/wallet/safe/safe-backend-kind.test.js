/**
 * The Safe backend switch (freedom-core design 0016, SAFE-3; the SAFE-3
 * plan's point 4): FREEDOM_SAFE_BACKEND=core|js in development builds,
 * `js` by default and for any other value (warned of once), and always
 * `js` in packaged builds until PR 11; one backend per process.
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const log = require('../../logger');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('FREEDOM_SAFE_BACKEND', () => {
  const { readSafeBackendKind } = require('./safe-backend-kind');

  test.each([
    [false, undefined, 'js'],
    [false, '', 'js'],
    [false, 'js', 'js'],
    [false, 'core', 'core'],
    [false, 'protocol-kit', 'js'],
    [true, undefined, 'js'],
    [true, 'core', 'js'],
    [true, 'js', 'js'],
  ])('packaged %s, FREEDOM_SAFE_BACKEND=%s: %s', (packaged, value, runs) => {
    const env = value === undefined ? {} : { FREEDOM_SAFE_BACKEND: value };
    expect(readSafeBackendKind({ packaged, env })).toBe(runs);
    if (value === 'protocol-kit' && !packaged) {
      expect(log.warn).toHaveBeenCalledWith(
        '[Safe] Unknown FREEDOM_SAFE_BACKEND=protocol-kit; using the JS backend'
      );
    } else {
      expect(log.warn).not.toHaveBeenCalled();
    }
  });

  test('an unknown value is warned of once', () => {
    const env = { FREEDOM_SAFE_BACKEND: 'rust' };
    expect(readSafeBackendKind({ packaged: false, env })).toBe('js');
    expect(readSafeBackendKind({ packaged: false, env })).toBe('js');
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test("a packaged build reads the app's flag", () => {
    const { app } = require('electron');
    const env = { FREEDOM_SAFE_BACKEND: 'core' };
    app.isPackaged = true;
    try {
      expect(readSafeBackendKind({ env })).toBe('js');
    } finally {
      app.isPackaged = false;
    }
    expect(readSafeBackendKind({ env })).toBe('core');
  });

  test("the Ledger's switch is its own", () => {
    const env = { FREEDOM_LEDGER_BACKEND: 'core' };
    expect(readSafeBackendKind({ packaged: false, env })).toBe('js');
    expect(readSafeBackendKind({ packaged: false, env: { FREEDOM_SAFE_BACKEND: 'core' } })).toBe(
      'core'
    );
  });
});

describe('one backend per process', () => {
  const saved = process.env.FREEDOM_SAFE_BACKEND;

  afterEach(() => {
    if (saved === undefined) delete process.env.FREEDOM_SAFE_BACKEND;
    else process.env.FREEDOM_SAFE_BACKEND = saved;
  });

  test.each(['core', 'js'])('the first answer, %s, stays for the process', (first) => {
    jest.isolateModules(() => {
      const { safeBackendKind } = require('./safe-backend-kind');
      process.env.FREEDOM_SAFE_BACKEND = first;
      expect(safeBackendKind()).toBe(first);
      process.env.FREEDOM_SAFE_BACKEND = first === 'core' ? 'js' : 'core';
      expect(safeBackendKind()).toBe(first);
      delete process.env.FREEDOM_SAFE_BACKEND;
      expect(safeBackendKind()).toBe(first);
    });
  });

  test('by default, js', () => {
    jest.isolateModules(() => {
      const { safeBackendKind } = require('./safe-backend-kind');
      delete process.env.FREEDOM_SAFE_BACKEND;
      expect(safeBackendKind()).toBe('js');
    });
  });
});
