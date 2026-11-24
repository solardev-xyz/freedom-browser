/**
 * The development switch between Colibri's WASM verifier and freedom-colibrid
 * (freedom-core design 0014, COL-5): WASM by default and always in a packaged
 * build; the service only when a development build names it.
 */

const mockWarn = jest.fn();
jest.mock('../logger', () => ({ warn: (...args) => mockWarn(...args), info: jest.fn() }));

const ENV = 'FREEDOM_COLIBRI_BACKEND';

/** colibri-backend.js, fresh, with `electron` giving `app`. */
function load(app) {
  let mod;
  jest.isolateModules(() => {
    jest.doMock('electron', () => ({ app }));
    mod = require('./colibri-backend');
  });
  return mod;
}

let savedEnv;

beforeEach(() => {
  mockWarn.mockReset();
  savedEnv = process.env[ENV];
  delete process.env[ENV];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe('colibriBackendKind', () => {
  test.each([
    ['a development build, by default', 'wasm', false, undefined],
    ['a development build, WASM named', 'wasm', false, 'wasm'],
    ['a development build, the service named', 'service', false, 'service'],
    ['a development build, the variable empty', 'wasm', false, ''],
    ['a development build, an unknown value', 'wasm', false, 'colibrid'],
    ['a development build, the service named in another case', 'wasm', false, 'Service'],
    ['a packaged build, by default', 'wasm', true, undefined],
    ['a packaged build, the service named', 'wasm', true, 'service'],
    ['a packaged build, an unknown value', 'wasm', true, 'colibrid'],
  ])('%s: runs %s', (_label, runs, packaged, value) => {
    const { colibriBackendKind } = load({ isPackaged: false });
    const env = value === undefined ? {} : { [ENV]: value };
    expect(colibriBackendKind({ packaged, env })).toBe(runs);
    if (!packaged && (value === 'colibrid' || value === 'Service')) {
      expect(mockWarn).toHaveBeenCalledWith(
        `[colibri] Unknown FREEDOM_COLIBRI_BACKEND=${value}; using the WASM verifier`
      );
      expect(mockWarn).toHaveBeenCalledTimes(1);
    } else {
      expect(mockWarn).not.toHaveBeenCalled();
    }
  });

  test('an unknown value is warned of once, and another one again', () => {
    const { colibriBackendKind } = load({ isPackaged: false });
    const env = { [ENV]: 'native' };
    expect(colibriBackendKind({ packaged: false, env })).toBe('wasm');
    expect(colibriBackendKind({ packaged: false, env })).toBe('wasm');
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(colibriBackendKind({ packaged: false, env: { [ENV]: 'colibrid' } })).toBe('wasm');
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  test('by default it reads the app and the process environment', () => {
    process.env[ENV] = 'service';
    expect(load({ isPackaged: false }).colibriBackendKind()).toBe('service');
    expect(load({ isPackaged: true }).colibriBackendKind()).toBe('wasm');
    delete process.env[ENV];
    expect(load({ isPackaged: false }).colibriBackendKind()).toBe('wasm');
  });

  test('outside Electron (no app) it is a development build', () => {
    process.env[ENV] = 'service';
    expect(load(undefined).colibriBackendKind()).toBe('service');
  });
});
