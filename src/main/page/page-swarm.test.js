const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { CLASS, methodRow } = require('./page-methods');
const {
  SWARM_READ_METHODS,
  SWARM_CONNECT_METHODS,
  SWARM_MESSAGING_METHODS,
  SWARM_PUBLISH_METHODS,
  SWARM_PAGE_METHODS,
  createSwarmDispatchers,
} = require('./page-swarm');

const CHROME_URL = 'file:///app/src/renderer/index.html';
const HASH = 'a'.repeat(64);
const DAPP = `bzz://${HASH}/app`;
const DAPP_KEY = `bzz://${HASH}`;
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';
const KEYLESS = 'data:text/html,<p>keyless</p>';

const PERMISSION_FREE = ['swarm_readChunk', 'swarm_readData', 'swarm_readSingleOwnerChunk'];
const UNDER_KEY = ['swarm_getCapabilities', 'swarm_readFeedEntry', 'swarm_listFeeds'];

const NO_ADDRESS = {
  error: { code: 4100, message: 'This page has no address to connect from yet', data: { reason: 'no_address' } },
};

let nextId = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A tab guest: a webview webContents hosted by chrome window `window`. */
class Guest extends EventEmitter {
  constructor({ window = 1 } = {}) {
    super();
    this.id = nextId++;
    this.window = window;
    this.hostWebContents = { id: 500 + window, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
    this.destroyed = false;
    this.mainFrame = {
      url: 'about:blank',
      frameTreeNodeId: 1000 + this.id,
      processId: 1,
      routingId: this.id,
      detached: false,
      send: jest.fn(),
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
    this.mainFrame = { ...this.mainFrame, url, detached: false, send: jest.fn() };
    this.emit('did-frame-navigate', {}, url, 200, 'OK', true, 1, this.mainFrame.routingId);
  }
}

const eventFrom = (guest) => ({ sender: guest, senderFrame: guest.mainFrame });

/** Timers the test fires by hand. */
function manualTimers() {
  const timers = [];
  return {
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
    fire(ms) {
      for (const timer of timers.filter((t) => t.ms === ms && !t.cleared)) {
        timer.cleared = true;
        timer.fn();
      }
    },
  };
}

function setup() {
  const guests = new Map();
  const resolutions = [];
  const names = new Map();
  const trace = [];
  // A test may hold each resolution and answer it itself.
  const resolver = { held: null };
  const documents = createPageDocuments({
    isPrivateWebContents: () => false,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent: async (name) => {
      resolutions.push(name);
      if (resolver.held) {
        const key = await new Promise((resolve) => resolver.held.push(resolve));
        return { type: 'ok', protocol: 'ipns', decoded: key };
      }
      const key = names.get(name);
      return key ? { type: 'ok', protocol: 'ipns', decoded: key } : { type: 'not_found' };
    },
  });
  const state = { enabled: true, calls: [], hold: null };
  // executeSwarmMethod as the dispatcher reaches it: what it was asked, and
  // under which key. A test may hold a call to move the name meanwhile.
  const execute = jest.fn(async (method, params, key) => {
    // Whether the named document still held its name at the moment of the
    // call: an ended binding leaves its document keyless.
    trace.push({ kind: 'execute', method, liveKeys: documents.liveDocuments().map((doc) => doc.key) });
    state.calls.push({ method, params, key });
    if (state.hold) await state.hold;
    return { result: { method, key } };
  });
  const timers = manualTimers();
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers: createSwarmDispatchers({ identityWalletEnabled: () => state.enabled, execute }),
    hooks: { onTrace: (entry) => trace.push(entry) },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  function greet(guest) {
    const n = nonce();
    expect(requests.hello(eventFrom(guest), { nonce: n })).toEqual({ ok: true, navigation: expect.any(Number) });
    return {
      guest,
      ask: (method, params = {}) => requests.request(eventFrom(guest), { nonce: n, provider: 'swarm', method, params }),
    };
  }

  /** A tracked guest on `url` whose document has said hello. */
  function tab(url = DAPP, { window = 1, bind = null } = {}) {
    const guest = new Guest({ window });
    guests.set(guest.id, guest);
    requests.track(guest);
    if (bind) {
      const host = guest.hostWebContents;
      expect(requests.bindName({ sender: host }, { guest: guest.id, name: bind, key: url.slice(7).split('/')[0] })).toBe(true);
    }
    guest.commit(url);
    return greet(guest);
  }

  /** A document of the DNS name over IPNS, bound to the name. */
  async function named() {
    names.set(NAME, IPNS_KEY);
    const page = tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    await flush();
    resolutions.length = 0;
    return page;
  }

  return { requests, state, execute, timers, trace, tab, named, names, resolutions, resolver };
}

describe('Swarm reads through main (freedom-core design 0011, PRQ-7a)', () => {
  test('the dispatcher serves the chrome\'s public methods but unsubscribe, and the preload routes exactly these', () => {
    // The chrome's own list, read from the code that served it: the methods
    // it ran with no prompt and no manifest check.
    const source = fs.readFileSync(path.join(__dirname, '../../renderer/lib/swarm-provider.js'), 'utf-8');
    const publicMethods = /const PUBLIC_METHODS = new Set\(\[([\s\S]*?)\]\);/
      .exec(source)[1]
      .match(/'[^']+'/g)
      .map((m) => m.slice(1, -1));
    expect([...SWARM_READ_METHODS].sort()).toEqual(publicMethods.filter((m) => m !== 'swarm_unsubscribe').sort());
    // And PRQ-7b's: connecting, and the methods its messaging handler ran.
    expect(SWARM_CONNECT_METHODS).toEqual(['swarm_requestAccess']);
    const messagingMethods = /method === 'swarm_getMessagingIdentity' \|\|[\s\S]*?\) \{\s*result = await handleMessagingRequest/
      .exec(source)[0]
      .match(/'swarm_[A-Za-z]+'/g)
      .map((m) => m.slice(1, -1));
    expect([...SWARM_MESSAGING_METHODS].sort()).toEqual(messagingMethods.sort());
    // And PRQ-7c's: the methods the chrome ran with its publish prompt, and
    // swarm_getUploadStatus, the one its catch-all branch ran.
    const publishMethods = /method === 'swarm_publishData' \|\| method === 'swarm_publishFiles' \|\| method === 'swarm_publishChunk'/
      .exec(source)[0]
      .match(/'swarm_[A-Za-z]+'/g)
      .map((m) => m.slice(1, -1));
    expect([...SWARM_PUBLISH_METHODS].sort()).toEqual([...publishMethods, 'swarm_getUploadStatus'].sort());
    expect(SWARM_PAGE_METHODS).toEqual([
      ...SWARM_READ_METHODS,
      ...SWARM_CONNECT_METHODS,
      ...SWARM_MESSAGING_METHODS,
      ...SWARM_PUBLISH_METHODS,
    ]);
    expect(Object.keys(createSwarmDispatchers({ identityWalletEnabled: () => true, execute: jest.fn() })).sort()).toEqual(
      SWARM_PAGE_METHODS.map((m) => `swarm:${m}`).sort()
    );
    const preload = fs.readFileSync(path.join(__dirname, '../webview-preload.js'), 'utf-8');
    const routes = /const PAGE_ROUTES = new Set\(\[([\s\S]*?)\]\);/
      .exec(preload)[1]
      .match(/'[^']+'/g)
      .map((r) => r.slice(1, -1))
      .filter((r) => r.startsWith('swarm:'));
    expect(routes.sort()).toEqual(SWARM_PAGE_METHODS.map((m) => `swarm:${m}`).sort());
    // Each has its row, of the class the design gives it.
    for (const method of PERMISSION_FREE) expect(methodRow('swarm', method).class).toBe(CLASS.PERMISSION_FREE);
    for (const method of UNDER_KEY) expect(methodRow('swarm', method).class).toBe(CLASS.NAME_REVALIDATED);
    for (const method of [...SWARM_CONNECT_METHODS, ...SWARM_MESSAGING_METHODS, ...SWARM_PUBLISH_METHODS]) {
      expect({ method, class: methodRow('swarm', method).class }).toEqual({
        method,
        class: method === 'swarm_unsubscribe' ? CLASS.EXEMPT : CLASS.NAME_REVALIDATED,
      });
    }
  });

  test('every method runs under the attested key, for each URL form, with the page\'s params', async () => {
    const forms = [
      ['https://app.example/swap?x=1', 'https://app.example'],
      [DAPP, DAPP_KEY],
      ['bzz://name.eth/page', 'name.eth'],
      ['ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/docs', 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'],
      ['ipns://name.eth/', 'name.eth'],
      [`ipns://${IPNS_KEY}/`, `ipns://${IPNS_KEY}`],
      ['rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5/tree', 'rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5'],
    ];
    const env = setup();
    for (const [url, key] of forms) {
      const page = env.tab(url);
      for (const method of SWARM_READ_METHODS) {
        env.state.calls.length = 0;
        const params = { reference: 'b'.repeat(64), name: 'chat' };
        expect({ url, method, answer: await page.ask(method, params) }).toEqual({
          url,
          method,
          answer: { result: { method, key } },
        });
        expect(env.state.calls).toEqual([{ method, params, key }]);
      }
    }
    // No name was resolved: none of these documents has a name binding.
    expect(env.resolutions).toEqual([]);
  });

  test('a keyless document reads on the anonymous bucket, and is refused every method that uses the key', async () => {
    const env = setup();
    const page = env.tab(KEYLESS);
    for (const method of PERMISSION_FREE) {
      expect(await page.ask(method, { reference: 'b'.repeat(64) })).toEqual({ result: { method, key: '' } });
    }
    for (const method of UNDER_KEY) {
      expect({ method, answer: await page.ask(method, { name: 'chat' }) }).toEqual({ method, answer: NO_ADDRESS });
    }
    expect(env.state.calls.map((c) => c.method)).toEqual(PERMISSION_FREE);
  });

  test('every method answers 4900 while the Identity & Wallet switch is off, with nothing run', async () => {
    const env = setup();
    const page = env.tab(DAPP);
    env.state.enabled = false;
    for (const method of SWARM_PAGE_METHODS) {
      expect(await page.ask(method)).toEqual({ error: { code: 4900, message: 'Swarm provider is not available' } });
    }
    expect(env.trace.filter((e) => e.kind === 'handle-opened')).toEqual([]);
    expect(env.execute).not.toHaveBeenCalled();
  });

  test('a DNS name over IPNS: the methods under the key resolve the name before and after their wait; the reads resolve nothing', async () => {
    const env = setup();
    const page = await env.named();
    for (const method of UNDER_KEY) {
      env.resolutions.length = 0;
      expect(await page.ask(method, { name: 'chat' })).toEqual({ result: { method, key: NAME } });
      // listFeeds has no wait between its check and its read.
      expect({ method, resolutions: env.resolutions }).toEqual({
        method,
        resolutions: method === 'swarm_listFeeds' ? [NAME] : [NAME, NAME],
      });
    }
    env.resolutions.length = 0;
    for (const method of PERMISSION_FREE) {
      expect(await page.ask(method, { reference: 'b'.repeat(64) })).toEqual({ result: { method, key: NAME } });
    }
    expect(env.resolutions).toEqual([]);
  });

  test('after the name has moved off its IPNS key: every method under the key refused with nothing read; the reads still answer, resolving nothing', async () => {
    const env = setup();
    const page = await env.named();
    env.names.set(NAME, OTHER_IPNS_KEY);
    // The first method under the key finds the name moved, and reads nothing.
    expect(await page.ask('swarm_listFeeds')).toEqual(NO_ADDRESS);
    expect(env.resolutions).toEqual([NAME]);
    // The binding has ended: the document is keyless now.
    for (const method of UNDER_KEY) {
      expect({ method, answer: await page.ask(method, { name: 'chat' }) }).toEqual({ method, answer: NO_ADDRESS });
    }
    // One class per method, whatever its params: a feed read by topic too.
    expect(await page.ask('swarm_readFeedEntry', { topic: 'c'.repeat(64), owner: 'ab'.repeat(20) })).toEqual(NO_ADDRESS);
    expect(env.execute).not.toHaveBeenCalled();
    // The permission-free reads answer on, on the keyless bucket, and
    // resolve nothing.
    for (const method of PERMISSION_FREE) {
      expect(await page.ask(method, { reference: 'b'.repeat(64) })).toEqual({ result: { method, key: '' } });
    }
    expect(env.resolutions).toEqual([NAME]);
  });

  test('a name that moves while a read under it waits: the answer is withheld, and the document answers keyless', async () => {
    for (const method of ['swarm_readFeedEntry', 'swarm_getCapabilities']) {
      const env = setup();
      const page = await env.named();
      let release;
      env.state.hold = new Promise((resolve) => {
        release = resolve;
      });
      const answer = page.ask(method, { name: 'chat' });
      await flush();
      expect(env.state.calls).toEqual([{ method, params: { name: 'chat' }, key: NAME }]);
      env.names.set(NAME, OTHER_IPNS_KEY);
      release();
      expect({ method, answer: await answer }).toEqual({ method, answer: NO_ADDRESS });
      expect(env.trace.some((e) => e.kind === 'name-checked' && e.holds === false)).toBe(true);
    }
  });

  test('another request ends the binding just as a read under the name answers: the answer goes out keyless', async () => {
    const env = setup();
    const page = await env.named();
    let release;
    env.state.hold = new Promise((resolve) => {
      release = resolve;
    });
    // listFeeds reads in the same run as its check, and has no wait after.
    // Its answer is held; meanwhile another method finds the name moved.
    const listed = page.ask('swarm_listFeeds');
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    env.state.hold = null;
    expect(await page.ask('swarm_getCapabilities')).toEqual(NO_ADDRESS);
    release();
    expect(await listed).toEqual(NO_ADDRESS);
    expect(env.trace.some((e) => e.kind === 'name-lost')).toBe(true);
  });

  test('a losing name check of another request, swept across a read\'s own check: the read runs only while the document holds the name', async () => {
    for (let offset = 0; offset < 16; offset += 1) {
      const env = setup();
      const page = await env.named();
      env.resolver.held = [];
      env.trace.length = 0;
      // The read's own check, and another request's, which will find the
      // name moved.
      const listed = page.ask('swarm_listFeeds');
      const other = page.ask('swarm_getCapabilities');
      await flush();
      expect(env.resolver.held).toHaveLength(2);
      const [honest, losing] = env.resolver.held;
      honest(IPNS_KEY);
      for (let tick = 0; tick < offset; tick += 1) await Promise.resolve();
      losing(OTHER_IPNS_KEY);
      const answers = { listed: await listed, other: await other };
      expect(answers.other).toEqual(NO_ADDRESS);
      // The read ran only while the document held the name, if at all.
      const ran = env.trace.find((e) => e.kind === 'execute');
      expect({ offset, heldAtRead: ran ? ran.liveKeys.includes(NAME) : 'not run' }).toEqual({
        offset,
        heldAtRead: ran ? true : 'not run',
      });
      // And it went out only if the document still held the name when main
      // answered.
      const lost = env.trace.findIndex((e) => e.kind === 'name-lost');
      if (!ran || lost !== -1) expect({ offset, listed: answers.listed }).toEqual({ offset, listed: NO_ADDRESS });
      else expect({ offset, listed: answers.listed }).toEqual({ offset, listed: { result: { method: 'swarm_listFeeds', key: NAME } } });
    }
  });

  test('main\'s deadline answers a read that runs too long, with today\'s timeout error, and drops its late result', async () => {
    const env = setup();
    const page = env.tab(DAPP);
    let release;
    env.state.hold = new Promise((resolve) => {
      release = resolve;
    });
    const short = page.ask('swarm_readChunk', { reference: 'b'.repeat(64) });
    const long = page.ask('swarm_readData', { reference: 'b'.repeat(64) });
    await flush();
    env.timers.fire(60_000);
    expect(await short).toEqual({ error: { code: -32603, message: 'Request timed out' } });
    env.timers.fire(300_000);
    expect(await long).toEqual({ error: { code: -32603, message: 'Request timed out' } });
    release();
    await flush();
    expect(env.trace.filter((e) => e.kind === 'dropped')).toHaveLength(2);
  });

  test('a read for a document that navigated is answered to no page', async () => {
    const env = setup();
    const page = env.tab(DAPP);
    let release;
    env.state.hold = new Promise((resolve) => {
      release = resolve;
    });
    const answer = page.ask('swarm_listFeeds');
    await flush();
    page.guest.commit(`${DAPP}/other`);
    release();
    expect(await answer).toEqual({ gone: true });
  });
});
