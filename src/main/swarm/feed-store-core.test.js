/**
 * feed-store.js on the core's feed store (freedom-core design 0015, D3, D7
 * and D8; the SWM-6 to SWM-9 plan's PR 6.2), against the simulated core
 * (test/helpers/simulated-swarm-stores-core.js), through main's real client
 * (core/swarm-stores.js). The hello naming `swarm_stores` is the test's
 * choice (core-client.js `swarmStoresNamed`, mocked); no build names it
 * before PR 7.4. feed-store.integration.test.js plays the same cases on
 * the real core.
 *
 * - feed-store.test.js's store cases (test/helpers/feed-store-cases.js):
 *   each answer of main's equals the reference's
 *   (test/helpers/reference-feed-store.js, on a root of its own) for the
 *   same sequence, the core asked the op the channel or function names, as
 *   `chrome` or `shell`, and the store's files end the same.
 * - An `fs` spy: main's feed-store.js opens no feed-store file (the
 *   simulated core's reference, in this process, does).
 * - Every function that reads or writes the file throws unrun, the JS
 *   provider's direct calls among them.
 * - page-swarm.js's feed prompt on the core's store gives what it gives on
 *   main's own: the prompt's views, the store's state and the write.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// The chrome's handlers go to `mockIpc.handlers`: main's and the
// reference's apart.
const mockIpc = { handlers: null };
jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  ipcMain: {
    handle: (channel, handler) => {
      mockIpc.handlers[channel] = handler;
    },
    removeHandler: () => {},
  },
  webContents: { fromId: () => null },
}));
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// The vault's owners, as identity-manager.js reads them (its messages when
// locked).
const mockVault = { unlocked: true };
jest.mock('../identity-manager', () => ({
  getBeeWalletAddress: async () =>
    mockVault.unlocked ? '0xBee0000000000000000000000000000000000000' : null,
  getPublisherAddress: async (index) => {
    if (!mockVault.unlocked) throw new Error('Vault must be unlocked to derive publisher keys');
    return `0xPublisher${index}`;
  },
  getDerivedWallets: async () => [],
}));

// The test chooses the hello (`swarm_stores` named or not) and the core.
const mockMove = { named: false, client: null };
jest.mock('../core/core-client', () => ({
  ...jest.requireActual('../core/core-client'),
  swarmStoresNamed: () => mockMove.named,
}));
jest.mock('../core/core-process', () => ({ getCoreClient: () => mockMove.client }));

const IPC = require('../../shared/ipc-channels');
const feeds = require('./feed-store');
const { simulatedSwarmStores } = require('../../../test/helpers/simulated-swarm-stores-core');
const {
  FEED_STORE_CASES,
  mainOpArgs,
  normalized,
  playFeedStoreCase,
} = require('../../../test/helpers/feed-store-cases');

const FEEDS_FILE = 'swarm-feeds.json';
const MAIN_FEED_STORE = path.join('src', 'main', 'swarm', 'feed-store.js');
const SPIED = [
  'existsSync',
  'readFileSync',
  'writeFileSync',
  'renameSync',
  'copyFileSync',
  'openSync',
  'statSync',
  'unlinkSync',
  'rmSync',
  'appendFileSync',
  'createReadStream',
  'createWriteStream',
];

const { app } = require('electron');
const sim = simulatedSwarmStores();
// The simulated core's feed store is the reference module; between a case's
// two runs it is the reference's, on a root of its own.
const referenceFeeds = sim.references().feeds;
const mockHandlers = {};
const referenceHandlers = {};
mockIpc.handlers = mockHandlers;
feeds.registerFeedStoreIpc();
mockIpc.handlers = referenceHandlers;
referenceFeeds.registerFeedStoreIpc();
mockIpc.handlers = mockHandlers;

const dirs = [];
function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `feed-store-core-${name}-`));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  mockVault.unlocked = true;
  mockMove.named = true;
  mockMove.client = { request: sim.request };
  sim.calls.length = 0;
  sim.unnormalized.length = 0;
  // A new world: the core's store loads again from its root.
  sim.restart();
});

afterEach(() => {
  mockMove.named = false;
  mockMove.client = null;
});

/** The first frame of `stack` outside this file, node and node_modules. */
function callerOf(stack) {
  return stack
    .split('\n')
    .slice(1)
    .find(
      (line) =>
        !line.includes(__filename) && !line.includes('node:') && !line.includes('node_modules')
    );
}

/**
 * Spies on `fs` for any touch of a feed-store file (the file, its backups,
 * its temporary file), from main's feed-store.js: `fromMain()` lists them,
 * `restore()` removes the spies. The simulated core's reference, in this
 * process, touches the file itself; only main's frames count.
 */
function spyMainFeedStore() {
  const hits = [];
  const spies = SPIED.map((name) => {
    const original = fs[name];
    return jest.spyOn(fs, name).mockImplementation(function (...args) {
      if (args.some((arg) => typeof arg === 'string' && arg.includes('swarm-feeds'))) {
        const limit = Error.stackTraceLimit;
        Error.stackTraceLimit = 64;
        const { stack } = new Error();
        Error.stackTraceLimit = limit;
        hits.push({ name, target: args[0], from: callerOf(stack) || '' });
      }
      return original.apply(this, args);
    });
  });
  return {
    all: () => hits,
    fromMain: () => hits.filter((hit) => hit.from.includes(MAIN_FEED_STORE)),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

/** Main, its hello naming `swarm_stores`: its handlers and `coreOps`. */
const mainSide = {
  chrome: (channel, args) => mockHandlers[channel]({}, ...args),
  main: (op, args) => feeds.coreOps[op](...mainOpArgs(op, args)[0]),
  vault: (state) => {
    mockVault.unlocked = state === 'unlock';
  },
};

/** The reference, today's main on its own file: its handlers and functions. */
const referenceSide = {
  chrome: (channel, args) => referenceHandlers[channel]({}, ...args),
  main: (op, args) => referenceFeeds[op](...mainOpArgs(op, args)[1]),
  vault: (state) => {
    mockVault.unlocked = state === 'unlock';
  },
};

/** The op a step asks the core, `[method, op, caller]`, or none. */
function askedOf([kind, name]) {
  if (kind === 'chrome') return ['swarm.identities', name.replace(/^swarm:/, ''), 'chrome'];
  if (kind === 'main') return ['swarm.identities', name, 'shell'];
  return null;
}

const readStore = (dir) => {
  const file = path.join(dir, FEEDS_FILE);
  return fs.existsSync(file) ? normalized(JSON.parse(fs.readFileSync(file, 'utf8'))) : null;
};

describe("feed-store.js's store cases on the simulated core", () => {
  test.each(FEED_STORE_CASES.map((kase) => [kase.name, kase]))('%s', async (_name, kase) => {
    const coreDir = tempDir('core');
    const referenceDir = tempDir('reference');
    if (kase.seed) {
      fs.writeFileSync(path.join(coreDir, FEEDS_FILE), kase.seed);
      fs.writeFileSync(path.join(referenceDir, FEEDS_FILE), kase.seed);
    }
    mockVault.unlocked = kase.vault !== 'locked';
    app.getPath.mockReturnValue(coreDir);

    const spy = spyMainFeedStore();
    let fromMain;
    let coreTouches;
    let played;
    try {
      played = await playFeedStoreCase(kase, {
        main: mainSide,
        reference: referenceSide,
        between: () => {
          fromMain = spy.fromMain();
          coreTouches = spy.all().length;
          // The reference's run: the module on its own root, the vault as
          // the case starts.
          mockMove.named = false;
          referenceFeeds._resetCache();
          app.getPath.mockReturnValue(referenceDir);
          mockVault.unlocked = kase.vault !== 'locked';
        },
      });
    } finally {
      spy.restore();
    }

    // Each answer is the reference's, step by step.
    expect(played.map(({ step, main }) => [step, main])).toEqual(
      played.map(({ step, reference: answer }) => [step, answer])
    );
    // The core was asked each op once, as the caller main relays it for,
    // each site by its permission key: the core normalizes none again.
    expect(sim.calls).toEqual(played.map(({ step }) => askedOf(step)).filter(Boolean));
    expect(sim.unnormalized).toEqual([]);
    // Main touched no feed-store file in its run; the core's store did.
    expect(fromMain).toEqual([]);
    expect(coreTouches).toBeGreaterThan(0);
    // The store ends as the reference's.
    expect(readStore(coreDir)).toEqual(readStore(referenceDir));
  });

  test('the cases cover every op main relays or sends', () => {
    const { OPS } = require('../core/swarm-stores');
    const asked = new Set(
      FEED_STORE_CASES.flatMap((kase) =>
        kase.steps
          .map(askedOf)
          .filter(Boolean)
          .map(([, op]) => op)
      )
    );
    expect([...asked].sort()).toEqual(Object.keys(OPS['swarm.identities']).sort());
  });
});

describe("main never opens the feed store's file once it is the core's", () => {
  test("every function that reads or writes it throws, unrun, the JS provider's calls among them", async () => {
    const dir = tempDir('refused');
    const seeded = JSON.stringify({ version: 2, nextPublisherKeyIndex: 0, origins: {} });
    fs.writeFileSync(path.join(dir, FEEDS_FILE), seeded);
    app.getPath.mockReturnValue(dir);
    feeds._resetCache();
    const refused = "swarm-feeds.json is the identity core's: main doesn't open it";
    const calls = [
      // swarm-provider-ipc.js's direct calls (the plan's point 1: no core
      // op; unreachable on the core from PR 7.4).
      ['getOriginEntry', () => feeds.getOriginEntry('site.eth')],
      ['getFeed', () => feeds.getFeed('site.eth', 'blog')],
      [
        'setFeed',
        () => feeds.setFeed('site.eth', 'blog', { topic: 't', owner: 'o', manifestReference: 'm' }),
      ],
      ['updateFeedReference', () => feeds.updateFeedReference('site.eth', 'blog', 'ref')],
      ['getAllFeeds', () => feeds.getAllFeeds('site.eth')],
      [
        'isIdentitySharedWithOtherOrigins',
        () =>
          feeds.isIdentitySharedWithOtherOrigins('site.eth', {
            mode: 'app-scoped',
            publisherKeyIndex: 0,
          }),
      ],
      ['hasFeedGrant', () => feeds.hasFeedGrant('site.eth')],
      // permission-manifests.js's projections (PR 6.3 makes it a client).
      ['grantFeedAccess', () => feeds.grantFeedAccess('site.eth', { source: 'manifest' })],
      ['revokeFeedAccess', () => feeds.revokeFeedAccess('site.eth', { source: 'manifest' })],
      [
        'createAppScopedIdentity',
        () => feeds.createAppScopedIdentity('site.eth', { source: 'manifest' }),
      ],
      ['hasIdentityMode', () => feeds.hasIdentityMode('site.eth')],
      ['hasUnavailableIdentity', () => feeds.hasUnavailableIdentity('site.eth')],
      // The file's other functions, main's own ops' among them.
      ['setOriginEntry', () => feeds.setOriginEntry('site.eth', { identityMode: 'bee-wallet' })],
      ['allocatePublisherKeyIndex', () => feeds.allocatePublisherKeyIndex()],
      ['getOriginIdentityState', () => feeds.getOriginIdentityState('site.eth')],
      ['getAllOriginEntries', () => feeds.getAllOriginEntries()],
      ['createAppScopedIdentityAt', () => feeds.createAppScopedIdentityAt('site.eth', 0)],
      ['ensureAntWalletIdentity', () => feeds.ensureAntWalletIdentity('site.eth')],
      ['activateIdentity', () => feeds.activateIdentity('site.eth', 'bee-wallet')],
      ['assertFeedGrantable', () => feeds.assertFeedGrantable('site.eth')],
      ['getEthereumWalletIdentityReferences', () => feeds.getEthereumWalletIdentityReferences(0)],
      [
        'getOriginIdentityStateWithOwners',
        () => feeds.getOriginIdentityStateWithOwners('site.eth'),
      ],
      ['previewAppScopedIdentity', () => feeds.previewAppScopedIdentity('site.eth')],
    ];
    const spy = spyMainFeedStore();
    const outcomes = [];
    try {
      for (const [name, call] of calls) {
        try {
          await call();
          outcomes.push([name, 'ran']);
        } catch (err) {
          outcomes.push([name, err.message]);
        }
      }
    } finally {
      spy.restore();
    }
    expect(outcomes).toEqual(calls.map(([name]) => [name, refused]));
    expect(spy.all()).toEqual([]);
    expect(sim.calls).toEqual([]);
    expect(fs.readFileSync(path.join(dir, FEEDS_FILE), 'utf8')).toBe(seeded);
  });

  test("with the move off, the chrome's handlers write main's own file and ask the core nothing", async () => {
    mockMove.named = false;
    const dir = tempDir('off');
    app.getPath.mockReturnValue(dir);
    feeds._resetCache();
    const state = await mockHandlers[IPC.SWARM_CREATE_APP_SCOPED_IDENTITY]({}, 'off.eth', {
      label: 'Mine',
    });
    expect(state.identities.map(({ id }) => id)).toEqual(['app-scoped:0', 'bee-wallet']);
    expect(
      Object.keys(JSON.parse(fs.readFileSync(path.join(dir, FEEDS_FILE), 'utf8')).origins)
    ).toEqual(['off.eth']);
    expect(sim.calls).toEqual([]);
  });

  test("a protocol error reaches the chrome as the core's, and main writes nothing", async () => {
    const dir = tempDir('failed');
    app.getPath.mockReturnValue(dir);
    sim.fail = async () => {
      throw Object.assign(new Error('The core is busy'), { code: 'busy' });
    };
    try {
      await expect(
        mockHandlers[IPC.SWARM_REVOKE_FEED_ACCESS]({}, 'busy.eth')
      ).rejects.toMatchObject({ name: 'CoreError', code: 'busy' });
      await expect(feeds.coreOps.hasFeedGrant('busy.eth')).rejects.toMatchObject({ code: 'busy' });
    } finally {
      sim.fail = null;
    }
    expect(fs.existsSync(path.join(dir, FEEDS_FILE))).toBe(false);
  });

  test('without a running core, a call fails core_unavailable', async () => {
    mockMove.client = null;
    await expect(mockHandlers[IPC.SWARM_GET_ALL_ORIGINS]({})).rejects.toMatchObject({
      code: 'core_unavailable',
    });
  });
});

describe("page-swarm.js's feed prompt on the core's feed store", () => {
  const KEY = `bzz://${'a'.repeat(64)}`;
  const { createSwarmDispatchers } = require('../page/page-swarm');

  /**
   * A feed request through main's dispatcher, every dependency but the
   * feed store's (and main's lock) a stub: `answer(view, shown)` is the
   * user's decision on the prompt, shown for the `shown`th time.
   */
  async function feedRequest(answer, state) {
    const execute = jest.fn(async () => ({ result: { reference: 'ef'.repeat(32) } }));
    const dispatchers = createSwarmDispatchers({
      identityWalletEnabled: () => true,
      execute,
      grantsLoaded: async () => true,
      getPermission: () => ({ origin: KEY }),
      updateLastUsed: async () => {},
      getAutoApprove: (key, rule) => state.rules.has(`${key} ${rule}`),
      setAutoApprove: async (key, rule, enabled) => {
        if (enabled) state.rules.add(`${key} ${rule}`);
      },
      checkManifest: async () => ({ kind: 'none' }),
      guestContents: () => null,
      inCustody: () => false,
      isVaultUnlocked: async () => true,
      endDocumentSubscriptions: () => {},
      routeToSetup: () => {},
    });
    let shown = 0;
    const context = {
      requester: { key: KEY, url: `${KEY}/`, guest: 7, navigation: 1, window: 1 },
      method: 'swarm_createFeed',
      params: { name: 'blog' },
      nameHolds: async () => true,
      holdsKey: () => true,
      pageContext: () => ({ transport_key: 'k' }),
      onDocumentEnded: () => {},
      isCurrent: () => true,
      copied: () => {},
      signal: undefined,
      prompt: async ({ kind, view }) => {
        shown += 1;
        state.views.push(normalized({ kind, view }));
        return answer(view, shown);
      },
    };
    const out = await dispatchers['swarm:swarm_createFeed'](context);
    return { out, execute };
  }

  /**
   * The prompt's run, the user's pick `pick` (`'new'` or an identity's id):
   * for a new identity another site first takes the key the prompt showed
   * (`takeKey`), so the choice is refused (`identity_taken`) and the prompt
   * shows the next key, taken with "always allow"; then a second request,
   * which the site's rule answers.
   */
  async function promptRun(pick, takeKey) {
    const state = { rules: new Set(), views: [] };
    const first = await feedRequest(async (view, shown) => {
      if (pick !== 'new') return { approve: true, choices: { identity: pick, alwaysAllow: true } };
      if (shown === 1) await takeKey();
      return { approve: true, choices: { identity: view.newIdentity.id, alwaysAllow: shown > 1 } };
    }, state);
    const second = await feedRequest(() => {
      throw new Error('no prompt expected');
    }, state);
    return { state, first, second };
  }

  const resultOf = ({ out, execute }) => ({
    out,
    executed: execute.mock.calls.map(([method, params, key]) => [method, params, key]),
  });

  const takeKey = () =>
    mockHandlers[IPC.SWARM_CREATE_APP_SCOPED_IDENTITY]({}, 'other.eth', { activate: true });

  test.each([
    [
      'a new identity, its key taken meanwhile',
      'new',
      [
        'shell hasFeedGrant',
        'shell previewAppScopedIdentity',
        'shell getOriginIdentityStateWithOwners',
        'chrome create-app-scoped-identity',
        'shell createAppScopedIdentityAt',
        'shell previewAppScopedIdentity',
        'shell getOriginIdentityStateWithOwners',
        'shell createAppScopedIdentityAt',
        'shell assertFeedGrantable',
        'shell hasFeedGrant',
        'shell grantFeedAccess',
        // The second request: the site's rule answers it.
        'shell hasFeedGrant',
      ],
      { activeIdentityId: 'app-scoped:1', feedGranted: true },
    ],
    [
      "the Ant wallet's identity",
      'bee-wallet',
      [
        'shell hasFeedGrant',
        'shell previewAppScopedIdentity',
        'shell getOriginIdentityStateWithOwners',
        'shell ensureAntWalletIdentity',
        'shell assertFeedGrantable',
        'shell hasFeedGrant',
        'shell grantFeedAccess',
        'shell hasFeedGrant',
      ],
      { activeIdentityId: 'bee-wallet', feedGranted: true },
    ],
  ])(
    "%s: the views, the state and the writes equal main's own store's",
    async (_name, pick, asked, ends) => {
      // On the core's store.
      const coreDir = tempDir('prompt-core');
      app.getPath.mockReturnValue(coreDir);
      const spy = spyMainFeedStore();
      let onCore;
      try {
        onCore = await promptRun(pick, takeKey);
      } finally {
        spy.restore();
      }
      expect(spy.fromMain()).toEqual([]);
      expect(sim.calls.map(([, op, caller]) => `${caller} ${op}`)).toEqual(asked);
      const coreState = normalized(await feeds.coreOps.getOriginIdentityStateWithOwners(KEY));

      // On main's own store: today's path.
      mockMove.named = false;
      const ownDir = tempDir('prompt-own');
      app.getPath.mockReturnValue(ownDir);
      feeds._resetCache();
      const onMain = await promptRun(pick, takeKey);
      const mainState = normalized(await feeds.getOriginIdentityStateWithOwners(KEY));

      expect(onCore.state.views).toEqual(onMain.state.views);
      expect([...onCore.state.rules]).toEqual([...onMain.state.rules]);
      expect(resultOf(onCore.first)).toEqual(resultOf(onMain.first));
      expect(resultOf(onCore.second)).toEqual(resultOf(onMain.second));
      expect(onCore.first.execute).toHaveBeenCalledTimes(1);
      expect(onCore.first.out.error).toBeUndefined();
      expect(coreState).toEqual(mainState);
      expect(coreState).toMatchObject(ends);
      expect(readStore(coreDir)).toEqual(readStore(ownDir));
    }
  );

  test("a failed op fails the prompt's write as main's own store's does, nothing granted", async () => {
    const dir = tempDir('prompt-failed');
    app.getPath.mockReturnValue(dir);
    sim.fail = async (_method, params) => {
      if (params.op === 'grantFeedAccess')
        throw Object.assign(new Error('Storage error'), { code: 'storage' });
    };
    let run;
    try {
      run = await feedRequest(
        (view) => ({ approve: true, choices: { identity: view.newIdentity.id } }),
        { rules: new Set(), views: [] }
      );
    } finally {
      sim.fail = null;
    }
    expect(run.out).toEqual({ error: { code: -32603, message: 'Storage error' } });
    expect(run.execute).not.toHaveBeenCalled();
    expect(await feeds.coreOps.hasFeedGrant(KEY)).toBe(false);
  });
});
