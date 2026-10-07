// Packaged smoke — the Electron fuses the artifact actually carries
// (docs/security-audit-electron.md, E-5 / O-4; issues #425 and #431).
//
// electron-builder flips build.electronFuses into the binary right before
// signing; scripts/electron-fuses.test.js pins that config. This checks the
// bytes that shipped, once per release smoke leg (.deb, AppImage, .dmg,
// -mac.zip, NSIS install, portable zip), and then checks the two behaviours
// the fuses exist for that a smoke run can observe:
//   - `--inspect` no longer opens a Node inspector on the main process;
//   - the app was loaded from its own app.asar.
// Integrity validation itself (a tampered app.asar refusing to start) is
// enforced only on macOS and Windows, and needs a signed artifact to mean
// anything; it cannot be exercised by editing an installed package here.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('../fixtures');
const {
  isAppImageRun,
  launchPackagedApp,
  packagedExecutable,
  packagedLaunchTarget,
} = require('../packaged-launch');

const pkg = require('../../package.json');

// @electron/fuses' wire format: a sentinel, a version byte, a length byte, then
// one byte per fuse. Read directly so this spec depends on nothing but the file.
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const STATE = { 0x30: false, 0x31: true, 0x72: 'removed' };
// FuseV1Options order, as electron-builder's config keys.
const FUSE_ORDER = [
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
];

// On macOS the fuse wire lives in the Electron Framework, not the app's own
// executable (FREEDOM_E2E_EXECUTABLE is …/Freedom.app/Contents/MacOS/Freedom).
function fuseFile(executable) {
  if (process.platform !== 'darwin') return executable;
  return path.resolve(
    path.dirname(executable),
    '..',
    'Frameworks',
    'Electron Framework.framework',
    'Electron Framework'
  );
}

function readFuses(file) {
  const bytes = fs.readFileSync(file);
  const at = bytes.indexOf(SENTINEL);
  if (at < 0) throw new Error(`No fuse wire in ${file}`);
  const version = bytes[at + SENTINEL.length];
  const length = bytes[at + SENTINEL.length + 1];
  const fuses = {};
  for (let i = 0; i < Math.min(length, FUSE_ORDER.length); i++) {
    const raw = bytes[at + SENTINEL.length + 2 + i];
    fuses[FUSE_ORDER[i]] = raw in STATE ? STATE[raw] : `0x${raw.toString(16)}`;
  }
  return { version, fuses };
}

function testModeEnv(userDataDir) {
  return {
    ...process.env,
    FREEDOM_TEST_MODE: '1',
    FREEDOM_TEST_USER_DATA: userDataDir,
    LANG: 'en_US.UTF-8',
  };
}

// An AppImage's binary sits compressed inside its squashfs, so there are no
// fuse bytes to find in the file itself. Start it and read the binary it
// actually runs from the mount (appFacts().execPath) while it is up.
async function readFusesFromRunningAppImage(userDataDir) {
  const app = await launchPackagedApp({
    ...packagedLaunchTarget(),
    env: testModeEnv(userDataDir),
    timeout: 45_000,
  });
  try {
    await app.firstWindow();
    const { execPath } = await app.appFacts();
    return readFuses(execPath);
  } finally {
    await app.close();
  }
}

test('the artifact carries the configured fuses', async ({ userDataDir }) => {
  const { version, fuses } = isAppImageRun()
    ? await readFusesFromRunningAppImage(userDataDir)
    : readFuses(fuseFile(fs.realpathSync(packagedExecutable())));
  expect(version).toBe(1);

  const configured = Object.fromEntries(
    FUSE_ORDER.filter((name) => name in pkg.build.electronFuses).map((name) => [
      name,
      pkg.build.electronFuses[name],
    ])
  );
  expect(Object.fromEntries(Object.keys(configured).map((name) => [name, fuses[name]]))).toEqual(
    configured
  );
  // Spelled out as well, so a config change cannot quietly carry this spec
  // along with it.
  expect(fuses).toMatchObject({
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  });
});

test('the app is loaded from its own app.asar', async ({ electronApp }) => {
  const { appPath, resourcesPath } = await electronApp.appFacts();
  expect(appPath).toBe(path.join(resourcesPath, 'app.asar'));
});

test('--inspect does not open a main-process inspector', async ({ userDataDir }) => {
  const target = packagedLaunchTarget();
  const app = await launchPackagedApp({
    ...target,
    args: [...target.args, '--inspect=0'],
    env: testModeEnv(userDataDir),
    timeout: 45_000,
  });
  try {
    const window = await app.firstWindow();
    await window.waitForSelector('[data-test="address-input"]', { state: 'visible' });
    const output = app.outputText();
    expect(output).toContain('DevTools listening on ws://');
    expect(output).not.toMatch(/Debugger listening on ws:\/\//);
  } finally {
    await app.close();
  }
});
