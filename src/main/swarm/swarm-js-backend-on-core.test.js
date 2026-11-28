/**
 * SWM-7's flip (freedom-core design 0015's 2026-11-28 amendment, "the store
 * move follows the switch"; the SWM-6 to SWM-9 plan's PR 7.4 and section
 * 5): in a process whose Swarm backend is the core's, the JS backend's own
 * paths can't run. Each refuses before anything of its own runs, with an
 * error naming what refused, and never falls back to another path:
 *
 * - the JS provider (swarm-provider-ipc.js `executeSwarmMethod`): every
 *   method, an unknown or missing one included, answers `-32603` naming
 *   it, with no grant read, no store, service or node call made;
 * - main's GSOC miner (gsoc-miner.js `mineSigner`, and messaging-service's
 *   `deriveGsoc` through it): rejects with a `SwarmBackendError`, no job
 *   queued and no Worker constructed (mining is the core's);
 * - main's writers of the three Swarm stores: every function of
 *   feed-store.js, permission-manifests.js and publish-history.js that
 *   keeps main's own file throws or rejects naming that file, with no
 *   `fs` touch of any of the three stores' files (an `fs` spy over every
 *   path-taking call, store-handover.js `watchFileTouches`), no
 *   better-sqlite3 open, no identity-manager call, and no call to the core
 *   either: a refusal, not a rerouting.
 *
 * Each process is a fresh registry whose switch, FREEDOM_SWARM_BACKEND, is
 * read as a development build reads it. On `js` the same calls run as
 * before (they reach their collaborators and files), and a packaged build
 * runs `js` whatever the switch says (U-2, still open: the core's backend
 * is a development build's).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');
const { watchFileTouches } = require('../../../test/helpers/store-handover');

const KEY = 'https://app.example';
const REF = 'a1'.repeat(32);
const OWNER = 'd4'.repeat(20);
const ID = 'f6'.repeat(32);
const PROVIDER_REFUSAL = "The JS Swarm provider can't run on the core's Swarm backend";
const MINER_REFUSAL = "Main's GSOC miner can't run on the core's Swarm backend";

/** The three stores' files: each name, its backups, temporary files and SQLite's. */
const STORE_STEMS = ['swarm-feeds', 'swarm-manifest-grants', 'publish-history'];
const isStoreFile = (target) => {
  const base = String(target).split(/[\\/]/).pop();
  return STORE_STEMS.some((stem) => base.startsWith(`${stem}.`)) && !base.endsWith('.js');
};

const quietLog = () => ({
  info() {},
  warn() {},
  error() {},
  debug() {},
  transports: { file: {}, console: {} },
});

// Every method a page can send, as a page sends it, and two it can't.
const METHODS = [
  ['swarm_requestAccess', undefined],
  ['swarm_getCapabilities', undefined],
  ['swarm_publishData', { data: 'hello', contentType: 'text/plain', name: 'h.txt' }],
  ['swarm_publishFiles', { files: [{ path: 'a.txt', bytes: new Uint8Array([7]) }] }],
  ['swarm_getUploadStatus', { tagUid: 5 }],
  ['swarm_createFeed', { name: 'blog' }],
  ['swarm_updateFeed', { feedId: 'blog', reference: REF }],
  ['swarm_writeFeedEntry', { name: 'blog', data: 'entry' }],
  ['swarm_readFeedEntry', { name: 'blog', index: 0 }],
  ['swarm_listFeeds', undefined],
  ['swarm_publishChunk', { data: new Uint8Array([1, 2, 3]) }],
  ['swarm_readChunk', { reference: REF }],
  ['swarm_readData', { reference: REF }],
  ['swarm_writeSingleOwnerChunk', { identifier: ID, data: new Uint8Array([4]) }],
  ['swarm_readSingleOwnerChunk', { owner: OWNER, identifier: ID }],
  ['swarm_getSigningIdentity', undefined],
  ['swarm_getMessagingIdentity', undefined],
  ['swarm_subscribe', { kind: 'pss', topic: 'chat' }],
  ['swarm_unsubscribe', { subscriptionId: 'a'.repeat(32) }],
  ['swarm_sendPss', { topic: 'chat', targets: 'abcd', recipient: `02${'28'.repeat(32)}`, data: 'hi' }],
  ['swarm_sendGsoc', { topic: 'chat', data: 'hello' }],
  ['swarm_unknown', {}],
  [undefined, {}],
];

/**
 * Arguments whose every member read throws (non-enumerable, so a test's
 * name, which JSON-encodes its arguments, doesn't read them): a path that
 * reads its arguments before it refuses fails with this error instead of
 * its refusal (Codex round 1 on #1392).
 */
const READ_TRAP = Object.defineProperties(
  {},
  Object.fromEntries(
    ['source', 'owner', 'key', 'origin', 'committedUrl', 'eager', 'label', 'activate', 'identityMode', 'type', 'name', 'status'].map(
      (member) => [
        member,
        {
          enumerable: false,
          get() {
            throw new Error(`argument member ${member} read before the refusal`);
          },
        },
      ]
    )
  )
);

/**
 * An argument any use of which throws (a Proxy trapping every operation):
 * a property read, a `typeof`-free coercion, an own-keys walk. A path that
 * handles an argument before it refuses meets this error instead of its
 * refusal (Codex round 2 on #1392). Every store path below is also played
 * with each argument, and one more, replaced by it.
 */
const ARG_TRAP = new Proxy(
  {},
  Object.fromEntries(
    ['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'set', 'defineProperty', 'deleteProperty', 'apply'].map(
      (trap) => [
        trap,
        () => {
          throw new Error(`an argument was used (${trap}) before the refusal`);
        },
      ]
    )
  )
);
/** An argument as a test's name shows it (the traps are never encoded: that would use them). */
const shown = (arg) => (arg === ARG_TRAP ? '<trap>' : arg === READ_TRAP ? '<getters>' : (JSON.stringify(arg) ?? 'undefined'));

/** `args` with each one, and one more after them, replaced by `ARG_TRAP`. */
const trapped = (args) => [...args.map((_, i) => args.map((arg, j) => (i === j ? ARG_TRAP : arg))), [...args, ARG_TRAP]];

const dirs = [];
const savedBackend = process.env.FREEDOM_SWARM_BACKEND;
// The requests a test mocked: a mock outlives `jest.resetModules()`, so
// each is undone after its test.
const mocked = new Set();

afterEach(() => {
  if (savedBackend === undefined) delete process.env.FREEDOM_SWARM_BACKEND;
  else process.env.FREEDOM_SWARM_BACKEND = savedBackend;
  for (const name of mocked) jest.dontMock(name);
  mocked.clear();
  jest.resetModules();
});

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-js-on-core-'));
  dirs.push(dir);
  return dir;
}

/**
 * A fresh registry for a process whose switch reads `backend`, packaged
 * when `packaged`, with `mocks` (request → factory) and Electron's app on
 * `userDataDir`; returns the module `request` and the registry's require.
 */
function processOn(backend, { packaged = false, userDataDir = tempDir(), mocks = {}, request }) {
  process.env.FREEDOM_SWARM_BACKEND = backend;
  const extraMocks = {
    [require.resolve('../logger')]: quietLog,
    'electron-log': quietLog,
    ...mocks,
  };
  for (const name of ['electron', ...Object.keys(extraMocks)]) mocked.add(name);
  const { mod, ipcMain } = loadMainModule(require.resolve(request), {
    userDataDir,
    isPackaged: packaged,
    extraMocks,
  });
  return { mod, ipcMain, require: (name) => require(name), userDataDir };
}

// ---------------------------------------------------------------------------
// The JS provider.

/** Every collaborator of swarm-provider-ipc.js, each a spy that must stay unrun on core. */
function providerCollaborators() {
  const calls = [];
  const spy = (name, value) =>
    jest.fn((...args) => {
      calls.push(name);
      return typeof value === 'function' ? value(...args) : value;
    });
  const surface = (prefix, names, value = undefined) =>
    Object.fromEntries(names.map((name) => [name, spy(`${prefix}.${name}`, value)]));
  const mocks = {
    [require.resolve('./swarm-permissions')]: () =>
      surface('permissions', ['getPermission', 'hasMessagingGrant', 'onRevoke'], null),
    [require.resolve('./publish-service')]: () =>
      surface('publish', ['publishPageData', 'publishFilesFromContent', 'getUploadStatus']),
    [require.resolve('./feed-service')]: () =>
      surface('feeds', ['createFeed', 'updateFeed', 'writeFeedPayload', 'readFeedPayload', 'buildTopicString']),
    [require.resolve('./feed-store')]: () =>
      surface('feedStore', [
        'getOriginEntry',
        'getFeed',
        'setFeed',
        'updateFeedReference',
        'hasFeedGrant',
        'getAllFeeds',
        'isIdentitySharedWithOtherOrigins',
      ]),
    [require.resolve('./chunk-service')]: () =>
      surface('chunks', [
        'publishChunk',
        'readChunk',
        'readDataRoot',
        'readData',
        'writeSingleOwnerChunk',
        'readSingleOwnerChunk',
      ]),
    [require.resolve('./publish-history')]: () => surface('history', ['addEntry', 'updateEntry']),
    [require.resolve('./messaging-service')]: () => ({
      MAX_MESSAGE_BYTES: 4000,
      MAX_TARGET_DEPTH: 4,
      DEFAULT_TARGET_DEPTH: 2,
      ...surface('messaging', [
        'getMessagingIdentity',
        'sendPss',
        'sendGsoc',
        'deriveGsoc',
        'resolvePssTopicHex',
        'openSubscriptionSocket',
      ]),
    }),
    [require.resolve('./subscription-registry')]: () =>
      surface('subscriptions', [
        'configure',
        'subscribe',
        'unsubscribeDocument',
        'cancelByDocument',
        'cancelByOrigin',
        'checkRoute',
        'recheckRoutes',
      ]),
    [require.resolve('../service-registry')]: () => surface('services', ['getAntApiUrl', 'getService', 'onServiceChange']),
    [require.resolve('./publish-setup-service')]: () => surface('setup', ['getPublishReadiness']),
    [require.resolve('./swarm-signer')]: () => surface('signer', ['resolveSwarmSigner', 'getIdentityMode']),
    [require.resolve('../vault-timer')]: () => surface('vaultTimer', ['resetVaultAutoLockTimer']),
  };
  return { mocks, calls };
}

describe("the JS provider on the core's backend", () => {
  test('executeSwarmMethod with every argument a trap answers -32603, none of them used', async () => {
    const { mocks, calls } = providerCollaborators();
    const { mod } = processOn('core', { mocks, request: './swarm-provider-ipc' });
    expect(await mod.executeSwarmMethod(ARG_TRAP, ARG_TRAP, ARG_TRAP, ARG_TRAP)).toEqual({
      error: { code: -32603, message: PROVIDER_REFUSAL },
    });
    expect(calls).toEqual([]);
  });

  test.each(METHODS.map(([method, params]) => [String(method), method, params]))(
    '%s answers -32603 naming it, with nothing of its own run',
    async (_name, method, params) => {
      const { mocks, calls } = providerCollaborators();
      const meta = { page: { document: '1:1', deliverTo: jest.fn(), effect: jest.fn() } };
      const { mod } = processOn('core', { mocks, request: './swarm-provider-ipc' });
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      try {
        expect(await mod.executeSwarmMethod(method, params, KEY, meta)).toEqual({
          error: { code: -32603, message: PROVIDER_REFUSAL },
        });
        expect(calls).toEqual([]);
        expect(meta.page.effect).not.toHaveBeenCalled();
        expect(meta.page.deliverTo).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    }
  );

  test.each([
    ['js', false],
    ['core', true],
  ])('FREEDOM_SWARM_BACKEND=%s, packaged %s: the JS backend, which runs as before', async (backend, packaged) => {
    const { mocks, calls } = providerCollaborators();
    const { mod } = processOn(backend, { packaged, mocks, request: './swarm-provider-ipc' });
    // A site that isn't connected: the provider read its grant.
    expect(await mod.executeSwarmMethod('swarm_requestAccess', undefined, KEY)).toEqual({
      error: {
        code: 4100,
        message: 'The origin is not authorized for this operation',
        data: { reason: 'not_connected' },
      },
    });
    expect(calls).toEqual(['permissions.getPermission']);
  });
});

describe("the JS provider's exported probes on the core's backend", () => {
  test.each([
    ['checkBeeReachable()', 'checkBeeReachable', [], "The JS Swarm provider's node probe"],
    ['checkBeeReachable(url)', 'checkBeeReachable', ['http://127.0.0.1:1633'], "The JS Swarm provider's node probe"],
    ['checkBeeReachable(<trap>)', 'checkBeeReachable', [ARG_TRAP], "The JS Swarm provider's node probe"],
    ['checkSwarmPreFlight()', 'checkSwarmPreFlight', [], "The JS Swarm provider's publish pre-flight"],
    ['checkSwarmPreFlight(<trap>)', 'checkSwarmPreFlight', [ARG_TRAP], "The JS Swarm provider's publish pre-flight"],
  ])('%s rejects before it reads the node URL or asks readiness', async (_name, probe, args, what) => {
    const { mocks, calls } = providerCollaborators();
    const { mod } = processOn('core', { mocks, request: './swarm-provider-ipc' });
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      await expect(mod[probe](...args)).rejects.toMatchObject({
        name: 'SwarmBackendError',
        code: 'swarm_backend_core',
        message: `${what} can't run on the core's Swarm backend`,
      });
      expect(calls).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test.each([
    ['js', false],
    ['core', true],
  ])('FREEDOM_SWARM_BACKEND=%s, packaged %s: both probes run as before', async (backend, packaged) => {
    const { mocks, calls } = providerCollaborators();
    const { mod } = processOn(backend, { packaged, mocks, request: './swarm-provider-ipc' });
    // No node URL: the probe reads it and answers node-stopped undialled.
    expect(await mod.checkBeeReachable()).toEqual({ ok: false, reason: 'node-stopped' });
    // Readiness asked (its spy answers nothing, read as node-stopped).
    expect(await mod.checkSwarmPreFlight()).toEqual({ ok: false, reason: 'node-stopped' });
    expect(calls).toEqual(['services.getAntApiUrl', 'setup.getPublishReadiness']);
  });
});

// ---------------------------------------------------------------------------
// Main's GSOC miner.

describe("main's GSOC miner on the core's backend", () => {
  const overlay = new Uint8Array(32).fill(1);
  const identifier = new Uint8Array(32).fill(2);

  /** The miner on `backend`, its Worker a spy. */
  function minerOn(backend, options = {}) {
    const Worker = jest.fn(() => {
      throw new Error('a GSOC worker was started');
    });
    const loaded = processOn(backend, {
      ...options,
      mocks: { 'node:worker_threads': () => ({ Worker }) },
      request: './gsoc-miner',
    });
    return { miner: loaded.mod, Worker, require: loaded.require };
  }

  test('mineSigner rejects, nothing queued and no worker started', async () => {
    const { miner, Worker } = minerOn('core');
    const refused = miner.mineSigner(overlay, identifier, 12, { owner: KEY, key: 'chat' });
    await expect(refused).rejects.toMatchObject({
      name: 'SwarmBackendError',
      code: 'swarm_backend_core',
      message: MINER_REFUSAL,
    });
    // No job was named for a joiner either.
    expect(miner.joinJob('chat', { owner: 'https://other.example' })).toBe(false);
    expect(Worker).not.toHaveBeenCalled();
  });

  test.each([
    ['options null', [overlay, identifier, 12, null]],
    ['options whose members throw when read', [overlay, identifier, 12, READ_TRAP]],
    ...trapped([overlay, identifier, 12, {}]).map((args) => [`(${args.map(shown).join(', ')})`, args]),
  ])('mineSigner with %s rejects before using its arguments, no worker started', async (_name, args) => {
    const { miner, Worker } = minerOn('core');
    let refused;
    expect(() => {
      refused = miner.mineSigner(...args);
    }).not.toThrow();
    await expect(refused).rejects.toMatchObject({ name: 'SwarmBackendError', message: MINER_REFUSAL });
    expect(Worker).not.toHaveBeenCalled();
  });

  test("messaging-service's GSOC derivation rejects through it, no worker started", async () => {
    const Worker = jest.fn();
    const { mod: messaging } = processOn('core', {
      mocks: {
        'node:worker_threads': () => ({ Worker }),
        [require.resolve('../service-registry')]: () => ({
          getAntApiUrl: () => 'http://127.0.0.1:1633',
          getService: () => ({ mode: 'bundled' }),
        }),
      },
      request: './messaging-service',
    });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      // The node's overlay, which the derivation reads first.
      if (String(url).endsWith('/addresses')) {
        return new Response(JSON.stringify({ overlay: '36'.repeat(32) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`no node call ${url} here`);
    });
    try {
      await expect(messaging.deriveGsoc('chat', { origin: KEY })).rejects.toMatchObject({
        code: 'swarm_backend_core',
      });
    } finally {
      fetchSpy.mockRestore();
    }
    expect(Worker).not.toHaveBeenCalled();
  });

  test.each([
    ['js', false],
    ['core', true],
  ])('FREEDOM_SWARM_BACKEND=%s, packaged %s: the worker starts, as before', async (backend, packaged) => {
    const { miner, Worker } = minerOn(backend, { packaged });
    const job = miner.mineSigner(overlay, identifier, 12, { owner: KEY });
    await expect(job).rejects.toMatchObject({ reason: 'gsoc_mining_failed' });
    expect(Worker).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The JS backend's messaging.

describe("main's Swarm messaging on the core's backend", () => {
  const MESSAGING_REFUSAL = "Main's Swarm messaging can't run on the core's Swarm backend";
  const SENDS = [
    ['getMessagingIdentity', []],
    ['deriveGsoc', ['chat', { origin: KEY }]],
    ['sendPss', [{ topic: 'chat', targets: 'abcd', recipient: `02${'28'.repeat(32)}`, data: new Uint8Array([1]) }]],
    ['sendGsoc', [{ topic: 'chat', data: new Uint8Array([1]), origin: KEY }]],
  ];
  const ROWS = SENDS.flatMap(([name, args]) => [[name, args], ...trapped(args).map((variant) => [name, variant])]);

  /** messaging-service on `backend`: its node reachable through a fetch spy, its miner's Worker a spy. */
  function messagingOn(backend, options = {}) {
    const Worker = jest.fn(() => {
      throw new Error('a GSOC worker was started');
    });
    const { mod } = processOn(backend, {
      ...options,
      mocks: {
        'node:worker_threads': () => ({ Worker }),
        [require.resolve('../service-registry')]: () => ({
          getAntApiUrl: () => 'http://127.0.0.1:1633',
          getService: () => ({ mode: 'bundled' }),
        }),
      },
      request: './messaging-service',
    });
    return { messaging: mod, Worker };
  }

  test.each(ROWS.map(([name, args]) => [`${name}(${args.map(shown).join(', ')})`, name, args]))(
    '%s rejects before using its arguments or calling the node',
    async (_label, name, args) => {
      const { messaging, Worker } = messagingOn('core');
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        throw new Error(`a node call ${url}`);
      });
      try {
        await expect(messaging[name](...args)).rejects.toMatchObject({
          name: 'SwarmBackendError',
          code: 'swarm_backend_core',
          message: MESSAGING_REFUSAL,
        });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(Worker).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    }
  );

  test.each([
    ['js', false],
    ['core', true],
  ])('FREEDOM_SWARM_BACKEND=%s, packaged %s: the identity asks the node, as before', async (backend, packaged) => {
    const { messaging } = messagingOn(backend, { packaged });
    const asked = [];
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      asked.push(new URL(String(url)).pathname);
      return new Response('{}', { status: 500 });
    });
    try {
      await expect(messaging.getMessagingIdentity()).rejects.toBeInstanceOf(Error);
      expect(asked).toEqual(['/addresses']);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Main's writers of the three Swarm stores.

const FEEDS = JSON.stringify(
  {
    version: 2,
    nextPublisherKeyIndex: 1,
    origins: {
      [KEY]: {
        activeIdentityId: 'bee-wallet',
        identities: {
          'bee-wallet': {
            id: 'bee-wallet',
            mode: 'bee-wallet',
            publisherKeyIndex: null,
            walletIndex: null,
            label: 'Bee wallet identity',
            createdAt: 1767225550123,
            lastUsedAt: null,
          },
        },
        feedGranted: true,
        grantedAt: 1767225550123,
        feeds: {
          blog: {
            topic: 'c3'.repeat(32),
            owner: `0x${OWNER}`,
            manifestReference: REF,
            identityId: 'bee-wallet',
            createdAt: 1767225560123,
            lastUpdated: null,
            lastReference: null,
          },
        },
      },
    },
  },
  null,
  2
);
const MANIFESTS = JSON.stringify({ version: 1, records: {} }, null, 2);
const LEGACY = JSON.stringify({
  entries: [{ type: 'data', name: 'a.txt', status: 'completed', timestamp: '2026-01-01T00:00:00.123Z' }],
});

/** A profile holding each store's file (and the legacy history), as a `js` run left it. */
function seededProfile() {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'swarm-feeds.json'), FEEDS);
  fs.writeFileSync(path.join(dir, 'swarm-manifest-grants.json'), MANIFESTS);
  fs.writeFileSync(path.join(dir, 'publish-history.json'), LEGACY);
  const Database = jest.requireActual('better-sqlite3');
  const db = new Database(path.join(dir, 'publish-history.sqlite'));
  db.exec('CREATE TABLE seeded (id INTEGER)');
  db.close();
  return dir;
}

/** `{ [file]: bytes as hex }` of `dir`'s store files. */
function storeFiles(dir) {
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter(isStoreFile)
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(dir, name)).toString('hex')])
  );
}

// Each store module's own paths: the function, its arguments, and the file
// its refusal names.
const FEED_PATHS = [
  ['getOriginEntry', [KEY]],
  ['setOriginEntry', [KEY, { identityMode: 'bee-wallet', feedGranted: true }]],
  // Refused before its arguments are read.
  ['setOriginEntry', [KEY, {}]],
  ['allocatePublisherKeyIndex', []],
  ['getOriginIdentityState', [KEY]],
  ['getOriginIdentityStateWithOwners', [KEY]],
  ['previewAppScopedIdentity', [KEY]],
  ['createAppScopedIdentity', [KEY]],
  ['createAppScopedIdentityAt', [KEY, 3, { activate: true, source: 'user' }]],
  ['ensureAntWalletIdentity', [KEY, { activate: true, source: 'user' }]],
  ['activateIdentity', [KEY, 'bee-wallet', { source: 'user' }]],
  ['getFeed', [KEY, 'blog']],
  ['setFeed', [KEY, 'notes', { topic: 'c3'.repeat(32), owner: `0x${OWNER}` }]],
  ['updateFeedReference', [KEY, 'blog', REF]],
  ['getAllFeeds', [KEY]],
  ['getAllOriginEntries', []],
  ['isIdentitySharedWithOtherOrigins', [KEY, { id: 'app-scoped:0', mode: 'app-scoped', publisherKeyIndex: 0 }]],
  // Refused even where the identity alone would answer.
  ['isIdentitySharedWithOtherOrigins', [KEY, { id: 'bee-wallet', mode: 'bee-wallet' }]],
  ['getEthereumWalletIdentityReferences', [1]],
  ['getEthereumWalletIdentityReferences', [-1]],
  ['hasIdentityMode', [KEY]],
  ['hasUnavailableIdentity', [KEY]],
  ['assertFeedGrantable', [KEY]],
  ['hasFeedGrant', [KEY]],
  ['grantFeedAccess', [KEY, { source: 'user' }]],
  ['revokeFeedAccess', [KEY, { source: 'user' }]],
  // Refused before their arguments are read: null, or members that throw
  // when read (`READ_TRAP`).
  ['setOriginEntry', [KEY, null]],
  ['setOriginEntry', [KEY, READ_TRAP]],
  ['previewAppScopedIdentity', [KEY, READ_TRAP]],
  ['createAppScopedIdentity', [KEY, READ_TRAP]],
  ['createAppScopedIdentityAt', [KEY, 3, READ_TRAP]],
  ['ensureAntWalletIdentity', [KEY, READ_TRAP]],
  ['activateIdentity', [KEY, 'bee-wallet', null]],
  ['activateIdentity', [KEY, 'bee-wallet', READ_TRAP]],
  ['isIdentitySharedWithOtherOrigins', [KEY, READ_TRAP]],
  ['grantFeedAccess', [KEY, null]],
  ['grantFeedAccess', [KEY, READ_TRAP]],
  ['revokeFeedAccess', [KEY, null]],
  ['revokeFeedAccess', [KEY, READ_TRAP]],
].map(([name, args]) => ['feed-store', name, args, 'swarm-feeds.json']);
const MANIFEST_PATHS = [
  ['checkManifest', [{ origin: KEY, committedUrl: `${KEY}/`, eager: true }]],
  ['decideManifest', ['c'.repeat(32), 'allow']],
  ['detachManaged', [KEY, 'autoApprove.publish']],
  ['detachManaged', [KEY, 'connection']],
  ['disconnect', [KEY]],
  ['getRecord', [KEY]],
  ['useIndividual', [KEY, 'publish']],
  // Refused before their arguments are read.
  ['checkManifest', [null]],
  ['checkManifest', [READ_TRAP]],
  ['checkManifest', [{ origin: KEY, committedUrl: `${KEY}/` }, READ_TRAP]],
  ['decideManifest', ['c'.repeat(32), 'allow', READ_TRAP]],
  // The JS check's own manifest fetch (the core's ask is answerManifestAsk).
  ['discover', [`${KEY}/`]],
].map(([name, args]) => ['permission-manifests', name, args, 'swarm-manifest-grants.json']);
const HISTORY_PATHS = [
  ['addEntry', [{ type: 'data', name: 'a.txt', origin: KEY }]],
  ['addEntry', [null]],
  ['updateEntry', [1, { status: 'completed' }]],
  ['updateEntry', [1, null]],
  ['addEntry', [READ_TRAP]],
  ['updateEntry', [1, READ_TRAP]],
  ['getEntries', []],
  ['clearEntries', []],
  ['removeEntry', [1]],
  ['getDb', []],
].map(([name, args]) => ['publish-history', name, args, 'publish-history.sqlite']);

describe("main's writers of the Swarm stores on the core's backend", () => {
  let watch;

  beforeAll(() => {
    watch = watchFileTouches(isStoreFile, { skip: [__filename] });
  });

  afterAll(() => {
    watch.restore();
  });

  /**
   * The three store modules on `backend`, on `userDataDir`, with spies on
   * what a store path would reach first: identity-manager's owners,
   * better-sqlite3's opens, the core's store calls and the bzz: fetch.
   */
  function storesOn(backend, userDataDir, { packaged = false } = {}) {
    const reached = [];
    const note = (name, value) =>
      jest.fn((...args) => {
        reached.push(name);
        return typeof value === 'function' ? value(...args) : value;
      });
    const Real = jest.requireActual('better-sqlite3');
    const loaded = processOn(backend, {
      packaged,
      userDataDir,
      mocks: {
        [require.resolve('../identity-manager')]: () => ({
          getBeeWalletAddress: note('identity.getBeeWalletAddress', async () => `0x${OWNER}`),
          getPublisherAddress: note('identity.getPublisherAddress', async () => `0x${'e5'.repeat(20)}`),
          getDerivedWallets: note('identity.getDerivedWallets', async () => []),
        }),
        'better-sqlite3': () =>
          function SpiedDatabase(file, options) {
            reached.push('better-sqlite3');
            watch.record('better-sqlite3', file);
            return new Real(file, options);
          },
        [require.resolve('../core/swarm-stores')]: () => ({
          identities: note('core.identities', async () => null),
          manifest: note('core.manifest', async () => null),
          history: note('core.history', async () => []),
        }),
        [require.resolve('./bzz-protocol')]: () => ({
          handleBzzRequest: note('bzz', async () => new Response('Not Found', { status: 404 })),
        }),
        [require.resolve('../private/private-windows')]: () => ({
          getPartitionForWebContents: () => null,
          isPrivateWebContents: () => false,
        }),
        [require.resolve('../profile-resolver')]: () => ({ getActiveProfile: () => null }),
      },
      request: '../../shared/ipc-channels',
    });
    return {
      modules: {
        'feed-store': loaded.require('./feed-store'),
        'permission-manifests': loaded.require('./permission-manifests'),
        'publish-history': loaded.require('./publish-history'),
      },
      reached,
      close: () => loaded.require('./publish-history').closeDb(),
    };
  }

  /** What `fn` returned or threw, waited for: `{ value }` or `{ error }`. */
  async function outcome(fn) {
    try {
      return { value: await fn() };
    } catch (error) {
      return { error };
    }
  }

  // Each path as written, then with each argument, and one more, a trap.
  const STORE_ROWS = [...FEED_PATHS, ...MANIFEST_PATHS, ...HISTORY_PATHS].flatMap(([module, name, args, file]) => [
    [module, name, args, file],
    ...trapped(args).map((variant) => [module, name, variant, file]),
  ]);

  test.each(STORE_ROWS.map((row) => [`${row[0]} ${row[1]}(${row[2].map(shown).join(', ')})`, ...row]))(
    '%s refuses unrun, naming its file',
    async (_name, module, name, args, file) => {
      const dir = seededProfile();
      const before = storeFiles(dir);
      const { modules, reached, close } = storesOn('core', dir);
      const mark = watch.mark();
      try {
        const out = await outcome(() => modules[module][name](...args));
        expect(out.error).toBeInstanceOf(Error);
        expect(out.error.message).toBe(`${file} is the identity core's: main doesn't open it`);
        expect(reached).toEqual([]);
        expect(watch.since(mark).map(({ name: call, path: target }) => [call, target])).toEqual([]);
        expect(storeFiles(dir)).toEqual(before);
      } finally {
        close();
      }
    }
  );

  test("the chrome's handlers and main's hooks on core: relays to the core, no file opened", async () => {
    const dir = seededProfile();
    const before = storeFiles(dir);
    const { modules, reached, close } = storesOn('core', dir);
    const mark = watch.mark();
    try {
      // Registering opens nothing on core: no journal replay, no hook set
      // (design 0015, D17's detach is the core's).
      modules['feed-store'].registerFeedStoreIpc();
      modules['permission-manifests'].registerPermissionManifestIpc();
      modules['publish-history'].registerPublishHistoryIpc();
      await new Promise(setImmediate);
      expect(reached).toEqual([]);
      expect(watch.since(mark)).toEqual([]);
      expect(storeFiles(dir)).toEqual(before);
    } finally {
      close();
    }
  });

  test.each([
    ['js', false],
    ['core', true],
  ])('FREEDOM_SWARM_BACKEND=%s, packaged %s: main keeps its files, as before', async (backend, packaged) => {
    const dir = seededProfile();
    const { modules, reached, close } = storesOn(backend, dir, { packaged });
    const mark = watch.mark();
    try {
      expect(modules['feed-store'].getAllFeeds(KEY)).toEqual({
        blog: expect.objectContaining({ topic: 'c3'.repeat(32), manifestReference: REF }),
      });
      expect(await modules['permission-manifests'].getRecord(KEY)).toBeNull();
      // The legacy file imported, as main's own history imports it.
      expect(modules['publish-history'].getEntries()).toEqual([
        expect.objectContaining({ id: 1, type: 'data', name: 'a.txt', status: 'completed' }),
      ]);
      const touched = new Set(watch.since(mark).filter((touch) => touch.main).map((touch) => path.basename(touch.path)));
      for (const name of ['swarm-feeds.json', 'swarm-manifest-grants.json', 'publish-history.sqlite']) {
        expect(touched).toContain(name);
      }
      expect(reached).toContain('better-sqlite3');
      expect(reached.filter((name) => name.startsWith('core.'))).toEqual([]);
    } finally {
      close();
    }
  });
});
