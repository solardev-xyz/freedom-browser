/**
 * The freedom-colibrid binary's path in each build: the download in
 * development, `FREEDOM_COLIBRID_PATH` only while the app isn't packaged,
 * and the resources a packaged build ships.
 */

const path = require('path');

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });

const { app } = require('electron');
const { getColibridBinaryPath } = require('./colibrid-binary');

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
const originalPath = process.env.FREEDOM_COLIBRID_PATH;

afterEach(() => {
  app.isPackaged = false;
  Object.defineProperty(process, 'platform', originalPlatform);
  Object.defineProperty(process, 'arch', originalArch);
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources);
  else delete process.resourcesPath;
  if (originalPath === undefined) delete process.env.FREEDOM_COLIBRID_PATH;
  else process.env.FREEDOM_COLIBRID_PATH = originalPath;
});

test.each([
  ['darwin', 'x64', 'mac', 'freedom-colibrid'],
  ['darwin', 'arm64', 'mac', 'freedom-colibrid'],
  ['linux', 'x64', 'linux', 'freedom-colibrid'],
  ['linux', 'arm64', 'linux', 'freedom-colibrid'],
  ['win32', 'x64', 'win', 'freedom-colibrid.exe'],
  ['win32', 'arm64', 'win', 'freedom-colibrid.exe'],
])('resolves dev and packaged paths for %s-%s', (platform, arch, os, binary) => {
  Object.defineProperty(process, 'platform', { value: platform });
  Object.defineProperty(process, 'arch', { value: arch });
  Object.defineProperty(process, 'resourcesPath', {
    value: path.join('packaged', 'resources'),
    configurable: true,
  });
  delete process.env.FREEDOM_COLIBRID_PATH;
  expect(getColibridBinaryPath()).toBe(
    path.join(__dirname, '../../..', 'freedom-colibrid-bin', `${os}-${arch}`, binary)
  );
  // The override is honoured only while the app isn't packaged.
  process.env.FREEDOM_COLIBRID_PATH = path.join('custom', binary);
  expect(getColibridBinaryPath()).toBe(process.env.FREEDOM_COLIBRID_PATH);
  app.isPackaged = true;
  expect(getColibridBinaryPath()).toBe(
    path.join(process.resourcesPath, 'freedom-colibrid', binary)
  );
});
