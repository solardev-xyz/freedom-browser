const fs = require('fs');
const path = require('path');

jest.mock('electron', () => ({ app: { isPackaged: false } }));
jest.mock('./logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const {
  WEBVIEW_BOOT_SWITCH,
  buildEthereumInjectSource,
  buildWebviewBootSwitch,
} = require('./webview-boot');

const decode = (arg) => {
  expect(arg.startsWith(WEBVIEW_BOOT_SWITCH)).toBe(true);
  return JSON.parse(Buffer.from(arg.slice(WEBVIEW_BOOT_SWITCH.length), 'base64').toString('utf-8'));
};

test('the preload reads the same switch name main writes', () => {
  // A sandboxed preload can't require webview-boot.js, so it keeps a copy.
  const preload = fs.readFileSync(path.join(__dirname, 'webview-preload.js'), 'utf-8');
  expect(preload).toContain(`const WEBVIEW_BOOT_SWITCH = '${WEBVIEW_BOOT_SWITCH}';`);
});

test('a normal webview gets the pages list and everything the provider needs', () => {
  const boot = decode(buildWebviewBootSwitch({ isPrivate: false }));
  expect(boot.isPrivate).toBe(false);
  expect(boot.internalPages).toEqual(require('../shared/internal-pages.json'));
  // What the preload assembles from the switch is what the sync IPC serves.
  const uuid = '00000000-0000-4000-8000-000000000000';
  const info = JSON.stringify({ ...boot.ethereum.info, uuid }).replace(/</g, '\\u003c');
  expect(`window.__FREEDOM_PROVIDER_CONFIG__ = ${info};\n${boot.ethereum.source}`).toBe(
    buildEthereumInjectSource(uuid)
  );
  expect(boot.ethereum.info.icon).toMatch(/^data:image\/png;base64,./);
});

test('a private webview gets no provider at all', () => {
  const boot = decode(buildWebviewBootSwitch({ isPrivate: true }));
  expect(boot.isPrivate).toBe(true);
  expect(boot).not.toHaveProperty('ethereum');
});

// freedom-core design 0011, PRQ-2: the E2E harness's routes through
// page:request. Main passes them only in test mode (page-requests.js
// `testPageRoutes`, empty otherwise); the switch carries them only when
// there are some, and never to a private webview, which has no providers.
test('the harness\'s page routes ride on a normal webview\'s switch only when there are some', () => {
  expect(decode(buildWebviewBootSwitch({ isPrivate: false }))).not.toHaveProperty('testPageRoutes');
  expect(decode(buildWebviewBootSwitch({ isPrivate: false, testPageRoutes: [] }))).not.toHaveProperty('testPageRoutes');
  expect(
    decode(buildWebviewBootSwitch({ isPrivate: false, testPageRoutes: ['swarm:swarm_readChunk', 7] })).testPageRoutes
  ).toEqual(['swarm:swarm_readChunk']);
  expect(
    decode(buildWebviewBootSwitch({ isPrivate: true, testPageRoutes: ['swarm:swarm_readChunk'] }))
  ).not.toHaveProperty('testPageRoutes');
});

test('the app\'s instance routes nothing until the harness enables its hooks', () => {
  jest.isolateModules(() => {
    const { testPageRoutes, enablePageRequestTestHooks } = require('./page/page-requests');
    expect(testPageRoutes()).toEqual([]);
    const hooks = enablePageRequestTestHooks();
    expect(testPageRoutes()).toEqual([]);
    hooks.setRoutes(['swarm:swarm_readChunk']);
    expect(testPageRoutes()).toEqual(['swarm:swarm_readChunk']);
  });
});

test('only an explicit true is private', () => {
  expect(decode(buildWebviewBootSwitch({})).isPrivate).toBe(false);
});

// Windows caps a whole command line at 32,767 characters, and Chromium's own
// renderer switches take a few thousand of them.
test('the switch stays well inside a Windows command line', () => {
  expect(buildWebviewBootSwitch({ isPrivate: false }).length).toBeLessThan(20_000);
});
