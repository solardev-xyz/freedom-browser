// window.radicle's signing through main, and no Radicle route left in the
// chrome (freedom-core design 0011, PRQ-8c), against the PRQ-8 row. Main's
// real request path (page-documents, page-requests, its prompts) runs the
// dispatcher (page-radicle.js) over main's real executeRadicleMethod,
// cob-service, auto-write limiter and Radicle permission store; the add-on's
// signed writes are in memory, and a test can hold one. Each guest's main
// frame records what main sends it (`page:event`).

const os = require('os');
const fs = require('fs');
const path = require('path');

const mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'page-radicle-sign-'));
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

// The add-on's signed writes: what it signed, and a write a test may hold.
const mockAddon = { writes: [], hold: null };
const mockWrite = (kind) =>
  jest.fn(async (...args) => {
    if (mockAddon.hold) await mockAddon.hold;
    mockAddon.writes.push([kind, ...args]);
    return { id: 'c'.repeat(40) };
  });
jest.mock('../radicle-embedded', () => ({
  createIssue: mockWrite('createIssue'),
  commentIssue: mockWrite('commentIssue'),
  editIssueState: mockWrite('editIssueState'),
  commentPatch: mockWrite('commentPatch'),
  identity: jest.fn(async () => ({ did: 'did:key:z6MkTest', nid: 'z6MkTest', alias: 'me' })),
  listSeededRepos: jest.fn(async () => []),
}));
jest.mock('../radicle-manager', () => ({
  // The add-on: no service generation, so no write refusal (plan B10).
  activeRadicleIdentity: jest.fn(() => null),
  radicleWriteRefusal: jest.fn(() => null),
  isDisabledForProfile: jest.fn(() => false),
  getCurrentStatus: jest.fn(() => ({ status: 'running', error: null })),
  getConnections: jest.fn(async () => ({ success: true, count: 3 })),
  seedRepository: jest.fn(),
  unseedRepository: jest.fn(),
  refetchRepository: jest.fn(),
  getSeedFetchStatus: jest.fn(),
  unsubscribeSeedStatus: jest.fn(),
  validateAndNormalizeRid: jest.fn((rid) => {
    const m = /^(?:rad:)?(z[1-9A-HJ-NP-Za-km-z]{20,60})$/.exec(rid ?? '');
    return m ? `rad:${m[1]}` : null;
  }),
  getNodeAlias: jest.fn(async () => 'me'),
  setNodeAlias: jest.fn(async () => ({ success: true })),
  STATUS: { STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', ERROR: 'error' },
}));

const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { CLASS, methodRow } = require('./page-methods');
const { RADICLE_SIGN_METHODS, createRadicleDispatchers, registerRadiclePageEvents } = require('./page-radicle');
const permissions = require('../radicle/radicle-permissions');
const provider = require('../radicle/radicle-provider-ipc');
const embedded = require('../radicle-embedded');
const manager = require('../radicle-manager');
const IPC = require('../../shared/ipc-channels');

permissions.registerRadiclePermissionsIpc();
provider.registerRadicleProviderIpc();

const CHROME_URL = 'file:///app/src/renderer/index.html';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const KEYLESS = 'data:text/html,<p>keyless</p>';
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const ISSUE = { rid: RID.slice(4), title: 'Bug', description: 'Steps', labels: ['ui'] };
const ISSUE_FIELDS = { rid: RID, title: 'Bug', description: 'Steps', labels: ['ui'] };
const WRITES = {
  radicle_createIssue: { rid: RID, title: 'Bug', description: 'Steps' },
  radicle_commentIssue: { rid: RID, issueId: 'a'.repeat(40), body: 'Same here' },
  radicle_editIssueState: { rid: RID, issueId: 'a'.repeat(40), state: 'closed' },
  radicle_commentPatch: { rid: RID, patchId: 'b'.repeat(40), body: 'LGTM' },
};

const NO_ADDRESS = {
  error: { code: 4100, message: 'This page has no address to connect from yet', data: { reason: 'no_address' } },
};
const REJECTED = { error: { code: 4001, message: 'User rejected the request' } };
const NOT_CONNECTED = { error: { code: 4100, message: 'Origin not authorized. Call radicle_requestAccess first.' } };
const CONNECTION_GONE = { error: { code: 4100, message: 'Origin not connected', data: { reason: 'not_connected' } } };
const SIGNING_GONE = { error: { code: 4100, message: 'Origin lacks the signing grant', data: { reason: 'signing_not_granted' } } };
const AGENT_CUSTODY = {
  error: { code: 4100, message: 'A page in Agent custody needs approval for this action', data: { reason: 'agent_custody' } },
};
const RULE_OFF = { error: { code: 4100, message: "This action needs the user's approval", data: { reason: 'not_auto_approved' } } };
const WRITTEN = { result: { id: 'c'.repeat(40) } };
// Under the Radicle service, a node running with a throwaway key (plan B10).
const THROWAWAY_KEY = {
  reason: 'needs_vault',
  message: "Radicle is running with a throwaway key and can't publish. Restart Radicle once your identity is set up.",
};
const NEEDS_VAULT = { error: { code: 4900, message: THROWAWAY_KEY.message, data: { reason: 'needs_vault' } } };
const IDENTITY = { result: { did: 'did:key:z6MkTest', nid: 'z6MkTest', alias: 'me' } };

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
  async function shown(kind = 'radicle.sign') {
    await flush();
    const prompt = prompts().at(-1);
    expect(prompt?.kind).toBe(kind);
    return prompt;
  }

  return { requests, documents, sent, trace, tab, greet, named, names, resolutions, gate, prompts, pending, decide, shown, guests, hooks, stopEvents, fire, custody };
}

const connect = (key, { signing = false, rule = false } = {}) => {
  permissions.grantPermission(key);
  if (signing) permissions.grantSigning(key);
  if (rule) permissions.setAutoApprove(key, 'signing', true);
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

beforeEach(() => {
  jest.clearAllMocks();
  permissions._resetCache();
  fs.rmSync(path.join(mockUserData, 'radicle-permissions.json'), { force: true });
  permissions.onRevoke(null);
  provider._resetAutoWriteLimiter();
  require('../radicle/cob-service').clearIdentityCache();
  mockAddon.writes = [];
  mockAddon.hold = null;
});

afterAll(() => {
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

describe('the signing methods main serves (0011 PRQ-8c)', () => {
  test('each has its row, name-revalidated; a keyless document and an unconnected site are refused with no prompt', async () => {
    for (const method of RADICLE_SIGN_METHODS) expect(methodRow('radicle', method).class).toBe(CLASS.NAME_REVALIDATED);
    const env = setup();
    const keyless = env.tab(KEYLESS);
    const page = env.tab(`${KEY_A}/app`);
    for (const method of RADICLE_SIGN_METHODS) {
      expect({ method, answer: await keyless.ask(method, WRITES[method]) }).toEqual({ method, answer: NO_ADDRESS });
      expect({ method, answer: await page.ask(method, WRITES[method]) }).toEqual({ method, answer: NOT_CONNECTED });
    }
    expect(env.trace.filter((e) => e.kind === 'handle-opened')).toEqual([]);
    expect(mockAddon.writes).toEqual([]);
    expect(embedded.identity).not.toHaveBeenCalled();
  });
});

describe('the signing grant and radicle_getIdentity through main (0011 PRQ-8c)', () => {
  test('a connected site is asked for the signing grant once; main writes it for the attested key, and discloses the identity', async () => {
    const env = setup();
    connect(KEY_A);
    connect(KEY_B);
    const page = env.tab();
    const answer = page.ask('radicle_getIdentity');
    const prompt = await env.shown();
    expect(prompt).toEqual({
      handle: expect.any(String),
      guest: page.guest.id,
      kind: 'radicle.sign',
      site: { key: KEY_A, label: KEY_A },
      view: { mode: 'grant', method: 'radicle_getIdentity' },
    });
    expect(await env.decide(prompt.handle, true, { site: KEY_B })).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(prompt.handle, true)).toEqual({ ok: true });
    expect(await answer).toEqual(IDENTITY);
    expect(permissions.hasSigningGrant(KEY_A)).toBe(true);
    expect(permissions.hasSigningGrant(KEY_B)).toBe(false);
    // Held now: no prompt.
    env.sent.length = 0;
    expect(await page.ask('radicle_getIdentity')).toEqual(IDENTITY);
    expect(env.prompts()).toEqual([]);
  });

  test('a rejected grant prompt grants nothing and discloses nothing', async () => {
    const env = setup();
    connect(KEY_A);
    const page = env.tab();
    const answer = page.ask('radicle_getIdentity');
    const prompt = await env.shown();
    expect(await env.decide(prompt.handle, false)).toEqual({ ok: true });
    expect(await answer).toEqual(REJECTED);
    expect(permissions.hasSigningGrant(KEY_A)).toBe(false);
    expect(embedded.identity).not.toHaveBeenCalled();
  });

  test('a name that moves off its IPNS key while the grant prompt is open gets no grant', async () => {
    const env = setup();
    connect(NAME);
    const page = await env.named();
    const answer = page.ask('radicle_getIdentity');
    const prompt = await env.shown();
    env.names.set(NAME, OTHER_IPNS_KEY);
    expect(await env.decide(prompt.handle, true)).toEqual({ ok: true });
    expect(await answer).toEqual(NO_ADDRESS);
    expect(permissions.hasSigningGrant(NAME)).toBe(false);
    expect(embedded.identity).not.toHaveBeenCalled();
  });

  test('after the name has moved, radicle_getIdentity discloses nothing; one whose name moves during its read answers keyless', async () => {
    const env = setup();
    connect(NAME, { signing: true });
    const page = await env.named();
    let release;
    embedded.identity.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ did: 'did:key:z6MkTest', nid: 'z6MkTest', alias: 'me' });
        })
    );
    const answer = page.ask('radicle_getIdentity');
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    release();
    expect(await answer).toEqual(NO_ADDRESS);
    require('../radicle/cob-service').clearIdentityCache();
    embedded.identity.mockClear();
    expect(await page.ask('radicle_getIdentity')).toEqual(NO_ADDRESS);
    expect(embedded.identity).not.toHaveBeenCalled();
  });
});

describe('the COB writes through main (0011 PRQ-8c)', () => {
  test('a write without the signing grant asks for it first, then shows exactly what it signs; main writes on approval', async () => {
    const env = setup();
    connect(KEY_A);
    const granted = permissions.getPermission(KEY_A);
    granted.lastUsed = Date.now() - 120_000;
    const stale = granted.lastUsed;
    const page = env.tab();
    const answer = page.ask('radicle_createIssue', ISSUE);
    const grant = await env.shown();
    expect(grant.view).toEqual({ mode: 'grant', method: 'radicle_createIssue' });
    // A decision is answered once main has answered its request, which
    // prompts again first.
    const granting = env.decide(grant.handle, true);
    await flush();
    expect(permissions.hasSigningGrant(KEY_A)).toBe(true);
    const prompt = env.prompts().at(-1);
    expect(prompt).toEqual({
      handle: expect.any(String),
      guest: page.guest.id,
      kind: 'radicle.sign',
      site: { key: KEY_A, label: KEY_A },
      view: { mode: 'write', method: 'radicle_createIssue', ...ISSUE_FIELDS, agentHeld: false, alwaysAllow: false },
    });
    expect(mockAddon.writes).toEqual([]);
    // Only "always allow", and only as a boolean.
    expect(await env.decide(prompt.handle, true, { alwaysAllow: 'yes' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(prompt.handle, true, { identity: 'x' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(prompt.handle, true)).toEqual({ ok: true });
    expect(await answer).toEqual(WRITTEN);
    expect(await granting).toEqual({ ok: true });
    expect(mockAddon.writes).toEqual([['createIssue', RID, 'Bug', 'Steps', ['ui']]]);
    expect(permissions.getPermission(KEY_A).lastUsed).toBeGreaterThan(stale);
    expect(permissions.getAutoApprove(KEY_A, 'signing')).toBe(false);
  });

  test('each write prompts with its own fields; a rejection writes nothing; params the write refuses get no prompt', async () => {
    const env = setup();
    connect(KEY_A, { signing: true });
    const page = env.tab();
    for (const [method, params] of Object.entries(WRITES)) {
      const answer = page.ask(method, params);
      const prompt = await env.shown();
      expect(prompt.view).toEqual({ mode: 'write', method, ...params, agentHeld: false, alwaysAllow: false });
      expect(await env.decide(prompt.handle, false)).toEqual({ ok: true });
      expect(await answer).toEqual(REJECTED);
    }
    expect(mockAddon.writes).toEqual([]);
    env.sent.length = 0;
    expect(await page.ask('radicle_createIssue', { rid: RID, title: '', description: 'x' })).toEqual({
      error: { code: -32602, message: 'title must be a non-empty string', data: { reason: 'invalid_title' } },
    });
    expect(await page.ask('radicle_commentIssue', { rid: 'nope', issueId: 'a'.repeat(40), body: 'x' })).toEqual({
      error: { code: -32602, message: 'Invalid Radicle repository ID', data: { reason: 'invalid_rid' } },
    });
    expect(await page.ask('radicle_editIssueState', { ...WRITES.radicle_editIssueState, state: 'merged' })).toEqual({
      error: { code: -32602, message: "state must be 'open', 'closed' or 'solved'", data: { reason: 'invalid_state' } },
    });
    expect(env.prompts()).toEqual([]);
  });

  test('"always allow" turns the site\'s rule on, by main; the rule then answers with no prompt', async () => {
    const env = setup();
    connect(KEY_A, { signing: true });
    const page = env.tab();
    const answer = page.ask('radicle_commentIssue', WRITES.radicle_commentIssue);
    const prompt = await env.shown();
    expect(await env.decide(prompt.handle, true, { alwaysAllow: true })).toEqual({ ok: true });
    expect(await answer).toEqual(WRITTEN);
    expect(permissions.getAutoApprove(KEY_A, 'signing')).toBe(true);
    env.sent.length = 0;
    expect(await page.ask('radicle_commentPatch', WRITES.radicle_commentPatch)).toEqual(WRITTEN);
    expect(env.prompts()).toEqual([]);
    expect(mockAddon.writes.map(([kind]) => kind)).toEqual(['commentIssue', 'commentPatch']);
  });

  test('past the rule\'s limit a write falls back to its prompt, which can turn the rule off', async () => {
    const env = setup();
    connect(KEY_A, { signing: true, rule: true });
    const page = env.tab();
    // A burst of five.
    for (let i = 0; i < 5; i += 1) expect(await page.ask('radicle_createIssue', WRITES.radicle_createIssue)).toEqual(WRITTEN);
    expect(env.prompts()).toEqual([]);
    const answer = page.ask('radicle_createIssue', WRITES.radicle_createIssue);
    const prompt = await env.shown();
    expect(prompt.view).toMatchObject({ mode: 'write', agentHeld: false, alwaysAllow: true });
    expect(mockAddon.writes).toHaveLength(5);
    expect(await env.decide(prompt.handle, true, { alwaysAllow: false })).toEqual({ ok: true });
    expect(await answer).toEqual(WRITTEN);
    expect(mockAddon.writes).toHaveLength(6);
    expect(permissions.getAutoApprove(KEY_A, 'signing')).toBe(false);
  });

  test('the rule is never chosen for a tab in Agent custody, whose prompt offers no rule; the user\'s approval still writes', async () => {
    const env = setup();
    connect(KEY_A, { signing: true, rule: true });
    const page = env.tab();
    env.custody.add(page.guest.id);
    const answer = page.ask('radicle_editIssueState', WRITES.radicle_editIssueState);
    const prompt = await env.shown();
    expect(prompt.view).toMatchObject({ agentHeld: true, alwaysAllow: false });
    // The request keeps its prompt when custody ends.
    env.custody.delete(page.guest.id);
    expect(await env.decide(prompt.handle, true, { alwaysAllow: true })).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(prompt.handle, true)).toEqual({ ok: true });
    expect(await answer).toEqual(WRITTEN);
    expect(permissions.getAutoApprove(KEY_A, 'signing')).toBe(true);
    // Out of custody, the rule answers again.
    env.sent.length = 0;
    expect(await page.ask('radicle_editIssueState', WRITES.radicle_editIssueState)).toEqual(WRITTEN);
    expect(env.prompts()).toEqual([]);
    expect(mockAddon.writes).toHaveLength(2);
  });

  test.each([
    ['enters Agent custody', (env, page) => env.custody.add(page.guest.id), AGENT_CUSTODY],
    ['has its rule turned off', () => permissions.setAutoApprove(NAME, 'signing', false), RULE_OFF],
    ['loses its connection', () => permissions.revokePermission(NAME), CONNECTION_GONE],
    ['loses its signing grant', () => {
      permissions.revokePermission(NAME);
      permissions.grantPermission(NAME);
      permissions.setAutoApprove(NAME, 'signing', true);
    }, SIGNING_GONE],
    ['has its name move off its IPNS key', (env) => env.names.set(NAME, OTHER_IPNS_KEY), NO_ADDRESS],
  ])('a rule-answered write whose tab %s before its guard signs nothing', async (_label, change, refusal) => {
    const env = setup();
    connect(NAME, { signing: true, rule: true });
    const page = await env.named();
    const guardCheck = deferred();
    // The dispatcher's own check answers; the guard's waits.
    env.gate.queue.push({ wait: Promise.resolve(), key: IPNS_KEY }, { wait: guardCheck.promise });
    const answer = page.ask('radicle_createIssue', WRITES.radicle_createIssue);
    await flush();
    expect(env.resolutions).toEqual([NAME, NAME]);
    change(env, page);
    guardCheck.resolve();
    expect(await answer).toEqual(refusal);
    expect(mockAddon.writes).toEqual([]);
    expect(env.prompts()).toEqual([]);
  });

  test('a name that moves off its IPNS key while the write prompt is open signs nothing', async () => {
    const env = setup();
    connect(NAME, { signing: true });
    const page = await env.named();
    const answer = page.ask('radicle_commentIssue', WRITES.radicle_commentIssue);
    const prompt = await env.shown();
    env.names.set(NAME, OTHER_IPNS_KEY);
    expect(await env.decide(prompt.handle, true, { alwaysAllow: true })).toEqual({ ok: true });
    expect(await answer).toEqual(NO_ADDRESS);
    expect(mockAddon.writes).toEqual([]);
    // Nor did "always allow" turn the rule on for the name.
    expect(permissions.getAutoApprove(NAME, 'signing')).toBe(false);
  });

  test('a write that went out after its guard answers as written, even if the name moves while the add-on writes', async () => {
    const env = setup();
    connect(NAME, { signing: true, rule: true });
    const page = await env.named();
    const hold = deferred();
    mockAddon.hold = hold.promise;
    const answer = page.ask('radicle_createIssue', WRITES.radicle_createIssue);
    await flush();
    expect(embedded.createIssue).toHaveBeenCalledTimes(1);
    env.names.set(NAME, OTHER_IPNS_KEY);
    expect(await page.ask('radicle_getIdentity')).toEqual(NO_ADDRESS);
    hold.resolve();
    expect(await answer).toEqual(WRITTEN);
    expect(mockAddon.writes).toHaveLength(1);
  });

  test('after the name has moved, every write is refused with no prompt and nothing signed', async () => {
    const env = setup();
    connect(NAME, { signing: true });
    const page = await env.named();
    env.names.set(NAME, OTHER_IPNS_KEY);
    for (const [method, params] of Object.entries(WRITES)) {
      expect({ method, answer: await page.ask(method, params) }).toEqual({ method, answer: NO_ADDRESS });
    }
    expect(env.trace.filter((e) => e.kind === 'handle-opened')).toEqual([]);
    expect(mockAddon.writes).toEqual([]);
  });
});

// Plan B10 (freedom-core design 0008, Main's side, `needs_vault`): while
// the service's running generation has a throwaway key, main refuses each
// COB write before anything is sent: before the write's prompt, before the
// rule's limit counts it, and in the guard's run just before the call.
describe('a node running with a throwaway key (radicled B10)', () => {
  afterEach(() => {
    manager.radicleWriteRefusal.mockReset();
    manager.radicleWriteRefusal.mockReturnValue(null);
  });

  test('every write is refused with no prompt, nothing signed and no rule slot spent; the identity is still disclosed', async () => {
    manager.radicleWriteRefusal.mockReturnValue(THROWAWAY_KEY);
    const env = setup();
    connect(KEY_A, { signing: true });
    connect(KEY_B, { signing: true, rule: true });
    const page = env.tab();
    const ruled = env.tab(`${KEY_B}/app`);
    for (const [method, params] of Object.entries(WRITES)) {
      expect({ method, answer: await page.ask(method, params) }).toEqual({ method, answer: NEEDS_VAULT });
      expect({ method, answer: await ruled.ask(method, params) }).toEqual({ method, answer: NEEDS_VAULT });
    }
    // Params the write refuses keep the method's own answer.
    expect(await page.ask('radicle_createIssue', { rid: RID, title: '', description: 'x' })).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_title' } },
    });
    expect(env.prompts()).toEqual([]);
    expect(mockAddon.writes).toEqual([]);
    expect(await page.ask('radicle_getIdentity')).toEqual(IDENTITY);

    // The node restarts with the derived key: the rule's whole burst is left.
    manager.radicleWriteRefusal.mockReturnValue(null);
    for (let i = 0; i < 5; i += 1) expect(await ruled.ask('radicle_createIssue', WRITES.radicle_createIssue)).toEqual(WRITTEN);
    expect(env.prompts()).toEqual([]);
  });

  test('a restart with a throwaway key while the write prompt is open: the approved write is refused, nothing signed', async () => {
    const env = setup();
    connect(KEY_A, { signing: true });
    const page = env.tab();
    const answer = page.ask('radicle_commentIssue', WRITES.radicle_commentIssue);
    const prompt = await env.shown();
    manager.radicleWriteRefusal.mockReturnValue(THROWAWAY_KEY);
    expect(await env.decide(prompt.handle, true)).toEqual({ ok: true });
    expect(await answer).toEqual(NEEDS_VAULT);
    expect(mockAddon.writes).toEqual([]);
    expect(embedded.commentIssue).not.toHaveBeenCalled();
  });

  test("a restart with a throwaway key while the guard waits: refused in the guard's run, nothing signed", async () => {
    const env = setup();
    connect(NAME, { signing: true, rule: true });
    const page = await env.named();
    const guardCheck = deferred();
    // The dispatcher's own check answers; the guard's waits.
    env.gate.queue.push({ wait: Promise.resolve(), key: IPNS_KEY }, { wait: guardCheck.promise });
    const answer = page.ask('radicle_createIssue', WRITES.radicle_createIssue);
    await flush();
    expect(env.resolutions).toEqual([NAME, NAME]);
    manager.radicleWriteRefusal.mockReturnValue(THROWAWAY_KEY);
    guardCheck.resolve();
    expect(await answer).toEqual(NEEDS_VAULT);
    expect(mockAddon.writes).toEqual([]);
    expect(embedded.createIssue).not.toHaveBeenCalled();
    expect(env.prompts()).toEqual([]);
  });
});

describe('no Radicle route or grant write left to the chrome (0011 PRQ-8c)', () => {
  test('the chrome\'s grant-signing and turning the signing rule on are refused for every site; turning it off and revoking stay open', () => {
    const chrome = { sender: { id: 501 } };
    connect(KEY_A, { signing: false, rule: false });
    for (const site of [KEY_A, 'name.eth', 'https://other.example']) {
      expect(() => mockIpcHandlers[IPC.RADICLE_GRANT_SIGNING](chrome, site)).toThrow(
        'The Radicle signing grant is given only from its own prompt'
      );
      for (const enabled of [true, 1, 'yes', null, undefined]) {
        expect(() => mockIpcHandlers[IPC.RADICLE_SET_AUTO_APPROVE](chrome, site, 'signing', enabled)).toThrow(
          'Radicle signing auto-approve is turned on only from a write prompt'
        );
      }
    }
    expect(permissions.hasSigningGrant(KEY_A)).toBe(false);
    expect(permissions.getAutoApprove(KEY_A, 'signing')).toBe(false);
    permissions.grantSigning(KEY_A);
    permissions.setAutoApprove(KEY_A, 'signing', true);
    expect(mockIpcHandlers[IPC.RADICLE_SET_AUTO_APPROVE](chrome, KEY_A, 'signing', false)).toBe(true);
    expect(permissions.getAutoApprove(KEY_A, 'signing')).toBe(false);
    expect(mockIpcHandlers[IPC.RADICLE_REVOKE_PERMISSION](chrome, KEY_A)).toBe(true);
  });

  test('nothing the chrome can call widens a Radicle grant (a sweep over every radicle: channel)', async () => {
    // Every radicle: channel main registers for the chrome: the permission
    // store's and the provider's here; the node manager's elsewhere, which
    // never reads or writes the permission store.
    const registered = Object.keys(mockIpcHandlers).filter((channel) => channel.startsWith('radicle:'));
    const declared = Object.values(IPC).filter((channel) => typeof channel === 'string' && channel.startsWith('radicle:'));
    const managerSource = fs.readFileSync(path.join(__dirname, '../radicle-manager.js'), 'utf-8');
    const managerChannels = [...managerSource.matchAll(/ipcMain\.handle\(IPC\.([A-Z_]+)/g)].map((m) => IPC[m[1]]);
    expect(managerSource).not.toMatch(/radicle-permissions/);
    // Events main sends the chrome, which it never calls.
    const pushed = [IPC.RADICLE_STATUS_UPDATE, IPC.RADICLE_SEED_STATUS_UPDATE];
    expect([...registered, ...managerChannels, ...pushed].sort()).toEqual([...declared].sort());
    expect(registered).not.toContain('radicle:provider-execute');

    // Sites in each state a grant write could widen.
    const SITES = {
      none: 'https://none.example',
      connected: 'https://connected.example',
      signing: 'https://signing.example',
    };
    const state = () =>
      Object.fromEntries(
        Object.entries(SITES).map(([label, site]) => {
          const permission = permissions.getPermission(site);
          return [
            label,
            permission
              ? { connected: true, signing: permission.signing === true, node: permission.autoApprove?.node === true, rule: permission.autoApprove?.signing === true }
              : { connected: false, signing: false, node: false, rule: false },
          ];
        })
      );
    const widened = (before, after) =>
      Object.keys(SITES).filter((label) =>
        ['connected', 'signing', 'node', 'rule'].some((field) => after[label][field] && !before[label][field])
      );
    const reset = () => {
      for (const site of Object.values(SITES)) permissions.revokePermission(site);
      permissions.grantPermission(SITES.connected);
      permissions.grantPermission(SITES.signing);
      permissions.grantSigning(SITES.signing);
    };
    // Every argument shape a grant write took, and the chrome's old route's.
    const shapes = (site) => [
      [site],
      [site, true],
      [site, 'node', true],
      [site, 'signing', true],
      [site, 'signing', 1],
      [site, 'node', 'yes'],
      [{ origin: site }],
      [{ method: 'radicle_requestAccess', params: {}, origin: site, meta: { approval: 'user' } }],
      [{ method: 'radicle_createIssue', params: WRITES.radicle_createIssue, origin: site, meta: { approval: 'auto' } }],
    ];
    const chrome = { sender: { id: 501 } };
    for (const channel of registered) {
      for (const site of Object.values(SITES)) {
        for (const args of shapes(site)) {
          reset();
          const before = state();
          try {
            await mockIpcHandlers[channel](chrome, ...args);
          } catch {
            // Refused.
          }
          expect({ channel, args, widened: widened(before, state()) }).toEqual({ channel, args, widened: [] });
        }
      }
    }
    expect(mockAddon.writes).toEqual([]);
  });
});
