/**
 * window.swarm on the core's backend (page-swarm-core.js; freedom-core
 * design 0015, "The protocol", D5, D13, D16, "Results for pages", and the
 * 2026-11-28 amendment; SWM-7's PR 7.2), through main's own page
 * dispatcher (page-swarm.js, its checks, prompts and grant writes) and
 * page-requests, against a scripted core (test/helpers/fake-swarm-core.js)
 * on a real CoreClient with main's Swarm executor registered
 * (swarm-shell.js), and main's one handler of the core's `approval.recheck`
 * (the EIP-1193 relay's, on the same registry: page-core-requests.js):
 * - each method's `swarm.request`: its typed params, its approval, the
 *   page's timer, its PageContext, and the parent main opens for it;
 * - a cancel at each step: before it is sent, while the core asks main,
 *   while a body streams, and after the answer;
 * - `approval.recheck` live, with the Agent's custody, and crossed;
 * - a result's charge held until the page has its answer;
 * - a page's request naming only its own parent;
 * - `swarm_unsubscribe` main's own, the setup screen on a `4900`, the vault
 *   timer, and the JS path unchanged (its `execute` gets its four
 *   arguments, and the core's path never reaches it).
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../service-registry', () => ({
  MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', REUSED: 'reused' },
  getAntApiUrl: () => 'http://127.0.0.1:1633',
  getService: () => ({ mode: 'bundled' }),
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../profile-resolver', () => ({ getActiveProfile: () => null }));
jest.mock('../core/dweb-verify', () => ({ dwebVerifier: () => null }));
jest.mock('../core/naming', () => ({ namingDriver: () => null }));
// The page's errors leave with no stored API key in them: none here.
jest.mock('../networks/network-registry', () => ({ withoutApiKeys: (text) => String(text) }));
// The JS backend: reached only by the JS path's own `execute`.
const mockSpi = {
  executeSwarmMethod: jest.fn(async () => ({ result: 'js' })),
  endDocumentSubscriptions: jest.fn(),
  endDocumentSubscription: jest.fn(),
};
jest.mock('../swarm/swarm-provider-ipc', () => mockSpi);

const { EventEmitter } = require('events');
const { KIND_ABORT } = require('../core/frame');
const { SwarmIoPool } = require('../core/swarm-io-pool');
const { readTyped, writePageParams, writeTyped } = require('../core/swarm-typed');
const { rowFor } = require('../core/swarm-grammar');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { methodRow } = require('./page-methods');
const { createSwarmDispatchers } = require('./page-swarm');
const { swarmCoreDependencies, createSwarmCoreExecute, VAULT_TIMER_METHODS } = require('./page-swarm-core');
const { createCoreRequests } = require('./page-core-requests');
const { createEip1193Relay } = require('./page-eip1193');
const { startSwarmCore, until, tick } = require('../../../test/helpers/fake-swarm-core');

const KIB = 1024;
const CHROME_URL = 'file:///app/src/renderer/index.html';
const KEY = `bzz://${'a'.repeat(64)}`;
const OTHER_KEY = `bzz://${'b'.repeat(64)}`;
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';
const NODE_URL = 'http://127.0.0.1:1633';
const NOW = 1_767_225_600_000;
const REF = 'a1'.repeat(32);
const OTHER_REF = 'b2'.repeat(32);
const TOPIC = 'c3'.repeat(32);
const OWNER = 'd4'.repeat(20);
const ID = 'f6'.repeat(32);
const RULES = Object.freeze({ publish: true, feeds: true, signing: true, messaging: true });
const PROMPT = 'c'.repeat(32);

let nextGuest = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');

class Guest extends EventEmitter {
  constructor({ window = 1 } = {}) {
    super();
    this.id = nextGuest++;
    this.window = window;
    this.hostWebContents = { id: 500 + window, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
    this.destroyed = false;
    this.events = [];
    this.mainFrame = this.frame('about:blank');
  }

  frame(url) {
    return {
      url,
      frameTreeNodeId: 1000 + this.id,
      processId: 1,
      routingId: this.id,
      detached: false,
      send: jest.fn((_channel, message) => this.events.push([message.event, message.data])),
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

function quietLog() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/**
 * The node's transport the parent captures (`antBackend()`'s shape): each
 * dial answered by its path's route, or `{}`; a dial's abort rejects it.
 */
function fakeNode() {
  const node = { url: NODE_URL, dials: [], routes: new Map() };
  node.request = ({ path, method, signal }) => {
    const dial = { path, method, signal };
    node.dials.push(dial);
    const route = node.routes.get(path) || (() => new Response('{}', { status: 200 }));
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      Promise.resolve(route(dial)).then(resolve, reject);
    });
  };
  return node;
}

const harnesses = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.core().release();
    await harness.client.stop();
  }
  mockSpi.executeSwarmMethod.mockClear();
});

/**
 * Main's page dispatcher with window.swarm on the core's backend: its
 * grants and stores are the test's (`state`), its backend the scripted core.
 */
async function setup({ poolBytes, rules = RULES, custody = false } = {}) {
  const pool = new SwarmIoPool(poolBytes);
  const node = fakeNode();
  const harness = await startSwarmCore({
    log: quietLog(),
    deps: {
      backendKind: () => 'core',
      nodeUrl: () => node.url,
      pool,
      publishReadiness: async () => ({ ok: true }),
      // The executor's clock is the dispatcher's.
      now: () => NOW,
    },
  });
  harnesses.push(harness);
  const { client, shell } = harness;
  // What each parent was opened with.
  const opened = [];
  const open = shell.open.bind(shell);
  shell.open = (sent, capture) => {
    opened.push({ sent, capture });
    return open(sent, capture);
  };
  // Main's one registry of the core's page requests, and the one handler of
  // the core's recheck on it: the EIP-1193 relay's.
  const coreRequests = createCoreRequests();
  createEip1193Relay({ coreRequests, coreClient: () => client }).attach(client);

  const guests = new Map();
  const names = new Map();
  const resolver = { held: null };
  const state = {
    grants: new Map([[KEY, { autoApprove: { ...rules } }], [OTHER_KEY, { autoApprove: { ...rules } }]]),
    messaging: true,
    feedGrant: true,
    custody,
    agent: false,
  };
  const documents = createPageDocuments({
    isPrivateWebContents: () => false,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent: async (name) => {
      if (resolver.held) {
        const key = await new Promise((resolve) => resolver.held.push(resolve));
        return { type: 'ok', protocol: 'ipns', decoded: key };
      }
      const key = names.get(name);
      return key ? { type: 'ok', protocol: 'ipns', decoded: key } : { type: 'not_found' };
    },
  });
  const registry = {
    unsubscribeDocument: jest.fn(),
    cancelByDocument: jest.fn(),
  };
  const vaultTimer = jest.fn();
  const routeToSetup = jest.fn();
  const coreDeps = {
    coreClient: () => client,
    swarmShell: () => shell,
    coreRequests,
    pool,
    nodeBackend: () => node,
    resetVaultTimer: vaultTimer,
    subscriptions: () => registry,
    now: () => NOW,
    log: quietLog(),
  };
  const dispatchers = createSwarmDispatchers({
    identityWalletEnabled: () => true,
    grantsLoaded: async () => true,
    getPermission: (key) => state.grants.get(key) || null,
    grantPermission: async (key) => state.grants.set(key, { autoApprove: {} }),
    updateLastUsed: async () => {},
    hasMessagingGrant: () => state.messaging,
    grantMessaging: async () => {
      state.messaging = true;
    },
    getAutoApprove: (key, type) => state.grants.get(key)?.autoApprove?.[type] === true,
    setAutoApprove: async () => {},
    lockOrigin: (_key, task) => task(),
    checkManifest: async () => ({ kind: 'legacy' }),
    decideManifest: async () => ({ allowed: true }),
    releaseManifest: () => {},
    guestContents: (id) => guests.get(id),
    inCustody: () => state.custody,
    isVaultUnlocked: async () => true,
    hasFeedGrant: () => state.feedGrant,
    identityState: async () => ({ identities: [], activeIdentityId: null }),
    previewIdentity: async () => ({ id: 'app-scoped:1', mode: 'app-scoped', label: '', owner: null, publisherKeyIndex: 1 }),
    createIdentityAt: () => {},
    ensureAntWalletIdentity: () => {},
    activateIdentity: () => {},
    assertFeedGrantable: () => {},
    grantFeedAccess: () => {},
    routeToSetup,
    ...swarmCoreDependencies(coreDeps),
  });
  const sent = [];
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers,
    setTimer: () => ({}),
    clearTimer: () => {},
    chromeWindowOf: (contents) => (contents?.id >= 500 ? contents.id - 500 : null),
    sendToWindow: (windowId, channel, payload) => sent.push([windowId, channel, payload]),
    watchWindow: () => {},
    isAgentGuest: () => state.agent,
  });

  function tab(url = `${KEY}/app`, { bind = null } = {}) {
    const guest = new Guest();
    guests.set(guest.id, guest);
    requests.track(guest);
    if (bind) {
      requests.bindName({ sender: guest.hostWebContents }, { guest: guest.id, name: bind, key: url.slice(7).split('/')[0] });
    }
    guest.commit(url);
    const n = nonce();
    const greeted = requests.hello(eventFrom(guest), { nonce: n });
    expect(greeted.ok).toBe(true);
    requests.foreground({ sender: { id: 501 } }, { guest: guest.id });
    return {
      guest,
      nonce: n,
      navigation: greeted.navigation,
      document: `${guest.id}:${greeted.navigation}`,
      ask: (method, params) => requests.request(eventFrom(guest), { nonce: n, provider: 'swarm', method, params }),
    };
  }

  /** A document of the DNS name over IPNS, bound to the name. */
  async function named() {
    names.set(NAME, IPNS_KEY);
    const page = tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    for (let i = 0; i < 8; i += 1) await tick();
    return page;
  }

  const core = () => harness.core();
  /** The core's `n`th `swarm.request` from main, once it has come. */
  async function swarmRequest(n = 0) {
    await until(() => core().requests('swarm.request').length > n, `swarm.request #${n}`);
    return core().requests('swarm.request')[n];
  }
  async function answer(id) {
    await until(() => core().reply(id), `main's answer to ${id}`);
    return core().reply(id);
  }
  const prompts = () => sent.filter(([, c]) => c === 'page:prompt').map(([, , p]) => p);
  const decide = (handle, approve, choices = {}) => requests.decide({ sender: { id: 501 } }, { handle, approve, choices });
  return {
    client,
    shell,
    pool,
    node,
    core,
    coreRequests,
    coreDeps,
    opened,
    state,
    names,
    resolver,
    documents,
    registry,
    vaultTimer,
    routeToSetup,
    tab,
    named,
    swarmRequest,
    answer,
    prompts,
    decide,
  };
}

const typedResult = (value) => ({ result_typed: writeTyped(value) });

/** The core's `chunk` call for address `a`, as it writes one. */
const chunkCall = (a) => ({
  form: 'chunk',
  method: 'GET',
  path: `/chunks/${a}`,
  query: [],
  headers: [],
  max_bytes: 4201,
  stream: false,
});

// Each method as a page asks it, and how main approved it with every rule
// on: `auto` for an upload, a send and a feed write, none for the rest.
const METHODS = [
  ['swarm_getCapabilities', {}, null],
  ['swarm_readChunk', { reference: REF }, null],
  ['swarm_readData', { reference: REF }, null],
  ['swarm_readSingleOwnerChunk', { owner: OWNER, identifier: ID }, null],
  ['swarm_readFeedEntry', { topic: TOPIC, owner: OWNER, index: 3 }, null],
  ['swarm_listFeeds', {}, null],
  ['swarm_requestAccess', {}, null],
  ['swarm_getMessagingIdentity', {}, null],
  ['swarm_subscribe', { kind: 'pss', topic: 'chat' }, null],
  ['swarm_sendPss', { topic: 'chat', target: '00', recipient: `02${'28'.repeat(32)}`, data: 'hi' }, 'auto'],
  ['swarm_sendGsoc', { address: REF, data: new Uint8Array([1, 2]) }, 'auto'],
  ['swarm_publishData', { data: 'hello', contentType: 'text/plain', name: 'h.txt' }, 'auto'],
  ['swarm_publishFiles', { files: [{ path: 'a.txt', bytes: new Uint8Array([7]) }], indexDocument: 'a.txt' }, 'auto'],
  ['swarm_publishChunk', { data: new Uint8Array([1, 2, 3]) }, 'auto'],
  ['swarm_getUploadStatus', { tagUid: 5 }, null],
  ['swarm_createFeed', { name: 'blog' }, 'auto'],
  ['swarm_updateFeed', { feedId: 'blog', reference: REF }, 'auto'],
  ['swarm_writeFeedEntry', { name: 'blog', data: 'entry' }, 'auto'],
  ['swarm_writeSingleOwnerChunk', { identifier: ID, data: new Uint8Array([4]) }, 'auto'],
  ['swarm_getSigningIdentity', {}, 'auto'],
];

describe("each window.swarm method goes to the core as swarm.request (0015's protocol, D5)", () => {
  test.each(METHODS)('%s', async (method, params, approval) => {
    const env = await setup();
    const page = env.tab();
    const asked = page.ask(method, params);
    const request = await env.swarmRequest();
    const timer = methodRow('swarm', method).timeoutMs;
    // The page's typed params, its approval and its timer.
    const expected = { method: { string: method }, params: writePageParams(method, params).typed };
    if (approval) expected.approval = approval;
    expected.deadline_ms = timer;
    expect(request.params).toEqual(expected);
    // Under `page`, with the request's PageContext.
    expect(request.context).toEqual({
      caller: 'page',
      page: { origin: KEY, top_origin: KEY, frame: 1000 + page.guest.id, navigation: page.navigation, agent: false },
    });
    // Its parent, opened as it was sent, with everything the core's calls
    // may use: the row the params give, those params read back, the key,
    // the node captured then, the request's signal and its deadline.
    expect(env.opened).toHaveLength(1);
    const [{ sent, capture }] = env.opened;
    expect(sent.id).toBe(request.id);
    const back = readTyped(request.params.params);
    expect(capture.row).toBe(rowFor(method, back));
    expect(capture.params).toEqual(back);
    expect(capture.key).toBe(KEY);
    expect(capture.backend).toBe(env.node);
    expect(capture.signal).toBeInstanceOf(AbortSignal);
    expect(capture.deadlineAt).toBe(NOW + timer);
    expect(capture.parts).toEqual(new Map());
    expect(env.shell.stats().parents).toBe(1);
    expect(env.coreRequests.size('swarm')).toBe(1);
    if (method === 'swarm_subscribe') {
      // D16's capture (PR 7.3): the document the subscription is bound to,
      // and its messages to that document alone.
      expect(capture.subscriber.document).toBe(page.document);
      await capture.subscriber.deliverTo({ message: 'm' });
      expect(page.guest.events).toContainEqual(['message', { message: 'm' }]);
    } else {
      expect(capture.subscriber).toBeNull();
    }
    env.core().respond(request.id, typedResult({ ok: true, span: 2n ** 60n, missing: undefined }));
    expect(await asked).toEqual({ result: { ok: true, span: 2n ** 60n, missing: undefined } });
    // The parent ends with the answer, and the request leaves the registry.
    expect(env.shell.stats().parents).toBe(0);
    expect(env.coreRequests.size()).toBe(0);
    expect(env.vaultTimer).toHaveBeenCalledTimes(VAULT_TIMER_METHODS.has(method) ? 1 : 0);
    // The JS backend is never reached.
    expect(mockSpi.executeSwarmMethod).not.toHaveBeenCalled();
  });

  test('the two timers: 60 s for a chunk read, 300 s for an upload', async () => {
    expect(methodRow('swarm', 'swarm_readChunk').timeoutMs).toBe(60_000);
    expect(methodRow('swarm', 'swarm_publishData').timeoutMs).toBe(300_000);
  });

  test("an upload past 64 KiB names a part, and its parent holds the page's own bytes", async () => {
    const env = await setup();
    const page = env.tab();
    const data = new Uint8Array(100 * KIB).fill(3);
    const asked = page.ask('swarm_publishData', { data });
    const request = await env.swarmRequest();
    expect(request.params.params).toEqual({
      object: [['data', { bytes: 100 * KIB, kind: 'Uint8Array', part: 0 }]],
    });
    const [{ capture }] = env.opened;
    expect(capture.parts.get(0)).toBe(data);
    expect(capture.row).toBe('publishData');
    env.core().respond(request.id, typedResult({ reference: REF }));
    expect(await asked).toEqual({ result: { reference: REF } });
  });

  test("approval: `user` once main's prompt is approved, `auto` for the site's rule", async () => {
    const env = await setup({ rules: { publish: false } });
    const page = env.tab();
    const asked = page.ask('swarm_publishData', { data: 'x' });
    await until(() => env.prompts().length === 1, 'the publish prompt');
    const [prompt] = env.prompts();
    expect(prompt.kind).toBe('swarm.publish');
    // The decision settles once the request it decided has its answer.
    const decided = env.decide(prompt.handle, true, {});
    const request = await env.swarmRequest();
    expect(request.params.approval).toBe('user');
    env.core().respond(request.id, typedResult({ reference: REF }));
    expect(await asked).toEqual({ result: { reference: REF } });
    expect(await decided).toEqual({ ok: true });
    // With custody, no rule answers: the prompt again, and `user`.
    env.state.grants.get(KEY).autoApprove.publish = true;
    env.state.custody = true;
    const second = page.ask('swarm_publishData', { data: 'y' });
    await until(() => env.prompts().length === 2, 'the second prompt');
    env.decide(env.prompts()[1].handle, true, {});
    expect((await env.swarmRequest(1)).params.approval).toBe('user');
    env.core().respond((await env.swarmRequest(1)).id, typedResult({ reference: REF }));
    await second;
    env.state.custody = false;
    const third = page.ask('swarm_publishData', { data: 'z' });
    expect((await env.swarmRequest(2)).params.approval).toBe('auto');
    env.core().respond((await env.swarmRequest(2)).id, typedResult({ reference: REF }));
    await third;
  });

  test('a document of a DNS name over IPNS goes with its transport key', async () => {
    const env = await setup();
    const page = await env.named();
    const asked = page.ask('swarm_readChunk', { reference: REF });
    const request = await env.swarmRequest();
    expect(request.context.page.transport_key).toBe(`ipns://${IPNS_KEY}`);
    expect(request.context.page.origin).not.toBe(request.context.page.transport_key);
    expect(env.opened[0].capture.key).toBe(request.context.page.origin);
    env.core().respond(request.id, typedResult({ data: '' }));
    expect(await asked).toEqual({ result: { data: '' } });
  });
});

describe("the core's answer as the page gets it", () => {
  test("an error with its data; a 4900 setup reason takes the user to the setup screen, as the JS backend's did", async () => {
    const env = await setup();
    const page = env.tab();
    const asked = page.ask('swarm_publishData', { data: 'x' });
    const request = await env.swarmRequest();
    const error = { code: 4900, message: 'Swarm node is not ready', data: { reason: 'node-not-ready' } };
    env.core().respond(request.id, { error_typed: writeTyped(error) });
    expect(await asked).toEqual({ error });
    expect(env.routeToSetup).toHaveBeenCalledWith(expect.objectContaining({ key: KEY }), 'node-not-ready');
    expect(env.vaultTimer).not.toHaveBeenCalled();
  });

  test.each([
    ['an untyped result', { result: 1 }],
    ['two members', { result_typed: { null: true }, error_typed: { null: true } }],
    ['bytes in a result', { result_typed: { bytes: 1, kind: 'Buffer', base64: 'YQ==' } }],
    ['an error without a code', { error_typed: writeTyped({ message: 'm' }) }],
    ['an error with more', { error_typed: writeTyped({ code: 1, message: 'm', stack: 's' }) }],
  ])('%s is -32603', async (_label, reply) => {
    const env = await setup();
    const asked = env.tab().ask('swarm_readChunk', { reference: REF });
    env.core().respond((await env.swarmRequest()).id, reply);
    expect(await asked).toEqual({
      error: { code: -32603, message: 'The identity core gave no answer for the page' },
    });
  });

  test('a protocol error is -32603 with its text', async () => {
    const env = await setup();
    const asked = env.tab().ask('swarm_readChunk', { reference: REF });
    const request = await env.swarmRequest();
    env.core().send({ type: 'response', id: request.id, error: { code: 'internal', message: 'boom' } });
    expect(await asked).toEqual({ error: { code: -32603, message: 'boom' } });
  });
});

describe("a result's charge (0015's Results for pages; PR 7.1's release)", () => {
  // A read's large answer: its data as base64 text, past 64 KiB.
  const large = { data: 'QUJD'.repeat(25 * KIB), encoding: 'base64' };

  test('held until page-requests has handed the page its answer, then released', async () => {
    const env = await setup();
    const page = await env.named();
    env.resolver.held = [];
    const asked = page.ask('swarm_readFeedEntry', { topic: TOPIC, owner: OWNER, index: 0 });
    let answered = false;
    asked.then(() => {
      answered = true;
    });
    // The name checked before the read.
    await until(() => env.resolver.held.length === 1, 'the first name check');
    env.resolver.held.shift()(IPNS_KEY);
    const request = await env.swarmRequest();
    env.core().respond(request.id, typedResult(large));
    // The dispatcher checks the name again after the read: the answer waits,
    // and its charge with it.
    await until(() => env.resolver.held.length === 1, 'the second name check');
    expect(env.pool.held).toBeGreaterThanOrEqual(2 * 100 * KIB);
    expect(answered).toBe(false);
    env.resolver.held.shift()(IPNS_KEY);
    expect(await asked).toEqual({ result: large });
    await until(() => env.pool.held === 0, 'the charge released');
  });

  test('released when the page gets another answer, or none (its document gone)', async () => {
    const env = await setup();
    const page = await env.named();
    env.resolver.held = [];
    const asked = page.ask('swarm_readFeedEntry', { topic: TOPIC, owner: OWNER, index: 0 });
    await until(() => env.resolver.held.length === 1, 'the first name check');
    env.resolver.held.shift()(IPNS_KEY);
    env.core().respond((await env.swarmRequest()).id, typedResult(large));
    await until(() => env.resolver.held.length === 1, 'the second name check');
    expect(env.pool.held).toBeGreaterThan(0);
    // The name moved meanwhile: the page hears it has no address.
    env.resolver.held.shift()(OTHER_IPNS_KEY);
    expect((await asked).error.code).toBe(4100);
    await until(() => env.pool.held === 0, 'the charge released');
  });

  test('a result main has no room for is dropped, and the page gets 4900 busy', async () => {
    const env = await setup({ poolBytes: 64 * KIB });
    const asked = env.tab().ask('swarm_readData', { reference: REF });
    env.core().respond((await env.swarmRequest()).id, typedResult(large));
    expect(await asked).toEqual({ error: { code: 4900, message: 'busy', data: { reason: 'busy' } } });
    expect(env.pool.held).toBe(0);
  });
});

describe("approval.recheck: one handler and one registry with the EIP-1193 relay (the amendment's point 7)", () => {
  test('live, read now; the Agent read live; crossed asks refused, and none once the request ends', async () => {
    const env = await setup();
    const page = env.tab();
    const asked = page.ask('swarm_readChunk', { reference: REF });
    const request = await env.swarmRequest();
    const pc = request.context.page;
    const recheck = async (params) => env.answer(env.core().ask('approval.recheck', params));
    expect((await recheck({ request: request.id, page: pc })).result).toEqual({ live: true, agent: false });
    env.state.agent = true;
    expect((await recheck({ request: request.id, page: pc })).result).toEqual({ live: true, agent: true });
    env.state.agent = false;
    // Crossed: another PageContext, a member past the two, a request main
    // doesn't hold, and the relay's own asks for a Swarm request.
    const crossed = [
      ['approval.recheck', { request: request.id, page: { ...pc, navigation: pc.navigation + 1 } }],
      ['approval.recheck', { request: request.id, page: { ...pc, transport_key: `ipns://${IPNS_KEY}` } }],
      ['approval.recheck', { request: request.id, page: pc, extra: 1 }],
      ['approval.recheck', { request: request.id + 7, page: pc }],
      [
        'approval.request',
        { request: request.id, prompt: PROMPT, page: pc, kind: 'eth.connect', view: {}, choices: {} },
      ],
      ['eip1193.select_chain', { request: request.id, page: pc, chain_id: 100 }],
    ];
    for (const [method, params] of crossed) {
      const reply = await env.answer(env.core().ask(method, params));
      expect(reply.error).toMatchObject({ code: 'invalid_argument' });
    }
    env.core().respond(request.id, typedResult({ data: '' }));
    await asked;
    expect((await recheck({ request: request.id, page: pc })).error).toMatchObject({ code: 'invalid_argument' });
  });

  test("not live once the document no longer holds its key; a bound page's transport key echoed exactly", async () => {
    const env = await setup();
    const page = await env.named();
    const asked = page.ask('swarm_readChunk', { reference: REF });
    const request = await env.swarmRequest();
    const pc = request.context.page;
    const recheck = async (params) => env.answer(env.core().ask('approval.recheck', params));
    expect((await recheck({ request: request.id, page: pc })).result).toEqual({ live: true, agent: false });
    const { transport_key: _dropped, ...unbound } = pc;
    expect((await recheck({ request: request.id, page: unbound })).error).toMatchObject({ code: 'invalid_argument' });
    // Main's own check of the name finds it moved: the binding ends.
    env.names.set(NAME, OTHER_IPNS_KEY);
    await env.documents.recheckName({ guest: page.guest.id, navigation: page.navigation, nonce: page.nonce, key: pc.origin });
    expect((await recheck({ request: request.id, page: pc })).result).toEqual({ live: false, agent: false });
    env.core().respond(request.id, typedResult({ data: '' }));
    await asked;
  });
});

describe("main's own: one registry for both dispatchers", () => {
  const page = { origin: KEY, top_origin: KEY, frame: 1001, navigation: 1, agent: false };

  test("main's relay serves the recheck of a Swarm request on the shared registry, and only the recheck", async () => {
    const { getEip1193Relay } = require('./page-eip1193');
    const { getCoreRequests } = require('./page-core-requests');
    const context = {
      signal: new AbortController().signal,
      isCurrent: () => true,
      holdsKey: () => true,
      pageContext: () => ({ agent: true }),
    };
    const remove = getCoreRequests().add(9, 4, { family: 'swarm', context, page });
    const relay = getEip1193Relay();
    expect(await relay.approvalRecheck({ request: 4, page }, { generation: 9 })).toEqual({ live: true, agent: true });
    await expect(
      relay.approvalRequest(
        { request: 4, prompt: PROMPT, page, kind: 'eth.connect', view: {}, choices: {} },
        { generation: 9 }
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(relay.running()).toBe(0);
    remove();
    await expect(relay.approvalRecheck({ request: 4, page }, { generation: 9 })).rejects.toMatchObject({
      code: 'invalid_argument',
    });
  });

  test('the dispatcher registers its requests there by default', async () => {
    const { getCoreRequests } = require('./page-core-requests');
    const env = await setup();
    const { coreRequests: _own, ...deps } = env.coreDeps;
    const execute = createSwarmCoreExecute(deps);
    const context = {
      requester: { key: KEY, topKey: KEY, transportKey: KEY, guest: 1, navigation: 1 },
      pageContext: () => page,
      signal: new AbortController().signal,
      isCurrent: () => true,
      holdsKey: () => true,
      whenAnswered: async () => ({ delivered: true }),
    };
    const out = execute('swarm_readChunk', { reference: REF }, KEY, undefined, { context });
    const request = await env.swarmRequest();
    expect(getCoreRequests().size('swarm')).toBe(1);
    const recheck = await env.answer(env.core().ask('approval.recheck', { request: request.id, page }));
    // The test's own relay serves its own registry only.
    expect(recheck.error).toMatchObject({ code: 'invalid_argument' });
    env.core().respond(request.id, typedResult({ data: '' }));
    expect(await out).toEqual({ result: { data: '' } });
    expect(getCoreRequests().size()).toBe(0);
  });
});

describe('cancel at each step (0015, Deadlines and cancel)', () => {
  test('before it is sent: nothing goes, and no parent opens', async () => {
    const env = await setup();
    const execute = createSwarmCoreExecute(env.coreDeps);
    const context = {
      requester: { key: KEY, topKey: KEY, transportKey: KEY, guest: 1, navigation: 1 },
      pageContext: () => ({ origin: KEY, top_origin: KEY, frame: 1001, navigation: 1, agent: false }),
      signal: AbortSignal.abort(),
      whenAnswered: async () => ({ delivered: false }),
    };
    const out = await execute('swarm_readChunk', { reference: REF }, KEY, undefined, { context });
    expect(out.error.code).toBe(-32603);
    await tick();
    expect(env.core().requests('swarm.request')).toHaveLength(0);
    expect(env.opened).toHaveLength(0);
    expect(env.coreRequests.size()).toBe(0);
  });

  test('while the core asks main: the request cancelled and its parent ended, the dial stopped; the ask answered cancelled at the core\'s cancel', async () => {
    const env = await setup();
    env.node.routes.set('/node', () => new Promise(() => {}));
    const page = env.tab();
    const asked = page.ask('swarm_readChunk', { reference: REF });
    const request = await env.swarmRequest();
    const ready = env.core().ready(request.id, 'reachable');
    await until(() => env.node.dials.length === 1, 'the probe dialled');
    // The document goes.
    page.guest.commit(`${OTHER_KEY}/`);
    await asked;
    await until(
      () => env.core().messages.some((m) => m?.type === 'cancel' && m.id === request.id),
      "main's cancel of the request"
    );
    expect(env.node.dials[0].signal.aborted).toBe(true);
    expect(env.shell.stats().parents).toBe(0);
    expect(env.coreRequests.size()).toBe(0);
    for (let i = 0; i < 10; i += 1) await tick();
    expect(env.core().reply(ready)).toBeUndefined();
    env.core().cancel(ready);
    expect((await env.answer(ready)).error).toMatchObject({ code: 'cancelled' });
    expect(env.registry.cancelByDocument).not.toHaveBeenCalled();
  });

  test('while a body streams: the stream aborted, and the pool back at 0', async () => {
    const env = await setup();
    let controller;
    env.node.routes.set(
      `/feeds/${OWNER}/${TOPIC}`,
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              controller = c;
              c.enqueue(new Uint8Array(1000).fill(1));
            },
          }),
          { status: 200 }
        )
    );
    const page = env.tab();
    const asked = page.ask('swarm_readFeedEntry', { topic: TOPIC, owner: OWNER });
    const request = await env.swarmRequest();
    expect(env.opened[0].capture.row).toBe('readFeedEntry_latest');
    const ready = env.core().ready(request.id, 'reachable');
    expect((await env.answer(ready)).result).toEqual({ ok: true });
    const call = env.core().api(request.id, {
      form: 'feed_latest',
      method: 'GET',
      path: `/feeds/${OWNER}/${TOPIC}`,
      query: [],
      headers: [],
      max_bytes: 5 * KIB * KIB,
      stream: true,
    });
    expect((await env.answer(call)).result).toMatchObject({ status: 200 });
    await until(() => env.core().dataOf(call).length === 1000, 'the first bytes');
    expect(env.pool.held).toBeGreaterThan(0);
    page.guest.commit(`${OTHER_KEY}/`);
    await asked;
    await until(() => env.core().terminal(call), "the stream's terminal");
    expect(env.core().terminal(call)).toMatchObject({ kind: KIND_ABORT });
    expect(env.core().messages.some((m) => m?.type === 'cancel' && m.id === request.id)).toBe(true);
    await until(() => env.pool.held === 0 && env.shell.stats().calls === 0, 'the pool at 0');
    // The node's body was let go of.
    expect(() => controller.enqueue(new Uint8Array(1))).toThrow();
  });

  test('after the answer: nothing cancelled, and a late call for the ended parent refused', async () => {
    const env = await setup();
    const page = env.tab();
    const asked = page.ask('swarm_readChunk', { reference: REF });
    const request = await env.swarmRequest();
    env.core().respond(request.id, typedResult({ data: '' }));
    expect(await asked).toEqual({ result: { data: '' } });
    page.guest.commit(`${OTHER_KEY}/`);
    for (let i = 0; i < 10; i += 1) await tick();
    expect(env.core().messages.some((m) => m?.type === 'cancel')).toBe(false);
    const late = env.core().api(request.id, chunkCall(REF));
    expect((await env.answer(late)).error).toMatchObject({ code: 'invalid_argument', data: { rule: 'ended' } });
    expect(env.node.dials).toHaveLength(0);
  });
});

describe("a page's request names only its own parent", () => {
  test("another document's PageContext, part or address is refused", async () => {
    const env = await setup();
    const a = env.tab();
    const b = env.tab(`${OTHER_KEY}/app`);
    const askedA = a.ask('swarm_readChunk', { reference: REF });
    const reqA = await env.swarmRequest(0);
    const askedB = b.ask('swarm_publishData', { data: new Uint8Array(70 * KIB) });
    const reqB = await env.swarmRequest(1);
    expect(env.opened[1].capture.parts.size).toBe(1);
    // A's request under B's PageContext.
    const crossed = await env.answer(env.core().ask('approval.recheck', { request: reqA.id, page: reqB.context.page }));
    expect(crossed.error).toMatchObject({ code: 'invalid_argument' });
    // B's part, asked under A's parent: refused, and A's parent refuses
    // everything after it.
    const part = await env.answer(env.core().part(reqA.id, 0));
    expect(part.error).toMatchObject({ code: 'invalid_argument', data: { rule: 'value' } });
    const after = await env.answer(env.core().api(reqA.id, chunkCall(REF)));
    expect(after.error).toMatchObject({ code: 'invalid_argument', data: { rule: 'ended' } });
    // B's address under a parent of A's whose params name another.
    const askedA2 = a.ask('swarm_readChunk', { reference: REF });
    const reqA2 = await env.swarmRequest(2);
    expect((await env.answer(env.core().ready(reqA2.id, 'reachable'))).result).toEqual({ ok: true });
    const other = await env.answer(env.core().api(reqA2.id, chunkCall(OTHER_REF)));
    expect(other.error).toMatchObject({ code: 'invalid_argument', data: { rule: 'value' } });
    // Only the ready check's probe was dialled.
    expect(env.node.dials.map((d) => d.path)).toEqual(['/node']);
    env.core().respond(reqA.id, typedResult({ data: '' }));
    env.core().respond(reqA2.id, typedResult({ data: '' }));
    env.core().respond(reqB.id, typedResult({ reference: REF }));
    await Promise.all([askedA, askedA2, askedB]);
  });
});

describe('swarm_unsubscribe never reaches the core (D5)', () => {
  test("main ends one of the document's own subscriptions, with the JS backend's answers", async () => {
    const env = await setup();
    const page = env.tab();
    expect(await page.ask('swarm_unsubscribe', { subscriptionId: 's1' })).toEqual({ result: { unsubscribed: true } });
    expect(env.registry.unsubscribeDocument).toHaveBeenCalledWith(page.document, 's1');
    env.registry.unsubscribeDocument.mockImplementationOnce(() => {
      throw Object.assign(new Error('Subscription not found'), { reason: 'subscription_not_found' });
    });
    expect(await page.ask('swarm_unsubscribe', { subscriptionId: 's2' })).toEqual({
      error: { code: -32602, message: 'Subscription not found', data: { reason: 'subscription_not_found' } },
    });
    expect(await page.ask('swarm_unsubscribe', { subscriptionId: '' })).toEqual({
      error: { code: -32602, message: 'subscriptionId is required', data: { reason: 'invalid_params' } },
    });
    expect(env.core().requests('swarm.request')).toHaveLength(0);
    expect(mockSpi.executeSwarmMethod).not.toHaveBeenCalled();
  });
});

describe('the JS path, unchanged until the flip', () => {
  test("page-swarm.js's own execute is the JS backend's, with exactly its four arguments", async () => {
    const dispatchers = createSwarmDispatchers({ identityWalletEnabled: () => true });
    const context = {
      requester: { key: KEY, guest: 1, navigation: 1 },
      method: 'swarm_readChunk',
      params: { reference: REF },
    };
    expect(await dispatchers['swarm:swarm_readChunk'](context)).toEqual({ result: 'js' });
    expect(mockSpi.executeSwarmMethod).toHaveBeenCalledTimes(1);
    expect(mockSpi.executeSwarmMethod.mock.calls[0]).toEqual(['swarm_readChunk', { reference: REF }, KEY, undefined]);
  });
});
