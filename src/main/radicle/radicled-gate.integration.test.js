/**
 * The Radicle home's gate against the real freedom-radicled (freedom-core
 * design 0008, "Spawn and lock" and Rollback). Skipped unless
 * FREEDOM_RADICLED_PATH points at a build, e.g.
 *   FREEDOM_RADICLED_PATH=freedom-radicled-bin/linux-x64/freedom-radicled npx jest src/main/radicle/radicled-gate
 *
 * - a second owner gets `lock_held` (75), and takes the gate once the first
 *   lets it go;
 * - while a service (`freedom-radicled serve`) holds the home, `hold-lock`
 *   from main is refused, and so is the add-on's start;
 * - a profile delete while another process holds the profile's Radicle home
 *   fails, and removes nothing; once the home is free, it goes through;
 * - the alias rewrite is refused while another process holds the home, and
 *   written under the gate once it is free;
 * - an identity re-key while another process holds the home touches
 *   nothing, and blocks nothing; once the home is free, it wipes and asks
 *   the core for the key;
 * - a legacy home's carry-over to a new, empty short home another process
 *   holds replaces nothing; once the home is free, it carries it over;
 * - with the add-on downloaded too (`npm run radicle:download`), the add-on
 *   runs under hold-lock: a second owner is refused while it runs, and
 *   takes the gate once it has stopped; and an add-on start waiting out
 *   another writer's gate gives up at a stop, at once.
 *
 * The manager's tests other than the add-on's stand a fake in for the
 * add-on, so they run wherever the binary does. Each refusal waits out the
 * binary's 5 s of contention retries. Nothing here touches the network: the
 * service runs no node without its handshake, and the add-on's home names
 * no peer (`radicle-fixture.js`).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { holdRadicleGate, withRadicleGate } = require('./radicled-gate');
const { scrubbedEnv } = require('../core/service-client');
const { deleteProfile, ensureProfile, loadCatalog } = require('../profile-catalog');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');
const { writeIdentity } = require('../../../test/helpers/radicle-fixture');

const binary = process.env.FREEDOM_RADICLED_PATH;
const describeIfBinary = binary ? describe : describe.skip;
const SRC = path.join(__dirname, '..');
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
// Past the binary's 5 s of retries, with room to spare on a slow runner.
const REFUSAL_MS = 30_000;
const LOCK_HELD = 'The Radicle data is in use by another process. Close it and try again.';
// The add-on's control socket lives in its home (`node/control.sock`), and
// macOS's temporary directory is too long for a socket's path: a short root
// there.
const TMP_ROOT = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
// What the loaders below stand in for: a stand-in one test registers
// outlives resetModules, so each loader lets go of every one first.
const STAND_INS = [
  'logger.js',
  'profile-paths.js',
  'profile-resolver.js',
  path.join('core', 'node-identity-guard.js'),
  path.join('core', 'vault-backend.js'),
  'service-registry.js',
  'service-locks.js',
  'radicle-embedded.js',
].map((rel) => path.join(SRC, rel));
const withoutStandIns = () => STAND_INS.forEach((file) => jest.dontMock(file));

function addonAvailable() {
  let available = false;
  jest.isolateModules(() => {
    available = require('../radicle-embedded').isAvailable();
  });
  return available;
}
const testIfAddon = binary && addonAvailable() ? test : test.skip;

describeIfBinary("the Radicle home's gate with the real freedom-radicled", () => {
  let root;
  let lockDir;
  let home;
  const cleanups = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(TMP_ROOT, 'frg-'));
    lockDir = path.join(root, 'locks');
    home = path.join(root, 'R', '1');
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    // Windows may hold the add-on's files a moment after it stops.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const hold = (dir = home) => holdRadicleGate({ home: dir, lockDir, log: quietLog });

  /** Another process holding the home's gate, as the service or another
   * build's add-on would. */
  async function heldElsewhere(dir = home) {
    const held = await hold(dir);
    cleanups.push(() => held.release());
    return held;
  }

  /** `freedom-radicled serve` on the home, once it holds the gate (its
   * `serving` line): it waits for a handshake that never comes, and exits
   * 76 after 10 s. */
  async function service() {
    const ownHome = path.join(root, 'radicled-home');
    fs.mkdirSync(ownHome, { recursive: true });
    const child = spawn(
      binary,
      ['serve', '--home', home, '--lock-dir', lockDir, '--network', 'direct'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...scrubbedEnv(), HOME: ownHome } }
    );
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    cleanups.push(async () => {
      child.stdin.end();
      child.kill('SIGKILL');
      await exited;
    });
    child.stdout.resume();
    await new Promise((resolve, reject) => {
      let lines = '';
      child.stderr.on('data', (chunk) => {
        lines += chunk.toString('utf8');
        if (/"msg":"serving"/.test(lines)) resolve();
      });
      exited.then((code) => reject(new Error(`serve exited ${code} before serving: ${lines}`)));
    });
    return child;
  }

  /** The production radicle-manager on `home`, its gate the real binary's,
   * with a fake for the add-on. */
  function managerWithFakeAddon() {
    const node = { started: false };
    const embedded = {
      isAvailable: () => true,
      isStarted: () => node.started,
      start: jest.fn(async () => {
        node.started = true;
        return { did: 'did:key:z6MkFake' };
      }),
      shutdown: jest.fn(async () => {
        node.started = false;
        return { ok: true };
      }),
      connectSeeds: async () => ({ connected: 0, target: 1, targetReached: false }),
      status: async () => ({ connectedPeers: 0 }),
      cloneRepo: async () => ({ ok: true }),
      listRepos: async () => [],
      listSeededRepos: async () => [],
      getVersion: () => '0.8.0',
    };
    withoutStandIns();
    const { mod: manager } = loadMainModule(path.join(SRC, 'radicle-manager.js'), {
      extraMocks: {
        [path.join(SRC, 'logger.js')]: () => quietLog,
        [path.join(SRC, 'profile-paths.js')]: () => ({
          getRadicleDataDir: () => home,
          prepareRadicleDataDir: async () => {
            fs.mkdirSync(home, { recursive: true, mode: 0o700 });
            return home;
          },
        }),
        [path.join(SRC, 'profile-resolver.js')]: () => ({ getActiveProfile: () => null }),
        [path.join(SRC, 'core', 'node-identity-guard.js')]: () => ({
          nodeBlockReason: () => null,
        }),
        [path.join(SRC, 'service-registry.js')]: () => ({
          MODE: { EMBEDDED: 'embedded', DISABLED: 'disabled', NONE: 'none' },
          updateService() {},
          setStatusMessage() {},
          clearService() {},
        }),
        [path.join(SRC, 'service-locks.js')]: () => ({ getLockDir: () => lockDir }),
        [path.join(SRC, 'radicle-embedded.js')]: () => embedded,
      },
    });
    cleanups.push(() => manager.stopRadicle());
    return { manager, embedded };
  }

  test(
    'a second owner gets lock_held (75), and takes the gate once the first lets it go',
    async () => {
      const first = await hold();
      const started = Date.now();
      await expect(hold()).rejects.toMatchObject({
        name: 'RadicleGateError',
        code: 'lock_held',
        message: LOCK_HELD,
      });
      // It retried for 5 s first.
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
      // The lock is the service's own: radicle-<sha256(canonical home)>.lock.
      expect(fs.readdirSync(lockDir)).toEqual([
        expect.stringMatching(/^radicle-[0-9a-f]{64}\.lock$/),
      ]);

      await first.release();
      const second = await hold();
      await second.release();
    },
    REFUSAL_MS
  );

  test(
    "while a service holds the home, hold-lock is refused, and so is the add-on's start",
    async () => {
      await service();
      const { manager, embedded } = managerWithFakeAddon();

      // Both wait out the binary's retries together, inside the service's
      // 10 s wait for its handshake.
      const [held, started] = await Promise.all([
        hold().then(
          () => null,
          (err) => err
        ),
        manager.startRadicle(),
      ]);

      expect(held).toMatchObject({ name: 'RadicleGateError', code: 'lock_held' });
      expect(started).toEqual({ status: 'error', error: LOCK_HELD });
      expect(embedded.start).not.toHaveBeenCalled();
    },
    REFUSAL_MS
  );

  test(
    "a profile delete while another process holds the profile's Radicle home fails, and removes nothing",
    async () => {
      const appRoot = path.join(root, 'Freedom');
      const options = { defaultProfileDir: path.join(appRoot, 'Profiles', 'default') };
      ensureProfile(appRoot, 'default', options);
      const { record } = ensureProfile(appRoot, 'work', options);
      const radicleHome = path.join(appRoot, 'R', String(record.slot));
      fs.mkdirSync(path.join(radicleHome, 'storage'), { recursive: true });
      fs.writeFileSync(path.join(radicleHome, 'storage', 'repo'), 'seeded');
      const other = await heldElsewhere(radicleHome);
      const gate = (dir, fn) => withRadicleGate(dir, fn, { lockDir, log: quietLog });

      await expect(
        deleteProfile(appRoot, 'work', 'Work', { ...options, withRadicleGate: gate })
      ).rejects.toMatchObject({ code: 'lock_held' });
      expect(fs.readFileSync(path.join(radicleHome, 'storage', 'repo'), 'utf8')).toBe('seeded');
      expect(fs.existsSync(record.dir)).toBe(true);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default', 'work']);

      await other.release();
      await deleteProfile(appRoot, 'work', 'Work', { ...options, withRadicleGate: gate });
      expect(fs.existsSync(radicleHome)).toBe(false);
      expect(fs.readdirSync(path.dirname(radicleHome))).toEqual([]);
      expect(fs.existsSync(record.dir)).toBe(false);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default']);
    },
    REFUSAL_MS
  );

  test(
    'the alias rewrite is refused while another process holds the home, and written under the gate once it is free',
    async () => {
      const { manager } = managerWithFakeAddon();
      const configPath = path.join(home, 'config.json');
      const other = await heldElsewhere();

      await expect(manager.setNodeAlias('renamed')).resolves.toMatchObject({
        success: false,
        error: { code: 'ALIAS_WRITE_FAILED', message: LOCK_HELD },
      });
      expect(fs.existsSync(configPath)).toBe(false);

      await other.release();
      await expect(manager.setNodeAlias('renamed')).resolves.toMatchObject({ success: true });
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).node.alias).toBe('renamed');
      // The gate went with the write: it can be had again at once.
      const after = await hold();
      await after.release();
    },
    REFUSAL_MS
  );

  /** The production identity-manager, its gate the real binary's, on `home`
   * (FREEDOM_RADICLE_DATA), with a fake for the core's vault: unlocked, and
   * writing a key as the core would. */
  function identityManager() {
    const radicleBefore = process.env.FREEDOM_RADICLE_DATA;
    process.env.FREEDOM_RADICLE_DATA = home;
    cleanups.push(() => {
      if (radicleBefore === undefined) delete process.env.FREEDOM_RADICLE_DATA;
      else process.env.FREEDOM_RADICLE_DATA = radicleBefore;
    });
    const vaultBackend = {
      status: async () => ({ exists: true, unlocked: true, epoch: null, fingerprint: null }),
      addresses: async () => ({
        user_wallets: [],
        bee_wallet: '0xbee',
        publishers: [],
        radicle: { public_key: '00', did: 'did:key:zTest', node_id: 'zTest' },
      }),
      writeNodeIdentity: jest.fn(async ({ home: dir }) => {
        fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'keys', 'radicle'), 'the new key');
        return { status: 'installed', did: 'did:key:zTest', node_id: 'zTest' };
      }),
    };
    withoutStandIns();
    const userDataDir = path.join(root, 'profile');
    fs.mkdirSync(userDataDir, { recursive: true });
    const { mod } = loadMainModule(path.join(SRC, 'identity-manager.js'), {
      userDataDir,
      extraMocks: {
        [path.join(SRC, 'logger.js')]: () => quietLog,
        [path.join(SRC, 'service-locks.js')]: () => ({ getLockDir: () => lockDir }),
        [path.join(SRC, 'core', 'vault-backend.js')]: () => ({ vaultBackend }),
      },
    });
    const guard = require(path.join(SRC, 'core', 'node-identity-guard.js'));
    guard.setStartupRecovery(null);
    return { mod, vaultBackend, guard };
  }

  test(
    'an identity re-key while another process holds the home touches nothing; once free, it wipes and asks the core',
    async () => {
      const files = {
        'keys/radicle': 'the old key',
        'node/node.db': 'routing',
        'cobs/cache.db': 'cobs',
        'storage/repo/obj': 'seeded',
      };
      for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
        fs.writeFileSync(path.join(home, rel), content);
      }
      const { mod, vaultBackend, guard } = identityManager();
      const other = await heldElsewhere();

      await expect(mod.injectRadicleIdentity('Alias')).rejects.toMatchObject({
        name: 'RadicleGateError',
        code: 'lock_held',
      });
      for (const [rel, content] of Object.entries(files)) {
        expect(fs.readFileSync(path.join(home, rel), 'utf8')).toBe(content);
      }
      expect(vaultBackend.writeNodeIdentity).not.toHaveBeenCalled();
      expect(guard.nodeBlockReason('radicle')).toBeNull();

      await other.release();
      await expect(mod.injectRadicleIdentity('Alias')).resolves.toEqual({ did: 'did:key:zTest' });
      for (const dir of ['node', 'cobs', 'storage']) {
        expect(fs.existsSync(path.join(home, dir))).toBe(false);
      }
      expect(vaultBackend.writeNodeIdentity).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(path.join(home, 'keys', 'radicle'), 'utf8')).toBe('the new key');
      // The gate went before the core's write: it can be had at once.
      const after = await hold();
      await after.release();
    },
    REFUSAL_MS
  );

  test(
    "a legacy home's carry-over to a new, empty short home another process holds replaces nothing; once free, it carries it over",
    async () => {
      const appRoot = path.join(root, 'app');
      const userDataDir = path.join(appRoot, 'Profiles', 'work');
      const legacy = path.join(userDataDir, 'radicle-data');
      fs.mkdirSync(path.join(legacy, 'keys'), { recursive: true });
      fs.writeFileSync(path.join(legacy, 'keys', 'radicle.pub'), 'public-key');
      const shortHome = path.join(appRoot, 'R', '1');
      // hold-lock makes the home it holds: a service's new, empty home.
      const other = await heldElsewhere(shortHome);
      const { ino } = fs.statSync(shortHome);
      const activeProfile = { source: 'catalog', appRoot, isDev: false, metadata: { slot: 1 } };
      withoutStandIns();
      const { mod: paths } = loadMainModule(path.join(SRC, 'profile-paths.js'), {
        userDataDir,
        extraMocks: {
          [path.join(SRC, 'logger.js')]: () => quietLog,
          [path.join(SRC, 'profile-resolver.js')]: () => ({
            getActiveProfile: () => activeProfile,
          }),
          [path.join(SRC, 'service-locks.js')]: () => ({ getLockDir: () => lockDir }),
        },
      });

      await expect(paths.prepareRadicleDataDir()).rejects.toMatchObject({ code: 'lock_held' });
      expect(fs.statSync(shortHome).ino).toBe(ino);
      expect(fs.readdirSync(shortHome)).toEqual([]);
      expect(fs.readdirSync(path.dirname(shortHome))).toEqual(['1']);

      await other.release();
      await expect(paths.prepareRadicleDataDir()).resolves.toBe(shortHome);
      expect(fs.readFileSync(path.join(shortHome, 'keys', 'radicle.pub'), 'utf8')).toBe(
        'public-key'
      );
      expect(fs.readdirSync(path.dirname(shortHome))).toEqual(['1']);
    },
    REFUSAL_MS
  );

  /** The production radicle-manager on the real add-on, on a home with the
   * fixture's identity and no peer (radicle-contract-backends.js). */
  async function managerWithAddon() {
    const { BACKENDS } = require('../../../test/helpers/radicle-contract-backends');
    withoutStandIns();
    writeIdentity(home);
    const backend = await BACKENDS.addon.load({ home });
    cleanups.push(() => backend.close());
    return backend;
  }

  testIfAddon(
    'the add-on runs under hold-lock: a second owner is refused while it runs, and takes the gate once it has stopped',
    async () => {
      const backend = await managerWithAddon();
      await backend.start();
      expect(backend.embedded.isStarted()).toBe(true);

      await expect(
        holdRadicleGate({ home, lockDir: backend.lockDir, log: quietLog })
      ).rejects.toMatchObject({ code: 'lock_held' });

      await backend.stop();
      expect(backend.embedded.isStarted()).toBe(false);
      const after = await holdRadicleGate({ home, lockDir: backend.lockDir, log: quietLog });
      await after.release();
    },
    REFUSAL_MS * 2
  );

  testIfAddon(
    "an add-on start waiting out another writer's gate gives up at a stop, at once",
    async () => {
      const backend = await managerWithAddon();
      const other = await holdRadicleGate({ home, lockDir: backend.lockDir, log: quietLog });
      cleanups.push(() => other.release());

      const starting = backend.manager.startRadicle();
      // hold-lock is retrying against the other holder.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const stopped = Date.now();
      await backend.manager.stopRadicle();

      await expect(starting).resolves.toEqual({ status: 'stopped', error: null });
      expect(Date.now() - stopped).toBeLessThan(2_000);
      expect(backend.embedded.isStarted()).toBe(false);
    },
    REFUSAL_MS
  );
});
