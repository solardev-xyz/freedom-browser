// Fixtures for the Radicle live E2E suite.
//
// Launches the app WITHOUT FREEDOM_TEST_MODE (real protocol handlers, real
// native Radicle node) but with every data dir isolated. The Radicle home is
// pre-baked before launch:
//  - a fresh identity created by libradicle
//  - an ISOLATED node config (no preferred seeds, no peers) so nothing the
//    suite creates ever reaches the public network
//  - a two-commit public fixture repo with one issue, created through
//    libradicle, so reads and window.radicle writes can be asserted offline
//
// Also serves the canopy production build (../canopy/dist) from a local
// static server — the dApp under test.

const { test: base, expect, _electron: electron } = require('@playwright/test');
const { execFileSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');

function radicleBinDir() {
  const platform = process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return path.join(repoRoot, 'radicle-bin', `${platform}-${arch}`);
}

const RADICLE_ADDON = path.join(radicleBinDir(), 'libradicle.node');
const HAS_RADICLE_ADDON = fs.existsSync(RADICLE_ADDON);

const CANOPY_DIST = path.resolve(repoRoot, '..', 'canopy', 'dist');
const HAS_CANOPY_DIST = fs.existsSync(path.join(CANOPY_DIST, 'index.html'));

/** Pre-bake an isolated radicle home + public fixture repo. */
async function bakeRadicleHome(radHome, workdir) {
  const addon = require(RADICLE_ADDON);
  const call = async (name, ...args) => {
    const value = JSON.parse(await addon[name](...args));
    if (value.error) throw new Error(value.error);
    return value;
  };

  // Public fixture repo; the isolated node config guarantees it never leaves
  // this machine.
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(path.join(workdir, 'README.md'), '# e2e-sample\n\nCanopy e2e fixture.\n');
  fs.writeFileSync(path.join(workdir, 'index.js'), "console.log('hello');\n");
  const git = (args) =>
    execFileSync('git', args, {
      cwd: workdir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'e2e',
        GIT_AUTHOR_EMAIL: 'e2e@canopy.local',
        GIT_COMMITTER_NAME: 'e2e',
        GIT_COMMITTER_EMAIL: 'e2e@canopy.local',
      },
      encoding: 'utf8',
    });
  git(['init', '-q', '-b', 'main']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial commit']);
  const firstCommit = git(['rev-parse', 'HEAD']).trim();
  fs.appendFileSync(path.join(workdir, 'README.md'), '\nSecond revision.\n');
  fs.writeFileSync(path.join(workdir, 'new.txt'), 'added in the second commit\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'update fixture files']);
  const secondCommit = git(['rev-parse', 'HEAD']).trim();
  // Profile initialization writes Heartwood's default network config. Stop
  // immediately and replace it before importing any repository content; doing
  // this after import leaves enough time for the fixture RID to reach public
  // seeds and makes every test run look like a new public repository.
  await call('start', radHome, 'radicle-e2e');
  await call('shutdown');

  const configPath = path.join(radHome, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.preferredSeeds = [];
  config.node.peers = { type: 'static' };
  config.node.connect = [];
  config.node.listen = [];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Only the isolated runtime is allowed to see the fixture repository.
  await call('start', radHome, 'radicle-e2e');
  const { rid } = await call(
    'importRepo', workdir, 'e2e-sample', 'Canopy e2e fixture repo', 'main'
  );
  await call(
    'createIssue', rid, 'Fixture issue', 'Opened by the e2e fixture.', JSON.stringify([])
  );
  await call('shutdown');

  return { rid, firstCommit, secondCommit };
}

/** Serve a directory over local http; resolves to the base URL. */
function serveStatic(dir) {
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
  };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let filePath = path.join(dir, urlPath === '/' ? 'index.html' : urlPath);
    if (!filePath.startsWith(dir) || !fs.existsSync(filePath)) {
      filePath = path.join(dir, 'index.html'); // SPA fallback
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(filePath)] ?? 'application/octet-stream',
    });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  radicleEnv: async ({}, use) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-rad-e2e-'));
    // The radicle home must stay SHORT: the node binds a Unix socket at
    // $RAD_HOME/node/control.sock and sockaddr_un caps the path length.
    const radHome = fs.mkdtempSync('/tmp/rad-e2e-');
    const userDataDir = path.join(tmpRoot, 'userData');
    fs.mkdirSync(userDataDir, { recursive: true });

    const fixture = await bakeRadicleHome(radHome, path.join(tmpRoot, 'fixture-repo'));

    // Radicle on, auto-start on, wallet features off.
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({ startRadicleAtLaunch: true })
    );

    const canopy = await serveStatic(CANOPY_DIST);

    await use({ tmpRoot, radHome, userDataDir, ...fixture, canopyUrl: canopy.url });

    canopy.server.close();
    for (const dir of [tmpRoot, radHome]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  },

  electronApp: async ({ radicleEnv }, use) => {
    const { tmpRoot, radHome, userDataDir } = radicleEnv;
    const dirs = {
      FREEDOM_ANT_DATA: path.join(tmpRoot, 'ant-data'),
      FREEDOM_IPFS_DATA: path.join(tmpRoot, 'ipfs-data'),
      FREEDOM_IDENTITY_DATA: path.join(tmpRoot, 'identity'),
    };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_USER_DATA: userDataDir,
        FREEDOM_RADICLE_DATA: radHome,
        ...dirs,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 60_000,
    });

    await use(app);

    try {
      await app.close();
    } catch {
      // window may already be closed
    }
  },

  window: async ({ electronApp }, use) => {
    const win = await electronApp.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForSelector('[data-test="address-input"]', { state: 'visible' });
    await use(win);
  },
});

module.exports = { test, expect, HAS_RADICLE_ADDON, HAS_CANOPY_DIST, RADICLE_ADDON, CANOPY_DIST };
