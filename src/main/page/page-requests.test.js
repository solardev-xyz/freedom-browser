const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests, CHANNELS, CLOSED, GONE } = require('./page-requests');
const { BUDGETS, chargeOf, largestChargeOf } = require('./page-budgets');
const { measurePageRequest, pageRequestMaxBytes } = require('../../shared/page-request-bounds');
const { ipnsMhToCidV1Base36 } = require('../../shared/cid-utils');

const CHROME_URL = 'file:///app/src/renderer/index.html';
const HASH = 'a'.repeat(64);
const DAPP = `bzz://${HASH}/`;
const DAPP_KEY = `bzz://${HASH}`;
const IPNS_B58 = '12D3KooWD3eckifWpRn9wQpMG9R9hX3sD158z7EqHWmweQAJU5SA';
const IPNS_KEY = ipnsMhToCidV1Base36(IPNS_B58);

let nextId = 1;
let nextRoutingId = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A tab guest: a webview webContents hosted by chrome window `window`. */
class Guest extends EventEmitter {
  constructor({ window = 1 } = {}) {
    super();
    this.id = nextId++;
    this.window = window;
    this.hostWebContents = { isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
    this.destroyed = false;
    this.sent = [];
    this.mainFrame = this.makeFrame('about:blank', 1000 + this.id);
  }

  makeFrame(url, frameTreeNodeId) {
    const frame = { url, frameTreeNodeId, processId: 1, routingId: nextRoutingId++, detached: false };
    frame.send = jest.fn((channel, message) => this.sent.push({ frame, channel, message }));
    return frame;
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

  /** Commit a main-frame document; `newFrame` is a new RenderFrameHost. */
  commit(url, { newFrame = true } = {}) {
    if (newFrame) {
      this.mainFrame.detached = true;
      this.mainFrame = this.makeFrame(url, this.mainFrame.frameTreeNodeId);
    } else {
      this.mainFrame.url = url;
    }
    const { processId, routingId } = this.mainFrame;
    this.emit('did-frame-navigate', {}, url, 200, 'OK', true, processId, routingId);
  }

  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

const eventFrom = (guest, senderFrame = guest.mainFrame) => ({ sender: guest, senderFrame });

/** A dispatcher that holds each call until the test answers it. */
function heldDispatcher() {
  const calls = [];
  const dispatch = jest.fn(
    (context) =>
      new Promise((resolve, reject) => {
        calls.push({ context, resolve, reject });
      })
  );
  return { dispatch, calls };
}

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
    // Fire every live timer of exactly `ms`.
    fire(ms) {
      for (const timer of timers.filter((t) => t.ms === ms && !t.cleared)) {
        timer.cleared = true;
        timer.fn();
      }
    },
    live: () => timers.filter((t) => !t.cleared).map((t) => t.ms),
  };
}

function setup({ dispatch, dispatchers, budgets, tickets, resolveEnsContent } = {}) {
  const guests = new Map();
  const privateContents = new Set();
  const documents = createPageDocuments({
    isPrivateWebContents: (contents) => privateContents.has(contents),
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent: resolveEnsContent || (async () => ({ type: 'not_found' })),
  });
  const trace = [];
  const copies = [];
  const hooks = { onTrace: (entry) => trace.push(entry), onCopy: (entry) => copies.push(entry) };
  if (dispatch) hooks.dispatch = dispatch;
  const timers = manualTimers();
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers,
    hooks,
    budgets,
    tickets,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  /** A tracked guest on `url` whose document has said hello. */
  function tab({ url = DAPP, window = 1, guest = new Guest({ window }) } = {}) {
    guests.set(guest.id, guest);
    requests.track(guest);
    guest.commit(url);
    return greet(guest);
  }

  function greet(guest) {
    const n = nonce();
    expect(requests.hello(eventFrom(guest), { nonce: n })).toEqual({ ok: true, navigation: expect.any(Number) });
    const page = {
      guest,
      nonce: n,
      ask: (method, params = {}, provider = providerOf(method), frame = guest.mainFrame) =>
        requests.request(eventFrom(guest, frame), { nonce: n, provider, method, params }),
      // A request as a renderer may send it, past the preload.
      send: (fields, frame = guest.mainFrame) => requests.request(eventFrom(guest, frame), { nonce: n, ...fields }),
      reserve: (method, bytes, fields = {}, frame = guest.mainFrame) =>
        requests.reserve(eventFrom(guest, frame), { nonce: n, method, bytes, ...fields }),
    };
    return page;
  }

  return { documents, requests, hooks, trace, copies, timers, tab, greet, guests, privateContents };
}

const providerOf = (method) => (method.startsWith('swarm_') ? 'swarm' : method.startsWith('radicle_') ? 'radicle' : 'ethereum');
const recorded = (trace) => trace.filter((entry) => entry.kind === 'recorded');

describe('page requests: the way in (freedom-core design 0011, PRQ-2)', () => {
  test('a request from the current document reaches its dispatcher as its attested requester', async () => {
    const dispatch = jest.fn(async (context) => ({ result: { method: context.method, params: context.params } }));
    const { tab, requests } = setup({ dispatch });
    const page = tab();
    const answer = await page.ask('swarm_readChunk', { reference: 'ab' });
    expect(answer).toEqual({ result: { method: 'swarm_readChunk', params: { reference: 'ab' } } });
    const [context] = dispatch.mock.calls[0];
    expect(context.requester).toEqual(
      expect.objectContaining({
        guest: page.guest.id,
        window: 1,
        frame: page.guest.mainFrame.frameTreeNodeId,
        nonce: page.nonce,
        url: DAPP,
        transportKey: DAPP_KEY,
        key: DAPP_KEY,
      })
    );
    expect(Object.isFrozen(context.requester)).toBe(true);
    expect(context.provider).toBe('swarm');
    expect(context.class).toBe('permission-free');
    expect(context.isCurrent()).toBe(true);
    expect(requests.stats()).toEqual({
      browser: { requests: 0, bytes: 0 },
      windows: {},
      documents: {},
      turns: 0,
      waiting: 0,
      tickets: 0,
      records: 0,
      handles: 0,
    });
  });

  test('a method with no row, a refused one, or one no dispatcher serves never runs and is never recorded', async () => {
    const dispatch = jest.fn(async () => ({ result: 'ran' }));
    const { tab, trace, requests } = setup({ dispatch });
    const page = tab();
    const ask = (payload) => requests.request(eventFrom(page.guest), { nonce: page.nonce, ...payload });
    const INVALID = { error: { code: -32602, message: 'Invalid parameters' } };

    for (const payload of [null, undefined, 'x', 7, [], new Map()]) {
      expect(await requests.request(eventFrom(page.guest), payload)).toEqual(INVALID);
    }
    for (const provider of [undefined, 'bitcoin', '__proto__', 'toString', ['swarm']]) {
      expect(await ask({ provider, method: 'swarm_readChunk' })).toEqual(INVALID);
    }
    for (const method of [undefined, '', 7, { toString: () => 'swarm_readChunk' }]) {
      expect(await ask({ provider: 'swarm', method })).toEqual(INVALID);
    }
    expect(await ask({ provider: 'ethereum', method: 'wallet_addEthereumChain' })).toEqual({
      error: { code: 4200, message: 'Method not supported' },
    });
    expect(await ask({ provider: 'swarm', method: 'swarm_deleteEverything' })).toEqual({
      error: { code: 4200, message: 'Unknown method: swarm_deleteEverything' },
    });
    expect(await ask({ provider: 'radicle', method: '__proto__' })).toEqual({
      error: { code: 4200, message: 'Unknown method: __proto__' },
    });
    // Another provider's method has no row under this one.
    expect(await ask({ provider: 'ethereum', method: 'swarm_readChunk' })).toEqual({
      error: { code: 4200, message: 'Method not supported' },
    });
    // The table refuses it for every caller, whatever serves the rest.
    expect(await ask({ provider: 'ethereum', method: 'eth_sign' })).toEqual({
      error: { code: 4200, message: 'eth_sign is deprecated for security reasons' },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(recorded(trace)).toEqual([]);

    // The app's own instance has no dispatcher yet: every listed method is
    // refused as unknown, before the sender is even attested.
    const app = setup();
    const appPage = app.tab();
    expect(await appPage.ask('eth_chainId', [])).toEqual({ error: { code: 4200, message: 'Method not supported' } });
    expect(await appPage.ask('swarm_readChunk')).toEqual({
      error: { code: 4200, message: 'Unknown method: swarm_readChunk' },
    });
    expect(recorded(app.trace)).toEqual([]);
  });

  test('a production dispatcher serves only its own method', async () => {
    const readChunk = jest.fn(async () => ({ result: 'chunk' }));
    const { tab } = setup({ dispatchers: { 'swarm:swarm_readChunk': readChunk } });
    const page = tab();
    expect(await page.ask('swarm_readChunk')).toEqual({ result: 'chunk' });
    expect(await page.ask('swarm_readData')).toEqual({ error: { code: 4200, message: 'Unknown method: swarm_readData' } });
    expect(readChunk).toHaveBeenCalledTimes(1);
  });

  test('the attested requester refuses, before anything is recorded or run', async () => {
    const dispatch = jest.fn(async () => ({ result: 'ran' }));
    const { tab, trace, requests, privateContents, guests } = setup({ dispatch });
    const refused = (reason) => ({ error: { code: 4100, message: 'Unauthorized', data: { reason } } });
    const ask = (event, n) => requests.request(event, { nonce: n, provider: 'swarm', method: 'swarm_readChunk' });

    // Not a tab: the chrome window itself, which has no page to speak for,
    // or a webview that a page hosts.
    const page = tab();
    const chrome = { id: 999, isDestroyed: () => false, getType: () => 'window', mainFrame: { url: CHROME_URL } };
    expect(await ask({ sender: chrome, senderFrame: chrome.mainFrame }, page.nonce)).toEqual(refused('not-a-tab'));
    const nested = new Guest();
    nested.hostWebContents = { isDestroyed: () => false, mainFrame: { url: 'https://evil.example/' } };
    guests.set(nested.id, nested);
    requests.track(nested);
    nested.commit(DAPP);
    const nestedNonce = nonce();
    expect(requests.hello(eventFrom(nested), { nonce: nestedNonce })).toEqual({ ok: false, reason: 'not-a-tab' });
    expect(await ask(eventFrom(nested), nestedNonce)).toEqual(refused('not-a-tab'));

    // A sub-frame, and a frame gone or detached.
    expect(await page.ask('swarm_readChunk', {}, 'swarm', { url: DAPP, frameTreeNodeId: 5, detached: false })).toEqual(
      refused('sub-frame')
    );
    expect(await ask(eventFrom(page.guest, null), page.nonce)).toEqual(refused('detached'));
    expect(await ask(eventFrom(page.guest, { ...page.guest.mainFrame, detached: true }), page.nonce)).toEqual(
      refused('detached')
    );

    // No hello, another nonce, and a document that has gone.
    const quiet = new Guest();
    guests.set(quiet.id, quiet);
    requests.track(quiet);
    quiet.commit(DAPP);
    expect(await ask(eventFrom(quiet), nonce())).toEqual(refused('no-hello'));
    expect(await ask(eventFrom(page.guest), nonce())).toEqual(refused('wrong-nonce'));
    const old = page.nonce;
    page.guest.commit(`${DAPP}two`, { newFrame: false });
    expect(await ask(eventFrom(page.guest), old)).toEqual(refused('navigated'));

    // A private window's guest, whatever its preload did.
    const secret = tab();
    privateContents.add(secret.guest);
    expect(await secret.ask('swarm_readChunk')).toEqual(refused('private'));

    // A preview.
    const preview = new Guest();
    guests.set(preview.id, preview);
    requests.track(preview);
    preview.commit(`freedom-preview://${'b'.repeat(40)}/index.html`);
    expect(requests.hello(eventFrom(preview), { nonce: nonce() })).toEqual({ ok: false, reason: 'preview' });
    expect(await ask(eventFrom(preview), nonce())).toEqual(refused('preview'));

    expect(dispatch).not.toHaveBeenCalled();
    expect(recorded(trace)).toEqual([]);
  });
});

describe('page requests in flight across a navigation', () => {
  test.each([
    ['same-process', false],
    ['cross-process', true],
  ])('a %s navigation: the request gets no reply, its late result is dropped, and its work is let go', async (_name, newFrame) => {
    const held = heldDispatcher();
    const { tab, trace, requests, greet } = setup({ dispatch: held.dispatch });
    const page = tab();
    let settled = null;
    page.ask('swarm_publishData', { data: 'x' }).then((value) => {
      settled = value;
    });
    await flush();
    expect(held.calls).toHaveLength(1);
    expect(requests.stats().records).toBe(1);

    page.guest.commit(`${DAPP}next`, { newFrame });
    await flush();
    // The invoke's answer goes to the context that asked, which went with its
    // document: nothing a page sees.
    expect(settled).toBe(GONE);
    expect(held.calls[0].context.isCurrent()).toBe(false);
    // The work started still holds its place until it ends.
    expect(requests.stats().records).toBe(1);

    held.calls[0].resolve({ result: 'published' });
    await flush();
    expect(trace.map((entry) => entry.kind)).toEqual(['hello', 'recorded', 'gone', 'dropped', 'released']);
    expect(requests.stats().records).toBe(0);

    // The new document asks for itself as usual.
    const next = greet(page.guest);
    const answer = next.ask('swarm_readChunk');
    await flush();
    held.calls[1].resolve({ result: 'mine' });
    expect(await answer).toEqual({ result: 'mine' });
  });

  test('a guest destroyed: no reply, and its handles close as closed', async () => {
    const held = heldDispatcher();
    const { tab, requests } = setup({ dispatch: held.dispatch });
    const page = tab();
    const closed = [];
    requests.onHandleClosed((entry) => closed.push(entry));
    const answer = page.ask('eth_sendTransaction', [{}]);
    await flush();
    const handle = held.calls[0].context.openHandle();
    page.guest.destroy();
    expect(await answer).toBe(GONE);
    expect(closed).toEqual([{ handle, window: 1, guest: page.guest.id, reason: CLOSED.CLOSED }]);
    expect(requests.findHandle(1, handle)).toBeNull();
  });
});

describe('one deadline, main\'s', () => {
  test('until its prompt shows, a request has today\'s time limit for its method, then "Request timed out"', async () => {
    const held = heldDispatcher();
    const { tab, timers, trace, requests } = setup({ dispatch: held.dispatch });
    const page = tab();
    const answers = {};
    const ask = (method, params) =>
      page.ask(method, params).then((value) => {
        answers[method] = value;
      });
    ask('swarm_readChunk');
    ask('eth_sendTransaction', [{}]);
    ask('eth_blockNumber', []);
    ask('radicle_seed');
    await flush();
    expect(timers.live().sort((a, b) => a - b)).toEqual([60_000, 60_000, 300_000, 300_000]);

    timers.fire(60_000);
    await flush();
    expect(answers).toEqual({
      swarm_readChunk: { error: { code: -32603, message: 'Request timed out' } },
      // The Ethereum provider's own timeout error carries no code.
      eth_blockNumber: { error: { message: 'Request timed out' } },
    });
    timers.fire(300_000);
    await flush();
    expect(answers.eth_sendTransaction).toEqual({ error: { message: 'Request timed out' } });
    expect(answers.radicle_seed).toEqual({ error: { code: -32603, message: 'Request timed out' } });

    // A late result is dropped; the work's place is let go once it ends.
    expect(requests.stats().records).toBe(4);
    for (const call of held.calls) call.resolve({ result: 'late' });
    await flush();
    expect(trace.filter((entry) => entry.kind === 'dropped')).toHaveLength(4);
    expect(requests.stats().records).toBe(0);
  });

  test('a prompt that never showed closes as expired; a shown one has no deadline', async () => {
    const held = heldDispatcher();
    const { tab, timers, requests } = setup({ dispatch: held.dispatch });
    const page = tab();
    const closed = [];
    requests.onHandleClosed((entry) => closed.push(entry.reason));
    let neverShown = null;
    let shown = null;
    page.ask('eth_sendTransaction', [{}]).then((value) => {
      neverShown = value;
    });
    page.ask('personal_sign', ['0x00']).then((value) => {
      shown = value;
    });
    await flush();
    const [first, second] = held.calls;
    const expiring = first.context.openHandle();
    const waiting = second.context.openHandle();
    expect(expiring).toMatch(/^[0-9a-f]{64}$/);
    expect(waiting).toMatch(/^[0-9a-f]{64}$/);
    expect(waiting).not.toBe(expiring);
    expect(second.context.markShown()).toBe(true);

    timers.fire(300_000);
    timers.fire(60_000);
    await flush();
    expect(neverShown).toEqual({ error: { message: 'Request timed out' } });
    expect(closed).toEqual([CLOSED.EXPIRED]);
    expect(requests.findHandle(1, expiring)).toBeNull();
    // The shown prompt waits for its decision, however long.
    expect(shown).toBeNull();
    expect(requests.findHandle(1, waiting)).toEqual({ id: expect.any(Number), handle: waiting, requester: second.context.requester, shown: true });
    second.resolve({ result: '0xsig' });
    await flush();
    expect(shown).toEqual({ result: '0xsig' });
  });

  test('markShown needs an open handle, and a closed request opens none', async () => {
    const held = heldDispatcher();
    const { tab, timers } = setup({ dispatch: held.dispatch });
    const page = tab();
    let answer = null;
    page.ask('swarm_readChunk').then((value) => {
      answer = value;
    });
    await flush();
    const { context } = held.calls[0];
    expect(context.markShown()).toBe(false);
    timers.fire(60_000);
    await flush();
    expect(answer).toEqual({ error: { code: -32603, message: 'Request timed out' } });
    expect(context.openHandle()).toBeNull();
  });
});

describe('handles', () => {
  test('scoped to the window that hosts the guest, and closed when the document navigates', async () => {
    const held = heldDispatcher();
    const { tab, requests } = setup({ dispatch: held.dispatch });
    const page = tab({ window: 3 });
    const closed = [];
    const stop = requests.onHandleClosed((entry) => closed.push(entry));
    page.ask('eth_requestAccounts', []);
    await flush();
    const { context } = held.calls[0];
    const handle = context.openHandle();
    expect(context.openHandle()).toBe(handle);
    expect(requests.findHandle(3, handle)).toEqual({ id: expect.any(Number), handle, requester: context.requester, shown: false });
    expect(requests.findHandle(4, handle)).toBeNull();
    expect(requests.findHandle(3, 'f'.repeat(64))).toBeNull();
    expect(requests.findHandle(3, undefined)).toBeNull();
    expect(requests.stats().handles).toBe(1);

    page.guest.commit(`${DAPP}elsewhere`, { newFrame: false });
    expect(closed).toEqual([{ handle, window: 3, guest: page.guest.id, reason: CLOSED.NAVIGATED }]);
    expect(requests.findHandle(3, handle)).toBeNull();
    stop();
    expect(requests.stats().handles).toBe(0);
  });

  test('a request answered with its handle still open closes it as cancelled', async () => {
    const held = heldDispatcher();
    const { tab, requests } = setup({ dispatch: held.dispatch });
    const page = tab();
    const closed = [];
    requests.onHandleClosed((entry) => closed.push(entry.reason));
    const answer = page.ask('eth_requestAccounts', []);
    await flush();
    held.calls[0].context.openHandle();
    held.calls[0].resolve({ error: { code: 4001, message: 'User rejected the request' } });
    expect(await answer).toEqual({ error: { code: 4001, message: 'User rejected the request' } });
    expect(closed).toEqual([CLOSED.CANCELLED]);
  });
});

describe('the count bounds', () => {
  const LIMIT = { error: { code: -32005, message: 'Limit exceeded' } };

  test('the numbers are the design\'s', () => {
    expect(BUDGETS.document.requests).toBe(64);
    expect(BUDGETS.window.requests).toBe(256);
    expect(BUDGETS.browser.requests).toBe(1024);
  });

  test('a document holds 64 requests in flight; the next is refused and runs nothing, until one ends', async () => {
    const held = heldDispatcher();
    const { tab, requests } = setup({ dispatch: held.dispatch });
    const page = tab();
    for (let i = 0; i < 64; i += 1) page.ask('swarm_readChunk');
    await flush();
    expect(held.calls).toHaveLength(64);
    expect(await page.ask('swarm_readChunk')).toEqual(LIMIT);
    expect(await page.ask('eth_chainId', [])).toEqual(LIMIT);
    expect(held.calls).toHaveLength(64);

    // Another document of the same window still has room.
    const other = tab();
    other.ask('swarm_readChunk');
    await flush();
    expect(held.calls).toHaveLength(65);

    held.calls[0].resolve({ result: 1 });
    await flush();
    page.ask('swarm_readChunk');
    await flush();
    expect(held.calls).toHaveLength(66);
    expect(requests.stats().documents[`${page.guest.id}:${held.calls[0].context.requester.navigation}`].requests).toBe(64);
  });

  test('documents in two windows fill the window\'s and then the browser\'s bound; admission resumes as they finish', async () => {
    const held = heldDispatcher();
    const { tab, requests } = setup({ dispatch: held.dispatch });
    const fill = (page, count) => {
      for (let i = 0; i < count; i += 1) page.ask('swarm_readChunk');
    };
    // Window 1: four documents fill its 256.
    const first = [tab({ window: 1 }), tab({ window: 1 }), tab({ window: 1 }), tab({ window: 1 })];
    for (const page of first) fill(page, 64);
    await flush();
    expect(requests.stats().windows[1].requests).toBe(256);
    const fifth = tab({ window: 1 });
    expect(await fifth.ask('swarm_readChunk')).toEqual(LIMIT);

    // Windows 2 to 4 fill the browser's 1,024.
    for (const window of [2, 3, 4]) {
      for (let i = 0; i < 4; i += 1) fill(tab({ window }), 64);
    }
    await flush();
    expect(requests.stats().records).toBe(1024);
    expect(held.calls).toHaveLength(1024);
    const late = tab({ window: 5 });
    expect(await late.ask('swarm_readChunk')).toEqual(LIMIT);
    expect(held.calls).toHaveLength(1024);

    // One ends: one more fits, in any window but the full one.
    held.calls[300].resolve({ result: 'done' });
    await flush();
    expect(requests.stats().records).toBe(1023);
    late.ask('swarm_readChunk');
    await flush();
    expect(held.calls).toHaveLength(1025);
    expect(await late.ask('swarm_readChunk')).toEqual(LIMIT);
  });

  test('a document that has gone keeps its window\'s count until its work ends', async () => {
    const held = heldDispatcher();
    const { tab, requests, greet } = setup({ dispatch: held.dispatch });
    const page = tab();
    for (let i = 0; i < 10; i += 1) page.ask('swarm_publishChunk');
    await flush();
    page.guest.commit(`${DAPP}next`);
    const next = greet(page.guest);
    next.ask('swarm_readChunk');
    await flush();
    expect(requests.stats().windows[1].requests).toBe(11);
    for (const call of held.calls.slice(0, 10)) call.resolve({ result: 'ok' });
    await flush();
    expect(requests.stats().windows[1].requests).toBe(1);
  });
});

describe('a name-keyed document', () => {
  const NAME = 'example.com';

  function bound(resolveEnsContent) {
    const held = heldDispatcher();
    const env = setup({ dispatch: held.dispatch, resolveEnsContent });
    const guest = new Guest();
    env.guests.set(guest.id, guest);
    env.requests.track(guest);
    expect(env.documents.bindName({ guest: guest.id, name: NAME, key: IPNS_KEY })).toBe(true);
    guest.commit(`ipns://${IPNS_KEY}/`);
    const page = env.greet(guest);
    return { ...env, held, page };
  }

  test('a request waiting for the name check is counted at once, and runs under the name', async () => {
    let answerName;
    const { page, held, requests } = bound(
      () =>
        new Promise((resolve) => {
          answerName = () => resolve({ type: 'ok', protocol: 'ipns', decoded: IPNS_B58 });
        })
    );
    page.ask('eth_accounts', []);
    await flush();
    expect(requests.stats().records).toBe(1);
    expect(held.calls).toHaveLength(0);
    answerName();
    await flush();
    expect(held.calls).toHaveLength(1);
    expect(held.calls[0].context.requester).toEqual(
      expect.objectContaining({ key: NAME, transportKey: `ipns://${IPNS_KEY}` })
    );
  });

  test('a document that navigates while its name is checked: no reply, nothing run', async () => {
    let answerName;
    const { page, held, requests } = bound(
      () =>
        new Promise((resolve) => {
          answerName = () => resolve({ type: 'ok', protocol: 'ipns', decoded: IPNS_B58 });
        })
    );
    const answer = page.ask('eth_accounts', []);
    await flush();
    page.guest.commit(DAPP);
    answerName();
    expect(await answer).toBe(GONE);
    await flush();
    expect(held.calls).toHaveLength(0);
    expect(requests.stats().records).toBe(0);
  });
});

describe('page:event', () => {
  test('goes to the document\'s main frame with its nonce, only while it is current', async () => {
    const { tab, requests, documents } = setup();
    const page = tab();
    const target = (await documents.attest(eventFrom(page.guest), page.nonce)).requester;

    expect(await requests.sendEvent(target, 'swarm', 'message', { data: 'hi' })).toEqual({ ok: true });
    expect(page.guest.sent).toEqual([
      {
        frame: page.guest.mainFrame,
        channel: CHANNELS.EVENT,
        message: { nonce: page.nonce, provider: 'swarm', event: 'message', data: { data: 'hi' } },
      },
    ]);

    // An event with no row is never sent.
    for (const [provider, event] of [
      ['ethereum', 'message'],
      ['swarm', '__proto__'],
      ['bitcoin', 'connect'],
    ]) {
      expect(await requests.sendEvent(target, provider, event, {})).toEqual({ ok: false, reason: 'unlisted' });
    }
    expect(await requests.sendEvent(null, 'swarm', 'message', {})).toEqual({ ok: false, reason: 'navigated' });

    // A document that has gone gets nothing, nor does its replacement.
    page.guest.commit(`${DAPP}next`, { newFrame: false });
    expect(await requests.sendEvent(target, 'swarm', 'message', {})).toEqual({ ok: false, reason: 'navigated' });
    expect(page.guest.sent).toHaveLength(1);
  });

  test('a destroyed guest, or a frame that isn\'t the document\'s, gets nothing', async () => {
    const { tab, requests, documents, guests } = setup();
    const page = tab();
    const target = (await documents.attest(eventFrom(page.guest), page.nonce)).requester;
    guests.delete(page.guest.id);
    expect(await requests.sendEvent(target, 'ethereum', 'chainChanged', '0x1')).toEqual({ ok: false, reason: 'navigated' });
    guests.set(page.guest.id, page.guest);
    page.guest.mainFrame.frameTreeNodeId += 1;
    expect(await requests.sendEvent(target, 'ethereum', 'chainChanged', '0x1')).toEqual({ ok: false, reason: 'navigated' });
    page.guest.mainFrame.frameTreeNodeId -= 1;
    page.guest.mainFrame.send.mockImplementationOnce(() => {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed');
    });
    expect(await requests.sendEvent(target, 'ethereum', 'chainChanged', '0x1')).toEqual({ ok: false, reason: 'navigated' });
    page.guest.destroy();
    expect(await requests.sendEvent(target, 'ethereum', 'chainChanged', '0x1')).toEqual({ ok: false, reason: 'navigated' });
    expect(page.guest.sent).toEqual([]);
  });

  test('until names are checked again before an event, a name-revalidated one never goes to a name-keyed document', async () => {
    const env = setup({ resolveEnsContent: async () => ({ type: 'ok', protocol: 'ipns', decoded: IPNS_B58 }) });
    const guest = new Guest();
    env.guests.set(guest.id, guest);
    env.requests.track(guest);
    env.documents.bindName({ guest: guest.id, name: 'example.com', key: IPNS_KEY });
    guest.commit(`ipns://${IPNS_KEY}/`);
    const page = env.greet(guest);
    const target = (await env.documents.attest(eventFrom(guest), page.nonce)).requester;
    expect(target.key).toBe('example.com');
    for (const [provider, event] of [
      ['ethereum', 'accountsChanged'],
      ['swarm', 'message'],
      ['radicle', 'seedStatus'],
    ]) {
      expect(await env.requests.sendEvent(target, provider, event, {})).toEqual({ ok: false, reason: 'name-unchecked' });
    }
    expect(await env.requests.sendEvent(target, 'ethereum', 'chainChanged', '0x64')).toEqual({ ok: true });
    expect(guest.sent.map((entry) => entry.message.event)).toEqual(['chainChanged']);
  });

  test.each([
    ['same-process', false],
    ['cross-process', true],
  ])('an event held after main\'s check reaches a %s replacement with the old nonce, which its preload drops', async (_name, newFrame) => {
    const { tab, requests, documents, hooks, greet } = setup();
    const page = tab();
    const target = (await documents.attest(eventFrom(page.guest), page.nonce)).requester;
    let release;
    hooks.beforeEventSend = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const sending = requests.sendEvent(target, 'swarm', 'message', { n: 1 });
    // Main has checked the document; the frame now commits a document of the
    // same key (a reload).
    page.guest.commit(DAPP, { newFrame });
    const next = greet(page.guest);
    release();
    expect(await sending).toEqual({ ok: true });
    const [delivered] = page.guest.sent;
    expect(delivered.frame).toBe(page.guest.mainFrame);
    // The old document's nonce, not the new one's: the new document's preload
    // drops it (webview-preload.test.js, test-e2e/page-requests.spec.js).
    expect(delivered.message.nonce).toBe(page.nonce);
    expect(delivered.message.nonce).not.toBe(next.nonce);
  });
});

describe('answers', () => {
  test('a dispatcher\'s answer or failure as the page gets it', async () => {
    const outcomes = [
      [async () => ({ result: 5 }), { result: 5 }],
      [async () => undefined, { result: undefined }],
      [async () => ({ error: { code: 4001, message: 'User rejected the request', data: { why: 1 } } }), { error: { code: 4001, message: 'User rejected the request', data: { why: 1 } } }],
      [async () => ({ error: { message: '' } }), { error: { code: -32603, message: 'Internal error' } }],
      [async () => ({ error: { code: 1.5, message: 7 } }), { error: { code: -32603, message: 'Internal error' } }],
      [async () => { throw new Error('boom'); }, { error: { code: -32603, message: 'boom' } }],
      [async () => { throw { code: 4100, message: 'Origin not authorized' }; }, { error: { code: 4100, message: 'Origin not authorized' } }],
      [() => { throw null; }, { error: { code: -32603, message: 'Internal error' } }],
    ];
    for (const [dispatch, expected] of outcomes) {
      const { tab } = setup({ dispatch });
      expect(await tab().ask('swarm_readChunk')).toEqual(expected);
    }
  });
});

describe('register', () => {
  test('page:hello is a listener and page:request a handler, end to end', async () => {
    const dispatch = jest.fn(async (context) => ({ result: context.requester.key }));
    const { requests, guests } = setup({ dispatch });
    const on = new Map();
    const handle = new Map();
    requests.register({ on: (channel, fn) => on.set(channel, fn), handle: (channel, fn) => handle.set(channel, fn) });
    expect([...on.keys()]).toEqual(['page:hello', 'page:bind-name']);
    expect([...handle.keys()]).toEqual(['page:reserve', 'page:request']);

    const guest = new Guest();
    guests.set(guest.id, guest);
    requests.track(guest);
    guest.commit(DAPP);
    const n = nonce();
    on.get('page:hello')(eventFrom(guest), { nonce: n });
    expect(await handle.get('page:request')(eventFrom(guest), { nonce: n, provider: 'radicle', method: 'radicle_getCapabilities' })).toEqual({
      result: DAPP_KEY,
    });
  });
});

// PRQ-2b: the size walk, the charge, the byte budgets, and tickets.
const MiB = 1024 * 1024;
const LIMIT = { error: { code: -32005, message: 'Limit exceeded' } };

/** The request `page` sends for `method` with `params`, measured as main measures it. */
const measure = (page, provider, method, params) =>
  measurePageRequest({ nonce: page.nonce, provider, method, params }, pageRequestMaxBytes(provider, method));

/** A params object `{ data }` whose request measures exactly `size` bytes. */
function paramsOfSize(page, provider, method, size, make = (n) => 'x'.repeat(n)) {
  const base = measure(page, provider, method, { data: '' }).size;
  const params = { data: make(size - base) };
  expect(measure(page, provider, method, params).size).toBe(size);
  return params;
}

describe('the size per request', () => {
  test('a request of exactly its method\'s size passes; one byte more is refused before main records it', async () => {
    const dispatch = jest.fn(async () => ({ result: 'ok' }));
    const { tab, trace } = setup({ dispatch });
    const page = tab();
    for (const make of [(n) => 'x'.repeat(n), (n) => new Uint8Array(n), (n) => '\u0001'.repeat(n)]) {
      const exact = paramsOfSize(page, 'swarm', 'swarm_readChunk', MiB, make);
      expect(await page.ask('swarm_readChunk', exact)).toEqual({ result: 'ok' });
      const over = paramsOfSize(page, 'swarm', 'swarm_readChunk', MiB + 1, make);
      expect(await page.ask('swarm_readChunk', over)).toEqual(LIMIT);
    }
    // An Ethereum request, whose params are an array.
    const base = measure(page, 'ethereum', 'eth_call', ['']).size;
    expect(await page.ask('eth_call', ['x'.repeat(MiB - base)])).toEqual({ result: 'ok' });
    expect(await page.ask('eth_call', ['x'.repeat(MiB - base + 1)])).toEqual(LIMIT);
    // The uploads' own error past their size, as today.
    const data = await page.ask('swarm_publishData', paramsOfSize(page, 'swarm', 'swarm_publishData', 10 * MiB + 64 * 1024 + 1));
    expect(data.error).toEqual({
      code: -32602,
      message: 'Payload exceeds maximum size of 10485760 bytes',
      data: { reason: 'payload_too_large', limit: 10 * MiB, actual: 10 * MiB + 64 * 1024 + 1 },
    });
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(recorded(trace)).toHaveLength(4);
  });

  test('a request the walk refuses, sent past the preload, is refused before main records it', async () => {
    const dispatch = jest.fn(async () => ({ result: 'ran' }));
    const { tab, trace } = setup({ dispatch });
    const page = tab();
    let deep = 0;
    for (let i = 0; i < 40; i += 1) deep = [deep];
    const cases = [
      [{ value: 1n << 256n }, { code: -32602, message: 'Invalid parameters' }],
      [{ value: -(1n << 4_000_000n) }, { code: -32602, message: 'Invalid parameters' }],
      [{ value: new Map() }, { code: -32602, message: 'Invalid parameters' }],
      [{ value: new Date() }, { code: -32602, message: 'Invalid parameters' }],
      [{ value: new Int8Array(4) }, { code: -32602, message: 'Invalid parameters' }],
      [{ value: new Array(10_000).fill(0) }, { code: -32005, message: 'Limit exceeded' }],
      [{ value: new Array(1e9) }, { code: -32005, message: 'Limit exceeded' }],
      [{ value: deep }, { code: -32005, message: 'Limit exceeded' }],
    ];
    for (const [params, error] of cases) expect(await page.ask('swarm_readChunk', params)).toEqual({ error });
    // A BigInt of 256 bits passes, as 32 bytes.
    expect(await page.ask('swarm_readChunk', { value: (1n << 256n) - 1n })).toEqual({ result: 'ran' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(recorded(trace)).toHaveLength(1);
    expect(trace.filter((e) => e.kind === 'refused').map((e) => e.reason)).toEqual([
      'bigint', 'bigint', 'type', 'type', 'type', 'values', 'values', 'depth',
    ]);
  });

  test('a key a request doesn\'t have, a request over 1 MiB with no ticket, or a ticket main doesn\'t hold: refused', async () => {
    const dispatch = jest.fn(async () => ({ result: 'ran' }));
    const { tab, trace } = setup({ dispatch });
    const page = tab();
    expect(await page.send({ provider: 'swarm', method: 'swarm_readChunk', params: {}, extra: 'x'.repeat(10) })).toEqual({
      error: { code: -32602, message: 'Invalid parameters' },
    });
    const big = paramsOfSize(page, 'swarm', 'swarm_publishData', 2 * MiB);
    expect(await page.ask('swarm_publishData', big)).toEqual(LIMIT);
    for (const ticket of ['f'.repeat(64), 7, null, { ticket: 'x' }]) {
      expect(await page.send({ provider: 'swarm', method: 'swarm_readChunk', params: {}, ticket })).toEqual(LIMIT);
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(recorded(trace)).toEqual([]);
  });
});

describe('the charge', () => {
  test('in place before the dispatcher runs, at every copy it reports, and gone once the request is', async () => {
    const held = heldDispatcher();
    const { tab, requests, copies } = setup({ dispatch: held.dispatch });
    const page = tab();
    const params = { data: String.fromCharCode(0x100) + String.fromCharCode(1).repeat(1000) };
    const answer = page.ask('swarm_sendPss', params);
    await flush();
    const expected = chargeOf('swarm', 'swarm_sendPss', measure(page, 'swarm', 'swarm_sendPss', params));
    const key = `${page.guest.id}:${held.calls[0].context.requester.navigation}`;
    expect(requests.stats().documents[key]).toEqual({ requests: 1, bytes: expected });
    expect(requests.stats().windows[1]).toEqual({ requests: 1, bytes: expected });
    expect(requests.stats().browser).toEqual({ requests: 1, bytes: expected });
    const { context } = held.calls[0];
    expect(context.copied('json')).toBe(true);
    expect(context.copied('body')).toBe(true);
    held.calls[0].resolve({ result: 'sent' });
    expect(await answer).toEqual({ result: 'sent' });
    expect(context.copied('late')).toBe(false);
    expect(copies).toEqual([
      { id: context.id, label: 'json', charged: expected, charge: expected, inPlace: true },
      { id: context.id, label: 'body', charged: expected, charge: expected, inPlace: true },
      { id: context.id, label: 'late', charged: 0, charge: expected, inPlace: false },
    ]);
    expect(requests.stats().browser).toEqual({ requests: 0, bytes: 0 });
  });

  test('documents in two windows fill the window\'s and then the browser\'s budget; admission resumes as they finish', async () => {
    const held = heldDispatcher();
    const { tab, requests } = setup({ dispatch: held.dispatch });
    const docs = [tab({ window: 1 }), tab({ window: 1 }), tab({ window: 1 }), tab({ window: 2 }), tab({ window: 2 })];
    const params = paramsOfSize(docs[0], 'swarm', 'swarm_sendPss', MiB);
    const charge = chargeOf('swarm', 'swarm_sendPss', measure(docs[0], 'swarm', 'swarm_sendPss', params));
    const perDocument = Math.floor(BUDGETS.document.bytes / charge);
    const perWindow = Math.floor(BUDGETS.window.bytes / charge);
    const perBrowser = Math.floor(BUDGETS.browser.bytes / charge);
    expect([perDocument, perWindow, perBrowser]).toEqual([5, 10, 15]);
    const fill = async (page) => {
      const outcomes = [];
      for (let i = 0; i < 8; i += 1) {
        outcomes.push(Promise.race([page.ask('swarm_sendPss', params), flush().then(() => 'running')]));
      }
      return (await Promise.all(outcomes)).filter((o) => o === 'running').length;
    };
    // Each document within its own bound; the window's fills at two of them.
    expect(await fill(docs[0])).toBe(perDocument);
    expect(await fill(docs[1])).toBe(perDocument);
    expect(await fill(docs[2])).toBe(0);
    expect(requests.stats().windows[1].bytes).toBe(perWindow * charge);
    // The other window fills the browser's.
    expect(await fill(docs[3])).toBe(perDocument);
    expect(await fill(docs[4])).toBe(0);
    expect(requests.stats().browser).toEqual({ requests: perBrowser, bytes: perBrowser * charge });
    expect(held.calls).toHaveLength(perBrowser);
    // One finishes in window 2: room for one there, and none in window 1.
    held.calls[2 * perDocument].resolve({ result: 'done' });
    await flush();
    expect(await fill(docs[2])).toBe(0);
    expect(await fill(docs[4])).toBe(1);
    expect(held.calls).toHaveLength(perBrowser + 1);
  });

  test('1,024 requests of 10,000 near-empty values each, across documents and windows: admitted only while they fit', async () => {
    const held = heldDispatcher();
    const { tab, requests } = setup({ dispatch: held.dispatch });
    const pages = [];
    for (let window = 1; window <= 4; window += 1) {
      for (let i = 0; i < 4; i += 1) pages.push(tab({ window }));
    }
    // The request object, its nonce, provider and method, its params object,
    // and 9,995 near-empty values with a name each: 10,000 values.
    const params = {};
    for (let i = 0; i < 9995; i += 1) params[`k${i}`] = '';
    const measured = measure(pages[0], 'swarm', 'swarm_readChunk', params);
    expect(measured.values).toBe(10000);
    const charge = chargeOf('swarm', 'swarm_readChunk', measured);
    expect(charge).toBeGreaterThan(2.4 * MiB);

    let admitted = 0;
    for (let n = 0; n < 1024; n += 1) {
      const page = pages[n % pages.length];
      const before = requests.stats();
      const doc = Object.entries(before.documents).find(([k]) => k.startsWith(`${page.guest.id}:`))?.[1] || { requests: 0, bytes: 0 };
      const win = before.windows[page.guest.window] || { requests: 0, bytes: 0 };
      const fits =
        doc.requests < 64 && doc.bytes + charge <= BUDGETS.document.bytes &&
        win.requests < 256 && win.bytes + charge <= BUDGETS.window.bytes &&
        before.browser.requests < 1024 && before.browser.bytes + charge <= BUDGETS.browser.bytes;
      const outcome = await Promise.race([page.ask('swarm_readChunk', params), flush().then(() => 'running')]);
      expect({ n, admitted: outcome === 'running' }).toEqual({ n, admitted: fits });
      if (outcome === 'running') admitted += 1;
      else expect(outcome).toEqual(LIMIT);
    }
    expect(admitted).toBe(Math.floor(BUDGETS.browser.bytes / charge));
    expect(held.calls).toHaveLength(admitted);
    expect(requests.stats().browser.bytes).toBeLessThanOrEqual(BUDGETS.browser.bytes);
  });
});

describe('reservations and tickets', () => {
  const TICKET = /^[0-9a-f]{64}$/;

  /** A tab with a large request ready: its params and its exact size. */
  function large(env, { window = 1, method = 'swarm_publishData', size = 2 * MiB } = {}) {
    const page = env.tab({ window });
    const params = paramsOfSize(page, 'swarm', method, size);
    return { ...page, params, size, method, upload: (ticket, extra = {}) => page.send({ provider: 'swarm', method, params, ticket, ...extra }) };
  }

  test('a reservation is refused as a request is, and for a method or size that needs none', async () => {
    const env = setup({ dispatch: jest.fn(async () => ({ result: 'ok' })) });
    const { tab, requests, privateContents, guests } = env;
    const refused = (reason) => ({ error: { code: 4100, message: 'Unauthorized', data: { reason } } });
    const page = tab();
    const reserve = (event, fields) => requests.reserve(event, { method: 'swarm_publishData', bytes: 2 * MiB, ...fields });
    expect(await reserve(eventFrom(page.guest), { nonce: nonce() })).toEqual(refused('wrong-nonce'));
    expect(await reserve(eventFrom(page.guest, null), { nonce: page.nonce })).toEqual(refused('detached'));
    expect(await reserve(eventFrom(page.guest, { ...page.guest.mainFrame, detached: true }), { nonce: page.nonce })).toEqual(refused('detached'));
    expect(await reserve(eventFrom(page.guest, { url: DAPP, frameTreeNodeId: 3, detached: false }), { nonce: page.nonce })).toEqual(refused('sub-frame'));
    const quiet = new Guest();
    guests.set(quiet.id, quiet);
    requests.track(quiet);
    quiet.commit(DAPP);
    expect(await reserve(eventFrom(quiet), { nonce: nonce() })).toEqual(refused('no-hello'));
    const secret = tab();
    privateContents.add(secret.guest);
    expect(await secret.reserve('swarm_publishData', 2 * MiB)).toEqual(refused('private'));
    const preview = new Guest();
    guests.set(preview.id, preview);
    requests.track(preview);
    preview.commit(`freedom-preview://${'c'.repeat(40)}/`);
    expect(await reserve(eventFrom(preview), { nonce: nonce() })).toEqual(refused('preview'));
    // The frame's URL off the document's transport key.
    const moved = tab();
    moved.guest.mainFrame.url = `bzz://${'e'.repeat(64)}/`;
    expect(await moved.reserve('swarm_publishData', 2 * MiB)).toEqual(refused('off-key'));

    const INVALID = { error: { code: -32602, message: 'Invalid parameters' } };
    for (const [method, bytes] of [
      ['swarm_readChunk', 2 * MiB],
      ['eth_call', 2 * MiB],
      ['__proto__', 2 * MiB],
      ['swarm_publishData', MiB],
      ['swarm_publishData', 10 * MiB + 64 * 1024 + 1],
      ['swarm_publishFiles', 50 * MiB + 64 * 1024 + 1],
      ['swarm_publishData', 2.5 * MiB + 0.5],
      ['swarm_publishData', '3000000'],
    ]) {
      expect(await page.reserve(method, bytes)).toEqual(INVALID);
    }
    expect(await page.reserve('swarm_publishData', 2 * MiB, { extra: 1 })).toEqual(INVALID);
    expect(await requests.reserve(eventFrom(page.guest), null)).toEqual(INVALID);
    expect(requests.stats()).toEqual(expect.objectContaining({ turns: 0, waiting: 0, tickets: 0, browser: { requests: 0, bytes: 0 } }));
  });

  test('two turns at a time; one reservation per document; sixteen waiting in the browser', async () => {
    const env = setup({ dispatch: jest.fn(async () => ({ result: 'ok' })) });
    const a = large(env);
    const b = large(env);
    expect((await a.reserve(a.method, a.size)).ticket).toMatch(TICKET);
    const second = await b.reserve(b.method, b.size);
    expect(second.ticket).toMatch(TICKET);
    // A document's second reservation, while it holds a ticket.
    expect(await a.reserve(a.method, a.size)).toEqual(LIMIT);
    const waiting = [];
    for (let i = 0; i < 16; i += 1) {
      const page = large(env);
      waiting.push({ page, answer: page.reserve(page.method, page.size) });
    }
    await flush();
    expect(env.requests.stats()).toEqual(expect.objectContaining({ turns: 2, waiting: 16, tickets: 2 }));
    // A document's second reservation while it waits, and a seventeenth.
    expect(await waiting[0].page.reserve(a.method, a.size)).toEqual(LIMIT);
    const late = large(env);
    expect(await late.reserve(late.method, late.size)).toEqual(LIMIT);
    // While they wait, each counts as one of its document's requests.
    expect(env.requests.stats().browser.requests).toBe(18);
  });

  test('a ticket presented is spent: the request takes its charge and turn, and the next waits for the turn', async () => {
    const held = heldDispatcher();
    const env = setup({ dispatch: held.dispatch });
    const a = large(env);
    const b = large(env);
    const c = large(env);
    const { ticket } = await a.reserve(a.method, a.size);
    await b.reserve(b.method, b.size);
    let cTicket = null;
    c.reserve(c.method, c.size).then((answer) => {
      cTicket = answer.ticket;
    });
    const largest = largestChargeOf('swarm', a.method, a.size);
    const key = (page) => Object.keys(env.requests.stats().documents).find((k) => k.startsWith(`${page.guest.id}:`));
    expect(env.requests.stats().documents[key(a)]).toEqual({ requests: 1, bytes: largest });
    const answer = a.upload(ticket);
    await flush();
    expect(held.calls).toHaveLength(1);
    // The ticket's charge moved to the request, with no gap; the turn stays.
    expect(env.requests.stats().documents[key(a)]).toEqual({ requests: 1, bytes: largest });
    expect(env.requests.stats()).toEqual(expect.objectContaining({ turns: 2, waiting: 1, tickets: 1 }));
    expect(cTicket).toBeNull();
    held.calls[0].resolve({ result: 'ref' });
    expect(await answer).toEqual({ result: 'ref' });
    await flush();
    expect(cTicket).toMatch(TICKET);
    expect(env.requests.stats().documents[key(a)]).toBeUndefined();
    // Presented again: it is gone.
    expect(await a.upload(ticket)).toEqual(LIMIT);
    expect(held.calls).toHaveLength(1);
  });

  test('a ticket presented by another guest, for another method, or with more bytes: refused, burnt, its charge and turn freed', async () => {
    const held = heldDispatcher();
    const env = setup({ dispatch: held.dispatch });
    const owner = large(env, { size: 3 * MiB });
    const other = large(env, { size: 3 * MiB });
    const files = large(env, { method: 'swarm_publishFiles', size: 3 * MiB });
    const tickets = [];
    for (let i = 0; i < 3; i += 1) {
      // Each case's ticket, granted fresh.
      const { ticket } = await owner.reserve(owner.method, 3 * MiB - 10);
      tickets.push(ticket);
      const misuse = [
        () => other.upload(ticket),
        () => owner.send({ provider: 'swarm', method: 'swarm_publishFiles', params: files.params, ticket }),
        () => owner.upload(ticket),
      ][i];
      expect(await misuse()).toEqual(LIMIT);
      expect(env.requests.stats()).toEqual(expect.objectContaining({ turns: 0, tickets: 0, browser: { requests: 0, bytes: 0 } }));
      // Burnt: not even its owner can use it now.
      expect(await owner.send({ provider: 'swarm', method: 'swarm_readChunk', params: {}, ticket })).toEqual(LIMIT);
    }
    expect(new Set(tickets).size).toBe(3);
    expect(held.calls).toHaveLength(0);
  });

  test('a waiting reservation goes with its document, and its turn to the next', async () => {
    const env = setup({ dispatch: jest.fn(async () => ({ result: 'ok' })) });
    const { timers } = env;
    const a = large(env);
    const b = large(env);
    await a.reserve(a.method, a.size);
    await b.reserve(b.method, b.size);
    const pending = [];
    const waiters = [large(env), large(env), large(env, { window: 2 }), large(env)];
    for (const page of waiters) {
      const entry = { page, answer: null };
      page.reserve(page.method, page.size).then((answer) => {
        entry.answer = answer;
      });
      pending.push(entry);
    }
    await flush();
    // Navigated, destroyed, and its window closed (which destroys its guests).
    waiters[0].guest.commit(`${DAPP}elsewhere`);
    waiters[1].guest.destroy();
    waiters[2].guest.destroy();
    await flush();
    expect(pending.slice(0, 3).map((entry) => entry.answer)).toEqual([GONE, GONE, GONE]);
    expect(env.requests.stats()).toEqual(expect.objectContaining({ waiting: 1, turns: 2 }));
    // A's and B's tickets go unused for 30 s: a turn goes to the one still
    // waiting.
    timers.fire(30_000);
    await flush();
    expect(pending[3].answer.ticket).toMatch(TICKET);
    expect(env.requests.stats()).toEqual(expect.objectContaining({ waiting: 0, turns: 1, tickets: 1 }));
  });

  test('a granted ticket is released when its document navigates, its guest goes, or it lies unused for 30 s', async () => {
    const dispatch = jest.fn(async () => ({ result: 'ok' }));
    for (const end of ['navigate', 'destroy', 'unused']) {
      const env = setup({ dispatch });
      const a = large(env);
      const b = large(env);
      const c = large(env);
      const { ticket } = await a.reserve(a.method, a.size);
      await b.reserve(b.method, b.size);
      let next = null;
      c.reserve(c.method, c.size).then((answer) => {
        next = answer;
      });
      if (end === 'navigate') a.guest.commit(`${DAPP}next`, { newFrame: false });
      if (end === 'destroy') a.guest.destroy();
      if (end === 'unused') {
        env.timers.fire(30_000 - 1);
        await flush();
        expect(next).toBeNull();
        env.timers.fire(30_000);
      }
      await flush();
      expect(next.ticket).toMatch(TICKET);
      if (end !== 'destroy') {
        // The document that held it, or the one that replaced it, can't use it.
        const page = end === 'navigate' ? env.greet(a.guest) : a;
        expect(await page.send({ provider: 'swarm', method: a.method, params: a.params, ticket })).toEqual(LIMIT);
      }
      expect(dispatch).not.toHaveBeenCalled();
    }
  });

  test('a ticket presented twice: the second is refused, after a first that was served and after one that was refused', async () => {
    const dispatch = jest.fn(async () => ({ result: 'ok' }));
    const env = setup({ dispatch });
    const page = large(env);
    const served = (await page.reserve(page.method, page.size)).ticket;
    expect(await page.upload(served)).toEqual({ result: 'ok' });
    expect(await page.upload(served)).toEqual(LIMIT);
    const refusedFirst = (await page.reserve(page.method, page.size - 1)).ticket;
    expect(await page.upload(refusedFirst)).toEqual(LIMIT);
    expect(await page.upload(refusedFirst)).toEqual(LIMIT);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test('an entry that doesn\'t fit keeps its place while a later one that fits is granted', async () => {
    const held = heldDispatcher();
    const env = setup({ dispatch: held.dispatch });
    const crowded = large(env, { method: 'swarm_publishFiles', size: 40 * MiB });
    // Five requests of 1 MiB fill most of the document's 128 MiB.
    const params = paramsOfSize(crowded, 'swarm', 'swarm_sendPss', MiB);
    for (let i = 0; i < 5; i += 1) crowded.ask('swarm_sendPss', params);
    await flush();
    expect(held.calls).toHaveLength(5);
    let crowdedTicket = null;
    crowded.reserve(crowded.method, crowded.size).then((answer) => {
      crowdedTicket = answer.ticket;
    });
    const later = large(env);
    expect((await later.reserve(later.method, later.size)).ticket).toMatch(TICKET);
    await flush();
    expect(crowdedTicket).toBeNull();
    for (const call of held.calls) call.resolve({ result: 'sent' });
    await flush();
    expect(crowdedTicket).toMatch(TICKET);
  });

  test('a waiting entry whose document no longer holds when its turn comes is dropped as navigated', async () => {
    const env = setup({ dispatch: jest.fn(async () => ({ result: 'ok' })) });
    const a = large(env);
    const b = large(env);
    const c = large(env);
    const d = large(env);
    const first = (await a.reserve(a.method, a.size)).ticket;
    await b.reserve(b.method, b.size);
    const answers = {};
    c.reserve(c.method, c.size).then((answer) => {
      answers.c = answer;
    });
    d.reserve(d.method, d.size).then((answer) => {
      answers.d = answer;
    });
    await flush();
    // C's frame shows another key (no commit main saw).
    c.guest.mainFrame.url = `bzz://${'e'.repeat(64)}/`;
    expect(await a.upload(first)).toEqual({ result: 'ok' });
    await flush();
    expect(answers.c).toEqual({ error: { code: 4100, message: 'Unauthorized', data: { reason: 'navigated' } } });
    expect(answers.d.ticket).toMatch(TICKET);
  });
});
