/**
 * The dweb handlers' one flow (freedom-core design 0006): the size bounds
 * before the core is asked, `dweb.open`'s failures as HTTP, validation
 * before any dial, and each plan kind, with a scripted planner.
 */

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../logger', () => mockLog);

let mockDriver = null;
jest.mock('../core/naming', () => ({ namingDriver: () => mockDriver }));

let mockAdmission = null;
jest.mock('./fetch-admission', () => {
  const actual = jest.requireActual('./fetch-admission');
  return { ...actual, acquireDwebFetch: (request) => mockAdmission.acquire(request) };
});

const { handleDwebRequest, MAX_URL_UNITS, MAX_HEADER_UNITS } = require('./dweb-handler');
const { createFetchAdmission } = require('./fetch-admission');
const { runWithPrivateLogContext } = require('../private/private-log-context');

const HASH = 'ab'.repeat(32);
const SWARM = [
  ['swarm-chunk-retrieval-timeout', '30s'],
  ['swarm-redundancy-fallback-mode', 'true'],
  ['swarm-redundancy-strategy', '3'],
];
const FETCH = {
  fetch: {
    node: 'ant',
    path: `/bzz/${HASH}/index.html`,
    headers: [['accept', '*/*'], ...SWARM],
    retry: { statuses: [], on_error: false, attempts: 1, delays_ms: [] },
    timers: { queue_ms: null, headers_ms: 30000, body_idle_ms: 60000 },
    response: ['canonicalize_redirect', 'strip_page_state'],
    trust: { name: null, content: 'node_asserted' },
  },
};

/** A driver that answers `plan` (or throws `error`), honouring `ready`. */
function scriptedDriver({ plan = FETCH, error = null } = {}) {
  return {
    open: jest.fn(async (_params, { ready } = {}) => {
      if (error) throw error;
      const reply = { plan, generations: { ens: 0, tezos: 0, lifecycle: 0 }, attempts: 0 };
      if (ready) await ready(reply);
      return reply;
    }),
  };
}

function antBackend(answer = () => new Response('content')) {
  return {
    ref: { ant: 'bundled', up: true },
    url: 'http://127.0.0.1:1633',
    request: jest.fn(async (init) => answer(init)),
  };
}

const handle = (request, backend = antBackend()) =>
  handleDwebRequest(request, { backend, tag: '[bzz-protocol]' });

beforeEach(() => {
  jest.clearAllMocks();
  mockDriver = scriptedDriver();
  mockAdmission = createFetchAdmission();
});

describe('bounds before the core is asked', () => {
  // `bzz://<hash>/` is 71 code units; the rest is path.
  const urlOf = (units) => `bzz://${HASH}/${'a'.repeat(units - 71)}`;

  test('a URL over 64 KiB of UTF-16 code units is a 414', async () => {
    expect(urlOf(MAX_URL_UNITS)).toHaveLength(65_536);
    expect((await handle(new Request(urlOf(MAX_URL_UNITS)))).status).toBe(200);
    const res = await handle(new Request(urlOf(MAX_URL_UNITS + 1)));
    expect(res.status).toBe(414);
    expect(mockDriver.open).toHaveBeenCalledTimes(1);
  });

  test('headers over 64 KiB in all, each counting 4 more, are a 431', async () => {
    // `x-pad: …` counts its name (5), its value and 4.
    const withPad = (units) =>
      new Request(`bzz://${HASH}/`, { headers: { 'x-pad': 'p'.repeat(units - 9) } });
    expect(MAX_HEADER_UNITS).toBe(65_536);
    expect((await handle(withPad(MAX_HEADER_UNITS))).status).toBe(200);
    const res = await handle(withPad(MAX_HEADER_UNITS + 1));
    expect(res.status).toBe(431);
    expect(mockDriver.open).toHaveBeenCalledTimes(1);
  });
});

describe("dweb.open's failures", () => {
  const coreError = (code, message = code) => Object.assign(new Error(message), { code });

  test.each([
    ['busy', coreError('busy', 'Too many naming requests'), 503, 'Too many naming requests'],
    [
      'deadline',
      coreError('deadline', "The resolution's deadline passed"),
      504,
      "The resolution's deadline passed",
    ],
    ['no core process', coreError('core_unavailable'), 503, 'The core is unavailable'],
    ['cancelled', coreError('cancelled'), 502, 'Cancelled'],
    [
      'the generations moving under every attempt',
      coreError('repeated', 'Myotis availability changed repeatedly while resolving x.eth'),
      502,
      'ENS resolver error: Myotis availability changed repeatedly while resolving x.eth',
    ],
  ])('%s', async (_label, error, status, message) => {
    mockDriver = scriptedDriver({ error });
    const backend = antBackend();
    const res = await handle(new Request('bzz://x.eth/'), backend);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ code: status, message });
    expect(backend.request).not.toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  test.each(['invalid_argument', 'forbidden', 'internal', 'unknown_method'])(
    "%s: main's mistake or the core's, a 502 and a logged core fault",
    async (code) => {
      mockDriver = scriptedDriver({ error: coreError(code) });
      const res = await handle(new Request(`bzz://${HASH}/`));
      expect(res.status).toBe(502);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining(`[Core] dweb.open failed (${code})`),
        expect.anything()
      );
    }
  );

  test('without a core, nothing is planned', async () => {
    mockDriver = null;
    const res = await handle(new Request(`bzz://${HASH}/`));
    expect(res.status).toBe(503);
  });
});

// fc-dweb's vectors carry the design's refusals (vectors/dweb.json,
// `validation`; `dweb-vectors.test.js` runs them all). A plan a faulty core
// could make is refused here before the backend is ever asked.
describe('a refused plan is a 502 before any dial', () => {
  test.each([
    ['path', 'a target that climbs out of /bzz/<ref>', { path: `/bzz/${HASH}/../stamps` }],
    ['path', 'an encoded separator that climbs', { path: `/bzz/${HASH}/..%2F..%2Fstamps` }],
    ['path', 'another node path altogether', { path: '/stamps/1/17' }],
    ['header', 'a header off the allowlist', { headers: [['swarm-pin', 'true'], ...SWARM] }],
    ['header', 'a CR LF in a value', { headers: [['accept', 'a\r\nx: 1'], ...SWARM] }],
    ['node', 'a URL where the node reference goes', { node: 'http://127.0.0.1:1633' }],
    [
      'timers',
      'an unbounded body',
      { timers: { queue_ms: null, headers_ms: 30000, body_idle_ms: null } },
    ],
  ])('%s: %s', async (refusal, _label, override) => {
    mockDriver = scriptedDriver({ plan: { fetch: { ...FETCH.fetch, ...override } } });
    const backend = antBackend();
    const res = await handle(new Request(`bzz://${HASH}/index.html`), backend);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 502, message: 'dweb plan refused' });
    expect(backend.request).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining(`[Core] dweb plan refused (${refusal})`),
      expect.anything()
    );
    // Nothing was admitted, or nothing is held.
    expect(mockAdmission.stats()).toEqual({ active: 0, waiting: 0 });
  });
});

describe('the plans', () => {
  test("the core is told the request and the backend's reference, never its URL", async () => {
    const res = await handle(
      new Request(`bzz://${HASH}/index.html`, { method: 'HEAD', headers: { Range: 'bytes=0-1' } })
    );
    expect(res.status).toBe(200);
    expect(mockDriver.open.mock.calls[0][0]).toEqual({
      url: `bzz://${HASH}/index.html`,
      method: 'HEAD',
      headers: [['range', 'bytes=0-1']],
      backend: { ant: 'bundled', up: true },
    });
  });

  test('an error plan is answered as its JSON body, its message redacted in a private log', async () => {
    const message = 'ENS name secret.eth has no contenthash (no_contenthash)';
    mockDriver = scriptedDriver({ plan: { error: { status: 404, code: 404, message } } });
    const backend = antBackend();
    const res = await runWithPrivateLogContext(true, () =>
      handle(new Request('bzz://secret.eth/'), backend)
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ code: 404, message });
    expect(backend.request).not.toHaveBeenCalled();
    expect(mockLog.info.mock.calls.flat().join(' ')).not.toContain('secret');
  });

  test('a redirect plan is answered as itself, with no node and no slot', async () => {
    const location = 'ipfs://bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34/a';
    mockDriver = scriptedDriver({
      plan: {
        redirect: { status: 307, location, headers: [['access-control-allow-origin', '*']] },
      },
    });
    const backend = { ...antBackend(), ref: { ipfs: 'native', up: false } };
    const res = await handleDwebRequest(
      new Request('ipfs://localhost/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/a'),
      { backend, tag: '[ipfs-protocol]' }
    );
    expect(res.status).toBe(307);
    expect([...res.headers]).toEqual([
      ['access-control-allow-origin', '*'],
      ['location', location],
    ]);
    expect(res.body).toBeNull();
    expect(backend.request).not.toHaveBeenCalled();
    expect(mockAdmission.stats().active).toBe(0);
  });

  test('a fetch plan holds its slot, taken before the plan is used, until its body ends', async () => {
    let slotAtDial = null;
    const backend = antBackend(() => {
      slotAtDial = mockAdmission.stats().active;
      return new Response('content');
    });
    const res = await handle(new Request(`bzz://${HASH}/index.html`), backend);
    expect(slotAtDial).toBe(1);
    expect(mockAdmission.stats().active).toBe(1);
    await expect(res.text()).resolves.toBe('content');
    expect(mockAdmission.stats().active).toBe(0);
    // The plan's target, on the backend captured at admission.
    expect(backend.request.mock.calls[0][0].path).toBe(`/bzz/${HASH}/index.html`);
  });

  test('beyond the admission bounds a fetch is a 503 at once', async () => {
    mockAdmission = createFetchAdmission({ maxActive: 1, maxWaiting: 0 });
    const held = await mockAdmission.acquire();
    const backend = antBackend();
    const res = await handle(new Request(`bzz://${HASH}/`), backend);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 503, message: 'Too many dweb requests' });
    expect(backend.request).not.toHaveBeenCalled();
    held.release();
  });
});
