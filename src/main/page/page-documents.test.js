const { EventEmitter } = require('events');
const { createPageDocuments, transportKeyOf, chainOfKey } = require('./page-documents');
const { ipnsMhToCidV1Base36 } = require('../../shared/cid-utils');

const CHROME_URL = 'file:///app/src/renderer/index.html';
const HASH = 'a'.repeat(64);
const DAPP = `bzz://${HASH}/`;
const IPNS_B58 = '12D3KooWD3eckifWpRn9wQpMG9R9hX3sD158z7EqHWmweQAJU5SA';
const IPNS_KEY = ipnsMhToCidV1Base36(IPNS_B58);
const OTHER_IPNS_KEY = ipnsMhToCidV1Base36('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
const ADDRESS = '0x' + 'ab'.repeat(20);

let nextId = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
let nextRoutingId = 1;

function frame(url, frameTreeNodeId, processId = 1) {
  return { url, frameTreeNodeId, processId, routingId: nextRoutingId++, detached: false };
}

// Let settled promises run their callbacks.
const flush = () => new Promise((resolve) => setImmediate(resolve));

const chromeHost = () => ({
  isDestroyed: () => false,
  mainFrame: { url: CHROME_URL },
});

/** A tab guest: a webview webContents hosted by a chrome window. */
class Guest extends EventEmitter {
  constructor({ host = chromeHost(), type = 'webview' } = {}) {
    super();
    this.id = nextId++;
    this.type = type;
    this.hostWebContents = host;
    this.destroyed = false;
    this.mainFrame = frame('about:blank', 1000 + this.id);
  }

  isDestroyed() {
    return this.destroyed;
  }

  getType() {
    return this.type;
  }

  getURL() {
    return this.mainFrame.url;
  }

  /**
   * Commit a main-frame document. `newFrame` stands for a new
   * RenderFrameHost (a cross-process navigation, or a same-process one under
   * RenderDocument): the old `WebFrameMain` is detached, and the main
   * frame's tree node id stays.
   */
  commit(url, { newFrame = true } = {}) {
    if (newFrame) {
      this.mainFrame.detached = true;
      this.mainFrame = frame(url, this.mainFrame.frameTreeNodeId);
    } else {
      this.mainFrame.url = url;
    }
    const { processId, routingId } = this.mainFrame;
    this.emit('did-frame-navigate', {}, url, 200, 'OK', true, processId, routingId);
  }

  /**
   * An error page replaces the document, in a frame of its own that shows
   * the failed URL: `did-fail-provisional-load`, no `did-frame-navigate`.
   */
  commitErrorPage(url, { code = -105, newFrame = true } = {}) {
    if (newFrame) {
      this.mainFrame.detached = true;
      this.mainFrame = frame(url, this.mainFrame.frameTreeNodeId, 2);
    } else {
      this.mainFrame.url = url;
    }
    const { processId, routingId } = this.mainFrame;
    this.emit('did-fail-provisional-load', {}, code, 'ERR_NAME_NOT_RESOLVED', url, true, processId, routingId);
  }

  /** A load that fails without replacing the document, which stays committed. */
  failLoad(url, { code, processId = -1, routingId = -1 }) {
    this.emit('did-fail-provisional-load', {}, code, 'ERR', url, true, processId, routingId);
  }

  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

const eventFrom = (guest, senderFrame = guest.mainFrame) => ({ sender: guest, senderFrame });

function setup({ resolveEnsContent = jest.fn(async () => ({ type: 'not_found' })) } = {}) {
  const privateContents = new Set();
  const agentContents = new Set();
  const documents = createPageDocuments({
    isPrivateWebContents: (contents) => privateContents.has(contents),
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: (contents) => agentContents.has(contents),
    windowIdOf: () => 7,
    resolveEnsContent,
  });
  return { documents, privateContents, agentContents, resolveEnsContent };
}

/** A tracked guest on `url` whose document has said hello. */
function open(documents, url = DAPP, guest = new Guest()) {
  documents.track(guest);
  guest.commit(url);
  const n = nonce();
  const greeted = documents.hello(eventFrom(guest), { nonce: n });
  expect(greeted).toEqual({ ok: true, navigation: expect.any(Number) });
  return { guest, nonce: n };
}

describe('transportKeyOf: the Keys table', () => {
  test.each([
    ['https://app.example/x', 'https://app.example'],
    ['http://app.example:8080/x?q#f', 'http://app.example:8080'],
    ['bzz://name.eth/x', 'name.eth'],
    ['ipfs://name.eth/x', 'name.eth'],
    ['ipns://name.eth/x', 'name.eth'],
    ['ipfs://name.box/x', 'name.box'],
    [`bzz://${HASH}/x`, `bzz://${HASH}`],
    [`bzz://${HASH}`, `bzz://${HASH}`],
    ['ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/x', 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'],
    [`ipns://${IPNS_KEY}/x`, `ipns://${IPNS_KEY}`],
    ['rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5/tree', 'rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5'],
    [`web3://${ADDRESS}.eip155-1/x`, `web3://${ADDRESS}`],
    [`web3://${ADDRESS.toUpperCase().replace('0X', '0x')}.eip155-100/x`, `web3://${ADDRESS}:100`],
    [`web3://${ADDRESS}:100/x`, `web3://${ADDRESS}:100`],
    ['blob:https://app.example/0c6f7e2a', 'https://app.example'],
  ])('%s keys to %s', (url, key) => {
    expect(transportKeyOf(url)).toBe(key);
  });

  test.each([
    ['a data: page', 'data:text/html,<p>hi'],
    ['a data: URL today keyed as a name', 'data:,x.eth'],
    ['about:blank', 'about:blank'],
    ['a view-source: page', 'view-source:https://app.example/'],
    ['a local file', 'file:///home/user/page.html'],
    ['an internal page', 'file:///app/src/renderer/pages/home.html'],
    [
      'the onchain gate, whatever its target',
      `file:///app/src/renderer/pages/onchain-unverified.html?target=${encodeURIComponent(`web3://${ADDRESS}.eip155-1/`)}`,
    ],
    ['an error page', 'chrome-error://chromewebdata/'],
    ['a preview', 'freedom-preview://abc/'],
    ['a blob: of a dweb page', `blob:bzz://${HASH}/0c6f7e2a`],
    ['a web3: name', 'web3://vitalik.eth/'],
    ['a web3: app on chain 0', `web3://${ADDRESS}.eip155-0/`],
    ['a dweb URL with no host', 'bzz:///x'],
    ['an ens: display URL', 'ens://name.eth/'],
    ['no URL', ''],
    ['not a URL', 'name.eth/x'],
  ])('%s gets no key', (_label, url) => {
    expect(transportKeyOf(url)).toBeNull();
  });

  test('an onchain app carries its chain', () => {
    expect(chainOfKey(`web3://${ADDRESS}`)).toBe(1);
    expect(chainOfKey(`web3://${ADDRESS}:100`)).toBe(100);
    expect(chainOfKey('https://app.example')).toBeNull();
    expect(chainOfKey(null)).toBeNull();
  });
});

describe('the record of an attested document', () => {
  test.each([
    ['https://app.example/x', 'https://app.example', null],
    ['bzz://name.eth/x', 'name.eth', null],
    [`ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/x`, 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', null],
    [`ipns://${IPNS_KEY}/x`, `ipns://${IPNS_KEY}`, null],
    ['rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5/tree', 'rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5', null],
    [`web3://${ADDRESS}.eip155-1/x`, `web3://${ADDRESS}`, 1],
    [`web3://${ADDRESS}.eip155-100/x`, `web3://${ADDRESS}:100`, 100],
    ['data:text/html,<p>hi', null, null],
    ['file:///app/src/renderer/pages/home.html', null, null],
  ])('%s: key %s, chain %s', async (url, key, chain) => {
    const { documents } = setup();
    const { guest, nonce: n } = open(documents, url);
    const result = await documents.attest(eventFrom(guest), n);
    expect(result).toEqual({
      ok: true,
      requester: {
        guest: guest.id,
        window: 7,
        frame: guest.mainFrame.frameTreeNodeId,
        navigation: expect.any(Number),
        nonce: n,
        url,
        transportKey: key,
        key,
        topKey: key,
        agent: false,
        chain,
      },
    });
    expect(Object.isFrozen(result.requester)).toBe(true);
  });
});

describe('the attested requester refuses', () => {
  test('not a tab: no sender, a destroyed guest, another webContents type, a host that is not a chrome window', async () => {
    const { documents } = setup();
    const { guest, nonce: n } = open(documents);
    expect(await documents.attest({ sender: null, senderFrame: null }, n)).toEqual({ ok: false, reason: 'not-a-tab' });
    expect(await documents.attest(undefined, n)).toEqual({ ok: false, reason: 'not-a-tab' });

    const notTabs = [
      // An automation page's hidden window, the PDF worker, the chrome itself.
      new Guest({ type: 'window' }),
      new Guest({ type: 'browserView' }),
      // A webview some other page hosts.
      new Guest({ host: { isDestroyed: () => false, mainFrame: { url: 'https://evil.example/' } } }),
      new Guest({ host: null }),
      new Guest({ host: { isDestroyed: () => true, mainFrame: { url: CHROME_URL } } }),
    ];
    for (const other of notTabs) {
      documents.track(other);
      other.commit(DAPP);
      expect(documents.hello(eventFrom(other), { nonce: nonce() })).toEqual({ ok: false, reason: 'not-a-tab' });
      expect(await documents.attest(eventFrom(other), nonce())).toEqual({ ok: false, reason: 'not-a-tab' });
    }

    guest.destroy();
    expect(await documents.attest(eventFrom(guest), n)).toEqual({ ok: false, reason: 'not-a-tab' });
  });

  test('private: a guest of a private window, whatever its preload did', async () => {
    const { documents, privateContents } = setup();
    const { guest, nonce: n } = open(documents);
    privateContents.add(guest);
    expect(await documents.attest(eventFrom(guest), n)).toEqual({ ok: false, reason: 'private' });
  });

  test('private: a check that throws counts as private', async () => {
    const guest = new Guest();
    const documents = createPageDocuments({
      isPrivateWebContents: () => {
        throw new Error('torn down');
      },
      isChromeIndexUrl: (url) => url === CHROME_URL,
      isAgentPage: () => false,
      windowIdOf: () => 7,
      resolveEnsContent: async () => null,
    });
    documents.track(guest);
    guest.commit(DAPP);
    expect(documents.hello(eventFrom(guest), { nonce: nonce() })).toEqual({ ok: false, reason: 'private' });
  });

  test('preview: a freedom-preview: commit', async () => {
    const { documents } = setup();
    const guest = new Guest();
    documents.track(guest);
    guest.commit('freedom-preview://workspace/index.html');
    expect(documents.hello(eventFrom(guest), { nonce: nonce() })).toEqual({ ok: false, reason: 'preview' });
    expect(await documents.attest(eventFrom(guest), nonce())).toEqual({ ok: false, reason: 'preview' });
  });

  test('sub-frame: a frame that is not the guest main frame', async () => {
    const { documents } = setup();
    const { guest, nonce: n } = open(documents);
    const iframe = frame(DAPP, 5000);
    expect(documents.hello(eventFrom(guest, iframe), { nonce: nonce() })).toEqual({ ok: false, reason: 'sub-frame' });
    expect(await documents.attest(eventFrom(guest, iframe), n)).toEqual({ ok: false, reason: 'sub-frame' });
  });

  test('detached: no sender frame, or one detached from the tree', async () => {
    const { documents } = setup();
    const { guest, nonce: n } = open(documents);
    expect(await documents.attest(eventFrom(guest, null), n)).toEqual({ ok: false, reason: 'detached' });
    const old = guest.mainFrame;
    guest.commit(`${DAPP}next`);
    expect(old.detached).toBe(true);
    expect(await documents.attest(eventFrom(guest, old), n)).toEqual({ ok: false, reason: 'detached' });
  });

  test('no document: an untracked guest, or one with no commit yet', async () => {
    const { documents } = setup();
    const untracked = new Guest();
    untracked.commit(DAPP);
    expect(documents.hello(eventFrom(untracked), { nonce: nonce() })).toEqual({ ok: false, reason: 'no-document' });
    const fresh = new Guest();
    documents.track(fresh);
    expect(documents.hello(eventFrom(fresh), { nonce: nonce() })).toEqual({ ok: false, reason: 'no-document' });
    expect(await documents.attest(eventFrom(fresh), nonce())).toEqual({ ok: false, reason: 'no-document' });
  });

  test('no hello: a request before the document bound its nonce', async () => {
    const { documents } = setup();
    const guest = new Guest();
    documents.track(guest);
    guest.commit(DAPP);
    expect(await documents.attest(eventFrom(guest), nonce())).toEqual({ ok: false, reason: 'no-hello' });
  });

  test('wrong nonce: one the document never had, or none', async () => {
    const { documents } = setup();
    const { guest } = open(documents);
    expect(await documents.attest(eventFrom(guest), nonce())).toEqual({ ok: false, reason: 'wrong-nonce' });
    expect(await documents.attest(eventFrom(guest), undefined)).toEqual({ ok: false, reason: 'wrong-nonce' });
    expect(await documents.attest(eventFrom(guest), { toString: () => 'x' })).toEqual({ ok: false, reason: 'wrong-nonce' });
  });

  test('navigated: the replaced document\'s nonce, across same-process and cross-process commits and reloads', async () => {
    const { documents } = setup();
    const { guest, nonce: first } = open(documents);
    // Same process, same RenderFrameHost: the frame object outlives the document.
    guest.commit(`${DAPP}two`, { newFrame: false });
    expect(await documents.attest(eventFrom(guest), first)).toEqual({ ok: false, reason: 'navigated' });
    const second = nonce();
    expect(documents.hello(eventFrom(guest), { nonce: second }).ok).toBe(true);
    // A reload.
    guest.commit(`${DAPP}two`, { newFrame: false });
    expect(await documents.attest(eventFrom(guest), second)).toEqual({ ok: false, reason: 'navigated' });
    expect(await documents.attest(eventFrom(guest), first)).toEqual({ ok: false, reason: 'navigated' });
    const third = nonce();
    expect(documents.hello(eventFrom(guest), { nonce: third }).ok).toBe(true);
    // Cross-process.
    guest.commit('https://other.example/');
    expect(await documents.attest(eventFrom(guest), third)).toEqual({ ok: false, reason: 'navigated' });
  });

  test('navigated: the latest eight replaced documents\' nonces; an older one is a wrong nonce', async () => {
    const { documents } = setup();
    const { guest, nonce: first } = open(documents);
    const ended = [first];
    for (let i = 1; i <= 8; i += 1) {
      guest.commit(`${DAPP}page-${i}`);
      const n = nonce();
      expect(documents.hello(eventFrom(guest), { nonce: n }).ok).toBe(true);
      ended.push(n);
    }
    guest.commit(`${DAPP}last`);
    expect(documents.hello(eventFrom(guest), { nonce: nonce() }).ok).toBe(true);
    // Nine documents have ended: the oldest has dropped out of the window.
    expect(ended).toHaveLength(9);
    expect(await documents.attest(eventFrom(guest), ended[0])).toEqual({ ok: false, reason: 'wrong-nonce' });
    for (const n of ended.slice(1)) {
      expect(await documents.attest(eventFrom(guest), n)).toEqual({ ok: false, reason: 'navigated' });
    }
  });

  test('off its transport key: a frame URL that keys elsewhere than the commit', async () => {
    const { documents } = setup();
    const { guest, nonce: n } = open(documents);
    guest.mainFrame.url = 'https://elsewhere.example/';
    expect(await documents.attest(eventFrom(guest), n)).toEqual({ ok: false, reason: 'off-key' });
    guest.mainFrame.url = `${DAPP}a/path?q#f`;
    expect((await documents.attest(eventFrom(guest), n)).ok).toBe(true);
  });

  test('a malformed hello gets the refusal of the first step before the nonce that fails', () => {
    const { documents, privateContents } = setup();
    const malformed = [undefined, {}, { nonce: 'ab' }, { nonce: 7 }];
    const expectHello = (event, reason) => {
      for (const payload of malformed) expect(documents.hello(event, payload)).toEqual({ ok: false, reason });
    };
    expectHello({ sender: null }, 'not-a-tab');
    const window = new Guest({ type: 'window' });
    documents.track(window);
    window.commit(DAPP);
    expectHello(eventFrom(window), 'not-a-tab');

    const fresh = new Guest();
    documents.track(fresh);
    expectHello(eventFrom(fresh), 'no-document');

    const { guest } = open(documents);
    expectHello(eventFrom(guest), 'already-bound');
    expectHello(eventFrom(guest, frame(DAPP, 5000)), 'sub-frame');
    expectHello(eventFrom(guest, null), 'detached');
    privateContents.add(guest);
    expectHello(eventFrom(guest), 'private');
    privateContents.delete(guest);

    const preview = new Guest();
    documents.track(preview);
    preview.commit('freedom-preview://workspace/');
    expectHello(eventFrom(preview), 'preview');

    guest.commit(`${DAPP}next`);
    expectHello(eventFrom(guest), 'bad-nonce');
  });

  test('in the design\'s order: the first step that fails names the refusal', async () => {
    const { documents, privateContents } = setup();
    const guest = new Guest();
    documents.track(guest);
    guest.commit('freedom-preview://workspace/');
    privateContents.add(guest);
    const iframe = frame(DAPP, 5000);
    expect(await documents.attest(eventFrom(guest, iframe), nonce())).toEqual({ ok: false, reason: 'private' });
    privateContents.delete(guest);
    expect(await documents.attest(eventFrom(guest, iframe), nonce())).toEqual({ ok: false, reason: 'preview' });
    guest.commit(DAPP);
    expect(await documents.attest(eventFrom(guest, iframe), nonce())).toEqual({ ok: false, reason: 'sub-frame' });
    expect(await documents.attest(eventFrom(guest), nonce())).toEqual({ ok: false, reason: 'no-hello' });
  });
});

describe('documents', () => {
  test('each main-frame commit takes the next number from one counter for the whole process', async () => {
    const { documents } = setup();
    const a = open(documents);
    const b = open(documents);
    const first = (await documents.attest(eventFrom(a.guest), a.nonce)).requester.navigation;
    const second = (await documents.attest(eventFrom(b.guest), b.nonce)).requester.navigation;
    expect(second).toBeGreaterThan(first);
    a.guest.commit(`${DAPP}next`);
    const n = nonce();
    expect(documents.hello(eventFrom(a.guest), { nonce: n })).toEqual({ ok: true, navigation: expect.any(Number) });
    const third = (await documents.attest(eventFrom(a.guest), n)).requester.navigation;
    expect(third).toBeGreaterThan(second);

    // A second instance shares the counter.
    const other = setup().documents;
    const c = open(other);
    expect((await other.attest(eventFrom(c.guest), c.nonce)).requester.navigation).toBeGreaterThan(third);
  });

  test('a sub-frame commit and a same-document navigation keep the document and its number', async () => {
    const { documents } = setup();
    const { guest, nonce: n } = open(documents);
    const before = (await documents.attest(eventFrom(guest), n)).requester;
    guest.emit('did-frame-navigate', {}, 'https://ads.example/', 200, 'OK', false, 2, 2);
    guest.mainFrame.url = `${DAPP}#/swap`;
    guest.emit('did-navigate-in-page', {}, `${DAPP}#/swap`, true, 1, 1);
    const after = await documents.attest(eventFrom(guest), n);
    expect(after.ok).toBe(true);
    expect(after.requester.navigation).toBe(before.navigation);
    expect(after.requester.url).toBe(DAPP);
  });

  test('the hello binds the first nonce for the current number and ignores every later one', async () => {
    const { documents } = setup();
    const { guest, nonce: n } = open(documents);
    expect(documents.hello(eventFrom(guest), { nonce: nonce() })).toEqual({ ok: false, reason: 'already-bound' });
    expect((await documents.attest(eventFrom(guest), n)).ok).toBe(true);
  });

  test('a malformed hello binds nothing', () => {
    const { documents } = setup();
    const guest = new Guest();
    documents.track(guest);
    guest.commit(DAPP);
    for (const payload of [undefined, {}, { nonce: 'ab' }, { nonce: 'A'.repeat(32) }, { nonce: 7 }, { nonce: 'g'.repeat(32) }]) {
      expect(documents.hello(eventFrom(guest), payload)).toEqual({ ok: false, reason: 'bad-nonce' });
    }
    expect(documents.hello(eventFrom(guest), { nonce: nonce() }).ok).toBe(true);
  });

  test('a hello sent by the old document after the commit binds nothing', () => {
    const { documents } = setup();
    const { guest } = open(documents);
    const old = guest.mainFrame;
    guest.commit('https://other.example/');
    expect(documents.hello(eventFrom(guest, old), { nonce: nonce() })).toEqual({ ok: false, reason: 'detached' });
    expect(documents.hello(eventFrom(guest), { nonce: nonce() }).ok).toBe(true);
  });

  test('a hello off the commit\'s transport key binds nothing', () => {
    const { documents } = setup();
    const guest = new Guest();
    documents.track(guest);
    guest.commit(DAPP);
    guest.mainFrame.url = 'https://elsewhere.example/';
    expect(documents.hello(eventFrom(guest), { nonce: nonce() })).toEqual({ ok: false, reason: 'off-key' });
  });

  test('an error page ends the document and starts none', async () => {
    const { documents } = setup();
    const { guest, nonce: n } = open(documents);
    guest.commitErrorPage(DAPP);
    expect(documents.hello(eventFrom(guest), { nonce: nonce() })).toEqual({ ok: false, reason: 'no-document' });
    expect(await documents.attest(eventFrom(guest), n)).toEqual({ ok: false, reason: 'no-document' });
    // A sub-frame's error page leaves the top document alone.
    const next = open(documents, DAPP, guest);
    guest.emit('did-fail-provisional-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://ads.example/', false, 2, 2);
    expect((await documents.attest(eventFrom(guest), next.nonce)).ok).toBe(true);
    // An error page in the same frame ends it too.
    guest.commitErrorPage(`${DAPP}gone`, { newFrame: false });
    expect(await documents.attest(eventFrom(guest), next.nonce)).toEqual({ ok: false, reason: 'no-document' });
  });

  test('a load that is cancelled, or fails without committing, keeps the document', async () => {
    const { documents } = setup();
    const { guest, nonce: n } = open(documents);
    const { processId, routingId } = guest.mainFrame;
    // ERR_ABORTED never installs an error page, even when the event names
    // the live main frame and the failed URL is the page's own (a reload).
    guest.failLoad(DAPP, { code: -3, processId, routingId });
    guest.failLoad('https://other.example/', { code: -3 });
    // A failure that committed no frame.
    guest.failLoad('https://other.example/', { code: -105 });
    // One that names the live main frame, which still shows its own URL.
    guest.failLoad('https://other.example/', { code: -105, processId, routingId });
    // One that names a frame that is not the main frame.
    guest.failLoad(DAPP, { code: -105, processId: 9, routingId: 9 });
    const result = await documents.attest(eventFrom(guest), n);
    expect(result.ok).toBe(true);
    expect(documents.isCurrent(result.requester)).toBe(true);
    expect(documents.hello(eventFrom(guest), { nonce: nonce() })).toEqual({ ok: false, reason: 'already-bound' });
  });

  test('isCurrent: until the document is replaced or its guest destroyed', async () => {
    const { documents } = setup();
    const { guest, nonce: n } = open(documents);
    const { requester } = await documents.attest(eventFrom(guest), n);
    expect(documents.isCurrent(requester)).toBe(true);
    guest.emit('did-navigate-in-page', {}, `${DAPP}#x`, true, 1, 1);
    expect(documents.isCurrent(requester)).toBe(true);
    guest.commit(`${DAPP}next`);
    expect(documents.isCurrent(requester)).toBe(false);

    const other = open(documents);
    const { requester: second } = await documents.attest(eventFrom(other.guest), other.nonce);
    other.guest.destroy();
    expect(documents.isCurrent(second)).toBe(false);
    expect(documents.isCurrent(null)).toBe(false);
  });

  test('a destroyed guest is forgotten', async () => {
    const { documents } = setup();
    const { guest } = open(documents);
    guest.destroy();
    expect(documents.bindName({ guest: guest.id, name: 'example.com', key: IPNS_KEY })).toBe(false);
  });

  test('track is idempotent', async () => {
    const { documents } = setup();
    const { guest, nonce: n } = open(documents);
    documents.track(guest);
    expect((await documents.attest(eventFrom(guest), n)).ok).toBe(true);
    expect(guest.listenerCount('did-frame-navigate')).toBe(1);
  });
});

describe('names over IPNS', () => {
  const answers = (decoded) => jest.fn(async () => ({ type: 'ok', protocol: 'ipns', decoded }));

  function bound({ resolveEnsContent, name = 'example.com', key = IPNS_KEY, url = `ipns://${key}/` } = {}) {
    const ctx = setup({ resolveEnsContent });
    const guest = new Guest();
    ctx.documents.track(guest);
    expect(ctx.documents.bindName({ guest: guest.id, name, key })).toBe(true);
    guest.commit(url);
    const n = nonce();
    expect(ctx.documents.hello(eventFrom(guest), { nonce: n }).ok).toBe(true);
    return { ...ctx, guest, nonce: n };
  }

  test('a verified name is the key; transportKey stays ipns://<key>', async () => {
    const { documents, guest, nonce: n, resolveEnsContent } = bound({ resolveEnsContent: answers(IPNS_B58) });
    const { requester } = await documents.attest(eventFrom(guest), n);
    expect(resolveEnsContent).toHaveBeenCalledWith('example.com');
    expect(requester).toMatchObject({ transportKey: `ipns://${IPNS_KEY}`, key: 'example.com', topKey: 'example.com' });
  });

  test('the resolver\'s base36 form is compared exactly too', async () => {
    const { documents, guest, nonce: n } = bound({ resolveEnsContent: answers(IPNS_KEY) });
    expect((await documents.attest(eventFrom(guest), n)).requester.key).toBe('example.com');
  });

  test('the name is lowercased, as a permission key is', async () => {
    const { documents, guest, nonce: n } = bound({ resolveEnsContent: answers(IPNS_B58), name: 'Example.COM' });
    expect((await documents.attest(eventFrom(guest), n)).requester.key).toBe('example.com');
  });

  test('step 6 compares the frame URL with transportKey, never with the name', async () => {
    const { documents, guest, nonce: n } = bound({ resolveEnsContent: answers(IPNS_B58) });
    guest.mainFrame.url = `ipns://${IPNS_KEY}/deep/link?x#y`;
    expect((await documents.attest(eventFrom(guest), n)).requester.key).toBe('example.com');
    // A frame URL that keys to the name itself is off the transport key.
    for (const url of ['ipns://example.com/', 'https://example.com/', `ipns://${OTHER_IPNS_KEY}/`]) {
      guest.mainFrame.url = url;
      expect(await documents.attest(eventFrom(guest), n)).toEqual({ ok: false, reason: 'off-key' });
    }
  });

  test('a name that answers another key leaves the document on ipns://<key> and ends the binding', async () => {
    const resolveEnsContent = answers('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
    const { documents, guest, nonce: n } = bound({ resolveEnsContent });
    expect((await documents.attest(eventFrom(guest), n)).requester).toMatchObject({
      transportKey: `ipns://${IPNS_KEY}`,
      key: `ipns://${IPNS_KEY}`,
      topKey: `ipns://${IPNS_KEY}`,
    });
    // A reload stays on the key, but the binding has ended: no new check.
    guest.commit(`ipns://${IPNS_KEY}/`);
    const reloaded = nonce();
    documents.hello(eventFrom(guest), { nonce: reloaded });
    expect((await documents.attest(eventFrom(guest), reloaded)).requester.key).toBe(`ipns://${IPNS_KEY}`);
    expect(resolveEnsContent).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['throws', async () => {
      throw new Error('offline');
    }],
    ['answers no record', async () => ({ type: 'not_found' })],
    ['answers IPFS content', async () => ({ type: 'ok', protocol: 'ipfs', decoded: IPNS_KEY })],
    ['answers a case-folded base58 key', async () => ({ type: 'ok', protocol: 'ipns', decoded: IPNS_B58.toLowerCase() })],
  ])('a resolver that %s binds nothing', async (_label, resolve) => {
    const { documents, guest, nonce: n } = bound({ resolveEnsContent: jest.fn(resolve) });
    expect((await documents.attest(eventFrom(guest), n)).requester.key).toBe(`ipns://${IPNS_KEY}`);
  });

  test('the binding applies only to a commit on exactly that key', async () => {
    const resolveEnsContent = answers(IPNS_B58);
    const { documents, guest, nonce: n } = bound({ resolveEnsContent, url: `ipns://${OTHER_IPNS_KEY}/` });
    expect((await documents.attest(eventFrom(guest), n)).requester.key).toBe(`ipns://${OTHER_IPNS_KEY}`);
    expect(resolveEnsContent).not.toHaveBeenCalled();
    // The held binding went with that commit.
    guest.commit(`ipns://${IPNS_KEY}/`);
    const next = nonce();
    documents.hello(eventFrom(guest), { nonce: next });
    expect((await documents.attest(eventFrom(guest), next)).requester.key).toBe(`ipns://${IPNS_KEY}`);
    expect(resolveEnsContent).not.toHaveBeenCalled();
  });

  test('the binding lasts while commits stay on the key, checked again for each document', async () => {
    const resolveEnsContent = answers(IPNS_B58);
    const { documents, guest } = bound({ resolveEnsContent });
    guest.commit(`ipns://${IPNS_KEY}/page-two`);
    const two = nonce();
    documents.hello(eventFrom(guest), { nonce: two });
    expect((await documents.attest(eventFrom(guest), two)).requester.key).toBe('example.com');
    expect(resolveEnsContent).toHaveBeenCalledTimes(2);

    guest.commit('https://elsewhere.example/');
    guest.commit(`ipns://${IPNS_KEY}/`);
    const back = nonce();
    documents.hello(eventFrom(guest), { nonce: back });
    expect((await documents.attest(eventFrom(guest), back)).requester.key).toBe(`ipns://${IPNS_KEY}`);
    expect(resolveEnsContent).toHaveBeenCalledTimes(2);
  });

  test('a held binding does not displace an active one the commit stays on', async () => {
    const { documents, guest } = bound({ resolveEnsContent: answers(IPNS_B58) });
    expect(documents.bindName({ guest: guest.id, name: 'other.example', key: OTHER_IPNS_KEY })).toBe(true);
    guest.commit(`ipns://${IPNS_KEY}/`);
    const n = nonce();
    documents.hello(eventFrom(guest), { nonce: n });
    expect((await documents.attest(eventFrom(guest), n)).requester.key).toBe('example.com');
  });

  test('a request waits for the check, then is checked again: a guest that navigated meanwhile is refused', async () => {
    const answers = [];
    const answer = (i) => answers[i]({ type: 'ok', protocol: 'ipns', decoded: IPNS_B58 });
    const resolveEnsContent = jest.fn(() => new Promise((resolve) => answers.push(resolve)));
    const { documents, guest, nonce: n } = bound({ resolveEnsContent });
    const pending = documents.attest(eventFrom(guest), n);
    guest.commit(`ipns://${IPNS_KEY}/two`, { newFrame: false });
    // The replaced document's request is refused at once, its check still running.
    expect(await pending).toEqual({ ok: false, reason: 'navigated' });

    // Under a new RenderFrameHost the old frame is gone first.
    const next = nonce();
    expect(documents.hello(eventFrom(guest), { nonce: next }).ok).toBe(true);
    const waiting = documents.attest(eventFrom(guest), next);
    guest.commit(`ipns://${IPNS_KEY}/three`);
    expect(await waiting).toEqual({ ok: false, reason: 'detached' });

    // The first check answers for a document that has gone; only the latest
    // document gets the next one.
    answer(0);
    await flush();
    expect(resolveEnsContent).toHaveBeenCalledTimes(2);
  });

  test('one check at a time: reloads while the name is slow keep one check running and the latest document waiting', async () => {
    const answers = [];
    const answer = (i, decoded = IPNS_B58) => answers[i]({ type: 'ok', protocol: 'ipns', decoded });
    const resolveEnsContent = jest.fn(() => new Promise((resolve) => answers.push(resolve)));
    const { documents, guest } = bound({ resolveEnsContent });
    const refused = [];
    let latest;
    for (let i = 0; i < 50; i += 1) {
      guest.commit(`ipns://${IPNS_KEY}/`);
      latest = nonce();
      expect(documents.hello(eventFrom(guest), { nonce: latest }).ok).toBe(true);
      refused.push(documents.attest(eventFrom(guest), latest));
    }
    const current = refused.pop();
    // Every replaced document's request was refused without waiting for a
    // name check: its frame was replaced with it.
    for (const result of await Promise.all(refused)) {
      expect(result).toEqual({ ok: false, reason: 'detached' });
    }
    expect(resolveEnsContent).toHaveBeenCalledTimes(1);

    // The running check answers for a document that has gone. The latest
    // document then gets a check of its own, started after its commit.
    answer(0);
    await flush();
    expect(resolveEnsContent).toHaveBeenCalledTimes(2);
    let settled = false;
    current.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    answer(1);
    expect((await current).requester).toMatchObject({ nonce: latest, key: 'example.com' });
    expect(resolveEnsContent).toHaveBeenCalledTimes(2);
  });

  test('a check that answers for a document that has gone decides nothing, not even the binding', async () => {
    const answers = [];
    const resolveEnsContent = jest.fn(() => new Promise((resolve) => answers.push(resolve)));
    const { documents, guest } = bound({ resolveEnsContent });
    guest.commit(`ipns://${IPNS_KEY}/two`);
    const two = nonce();
    documents.hello(eventFrom(guest), { nonce: two });
    const pending = documents.attest(eventFrom(guest), two);
    // The first document's name moved off the key, but that document is gone.
    answers[0]({ type: 'not_found' });
    await flush();
    answers[1]({ type: 'ok', protocol: 'ipns', decoded: IPNS_B58 });
    expect((await pending).requester.key).toBe('example.com');
    // The binding is still there for the next commit.
    guest.commit(`ipns://${IPNS_KEY}/three`);
    const three = nonce();
    documents.hello(eventFrom(guest), { nonce: three });
    const later = documents.attest(eventFrom(guest), three);
    await flush();
    answers[2]({ type: 'ok', protocol: 'ipns', decoded: IPNS_B58 });
    expect((await later).requester.key).toBe('example.com');
  });

  test('a document that ends while waiting for its check is dropped, and a destroyed guest starts none', async () => {
    const answers = [];
    const resolveEnsContent = jest.fn(() => new Promise((resolve) => answers.push(resolve)));
    const { documents, guest } = bound({ resolveEnsContent });
    guest.commit(`ipns://${IPNS_KEY}/two`);
    const two = nonce();
    documents.hello(eventFrom(guest), { nonce: two });
    const pending = documents.attest(eventFrom(guest), two);
    guest.commit('https://elsewhere.example/');
    expect(await pending).toEqual({ ok: false, reason: 'detached' });
    answers[0]({ type: 'ok', protocol: 'ipns', decoded: IPNS_B58 });
    await flush();
    expect(resolveEnsContent).toHaveBeenCalledTimes(1);

    const other = bound({ resolveEnsContent });
    other.guest.commit(`ipns://${IPNS_KEY}/two`);
    other.guest.destroy();
    answers[1]({ type: 'ok', protocol: 'ipns', decoded: IPNS_B58 });
    await flush();
    expect(resolveEnsContent).toHaveBeenCalledTimes(2);
  });

  test('a request waits for the check, and acts under the name once it answers', async () => {
    let answer;
    const resolveEnsContent = jest.fn(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const { documents, guest, nonce: n } = bound({ resolveEnsContent });
    const pending = documents.attest(eventFrom(guest), n);
    answer({ type: 'ok', protocol: 'ipns', decoded: IPNS_B58 });
    expect((await pending).requester.key).toBe('example.com');
  });

  test.each([
    ['an untracked guest', { guest: 999999, name: 'example.com', key: IPNS_KEY }],
    ['an ENS-host name, which loads under its own name', { name: 'name.eth', key: IPNS_KEY }],
    ['a URL for a name', { name: 'https://example.com', key: IPNS_KEY }],
    ['a single label', { name: 'localhost', key: IPNS_KEY }],
    ['a key with a path', { name: 'example.com', key: `${IPNS_KEY}/x` }],
    ['no key', { name: 'example.com' }],
    ['no name', { key: IPNS_KEY }],
  ])('bindName refuses %s', (_label, args) => {
    const { documents } = setup();
    const guest = new Guest();
    documents.track(guest);
    expect(documents.bindName({ guest: guest.id, ...args })).toBe(false);
  });
});

describe('the record\'s agent flag', () => {
  test('is read at the hello, for logs and tests', async () => {
    const { documents, agentContents } = setup();
    const guest = new Guest();
    agentContents.add(guest);
    const { nonce: n } = open(documents, DAPP, guest);
    expect((await documents.attest(eventFrom(guest), n)).requester.agent).toBe(true);
  });

  test('changes no decision: every outcome is the same in custody or out', async () => {
    async function outcomes(inCustody) {
      const { documents, agentContents, privateContents } = setup({
        resolveEnsContent: jest.fn(async () => ({ type: 'ok', protocol: 'ipns', decoded: IPNS_B58 })),
      });
      const results = [];
      const record = (value) => {
        if (value?.requester) {
          const { agent: _agent, navigation: _n, guest: _g, frame: _f, nonce: _nonce, ...rest } = value.requester;
          results.push({ ok: true, ...rest });
        } else {
          results.push(value?.navigation ? { ok: value.ok } : value);
        }
      };
      const guest = new Guest();
      if (inCustody) agentContents.add(guest);
      documents.track(guest);
      guest.commit(DAPP);
      record(await documents.attest(eventFrom(guest), nonce()));
      const n = nonce();
      record(documents.hello(eventFrom(guest), { nonce: n }));
      record(documents.hello(eventFrom(guest), { nonce: nonce() }));
      record(await documents.attest(eventFrom(guest), n));
      record(await documents.attest(eventFrom(guest), nonce()));
      record(await documents.attest(eventFrom(guest, frame(DAPP, 5000)), n));
      guest.mainFrame.url = 'https://elsewhere.example/';
      record(await documents.attest(eventFrom(guest), n));
      // Custody flips after the hello: still no difference.
      if (inCustody) agentContents.delete(guest);
      else agentContents.add(guest);
      guest.mainFrame.url = DAPP;
      record(await documents.attest(eventFrom(guest), n));
      guest.commit(`${DAPP}next`, { newFrame: false });
      record(await documents.attest(eventFrom(guest), n));
      documents.bindName({ guest: guest.id, name: 'example.com', key: IPNS_KEY });
      guest.commit(`ipns://${IPNS_KEY}/`);
      const named = nonce();
      record(documents.hello(eventFrom(guest), { nonce: named }));
      record(await documents.attest(eventFrom(guest), named));
      privateContents.add(guest);
      record(await documents.attest(eventFrom(guest), named));
      return results;
    }
    const outside = await outcomes(false);
    expect(outside).toContainEqual(expect.objectContaining({ ok: true, key: 'example.com' }));
    expect(await outcomes(true)).toEqual(outside);
  });
});
