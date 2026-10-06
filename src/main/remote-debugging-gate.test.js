const fs = require('fs');
const path = require('path');
const {
  GATED_SWITCHES,
  remoteDebuggingAllowed,
  applyRemoteDebuggingGate,
} = require('./remote-debugging-gate');

// A stand-in for app.commandLine: a set of switch names.
function fakeApp({ isPackaged, switches = [] }) {
  const present = new Set(switches);
  return {
    isPackaged,
    present,
    commandLine: {
      hasSwitch: (name) => present.has(name),
      removeSwitch: (name) => present.delete(name),
    },
  };
}

describe('remote-debugging gate', () => {
  test('covers both Chromium remote-debugging transports', () => {
    expect([...GATED_SWITCHES].sort()).toEqual(['remote-debugging-pipe', 'remote-debugging-port']);
  });

  test('a packaged launch on the real profile loses both switches', () => {
    const app = fakeApp({
      isPackaged: true,
      switches: ['remote-debugging-port', 'remote-debugging-pipe', 'no-sandbox'],
    });
    const removed = applyRemoteDebuggingGate({ app, env: {} });
    expect(removed.sort()).toEqual(['remote-debugging-pipe', 'remote-debugging-port']);
    expect([...app.present]).toEqual(['no-sandbox']);
  });

  test('a blank FREEDOM_TEST_USER_DATA does not open the gate', () => {
    for (const value of ['', '   ']) {
      const app = fakeApp({ isPackaged: true, switches: ['remote-debugging-port'] });
      expect(applyRemoteDebuggingGate({ app, env: { FREEDOM_TEST_USER_DATA: value } })).toEqual([
        'remote-debugging-port',
      ]);
      expect(app.present.has('remote-debugging-port')).toBe(false);
    }
  });

  test('FREEDOM_TEST_MODE alone does not open the gate', () => {
    const app = fakeApp({ isPackaged: true, switches: ['remote-debugging-port'] });
    applyRemoteDebuggingGate({ app, env: { FREEDOM_TEST_MODE: '1' } });
    expect(app.present.has('remote-debugging-port')).toBe(false);
  });

  test('a packaged E2E launch on a scratch profile keeps the switch', () => {
    const app = fakeApp({ isPackaged: true, switches: ['remote-debugging-port'] });
    expect(
      applyRemoteDebuggingGate({ app, env: { FREEDOM_TEST_USER_DATA: '/tmp/freedom-e2e-x' } })
    ).toEqual([]);
    expect(app.present.has('remote-debugging-port')).toBe(true);
  });

  test('source-tree runs are left alone', () => {
    const app = fakeApp({ isPackaged: false, switches: ['remote-debugging-port'] });
    expect(applyRemoteDebuggingGate({ app, env: {} })).toEqual([]);
    expect(app.present.has('remote-debugging-port')).toBe(true);
    expect(remoteDebuggingAllowed({ isPackaged: false, env: {} })).toBe(true);
  });

  // Chromium reads the switch when it starts the DevTools handler, after the
  // main script has run; anything that requires a heavy module first only
  // widens the window for a future refactor to move the gate behind code that
  // throws or exits early. Pin it right behind the IPC sender policy, which
  // ipc-sender-policy.test.js in turn pins right behind electron.
  test('index.js applies the gate before any other app module is loaded', () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect(requires.slice(0, 5)).toEqual([
      // Sets UV_THREADPOOL_SIZE only; requires nothing (uv-threadpool.test.js).
      './uv-threadpool',
      'electron',
      './ipc-sender-policy',
      // The policy's lazy logger callback, not run at load time.
      './logger',
      './remote-debugging-gate',
    ]);
    expect(source).toMatch(
      /require\('\.\/remote-debugging-gate'\)\.applyRemoteDebuggingGate\(\{ app \}\)/
    );
  });
});
