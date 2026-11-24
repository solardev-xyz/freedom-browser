// PRIVATE MODE GUARD (Colibri store, #1058), end to end inside main: the
// real resolver and private-window registry over the real freedom-colibrid
// (test/helpers/colibri-service-harness.js, freedom-core design 0014). With
// no proof to be had (a scripted prover that is down), what a private
// session must not leave behind is anything at all under <userData>: no file
// and no directory. Its processes end with it, and a read for an ended session
// starts none. Colibri's store names every contract a read touched
// (`call_<chain>_<address>`), so a private window's reads run on a process
// whose store is in memory only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let mockUserData = null;
const mockWindows = [];
// The prover the registry names.
let mockProverUrl = 'https://prover.example';

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

const resolver = require('./colibri-resolver');
const privateWindows = require('../private/private-windows');
const { runWithPrivateLogContext } = require('../private/private-log-context');
const {
  describeService,
  outcomeOf,
  proverWorld,
  startService,
} = require('../../../test/helpers/colibri-service-harness');

const inPrivate = (fn) => runWithPrivateLogContext(true, fn);
const CONTRACT = '0x00000000000000000000000000000000000000c1';
const OTHER = '0x00000000000000000000000000000000000000c2';

const balance = (address) => resolver.requestViaColibri(1, 'eth_getBalance', [address, 'latest']);
const code = (address) => resolver.requestViaColibri(1, 'eth_getCode', [address, 'latest']);

beforeEach(() => {
  mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-colibri-private-'));
  mockWindows.length = 0;
  resolver.clearColibriClientForTest();
  privateWindows._resetState();
  privateWindows.setPrivateSessionConfigurator(() => {});
  resolver.registerColibriPrivateCleanup(privateWindows);
});

afterEach(() => {
  resolver.clearColibriClientForTest();
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

// Every file and directory under <userData>, as paths relative to it.
function entriesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).sort();
}

describeService('a private session (#1058)', () => {
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
  const lanes = () => started.spawned.map((proc) => (proc.private ? 'private' : 'normal'));

  beforeEach(async () => {
    world = await proverWorld();
    mockProverUrl = world.url;
    started = await startService({ userData: mockUserData });
  });

  afterEach(async () => {
    world.release();
    resolver.clearColibriClientForTest();
    await started.close();
    await world.close();
    mockProverUrl = 'https://prover.example';
  });

  test("a normal window's reads keep the chain's store under <userData>/colibri/<chain> [deviation storage-per-chain]", async () => {
    await expect(balance(CONTRACT).catch(outcomeOf)).resolves.toEqual(failed(CONTRACT));
    expect(lanes()).toEqual(['normal']);
    expect(entriesUnder(mockUserData)).toEqual(['colibri', path.join('colibri', '1')]);
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

    // #1076: the naming executor, with its real adapters, refuses the old
    // Colibri operations. No process starts and no store is touched, so no
    // name can come from Colibri, from a private window or a normal one.
    test.each([
      [
        'an ENS forward lookup',
        { colibri: 'resolve', name: 'secret.eth', call_data: '0x9061b923', resolver: 'ur' },
      ],
      ['an ENS reverse lookup', { colibri: 'reverse', address: CONTRACT, coin_type: 60 }],
    ])('%s the core asks for is refused and reaches no Colibri process', async (_label, lookup) => {
      const { registerNamingVerified } = require('../core/naming-verified');
      const naming = [];
      registerNamingVerified({ hello: null, handle: (_method, fn) => naming.push(fn) }, {
        generations: { lifecycle: 0 },
      });
      privateWindows.createPrivateWindow();
      for (const extra of [
        { private: true, privateSession: openSession() },
        { private: false },
        {},
      ]) {
        await expect(
          Promise.resolve().then(() =>
            naming[0](
              { generations: { lifecycle: 0 }, ...lookup, deadline_ms: 10_000 },
              { signal: new AbortController().signal, charge: () => true, ...extra }
            )
          )
        ).rejects.toMatchObject({ code: 'refused' });
      }
      expect(started.spawned).toEqual([]);
      expect(entriesUnder(mockUserData)).toEqual([]);
    });
  });
});
