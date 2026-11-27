/**
 * The Ledger backend switch (freedom-core design 0016, LDG-3; the LDG-3
 * plan's point 14): FREEDOM_LEDGER_BACKEND=core|js in development builds,
 * `js` by default and for any other value (warned of once), and always
 * `js` in packaged builds until PR 14; one backend per process.
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const log = require('../../logger');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('FREEDOM_LEDGER_BACKEND', () => {
  const { readLedgerBackendKind } = require('./ledger-backend-kind');

  test.each([
    [false, undefined, 'js'],
    [false, '', 'js'],
    [false, 'js', 'js'],
    [false, 'core', 'core'],
    [false, 'rust', 'js'],
    [true, undefined, 'js'],
    [true, 'core', 'js'],
    [true, 'js', 'js'],
  ])('packaged %s, FREEDOM_LEDGER_BACKEND=%s: %s', (packaged, value, runs) => {
    const env = value === undefined ? {} : { FREEDOM_LEDGER_BACKEND: value };
    expect(readLedgerBackendKind({ packaged, env })).toBe(runs);
    if (value === 'rust' && !packaged) {
      expect(log.warn).toHaveBeenCalledWith(
        '[Ledger] Unknown FREEDOM_LEDGER_BACKEND=rust; using the JS backend'
      );
    } else {
      expect(log.warn).not.toHaveBeenCalled();
    }
  });

  test('an unknown value is warned of once', () => {
    const env = { FREEDOM_LEDGER_BACKEND: 'hw-app-eth' };
    expect(readLedgerBackendKind({ packaged: false, env })).toBe('js');
    expect(readLedgerBackendKind({ packaged: false, env })).toBe('js');
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test("a packaged build reads the app's flag", () => {
    const { app } = require('electron');
    const env = { FREEDOM_LEDGER_BACKEND: 'core' };
    app.isPackaged = true;
    try {
      expect(readLedgerBackendKind({ env })).toBe('js');
    } finally {
      app.isPackaged = false;
    }
    expect(readLedgerBackendKind({ env })).toBe('core');
  });
});

describe('one backend per process', () => {
  const saved = process.env.FREEDOM_LEDGER_BACKEND;

  afterEach(() => {
    if (saved === undefined) delete process.env.FREEDOM_LEDGER_BACKEND;
    else process.env.FREEDOM_LEDGER_BACKEND = saved;
  });

  test.each(['core', 'js'])('the first answer, %s, stays for the process', (first) => {
    jest.isolateModules(() => {
      const { ledgerBackendKind } = require('./ledger-backend-kind');
      process.env.FREEDOM_LEDGER_BACKEND = first;
      expect(ledgerBackendKind()).toBe(first);
      process.env.FREEDOM_LEDGER_BACKEND = first === 'core' ? 'js' : 'core';
      expect(ledgerBackendKind()).toBe(first);
      delete process.env.FREEDOM_LEDGER_BACKEND;
      expect(ledgerBackendKind()).toBe(first);
    });
  });

  test('by default, js', () => {
    jest.isolateModules(() => {
      const { ledgerBackendKind } = require('./ledger-backend-kind');
      delete process.env.FREEDOM_LEDGER_BACKEND;
      expect(ledgerBackendKind()).toBe('js');
    });
  });
});
