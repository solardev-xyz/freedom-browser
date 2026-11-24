// PRIVATE MODE GUARD (Colibri store, #1058), end to end inside main, in two
// parts:
//
// - On each backend (test/helpers/colibri-backends.js, freedom-core design
//   0014, COL-5): the real resolver and private-window registry over the
//   real WASM workers, and over the real freedom-colibrid. With no proof to
//   be had (a scripted prover that is down), what a private session must
//   not leave behind is anything at all under <userData>: no file and no
//   directory. Its processes end with it, and a read for an ended session
//   starts none.
// - The store's contents, on the WASM path: the real resolver, worker host,
//   worker service and private-window registry, with a fake Colibri runtime
//   that keeps a `call_<chain>_<address>` record for every contract it is
//   asked about, as Colibri's own store does (eth_call_account.c, saved by
//   verify_call.c). Only the thread boundary is replaced: each "worker"
//   runs the worker service in this process, on its own fake runtime, with
//   the storage the host chose for it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let mockUserData = null;
const mockWindows = [];
const mockLanes = [];
// The prover the registry names, and whether workers are the real ones.
let mockProverUrl = 'https://prover.example';
let mockRealWorkers = false;

jest.mock('electron', () => {
  const { EventEmitter: Emitter } = require('node:events');
  return {
    app: { getPath: (name) => (name === 'userData' ? mockUserData : null) },
    net: { request: () => ({}) },
    BrowserWindow: { fromWebContents: () => null },
    session: {
      fromPartition: () => Object.assign(new Emitter(), {
        clearStorageData: () => Promise.resolve(),
        clearCache: () => Promise.resolve(),
      }),
    },
  };
});

jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

jest.mock('../windows/mainWindow', () => {
  const { EventEmitter: Emitter } = require('node:events');
  let nextId = 1;
  return {
    createMainWindow: () => {
      const win = Object.assign(new Emitter(), { id: nextId++ });
      mockWindows.push(win);
      return win;
    },
  };
});

jest.mock('../networks/network-registry', () => ({
  ...jest.requireActual('../networks/network-registry'),
  getNetwork: () => ({ zkProof: true }),
  getEndpoints: (_chainId, role) => (role === 'prover' ? [mockProverUrl] : []),
}));

// Only hostOf is imported: Colibri runs no ENS call (#1076).
jest.mock('../ens-resolver', () => ({
  hostOf: (url) => new URL(url).host,
}));

// A read's answer says whether the record was already in the worker's store.
const HIT = '0x01';
const MISS = '0x00';

function mockFakeRuntime() {
  let storage = null;
  class Colibri {
    constructor(config) { this.config = config; }

    static register_storage(registered) {
      storage = registered;
      return Promise.resolve();
    }

    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x1';
      const target = method === 'eth_call' ? params[0]?.to : params[0];
      const key = `call_${this.config.chainId}_${String(target).toLowerCase()}`;
      const hit = storage.get(key) !== null;
      storage.set(key, Buffer.from('account and storage state'));
      return hit ? '0x01' : '0x00';
    }

    destroy() {}
  }
  return { Colibri, Strategy: { VerifiedOnly: 'verified-only' }, setRuntimeResetListener() {} };
}

// node:worker_threads' Worker: run in this process, or the real one.
jest.mock('node:worker_threads', () => ({
  isMainThread: true,
  parentPort: null,
  threadId: 0,
  workerData: null,
  Worker: jest.fn().mockImplementation((file, options) => {
    if (mockRealWorkers) {
      return require('../../../test/helpers/colibri-backends').realWorker(file, options);
    }
    const { workerData } = options;
    // Loaded here, not at the top: the factory runs before the file's own
    // requires.
    const { createColibriService } = jest.requireActual('./colibri-worker');
    const { EventEmitter } = require('node:events');
    const worker = new EventEmitter();
    let stopped = false;
    const post = (message) => setImmediate(() => { if (!stopped) worker.emit('message', message); });
    const service = createColibriService({
      runtime: mockFakeRuntime(),
      storageDir: workerData.storageDir,
      post,
    });
    mockLanes.push({ storageDir: workerData.storageDir, worker });
    worker.postMessage = (message) => {
      if (!stopped) setImmediate(() => service.handle(message));
    };
    worker.terminate = () => {
      stopped = true;
      worker.stopped = true;
      setImmediate(() => worker.emit('exit', 1));
      return Promise.resolve(1);
    };
    worker.unref = () => {};
    service.init().then(() => post({ type: 'ready' }));
    return worker;
  }),
}));
const host = require('./colibri-worker-host');
const resolver = require('./colibri-resolver');
const privateWindows = require('../private/private-windows');
const { runWithPrivateLogContext } = require('../private/private-log-context');
const {
  describeBackends,
  deviation,
  outcomeOf,
  proverWorld,
  startBackend,
} = require('../../../test/helpers/colibri-backends');

const inPrivate = (fn) => runWithPrivateLogContext(true, fn);
const CONTRACT = '0x00000000000000000000000000000000000000c1';
const OTHER = '0x00000000000000000000000000000000000000c2';
const callKey = (address) => `call_1_${address.toLowerCase()}`;

// Every file under <userData>, as paths relative to it.
function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true })
    .filter((name) => fs.statSync(path.join(dir, name)).isFile())
    .sort();
}

const balance = (address) => resolver.requestViaColibri(1, 'eth_getBalance', [address, 'latest']);
const code = (address) => resolver.requestViaColibri(1, 'eth_getCode', [address, 'latest']);

beforeEach(() => {
  mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-colibri-private-'));
  mockLanes.length = 0;
  mockWindows.length = 0;
  resolver.clearColibriClientForTest();
  host.resetForTest();
  privateWindows._resetState();
  privateWindows.setPrivateSessionConfigurator(() => {});
  resolver.registerColibriPrivateCleanup(privateWindows);
});

afterEach(() => {
  resolver.clearColibriClientForTest();
  host.resetForTest();
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

// Every file and directory under <userData>, as paths relative to it.
function entriesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).sort();
}

describeBackends('a private session on each backend (#1058)', (backend) => {
  const ENV = 'FREEDOM_COLIBRI_BACKEND';
  const failed = (address, method = 'eth_getBalance') => ({
    name: 'ProviderRpcError',
    code: 4900,
    message:
      `Error in rpc call ${method}${JSON.stringify([address, 'latest'])} : remote proof ` +
      'failed (no local proving): HTTP error! Status: 503, Details: prover down',
    data: undefined,
  });
  let world;
  let started;
  let saved;
  const lanes = () => started.spawned.map((proc) => (proc.private ? 'private' : 'normal'));

  beforeEach(async () => {
    mockRealWorkers = true;
    saved = process.env[ENV];
    process.env[ENV] = backend.kind;
    world = await proverWorld();
    mockProverUrl = world.url;
    started = await startBackend(backend, { userData: mockUserData });
  });

  afterEach(async () => {
    world.release();
    resolver.clearColibriClientForTest();
    await started.close();
    await world.close();
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    mockProverUrl = 'https://prover.example';
    mockRealWorkers = false;
  });

  test("a normal window's reads keep the chain's store under <userData>/colibri [deviation storage-per-chain]", async () => {
    await expect(balance(CONTRACT).catch(outcomeOf)).resolves.toEqual(failed(CONTRACT));
    expect(lanes()).toEqual(['normal']);
    expect(entriesUnder(mockUserData)).toEqual(
      deviation('storage-per-chain', backend, {
        wasm: ['colibri'],
        service: ['colibri', path.join('colibri', '1')],
      })
    );
  });

  test.each([
    ['a balance read', () => balance(CONTRACT), failed(CONTRACT)],
    ['a code read', () => code(CONTRACT), failed(CONTRACT, 'eth_getCode')],
  ])('%s from a private window writes nothing under <userData>', async (_label, read, outcome) => {
    privateWindows.createPrivateWindow();
    await expect(inPrivate(read).catch(outcomeOf)).resolves.toEqual(outcome);
    await expect(inPrivate(read).catch(outcomeOf)).resolves.toEqual(outcome);
    expect(entriesUnder(mockUserData)).toEqual([]);
    // It ran on a process of its own, with no store.
    expect(started.spawned.map((proc) => proc.storageDir)).toEqual([null]);
  });

  test('closing the last private window ends its process; the next starts a new one', async () => {
    const first = privateWindows.createPrivateWindow();
    const second = privateWindows.createPrivateWindow();
    await expect(balance(OTHER).catch(outcomeOf)).resolves.toEqual(failed(OTHER));
    await expect(inPrivate(() => balance(CONTRACT)).catch(outcomeOf)).resolves.toEqual(
      failed(CONTRACT)
    );
    expect(lanes()).toEqual(['normal', 'private']);
    const [normal, privateProc] = started.spawned;
    let privateExited = false;
    privateProc.exited.then(() => {
      privateExited = true;
    });

    // One private window is still open: the process is still theirs.
    first.emit('closed');
    await expect(inPrivate(() => code(CONTRACT)).catch(outcomeOf)).resolves.toEqual(
      failed(CONTRACT, 'eth_getCode')
    );
    expect(privateExited).toBe(false);
    expect(lanes()).toEqual(['normal', 'private']);

    second.emit('closed');
    await privateProc.exited;

    // The next private window starts a new one.
    privateWindows.createPrivateWindow();
    await expect(inPrivate(() => balance(CONTRACT)).catch(outcomeOf)).resolves.toEqual(
      failed(CONTRACT)
    );
    expect(lanes()).toEqual(['normal', 'private', 'private']);
    // The normal lane never noticed.
    let normalExited = false;
    normal.exited.then(() => {
      normalExited = true;
    });
    await expect(balance(OTHER).catch(outcomeOf)).resolves.toEqual(failed(OTHER));
    expect(normalExited).toBe(false);
    expect(lanes()).toEqual(['normal', 'private', 'private']);
  });

  // Codex review of #1070, finding 2: a read can wait on Myotis or the
  // network before it reaches Colibri, so a private one can still be waiting
  // when its last window closes.
  test('a private read still waiting when the last private window closes starts no process', async () => {
    const win = privateWindows.createPrivateWindow();
    await inPrivate(() => balance(OTHER)).catch(() => {});
    let releaseMyotis;
    const myotis = new Promise((resolve) => {
      releaseMyotis = resolve;
    });
    const pending = inPrivate(async () => {
      await myotis;
      return balance(CONTRACT);
    });
    pending.catch(() => {});

    win.emit('closed');
    await started.spawned[0].exited;
    // The next private window opens before the old read resumes.
    privateWindows.createPrivateWindow();
    releaseMyotis();

    await expect(pending).rejects.toMatchObject({
      message: 'Colibri private session ended',
      colibriBystander: true,
    });
    expect(started.spawned).toHaveLength(1);
    expect(entriesUnder(mockUserData)).toEqual([]);
    expect(world.requests).toHaveLength(1);
  });

  // The core's request names the requests of main's it serves; the
  // executor runs the read in their private session (#1071, #285).
  describe("through the core's shell.verified", () => {
    const { registerChainVerified } = require('../core/chain-verified');
    const { privateContextSession } = require('../private/private-log-context');
    const routes = [];
    registerChainVerified({ hello: null, handle: (_method, fn) => routes.push(fn) }, {
      generation: () => 0,
    });
    const chainRead = (extra) =>
      routes[0](
        {
          chain_id: 1,
          generation: 0,
          colibri: 'request',
          method: 'eth_getBalance',
          params: [CONTRACT, 'latest'],
          deadline_ms: 10_000,
        },
        { signal: new AbortController().signal, charge: () => true, ...extra }
      );
    const openSession = () => runWithPrivateLogContext(true, () => privateContextSession());

    test('a read the core asks for a private window writes nothing under <userData>', async () => {
      privateWindows.createPrivateWindow();
      await expect(chainRead({ private: true, privateSession: openSession() })).resolves.toEqual({
        failure: 'error',
      });
      // Unknown counts as private, and with no session it is refused.
      await expect(chainRead({})).resolves.toEqual({ failure: 'error' });
      expect(entriesUnder(mockUserData)).toEqual([]);
      expect(lanes()).toEqual(['private']);
    });

    test('a read the core asks for a private session that has ended starts no process', async () => {
      const win = privateWindows.createPrivateWindow();
      const ended = openSession();
      await chainRead({ private: true, privateSession: ended });
      win.emit('closed');
      await started.spawned[0].exited;
      // A new private window opens before the old read's verifier step.
      privateWindows.createPrivateWindow();
      await expect(chainRead({ private: true, privateSession: ended })).resolves.toEqual({
        failure: 'error',
      });
      expect(started.spawned).toHaveLength(1);
      expect(entriesUnder(mockUserData)).toEqual([]);
      // The new session's own read gets a new process.
      await chainRead({ private: true, privateSession: openSession() });
      expect(lanes()).toEqual(['private', 'private']);
    });
  });
});

describe('Colibri store for private windows (#1058)', () => {
  test('a normal window keeps its reads in <userData>/colibri, as before', async () => {
    await expect(balance(CONTRACT)).resolves.toBe(MISS);
    await expect(code(OTHER)).resolves.toBe(MISS);

    expect(filesUnder(mockUserData)).toEqual([
      path.join('colibri', callKey(CONTRACT)),
      path.join('colibri', callKey(OTHER)),
    ]);
    // And they stay warm across reads.
    await expect(balance(CONTRACT)).resolves.toBe(HIT);
  });

  // Chain data is Colibri's only caller: names don't use it (#1076).
  test.each([
    ['a balance read', () => balance(CONTRACT)],
    ['a code read', () => code(CONTRACT)],
  ])('%s from a private window writes nothing under <userData>', async (_label, read) => {
    privateWindows.createPrivateWindow();
    await inPrivate(read);
    await inPrivate(read);

    expect(filesUnder(mockUserData)).toEqual([]);
    // It ran on a worker of its own, with no storage dir.
    expect(mockLanes.map((lane) => lane.storageDir)).toEqual([null]);
  });

  test('private and normal windows do not see each other’s store', async () => {
    privateWindows.createPrivateWindow();
    await inPrivate(() => balance(CONTRACT));
    // Warm in the private store, cold in the normal one...
    await expect(inPrivate(() => balance(CONTRACT))).resolves.toBe(HIT);
    await expect(balance(CONTRACT)).resolves.toBe(MISS);
    // ...and the other way round.
    await balance(OTHER);
    await expect(inPrivate(() => balance(OTHER))).resolves.toBe(MISS);
    expect(filesUnder(mockUserData)).toEqual([
      path.join('colibri', callKey(CONTRACT)),
      path.join('colibri', callKey(OTHER)),
    ]);
  });

  test('closing the last private window drops its store', async () => {
    const first = privateWindows.createPrivateWindow();
    const second = privateWindows.createPrivateWindow();
    await balance(OTHER);
    await inPrivate(() => balance(CONTRACT));
    await inPrivate(() => code(OTHER));
    const [, privateLane] = mockLanes;
    expect(privateLane.storageDir).toBeNull();

    // One private window is still open: the store is still theirs.
    first.emit('closed');
    expect(privateLane.worker.stopped).toBeUndefined();
    await expect(inPrivate(() => balance(CONTRACT))).resolves.toBe(HIT);

    second.emit('closed');
    expect(privateLane.worker.stopped).toBe(true);

    // The next private window starts from an empty store, on a new worker.
    privateWindows.createPrivateWindow();
    await expect(inPrivate(() => balance(CONTRACT))).resolves.toBe(MISS);
    await expect(inPrivate(() => code(OTHER))).resolves.toBe(MISS);
    expect(mockLanes.map((lane) => lane.storageDir)).toEqual([
      path.join(mockUserData, 'colibri'),
      null,
      null,
    ]);
    // The normal lane never noticed.
    expect(mockLanes[0].worker.stopped).toBeUndefined();
    await expect(balance(OTHER)).resolves.toBe(HIT);
    expect(filesUnder(mockUserData)).toEqual([path.join('colibri', callKey(OTHER))]);
  });

  // Codex review of #1070, finding 2: a read can wait on Myotis or the
  // network before it reaches Colibri, so a private one can still be waiting
  // when its last window closes.
  test('a private read still waiting when the last private window closes starts no worker', async () => {
    const win = privateWindows.createPrivateWindow();
    await inPrivate(() => balance(OTHER));
    let releaseMyotis;
    const myotis = new Promise((resolve) => { releaseMyotis = resolve; });
    const pending = inPrivate(async () => {
      await myotis;
      return balance(CONTRACT);
    });
    pending.catch(() => {});

    win.emit('closed');
    expect(mockLanes[0].worker.stopped).toBe(true);
    // The next private window opens before the old read resumes.
    privateWindows.createPrivateWindow();
    releaseMyotis();

    await expect(pending).rejects.toMatchObject({ message: 'Colibri private session ended' });
    expect(mockLanes).toHaveLength(1);
    expect(filesUnder(mockUserData)).toEqual([]);
    // The new window's first read gets a fresh store, without the old read.
    await expect(inPrivate(() => balance(CONTRACT))).resolves.toBe(MISS);
    expect(mockLanes.map((lane) => lane.storageDir)).toEqual([null, null]);
  });
});


// On this branch every Colibri read is one of chain data's `shell.verified`
// operations, run by main's executor with its real adapters. The core's
// request names the requests of main's it serves; the client's `private`
// (service-client.js privacyOf) tells from those, and the executor runs the
// read in that context. Naming's executor runs no Colibri read at all
// (#1076).
describe("Colibri store through the cores' shell.verified (#1058)", () => {
  const { registerChainVerified } = require('../core/chain-verified');
  const { registerNamingVerified } = require('../core/naming-verified');

  function executor(register, config) {
    const routes = [];
    register({ hello: null, handle: (method, fn) => routes.push(fn) }, config);
    return (params, extra) =>
      routes[0](params, { signal: new AbortController().signal, charge: () => true, ...extra });
  }
  const chain = executor(registerChainVerified, { generation: () => 0 });
  const naming = executor(registerNamingVerified, { generations: { lifecycle: 0 } });
  const chainRead = (address, extra) =>
    chain({
      chain_id: 1,
      generation: 0,
      colibri: 'request',
      method: 'eth_getBalance',
      params: [address, 'latest'],
      deadline_ms: 10_000,
    }, extra);
  const ensLookup = (extra) =>
    naming({
      generations: { lifecycle: 0 },
      colibri: 'resolve',
      name: 'secret.eth',
      call_data: '0x9061b923',
      resolver: 'ur',
      deadline_ms: 10_000,
    }, extra);
  const ensReverse = (extra) =>
    naming({
      generations: { lifecycle: 0 },
      colibri: 'reverse',
      address: CONTRACT,
      coin_type: 60,
      deadline_ms: 10_000,
    }, extra);

  // The private session a request sent from a private window now names, as
  // service-client.js records it.
  const { privateContextSession } = require('../private/private-log-context');
  const openSession = () => runWithPrivateLogContext(true, () => privateContextSession());

  test('a chain-data read the core asks for a private window writes nothing under <userData>', async () => {
    const read = (extra) => chainRead(CONTRACT, extra);
    privateWindows.createPrivateWindow();
    await read({ private: true, privateSession: openSession() });
    // Unknown counts as private, and with no session it is refused.
    await read({});
    expect(filesUnder(mockUserData)).toEqual([]);
    expect(mockLanes.map((lane) => lane.storageDir)).toEqual([null]);
  });

  // Codex review of #1071, finding 2.
  test('a chain-data read the core asks for a private session that has ended starts no worker', async () => {
    const read = (extra) => chainRead(CONTRACT, extra);
    const win = privateWindows.createPrivateWindow();
    const ended = openSession();
    await read({ private: true, privateSession: ended });
    win.emit('closed');
    expect(mockLanes[0].worker.stopped).toBe(true);
    // A new private window opens before the old read's verifier step.
    privateWindows.createPrivateWindow();
    await read({ private: true, privateSession: ended });
    expect(mockLanes).toHaveLength(1);
    expect(filesUnder(mockUserData)).toEqual([]);
    // The new session's own read gets a fresh store, without the old one.
    await read({ private: true, privateSession: openSession() });
    expect(mockLanes.map((lane) => lane.storageDir)).toEqual([null, null]);
  });

  test('a normal window’s reads keep the disk store', async () => {
    await expect(chainRead(CONTRACT, { private: false })).resolves.toEqual({ result: MISS });
    await expect(chainRead(OTHER, { private: false })).resolves.toEqual({ result: MISS });
    await expect(chainRead(CONTRACT, { private: false })).resolves.toEqual({ result: HIT });
    expect(filesUnder(mockUserData)).toEqual([
      path.join('colibri', callKey(CONTRACT)),
      path.join('colibri', callKey(OTHER)),
    ]);
  });

  // #1076: the naming executor, with its real adapters, refuses the old
  // Colibri operations. No worker starts and no store is touched, so no name
  // can come from Colibri, from a private window or a normal one.
  test.each([
    ['an ENS forward lookup', ensLookup],
    ['an ENS reverse lookup', ensReverse],
  ])('%s the core asks for is refused and reaches no Colibri worker', async (_label, lookup) => {
    privateWindows.createPrivateWindow();
    for (const extra of [{ private: true, privateSession: openSession() }, { private: false }, {}]) {
      await expect(Promise.resolve().then(() => lookup(extra))).rejects.toMatchObject({
        code: 'refused',
      });
    }
    expect(mockLanes).toEqual([]);
    expect(filesUnder(mockUserData)).toEqual([]);
  });
});
