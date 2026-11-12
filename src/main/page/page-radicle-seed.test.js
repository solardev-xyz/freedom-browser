// window.radicle's seeding through main (freedom-core design 0011, PRQ-8b),
// against the PRQ-8 row. Main's real request path (page-documents,
// page-requests, its prompts) runs the dispatcher (page-radicle.js) over
// main's real executeRadicleMethod, Radicle permission store and seed-status
// delivery; the node's seeding is in memory: a test can hold the seeding
// policy's read and push a fetch's statuses to whoever is subscribed. Each
// guest's main frame records what main sends it (`page:event`).

const os = require('os');
const fs = require('fs');
const path = require('path');

const mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'page-radicle-seed-'));
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
// The chrome's sender, as a known public window's.
jest.mock('../private/private-sender', () => ({ isPrivateSender: () => false }));

// The node's seeding: what it did, who listens to its fetches, and the
// seeding policies, whose read a test may hold.
const mockNode = { actions: [], listeners: new Set(), seeded: new Set(), policies: null };
const mockStatusOf = (rid, state) => ({ rid, state, inStorage: state === 'fetched', progress: { phase: state } });
jest.mock('../radicle-manager', () => {
  const start = (kind, rid, onStatus) => {
    mockNode.actions.push([kind, rid]);
    if (onStatus) mockNode.listeners.add(onStatus);
    const status = mockStatusOf(rid, 'fetching');
    onStatus?.(status);
    return { success: true, status };
  };
  return {
    isDisabledForProfile: jest.fn(() => false),
    getCurrentStatus: jest.fn(() => ({ status: 'running', error: null })),
    getConnections: jest.fn(async () => ({ success: true, count: 3 })),
    seedRepository: jest.fn(async (rid, onStatus) => start('seed', rid, onStatus)),
    unseedRepository: jest.fn(async (rid) => {
      mockNode.actions.push(['unseed', rid]);
      return { success: true };
    }),
    // As the manager's: the seeding policy read, then the page's guard.
    refetchRepository: jest.fn(async (rid, onStatus, { guard } = {}) => {
      if (mockNode.policies) await mockNode.policies;
      if (!mockNode.seeded.has(rid)) {
        return { success: false, error: { code: 'NOT_SEEDED', message: 'Repository is not seeded — seed it before syncing' } };
      }
      if (!guard) return start('sync', rid, onStatus);
      return (await guard(() => start('sync', rid, onStatus))) ?? { success: false, error: { code: 'REFUSED', message: 'The fetch was not started' } };
    }),
    getSeedFetchStatus: jest.fn(async (rid, onStatus) => {
      if (onStatus) mockNode.listeners.add(onStatus);
      return { success: true, status: mockStatusOf(rid, 'fetching') };
    }),
    unsubscribeSeedStatus: jest.fn((listener) => mockNode.listeners.delete(listener)),
    validateAndNormalizeRid: jest.fn((rid) => {
      const m = /^(?:rad:)?(z[1-9A-HJ-NP-Za-km-z]{20,60})$/.exec(rid ?? '');
      return m ? `rad:${m[1]}` : null;
    }),
    getNodeAlias: jest.fn(),
    setNodeAlias: jest.fn(),
    STATUS: { STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', ERROR: 'error' },
  };
});
jest.mock('../radicle-embedded', () => ({ listSeededRepos: jest.fn(async () => []) }));
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
  RADICLE_SEED_METHODS,
  SEED_STATUS_QUEUE,
  createRadicleDispatchers,
  registerRadiclePageEvents,
} = require('./page-radicle');
const permissions = require('../radicle/radicle-permissions');
const manager = require('../radicle-manager');

permissions.registerRadiclePermissionsIpc();

const CHROME_URL = 'file:///app/src/renderer/index.html';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const KEYLESS = 'data:text/html,<p>keyless</p>';
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const BARE_RID = RID.slice(4);

const NO_ADDRESS = {
  error: { code: 4100, message: 'This page has no address to connect from yet', data: { reason: 'no_address' } },
};
const REJECTED = { error: { code: 4001, message: 'User rejected the request' } };
const NOT_CONNECTED = { error: { code: 4100, message: 'Origin not authorized. Call radicle_requestAccess first.' } };
const CONNECTION_GONE = { error: { code: 4100, message: 'Origin not connected', data: { reason: 'not_connected' } } };
const AGENT_CUSTODY = {
  error: { code: 4100, message: 'A page in Agent custody needs approval for this action', data: { reason: 'agent_custody' } },
};
const RULE_OFF = { error: { code: 4100, message: "This action needs the user's approval", data: { reason: 'not_auto_approved' } } };
const INVALID_RID = { error: { code: -32602, message: 'Invalid Radicle repository ID', data: { reason: 'invalid_rid' } } };

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
  const custody = new Set();
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
        // A step with no key answers as the name stands once it is let go.
        if (step.key !== undefined) return step.key ? { type: 'ok', protocol: 'ipns', decoded: step.key } : { type: 'not_found' };
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
    dispatchers: createRadicleDispatchers({ inCustody: (guest) => custody.has(guest), ...deps }),
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
  async function shown(kind = 'radicle.node') {
    await flush();
    const prompt = prompts().at(-1);
    expect(prompt?.kind).toBe(kind);
    return prompt;
  }

  return { requests, documents, sent, trace, tab, greet, named, names, resolutions, gate, prompts, pending, decide, shown, guests, hooks, stopEvents, fire, custody };
}

const connect = (key) => permissions.grantPermission(key);
// A fetch's next status, to every listener the node holds.
const emit = (status) => {
  for (const listener of [...mockNode.listeners]) listener(status);
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const seedStatuses = (page) => page.heard().filter(([event]) => event === 'seedStatus').map(([, data]) => data);

beforeEach(() => {
  jest.clearAllMocks();
  permissions._resetCache();
  fs.rmSync(path.join(mockUserData, 'radicle-permissions.json'), { force: true });
  permissions.onRevoke(null);
  mockNode.actions = [];
  mockNode.listeners.clear();
  mockNode.seeded = new Set([RID]);
  mockNode.policies = null;
});

afterAll(() => {
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

describe('the seeding methods main serves (0011 PRQ-8b)', () => {
  test('each has its row, name-revalidated, and a keyless document is refused each with nothing done', async () => {
    for (const method of RADICLE_SEED_METHODS) expect(methodRow('radicle', method).class).toBe(CLASS.NAME_REVALIDATED);
    const env = setup();
    const page = env.tab(KEYLESS);
    for (const method of RADICLE_SEED_METHODS) {
      expect({ method, answer: await page.ask(method, { rid: RID }) }).toEqual({ method, answer: NO_ADDRESS });
    }
    expect(mockNode.actions).toEqual([]);
    expect(manager.getSeedFetchStatus).not.toHaveBeenCalled();
    expect(env.trace.filter((e) => e.kind === 'handle-opened')).toEqual([]);
  });

  test('a site that isn\'t connected gets the chrome\'s answer, with no prompt and nothing done', async () => {
    const env = setup();
    const page = env.tab();
    for (const method of RADICLE_SEED_METHODS) {
      expect({ method, answer: await page.ask(method, { rid: RID }) }).toEqual({ method, answer: NOT_CONNECTED });
    }
    expect(mockNode.actions).toEqual([]);
    expect(manager.getSeedFetchStatus).not.toHaveBeenCalled();
    expect(env.prompts()).toEqual([]);
  });
});

describe('radicle_seed and radicle_unseed through main (0011 PRQ-8b)', () => {
  test('main prompts with the repository as the method accepts it, seeds on approval, and records the site\'s use', async () => {
    const env = setup();
    const granted = connect(KEY_A);
    granted.lastUsed = Date.now() - 120_000;
    const stale = granted.lastUsed;
    const page = env.tab();
    const answer = page.ask('radicle_seed', { rid: BARE_RID });
    const prompt = await env.shown();
    expect(prompt).toEqual({
      handle: expect.any(String),
      guest: page.guest.id,
      kind: 'radicle.node',
      site: { key: KEY_A, label: KEY_A },
      view: { method: 'radicle_seed', rid: RID },
    });
    expect(mockNode.actions).toEqual([]);
    // The chrome picks nothing here.
    expect(await env.decide(prompt.handle, true, { alwaysAllow: true })).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(prompt.handle, true)).toEqual({ ok: true });
    expect(await answer).toEqual({ result: { rid: RID, seeded: true, status: mockStatusOf(RID, 'fetching') } });
    expect(mockNode.actions).toEqual([['seed', RID]]);
    expect(permissions.getPermission(KEY_A).lastUsed).toBeGreaterThan(stale);
    // No prompt turns the node rule on.
    expect(permissions.getAutoApprove(KEY_A, 'node')).toBe(false);
  });

  test('an unseed prompts too; a rejection does nothing; an invalid repository id is refused with no prompt', async () => {
    const env = setup();
    connect(KEY_A);
    const page = env.tab();
    const unseed = page.ask('radicle_unseed', { rid: RID });
    const prompt = await env.shown();
    expect(prompt.view).toEqual({ method: 'radicle_unseed', rid: RID });
    expect(await env.decide(prompt.handle, true)).toEqual({ ok: true });
    expect(await unseed).toEqual({ result: { rid: RID, seeded: false } });
    expect(mockNode.actions).toEqual([['unseed', RID]]);

    const rejected = page.ask('radicle_seed', { rid: RID });
    const next = await env.shown();
    expect(await env.decide(next.handle, false)).toEqual({ ok: true });
    expect(await rejected).toEqual(REJECTED);
    expect(mockNode.actions).toEqual([['unseed', RID]]);

    env.sent.length = 0;
    for (const rid of ['not-a-rid', undefined, 42, `rad:${'z'.repeat(80)}`]) {
      expect(await page.ask('radicle_seed', { rid })).toEqual(INVALID_RID);
    }
    expect(env.prompts()).toEqual([]);
    expect(mockNode.actions).toEqual([['unseed', RID]]);
  });

  test('the site\'s node rule answers with no prompt; it is never chosen for a tab in Agent custody, whose user\'s approval still counts', async () => {
    const env = setup();
    connect(KEY_A);
    permissions.setAutoApprove(KEY_A, 'node', true);
    const page = env.tab();
    expect((await page.ask('radicle_seed', { rid: RID })).result.seeded).toBe(true);
    expect(env.prompts()).toEqual([]);
    // In custody: the request goes to its prompt, and keeps it when custody ends.
    env.custody.add(page.guest.id);
    const held = page.ask('radicle_unseed', { rid: RID });
    const prompt = await env.shown();
    env.custody.delete(page.guest.id);
    expect(await env.decide(prompt.handle, true)).toEqual({ ok: true });
    expect((await held).result).toEqual({ rid: RID, seeded: false });
    // Out of custody again: the rule answers.
    env.sent.length = 0;
    expect((await page.ask('radicle_seed', { rid: RID })).result.seeded).toBe(true);
    expect(env.prompts()).toEqual([]);
    expect(mockNode.actions).toEqual([['seed', RID], ['unseed', RID], ['seed', RID]]);
  });

  test.each([
    ['enters Agent custody', (env, page) => env.custody.add(page.guest.id), AGENT_CUSTODY],
    ['has its rule turned off', () => permissions.setAutoApprove(NAME, 'node', false), RULE_OFF],
    ['loses its connection', () => permissions.revokePermission(NAME), CONNECTION_GONE],
    ['has its name move off its IPNS key', (env) => env.names.set(NAME, OTHER_IPNS_KEY), NO_ADDRESS],
  ])('a rule-answered seed whose tab %s while it waits does nothing', async (_label, change, refusal) => {
    const env = setup();
    connect(NAME);
    permissions.setAutoApprove(NAME, 'node', true);
    const page = await env.named();
    const guardCheck = deferred();
    // The dispatcher's own check answers; the guard's waits.
    env.gate.queue.push({ wait: Promise.resolve(), key: IPNS_KEY }, { wait: guardCheck.promise });
    const answer = page.ask('radicle_seed', { rid: RID });
    await flush();
    expect(env.resolutions).toEqual([NAME, NAME]);
    change(env, page);
    // The guard's resolution answers as the name stands now.
    guardCheck.resolve();
    expect(await answer).toEqual(refusal);
    expect(mockNode.actions).toEqual([]);
    expect(env.prompts()).toEqual([]);
  });

  test('a name that moves off its IPNS key while the node prompt is open: nothing seeded', async () => {
    const env = setup();
    connect(NAME);
    const page = await env.named();
    const answer = page.ask('radicle_seed', { rid: RID });
    const prompt = await env.shown();
    expect(prompt.site).toEqual({ key: NAME, label: NAME });
    env.names.set(NAME, OTHER_IPNS_KEY);
    expect(await env.decide(prompt.handle, true)).toEqual({ ok: true });
    expect(await answer).toEqual(NO_ADDRESS);
    expect(mockNode.actions).toEqual([]);
  });

  test('a background tab\'s node prompt waits for its tab, and closes at main\'s deadline with nothing done', async () => {
    const env = setup();
    connect(KEY_A);
    env.tab(`${KEY_B}/`);
    const page = env.tab(`${KEY_A}/app`, { front: false });
    const seed = page.ask('radicle_seed', { rid: RID });
    const unseed = page.ask('radicle_unseed', { rid: RID });
    await flush();
    expect(env.pending().map((p) => p.guest)).toEqual([page.guest.id, page.guest.id]);
    expect(env.prompts()).toEqual([]);
    // Today's page-world limits: 300 s for a seed, 60 s for an unseed.
    env.fire(60_000);
    expect(await unseed).toEqual({ error: { code: -32603, message: 'Request timed out' } });
    env.fire(300_000);
    expect(await seed).toEqual({ error: { code: -32603, message: 'Request timed out' } });
    env.requests.foreground({ sender: { id: 501 } }, { guest: page.guest.id });
    await flush();
    expect(env.prompts()).toEqual([]);
    expect(mockNode.actions).toEqual([]);
  });
});

describe('radicle_sync and radicle_getSeedStatus through main (0011 PRQ-8b)', () => {
  test('a sync restarts a seeded repository\'s fetch with no prompt; one it doesn\'t seed is refused with nothing fetched', async () => {
    const env = setup();
    connect(KEY_A);
    const page = env.tab();
    expect(await page.ask('radicle_sync', { rid: RID })).toEqual({ result: { rid: RID, status: mockStatusOf(RID, 'fetching') } });
    expect(env.prompts()).toEqual([]);
    mockNode.seeded.clear();
    expect(await page.ask('radicle_sync', { rid: RID })).toEqual({
      error: { code: -32602, message: 'Repository is not seeded — seed it before syncing', data: { reason: 'not_seeded' } },
    });
    expect(mockNode.actions).toEqual([['sync', RID]]);
  });

  test('a name that moves while a sync reads the seeding policy: nothing fetched', async () => {
    const env = setup();
    connect(NAME);
    const page = await env.named();
    const policies = deferred();
    mockNode.policies = policies.promise;
    const answer = page.ask('radicle_sync', { rid: RID });
    await flush();
    expect(manager.refetchRepository).toHaveBeenCalledTimes(1);
    env.names.set(NAME, OTHER_IPNS_KEY);
    policies.resolve();
    expect(await answer).toEqual(NO_ADDRESS);
    expect(mockNode.actions).toEqual([]);
  });

  test('a connection revoked while a sync reads the seeding policy: nothing fetched', async () => {
    const env = setup();
    connect(KEY_A);
    const page = env.tab();
    const policies = deferred();
    mockNode.policies = policies.promise;
    const answer = page.ask('radicle_sync', { rid: RID });
    await flush();
    permissions.revokePermission(KEY_A);
    policies.resolve();
    expect(await answer).toEqual(CONNECTION_GONE);
    expect(mockNode.actions).toEqual([]);
  });

  test('after the name has moved: sync and getSeedStatus are refused, nothing fetched and no seedStatus; seed and unseed get no prompt', async () => {
    const env = setup();
    connect(NAME);
    const page = await env.named();
    env.names.set(NAME, OTHER_IPNS_KEY);
    for (const method of RADICLE_SEED_METHODS) {
      expect({ method, answer: await page.ask(method, { rid: RID }) }).toEqual({ method, answer: NO_ADDRESS });
    }
    expect(manager.refetchRepository).not.toHaveBeenCalled();
    expect(manager.getSeedFetchStatus).not.toHaveBeenCalled();
    expect(mockNode.listeners.size).toBe(0);
    expect(mockNode.actions).toEqual([]);
    expect(env.trace.filter((e) => e.kind === 'handle-opened')).toEqual([]);
    emit(mockStatusOf(RID, 'fetched'));
    await flush();
    expect(page.heard()).toEqual([]);
  });

  test('a seed status read answers keyless once the name moves during it', async () => {
    const env = setup();
    connect(NAME);
    const page = await env.named();
    let release;
    manager.getSeedFetchStatus.mockImplementationOnce(async (rid, onStatus) => {
      mockNode.listeners.add(onStatus);
      await new Promise((resolve) => {
        release = resolve;
      });
      return { success: true, status: mockStatusOf(rid, 'fetching') };
    });
    const answer = page.ask('radicle_getSeedStatus', { rid: RID });
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    release();
    expect(await answer).toEqual(NO_ADDRESS);
  });
});

describe('seedStatus from main (0011 PRQ-8b)', () => {
  test('a fetch\'s statuses reach every live document of the key, and no other', async () => {
    const env = setup();
    connect(KEY_A);
    permissions.setAutoApprove(KEY_A, 'node', true);
    const page = env.tab(`${KEY_A}/app`);
    const sibling = env.tab(`${KEY_A}/other`, { front: false });
    const stranger = env.tab(`${KEY_B}/`, { front: false });
    expect((await page.ask('radicle_seed', { rid: RID })).result.seeded).toBe(true);
    await flush();
    emit(mockStatusOf(RID, 'fetched'));
    await flush();
    const both = [mockStatusOf(RID, 'fetching'), mockStatusOf(RID, 'fetched')];
    expect(seedStatuses(page)).toEqual(both);
    expect(seedStatuses(sibling)).toEqual(both);
    expect(stranger.heard()).toEqual([]);
  });

  test('a name-keyed document hears them only while the name answers its key', async () => {
    const env = setup();
    connect(NAME);
    const page = await env.named();
    expect((await page.ask('radicle_getSeedStatus', { rid: RID })).result).toEqual(mockStatusOf(RID, 'fetching'));
    emit(mockStatusOf(RID, 'fetching'));
    await flush();
    expect(seedStatuses(page)).toHaveLength(1);
    env.names.set(NAME, OTHER_IPNS_KEY);
    emit(mockStatusOf(RID, 'fetched'));
    await flush();
    expect(seedStatuses(page)).toHaveLength(1);
    expect(env.trace.filter((e) => e.kind === 'event-refused').map((e) => [e.event, e.reason])).toEqual([['seedStatus', 'name-moved']]);
    // Its binding has ended: it hears no more.
    emit(mockStatusOf(RID, 'failed'));
    await flush();
    expect(seedStatuses(page)).toHaveLength(1);
  });

  test('PRQ-2\'s replaced-document race for seedStatus: the event carries the old document\'s nonce, which the new document drops', async () => {
    const env = setup();
    connect(KEY_A);
    const page = env.tab();
    await page.ask('radicle_getSeedStatus', { rid: RID });
    let release;
    env.hooks.beforeEventSend = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    emit(mockStatusOf(RID, 'fetched'));
    await flush();
    page.guest.commit(`${KEY_A}/app`);
    const reloaded = env.greet(page.guest);
    release();
    await flush();
    expect(page.guest.delivered.map((m) => [m.event, m.nonce])).toEqual([['seedStatus', page.nonce]]);
    expect(reloaded.heard()).toEqual([]);
  });

  test('each document\'s queue holds the statuses of at most its bound of repositories, sent one at a time', async () => {
    const env = setup();
    connect(NAME);
    const page = await env.named();
    await page.ask('radicle_getSeedStatus', { rid: RID });
    // The first status's delivery waits on the name's resolution.
    const held = deferred();
    env.gate.held = held.promise;
    const rid = (i) => `rad:z${String(i).padStart(30, '1')}`;
    emit(mockStatusOf(rid(0), 'fetching'));
    await flush();
    for (let i = 1; i <= 100; i += 1) emit(mockStatusOf(rid(i), 'fetching'));
    // An ending of one waiting replaces its status, and goes last.
    emit(mockStatusOf(rid(50), 'fetched'));
    env.gate.held = null;
    held.resolve();
    await flush();
    await flush();
    const expected = [mockStatusOf(rid(0), 'fetching')];
    for (let i = 101 - SEED_STATUS_QUEUE; i <= 100; i += 1) if (i !== 50) expected.push(mockStatusOf(rid(i), 'fetching'));
    expected.push(mockStatusOf(rid(50), 'fetched'));
    expect(SEED_STATUS_QUEUE).toBe(64);
    expect(seedStatuses(page)).toEqual(expected);
  });

  // Codex round 1 on #1203: a fetch that starts after another ended begins
  // a new record with no trace of the last one's ending, so an ending never
  // gives way to a later fetch's status.
  test('an ending waiting for a document is kept ahead of a later fetch another document starts', async () => {
    const env = setup();
    connect(KEY_A);
    const page = env.tab(`${KEY_A}/app`);
    const other = env.tab(`${KEY_A}/other`, { front: false });
    await page.ask('radicle_getSeedStatus', { rid: RID });
    // The page's first delivery is held between main's check and its send.
    let release;
    env.hooks.beforeEventSend = (_message, target) =>
      target.guest === page.guest.id
        ? new Promise((resolve) => {
          release = resolve;
        })
        : undefined;
    emit(mockStatusOf(RID, 'fetching'));
    await flush();
    // The first fetch ends while the page's delivery waits; the other
    // document then starts the next one.
    emit({ ...mockStatusOf(RID, 'failed'), lastError: 'the fetch failed' });
    expect(await other.ask('radicle_sync', { rid: RID })).toEqual({ result: { rid: RID, status: mockStatusOf(RID, 'fetching') } });
    env.hooks.beforeEventSend = undefined;
    release();
    await flush();
    const heard = [mockStatusOf(RID, 'fetching'), { ...mockStatusOf(RID, 'failed'), lastError: 'the fetch failed' }, mockStatusOf(RID, 'fetching')];
    expect(seedStatuses(page)).toEqual(heard);
    expect(seedStatuses(other)).toEqual(heard);
  });

  test('a newer ending replaces the one waiting, and the steps between', async () => {
    const env = setup();
    connect(NAME);
    const page = await env.named();
    await page.ask('radicle_getSeedStatus', { rid: RID });
    const held = deferred();
    env.gate.held = held.promise;
    emit(mockStatusOf(RID, 'fetching'));
    await flush();
    emit(mockStatusOf(RID, 'fetched'));
    emit(mockStatusOf(RID, 'fetching'));
    expect(seedStatuses(page)).toEqual([]);
    emit(mockStatusOf(RID, 'cancelled'));
    emit(mockStatusOf(RID, 'fetching'));
    env.gate.held = null;
    held.resolve();
    await flush();
    await flush();
    expect(seedStatuses(page)).toEqual([mockStatusOf(RID, 'fetching'), mockStatusOf(RID, 'cancelled'), mockStatusOf(RID, 'fetching')]);
  });

  test('a navigated document hears no later status, and a disconnect ends the site\'s subscription', async () => {
    const env = setup();
    connect(KEY_A);
    const page = env.tab();
    const other = env.tab(`${KEY_A}/x`, { front: false });
    await page.ask('radicle_getSeedStatus', { rid: RID });
    page.guest.commit(`${KEY_B}/`);
    const next = env.greet(page.guest);
    emit(mockStatusOf(RID, 'fetched'));
    await flush();
    expect(page.guest.delivered).toEqual([]);
    expect(next.heard()).toEqual([]);
    expect(seedStatuses(other)).toHaveLength(1);
    expect(await other.ask('radicle_disconnect')).toEqual({ result: { connected: false } });
    expect(manager.unsubscribeSeedStatus).toHaveBeenCalledWith(expect.any(Function));
    expect(mockNode.listeners.size).toBe(0);
  });
});

describe('the chrome\'s node rule writes (0011 PRQ-8b)', () => {
  test('radicle:set-auto-approve refuses turning the node rule on, and still turns it off; revoking stays open', async () => {
    connect(KEY_A);
    const chrome = { sender: { id: 501 } };
    for (const enabled of [true, 1, 'yes', null, undefined]) {
      expect(() => mockIpcHandlers['radicle:set-auto-approve'](chrome, KEY_A, 'node', enabled)).toThrow(
        'Radicle node auto-approve can only be turned off here'
      );
    }
    expect(permissions.getAutoApprove(KEY_A, 'node')).toBe(false);
    permissions.setAutoApprove(KEY_A, 'node', true);
    expect(mockIpcHandlers['radicle:set-auto-approve'](chrome, KEY_A, 'node', false)).toBe(true);
    expect(permissions.getAutoApprove(KEY_A, 'node')).toBe(false);
    expect(mockIpcHandlers['radicle:revoke-permission'](chrome, KEY_A)).toBe(true);
  });
});
