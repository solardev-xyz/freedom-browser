// The chain switcher's chainChanged, and accountsChanged when a grant is
// revoked or its account changes, sent by main (freedom-core design 0011,
// "Events"; step PRQ-6): to the right live documents, through `sendEvent`,
// with each document's nonce, to its guest's main frame only, and to a
// name-keyed document an accountsChanged only once its name answers its
// IPNS key again.

const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { createPageEvents, registerPageEvents, chainReadFor } = require('./page-events');
const { createEthereumDispatchers } = require('./page-ethereum');
const { normalizeOrigin } = require('../../shared/origin-utils');

const CHROME_URL = 'file:///app/src/renderer/index.html';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const ONCHAIN = '0x00000095643cffa7d9fae407a84dfcb6406456c6';
const ONCHAIN_URL = `web3://${ONCHAIN}.eip155-10/`;
const KEYLESS = 'data:text/html,<h1>keyless</h1>';
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const SECOND = '0x2222222222222222222222222222222222222222';

let nextId = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// A tab guest. Its main frame's `send` stands in for the IPC and for the
// app's preload: every message reaches `delivered`, and the page sees
// (`events`) only one that carries its own document's nonce, as the preload
// drops any other. A sub-frame's `send` must never be called.
class Guest extends EventEmitter {
  constructor({ window = 1, isPrivate = false } = {}) {
    super();
    this.id = nextId++;
    this.window = window;
    this.private = isPrivate;
    this.hostWebContents = { id: 500 + window, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
    this.destroyed = false;
    this.nonce = null;
    this.delivered = [];
    this.events = [];
    this.subFrame = { url: `${KEY_B}/frame`, frameTreeNodeId: 9000 + this.id, detached: false, send: jest.fn() };
    this.mainFrame = this.frame('about:blank');
  }

  frame(url) {
    return {
      url,
      frameTreeNodeId: 1000 + this.id,
      processId: 1,
      routingId: this.id,
      detached: false,
      send: jest.fn((_channel, message) => {
        this.delivered.push(message);
        if (message.nonce === this.nonce) this.events.push([message.event, message.data]);
      }),
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

  // A main-frame commit: a new document in the same frame (same
  // frameTreeNodeId), as a reload or a link within the site.
  commit(url) {
    this.mainFrame.detached = true;
    this.mainFrame = this.frame(url);
    this.nonce = null;
    this.emit('did-frame-navigate', {}, url, 200, 'OK', true, 1, this.mainFrame.routingId);
  }
}

const eventFrom = (guest) => ({ sender: guest, senderFrame: guest.mainFrame });

function setup() {
  const guests = new Map();
  const names = new Map([[NAME, IPNS_KEY]]);
  const resolutions = [];
  const hooks = {};
  const trace = [];
  hooks.onTrace = (entry) => trace.push(entry);
  // While set, a resolution waits for it, then reads the name's key.
  let gate = null;
  const holdResolutions = () => {
    let open;
    gate = new Promise((resolve) => (open = resolve));
    return () => {
      gate = null;
      open();
    };
  };
  const documents = createPageDocuments({
    isPrivateWebContents: (contents) => contents.private === true,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent: async (name) => {
      resolutions.push(name);
      if (gate) await gate;
      const key = names.get(name);
      return key ? { type: 'ok', protocol: 'ipns', decoded: key } : { type: 'not_found' };
    },
  });
  const permissions = new Map();
  const dispatchers = createEthereumDispatchers({
    identityWalletEnabled: () => true,
    getPermission: (key) => permissions.get(key) || null,
    getDerivedWallets: async () => wallets,
  });
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers,
    hooks,
    setTimer: () => ({}),
    clearTimer: () => {},
    chromeWindowOf: (contents) => (contents?.id >= 500 ? contents.id - 500 : null),
    sendToWindow: () => {},
    watchWindow: () => {},
  });
  const wallets = [
    { index: 0, name: 'Main Wallet', address: ACCOUNT },
    { index: 1, name: 'Second', address: SECOND },
  ];
  const events = createPageEvents({
    requests: () => requests,
    getDerivedWallets: async () => wallets,
    normalizeKey: normalizeOrigin,
  });

  function greet(guest) {
    const n = nonce();
    const result = requests.hello(eventFrom(guest), { nonce: n });
    if (result?.ok !== false) guest.nonce = n;
    return n;
  }

  async function tab(url, { window = 1, bind = null, isPrivate = false } = {}) {
    const guest = new Guest({ window, isPrivate });
    guests.set(guest.id, guest);
    requests.track(guest);
    if (bind) {
      expect(requests.bindName({ sender: guest.hostWebContents }, { guest: guest.id, name: bind, key: IPNS_KEY })).toBe(true);
    }
    guest.commit(url);
    await flush();
    greet(guest);
    return guest;
  }

  const ask = (guest, method, params = []) =>
    requests.request(eventFrom(guest), { nonce: guest.nonce, provider: 'ethereum', method, params });

  return { requests, documents, events, hooks, trace, tab, greet, names, resolutions, holdResolutions, permissions, wallets, ask };
}

describe('chainChanged from the chain switcher (0011 PRQ-6)', () => {
  test('to every live document of the window whose chain follows the selection: not another window\'s, nor an onchain app', async () => {
    const env = setup();
    const a = await env.tab(`${KEY_A}/`);
    const b = await env.tab(`${KEY_B}/`);
    const keyless = await env.tab(KEYLESS);
    const onchain = await env.tab(ONCHAIN_URL);
    const elsewhere = await env.tab(`${KEY_A}/`, { window: 2 });
    const outcomes = await env.events.chainSelected({ window: 1, previous: 100, next: 1 });
    expect(a.events).toEqual([['chainChanged', '0x1']]);
    expect(b.events).toEqual([['chainChanged', '0x1']]);
    // A page with no key reads the window's chain too.
    expect(keyless.events).toEqual([['chainChanged', '0x1']]);
    // An onchain app keeps its own chain: nothing is sent it at all.
    expect(onchain.delivered).toEqual([]);
    expect(elsewhere.delivered).toEqual([]);
    expect(outcomes.map((o) => [o.guest, o.ok])).toEqual([
      [a.id, true],
      [b.id, true],
      [keyless.id, true],
    ]);
    // Each carries its own document's nonce.
    expect(a.delivered[0]).toEqual({ nonce: a.nonce, provider: 'ethereum', event: 'chainChanged', data: '0x1' });
  });

  test('only when the chain a page reads changes: "All Chains" reads as Gnosis', async () => {
    const env = setup();
    const a = await env.tab(`${KEY_A}/`);
    expect(chainReadFor(null)).toBe(100);
    await env.events.chainSelected({ window: 1, previous: 100, next: null });
    await env.events.chainSelected({ window: 1, previous: null, next: 100 });
    expect(a.delivered).toEqual([]);
    await env.events.chainSelected({ window: 1, previous: 100, next: 42161 });
    await env.events.chainSelected({ window: 1, previous: 42161, next: null });
    expect(a.events).toEqual([
      ['chainChanged', '0xa4b1'],
      ['chainChanged', '0x64'],
    ]);
    // A malformed change sends nothing.
    expect(await env.events.chainSelected({ window: '1', previous: 100, next: 1 })).toEqual([]);
    expect(await env.events.chainSelected()).toEqual([]);
    expect(a.delivered).toHaveLength(2);
  });

  test('changes in a row arrive in their order, the last one main\'s selection', async () => {
    const env = setup();
    const a = await env.tab(`${KEY_A}/`);
    const b = await env.tab(`${KEY_B}/`);
    // The first change's send to `a` waits; the second's still goes after it.
    let release;
    env.hooks.beforeEventSend = (message, target) =>
      target.guest === a.id && message.data === '0x1' ? new Promise((resolve) => (release = resolve)) : undefined;
    const first = env.events.chainSelected({ window: 1, previous: 100, next: 1 });
    const second = env.events.chainSelected({ window: 1, previous: 1, next: 10 });
    await flush();
    expect(a.events).toEqual([]);
    expect(b.events).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(a.events).toEqual([['chainChanged', '0x1'], ['chainChanged', '0xa']]);
    expect(b.events).toEqual([['chainChanged', '0x1'], ['chainChanged', '0xa']]);
  });

  test('none to a document that navigated, nor to the one that replaced it', async () => {
    const env = setup();
    const a = await env.tab(`${KEY_A}/`);
    const sending = env.events.chainSelected({ window: 1, previous: 100, next: 1 });
    // The page navigates before main sends: the event was for the document
    // that went.
    a.commit(`${KEY_A}/next`);
    env.greet(a);
    expect(await sending).toEqual([expect.objectContaining({ guest: a.id, ok: false, reason: 'navigated' })]);
    expect(a.delivered).toEqual([]);
    expect(env.trace).toContainEqual(expect.objectContaining({ kind: 'event-refused', event: 'chainChanged', reason: 'navigated' }));
  });

  test('PRQ-2\'s race: a document that replaced the one main checked drops the event by its nonce', async () => {
    const env = setup();
    const a = await env.tab(`${KEY_A}/`);
    const old = a.nonce;
    let release;
    env.hooks.beforeEventSend = () => new Promise((resolve) => (release = resolve));
    const sending = env.events.chainSelected({ window: 1, previous: 100, next: 1 });
    await flush();
    expect(typeof release).toBe('function');
    // Main has checked the record; a same-frame commit of the same key
    // lands before the send goes.
    a.commit(`${KEY_A}/`);
    env.greet(a);
    release();
    expect(await sending).toEqual([expect.objectContaining({ ok: true })]);
    // It reached the frame, with the old document's nonce, and the new
    // document's page saw nothing.
    expect(a.delivered).toEqual([{ nonce: old, provider: 'ethereum', event: 'chainChanged', data: '0x1' }]);
    expect(a.nonce).not.toBe(old);
    expect(a.events).toEqual([]);
    // The new document hears the next change.
    env.hooks.beforeEventSend = undefined;
    await env.events.chainSelected({ window: 1, previous: 1, next: 10 });
    expect(a.events).toEqual([['chainChanged', '0xa']]);
  });

  test('never to a sub-frame or a private window\'s page', async () => {
    const env = setup();
    const a = await env.tab(`${KEY_A}/`);
    const hidden = await env.tab(`${KEY_A}/`, { isPrivate: true });
    await env.events.chainSelected({ window: 1, previous: 100, next: 1 });
    expect(a.events).toEqual([['chainChanged', '0x1']]);
    expect(a.subFrame.send).not.toHaveBeenCalled();
    // A private window's page never said hello: it is no live document.
    expect(hidden.nonce).toBeNull();
    expect(hidden.delivered).toEqual([]);
    expect(env.requests.liveDocuments().map((doc) => doc.guest)).toEqual([a.id]);
  });

  test('a name-keyed document hears it with no resolution, its name moved or not', async () => {
    const env = setup();
    const named = await env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    expect(env.requests.liveDocuments()).toEqual([expect.objectContaining({ guest: named.id, key: NAME })]);
    env.resolutions.length = 0;
    env.names.set(NAME, OTHER_IPNS_KEY);
    await env.events.chainSelected({ window: 1, previous: 100, next: 1 });
    expect(named.events).toEqual([['chainChanged', '0x1']]);
    expect(env.resolutions).toEqual([]);
  });
});

describe('accountsChanged when a grant is revoked or its account changes (0011 PRQ-6)', () => {
  test('a revocation: [] to every live document of the key, in every window, and no other key', async () => {
    const env = setup();
    const one = await env.tab(`${KEY_A}/one`);
    const two = await env.tab(`${KEY_A}/two`);
    const other = await env.tab(`${KEY_B}/`);
    const keyless = await env.tab(KEYLESS);
    const elsewhere = await env.tab(`${KEY_A}/x`, { window: 2 });
    const outcomes = await env.events.grantChanged({ key: KEY_A, walletIndex: null });
    for (const guest of [one, two, elsewhere]) expect(guest.events).toEqual([['accountsChanged', []]]);
    expect(other.delivered).toEqual([]);
    expect(keyless.delivered).toEqual([]);
    expect(outcomes.map((o) => [o.guest, o.ok])).toEqual([
      [one.id, true],
      [two.id, true],
      [elsewhere.id, true],
    ]);
  });

  test('an account change: the grant\'s new account, or [] for one main doesn\'t hold', async () => {
    const env = setup();
    const a = await env.tab(`${KEY_A}/`);
    await env.events.grantChanged({ key: KEY_A, walletIndex: 1 });
    await env.events.grantChanged({ key: KEY_A, walletIndex: 7 });
    expect(a.events).toEqual([['accountsChanged', [SECOND]], ['accountsChanged', []]]);
    // A malformed change sends nothing.
    expect(await env.events.grantChanged({ key: '', walletIndex: 1 })).toEqual([]);
    expect(await env.events.grantChanged()).toEqual([]);
    expect(a.delivered).toHaveLength(2);
  });

  test('the key is matched in its normalized form', async () => {
    const env = setup();
    const named = await env.tab('https://App.Example/path');
    await env.events.grantChanged({ key: 'https://app.example', walletIndex: 0 });
    expect(named.events).toEqual([['accountsChanged', [ACCOUNT]]]);
  });

  test('an account change then a revocation arrive in that order, though the account is looked up first', async () => {
    const env = setup();
    const a = await env.tab(`${KEY_A}/`);
    const changed = env.events.grantChanged({ key: KEY_A, walletIndex: 1 });
    const revoked = env.events.grantChanged({ key: KEY_A, walletIndex: null });
    await Promise.all([changed, revoked]);
    expect(a.events).toEqual([['accountsChanged', [SECOND]], ['accountsChanged', []]]);
  });

  test('none to a document that navigated, and PRQ-2\'s race for a revocation and an account change', async () => {
    const env = setup();
    const a = await env.tab(`${KEY_A}/`);
    const sending = env.events.grantChanged({ key: KEY_A, walletIndex: null });
    a.commit(`${KEY_A}/next`);
    env.greet(a);
    expect(await sending).toEqual([expect.objectContaining({ ok: false, reason: 'navigated' })]);
    expect(a.delivered).toEqual([]);

    for (const walletIndex of [null, 1]) {
      const old = a.nonce;
      let release = null;
      env.hooks.beforeEventSend = () => new Promise((resolve) => (release = resolve));
      const held = env.events.grantChanged({ key: KEY_A, walletIndex });
      await flush();
      expect(typeof release).toBe('function');
      a.commit(`${KEY_A}/`);
      env.greet(a);
      release();
      expect(await held).toEqual([expect.objectContaining({ ok: true })]);
      expect(a.delivered.at(-1)).toEqual(expect.objectContaining({ nonce: old, event: 'accountsChanged' }));
      expect(a.events).toEqual([]);
    }
    env.hooks.beforeEventSend = undefined;
    await env.events.grantChanged({ key: KEY_A, walletIndex: 0 });
    expect(a.events).toEqual([['accountsChanged', [ACCOUNT]]]);
  });

  test('never to a sub-frame or a private window\'s page', async () => {
    const env = setup();
    const a = await env.tab(`${KEY_A}/`);
    const hidden = await env.tab(`${KEY_A}/`, { isPrivate: true });
    await env.events.grantChanged({ key: KEY_A, walletIndex: null });
    expect(a.events).toEqual([['accountsChanged', []]]);
    expect(a.subFrame.send).not.toHaveBeenCalled();
    expect(hidden.delivered).toEqual([]);
  });

  test('a name-keyed document: after its name answers its IPNS key again; none once the name has moved, and its binding ends', async () => {
    const env = setup();
    const named = await env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    // A page of the same IPNS key that no name bound is another key.
    const bare = await env.tab(`ipns://${IPNS_KEY}/other`);
    env.permissions.set(NAME, { origin: NAME, walletIndex: 0, chainId: 100 });
    expect(await env.ask(named, 'eth_accounts')).toEqual({ result: [ACCOUNT] });

    env.resolutions.length = 0;
    await env.events.grantChanged({ key: NAME, walletIndex: 1 });
    expect(env.resolutions).toEqual([NAME]);
    expect(named.events).toEqual([['accountsChanged', [SECOND]]]);
    expect(bare.delivered).toEqual([]);

    // The name moves off the page's IPNS key: the revocation isn't sent.
    env.names.set(NAME, OTHER_IPNS_KEY);
    env.resolutions.length = 0;
    const outcomes = await env.events.grantChanged({ key: NAME, walletIndex: null });
    expect(env.resolutions).toEqual([NAME]);
    expect(outcomes).toEqual([expect.objectContaining({ guest: named.id, ok: false, reason: 'name-moved' })]);
    expect(named.delivered).toHaveLength(1);
    // The binding has ended: the page is keyless, so it is no document of
    // the name's any more, and nothing is resolved for it.
    expect(await env.ask(named, 'eth_accounts')).toEqual({ result: [] });
    env.resolutions.length = 0;
    expect(await env.events.grantChanged({ key: NAME, walletIndex: 0 })).toEqual([]);
    expect(env.resolutions).toEqual([]);
    expect(named.delivered).toHaveLength(1);
  });

  test('a name that moves while main resolves it: not sent', async () => {
    const env = setup();
    const named = await env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    // Main's resolution waits; the name moves meanwhile.
    const release = env.holdResolutions();
    const sending = env.events.grantChanged({ key: NAME, walletIndex: null });
    await flush();
    expect(env.resolutions).toContain(NAME);
    env.names.set(NAME, OTHER_IPNS_KEY);
    release();
    expect(await sending).toEqual([expect.objectContaining({ ok: false, reason: 'name-moved' })]);
    expect(named.delivered).toEqual([]);
    expect(env.trace).toContainEqual(
      expect.objectContaining({ kind: 'event-refused', event: 'accountsChanged', guest: named.id, reason: 'name-moved' })
    );
  });
});

describe('registerPageEvents (0011 PRQ-6)', () => {
  test('main hears the chrome\'s selections and the grants\' changes, until stopped', () => {
    const listeners = {};
    const stopped = [];
    const selectedChain = {
      onChromeSelection: (listener) => {
        listeners.chain = listener;
        return () => stopped.push('chain');
      },
    };
    const permissions = {
      onGrantChanged: (listener) => {
        listeners.grant = listener;
        return () => stopped.push('grant');
      },
    };
    const events = { chainSelected: jest.fn(), grantChanged: jest.fn() };
    const stop = registerPageEvents({ selectedChain, permissions, events });
    listeners.chain({ window: 1, previous: 100, next: 1 });
    listeners.grant({ key: KEY_A, walletIndex: null });
    expect(events.chainSelected).toHaveBeenCalledWith({ window: 1, previous: 100, next: 1 });
    expect(events.grantChanged).toHaveBeenCalledWith({ key: KEY_A, walletIndex: null });
    stop();
    expect(stopped).toEqual(['chain', 'grant']);
  });

  test('with main\'s own modules: the chrome\'s wallet:select-chain reaches the window\'s pages', async () => {
    const selected = require('../wallet/selected-chain');
    selected.resetSelectedChains();
    const env = setup();
    const a = await env.tab(`${KEY_A}/`);
    const handlers = {};
    selected.registerSelectedChainIpc(
      { on: (channel, handler) => (handlers[channel] = handler) },
      { windowOf: () => ({ id: 1, isDestroyed: () => false, once: () => {} }) }
    );
    const stop = registerPageEvents({
      selectedChain: selected,
      permissions: { onGrantChanged: () => () => {} },
      events: env.events,
    });
    handlers['wallet:select-chain']({ sender: {} }, 1);
    await flush();
    expect(a.events).toEqual([['chainChanged', '0x1']]);
    stop();
    handlers['wallet:select-chain']({ sender: {} }, 10);
    await flush();
    expect(a.events).toHaveLength(1);
    selected.resetSelectedChains();
  });
});
