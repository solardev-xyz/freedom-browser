const path = require('path');

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../profile-paths', () => ({ getIdentityDataDir: jest.fn() }));
jest.mock('./core-client', () => ({ CoreClient: jest.fn() }));

const { app } = require('electron');
const { getCoredBinaryPath, isCoreEnabled } = require('./core-process');
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
const originalPath = process.env.FREEDOM_CORED_PATH;
const originalEnabled = process.env.FREEDOM_CORE;

afterEach(() => {
  app.isPackaged = false;
  Object.defineProperty(process, 'platform', originalPlatform);
  Object.defineProperty(process, 'arch', originalArch);
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources);
  else delete process.resourcesPath;
  if (originalPath === undefined) delete process.env.FREEDOM_CORED_PATH;
  else process.env.FREEDOM_CORED_PATH = originalPath;
  if (originalEnabled === undefined) delete process.env.FREEDOM_CORE;
  else process.env.FREEDOM_CORE = originalEnabled;
});

test.each([
  ['darwin', 'x64', 'mac', 'freedom-cored'],
  ['darwin', 'arm64', 'mac', 'freedom-cored'],
  ['linux', 'x64', 'linux', 'freedom-cored'],
  ['linux', 'arm64', 'linux', 'freedom-cored'],
  ['win32', 'x64', 'win', 'freedom-cored.exe'],
  ['win32', 'arm64', 'win', 'freedom-cored.exe'],
])('resolves dev and packaged paths for %s-%s', (platform, arch, os, binary) => {
  Object.defineProperty(process, 'platform', { value: platform });
  Object.defineProperty(process, 'arch', { value: arch });
  Object.defineProperty(process, 'resourcesPath', {
    value: path.join('packaged', 'resources'),
    configurable: true,
  });
  delete process.env.FREEDOM_CORED_PATH;
  expect(getCoredBinaryPath()).toBe(
    path.join(__dirname, '../../..', 'freedom-cored-bin', `${os}-${arch}`, binary)
  );
  process.env.FREEDOM_CORED_PATH = path.join('custom', binary);
  expect(getCoredBinaryPath()).toBe(process.env.FREEDOM_CORED_PATH);
  app.isPackaged = true;
  expect(getCoredBinaryPath()).toBe(path.join(process.resourcesPath, 'freedom-cored', binary));
});

test('the core always runs: it owns the vault (migration step 2)', () => {
  // No runtime switch back to the JS stack (design 0001, "Rollback").
  for (const value of [undefined, '0', '1']) {
    if (value === undefined) delete process.env.FREEDOM_CORE;
    else process.env.FREEDOM_CORE = value;
    app.isPackaged = false;
    expect(isCoreEnabled()).toBe(true);
    app.isPackaged = true;
    expect(isCoreEnabled()).toBe(true);
  }
});
