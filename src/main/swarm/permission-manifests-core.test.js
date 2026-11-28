/**
 * permission-manifests.js on the core's manifest store (freedom-core design
 * 0015, D3, D6 and D17; the SWM-6 to SWM-9 plan's PR 6.3, points 5 and 6),
 * through main's real client (core/swarm-stores.js). The hello naming
 * `swarm_stores` is the test's choice (core-client.js `swarmStoresNamed`,
 * mocked); no build names it before PR 7.4.
 *
 * - permission-manifests' store cases (test/helpers/permission-manifest-cases.js)
 *   against the simulated core (test/helpers/simulated-swarm-stores-core.js),
 *   whose check asks main's own `shell.swarm_manifest` handler (registered
 *   by core/swarm-stores.js's `registerSwarmShell`): each answer of main's,
 *   each manifest fetched and the store's files equal the reference's
 *   (test/helpers/reference-permission-manifests.js, on a root of its own)
 *   for the same sequence; every site key main sends is normalized, and
 *   every op goes as `shell`. permission-manifests.integration.test.js
 *   plays the same cases on the real core.
 * - An `fs` spy: main's permission-manifests.js opens no manifest-store
 *   file (the simulated core's reference, in this process, does), every
 *   function that reads or writes the file throws unrun, and main's detach
 *   hooks and journal replay are off.
 * - `shell.swarm_manifest` on a real client against a scripted core
 *   (test/helpers/fake-swarm-core.js): the check main sent names the window
 *   whose session fetches (a private window's own); never a fetch of a URL
 *   that isn't the check's `bzz:` manifest, nor for a check that isn't
 *   running; at most 8 KiB and a byte sent; `{ failed: true }` for a fetch
 *   that throws, a body that breaks or stalls, or no room in the Swarm I/O
 *   pool, whose 45 KiB charge it holds until its reply is written; the
 *   core's cancel answered at once.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// The chrome's handlers go to `mockIpc.handlers`: main's and the
// reference's apart.
const mockIpc = { handlers: {} };
jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  ipcMain: {
    handle: (channel, handler) => {
      mockIpc.handlers[channel] = handler;
    },
    removeHandler: () => {},
  },
  session: {
    defaultSession: { partition: 'default' },
    fromPartition: (partition) => ({ partition }),
  },
}));
jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  transports: { file: {}, console: {} },
}));

// The private-window bookkeeping, as the asking window reads now.
const mockPrivate = { partition: null };
jest.mock('../private/private-windows', () => ({
  getPartitionForWebContents: () => mockPrivate.partition,
  isPrivateWebContents: () => Boolean(mockPrivate.partition),
}));

jest.mock('../identity-manager', () => ({
  getBeeWalletAddress: async () => '0xBee0000000000000000000000000000000000000',
  getPublisherAddress: async (index) => `0xPublisher${index}`,
  getDerivedWallets: async () => [],
}));

// Every manifest fetch, main's and the reference's.
jest.mock('./bzz-protocol', () => ({ handleBzzRequest: jest.fn() }));

// The test chooses the hello (`swarm_stores` named or not) and the core.
const mockMove = { named: false, client: null };
jest.mock('../core/core-client', () => ({
  ...jest.requireActual('../core/core-client'),
  swarmStoresNamed: () => mockMove.named,
}));
jest.mock('../core/core-process', () => ({ getCoreClient: () => mockMove.client }));

const IPC = require('../../shared/ipc-channels');
const { handleBzzRequest } = require('./bzz-protocol');
const manifests = require('./permission-manifests');
const { registerSwarmShell } = require('../core/swarm-shell');
const { SwarmIoPool } = require('../core/swarm-io-pool');
const { writeTyped, readPlain } = require('../core/swarm-typed');
const { simulatedSwarmStores } = require('../../../test/helpers/simulated-swarm-stores-core');
const { useSimulatedGrantCore } = require('../../../test/helpers/simulated-grant-core');
const {
  PERMISSION_MANIFEST_CASES,
  manifest,
  normalized,
  playPermissionManifestCase,
  responseFor,
} = require('../../../test/helpers/permission-manifest-cases');

const { app } = require('electron');

// The stores' logs, and main's warnings, which a test reads: kept quiet.
for (const method of ['log', 'warn', 'error'])
  jest.spyOn(console, method).mockImplementation(() => {});

const STORE_FILE = 'swarm-manifest-grants.json';
const MAIN_MANIFESTS = path.join('src', 'main', 'swarm', 'permission-manifests.js');
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
const KIB = 1024;
const SITE = 'app.eth';
/** The room main charges for a manifest ask: 8 KiB and a byte, D6's sum. */
const ASK_CHARGE = 8193 + 2 * 4 * Math.ceil(8193 / 3) + 16 * KIB;

// What a manifest fetch answers now, and every URL fetched.
const serving = { spec: undefined };
const fetched = [];
beforeEach(() => {
  handleBzzRequest.mockReset();
  handleBzzRequest.mockImplementation(async (request) => {
    fetched.push(request.url);
    const response = responseFor(serving.spec);
    if (!response) throw new Error('fetch failed');
    return response;
  });
});

const dirs = [];
function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `permission-manifests-core-${name}-`));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A window's webContents, as page-swarm.js hands it over. */
function liveGuest() {
  const guest = { destroyed: false, isDestroyed: () => guest.destroyed };
  return guest;
}

/** An account on `pool` as the service client keeps one for a handler. */
function leaseOn(pool) {
  let held = 0;
  return {
    get held() {
      return held;
    },
    charge: (bytes) => {
      if (!pool.take(bytes)) return false;
      held += bytes;
      return true;
    },
    shrink: (bytes) => {
      if (bytes >= held) return;
      pool.release(held - bytes);
      held = bytes;
    },
    close: () => {
      pool.release(held);
      held = 0;
    },
  };
}

// Main's `shell.swarm_manifest` handler, as registerSwarmShell registers it
// on the core's client; its pool the test's.
const shellPool = new SwarmIoPool();
const registered = new Map();
registerSwarmShell(
  { handle: (method, handler, options) => registered.set(method, { handler, options }) },
  { pool: shellPool }
);

/** Main's answer to the core's `shell.swarm_manifest` ask, from generation 1. */
async function askMain(params) {
  const lease = leaseOn(shellPool);
  try {
    return await registered.get('shell.swarm_manifest').handler(params, {
      id: 1,
      signal: new AbortController().signal,
      charge: lease.charge,
      shrink: lease.shrink,
      onRelease: () => {},
      generation: 1,
    });
  } finally {
    lease.close();
  }
}

const sim = simulatedSwarmStores({ fetchManifest: (ask) => askMain(ask) });
const reference = sim.references().manifests;

// Main's handlers on the core's store, and the reference's on its own file.
const mainHandlers = {};
const referenceHandlers = {};
mockMove.named = true;
mockIpc.handlers = mainHandlers;
manifests.registerPermissionManifestIpc();
mockMove.named = false;
app.getPath.mockReturnValue(tempDir('register'));
mockIpc.handlers = referenceHandlers;
reference.registerPermissionManifestIpc();
mockIpc.handlers = {};

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
 * Spies on `fs` for any touch of a manifest-store file (the file, its
 * backup, its temporary file) from main's permission-manifests.js:
 * `fromMain()` lists them, `restore()` removes the spies. The simulated
 * core's reference, in this process, touches the files itself; only main's
 * frames count.
 */
function spyMainManifestStore() {
  const hits = [];
  const spies = SPIED.map((name) => {
    const original = fs[name];
    return jest.spyOn(fs, name).mockImplementation(function (...args) {
      if (args.some((arg) => typeof arg === 'string' && arg.includes(STORE_FILE))) {
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
    fromMain: () => hits.filter((hit) => hit.from.includes(MAIN_MANIFESTS)),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

/** A root seeded with `kase`'s files, and the grants seeded on a new grant core. */
async function freshWorld(kase, name) {
  const root = tempDir(name);
  for (const [file, text] of Object.entries(kase.seed?.files ?? {})) {
    fs.writeFileSync(path.join(root, file), text);
  }
  app.getPath.mockReturnValue(root);
  // A new world: the core's references load again from this root (the
  // feed store's too, which the manifest store's reference reads).
  void sim.references().feeds;
  sim.restart();
  manifests._resetForTests();
  sim.calls.length = 0;
  sim.unnormalized.length = 0;
  fetched.length = 0;
  const grantCore = await useSimulatedGrantCore({ swarm: kase.seed?.grants?.swarm ?? {} });
  return { root, grantCore };
}

/** A file of `root`, parsed, its text where it isn't JSON, or null. */
function fileOf(root, name) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  try {
    return normalized(JSON.parse(text));
  } catch {
    return text;
  }
}

/** What a run left: the Swarm grants, the manifest store and the feed store. */
function stateOf({ root, grantCore }) {
  return {
    grants: normalized(JSON.parse(grantCore.file('swarm'))),
    manifests: fileOf(root, STORE_FILE),
    feeds: fileOf(root, 'swarm-feeds.json'),
  };
}

const mainWorld = {
  serve: (spec) => {
    serving.spec = spec;
  },
  guest: liveGuest,
  check: (request) => manifests.checkPageManifest(request),
  decide: (...args) => manifests.decidePageManifest(...args),
  release: (token) => manifests.releasePageManifest(token),
  handlers: mainHandlers,
};

const referenceWorld = {
  ...mainWorld,
  check: (request) => reference.checkPageManifest(request),
  decide: (...args) => reference.decidePageManifest(...args),
  release: (token) => reference.releasePageManifest(token),
  handlers: referenceHandlers,
};

describe("permission-manifests' store cases on the simulated core", () => {
  afterEach(() => {
    mockMove.named = false;
    mockMove.client = null;
  });

  test.each(PERMISSION_MANIFEST_CASES.map((kase) => [kase.name, kase]))(
    '%s',
    async (_name, kase) => {
      // Main, its hello naming swarm_stores: every change goes to the core.
      const mainSide = await freshWorld(kase, 'main');
      mockMove.named = true;
      mockMove.client = { request: sim.request };
      const spy = spyMainManifestStore();
      let mainRun;
      try {
        mainRun = await playPermissionManifestCase(kase, mainWorld);
      } finally {
        spy.restore();
      }
      mockMove.named = false;
      mockMove.client = null;
      const mainFetched = [...fetched];
      const asked = [...sim.calls];
      const unnormalized = [...sim.unnormalized];
      const mainState = stateOf(mainSide);
      expect(spy.fromMain()).toEqual([]);
      expect(manifests._manifestAskCountForTests()).toBe(0);
      expect(shellPool.held).toBe(0);

      // The reference, today's main, on a root of its own.
      const referenceSide = await freshWorld(kase, 'reference');
      const referenceRun = await playPermissionManifestCase(kase, referenceWorld);

      expect(normalized(mainRun)).toEqual(normalized(referenceRun));
      expect(mainFetched).toEqual(fetched);
      expect(mainState).toEqual(stateOf(referenceSide));
      // Each step's op, as main's own (`shell`); every key as the core keys it.
      expect(asked.length).toBeGreaterThan(0);
      expect(
        asked.every(([method, , caller]) => method === 'swarm.manifest' && caller === 'shell')
      ).toBe(true);
      expect(unnormalized).toEqual([]);
    }
  );
});

describe("main's own manifest store is off once the core has it", () => {
  beforeEach(async () => {
    await freshWorld({}, 'off');
    mockMove.named = true;
    mockMove.client = { request: sim.request };
  });

  afterEach(() => {
    mockMove.named = false;
    mockMove.client = null;
  });

  test('every function that reads or writes the file throws, unrun, opening nothing', async () => {
    const spy = spyMainManifestStore();
    try {
      const refused = /swarm-manifest-grants\.json is the identity core's: main doesn't open it/;
      await expect(manifests.getRecord(SITE)).rejects.toThrow(refused);
      await expect(manifests.disconnect(SITE)).rejects.toThrow(refused);
      await expect(manifests.useIndividual(SITE, 'publish')).rejects.toThrow(refused);
      await expect(manifests.detachManaged(SITE, 'autoApprove.publish')).rejects.toThrow(refused);
      await expect(manifests.decideManifest('token', 'allow')).rejects.toThrow(refused);
      await expect(
        manifests.checkManifest({ origin: SITE, committedUrl: `bzz://${SITE}/`, eager: true })
      ).rejects.toThrow(refused);
    } finally {
      spy.restore();
    }
    expect(spy.all()).toEqual([]);
    expect(handleBzzRequest).not.toHaveBeenCalled();
  });

  test("registering the chrome's handlers replays no journal and listens for no change: D17 is the core's", () => {
    const permissions = require('./swarm-permissions');
    const feeds = require('./feed-store');
    const onPermissions = jest.spyOn(permissions, 'onManifestMutation');
    const onFeeds = jest.spyOn(feeds, 'onManifestMutation');
    const spy = spyMainManifestStore();
    const handlers = {};
    mockIpc.handlers = handlers;
    try {
      manifests.registerPermissionManifestIpc();
    } finally {
      mockIpc.handlers = {};
      spy.restore();
    }
    expect(Object.keys(handlers).sort()).toEqual([
      IPC.SWARM_MANIFEST_DISCONNECT,
      IPC.SWARM_MANIFEST_GET,
      IPC.SWARM_MANIFEST_USE_INDIVIDUAL,
    ]);
    expect(onPermissions).not.toHaveBeenCalled();
    expect(onFeeds).not.toHaveBeenCalled();
    expect(spy.all()).toEqual([]);
    onPermissions.mockRestore();
    onFeeds.mockRestore();
  });

  test("the page path's release never fails its caller, even with no core", async () => {
    mockMove.client = null;
    await expect(manifests.releasePageManifest('token')).resolves.toBeUndefined();
    mockMove.client = {
      request: async () => {
        throw new Error('gone');
      },
    };
    await expect(manifests.releasePageManifest('token')).resolves.toBeUndefined();
  });

  test('a window gone, or private without a partition, sends the core nothing', async () => {
    const gone = liveGuest();
    gone.destroyed = true;
    const request = { key: SITE, url: `bzz://${SITE}/`, eager: true };
    expect(await manifests.checkPageManifest({ ...request, guest: gone })).toEqual({
      kind: 'unresolved',
    });
    expect(await manifests.checkPageManifest({ ...request, guest: undefined })).toEqual({
      kind: 'unresolved',
    });
    expect(sim.calls).toEqual([]);
  });

  test('a refused guard reads holds() only after a passing recheck, and sends live: false', async () => {
    const sent = [];
    mockMove.client = {
      request: async (method, params) => {
        sent.push(readPlain(params.live));
        return { result_typed: writeTyped({ refused: true }) };
      },
    };
    const holds = jest.fn(() => true);
    expect(
      await manifests.decidePageManifest(SITE, 'token', 'allow', {
        recheck: async () => false,
        holds,
      })
    ).toEqual({ refused: true });
    expect(holds).not.toHaveBeenCalled();
    await manifests.decidePageManifest(SITE, 'token', 'allow', {
      recheck: async () => true,
      holds: () => false,
    });
    await manifests.decidePageManifest(SITE, 'token', 'allow', {
      recheck: async () => true,
      holds,
    });
    expect(sent).toEqual([false, false, true]);
  });
});

/**
 * A scripted core that echoes the stores the hello names (the build's
 * fake-swarm-core echoes none), with main's Swarm shell registered on a
 * real client whose hello names `swarm_stores`.
 */
async function startStoresCore({ pool = new SwarmIoPool() } = {}) {
  const { CoreClient, _internal, storeMovedFor } = jest.requireActual('../core/core-client');
  const { FakeSwarmCore } = require('../../../test/helpers/fake-swarm-core');
  const { CORE_STREAM_KINDS } = require('../core/frame');
  class StoresCore extends FakeSwarmCore {
    onMessage(message) {
      if (message.method !== 'core.hello') return super.onMessage(message);
      this.send({
        type: 'response',
        id: message.id,
        result: {
          protocol: 2,
          core_version: '0.32.0',
          capabilities: ['vault.status', 'fragments', 'streams'],
          store_moved: message.params.store_moved,
        },
      });
      this.decoder.setKinds(CORE_STREAM_KINDS);
      return undefined;
    }
  }
  const children = [];
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const client = new CoreClient({
    spawn: () => {
      const child = new StoresCore();
      children.push(child);
      return child;
    },
    command: '/bin/freedom-cored',
    args: ['serve'],
    log: quiet,
    shellVersion: 'test',
    grantRoot: os.tmpdir(),
    setTimer: (fn, ms) => ({ fn, ms }),
    clearTimer: () => {},
  });
  client.service = _internal.coreService(storeMovedFor('core', { swarmStores: true }));
  registerSwarmShell(client, { log: quiet, pool });
  await client.start();
  return { client, pool, core: () => children[children.length - 1] };
}

describe("shell.swarm_manifest: main fetches a running check's manifest on its window's session", () => {
  const { until } = require('../../../test/helpers/fake-swarm-core');
  let started;
  const manifestUrl = `bzz://${SITE}/freedom-manifest.json`;
  const body = JSON.stringify(manifest({ publish: { why: 'Publish releases' } }));

  beforeEach(() => {
    mockMove.named = true;
    mockPrivate.partition = null;
    manifests._resetForTests();
  });

  afterEach(async () => {
    mockMove.named = false;
    mockMove.client = null;
    mockPrivate.partition = null;
    await started?.client.stop();
    started = null;
  });

  async function start(options) {
    started = await startStoresCore(options);
    mockMove.client = started.client;
    return started;
  }

  /** A page's check, sent: `{ checking, check }`, `check` the core's view of it. */
  async function sendCheck(guest = liveGuest(), key = SITE) {
    const checking = manifests.checkPageManifest({
      key,
      url: `bzz://${key}/page`,
      guest,
      eager: true,
    });
    await until(() => started.core().requests('swarm.manifest').length > 0, 'the check');
    const check = started.core().requests('swarm.manifest').at(-1);
    return { checking, check };
  }

  /** The core's ask, and main's reply once it has come. */
  async function ask(params) {
    const id = started.core().ask('shell.swarm_manifest', params);
    await until(() => started.core().reply(id), 'the reply');
    return started.core().reply(id);
  }

  /** The core answers its check `id`. */
  function answerCheck(id, result = { kind: 'legacy' }) {
    started.core().respond(id, { result_typed: writeTyped(result) });
  }

  test("the check names its window: the default session's fetch, its body sent, the registry emptied after", async () => {
    await start();
    serving.spec = manifest({ publish: { why: 'Publish releases' } });
    const { checking, check } = await sendCheck();
    expect(readPlain(check.params.key)).toBe(SITE);
    expect(manifests._manifestAskCountForTests()).toBe(1);
    const reply = await ask({ for: check.id, url: manifestUrl });
    expect(reply.result).toEqual({
      status: 200,
      body_base64: Buffer.from(body).toString('base64'),
    });
    expect(handleBzzRequest).toHaveBeenCalledTimes(1);
    const [request, context] = handleBzzRequest.mock.calls[0];
    expect(request.url).toBe(manifestUrl);
    expect(context).toEqual({
      session: { partition: 'default' },
      partition: null,
      isPrivate: false,
    });
    answerCheck(check.id);
    await expect(checking).resolves.toEqual({ kind: 'legacy' });
    expect(manifests._manifestAskCountForTests()).toBe(0);
    // The check has ended: a late ask for it fetches nothing.
    expect((await ask({ for: check.id, url: manifestUrl })).result).toEqual({ failed: true });
    expect(handleBzzRequest).toHaveBeenCalledTimes(1);
    expect(started.pool.held).toBe(0);
  });

  test("a private window's check is fetched on its own session, with its private context", async () => {
    await start();
    serving.spec = { status: 404 };
    mockPrivate.partition = 'private-1';
    const { checking, check } = await sendCheck();
    // The partition is read for the window again at the ask.
    expect((await ask({ for: check.id, url: manifestUrl })).result).toEqual({
      status: 404,
      body_base64: '',
    });
    expect(handleBzzRequest.mock.calls[0][1]).toEqual({
      session: { partition: 'private-1' },
      partition: 'private-1',
      isPrivate: true,
    });
    answerCheck(check.id);
    await checking;
  });

  test('a window gone, or on another partition, since its check was sent fetches nothing', async () => {
    await start();
    serving.spec = manifest({ publish: { why: 'Publish releases' } });
    const guest = liveGuest();
    const { checking, check } = await sendCheck(guest);
    guest.destroyed = true;
    expect((await ask({ for: check.id, url: manifestUrl })).result).toEqual({ failed: true });
    guest.destroyed = false;
    mockPrivate.partition = 'private-2';
    expect((await ask({ for: check.id, url: manifestUrl })).result).toEqual({ failed: true });
    expect(handleBzzRequest).not.toHaveBeenCalled();
    answerCheck(check.id);
    await checking;
  });

  test("never a fetch but the running check's bzz: manifest: another URL, another check, another form", async () => {
    await start();
    serving.spec = manifest({ publish: { why: 'Publish releases' } });
    const { checking, check } = await sendCheck();
    console.warn.mockClear();
    for (const params of [
      { for: check.id, url: 'https://app.eth/freedom-manifest.json' },
      { for: check.id, url: 'http://127.0.0.1:1633/bzz/app.eth/freedom-manifest.json' },
      { for: check.id, url: 'file:///etc/passwd' },
      { for: check.id, url: 'bzz://other.eth/freedom-manifest.json' },
      { for: check.id, url: 'bzz://app.eth/other.json' },
      { for: check.id, url: 'BZZ://app.eth/freedom-manifest.json' },
      { for: check.id + 1, url: manifestUrl },
      { for: 0, url: manifestUrl },
      { for: String(check.id), url: manifestUrl },
      { for: check.id, url: manifestUrl, extra: true },
      { for: check.id },
      { url: manifestUrl },
    ]) {
      expect([params, (await ask(params)).result]).toEqual([params, { failed: true }]);
    }
    expect(handleBzzRequest).not.toHaveBeenCalled();
    // Each core fault is logged, and no URL with it.
    const warned = console.warn.mock.calls.flat().join('\n');
    expect(warned).toMatch(/another address/);
    expect(warned).toMatch(/malformed/);
    expect(warned).not.toMatch(/\/\/|passwd|freedom-manifest/);
    answerCheck(check.id);
    await checking;
  });

  test("a check whose committed URL isn't bzz: fetches nothing, whatever the core asks", async () => {
    await start();
    const checking = manifests.checkPageManifest({
      key: 'https://app.example',
      url: 'https://app.example/page',
      guest: liveGuest(),
      eager: true,
    });
    await until(() => started.core().requests('swarm.manifest').length > 0, 'the check');
    const check = started.core().requests('swarm.manifest').at(-1);
    for (const url of [
      'https://app.example/freedom-manifest.json',
      'bzz://app.example/freedom-manifest.json',
    ]) {
      expect((await ask({ for: check.id, url })).result).toEqual({ failed: true });
    }
    expect(handleBzzRequest).not.toHaveBeenCalled();
    answerCheck(check.id);
    await checking;
  });

  test('at most 8 KiB and a byte is read and sent; 8 KiB whole; another status unread', async () => {
    await start();
    const { checking, check } = await sendCheck();
    const big = Buffer.alloc(40 * KIB, 0x78);
    serving.spec = { text: big.toString() };
    const over = await ask({ for: check.id, url: manifestUrl });
    expect(Buffer.from(over.result.body_base64, 'base64')).toEqual(big.subarray(0, 8 * KIB + 1));
    serving.spec = { text: 'y'.repeat(8 * KIB) };
    const whole = await ask({ for: check.id, url: manifestUrl });
    expect(Buffer.from(whole.result.body_base64, 'base64').toString()).toBe('y'.repeat(8 * KIB));
    // A body without a reader is cut the same way.
    handleBzzRequest.mockImplementationOnce(async () => ({
      status: 200,
      body: null,
      arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.length),
    }));
    const unread = await ask({ for: check.id, url: manifestUrl });
    expect(Buffer.from(unread.result.body_base64, 'base64')).toEqual(big.subarray(0, 8 * KIB + 1));
    let cancelled = false;
    handleBzzRequest.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 }
        )
    );
    expect((await ask({ for: check.id, url: manifestUrl })).result).toEqual({
      status: 503,
      body_base64: '',
    });
    expect(cancelled).toBe(true);
    answerCheck(check.id);
    await checking;
    expect(started.pool.held).toBe(0);
  });

  test('a fetch that throws, or a body that breaks, answers { failed: true }', async () => {
    await start();
    const { checking, check } = await sendCheck();
    serving.spec = 'throws';
    expect((await ask({ for: check.id, url: manifestUrl })).result).toEqual({ failed: true });
    serving.spec = 'severed';
    expect((await ask({ for: check.id, url: manifestUrl })).result).toEqual({ failed: true });
    answerCheck(check.id);
    await checking;
    expect(started.pool.held).toBe(0);
  });

  test("the reply's 45 KiB room is held on the Swarm I/O pool until written; without it, no fetch", async () => {
    await start();
    let release;
    handleBzzRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(new Response(body, { status: 200 }));
        })
    );
    const { checking, check } = await sendCheck();
    const id = started.core().ask('shell.swarm_manifest', { for: check.id, url: manifestUrl });
    await until(() => release, 'the fetch');
    expect(started.pool.held).toBe(ASK_CHARGE);
    release();
    await until(() => started.core().reply(id), 'the reply');
    await until(() => started.pool.held === 0, 'the release');
    answerCheck(check.id);
    await checking;
    await started.client.stop();

    // A pool with no room for it: failed, unfetched.
    handleBzzRequest.mockClear();
    await start({ pool: new SwarmIoPool(ASK_CHARGE - 1) });
    const second = await sendCheck();
    expect((await ask({ for: second.check.id, url: manifestUrl })).result).toEqual({
      failed: true,
    });
    expect(handleBzzRequest).not.toHaveBeenCalled();
    answerCheck(second.check.id);
    await second.checking;
  });

  test("the core's cancel is answered cancelled at once, and stops the fetch", async () => {
    await start();
    let signal = null;
    let release;
    handleBzzRequest.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          ({ signal } = request);
          release = () => resolve(new Response(body, { status: 200 }));
        })
    );
    const { checking, check } = await sendCheck();
    const id = started.core().ask('shell.swarm_manifest', { for: check.id, url: manifestUrl });
    await until(() => signal, 'the fetch');
    started.core().cancel(id);
    await until(() => started.core().reply(id), 'the cancel');
    expect(started.core().reply(id).error).toMatchObject({ code: 'cancelled' });
    expect(signal.aborted).toBe(true);
    // The fetch settling later sends nothing more, and its charge goes.
    release();
    await until(() => started.pool.held === 0, 'the release');
    expect(
      started.core().messages.filter((m) => m.type === 'response' && m.id === id)
    ).toHaveLength(1);
    answerCheck(check.id);
    await checking;
  });
});

describe('shell.swarm_manifest: a body that stalls', () => {
  afterEach(() => {
    jest.useRealTimers();
    mockMove.named = false;
    mockMove.client = null;
  });

  test('15 s without a byte answers { failed: true }, and cancels the body', async () => {
    mockMove.named = true;
    let onSent = null;
    let finish;
    mockMove.client = {
      request: (method, params, context, options) =>
        new Promise((resolve) => {
          ({ onSent } = options);
          onSent(7, 3);
          finish = () => resolve({ result_typed: writeTyped({ kind: 'unresolved' }) });
        }),
    };
    const checking = manifests.checkPageManifest({
      key: SITE,
      url: `bzz://${SITE}/`,
      guest: liveGuest(),
      eager: true,
    });
    for (let i = 0; i < 10 && !onSent; i += 1) await Promise.resolve();
    let cancelled = false;
    handleBzzRequest.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"schema":'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 }
        )
    );
    jest.useFakeTimers();
    const answer = manifests.answerManifestAsk(
      { for: 7, url: `bzz://${SITE}/freedom-manifest.json` },
      { generation: 3, signal: new AbortController().signal }
    );
    await jest.advanceTimersByTimeAsync(manifests.BODY_IDLE_TIMEOUT_MS + 1_000);
    await expect(answer).resolves.toEqual({ failed: true });
    expect(cancelled).toBe(true);
    // Another generation's ID is another check.
    expect(
      await manifests.answerManifestAsk(
        { for: 7, url: `bzz://${SITE}/freedom-manifest.json` },
        { generation: 4 }
      )
    ).toEqual({ failed: true });
    jest.useRealTimers();
    finish();
    await expect(checking).resolves.toEqual({ kind: 'unresolved' });
  });
});
