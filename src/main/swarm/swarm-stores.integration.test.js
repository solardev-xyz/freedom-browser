/**
 * The gates of SWM-6's store move (freedom-core design 0015: SWM-6's
 * Done-when, D3, D10 and the 2026-11-28 amendment; the SWM-6 to SWM-9
 * plan's PR 6.5, with its points 1, 2 and 5): the three Swarm stores,
 * swarm-feeds.json, swarm-manifest-grants.json and publish-history.sqlite,
 * on the real freedom-cored. No build's hello names `swarm_stores` before
 * PR 7.4: here the hello is the test's (`storeMovedFor('core', {
 * swarmStores: true })`), and main's `swarmStoresNamed()` says so.
 *
 * - **Each module's suite against the core:** feed-store.js's,
 *   permission-manifests.js's and publish-history.js's store cases
 *   (test/helpers/{feed-store,permission-manifest,publish-history}-cases.js),
 *   played through main's handlers and own calls against the pinned core,
 *   each case on a core of its own: each answer equals the reference's
 *   (test/helpers/reference-*.js, on a root of its own) for the same
 *   sequence, and the core's files end as the reference's.
 * - **An `fs` spy over the whole run** (store-handover.js
 *   `watchFileTouches`): every `fs` call that takes a path, in every form,
 *   and every better-sqlite3 open, of any of the three stores' files (their
 *   backups, temporary files, `.bak`, `-wal`, `-shm` and the legacy
 *   publish-history.json included), with the stack it came from. Main
 *   (src/main, in any registry) makes none while the core holds the stores;
 *   on Linux it also holds no descriptor of one (`/proc/self/fd`) after each
 *   of its runs. The reference modules' touches and the test's own are told
 *   apart by their stacks.
 * - **Rollback both ways** (point 2), in the profile's root layout and in
 *   the Freedom root layout (a moved profile, the legacy file at the
 *   profile's root): one run on the real core makes identities, feed
 *   records (a page's `swarm_createFeed` through main's dispatcher on the
 *   core, page-swarm-core.js, against a node on loopback), grants (a feed
 *   grant, and a manifest's projections), manifest records and history rows
 *   (completed, failed, and the legacy publish-history.json the core
 *   imports at its start, D10); then the next start on `js`, this build's
 *   own modules on the JS backend and then the reference modules
 *   (test/helpers/reference-*.js), loads those files and gives the core's
 *   answers (`get-all-origins`, `get-origin-identities`, manifest `get`,
 *   history `list`) and its feed's record. The other way, the core loads
 *   what the reference wrote and gives the same answers, and the next start
 *   on `js` reads back what the core then wrote. Each row comes back once:
 *   js→core→js, and core→js where the core was the first to import the
 *   legacy file (in the Freedom root layout the build's own start retires
 *   the profile root's original, #1386's fix of what the core's hand-over
 *   leaves there until its next start). Only the deviations the amendment
 *   names differ, each asserted as that difference: `history-bound`'s
 *   trim, `store-shapes`' repairs, and D10's import.
 *
 * Skipped without the binary; FREEDOM_CORED_STORES_TEST=1 requires it (npm
 * run core:download, npm run core:download:previous).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');
const {
  coredBinaries,
  openFiles,
  startCore,
  watchFileTouches,
} = require('../../../test/helpers/store-handover');
const { startFakeHttpNode } = require('../../../test/helpers/fake-http-node');
const { useSimulatedGrantCore } = require('../../../test/helpers/simulated-grant-core');
const feedCases = require('../../../test/helpers/feed-store-cases');
const manifestCases = require('../../../test/helpers/permission-manifest-cases');
const historyCases = require('../../../test/helpers/publish-history-cases');
const IPC = require('../../shared/ipc-channels');
const { id } = require('ethers');

// A core per case, and a run of 10,003 rows.
jest.setTimeout(180_000);

const { current } = coredBinaries();
const describeIfCurrent = current && fs.existsSync(current) ? describe : describe.skip;

const PASSWORD = 'swarm-stores-gate-pass-1';
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PUBLISHERS = [0, 1, 2, 3, 4, 5, 6, 7];
const shell = { caller: 'shell' };
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FEEDS_FILE = 'swarm-feeds.json';
const MANIFESTS_FILE = 'swarm-manifest-grants.json';
const GRANTS_FILE = 'swarm-permissions.json';
const { HISTORY_FILE, LEGACY_FILE } = historyCases;

/** The three stores' files: each name, its backups, temporary files and SQLite's. */
const STORE_STEMS = ['swarm-feeds', 'swarm-manifest-grants', 'publish-history'];
function isStoreFile(target) {
  const base = String(target).split(/[\\/]/).pop();
  return STORE_STEMS.some((stem) => base.startsWith(`${stem}.`)) && !base.endsWith('.js');
}

// Every touch of a store's file, from the suite's first hook to its last
// (installed only where the suite runs: Node's fs is the worker's).
let watch = null;

/** The store files this process holds open (Linux), or null elsewhere. */
function heldStoreFiles() {
  const held = openFiles(process.pid);
  return held && held.filter(isStoreFile);
}

/** Main's touches since `mark`, as `[call, path]`. */
function mainTouchesSince(mark) {
  return watch
    .since(mark)
    .filter((touch) => touch.main)
    .map(({ name, path: file }) => [name, file]);
}

const quietLog = () => ({
  info() {},
  warn() {},
  error() {},
  debug() {},
  transports: { file: {}, console: {} },
});

/** better-sqlite3, each open recorded in the watch, for main's registry and the reference's. */
function spiedDatabase() {
  const Real = jest.requireActual('better-sqlite3');
  return function SpiedDatabase(file, options) {
    watch.record('better-sqlite3', file);
    return new Real(file, options);
  };
}

/**
 * The reference's owners, as identity-manager.js reads them from the vault:
 * the core's addresses for the same phrase, and its messages while locked.
 */
function ownersOf(state) {
  return {
    getBeeWalletAddress: async () => (state.unlocked ? state.addresses.bee_wallet : null),
    getPublisherAddress: async (index) => {
      if (!state.unlocked) throw new Error('Vault must be unlocked to derive publisher keys');
      const found = state.addresses.publishers.find((one) => one.origin_index === index);
      if (!found) throw new Error(`no address for publisher ${index} in the test`);
      return found.address;
    },
    getDerivedWallets: async () => state.wallets,
  };
}

/**
 * One fresh registry whose profile is `userDataDir`, as `kind` says:
 * - `'core'`: main's three store modules on the core (`world.core`, set by
 *   `startNamed`; their hello names `swarm_stores`), and the reference
 *   modules beside them on `userDataDir`'s Freedom root, for the module
 *   suites;
 * - `'js'`: main's three store modules on the JS backend (this build's
 *   next start on `js`), keeping their own files, alone;
 * - `'reference'`: the reference modules alone (a build before SWM-6, or
 *   the JS backend as the plan's point 2 reads it).
 * Main's modules and the reference's never share a registry on `js`: both
 * would keep the same files and set swarm-permissions.js's one hook. A
 * manifest's fetch answers `serving.spec` (permission-manifest-cases.js
 * `responseFor`) and is kept in `fetched`; the node's API is `nodeUrl`.
 */
function loadWorld({ userDataDir, kind = 'core', owners, nodeUrl = null }) {
  // The core, once started on this registry's client (`startNamed`).
  const world = { core: null, kind };
  const serving = { spec: undefined };
  const fetched = [];
  const handleBzzRequest = jest.fn(async (request) => {
    fetched.push(request.url);
    const response = manifestCases.responseFor(serving.spec);
    if (!response) throw new Error('fetch failed');
    return response;
  });
  // A fresh registry with the mocks below (anchored on a module with no
  // dependencies); the store modules are required into it after.
  const { ipcMain } = loadMainModule(require.resolve('../../shared/ipc-channels'), {
    userDataDir,
    electronOverrides: {
      session: {
        defaultSession: { partition: 'default' },
        fromPartition: (partition) => ({ partition }),
      },
    },
    extraMocks: {
      [require.resolve('../core/core-process')]: () => ({ getCoreClient: () => world.core }),
      [require.resolve('../core/core-client')]: () => ({
        ...jest.requireActual('../core/core-client'),
        swarmStoresNamed: () => kind === 'core',
      }),
      [require.resolve('../identity-manager')]: () => owners,
      [require.resolve('../logger')]: quietLog,
      'electron-log': quietLog,
      'better-sqlite3': spiedDatabase,
      [require.resolve('../private/private-windows')]: () => ({
        getPartitionForWebContents: () => null,
        isPrivateWebContents: () => false,
      }),
      [require.resolve('./bzz-protocol')]: () => ({
        ...jest.requireActual('./bzz-protocol'),
        handleBzzRequest,
      }),
      [require.resolve('../service-registry')]: () => ({
        MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', REUSED: 'reused' },
        getAntApiUrl: () => nodeUrl,
        getService: () => ({ mode: 'bundled' }),
      }),
      [require.resolve('../profile-resolver')]: () => ({ getActiveProfile: () => null }),
      [require.resolve('../core/dweb-verify')]: () => ({ dwebVerifier: () => null }),
      [require.resolve('../core/naming')]: () => ({ namingDriver: () => null }),
    },
  });
  /** `modules` loaded and their IPC registered: the modules, and their handlers by channel. */
  const register = (modules) => {
    modules.feeds.registerFeedStoreIpc();
    modules.manifests.registerPermissionManifestIpc();
    modules.history.registerPublishHistoryIpc();
    const handlers = new Map(ipcMain.handlers);
    ipcMain.handlers.clear();
    return handlers;
  };
  let main = null;
  let mainHandlers = null;
  let reference = null;
  let referenceHandlers = null;
  if (kind !== 'reference') {
    main = {
      feeds: require('./feed-store'),
      manifests: require('./permission-manifests'),
      history: require('./publish-history'),
    };
    mainHandlers = register(main);
  }
  if (kind !== 'js') {
    reference = {
      feeds: require('../../../test/helpers/reference-feed-store'),
      manifests: require('../../../test/helpers/reference-permission-manifests'),
      history: require('../../../test/helpers/reference-publish-history'),
    };
    referenceHandlers = register(reference);
  }
  return Object.assign(world, {
    main,
    reference,
    mainHandlers,
    referenceHandlers,
    serving,
    fetched,
    // The registry's own, for the page path and the grants.
    require: (request) => require(request),
  });
}

/**
 * Main's Swarm executor (core/swarm-shell.js, its manifest fetch the
 * registry's permission-manifests.js) and `approval.recheck` on `client`,
 * and main's dispatcher on the core (page/page-swarm-core.js) through
 * them, for a world loaded with the client: the executor's switch reads
 * `core`, and freedom://publish's readiness is ready.
 */
function attachSwarm(world, client) {
  const { registerSwarmShell } = world.require('../core/swarm-shell');
  const { createCoreRequests } = world.require('../page/page-core-requests');
  const { createSwarmCoreExecute } = world.require('../page/page-swarm-core');
  const { antBackend } = world.require('./bzz-protocol');
  const swarmShell = registerSwarmShell(client, {
    backendKind: () => 'core',
    publishReadiness: async () => ({ ok: true }),
  });
  const coreRequests = createCoreRequests();
  client.handle('approval.recheck', (params, context) => coreRequests.recheck(params, context));
  world.execute = createSwarmCoreExecute({
    coreClient: () => client,
    swarmShell: () => swarmShell,
    coreRequests,
    nodeBackend: () => antBackend({ session: null }),
    resetVaultTimer: () => {},
    log: quietLog(),
  });
  return world;
}

/** A page's request context for `key`, live, as page-requests.js gives page-swarm.js one. */
function pageRequest(key) {
  const page = { origin: key, top_origin: key, frame: 1001, navigation: 1, agent: false };
  return {
    requester: { key, topKey: key, transportKey: key, guest: 1, navigation: 1 },
    pageContext: () => page,
    signal: new AbortController().signal,
    isCurrent: () => true,
    holdsKey: () => true,
    whenAnswered: async () => ({ delivered: true }),
  };
}

const BATCH = 'a1'.repeat(32);
const STAMPS = JSON.stringify({
  stamps: [
    {
      batchID: BATCH,
      utilization: 0,
      usable: true,
      label: 'freedom',
      depth: 22,
      amount: '100000000000',
      bucketDepth: 16,
      blockNumber: 1000,
      immutableFlag: true,
      exists: true,
      batchTTL: 864000,
    },
  ],
});
const FEED_MANIFEST = 'fe'.repeat(32);

/** A node on loopback: `/stamps` and a feed manifest's `POST /feeds/<owner>/<topic>`. */
async function startNode() {
  const node = await startFakeHttpNode();
  node.calls = [];
  node.handle((req, res) => {
    const { pathname } = new URL(req.url, 'http://node');
    node.calls.push(`${req.method} ${pathname}`);
    if (req.method === 'GET' && pathname === '/stamps') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(STAMPS),
      });
      res.end(STAMPS);
      return;
    }
    if (req.method === 'POST' && pathname.startsWith('/feeds/')) {
      req.resume();
      req.on('end', () => {
        const body = JSON.stringify({ reference: FEED_MANIFEST });
        res.writeHead(201, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 404, message: 'Not Found' }));
  });
  return node;
}

describeIfCurrent('the Swarm stores on the pinned freedom-cored (SWM-6 gates)', () => {
  const dirs = [];
  let chosen;
  // The core's addresses and derived wallets for ABANDON.
  let ADDRESSES;
  let WALLETS;

  const tempDir = (name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `swarm-stores-${name}-`));
    dirs.push(dir);
    return dir;
  };

  async function importVault(core) {
    await core.request(
      'vault.import',
      {
        password_b64: b64(PASSWORD),
        mnemonic_b64: b64(ABANDON),
        overwrite: false,
        user_knows_password: true,
      },
      shell
    );
  }

  beforeAll(async () => {
    watch = watchFileTouches(isStoreFile, { skip: [__filename] });
    ({ storeMovedFor: chosen } = jest.requireActual('../core/core-client'));
    chosen = chosen('core', { swarmStores: true });
    const core = await startCore({ binary: current, root: tempDir('addresses') });
    try {
      await importVault(core);
      ADDRESSES = await core.request(
        'keys.addresses',
        { accounts: [], publishers: PUBLISHERS },
        shell
      );
      WALLETS = (await core.request('accounts.list', {}, shell)).wallets;
    } finally {
      await core.stop();
    }
  });

  afterAll(() => {
    watch?.restore();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A core on `root` whose hello names `swarm_stores`, on `world`'s
   * registry (its client's classes main's, JsonText's among them), with
   * main's Swarm executor and dispatcher attached when `swarm`.
   */
  async function startNamed(root, world, { swarm = false, ...options } = {}) {
    const core = await startCore({
      binary: current,
      root,
      storeMoved: chosen,
      ...options,
      beforeStart: (client) => {
        world.core = client;
        if (swarm) attachSwarm(world, client);
      },
    });
    expect(core.hello.store_moved).toEqual([...chosen]);
    return core;
  }

  const unlockedOwners = () => ownersOf({ unlocked: true, addresses: ADDRESSES, wallets: WALLETS });

  // ---- Each module's suite against the core ----

  describe("feed-store.js's store cases", () => {
    test.each(feedCases.FEED_STORE_CASES.map((kase) => [kase.name, kase]))(
      '%s',
      async (_name, kase) => {
        const root = tempDir('feeds-core');
        const referenceDir = tempDir('feeds-reference');
        if (kase.seed) {
          // Before the core starts: its swarm thread loads the store then.
          fs.writeFileSync(path.join(root, FEEDS_FILE), kase.seed);
          fs.writeFileSync(path.join(referenceDir, FEEDS_FILE), kase.seed);
        }
        const state = { unlocked: true, addresses: ADDRESSES, wallets: WALLETS };
        const world = loadWorld({ userDataDir: referenceDir, owners: ownersOf(state) });
        const core = await startNamed(root, world);
        try {
          await importVault(core);
          if (kase.vault === 'locked') await core.request('vault.lock', {}, shell);

          const side = (feeds, handlers, vault, which) => ({
            chrome: (channel, args) => handlers.get(channel)({}, ...args),
            main: (op, args) => feeds[op](...feedCases.mainOpArgs(op, args)[which]),
            vault,
          });
          const mainSide = side(
            world.main.feeds.coreOps,
            world.mainHandlers,
            (to) =>
              to === 'unlock'
                ? core.request('vault.unlock', { password_b64: b64(PASSWORD) }, shell)
                : core.request('vault.lock', {}, shell),
            0
          );
          const referenceSide = side(
            world.reference.feeds,
            world.referenceHandlers,
            (to) => {
              state.unlocked = to === 'unlock';
            },
            1
          );

          const mark = watch.mark();
          let mainTouches;
          let held;
          const played = await feedCases.playFeedStoreCase(kase, {
            main: mainSide,
            reference: referenceSide,
            between: () => {
              mainTouches = mainTouchesSince(mark);
              held = heldStoreFiles();
              // The reference's run starts from the case's vault.
              state.unlocked = kase.vault !== 'locked';
            },
          });

          expect(mainTouches).toEqual([]);
          if (held) expect(held).toEqual([]);
          // Each answer is the reference's, step by step.
          expect(played.map(({ step, main }) => [step, main])).toEqual(
            played.map(({ step, reference }) => [step, reference])
          );
          // The core's file ends as the reference's.
          const read = (dir) =>
            feedCases.normalized(JSON.parse(fs.readFileSync(path.join(dir, FEEDS_FILE), 'utf8')));
          if (fs.existsSync(path.join(referenceDir, FEEDS_FILE))) {
            expect(read(root)).toEqual(read(referenceDir));
          } else {
            expect(fs.existsSync(path.join(root, FEEDS_FILE))).toBe(false);
          }
        } finally {
          await core.stop();
        }
      }
    );
  });

  describe("permission-manifests' store cases", () => {
    const MANIFEST_FILES = [MANIFESTS_FILE, GRANTS_FILE, FEEDS_FILE];
    const OWNERS = {
      getBeeWalletAddress: async () => '0xBee0000000000000000000000000000000000000',
      getPublisherAddress: async (index) => `0xPublisher${index}`,
      getDerivedWallets: async () => [],
    };

    /** A store file of `dir`, parsed and normalized; its text where it isn't JSON; or null. */
    const fileOf = (dir, name) => {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) return null;
      const text = fs.readFileSync(file, 'utf8');
      try {
        return manifestCases.normalized(JSON.parse(text));
      } catch {
        return text;
      }
    };

    const seeded = (dir, kase) => {
      for (const [file, text] of Object.entries(kase.seed?.files ?? {})) {
        fs.writeFileSync(path.join(dir, file), text);
      }
    };

    /** `kase` played on `module`'s page path and the chrome's `handlers`. */
    const playOn = (world, module, handlers) => (kase) =>
      manifestCases.playPermissionManifestCase(kase, {
        serve: (spec) => {
          world.serving.spec = spec;
        },
        guest: () => ({ isDestroyed: () => false }),
        check: (request) => module.checkPageManifest(request),
        decide: (...args) => module.decidePageManifest(...args),
        release: (token) => module.releasePageManifest(token),
        handlers: Object.fromEntries(handlers),
      });

    test.each(manifestCases.PERMISSION_MANIFEST_CASES.map((kase) => [kase.name, kase]))(
      '%s',
      async (_name, kase) => {
        const root = tempDir('manifests-core');
        const referenceDir = tempDir('manifests-reference');
        // Before the core starts: its swarm thread loads the stores then, and
        // its grant store the Swarm grants.
        seeded(root, kase);
        const grantSeed = kase.seed?.grants?.swarm;
        if (grantSeed) {
          fs.writeFileSync(path.join(root, GRANTS_FILE), JSON.stringify(grantSeed, null, 2), {
            mode: 0o600,
          });
        }
        seeded(referenceDir, kase);

        const world = loadWorld({ userDataDir: referenceDir, owners: OWNERS });
        const core = await startNamed(root, world, { swarm: true });
        const mark = watch.mark();
        let mainRun;
        try {
          mainRun = await playOn(world, world.main.manifests, world.mainHandlers)(kase);
        } finally {
          await core.stop();
        }
        expect(mainTouchesSince(mark)).toEqual([]);
        const held = heldStoreFiles();
        if (held) expect(held).toEqual([]);
        expect(world.main.manifests._manifestAskCountForTests()).toBe(0);
        const mainFetched = world.fetched.splice(0);

        // The reference's run, today's main on its own files, its Swarm
        // grants on a simulated grant core.
        const grantCore = await useSimulatedGrantCore({ swarm: grantSeed ?? {} });
        const referenceRun = await playOn(
          world,
          world.reference.manifests,
          world.referenceHandlers
        )(kase);
        fs.writeFileSync(path.join(referenceDir, GRANTS_FILE), grantCore.file('swarm'));

        // Each answer is the reference's, step by step, and so is each fetch.
        expect(
          manifestCases.normalized(mainRun).map((outcome, i) => [kase.steps[i], outcome])
        ).toEqual(
          manifestCases.normalized(referenceRun).map((outcome, i) => [kase.steps[i], outcome])
        );
        expect(mainFetched).toEqual(world.fetched);
        // The core's files end as the reference's (its grants as the
        // simulated grant core writes them; none where it holds none).
        for (const file of MANIFEST_FILES) {
          const expected = fileOf(referenceDir, file);
          const empty = file === GRANTS_FILE && expected && Object.keys(expected).length === 0;
          expect([file, fileOf(root, file) ?? (empty ? {} : null)]).toEqual([file, expected]);
        }
      }
    );
  });

  describe("publish-history.js's cases", () => {
    test.each(historyCases.PUBLISH_HISTORY_CASES.map((kase) => [kase.name, kase]))(
      '%s',
      async (_name, kase) => {
        const root = tempDir('history-core');
        const referenceDir = tempDir('history-reference');
        // Before the core starts: its history opens, and imports, from then.
        historyCases.seedLegacy(kase, root);
        historyCases.seedLegacy(kase, referenceDir);
        const world = loadWorld({ userDataDir: referenceDir, owners: unlockedOwners() });
        const core = await startNamed(root, world);
        try {
          const mainSide = {
            chrome: (channel) => world.mainHandlers.get(channel)({}),
            main: (fn, args) => world.main.history.coreOps[fn](...args),
          };
          const referenceSide = {
            chrome: (channel) => world.referenceHandlers.get(channel)({}),
            main: (fn, args) => world.reference.history[fn](...args),
          };
          const mark = watch.mark();
          let mainTouches;
          let held;
          let coreFiles;
          let played;
          try {
            played = await historyCases.playPublishHistoryCase(kase, {
              main: mainSide,
              reference: referenceSide,
              between: () => {
                mainTouches = mainTouchesSince(mark);
                held = heldStoreFiles();
                coreFiles = historyCases.legacyFiles(root);
              },
            });
          } finally {
            world.reference.history.closeDb();
          }
          expect(mainTouches).toEqual([]);
          if (held) expect(held).toEqual([]);
          expect(played.map(({ step, main }) => [step, main])).toEqual(
            played.map(({ step, reference }) => [step, reference])
          );
          expect(coreFiles).toEqual(historyCases.legacyFiles(referenceDir));
          await core.stop();
          expect(readRows(root)).toEqual(readRows(referenceDir));
        } finally {
          await core.stop();
        }
      }
    );
  });

  // ---- Rollback both ways (the plan, point 2) ----

  /**
   * A profile in `layout`: `'root'` (the Freedom root the profile's
   * directory) or `'freedom'` (a moved profile: `freedom/` with its
   * layout.json). The legacy publish-history.json, where `legacy` is
   * given, at the profile's root, where the browser kept it.
   */
  function profileIn(layout, name, legacy) {
    const profile = tempDir(`${name}-${layout}`);
    const root = layout === 'freedom' ? path.join(profile, 'freedom') : profile;
    if (layout === 'freedom') {
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'layout.json'), JSON.stringify({ version: 1 }));
    }
    if (legacy !== undefined) fs.writeFileSync(path.join(profile, LEGACY_FILE), legacy);
    return { profile, root, layout };
  }

  /** The core on a profile, as main starts it: grant root the Freedom root, user_data_dir the profile. */
  async function startOnProfile({ profile, root }, world, options = {}) {
    const core = await startNamed(profile, world, {
      ...options,
      grantRoot: root,
      userDataDir: profile,
    });
    expect(core.service.helloParams(core)).toMatchObject({
      grant_root: root,
      user_data_dir: profile,
    });
    return core;
  }

  /**
   * What the chrome reads of the three stores through `handlers` (main's,
   * relayed to the core or on its own files, or the reference's): every
   * site's entry, each of `SITES`' identities with their owners and its
   * manifest record, and the history's rows.
   */
  async function answersOf(handlers) {
    const call = (channel, ...args) => handlers.get(channel)({}, ...args);
    const identities = {};
    const manifests = {};
    for (const site of SITES) {
      identities[site] = await call(IPC.SWARM_GET_ORIGIN_IDENTITIES, site);
      manifests[site] = await call(IPC.SWARM_MANIFEST_GET, site);
    }
    return {
      origins: await call(IPC.SWARM_GET_ALL_ORIGINS),
      identities,
      manifests,
      history: await call('swarm:get-publish-history'),
    };
  }

  /** A js world on `profile` (`loadWorld`'s `'js'` or `'reference'`). */
  function jsWorld(profile, kind = 'reference') {
    return loadWorld({ userDataDir: profile, kind, owners: unlockedOwners() });
  }

  /** A js world's own modules: main's on the JS backend, or the reference's. */
  const modulesOf = (world) => world.main ?? world.reference;

  /**
   * The next start on `js`, on `place`: first this build's own modules on
   * the JS backend (main is the files' writer there, so its touches are
   * kept apart), then the reference modules, each in a registry of its
   * own. Resolves `{ js, reference }`, each `{ answers, read }`: the
   * chrome's reads, and `read(modules)`'s.
   */
  async function nextStartOnJs(place, read = () => null) {
    const out = {};
    for (const kind of ['js', 'reference']) {
      out[kind] = await watch.allowed(async () => {
        const world = jsWorld(place.profile, kind);
        try {
          const handlers = world.mainHandlers ?? world.referenceHandlers;
          return { answers: await answersOf(handlers), read: await read(modulesOf(world)) };
        } finally {
          modulesOf(world).history.closeDb();
          // Registration's own reads (an interrupted change's recovery) end first.
          await pause(20);
        }
      });
    }
    return out;
  }

  /** No row twice: each id once, and no two rows alike but for their id. */
  function expectNoRowTwice(rows) {
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    const alike = rows.map(({ id: _id, ...rest }) => JSON.stringify(rest));
    expect(new Set(alike).size).toBe(rows.length);
  }

  const LEGACY_ENTRIES = [
    {
      id: 'legacy-1',
      type: 'directory',
      name: 'old-site',
      status: 'completed',
      reference: 'legacyref',
      bzzUrl: 'bzz://legacyref',
      tagUid: 100,
      batchIdUsed: 'legacybatch',
      timestamp: '2026-04-15T19:30:32.540Z',
    },
    {
      id: 'legacy-2',
      type: 'feed-create',
      name: 'feed-x',
      status: 'failed',
      timestamp: '2026-04-15T19:31:00.000Z',
    },
  ];
  const LEGACY_TEXT = JSON.stringify({ version: 1, entries: LEGACY_ENTRIES });
  /** Each legacy entry's rows, by its name. */
  const legacyRows = (rows) =>
    Object.fromEntries(
      LEGACY_ENTRIES.map(({ name }) => [name, rows.filter((row) => row.name === name).length])
    );
  const ONCE = { 'old-site': 1, 'feed-x': 1 };

  const BLOG = 'blog.eth';
  const SHOP = 'shop.eth';
  const APP = 'app.eth';
  const SITES = [BLOG, SHOP, APP, 'none.eth'];
  const APP_MANIFEST = manifestCases.manifest({
    publish: { why: 'Publish releases' },
    feeds: { why: 'Update the app feed' },
  });

  /** A site's stored identities, of its `get-origin-identities` answer (not the Ant wallet's offer). */
  const storedOf = (state) => state.identities.filter((identity) => identity.stored);

  /** A page's feed topic, as feed-service.js derives it: keccak256 of `<key>/<name>`. */
  const topicOf = (key, name) => id(`${key}/${name}`).slice(2);

  /** The address of an identity, as the core's vault derives it for the same phrase. */
  function addressOf(identity) {
    return identity.mode === 'bee-wallet'
      ? ADDRESSES.bee_wallet
      : ADDRESSES.publishers.find((one) => one.origin_index === identity.publisherKeyIndex).address;
  }

  /**
   * The state both directions make, through `ops`: identities (an
   * app-scoped one made by the chrome, the Ant wallet's beside it, the
   * first made active again; one at an index a feed prompt previewed), a
   * feed grant, a manifest's allow (its record, its grants and its
   * projection onto the feed store), a page's feed (its record and its
   * history row), and history rows, one completed and one failed. Resolves
   * the page's feed answer.
   */
  async function makeState(world, handlers, ops) {
    const call = (channel, ...args) => handlers.get(channel)({}, ...args);
    await call(IPC.SWARM_CREATE_APP_SCOPED_IDENTITY, BLOG, { label: 'Blog key' });
    await pause(3);
    await call(IPC.SWARM_ENSURE_ANT_WALLET_IDENTITY, BLOG, { activate: true });
    await pause(3);
    const before = await call(IPC.SWARM_GET_ORIGIN_IDENTITIES, BLOG);
    const appScoped = before.identities.find((one) => one.mode === 'app-scoped');
    await call(IPC.SWARM_ACTIVATE_FEED_IDENTITY, BLOG, appScoped.id);
    await ops.grantFeedAccess(BLOG);
    const preview = await ops.previewAppScopedIdentity(SHOP);
    await ops.createAppScopedIdentityAt(SHOP, preview.publisherKeyIndex);

    world.serving.spec = APP_MANIFEST;
    const consent = await ops.check({
      key: APP,
      url: `bzz://${APP}/`,
      guest: { isDestroyed: () => false },
      eager: true,
    });
    expect(consent).toMatchObject({ kind: 'consent', token: expect.any(String) });
    await ops.decide(APP, consent.token, 'allow', { recheck: async () => true, holds: () => true });
    await pause(3);
    const feed = await ops.feed(APP, 'notes');

    await pause(3);
    const done = await ops.addEntry({
      type: 'file',
      name: 'done.txt',
      origin: 'freedom://publish',
      status: 'uploading',
    });
    await pause(3);
    await ops.updateEntry(done.id, { status: 'completed', reference: 'ab'.repeat(32) });
    await pause(3);
    const failed = await ops.addEntry({ type: 'data', name: 'failed', origin: 'freedom://agent' });
    await ops.updateEntry(failed.id, { status: 'failed', errorMessage: 'stamp expired' });
    return feed;
  }

  /** A page's swarm_createFeed through main's dispatcher on the core, approved by the site's rule. */
  async function pageFeed(world, key, name) {
    const out = await world.execute('swarm_createFeed', { name }, key, undefined, {
      context: pageRequest(key),
      approval: 'auto',
    });
    expect(out).toEqual({ result: expect.any(Object) });
    return out.result;
  }

  /** Main's calls on the core, for `makeState`. */
  function coreOps(world) {
    const { feeds, manifests, history } = world.main;
    return {
      grantFeedAccess: (key) => feeds.coreOps.grantFeedAccess(key),
      previewAppScopedIdentity: (key) => feeds.coreOps.previewAppScopedIdentity(key),
      createAppScopedIdentityAt: (key, index) =>
        feeds.coreOps.createAppScopedIdentityAt(key, index, { activate: true }),
      check: (request) => manifests.checkPageManifest(request),
      decide: (...args) => manifests.decidePageManifest(...args),
      feed: (key, name) => pageFeed(world, key, name),
      addEntry: (entry) => history.coreOps.addEntry(entry),
      updateEntry: (id, updates) => history.coreOps.updateEntry(id, updates),
    };
  }

  /** The reference's calls, as the JS backend makes them, for `makeState`. */
  function jsOps(world) {
    const { feeds, manifests, history } = world.reference;
    return {
      grantFeedAccess: async (key) => feeds.grantFeedAccess(key, { source: 'user' }),
      previewAppScopedIdentity: (key) => feeds.previewAppScopedIdentity(key),
      createAppScopedIdentityAt: async (key, index) =>
        feeds.createAppScopedIdentityAt(key, index, { activate: true, source: 'user' }),
      check: (request) => manifests.checkPageManifest(request),
      decide: (...args) => manifests.decidePageManifest(...args),
      // swarm-provider-ipc.js's handleCreateFeed: its history row, the
      // node's manifest, the feed's record, the row completed; then a feed
      // update's reference (handleUpdateFeed).
      feed: async (key, name) => {
        const entry = feeds.getOriginEntry(key);
        const identity = entry.identities[entry.activeIdentityId];
        const row = history.addEntry({
          type: 'feed-create',
          name,
          status: 'uploading',
          origin: key,
        });
        const result = {
          topic: topicOf(key, name),
          owner: addressOf(identity),
          manifestReference: FEED_MANIFEST,
          bzzUrl: `bzz://${FEED_MANIFEST}`,
        };
        feeds.setFeed(key, name, {
          topic: result.topic,
          owner: result.owner,
          manifestReference: result.manifestReference,
          identityId: identity.id,
        });
        await pause(3);
        history.updateEntry(row.id, { status: 'completed', ...result });
        feeds.updateFeedReference(key, name, 'ef'.repeat(32));
        return { feedId: name, ...result, identityMode: identity.mode };
      },
      addEntry: async (entry) => history.addEntry(entry),
      updateEntry: async (id, updates) => history.updateEntry(id, updates),
    };
  }

  describe.each([
    ['root', "the profile's root layout"],
    ['freedom', 'the Freedom root layout'],
  ])('rollback in %s (%s)', (layout) => {
    test('core → js: the next start on js loads what the core wrote and gives its answers', async () => {
      const place = profileIn(layout, 'core-js', LEGACY_TEXT);

      // One run on the core, its swarm thread importing the legacy file
      // at its start (D10).
      const node = await startNode();
      const world = loadWorld({
        userDataDir: tempDir('unused'),
        owners: unlockedOwners(),
        nodeUrl: node.origin,
      });
      const core = await startOnProfile(place, world, { swarm: true });
      const mark = watch.mark();
      let answers;
      let feed;
      try {
        await importVault(core);
        feed = await makeState(world, world.mainHandlers, coreOps(world));
        answers = await answersOf(world.mainHandlers);
      } finally {
        await core.stop();
        await node.close();
      }
      expect(mainTouchesSince(mark)).toEqual([]);
      const held = heldStoreFiles();
      if (held) expect(held).toEqual([]);

      // What the core made, as its answers say. The page's feed: one
      // /stamps read and its manifest's POST, at its owner and topic.
      const [appIdentity] = storedOf(answers.identities[APP]);
      expect(feed).toEqual({
        feedId: 'notes',
        owner: addressOf(appIdentity),
        topic: topicOf(APP, 'notes'),
        manifestReference: FEED_MANIFEST,
        bzzUrl: `bzz://${FEED_MANIFEST}`,
        identityMode: 'app-scoped',
      });
      expect(node.calls).toEqual([
        'GET /stamps',
        `POST /feeds/${feed.owner.slice(2).toLowerCase()}/${feed.topic}`,
      ]);
      const blog = answers.identities[BLOG];
      expect(
        storedOf(blog)
          .map((one) => one.mode)
          .sort()
      ).toEqual(['app-scoped', 'bee-wallet']);
      expect(blog).toMatchObject({ identityMode: 'app-scoped', feedGranted: true });
      expect(storedOf(answers.identities[SHOP])).toEqual([
        expect.objectContaining({ mode: 'app-scoped', publisherKeyIndex: 1 }),
      ]);
      expect(answers.manifests[APP]).toMatchObject({ revision: 1 });
      expect(answers.manifests['none.eth']).toBeNull();
      expect(answers.origins.find((entry) => entry.origin === APP)).toMatchObject({
        feedGranted: true,
        feedCount: 1,
      });
      const rows = answers.history.entries;
      expect(rows.map(({ name, status, origin }) => [name, status, origin])).toEqual([
        ['failed', 'failed', 'freedom://agent'],
        ['done.txt', 'completed', 'freedom://publish'],
        ['notes', 'completed', APP],
        ['feed-x', 'failed', null],
        ['old-site', 'completed', null],
      ]);

      // D10's import: in the root layout the core renames the legacy file
      // as the reference does; in the Freedom root layout it imports a
      // copy it makes in freedom/, renamed there, and leaves the profile
      // root's file until its next start (0017's hand-over, step 4).
      if (layout === 'root') {
        expect(historyCases.legacyFiles(place.profile)).toEqual({ legacy: false, migrated: true });
      } else {
        expect(historyCases.legacyFiles(place.root)).toEqual({ legacy: false, migrated: true });
        expect(historyCases.legacyFiles(place.profile)).toEqual({ legacy: true, migrated: false });
      }

      // The next start on js: this build's own modules, then the
      // reference's, each give the core's answers, each row once (the
      // legacy entries' too), and the feed's record the core answered.
      const back = await nextStartOnJs(place, (modules) => modules.feeds.getFeed(APP, 'notes'));
      for (const kind of ['js', 'reference']) {
        expect([kind, back[kind].answers]).toEqual([kind, answers]);
        expectNoRowTwice(back[kind].answers.history.entries);
        expect(legacyRows(back[kind].answers.history.entries)).toEqual(ONCE);
        expect(back[kind].read).toMatchObject({
          topic: feed.topic,
          owner: feed.owner,
          manifestReference: FEED_MANIFEST,
          identityId: appIdentity.id,
        });
      }
      // In the Freedom root layout the build's own start retired the
      // profile root's original, as the core's next start would have.
      if (layout === 'freedom') {
        expect(historyCases.legacyFiles(place.profile)).toEqual({
          legacy: false,
          migrated: false,
        });
        expect(historyCases.legacyFiles(place.root)).toEqual({ legacy: false, migrated: true });
      }
    });

    test('js → core → js: the core loads what the reference wrote, and no row comes back twice', async () => {
      const place = profileIn(layout, 'js-core', LEGACY_TEXT);

      // The reference makes the state, its legacy file imported at the
      // history's first open, and its Swarm grants on the core's grant
      // store (a simulated one here, whose file the core then loads).
      let feed;
      await watch.allowed(async () => {
        const js = jsWorld(place.profile);
        const grantCore = await useSimulatedGrantCore();
        try {
          feed = await makeState(js, js.referenceHandlers, jsOps(js));
        } finally {
          js.reference.history.closeDb();
        }
        fs.writeFileSync(path.join(place.root, GRANTS_FILE), grantCore.file('swarm'), {
          mode: 0o600,
        });
      });
      expect(historyCases.legacyFiles(place.profile)).toEqual({ legacy: false, migrated: true });
      // What the next start on js reads.
      const written = await nextStartOnJs(place, (modules) => modules.feeds.getFeed(APP, 'notes'));
      const before = written.reference.answers;
      const record = written.reference.read;
      expect(written.js).toEqual(written.reference);
      expect(legacyRows(before.history.entries)).toEqual(ONCE);
      expect(record).toMatchObject({ lastReference: 'ef'.repeat(32) });

      // The core: the same answers, the page's feed answered from the
      // reference's record (no node call), then rows and an identity of
      // its own.
      const node = await startNode();
      const world = loadWorld({
        userDataDir: tempDir('unused'),
        owners: unlockedOwners(),
        nodeUrl: node.origin,
      });
      const core = await startOnProfile(place, world, { swarm: true });
      const mark = watch.mark();
      let after;
      try {
        await importVault(core);
        expect(await answersOf(world.mainHandlers)).toEqual(before);
        expect(await pageFeed(world, APP, 'notes')).toEqual(feed);
        expect(node.calls).toEqual([]);
        await pause(3);
        const row = await world.main.history.coreOps.addEntry({
          type: 'directory',
          name: 'core-site',
          status: 'uploading',
          origin: 'freedom://agent',
        });
        expect(row.id).toBe(before.history.entries.length + 1);
        await world.main.history.coreOps.updateEntry(row.id, {
          status: 'completed',
          reference: 'cd'.repeat(32),
        });
        await world.mainHandlers.get(IPC.SWARM_CREATE_APP_SCOPED_IDENTITY)({}, SHOP, {});
        after = await answersOf(world.mainHandlers);
      } finally {
        await core.stop();
        await node.close();
      }
      expect(mainTouchesSince(mark)).toEqual([]);
      expect(after.history.entries).toHaveLength(before.history.entries.length + 1);
      expect(storedOf(after.identities[SHOP])).toHaveLength(2);
      expect(historyCases.legacyFiles(place.profile)).toEqual({ legacy: false, migrated: true });
      if (layout === 'freedom') {
        expect(historyCases.legacyFiles(place.root)).toEqual({ legacy: false, migrated: false });
      }

      // The next start on js again: the core's answers, the feed's record
      // as the reference wrote it, each row once.
      const back = await nextStartOnJs(place, (modules) => modules.feeds.getFeed(APP, 'notes'));
      for (const kind of ['js', 'reference']) {
        expect([kind, back[kind].answers]).toEqual([kind, after]);
        expectNoRowTwice(back[kind].answers.history.entries);
        expect(legacyRows(back[kind].answers.history.entries)).toEqual(ONCE);
        expect([kind, back[kind].read]).toEqual([kind, record]);
      }
    });
  });

  // ---- The differences the amendment names, each as that difference ----

  describe('what may differ, each as that difference (js → core)', () => {
    /** The core's answers on `place`, its vault imported. */
    async function coreAnswers(place) {
      const world = loadWorld({ userDataDir: tempDir('unused'), owners: unlockedOwners() });
      const core = await startOnProfile(place, world);
      const mark = watch.mark();
      try {
        await importVault(core);
        return await answersOf(world.mainHandlers);
      } finally {
        await core.stop();
        expect(mainTouchesSince(mark)).toEqual([]);
      }
    }

    /** The next start on js's answers on `place`: the build's own and the reference's alike. */
    async function jsAnswers(place) {
      const { js, reference } = await nextStartOnJs(place);
      expect(js.answers).toEqual(reference.answers);
      return reference.answers;
    }

    test('history-bound: the core keeps 10,000 rows, the oldest finished ones trimmed at its open', async () => {
      const place = profileIn('root', 'bound');
      await watch.allowed(() => {
        const { history } = jsWorld(place.profile).reference;
        try {
          history.getDb().transaction(() => {
            for (let n = 0; n < 10_003; n++) {
              history.addEntry({
                type: 'data',
                name: `row-${n}`,
                status: n % 2 ? 'completed' : 'failed',
                origin: 'freedom://publish',
              });
            }
          })();
        } finally {
          history.closeDb();
        }
      });
      const rows = (await jsAnswers(place)).history.entries;
      expect(rows).toHaveLength(10_003);

      const answers = await coreAnswers(place);
      // Every row is finished, so the oldest three go: the first inserted,
      // which started first or, within a millisecond, have the lowest ids.
      const trimmed = [1, 2, 3];
      expect(answers.history).toEqual({
        success: true,
        entries: rows.filter((row) => !trimmed.includes(row.id)),
      });
      expect(readRows(place.root)).toHaveLength(10_000);
      // And the next start on js reads the core's 10,000.
      expect((await jsAnswers(place)).history).toEqual(answers.history);
    });

    test('history-bound: a legacy publish-history.json past 16 MiB stays unimported by the core, and the next start on js imports it', async () => {
      const name = 'x'.repeat(16 * 1024 * 1024);
      const text = JSON.stringify({ version: 1, entries: [{ ...LEGACY_ENTRIES[0], name }] });
      expect(Buffer.byteLength(text)).toBeGreaterThan(16 * 1024 * 1024);
      const place = profileIn('root', 'bound-legacy', text);

      const answers = await coreAnswers(place);
      expect(answers.history).toEqual({ success: true, entries: [] });
      expect(historyCases.legacyFiles(place.profile)).toEqual({ legacy: true, migrated: false });

      // The build's own start imports it (the core's hand-over never read
      // it), as the reference does: the core's answers but for that row.
      const back = await nextStartOnJs(place);
      for (const kind of ['js', 'reference']) {
        const { history, ...rest } = back[kind].answers;
        const { history: _history, ...core } = answers;
        expect([kind, rest]).toEqual([kind, core]);
        expect(history.entries.map((row) => [row.id, row.status, row.name.length])).toEqual([
          [1, 'completed', name.length],
        ]);
      }
      expect(historyCases.legacyFiles(place.profile)).toEqual({ legacy: false, migrated: true });
    });

    test("store-shapes: a feed map that isn't one of objects is rebuilt, and an identity under another key left out", async () => {
      const place = profileIn('root', 'shapes-feeds');
      await watch.allowed(async () => {
        const js = jsWorld(place.profile);
        try {
          await js.referenceHandlers.get(IPC.SWARM_CREATE_APP_SCOPED_IDENTITY)({}, BLOG, {});
          js.reference.feeds.grantFeedAccess(BLOG, { source: 'user' });
          await jsOps(js).feed(BLOG, 'notes');
          await js.referenceHandlers.get(IPC.SWARM_CREATE_APP_SCOPED_IDENTITY)({}, SHOP, {});
        } finally {
          js.reference.history.closeDb();
        }
      });
      // Shapes no reference writer makes, which it loads as they are: a
      // feed that isn't an object beside a real one, and an identity kept
      // under another identity's key.
      const file = path.join(place.root, FEEDS_FILE);
      const store = JSON.parse(fs.readFileSync(file, 'utf8'));
      store.origins[BLOG].feeds.broken = 'not a feed';
      const shop = store.origins[SHOP];
      shop.identities['app-scoped:9'] = {
        ...shop.identities[shop.activeIdentityId],
        label: 'Kept under another key',
      };
      fs.writeFileSync(file, JSON.stringify(store, null, 2));

      const expected = await jsAnswers(place);
      // The next start on js counts the broken feed and lists both identities.
      expect(expected.origins.find((entry) => entry.origin === BLOG)).toMatchObject({
        feedCount: 2,
      });
      expect(storedOf(expected.identities[SHOP])).toHaveLength(2);

      // The core's answers are the same but for the rebuilt feed map and
      // the identity left out.
      const repaired = structuredClone(expected);
      repaired.origins.find((entry) => entry.origin === BLOG).feedCount = 1;
      repaired.identities[BLOG].feedCount = 1;
      repaired.origins.find((entry) => entry.origin === SHOP).identityCount = 1;
      repaired.identities[SHOP].identities = repaired.identities[SHOP].identities.filter(
        (identity) => identity.label !== 'Kept under another key'
      );
      expect(await coreAnswers(place)).toEqual(repaired);
    });

    test("store-shapes: a manifest record with a string revision is read from the file's .bak", async () => {
      const place = profileIn('root', 'shapes-manifests');
      let first;
      let individual;
      await watch.allowed(async () => {
        const js = jsWorld(place.profile);
        await useSimulatedGrantCore();
        try {
          js.serving.spec = APP_MANIFEST;
          const ops = jsOps(js);
          const consent = await ops.check({
            key: APP,
            url: `bzz://${APP}/`,
            guest: { isDestroyed: () => false },
            eager: true,
          });
          await ops.decide(APP, consent.token, 'allow', {
            recheck: async () => true,
            holds: () => true,
          });
          first = await js.referenceHandlers.get(IPC.SWARM_MANIFEST_GET)({}, APP);
          // A second change, journaled: its journal's file is the .bak.
          await js.referenceHandlers.get(IPC.SWARM_MANIFEST_USE_INDIVIDUAL)(
            {},
            {
              origin: APP,
              capability: 'publish',
            }
          );
          individual = await js.referenceHandlers.get(IPC.SWARM_MANIFEST_GET)({}, APP);
        } finally {
          js.reference.history.closeDb();
        }
      });
      const file = path.join(place.root, MANIFESTS_FILE);
      // The .bak: the first change's record, and the second pending in its
      // journal, as its write left the file just before its commit.
      const backup = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
      expect(backup.records[APP]).toEqual(first);
      expect(backup.pending).toMatchObject({ origin: APP, record: individual });
      expect(individual).toMatchObject({ revision: 2 });
      // A revision no reference writer makes, which the reference reads.
      const store = JSON.parse(fs.readFileSync(file, 'utf8'));
      store.records[APP].revision = '2';
      fs.writeFileSync(file, JSON.stringify(store, null, 2));

      const expected = await jsAnswers(place);
      expect(expected.manifests[APP]).toEqual({ ...individual, revision: '2' });

      // The core reads the .bak instead and completes its journal: its
      // answers are the same but for that record, the journal's, whose
      // revision is the number.
      expect(await coreAnswers(place)).toEqual({
        ...expected,
        manifests: { ...expected.manifests, [APP]: individual },
      });
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).records[APP]).toEqual(individual);
    });
  });

  // ---- The whole run ----

  test("main touched none of the three stores' files over the whole run", () => {
    const touches = watch.touches();
    expect(
      touches.filter((touch) => touch.main).map(({ name, path: file }) => [name, file])
    ).toEqual([]);
    // The watch saw the reference's touches of each store's files, its
    // database's opens among them, and main's on the JS backend apart.
    for (const stem of STORE_STEMS) {
      expect(touches.some((touch) => touch.path.split(/[\\/]/).pop().startsWith(stem))).toBe(true);
    }
    expect(touches.some((touch) => touch.name === 'better-sqlite3')).toBe(true);
    expect(watch.allowedTouches().length).toBeGreaterThan(0);
  });
});

/** The rows of `dir`'s publish-history.sqlite, by id, each time a clock made `'now'`. */
function readRows(dir) {
  const file = path.join(dir, HISTORY_FILE);
  if (!fs.existsSync(file)) return null;
  const Real = jest.requireActual('better-sqlite3');
  const db = new Real(file, { readonly: true });
  try {
    const since = Date.now() - 600_000;
    const clock = (value) => (typeof value === 'number' && value >= since ? 'now' : value);
    return db
      .prepare('SELECT * FROM publishes ORDER BY id')
      .all()
      .map((row) => ({
        ...row,
        started_at: clock(row.started_at),
        completed_at: clock(row.completed_at),
      }));
  } finally {
    db.close();
  }
}
