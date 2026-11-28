/**
 * window.swarm against the bundled antd, on the core's backend (freedom-core
 * design 0015, SWM-7's Done-when: "e2e on three OSes against the bundled
 * node"; the SWM-6 to SWM-9 plan's PR 7.7): a development build with
 * FREEDOM_SWARM_BACKEND=core, as main runs it after the flip (PR 7.4), the
 * pinned freedom-cored behind it, and the antd `npm run ant:download`
 * fetched in front, offline (test/helpers/antd-node.js). Each page request
 * goes through main's page-requests (its documents, tickets and answers),
 * main's page dispatcher with its default deps (the grants, the stores'
 * clients, page-swarm-core.js), the core, and main's executor, to the node
 * through a loopback tap that reads each request as it crosses.
 *
 * antd runs with a postage batch it reads from a loopback chain and no
 * peers, so it stamps and assembles what it is sent (it logs each `/bzz`
 * upload's manifest root) and then fails the push, 502. It serves a single
 * chunk from its cache, and nothing that needs a peer. A light node, it
 * can't keep an upload offline, and it peers only with full Bee nodes, so
 * no second antd can keep one for it: the upload that has to succeed and
 * stay goes to `bee dev` (Bee v2.8.0's dev mode, `npm run bee-dev:download`;
 * test/helpers/bee-dev-node.js), one offline process with a real local
 * store, behind a tap of its own.
 *
 * - **A nested `publishFiles`** gives the reference the JS backend gives for
 *   the same files: the JS backend's run (bee-js, the reference) first, then
 *   the core's, the same files under nested paths with an index document.
 *   - **Offline, against antd:** antd assembles the same manifest root from
 *     both tars, and it is the root of a manifest naming exactly the page's
 *     nested paths (antd's own writer, `collectionManifest`). With the
 *     chunks the push would have stored put in antd's cache, every nested
 *     file resolves through the node: its manifest walked with core-sdk's
 *     mantaray reader over window.swarm's `readChunk` through the core,
 *     each file's bytes and metadata as antd stores them.
 *   - **To a node that keeps it (bee dev):** each backend's page call
 *     succeeds, and window.swarm on the core answers the reference the JS
 *     backend's call got (the root antd assembled from both tars). From
 *     that uploaded root every nested path resolves with the chunks the
 *     node stored, nothing seeded (only the two uploads ever wrote to it):
 *     the manifest walked over window.swarm's `readChunk` through the core
 *     (each file's `Content-Type` and `Filename`, its bytes by `readChunk`
 *     and by `readData`, the index document at `/`, a missing path
 *     refused), and the node's own `/bzz/<root>/<path>` (each file's bytes,
 *     `Content-Type` and filename, `index.html` at the root, 404 for a
 *     missing path).
 * - **A feed read past the read window** is refused before its body is
 *   held: a site with no grant (512 KiB a minute) reads a 4096-byte entry,
 *   then a wrapped entry of 524288 bytes: its SOC read, then refused
 *   `rate_limited` (the vectors' `read-feed-index-reserve-refused`), and no
 *   `GET /bytes` reaches the node.
 * - **F-4's case** (`write-feed-10mib+1`, deviation `feed-entry-bound`): a
 *   feed entry of 10 MiB and one byte is refused with nothing sent to the
 *   node. From a page, page-requests refuses it as it arrives (the method's
 *   size is 1 MiB), so nothing reaches the core either; at main's
 *   dispatcher, as the vectors' case runs (PR 7.6's contract), the core
 *   answers `payload_too_large` with its limit and the actual size.
 * - **A navigation mid-upload stops it:** a 48 MiB `publishFiles` held at
 *   the tap after 1 MiB of its body; the document navigates; once the core's
 *   request has ended the tap lets the body go: the client ends the
 *   connection with the body never whole, the node never takes it (no
 *   manifest assembled; at most its 400 for a body cut short), and what
 *   still arrives is only what was already in flight.
 * - **Subscriptions (question 4, PR 7.3) against antd:** a remote node
 *   behind a proxy, 4900 `proxy-or-tor` and no socket (a spy on the
 *   `WebSocket` constructor, and the tap sees no upgrade) and no dial; a
 *   proxy turned on between the ready check and the open, refused just
 *   before it with no socket; a live subscription to the remote node ended,
 *   without a reconnect, once a proxy comes on; and a loopback node still
 *   subscribes with a proxy on. A remote node is antd behind a name that
 *   isn't loopback: main's remote dials and the sockets are aliased to it.
 *
 * Gated: runs only with SWARM_CORE_NODE_E2E=1, which then requires antd
 * (ant-bin/<os>-<arch>/antd, `npm run ant:download`), bee dev
 * (bee-dev-bin/<os>-<arch>/bee, `npm run bee-dev:download`) and
 * freedom-cored (`npm run core:download`, or FREEDOM_CORED_PATH): any of
 * them missing fails the suite, never skips it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const coreSdk = require('@ethersphere/core-sdk');
const { Wallet } = require('ethers');
const {
  ANTD,
  collectionManifest,
  contentTypeOf,
  feedEntry,
  seedChunks,
  sleep,
  startAntd,
  startFakeGnosis,
  startTap,
} = require('../../../test/helpers/antd-node');
const { BEE_DEV, startBeeDev } = require('../../../test/helpers/bee-dev-node');

const RUN = process.env.SWARM_CORE_NODE_E2E === '1';
const SRC = path.join(__dirname, '..');
const SRC_PATH = (rel) => path.join(SRC, rel);

/** The pinned freedom-cored, required with SWARM_CORE_NODE_E2E=1. */
function coredBinary() {
  const binary =
    process.env.FREEDOM_CORED_PATH ||
    require(SRC_PATH('core/cored-binary.js')).getCoredBinaryPath();
  if (!binary || !fs.existsSync(binary)) {
    throw new Error(
      `SWARM_CORE_NODE_E2E=1 needs freedom-cored (${binary || 'none'}): run npm run core:download`
    );
  }
  return binary;
}

if (RUN && !fs.existsSync(ANTD)) {
  throw new Error(`SWARM_CORE_NODE_E2E=1 needs antd at ${ANTD}: run npm run ant:download`);
}
if (RUN && !fs.existsSync(BEE_DEV)) {
  throw new Error(
    `SWARM_CORE_NODE_E2E=1 needs bee dev at ${BEE_DEV}: run npm run bee-dev:download`
  );
}
const BINARY = RUN ? coredBinary() : null;
const describeIfNode = RUN
  ? describe
  : (name, fn) => describe.skip(`${name} (skipped: SWARM_CORE_NODE_E2E is not 1)`, fn);

// Node and core starts, and a 48 MiB upload.
jest.setTimeout(180_000);

const KIB = 1024;
const MIB = 1024 * KIB;
const CHROME_URL = 'file:///app/src/renderer/index.html';
const APP = 'https://app.example';
const READER = 'https://reader.example';
const PASSWORD = 'swarm-node-e2e-pass-1';
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const shell = { caller: 'shell' };
const SILENT = { info() {}, warn() {}, error() {}, debug() {}, log() {}, verbose() {} };

// The batch antd stamps with, owned by this key on the loopback chain.
const BATCH = 'c3'.repeat(32);
const POSTAGE_KEY = '11'.repeat(32);
// Arti's SOCKS endpoint, and a proxy the session turns on.
const ARTI = '127.0.0.1:19150';
const PROXY = 'PROXY 127.0.0.1:8118';
const PROXY_OR_TOR = {
  code: 4900,
  message: 'Node not available: proxy-or-tor',
  data: { reason: 'proxy-or-tor' },
};

// The nested files: each of at most one chunk, under nested paths.
const NESTED = [
  ['index.html', '<!doctype html><h1>Freedom on Swarm</h1>'],
  ['assets/app.js', 'console.log("nested");'],
  ['assets/css/site.css', 'body { color: #222; }'],
  ['assets/img/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
  ['docs/guide/intro.txt', 'three levels down & <still> here'],
].map(([filePath, text]) => ({ path: filePath, bytes: new TextEncoder().encode(text) }));
const INDEX = 'index.html';

// A feed no site of this run owns: entries signed by a test key.
const FEED_KEY = '22'.repeat(32);
const FEED_TOPIC = Buffer.from(coreSdk.keccak256(Buffer.from('swarm-node-e2e/window'))).toString(
  'hex'
);
// F-4's feed: the vectors' `write-feed-10mib+1` store (the site's `blog`
// feed on its Bee wallet identity).
const BLOG_TOPIC = Buffer.from(coreSdk.keccak256(Buffer.from(`${APP}/blog`))).toString('hex');

/** The grants file the core loads: APP connected, its rules on, messaging granted. */
function grantsFile(now) {
  return {
    [APP]: {
      origin: APP,
      connectedAt: now - 60_000,
      lastUsed: now - 60_000,
      autoApprove: { publish: true, feeds: true, signing: false, messaging: true },
      messaging: { grantedAt: now - 60_000 },
    },
  };
}

/** The feed store F-4's case starts from: APP's `blog` feed on its Bee wallet identity. */
function feedsFile(now, owner) {
  return {
    version: 2,
    nextPublisherKeyIndex: 0,
    origins: {
      [APP]: {
        activeIdentityId: 'bee-wallet',
        identities: {
          'bee-wallet': {
            id: 'bee-wallet',
            mode: 'bee-wallet',
            publisherKeyIndex: null,
            walletIndex: null,
            label: 'Bee wallet identity',
            createdAt: now - 50_000,
            lastUsedAt: null,
          },
        },
        feedGranted: true,
        grantedAt: now - 50_000,
        feeds: {
          blog: {
            topic: BLOG_TOPIC,
            owner,
            manifestReference: 'cd'.repeat(32),
            identityId: 'bee-wallet',
            createdAt: now - 40_000,
            lastUpdated: null,
            lastReference: null,
          },
        },
      },
    },
  };
}

let nextGuest = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');

/** A tab's guest, as page-documents tracks one (page-swarm-core.test.js's). */
class Guest extends EventEmitter {
  constructor(world) {
    super();
    this.id = nextGuest++;
    this.window = 1;
    this.world = world;
    this.hostWebContents = { id: 501, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
    this.destroyed = false;
    this.mainFrame = this.frame('about:blank');
  }

  frame(url) {
    return {
      url,
      frameTreeNodeId: 1000 + this.id,
      processId: 1,
      routingId: this.id,
      detached: false,
      send: (_channel, message) =>
        this.world.events.push({ guest: this.id, event: message.event, data: message.data }),
    };
  }

  isDestroyed() {
    return this.destroyed;
  }

  getType() {
    return 'webview';
  }

  getURL() {
    return this.mainFrame.url;
  }

  commit(url) {
    this.mainFrame.detached = true;
    this.mainFrame = this.frame(url);
    this.emit('did-frame-navigate', {}, url, 200, 'OK', true, 1, this.mainFrame.routingId);
  }
}

const eventFrom = (guest) => ({ sender: guest, senderFrame: guest.mainFrame });

/** Polls `check` until it holds, or fails naming `what`. */
async function until(check, what, ms = 20_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describeIfNode('window.swarm on the core against the bundled antd (SWARM_CORE_NODE_E2E=1)', () => {
  const shared = { gnosis: null, node: null, tap: null, nodeDir: null, bee: null, beeTap: null };
  // The manifest root antd assembled from each backend's nested tar.
  const roots = {};
  // The reference each backend's nested publishFiles got from bee dev.
  const refs = {};

  beforeAll(async () => {
    shared.gnosis = await startFakeGnosis({ owner: new Wallet(`0x${POSTAGE_KEY}`).address });
    shared.nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-node-e2e-antd-'));
    shared.node = await startAntd({
      dir: shared.nodeDir,
      postage: { batch: BATCH, ownerKey: POSTAGE_KEY, rpcUrl: shared.gnosis.url },
    });
    shared.tap = await startTap(shared.node.port);
    shared.bee = await startBeeDev();
    shared.beeTap = await startTap(shared.bee.port);
  });

  afterAll(async () => {
    await shared.tap?.close();
    await shared.node?.stop();
    await shared.gnosis?.close();
    await shared.beeTap?.close();
    await shared.bee?.stop();
    if (shared.nodeDir)
      fs.rmSync(shared.nodeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /**
   * Main on `backend` (`js` or `core`), as a development build runs it:
   * the switch read once, the build's own hello, a real freedom-cored with
   * the vault imported, main's modules fresh and its boundaries scripted
   * (Electron, the service registry, the session's proxy, the setup
   * screen), page-requests over page-swarm.js's default dispatchers.
   */
  async function loadWorld(backend) {
    const now = Date.now();
    const world = {
      backend,
      dir: fs.mkdtempSync(path.join(os.tmpdir(), `swarm-node-e2e-${backend}-`)),
      nodeUrl: shared.tap.url,
      nodeKind: 'bundled',
      tor: false,
      // The session's proxy for a URL: a function of the URL and how many
      // times it was asked.
      proxy: () => 'DIRECT',
      proxyAsked: [],
      // A remote name main's dials and sockets reach the tap under.
      alias: null,
      guests: new Map(),
      events: [],
      prompts: [],
      setup: [],
      serviceListeners: [],
      sockets: [],
      // Main's dials of a remote node (the session's stack), by URL.
      remoteDials: [],
      client: null,
      swarmShell: null,
      exits: [],
    };
    const log = SILENT;
    fs.writeFileSync(
      path.join(world.dir, 'settings.json'),
      JSON.stringify({ enableIdentityWallet: true })
    );
    fs.writeFileSync(
      path.join(world.dir, 'swarm-permissions.json'),
      JSON.stringify(grantsFile(now), null, 2)
    );
    // The main wallet of the vault imported below (keys.json's `bee`).
    const beeOwner = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';
    fs.writeFileSync(
      path.join(world.dir, 'swarm-feeds.json'),
      JSON.stringify(feedsFile(now, beeOwner), null, 2)
    );

    // Every subscription socket, aliased as main's dials are.
    const RealWebSocket = globalThis.WebSocket;
    world.restoreWebSocket = () => {
      globalThis.WebSocket = RealWebSocket;
    };
    globalThis.WebSocket = class SpiedWebSocket extends RealWebSocket {
      constructor(url, ...rest) {
        const asked = String(url);
        let to = asked;
        if (world.alias) {
          const from = world.alias.from.replace(/^http/, 'ws');
          if (asked.startsWith(`${from}/`))
            to = world.alias.to.replace(/^http/, 'ws') + asked.slice(from.length);
        }
        super(to, ...rest);
        world.sockets.push({ url: asked, socket: this });
      }
    };

    // The stores' own console lines (swarm-permissions.js and
    // permission-manifests.js log there) stay out of the run's output.
    const consoleWas = { log: console.log, info: console.info };
    Object.assign(console, { log() {}, info() {} });
    process.env.FREEDOM_SWARM_BACKEND = backend;
    jest.resetModules();
    const mock = (rel, factory) => jest.doMock(SRC_PATH(rel), factory);
    jest.doMock(
      'electron',
      () => ({
        ipcMain: { handle() {}, on() {}, removeHandler() {} },
        app: {
          getPath: () => world.dir,
          getVersion: () => '0.0.0-jest',
          isPackaged: false,
          on() {},
          whenReady: async () => {},
        },
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        BrowserWindow: {
          getAllWindows: () => [],
          fromId: () => null,
          getFocusedWindow: () => null,
        },
        session: {
          defaultSession: {
            resolveProxy: async (url) => {
              world.proxyAsked.push(url);
              return world.proxy(url, world.proxyAsked.length);
            },
          },
        },
        webContents: { fromId: (id) => world.guests.get(id) || null, getAllWebContents: () => [] },
        nativeTheme: {},
        shell: {},
      }),
      { virtual: true }
    );
    jest.doMock('electron-log', () => log);
    mock('logger.js', () => log);
    mock('service-registry.js', () => ({
      ...jest.requireActual(SRC_PATH('service-registry.js')),
      getAntApiUrl: () => world.nodeUrl,
      getService: (name) => {
        if (name === 'ant') return { mode: world.nodeKind };
        if (name === 'tor') return world.tor ? { socks: ARTI } : null;
        return null;
      },
      onServiceChange: (fn) => {
        world.serviceListeners.push(fn);
        return () => {};
      },
    }));
    mock('swarm/publish-setup-service.js', () => ({
      getPublishReadiness: async () => ({ ok: true }),
    }));
    mock('vault-timer.js', () => ({ resetVaultAutoLockTimer: () => {} }));
    mock('freedom-root.js', () => ({
      ...jest.requireActual(SRC_PATH('freedom-root.js')),
      getFreedomDataDir: () => world.dir,
      getFreedomDataPath: (name) => path.join(world.dir, name),
    }));
    mock('private/private-windows.js', () => ({
      isPrivateWebContents: () => false,
      getPartitionForWebContents: () => null,
    }));
    // A site's freedom-manifest.json: none (the node's 404).
    mock('swarm/bzz-protocol.js', () => ({
      ...jest.requireActual(SRC_PATH('swarm/bzz-protocol.js')),
      handleBzzRequest: async () => new Response('Not Found', { status: 404 }),
    }));
    // Main's reads of a remote node go on the session's stack: here, to
    // the tap the remote name aliases.
    mock('ipfs/gateway-transport.js', () => ({
      ...jest.requireActual(SRC_PATH('ipfs/gateway-transport.js')),
      netGatewayFetch: (url, init) => {
        world.remoteDials.push(url);
        const to =
          world.alias && url.startsWith(`${world.alias.from}/`)
            ? world.alias.to + url.slice(world.alias.from.length)
            : url;
        return globalThis.fetch(to, init);
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
    mock('core/core-process.js', () => ({
      getCoreClient: () => world.client,
      getSwarmShell: () => world.swarmShell,
      isCoreRunning: () => Boolean(world.client),
    }));

    const { CoreClient } = require(SRC_PATH('core/core-client.js'));
    const client = new CoreClient({
      spawn,
      command: BINARY,
      args: [
        'serve',
        '--data-dir',
        path.join(world.dir, 'identity'),
        '--lock-dir',
        path.join(world.dir, 'locks'),
      ],
      log: SILENT,
      shellVersion: 'jest',
      grantRoot: world.dir,
      userDataDir: world.dir,
    });
    world.client = client;
    // Each request main sends the core, by its method.
    world.sent = [];
    const send = client.request.bind(client);
    client.request = (method, ...rest) => {
      world.sent.push(method);
      return send(method, ...rest);
    };
    // As core-process.js wires a client before its start.
    require(SRC_PATH('core/grants.js')).attachGrants(client);
    world.swarmShell = require(SRC_PATH('core/swarm-shell.js')).registerSwarmShell(client);
    require(SRC_PATH('page/page-eip1193.js')).attachEip1193(client);
    world.hello = await client.start();
    client.current.child.on('exit', (code, signal) => world.exits.push(code ?? signal));
    await client.request(
      'vault.import',
      {
        password_b64: b64(PASSWORD),
        mnemonic_b64: b64(ABANDON),
        overwrite: false,
        user_knows_password: true,
      },
      shell
    );
    // As index.js registers them, on either backend.
    require(SRC_PATH('swarm/swarm-provider-ipc.js')).registerSwarmProviderIpc();
    require(SRC_PATH('swarm/feed-store.js')).registerFeedStoreIpc();
    require(SRC_PATH('swarm/permission-manifests.js')).registerPermissionManifestIpc();
    require(SRC_PATH('swarm/publish-history.js')).registerPublishHistoryIpc();
    expect(await require(SRC_PATH('swarm/swarm-permissions.js')).whenLoaded()).toBe(true);
    world.registry = require(SRC_PATH('swarm/subscription-registry.js'));
    world.backendKind = require(SRC_PATH('swarm/swarm-backend-kind.js')).swarmBackendKind;
    world.coreClient = require(SRC_PATH('core/core-client.js'));
    world.stores = require(SRC_PATH('core/swarm-stores.js'));

    // page-requests over page-swarm.js's default dispatchers: only the
    // UI's boundaries are the test's.
    const { createPageDocuments } = require(SRC_PATH('page/page-documents.js'));
    const { createPageRequests, GONE } = require(SRC_PATH('page/page-requests.js'));
    const { createSwarmDispatchers } = require(SRC_PATH('page/page-swarm.js'));
    world.GONE = GONE;
    const documents = createPageDocuments({
      isPrivateWebContents: () => false,
      isChromeIndexUrl: (url) => url === CHROME_URL,
      isAgentPage: () => false,
      windowIdOf: (contents) => contents.window,
      resolveEnsContent: async () => ({ type: 'not_found' }),
    });
    const dispatchers = createSwarmDispatchers({
      guestContents: (id) => world.guests.get(id) || null,
      inCustody: () => false,
      routeToSetup: (_requester, reason) => world.setup.push(reason),
    });
    const requests = createPageRequests({
      documents,
      webContentsFromId: (id) => world.guests.get(id) || null,
      dispatchers,
      chromeWindowOf: (contents) => (contents?.id >= 500 ? contents.id - 500 : null),
      // No prompt is expected: the site's rules answer for it.
      sendToWindow: (_windowId, channel, payload) => {
        if (channel === 'page:prompt') world.prompts.push(payload);
      },
      watchWindow: () => {},
      isAgentGuest: () => false,
    });
    world.requests = requests;

    /** A tab with a document of `key`, greeted. */
    world.tab = (key) => {
      const guest = new Guest(world);
      world.guests.set(guest.id, guest);
      requests.track(guest);
      guest.commit(`${key}/`);
      const n = nonce();
      const greeted = requests.hello(eventFrom(guest), { nonce: n });
      if (!greeted.ok) throw new Error(`the tab's hello failed: ${JSON.stringify(greeted)}`);
      requests.foreground({ sender: { id: 501 } }, { guest: guest.id });
      const requester = Object.freeze({
        guest: guest.id,
        window: 1,
        frame: guest.mainFrame.frameTreeNodeId,
        navigation: greeted.navigation,
        url: `${key}/`,
        key,
        transportKey: key,
        topKey: key,
      });
      return {
        guest,
        /**
         * `method` at main's page dispatcher itself, past page-requests'
         * walk and tickets, as window.swarm's contract plays a vectors case
         * (test/helpers/swarm-contract-backends.js on PR 7.6).
         */
        dispatch: (method, params) =>
          dispatchers[`swarm:${method}`]({
            id: nextNonce++,
            requester,
            provider: 'swarm',
            method,
            params,
            signal: new AbortController().signal,
            isCurrent: () => true,
            nameHolds: async () => true,
            holdsKey: () => true,
            keylessOnceUnheld: () => {},
            prompt: async (spec) => {
              world.prompts.push(spec);
              return { approve: false, choices: {} };
            },
            pageContext: () => ({
              origin: key,
              top_origin: key,
              frame: requester.frame,
              navigation: requester.navigation,
              agent: false,
            }),
            afterAnswer: () => {},
            whenAnswered: async () => ({ delivered: true }),
            liveDocuments: () => [requester],
            sendEvent: async () => ({ ok: true }),
            onDocumentEnded: () => () => {},
            copied: () => {},
          }),
        ask: (method, params, ticket) =>
          requests.request(eventFrom(guest), {
            nonce: n,
            provider: 'swarm',
            method,
            params,
            ...(ticket ? { ticket } : {}),
          }),
        reserve: (method, bytes) => requests.reserve(eventFrom(guest), { nonce: n, method, bytes }),
        navigate: (url) => guest.commit(url),
      };
    };

    world.close = async () => {
      try {
        world.registry._reset?.();
        // The JS backend's publish history holds its database open, which
        // Windows won't let the directory's removal past.
        require(SRC_PATH('swarm/publish-history.js')).closeDb();
      } finally {
        Object.assign(console, consoleWas);
        world.restoreWebSocket();
        await world.client?.stop();
        delete process.env.FREEDOM_SWARM_BACKEND;
        fs.rmSync(world.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    };
    return world;
  }

  /** What crossed the tap from request `from` on. */
  const crossedSince = (from) => shared.tap.requests.slice(from);
  const line = (request) => `${request.method} ${request.target.split('?')[0]}`;

  /** The manifest roots antd logged since `from`, once `count` have come. */
  async function newRoots(from, count = 1) {
    await until(() => shared.node.manifestRoots().length >= from + count, "antd's manifest root");
    return shared.node.manifestRoots().slice(from);
  }

  // The page's nested files, as a page passes them.
  const nestedParams = () => ({
    files: NESTED.map(({ path: filePath, bytes }) => ({
      path: filePath,
      bytes: new Uint8Array(bytes),
    })),
    indexDocument: INDEX,
  });

  /**
   * A manifest walked with core-sdk's mantaray reader over the page's
   * window.swarm `readChunk` (through its backend, `GET /chunks/<addr>` at
   * main's node). `resolve(root, filePath)` gives the path's target and its
   * fork's metadata, or null; `reads` holds every address read.
   */
  function manifestWalker(page) {
    const reads = [];
    const readChunk = async (address) => {
      reads.push(address);
      const answer = await page.ask('swarm_readChunk', { reference: address });
      if (!answer.result) throw new Error(`readChunk ${address}: ${JSON.stringify(answer.error)}`);
      return Buffer.from(answer.result.data, 'base64');
    };
    const load = async (address) =>
      coreSdk.MantarayNode.unmarshalFromData(await readChunk(address), Buffer.from(address, 'hex'));
    async function resolve(root, filePath) {
      let node = await load(root);
      let rest = Buffer.from(filePath, 'utf8');
      let metadata = null;
      while (rest.length) {
        const fork = node.forks.get(rest[0]);
        if (!fork) return null;
        const prefix = Buffer.from(fork.prefix);
        if (!rest.subarray(0, prefix.length).equals(prefix)) return null;
        rest = rest.subarray(prefix.length);
        metadata = fork.node.metadata;
        node = await load(Buffer.from(fork.node.selfAddress).toString('hex'));
      }
      return { target: Buffer.from(node.targetAddress).toString('hex'), metadata };
    }
    return { reads, readChunk, resolve };
  }

  /**
   * The page's nested publishFiles on `world`, to bee dev (a node that keeps
   * the upload) instead of antd: main's node URL is bee dev's tap for the
   * call, and antd's again after it. `{ answer, upload }`, `upload` the
   * request that carried the body to the node.
   */
  async function publishToBee(world) {
    const page = world.tab(APP);
    const from = shared.beeTap.requests.length;
    world.nodeUrl = shared.beeTap.url;
    try {
      const answer = await page.ask('swarm_publishFiles', nestedParams());
      const upload = shared.beeTap.requests
        .slice(from)
        .find((r) => r.method === 'POST' && r.target.startsWith('/bzz'));
      return { answer, upload };
    } finally {
      world.nodeUrl = shared.tap.url;
    }
  }

  describe('the JS backend, the reference', () => {
    let world;
    beforeAll(async () => {
      world = await loadWorld('js');
    });
    afterAll(async () => world?.close());

    test("a nested publishFiles: antd takes bee-js's tar whole and assembles its manifest", async () => {
      expect(world.backendKind()).toBe('js');
      expect(world.coreClient.swarmStoresNamed()).toBe(false);
      const page = world.tab(APP);
      const from = shared.tap.requests.length;
      const rootsFrom = shared.node.manifestRoots().length;
      const answer = await page.ask('swarm_publishFiles', nestedParams());
      // antd has no peers: its push fails, after it assembled the manifest.
      expect(answer.error).toBeDefined();
      const upload = crossedSince(from).find(
        (r) => r.method === 'POST' && r.target.startsWith('/bzz')
      );
      expect(upload).toMatchObject({ whole: true, status: 502 });
      expect(upload.headers['swarm-index-document']).toBe(INDEX);
      [roots.js] = await newRoots(rootsFrom);
      expect(world.prompts).toEqual([]);
      expect(world.exits).toEqual([]);
    });

    test("a nested publishFiles to a node that keeps it (bee dev): the reference it answers is the root antd assembled from bee-js's tar", async () => {
      const { answer, upload } = await publishToBee(world);
      expect(answer.error).toBeUndefined();
      expect(answer.result.reference).toMatch(/^[0-9a-f]{64}$/);
      expect(answer.result.bzzUrl).toBe(`bzz://${answer.result.reference}`);
      // The node took the body whole, on its own batch, and kept it (201).
      expect(upload).toMatchObject({ whole: true, status: 201 });
      expect(upload.headers['swarm-postage-batch-id']).toBe(shared.bee.batch);
      expect(upload.headers['swarm-index-document']).toBe(INDEX);
      // antd's root from the same tar, which names exactly the page's paths.
      expect(answer.result.reference).toBe(roots.js);
      expect(answer.result.reference).toBe(collectionManifest(NESTED, INDEX).root);
      refs.js = answer.result.reference;
      expect(world.prompts).toEqual([]);
    });
  });

  describe('the core backend (the flip)', () => {
    let world;
    beforeAll(async () => {
      world = await loadWorld('core');
    });
    afterAll(async () => world?.close());

    test("the build's hello names swarm_stores, the core takes it, and the node lists its batch usable", async () => {
      expect(world.backendKind()).toBe('core');
      expect(world.coreClient.swarmStoresNamed()).toBe(true);
      expect(world.hello.store_moved).toContain('swarm_stores');
      const stamps = await (await fetch(`${shared.tap.url}/stamps`)).json();
      expect(stamps.stamps).toEqual([expect.objectContaining({ batchID: BATCH, usable: true })]);
    });

    describe('a nested publishFiles', () => {
      const manifest = collectionManifest(NESTED, INDEX);

      test("gives the JS backend's reference: antd assembles the same manifest root, the one naming the page's nested paths", async () => {
        const page = world.tab(APP);
        const from = shared.tap.requests.length;
        const rootsFrom = shared.node.manifestRoots().length;
        const answer = await page.ask('swarm_publishFiles', nestedParams());
        expect(answer.error).toBeDefined();
        const upload = crossedSince(from).find(
          (r) => r.method === 'POST' && r.target.startsWith('/bzz')
        );
        // The core's tar, streamed chunked through main's executor, whole.
        expect(upload).toMatchObject({ framing: 'chunked', whole: true, status: 502 });
        expect(upload.headers['swarm-index-document']).toBe(INDEX);
        [roots.core] = await newRoots(rootsFrom);
        expect(roots.js).toMatch(/^[0-9a-f]{64}$/);
        expect(roots.core).toBe(roots.js);
        expect(roots.core).toBe(manifest.root);
        expect(world.prompts).toEqual([]);
      });

      test('its nested files resolve through the node: the manifest walked over readChunk, each file as antd stores it', async () => {
        expect(roots.core).toBe(manifest.root);
        // What the push would have stored, in antd's cache.
        seedChunks(path.join(shared.nodeDir, 'chunks.sqlite'), manifest.chunks);
        const page = world.tab(APP);
        const { reads, readChunk, resolve } = manifestWalker(page);
        for (const file of NESTED) {
          const found = await resolve(roots.core, file.path);
          expect(found?.metadata).toEqual({
            'Content-Type': contentTypeOf(file.path),
            Filename: file.path.split('/').pop(),
          });
          expect((await readChunk(found.target)).equals(Buffer.from(file.bytes))).toBe(true);
        }
        expect(await resolve(roots.core, '/')).toEqual({
          target: '00'.repeat(32),
          metadata: { 'website-index-document': INDEX },
        });
        expect(await resolve(roots.core, 'assets/missing.js')).toBeNull();
        // Each read went to the node, as a single chunk.
        const chunkReads = shared.tap.requests.filter(
          (r) => r.method === 'GET' && r.target.startsWith('/chunks/')
        );
        for (const address of new Set(reads)) {
          expect(
            chunkReads.some((r) => r.target === `/chunks/${address}` && r.status === 200)
          ).toBe(true);
        }
      });

      test("to a node that keeps it (bee dev): window.swarm gives the JS backend's reference", async () => {
        const { answer, upload } = await publishToBee(world);
        expect(answer.error).toBeUndefined();
        // What the core's upload gave the page, which the next test resolves
        // whatever it is.
        refs.core = answer.result.reference;
        // The core's tar, streamed chunked through main's executor, whole,
        // on the node's batch, and kept.
        expect(upload).toMatchObject({ framing: 'chunked', whole: true, status: 201 });
        expect(upload.headers['swarm-postage-batch-id']).toBe(shared.bee.batch);
        expect(upload.headers['swarm-index-document']).toBe(INDEX);
        expect(refs.js).toMatch(/^[0-9a-f]{64}$/);
        expect(answer.result.reference).toBe(refs.js);
        expect(answer.result.bzzUrl).toBe(`bzz://${refs.js}`);
        // The root antd assembled from the same tar, offline.
        expect(answer.result.reference).toBe(roots.core);
        expect(world.prompts).toEqual([]);
      });

      test('its nested files resolve from the uploaded root through the node that kept them: window.swarm over the core, and the node itself', async () => {
        expect(refs.core).toMatch(/^[0-9a-f]{64}$/);
        const root = refs.core;
        const page = world.tab(APP);
        const from = shared.beeTap.requests.length;
        world.nodeUrl = shared.beeTap.url;
        try {
          const walker = manifestWalker(page);
          for (const file of NESTED) {
            const found = await walker.resolve(root, file.path);
            expect(found?.metadata).toEqual({
              'Content-Type': contentTypeOf(file.path),
              Filename: file.path.split('/').pop(),
            });
            expect((await walker.readChunk(found.target)).equals(Buffer.from(file.bytes))).toBe(
              true
            );
            // window.swarm's readData gives the same bytes.
            const data = await page.ask('swarm_readData', { reference: found.target });
            expect(data.error).toBeUndefined();
            expect(Buffer.from(data.result.data, 'base64').equals(Buffer.from(file.bytes))).toBe(
              true
            );
          }
          expect(await walker.resolve(root, '/')).toEqual({
            target: '00'.repeat(32),
            metadata: { 'website-index-document': INDEX },
          });
          expect(await walker.resolve(root, 'assets/missing.js')).toBeNull();
          // Each chunk read went to the node, which served what it stored.
          const chunkReads = shared.beeTap.requests
            .slice(from)
            .filter((r) => r.method === 'GET' && r.target.startsWith('/chunks/'));
          for (const address of new Set(walker.reads)) {
            expect(
              chunkReads.some((r) => r.target === `/chunks/${address}` && r.status === 200)
            ).toBe(true);
          }
        } finally {
          world.nodeUrl = shared.tap.url;
        }
        // The node's own resolution of each path from the root.
        const bzz = async (rest) => {
          const res = await fetch(`${shared.beeTap.url}/bzz/${root}/${rest}`);
          return { res, body: Buffer.from(await res.arrayBuffer()) };
        };
        for (const file of NESTED) {
          const { res, body } = await bzz(file.path);
          expect(res.status).toBe(200);
          expect(body.equals(Buffer.from(file.bytes))).toBe(true);
          expect(res.headers.get('content-type')).toBe(contentTypeOf(file.path));
          expect(res.headers.get('content-disposition')).toBe(
            `inline; filename="${file.path.split('/').pop()}"`
          );
        }
        const index = await bzz('');
        expect(index.res.status).toBe(200);
        expect(index.body.equals(Buffer.from(NESTED[0].bytes))).toBe(true);
        expect((await bzz('assets/missing.js')).res.status).toBe(404);
        // Nothing reached the node's store but the two backends' uploads:
        // every chunk read here is one they stored, none seeded.
        expect(shared.beeTap.requests.filter((r) => r.method !== 'GET').map(line)).toEqual([
          'POST /bzz',
          'POST /bzz',
        ]);
      });
    });

    test('a feed read past the read window is refused before its body is held: the SOC read, no GET /bytes', async () => {
      const inline = feedEntry({
        privateKey: FEED_KEY,
        topic: FEED_TOPIC,
        index: 1,
        data: Buffer.alloc(4096, 0x5a),
      });
      const wrapped = feedEntry({
        privateKey: FEED_KEY,
        topic: FEED_TOPIC,
        index: 4,
        data: Buffer.alloc(512 * KIB, 0x3c),
      });
      seedChunks(path.join(shared.nodeDir, 'chunks.sqlite'), [...inline.chunks, ...wrapped.chunks]);
      // A site with no grant: the permission-free window, 512 KiB a minute.
      const page = world.tab(READER);
      const owner = `0x${inline.owner}`;
      let from = shared.tap.requests.length;
      const first = await page.ask('swarm_readFeedEntry', { topic: FEED_TOPIC, owner, index: 1 });
      expect(first.error).toBeUndefined();
      expect(first.result).toMatchObject({ encoding: 'base64', index: 1, nextIndex: 2 });
      expect(Buffer.from(first.result.data, 'base64').equals(Buffer.alloc(4096, 0x5a))).toBe(true);
      expect(crossedSince(from).map(line)).toEqual([
        'GET /node',
        `GET /chunks/${inline.socAddress}`,
      ]);
      from = shared.tap.requests.length;
      const past = await page.ask('swarm_readFeedEntry', { topic: FEED_TOPIC, owner, index: 4 });
      expect(past).toEqual({
        error: {
          code: -32602,
          message: 'Permission-free read budget exceeded',
          data: { reason: 'rate_limited', windowMs: 60000, maxRequests: 120, maxBytes: 524288 },
        },
      });
      // Its SOC read, and then nothing: the entry's body is never asked for.
      expect(crossedSince(from).map(line)).toEqual([
        'GET /node',
        `GET /chunks/${wrapped.socAddress}`,
      ]);
      expect(shared.tap.requests.some((r) => r.target === `/bytes/${wrapped.root}`)).toBe(false);
    });

    describe("F-4's case (`write-feed-10mib+1`): a feed entry of 10 MiB and one byte, refused before any upload", () => {
      const tooLarge = () => new Uint8Array(10 * MIB + 1).fill(0x46);

      test("from the page: page-requests refuses it as it arrives (1 MiB is the method's size), and nothing reaches the core or the node", async () => {
        const page = world.tab(APP);
        const from = shared.tap.requests.length;
        const sent = world.sent.length;
        expect(await page.ask('swarm_writeFeedEntry', { name: 'blog', data: tooLarge() })).toEqual({
          error: { code: -32005, message: 'Limit exceeded' },
        });
        expect(world.sent.slice(sent).filter((method) => method === 'swarm.request')).toEqual([]);
        expect(crossedSince(from).map(line)).toEqual([]);
      });

      test("at main's dispatcher, as the vectors' case runs: the core answers payload_too_large, and nothing reaches the node", async () => {
        const page = world.tab(APP);
        const from = shared.tap.requests.length;
        const sent = world.sent.length;
        const rootsFrom = shared.node.manifestRoots().length;
        expect(
          await page.dispatch('swarm_writeFeedEntry', { name: 'blog', data: tooLarge() })
        ).toEqual({
          error: {
            code: -32602,
            message: 'Payload exceeds maximum size of 10485760 bytes',
            data: { reason: 'payload_too_large', limit: 10485760, actual: 10485761 },
          },
        });
        // The core had it (one swarm.request), and asked the node nothing:
        // no stamps read, no index probe, no upload.
        expect(world.sent.slice(sent).filter((method) => method === 'swarm.request')).toHaveLength(
          1
        );
        await sleep(300);
        expect(crossedSince(from).map(line)).toEqual([]);
        expect(shared.node.manifestRoots().length).toBe(rootsFrom);
        expect(world.prompts).toEqual([]);
      });
    });

    test('a navigation mid-upload stops it: no more of the body reaches the node once the document has gone', async () => {
      const page = world.tab(APP);
      const files = Array.from({ length: 6 }, (_, i) => ({
        path: `big/part-${i}.bin`,
        bytes: new Uint8Array(8 * MIB).fill(i + 1),
      }));
      const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
      const reserved = await page.reserve('swarm_publishFiles', total + 4 * KIB);
      expect(reserved.ticket).toEqual(expect.any(String));
      const rootsFrom = shared.node.manifestRoots().length;
      const held = shared.tap.holdBody(
        (r) => r.method === 'POST' && r.target.startsWith('/bzz'),
        MIB
      );
      const asked = page.ask('swarm_publishFiles', { files }, reserved.ticket);
      await held;
      const upload = shared.tap.held.request;
      const atNavigation = upload.bytes;
      expect(atNavigation).toBeLessThan(total / 4);
      // The document goes.
      page.navigate('https://elsewhere.example/');
      expect(await asked).toBe(world.GONE);
      // The core's request has ended, and with it main's parent and calls.
      await until(
        () => world.swarmShell.stats().parents === 0 && world.swarmShell.stats().calls === 0,
        "main's parent and calls ended"
      );
      // Let the tap read on: only what was already on its way arrives, then
      // the client ends the connection.
      shared.tap.letGo();
      await until(() => upload.clientEnded, 'the client ending the connection');
      await sleep(500);
      expect(upload.whole).toBe(false);
      // The node never took it: it answers a body cut short 400 (the tap
      // passes the client's end on), or nothing once the connection went.
      expect([null, 400]).toContain(upload.status);
      expect(upload.bytes).toBeLessThan(total);
      // What still arrived was in flight: a body window and the sockets'
      // buffers at most, far short of the 47 MiB left.
      expect(upload.bytes - atNavigation).toBeLessThanOrEqual(16 * MIB);
      expect(shared.node.manifestRoots().length).toBe(rootsFrom);
    });

    describe("subscriptions: question 4's route test, against antd", () => {
      const REMOTE = () => `http://swarm-node.test:${shared.tap.port}`;
      const asRemote = () => {
        world.nodeUrl = REMOTE();
        world.nodeKind = 'external';
        world.alias = { from: REMOTE(), to: shared.tap.url };
      };
      const asLoopback = () => {
        world.nodeUrl = shared.tap.url;
        world.nodeKind = 'bundled';
        world.alias = null;
      };
      const upgrades = (from) => crossedSince(from).filter((r) => r.upgrade);
      afterEach(() => {
        world.proxy = () => 'DIRECT';
        world.tor = false;
        asLoopback();
      });

      test('a remote node behind a proxy: 4900 proxy-or-tor, no socket, and the node never dialled', async () => {
        asRemote();
        world.proxy = () => PROXY;
        const page = world.tab(APP);
        const from = shared.tap.requests.length;
        const sockets = world.sockets.length;
        const dials = world.remoteDials.length;
        expect(await page.ask('swarm_subscribe', { kind: 'pss', topic: 'room:refused' })).toEqual({
          error: PROXY_OR_TOR,
        });
        expect(world.sockets.length).toBe(sockets);
        expect(crossedSince(from)).toEqual([]);
        expect(world.remoteDials.slice(dials)).toEqual([]);
        expect(world.proxyAsked).toContain(`${REMOTE()}`);
      });

      test('checked again just before the open: a proxy turned on after the ready check refuses, and no socket is made', async () => {
        asRemote();
        const asked = world.proxyAsked.length;
        // DIRECT for the ready check, a proxy from then on.
        world.proxy = (_url, n) => (n === asked + 1 ? 'DIRECT' : PROXY);
        const page = world.tab(APP);
        const from = shared.tap.requests.length;
        const sockets = world.sockets.length;
        const dials = world.remoteDials.length;
        expect(await page.ask('swarm_subscribe', { kind: 'pss', topic: 'room:crossed' })).toEqual({
          error: PROXY_OR_TOR,
        });
        // The ready check dialled the node through its remote name; the
        // open, checked again, made no socket.
        expect(world.remoteDials.slice(dials)).toEqual([`${REMOTE()}/node`]);
        expect(crossedSince(from).map(line)).toEqual(['GET /node']);
        expect(world.proxyAsked.length).toBe(asked + 2);
        expect(world.sockets.length).toBe(sockets);
        expect(upgrades(from)).toEqual([]);
      });

      test('a proxy turned on ends a live subscription to the remote node, without a reconnect', async () => {
        asRemote();
        const page = world.tab(APP);
        const from = shared.tap.requests.length;
        const sockets = world.sockets.length;
        const opened = await page.ask('swarm_subscribe', { kind: 'pss', topic: 'room:live' });
        expect(opened.result).toMatchObject({ kind: 'pss', subscriptionId: expect.any(String) });
        // One socket, on the remote name, open to antd.
        expect(world.sockets.slice(sockets).map((s) => s.url)).toEqual([
          `${REMOTE().replace(/^http/, 'ws')}/pss/subscribe/${opened.result.key}`,
        ]);
        const { socket } = world.sockets[sockets];
        expect(socket.readyState).toBe(1);
        expect(upgrades(from)).toEqual([
          expect.objectContaining({ target: `/pss/subscribe/${opened.result.key}`, status: 101 }),
        ]);
        // A proxy comes on, and Tor's state changes: main tests the route again.
        world.proxy = () => PROXY;
        world.tor = true;
        for (const listener of world.serviceListeners) listener('tor');
        await until(() => socket.readyState === 3, 'the socket closed');
        // Ended: the page's subscription is gone, and nothing dials again
        // past the socket layer's first backoff (1 s).
        await sleep(3000);
        expect(world.sockets.length).toBe(sockets + 1);
        expect(upgrades(from)).toHaveLength(1);
        expect(
          await page.ask('swarm_unsubscribe', { subscriptionId: opened.result.subscriptionId })
        ).toMatchObject({
          error: { data: { reason: 'subscription_not_found' } },
        });
      });

      test('a loopback node still subscribes with a proxy on, its route never asked', async () => {
        asLoopback();
        world.proxy = () => PROXY;
        const asked = world.proxyAsked.length;
        const page = world.tab(APP);
        const from = shared.tap.requests.length;
        const sockets = world.sockets.length;
        const opened = await page.ask('swarm_subscribe', { kind: 'pss', topic: 'room:loopback' });
        expect(opened.result).toMatchObject({ kind: 'pss', subscriptionId: expect.any(String) });
        expect(world.sockets.slice(sockets).map((s) => s.url)).toEqual([
          `${shared.tap.url.replace(/^http/, 'ws')}/pss/subscribe/${opened.result.key}`,
        ]);
        expect(world.sockets[sockets].socket.readyState).toBe(1);
        expect(upgrades(from)).toEqual([
          expect.objectContaining({ target: `/pss/subscribe/${opened.result.key}`, status: 101 }),
        ]);
        expect(world.proxyAsked.length).toBe(asked);
        expect(
          await page.ask('swarm_unsubscribe', { subscriptionId: opened.result.subscriptionId })
        ).toEqual({
          result: { unsubscribed: true },
        });
        await until(() => world.sockets[sockets].socket.readyState === 3, 'the socket closed');
      });
    });

    test('the core never restarted, nothing went to the setup screen, and no prompt was shown', () => {
      expect(world.exits).toEqual([]);
      expect(world.setup).toEqual([]);
      expect(world.prompts).toEqual([]);
    });
  });
});
