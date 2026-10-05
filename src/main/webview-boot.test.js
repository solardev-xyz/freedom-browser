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

test('only an explicit true is private', () => {
  expect(decode(buildWebviewBootSwitch({})).isPrivate).toBe(false);
});

// Windows caps a whole command line at 32,767 characters, and Chromium's own
// renderer switches take a few thousand of them.
test('the switch stays well inside a Windows command line', () => {
  expect(buildWebviewBootSwitch({ isPrivate: false }).length).toBeLessThan(20_000);
});
