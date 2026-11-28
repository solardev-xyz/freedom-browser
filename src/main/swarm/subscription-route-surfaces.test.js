/**
 * Question 4's surfaces end to end in main (freedom-core design 0015,
 * Messaging, decided 2026-11-24 with the user told whenever it applies;
 * SWM-7's PR 7.5): a page's `swarm_subscribe` through swarm-provider-ipc,
 * the real subscription registry, messaging-service's real socket and the
 * real notices, with the session's `resolveProxy` scripted and the browser
 * windows faked.
 * - A refused subscription and one a proxy ended each tell the window the
 *   user is in, once per site per session; a new session tells it again.
 * - The Nodes panel's and Settings' line (`swarm:messages-route-get`) shows
 *   only for a remote external node with a proxy or Tor on, never for an
 *   external node on loopback or the bundled node, and follows Tor and the
 *   node (pushed to every browser window).
 */

const mockResolveProxy = jest.fn();
const mockIpcHandlers = {};
const mockWindows = { all: [], focused: null };
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, handler) => {
      mockIpcHandlers[channel] = handler;
    },
    removeHandler: () => {},
  },
  session: { defaultSession: { resolveProxy: (url) => mockResolveProxy(url) } },
  BrowserWindow: { getFocusedWindow: () => mockWindows.focused },
}));
jest.mock('../windows/mainWindow', () => ({
  isMainBrowserWindow: (win) => mockWindows.all.includes(win),
  getLastFocusedMainWindow: () => mockWindows.all[mockWindows.all.length - 1] ?? null,
  getMainWindows: () => [...mockWindows.all],
}));
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.mock('./swarm-permissions', () => ({
  getPermission: (origin) => ({ origin, connectedAt: 1, lastUsed: 1, autoApprove: {} }),
  hasMessagingGrant: () => true,
  onRevoke: () => {},
}));

const mockServices = { url: null, tor: null, listeners: [] };
jest.mock('../service-registry', () => ({
  getAntApiUrl: () => mockServices.url,
  getService: (name) => (name === 'tor' ? mockServices.tor : null),
  onServiceChange: (listener) => mockServices.listeners.push(listener),
}));
jest.mock('../ant-manager', () => ({ restartingUrl: () => null }));

// The provider's other collaborators, which a subscribe never reaches.
jest.mock('./publish-setup-service', () => ({ getPublishReadiness: jest.fn() }));
jest.mock('./publish-service', () => ({}));
jest.mock('./feed-service', () => ({ buildTopicString: jest.fn() }));
jest.mock('./feed-store', () => ({}));
jest.mock('./chunk-service', () => ({}));
jest.mock('./publish-history', () => ({}));
jest.mock('./swarm-signer', () => ({}));
jest.mock('./gsoc-miner', () => ({ mineSigner: jest.fn(), joinJob: jest.fn() }));
jest.mock('../vault-timer', () => ({ resetVaultAutoLockTimer: jest.fn() }));

const IPC = require('../../shared/ipc-channels');

const REMOTE = 'https://ant.example:1633';
const LOOPBACK = 'http://127.0.0.1:1633';
const BUNDLED = 'http://127.0.0.1:11633';
const ONION = 'http://abcdefghijklmnop.onion';
const ARTI = '127.0.0.1:19150';
const PROXY = 'PROXY proxy.example:8080';
const TOPIC = 'room:lobby';

const notice = (site, what) =>
  `Live messages from ${site} are off while ${what} is on: they would go around it to your external Swarm node`;
const lines = (what) => ({
  panel: `Live messages are off while ${what} is on: they would go around it to your external node`,
  settings: `Live messages are off while ${what} is on: they would go around it to your external node.`,
});
const ONION_LINES = {
  panel: "Live messages are off: your external node is an .onion address, and they can't go through Tor",
  settings: "Live messages are off: your external node is an .onion address, and they can't go through Tor.",
};
const NO_LINES = { panel: null, settings: null };

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.closed = [];
    FakeWebSocket.made.push(this);
  }
  close(code) {
    this.closed.push(code);
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}
FakeWebSocket.made = [];

function fakeWindow() {
  return { webContents: { send: jest.fn(), isDestroyed: () => false }, isDestroyed: () => false };
}

// What was sent on a channel; a route push's revision left out (it orders replies, ant-ui.js).
const sent = (win, channel) =>
  win.webContents.send.mock.calls
    .filter(([name]) => name === channel)
    .map(([, payload]) => {
      if (channel !== IPC.SWARM_MESSAGES_ROUTE) return payload;
      const { revision: _revision, ...rest } = payload;
      return rest;
    });

/** A browser session: the provider and its registry loaded afresh, and wired. */
function startSession() {
  let loaded;
  mockServices.listeners = [];
  jest.isolateModules(() => {
    const registry = require('./subscription-registry');
    const provider = require('./swarm-provider-ipc');
    provider.registerSwarmProviderIpc();
    loaded = { registry, provider };
  });
  return loaded;
}

let app;
let proxy;

function page(document = '7:1') {
  const deliverTo = jest.fn(async () => ({ ok: true }));
  return { page: { document, deliverTo, effect: async (run) => ({ value: await run() }) } };
}

function subscribe(origin = 'myapp.eth', document = '7:1') {
  return app.provider.executeSwarmMethod('swarm_subscribe', { kind: 'pss', topic: TOPIC }, origin, page(document));
}

async function subscribed(origin = 'myapp.eth') {
  const pending = subscribe(origin);
  await jest.advanceTimersByTimeAsync(0);
  FakeWebSocket.made[FakeWebSocket.made.length - 1].open();
  await jest.advanceTimersByTimeAsync(600);
  const out = await pending;
  expect(out.result).toMatchObject({ kind: 'pss' });
  return out;
}

async function serviceChanged(name) {
  for (const listener of mockServices.listeners) listener(name);
  await jest.advanceTimersByTimeAsync(0);
}

const notices = (win) => sent(win, IPC.SWARM_MESSAGES_NOTICE);

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  FakeWebSocket.made = [];
  global.WebSocket = jest.fn((url) => new FakeWebSocket(url));
  proxy = 'DIRECT';
  mockResolveProxy.mockReset();
  mockResolveProxy.mockImplementation(async () => proxy);
  mockServices.url = REMOTE;
  mockServices.tor = null;
  mockWindows.all = [fakeWindow(), fakeWindow()];
  mockWindows.focused = mockWindows.all[0];
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) }));
  app = startSession();
});

afterEach(() => {
  app.registry._reset();
  jest.useRealTimers();
  delete global.WebSocket;
});

describe('the notice, once per site per session', () => {
  test('a refused subscription tells the window the user is in, once', async () => {
    proxy = PROXY;
    expect((await subscribe()).error).toMatchObject({ code: 4900, data: { reason: 'proxy-or-tor' } });
    expect((await subscribe('myapp.eth', '7:2')).error).toMatchObject({ code: 4900 });
    expect(notices(mockWindows.all[0])).toEqual([
      { site: 'myapp.eth', text: notice('myapp.eth', 'your proxy') },
    ]);
    expect(notices(mockWindows.all[1])).toEqual([]);
    expect(global.WebSocket).not.toHaveBeenCalled();
  });

  test("refused behind Arti's endpoint: it names Tor", async () => {
    mockServices.tor = { socks: ARTI };
    proxy = `SOCKS5 ${ARTI}`;
    await subscribe();
    expect(notices(mockWindows.all[0])).toEqual([{ site: 'myapp.eth', text: notice('myapp.eth', 'Tor') }]);
  });

  test('refused just before the open (a proxy came on after the first check): told once', async () => {
    mockResolveProxy.mockResolvedValueOnce('DIRECT').mockResolvedValue(PROXY);
    expect((await subscribe()).error).toMatchObject({ code: 4900, data: { reason: 'proxy-or-tor' } });
    expect(notices(mockWindows.all[0])).toEqual([
      { site: 'myapp.eth', text: notice('myapp.eth', 'your proxy') },
    ]);
  });

  test('a subscription a proxy ended tells it once, and a refusal after it says nothing more', async () => {
    await subscribed();
    expect(notices(mockWindows.all[0])).toEqual([]);
    proxy = PROXY;
    await serviceChanged('tor');
    expect(app.registry.countByOrigin('myapp.eth')).toBe(0);
    expect(notices(mockWindows.all[0])).toEqual([
      { site: 'myapp.eth', text: notice('myapp.eth', 'your proxy') },
    ]);
    expect((await subscribe('myapp.eth', '7:2')).error).toMatchObject({ code: 4900 });
    expect(notices(mockWindows.all[0])).toHaveLength(1);
  });

  test('ended by the 30 s recheck: told once, in the window the user is in now', async () => {
    await subscribed();
    await subscribed('other.eth');
    mockWindows.focused = null; // focus elsewhere: the window focused last
    proxy = PROXY;
    await jest.advanceTimersByTimeAsync(app.registry.ROUTE_RECHECK_MS);
    expect(notices(mockWindows.all[1]).map(({ site }) => site).sort()).toEqual(['myapp.eth', 'other.eth']);
    expect(notices(mockWindows.all[0])).toEqual([]);
  });

  test('each site is told once', async () => {
    proxy = PROXY;
    await subscribe('a.eth');
    await subscribe('b.eth');
    await subscribe('a.eth', '7:2');
    expect(notices(mockWindows.all[0]).map(({ site }) => site)).toEqual(['a.eth', 'b.eth']);
  });

  test('a new browser session tells the site again, once', async () => {
    proxy = PROXY;
    await subscribe();
    app.registry._reset();
    app = startSession();
    await subscribe();
    await subscribe('myapp.eth', '7:2');
    expect(notices(mockWindows.all[0])).toEqual([
      { site: 'myapp.eth', text: notice('myapp.eth', 'your proxy') },
      { site: 'myapp.eth', text: notice('myapp.eth', 'your proxy') },
    ]);
  });

  test('an onion node with Tor off: refused, and told so without saying Tor is on (Codex round 1)', async () => {
    mockServices.url = ONION;
    expect((await subscribe()).error).toMatchObject({ code: 4900, data: { reason: 'proxy-or-tor' } });
    expect(global.WebSocket).not.toHaveBeenCalled();
    expect(notices(mockWindows.all[0])).toEqual([
      {
        site: 'myapp.eth',
        text: "Live messages from myapp.eth are off: your external Swarm node is an .onion address, and they can't go through Tor",
      },
    ]);
  });

  test('a node on loopback still subscribes with a proxy on, and nobody is told anything', async () => {
    mockServices.url = LOOPBACK;
    proxy = PROXY;
    await subscribed();
    await serviceChanged('tor');
    await jest.advanceTimersByTimeAsync(app.registry.ROUTE_RECHECK_MS);
    expect(notices(mockWindows.all[0])).toEqual([]);
    expect(app.registry.countByOrigin('myapp.eth')).toBe(1);
  });
});

describe("the Nodes panel's and Settings' line", () => {
  const read = () => mockIpcHandlers[IPC.SWARM_MESSAGES_ROUTE_GET]();

  test.each([
    ['a remote external node behind a proxy', REMOTE, PROXY, null, lines('your proxy')],
    ["a remote external node behind Arti's endpoint", REMOTE, `SOCKS5 ${ARTI}`, { socks: ARTI }, lines('Tor')],
    ['a remote external node reached directly', REMOTE, 'DIRECT', { socks: ARTI }, NO_LINES],
    ['an external node on loopback, a proxy on', LOOPBACK, PROXY, null, NO_LINES],
    ['an external node on loopback, Tor on', LOOPBACK, `SOCKS5 ${ARTI}`, { socks: ARTI }, NO_LINES],
    ['the bundled node, a proxy on', BUNDLED, PROXY, null, NO_LINES],
    ['the bundled node, Tor on', BUNDLED, `SOCKS5 ${ARTI}`, { socks: ARTI }, NO_LINES],
    ["an onion node behind Arti's endpoint", ONION, `SOCKS5 ${ARTI}`, { socks: ARTI }, lines('Tor')],
    ['an onion node, DIRECT, with no Tor endpoint', ONION, 'DIRECT', null, ONION_LINES],
  ])('%s', async (_case, url, answer, tor, expected) => {
    mockServices.url = url;
    mockServices.tor = tor;
    proxy = answer;
    expect(await read()).toMatchObject(expected);
  });

  test('a slow read, then a newer push, then the slow read lands: it answers its own older revision', async () => {
    let answer;
    mockResolveProxy.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    // The panel opens and reads; its read waits on resolveProxy.
    const slow = read();
    await Promise.resolve();
    expect(typeof answer).toBe('function');
    // A proxy comes on and the node changes: the newer read pushes.
    proxy = PROXY;
    await serviceChanged('ant');
    expect(sent(mockWindows.all[0], IPC.SWARM_MESSAGES_ROUTE)).toEqual([lines('your proxy')]);
    const pushed = mockWindows.all[0].webContents.send.mock.calls
      .filter(([name]) => name === IPC.SWARM_MESSAGES_ROUTE)
      .map(([, payload]) => payload.revision);
    // The slow read's own answer (DIRECT, from before) lands last, with its
    // own, older revision: the panel drops it (ant-ui.js), and main pushes nothing.
    answer('DIRECT');
    const late = await slow;
    expect(late).toMatchObject(NO_LINES);
    expect(late.revision).toBeLessThan(pushed.at(-1));
    expect(sent(mockWindows.all[0], IPC.SWARM_MESSAGES_ROUTE)).toEqual([lines('your proxy')]);
  });

  test('it follows Tor, the proxy and the node, pushed to every browser window', async () => {
    const pushes = (win) => sent(win, IPC.SWARM_MESSAGES_ROUTE);
    await serviceChanged('ant');
    // Tor comes on and takes the node's route.
    mockServices.tor = { socks: ARTI };
    proxy = `SOCKS5 ${ARTI}`;
    await serviceChanged('tor');
    // Another service's change reads nothing new.
    proxy = PROXY;
    await serviceChanged('ipfs');
    // The node moves to loopback.
    mockServices.url = LOOPBACK;
    await serviceChanged('ant');
    // A proxy comes on with no event, and the node moves back: a surface's
    // next read finds it, and every window hears.
    mockServices.url = REMOTE;
    expect(await read()).toMatchObject(lines('your proxy'));
    // Tor off, no proxy.
    mockServices.tor = null;
    proxy = 'DIRECT';
    await serviceChanged('tor');
    // The bundled node, a proxy on.
    mockServices.url = BUNDLED;
    proxy = PROXY;
    await serviceChanged('ant');
    for (const win of mockWindows.all) {
      expect(pushes(win)).toEqual([NO_LINES, lines('Tor'), NO_LINES, lines('your proxy'), NO_LINES]);
    }
  });
});
