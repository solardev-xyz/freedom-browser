// docs/security-audit-electron.md, O-12: FREEDOM_TEST_MODE=1 used to switch
// the E2E harness (stub protocols, `test:*` IPC) on in shipped builds too.
// O-4 then turned the EnableNodeCliInspectArguments fuse off, so a packaged
// launch proves itself a test launch with an honoured CDP debug port instead
// of an attached Node inspector.

const fs = require('fs');
const path = require('path');
const { isTestModeRequested, remoteDebuggingPortOpen, isListenablePort } = require('./test-mode');

const ON = { FREEDOM_TEST_MODE: '1' };
const open = () => true;
const closed = () => false;

// A stand-in for electron's app: switch name → value.
function fakeApp({ isPackaged = true, switches = {} } = {}) {
  return {
    isPackaged,
    commandLine: {
      hasSwitch: (name) => Object.prototype.hasOwnProperty.call(switches, name),
      getSwitchValue: (name) => switches[name] ?? '',
    },
  };
}
const SCRATCH = { FREEDOM_TEST_USER_DATA: '/tmp/freedom-e2e-x' };

describe('isTestModeRequested', () => {
  test('the source tree follows the env var', () => {
    expect(isTestModeRequested({ env: ON, isPackaged: false, debugPortOpen: closed })).toBe(true);
    expect(isTestModeRequested({ env: {}, isPackaged: false, debugPortOpen: open })).toBe(false);
    expect(isTestModeRequested({ env: { FREEDOM_TEST_MODE: 'true' }, isPackaged: false })).toBe(
      false
    );
  });

  test('a packaged build ignores the env var on its own', () => {
    expect(isTestModeRequested({ env: ON, isPackaged: true, debugPortOpen: closed })).toBe(false);
  });

  test('a packaged build honours it only with an honoured CDP port (the packaged launcher)', () => {
    expect(isTestModeRequested({ env: ON, isPackaged: true, debugPortOpen: open })).toBe(true);
    // The debug port alone is not a request for the harness.
    expect(isTestModeRequested({ env: {}, isPackaged: true, debugPortOpen: open })).toBe(false);
  });

  test('an odd probe result counts as closed', () => {
    expect(isTestModeRequested({ env: ON, isPackaged: true, debugPortOpen: () => 'yes' })).toBe(
      false
    );
  });

  test('the default probe reads the real command line, end to end', () => {
    const env = { ...ON, ...SCRATCH };
    const withPort = fakeApp({ switches: { 'remote-debugging-port': '0' } });
    expect(
      isTestModeRequested({
        env,
        isPackaged: true,
        debugPortOpen: () => remoteDebuggingPortOpen({ app: withPort, env }),
      })
    ).toBe(true);
  });

  // The rule only holds if nothing reads the env var around it.
  test('no main-process module reads FREEDOM_TEST_MODE except test-mode.js', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.name.endsWith('.js') &&
          !entry.name.endsWith('.test.js') &&
          full !== path.join(__dirname, 'test-mode.js')
        ) {
          const code = fs
            .readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
          // A read: `process.env.FREEDOM_TEST_MODE`, `env['FREEDOM_TEST_MODE']`,
          // `const { FREEDOM_TEST_MODE } = process.env` (a log line naming it
          // is fine).
          const reads =
            /\benv\s*(\.|\[\s*['"`])\s*FREEDOM_TEST_MODE/.test(code) ||
            /FREEDOM_TEST_MODE[^}]*\}\s*=\s*[\w.]*env\b/.test(code);
          if (reads) offenders.push(path.relative(__dirname, full));
        }
      }
    };
    walk(path.join(__dirname, '..'));
    expect(offenders).toEqual([]);
  });
});

describe('remoteDebuggingPortOpen', () => {
  test('the packaged launcher shape counts: --remote-debugging-port=0 on a scratch profile', () => {
    const app = fakeApp({ switches: { 'remote-debugging-port': '0' } });
    expect(remoteDebuggingPortOpen({ app, env: SCRATCH })).toBe(true);
    const fixed = fakeApp({ switches: { 'remote-debugging-port': '9222' } });
    expect(remoteDebuggingPortOpen({ app: fixed, env: SCRATCH })).toBe(true);
  });

  test('no switch, no port', () => {
    expect(remoteDebuggingPortOpen({ app: fakeApp(), env: SCRATCH })).toBe(false);
  });

  // The gate removes the switch for these launches before Chromium reads it;
  // the probe applies the same rule itself, so it cannot be read "too early".
  test('a packaged launch the gate refuses does not count, even with the switch still present', () => {
    const app = fakeApp({ switches: { 'remote-debugging-port': '0' } });
    expect(remoteDebuggingPortOpen({ app, env: {} })).toBe(false);
    expect(remoteDebuggingPortOpen({ app, env: { FREEDOM_TEST_USER_DATA: '  ' } })).toBe(false);
    expect(remoteDebuggingPortOpen({ app, env: ON })).toBe(false);
  });

  test('--remote-debugging-pipe is not the launcher transport and does not count', () => {
    const app = fakeApp({ switches: { 'remote-debugging-pipe': '' } });
    expect(remoteDebuggingPortOpen({ app, env: SCRATCH })).toBe(false);
  });

  // Electron 44 still listens (on an ephemeral port) for these; refusing them
  // keeps the harness off rather than relying on that fallback.
  test('anything but a plain decimal port does not count', () => {
    for (const value of ['', 'abc', '-1', '65535', '99999', '0x10', ' 0', '1e3', '123456']) {
      const app = fakeApp({ switches: { 'remote-debugging-port': value } });
      expect(remoteDebuggingPortOpen({ app, env: SCRATCH })).toBe(false);
    }
  });

  test('a throwing command line counts as closed', () => {
    const app = {
      isPackaged: true,
      commandLine: {
        hasSwitch: () => {
          throw new Error('boom');
        },
      },
    };
    expect(remoteDebuggingPortOpen({ app, env: SCRATCH })).toBe(false);
  });

  test('isListenablePort', () => {
    expect(['0', '1', '9222', '65534'].every(isListenablePort)).toBe(true);
    expect([undefined, null, 0, '65535', '-0'].some(isListenablePort)).toBe(false);
  });
});
