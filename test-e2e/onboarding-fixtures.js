// Fixtures for the onboarding-wizard identity E2E (issue #90 follow-up).
//
// Like `live-fixtures.js`, this launches WITHOUT FREEDOM_TEST_MODE so the real
// Bee manager spawns an actual node — the node opens (and LOCKs) its LevelDB
// `statestore`, which is the precondition for the EPERM-on-wipe regression. The
// test then drives the password onboarding wizard, whose force-reinjection wipes
// that statestore while Bee is running.
//
// All node data dirs are redirected into a per-run temp root via the
// FREEDOM_*_DATA overrides so a live run never touches the developer's
// persistent `ant-data/`, `ipfs-data/`, `radicle-data/`, or `identity-data/`.
// Settings are seeded so only Ant auto-starts (the node relevant to issue #90).
// IPFS reports ephemeral native identity mode and does not need a binary
// or running daemon for this regression.
//
// This fixture always SHOWS the window, even if the caller exported
// FREEDOM_TEST_HIDE_WINDOW=1: a hidden window starves Playwright's
// actionability checks of frames (#479, see the launch env below). A local run therefore pops
// up a window; on Linux use `xvfb-run -a npm run test:e2e:onboarding` to keep it
// on a virtual display.

const { test: base, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { closeApp } = require('./close-app');

const repoRoot = path.resolve(__dirname, '..');

function resolveBinary(dir, base) {
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const platform = platformMap[process.platform] || process.platform;
  const arch = process.arch;
  const binName = process.platform === 'win32' ? `${base}.exe` : base;
  return path.join(repoRoot, dir, `${platform}-${arch}`, binName);
}

const ANT_BINARY_PATH = resolveBinary('ant-bin', 'antd');
const HAS_ANT_BINARY = fs.existsSync(ANT_BINARY_PATH);
// The wizard injects the Ant identity (needs a running node to reproduce #90).
// Native freedom-ipfs reports an ephemeral identity and needs no binary here.
const HAS_BINARIES = HAS_ANT_BINARY;

// Start only Bee at launch: it's the node whose locked statestore drives the
// issue #90 wipe. Keeping IPFS/Radicle daemons off reduces flakiness.
const SEED_SETTINGS = {
  enableIdentityWallet: true,
  startAntAtLaunch: true,
  startIpfsAtLaunch: false,
  startRadicleAtLaunch: false,
};

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-onboarding-e2e-'));
    const userDataDir = path.join(tmpRoot, 'userData');
    const beeDataDir = path.join(tmpRoot, 'ant-data');
    const ipfsDataDir = path.join(tmpRoot, 'ipfs-data');
    const radicleDataDir = path.join(tmpRoot, 'radicle-data');
    const identityDataDir = path.join(tmpRoot, 'identity');
    for (const dir of [userDataDir, beeDataDir, ipfsDataDir, radicleDataDir, identityDataDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify(SEED_SETTINGS, null, 2),
      'utf-8'
    );

    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        // Deliberately NOT FREEDOM_TEST_MODE — we need the real Bee spawn so
        // its statestore lock is held during the wizard's reinjection.
        FREEDOM_TEST_USER_DATA: userDataDir,
        FREEDOM_ANT_DATA: beeDataDir,
        FREEDOM_IPFS_DATA: ipfsDataDir,
        FREEDOM_RADICLE_DATA: radicleDataDir,
        FREEDOM_IDENTITY_DATA: identityDataDir,
        // The window is shown, like the harness fixtures' (on Linux, run under
        // `xvfb-run -a` so it lands on a virtual display). This spec used to set
        // FREEDOM_TEST_HIDE_WINDOW=1, and a never-shown window has no reliable
        // frame clock: probed 2026-10 under xvfb (Electron 44.4.5), the hidden
        // window ran requestAnimationFrame at ~1 fps against ~60 fps shown, and
        // on CI it intermittently stopped entirely. Every Playwright click/check
        // first waits for the target to be "stable" — two rAF callbacks with
        // the same bounding box — so with no frames the wizard's Continue
        // (spec:72) and #backup-confirmed (spec:92) sat at "waiting for element
        // to be visible, enabled and stable" for the full 30s with no
        // re-check logged, even though both were on screen and enabled (#479).
        // Set to '0' explicitly rather than left unset, so an inherited =1 from
        // the caller's environment (ci.yml's Myotis step exports one) can't
        // re-hide it.
        FREEDOM_TEST_HIDE_WINDOW: '0',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 60_000,
    });

    await use(app);

    // Real nodes stop on quit; same deadline as live-fixtures.js.
    await closeApp(app, { timeout: 100_000 });
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // Best-effort cleanup; leftover dirs in the OS temp dir are harmless.
    }
  },

  window: async ({ electronApp }, use) => {
    const win = await electronApp.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForSelector('[data-test="address-input"]', { state: 'visible' });
    // Pin the precondition above: if the window ever goes back to hidden, fail
    // here with the reason instead of as a 30s actionability timeout mid-wizard.
    // Check the BrowserWindow behind the page under test, not "any window", so
    // a second visible window can't mask a hidden main one.
    const browserWindow = await electronApp.browserWindow(win);
    const shown = await browserWindow.evaluate((w) => w.isVisible());
    expect(
      shown,
      'main window must be shown: Playwright actionability needs its frames (#479)'
    ).toBe(true);
    await use(win);
  },
});

module.exports = {
  test,
  expect,
  HAS_BINARIES,
  HAS_ANT_BINARY,
  ANT_BINARY_PATH,
};
