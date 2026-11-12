// The same answers as the chrome's (freedom-core design 0011, PRQ-7a): each
// moved Swarm method, for each URL form, answered by the chrome's own route
// (`swarm-provider.js` sent these to `executeSwarmMethod` with the key it
// computed from the tab's URL, `getPermissionKey`) and by main's dispatcher,
// which calls the same `executeSwarmMethod` with the requester's attested
// key, over the same grants, feeds, node and chunks. Where the two differ,
// the design says so: a keyless document is refused what uses the key.

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  webContents: { fromId: jest.fn() },
}));
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// Main's backends, in memory. Every answer names the key it was asked under,
// so a wrong key shows in the answer itself.
const mockState = { permissions: new Map(), feeds: new Map(), ready: true };
jest.mock('../swarm/swarm-permissions', () => ({
  getPermission: (key) => mockState.permissions.get(key) || null,
  hasMessagingGrant: () => false,
  onRevoke: () => {},
}));
jest.mock('../swarm/publish-setup-service', () => ({
  getPublishReadiness: async () => (mockState.ready ? { ok: true } : { ok: false, reason: 'node-stopped' }),
}));
jest.mock('../service-registry', () => ({ getAntApiUrl: () => 'http://127.0.0.1:1633' }));
jest.mock('../swarm/chunk-service', () => ({
  readChunk: async (reference) => ({ data: Buffer.from(`chunk ${reference}`).toString('base64'), encoding: 'base64', span: '8' }),
  readDataRoot: async () => ({ size: 3n, chunkBytes: 3 }),
  readData: async (reference) => ({ data: Buffer.from(`data ${reference}`).toString('base64'), encoding: 'base64' }),
  readSingleOwnerChunk: async (params) => ({ data: Buffer.from(`soc ${params.address}`).toString('base64'), encoding: 'base64' }),
  publishChunk: jest.fn(),
  writeSingleOwnerChunk: jest.fn(),
}));
jest.mock('../swarm/feed-service', () => ({
  buildTopicString: (origin, name) => `${origin}/${name}`,
  readFeedPayload: async (owner, topic, index) => ({
    payload: Buffer.from(`feed ${owner} ${topic.label} ${index ?? 'latest'}`),
    index: 0,
    nextIndex: 1,
  }),
  createFeed: jest.fn(),
  updateFeed: jest.fn(),
  writeFeedPayload: jest.fn(),
}));
jest.mock('@ethersphere/bee-js', () => ({
  Topic: class {
    constructor(hex) {
      this.label = hex;
    }

    static fromString(text) {
      const topic = new this(text);
      topic.label = text;
      return topic;
    }
  },
}));
jest.mock('../swarm/feed-store', () => ({
  getFeed: (key, name) => mockState.feeds.get(key)?.[name] || null,
  getAllFeeds: (key) => ({ ...(mockState.feeds.get(key) || {}) }),
  getOriginEntry: () => null,
  setFeed: jest.fn(),
  updateFeedReference: jest.fn(),
  hasFeedGrant: () => false,
  isIdentitySharedWithOtherOrigins: () => false,
}));
jest.mock('../swarm/messaging-service', () => ({
  MAX_MESSAGE_BYTES: 4000,
  MAX_TARGET_DEPTH: 3,
  DEFAULT_TARGET_DEPTH: 2,
}));
jest.mock('../swarm/subscription-registry', () => ({ configure: jest.fn() }));
jest.mock('../swarm/publish-service', () => ({}));
jest.mock('../swarm/publish-history', () => ({ addEntry: jest.fn(() => ({ id: 1 })), updateEntry: jest.fn() }));
jest.mock('../swarm/swarm-signer', () => ({ resolveSwarmSigner: jest.fn(), getIdentityMode: () => null }));

global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) }));

const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { SWARM_READ_METHODS, createSwarmDispatchers } = require('./page-swarm');
const { executeSwarmMethod, clearPermissionFreeReadBudgets } = require('../swarm/swarm-provider-ipc');
const { getPermissionKey } = require('../../shared/origin-utils');

const CHROME_URL = 'file:///app/src/renderer/index.html';
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const PLAIN_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';
const KEYLESS = 'data:text/html,<p>keyless</p>';
const OWNER = 'ab'.repeat(20);
const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// The URL forms a page commits, as Chromium reports them.
const FORMS = [
  'https://app.example/swap?ref=1',
  'http://localhost:8080/x',
  `bzz://${'a'.repeat(64)}/index.html`,
  'bzz://name.eth/page#/feed',
  'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/docs',
  'ipfs://name.eth/',
  'ipns://name.eth/guide',
  `ipns://${PLAIN_IPNS_KEY}/plain`,
  'rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5/tree',
];
// The DNS name over IPNS: the chrome keyed it on the name from its known
// names; main keys it on the name its binding verified.
const NAMED = `ipns://${IPNS_KEY}/named`;

const CALLS = [
  ['swarm_getCapabilities', {}],
  ['swarm_readChunk', { reference: 'c'.repeat(64) }],
  ['swarm_readChunk', { reference: 'not-hex' }],
  ['swarm_readData', { reference: 'd'.repeat(64) }],
  ['swarm_readSingleOwnerChunk', { address: 'e'.repeat(64) }],
  ['swarm_readSingleOwnerChunk', { owner: OWNER }],
  ['swarm_readFeedEntry', { name: 'chat' }],
  ['swarm_readFeedEntry', { name: 'missing' }],
  ['swarm_readFeedEntry', { topic: 'f'.repeat(64), owner: OWNER, index: 2 }],
  ['swarm_readFeedEntry', { topic: 'f'.repeat(64), name: 'chat' }],
  ['swarm_listFeeds', {}],
];

class Guest extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.window = 1;
    this.hostWebContents = { id: 501, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
    this.mainFrame = { url: 'about:blank', frameTreeNodeId: 1000 + id, processId: 1, routingId: id, detached: false, send: jest.fn() };
  }

  isDestroyed() {
    return false;
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

function setup() {
  const guests = new Map();
  const documents = createPageDocuments({
    isPrivateWebContents: () => false,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent: async (name) => (name === NAME ? { type: 'ok', protocol: 'ipns', decoded: IPNS_KEY } : { type: 'not_found' }),
  });
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    // Main's own executeSwarmMethod, as in the app.
    dispatchers: createSwarmDispatchers({ identityWalletEnabled: () => true }),
  });
  let lastId = 0;
  let lastNonce = 0;
  async function tab(url, bind = null) {
    const guest = new Guest(++lastId);
    guests.set(guest.id, guest);
    requests.track(guest);
    if (bind) requests.bindName({ sender: guest.hostWebContents }, { guest: guest.id, name: bind, key: IPNS_KEY });
    guest.commit(url);
    const n = (++lastNonce).toString(16).padStart(32, '0');
    requests.hello({ sender: guest, senderFrame: guest.mainFrame }, { nonce: n });
    await flush();
    return (method, params) => requests.request({ sender: guest, senderFrame: guest.mainFrame }, { nonce: n, provider: 'swarm', method, params });
  }
  return { tab };
}

// What the page sees: a result, or an error's code, message and data.
const seen = (answer) => (answer.error ? { error: { code: answer.error.code, message: answer.error.message, data: answer.error.data } } : { result: answer.result });

describe('Swarm reads: the same answers as the chrome\'s (freedom-core design 0011, PRQ-7a)', () => {
  beforeEach(() => {
    mockState.permissions.clear();
    mockState.feeds.clear();
    mockState.ready = true;
  });

  // One page per URL form, connected or not, with feeds or without, and the
  // node ready or stopped: the chrome's answer and main's, from the same
  // state and a fresh read budget each.
  test.each([
    ['connected, with feeds', true, true],
    ['not connected, no feeds', false, false],
  ])('every URL form, %s', async (_label, connected, withFeeds) => {
    const env = setup();
    for (const url of [...FORMS, NAMED]) {
      // The chrome's key: for the named page, the name from its known names.
      const key = url === NAMED ? NAME : getPermissionKey(url);
      if (connected) mockState.permissions.set(key, { origin: key, autoApprove: {} });
      if (withFeeds) {
        mockState.feeds.set(key, {
          chat: { topic: 't'.repeat(64), owner: `0x${OWNER}`, manifestReference: 'm'.repeat(64), createdAt: 1 },
        });
      }
      const ask = await env.tab(url, url === NAMED ? NAME : null);
      for (const ready of [true, false]) {
        mockState.ready = ready;
        for (const [method, params] of CALLS) {
          clearPermissionFreeReadBudgets();
          const chrome = seen(await executeSwarmMethod(method, params, key));
          clearPermissionFreeReadBudgets();
          const main = seen(await ask(method, params));
          expect({ url, method, params, ready, main }).toEqual({ url, method, params, ready, main: chrome });
        }
      }
    }
    expect(CALLS.map(([method]) => method).filter((m, i, all) => all.indexOf(m) === i).sort()).toEqual(
      [...SWARM_READ_METHODS].sort()
    );
  });

  test('a keyless page: the reads answer as the chrome\'s did; what uses the key is refused, where the chrome keyed it on its whole URL', async () => {
    const env = setup();
    const ask = await env.tab(KEYLESS);
    for (const [method, params] of CALLS) {
      clearPermissionFreeReadBudgets();
      const chrome = seen(await executeSwarmMethod(method, params, getPermissionKey(KEYLESS)));
      clearPermissionFreeReadBudgets();
      const main = seen(await ask(method, params));
      if (['swarm_readChunk', 'swarm_readData', 'swarm_readSingleOwnerChunk'].includes(method)) {
        expect({ method, params, main }).toEqual({ method, params, main: chrome });
      } else {
        expect({ method, params, main }).toEqual({
          method,
          params,
          main: { error: { code: 4100, message: 'This page has no address to connect from yet', data: { reason: 'no_address' } } },
        });
      }
    }
  });
});
