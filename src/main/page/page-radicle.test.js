// window.radicle's reads, connecting and disconnecting through main
// (freedom-core design 0011, PRQ-8a), against the PRQ-8 row. Main's real
// request path (page-documents, page-requests, its prompts) runs the
// dispatcher (page-radicle.js) over main's real executeRadicleMethod and
// Radicle permission store; the node, the add-on and the COB service are in
// memory. Each guest's main frame records what main sends it
// (`page:event`), so a test sees which document heard what.

const os = require('os');
const fs = require('fs');
const path = require('path');

const mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'page-radicle-'));
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
  BrowserWindow: { getAllWindows: () => [] },
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// The node: running unless a test stops it; its connection count can be held.
const mockNode = { status: 'running', disabled: false, connections: null, seeded: [{ rid: 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5' }] };
jest.mock('../radicle-manager', () => ({
  isDisabledForProfile: jest.fn(() => mockNode.disabled),
  getCurrentStatus: jest.fn(() => ({ status: mockNode.status, error: null })),
  getConnections: jest.fn(async () => {
    if (mockNode.connections) await mockNode.connections;
    return { success: true, count: 3 };
  }),
  seedRepository: jest.fn(),
  unseedRepository: jest.fn(),
  refetchRepository: jest.fn(),
  getSeedFetchStatus: jest.fn(),
  unsubscribeSeedStatus: jest.fn(),
  validateAndNormalizeRid: jest.fn(() => null),
  getNodeAlias: jest.fn(),
  setNodeAlias: jest.fn(),
  STATUS: { STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', ERROR: 'error' },
}));
jest.mock('../radicle-embedded', () => ({ listSeededRepos: jest.fn(async () => mockNode.seeded) }));
jest.mock('../radicle/cob-service', () => ({
  getIdentity: jest.fn(async () => ({ did: 'did:key:z6MkTest', nid: 'z6MkTest', alias: 'me' })),
  clearIdentityCache: jest.fn(),
  CobValidationError: class CobValidationError extends Error {},
}));

const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { CLASS, methodRow } = require('./page-methods');
const {
  RADICLE_READ_METHODS,
  RADICLE_CONNECT_METHODS,
  RADICLE_SEED_METHODS,
  RADICLE_SIGN_METHODS,
  RADICLE_PAGE_METHODS,
  createRadicleDispatchers,
  registerRadiclePageEvents,
} = require('./page-radicle');
const permissions = require('../radicle/radicle-permissions');
const manager = require('../radicle-manager');
const embedded = require('../radicle-embedded');
const cob = require('../radicle/cob-service');

permissions.registerRadiclePermissionsIpc();

const CHROME_URL = 'file:///app/src/renderer/index.html';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const KEYLESS = 'data:text/html,<p>keyless</p>';
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';

const NO_ADDRESS = {
  error: { code: 4100, message: 'This page has no address to connect from yet', data: { reason: 'no_address' } },
};
const REJECTED = { error: { code: 4001, message: 'User rejected the request' } };
// The chrome's answer for a site without the connection, as main keeps it.
const NOT_CONNECTED = { error: { code: 4100, message: 'Origin not authorized. Call radicle_requestAccess first.' } };
const CAPABILITIES = (reason) => ({
  specVersion: '0.2',
  canUseNode: reason === null,
  reason,
  writes: ['issue', 'issueComment', 'issueState', 'patchComment'],
});

let nextId = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
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

function setup({ deps = {} } = {}) {
  const guests = new Map();
  const names = new Map();
  const resolutions = [];
  // A test may hold every resolution until it lets them go, or script the
  // next ones, each held until its own `wait` and answering its own `key`.
  const gate = { held: null, queue: [] };
  const documents = createPageDocuments({
    isPrivateWebContents: () => false,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent: async (name) => {
      resolutions.push(name);
      const step = gate.queue.shift();
      if (step) {
        await step.wait;
        return step.key ? { type: 'ok', protocol: 'ipns', decoded: step.key } : { type: 'not_found' };
      }
      if (gate.held) await gate.held;
      const key = names.get(name);
      return key ? { type: 'ok', protocol: 'ipns', decoded: key } : { type: 'not_found' };
    },
  });
  const sent = [];
  const trace = [];
  const timers = [];
  const hooks = { onTrace: (entry) => trace.push(entry) };
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers: createRadicleDispatchers(deps),
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
  const stopEvents = registerRadiclePageEvents(requests);

  function greet(guest) {
    const n = nonce();
    expect(requests.hello(eventFrom(guest), { nonce: n }).ok).toBe(true);
    return {
      guest,
      nonce: n,
      ask: (method, params = {}) => requests.request(eventFrom(guest), { nonce: n, provider: 'radicle', method, params }),
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

  async function named(options = {}) {
    names.set(NAME, IPNS_KEY);
    const page = tab(`ipns://${IPNS_KEY}/`, { bind: NAME, ...options });
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
  const pending = (windowId = 1) => sent.filter(([w, c]) => w === windowId && c === 'page:prompt-pending').map(([, , p]) => p);
  const decide = (handle, approve, choices, windowId = 1) =>
    requests.decide({ sender: { id: 500 + windowId } }, { handle, approve, choices });
  // The prompt now shown, once it has.
  async function shown(kind = 'radicle.connect') {
    await flush();
    const prompt = prompts().at(-1);
    expect(prompt?.kind).toBe(kind);
    return prompt;
  }

  return { requests, documents, sent, trace, tab, greet, named, names, resolutions, gate, prompts, pending, decide, shown, guests, hooks, stopEvents, fire };
}

const connect = (key) => permissions.grantPermission(key);

beforeEach(() => {
  jest.clearAllMocks();
  permissions._resetCache();
  fs.rmSync(path.join(mockUserData, 'radicle-permissions.json'), { force: true });
  permissions.onRevoke(null);
  mockNode.status = 'running';
  mockNode.disabled = false;
  mockNode.connections = null;
});

afterAll(() => {
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

describe('the methods main serves (0011 PRQ-8a)', () => {
  test('the dispatcher serves every window.radicle method, each with its row, and the preload sends them all to main', () => {
    expect(RADICLE_READ_METHODS).toEqual(['radicle_getCapabilities', 'radicle_getNodeStatus', 'radicle_listSeededRepos']);
    expect(RADICLE_CONNECT_METHODS).toEqual(['radicle_requestAccess', 'radicle_disconnect']);
    expect(RADICLE_SEED_METHODS).toEqual(['radicle_seed', 'radicle_unseed', 'radicle_sync', 'radicle_getSeedStatus']);
    expect(RADICLE_PAGE_METHODS).toEqual([
      ...RADICLE_READ_METHODS,
      ...RADICLE_CONNECT_METHODS,
      ...RADICLE_SEED_METHODS,
      ...RADICLE_SIGN_METHODS,
    ]);
    // Exactly the methods main's provider knows: all of window.radicle.
    const provider = fs.readFileSync(path.join(__dirname, '../radicle/radicle-provider-ipc.js'), 'utf-8');
    const known = [.../const METHOD_TIERS = \{([\s\S]*?)\};/.exec(provider)[1].matchAll(/(radicle_[A-Za-z]+):/g)].map((m) => m[1]);
    expect([...RADICLE_PAGE_METHODS].sort()).toEqual(known.sort());
    expect(Object.keys(createRadicleDispatchers({ execute: jest.fn() })).sort()).toEqual(
      RADICLE_PAGE_METHODS.map((m) => `radicle:${m}`).sort()
    );
    // The preload sends every window.radicle method to main (PRQ-8c), and
    // keeps no list of routed methods (PRQ-9).
    const preload = fs.readFileSync(path.join(__dirname, '../webview-preload.js'), 'utf-8');
    expect(preload).not.toMatch(/PAGE_ROUTES|routedToMain|sendToHost\('radicle:/);
    // Each has the design's class.
    for (const method of RADICLE_PAGE_METHODS) {
      expect({ method, class: methodRow('radicle', method).class }).toEqual({
        method,
        class: method === 'radicle_disconnect' ? CLASS.EXEMPT : CLASS.NAME_REVALIDATED,
      });
    }
  });

  test('every read runs under the attested key, for each URL form', async () => {
    const forms = [
      ['https://app.example/forge?x=1', 'https://app.example'],
      [`${KEY_A}/app`, KEY_A],
      ['bzz://name.eth/page', 'name.eth'],
      ['ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/docs', 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'],
      [`ipns://${IPNS_KEY}/`, `ipns://${IPNS_KEY}`],
      ['rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5/tree', 'rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5'],
    ];
    const env = setup();
    for (const [url, key] of forms) {
      const page = env.tab(url);
      // Not connected: the reads that need the connection are refused.
      expect(await page.ask('radicle_getCapabilities')).toEqual({ result: CAPABILITIES('not-connected') });
      expect(await page.ask('radicle_getNodeStatus')).toEqual(NOT_CONNECTED);
      expect(await page.ask('radicle_listSeededRepos')).toEqual(NOT_CONNECTED);
      expect(await page.ask('radicle_disconnect')).toEqual(NOT_CONNECTED);
      expect(manager.getConnections).not.toHaveBeenCalled();
      expect(embedded.listSeededRepos).not.toHaveBeenCalled();
      connect(key);
      permissions.grantSigning(key);
      expect({ url, answer: await page.ask('radicle_getCapabilities') }).toEqual({ url, answer: { result: CAPABILITIES(null) } });
      expect(await page.ask('radicle_getNodeStatus')).toEqual({
        result: { running: true, status: 'running', peers: 3, alias: 'me', nid: 'z6MkTest' },
      });
      expect(await page.ask('radicle_listSeededRepos')).toEqual({ result: [{ rid: 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5' }] });
      jest.clearAllMocks();
      // Another key's grant is never this page's.
      expect(permissions.getPermission(key).lastUsed).toEqual(expect.any(Number));
    }
    expect(permissions.getPermission(KEY_B)).toBeNull();
    // No name was resolved: none of these documents has a name binding.
    expect(env.resolutions).toEqual([]);
  });

  test('a keyless document is refused every method, with nothing read and no prompt', async () => {
    const env = setup();
    const page = env.tab(KEYLESS);
    for (const method of RADICLE_PAGE_METHODS) {
      expect({ method, answer: await page.ask(method) }).toEqual({ method, answer: NO_ADDRESS });
    }
    expect(manager.getConnections).not.toHaveBeenCalled();
    expect(embedded.listSeededRepos).not.toHaveBeenCalled();
    expect(env.trace.filter((e) => e.kind === 'handle-opened')).toEqual([]);
  });

  test('the node stopped: the capabilities say so, and connecting still works', async () => {
    const env = setup();
    mockNode.status = 'stopped';
    connect(KEY_A);
    const page = env.tab();
    expect(await page.ask('radicle_getCapabilities')).toEqual({ result: CAPABILITIES('node-stopped') });
    expect(await page.ask('radicle_getNodeStatus')).toEqual({ result: { running: false, status: 'stopped' } });
    expect(await page.ask('radicle_listSeededRepos')).toEqual({
      error: { code: 4900, message: 'Radicle node is not running', data: { reason: 'node-stopped' } },
    });
    expect(await page.ask('radicle_requestAccess')).toEqual({
      result: { connected: true, origin: KEY_A, capabilities: CAPABILITIES('node-stopped') },
    });
  });
});

describe('a DNS name over IPNS (0011 PRQ-8a)', () => {
  test('the reads resolve the name before and after their wait, the capabilities once', async () => {
    const env = setup();
    connect(NAME);
    const page = await env.named();
    expect(await page.ask('radicle_getCapabilities')).toEqual({ result: CAPABILITIES(null) });
    expect(env.resolutions).toEqual([NAME]);
    env.resolutions.length = 0;
    expect(await page.ask('radicle_getNodeStatus')).toEqual({ result: { running: true, status: 'running', peers: 3, alias: 'me' } });
    expect(env.resolutions).toEqual([NAME, NAME]);
    env.resolutions.length = 0;
    expect((await page.ask('radicle_listSeededRepos')).result).toHaveLength(1);
    expect(env.resolutions).toEqual([NAME, NAME]);
  });

  test('after the name has moved: radicle_disconnect runs with no resolution, and every name-revalidated method is refused with nothing done', async () => {
    const env = setup();
    connect(NAME);
    permissions.grantSigning(NAME);
    const page = await env.named();
    env.names.set(NAME, OTHER_IPNS_KEY);
    // Disconnecting gives up the name's grants, with no resolution of its
    // own: it only narrows.
    expect(await page.ask('radicle_disconnect')).toEqual({ result: { connected: false } });
    const disconnectId = env.trace.find((e) => e.kind === 'recorded' && e.method === 'radicle_disconnect').id;
    expect(env.trace.filter((e) => e.kind === 'name-checked' && e.id === disconnectId)).toEqual([]);
    expect(permissions.getPermission(NAME)).toBeNull();
    // Its disconnect is name-revalidated: the name no longer answers, so it
    // doesn't reach the document, and the binding ends.
    await flush();
    expect(page.heard()).toEqual([]);
    expect(env.trace.filter((e) => e.kind === 'event-refused').map((e) => [e.event, e.reason])).toEqual([['disconnect', 'name-moved']]);
    env.resolutions.length = 0;
    // The document is keyless now: every method is refused, resolving
    // nothing more.
    connect(NAME);
    permissions.grantSigning(NAME);
    for (const method of RADICLE_PAGE_METHODS) {
      expect({ method, answer: await page.ask(method) }).toEqual({ method, answer: NO_ADDRESS });
    }
    // No node id, nothing read, no prompt, nothing given up.
    expect(manager.getConnections).not.toHaveBeenCalled();
    expect(cob.getIdentity).not.toHaveBeenCalled();
    expect(embedded.listSeededRepos).not.toHaveBeenCalled();
    expect(env.trace.filter((e) => e.kind === 'handle-opened')).toEqual([]);
    expect(env.resolutions).toEqual([]);
    expect(permissions.getPermission(NAME)).not.toBeNull();
  });

  test('a losing name check swept across a read\'s own check: the read runs only while the document holds the name', async () => {
    const deferred = () => {
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    // The reads, and a connected site's requestAccess (its last use).
    for (const method of [...RADICLE_READ_METHODS, 'radicle_requestAccess']) {
      for (let ticks = 0; ticks <= 15; ticks += 1) {
        const box = {};
        const seen = [];
        const env = setup({
          deps: {
            // The key the document holds at the moment the method first
            // uses its own.
            execute: async (m, _params, key) => {
              const doc = box.env.documents.liveDocuments().find((d) => d.guest === box.guest);
              seen.push(doc?.key ?? null);
              return { result: { m, key } };
            },
          },
        });
        box.env = env;
        connect(NAME);
        const page = await env.named();
        box.guest = page.guest.id;
        const honest = deferred();
        const losing = deferred();
        env.gate.queue.push({ wait: honest.promise, key: IPNS_KEY }, { wait: losing.promise, key: OTHER_IPNS_KEY });
        const read = page.ask(method);
        await flush();
        const other = page.ask('radicle_getCapabilities');
        await flush();
        honest.resolve();
        for (let i = 0; i < ticks; i += 1) await Promise.resolve();
        losing.resolve();
        const answers = [await read, await other];
        expect({ method, ticks, seen: seen.filter((key) => key !== NAME) }).toEqual({ method, ticks, seen: [] });
        // Whatever ran answers only while the document still held the name.
        for (const answer of answers) if (answer.result) expect(answer.result.key).toBe(NAME);
        expect(answers[1]).toEqual(NO_ADDRESS);
      }
    }
  });

  test('a name found moved by the read itself: refused with nothing read', async () => {
    const env = setup();
    connect(NAME);
    permissions.grantSigning(NAME);
    for (const method of RADICLE_READ_METHODS) {
      const page = await env.named();
      env.names.set(NAME, OTHER_IPNS_KEY);
      expect({ method, answer: await page.ask(method) }).toEqual({ method, answer: NO_ADDRESS });
      expect(env.resolutions).toEqual([NAME]);
    }
    expect(manager.getConnections).not.toHaveBeenCalled();
    expect(cob.getIdentity).not.toHaveBeenCalled();
    expect(embedded.listSeededRepos).not.toHaveBeenCalled();
  });

  test('a name that moves while the node status waits: the answer, node id and all, is withheld', async () => {
    const env = setup();
    connect(NAME);
    permissions.grantSigning(NAME);
    const page = await env.named();
    let release;
    mockNode.connections = new Promise((resolve) => {
      release = resolve;
    });
    const answer = page.ask('radicle_getNodeStatus');
    await flush();
    expect(manager.getConnections).toHaveBeenCalledTimes(1);
    env.names.set(NAME, OTHER_IPNS_KEY);
    release();
    expect(await answer).toEqual(NO_ADDRESS);
  });

  test('another request\'s check ends the binding while a read\'s answer waits: it goes out keyless', async () => {
    const env = setup();
    connect(NAME);
    const page = await env.named();
    let release;
    mockNode.connections = new Promise((resolve) => {
      release = resolve;
    });
    const status = page.ask('radicle_getNodeStatus');
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    expect(await page.ask('radicle_getCapabilities')).toEqual(NO_ADDRESS);
    // The name answers the key again, but the binding has ended.
    env.names.set(NAME, IPNS_KEY);
    release();
    expect(await status).toEqual(NO_ADDRESS);
  });
});

describe('radicle_requestAccess through main (0011 PRQ-8a)', () => {
  test('main prompts, writes the grant for the attested key on approval, and every live document of the key hears connect, the asker first', async () => {
    const env = setup();
    const page = env.tab(`${KEY_A}/app`);
    const sibling = env.tab(`${KEY_A}/other`, { front: false });
    const stranger = env.tab(`${KEY_B}/`, { front: false });
    env.requests.foreground({ sender: { id: 501 } }, { guest: page.guest.id });
    const answer = page.ask('radicle_requestAccess');
    const prompt = await env.shown();
    expect(prompt).toEqual({ handle: expect.any(String), guest: page.guest.id, kind: 'radicle.connect', site: { key: KEY_A, label: KEY_A }, view: {} });
    expect(permissions.getPermission(KEY_A)).toBeNull();
    // The chrome names no site: a decision with one is refused.
    expect(await env.decide(prompt.handle, true, { site: KEY_B })).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(prompt.handle, true)).toEqual({ ok: true });
    expect(await answer).toEqual({ result: { connected: true, origin: KEY_A, capabilities: CAPABILITIES(null) } });
    expect(permissions.getPermission(KEY_A)).toMatchObject({ origin: KEY_A, signing: false, autoApprove: { node: false, signing: false } });
    expect(permissions.getPermission(KEY_B)).toBeNull();
    await flush();
    expect(page.heard()).toEqual([['connect', { origin: KEY_A }]]);
    expect(sibling.heard()).toEqual([['connect', { origin: KEY_A }]]);
    expect(stranger.heard()).toEqual([]);
    const sends = env.trace.filter((e) => e.kind === 'event-sent').map((e) => e.guest);
    expect(sends).toEqual([page.guest.id, sibling.guest.id]);
  });

  test('a rejection connects nothing and tells nothing; a connected site is marked used, with no prompt and no connect', async () => {
    const env = setup();
    const page = env.tab();
    const answer = page.ask('radicle_requestAccess');
    const prompt = await env.shown();
    expect(await env.decide(prompt.handle, false)).toEqual({ ok: true });
    expect(await answer).toEqual(REJECTED);
    expect(permissions.getPermission(KEY_A)).toBeNull();
    await flush();
    expect(page.heard()).toEqual([]);

    const granted = connect(KEY_A);
    const stale = Date.now() - 120_000;
    granted.lastUsed = stale;
    env.sent.length = 0;
    expect(await page.ask('radicle_requestAccess')).toEqual({
      result: { connected: true, origin: KEY_A, capabilities: CAPABILITIES(null) },
    });
    expect(env.prompts()).toEqual([]);
    expect(permissions.getPermission(KEY_A).lastUsed).toBeGreaterThan(stale);
    await flush();
    expect(page.heard()).toEqual([]);
  });

  test('a grant another document of the key wrote while the prompt was open is kept, with its signing grant, and announced once', async () => {
    const env = setup();
    const page = env.tab();
    const answer = page.ask('radicle_requestAccess');
    const prompt = await env.shown();
    connect(KEY_A);
    permissions.grantSigning(KEY_A);
    expect(await env.decide(prompt.handle, true)).toEqual({ ok: true });
    expect((await answer).result.connected).toBe(true);
    expect(permissions.hasSigningGrant(KEY_A)).toBe(true);
    await flush();
    // This request didn't connect the site: it tells nothing.
    expect(page.heard()).toEqual([]);
  });

  test('a name that moves off its IPNS key while its connect prompt is open gets no grant and no connect', async () => {
    const env = setup();
    const page = await env.named();
    const answer = page.ask('radicle_requestAccess');
    const prompt = await env.shown();
    expect(prompt.site).toEqual({ key: NAME, label: NAME });
    env.names.set(NAME, OTHER_IPNS_KEY);
    expect(await env.decide(prompt.handle, true)).toEqual({ ok: true });
    expect(await answer).toEqual(NO_ADDRESS);
    expect(permissions.getPermission(NAME)).toBeNull();
    await flush();
    expect(page.heard()).toEqual([]);
  });

  test('a background tab\'s prompt waits for its tab, and closes at main\'s deadline with nothing granted', async () => {
    const env = setup();
    const front = env.tab(`${KEY_B}/`);
    const page = env.tab(`${KEY_A}/app`, { front: false });
    const answer = page.ask('radicle_requestAccess');
    await flush();
    expect(env.pending().map((p) => p.guest)).toEqual([page.guest.id]);
    expect(env.prompts()).toEqual([]);
    // Today's page-world limit for it: 300 s, until its prompt shows.
    env.fire(300_000);
    expect(await answer).toEqual({ error: { code: -32603, message: 'Request timed out' } });
    env.requests.foreground({ sender: { id: 501 } }, { guest: page.guest.id });
    await flush();
    expect(env.prompts()).toEqual([]);
    expect(permissions.getPermission(KEY_A)).toBeNull();
    expect(front.heard()).toEqual([]);
  });

  test('a page whose document goes while its prompt is open gets nothing, and nothing is granted', async () => {
    const env = setup();
    const page = env.tab();
    const answer = page.ask('radicle_requestAccess');
    const prompt = await env.shown();
    page.guest.commit(`${KEY_A}/next`);
    expect(await answer).toEqual({ gone: true });
    expect(await env.decide(prompt.handle, true)).toEqual({ ok: false, reason: 'closed' });
    expect(permissions.getPermission(KEY_A)).toBeNull();
  });

  test('no prompt while Radicle is off for the profile', async () => {
    const env = setup();
    mockNode.disabled = true;
    const page = env.tab();
    expect(await page.ask('radicle_requestAccess')).toEqual({
      error: { code: 4900, message: 'Radicle is disabled for this profile', data: { reason: 'profile-disabled' } },
    });
    expect(env.trace.filter((e) => e.kind === 'handle-opened')).toEqual([]);
    expect(permissions.getPermission(KEY_A)).toBeNull();
  });
});

describe('radicle_disconnect and disconnect from main (0011 PRQ-8a)', () => {
  test('a page gives up its own grants, connection and signing, and every live document of the key hears disconnect', async () => {
    const env = setup();
    connect(KEY_A);
    permissions.grantSigning(KEY_A);
    permissions.setAutoApprove(KEY_A, 'signing', true);
    connect(KEY_B);
    const page = env.tab(`${KEY_A}/app`);
    const sibling = env.tab(`${KEY_A}/other`, { front: false });
    const stranger = env.tab(`${KEY_B}/`, { front: false });
    expect(await page.ask('radicle_disconnect')).toEqual({ result: { connected: false } });
    expect(permissions.getPermission(KEY_A)).toBeNull();
    expect(permissions.getPermission(KEY_B)).not.toBeNull();
    await flush();
    expect(page.heard()).toEqual([['disconnect', { origin: KEY_A }]]);
    expect(sibling.heard()).toEqual([['disconnect', { origin: KEY_A }]]);
    expect(stranger.heard()).toEqual([]);
    // A site with nothing to give up is told so.
    expect(await page.ask('radicle_disconnect')).toEqual(NOT_CONNECTED);
  });

  test('a revocation from the chrome tells every live document of the key; the chrome\'s grant writes are refused for every site', async () => {
    const env = setup();
    const page = env.tab();
    const other = env.tab(`${KEY_B}/`, { front: false });
    for (const site of [KEY_A, 'name.eth', 'https://other.example']) {
      expect(() => mockIpcHandlers['radicle:grant-permission']({ sender: { id: 501 } }, site)).toThrow(
        'A Radicle connection is granted only from its own prompt'
      );
      expect(permissions.getPermission(site)).toBeNull();
    }
    connect(KEY_A);
    expect(mockIpcHandlers['radicle:revoke-permission']({ sender: { id: 501 } }, KEY_A)).toBe(true);
    expect(permissions.getPermission(KEY_A)).toBeNull();
    await flush();
    expect(page.heard()).toEqual([['disconnect', { origin: KEY_A }]]);
    expect(other.heard()).toEqual([]);
    // Nothing to revoke tells nothing.
    expect(mockIpcHandlers['radicle:revoke-permission']({ sender: { id: 501 } }, KEY_A)).toBe(false);
    await flush();
    expect(page.heard()).toHaveLength(1);
  });

  test('a name-keyed document hears disconnect only while the name answers its key', async () => {
    const env = setup();
    connect(NAME);
    const page = await env.named();
    permissions.revokePermission(NAME);
    await flush();
    expect(page.heard()).toEqual([['disconnect', { origin: NAME }]]);
    expect(env.resolutions).toEqual([NAME]);
    connect(NAME);
    env.names.set(NAME, OTHER_IPNS_KEY);
    permissions.revokePermission(NAME);
    await flush();
    expect(page.heard()).toHaveLength(1);
    expect(env.trace.filter((e) => e.kind === 'event-refused').map((e) => e.reason)).toEqual(['name-moved']);
  });

  test('after the name has moved, no connect reaches the document either', async () => {
    const env = setup();
    const watcher = await env.named({ front: false });
    const asker = env.tab(`ipns://${IPNS_KEY}/x`, { bind: NAME });
    await flush();
    let release;
    env.hooks.beforeEventSend = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const answer = asker.ask('radicle_requestAccess');
    const prompt = await env.shown();
    expect(await env.decide(prompt.handle, true)).toEqual({ ok: true });
    expect((await answer).result.connected).toBe(true);
    await flush();
    // The asker's connect is held after its name check; then the name moves.
    env.names.set(NAME, OTHER_IPNS_KEY);
    env.hooks.beforeEventSend = undefined;
    release();
    await flush();
    expect(asker.heard()).toEqual([['connect', { origin: NAME }]]);
    expect(watcher.heard()).toEqual([]);
  });

  test('a connect and a later revocation reach every document in their order, even while the connect is held', async () => {
    const env = setup();
    const page = env.tab(`${KEY_A}/app`);
    const sibling = env.tab(`${KEY_A}/other`, { front: false });
    let release;
    env.hooks.beforeEventSend = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const answer = page.ask('radicle_requestAccess');
    const prompt = await env.shown();
    await env.decide(prompt.handle, true);
    expect((await answer).result.connected).toBe(true);
    await flush();
    // The asker's connect is held; the site is revoked meanwhile.
    env.hooks.beforeEventSend = undefined;
    permissions.revokePermission(KEY_A);
    await flush();
    expect(sibling.heard()).toEqual([]);
    release();
    await flush();
    expect(page.heard()).toEqual([
      ['connect', { origin: KEY_A }],
      ['disconnect', { origin: KEY_A }],
    ]);
    expect(sibling.heard()).toEqual([
      ['connect', { origin: KEY_A }],
      ['disconnect', { origin: KEY_A }],
    ]);
  });
});

describe('PRQ-2\'s replaced-document race, for connect and disconnect (0011 PRQ-8a)', () => {
  test.each(['connect', 'disconnect'])('%s: the event carries the old document\'s nonce, which the new document drops', async (event) => {
    const env = setup();
    const page = env.tab();
    let release;
    env.hooks.beforeEventSend = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    if (event === 'connect') {
      const answer = page.ask('radicle_requestAccess');
      const prompt = await env.shown();
      await env.decide(prompt.handle, true);
      await answer;
    } else {
      connect(KEY_A);
      permissions.revokePermission(KEY_A);
    }
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
    expect(page.guest.delivered.map((m) => [m.event, m.nonce])).toEqual([[event, page.nonce]]);
    expect(reloaded.heard()).toEqual([]);
    expect(page.nonce).not.toBe(reloaded.nonce);
  });

  test('a navigated document hears no later connect or disconnect', async () => {
    const env = setup();
    const page = env.tab();
    page.guest.commit(`${KEY_B}/`);
    const next = env.greet(page.guest);
    connect(KEY_A);
    permissions.revokePermission(KEY_A);
    await flush();
    expect(page.guest.delivered).toEqual([]);
    expect(next.heard()).toEqual([]);
  });
});
