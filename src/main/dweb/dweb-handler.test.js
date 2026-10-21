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
  return {
    ...actual,
    acquireDwebFetch: (request) => mockAdmission.acquire(request),
    fenceDwebSession: (partition) => mockAdmission.fence(partition),
  };
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

/** A driver that answers `plan` (or throws `error`), handing it over as
 * the real one does: `ready`, then `use` in the same turn. */
function scriptedDriver({ plan = FETCH, error = null } = {}) {
  return {
    open: jest.fn(async (_params, { signal, ready, use } = {}) => {
      if (error) throw error;
      const reply = { plan, generations: { ens: 0, tezos: 0, lifecycle: 0 }, attempts: 0 };
      if (ready) await ready(reply, signal);
      return use ? use(reply) : reply;
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
  // `bzz://site.eth/` is 15 code units; the rest is path. A name host, so
  // the scripted plan's target may be the lookup's.
  const urlOf = (units) => `bzz://site.eth/${'a'.repeat(units - 15)}`;

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
      new Request(`bzz://${HASH}/index.html`, { headers: { 'x-pad': 'p'.repeat(units - 9) } });
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
    // A hash host's target is the request's own (freedom-core#97).
    [
      'path',
      "another reference than the hash host's",
      { path: `/bzz/${'cd'.repeat(32)}/index.html` },
    ],
    [
      'trust',
      'a name label for a hash host',
      { trust: { name: 'verified', content: 'node_asserted' } },
    ],
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
    const res = await handle(new Request(`bzz://${HASH}/index.html`), backend);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 503, message: 'Too many dweb requests' });
    expect(backend.request).not.toHaveBeenCalled();
    held.release();
  });
});

// freedom-core design 0007, "Main's side": the backend captured at admission
// carries a lease, which the handler releases exactly once on every exit,
// and holds while a body it handed on is unfinished.
describe("the backend's lease", () => {
  const CIDV0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
  const CIDV0_AS_BASE32 = 'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34';
  function leasedBackend(answer) {
    const backend = antBackend(answer);
    backend.release = jest.fn();
    return backend;
  }
  const PRIVATE = 'private-lease';
  const bzz = (path, init) => new Request(`bzz://${HASH}/${path}`, init);
  const coreError = (code, message) => Object.assign(new Error(message), { code });

  // Each case sets up its exit: the request, and the session, the backend's
  // reference and the node's body where they differ.
  test.each([
    ['a URL over its bound (414)', 414, () => ({ request: bzz('a'.repeat(65_536)) })],
    [
      'headers over their bound (431)',
      431,
      () => ({ request: bzz('', { headers: { 'x-pad': 'p'.repeat(65_536) } }) }),
    ],
    [
      'no core (503)',
      503,
      () => {
        mockDriver = null;
        return { request: bzz('') };
      },
    ],
    [
      'a closed session (502)',
      502,
      () => {
        mockAdmission.closeSession(PRIVATE);
        return { request: bzz(''), partition: PRIVATE };
      },
    ],
    [
      'a failed lookup (502)',
      502,
      () => {
        mockDriver = scriptedDriver({ error: coreError('repeated', 'changed') });
        return { request: new Request('bzz://x.eth/') };
      },
    ],
    [
      'a busy core (503)',
      503,
      () => {
        mockDriver = scriptedDriver({ error: coreError('busy', 'Too many naming requests') });
        return { request: bzz('') };
      },
    ],
    [
      'a refused plan (502)',
      502,
      () => {
        mockDriver = scriptedDriver({ plan: { fetch: { ...FETCH.fetch, path: '/stamps/1/17' } } });
        return { request: bzz('index.html') };
      },
    ],
    [
      'an error plan (404)',
      404,
      () => {
        mockDriver = scriptedDriver({ plan: { error: { status: 404, code: 404, message: 'no' } } });
        return { request: bzz('') };
      },
    ],
    [
      'a redirect plan (307)',
      307,
      () => {
        const location = `ipfs://${CIDV0_AS_BASE32}/a`;
        mockDriver = scriptedDriver({
          plan: {
            redirect: { status: 307, location, headers: [['access-control-allow-origin', '*']] },
          },
        });
        return {
          request: new Request(`ipfs://localhost/ipfs/${CIDV0}/a`),
          ref: { ipfs: 'native', up: false },
        };
      },
    ],
    [
      "admission's 503",
      503,
      () => {
        mockAdmission = createFetchAdmission({ maxActive: 0, maxWaiting: 0 });
        return { request: bzz('index.html') };
      },
    ],
    [
      'an abort before the fetch (502)',
      502,
      () => {
        const controller = new AbortController();
        controller.abort();
        return { request: bzz('index.html', { signal: controller.signal }) };
      },
    ],
    [
      'a HEAD, whose answer has no body',
      200,
      () => ({ request: bzz('index.html', { method: 'HEAD' }), body: null }),
    ],
  ])('released once on %s', async (_label, status, setup) => {
    const { request, partition = null, ref = null, body = 'content' } = setup();
    const backend = leasedBackend(() => new Response(body));
    if (ref) backend.ref = ref;
    const res = await handleDwebRequest(request, { backend, partition, tag: '[bzz-protocol]' });
    expect(res.status).toBe(status);
    expect(backend.release).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['a rejected request() (502)', 502, () => Promise.reject(new Error('read failed'))],
    [
      "the node's capacity, BackendBusy (503)",
      503,
      () => Promise.reject(Object.assign(new Error('busy'), { name: 'BackendBusy' })),
    ],
  ])('released once on %s', async (_label, status, answer) => {
    const backend = leasedBackend(answer);
    const res = await handle(new Request(`bzz://${HASH}/index.html`), backend);
    expect(res.status).toBe(status);
    expect(backend.request).toHaveBeenCalledTimes(1);
    expect(backend.release).toHaveBeenCalledTimes(1);
  });

  // A body handed on holds the lease until it is over.
  const streaming = () => {
    let source;
    const body = new ReadableStream({
      start(controller) {
        source = controller;
        controller.enqueue(new TextEncoder().encode('first'));
      },
    });
    return { body, source: () => source };
  };

  test.each([
    ['its end', (reader, source) => (source().close(), reader.read())],
    [
      'an error',
      (reader, source) => (source().error(new Error('cut')), reader.read().catch(() => {})),
    ],
    ["its consumer's cancel", (reader) => reader.cancel()],
  ])('held through a body, then released once on %s', async (_label, finish) => {
    const { body, source } = streaming();
    const backend = leasedBackend(() => new Response(body));
    const res = await handle(new Request(`bzz://${HASH}/index.html`), backend);
    const reader = res.body.getReader();
    await reader.read();
    expect(backend.release).not.toHaveBeenCalled();

    await finish(reader, source);
    await waitForRelease(backend);
    expect(backend.release).toHaveBeenCalledTimes(1);
  });

  test("held through a body, then released once when the body's session closes", async () => {
    const { body } = streaming();
    const backend = leasedBackend(() => new Response(body));
    const res = await handleDwebRequest(new Request(`bzz://${HASH}/index.html`), {
      backend,
      partition: PRIVATE,
      tag: '[bzz-protocol]',
    });
    const reader = res.body.getReader();
    await reader.read();
    expect(backend.release).not.toHaveBeenCalled();

    mockAdmission.closeSession(PRIVATE);
    await reader.read().catch(() => {});
    await waitForRelease(backend);
    expect(backend.release).toHaveBeenCalledTimes(1);
  });

  test('a backend without a lease is served as before', async () => {
    const res = await handle(new Request(`bzz://${HASH}/index.html`), antBackend());
    await expect(res.text()).resolves.toBe('content');
  });
});

/** Settles once `backend.release` has been called, or after a few turns. */
async function waitForRelease(backend) {
  for (let i = 0; i < 20 && backend.release.mock.calls.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
