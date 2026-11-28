/**
 * SWM-7's flip against the real freedom-cored (freedom-core design 0015,
 * SWM-6's and SWM-7's Done-when, D3 and the 2026-11-28 amendment; the
 * SWM-6 to SWM-9 plan's PR 7.4 and section 5): a development build with
 * FREEDOM_SWARM_BACKEND=core, as main runs it, with nothing of the flip's
 * chosen by the test.
 *
 * - **The build's own hello** (core-client.js `storeMovedFor` the latched
 *   backend) names `swarm_stores`, and the pinned core takes it.
 * - **page-swarm.js's default deps** pick page-swarm-core.js's backend:
 *   every window.swarm method but `swarm_unsubscribe` reaches the core as
 *   one `swarm.request`, and the JS provider is never called. Only the UI's
 *   boundaries are the test's (the document, its prompts, custody, the
 *   setup screen); the grants, the stores' clients, main's executor
 *   (core/swarm-shell.js, production's registration), `approval.recheck`
 *   (the EIP-1193 relay's, attached as core-process.js attaches it) and
 *   the subscription registry are main's own.
 * - **A whole window.swarm session**, at least one method of each family,
 *   against a node on loopback that stores what it is sent: connect and
 *   capabilities; a publish (`swarm_publishData`) and its upload status; a
 *   chunk published and read back; a feed created, an entry written to it
 *   and read back (the core signs, the node stores the SOC, the core
 *   verifies it on the read), the feeds listed; messaging (the identity, a
 *   PSS and a GSOC subscription opened by main's registry on what the core
 *   derived, a message delivered to the document, a GSOC send) and an
 *   unsubscribe.
 * - **An `fs` spy over the whole session** (store-handover.js
 *   `watchFileTouches`: every path-taking `fs` call, every form, and every
 *   better-sqlite3 open, from the client's construction to the last
 *   answer): main touches none of the three stores' files
 *   (swarm-feeds.json, swarm-manifest-grants.json, publish-history.sqlite,
 *   their backups, temporary, `-wal` and `-shm` files, and the legacy
 *   publish-history.json), and on Linux holds none open; the core wrote
 *   them (the feed's record, the history's rows).
 * - **The GSOC worker idle:** a spy on `worker_threads.Worker` sees no
 *   worker constructed while the core mined the GSOC subscription's and
 *   send's keys.
 *
 * Skipped without the binary; FREEDOM_CORED_STORES_TEST=1 requires it (npm
 * run core:download), as FREEDOM_CORED_PATH names one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const coreSdk = require('@ethersphere/core-sdk');
const { openFiles, watchFileTouches } = require('../../../test/helpers/store-handover');
const { startFakeHttpNode } = require('../../../test/helpers/fake-http-node');

jest.setTimeout(180_000);

const SRC = path.join(__dirname, '..');
const SRC_PATH = (rel) => path.join(SRC, rel);

/** The pinned freedom-cored, or null (the suite skips). */
function coredBinary() {
  const required = process.env.FREEDOM_CORED_STORES_TEST === '1';
  const binary =
    process.env.FREEDOM_CORED_PATH ||
    (required ? jest.requireActual(SRC_PATH('core/cored-binary.js')).getCoredBinaryPath() : null);
  if (required && (!binary || !fs.existsSync(binary))) {
    throw new Error('FREEDOM_CORED_STORES_TEST=1 needs freedom-cored: run npm run core:download');
  }
  return binary && fs.existsSync(binary) ? binary : null;
}

const BINARY = coredBinary();
const describeIfCore = BINARY ? describe : describe.skip;

const KEY = 'https://app.example';
const PASSWORD = 'swarm-flip-pass-1';
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const SILENT = { info() {}, warn() {}, error() {}, debug() {}, log() {}, verbose() {} };
const shell = { caller: 'shell' };
const GUEST = 1;

/** The three stores' files: each name, its backups, temporary files and SQLite's. */
const STORE_STEMS = ['swarm-feeds', 'swarm-manifest-grants', 'publish-history'];
const isStoreFile = (target) => {
  const base = String(target).split(/[\\/]/).pop();
  return STORE_STEMS.some((stem) => base.startsWith(`${stem}.`)) && !base.endsWith('.js');
};

const BATCH = 'a1'.repeat(32);
const STAMPS = {
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
};
const ADDRESSES = {
  overlay: '36b7efd913ca4cf880b8eeac5093fa27b0825906c600685b6abdd6566e6cfe8f',
  underlay: ['/ip4/127.0.0.1/tcp/1634/p2p/16Uiu2HAm8k3iE4M7kxzxx4K2sKGSgC5Yp4wDS6xLdqyAn6B2Gk5q'],
  ethereum: '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0',
  publicKey: '039fd0991d0222b4e1339c1a1a5b5f6d9f6a96672a3247b638ee6156d9ea877a2f',
  pssPublicKey: '03c22c83fb49ab0ad897aa0c74e51311c95a3d1e1b27b2dedd7f42a7d2538c3a9e',
};
const TAG = 101;

/**
 * A node on loopback that stores what it is sent, as Bee and Ant answer:
 * `/node`, `/stamps`, `/addresses`, a tag, chunks posted and read back
 * (their addresses computed with core-sdk), SOCs posted and read back as
 * the node stores them (identifier, signature, span, payload), a `/bzz`
 * upload and a feed manifest. Each request is kept as `METHOD path`.
 */
async function startStoringNode() {
  const chunks = new Map();
  const calls = [];
  const json = (res, status, body, headers = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      ...headers,
    });
    res.end(text);
  };
  const node = await startFakeHttpNode({
    handler: (req, res) => {
      const parts = [];
      req.on('data', (part) => parts.push(part));
      req.on('end', () => {
        const body = Buffer.concat(parts);
        const url = new URL(req.url, 'http://node');
        const { pathname } = url;
        calls.push(`${req.method} ${pathname}`);
        if (req.method === 'GET' && pathname === '/node') {
          return json(res, 200, { beeMode: 'light', chequebookEnabled: true, swapEnabled: true });
        }
        if (req.method === 'GET' && pathname === '/stamps') return json(res, 200, STAMPS);
        if (req.method === 'GET' && pathname === '/addresses') return json(res, 200, ADDRESSES);
        if (req.method === 'GET' && pathname === `/tags/${TAG}`) {
          return json(res, 200, {
            uid: TAG,
            split: 1,
            seen: 0,
            stored: 1,
            sent: 1,
            synced: 1,
            address: 'ab'.repeat(32),
            startedAt: new Date().toISOString(),
          });
        }
        if (req.method === 'GET' && pathname.startsWith('/chunks/')) {
          const chunk = chunks.get(pathname.slice('/chunks/'.length));
          if (!chunk) return json(res, 404, { code: 404, message: 'Not Found' });
          res.writeHead(200, { 'content-type': 'binary/octet-stream', 'content-length': chunk.length });
          return res.end(chunk);
        }
        if (req.method === 'POST' && pathname === '/chunks') {
          const span = body.subarray(0, 8).readBigUInt64LE(0);
          const address = coreSdk.makeContentAddressedChunk(body.subarray(8), span).address.toHex();
          chunks.set(address, body);
          return json(res, 201, { reference: address }, { 'swarm-tag': '0' });
        }
        if (req.method === 'POST' && pathname.startsWith('/soc/')) {
          const [, , owner, identifier] = pathname.split('/');
          const signature = url.searchParams.get('sig');
          const address = coreSdk
            .makeSOCAddress(new coreSdk.Identifier(identifier), new coreSdk.EthAddress(owner))
            .toHex();
          chunks.set(address, Buffer.concat([Buffer.from(identifier, 'hex'), Buffer.from(signature, 'hex'), body]));
          return json(res, 201, { reference: address });
        }
        if (req.method === 'POST' && pathname === '/bzz') {
          return json(res, 201, { reference: 'b2'.repeat(32) }, { 'swarm-tag': String(TAG) });
        }
        if (req.method === 'POST' && pathname.startsWith('/feeds/')) {
          return json(res, 201, { reference: 'fe'.repeat(32) });
        }
        return json(res, 500, { code: 500, message: `no answer for ${req.method} ${pathname}` });
      });
    },
  });
  return Object.assign(node, { calls, chunks });
}

/** Global WebSocket as a fake that opens at once and records its URL; its sockets in `sockets`. */
function fakeWebSockets() {
  const sockets = [];
  const real = globalThis.WebSocket;
  globalThis.WebSocket = class FakeWebSocket {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      sockets.push(this);
      setImmediate(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.({});
      });
    }

    close() {
      this.readyState = 3;
    }

    addEventListener(type, fn) {
      this[`on${type}`] = fn;
    }

    removeEventListener() {}
  };
  return { sockets, restore: () => (globalThis.WebSocket = real) };
}

describeIfCore("window.swarm on the core's backend, the build's own flip (real freedom-cored)", () => {
  const world = {
    dir: null,
    node: null,
    ipc: new Map(),
    events: [],
    workers: [],
    client: null,
    swarmShell: null,
    sent: [],
    exits: [],
  };
  let watch = null;
  let ws = null;
  let main = null;
  let dispatchers = null;
  let savedBackend;
  let consoleWas = null;

  /** A prompt's answer: approve, picking the site's active identity where it may, else the new one. */
  async function answerPrompt(spec) {
    const { kind, view = {}, choices } = spec;
    let raw = {};
    if (kind === 'swarm.feed') {
      const active = { identity: view.activeIdentityId };
      raw = typeof choices === 'function' && choices(active) ? active : { identity: view.newIdentity.id };
    }
    world.events.push({ prompt: kind });
    const checked = typeof choices === 'function' ? choices(raw) : {};
    if (!checked) throw new Error(`the ${kind} prompt refuses ${JSON.stringify(raw)}`);
    return { approve: true, choices: checked };
  }

  /** The context page-requests.js hands a dispatcher, for one request of the one document. */
  function contextOf(method, params) {
    const requester = Object.freeze({
      guest: GUEST,
      window: 1,
      frame: 1,
      navigation: 1,
      url: `${KEY}/`,
      key: KEY,
      transportKey: KEY,
      topKey: KEY,
    });
    return {
      id: world.sent.length + world.events.length + 1,
      requester,
      provider: 'swarm',
      method,
      params,
      signal: new AbortController().signal,
      isCurrent: () => true,
      nameHolds: async () => true,
      holdsKey: () => true,
      keylessOnceUnheld: () => {},
      prompt: answerPrompt,
      pageContext: () => ({ origin: KEY, top_origin: KEY, frame: 1, navigation: 1, agent: false }),
      afterAnswer: () => {},
      whenAnswered: async () => ({ delivered: true }),
      liveDocuments: () => [requester],
      sendEvent: async (_target, event, data) => {
        world.events.push({ event, data });
        return { ok: true };
      },
      onDocumentEnded: () => () => {},
      copied: () => {},
    };
  }

  /** `method` through main's dispatcher, as page-requests.js calls it; the swarm.requests it sent. */
  async function ask(method, params) {
    const before = world.sent.length;
    const answer = await dispatchers[`swarm:${method}`](contextOf(method, params));
    return { answer, requests: world.sent.slice(before).filter((name) => name === 'swarm.request').length };
  }

  /** Electron as main meets it here: one live guest, a DIRECT route, IPC handlers kept. */
  function electron() {
    const guest = { id: GUEST, isDestroyed: () => false, session: null };
    return {
      ipcMain: {
        handle: (channel, fn) => world.ipc.set(channel, fn),
        on() {},
        removeHandler: (channel) => world.ipc.delete(channel),
      },
      app: {
        getPath: () => world.dir,
        getVersion: () => '0.0.0-jest',
        isPackaged: false,
        on() {},
        whenReady: async () => {},
      },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      BrowserWindow: { getAllWindows: () => [], fromId: () => null, getFocusedWindow: () => null },
      session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
      webContents: { fromId: (id) => (id === GUEST ? guest : null), getAllWebContents: () => [] },
      nativeTheme: {},
      shell: {},
    };
  }

  /** Main's boundaries for a fresh registry, everything Swarm's main's own. */
  function mockBoundaries() {
    const mock = (rel, factory) => jest.doMock(SRC_PATH(rel), factory);
    jest.doMock('electron', () => electron(), { virtual: true });
    jest.doMock('electron-log', () => SILENT);
    // Every worker main would start, kept (the GSOC miner's among them).
    jest.doMock('node:worker_threads', () => {
      const actual = jest.requireActual('node:worker_threads');
      class SpiedWorker extends actual.Worker {
        constructor(file, options) {
          world.workers.push(String(file));
          super(file, options);
        }
      }
      return { ...actual, Worker: SpiedWorker };
    });
    // Each better-sqlite3 open, in the watch.
    jest.doMock('better-sqlite3', () => {
      const Real = jest.requireActual('better-sqlite3');
      return function SpiedDatabase(file, options) {
        watch.record('better-sqlite3', file);
        return new Real(file, options);
      };
    });
    mock('logger.js', () => SILENT);
    mock('service-registry.js', () => ({
      ...jest.requireActual(SRC_PATH('service-registry.js')),
      getAntApiUrl: () => world.node.origin,
      getService: (name) => (name === 'ant' ? { mode: 'bundled' } : null),
      onServiceChange: () => () => {},
    }));
    mock('swarm/publish-setup-service.js', () => ({ getPublishReadiness: async () => ({ ok: true }) }));
    mock('vault-timer.js', () => ({ resetVaultAutoLockTimer: () => world.events.push({ vault_timer_reset: true }) }));
    mock('freedom-root.js', () => ({
      ...jest.requireActual(SRC_PATH('freedom-root.js')),
      getFreedomDataDir: () => world.dir,
      getFreedomDataPath: (name) => path.join(world.dir, name),
    }));
    mock('private/private-windows.js', () => ({
      isPrivateWebContents: () => false,
      getPartitionForWebContents: () => null,
    }));
    mock('swarm/bzz-protocol.js', () => ({
      ...jest.requireActual(SRC_PATH('swarm/bzz-protocol.js')),
      handleBzzRequest: async (request) => {
        world.events.push({ manifest_fetch: request.url });
        return new Response('Not Found', { status: 404 });
      },
    }));
    mock('windows/mainWindow.js', () => ({
      getMainWindows: () => [],
      isMainBrowserWindow: () => false,
      getLastFocusedMainWindow: () => null,
    }));
    mock('ant-manager.js', () => ({ restartingUrl: () => null }));
    mock('core/dweb-verify.js', () => ({ dwebVerifier: () => null }));
    mock('core/naming.js', () => ({ namingDriver: () => null }));
    mock('fs-offload.js', () => ({}));
    mock('profile-paths.js', () => ({
      getIdentityDataDir: () => path.join(world.dir, 'identity'),
      getAntDataDir: () => path.join(world.dir, 'ant'),
      getIpfsDataDir: () => path.join(world.dir, 'ipfs'),
      getRadicleDataDir: () => path.join(world.dir, 'radicle'),
      prepareRadicleDataDir: async () => {},
    }));
    mock('profile-resolver.js', () => ({ getActiveProfile: () => ({ id: 'default' }) }));
    mock('windows/request-window.js', () => ({ forSenderWindow: (fn) => fn }));
    mock('core/node-identity-guard.js', () => ({
      blockNode() {},
      unblockNode() {},
      nodeWriteStatus: () => null,
      restoreNodeWrite() {},
      setStartupRecovery() {},
      setRecoveryUnknown() {},
    }));
    mock('radicle/radicled-gate.js', () => ({ withRadicleGate: (fn) => fn() }));
    mock('radicle/radicle-backend-kind.js', () => ({ radicleBackendKind: () => 'service' }));
    mock('private-files.js', () => ({ withPrivateDir() {} }));
    mock('swarm/ant-keystore-password.js', () => ({}));
    // The core's process is the test's (core-process.js would spawn its own).
    mock('core/core-process.js', () => ({
      getCoreClient: () => world.client,
      getSwarmShell: () => world.swarmShell,
      isCoreRunning: () => Boolean(world.client),
    }));
  }

  beforeAll(async () => {
    world.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-flip-'));
    fs.writeFileSync(path.join(world.dir, 'settings.json'), JSON.stringify({ enableIdentityWallet: true }));
    world.node = await startStoringNode();
    ws = fakeWebSockets();
    // The whole session, from the client's construction on.
    watch = watchFileTouches(isStoreFile, { skip: [__filename] });
    savedBackend = process.env.FREEDOM_SWARM_BACKEND;
    // The stores' own console lines (swarm-permissions.js and
    // permission-manifests.js log there) stay out of the run's output.
    consoleWas = { log: console.log, info: console.info };
    Object.assign(console, { log() {}, info() {} });
    // A development build's switch, read once, as main reads it.
    process.env.FREEDOM_SWARM_BACKEND = 'core';
    jest.resetModules();
    mockBoundaries();

    const { CoreClient } = require(SRC_PATH('core/core-client.js'));
    const client = new CoreClient({
      spawn,
      command: BINARY,
      args: ['serve', '--data-dir', path.join(world.dir, 'identity'), '--lock-dir', path.join(world.dir, 'locks')],
      log: SILENT,
      shellVersion: 'jest',
      grantRoot: world.dir,
      userDataDir: world.dir,
    });
    world.client = client;
    // Each request main sends the core, by its method.
    const request = client.request.bind(client);
    client.request = (method, ...rest) => {
      world.sent.push(method);
      return request(method, ...rest);
    };
    // As core-process.js wires a client before its start.
    require(SRC_PATH('core/grants.js')).attachGrants(client);
    world.swarmShell = require(SRC_PATH('core/swarm-shell.js')).registerSwarmShell(client);
    require(SRC_PATH('page/page-eip1193.js')).attachEip1193(client);
    world.hello = await client.start();
    client.current.child.on('exit', (code, signal) => world.exits.push(code ?? signal));
    await client.request(
      'vault.import',
      { password_b64: b64(PASSWORD), mnemonic_b64: b64(ABANDON), overwrite: false, user_knows_password: true },
      shell
    );

    // As index.js registers them, on either backend.
    const provider = require(SRC_PATH('swarm/swarm-provider-ipc.js'));
    jest.spyOn(provider, 'executeSwarmMethod');
    provider.registerSwarmProviderIpc();
    require(SRC_PATH('swarm/feed-store.js')).registerFeedStoreIpc();
    require(SRC_PATH('swarm/permission-manifests.js')).registerPermissionManifestIpc();
    require(SRC_PATH('swarm/publish-history.js')).registerPublishHistoryIpc();
    const permissions = require(SRC_PATH('swarm/swarm-permissions.js'));
    expect(await permissions.whenLoaded()).toBe(true);
    const guest = { id: GUEST, isDestroyed: () => false };
    // Only the UI's boundaries are the test's: the backend, the grants and
    // the stores are page-swarm.js's own defaults.
    dispatchers = require(SRC_PATH('page/page-swarm.js')).createSwarmDispatchers({
      guestContents: (id) => (id === GUEST ? guest : null),
      inCustody: () => false,
      routeToSetup: (_requester, reason) => world.events.push({ route_to_setup: reason }),
    });
    main = {
      provider,
      backendKind: require(SRC_PATH('swarm/swarm-backend-kind.js')).swarmBackendKind,
      coreClient: require(SRC_PATH('core/core-client.js')),
      stores: require(SRC_PATH('core/swarm-stores.js')),
    };
  });

  afterAll(async () => {
    watch?.restore();
    if (consoleWas) Object.assign(console, consoleWas);
    ws?.restore();
    try {
      require(SRC_PATH('swarm/subscription-registry.js'))._reset?.();
    } catch {
      // Torn down with the registry.
    }
    await world.client?.stop();
    await world.node?.close();
    if (savedBackend === undefined) delete process.env.FREEDOM_SWARM_BACKEND;
    else process.env.FREEDOM_SWARM_BACKEND = savedBackend;
    fs.rmSync(world.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test("the build's hello names swarm_stores on core, and the core takes it", () => {
    expect(main.backendKind()).toBe('core');
    expect(main.coreClient.swarmStoresNamed()).toBe(true);
    const sent = world.client.service.helloParams(world.client).store_moved;
    expect(sent).toEqual([...main.coreClient.STORE_MOVED, 'swarm_stores']);
    expect(world.hello.store_moved).toEqual(sent);
  });

  // The session: each step's answer, and one swarm.request for each method
  // but swarm_unsubscribe.
  const state = {};

  test('connect, and the capabilities', async () => {
    const access = await ask('swarm_requestAccess', undefined);
    expect(access.answer).toEqual({ result: { connected: true, origin: KEY, capabilities: expect.any(Array) } });
    expect(access.requests).toBe(1);
    expect(world.events).toContainEqual({ prompt: 'swarm.connect' });
    const capabilities = await ask('swarm_getCapabilities', undefined);
    expect(capabilities.answer.result).toMatchObject({ specVersion: '1.0', canPublish: true, reason: null });
    expect(capabilities.requests).toBe(1);
  });

  test('publishes, and an upload status', async () => {
    const published = await ask('swarm_publishData', {
      data: 'hello swarm',
      contentType: 'text/plain',
      name: 'hello.txt',
    });
    expect(published.answer).toEqual({
      result: { reference: 'b2'.repeat(32), bzzUrl: `bzz://${'b2'.repeat(32)}` },
    });
    expect(published.requests).toBe(1);
    const files = await ask('swarm_publishFiles', {
      files: [{ path: 'notes/a.txt', bytes: new TextEncoder().encode('a note') }],
    });
    expect(files.answer).toEqual({
      result: { reference: 'b2'.repeat(32), bzzUrl: `bzz://${'b2'.repeat(32)}`, tagUid: TAG },
    });
    expect(files.requests).toBe(1);
    expect(world.node.calls.filter((call) => call === 'POST /bzz')).toHaveLength(2);
    const status = await ask('swarm_getUploadStatus', { tagUid: TAG });
    expect(status.answer.result).toMatchObject({ tagUid: TAG, split: 1, synced: 1, done: true });
    expect(status.requests).toBe(1);
  });

  test('a chunk published, then read back', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const published = await ask('swarm_publishChunk', { data });
    const reference = coreSdk.makeContentAddressedChunk(data).address.toHex();
    expect(published.answer).toEqual({ result: { reference } });
    const read = await ask('swarm_readChunk', { reference });
    expect(read.answer).toEqual({ result: { data: Buffer.from(data).toString('base64'), encoding: 'base64', span: 5 } });
    expect(published.requests + read.requests).toBe(2);
  });

  test('a feed created, an entry written to it and read back, the feeds listed', async () => {
    const created = await ask('swarm_createFeed', { name: 'blog' });
    expect(created.answer.result).toMatchObject({ feedId: 'blog', manifestReference: 'fe'.repeat(32) });
    expect(created.requests).toBe(1);
    state.feed = created.answer.result;
    const written = await ask('swarm_writeFeedEntry', { name: 'blog', data: 'first entry', index: 0 });
    expect(written.answer).toEqual({ result: { index: 0 } });
    expect(written.requests).toBe(1);
    expect(world.node.calls.filter((call) => call.startsWith('POST /soc/'))).toHaveLength(1);
    const read = await ask('swarm_readFeedEntry', { name: 'blog', index: 0 });
    expect(read.answer.result).toMatchObject({ encoding: 'base64', index: 0, nextIndex: 1 });
    expect(Buffer.from(read.answer.result.data, 'base64').toString('utf8')).toBe('first entry');
    expect(read.requests).toBe(1);
    const listed = await ask('swarm_listFeeds', undefined);
    expect(listed.answer.result).toEqual([
      expect.objectContaining({ name: 'blog', topic: state.feed.topic, owner: state.feed.owner }),
    ]);
    expect(listed.requests).toBe(1);
  });

  test('messaging: the identity, a PSS and a GSOC subscription, a delivery, a GSOC send, an unsubscribe', async () => {
    const identity = await ask('swarm_getMessagingIdentity', undefined);
    expect(identity.answer).toEqual({
      result: { pssPublicKey: ADDRESSES.pssPublicKey, pssTarget: ADDRESSES.overlay.slice(0, 4), identityMode: 'bee-wallet' },
    });
    const pss = await ask('swarm_subscribe', { kind: 'pss', topic: 'chat' });
    expect(pss.answer.result).toMatchObject({ kind: 'pss', subscriptionId: expect.any(String) });
    const gsoc = await ask('swarm_subscribe', { kind: 'gsoc', topic: 'chat' });
    expect(gsoc.answer.result).toMatchObject({ kind: 'gsoc', subscriptionId: expect.any(String) });
    // Main's registry opened each socket, on the key the core derived.
    expect(ws.sockets.map((socket) => new URL(socket.url).pathname)).toEqual([
      `/pss/subscribe/${pss.answer.result.key}`,
      `/gsoc/subscribe/${gsoc.answer.result.key}`,
    ]);
    // A message the node sends reaches the document.
    ws.sockets[0].onmessage?.({ data: new TextEncoder().encode('hi there').buffer });
    for (let i = 0; i < 100 && !world.events.some((e) => e.event === 'message'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(world.events.filter((e) => e.event === 'message')).toEqual([
      {
        event: 'message',
        data: {
          type: 'swarm_subscription',
          subscription: pss.answer.result.subscriptionId,
          result: {
            kind: 'pss',
            key: pss.answer.result.key,
            data: b64('hi there'),
            encoding: 'base64',
            receivedAt: expect.any(Number),
          },
        },
      },
    ]);
    const sent = await ask('swarm_sendGsoc', { topic: 'chat', data: 'hello room' });
    expect(sent.answer).toEqual({ result: { sent: true, address: gsoc.answer.result.key } });
    expect(identity.requests + pss.requests + gsoc.requests + sent.requests).toBe(4);
    const unsubscribed = await ask('swarm_unsubscribe', { subscriptionId: pss.answer.result.subscriptionId });
    expect(unsubscribed.answer).toEqual({ result: { unsubscribed: true } });
    // Main's own: it never reaches the core.
    expect(unsubscribed.requests).toBe(0);
    expect(ws.sockets[0].readyState).toBe(3);
  });

  test('the JS provider was never called, and the core never restarted', () => {
    expect(main.provider.executeSwarmMethod).not.toHaveBeenCalled();
    expect(world.exits).toEqual([]);
    expect(world.events.filter((e) => e.route_to_setup)).toEqual([]);
  });

  test("the GSOC worker stayed idle: no worker was started while the core mined", () => {
    expect(world.workers).toEqual([]);
  });

  test("main touched none of the stores' files over the whole session, and holds none open", async () => {
    expect(watch.mainTouches().map(({ name, path: file }) => [name, file])).toEqual([]);
    const held = openFiles(process.pid);
    if (held) expect(held.filter(isStoreFile)).toEqual([]);
    // The core wrote them: the feed's record and the history's rows.
    const feeds = JSON.parse(fs.readFileSync(path.join(world.dir, 'swarm-feeds.json'), 'utf8'));
    expect(feeds.origins[KEY].feeds.blog).toMatchObject({ topic: state.feed.topic, owner: state.feed.owner });
    const rows = await main.stores.history('list', {});
    expect(rows.map(({ type, name, status, origin }) => ({ type, name, status, origin }))).toEqual(
      expect.arrayContaining([
        { type: 'data', name: 'hello.txt', status: 'completed', origin: KEY },
        { type: 'feed-entry', name: 'blog', status: 'completed', origin: KEY },
      ])
    );
    expect(fs.existsSync(path.join(world.dir, 'publish-history.sqlite'))).toBe(true);
  });
});
