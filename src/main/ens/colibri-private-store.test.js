// PRIVATE MODE GUARD (Colibri store, #1058), end to end inside main: the
// real resolver, worker host, worker service and private-window registry,
// with a fake Colibri runtime that keeps a `call_<chain>_<address>` record
// for every contract it is asked about, as Colibri's own store does
// (eth_call_account.c, saved by verify_call.c). Only the thread boundary is
// replaced: each "worker" runs the worker service in this process, on its
// own fake runtime, with the storage the host chose for it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let mockUserData = null;
const mockWindows = [];
const mockLanes = [];

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
  getNetwork: () => ({ zkProof: true }),
  getEndpoints: (_chainId, role) => (role === 'prover' ? ['https://prover.example'] : []),
}));

// The ENS calls the resolver makes through its provider: one eth_call to a
// stand-in Universal Resolver, through ethers' real BrowserProvider.
const mockUniversalResolver = '0x00000000000000000000000000000000000000e5';
jest.mock('../ens-resolver', () => ({
  universalResolverCall: async (provider, _name, callData) => ({
    resolvedData: await provider.call({ to: mockUniversalResolver, data: callData }),
    resolverAddress: mockUniversalResolver,
  }),
  universalResolverReverse: async (provider) => ({
    resolvedData: await provider.call({ to: mockUniversalResolver, data: '0x5d78a217' }),
  }),
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

// node:worker_threads' Worker, run in this process.
jest.mock('node:worker_threads', () => ({
  isMainThread: true,
  parentPort: null,
  threadId: 0,
  workerData: null,
  Worker: jest.fn().mockImplementation((_file, { workerData }) => {
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
const forward = () => resolver.resolveCallViaColibri('secret.eth', '0x9061b923');
const reverse = () => resolver.resolveReverseViaColibri(new Uint8Array(20));

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

describe('Colibri store for private windows (#1058)', () => {
  test('a normal window keeps its reads in <userData>/colibri, as before', async () => {
    await expect(balance(CONTRACT)).resolves.toBe(MISS);
    await expect(forward()).resolves.toMatchObject({ resolvedData: MISS });

    expect(filesUnder(mockUserData)).toEqual([
      path.join('colibri', callKey(CONTRACT)),
      path.join('colibri', callKey(mockUniversalResolver)),
    ]);
    // And they stay warm across reads.
    await expect(balance(CONTRACT)).resolves.toBe(HIT);
  });

  test.each([
    ['a chain-data read', () => balance(CONTRACT)],
    ['an ENS forward lookup', forward],
    ['an ENS reverse lookup', reverse],
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
    await inPrivate(forward);
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
    await expect(inPrivate(forward)).resolves.toMatchObject({ resolvedData: MISS });
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

  // Codex review of #1070, finding 2: ENS asks Myotis before Colibri, so a
  // private lookup can still be waiting when its last window closes.
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
    // The next private window opens before the old lookup resumes.
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


// On this branch every Colibri read is one of the cores' `shell.verified`
// operations, run by main's executors with their real adapters. The core's
// request names no window; the client's `private` (service-client.js
// forPrivate) does, and the executors run the read in that context.
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

  test.each([
    ['a chain-data read', (extra) => chainRead(CONTRACT, extra)],
    ['an ENS lookup', ensLookup],
  ])('%s the core asks for a private window writes nothing under <userData>', async (_label, read) => {
    privateWindows.createPrivateWindow();
    await read({ private: true });
    // Unknown counts as private.
    await read({});
    expect(filesUnder(mockUserData)).toEqual([]);
    expect(mockLanes.map((lane) => lane.storageDir)).toEqual([null]);
  });

  test('a normal window’s reads keep the disk store', async () => {
    await expect(chainRead(CONTRACT, { private: false })).resolves.toEqual({ result: MISS });
    await expect(ensLookup({ private: false })).resolves.toMatchObject({ resolved_data: MISS });
    await expect(chainRead(CONTRACT, { private: false })).resolves.toEqual({ result: HIT });
    expect(filesUnder(mockUserData)).toEqual([
      path.join('colibri', callKey(CONTRACT)),
      path.join('colibri', callKey(mockUniversalResolver)),
    ]);
  });
});
