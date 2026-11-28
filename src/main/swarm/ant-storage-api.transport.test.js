/**
 * ant-storage-api's calls on the node's transport (freedom-core design 0015,
 * The transport: main's own reads move onto it in SWM-8, closing F-6 for
 * them; the SWM-6 to SWM-9 plan, PR 8.1). What every caller sees is pinned in
 * `ant-storage-api.test.js`; here, how each call goes out.
 *
 * A remote node: the real Ant backend (`antBackend()`), the real
 * announcements and Ant API guard, the real write sessions, and Chromium's
 * stack as `netGatewayFetch` drives it, over a fake `net.request`
 * (`test/helpers/fake-electron-net.js`) and fake sessions that answer their
 * proxy and run their guards as Chromium's `onBeforeRequest` would. A
 * loopback node: real HTTP with Node's `fetch`. That a write goes once
 * through a real session's proxy is shown by a real Electron process
 * (`__tests__/integration/swarm-post-proxy.test.js`).
 */

const mockRegistry = { url: null };
jest.mock('../service-registry', () => ({
  DEFAULTS: { ant: { apiPort: 1633 } },
  MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', REUSED: 'reused' },
  getAntApiUrl: () => mockRegistry.url,
  getService: () => ({ mode: 'external' }),
}));
jest.mock('../core/dweb-verify', () => ({ dwebVerifier: () => null }));
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Chromium, as these tests play it: each `net.request` is handed to
// `mockChromium.onDial` once it is ended, with the session it went out on.
// `events` orders each session's connection closes and dials. `writeSession`
// makes a write session misbehave: `readBack`, the proxy it resolves whatever
// it was set to; `setProxy` or `closeAllConnections`, an error its next such
// call fails with.
const mockChromium = { onDial: null, events: [], writeSession: {} };
const mockWriteSessions = [];
const mockDefaultSession = {
  name: 'default',
  proxy: 'DIRECT',
  resolveProxy: jest.fn(async () => mockDefaultSession.proxy),
};
// The publish setup's own suite mocks the node's routes; here it runs on
// the real calls, so only swarm-service's bee-js client is left out.
jest.mock('./swarm-service', () => {
  const { isUsableStamp, isPendingStamp, isPropagatingStamp, isFullImmutableStamp } =
    jest.requireActual('./swarm-service');
  return { isUsableStamp, isPendingStamp, isPropagatingStamp, isFullImmutableStamp };
});
jest.mock('electron', () => {
  const { FakeClientRequest } = jest.requireActual('../../../test/helpers/fake-electron-net');
  return {
    ipcMain: { handle: jest.fn() },
    webContents: { getAllWebContents: () => [] },
    net: {
      request: (options) => {
        const request = new FakeClientRequest(options);
        const ses = options.session || mockDefaultSession;
        mockChromium.events.push(`dial ${ses.name}`);
        setImmediate(() => mockChromium.onDial(request, ses));
        return request;
      },
    },
    session: {
      get defaultSession() {
        return mockDefaultSession;
      },
      fromPartition: (partition) => {
        let proxy = 'DIRECT';
        const ses = {
          name: partition,
          guard: null,
          webRequest: { onBeforeRequest: (listener) => (ses.guard = listener) },
          setSpellCheckerLanguages: jest.fn(),
          setSpellCheckerEnabled: jest.fn(),
          setProxy: jest.fn(async ({ pacScript }) => {
            const failure = mockChromium.writeSession.setProxy;
            if (failure) {
              delete mockChromium.writeSession.setProxy;
              throw failure;
            }
            const script = Buffer.from(pacScript.split(',')[1], 'base64').toString('utf-8');
            proxy = JSON.parse(script.match(/return (".*");/)[1]);
          }),
          forceReloadProxyConfig: jest.fn(async () => {}),
          closeAllConnections: jest.fn(async () => {
            const failure = mockChromium.writeSession.closeAllConnections;
            if (failure) {
              delete mockChromium.writeSession.closeAllConnections;
              throw failure;
            }
            mockChromium.events.push(`close ${partition}`);
          }),
          resolveProxy: jest.fn(async () => mockChromium.writeSession.readBack ?? proxy),
        };
        mockWriteSessions.push(ses);
        return ses;
      },
    },
  };
});

const { emitResponse } = require('../../../test/helpers/fake-electron-net');
const {
  closedLoopbackPort,
  startFakeHttpNode,
  waitFor,
} = require('../../../test/helpers/fake-http-node');
const api = require('./ant-storage-api');
const { MAX_WRITE_SESSIONS } = require('./ant-write-sessions');
const { isMainProcessAntDial } = require('./ant-api-main-dials');
const { guardAntApiRequest, noteAntApiUrl, _resetAntApiGuardForTests } = require('./ant-api-guard');

const REMOTE = 'https://ant.example:1633';
const SOCKS = 'SOCKS5 127.0.0.1:9150';

// Every call, with the options its last argument takes.
const CALLS = [
  ['getHealth', (o) => api.getHealth(o)],
  ['getNode', (o) => api.getNode(o)],
  ['getReadiness', (o) => api.getReadiness(o)],
  ['getStamps', (o) => api.getStamps(o)],
  ['getAddresses', (o) => api.getAddresses(o)],
  ['getWallet', (o) => api.getWallet(o)],
  ['getChequebookAddress', (o) => api.getChequebookAddress(o)],
  ['getChequebookBalance', (o) => api.getChequebookBalance(o)],
  ['getSettlements', (o) => api.getSettlements(o)],
  ['getStorageQuote', (o) => api.getStorageQuote({ depth: 20, days: 30 }, o)],
  ['getSettlementDeposit', (o) => api.getSettlementDeposit(o)],
  ['buyStorage', (o) => api.buyStorage({ depth: 20, amountPerChunk: '65676' }, o)],
  ['extendStorage', (o) => api.extendStorage({ batchId: 'ab', amountPerChunk: '9', depth: 22 }, o)],
  ['topUpSettlementDeposit', (o) => api.topUpSettlementDeposit({ amountPlur: '1000' }, o)],
  ['setSwapEnabled', (o) => api.setSwapEnabled(true, o)],
];

// What the node answers: the request it took, echoed.
const echo = ({ method, path, body }) => ({ method, path, body: body || null });

/** Whether a write session's own guard lets `method` to `url` through. */
const writeGuardSends = (ses, method, url) =>
  new Promise((resolve) =>
    ses.guard({ method, url, resourceType: 'other' }, ({ cancel }) => resolve(!cancel))
  );

/** Whether the request session's Ant guard lets main's frameless `method` to `url` through. */
const sessionGuardSends = (method, url) =>
  guardAntApiRequest({ method, url, resourceType: 'other' }) === null;

/**
 * Chromium's side of each dial: the session's `onBeforeRequest` (the Ant
 * guard on the request session, its own on a write session), then
 * `answer(dial)`: `{ status, json }`, `{ error }` (a net error), `{ stall }`
 * (headers and a first chunk, then nothing; with `abort`, then the node
 * cuts the connection) or null (no answer at all).
 * `during(dial)` runs while the dial is in flight. Every dial is recorded.
 */
function playChromium({ answer = (dial) => ({ status: 200, json: echo(dial) }), during } = {}) {
  const dials = [];
  mockChromium.onDial = async (request, ses) => {
    const { method, url } = request.options;
    const admitted =
      ses === mockDefaultSession
        ? sessionGuardSends(method, url)
        : await writeGuardSends(ses, method, url);
    const dial = {
      method,
      path: url.slice(mockRegistry.url.length),
      on: ses === mockDefaultSession ? 'session' : 'write session',
      session: ses,
      proxy: await ses.resolveProxy(url),
      admitted,
      contentType: request.sentHeaders['Content-Type'] || null,
      body: request.written.length ? Buffer.concat(request.written).toString('utf8') : null,
      request,
    };
    dials.push(dial);
    if (!admitted) {
      request.emit('error', new Error('net::ERR_BLOCKED_BY_CLIENT'));
      return;
    }
    if (during) await during(dial);
    const reply = answer(dial);
    if (!reply) return;
    if (reply.error) {
      request.emit('error', new Error(reply.error));
      return;
    }
    if (reply.stall) {
      const response = emitResponse(request, { status: 200, chunks: [reply.stall], end: false });
      // Chromium's `aborted` on the response: the connection closed mid-body.
      if (reply.abort) setImmediate(() => response.emit('aborted'));
      return;
    }
    emitResponse(request, {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
      chunks: [JSON.stringify(reply.json)],
    });
  };
  return dials;
}

// Node's fetch, which a remote node's calls must never use.
const noLoopbackDial = () =>
  jest.fn(async () => {
    throw new Error('no loopback dial expected');
  });

beforeEach(() => {
  mockRegistry.url = REMOTE;
  mockDefaultSession.proxy = SOCKS;
  mockDefaultSession.resolveProxy.mockClear();
  mockChromium.events.length = 0;
  mockChromium.writeSession = {};
  mockChromium.onDial = () => {
    throw new Error('no dial expected');
  };
  _resetAntApiGuardForTests();
  noteAntApiUrl(REMOTE);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a remote node: every call on the default session’s stack, through its proxy', () => {
  test('reads on the session, announced; writes on write sessions; the same results as the loopback path', async () => {
    // The loopback path: Node's fetch, answering as the node does.
    mockRegistry.url = 'http://127.0.0.1:1633';
    const fetchImpl = jest.fn(async (url, init) => {
      const body = init.body ? new TextDecoder().decode(init.body) : null;
      const path = url.slice(mockRegistry.url.length);
      return new Response(JSON.stringify(echo({ method: init.method, path, body })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const loopback = [];
    for (const [, call] of CALLS) loopback.push(await call({ fetchImpl }));
    expect(fetchImpl).toHaveBeenCalledTimes(CALLS.length);

    mockRegistry.url = REMOTE;
    const dials = playChromium();
    const unused = noLoopbackDial();
    const remote = [];
    for (const [, call] of CALLS) remote.push(await call({ fetchImpl: unused }));

    expect(remote).toEqual(loopback);
    expect(unused).not.toHaveBeenCalled();
    // One dial a call, each through the session's proxy: a read on the
    // session, which its guard admitted as announced; a write on a write
    // session that mirrors the proxy, which its own guard admitted.
    expect(dials).toHaveLength(CALLS.length);
    expect(
      dials.map(({ method, path, on, proxy, admitted, contentType, body }) => [
        method,
        path,
        on,
        proxy,
        admitted,
        contentType,
        body,
      ])
    ).toEqual([
      ['GET', '/health', 'session', SOCKS, true, null, null],
      ['GET', '/node', 'session', SOCKS, true, null, null],
      ['GET', '/readiness', 'session', SOCKS, true, null, null],
      ['GET', '/stamps', 'session', SOCKS, true, null, null],
      ['GET', '/addresses', 'session', SOCKS, true, null, null],
      ['GET', '/wallet', 'session', SOCKS, true, null, null],
      ['GET', '/chequebook/address', 'session', SOCKS, true, null, null],
      ['GET', '/chequebook/balance', 'session', SOCKS, true, null, null],
      ['GET', '/settlements', 'session', SOCKS, true, null, null],
      ['GET', '/v0/storage/quote?depth=20&days=30', 'session', SOCKS, true, null, null],
      ['GET', '/v0/settlement/deposit', 'session', SOCKS, true, null, null],
      [
        'POST',
        '/v0/storage/buy?depth=20&amountPerChunk=65676&immutable=true',
        'write session',
        SOCKS,
        true,
        null,
        null,
      ],
      [
        'POST',
        '/v0/storage/extend?batchId=ab&amountPerChunk=9&depth=22',
        'write session',
        SOCKS,
        true,
        null,
        null,
      ],
      ['POST', '/v0/settlement/deposit?amount=1000', 'write session', SOCKS, true, null, null],
      [
        'PUT',
        '/v0/settlement/swap',
        'write session',
        SOCKS,
        true,
        'application/json',
        '{"swapEnabled":true}',
      ],
    ]);
    // Each write's session took the request session's proxy for its URL.
    for (const dial of dials.filter((d) => d.on === 'write session')) {
      expect(mockDefaultSession.resolveProxy).toHaveBeenCalledWith(`${REMOTE}${dial.path}`);
    }
    // Nothing stays announced once the calls are over.
    for (const dial of dials) {
      expect(isMainProcessAntDial(`${REMOTE}${dial.path}`, dial.method)).toBe(false);
    }
  });

  test('the guard sees each read: the announced GET passes; another URL, another method, or the same GET after it, doesn’t', async () => {
    const url = `${REMOTE}/settlements`;
    const seen = {};
    playChromium({
      during: () => {
        seen.get = sessionGuardSends('GET', url);
        seen.head = sessionGuardSends('HEAD', url);
        seen.post = sessionGuardSends('POST', url);
        seen.put = sessionGuardSends('PUT', url);
        seen.otherPath = sessionGuardSends('GET', `${REMOTE}/stamps`);
        seen.otherQuery = sessionGuardSends('GET', `${url}?x=1`);
        // A page's request is never main's own, announced or not.
        seen.worker = guardAntApiRequest({ method: 'GET', url, resourceType: 'xhr' }) === null;
      },
    });
    await expect(api.getSettlements()).resolves.toMatchObject({ ok: true, status: 200 });
    expect(seen).toEqual({
      get: true,
      head: false,
      post: false,
      put: false,
      otherPath: false,
      otherQuery: false,
      worker: false,
    });
    expect(sessionGuardSends('GET', url)).toBe(false);
  });

  test.each([
    ['PUT', '/v0/settlement/swap', () => api.setSwapEnabled(false)],
    [
      'POST',
      '/v0/storage/buy?depth=20&amountPerChunk=1&immutable=true',
      () => api.buyStorage({ depth: 20, amountPerChunk: '1' }),
    ],
  ])(
    'a %s is never announced; its write session’s guard admits it once, and nothing else',
    async (method, path, call) => {
      const url = `${REMOTE}${path}`;
      const seen = {};
      const dials = playChromium({
        during: async ({ session }) => {
          seen.onTheSession = sessionGuardSends(method, url);
          seen.again = await writeGuardSends(session, method, url);
          seen.get = await writeGuardSends(session, 'GET', url);
          seen.otherMethod = await writeGuardSends(session, method === 'PUT' ? 'POST' : 'PUT', url);
          seen.otherPath = await writeGuardSends(session, method, `${REMOTE}/stamps/1/17`);
        },
      });
      await expect(call()).resolves.toMatchObject({ ok: true, status: 200 });
      expect(dials).toHaveLength(1);
      expect(dials[0]).toMatchObject({ method, on: 'write session', admitted: true });
      expect(seen).toEqual({
        onTheSession: false,
        again: false,
        get: false,
        otherMethod: false,
        otherPath: false,
      });
    }
  );

  test('a write goes once, on a new connection: a node that hangs up fails it, and it may have landed', async () => {
    let hangUp = true;
    const dials = playChromium({
      answer: (dial) =>
        hangUp ? { error: 'net::ERR_EMPTY_RESPONSE' } : { status: 200, json: echo(dial) },
    });
    const failed = await api.setSwapEnabled(true);
    expect(failed).toEqual({
      ok: false,
      status: 0,
      data: null,
      message: null,
      timedOut: false,
      unreachable: true,
      refused: false,
    });
    expect(api.isUncertainWrite(failed)).toBe(true);
    // Sent once: never again by main, and on a session whose connections
    // were closed just before, so Chromium had none to send it again on.
    expect(dials).toHaveLength(1);
    const first = dials[0].session.name;
    expect(mockChromium.events).toEqual([`close ${first}`, `dial ${first}`]);

    hangUp = false;
    await expect(api.setSwapEnabled(true)).resolves.toMatchObject({ ok: true });
    expect(dials).toHaveLength(2);
    // The next write closes its session's connections again before it dials.
    const second = dials[1].session.name;
    expect(mockChromium.events.slice(2)).toEqual([`close ${second}`, `dial ${second}`]);
  });

  test('a refused connection, an unresolved name or a failed proxy never sent the write; a reset or an empty reply may have', async () => {
    let error = null;
    playChromium({ answer: () => ({ error }) });
    const outcome = async (netError) => {
      error = netError;
      const res = await api.buyStorage({ depth: 20, amountPerChunk: '1' });
      return {
        refused: res.refused,
        unreachable: res.unreachable,
        uncertain: api.isUncertainWrite(res),
      };
    };
    const neverSent = { refused: true, unreachable: true, uncertain: false };
    const maybeSent = { refused: false, unreachable: true, uncertain: true };
    for (const netError of [
      'net::ERR_CONNECTION_REFUSED',
      'net::ERR_NAME_NOT_RESOLVED',
      'net::ERR_ADDRESS_UNREACHABLE',
      'net::ERR_CONNECTION_TIMED_OUT',
      'net::ERR_PROXY_CONNECTION_FAILED',
      'net::ERR_SOCKS_CONNECTION_FAILED',
      'net::ERR_TUNNEL_CONNECTION_FAILED',
    ]) {
      await expect(outcome(netError)).resolves.toEqual(neverSent);
    }
    for (const netError of [
      'net::ERR_CONNECTION_RESET',
      'net::ERR_EMPTY_RESPONSE',
      'net::ERR_CONNECTION_CLOSED',
      'net::ERR_TIMED_OUT',
    ]) {
      await expect(outcome(netError)).resolves.toEqual(maybeSent);
    }
  });

  test('an onion node the session would send DIRECT is never dialled, read or write', async () => {
    mockRegistry.url = 'http://antnode.onion:1633';
    mockDefaultSession.proxy = 'DIRECT';
    const read = await api.getHealth();
    const write = await api.setSwapEnabled(true);
    expect(read).toMatchObject({ status: 0, unreachable: true, refused: true });
    expect(write).toMatchObject({ status: 0, unreachable: true, refused: true });
    expect(api.isUncertainWrite(write)).toBe(false);
    expect(mockChromium.events.filter((e) => e.startsWith('dial'))).toEqual([]);
  });

  test('a redirect is answered, never followed', async () => {
    const dials = [];
    mockChromium.onDial = (request) => {
      dials.push(request.options.url);
      request.emit('redirect', 307, 'POST', 'http://127.0.0.1:1633/stamps/1/17', {
        location: ['http://127.0.0.1:1633/stamps/1/17'],
      });
    };
    await expect(api.buyStorage({ depth: 20, amountPerChunk: '1' })).resolves.toEqual({
      ok: false,
      status: 307,
      data: null,
      message: null,
    });
    expect(dials).toHaveLength(1);
  });
});

// Codex round 1 on #1369, 1: an abort that isn't the call's own deadline.
describe('a reply the node cuts off mid-body', () => {
  const CUT_OFF = {
    ok: false,
    status: 0,
    data: null,
    message: null,
    timedOut: false,
    unreachable: true,
    refused: false,
  };

  test('is unreachable, as undici’s `terminated` was on a loopback node, never a timeout', async () => {
    const dials = playChromium({ answer: () => ({ stall: '{"stamps":[', abort: true }) });
    const remote = await api.getStamps();
    expect(dials).toHaveLength(1);

    const node = await startFakeHttpNode({
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"stamps":[', () => setImmediate(() => res.socket.destroy()));
      },
    });
    mockRegistry.url = node.origin;
    let loopback;
    try {
      loopback = await api.getStamps();
    } finally {
      await node.close();
    }
    expect(remote).toEqual(CUT_OFF);
    expect(loopback).toEqual(CUT_OFF);
  });

  test('a write cut off mid-reply may have landed: uncertain, not timed out', async () => {
    playChromium({ answer: () => ({ stall: '{"swapEnabled":', abort: true }) });
    const res = await api.setSwapEnabled(true);
    expect(res).toEqual(CUT_OFF);
    expect(api.isUncertainWrite(res)).toBe(true);
    expect(api.describeAntError(res)).toBe('Cannot reach the Swarm node.');
  });
});

// Codex round 1 on #1369, 2: a write session that fails before its dial.
describe('a write whose session could not be prepared was never sent', () => {
  const NEVER_SENT = {
    ok: false,
    status: 0,
    data: null,
    message: null,
    timedOut: false,
    unreachable: true,
    refused: true,
  };

  test.each([
    [
      'its write session reads back another proxy than the request session’s',
      () => {
        mockChromium.writeSession.readBack = 'DIRECT';
      },
    ],
    [
      'the request session’s proxy lookup fails',
      () => {
        mockDefaultSession.resolveProxy.mockRejectedValueOnce(new Error('resolveProxy failed'));
      },
    ],
    [
      'setting the write session’s proxy fails',
      () => {
        mockDefaultSession.proxy = 'PROXY 127.0.0.1:3128';
        mockChromium.writeSession.setProxy = new Error('setProxy failed');
      },
    ],
    [
      'closing the write session’s connections fails',
      () => {
        mockChromium.writeSession.closeAllConnections = new Error('closeAllConnections failed');
      },
    ],
  ])('%s: refused, not dialled, never uncertain', async (_case, arrange) => {
    playChromium();
    for (const call of [
      () => api.buyStorage({ depth: 20, amountPerChunk: '1' }),
      () => api.setSwapEnabled(true),
    ]) {
      // Each failure is spent by the call it fails.
      arrange();
      const res = await call();
      expect(res).toEqual(NEVER_SENT);
      expect(api.isUncertainWrite(res)).toBe(false);
      expect(api.describeAntError(res, 'Buying storage')).toBe('Cannot reach the Swarm node.');
    }
    expect(mockChromium.events.filter((e) => e.startsWith('dial'))).toEqual([]);
  });
});

// Codex round 2 on #1369: a write whose deadline passes before it was
// dialled, waiting for one of the default session's write sessions (all
// held by writes the node never answers) or while one is prepared.
describe('a write whose deadline passes before it was dialled', () => {
  let deadlines;
  let timeoutSpy;
  beforeEach(() => {
    deadlines = [];
    timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const deadline = new AbortController();
      deadlines.push(deadline);
      return deadline.signal;
    });
  });
  afterEach(() => timeoutSpy.mockRestore());
  const expire = (deadline) =>
    deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  // Timed out, and certain: nothing of it left Freedom.
  const NOT_DIALLED = {
    ok: false,
    status: 0,
    data: null,
    message: null,
    timedOut: true,
    unreachable: false,
    refused: true,
  };

  /** Every write session of the default session's pool, held by a dialled write. */
  async function holdEveryWriteSession(dials) {
    const holders = [];
    for (let n = 0; n < MAX_WRITE_SESSIONS; n++) holders.push(api.topUpSettlementDeposit());
    await waitFor(() => dials.length === MAX_WRITE_SESSIONS);
    return holders;
  }

  /** The holders' own deadlines: dialled, so each may have landed. */
  async function endHolders(holders) {
    for (const deadline of deadlines.slice(0, MAX_WRITE_SESSIONS)) expire(deadline);
    for (const res of await Promise.all(holders)) {
      expect(res).toMatchObject({ timedOut: true, refused: false });
      expect(api.isUncertainWrite(res)).toBe(true);
    }
  }

  test(`waiting for a write session, all ${MAX_WRITE_SESSIONS} held: certain, and nothing dialled`, async () => {
    const dials = playChromium({ answer: () => null });
    const holders = await holdEveryWriteSession(dials);
    try {
      const pending = api.buyStorage({ depth: 20, amountPerChunk: '1' });
      // Queued for a session.
      await new Promise(setImmediate);
      expect(deadlines).toHaveLength(MAX_WRITE_SESSIONS + 1);
      expire(deadlines[MAX_WRITE_SESSIONS]);
      const res = await pending;
      expect(res).toEqual(NOT_DIALLED);
      expect(api.isUncertainWrite(res)).toBe(false);
      expect(api.describeAntError(res)).toBe('The Swarm node did not answer in time.');
    } finally {
      await endHolders(holders);
    }
    // A session that came back dialled nothing for it.
    await new Promise(setImmediate);
    expect(dials).toHaveLength(MAX_WRITE_SESSIONS);
  });

  test('while its session is prepared: certain at once, without waiting for the preparation, which dials nothing after', async () => {
    const dials = playChromium();
    let lookedUp = null;
    mockDefaultSession.resolveProxy.mockImplementationOnce(
      () => new Promise((resolve) => (lookedUp = resolve))
    );
    const pending = api.setSwapEnabled(true);
    await waitFor(() => lookedUp !== null);
    expire(deadlines[0]);
    try {
      await expect(pending).resolves.toEqual(NOT_DIALLED);
    } finally {
      // The preparation ends; its session goes back to the pool.
      lookedUp(SOCKS);
      await new Promise(setImmediate);
      await new Promise(setImmediate);
    }
    expect(dials).toEqual([]);
    expect(mockChromium.events.filter((e) => e.startsWith('dial'))).toEqual([]);
  });

  test('the publish setup fails such a buy as certain, never "may still go through"', async () => {
    const { createPublishSetupService } = require('./publish-setup-service');
    const dials = playChromium({ answer: () => null });
    const holders = await holdEveryWriteSession(dials);
    const ok = (data) => ({ ok: true, status: 200, data, message: null });
    const wallet = '0x1234567890abcdef1234567890abcdef12345678';
    // The node's reads, as the publish setup's own suite answers them; the
    // buy is the real call, on the node's transport.
    const setupApi = {
      getHealth: jest.fn().mockResolvedValue(ok({ status: 'ok', chainReady: true })),
      getNode: jest.fn().mockResolvedValue(ok({ beeMode: 'light' })),
      getReadiness: jest.fn().mockResolvedValue(ok({})),
      getStamps: jest.fn().mockResolvedValue(ok({ stamps: [] })),
      getAddresses: jest.fn().mockResolvedValue(ok({ ethereum: wallet })),
      getWallet: jest.fn().mockResolvedValue(ok({ nativeTokenBalance: '0', bzzBalance: '0' })),
      getChequebookAddress: jest.fn().mockResolvedValue(ok({ chequebookAddress: wallet })),
      getChequebookBalance: jest.fn().mockResolvedValue(ok({ availableBalance: '0' })),
      getStorageQuote: jest.fn().mockResolvedValue(
        ok({
          depth: 20,
          days: 30,
          amountPerChunk: '65676000',
          planCostPlur: '68866000000000',
          settlementDepositPlur: '10000000000000',
          walletAddress: wallet,
          walletBzzPlur: '0',
          walletXdaiWei: '447000000000000000',
          bzzToAcquirePlur: '78866000000000',
          swapInputWei: '432000000000000000',
          gasReserveWei: '15000000000000000',
          xdaiRequiredWei: '447000000000000000',
          xdaiToSendWei: '0',
          sufficientFunds: true,
        })
      ),
      buyStorage: jest.fn((params) => api.buyStorage(params)),
      extendStorage: jest.fn(),
      getSettlementDeposit: jest.fn().mockResolvedValue(ok({ needsTopUp: false })),
      topUpSettlementDeposit: jest.fn(),
    };
    const service = createPublishSetupService({
      api: setupApi,
      getNodeStatus: () => ({ status: 'running', error: null }),
      getRegistryMode: () => 'external',
      restartNode: jest.fn(),
      getTransactionStatus: jest.fn(),
      getNodeStartedAt: () => null,
    });
    try {
      service.arm({ kind: 'buy', planId: 'starter' });
      await waitFor(() => deadlines.length === MAX_WRITE_SESSIONS + 1);
      await new Promise(setImmediate);
      expire(deadlines[MAX_WRITE_SESSIONS]);
      await waitFor(() => service.getState().operation?.phase === 'failed');
      expect(setupApi.buyStorage).toHaveBeenCalledTimes(1);
      expect(service.getState().operation).toMatchObject({
        phase: 'failed',
        uncertain: false,
        error: 'The Swarm node did not answer in time.',
      });
      expect(dials).toHaveLength(MAX_WRITE_SESSIONS);
    } finally {
      service.dispose();
      await endHolders(holders);
    }
  });
});

describe('timeouts and notSent as today', () => {
  test('each call keeps its timeout: 10 s a read, 30 s a quote or the deposit, 15 s the swap switch, 330 s a write', async () => {
    const asked = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      asked.push(ms);
      return timeout(ms);
    });
    playChromium();
    for (const [, call] of CALLS) await call();
    expect(Object.fromEntries(CALLS.map(([name], i) => [name, asked[i]]))).toEqual({
      getHealth: 10_000,
      getNode: 10_000,
      getReadiness: 10_000,
      getStamps: 10_000,
      getAddresses: 10_000,
      getWallet: 10_000,
      getChequebookAddress: 10_000,
      getChequebookBalance: 10_000,
      getSettlements: 10_000,
      getStorageQuote: 30_000,
      getSettlementDeposit: 30_000,
      buyStorage: 330_000,
      extendStorage: 330_000,
      topUpSettlementDeposit: 330_000,
      setSwapEnabled: 15_000,
    });
    // A caller's own timeout still wins.
    asked.length = 0;
    await api.getStorageQuote({ depth: 20, days: 1 }, { timeoutMs: 1234 });
    expect(asked).toEqual([1234]);
  });

  describe('a call ends at its timeout, its dial or its reply’s body cancelled', () => {
    // The call's deadline, fired by the test.
    let deadline;
    let timeoutSpy;
    beforeEach(() => {
      timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
        deadline = new AbortController();
        return deadline.signal;
      });
    });
    afterEach(() => timeoutSpy.mockRestore());
    const expire = () =>
      deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const TIMED_OUT = {
      ok: false,
      status: 0,
      data: null,
      message: null,
      timedOut: true,
      unreachable: false,
      refused: false,
    };

    test('a read the node never answers: the dial aborted, its announcement released', async () => {
      const dials = playChromium({ answer: () => null });
      const pending = api.getStamps();
      await waitFor(() => dials.length === 1);
      expect(isMainProcessAntDial(`${REMOTE}/stamps`, 'GET')).toBe(true);
      expire();
      await expect(pending).resolves.toEqual(TIMED_OUT);
      expect(dials[0].request.aborted).toBe(true);
      expect(isMainProcessAntDial(`${REMOTE}/stamps`, 'GET')).toBe(false);
    });

    test('a reply whose body stalls: the body counts, and is cancelled', async () => {
      const dials = playChromium({ answer: () => ({ stall: '{"stamps":[' }) });
      const pending = api.getStamps();
      await waitFor(() => dials.length === 1);
      // The headers are in; the call still waits for the body.
      await new Promise((resolve) => setImmediate(resolve));
      expire();
      await expect(pending).resolves.toEqual(TIMED_OUT);
      expect(dials[0].request.aborted).toBe(true);
    });

    test('a write the node never answers may have landed; its write session is handed back', async () => {
      const dials = playChromium({ answer: () => null });
      const pending = api.buyStorage({ depth: 20, amountPerChunk: '1' });
      await waitFor(() => dials.length === 1);
      expire();
      const res = await pending;
      expect(res).toEqual(TIMED_OUT);
      expect(api.isUncertainWrite(res)).toBe(true);
      expect(dials[0].request.aborted).toBe(true);
      // The next write takes the session the first gave back (the pool's
      // last one in).
      timeoutSpy.mockRestore();
      const next = playChromium();
      await expect(api.buyStorage({ depth: 20, amountPerChunk: '1' })).resolves.toMatchObject({
        ok: true,
      });
      expect(next[0].session).toBe(dials[0].session);
    });
  });

  test('no node URL: not sent, nothing dialled, announced or leased', async () => {
    mockRegistry.url = null;
    const made = mockWriteSessions.length;
    for (const [name, call] of CALLS) {
      await expect(call()).resolves.toEqual({
        ok: false,
        status: 0,
        data: null,
        message: null,
        notSent: true,
      });
      expect([name, mockChromium.events]).toEqual([name, []]);
    }
    expect(mockWriteSessions.length).toBe(made);
  });
});

describe('a loopback node: Node’s fetch, outside the session', () => {
  let node;
  beforeEach(async () => {
    node = await startFakeHttpNode();
    mockRegistry.url = node.origin;
  });
  afterEach(async () => {
    await node.close();
  });

  test('reads and writes go to the node itself: nothing on the session, announced or leased', async () => {
    const seen = [];
    node.handle((req, res) => {
      const parts = [];
      req.on('data', (chunk) => parts.push(chunk));
      req.on('end', () => {
        seen.push({
          method: req.method,
          path: req.url,
          contentType: req.headers['content-type'] || null,
          contentLength: req.headers['content-length'] || null,
          body: Buffer.concat(parts).toString('utf8'),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"swapEnabled":true,"message":""}');
      });
    });
    const made = mockWriteSessions.length;
    await expect(api.getSettlements()).resolves.toMatchObject({ ok: true, status: 200 });
    await expect(api.setSwapEnabled(true)).resolves.toEqual({
      ok: true,
      status: 200,
      data: { swapEnabled: true, message: '' },
      message: null,
    });
    await expect(api.topUpSettlementDeposit()).resolves.toMatchObject({ ok: true });
    expect(seen).toEqual([
      { method: 'GET', path: '/settlements', contentType: null, contentLength: null, body: '' },
      {
        method: 'PUT',
        path: '/v0/settlement/swap',
        contentType: 'application/json',
        contentLength: '20',
        body: '{"swapEnabled":true}',
      },
      {
        method: 'POST',
        path: '/v0/settlement/deposit',
        contentType: null,
        contentLength: '0',
        body: '',
      },
    ]);
    expect(mockChromium.events).toEqual([]);
    expect(mockWriteSessions.length).toBe(made);
  });

  test('the timeout bounds the reply’s body too: a node that stalls mid-body is hung up on', async () => {
    node.handle((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"stamps":[');
    });
    const res = await api.getStamps({ timeoutMs: 300 });
    expect(res).toMatchObject({ status: 0, timedOut: true, unreachable: false });
    const [entry] = node.requests;
    await expect(entry.done).resolves.toMatchObject({ aborted: true });
  });

  test('a refused connection never sent the write', async () => {
    mockRegistry.url = `http://127.0.0.1:${await closedLoopbackPort()}`;
    const res = await api.buyStorage({ depth: 20, amountPerChunk: '1' });
    expect(res).toMatchObject({ status: 0, unreachable: true, refused: true, timedOut: false });
    expect(api.isUncertainWrite(res)).toBe(false);
  });
});
