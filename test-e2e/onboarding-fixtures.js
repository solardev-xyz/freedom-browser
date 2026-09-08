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

const { test: base, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
        // Run headless by default so a local run doesn't pop up or steal focus
        // (the renderer still loads and is fully driveable). Set
        // FREEDOM_E2E_HEADED=1 to watch the window for a run.
        FREEDOM_TEST_HIDE_WINDOW: process.env.FREEDOM_E2E_HEADED === '1' ? '0' : '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 60_000,
    });

    await use(app);

    try {
      await app.close();
    } catch {
      // Window may already be closed by the spec.
    }
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
