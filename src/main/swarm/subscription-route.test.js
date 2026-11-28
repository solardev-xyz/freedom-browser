/**
 * Question 4 on the JS backend (freedom-core design 0015, Messaging,
 * decided 2026-11-24; SWM-6 to SWM-9's plan, point 10): a page's
 * `swarm_subscribe` through swarm-provider-ipc, the real subscription
 * registry and messaging-service's real socket, with a spy on the
 * `WebSocket` constructor and the session's `resolveProxy` scripted.
 * - A node not on loopback that the session reaches through a proxy or
 *   Arti's endpoint, or an onion node: 4900 `Node not available:
 *   proxy-or-tor`, and no socket (nor the probe, which would go around
 *   them too).
 * - The route tested again just before the open: a proxy that comes on
 *   after the first check refuses.
 * - A proxy that comes on ends an open subscription, with no reconnect: at
 *   Tor's or the node's change, at the 30 s recheck, at a reconnect.
 * - A node on loopback still subscribes with a proxy on.
 */

const mockResolveProxy = jest.fn();
jest.mock('electron', () => ({
  ipcMain: { handle: () => {}, removeHandler: () => {} },
  session: { defaultSession: { resolveProxy: (url) => mockResolveProxy(url) } },
}));
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockOnRevoke = jest.fn();
jest.mock('./swarm-permissions', () => ({
  getPermission: () => ({ origin: 'myapp.eth', connectedAt: 1, lastUsed: 1, autoApprove: {} }),
  hasMessagingGrant: () => true,
  onRevoke: (listener) => mockOnRevoke(listener),
}));

const mockServices = { url: null, tor: null, listeners: [] };
jest.mock('../service-registry', () => ({
  getAntApiUrl: () => mockServices.url,
  getService: (name) => (name === 'tor' ? mockServices.tor : null),
  onServiceChange: (listener) => mockServices.listeners.push(listener),
}));

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

const { Topic } = require('@ethersphere/bee-js');
const registry = require('./subscription-registry');
const { registerSwarmProviderIpc, executeSwarmMethod } = require('./swarm-provider-ipc');

const ORIGIN = 'myapp.eth';
const REMOTE = 'https://ant.example:1633';
const LOOPBACK = 'http://127.0.0.1:1633';
const ARTI = '127.0.0.1:19150';
const TOPIC = 'room:lobby';
const TOPIC_HEX = Topic.fromString(TOPIC).toHex();

/** Node's WebSocket, as messaging-service drives it. */
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
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
}
FakeWebSocket.made = [];

let WebSocketSpy;
let proxy;

function page(document = '7:1') {
  const deliverTo = jest.fn(async () => ({ ok: true }));
  return {
    deliverTo,
    meta: { page: { document, deliverTo, effect: async (run) => ({ value: await run() }) } },
  };
}

function subscribe(meta, params = { kind: 'pss', topic: TOPIC }) {
  return executeSwarmMethod('swarm_subscribe', params, ORIGIN, meta);
}

/** Subscribes and lets its socket establish (the 500 ms grace). */
async function subscribed(meta) {
  const pending = subscribe(meta);
  await jest.advanceTimersByTimeAsync(0);
  const socket = FakeWebSocket.made[FakeWebSocket.made.length - 1];
  socket.open();
  await jest.advanceTimersByTimeAsync(600);
  const out = await pending;
  expect(out.result).toMatchObject({ kind: 'pss', key: TOPIC_HEX });
  return { out, socket };
}

const UNAVAILABLE = {
  error: {
    code: 4900,
    message: 'Node not available: proxy-or-tor',
    data: { reason: 'proxy-or-tor' },
  },
};

beforeAll(() => {
  registerSwarmProviderIpc();
});

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  FakeWebSocket.made = [];
  WebSocketSpy = jest.fn((url) => new FakeWebSocket(url));
  global.WebSocket = WebSocketSpy;
  proxy = 'DIRECT';
  mockResolveProxy.mockReset();
  mockResolveProxy.mockImplementation(async () => proxy);
  mockServices.url = REMOTE;
  mockServices.tor = null;
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) }));
});

afterEach(() => {
  registry.cancelByOrigin(ORIGIN);
  jest.useRealTimers();
  delete global.WebSocket;
});

describe('question 4 on the JS backend: refused before any socket', () => {
  test('a remote node behind a proxy: 4900 proxy-or-tor, no socket, no probe', async () => {
    proxy = 'PROXY proxy.example:8080';
    expect(await subscribe(page().meta)).toEqual(UNAVAILABLE);
    expect(WebSocketSpy).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockResolveProxy).toHaveBeenCalledWith(REMOTE);
    expect(registry.countByOrigin(ORIGIN)).toBe(0);
  });

  test("a remote node behind Arti's endpoint: the same", async () => {
    mockServices.tor = { socks: ARTI };
    proxy = `SOCKS5 ${ARTI}`;
    expect(await subscribe(page().meta)).toEqual(UNAVAILABLE);
    expect(WebSocketSpy).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('an onion node: refused, whatever the proxy says, its name never handed to a socket', async () => {
    mockServices.url = 'http://abcdefghijklmnop.onion';
    expect(await subscribe(page().meta)).toEqual(UNAVAILABLE);
    expect(WebSocketSpy).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('checked again just before the open: a proxy turned on after the first check refuses', async () => {
    mockResolveProxy.mockResolvedValueOnce('DIRECT').mockResolvedValue('PROXY proxy.example:8080');
    expect(await subscribe(page().meta)).toEqual(UNAVAILABLE);
    // The first check passed and the probe went; the open was refused.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockResolveProxy).toHaveBeenCalledTimes(2);
    expect(WebSocketSpy).not.toHaveBeenCalled();
    expect(registry.countByOrigin(ORIGIN)).toBe(0);
  });

  test('a loopback node still subscribes with a proxy on, its proxy never asked', async () => {
    mockServices.url = LOOPBACK;
    proxy = 'PROXY proxy.example:8080';
    const { socket } = await subscribed(page().meta);
    expect(socket.url).toBe(`ws://127.0.0.1:1633/pss/subscribe/${TOPIC_HEX}`);
    expect(mockResolveProxy).not.toHaveBeenCalled();
    // Nor tested every 30 s.
    await jest.advanceTimersByTimeAsync(registry.ROUTE_RECHECK_MS * 2);
    expect(mockResolveProxy).not.toHaveBeenCalled();
    expect(registry.countByOrigin(ORIGIN)).toBe(1);
  });

  test('a remote node reached directly subscribes, on the URL it tested', async () => {
    const { socket } = await subscribed(page().meta);
    expect(socket.url).toBe(`wss://ant.example:1633/pss/subscribe/${TOPIC_HEX}`);
    expect(WebSocketSpy).toHaveBeenCalledTimes(1);
  });
});

describe('question 4 on the JS backend: a proxy that comes on ends what is open', () => {
  test("at Tor's or the node's change: ended, closed, never reconnected", async () => {
    const { socket } = await subscribed(page().meta);
    proxy = 'PROXY proxy.example:8080';
    // A status message is no change of route; Tor's state is.
    for (const listener of mockServices.listeners) listener('ipfs');
    await jest.advanceTimersByTimeAsync(0);
    expect(registry.countByOrigin(ORIGIN)).toBe(1);
    for (const listener of mockServices.listeners) listener('tor');
    await jest.advanceTimersByTimeAsync(0);
    expect(registry.countByOrigin(ORIGIN)).toBe(0);
    expect(socket.closed).toEqual([1000]);
    socket.drop(1000);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(WebSocketSpy).toHaveBeenCalledTimes(1);
  });

  test('at the 30 s recheck, with no event', async () => {
    const { socket } = await subscribed(page().meta);
    proxy = 'PROXY proxy.example:8080';
    await jest.advanceTimersByTimeAsync(registry.ROUTE_RECHECK_MS - 1000);
    expect(registry.countByOrigin(ORIGIN)).toBe(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(registry.countByOrigin(ORIGIN)).toBe(0);
    expect(socket.closed).toEqual([1000]);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(WebSocketSpy).toHaveBeenCalledTimes(1);
  });

  test('at a reconnect: tested before it dials, and refused, it dials no more', async () => {
    const { socket } = await subscribed(page().meta);
    // A drop on a route that holds reconnects.
    socket.drop();
    await jest.advanceTimersByTimeAsync(1000);
    expect(WebSocketSpy).toHaveBeenCalledTimes(2);
    proxy = 'PROXY proxy.example:8080';
    FakeWebSocket.made[1].open();
    await jest.advanceTimersByTimeAsync(600);
    FakeWebSocket.made[1].drop();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(WebSocketSpy).toHaveBeenCalledTimes(2);
    expect(registry.countByOrigin(ORIGIN)).toBe(0);
  });

  test("an ended subscription's page gets no more messages, and a new subscribe is refused", async () => {
    const { deliverTo, meta } = page();
    const { socket } = await subscribed(meta);
    proxy = 'PROXY proxy.example:8080';
    await registry.recheckRoutes();
    socket.onmessage?.({ data: new TextEncoder().encode('late').buffer });
    await jest.advanceTimersByTimeAsync(0);
    expect(deliverTo).not.toHaveBeenCalled();
    expect(await subscribe(meta)).toEqual(UNAVAILABLE);
    expect(WebSocketSpy).toHaveBeenCalledTimes(1);
  });
});
