// Custom fixtures for the live-network E2E suite.
//
// Unlike `fixtures.js`, this launches the app WITHOUT FREEDOM_TEST_MODE,
// so the actual Bee / native IPFS managers start, ENS resolution hits the
// live Universal Resolver, and the production bzz:// / ipfs:// protocol
// handlers stream through local nodes. We still pass
// FREEDOM_TEST_USER_DATA so the test session doesn't write to the
// user's real settings/bookmarks/history files.

const { test: base, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');

// Mirror ant-manager.js's binary-path resolution so we can detect a
// missing binary up front and skip the suite gracefully (downloading
// the Ant binary is a per-platform extra step the user opts into via
// `npm run ant:download`).
function resolveAntBinaryPath() {
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const platform = platformMap[process.platform] || process.platform;
  const arch = process.arch;
  const binName = process.platform === 'win32' ? 'antd.exe' : 'antd';
  return path.join(repoRoot, 'ant-bin', `${platform}-${arch}`, binName);
}

// Mirror tor-manager.js's getArtiBinaryPath() (dev layout) for the same
// reason: `npm run tor:download` is an opt-in per-platform build step, so the
// live Tor spec skips gracefully when the binary isn't there.
function resolveArtiBinaryPath() {
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const platform = platformMap[process.platform] || process.platform;
  const binName = process.platform === 'win32' ? 'arti.exe' : 'arti';
  return path.join(repoRoot, 'arti-bin', `${platform}-${process.arch}`, binName);
}

function resolveIpfsNativeAddonPath() {
  return path.join(
    repoRoot,
    'native',
    'freedom-ipfs-node',
    'build',
    'Release',
    'freedom_ipfs_native.node'
  );
}

const ANT_BINARY_PATH = resolveAntBinaryPath();
const HAS_ANT_BINARY = fs.existsSync(ANT_BINARY_PATH);

const IPFS_NATIVE_ADDON_PATH = resolveIpfsNativeAddonPath();
const HAS_IPFS_NATIVE_ADDON = fs.existsSync(IPFS_NATIVE_ADDON_PATH);

const ARTI_BINARY_PATH = resolveArtiBinaryPath();
const HAS_ARTI_BINARY = fs.existsSync(ARTI_BINARY_PATH);

function envFlagEnabled(name) {
  const raw = process.env[name];
  return typeof raw === 'string' && raw !== '' && raw !== '0' && raw.toLowerCase() !== 'false';
}

// `FREEDOM_LIVE_E2E_DISABLE_DEFAULT_NODES=1` (set by `npm run test:e2e:tor`)
// seeds settings that keep Ant / IPFS / Radicle / Tor from autostarting: a
// spec exercising one live subsystem shouldn't pay the boot cost — or inherit
// the flakiness — of the others. A spec's own `seedSettings` still wins.
const DEFAULT_NODES_OFF_SETTINGS = {
  startAntAtLaunch: false,
  startIpfsAtLaunch: false,
  enableRadicleIntegration: false,
  startRadicleAtLaunch: false,
  startTorAtLaunch: false,
};

const test = base.extend({
  // Seed settings.json before launch (same semantics as fixtures.js) —
  // e.g. disable node autostart for specs that don't need Ant/IPFS.
  seedSettings: [null, { option: true }],

  // Extra environment variables for the app process (e.g.
  // FREEDOM_ADBLOCK_DIR). The suite-critical vars below always win.
  launchEnv: [null, { option: true }],

  electronApp: async ({ seedSettings: settingsOverride, launchEnv }, use) => {
    // One temp root per run, with four subdirs:
    //   - userData/     → settings, bookmarks, history (FREEDOM_TEST_USER_DATA)
    //   - ant-data/     → Ant's identity, swarm key, peerstore (FREEDOM_ANT_DATA)
    //   - ipfs-data/    → native freedom-ipfs data base (FREEDOM_IPFS_DATA)
    //   - identity/     → vault meta + node-identity files (FREEDOM_IDENTITY_DATA)
    // All four overrides matter: in dev mode these directories default
    // to `<repoRoot>/ant-data`, `<repoRoot>/ipfs-data`, and
    // `<repoRoot>/identity-data` — pointing them at empty temp dirs is
    // what keeps a live run from clobbering the developer's persistent
    // state. The identity override is the most subtle of the three:
    // without it `hasVault()` would still find the developer's local
    // vault, set the node managers into injected-identity mode, and
    // Bee would hang waiting for keys the temp data dirs don't
    // have.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-live-e2e-'));
    const userDataDir = path.join(tmpRoot, 'userData');
    const beeDataDir = path.join(tmpRoot, 'ant-data');
    const ipfsDataDir = path.join(tmpRoot, 'ipfs-data');
    const identityDataDir = path.join(tmpRoot, 'identity');
    for (const dir of [userDataDir, beeDataDir, ipfsDataDir, identityDataDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const seededSettings = envFlagEnabled('FREEDOM_LIVE_E2E_DISABLE_DEFAULT_NODES')
      ? { ...DEFAULT_NODES_OFF_SETTINGS, ...(settingsOverride || {}) }
      : settingsOverride;
    if (seededSettings) {
      fs.writeFileSync(
        path.join(userDataDir, 'settings.json'),
        JSON.stringify(seededSettings, null, 2),
        'utf-8'
      );
    }

    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        ...(launchEnv || {}),
        // Deliberately NOT setting FREEDOM_TEST_MODE — this suite needs
        // the production code paths (actual Bee spawn, live ENS, real
        // protocol handlers).
        FREEDOM_TEST_USER_DATA: userDataDir,
        FREEDOM_ANT_DATA: beeDataDir,
        FREEDOM_IPFS_DATA: ipfsDataDir,
        FREEDOM_IDENTITY_DATA: identityDataDir,
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
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; leftover dirs in /tmp are harmless.
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
  HAS_ANT_BINARY,
  ANT_BINARY_PATH,
  HAS_IPFS_NATIVE_ADDON,
  IPFS_NATIVE_ADDON_PATH,
  HAS_ARTI_BINARY,
  ARTI_BINARY_PATH,
};
