// The moved profile with the real nodes (freedom-core design 0013, PRF-9 B3;
// MD3): after a full start, with the bundled nodes running on the profile's
// own data in `<userData>/freedom/`, a walk of `freedom/` finds no socket,
// FIFO or device file, and no name the move takes is at the profile's root
// but the placeholder. A special file under a moved entry would make a later
// move across volumes defer for good (`special_file`), and a node keeping a
// socket there would push its path past the platform's limit.
//
// Unlike the live fixtures, this launch sets none of the data-directory
// overrides (FREEDOM_ANT_DATA, …): each node's data is the profile's, where
// the move puts it. Radicle's home stays outside the profile, as live specs
// keep it (its control socket's path limit; a non-catalog `radicle-data/`
// isn't moved either). Each node runs whose binary this checkout has: Ant
// (`npm run ant:download`), IPFS (`npm run ipfsd:download`), Tor (`npm run
// tor:download`) and Myotis (`npm run myotis:download` and its supervisor, or
// MYOTIS_NODE_PATH). The walk runs while they run, and again after the quit.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { HAS_ANT_BINARY, HAS_ARTI_BINARY, HAS_IPFS_NODE } = require('../live-fixtures');
const { launchApp, packagedLaunchTarget } = require('../packaged-launch');
const { closeApp } = require('../close-app');
const { chromeWindow } = require('../chrome-window');
const { MOVED_ENTRIES, PLACEHOLDER } = require('../../src/main/freedom-root');

const repoRoot = path.resolve(__dirname, '..', '..');
const osDir = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform] || process.platform;
const HAS_MYOTIS = [
  process.env.MYOTIS_NODE_PATH,
  path.join(repoRoot, 'myotis-bin', `${osDir}-${process.arch}`, 'myotis-node.node'),
].some((candidate) => candidate && fs.existsSync(candidate));

// Myotis's supervisor takes its lease in the generation it runs,
// `myotis/verified-sync/<generation>/` (checkpoint-store.js), not in `myotis/`.
function myotisLeaseUnder(freedom) {
  const generations = path.join(freedom, 'myotis', 'verified-sync');
  try {
    return fs
      .readdirSync(generations)
      .some((name) => fs.existsSync(path.join(generations, name, '.freedom-myotis-lifetime')));
  } catch {
    return false;
  }
}

// Each node, the settings that start it, and what under `freedom/` shows it
// has started on the profile's data: a path, or a check of its own.
const NODES = [
  {
    label: 'Ant',
    present: HAS_ANT_BINARY,
    settings: { startAntAtLaunch: true },
    started: 'ant-data',
    api: 'ant',
  },
  {
    label: 'IPFS',
    present: HAS_IPFS_NODE,
    settings: { startIpfsAtLaunch: true },
    started: path.join('ipfs-data', 'freedom-ipfs'),
    api: 'ipfs',
  },
  {
    label: 'Tor',
    present: HAS_ARTI_BINARY,
    settings: { enableTorIntegration: true, startTorAtLaunch: true },
    started: path.join('tor-data', 'state'),
  },
  {
    label: 'Myotis',
    present: HAS_MYOTIS,
    settings: { startMyotisAtLaunch: true },
    started: myotisLeaseUnder,
  },
];
const NODES_OFF = {
  startAntAtLaunch: false,
  startIpfsAtLaunch: false,
  startRadicleAtLaunch: false,
  enableTorIntegration: false,
  startTorAtLaunch: false,
  startMyotisAtLaunch: false,
  startMyotisGnosisAtLaunch: false,
};
const START_TIMEOUT_MS = 180_000;

/** Sockets, FIFOs and devices under `dir`, never following a link. */
function specialFiles(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      // A node may remove a directory while the walk is in it.
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isDirectory()) walk(full);
      else if (stat.isSocket() || stat.isFIFO() || stat.isCharacterDevice() || stat.isBlockDevice()) {
        found.push(path.relative(dir, full));
      }
    }
  };
  walk(dir);
  return found;
}

function movedNamesAtRoot(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => MOVED_ENTRIES.includes(name))
    .filter((name) => !(name === PLACEHOLDER && fs.lstatSync(path.join(dir, name)).isFile()));
}

test('a moved profile with the real nodes keeps no socket, FIFO or device under freedom/', async () => {
  const running = NODES.filter((node) => node.present);
  test.skip(running.length === 0, 'No node binary in this checkout (npm run ant:download, …)');
  test.setTimeout(START_TIMEOUT_MS + 180_000);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-live-layout-'));
  const userDataDir = path.join(tmpRoot, 'userData');
  fs.mkdirSync(userDataDir);
  // The Radicle home's control socket must fit sockaddr_un; it isn't started
  // here, but nothing of it lands in the profile either way.
  const radicleHome = fs.mkdtempSync(
    process.platform === 'win32' ? path.join(os.tmpdir(), 'rad-') : '/tmp/rad-'
  );
  // Seeded at the root, as a build before the move kept them: the first start
  // moves them. Ant is the profile's own (`managed`), not a node on 1633.
  const settings = Object.assign({}, NODES_OFF, ...running.map((node) => node.settings));
  fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify(settings, null, 2));
  fs.writeFileSync(
    path.join(userDataDir, 'external-node-decisions.json'),
    JSON.stringify({ bee: { choice: 'managed', endpoints: ['http://127.0.0.1:1633'] } }, null, 2)
  );

  const env = { ...process.env };
  for (const name of [
    'FREEDOM_ANT_DATA',
    'FREEDOM_BEE_DATA',
    'FREEDOM_IPFS_DATA',
    'FREEDOM_IDENTITY_DATA',
    'FREEDOM_TOR_DATA',
    'MYOTIS_DATA_DIR',
    'FREEDOM_TEST_MODE',
  ]) {
    delete env[name];
  }
  const app = await launchApp({
    ...packagedLaunchTarget(),
    cwd: repoRoot,
    env: {
      ...env,
      FREEDOM_TEST_USER_DATA: userDataDir,
      FREEDOM_RADICLE_DATA: radicleHome,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      LANG: 'en_US.UTF-8',
    },
    timeout: 90_000,
  });
  const freedom = path.join(userDataDir, 'freedom');
  try {
    const window = await chromeWindow(app);
    await window.waitForSelector('[data-test="address-input"]', { state: 'visible' });
    expect(fs.existsSync(path.join(freedom, 'layout.json'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'settings.json'))).toBe(false);

    for (const node of running) {
      await expect
        .poll(
          () =>
            typeof node.started === 'function'
              ? node.started(freedom)
              : fs.existsSync(path.join(freedom, node.started)),
          {
            message: `${node.label} to start on the profile's data in freedom/`,
            timeout: START_TIMEOUT_MS,
            intervals: [1_000, 2_000],
          }
        )
        .toBe(true);
      if (node.api) {
        await expect
          .poll(() => window.evaluate((api) => window[api].getStatus(), node.api).then((s) => s.status), {
            message: `${node.label} to report running`,
            timeout: START_TIMEOUT_MS,
            intervals: [1_000, 2_000],
          })
          .toBe('running');
      }
    }
    test.info().annotations.push({
      type: 'nodes',
      description: running.map((node) => node.label).join(', '),
    });

    // While the nodes run: anything they keep open is there now.
    expect(specialFiles(freedom)).toEqual([]);
    expect(movedNamesAtRoot(userDataDir)).toEqual([]);
  } finally {
    await closeApp(app, { timeout: 100_000 });
  }
  expect(specialFiles(freedom)).toEqual([]);
  expect(movedNamesAtRoot(userDataDir)).toEqual([]);
  for (const dir of [tmpRoot, radicleHome]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; leftover dirs in /tmp are harmless.
    }
  }
});
