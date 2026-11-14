// Swarm connecting, the manifest check and messaging through main
// (freedom-core design 0011, PRQ-7b), against the PRQ-7 row. Main's real
// request path (page-documents, page-requests, its prompts) runs the
// dispatcher (page-swarm.js) over main's real executeSwarmMethod,
// subscription registry and Swarm permission store; the node's messaging
// sockets and sends are in memory. Each guest's main frame records what
// main sends it (`page:event`), so a test sees which document heard what.

const os = require('os');
const { useSimulatedGrantCore, testPage } = require('../../../test/helpers/simulated-grant-core');
const fs = require('fs');
const path = require('path');

const mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'page-swarm-connect-'));
const mockIpcHandlers = {};
jest.mock('electron', () => ({
  app: { getPath: () => mockUserData },
  ipcMain: {
    handle: (channel, handler) => {
      mockIpcHandlers[channel] = handler;
    },
    removeHandler: () => {},
  },
  webContents: { fromId: () => null },
}));
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// The node's messaging: sockets a test feeds by hand, and sends it records.
const mockNode = {
  sockets: new Map(),
  sent: [],
  establish: null,
  readiness: null,
};
jest.mock('../swarm/messaging-service', () => ({
  MAX_MESSAGE_BYTES: 4000,
  MAX_TARGET_DEPTH: 3,
  DEFAULT_TARGET_DEPTH: 2,
  getMessagingIdentity: async () => ({ pssPublicKey: `02${'a'.repeat(64)}`, overlay: 'f'.repeat(64) }),
  resolvePssTopicHex: (topic) => Buffer.from(topic).toString('hex').padEnd(64, '0').slice(0, 64),
  deriveGsoc: async () => ({ address: 'e'.repeat(64) }),
  sendPss: async (message) => {
    mockNode.sent.push(['pss', message.topic]);
  },
  sendGsoc: async (message) => {
    mockNode.sent.push(['gsoc', message.topic]);
    return { address: 'e'.repeat(64) };
  },
  openSubscriptionSocket: ({ kind, key }, { onMessage }) => {
    const socket = { kind, key, onMessage, cancelled: false, cancel: () => { socket.cancelled = true; } };
    socket.established = mockNode.establish ? mockNode.establish : Promise.resolve();
    mockNode.sockets.set(`${kind}:${key}`, socket);
    return socket;
  },
}));
jest.mock('../service-registry', () => ({ getAntApiUrl: () => 'http://127.0.0.1:1633' }));
jest.mock('../swarm/publish-setup-service', () => ({
  getPublishReadiness: async () => (mockNode.readiness ? mockNode.readiness : { ok: true }),
}));
jest.mock('../swarm/chunk-service', () => ({}));
jest.mock('../swarm/feed-service', () => ({ buildTopicString: (o, n) => `${o}/${n}` }));
jest.mock('../swarm/feed-store', () => ({
  getAllFeeds: () => ({}),
  getFeed: () => null,
  getOriginEntry: () => null,
  hasFeedGrant: () => false,
  onManifestMutation: () => {},
}));
jest.mock('../swarm/publish-service', () => ({}));
jest.mock('../swarm/publish-history', () => ({ addEntry: () => ({ id: 1 }), updateEntry: () => {} }));
jest.mock('../swarm/swarm-signer', () => ({ resolveSwarmSigner: jest.fn(), getIdentityMode: () => null }));

global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) }));

const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { createSwarmDispatchers, registerSwarmPageEvents } = require('./page-swarm');
const permissions = require('../swarm/swarm-permissions');
const registry = require('../swarm/subscription-registry');
const { registerSwarmProviderIpc } = require('../swarm/swarm-provider-ipc');

registerSwarmProviderIpc();
permissions.registerSwarmPermissionsIpc();

const CHROME_URL = 'file:///app/src/renderer/index.html';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';
const RECIPIENT = `02${'c'.repeat(64)}`;
const PSS = { topic: 'room', recipient: RECIPIENT, targets: 'abcd', data: 'hello' };

const NO_ADDRESS = {
  error: { code: 4100, message: 'This page has no address to connect from yet', data: { reason: 'no_address' } },
};
const AGENT_CUSTODY = {
  error: { code: 4100, message: 'The origin is not authorized for this operation', data: { reason: 'agent_custody' } },
};
const NOT_CONNECTED = { error: { code: 4100, message: 'Origin not authorized. Call swarm_requestAccess first.' } };
const REJECTED = { error: { code: 4001, message: 'User rejected the request' } };

let nextId = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

class Guest extends EventEmitter {
  constructor({ window = 1 } = {}) {
    super();
    this.id = nextId++;
    this.window = window;
    this.hostWebContents = { id: 500 + window, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
    this.destroyed = false;
    // Every page:event main sent this guest's main frame, whichever
    // document was in it.
    this.delivered = [];
    this.mainFrame = this.frame('about:blank');
  }

  frame(url) {
    return {
      url,
      frameTreeNodeId: 1000 + this.id,
      processId: 1,
      routingId: this.id,
      detached: false,
      send: jest.fn((_channel, message) => this.delivered.push(message)),
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

function setup() {
  const guests = new Map();
  const names = new Map();
  const resolutions = [];
  // A test may hold every resolution until it lets them go.
  const gate = { held: null };
  const documents = createPageDocuments({
    isPrivateWebContents: () => false,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent: async (name) => {
      resolutions.push(name);
      if (gate.held) await gate.held;
      const key = names.get(name);
      return key ? { type: 'ok', protocol: 'ipns', decoded: key } : { type: 'not_found' };
    },
  });
  const state = {
    custody: new Set(),
    // The manifest check main runs: `legacy` unless a test says otherwise.
    manifest: async () => ({ kind: 'legacy' }),
    checks: [],
    decisions: [],
    // Main's page consents waiting on a decision, as a test mints them.
    pool: new Set(),
    releases: [],
    decide: (key, token, outcome) => ({ allowed: outcome !== 'deny', mode: outcome }),
  };
  const sent = [];
  const trace = [];
  const timers = [];
  const hooks = { onTrace: (entry) => trace.push(entry) };
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers: createSwarmDispatchers({
      identityWalletEnabled: () => true,
      inCustody: (guest) => state.custody.has(guest),
      guestContents: (id) => guests.get(id),
      checkManifest: async (request) => {
        state.checks.push({ key: request.key, url: request.url, guest: request.guest?.id, eager: request.eager });
        return state.manifest(request);
      },
      // Main's real lock and guard order: the name checked again, then the
      // document's key and the decision in one run. A decision, refused or
      // not, spends the consent, as main's pool does.
      decideManifest: async (key, token, outcome, guard) => {
        if (!(await guard.recheck()) || !guard.holds()) {
          state.pool.delete(token);
          return { refused: true };
        }
        state.pool.delete(token);
        state.decisions.push({ key, token, outcome });
        return state.decide(key, token, outcome);
      },
      releaseManifest: (token) => {
        state.releases.push(token);
        state.pool.delete(token);
      },
    }),
    hooks,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
    chromeWindowOf: (contents) => (contents?.id >= 500 ? contents.id - 500 : null),
    sendToWindow: (windowId, channel, payload) => sent.push([windowId, channel, payload]),
    watchWindow: () => {},
  });
  const stopEvents = registerSwarmPageEvents(requests);

  function greet(guest) {
    const n = nonce();
    expect(requests.hello(eventFrom(guest), { nonce: n }).ok).toBe(true);
    return {
      guest,
      nonce: n,
      ask: (method, params = {}) => requests.request(eventFrom(guest), { nonce: n, provider: 'swarm', method, params }),
      // What this document heard: the events main sent it with its nonce.
      heard: () => guest.delivered.filter((m) => m.nonce === n).map((m) => [m.event, m.data]),
    };
  }

  function tab(url = `${KEY_A}/app`, { window = 1, bind = null, front = true } = {}) {
    const guest = new Guest({ window });
    guests.set(guest.id, guest);
    requests.track(guest);
    if (bind) {
      expect(requests.bindName({ sender: guest.hostWebContents }, { guest: guest.id, name: bind, key: url.slice(7).split('/')[0] })).toBe(true);
    }
    guest.commit(url);
    const page = greet(guest);
    if (front) requests.foreground({ sender: { id: 500 + window } }, { guest: guest.id });
    return page;
  }

  async function named() {
    names.set(NAME, IPNS_KEY);
    const page = tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    await flush();
    resolutions.length = 0;
    return page;
  }

  // Main's deadline for every request whose timer is `ms` and still running.
  const fire = (ms) => {
    for (const timer of timers.filter((t) => t.ms === ms && !t.cleared)) {
      timer.cleared = true;
      timer.fn();
    }
  };
  const prompts = (windowId = 1) => sent.filter(([w, c]) => w === windowId && c === 'page:prompt').map(([, , p]) => p);
  const decide = (handle, approve, choices, windowId = 1) =>
    requests.decide({ sender: { id: 500 + windowId } }, { handle, approve, choices });
  // The prompt now shown, once it has.
  async function shown(kind) {
    await flush();
    const prompt = prompts().at(-1);
    expect(prompt?.kind).toBe(kind);
    return prompt;
  }

  return { requests, documents, state, sent, trace, tab, greet, named, names, resolutions, gate, prompts, decide, shown, guests, hooks, stopEvents, fire };
}

const connect = (key) => permissions.grantPermission(key, { page: testPage(key) });

beforeEach(async () => {
  await useSimulatedGrantCore();
  registry._reset();
  mockNode.sockets.clear();
  mockNode.sent = [];
  mockNode.establish = null;
  mockNode.readiness = null;
  permissions.onRevoke(null);
  // swarm-provider-ipc's own listener: subscriptions end with their grant.
  permissions.onRevoke((origin) => registry.cancelByOrigin(origin));
});

afterAll(() => {
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

describe('swarm_requestAccess through main (0011 PRQ-7b)', () => {
  test('main prompts, writes the grant for the attested key on approval, and every live document of the key hears connect', async () => {
    const env = setup();
    const page = env.tab(`${KEY_A}/app`);
    const sibling = env.tab(`${KEY_A}/other`, { front: false });
    const stranger = env.tab(`${KEY_B}/`, { front: false });
    const answer = page.ask('swarm_requestAccess');
    const prompt = await env.shown('swarm.connect');
    expect(prompt).toEqual({ handle: expect.any(String), guest: page.guest.id, kind: 'swarm.connect', site: { key: KEY_A, label: KEY_A }, view: {} });
    expect(permissions.getPermission(KEY_A)).toBeNull();
    // The chrome names no site: a decision with one is refused.
    expect(await env.decide(prompt.handle, true, { site: KEY_B })).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(prompt.handle, true)).toEqual({ ok: true });
    expect(await answer).toEqual({ result: { connected: true, origin: KEY_A, capabilities: ['publish'] } });
    expect(permissions.getPermission(KEY_A)).toMatchObject({ origin: KEY_A });
    expect(permissions.getPermission(KEY_B)).toBeNull();
    await flush();
    expect(page.heard()).toEqual([['connect', { origin: KEY_A }]]);
    expect(sibling.heard()).toEqual([['connect', { origin: KEY_A }]]);
    expect(stranger.heard()).toEqual([]);
  });

  test('a rejection connects nothing and tells nothing; a connected site is marked used, with no prompt and no connect', async () => {
    const env = setup();
    const page = env.tab();
    const answer = page.ask('swarm_requestAccess');
    const prompt = await env.shown('swarm.connect');
    await env.decide(prompt.handle, false);
    expect(await answer).toEqual({ error: { code: 4001, message: 'User rejected Swarm access' } });
    expect(permissions.getPermission(KEY_A)).toBeNull();

    await connect(KEY_A);
    const before = permissions.getPermission(KEY_A).lastUsed;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const count = env.prompts().length;
    expect(await page.ask('swarm_requestAccess')).toEqual({ result: { connected: true, origin: KEY_A, capabilities: ['publish'] } });
    expect(env.prompts()).toHaveLength(count);
    expect(permissions.getPermission(KEY_A).lastUsed).toBeGreaterThan(before);
    await flush();
    expect(page.heard()).toEqual([]);
  });

  test('a keyless document is refused, with no prompt', async () => {
    const env = setup();
    const page = env.tab('data:text/html,<p>x</p>');
    expect(await page.ask('swarm_requestAccess')).toEqual(NO_ADDRESS);
    expect(await page.ask('swarm_sendPss', PSS)).toEqual(NO_ADDRESS);
    expect(env.prompts()).toEqual([]);
    expect(env.state.checks).toEqual([]);
  });

  test('a name that moves off its IPNS key while its connect prompt is open gets no grant and no connect', async () => {
    const env = setup();
    const page = await env.named();
    const answer = page.ask('swarm_requestAccess');
    const prompt = await env.shown('swarm.connect');
    expect(prompt.site).toEqual({ key: NAME, label: NAME });
    env.names.set(NAME, OTHER_IPNS_KEY);
    await env.decide(prompt.handle, true);
    expect(await answer).toEqual(NO_ADDRESS);
    expect(permissions.getPermission(NAME)).toBeNull();
    await flush();
    expect(page.heard()).toEqual([]);
  });
});

describe('the permission manifest, checked by main (0011 PRQ-7b)', () => {
  const CONSENT = { kind: 'consent', token: 'tok-1', model: { origin: KEY_A, name: 'App', description: '', changed: [], removed: [] } };

  test('connecting checks eagerly, for the document\'s own URL, key and guest; the consent is main\'s prompt, and main decides it', async () => {
    const env = setup();
    env.state.manifest = async () => CONSENT;
    // The manifest's "allow" connects the site.
    env.state.decide = async (key, token, outcome) => {
      await connect(key);
      return { allowed: true, mode: outcome };
    };
    const page = env.tab(`${KEY_A}/app/index.html`);
    const answer = page.ask('swarm_requestAccess');
    const prompt = await env.shown('swarm.manifest');
    expect(env.state.checks).toEqual([{ key: KEY_A, url: `${KEY_A}/app/index.html`, guest: page.guest.id, eager: true }]);
    // The token never leaves main.
    expect(prompt.view).toEqual({ model: CONSENT.model });
    expect(JSON.stringify(env.sent)).not.toContain('tok-1');
    expect(await env.decide(prompt.handle, true, { outcome: 'everything' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(prompt.handle, true, { outcome: 'allow' })).toEqual({ ok: true });
    expect(await answer).toEqual({ result: { connected: true, origin: KEY_A, capabilities: ['publish'] } });
    expect(env.state.decisions).toEqual([{ key: KEY_A, token: 'tok-1', outcome: 'allow' }]);
    // Connected by the manifest: no connect prompt, and connect is heard.
    expect(env.prompts().map((p) => p.kind)).toEqual(['swarm.manifest']);
    await flush();
    expect(page.heard()).toEqual([['connect', { origin: KEY_A }]]);
  });

  test('a denial stands for the document; a new document is checked again', async () => {
    const env = setup();
    env.state.manifest = async () => CONSENT;
    const page = env.tab();
    const answer = page.ask('swarm_requestAccess');
    const prompt = await env.shown('swarm.manifest');
    await env.decide(prompt.handle, false);
    expect(await answer).toEqual(REJECTED);
    expect(env.state.decisions).toEqual([{ key: KEY_A, token: 'tok-1', outcome: 'deny' }]);
    expect(await page.ask('swarm_requestAccess')).toEqual(REJECTED);
    expect(env.state.checks).toHaveLength(1);
    page.guest.commit(`${KEY_A}/again`);
    const again = env.greet(page.guest);
    env.state.manifest = async () => ({ kind: 'ready' });
    const second = again.ask('swarm_requestAccess');
    await env.shown('swarm.connect');
    expect(env.state.checks).toHaveLength(2);
    second.catch(() => {});
  });

  test('messaging checks lazily, once per document; an unresolved check answers 4900 and is tried again', async () => {
    const env = setup();
    await connect(KEY_A);
    await permissions.grantMessaging(KEY_A, { page: testPage(KEY_A) });
    const page = env.tab();
    env.state.manifest = async () => ({ kind: 'unresolved' });
    expect(await page.ask('swarm_getMessagingIdentity')).toEqual({
      error: { code: 4900, message: 'Could not refresh this app’s permission manifest' },
    });
    env.state.manifest = async () => ({ kind: 'legacy' });
    expect((await page.ask('swarm_getMessagingIdentity')).result).toMatchObject({ identityMode: 'bee-wallet' });
    expect((await page.ask('swarm_getMessagingIdentity')).result).toMatchObject({ identityMode: 'bee-wallet' });
    expect(env.state.checks.map((c) => c.eager)).toEqual([false, false]);
    // Unsubscribe never checks it, as the chrome never did.
    await page.ask('swarm_unsubscribe', { subscriptionId: 'none' });
    expect(env.state.checks).toHaveLength(2);
  });

  // Codex round 2 on #1194: a page's consent goes when its request is done
  // with it, however that ends.
  test('a consent is released however its request ends: decided, refused, navigated away, at its deadline', async () => {
    const env = setup();
    let minted = 0;
    env.state.manifest = async () => {
      const token = `tok-${++minted}`;
      env.state.pool.add(token);
      return { ...CONSENT, token };
    };
    // Repeated request-and-navigate cycles leave nothing waiting.
    const page = env.tab(`${KEY_A}/app`);
    let doc = page;
    for (let i = 0; i < 5; i += 1) {
      const answer = doc.ask('swarm_requestAccess');
      await env.shown('swarm.manifest');
      expect(env.state.pool.size).toBe(1);
      page.guest.commit(`${KEY_A}/app?cycle=${i}`);
      doc = env.greet(page.guest);
      env.requests.foreground({ sender: { id: 501 } }, { guest: page.guest.id });
      expect(await answer).toEqual({ gone: true });
      await flush();
      expect({ cycle: i, waiting: env.state.pool.size }).toEqual({ cycle: i, waiting: 0 });
    }
    // A background tab's consent never shown, at its deadline.
    const background = env.tab(`${KEY_B}/`, { front: false });
    const late = background.ask('swarm_requestAccess');
    await flush();
    expect(env.state.pool.size).toBe(1);
    env.fire(60_000);
    expect(await late).toEqual({ error: { code: -32603, message: 'Request timed out' } });
    await flush();
    expect(env.state.pool.size).toBe(0);
    // Decided, and refused because the name moved.
    const answer = doc.ask('swarm_requestAccess');
    const prompt = await env.shown('swarm.manifest');
    await env.decide(prompt.handle, false);
    await answer;
    expect(env.state.pool.size).toBe(0);
    const named = await env.named();
    const refused = named.ask('swarm_requestAccess');
    const consent = await env.shown('swarm.manifest');
    env.names.set(NAME, OTHER_IPNS_KEY);
    await env.decide(consent.handle, true, { outcome: 'allow' });
    expect(await refused).toEqual(NO_ADDRESS);
    expect(env.state.pool.size).toBe(0);
    // Every consent minted was released (once its request was done; the
    // release is idempotent, and may come from both its end and its abort).
    expect(new Set(env.state.releases).size).toBe(minted);
  });

  test('a name that moves while its consent is open: nothing decided, nothing written', async () => {
    const env = setup();
    env.state.manifest = async () => CONSENT;
    const page = await env.named();
    const answer = page.ask('swarm_requestAccess');
    const prompt = await env.shown('swarm.manifest');
    env.names.set(NAME, OTHER_IPNS_KEY);
    await env.decide(prompt.handle, true, { outcome: 'allow' });
    expect(await answer).toEqual(NO_ADDRESS);
    expect(env.state.decisions).toEqual([]);
  });
});

describe('messaging through main (0011 PRQ-7b)', () => {
  test('an unconnected site is refused with no prompt; a connected one is asked for messaging, and main writes the grant', async () => {
    const env = setup();
    const page = env.tab();
    expect(await page.ask('swarm_getMessagingIdentity')).toEqual(NOT_CONNECTED);
    expect(env.prompts()).toEqual([]);

    await connect(KEY_A);
    const answer = page.ask('swarm_getMessagingIdentity');
    const prompt = await env.shown('swarm.messaging');
    expect(prompt.view).toEqual({ method: 'swarm_getMessagingIdentity', grantMode: true });
    expect(permissions.hasMessagingGrant(KEY_A)).toBe(false);
    await env.decide(prompt.handle, true);
    expect(await answer).toEqual({ result: { pssPublicKey: `02${'a'.repeat(64)}`, pssTarget: 'ffff', identityMode: 'bee-wallet' } });
    expect(permissions.hasMessagingGrant(KEY_A)).toBe(true);
    // The grant prompt offers no "always allow".
    const again = page.ask('swarm_sendPss', PSS);
    const send = await env.shown('swarm.messaging');
    expect(send.view).toEqual({ method: 'swarm_sendPss', grantMode: false, topic: 'room', size: 5 });
    await env.decide(send.handle, false);
    expect(await again).toEqual(REJECTED);
    expect(mockNode.sent).toEqual([]);
  });

  test('a send asks per message; "always allow" sets the rule, by main, and the rule then answers', async () => {
    const env = setup();
    await connect(KEY_A);
    await permissions.grantMessaging(KEY_A, { page: testPage(KEY_A) });
    const page = env.tab();
    const answer = page.ask('swarm_sendGsoc', { topic: 'lobby', data: 'hi' });
    const prompt = await env.shown('swarm.messaging');
    expect(await env.decide(prompt.handle, true, { alwaysAllow: 'yes' })).toEqual({ ok: false, reason: 'invalid' });
    await env.decide(prompt.handle, true, { alwaysAllow: true });
    expect(await answer).toEqual({ result: { sent: true, address: 'e'.repeat(64) } });
    expect(permissions.getAutoApprove(KEY_A, 'messaging')).toBe(true);
    const count = env.prompts().length;
    expect(await page.ask('swarm_sendPss', PSS)).toEqual({ result: { sent: true } });
    expect(env.prompts()).toHaveLength(count);
    expect(mockNode.sent).toEqual([['gsoc', 'lobby'], ['pss', 'room']]);
  });

  test('custody read live: no rule answers a tab in custody, the user\'s own approval counts there, and one that enters custody while a rule-answered send waits sends nothing', async () => {
    const env = setup();
    await connect(KEY_A);
    await permissions.grantMessaging(KEY_A, { page: testPage(KEY_A) });
    await permissions.setAutoApprove(KEY_A, 'messaging', true, { page: testPage(KEY_A) });
    const page = env.tab();
    env.state.custody.add(page.guest.id);
    const prompted = page.ask('swarm_sendPss', PSS);
    const prompt = await env.shown('swarm.messaging');
    await env.decide(prompt.handle, true);
    expect(await prompted).toEqual({ result: { sent: true } });
    expect(mockNode.sent).toEqual([['pss', 'room']]);

    // Out of custody, the rule answers; the tab enters custody while the
    // send waits on the node's readiness.
    env.state.custody.delete(page.guest.id);
    let ready;
    mockNode.readiness = new Promise((resolve) => {
      ready = resolve;
    });
    const ruled = page.ask('swarm_sendPss', PSS);
    await flush();
    env.state.custody.add(page.guest.id);
    ready({ ok: true });
    expect(await ruled).toEqual(AGENT_CUSTODY);
    expect(mockNode.sent).toEqual([['pss', 'room']]);
    // Leaving custody gives the rule back for the next.
    env.state.custody.delete(page.guest.id);
    mockNode.readiness = null;
    expect(await page.ask('swarm_sendPss', PSS)).toEqual({ result: { sent: true } });
  });

  test('a name that moves while a send under its rule waits, or a messaging grant revoked meanwhile: nothing sent', async () => {
    const env = setup();
    await connect(NAME);
    await permissions.grantMessaging(NAME, { page: testPage(NAME) });
    await permissions.setAutoApprove(NAME, 'messaging', true, { page: testPage(NAME) });
    const page = await env.named();
    let ready;
    mockNode.readiness = new Promise((resolve) => {
      ready = resolve;
    });
    const answer = page.ask('swarm_sendGsoc', { topic: 'lobby', data: 'hi' });
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    ready({ ok: true });
    expect(await answer).toEqual(NO_ADDRESS);
    expect(mockNode.sent).toEqual([]);

    // A send the user approved, whose messaging grant is revoked while it
    // waits on the node.
    const other = env.tab(`${KEY_A}/`);
    await connect(KEY_A);
    await permissions.grantMessaging(KEY_A, { page: testPage(KEY_A) });
    mockNode.readiness = new Promise((resolve) => {
      ready = resolve;
    });
    const revoked = other.ask('swarm_sendPss', PSS);
    const prompt = await env.shown('swarm.messaging');
    const decided = env.decide(prompt.handle, true);
    await flush();
    await permissions.revokeMessaging(KEY_A);
    ready({ ok: true });
    expect((await revoked).error).toMatchObject({ code: 4100, data: { reason: 'messaging_not_granted' } });
    expect(await decided).toEqual({ ok: true });
    expect(mockNode.sent).toEqual([]);
    // A rule-answered send whose rule went off meanwhile sends nothing either.
    await permissions.grantMessaging(KEY_A, { page: testPage(KEY_A) });
    await permissions.setAutoApprove(KEY_A, 'messaging', true, { page: testPage(KEY_A) });
    mockNode.readiness = new Promise((resolve) => {
      ready = resolve;
    });
    const ruleOff = other.ask('swarm_sendPss', PSS);
    await flush();
    await permissions.setAutoApprove(KEY_A, 'messaging', false);
    ready({ ok: true });
    expect((await ruleOff).error).toMatchObject({ code: 4100, data: { reason: 'not_auto_approved' } });
    expect(mockNode.sent).toEqual([]);
  });

  test('after the name has moved: the messaging identity is refused, with nothing disclosed', async () => {
    const env = setup();
    await connect(NAME);
    await permissions.grantMessaging(NAME, { page: testPage(NAME) });
    const page = await env.named();
    env.names.set(NAME, OTHER_IPNS_KEY);
    expect(await page.ask('swarm_getMessagingIdentity')).toEqual(NO_ADDRESS);
    expect(await page.ask('swarm_subscribe', { kind: 'pss', topic: 'room' })).toEqual(NO_ADDRESS);
    expect(await page.ask('swarm_requestAccess')).toEqual(NO_ADDRESS);
    expect(env.prompts()).toEqual([]);
    expect(mockNode.sockets.size).toBe(0);
  });
});

describe('subscriptions bound to their document (0011 PRQ-7b)', () => {
  async function subscribed(env, page, params = { kind: 'pss', topic: 'room' }) {
    const answer = await page.ask('swarm_subscribe', params);
    expect(answer.result).toMatchObject({ subscriptionId: expect.any(String), kind: params.kind });
    return answer.result;
  }

  const message = (key, data = 'ping') => {
    const socket = [...mockNode.sockets.values()].find((s) => s.key === key || !key);
    socket.onMessage(Buffer.from(data));
  };

  test('a message goes to the document that subscribed, with its nonce, and to no other', async () => {
    const env = setup();
    await connect(KEY_A);
    await permissions.grantMessaging(KEY_A, { page: testPage(KEY_A) });
    const page = env.tab();
    const sibling = env.tab(`${KEY_A}/other`, { front: false });
    const { subscriptionId, key } = await subscribed(env, page);
    message(key, 'ping');
    await flush();
    expect(page.heard()).toEqual([
      [
        'message',
        {
          type: 'swarm_subscription',
          subscription: subscriptionId,
          result: { kind: 'pss', key, data: Buffer.from('ping').toString('base64'), encoding: 'base64', receivedAt: expect.any(Number) },
        },
      ],
    ]);
    expect(sibling.heard()).toEqual([]);
    expect(env.trace.filter((e) => e.kind === 'event-sent').map((e) => e.guest)).toEqual([page.guest.id]);
  });

  test('a navigated document\'s subscription ends, and a late message reaches no page', async () => {
    const env = setup();
    await connect(KEY_A);
    await permissions.grantMessaging(KEY_A, { page: testPage(KEY_A) });
    const page = env.tab();
    const { key } = await subscribed(env, page);
    const socket = mockNode.sockets.get(`pss:${key}`);
    page.guest.commit(`${KEY_A}/next`);
    const next = env.greet(page.guest);
    expect(socket.cancelled).toBe(true);
    socket.onMessage(Buffer.from('late'));
    await flush();
    expect(page.guest.delivered).toEqual([]);
    expect(next.heard()).toEqual([]);
    expect(registry.countByOrigin(KEY_A)).toBe(0);
  });

  test('PRQ-2\'s replaced-document race for message: the event carries the old document\'s nonce, which the new document drops', async () => {
    const env = setup();
    await connect(KEY_A);
    await permissions.grantMessaging(KEY_A, { page: testPage(KEY_A) });
    const page = env.tab();
    const { key } = await subscribed(env, page);
    let release;
    env.hooks.beforeEventSend = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    message(key, 'race');
    await flush();
    // Main has checked the document and holds the send; the frame reloads,
    // same process, same key.
    page.guest.commit(`${KEY_A}/app`);
    const reloaded = env.greet(page.guest);
    release();
    await flush();
    // The send reached the frame that now holds the new document, with the
    // old document's nonce: the new document's preload drops it, and its
    // page hears nothing.
    expect(page.guest.delivered.map((m) => [m.event, m.nonce])).toEqual([['message', page.nonce]]);
    expect(reloaded.heard()).toEqual([]);
    expect(page.nonce).not.toBe(reloaded.nonce);
  });

  test('a name that moves off its IPNS key before the next message: no event, and the subscription ends', async () => {
    const env = setup();
    await connect(NAME);
    await permissions.grantMessaging(NAME, { page: testPage(NAME) });
    const page = await env.named();
    const { key } = await subscribed(env, page);
    const socket = mockNode.sockets.get(`pss:${key}`);
    message(key, 'one');
    await flush();
    expect(page.heard()).toHaveLength(1);
    env.names.set(NAME, OTHER_IPNS_KEY);
    message(key, 'two');
    await flush();
    expect(page.heard()).toHaveLength(1);
    expect(socket.cancelled).toBe(true);
    expect(registry.countByOrigin(NAME)).toBe(0);
    // The binding has ended: the document is keyless now.
    expect(await page.ask('swarm_subscribe', { kind: 'pss', topic: 'room' })).toEqual(NO_ADDRESS);
  });

  test('a name that moves while the subscription establishes: it is closed, and the page gets the keyless answer', async () => {
    const env = setup();
    await connect(NAME);
    await permissions.grantMessaging(NAME, { page: testPage(NAME) });
    const page = await env.named();
    let established;
    mockNode.establish = new Promise((resolve) => {
      established = resolve;
    });
    const answer = page.ask('swarm_subscribe', { kind: 'pss', topic: 'room' });
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    established();
    expect(await answer).toEqual(NO_ADDRESS);
    expect(registry.countByOrigin(NAME)).toBe(0);
  });

  // Codex round 1 on #1194: a fast producer can't pile up deliveries while
  // a name's resolution is held, and a teardown drops what waits.
  test('a fast producer while the name\'s resolution is held: past the bound the subscription closes, and nothing more waits', async () => {
    const { PAGE_DELIVERY_LIMITS } = require('../swarm/swarm-provider-ipc');
    const env = setup();
    await connect(NAME);
    await permissions.grantMessaging(NAME, { page: testPage(NAME) });
    const page = await env.named();
    const { key } = await subscribed(env, page);
    const socket = mockNode.sockets.get(`pss:${key}`);
    let release;
    env.gate.held = new Promise((resolve) => {
      release = resolve;
    });
    env.resolutions.length = 0;
    // The first is in flight, waiting on the name; the bound's worth waits
    // behind it; one more closes the subscription.
    socket.onMessage(Buffer.from('head'));
    await flush();
    expect(env.resolutions).toEqual([NAME]);
    for (let i = 0; i < PAGE_DELIVERY_LIMITS.messages; i += 1) socket.onMessage(Buffer.from(`m${i}`));
    expect(socket.cancelled).toBe(false);
    socket.onMessage(Buffer.from('one too many'));
    expect(socket.cancelled).toBe(true);
    expect(registry.countByOrigin(NAME)).toBe(0);
    env.gate.held = null;
    release();
    await flush();
    // At most the head, already in flight, reaches the page; nothing that
    // waited behind it is resolved for or sent.
    expect(page.heard().length).toBeLessThanOrEqual(1);
    expect(env.resolutions).toEqual([NAME]);
  });

  test('the bytes waiting are bounded too', async () => {
    const env = setup();
    await connect(NAME);
    await permissions.grantMessaging(NAME, { page: testPage(NAME) });
    const page = await env.named();
    const { key } = await subscribed(env, page);
    const socket = mockNode.sockets.get(`pss:${key}`);
    env.gate.held = new Promise(() => {});
    socket.onMessage(Buffer.from('head'));
    await flush();
    socket.onMessage(Buffer.alloc(200 * 1024));
    expect(socket.cancelled).toBe(false);
    socket.onMessage(Buffer.alloc(100 * 1024));
    expect(socket.cancelled).toBe(true);
  });

  test('a document that ends while its messages wait on the name: what waits is dropped, and nothing is resolved for or sent', async () => {
    const env = setup();
    await connect(NAME);
    await permissions.grantMessaging(NAME, { page: testPage(NAME) });
    const page = await env.named();
    const { key } = await subscribed(env, page);
    const socket = mockNode.sockets.get(`pss:${key}`);
    let release;
    env.gate.held = new Promise((resolve) => {
      release = resolve;
    });
    env.resolutions.length = 0;
    for (let i = 0; i < 10; i += 1) socket.onMessage(Buffer.from(`m${i}`));
    await flush();
    expect(env.resolutions).toEqual([NAME]);
    // Another site: a commit on the same IPNS key would check the name
    // again for its own new document.
    page.guest.commit(`${KEY_A}/`);
    expect(socket.cancelled).toBe(true);
    env.gate.held = null;
    release();
    await flush();
    expect(page.guest.delivered).toEqual([]);
    expect(env.resolutions).toEqual([NAME]);
  });

  test('swarm_unsubscribe ends only the document\'s own, and runs with no resolution after the name has moved', async () => {
    const env = setup();
    await connect(NAME);
    await permissions.grantMessaging(NAME, { page: testPage(NAME) });
    await connect(KEY_A);
    await permissions.grantMessaging(KEY_A, { page: testPage(KEY_A) });
    const page = await env.named();
    const other = env.tab(`${KEY_A}/`);
    const own = await subscribed(env, page);
    const theirs = await subscribed(env, other, { kind: 'gsoc', topic: 'lobby' });
    expect((await page.ask('swarm_unsubscribe', { subscriptionId: theirs.subscriptionId })).error).toMatchObject({
      code: -32602,
      data: { reason: 'subscription_not_found' },
    });
    expect(registry.countByOrigin(KEY_A)).toBe(1);
    env.names.set(NAME, OTHER_IPNS_KEY);
    env.resolutions.length = 0;
    expect(await page.ask('swarm_unsubscribe', { subscriptionId: own.subscriptionId })).toEqual({ result: { unsubscribed: true } });
    expect(env.resolutions).toEqual([]);
    expect(registry.countByOrigin(NAME)).toBe(0);
  });

  test('a revoked grant: its subscriptions end, and every live document of the key hears disconnect; messaging revoked alone tells nothing', async () => {
    const env = setup();
    await connect(KEY_A);
    await permissions.grantMessaging(KEY_A, { page: testPage(KEY_A) });
    const page = env.tab();
    const sibling = env.tab(`${KEY_A}/x`, { front: false });
    const stranger = env.tab(`${KEY_B}/`, { front: false });
    await subscribed(env, page);
    await permissions.revokeMessaging(KEY_A);
    await flush();
    expect(registry.countByOrigin(KEY_A)).toBe(0);
    expect(page.heard()).toEqual([]);
    await permissions.revokePermission(KEY_A);
    await flush();
    expect(page.heard()).toEqual([['disconnect', { origin: KEY_A }]]);
    expect(sibling.heard()).toEqual([['disconnect', { origin: KEY_A }]]);
    expect(stranger.heard()).toEqual([]);
  });

  test('after the name has moved, no disconnect reaches the document', async () => {
    const env = setup();
    await connect(NAME);
    const page = await env.named();
    env.names.set(NAME, OTHER_IPNS_KEY);
    await permissions.revokePermission(NAME);
    await flush();
    expect(page.heard()).toEqual([]);
    expect(env.resolutions).toEqual([NAME]);
  });
});

describe('the chrome\'s grant writes (0011 PRQ-7b, "Grants")', () => {
  const invoke = (channel, ...args) => mockIpcHandlers[channel]({}, ...args);

  test('swarm:grant-permission and swarm:grant-messaging refused for every site; revoking still accepted', async () => {
    for (const site of [KEY_A, 'name.eth', 'https://app.example']) {
      expect(() => invoke('swarm:grant-permission', site)).toThrow('A Swarm connection is granted only from its own prompt');
      expect(permissions.getPermission(site)).toBeNull();
    }
    await connect(KEY_A);
    for (const site of [KEY_A, 'name.eth']) {
      expect(() => invoke('swarm:grant-messaging', site)).toThrow('Swarm messaging is granted only from its own prompt');
    }
    expect(permissions.hasMessagingGrant(KEY_A)).toBe(false);
    await permissions.grantMessaging(KEY_A, { page: testPage(KEY_A) });
    expect(await invoke('swarm:revoke-messaging', KEY_A)).toBe(true);
    expect(permissions.hasMessagingGrant(KEY_A)).toBe(false);
    expect(await invoke('swarm:revoke-permission', KEY_A)).toBe(true);
    expect(permissions.getPermission(KEY_A)).toBeNull();
  });

  test('swarm:set-auto-approve refused for turning messaging on, accepted for turning it off', async () => {
    await connect(KEY_A);
    expect(() => invoke('swarm:set-auto-approve', KEY_A, 'messaging', true)).toThrow(
      'Messaging auto-approve is turned on only from a messaging prompt'
    );
    expect(() => invoke('swarm:set-auto-approve', KEY_A, 'messaging', 1)).toThrow();
    expect(permissions.getAutoApprove(KEY_A, 'messaging')).toBe(false);
    await permissions.setAutoApprove(KEY_A, 'messaging', true, { page: testPage(KEY_A) });
    expect(await invoke('swarm:set-auto-approve', KEY_A, 'messaging', false)).toBe(true);
    expect(permissions.getAutoApprove(KEY_A, 'messaging')).toBe(false);
    // Every other rule is main's too from PRQ-7c and 7d
    // (page-swarm-publish.test.js, page-swarm-feeds.test.js).
    expect(() => invoke('swarm:set-auto-approve', KEY_A, 'feeds', true)).toThrow('Feed auto-approve is turned on only from a feed prompt');
  });
});
