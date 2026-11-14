// Swarm publishing through main (freedom-core design 0011, PRQ-7c), against
// the PRQ-7 row. Main's real request path (page-documents, page-requests,
// its prompts, budgets and tickets) runs the dispatcher (page-swarm.js) over
// main's real executeSwarmMethod and Swarm permission store; the node's
// uploads are in memory, and a test can hold the service's own wait (the
// batch) or the upload itself. Each upload goes through the caller's guard
// (`guard(send)`), as publish-service.js and chunk-service.js run it.

const os = require('os');
const { useSimulatedGrantCore, attachedCoreClient, testPage } = require('../../../test/helpers/simulated-grant-core');
const fs = require('fs');
const path = require('path');

const mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'page-swarm-publish-'));
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
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// The node: what was uploaded, and the waits a test may hold.
const mockNode = {
  uploads: [],
  signals: [],
  statusReads: [],
  readiness: null,
  batch: null,
  upload: null,
  statusWait: null,
  fail: null,
};
// As publish-service and chunk-service: their own wait (the batch), then
// the write under the caller's guard, which resolves null to send nothing.
// As page-upload.js: the caller's signal stops an upload in flight.
function mockAborted(signal) {
  return new Promise((_resolve, reject) => {
    const stop = () => {
      const err = new Error('The upload was cancelled');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
}
async function mockUpload(kind, body, options = {}) {
  mockNode.signals.push(options.signal);
  if (mockNode.batch) await mockNode.batch;
  if (mockNode.fail) throw mockNode.fail;
  const send = async () => {
    options.onSend?.();
    mockNode.uploads.push({ kind, body });
    if (mockNode.upload) await Promise.race([mockNode.upload, mockAborted(options.signal)]);
    return { reference: 'ab'.repeat(32), tagUid: kind === 'files' ? 7 : null };
  };
  const sent = options.guard ? await options.guard(send) : await send();
  if (!sent) return null;
  return { ...sent, bzzUrl: `bzz://${sent.reference}`, batchIdUsed: 'batch' };
}
jest.mock('../swarm/publish-service', () => ({
  publishPageData: (data, options) => mockUpload('data', data, options),
  publishFilesFromContent: (files, options) => mockUpload('files', files, options),
  getUploadStatus: async (tagUid) => {
    mockNode.statusReads.push(tagUid);
    if (mockNode.statusWait) await mockNode.statusWait;
    return { tagUid, split: 4, sent: 2, progress: 50, done: false };
  },
}));
jest.mock('../swarm/chunk-service', () => ({
  publishChunk: async (data, options) => {
    const out = await mockUpload('chunk', data, options);
    return out ? { reference: out.reference, batchIdUsed: 'batch' } : null;
  },
}));
jest.mock('../swarm/messaging-service', () => ({
  MAX_MESSAGE_BYTES: 4000,
  MAX_TARGET_DEPTH: 3,
  DEFAULT_TARGET_DEPTH: 2,
  sendPss: async () => {},
}));
jest.mock('../service-registry', () => ({ getAntApiUrl: () => 'http://127.0.0.1:1633' }));
jest.mock('../swarm/publish-setup-service', () => ({
  getPublishReadiness: async () => (mockNode.readiness ? mockNode.readiness : { ok: true }),
}));
jest.mock('../swarm/feed-service', () => ({ buildTopicString: (o, n) => `${o}/${n}` }));
jest.mock('../swarm/feed-store', () => ({
  getAllFeeds: () => ({}),
  getFeed: () => null,
  getOriginEntry: () => null,
  hasFeedGrant: () => false,
  onManifestMutation: () => {},
}));
const mockHistory = [];
jest.mock('../swarm/publish-history', () => ({
  addEntry: (entry) => {
    mockHistory.push({ ...entry });
    return { id: mockHistory.length };
  },
  updateEntry: (id, update) => Object.assign(mockHistory[id - 1], update),
}));
jest.mock('../swarm/swarm-signer', () => ({ resolveSwarmSigner: jest.fn(), getIdentityMode: () => null }));

global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) }));

const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { createSwarmDispatchers } = require('./page-swarm');
const { BUDGETS, largestChargeOf } = require('./page-budgets');
const { measurePageRequest, pageRequestMaxBytes } = require('../../shared/page-request-bounds');
const permissions = require('../swarm/swarm-permissions');
const { registerSwarmProviderIpc, executeSwarmMethod, clearTagOwnership } = require('../swarm/swarm-provider-ipc');

registerSwarmProviderIpc();
permissions.registerSwarmPermissionsIpc();

const MiB = 1024 * 1024;
const KiB = 1024;
const CHROME_URL = 'file:///app/src/renderer/index.html';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';
const REFERENCE = 'ab'.repeat(32);

const DATA = { data: 'hello', contentType: 'text/plain', name: 'note.txt' };
const FILES = { files: [{ path: 'index.html', bytes: new Uint8Array([60, 112, 62]) }], indexDocument: 'index.html' };
const CHUNK = { data: 'chunk' };
const UPLOADS = [
  ['swarm_publishData', DATA, { result: { reference: REFERENCE, bzzUrl: `bzz://${REFERENCE}` } }],
  ['swarm_publishFiles', FILES, { result: { reference: REFERENCE, bzzUrl: `bzz://${REFERENCE}`, tagUid: 7 } }],
  ['swarm_publishChunk', CHUNK, { result: { reference: REFERENCE } }],
];

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
const PUBLISH_REJECTED = { error: { code: 4001, message: 'User rejected publish' } };
const LIMIT = { error: { code: -32005, message: 'Limit exceeded' } };
const GRANTS_UNAVAILABLE = {
  error: { code: 4900, message: 'Swarm permissions are not available', data: { reason: 'grants_unavailable' } },
};

let nextId = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
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
  const state = { custody: new Set(), checks: [], routed: [], manifest: async () => ({ kind: 'legacy' }) };
  const sent = [];
  const trace = [];
  const copies = [];
  const timers = [];
  const hooks = {
    onTrace: (entry) => trace.push(entry),
    onCopy: (entry) => copies.push(entry),
  };
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers: createSwarmDispatchers({
      identityWalletEnabled: () => true,
      inCustody: (guest) => state.custody.has(guest),
      guestContents: (id) => guests.get(id),
      checkManifest: async (request) => {
        state.checks.push({ key: request.key, eager: request.eager });
        return state.manifest(request);
      },
      decideManifest: async () => ({ allowed: true, mode: 'allow' }),
      releaseManifest: () => {},
      routeToSetup: (requester, reason) => state.routed.push({ guest: requester.guest, key: requester.key, reason }),
    }),
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

  function greet(guest) {
    const n = nonce();
    expect(requests.hello(eventFrom(guest), { nonce: n }).ok).toBe(true);
    return {
      guest,
      nonce: n,
      ask: (method, params = {}, ticket) =>
        requests.request(eventFrom(guest), {
          nonce: n,
          provider: 'swarm',
          method,
          params,
          ...(ticket === undefined ? {} : { ticket }),
        }),
      reserve: (method, bytes) => requests.reserve(eventFrom(guest), { nonce: n, method, bytes }),
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

const connect = async (key, { publishRule = false } = {}) => {
  await permissions.grantPermission(key, { page: testPage(key) });
  if (publishRule) await permissions.setAutoApprove(key, 'publish', true, { page: testPage(key) });
};

/**
 * Params for `method` whose request, as the walk measures it, is exactly
 * `size` bytes. The payload is `payload` bytes (by default all of it), and
 * the rest a property the method ignores (`note`): a request of exactly its
 * method's size whose payload is the method's own limit.
 */
function paramsOfSize(page, method, size, { form = 'u8', payload = null } = {}) {
  const make = (n) => (form === 'u8' ? new Uint8Array(n).fill(255) : 'a'.repeat(n));
  const shape = (bytes, note) => ({
    ...(method === 'swarm_publishFiles'
      ? { files: [{ path: 'index.html', bytes }] }
      : { data: bytes, contentType: 'text/plain' }),
    ...(note === undefined ? {} : { note }),
  });
  const measure = (params) =>
    measurePageRequest({ nonce: page.nonce, provider: 'swarm', method, params }, pageRequestMaxBytes('swarm', method)).size;
  if (payload === null) return shape(make(size - measure(shape(make(0)))));
  return shape(make(payload), 'n'.repeat(size - measure(shape(make(payload), ''))));
}

// The simulated identity core main's grants come from.
let core;

beforeEach(async () => {
  core = await useSimulatedGrantCore();
  clearTagOwnership();
  mockNode.uploads = [];
  mockNode.signals = [];
  mockNode.statusReads = [];
  mockNode.readiness = null;
  mockNode.batch = null;
  mockNode.upload = null;
  mockNode.statusWait = null;
  mockNode.fail = null;
  mockHistory.length = 0;
});

afterAll(() => {
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

describe('publishing through main (0011 PRQ-7c)', () => {
  test('main prompts with its own site and view; on approval the upload goes out for the attested key; "always allow" sets the rule, by main', async () => {
    const env = setup();
    await connect(KEY_A);
    const page = env.tab(`${KEY_A}/app`);
    const answer = page.ask('swarm_publishData', DATA);
    const prompt = await env.shown('swarm.publish');
    expect(prompt).toEqual({
      handle: expect.any(String),
      guest: page.guest.id,
      kind: 'swarm.publish',
      site: { key: KEY_A, label: KEY_A },
      view: { method: 'swarm_publishData', kind: 'data', size: 5, contentType: 'text/plain', name: 'note.txt' },
    });
    expect(mockNode.uploads).toEqual([]);
    // The chrome names no site, and "always allow" is a boolean.
    expect(await env.decide(prompt.handle, true, { site: KEY_B })).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(prompt.handle, true, { alwaysAllow: 'yes' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(prompt.handle, true, { alwaysAllow: true })).toEqual({ ok: true });
    expect(await answer).toEqual(UPLOADS[0][2]);
    expect(mockNode.uploads).toEqual([{ kind: 'data', body: 'hello' }]);
    expect(mockHistory).toEqual([expect.objectContaining({ origin: KEY_A, status: 'completed' })]);
    expect(permissions.getAutoApprove(KEY_A, 'publish')).toBe(true);
    expect(permissions.getAutoApprove(KEY_B, 'publish')).toBe(false);
    // The rule now answers each upload, with no prompt.
    const count = env.prompts().length;
    for (const [method, params, out] of UPLOADS) {
      expect({ method, answer: await page.ask(method, params) }).toEqual({ method, answer: out });
    }
    expect(env.prompts()).toHaveLength(count);
    expect(mockNode.uploads.map((u) => u.kind)).toEqual(['data', 'data', 'files', 'chunk']);
  });

  test('the publish prompt\'s view: sizes main measured, and the page\'s text only as far as each bound', async () => {
    const env = setup();
    await connect(KEY_A);
    const page = env.tab();
    const files = [
      { path: 'index.html', bytes: new Uint8Array(10) },
      { path: `${'x'.repeat(101)}.js`, bytes: new ArrayBuffer(20) },
      { path: 'assets/app.js', bytes: { type: 'Buffer', data: [1, 2, 3] } },
      { path: 'b.css', bytes: new Uint8Array(4) },
      { path: 'c.css', bytes: new Uint8Array(4) },
    ];
    const cases = [
      ['swarm_publishFiles', { files }, { method: 'swarm_publishFiles', kind: 'files', count: 5, size: 41, paths: ['index.html', 'assets/app.js', 'b.css'] }],
      ['swarm_publishChunk', { data: new Uint8Array(40) }, { method: 'swarm_publishChunk', kind: 'chunk', size: 40 }],
      ['swarm_publishData', { data: 'é', contentType: 'x'.repeat(257), name: 'n'.repeat(256) }, { method: 'swarm_publishData', kind: 'data', size: 2, name: 'n'.repeat(256) }],
    ];
    for (const [method, params, view] of cases) {
      const answer = page.ask(method, params);
      const prompt = await env.shown('swarm.publish');
      expect({ method, view: prompt.view }).toEqual({ method, view });
      await env.decide(prompt.handle, false);
      expect(await answer).toEqual(PUBLISH_REJECTED);
    }
    expect(mockNode.uploads).toEqual([]);
    expect(permissions.getAutoApprove(KEY_A, 'publish')).toBe(false);
  });

  test('an unconnected site is refused with no prompt, a keyless document is refused, and the manifest is checked once per document, lazily', async () => {
    const env = setup();
    const page = env.tab();
    for (const [method, params] of UPLOADS) {
      expect(await page.ask(method, params)).toEqual(NOT_CONNECTED);
    }
    expect(await page.ask('swarm_getUploadStatus', { tagUid: 7 })).toEqual(NOT_CONNECTED);
    expect(env.prompts()).toEqual([]);
    expect(env.state.checks).toEqual([{ key: KEY_A, eager: false }]);
    const keyless = env.tab('data:text/html,<p>x</p>');
    for (const [method, params] of UPLOADS) expect(await keyless.ask(method, params)).toEqual(NO_ADDRESS);
    expect(await keyless.ask('swarm_getUploadStatus', { tagUid: 7 })).toEqual(NO_ADDRESS);
    expect(env.state.checks).toHaveLength(1);
    // An unresolved manifest check answers 4900 and is tried again.
    const other = env.tab(`${KEY_B}/`);
    await connect(KEY_B, { publishRule: true });
    env.state.manifest = async () => ({ kind: 'unresolved' });
    expect(await other.ask('swarm_publishData', DATA)).toEqual({
      error: { code: 4900, message: 'Could not refresh this app’s permission manifest' },
    });
    env.state.manifest = async () => ({ kind: 'legacy' });
    expect(await other.ask('swarm_publishData', DATA)).toEqual(UPLOADS[0][2]);
    expect(env.state.checks.filter((c) => c.key === KEY_B)).toHaveLength(2);
    expect(mockNode.uploads).toHaveLength(1);
  });

  test.each(UPLOADS)('custody read live for %s: no rule answers a tab in custody, the user\'s approval counts there, one that enters custody while a rule-answered upload waits publishes nothing, and leaving custody gives the rule back', async (method, params, out) => {
    const env = setup();
    await connect(KEY_A, { publishRule: true });
    const page = env.tab();
    env.state.custody.add(page.guest.id);
    const prompted = page.ask(method, params);
    const prompt = await env.shown('swarm.publish');
    await env.decide(prompt.handle, true);
    expect(await prompted).toEqual(out);
    expect(mockNode.uploads).toHaveLength(1);

    // Out of custody, the rule answers; the tab enters custody while the
    // upload waits on the node's readiness, and again on the batch.
    env.state.custody.delete(page.guest.id);
    for (const wait of ['readiness', 'batch']) {
      const gate = held();
      mockNode[wait] = gate.promise.then(() => ({ ok: true }));
      const ruled = page.ask(method, params);
      await flush();
      env.state.custody.add(page.guest.id);
      gate.release();
      expect({ wait, answer: await ruled }).toEqual({ wait, answer: AGENT_CUSTODY });
      expect(mockNode.uploads).toHaveLength(1);
      mockNode[wait] = null;
      env.state.custody.delete(page.guest.id);
    }
    // Leaving custody gives the rule back for the next, with no prompt.
    const count = env.prompts().length;
    expect(await page.ask(method, params)).toEqual(out);
    expect(env.prompts()).toHaveLength(count);
    expect(mockNode.uploads).toHaveLength(2);
  });

  test('a rule turned off, or the connection revoked, while an upload waits: nothing published', async () => {
    const env = setup();
    await connect(KEY_A, { publishRule: true });
    const page = env.tab();
    let gate = held();
    mockNode.readiness = gate.promise.then(() => ({ ok: true }));
    const ruleOff = page.ask('swarm_publishFiles', FILES);
    await flush();
    await permissions.setAutoApprove(KEY_A, 'publish', false);
    gate.release();
    expect(await ruleOff).toEqual(RULE_OFF);

    // A prompted upload whose connection is revoked while it waits.
    gate = held();
    mockNode.readiness = gate.promise.then(() => ({ ok: true }));
    const revoked = page.ask('swarm_publishData', DATA);
    const prompt = await env.shown('swarm.publish');
    const decided = env.decide(prompt.handle, true);
    await flush();
    await permissions.revokePermission(KEY_A);
    gate.release();
    expect((await revoked).error).toMatchObject({ code: 4100, data: { reason: 'not_connected' } });
    expect(await decided).toEqual({ ok: true });
    expect(mockNode.uploads).toEqual([]);
    // A refused upload's history row says so.
    expect(mockHistory.map((h) => h.status)).toEqual(['failed', 'failed']);
  });

  test('a rule the core turned off reads as no grant until its read lands: an upload waiting under the rule, and a new one, publish nothing', async () => {
    const env = setup();
    await connect(KEY_A, { publishRule: true });
    const page = env.tab();
    const client = attachedCoreClient();
    const gate = held();
    mockNode.readiness = gate.promise.then(() => ({ ok: true }));
    const waiting = page.ask('swarm_publishFiles', FILES);
    await flush();
    // The core turns the rule off and reports it; main's read of the key is held.
    const reads = core.holdKeyReads();
    core.entries.swarm[KEY_A].autoApprove.publish = false;
    client.changed('swarm', KEY_A);
    expect(await page.ask('swarm_publishData', DATA)).toEqual(NOT_CONNECTED);
    gate.release();
    expect((await waiting).error).toMatchObject({ code: 4100 });
    expect(mockNode.uploads).toEqual([]);
    expect(env.prompts()).toEqual([]);
    // Once the read lands: connected, with no rule.
    reads.release();
    await flush();
    mockNode.readiness = null;
    const prompted = page.ask('swarm_publishData', DATA);
    const prompt = await env.shown('swarm.publish');
    expect(await env.decide(prompt.handle, false)).toEqual({ ok: true });
    expect(await prompted).toEqual(PUBLISH_REJECTED);
    expect(mockNode.uploads).toEqual([]);
  });

  test('a rule the core turned on answers once its read lands', async () => {
    const env = setup();
    await connect(KEY_A);
    const page = env.tab();
    const client = attachedCoreClient();
    const reads = core.holdKeyReads();
    core.entries.swarm[KEY_A].autoApprove.publish = true;
    client.changed('swarm', KEY_A);
    expect(await page.ask('swarm_publishData', DATA)).toEqual(NOT_CONNECTED);
    reads.release();
    await flush();
    expect((await page.ask('swarm_publishData', DATA)).result.reference).toBe(REFERENCE);
    expect(env.prompts()).toEqual([]);
    expect(mockNode.uploads.map((u) => u.kind)).toEqual(['data']);
  });

  test('a revoke from the chrome hides the connection while the core writes it and reads it back: nothing published meanwhile', async () => {
    const env = setup();
    await connect(KEY_A, { publishRule: true });
    const page = env.tab();
    const reads = core.holdKeyReads();
    const revoking = permissions.revokePermission(KEY_A, { caller: 'chrome' });
    expect(await page.ask('swarm_publishData', DATA)).toEqual(NOT_CONNECTED);
    await flush();
    expect(core.calls.at(-1)).toMatchObject({ method: 'approval.revoke', caller: 'chrome' });
    expect(await page.ask('swarm_publishData', DATA)).toEqual(NOT_CONNECTED);
    reads.release();
    await revoking;
    expect(permissions.getPermission(KEY_A)).toBeNull();
    expect(mockNode.uploads).toEqual([]);
  });

  test('between core processes an upload waits for the next one\'s grants, and one already waiting publishes nothing; once the core gives up, uploads are refused', async () => {
    const env = setup();
    await connect(KEY_A, { publishRule: true });
    const page = env.tab();
    const client = attachedCoreClient();
    const gate = held();
    mockNode.readiness = gate.promise.then(() => ({ ok: true }));
    const checked = page.ask('swarm_publishFiles', FILES);
    await flush();
    client.emit('exit', { code: 1 });
    gate.release();
    expect((await checked).error).toMatchObject({ code: 4100 });
    // A request now waits for the next process's load.
    mockNode.readiness = null;
    let answered = false;
    const waiting = page.ask('swarm_publishData', DATA).then((out) => {
      answered = true;
      return out;
    });
    await flush();
    expect(answered).toBe(false);
    expect(env.prompts()).toEqual([]);
    // The next process holds the connection without the rule.
    core.entries.swarm[KEY_A].autoApprove.publish = false;
    client.emit('ready');
    const prompt = await env.shown('swarm.publish');
    expect(await env.decide(prompt.handle, false)).toEqual({ ok: true });
    expect(await waiting).toEqual(PUBLISH_REJECTED);
    // The core gives up.
    client.emit('failed', 'three crashes within a minute');
    const before = env.prompts().length;
    for (const [method, params] of UPLOADS) expect(await page.ask(method, params)).toEqual(GRANTS_UNAVAILABLE);
    expect(env.prompts()).toHaveLength(before);
    expect(mockNode.uploads).toEqual([]);
  });

  test('a name that moves off its IPNS key while a rule-answered upload waits, or while its prompt is open: nothing published, no rule', async () => {
    const env = setup();
    await connect(NAME, { publishRule: true });
    const page = await env.named();
    for (const wait of ['readiness', 'batch']) {
      env.names.set(NAME, IPNS_KEY);
      const gate = held();
      mockNode[wait] = gate.promise.then(() => ({ ok: true }));
      const answer = page.ask('swarm_publishFiles', FILES);
      await flush();
      env.names.set(NAME, OTHER_IPNS_KEY);
      gate.release();
      expect({ wait, answer: await answer }).toEqual({ wait, answer: NO_ADDRESS });
      mockNode[wait] = null;
    }
    expect(mockNode.uploads).toEqual([]);

    // The prompt, for another document of the name.
    const env2 = setup();
    await connect(NAME);
    const prompted = await env2.named();
    const answer = prompted.ask('swarm_publishData', DATA);
    const prompt = await env2.shown('swarm.publish');
    expect(prompt.site).toEqual({ key: NAME, label: NAME });
    env2.names.set(NAME, OTHER_IPNS_KEY);
    await env2.decide(prompt.handle, true, { alwaysAllow: true });
    expect(await answer).toEqual(NO_ADDRESS);
    expect(permissions.getAutoApprove(NAME, 'publish')).toBe(false);
    expect(mockNode.uploads).toEqual([]);
  });

  test('after the name has moved: every publishing method refused with nothing done, swarm_getUploadStatus with nothing about the tag', async () => {
    const env = setup();
    await connect(NAME, { publishRule: true });
    const page = await env.named();
    // The site's own tag, from an upload before the name moved.
    expect((await page.ask('swarm_publishFiles', FILES)).result.tagUid).toBe(7);
    mockNode.uploads = [];
    env.names.set(NAME, OTHER_IPNS_KEY);
    for (const [method, params] of UPLOADS) {
      expect({ method, answer: await page.ask(method, params) }).toEqual({ method, answer: NO_ADDRESS });
    }
    expect(await page.ask('swarm_getUploadStatus', { tagUid: 7 })).toEqual(NO_ADDRESS);
    expect(mockNode.uploads).toEqual([]);
    expect(mockNode.statusReads).toEqual([]);
    expect(env.prompts()).toEqual([]);
  });

  test('an upload that went out answers with its reference though the name moves during it; the tag\'s owner is recorded only while the name answers', async () => {
    const env = setup();
    await connect(NAME, { publishRule: true });
    const page = await env.named();
    const gate = held();
    mockNode.upload = gate.promise;
    const answer = page.ask('swarm_publishFiles', FILES);
    await flush();
    expect(mockNode.uploads).toHaveLength(1);
    env.names.set(NAME, OTHER_IPNS_KEY);
    gate.release();
    expect(await answer).toEqual(UPLOADS[1][2]);
    // Not the name's tag: main recorded no owner for it.
    expect((await executeSwarmMethod('swarm_getUploadStatus', { tagUid: 7 }, NAME)).error).toMatchObject({
      data: { reason: 'tag_ownership_mismatch' },
    });
  });

  test('swarm_getUploadStatus: the owner\'s tag, never another site\'s; a name that moves while the read waits gets nothing', async () => {
    const env = setup();
    await connect(KEY_A, { publishRule: true });
    await connect(KEY_B);
    const page = env.tab();
    const other = env.tab(`${KEY_B}/`, { front: false });
    expect((await page.ask('swarm_publishFiles', FILES)).result.tagUid).toBe(7);
    expect(await page.ask('swarm_getUploadStatus', { tagUid: 7 })).toEqual({
      result: { tagUid: 7, split: 4, sent: 2, progress: 50, done: false },
    });
    expect((await other.ask('swarm_getUploadStatus', { tagUid: 7 })).error).toMatchObject({
      code: 4100,
      data: { reason: 'tag_ownership_mismatch' },
    });
    expect(mockNode.statusReads).toEqual([7]);

    const env2 = setup();
    await connect(NAME, { publishRule: true });
    const named = await env2.named();
    expect((await named.ask('swarm_publishFiles', FILES)).result.tagUid).toBe(7);
    const gate = held();
    mockNode.statusWait = gate.promise;
    const answer = named.ask('swarm_getUploadStatus', { tagUid: 7 });
    await flush();
    env2.names.set(NAME, OTHER_IPNS_KEY);
    gate.release();
    expect(await answer).toEqual(NO_ADDRESS);
  });

  test('a write the node refuses because publishing isn\'t set up takes the requesting window to the setup screen, as the chrome did', async () => {
    const env = setup();
    await connect(KEY_A, { publishRule: true });
    await permissions.grantMessaging(KEY_A, { page: testPage(KEY_A) });
    await permissions.setAutoApprove(KEY_A, 'messaging', true, { page: testPage(KEY_A) });
    const page = env.tab();
    mockNode.readiness = { ok: false, reason: 'no-usable-stamps' };
    expect((await page.ask('swarm_publishData', DATA)).error).toMatchObject({ code: 4900, data: { reason: 'no-usable-stamps' } });
    const pss = { topic: 'room', recipient: `02${'c'.repeat(64)}`, targets: 'abcd', data: 'hi' };
    mockNode.readiness = { ok: false, reason: 'node-stopped' };
    expect((await page.ask('swarm_sendPss', pss)).error).toMatchObject({ code: 4900, data: { reason: 'node-stopped' } });
    expect(env.state.routed).toEqual([
      { guest: page.guest.id, key: KEY_A, reason: 'no-usable-stamps' },
      { guest: page.guest.id, key: KEY_A, reason: 'node-stopped' },
    ]);
    // Not for any other failure, nor for a read.
    mockNode.readiness = null;
    mockNode.fail = new Error('disk full');
    expect((await page.ask('swarm_publishData', DATA)).error).toMatchObject({ code: -32603 });
    expect((await page.ask('swarm_getUploadStatus', { tagUid: 'x' })).error).toMatchObject({ code: -32602 });
    expect(env.state.routed).toHaveLength(2);
  });

  test('each copy of an upload\'s bytes is reported with its charge already in place', async () => {
    const env = setup();
    await connect(KEY_A, { publishRule: true });
    const page = env.tab();
    await page.ask('swarm_publishData', { data: new Uint8Array(1000), contentType: 'x/y' });
    await page.ask('swarm_publishData', { data: 'text', contentType: 'x/y' });
    await page.ask('swarm_publishFiles', { files: [{ path: 'a', bytes: new Uint8Array(8) }, { path: 'b', bytes: new Uint8Array(8) }] });
    expect(env.copies.map((c) => [c.label, c.inPlace])).toEqual([
      ['normalizeBytes', true],
      ['upload', true],
      ['upload', true],
      ['normalizeBytes', true],
      ['normalizeBytes', true],
      ['upload', true],
    ]);
    for (const copy of env.copies) expect(copy.charged).toBeGreaterThanOrEqual(copy.charge);
  });
});

describe('large uploads on their tickets (0011 PRQ-7c, "Large requests")', () => {
  const FILES_SIZE = pageRequestMaxBytes('swarm', 'swarm_publishFiles');
  const DATA_SIZE = pageRequestMaxBytes('swarm', 'swarm_publishData');

  test('a swarm_publishFiles of exactly its size, one 50 MiB Uint8Array, passes on its ticket: about 103.6 MiB charged before normalizeBytes copies it, within the document\'s 128 MiB; one byte more is refused', async () => {
    const env = setup();
    await connect(KEY_A, { publishRule: true });
    const page = env.tab();
    const params = paramsOfSize(page, 'swarm_publishFiles', FILES_SIZE, { payload: 50 * MiB });
    expect(params.files[0].bytes.byteLength).toBe(50 * MiB);
    const { ticket } = await page.reserve('swarm_publishFiles', FILES_SIZE);
    expect(typeof ticket).toBe('string');
    const largest = largestChargeOf('swarm', 'swarm_publishFiles', FILES_SIZE);
    expect(largest / MiB).toBeCloseTo(103.6, 1);
    expect(largest).toBeLessThanOrEqual(BUDGETS.document.bytes);
    expect(await page.ask('swarm_publishFiles', params, ticket)).toEqual(UPLOADS[1][2]);
    expect(env.copies.map((c) => [c.label, c.inPlace])).toEqual([
      ['normalizeBytes', true],
      ['upload', true],
    ]);
    expect(env.copies[0].charged).toBe(largest);
    expect(mockNode.uploads[0].body[0].bytes.byteLength).toBe(params.files[0].bytes.byteLength);
    expect(env.requests.stats()).toMatchObject({ records: 0, turns: 0, browser: { requests: 0, bytes: 0 } });

    // One byte more: the walk refuses it, before main records anything.
    const over = paramsOfSize(page, 'swarm_publishFiles', FILES_SIZE + 1, { payload: 50 * MiB });
    const before = env.trace.length;
    expect((await page.reserve('swarm_publishFiles', FILES_SIZE + 1)).error).toEqual({ code: -32602, message: 'Invalid parameters' });
    const second = await page.reserve('swarm_publishFiles', FILES_SIZE);
    expect((await page.ask('swarm_publishFiles', over, second.ticket)).error).toMatchObject({
      code: -32602,
      data: { reason: 'payload_too_large' },
    });
    expect(env.trace.slice(before).filter((e) => e.kind === 'recorded')).toEqual([]);
    expect(mockNode.uploads).toHaveLength(1);
  });

  test('swarm_publishData at its size, as a Uint8Array and as a string V8 holds at two bytes a character, on its ticket', async () => {
    const env = setup();
    await connect(KEY_A, { publishRule: true });
    const page = env.tab();
    for (const form of ['u8', 'two-byte']) {
      let params = paramsOfSize(page, 'swarm_publishData', DATA_SIZE, { form, payload: 10 * MiB });
      // One character past U+00FF, two UTF-8 bytes, in place of two ASCII ones.
      if (form === 'two-byte') params = { ...params, data: `${String.fromCharCode(0x100)}${params.data.slice(2)}` };
      const { ticket } = await page.reserve('swarm_publishData', DATA_SIZE);
      expect({ form, answer: await page.ask('swarm_publishData', params, ticket) }).toEqual({ form, answer: UPLOADS[0][2] });
    }
    // One byte more of data than the method's own limit: its check refuses
    // it, after its copies were charged.
    const over = paramsOfSize(page, 'swarm_publishData', DATA_SIZE, { payload: 10 * MiB + 1 });
    const { ticket } = await page.reserve('swarm_publishData', DATA_SIZE);
    expect((await page.ask('swarm_publishData', over, ticket)).error).toMatchObject({ data: { reason: 'payload_too_large' } });
    expect(env.copies.filter((c) => !c.inPlace)).toEqual([]);
    expect(mockNode.uploads.map((u) => (typeof u.body === 'string' ? 'string' : u.body.byteLength))).toEqual([10 * MiB, 'string']);
  });

  test('three such uploads from three documents of one window run two at a time within the window\'s 256 MiB; the third waits, and is granted when one ends', async () => {
    const env = setup();
    await connect(KEY_A, { publishRule: true });
    const pages = [env.tab(`${KEY_A}/1`), env.tab(`${KEY_A}/2`, { front: false }), env.tab(`${KEY_A}/3`, { front: false })];
    const gate = held();
    mockNode.upload = gate.promise;
    const reservations = pages.map((page) => page.reserve('swarm_publishFiles', FILES_SIZE));
    await flush();
    expect(env.trace.filter((e) => e.kind === 'ticket-granted')).toHaveLength(2);
    expect(env.requests.stats()).toMatchObject({ turns: 2, waiting: 1, tickets: 2 });
    const [first, second] = await Promise.all(reservations.slice(0, 2));
    const running = [
      pages[0].ask('swarm_publishFiles', paramsOfSize(pages[0], 'swarm_publishFiles', FILES_SIZE, { payload: 50 * MiB }), first.ticket),
      pages[1].ask('swarm_publishFiles', paramsOfSize(pages[1], 'swarm_publishFiles', FILES_SIZE, { payload: 50 * MiB }), second.ticket),
    ];
    await flush();
    expect(mockNode.uploads).toHaveLength(2);
    // Two uploads' charges, in the window's budget; the third doesn't fit
    // beside them, and has no turn.
    const largest = largestChargeOf('swarm', 'swarm_publishFiles', FILES_SIZE);
    const usage = env.requests.stats();
    expect(usage.windows[1].bytes).toBe(2 * largest);
    expect(usage.windows[1].bytes).toBeLessThanOrEqual(BUDGETS.window.bytes);
    expect(3 * largest).toBeGreaterThan(BUDGETS.window.bytes);
    expect(usage).toMatchObject({ turns: 2, waiting: 1 });
    gate.release();
    expect(await running[0]).toEqual(UPLOADS[1][2]);
    expect(await running[1]).toEqual(UPLOADS[1][2]);
    const third = await reservations[2];
    expect(typeof third.ticket).toBe('string');
    mockNode.upload = null;
    expect(await pages[2].ask('swarm_publishFiles', paramsOfSize(pages[2], 'swarm_publishFiles', FILES_SIZE, { payload: 50 * MiB }), third.ticket)).toEqual(
      UPLOADS[1][2]
    );
    expect(mockNode.uploads).toHaveLength(3);
  });

  test('with both turns taken, sixteen more documents\' reservations wait and a seventeenth\'s is refused', async () => {
    const env = setup();
    await connect(KEY_A, { publishRule: true });
    const holders = [env.tab(`${KEY_A}/h1`, { window: 1 }), env.tab(`${KEY_A}/h2`, { window: 2 })];
    const tickets = await Promise.all(holders.map((page) => page.reserve('swarm_publishData', 2 * MiB)));
    expect(tickets.every((t) => typeof t.ticket === 'string')).toBe(true);
    const waiting = [];
    for (let i = 0; i < 16; i += 1) {
      const page = env.tab(`${KEY_A}/w${i}`, { window: 3 + (i % 4), front: false });
      waiting.push(page.reserve(i % 2 ? 'swarm_publishFiles' : 'swarm_publishData', 2 * MiB));
    }
    await flush();
    expect(env.trace.filter((e) => e.kind === 'reservation-waiting')).toHaveLength(18);
    const seventeenth = env.tab(`${KEY_A}/w16`, { window: 8, front: false });
    expect(await seventeenth.reserve('swarm_publishFiles', 2 * MiB)).toEqual(LIMIT);
    // A turn freed goes to the oldest waiting.
    const gate = held();
    mockNode.upload = gate.promise;
    const data = { data: new Uint8Array(2 * MiB - 200), contentType: 'x/y' };
    const served = holders[0].ask('swarm_publishData', data, tickets[0].ticket);
    gate.release();
    expect(await served).toEqual(UPLOADS[0][2]);
    expect(typeof (await waiting[0]).ticket).toBe('string');
  });

  // Codex round 1 on #1199: an upload stops with its request, so its charge
  // and its turn go.
  test('a navigation, or main\'s deadline, during an upload stops it: its charge and turn go, and the next waiting upload gets the turn', async () => {
    const env = setup();
    await connect(KEY_A, { publishRule: true });
    const pages = [env.tab(`${KEY_A}/1`), env.tab(`${KEY_A}/2`, { front: false }), env.tab(`${KEY_A}/3`, { front: false })];
    const gate = held();
    mockNode.upload = gate.promise;
    const bytes = 2 * MiB;
    const tickets = await Promise.all(pages.slice(0, 2).map((page) => page.reserve('swarm_publishData', bytes)));
    const third = pages[2].reserve('swarm_publishData', bytes);
    const running = pages.slice(0, 2).map((page, i) => page.ask('swarm_publishData', paramsOfSize(page, 'swarm_publishData', bytes), tickets[i].ticket));
    await flush();
    expect(mockNode.uploads).toHaveLength(2);
    expect(env.requests.stats()).toMatchObject({ turns: 2, waiting: 1, records: 2 });
    // Every upload has the request's signal.
    expect(mockNode.signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);

    // The first page navigates while its upload is stalled on the node.
    pages[0].guest.commit(`${KEY_A}/1?next`);
    expect(await running[0]).toEqual({ gone: true });
    await flush();
    expect(mockNode.signals[0].aborted).toBe(true);
    // Released: the record, its charge and its turn, which the third gets.
    expect(typeof (await third).ticket).toBe('string');
    expect(env.requests.stats()).toMatchObject({ turns: 2, waiting: 0, records: 1 });

    // Main's deadline for the second, a rule-answered upload no prompt
    // stopped, while it stalls.
    env.fire(300_000);
    expect(await running[1]).toEqual({ error: { code: -32603, message: 'Request timed out' } });
    await flush();
    expect(mockNode.signals[1].aborted).toBe(true);
    expect(env.requests.stats()).toMatchObject({ turns: 1, records: 0 });
    gate.release();
  });

  test.each(['swarm_publishData', 'swarm_publishFiles'])('PRQ-2\'s ticket tests for %s: spent once, bound to its document, method and bytes, released when its document goes or after 30 s unused', async (method) => {
    const env = setup();
    await connect(KEY_A, { publishRule: true });
    const page = env.tab();
    const other = env.tab(`${KEY_A}/other`, { front: false });
    const bytes = 1 * MiB + 4 * KiB;
    const params = paramsOfSize(page, method, bytes);
    const freed = () => env.requests.stats().browser.bytes === 0;

    // Presented twice: after it was served, and after it was refused.
    let { ticket } = await page.reserve(method, bytes);
    expect(await page.ask(method, params, ticket)).toEqual(method === 'swarm_publishData' ? UPLOADS[0][2] : UPLOADS[1][2]);
    expect(await page.ask(method, params, ticket)).toEqual(LIMIT);
    ({ ticket } = await page.reserve(method, bytes));
    expect((await page.ask(method, { ...params, files: 'nope', data: undefined }, ticket)).error).toBeDefined();
    expect(await page.ask(method, params, ticket)).toEqual(LIMIT);
    expect(freed()).toBe(true);

    // Another document of the same guest, another guest, another method,
    // more bytes than reserved: refused, burnt, its charge and turn freed.
    ({ ticket } = await page.reserve(method, bytes));
    page.guest.commit(`${KEY_A}/app?again`);
    const again = env.greet(page.guest);
    expect(await again.ask(method, paramsOfSize(again, method, bytes), ticket)).toEqual(LIMIT);
    ({ ticket } = await again.reserve(method, bytes));
    expect(await other.ask(method, paramsOfSize(other, method, bytes), ticket)).toEqual(LIMIT);
    ({ ticket } = await again.reserve(method, bytes));
    const otherMethod = method === 'swarm_publishData' ? 'swarm_publishFiles' : 'swarm_publishData';
    expect(await again.ask(otherMethod, paramsOfSize(again, otherMethod, bytes), ticket)).toEqual(LIMIT);
    ({ ticket } = await again.reserve(method, bytes));
    expect(await again.ask(method, paramsOfSize(again, method, bytes + 1), ticket)).toEqual(LIMIT);
    expect(freed()).toBe(true);
    expect(mockNode.uploads).toHaveLength(1);

    // A granted ticket goes when its document goes, and after 30 s unused.
    ({ ticket } = await again.reserve(method, bytes));
    again.guest.commit(`${KEY_A}/app?third`);
    const third = env.greet(again.guest);
    expect(freed()).toBe(true);
    expect(await third.ask(method, paramsOfSize(third, method, bytes), ticket)).toEqual(LIMIT);
    ({ ticket } = await third.reserve(method, bytes));
    env.fire(30_000);
    expect(freed()).toBe(true);
    expect(await third.ask(method, paramsOfSize(third, method, bytes), ticket)).toEqual(LIMIT);
    expect(mockNode.uploads).toHaveLength(1);
  });
});

describe('the chrome\'s grant writes (0011 PRQ-7c, "Grants")', () => {
  const invoke = (channel, ...args) => mockIpcHandlers[channel]({}, ...args);

  test('swarm:set-auto-approve refused for turning publishing\'s rule on, accepted for turning it off', async () => {
    await connect(KEY_A);
    for (const enabled of [true, 1, 'yes', null]) {
      expect(() => invoke('swarm:set-auto-approve', KEY_A, 'publish', enabled)).toThrow(
        'Publish auto-approve is turned on only from a publish prompt'
      );
    }
    expect(permissions.getAutoApprove(KEY_A, 'publish')).toBe(false);
    await permissions.setAutoApprove(KEY_A, 'publish', true, { page: testPage(KEY_A) });
    expect(await invoke('swarm:set-auto-approve', KEY_A, 'publish', false)).toBe(true);
    expect(permissions.getAutoApprove(KEY_A, 'publish')).toBe(false);
  });

  test('the chrome has no route to publish for any site: swarm:provider-execute is gone (PRQ-7d)', async () => {
    expect(mockIpcHandlers['swarm:provider-execute']).toBeUndefined();
    expect(mockNode.uploads).toEqual([]);
    expect(mockHistory).toEqual([]);
  });
});
