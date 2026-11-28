/* global jest */

/**
 * The backends window.swarm's contract suite
 * (`src/main/page/page-swarm.contract.test.js`; freedom-core design 0015,
 * SWM-7, and its 2026-11-28 amendment: the contract sits at the
 * dispatcher) runs against, chosen by `FREEDOM_SWARM_CONTRACT_BACKEND`:
 *
 * - `js`: main's dispatcher (page/page-swarm.js) on the JS backend, as
 *   every build runs it before SWM-7's flip: `execute` is
 *   swarm-provider-ipc.js's `executeSwarmMethod`, the stores are main's
 *   files (feed-store.js, permission-manifests.js, publish-history.js), and
 *   bee-js dials the node. Electron, the identity core's vault
 *   (core/vault-backend.js: keys.json's test keys, signing with core-sdk as
 *   the generator did) and its grant mirror (core/grants.js: the case's
 *   grants, in memory) are scripted, as the vectors' generator scripted
 *   them (freedom-core `vectors/generator/swarm-world.js`).
 * - `core`: the same dispatcher on the core's backend, with PR 7.2's deps
 *   (page/page-swarm-core.js `swarmCoreDependencies()`, which tests select
 *   without the flip; PR 7.4's flip makes them the production path): every
 *   backend call goes to the real freedom-cored as `swarm.request`, and
 *   main's executor (core/swarm-shell.js, the shell asks main serves)
 *   carries the core's node calls. The core's hello names `swarm_stores`
 *   (`storeMovedFor('core', { swarmStores: true })`), so the stores are the
 *   core's and main's store modules are its clients; the grants are the
 *   core's (`swarm` in `grant_moved`) through main's real mirror; the vault
 *   is the core's, imported from keys.json's `abandon-12` phrase. Needs the
 *   binary: `FREEDOM_CORED_PATH`, else the one `npm run core:download`
 *   fetched, whose absence fails the suite.
 *
 * Each case runs on a world of its own (`runCase`): a Freedom data
 * directory (the core's grant root) holding the case's feed store and
 * grants, the node it scripts (test/helpers/swarm-contract-node.js), main's
 * modules loaded fresh, and on `core` a core of its own. Only the UI's
 * boundaries are scripted on both: the attested document (one guest,
 * window, frame and navigation), its prompts (the case's answers, else the
 * defaults the generator chose), Agent custody, the name's binding, the
 * publish readiness, and the world changes a case makes as the request
 * reaches the backend (`at_execute`) or as a node request arrives.
 *
 * `runCase` returns what both backends are held to: each step's answer
 * (`{ result }` or `{ error }`), the node requests it made, the prompts it
 * showed, the WebSockets opened, and the stores after (the feed store's
 * text and the publish history's rows).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { heldOf, swarmVectors } = require('./swarm-vectors');
const { ContractNode, nodeWorld, requestRecord, testKeys } = require('./swarm-contract-node');

const SRC = path.join(__dirname, '..', '..', 'src', 'main');
const BACKENDS = Object.freeze(['js', 'core']);
const BACKEND = process.env.FREEDOM_SWARM_CONTRACT_BACKEND || null;
const PASSWORD = 'swarm-contract-pass-1';
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const SILENT = { info() {}, warn() {}, error() {}, debug() {}, log() {}, verbose() {} };
const shell = { caller: 'shell' };

// The attested document every case's steps come from (swarm-run.js).
const GUEST = 1;
const WINDOW = 1;
const FRAME = 1;
const NAVIGATION = 1;
// Arti's SOCKS endpoint while a case says Tor is on.
const ARTI = '127.0.0.1:19150';

if (BACKEND !== null && !BACKENDS.includes(BACKEND)) {
  throw new Error(`FREEDOM_SWARM_CONTRACT_BACKEND=${BACKEND}: expected js or core`);
}

/**
 * The binary the `core` backend runs: `FREEDOM_CORED_PATH`, else the one
 * `npm run core:download` fetched. Its absence fails the suite (CI's core
 * step must never pass by skipping).
 */
function coredBinary() {
  const binary = process.env.FREEDOM_CORED_PATH || require(path.join(SRC, 'core', 'cored-binary')).getCoredBinaryPath();
  if (!binary || !fs.existsSync(binary)) {
    throw new Error(
      `FREEDOM_SWARM_CONTRACT_BACKEND=core needs freedom-cored (${binary || 'none'}): run npm run core:download`
    );
  }
  return binary;
}

/** The vectors the suite needs, or null: swarm.json and keys.json (test/helpers/swarm-vectors.js). */
function contractVectors() {
  const swarm = swarmVectors('swarm.json');
  const keys = swarmVectors('keys.json');
  return swarm && keys ? { swarm, keys: testKeys(keys) } : null;
}

/** The URL a page key's document has (swarm-run.js `urlOf`). */
function urlOf(key) {
  if (!key) return 'about:blank';
  return /^[a-z][a-z0-9+.-]*:\/\//.test(key) ? `${key}/` : `ens://${key}/`;
}

/** A frozen `Date` reading `clock.now` (swarm-node.js `fixedDate`). */
function fixedDate(clock) {
  const RealDate = globalThis.Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }

    static now() {
      return clock.now;
    }
  }
  return { RealDate, FixedDate };
}

/** The connected grant a case has by default (swarm-cases.js `connected`). */
function connected(origin, clock) {
  return {
    [origin]: {
      origin,
      connectedAt: clock - 60000,
      lastUsed: clock - 60000,
      autoApprove: { publish: false, feeds: false, signing: false, messaging: false },
    },
  };
}

// ---------------------------------------------------------------------------
// Prompts: the case's scripted answers, else the generator's defaults.

function defaultChoices(kind, view, choices) {
  if (kind === 'swarm.feed') {
    const active = { identity: view.activeIdentityId };
    return typeof choices === 'function' && choices(active) ? active : { identity: view.newIdentity.id };
  }
  if (kind === 'swarm.manifest') return { outcome: 'allow' };
  return {};
}

/**
 * A prompt's answer (swarm-run.js `answerPrompt`): the next scripted one,
 * else the default. A scripted answer the dispatcher's own `choices` check
 * refuses is a broken case. An approved `vault.unlock` opens the vault, as
 * main's unlock does before it answers the dispatcher.
 */
async function answerPrompt(world, spec) {
  const { kind, view = {}, choices } = spec;
  const scripted = world.prompts.length ? world.prompts.shift() : null;
  let answer;
  if (scripted) {
    if (scripted.kind && scripted.kind !== kind) throw new Error(`a scripted ${scripted.kind} answer met a ${kind} prompt`);
    answer = scripted.closed ? { closed: scripted.closed } : { approve: scripted.approve === true, choices: scripted.choices ?? {} };
  } else {
    answer = { approve: true, choices: defaultChoices(kind, view, choices) };
  }
  world.events.push({ prompt: { kind, view: JSON.parse(JSON.stringify(view)), answer } });
  if (answer.closed) return { closed: answer.closed };
  if (!answer.approve) return { approve: false, choices: {} };
  const checked = typeof choices === 'function' ? choices(answer.choices) : {};
  if (!checked) throw new Error(`the ${kind} prompt refuses the answer ${JSON.stringify(answer.choices)}`);
  if (kind === 'vault.unlock') await world.unlock();
  return { approve: true, choices: checked };
}

/**
 * The context page-requests.js hands a dispatcher, for one step
 * (swarm-run.js `pageContext`): the attested requester, the prompt, the
 * PageContext (custody read now), the name's binding, events to the
 * document, and the request's signal, which a reply marked `abortPage`
 * aborts. Subscription messages delivered to the document are noted.
 */
function pageContext(world, { method, params, key, id }) {
  const controller = new AbortController();
  world.abortPage = () => controller.abort();
  const requester = Object.freeze({
    guest: GUEST,
    window: WINDOW,
    frame: FRAME,
    navigation: NAVIGATION,
    url: urlOf(key),
    key,
    // A document's own key: no name binding (page-core-requests.js).
    transportKey: key,
    topKey: key,
  });
  const state = { after: null };
  const context = Object.freeze({
    id,
    requester,
    provider: 'swarm',
    method,
    params,
    isCurrent: () => true,
    nameHolds: async () => world.nameHolds,
    keylessOnceUnheld: () => {},
    holdsKey: () => world.nameHolds,
    prompt: (spec) => answerPrompt(world, spec),
    pageContext: () => ({ origin: key, top_origin: key, frame: FRAME, navigation: NAVIGATION, agent: world.custody }),
    get signal() {
      return controller.signal;
    },
    afterAnswer: (fn) => {
      if (typeof fn === 'function') state.after = fn;
    },
    liveDocuments: () => [requester],
    sendEvent: async (_target, event, data) => {
      world.events.push(event === 'message' ? { delivered: data } : { page_event: { event, data } });
      return { ok: true };
    },
    onDocumentEnded: () => () => {},
    copied: () => {},
  });
  return { context, after: () => state.after };
}

// ---------------------------------------------------------------------------
// Main's modules, loaded fresh for each case.

const SRC_PATH = (rel) => path.join(SRC, rel);

/** Electron as the world scripts it: inert, one live guest, the session's proxy. */
function electronOf(world) {
  const guest = { id: GUEST, isDestroyed: () => false, session: null };
  return {
    ipcMain: {
      handle: (channel, fn) => world.ipc.set(channel, fn),
      on() {},
      removeHandler: (channel) => world.ipc.delete(channel),
    },
    app: { getPath: () => world.dir, isPackaged: false, on() {}, whenReady: async () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    BrowserWindow: { getAllWindows: () => [], fromId: () => null, getFocusedWindow: () => null },
    session: { defaultSession: { resolveProxy: async (url) => world.resolveProxy(url) } },
    webContents: { fromId: (id) => (id === GUEST ? guest : null), getAllWebContents: () => [] },
    nativeTheme: {},
  };
}

/**
 * Mocks main's boundaries for a fresh registry (both backends): Electron,
 * the loggers, the service registry (the node's URL and kind, Tor), the
 * publish readiness, the vault timer, the Freedom data directory, private
 * windows, the manifest's fetch (`handleBzzRequest`: the world's manifest,
 * else the node's 404), the chrome's windows, and identity-manager.js's
 * lower modules (for its requires only, as the generator loads it).
 */
// The packages main's Swarm modules load, loaded once and shared by every
// case's registry: they hold no state a case could leave behind, and
// loading them per case would hold a copy per registry.
const PACKAGES = ['@ethersphere/bee-js', '@ethersphere/core-sdk', 'ethers', 'cafe-utility'];
let packages = null;

function mockBoundaries(world) {
  const mock = (rel, factory) => jest.doMock(SRC_PATH(rel), factory);
  packages ??= Object.fromEntries(PACKAGES.map((name) => [name, require(name)]));
  for (const name of PACKAGES) jest.doMock(name, () => packages[name]);
  jest.doMock('electron', () => electronOf(world), { virtual: true });
  jest.doMock('electron-log', () => SILENT);
  mock('logger.js', () => SILENT);
  mock('service-registry.js', () => ({
    ...jest.requireActual(SRC_PATH('service-registry.js')),
    getAntApiUrl: () => world.nodeUrl,
    getService: (name) => {
      if (name === 'tor') return world.tor ? { socks: ARTI } : null;
      if (name === 'ant') return { mode: world.nodeKind };
      return null;
    },
    onServiceChange: () => () => {},
  }));
  mock('swarm/publish-setup-service.js', () => ({
    getPublishReadiness: async () => {
      world.events.push({ readiness: 'publish' });
      if (world.readiness === 'throws') throw new Error('readiness failed');
      return world.readiness;
    },
  }));
  mock('vault-timer.js', () => ({ resetVaultAutoLockTimer: () => world.events.push({ vault_timer_reset: true }) }));
  mock('freedom-root.js', () => ({
    ...jest.requireActual(SRC_PATH('freedom-root.js')),
    getFreedomDataDir: () => world.dir,
    getFreedomDataPath: (name) => path.join(world.dir, name),
  }));
  mock('private/private-windows.js', () => ({ isPrivateWebContents: () => false, getPartitionForWebContents: () => null }));
  mock('swarm/bzz-protocol.js', () => ({
    ...jest.requireActual(SRC_PATH('swarm/bzz-protocol.js')),
    handleBzzRequest: async (request) => {
      if (!/^bzz:\/\/[^/]+\/freedom-manifest\.json$/.test(request.url)) throw new Error(`no bzz: ${request.url} here`);
      world.events.push({ manifest_fetch: request.url });
      if (world.manifest === undefined) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify(world.manifest), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  }));
  mock('windows/mainWindow.js', () => ({
    getMainWindows: () => [],
    isMainBrowserWindow: () => false,
    getLastFocusedMainWindow: () => null,
  }));
  mock('ant-manager.js', () => ({ restartingUrl: () => null }));
  // Main's dials of a remote node go on the session's stack: here, to the
  // node the case aliases.
  mock('ipfs/gateway-transport.js', () => ({
    ...jest.requireActual(SRC_PATH('ipfs/gateway-transport.js')),
    netGatewayFetch: (url, init) => {
      const { alias } = world.node;
      const to = alias && url.startsWith(`${alias.from}/`) ? alias.to + url.slice(alias.from.length) : url;
      return globalThis.fetch(to, init);
    },
  }));
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
  }));
  mock('radicle/radicled-gate.js', () => ({ withRadicleGate: (fn) => fn() }));
  mock('radicle/radicle-backend-kind.js', () => ({ radicleBackendKind: () => 'service' }));
  mock('private-files.js', () => ({ withPrivateDir() {} }));
  mock('swarm/ant-keystore-password.js', () => ({}));
}

/**
 * The JS backend's scripted identity core (swarm-world.js): the vault's
 * status, the test keys' addresses while unlocked, `sign.soc` with
 * core-sdk under the key the reference names, and the grant mirror over
 * the case's grants.
 */
function mockJsCore(world, keys) {
  const core = require('@ethersphere/core-sdk');
  const locked = () => Object.assign(new Error('Vault is locked'), { code: 'vault_locked' });
  const signSoc = (key, { identifier, payload, span }) => {
    if (!world.unlocked) return Promise.reject(locked());
    let privateKey;
    if (key.kind === 'bee_wallet') privateKey = keys.bee.privateKey;
    else if (key.kind === 'publisher') privateKey = keys.publishers.get(key.origin_index)?.privateKey;
    if (!privateKey) return Promise.reject(new Error(`no test key for ${JSON.stringify(key)}`));
    const cac = core.makeContentAddressedChunk(payload, span === undefined || span === null ? undefined : BigInt(span));
    const soc = cac.toSingleOwnerChunk(new core.Identifier(identifier), privateKey.replace(/^0x/, ''));
    return Promise.resolve({
      signature: '0x' + soc.signature.toHex(),
      owner: soc.owner.toChecksum(),
      chunk_address: '0x' + cac.address.toHex(),
      soc_address: '0x' + soc.address.toHex(),
      span: cac.span.toBigInt().toString(),
    });
  };
  const vaultBackend = {
    status: async () => ({ exists: true, unlocked: world.unlocked }),
    addresses: async ({ accounts = [], publishers = [] } = {}) => {
      if (!world.unlocked) throw locked();
      if (accounts.length) throw new Error('the swarm vectors derive no user wallet');
      return {
        user_wallets: [],
        bee_wallet: keys.bee.address,
        publishers: publishers.map((index) => {
          const key = keys.publishers.get(index);
          if (!key) throw new Error(`keys.json has no publisher key at index ${index}`);
          return { origin_index: index, address: key.address };
        }),
        radicle: null,
      };
    },
    accounts: { list: async () => [] },
    sign: { soc: signSoc },
    touch() {},
  };
  const record = (key) =>
    world.grants[key] || {
      origin: key,
      connectedAt: world.clock.now,
      lastUsed: world.clock.now,
      autoApprove: { publish: false, feeds: false, signing: false, messaging: false },
    };
  const grantStore = () => ({
    get: (key) => (world.grants[key] ? structuredClone(world.grants[key]) : null),
    all: () => Object.values(world.grants).map((g) => structuredClone(g)),
    whenLoaded: async () => world.grantsLoaded !== false,
    grant: async (change, caller) => {
      const key = change.key ?? caller?.origin;
      const was = record(key);
      if (change.op === 'connect') world.grants[key] = was;
      else if (change.op === 'flag') world.grants[key] = { ...was, autoApprove: { ...was.autoApprove, [change.flag]: true } };
      else if (change.op === 'messaging') world.grants[key] = { ...was, messaging: true };
    },
    revoke: async (key, what) => {
      const was = world.grants[key];
      if (!was) return;
      if (what === 'grant') delete world.grants[key];
      else if (what === 'messaging') world.grants[key] = { ...was, messaging: false };
      else if (what?.flag) world.grants[key] = { ...was, autoApprove: { ...was.autoApprove, [what.flag]: false } };
    },
    touch: async (page) => {
      if (world.grants[page?.origin]) world.grants[page.origin] = { ...world.grants[page.origin], lastUsed: world.clock.now };
    },
  });
  jest.doMock(SRC_PATH('core/vault-backend.js'), () => ({ vaultBackend }));
  jest.doMock(SRC_PATH('core/grants.js'), () => ({ grantStore }));
  jest.doMock('better-sqlite3', () => require('./fake-better-sqlite3-publishes'));
}

// ---------------------------------------------------------------------------
// The core: one per case, its vault from a template imported once.

let template = null;

/**
 * The vault imported once from keys.json's phrase into a template data
 * directory, which each case's core starts from (a copy), unlocked with
 * the password: the import's key stretch runs once.
 */
async function coreTemplate(binary, keys) {
  if (template) return template;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-contract-vault-'));
  const client = startClient(binary, root, null);
  await client.start();
  try {
    await client.request(
      'vault.import',
      { password_b64: b64(PASSWORD), mnemonic_b64: b64(keys.mnemonic), overwrite: false, user_knows_password: true },
      shell
    );
  } finally {
    await client.stop();
  }
  template = root;
  return root;
}

/** Removes the template (afterAll). */
function removeCoreTemplate() {
  if (template) fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  template = null;
}

/** A CoreClient on `binary` over `root` (identity, locks, grant root), its hello naming `storeMoved`. */
function startClient(binary, root, storeMoved) {
  const { CoreClient, _internal } = require(SRC_PATH('core/core-client.js'));
  const client = new CoreClient({
    spawn,
    command: binary,
    args: ['serve', '--data-dir', path.join(root, 'identity'), '--lock-dir', path.join(root, 'locks')],
    log: SILENT,
    shellVersion: 'jest',
    grantRoot: root,
  });
  if (storeMoved) client.service = _internal.coreService(storeMoved);
  return client;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else if (entry.isFile()) fs.copyFileSync(a, b);
  }
}

// ---------------------------------------------------------------------------
// A case's world.

/**
 * Builds a case's world: its data directory with the case's feed store,
 * manifest store and grants written before anything loads, the node, and
 * the scripted boundaries' state.
 */
async function worldOf(kase, { keys, trees }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-contract-'));
  const clock = { now: kase.clock };
  const node = new ContractNode(await nodeWorld(kase.node, { keyOf: keys.keyOf, trees }), { trees });
  const nodeUrl = await node.start();
  if (kase.feeds !== null && kase.feeds !== undefined) fs.writeFileSync(path.join(dir, 'swarm-feeds.json'), kase.feeds);
  if (kase.manifests !== null && kase.manifests !== undefined) {
    fs.writeFileSync(path.join(dir, 'swarm-manifest-grants.json'), kase.manifests);
  }
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ enableIdentityWallet: kase.identity_wallet !== false }));
  const session = kase.session || null;
  // A node the case places at a remote address reaches this one: the JS
  // backend's fetch and main's remote dials (netGatewayFetch) are aliased.
  // One it places on loopback is this one, whose port the records name as
  // 1633.
  const loopbackSession = session?.node_url && session.node_loopback === true;
  if (session?.node_url && !loopbackSession) node.alias = { from: new URL(session.node_url).origin, to: nodeUrl };
  const world = {
    dir,
    clock,
    node,
    nodeUrl: kase.node_stopped ? null : session?.node_url && !loopbackSession ? session.node_url : nodeUrl,
    nodeKind: session?.node_kind === 'external' ? 'external' : 'bundled',
    tor: session?.tor === true,
    // The session's proxy for the node's URL: a proxy the case turns on is
    // the session's; Freedom's Tor carries `.onion` names only
    // (tor-proxy.js), so a node at a normal address stays DIRECT with Tor
    // on, as the 2026-11-28 amendment's route test reads it.
    resolveProxy: async (url) => {
      if (session?.proxy === true) return 'PROXY 127.0.0.1:8118';
      if (session?.tor === true && /\.onion(:\d+)?\//.test(url)) return `SOCKS5 ${ARTI}`;
      return 'DIRECT';
    },
    custody: kase.custody === true,
    prompts: [...(kase.prompts || [])],
    grantsLoaded: kase.grants_unavailable !== true,
    nameHolds: true,
    manifest: kase.manifest,
    readiness: kase.readiness ?? { ok: true },
    unlocked: kase.vault !== 'locked',
    grants: structuredClone(kase.grants ?? connected(kase.origin, kase.clock)),
    events: [],
    // The core's requests main made, each with the method it carried: the
    // core's backend only.
    coreCalls: [],
    ipc: new Map(),
    abortPage: null,
  };
  // How the node answers a subscription's socket: a refusal it closes with.
  node.socketClose = kase.websocket_close || null;
  node.abortPage = () => world.abortPage?.();
  return world;
}

/** The grants file the core loads, as swarm-permissions.js's schema writes it. */
function writeGrants(world) {
  fs.writeFileSync(path.join(world.dir, 'swarm-permissions.json'), JSON.stringify(world.grants, null, 2));
}

/**
 * Loads main for the case on `backend` and returns `{ dispatchers,
 * change, after, close }`: the dispatchers page-requests.js would call,
 * the world's changes as the backend makes them, the stores after, and the
 * teardown.
 */
async function loadBackend(backend, world, { keys, binary }) {
  // The vault's template first, in the registry the case then drops.
  if (backend === 'core') await coreTemplate(binary, keys);
  jest.resetModules();
  mockBoundaries(world);
  if (backend === 'js') return loadJs(world, keys);
  return loadCore(world, keys, binary);
}

/** The dispatchers over `deps` with the UI's boundaries scripted (swarm-run.js `dispatchersFor`). */
function dispatchersOver(world, deps) {
  const guest = { id: GUEST, isDestroyed: () => false };
  const { createSwarmDispatchers } = require(SRC_PATH('page/page-swarm.js'));
  return createSwarmDispatchers({
    guestContents: (id) => (id === GUEST ? guest : null),
    inCustody: () => world.custody,
    routeToSetup: (_requester, reason) => world.events.push({ route_to_setup: reason }),
    ...deps,
  });
}

function loadJs(world, keys) {
  mockJsCore(world, keys);
  const provider = require(SRC_PATH('swarm/swarm-provider-ipc.js'));
  provider.registerSwarmProviderIpc();
  const feedStore = require(SRC_PATH('swarm/feed-store.js'));
  const history = require(SRC_PATH('swarm/publish-history.js'));
  const registry = require(SRC_PATH('swarm/subscription-registry.js'));
  const dispatchers = dispatchersOver(world, {
    execute: async (method, params, key, meta) => {
      world.events.push({ service: method });
      if (world.atExecute) await change(world.atExecute);
      return provider.executeSwarmMethod(method, params, key, meta);
    },
  });
  const key = world.key;
  async function change(changes) {
    for (const [what, value] of Object.entries(changes)) {
      if (what === 'custody') world.custody = value === true;
      else if (what === 'vault') world.unlocked = value !== 'locked';
      else if (what === 'name') world.nameHolds = value !== 'moved';
      else if (what === 'rule_off') {
        world.grants[key] = { ...world.grants[key], autoApprove: { ...world.grants[key].autoApprove, [value]: false } };
      } else if (what === 'messaging' && value === 'revoked') world.grants[key] = { ...world.grants[key], messaging: false };
      else if (what === 'connection' && value === 'revoked') delete world.grants[key];
      else if (what === 'feed_access' && value === 'revoked') feedStore.revokeFeedAccess(key, { source: 'user' });
      else throw new Error(`no world change ${what}`);
    }
  }
  world.unlock = async () => {
    world.unlocked = true;
  };
  return {
    dispatchers,
    change,
    after: async () => ({
      feeds: readIf(path.join(world.dir, 'swarm-feeds.json')),
      history: history.getEntries(),
    }),
    close: async () => {
      try {
        history.closeDb?.();
        registry._reset?.();
        require(SRC_PATH('swarm/gsoc-miner.js')).resetForTest?.();
      } catch {
        // Torn down with the registry.
      }
    },
  };
}

async function loadCore(world, keys, binary) {
  // The switch, read once per registry (swarm-backend-kind.js): before
  // anything of main's loads.
  process.env.FREEDOM_SWARM_BACKEND = 'core';
  const root = await coreTemplate(binary, keys);
  copyDir(path.join(root, 'identity'), path.join(world.dir, 'identity'));
  writeGrants(world);
  const { storeMovedFor } = jest.requireActual(SRC_PATH('core/core-client.js'));
  const storeMoved = storeMovedFor('core', { swarmStores: true });
  let client = null;
  let swarmShell = null;
  jest.doMock(SRC_PATH('core/core-process.js'), () => ({
    getCoreClient: () => client,
    getSwarmShell: () => swarmShell,
    isCoreRunning: () => Boolean(client),
  }));
  jest.doMock(SRC_PATH('core/core-client.js'), () => ({
    ...jest.requireActual(SRC_PATH('core/core-client.js')),
    swarmStoresNamed: () => true,
  }));
  client = startClient(binary, world.dir, storeMoved);
  // Each page request main sends the core, and what the core answered.
  const request = client.request.bind(client);
  client.request = async (method, params, ...rest) => {
    if (method !== 'swarm.request') return request(method, params, ...rest);
    const call = { method: params?.method?.string ?? null };
    world.coreCalls.push(call);
    try {
      const reply = await request(method, params, ...rest);
      const answer = reply && typeof reply === 'object' && 'result' in reply && 'release' in reply ? reply.result : reply;
      call.answer = Object.keys(answer || {})[0] ?? null;
      return reply;
    } catch (err) {
      call.failed = err?.code ?? 'error';
      throw err;
    }
  };
  const { attachGrants } = require(SRC_PATH('core/grants.js'));
  attachGrants(client);
  const { registerSwarmShell } = require(SRC_PATH('core/swarm-shell.js'));
  swarmShell = registerSwarmShell(client, {
    publishReadiness: async () => {
      world.events.push({ readiness: 'publish' });
      if (world.readiness === 'throws') throw new Error('readiness failed');
      return world.readiness;
    },
  });
  const { getCoreRequests } = require(SRC_PATH('page/page-core-requests.js'));
  const coreRequests = getCoreRequests();
  client.handle('approval.recheck', (params, context) => coreRequests.recheck(params, context));
  const exits = [];
  const hello = await client.start();
  client.current.child.on('exit', (code, signal) => exits.push(code ?? signal));
  if (JSON.stringify(hello.store_moved) !== JSON.stringify([...storeMoved])) {
    throw new Error(`the core's hello echoed ${JSON.stringify(hello.store_moved)}`);
  }
  if (world.unlocked) await client.request('vault.unlock', { password_b64: b64(PASSWORD) }, shell);
  // The main wallet the core's vault always holds (index 0).
  const mainWallet = (await client.request('accounts.list', {}, shell)).wallets.find((w) => w.index === 0)?.address ?? null;
  const permissions = require(SRC_PATH('swarm/swarm-permissions.js'));
  await permissions.whenLoaded();
  const provider = require(SRC_PATH('swarm/swarm-provider-ipc.js'));
  provider.registerSwarmProviderIpc();
  const registry = require(SRC_PATH('swarm/subscription-registry.js'));
  const { antBackend } = require(SRC_PATH('swarm/bzz-protocol.js'));
  const { swarmCoreDependencies } = require(SRC_PATH('page/page-swarm-core.js'));
  const core = swarmCoreDependencies({
    coreClient: () => client,
    swarmShell: () => swarmShell,
    coreRequests,
    nodeBackend: () => antBackend(),
  });
  const key = world.key;
  // The grant's changes go to the core as main's own writes (`shell`), so
  // no user change follows them, as the generator changed its grant store
  // directly.
  async function change(changes) {
    for (const [what, value] of Object.entries(changes)) {
      if (what === 'custody') world.custody = value === true;
      else if (what === 'vault') {
        if (value === 'locked') await client.request('vault.lock', {}, shell);
        world.unlocked = value !== 'locked';
      } else if (what === 'name') world.nameHolds = value !== 'moved';
      else if (what === 'rule_off') await permissions.setAutoApprove(key, value, false, { source: 'manifest' });
      else if (what === 'messaging' && value === 'revoked') await permissions.revokeMessaging(key, { source: 'manifest' });
      else if (what === 'connection' && value === 'revoked') await permissions.revokePermission(key, { source: 'manifest' });
      else if (what === 'feed_access' && value === 'revoked') {
        await require(SRC_PATH('core/swarm-stores.js')).identities('revoke-feed-access', { origin: key }, { caller: 'chrome' });
      } else throw new Error(`no world change ${what}`);
    }
  }
  world.unlock = async () => {
    await client.request('vault.unlock', { password_b64: b64(PASSWORD) }, shell);
    world.unlocked = true;
  };
  const dispatchers = dispatchersOver(world, {
    ...core,
    // Main's grant mirror, which a case may find not loaded.
    grantsLoaded: async () => world.grantsLoaded !== false && (await permissions.whenLoaded()),
    execute: async (method, params, key2, meta, request) => {
      world.events.push({ service: method });
      if (world.atExecute) await change(world.atExecute);
      return core.execute(method, params, key2, meta, request);
    },
  });
  return {
    dispatchers,
    change,
    client,
    exits,
    mainWallet,
    after: async () => {
      const history = await require(SRC_PATH('core/swarm-stores.js')).history('list', {});
      return { feeds: readIf(path.join(world.dir, 'swarm-feeds.json')), history };
    },
    close: async () => {
      try {
        registry._reset?.();
      } finally {
        await client.stop();
        delete process.env.FREEDOM_SWARM_BACKEND;
      }
    },
  };
}

function readIf(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

// ---------------------------------------------------------------------------
// Playing a case.

/**
 * The page's answer as the vectors write it: `{ result }` or `{ error }`,
 * an error's message with the node's port replaced.
 */
function outcomeOf(value, node) {
  if (!value || typeof value !== 'object') return { answer: value };
  if ('error' in value) {
    const error = { ...value.error };
    if (typeof error.message === 'string') error.message = node.normalize(error.message);
    return { error };
  }
  return { result: value.result };
}

/**
 * An answer with each subscription id a step answered replaced by the one
 * the vectors recorded for it (`ids`: recorded to answered), in its
 * strings too: ids are random on both backends.
 */
function recordedIds(out, ids) {
  if (ids.size === 0) return out;
  const back = new Map([...ids].map(([recorded, answered]) => [answered, recorded]));
  const walk = (value) => {
    if (typeof value === 'string') {
      let text = value;
      for (const [answered, recorded] of back) text = text.split(answered).join(recorded);
      return text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, walk(member)]));
    }
    return value;
  };
  return walk(out);
}

/** How many messages the document has been sent. */
const countDelivered = (world) => world.events.filter((e) => e.delivered).length;

/** Whether a step is a page's request through main's dispatcher. */
const viaDispatcher = (step) => typeof step.method === 'string' && step.page !== false;

/**
 * The verified walks a step's `read-data-verified` marks stand for on
 * `core`, by root (the node's `verifiedWalk`): each built from the root's
 * tree, with the reference's status for its join and what the node
 * streamed for the core's ranged read of it (`from`: the step's first node
 * request), whose leaves the walk checks. A behaviour case's step
 * (swarm-contract-cases.js) names its joins itself (`joins`: each root and
 * the status the reference's join of it is answered).
 */
function walksOf(step, node, from) {
  const joins = (step.requests || [])
    .filter((request) => request.deviation === 'read-data-verified')
    .map((request) => ({ root: request.path.slice('/bytes/'.length), status: request.status ?? null }));
  joins.push(...(step.joins || []));
  const walks = {};
  for (const { root, status } of joins) {
    const ranged = node.requests
      .slice(from)
      .find((r) => r.method === 'GET' && r.path === `/bytes/${root}` && r.headers.some(([name]) => name === 'range'));
    walks[root] = node.verifiedWalk(root, { status, served: ranged?.served ?? null });
  }
  return walks;
}

/**
 * Runs a `methods` case (or a contract case in the same form) on
 * `backend`: each step through main's dispatcher, as page-requests.js
 * calls it. Subscription ids are random on both backends, so a later
 * step's params naming the id the vectors recorded get the id the step
 * before answered.
 */
async function runCase(backend, kase, env) {
  const world = await worldOf(kase, env);
  world.key = kase.keyless ? null : kase.origin;
  world.atExecute = kase.at_execute;
  const { RealDate, FixedDate } = fixedDate(world.clock);
  // The stores' own console lines (swarm-permissions.js and
  // permission-manifests.js log there) stay out of the run's output.
  const consoleWas = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  Object.assign(console, { log() {}, warn() {}, error() {}, info() {} });
  const undo = world.node.install({ wrapTransports: backend === 'js' });
  if (backend === 'js') globalThis.Date = FixedDate;
  let loaded = null;
  const record = { steps: [], window: { from: RealDate.now(), to: null } };
  world.node.retime = {
    seconds: Math.floor(kase.clock / 1000),
    from: Math.floor(record.window.from / 1000) - 2,
    now: () => RealDate.now(),
  };
  try {
    loaded = await loadBackend(backend, world, env);
    world.node.onWorld = (changes) => loaded.change(changes);
    const ids = new Map();
    // One request through the dispatcher, as page-requests.js makes it.
    const dispatchOne = async (step, k) => {
      let params = step.plain !== undefined ? step.plain : heldOf(step.params, step.parts || []);
      if (params && typeof params === 'object' && typeof params.subscriptionId === 'string' && ids.has(params.subscriptionId)) {
        params = { ...params, subscriptionId: ids.get(params.subscriptionId) };
      }
      const dispatch = loaded.dispatchers[`swarm:${step.method}`];
      if (!dispatch) return { error: { code: -32601, message: 'no dispatcher' } };
      const key = kase.keyless ? null : (step.origin ?? kase.origin);
      const { context, after } = pageContext(world, { method: step.method, params, key, id: k + 1 });
      const value = await dispatch(context);
      if (after()) await after()();
      const recorded = step.result?.subscriptionId;
      if (recorded && typeof value?.result?.subscriptionId === 'string') ids.set(recorded, value.result.subscriptionId);
      return value;
    };
    for (const [k, step] of kase.steps.entries()) {
      const before = world.node.requests.length;
      const eventsBefore = world.events.length;
      const sentBefore = world.coreCalls.length;
      let out;
      if (step.concurrent) {
        // Requests the page makes at once: each answer, in the step's order.
        const values = await Promise.all(step.concurrent.map((one) => dispatchOne(one, k)));
        out = { answers: values.map((value) => recordedIds(outcomeOf(value, world.node), ids)) };
      } else if (step.socket) {
        // The node sends a frame on every open subscription socket.
        out = { delivered: await world.node.sendOnSockets(step.socket.message, () => countDelivered(world)) };
      } else if (!viaDispatcher(step)) {
        record.steps.push({ skipped: 'not a page request through the dispatcher' });
        continue;
      } else {
        if (step.clock !== undefined) world.clock.now = step.clock;
        out = recordedIds(outcomeOf(await dispatchOne(step, k), world.node), ids);
      }
      record.steps.push({
        ...out,
        requests: world.node.requests.slice(before).map((r) => requestRecord(r, world.node)),
        prompts: world.events
          .slice(eventsBefore)
          .filter((e) => e.prompt)
          .map((e) => e.prompt),
        events: world.events.slice(eventsBefore).map((e) => recordedIds(e, ids)),
        sent: world.coreCalls.slice(sentBefore),
        ...(backend === 'core' ? { walks: walksOf(step, world.node, before) } : {}),
      });
    }
    record.window.to = RealDate.now();
    record.websockets = world.node.websockets;
    record.after = await loaded.after();
    if (loaded.exits?.length) record.exits = [...loaded.exits];
    if (loaded.mainWallet) record.mainWallet = loaded.mainWallet;
    return record;
  } finally {
    try {
      await loaded?.close();
    } finally {
      undo();
      globalThis.Date = RealDate;
      Object.assign(console, consoleWas);
      await world.node.stop();
      fs.rmSync(world.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

module.exports = {
  BACKEND,
  contractVectors,
  coredBinary,
  removeCoreTemplate,
  runCase,
  viaDispatcher,
};
