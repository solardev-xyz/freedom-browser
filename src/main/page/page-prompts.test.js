// Page prompts: main holds them, shows one per window (the oldest of the tab
// in front), and takes a decision only for the handle it shows (freedom-core
// design 0011, "Requests and handles" and "The prompt protocol"; PRQ-4).

const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');

const CHROME_URL = 'file:///app/src/renderer/index.html';
const DAPP_A = `bzz://${'a'.repeat(64)}/`;
const DAPP_B = `bzz://${'b'.repeat(64)}/`;
const DAPP_C = `bzz://${'c'.repeat(64)}/`;
const TIMED_OUT = { error: { message: 'Request timed out' } };
const PENDING = { error: { code: -32002, message: 'Another wallet request is already pending' } };

let nextId = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A chrome window's webContents: the sender of its prompt channels. */
const chromeOf = (windowId) => ({ id: 500 + windowId });

class Guest extends EventEmitter {
  constructor({ window = 1 } = {}) {
    super();
    this.id = nextId++;
    this.window = window;
    this.hostWebContents = { id: 500 + window, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
    this.destroyed = false;
    this.mainFrame = { url: 'about:blank', frameTreeNodeId: 1000 + this.id, processId: 1, routingId: this.id, detached: false, send: jest.fn() };
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

  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

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
    live: () => timers.filter((t) => !t.cleared).map((t) => t.ms),
  };
}

// Test dispatchers: each asks the user, and answers what was decided, as a
// moved method does. Effects are recorded so a test can see none happened.
function promptingDispatchers(effects) {
  const ask = (kind) => async (context) => {
    const decision = await context.prompt({
      kind,
      view: { note: kind },
      choices: (raw) => (Number.isInteger(raw.walletIndex) ? { walletIndex: raw.walletIndex } : null),
    });
    if (decision.error) return { error: decision.error };
    if (decision.closed) return { error: { code: 4001, message: `closed: ${decision.closed}` } };
    if (!decision.approve) return { error: { code: 4001, message: 'User rejected the request' } };
    effects.push({ key: context.requester.key, kind, choices: decision.choices });
    return { result: { key: context.requester.key, choices: decision.choices } };
  };
  return {
    'ethereum:eth_requestAccounts': ask('eth.connect'),
    'swarm:swarm_requestAccess': ask('swarm.connect'),
  };
}

function setup() {
  const guests = new Map();
  const documents = createPageDocuments({
    isPrivateWebContents: () => false,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent: async () => ({ type: 'not_found' }),
  });
  const sent = []; // [window, channel, payload]
  const effects = [];
  const timers = manualTimers();
  const trace = [];
  const closedWindows = new Map();
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers: promptingDispatchers(effects),
    hooks: { onTrace: (entry) => trace.push(entry) },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    chromeWindowOf: (contents) => (Number.isInteger(contents?.id) && contents.id >= 500 ? contents.id - 500 : null),
    sendToWindow: (windowId, channel, payload) => sent.push([windowId, channel, payload]),
    watchWindow: (windowId, onClosed) => closedWindows.set(windowId, onClosed),
  });

  function tab({ url = DAPP_A, window = 1 } = {}) {
    const guest = new Guest({ window });
    guests.set(guest.id, guest);
    requests.track(guest);
    guest.commit(url);
    return greet(guest);
  }

  function greet(guest) {
    const n = nonce();
    expect(requests.hello({ sender: guest, senderFrame: guest.mainFrame }, { nonce: n }).ok).toBe(true);
    return {
      guest,
      nonce: n,
      ask: (method, provider = method.startsWith('swarm_') ? 'swarm' : 'ethereum') =>
        requests.request({ sender: guest, senderFrame: guest.mainFrame }, { nonce: n, provider, method, params: [] }),
    };
  }

  const front = (windowId, guest) =>
    requests.foreground({ sender: chromeOf(windowId) }, { guest: guest === null ? null : guest.id });
  const decide = (windowId, handle, approve = true, choices = { walletIndex: 0 }) =>
    requests.decide({ sender: chromeOf(windowId) }, { handle, approve, choices });
  const messages = (channel, windowId = 1) =>
    sent.filter(([w, c]) => w === windowId && c === channel).map(([, , payload]) => payload);
  const handleOf = (guest, windowId = guest.window) =>
    messages('page:prompt-pending', windowId).filter((m) => m.guest === guest.id).map((m) => m.handle);

  return { requests, documents, guests, sent, effects, timers, trace, closedWindows, tab, greet, front, decide, messages, handleOf };
}

describe('a background tab\'s prompt waits (0011 PRQ-4)', () => {
  test('a guest not in front gets page:prompt-pending and no page:prompt until its tab is reported in front', async () => {
    const env = setup();
    const a = env.tab();
    const b = env.tab({ url: DAPP_B });
    env.front(1, a.guest);
    const answer = b.ask('eth_requestAccounts');
    await flush();
    const [handle] = env.handleOf(b.guest);
    expect(handle).toMatch(/^[0-9a-f]{64}$/);
    expect(env.messages('page:prompt-pending')).toEqual([{ handle, guest: b.guest.id }]);
    expect(env.messages('page:prompt')).toEqual([]);
    // Its deadline runs while it waits.
    expect(env.timers.live()).toContain(60_000);
    env.front(1, b.guest);
    expect(env.messages('page:prompt')).toEqual([
      {
        handle,
        guest: b.guest.id,
        kind: 'eth.connect',
        site: { key: `bzz://${'b'.repeat(64)}`, label: `bzz://${'b'.repeat(64)}` },
        view: { note: 'eth.connect' },
      },
    ]);
    // Shown: no deadline from now on.
    expect(env.timers.live()).toEqual([]);
    expect(await env.decide(1, handle)).toEqual({ ok: true });
    expect(await answer).toEqual({ result: { key: `bzz://${'b'.repeat(64)}`, choices: { walletIndex: 0 } } });
    expect(env.messages('page:prompt-closed')).toEqual([{ handle, reason: 'decided' }]);
  });

  test('a window with no report holds every prompt', async () => {
    const env = setup();
    const a = env.tab();
    a.ask('eth_requestAccounts');
    await flush();
    expect(env.handleOf(a.guest)).toHaveLength(1);
    expect(env.messages('page:prompt')).toEqual([]);
  });

  test.each([
    ['its document navigates', (env, page) => page.guest.commit(DAPP_C), 'navigated'],
    ['its tab closes', (env, page) => page.guest.destroy(), 'closed'],
  ])('a held prompt closes when %s, with its badge and count, and nothing shows it later', async (_name, close, reason) => {
    const env = setup();
    const a = env.tab();
    const b = env.tab({ url: DAPP_B });
    env.front(1, a.guest);
    b.ask('eth_requestAccounts');
    await flush();
    const [handle] = env.handleOf(b.guest);
    close(env, b);
    await flush();
    expect(env.messages('page:prompt-closed')).toEqual([{ handle, reason }]);
    env.front(1, b.guest);
    expect(env.messages('page:prompt')).toEqual([]);
    expect(await env.decide(1, handle)).toEqual({ ok: false, reason: 'closed' });
    expect(env.effects).toEqual([]);
    expect(env.requests.stats().handles).toBe(0);
  });

  test('a held prompt closes at its deadline: the page hears "Request timed out", a later report shows nothing, and a decision does nothing', async () => {
    const env = setup();
    const a = env.tab();
    const b = env.tab({ url: DAPP_B });
    env.front(1, a.guest);
    const answer = b.ask('eth_requestAccounts');
    await flush();
    const [handle] = env.handleOf(b.guest);
    env.timers.fire(60_000);
    expect(await answer).toEqual(TIMED_OUT);
    expect(env.messages('page:prompt-closed')).toEqual([{ handle, reason: 'expired' }]);
    env.front(1, b.guest);
    expect(env.messages('page:prompt')).toEqual([]);
    expect(await env.decide(1, handle)).toEqual({ ok: false, reason: 'closed' });
    expect(env.effects).toEqual([]);
  });

  test('a held prompt closes with its window', async () => {
    const env = setup();
    const a = env.tab({ window: 2 });
    env.front(2, null);
    a.ask('eth_requestAccounts');
    await flush();
    const [handle] = env.handleOf(a.guest);
    // A window's guests go with it.
    a.guest.destroy();
    env.closedWindows.get(2)();
    expect(env.messages('page:prompt-closed', 2)).toEqual([{ handle, reason: 'closed' }]);
    expect(env.requests.promptState()).toEqual({});
  });
});

describe('several tabs', () => {
  test('the tab in front shows its oldest prompt, then its next', async () => {
    const env = setup();
    const a = env.tab();
    env.front(1, a.guest);
    const connect = a.ask('eth_requestAccounts');
    const access = a.ask('swarm_requestAccess');
    await flush();
    const [first, second] = env.handleOf(a.guest);
    expect(env.messages('page:prompt').map((m) => [m.handle, m.kind])).toEqual([[first, 'eth.connect']]);
    // Only the shown one can be decided.
    expect(await env.decide(1, second)).toEqual({ ok: false, reason: 'not-shown' });
    expect(await env.decide(1, first, false)).toEqual({ ok: true });
    expect(await connect).toEqual({ error: { code: 4001, message: 'User rejected the request' } });
    expect(env.messages('page:prompt').map((m) => [m.handle, m.kind])).toEqual([
      [first, 'eth.connect'],
      [second, 'swarm.connect'],
    ]);
    expect(await env.decide(1, second)).toEqual({ ok: true });
    expect((await access).result.choices).toEqual({ walletIndex: 0 });
  });

  test('a background tab\'s waiting prompt never refuses or replaces the tab in front\'s', async () => {
    const env = setup();
    const a = env.tab();
    const b = env.tab({ url: DAPP_B });
    env.front(1, a.guest);
    b.ask('eth_requestAccounts');
    await flush();
    const front = a.ask('eth_requestAccounts');
    await flush();
    const [aHandle] = env.handleOf(a.guest);
    const [bHandle] = env.handleOf(b.guest);
    expect(env.messages('page:prompt').map((m) => m.handle)).toEqual([aHandle]);
    expect(await env.decide(1, aHandle)).toEqual({ ok: true });
    expect((await front).result.key).toBe(`bzz://${'a'.repeat(64)}`);
    // B's still waits, unshown, and its deadline still runs.
    expect(env.messages('page:prompt').map((m) => m.handle)).toEqual([aHandle]);
    expect(env.requests.promptState()[1]).toEqual({ front: a.guest.id, shown: null, open: [bHandle] });
  });

  test('one pending wallet prompt per document: the next request gets -32002, and the dApp can retry', async () => {
    const env = setup();
    const a = env.tab();
    const b = env.tab({ url: DAPP_B });
    env.front(1, a.guest);
    const first = a.ask('eth_requestAccounts');
    await flush();
    expect(await a.ask('eth_requestAccounts')).toEqual(PENDING);
    // Another document's is its own.
    b.ask('eth_requestAccounts');
    await flush();
    expect(env.handleOf(b.guest)).toHaveLength(1);
    // Swarm's prompts keep their own limits.
    a.ask('swarm_requestAccess');
    await flush();
    expect(env.handleOf(a.guest)).toHaveLength(2);
    const [handle] = env.handleOf(a.guest);
    await env.decide(1, handle);
    await first;
    // Decided: the document may ask again.
    a.ask('eth_requestAccounts');
    await flush();
    expect(env.handleOf(a.guest)).toHaveLength(3);
  });
});

describe('switching away and back', () => {
  test('a shown prompt is hidden when another tab comes to the front, keeps its place with no deadline, and shows again', async () => {
    const env = setup();
    const a = env.tab();
    const b = env.tab({ url: DAPP_B });
    env.front(1, a.guest);
    const answerA = a.ask('eth_requestAccounts');
    await flush();
    const [aHandle] = env.handleOf(a.guest);
    expect(env.messages('page:prompt').map((m) => m.handle)).toEqual([aHandle]);
    env.front(1, b.guest);
    expect(env.messages('page:prompt-hidden')).toEqual([{ handle: aHandle }]);
    // No deadline once shown, hidden again or not.
    env.timers.fire(60_000);
    await flush();
    expect(env.messages('page:prompt-closed')).toEqual([]);
    // B's oldest shows, if it has one.
    const answerB = b.ask('eth_requestAccounts');
    await flush();
    const [bHandle] = env.handleOf(b.guest);
    expect(env.messages('page:prompt').map((m) => m.handle)).toEqual([aHandle, bHandle]);
    // Back to A: B's is hidden and A's shows again.
    env.front(1, a.guest);
    expect(env.messages('page:prompt-hidden')).toEqual([{ handle: aHandle }, { handle: bHandle }]);
    expect(env.messages('page:prompt').map((m) => m.handle)).toEqual([aHandle, bHandle, aHandle]);
    expect(await env.decide(1, aHandle)).toEqual({ ok: true });
    expect((await answerA).result.key).toBe(`bzz://${'a'.repeat(64)}`);
    env.front(1, b.guest);
    expect(await env.decide(1, bHandle, false)).toEqual({ ok: true });
    expect((await answerB).error.code).toBe(4001);
  });

  test('a decision for A sent after the report of B is refused with nothing done; after switching back it counts', async () => {
    const env = setup();
    const a = env.tab();
    const b = env.tab({ url: DAPP_B });
    env.front(1, a.guest);
    const answer = a.ask('eth_requestAccounts');
    await flush();
    const [handle] = env.handleOf(a.guest);
    // The chrome reports B, and A's click was already in flight.
    env.front(1, b.guest);
    expect(await env.decide(1, handle)).toEqual({ ok: false, reason: 'not-shown' });
    await flush();
    expect(env.effects).toEqual([]);
    expect(env.messages('page:prompt-closed')).toEqual([]);
    env.front(1, a.guest);
    expect(await env.decide(1, handle)).toEqual({ ok: true });
    expect((await answer).result.choices).toEqual({ walletIndex: 0 });
    expect(env.effects).toHaveLength(1);
  });

  test('a report of the same tab again changes nothing; a tab with no page hides the shown prompt', async () => {
    const env = setup();
    const a = env.tab();
    env.front(1, a.guest);
    a.ask('eth_requestAccounts');
    await flush();
    const [handle] = env.handleOf(a.guest);
    env.front(1, a.guest);
    expect(env.messages('page:prompt')).toHaveLength(1);
    expect(env.front(1, null)).toBe(true);
    expect(env.messages('page:prompt-hidden')).toEqual([{ handle }]);
    expect(await env.decide(1, handle)).toEqual({ ok: false, reason: 'not-shown' });
  });

  test('badges and the count follow open handles until page:prompt-closed', async () => {
    const env = setup();
    const a = env.tab();
    const b = env.tab({ url: DAPP_B });
    env.front(1, a.guest);
    a.ask('eth_requestAccounts');
    b.ask('eth_requestAccounts');
    await flush();
    const open = () => {
      const closed = new Set(env.messages('page:prompt-closed').map((m) => m.handle));
      return env.messages('page:prompt-pending').filter((m) => !closed.has(m.handle));
    };
    expect(open().map((m) => m.guest)).toEqual([a.guest.id, b.guest.id]);
    const [aHandle] = env.handleOf(a.guest);
    await env.decide(1, aHandle);
    expect(open().map((m) => m.guest)).toEqual([b.guest.id]);
    b.guest.commit(DAPP_C);
    expect(open()).toEqual([]);
  });
});

describe('forged decisions and reports are refused', () => {
  test('a decision from another window\'s chrome is refused for this window\'s handle', async () => {
    const env = setup();
    const a = env.tab();
    env.front(1, a.guest);
    a.ask('eth_requestAccounts');
    await flush();
    const [handle] = env.handleOf(a.guest);
    expect(await env.decide(2, handle)).toEqual({ ok: false, reason: 'closed' });
    expect(env.effects).toEqual([]);
    expect(env.requests.promptState()[1].shown).toBe(handle);
    // Neither does a sender that is no window's chrome.
    expect(await env.requests.decide({ sender: { id: 7 } }, { handle, approve: true, choices: {} })).toEqual({
      ok: false,
      reason: 'not-a-window',
    });
  });

  test('page:decide names no site: a payload with anything but a handle, a decision and the choices is refused', async () => {
    const env = setup();
    const a = env.tab();
    env.front(1, a.guest);
    const answer = a.ask('eth_requestAccounts');
    await flush();
    const [handle] = env.handleOf(a.guest);
    const decide = (payload) => env.requests.decide({ sender: chromeOf(1) }, payload);
    for (const payload of [
      { handle, approve: true, choices: { walletIndex: 0 }, site: 'https://other.example' },
      { handle, approve: true, choices: { walletIndex: 0 }, key: 'name.eth' },
      { handle, approve: true, choices: { walletIndex: 0 }, guest: a.guest.id },
      { handle, approve: 'yes' },
      { handle: 7, approve: true },
      [handle, true],
      null,
      { handle, approve: true, choices: 'all' },
      // Choices the kind doesn't take.
      { handle, approve: true, choices: { walletIndex: 'all' } },
    ]) {
      expect(await decide(payload)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(await decide({ handle: 'f'.repeat(64), approve: true, choices: {} })).toEqual({ ok: false, reason: 'closed' });
    expect(env.effects).toEqual([]);
    // The prompt is still there, and its decision acts on its own request.
    expect(await decide({ handle, approve: true, choices: { walletIndex: 3 } })).toEqual({ ok: true });
    expect(await answer).toEqual({ result: { key: `bzz://${'a'.repeat(64)}`, choices: { walletIndex: 3 } } });
    expect(env.effects).toEqual([{ key: `bzz://${'a'.repeat(64)}`, kind: 'eth.connect', choices: { walletIndex: 3 } }]);
    // A handle decides once.
    expect(await decide({ handle, approve: false })).toEqual({ ok: false, reason: 'closed' });
  });

  test('page:foreground from another window\'s chrome, naming a dead guest or another window\'s guest, or malformed, is ignored', async () => {
    const env = setup();
    const a = env.tab();
    const other = env.tab({ url: DAPP_B, window: 2 });
    env.front(1, null);
    a.ask('eth_requestAccounts');
    await flush();
    const ignored = [
      // Window 2's chrome names window 1's guest.
      () => env.requests.foreground({ sender: chromeOf(2) }, { guest: a.guest.id }),
      // Window 1's chrome names window 2's guest.
      () => env.requests.foreground({ sender: chromeOf(1) }, { guest: other.guest.id }),
      // A sender that is no window's chrome.
      () => env.requests.foreground({ sender: { id: 9 } }, { guest: a.guest.id }),
      () => env.requests.foreground({ sender: chromeOf(1) }, { guest: 99999 }),
      () => env.requests.foreground({ sender: chromeOf(1) }, { guest: String(a.guest.id) }),
      () => env.requests.foreground({ sender: chromeOf(1) }, { guest: a.guest.id, handle: 'x' }),
      () => env.requests.foreground({ sender: chromeOf(1) }, null),
    ];
    for (const report of ignored) expect(report()).toBe(false);
    expect(env.messages('page:prompt')).toEqual([]);
    expect(env.messages('page:prompt', 2)).toEqual([]);
    // A dead guest.
    const c = env.tab({ url: DAPP_C });
    c.guest.destroy();
    expect(env.front(1, c.guest)).toBe(false);
    expect(env.messages('page:prompt')).toEqual([]);
    // The real report shows it.
    expect(env.front(1, a.guest)).toBe(true);
    expect(env.messages('page:prompt')).toHaveLength(1);
  });
});

// A prompt's content can change while it is open (0011 "Rendering a page's
// data": the renderer's input delay starts again when it does, APS-1).
describe('update', () => {
  const { createPagePrompts, TEST_KIND, KIND_SET, WALLET_KINDS } = require('./page-prompts');
  const site = { key: DAPP_A, label: DAPP_A };

  function prompts() {
    const sent = [];
    const api = createPagePrompts({
      send: (windowId, channel, payload) => sent.push([windowId, channel, payload]),
      markShown: () => true,
      decided: () => {},
    });
    return { api, sent };
  }

  test('the shown prompt shows again with its new view; a waiting one changes quietly', () => {
    const { api, sent } = prompts();
    api.foreground(1, 10);
    api.add({ handle: 'h1', record: {}, window: 1, guest: 10, document: '10:1', kind: 'eth.sign', site, view: { n: 1 } });
    api.add({ handle: 'h2', record: {}, window: 1, guest: 11, document: '11:1', kind: 'eth.sign', site, view: { n: 2 } });
    sent.length = 0;
    expect(api.update('h1', { n: 3 })).toBe(true);
    expect(sent).toEqual([[1, 'page:prompt', { handle: 'h1', guest: 10, kind: 'eth.sign', site, view: { n: 3 } }]]);
    expect(api.update('h2', { n: 4 })).toBe(true);
    expect(sent).toHaveLength(1);
    api.foreground(1, 11);
    expect(sent.at(-1)).toEqual([1, 'page:prompt', { handle: 'h2', guest: 11, kind: 'eth.sign', site, view: { n: 4 } }]);
    api.closed('h2', 'decided');
    expect(api.update('h2', { n: 5 })).toBe(false);
  });

  test('the harness\'s kind is no production kind and no wallet kind', () => {
    expect(TEST_KIND).toBe('test.prompt');
    expect(KIND_SET.has(TEST_KIND)).toBe(false);
    expect(WALLET_KINDS.has(TEST_KIND)).toBe(false);
  });
});
