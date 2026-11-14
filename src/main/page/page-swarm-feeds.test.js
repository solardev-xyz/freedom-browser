// Swarm feeds and signing through main (freedom-core design 0011, PRQ-7d),
// against the PRQ-7 row. Main's real request path (page-documents,
// page-requests, its prompts) runs the dispatcher (page-swarm.js) over
// main's real executeSwarmMethod, Swarm permission store and feed store;
// the identity core and the node's writes are in memory, and a test can
// hold the identity core's signature or the write itself. Each write goes
// through the caller's guard (`guard(send)`), as feed-service.js and
// chunk-service.js run it, and stops on the request's signal.

const os = require('os');
const { useSimulatedGrantCore, testPage } = require('../../../test/helpers/simulated-grant-core');
const fs = require('fs');
const path = require('path');

const mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'page-swarm-feeds-'));
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
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }));

// The vault's keys, as the identity manager derives their addresses.
const mockVault = { unlocked: true };
jest.mock('../identity-manager', () => ({
  getBeeWalletAddress: async () => (mockVault.unlocked ? '0xBee0000000000000000000000000000000000000' : null),
  getPublisherAddress: async (index) => {
    if (!mockVault.unlocked) throw new Error('Vault must be unlocked to derive publisher keys');
    return `0xPublisher${index}`;
  },
  getDerivedWallets: async () => [],
}));

// The identity core and the node: what was signed and written, and the
// waits a test may hold.
const mockNode = { writes: [], signals: [], socs: [], sign: null, write: null, readiness: null };
function mockAborted(signal) {
  return new Promise((_resolve, reject) => {
    const stop = () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
}
// As the services: the identity core's signature (for a signed write), then
// the write under the caller's guard, which resolves null to write nothing.
async function mockWrite(kind, signed, options = {}, result = {}, signer = null) {
  mockNode.signals.push(options.signal);
  // The chunk's signature, through the signer the provider gave: a page's
  // goes under `page` with its authorization (design 0012, APB-3).
  if (signed) await signer.signSoc({ identifier: new Uint8Array(32), payload: new Uint8Array(1) });
  if (signed && mockNode.sign) await Promise.race([mockNode.sign, mockAborted(options.signal)]);
  const send = async () => {
    mockNode.writes.push(kind);
    if (mockNode.write) await Promise.race([mockNode.write, mockAborted(options.signal)]);
    return result;
  };
  const sent = options.guard ? await options.guard(send) : await send();
  return sent === null ? null : sent;
}
jest.mock('../swarm/feed-service', () => ({
  buildTopicString: (origin, name) => `${origin}/${name}`,
  createFeed: (signer, topic, batchId, options) =>
    mockWrite('createFeed', false, options, {
      topic: 'ab'.repeat(32),
      owner: signer.owner,
      manifestReference: 'cd'.repeat(32),
      bzzUrl: `bzz://${'cd'.repeat(32)}`,
    }),
  updateFeed: (signer, topic, reference, batchId, options) => mockWrite('updateFeed', true, options, { index: 3 }, signer),
  writeFeedPayload: (signer, topic, data, options) => {
    if (typeof data === 'string') options?.copied?.('payload');
    return mockWrite('writeFeedEntry', true, options, { index: 4 }, signer);
  },
  readFeedPayload: jest.fn(),
}));
jest.mock('../swarm/chunk-service', () => ({
  writeSingleOwnerChunk: async (signer, identifier, payload, options) => {
    const out = await mockWrite('writeSingleOwnerChunk', true, options, 'ef'.repeat(32), signer);
    return out === null ? null : { reference: out, owner: signer.owner, identifier, batchIdUsed: 'batch' };
  },
}));
jest.mock('../swarm/swarm-signer', () => ({
  resolveSwarmSigner: async (identity) => {
    if (!mockVault.unlocked) throw new Error('Vault must be unlocked');
    const mode = identity?.mode || identity?.identityMode;
    if (mode === 'ethereum-wallet') throw new Error('The Ethereum wallet identity mode was removed');
    return {
      owner: mode === 'bee-wallet' ? '0xBee0000000000000000000000000000000000000' : `0xPublisher${identity.publisherKeyIndex}`,
      signSoc: async (_chunk, options) => {
        mockNode.socs.push(options);
        return {};
      },
    };
  },
  getIdentityMode: (identity) => identity?.mode || identity?.identityMode || null,
}));
jest.mock('../swarm/messaging-service', () => ({ MAX_MESSAGE_BYTES: 4000, MAX_TARGET_DEPTH: 3, DEFAULT_TARGET_DEPTH: 2 }));
jest.mock('../service-registry', () => ({ getAntApiUrl: () => 'http://127.0.0.1:1633' }));
jest.mock('../swarm/publish-setup-service', () => ({
  getPublishReadiness: async () => (mockNode.readiness ? mockNode.readiness : { ok: true }),
}));
jest.mock('../swarm/publish-service', () => ({}));
jest.mock('../swarm/publish-history', () => ({ addEntry: () => ({ id: 1 }), updateEntry: () => {} }));
jest.mock('../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
// The manifest's fetch goes through the bzz: handler, which this suite never
// reaches (main's dispatcher here checks manifests with a stub).
jest.mock('../swarm/bzz-protocol', () => ({ handleBzzRequest: jest.fn() }));

global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) }));

const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { createSwarmDispatchers, SWARM_FEED_METHODS } = require('./page-swarm');
const permissions = require('../swarm/swarm-permissions');
const feeds = require('../swarm/feed-store');
const manifests = require('../swarm/permission-manifests');
const { registerSwarmProviderIpc } = require('../swarm/swarm-provider-ipc');

registerSwarmProviderIpc();
permissions.registerSwarmPermissionsIpc();
feeds.registerFeedStoreIpc();
manifests.registerPermissionManifestIpc();

const CHROME_URL = 'file:///app/src/renderer/index.html';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';
const BEE = '0xBee0000000000000000000000000000000000000';
const IDENTIFIER = 'cc'.repeat(32);
const REFERENCE = 'aa'.repeat(32);

// Each method's params, and its rule.
let createCount = 0;
const CASES = {
  // A feed that exists already is answered from its record, with no write:
  // each create here names a new one.
  get swarm_createFeed() {
    return { params: { name: `feed${(createCount += 1)}` }, rule: 'feeds' };
  },
  swarm_updateFeed: { params: { feedId: 'blog', reference: REFERENCE }, rule: 'feeds' },
  swarm_writeFeedEntry: { params: { name: 'blog', data: 'entry' }, rule: 'feeds' },
  swarm_writeSingleOwnerChunk: { params: { identifier: IDENTIFIER, data: 'chunk' }, rule: 'signing' },
  swarm_getSigningIdentity: { params: {}, rule: 'signing' },
};

const NO_ADDRESS = {
  error: { code: 4100, message: 'This page has no address to connect from yet', data: { reason: 'no_address' } },
};
const AGENT_CUSTODY = {
  error: { code: 4100, message: 'The origin is not authorized for this operation', data: { reason: 'agent_custody' } },
};
const RULE_OFF = {
  error: { code: 4100, message: 'The origin is not authorized for this operation', data: { reason: 'not_auto_approved' } },
};
const NOT_CONNECTED = { error: { code: 4100, message: 'Origin not authorized. Call swarm_requestAccess first.' } };
const FEED_REJECTED = { error: { code: 4001, message: 'User rejected feed access' } };
const UNLOCK_CANCELLED = { error: { code: 4001, message: 'User cancelled unlock' } };

let nextId = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const held = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

class Guest extends EventEmitter {
  constructor({ window = 1 } = {}) {
    super();
    this.id = nextId++;
    this.window = window;
    this.hostWebContents = { id: 500 + window, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
    this.destroyed = false;
    this.mainFrame = this.frame('about:blank');
  }

  frame(url) {
    return { url, frameTreeNodeId: 1000 + this.id, processId: 1, routingId: this.id, detached: false, send: jest.fn() };
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
  const documents = createPageDocuments({
    isPrivateWebContents: () => false,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent: async (name) => {
      const key = names.get(name);
      return key ? { type: 'ok', protocol: 'ipns', decoded: key } : { type: 'not_found' };
    },
  });
  const state = { custody: new Set(), checks: [], routed: [] };
  const sent = [];
  const trace = [];
  const copies = [];
  const timers = [];
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers: createSwarmDispatchers({
      identityWalletEnabled: () => true,
      inCustody: (guest) => state.custody.has(guest),
      guestContents: (id) => guests.get(id),
      checkManifest: async (request) => {
        state.checks.push({ key: request.key, eager: request.eager });
        return { kind: 'legacy' };
      },
      decideManifest: async () => ({ allowed: true, mode: 'allow' }),
      releaseManifest: () => {},
      isVaultUnlocked: () => mockVault.unlocked,
      routeToSetup: (requester, reason) => state.routed.push({ key: requester.key, reason }),
    }),
    hooks: { onTrace: (entry) => trace.push(entry), onCopy: (entry) => copies.push(entry) },
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

  function greet(guest) {
    const n = nonce();
    expect(requests.hello(eventFrom(guest), { nonce: n }).ok).toBe(true);
    return {
      guest,
      nonce: n,
      ask: (method, params = {}) => requests.request(eventFrom(guest), { nonce: n, provider: 'swarm', method, params }),
    };
  }

  function tab(url = `${KEY_A}/app`, { window = 1, bind = null, front = true } = {}) {
    const guest = new Guest({ window });
    guests.set(guest.id, guest);
    requests.track(guest);
    if (bind) {
      expect(
        requests.bindName({ sender: guest.hostWebContents }, { guest: guest.id, name: bind, key: url.slice(7).split('/')[0] })
      ).toBe(true);
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
    return page;
  }

  const fire = (ms) => {
    for (const timer of timers.filter((t) => t.ms === ms && !t.cleared)) {
      timer.cleared = true;
      timer.fn();
    }
  };
  const prompts = (windowId = 1) => sent.filter(([w, c]) => w === windowId && c === 'page:prompt').map(([, , p]) => p);
  const decide = (handle, approve, choices, windowId = 1) =>
    requests.decide({ sender: { id: 500 + windowId } }, { handle, approve, choices });
  async function shown(kind) {
    await flush();
    const prompt = prompts().at(-1);
    expect(prompt?.kind).toBe(kind);
    return prompt;
  }

  return { requests, state, trace, copies, tab, greet, named, names, prompts, decide, shown, fire };
}

/** A site with feed access, an app-scoped identity, its rules, and the feed `blog`. */
async function grantFeeds(key, { feeds: feedsRule = false, signing = false } = {}) {
  const page = { page: testPage(key) };
  if (!permissions.getPermission(key)) await permissions.grantPermission(key, page);
  feeds.createAppScopedIdentity(key, { activate: true, source: 'manifest' });
  feeds.grantFeedAccess(key, { source: 'manifest' });
  feeds.setFeed(key, 'blog', { topic: 'ab'.repeat(32), owner: '0xPublisher0', manifestReference: 'cd'.repeat(32), identityId: feeds.getOriginEntry(key).activeIdentityId });
  if (feedsRule) await permissions.setAutoApprove(key, 'feeds', true, page);
  if (signing) await permissions.setAutoApprove(key, 'signing', true, page);
}

beforeEach(async () => {
  await useSimulatedGrantCore();
  feeds._resetCache();
  fs.rmSync(path.join(mockUserData, 'swarm-feeds.json'), { force: true });
  mockVault.unlocked = true;
  mockNode.writes = [];
  mockNode.signals = [];
  mockNode.socs = [];
  mockNode.sign = null;
  mockNode.write = null;
  mockNode.readiness = null;
});

afterAll(() => {
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

describe('feeds and signing through main (0011 PRQ-7d)', () => {
  test('main\'s feed prompt carries the site\'s identities and their owners; on approval main makes the pick the site\'s, grants feed access and the rule, and writes', async () => {
    const env = setup();
    await permissions.grantPermission(KEY_A, { page: testPage(KEY_A) });
    const page = env.tab();
    const answer = page.ask('swarm_createFeed', { name: 'blog' });
    const prompt = await env.shown('swarm.feed');
    expect(prompt.site).toEqual({ key: KEY_A, label: KEY_A });
    expect(prompt.view).toEqual({
      method: 'swarm_createFeed',
      mode: 'feeds',
      name: 'blog',
      identities: [
        { id: 'bee-wallet', mode: 'bee-wallet', label: 'Bee wallet identity', owner: BEE, shared: true, stored: false, unavailable: false },
      ],
      newIdentity: { id: 'app-scoped:0', mode: 'app-scoped', label: 'App-scoped identity 1', owner: '0xPublisher0', shared: false, stored: false, unavailable: false },
      activeIdentityId: 'app-scoped:0',
    });
    expect(feeds.hasFeedGrant(KEY_A)).toBe(false);
    // The chrome names no site, and picks only an identity the view offers.
    expect(await env.decide(prompt.handle, true, { identity: 'app-scoped:0', site: KEY_B })).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(prompt.handle, true, { identity: 'app-scoped:9' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(prompt.handle, true, { identity: 'app-scoped:0', alwaysAllow: 'yes' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(prompt.handle, true, { identity: 'app-scoped:0', alwaysAllow: true })).toEqual({ ok: true });
    expect(await answer).toEqual({
      result: {
        feedId: 'blog',
        owner: '0xPublisher0',
        topic: 'ab'.repeat(32),
        manifestReference: 'cd'.repeat(32),
        bzzUrl: `bzz://${'cd'.repeat(32)}`,
        identityMode: 'app-scoped',
      },
    });
    // Main's writes, for the attested key alone.
    expect(feeds.getOriginEntry(KEY_A)).toMatchObject({ activeIdentityId: 'app-scoped:0', feedGranted: true });
    expect(feeds.getFeed(KEY_A, 'blog')).toMatchObject({ manifestReference: 'cd'.repeat(32) });
    expect(permissions.getAutoApprove(KEY_A, 'feeds')).toBe(true);
    expect(permissions.getAutoApprove(KEY_A, 'signing')).toBe(false);
    expect(feeds.getOriginEntry(KEY_B)).toBeNull();
    // The rule answers the next feed writes, with no prompt.
    const count = env.prompts().length;
    expect((await page.ask('swarm_writeFeedEntry', { name: 'blog', data: 'hi' })).result).toEqual({ index: 4 });
    expect((await page.ask('swarm_updateFeed', { feedId: 'blog', reference: REFERENCE })).result).toMatchObject({ index: 3 });
    expect(env.prompts()).toHaveLength(count);
    expect(mockNode.writes).toEqual(['createFeed', 'writeFeedEntry', 'updateFeed']);
  });

  // Design 0012, "A page's SOC" (APB-3): each chunk a page's write signs
  // goes to the identity core under `page`, with the requester's
  // PageContext and how main approved it, never as main's own.
  test('each SOC a page signs goes under page, with its approval: the rule\'s (auto) or the prompt\'s (user), a feed write or a raw one', async () => {
    const env = setup();
    await grantFeeds(KEY_A, { feeds: true });
    const page = env.tab();
    const context = { origin: KEY_A, top_origin: KEY_A, frame: expect.any(Number), navigation: expect.any(Number), agent: false };
    expect((await page.ask('swarm_writeFeedEntry', { name: 'blog', data: 'hi' })).result).toEqual({ index: 4 });
    expect((await page.ask('swarm_updateFeed', { feedId: 'blog', reference: REFERENCE })).result).toMatchObject({ index: 3 });
    // The signing rule is off: a raw chunk is the prompt's.
    const answer = page.ask('swarm_writeSingleOwnerChunk', CASES.swarm_writeSingleOwnerChunk.params);
    const prompt = await env.shown('swarm.feed');
    expect(await env.decide(prompt.handle, true, { identity: prompt.view.activeIdentityId })).toEqual({ ok: true });
    expect((await answer).result).toMatchObject({ reference: 'ef'.repeat(32) });
    expect(mockNode.socs).toEqual([
      { page: context, authorization: { swarm: 'auto', soc: 'feed' } },
      { page: context, authorization: { swarm: 'auto', soc: 'feed' } },
      { page: context, authorization: { swarm: 'user', soc: 'raw' } },
    ]);
  });

  test('the pick: the Ant wallet\'s identity, or one the site has, made active; a raw single-owner chunk is refused a shared one', async () => {
    const env = setup();
    await permissions.grantPermission(KEY_A, { page: testPage(KEY_A) });
    const page = env.tab();
    let answer = page.ask('swarm_createFeed', { name: 'blog' });
    let prompt = await env.shown('swarm.feed');
    await env.decide(prompt.handle, true, { identity: 'bee-wallet' });
    expect((await answer).result).toMatchObject({ owner: BEE, identityMode: 'bee-wallet' });
    expect(feeds.getOriginEntry(KEY_A)).toMatchObject({ activeIdentityId: 'bee-wallet', feedGranted: true });

    // Signing a raw chunk: the shared Ant wallet's identity is no choice.
    answer = page.ask('swarm_writeSingleOwnerChunk', { identifier: IDENTIFIER, data: 'x' });
    prompt = await env.shown('swarm.feed');
    expect(prompt.view).toMatchObject({ method: 'swarm_writeSingleOwnerChunk', mode: 'signing', identifier: IDENTIFIER, activeIdentityId: 'bee-wallet' });
    expect(prompt.view.identities.map((i) => [i.id, i.shared, i.stored])).toEqual([['bee-wallet', true, true]]);
    expect(await env.decide(prompt.handle, true, { identity: 'bee-wallet' })).toEqual({ ok: false, reason: 'invalid' });
    await env.decide(prompt.handle, true, { identity: prompt.view.newIdentity.id });
    expect((await answer).result).toMatchObject({ owner: '0xPublisher0', identifier: IDENTIFIER });
    expect(feeds.getOriginEntry(KEY_A).activeIdentityId).toBe('app-scoped:0');

    // Back to one the site has.
    answer = page.ask('swarm_getSigningIdentity');
    prompt = await env.shown('swarm.feed');
    await env.decide(prompt.handle, true, { identity: 'bee-wallet' });
    expect(await answer).toEqual({ result: { owner: BEE, identityMode: 'bee-wallet' } });
    expect(feeds.getOriginEntry(KEY_A).activeIdentityId).toBe('bee-wallet');
    expect(Object.keys(feeds.getOriginEntry(KEY_A).identities).sort()).toEqual(['app-scoped:0', 'bee-wallet']);
  });

  // Codex round 1 on #1201: the user approves exactly the identity shown.
  test('a new identity whose key another one takes while its prompt is open is never granted: the prompt shows again, with the key now next', async () => {
    const env = setup();
    await permissions.grantPermission(KEY_A, { page: testPage(KEY_A) });
    const page = env.tab();
    const answer = page.ask('swarm_writeSingleOwnerChunk', { identifier: IDENTIFIER, data: 'x' });
    const first = await env.shown('swarm.feed');
    expect(first.view.newIdentity).toMatchObject({ id: 'app-scoped:0', owner: '0xPublisher0' });
    // Another site takes that key, through the chrome's identity channel.
    await mockIpcHandlers['swarm:create-app-scoped-identity']({}, KEY_B, { activate: true });
    expect(feeds.getOriginEntry(KEY_B).activeIdentityId).toBe('app-scoped:0');
    // The user approves the identity shown, with "always allow".
    const decided = env.decide(first.handle, true, { identity: 'app-scoped:0', alwaysAllow: true });
    const second = await env.shown('swarm.feed');
    expect(second.handle).not.toBe(first.handle);
    expect(second.view.newIdentity).toMatchObject({ id: 'app-scoped:1', owner: '0xPublisher1' });
    // Nothing was granted, set or created for the identity that was taken.
    expect(feeds.getOriginEntry(KEY_A)).toBeNull();
    expect(permissions.getAutoApprove(KEY_A, 'signing')).toBe(false);
    expect(mockNode.writes).toEqual([]);
    // The stale choice is no choice on the new prompt.
    expect(await env.decide(second.handle, true, { identity: 'app-scoped:0' })).toEqual({ ok: false, reason: 'invalid' });
    await env.decide(second.handle, true, { identity: 'app-scoped:1', alwaysAllow: true });
    expect((await answer).result).toMatchObject({ owner: '0xPublisher1', identifier: IDENTIFIER });
    expect(await decided).toEqual({ ok: true });
    expect(feeds.getOriginEntry(KEY_A)).toMatchObject({ activeIdentityId: 'app-scoped:1', feedGranted: true });
    expect(permissions.getAutoApprove(KEY_A, 'signing')).toBe(true);
  });

  test('a feed that exists already is answered under the guard too: custody begun, or the rule turned off, during the vault\'s unlock answers nothing', async () => {
    const env = setup();
    await grantFeeds(KEY_A, { feeds: true });
    const page = env.tab();
    for (const [label, change, refusal] of [
      ['custody', () => env.state.custody.add(page.guest.id), AGENT_CUSTODY],
      ['rule off', () => permissions.setAutoApprove(KEY_A, 'feeds', false), RULE_OFF],
    ]) {
      mockVault.unlocked = false;
      const answer = page.ask('swarm_createFeed', { name: 'blog' });
      const unlock = await env.shown('vault.unlock');
      await change();
      mockVault.unlocked = true;
      const decided = env.decide(unlock.handle, true);
      expect({ label, answer: await answer }).toEqual({ label, answer: refusal });
      expect(await decided).toEqual({ ok: true });
      env.state.custody.delete(page.guest.id);
      await permissions.setAutoApprove(KEY_A, 'feeds', true, { page: testPage(KEY_A) });
    }
    // Without a wait, the rule still answers it.
    expect((await page.ask('swarm_createFeed', { name: 'blog' })).result).toMatchObject({ feedId: 'blog' });
    expect(mockNode.writes).toEqual([]);
  });

  test('a locked vault is unlocked first, on main\'s own prompt, for the prompt and for the rule; cancelled, nothing is granted or written', async () => {
    const env = setup();
    await permissions.grantPermission(KEY_A, { page: testPage(KEY_A) });
    const page = env.tab();
    mockVault.unlocked = false;
    let answer = page.ask('swarm_createFeed', { name: 'blog' });
    let unlock = await env.shown('vault.unlock');
    expect(unlock.view).toEqual({ reason: 'feeds' });
    await env.decide(unlock.handle, false);
    expect(await answer).toEqual(UNLOCK_CANCELLED);
    expect(feeds.getOriginEntry(KEY_A)).toBeNull();

    answer = page.ask('swarm_createFeed', { name: 'blog' });
    unlock = await env.shown('vault.unlock');
    mockVault.unlocked = true;
    // The decision is answered once its request is: after the feed prompt.
    const unlocked = env.decide(unlock.handle, true);
    const prompt = await env.shown('swarm.feed');
    expect(prompt.view.newIdentity.owner).toBe('0xPublisher0');
    await env.decide(prompt.handle, false);
    expect(await answer).toEqual(FEED_REJECTED);
    expect(await unlocked).toEqual({ ok: true });
    expect(feeds.getOriginEntry(KEY_A)).toBeNull();
    expect(mockNode.writes).toEqual([]);

    // The rule answers, with only the unlock.
    await grantFeeds(KEY_A, { signing: true });
    mockVault.unlocked = false;
    answer = page.ask('swarm_writeSingleOwnerChunk', { identifier: IDENTIFIER, data: 'x' });
    unlock = await env.shown('vault.unlock');
    expect(unlock.view).toEqual({ reason: 'signing' });
    mockVault.unlocked = true;
    await env.decide(unlock.handle, true);
    expect((await answer).result).toMatchObject({ identifier: IDENTIFIER });
    expect(env.prompts().map((p) => p.kind)).toEqual(['vault.unlock', 'vault.unlock', 'swarm.feed', 'vault.unlock']);
  });

  test('an unconnected site is refused with no prompt, a keyless document is refused, and the manifest is checked once per document', async () => {
    const env = setup();
    const page = env.tab();
    for (const method of SWARM_FEED_METHODS) expect(await page.ask(method, CASES[method].params)).toEqual(NOT_CONNECTED);
    expect(env.prompts()).toEqual([]);
    expect(env.state.checks).toEqual([{ key: KEY_A, eager: false }]);
    const keyless = env.tab('data:text/html,<p>x</p>');
    for (const method of SWARM_FEED_METHODS) expect(await keyless.ask(method, CASES[method].params)).toEqual(NO_ADDRESS);
    expect(env.state.checks).toHaveLength(1);
    expect(mockNode.writes).toEqual([]);
  });

  test.each(SWARM_FEED_METHODS)('custody read live for %s: no rule answers a tab in custody, the user\'s approval counts there, one that enters custody while a rule-answered write waits writes nothing, and leaving gives the rule back', async (method) => {
    const env = setup();
    await grantFeeds(KEY_A, { feeds: true, signing: true });
    const page = env.tab();
    // Fresh params for each ask (a create names a new feed each time).
    const params = () => CASES[method].params;
    env.state.custody.add(page.guest.id);
    const prompted = page.ask(method, params());
    const prompt = await env.shown('swarm.feed');
    await env.decide(prompt.handle, true, { identity: prompt.view.activeIdentityId });
    expect((await prompted).result).toBeDefined();
    const written = mockNode.writes.length;

    // Out of custody the rule answers; the tab enters custody while the
    // request waits on the node's readiness (a disclosure, on nothing).
    env.state.custody.delete(page.guest.id);
    if (method !== 'swarm_getSigningIdentity') {
      const gate = held();
      mockNode.readiness = gate.promise.then(() => ({ ok: true }));
      const ruled = page.ask(method, params());
      await flush();
      env.state.custody.add(page.guest.id);
      gate.release();
      expect(await ruled).toEqual(AGENT_CUSTODY);
      expect(mockNode.writes).toHaveLength(written);
      mockNode.readiness = null;
      env.state.custody.delete(page.guest.id);
    }
    const count = env.prompts().length;
    expect((await page.ask(method, params())).result).toBeDefined();
    expect(env.prompts()).toHaveLength(count);
  });

  test('a signed write whose tab enters custody, or whose name moves, while the identity core signs writes nothing: the guard owns the write', async () => {
    const env = setup();
    await grantFeeds(KEY_A, { feeds: true, signing: true });
    const page = env.tab();
    for (const method of ['swarm_updateFeed', 'swarm_writeFeedEntry', 'swarm_writeSingleOwnerChunk']) {
      const gate = held();
      mockNode.sign = gate.promise;
      const answer = page.ask(method, CASES[method].params);
      await flush();
      env.state.custody.add(page.guest.id);
      gate.release();
      expect({ method, answer: await answer }).toEqual({ method, answer: AGENT_CUSTODY });
      env.state.custody.delete(page.guest.id);
    }
    expect(mockNode.writes).toEqual([]);

    const env2 = setup();
    await grantFeeds(NAME, { feeds: true, signing: true });
    const named = await env2.named();
    for (const method of ['swarm_updateFeed', 'swarm_writeFeedEntry', 'swarm_writeSingleOwnerChunk']) {
      env2.names.set(NAME, IPNS_KEY);
      const gate = held();
      mockNode.sign = gate.promise;
      const answer = named.ask(method, CASES[method].params);
      await flush();
      env2.names.set(NAME, OTHER_IPNS_KEY);
      gate.release();
      expect({ method, answer: await answer }).toEqual({ method, answer: NO_ADDRESS });
    }
    expect(mockNode.writes).toEqual([]);
  });

  test('a name that moves while the feed prompt is open: no identity changed, no grant, no rule, nothing written', async () => {
    const env = setup();
    await permissions.grantPermission(NAME, { page: testPage(NAME) });
    const page = await env.named();
    const answer = page.ask('swarm_createFeed', { name: 'blog' });
    const prompt = await env.shown('swarm.feed');
    expect(prompt.site).toEqual({ key: NAME, label: NAME });
    env.names.set(NAME, OTHER_IPNS_KEY);
    await env.decide(prompt.handle, true, { identity: prompt.view.newIdentity.id, alwaysAllow: true });
    expect(await answer).toEqual(NO_ADDRESS);
    expect(feeds.getOriginEntry(NAME)).toBeNull();
    expect(permissions.getAutoApprove(NAME, 'feeds')).toBe(false);
    expect(mockNode.writes).toEqual([]);
  });

  test('after the name has moved: a feed created, updated or written, a single-owner chunk and the signing identity are refused, with nothing signed, written or disclosed', async () => {
    const env = setup();
    await grantFeeds(NAME, { feeds: true, signing: true });
    const page = await env.named();
    env.names.set(NAME, OTHER_IPNS_KEY);
    for (const method of SWARM_FEED_METHODS) {
      expect({ method, answer: await page.ask(method, CASES[method].params) }).toEqual({ method, answer: NO_ADDRESS });
    }
    expect(mockNode.writes).toEqual([]);
    expect(mockNode.signals).toEqual([]);
    expect(env.prompts()).toEqual([]);
  });

  test('a write that went out answers as written though the name moves during it; the feed\'s record is kept only while the name answers', async () => {
    const env = setup();
    await grantFeeds(NAME, { feeds: true });
    const page = await env.named();
    const gate = held();
    mockNode.write = gate.promise;
    const answer = page.ask('swarm_createFeed', { name: 'news' });
    await flush();
    expect(mockNode.writes).toEqual(['createFeed']);
    env.names.set(NAME, OTHER_IPNS_KEY);
    gate.release();
    expect((await answer).result).toMatchObject({ feedId: 'news' });
    expect(feeds.getFeed(NAME, 'news')).toBeNull();
  });

  test('a feed grant revoked, the connection revoked, or the rule turned off while a write waits: nothing written', async () => {
    const env = setup();
    await grantFeeds(KEY_A, { feeds: true, signing: true });
    const page = env.tab();
    const waits = [
      ['feed grant revoked', () => feeds.revokeFeedAccess(KEY_A), { code: 4100, data: { reason: 'feed_not_granted' } }],
      ['rule off', () => permissions.setAutoApprove(KEY_A, 'feeds', false), RULE_OFF.error],
    ];
    for (const [label, change, refusal] of waits) {
      const gate = held();
      mockNode.sign = gate.promise;
      const answer = page.ask('swarm_writeFeedEntry', CASES.swarm_writeFeedEntry.params);
      await flush();
      await change();
      gate.release();
      expect({ label, error: (await answer).error }).toEqual({ label, error: expect.objectContaining(refusal) });
      await grantFeeds(KEY_A, { feeds: true, signing: true });
    }
    // The connection, for a prompted write.
    await permissions.setAutoApprove(KEY_A, 'feeds', false);
    const gate = held();
    mockNode.sign = gate.promise;
    const answer = page.ask('swarm_updateFeed', CASES.swarm_updateFeed.params);
    const prompt = await env.shown('swarm.feed');
    const decided = env.decide(prompt.handle, true, { identity: prompt.view.activeIdentityId });
    await flush();
    await permissions.revokePermission(KEY_A);
    gate.release();
    expect((await answer).error).toMatchObject({ code: 4100, data: { reason: 'not_connected' } });
    expect(await decided).toEqual({ ok: true });
    expect(mockNode.writes).toEqual([]);
  });

  test('a stored identity of the removed mode (#89) is never granted feed access by main', async () => {
    const env = setup();
    await permissions.grantPermission(KEY_A, { page: testPage(KEY_A) });
    // As feed-store.test.js stores one: an origin whose active identity is
    // an Ethereum wallet's, its grant revoked.
    const file = path.join(mockUserData, 'swarm-feeds.json');
    feeds.createAppScopedIdentity(KEY_A, { activate: true, source: 'manifest' });
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    store.origins[KEY_A].identities['ethereum-wallet:2'] = { id: 'ethereum-wallet:2', mode: 'ethereum-wallet', walletIndex: 2, publisherKeyIndex: null, label: 'Wallet', createdAt: 0, lastUsedAt: null };
    store.origins[KEY_A].activeIdentityId = 'ethereum-wallet:2';
    fs.writeFileSync(file, JSON.stringify(store));
    feeds._resetCache();
    const page = env.tab();
    const answer = page.ask('swarm_createFeed', { name: 'blog' });
    const prompt = await env.shown('swarm.feed');
    const wallet = prompt.view.identities.find((i) => i.id === 'ethereum-wallet:2');
    expect(wallet).toMatchObject({ unavailable: true });
    expect(prompt.view.activeIdentityId).not.toBe('ethereum-wallet:2');
    expect(await env.decide(prompt.handle, true, { identity: 'ethereum-wallet:2' })).toEqual({ ok: false, reason: 'invalid' });
    // Picking another identity is the user's explicit switch, and grants.
    await env.decide(prompt.handle, true, { identity: 'app-scoped:0' });
    expect((await answer).result).toMatchObject({ feedId: 'blog' });
    expect(feeds.getOriginEntry(KEY_A)).toMatchObject({ activeIdentityId: 'app-scoped:0', feedGranted: true });
  });

  test('a navigation, or main\'s deadline, during a stalled write stops it: the request\'s signal reaches the write', async () => {
    const env = setup();
    await grantFeeds(KEY_A, { feeds: true });
    const page = env.tab();
    const gate = held();
    mockNode.write = gate.promise;
    const answer = page.ask('swarm_writeFeedEntry', CASES.swarm_writeFeedEntry.params);
    await flush();
    expect(mockNode.writes).toEqual(['writeFeedEntry']);
    expect(mockNode.signals[0]).toBeInstanceOf(AbortSignal);
    page.guest.commit(`${KEY_A}/next`);
    expect(await answer).toEqual({ gone: true });
    await flush();
    expect(mockNode.signals[0].aborted).toBe(true);
    expect(env.requests.stats()).toMatchObject({ records: 0, browser: { requests: 0, bytes: 0 } });

    const next = env.greet(page.guest);
    const late = next.ask('swarm_updateFeed', CASES.swarm_updateFeed.params);
    await flush();
    env.fire(300_000);
    expect(await late).toEqual({ error: { code: -32603, message: 'Request timed out' } });
    await flush();
    expect(mockNode.signals[1].aborted).toBe(true);
    expect(env.requests.stats()).toMatchObject({ records: 0 });
    gate.release();
  });

  test('a feed entry\'s copies are reported with its charge in place; a write the node refuses for setup routes to the setup screen', async () => {
    const env = setup();
    await grantFeeds(KEY_A, { feeds: true });
    const page = env.tab();
    await page.ask('swarm_writeFeedEntry', { name: 'blog', data: new Uint8Array(100) });
    await page.ask('swarm_writeFeedEntry', { name: 'blog', data: 'text' });
    expect(env.copies.map((c) => [c.label, c.inPlace])).toEqual([
      ['normalizeBytes', true],
      ['payload', true],
    ]);
    mockNode.readiness = { ok: false, reason: 'no-usable-stamps' };
    expect((await page.ask('swarm_createFeed', { name: 'other' })).error).toMatchObject({ code: 4900, data: { reason: 'no-usable-stamps' } });
    expect(env.state.routed).toEqual([{ key: KEY_A, reason: 'no-usable-stamps' }]);
  });
});

describe('nothing the chrome can call writes a Swarm grant (0011 PRQ-7d, "Grants")', () => {
  const invoke = (channel, ...args) => mockIpcHandlers[channel]({ sender: { id: 1 } }, ...args);
  const snapshot = (key) => ({
    connected: permissions.getPermission(key) !== null,
    messaging: permissions.hasMessagingGrant(key),
    rules: ['publish', 'feeds', 'signing', 'messaging'].map((type) => permissions.getAutoApprove(key, type)),
    feedGrant: feeds.hasFeedGrant(key),
  });

  test('swarm:set-auto-approve refused for turning any rule on, accepted for turning one off; swarm:set-feed-identity refused', async () => {
    await permissions.grantPermission(KEY_A, { page: testPage(KEY_A) });
    for (const type of ['publish', 'feeds', 'signing', 'messaging', 'other']) {
      for (const enabled of [true, 1, 'yes', null]) {
        expect(() => invoke('swarm:set-auto-approve', KEY_A, type, enabled)).toThrow(/auto-approve is turned on only from/);
      }
    }
    expect(() => invoke('swarm:set-auto-approve', KEY_A, 'feeds', true)).toThrow('Feed auto-approve is turned on only from a feed prompt');
    expect(() => invoke('swarm:set-auto-approve', KEY_A, 'signing', true)).toThrow('Signing auto-approve is turned on only from a signing prompt');
    for (const type of ['feeds', 'signing']) {
      await permissions.setAutoApprove(KEY_A, type, true, { page: testPage(KEY_A) });
      expect(await invoke('swarm:set-auto-approve', KEY_A, type, false)).toBe(true);
      expect(permissions.getAutoApprove(KEY_A, type)).toBe(false);
    }
    for (const mode of ['app-scoped', 'bee-wallet']) {
      expect(() => invoke('swarm:set-feed-identity', KEY_A, mode)).toThrow('Swarm feed access is granted only from its own prompt');
    }
    expect(feeds.hasFeedGrant(KEY_A)).toBe(false);
  });

  test('every swarm: channel the chrome can call, with every enabling argument, leaves a site with no grant it didn\'t have', async () => {
    const channels = Object.keys(mockIpcHandlers).filter((channel) => channel.startsWith('swarm:')).sort();
    // The chrome's route and its manifest check and decide are gone.
    expect(channels).not.toContain('swarm:provider-execute');
    expect(channels).not.toContain('swarm:manifest-check');
    expect(channels).not.toContain('swarm:manifest-decide');
    // Every argument shape the grant writes took, and some more.
    const argSets = [
      [KEY_A],
      [KEY_A, 'feeds', true],
      [KEY_A, 'publish', true],
      [KEY_A, 'messaging', true],
      [KEY_A, 'app-scoped'],
      [KEY_A, 'bee-wallet'],
      [KEY_A, { activate: true }],
      [KEY_A, 'bee-wallet', true],
      [{ origin: KEY_A, capability: 'feeds' }],
      [{ origin: KEY_A, committedUrl: `${KEY_A}/`, eager: true }],
      [{ token: 'x', outcome: 'allow' }],
    ];
    for (const site of [KEY_A, KEY_B]) {
      const before = snapshot(site);
      for (const channel of channels) {
        for (const args of argSets) {
          const call = args.map((arg) => (arg === KEY_A ? site : arg && typeof arg === 'object' && arg.origin === KEY_A ? { ...arg, origin: site } : arg));
          try {
            await invoke(channel, ...call);
          } catch {
            // Refused, or not this channel's shape.
          }
        }
      }
      expect({ site, after: snapshot(site) }).toEqual({ site, after: before });
    }
  });
});
