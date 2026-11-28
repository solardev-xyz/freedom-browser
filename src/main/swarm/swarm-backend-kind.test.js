/**
 * The Swarm backend switch (freedom-core design 0015, SWM-5's calls; the
 * 2026-11-28 amendment, "SWM-6 to SWM-9's plan", point 1):
 * FREEDOM_SWARM_BACKEND=core|js in development builds, `js` by default and
 * for any other value (warned of once), and always `js` in packaged builds
 * until SWM-9; one backend per process, read once and never again.
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const log = require('../logger');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('FREEDOM_SWARM_BACKEND', () => {
  const { readSwarmBackendKind } = require('./swarm-backend-kind');

  test.each([
    [false, undefined, 'js'],
    [false, '', 'js'],
    [false, 'js', 'js'],
    [false, 'core', 'core'],
    [false, 'rust', 'js'],
    [true, undefined, 'js'],
    [true, 'core', 'js'],
    [true, 'js', 'js'],
  ])('packaged %s, FREEDOM_SWARM_BACKEND=%s: %s', (packaged, value, runs) => {
    const env = value === undefined ? {} : { FREEDOM_SWARM_BACKEND: value };
    expect(readSwarmBackendKind({ packaged, env })).toBe(runs);
    if (value === 'rust' && !packaged) {
      expect(log.warn).toHaveBeenCalledWith(
        '[Swarm] Unknown FREEDOM_SWARM_BACKEND=rust; using the JS backend'
      );
    } else {
      expect(log.warn).not.toHaveBeenCalled();
    }
  });

  test("a packaged build reads the app's flag", () => {
    const { app } = require('electron');
    const env = { FREEDOM_SWARM_BACKEND: 'core' };
    app.isPackaged = true;
    try {
      expect(readSwarmBackendKind({ env })).toBe('js');
    } finally {
      app.isPackaged = false;
    }
    expect(readSwarmBackendKind({ env })).toBe('core');
  });
});

describe('one backend per process', () => {
  const saved = process.env;

  afterEach(() => {
    process.env = saved;
  });

  /**
   * `process.env` as a copy whose reads of FREEDOM_SWARM_BACKEND are
   * counted, set to `value` (none for undefined).
   */
  function countedEnv(value) {
    const env = { ...saved };
    if (value === undefined) delete env.FREEDOM_SWARM_BACKEND;
    else env.FREEDOM_SWARM_BACKEND = value;
    const counted = { reads: 0 };
    process.env = new Proxy(env, {
      get(target, name) {
        if (name === 'FREEDOM_SWARM_BACKEND') counted.reads += 1;
        return target[name];
      },
    });
    return counted;
  }

  test.each(['core', 'js'])(
    'the first answer, %s, stays for the process: the environment is read once, never again',
    (first) => {
      jest.isolateModules(() => {
        const { swarmBackendKind } = require('./swarm-backend-kind');
        const counted = countedEnv(first);
        expect(swarmBackendKind()).toBe(first);
        expect(counted.reads).toBe(1);
        process.env.FREEDOM_SWARM_BACKEND = first === 'core' ? 'js' : 'core';
        expect(swarmBackendKind()).toBe(first);
        delete process.env.FREEDOM_SWARM_BACKEND;
        expect(swarmBackendKind()).toBe(first);
        process.env = { FREEDOM_SWARM_BACKEND: first === 'core' ? 'js' : 'core' };
        expect(swarmBackendKind()).toBe(first);
        expect(counted.reads).toBe(1);
      });
    }
  );

  test('by default, js; an unknown value is js, warned of once', () => {
    jest.isolateModules(() => {
      const { swarmBackendKind } = require('./swarm-backend-kind');
      countedEnv(undefined);
      expect(swarmBackendKind()).toBe('js');
    });
    jest.isolateModules(() => {
      const { swarmBackendKind } = require('./swarm-backend-kind');
      const isolatedLog = require('../logger');
      const counted = countedEnv('bee-js');
      expect(swarmBackendKind()).toBe('js');
      expect(swarmBackendKind()).toBe('js');
      expect(counted.reads).toBe(1);
      expect(isolatedLog.warn).toHaveBeenCalledTimes(1);
    });
  });

  test('the reading itself reads the switch each time it is asked', () => {
    const { readSwarmBackendKind } = require('./swarm-backend-kind');
    const counted = countedEnv('core');
    expect(readSwarmBackendKind()).toBe('core');
    process.env.FREEDOM_SWARM_BACKEND = 'js';
    expect(readSwarmBackendKind()).toBe('js');
    expect(counted.reads).toBe(2);
  });
});
