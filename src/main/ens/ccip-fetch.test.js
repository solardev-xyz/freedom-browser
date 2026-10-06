const { execFileSync } = require('child_process');
const {
  createNetMock,
  emitResponse,
  emitRedirect,
  FakeIncomingMessage,
} = require('../../../test/helpers/fake-electron-net');
const {
  ccipReadFetch,
  isHexData,
  CCIP_TIMEOUT_MS,
  CCIP_MAX_RESPONSE_BYTES,
} = require('./ccip-fetch');

const UR = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
const TX = { to: UR };
const originalFetch = global.fetch;

const json = (data) => JSON.stringify({ data });
const answer = (data) => (request) => emitResponse(request, { chunks: [json(data)] });

const CHUNK_BYTES = 64 * 1024;
// Far more body than the cap allows, but finite: a regression that drops the
// cap must fail the chunk-count assertion rather than hang the suite forever.
const OVERSIZED_CHUNKS = Math.ceil((CCIP_MAX_RESPONSE_BYTES * 4) / CHUNK_BYTES);

/** A valid answer of exactly CCIP_MAX_RESPONSE_BYTES, and its 64 KiB chunks. */
function capSizedAnswer() {
  const overhead = '{"data":"0x" }'.length;
  const hex = `0x${'ab'.repeat((CCIP_MAX_RESPONSE_BYTES - overhead) / 2)}`;
  const body = Buffer.from(`{"data":"${hex}" }`);
  expect(body.length).toBe(CCIP_MAX_RESPONSE_BYTES);
  const chunks = [];
  for (let at = 0; at < body.length; at += CHUNK_BYTES)
    chunks.push(body.subarray(at, at + CHUNK_BYTES));
  return { body, hex, chunks };
}

// #359: every gateway is dialled through Electron's `net.request` (Chromium,
// so the session proxy applies). Node's global `fetch` must never be reached —
// it is replaced with a spy that fails the test if anything calls it.
let nodeFetch;
beforeEach(() => {
  nodeFetch = jest.fn(async () => {
    throw new Error('undici fetch must not be used for CCIP gateways');
  });
  global.fetch = nodeFetch;
});

afterEach(() => {
  expect(nodeFetch).not.toHaveBeenCalled();
  global.fetch = originalFetch;
  jest.useRealTimers();
});

/**
 * `respond` per request, in order; the last one repeats. `errors` collects why
 * each skipped gateway was skipped, through the `onGatewayError` seam —
 * production swallows these without logging, so this is the only place the
 * real cause of a `CCIP_GATEWAY_FAILED` is visible (#478).
 */
function gateways(...responders) {
  let index = 0;
  const net = createNetMock((request, options) => {
    const respond = responders[Math.min(index, responders.length - 1)];
    index += 1;
    respond(request, options);
  });
  const errors = [];
  return {
    net,
    errors,
    deps: { requestImpl: net.request, onGatewayError: (error) => errors.push(error) },
  };
}

/** The skip reasons, as messages, so a failing assertion prints them. */
const reasons = (errors) => errors.map((error) => `${error.name}: ${error.message}`);

describe('the request each gateway gets', () => {
  test('substitutes the template, GETs it through Chromium and returns the hex', async () => {
    const { net, deps } = gateways(answer('0xcafe'));

    expect(
      await ccipReadFetch(TX, '0xbeef', ['https://gw.example/{sender}/{data}'], undefined, deps)
    ).toBe('0xcafe');

    const [request] = net.requests;
    expect(request.options).toMatchObject({
      method: 'GET',
      url: `https://gw.example/${UR.toLowerCase()}/0xbeef`,
      // Chromium is told `manual` so the hop is reported and never taken;
      // `redirect: 'error'` is enforced on that report (see the redirect test).
      redirect: 'manual',
      // Only the session's proxy policy — no cookies, no stored credentials, no
      // HTTP cache — exactly what undici sent (nothing) before #359.
      credentials: 'omit',
      useSessionCookies: false,
      cache: 'no-store',
      bypassCustomProtocolHandlers: true,
    });
    expect(request.sentHeaders).toEqual({ Accept: 'application/json' });
    expect(request.written).toEqual([]);
    expect(request.ended).toBe(true);
  });

  test('POSTs the sender and data when the template has no {data}', async () => {
    const { net, deps } = gateways(answer('0xcafe'));

    await ccipReadFetch(TX, '0xbeef', ['https://gw.example/lookup'], undefined, deps);

    const [request] = net.requests;
    expect(request.options.method).toBe('POST');
    expect(request.sentHeaders).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(Buffer.concat(request.written).toString('utf8'))).toEqual({
      sender: UR.toLowerCase(),
      data: '0xbeef',
    });
    expect(request.ended).toBe(true);
  });
});

test('tries the next gateway when one fails, and rejects once all are exhausted', async () => {
  const { net, deps, errors } = gateways(
    (request) => request.emit('error', new Error('net::ERR_CONNECTION_REFUSED')),
    (request) => emitResponse(request, { status: 500, chunks: ['nope'] }),
    (request) => emitResponse(request, { chunks: ['not json'] }),
    answer('0xnothex'),
    answer('0xcafe')
  );

  expect(
    await ccipReadFetch(
      TX,
      '0x',
      [
        'https://a.example/{data}',
        'https://b.example/{data}',
        'https://c.example/{data}',
        'https://d.example/{data}',
        'https://e.example/{data}',
      ],
      undefined,
      deps
    )
  ).toBe('0xcafe');
  expect(net.requests).toHaveLength(5);
  // Every skip reaches the seam with its own reason.
  expect(reasons(errors)).toEqual([
    'Error: net::ERR_CONNECTION_REFUSED',
    'Error: CCIP gateway answered HTTP 500',
    expect.stringMatching(/^SyntaxError: /),
    'Error: CCIP response data is not hex',
  ]);

  const failing = gateways((request) => emitResponse(request, { status: 502 }));
  await expect(
    ccipReadFetch(TX, '0x', ['https://a.example/{data}'], undefined, failing.deps)
  ).rejects.toMatchObject({
    code: 'CCIP_GATEWAY_FAILED',
    message: expect.stringContaining('CCIP gateways unavailable'),
  });
});

test.each([
  'file:///etc/passwd',
  'http://127.0.0.1:1633/stamps/1/17',
  'http://gateway.example/query',
  'https://127.0.0.1/query',
  'https://2130706433/query',
  'https://[::1]/query',
  'https://[::ffff:127.0.0.1]/query',
  'https://localhost./query',
  'https://node.localhost/query',
  'https://node.local/query',
  'https://node.internal/query',
  'https://node/query',
  'https://user:password@gateway.example/query',
])('refuses unsafe gateway %s without dialling it', async (url) => {
  const { net, deps, errors } = gateways(answer('0xcafe'));

  await expect(ccipReadFetch(TX, '0x', [url], undefined, deps)).rejects.toThrow(
    'CCIP gateways unavailable'
  );
  expect(net.request).not.toHaveBeenCalled();
  expect(reasons(errors)).toEqual(['Error: CCIP gateway URL refused']);
});

// `redirect: 'error'` survives the transport change: a 3xx is a failed
// gateway, its Location is never dialled, and the next URL is tried.
test('a redirecting gateway is skipped, never followed', async () => {
  const { net, deps } = gateways(
    (request) => emitRedirect(request, { status: 302, location: 'http://127.0.0.1:1633/' }),
    answer('0xcafe')
  );

  expect(
    await ccipReadFetch(
      TX,
      '0x',
      ['https://redirects.example/{data}', 'https://b.example/{data}'],
      undefined,
      deps
    )
  ).toBe('0xcafe');
  // Aborting on the `redirect` event is what stops Chromium taking the hop.
  expect(net.requests[0].aborted).toBe(true);
  expect(net.urls()).toEqual(['https://redirects.example/0x', 'https://b.example/0x']);
});

test('cancelling a resolution aborts its request and prevents subsequent gateways', async () => {
  const controller = new AbortController();
  const { net, deps } = gateways(() => {
    /* never answers */
  });
  const pending = ccipReadFetch(
    TX,
    '0x',
    ['https://a.example/', 'https://b.example/'],
    controller.signal,
    deps
  );
  const assertion = expect(pending).rejects.toThrow('CCIP gateways unavailable');
  await new Promise(setImmediate);
  controller.abort();
  await assertion;
  expect(net.request).toHaveBeenCalledTimes(1);
  expect(net.requests[0].aborted).toBe(true);
});

// The bounds this helper exists for. ethers' inherited implementation has
// neither: a 300s FetchRequest default and no response-size cap, for URLs an
// OffchainLookup revert — not us — chose.
describe('bounds', () => {
  test(`aborts a gateway that does not answer within ${CCIP_TIMEOUT_MS}ms`, async () => {
    jest.useFakeTimers();
    const { net, deps } = gateways(() => {
      /* never answers */
    });

    const pending = ccipReadFetch(TX, '0x', ['https://stalls.example/{data}'], undefined, deps);
    const assertion = expect(pending).rejects.toThrow('CCIP gateways unavailable');

    await jest.advanceTimersByTimeAsync(CCIP_TIMEOUT_MS - 1);
    expect(net.requests[0].aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    await assertion;
    expect(net.requests[0].aborted).toBe(true);
  });

  // The deadline is wall clock for the whole exchange, headers *and* body — a
  // gateway that answers promptly and then trickles must not escape it.
  test('the deadline also covers a body that stalls after the headers', async () => {
    jest.useFakeTimers();
    const { net, deps } = gateways((request) =>
      emitResponse(request, { chunks: ['{"data":'], end: false })
    );

    const pending = ccipReadFetch(TX, '0x', ['https://trickles.example/{data}'], undefined, deps);
    const assertion = expect(pending).rejects.toThrow('CCIP gateways unavailable');

    await jest.advanceTimersByTimeAsync(CCIP_TIMEOUT_MS - 1);
    expect(net.requests[0].aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    await assertion;
    expect(net.requests[0].aborted).toBe(true);
  });

  test('rejects an over-large body declared up front, without reading it', async () => {
    let upstream = null;
    const { net, deps, errors } = gateways((request) => {
      upstream = emitResponse(request, {
        headers: { 'content-length': String(CCIP_MAX_RESPONSE_BYTES + 1) },
        end: false,
      });
    });

    await expect(
      ccipReadFetch(TX, '0x', ['https://huge.example/{data}'], undefined, deps)
    ).rejects.toThrow('CCIP gateways unavailable');
    // Cancelling the body is what tears the request down in Chromium.
    expect(net.requests[0].aborted).toBe(true);
    expect(upstream).toBeInstanceOf(FakeIncomingMessage);
    expect(reasons(errors)).toEqual(['Error: CCIP response too large']);
  });

  test('stops reading a body that outgrows the cap mid-stream', async () => {
    let emitted = 0;
    const { net, deps, errors } = gateways(async (request) => {
      const response = emitResponse(request, { end: false });
      // No content-length: only the running count can catch this one.
      while (emitted < OVERSIZED_CHUNKS && !request.aborted) {
        emitted += 1;
        response.emit('data', Buffer.alloc(CHUNK_BYTES));
        await new Promise(setImmediate);
      }
      if (!request.aborted) response.emit('end');
    });

    await expect(
      ccipReadFetch(TX, '0x', ['https://endless.example/{data}'], undefined, deps)
    ).rejects.toThrow('CCIP gateways unavailable');
    // Cancelled as soon as the cap was crossed — not drained to the end.
    expect(net.requests[0].aborted).toBe(true);
    expect(emitted).toBeLessThanOrEqual(CCIP_MAX_RESPONSE_BYTES / CHUNK_BYTES + 2);
    expect(emitted).toBeLessThan(OVERSIZED_CHUNKS);
    expect(reasons(errors)).toEqual(['Error: CCIP response too large']);
  });

  // The cap is inclusive, as before: exactly CCIP_MAX_RESPONSE_BYTES is fine.
  test('accepts a body of exactly the cap', async () => {
    const { body, hex, chunks } = capSizedAnswer();
    const { deps, errors } = gateways((request) =>
      emitResponse(request, { headers: { 'content-length': String(body.length) }, chunks })
    );

    const result = await ccipReadFetch(
      TX,
      '0x',
      ['https://ok.example/{data}'],
      undefined,
      deps
    ).catch((error) => error);
    // Checked first, so a regression fails on the real reason, not on the
    // generic CCIP_GATEWAY_FAILED (#478 was a swallowed RangeError).
    expect(reasons(errors)).toEqual([]);
    expect(result).toBe(hex);
  });

  // #478: the answer used to be checked with /^0x(?:[0-9a-fA-F]{2})*$/, which
  // V8 runs in constant stack only while it compiles regexps with optimisation.
  // A long-lived isolate (a long in-band jest run, the Electron main process)
  // loses that, and the check then threw a RangeError on a cap-sized answer —
  // intermittently in CI, depending on executable memory at the time. A child
  // started with --no-regexp-optimization is that state, deterministically.
  test('accepts a cap-sized answer when V8 compiles regexps without optimisation', () => {
    const child = `
      const { EventEmitter } = require('events');
      const { ccipReadFetch, isHexData } = require(${JSON.stringify(require.resolve('./ccip-fetch'))});
      const CAP = ${CCIP_MAX_RESPONSE_BYTES};
      const overhead = '{"data":"0x" }'.length;
      const hex = '0x' + 'ab'.repeat((CAP - overhead) / 2);
      const body = Buffer.from('{"data":"' + hex + '" }');
      // Positive control: proves this child really is in the failing mode.
      let control;
      try { control = String(/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)); }
      catch (error) { control = error.name; }
      const requestImpl = () => {
        const request = new EventEmitter();
        request.setHeader = () => {};
        request.write = () => {};
        request.abort = () => {};
        request.end = () => setImmediate(() => {
          const response = new EventEmitter();
          Object.assign(response, {
            statusCode: 200,
            headers: { 'content-length': String(body.length) },
            pause() {}, resume() {}, destroy() {},
          });
          request.emit('response', response);
          for (let at = 0; at < body.length; at += ${CHUNK_BYTES})
            response.emit('data', body.subarray(at, at + ${CHUNK_BYTES}));
          response.emit('end');
        });
        return request;
      };
      const errors = [];
      ccipReadFetch({ to: '${UR}' }, '0x', ['https://ok.example/{data}'], undefined, {
        requestImpl,
        onGatewayError: (error) => errors.push(error.name + ': ' + error.message),
      }).then(
        (result) => ({ result: result === hex }),
        (error) => ({ error: error.message })
      ).then((outcome) => {
        process.stdout.write(JSON.stringify({
          control, errors, isHex: isHexData(hex), ...outcome,
        }));
      });
    `;
    const report = JSON.parse(
      execFileSync(process.execPath, ['--no-regexp-optimization', '-e', child], {
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '' },
      })
    );

    // If a future V8 runs the old pattern safely here, the control no longer
    // shows anything: find the engine mode that still breaks it, or drop this.
    expect(report.control).toBe('RangeError');
    expect(report).toEqual({ control: 'RangeError', errors: [], isHex: true, result: true });
  });
});

describe('isHexData', () => {
  test.each([
    ['0x', true],
    ['0xcafe', true],
    ['0xCAFEbabe', true],
    ['0xcaf', false],
    ['0xcafg', false],
    ['0Xcafe', false],
    ['cafe', false],
    ['0x ca', false],
    ['0xcafé', false],
    [undefined, false],
    [null, false],
    [0xcafe, false],
  ])('%p → %p', (value, expected) => {
    expect(isHexData(value)).toBe(expected);
  });
});

// The case #359 is about: a resolver whose OffchainLookup names an onion
// gateway. undici handed that name to the system resolver; through the
// transport it is dialled only when the session proves it proxies it.
describe('an .onion CCIP gateway', () => {
  const ONION = 'https://ccipgatewayprobe.onion/{data}';

  test('is refused, not dialled, while the session resolves it DIRECT', async () => {
    const { net, deps } = gateways(answer('0xcafe'));
    const resolveProxy = jest.fn(async () => 'DIRECT');

    await expect(
      ccipReadFetch(TX, '0x', [ONION], undefined, { ...deps, resolveProxy })
    ).rejects.toThrow('CCIP gateways unavailable');
    expect(resolveProxy).toHaveBeenCalledWith('https://ccipgatewayprobe.onion/0x');
    expect(net.request).not.toHaveBeenCalled();
  });

  test('is dialled by name once the session routes it through Tor', async () => {
    const { net, deps } = gateways(answer('0xcafe'));
    const resolveProxy = jest.fn(async () => 'SOCKS5 127.0.0.1:9150');

    expect(await ccipReadFetch(TX, '0x', [ONION], undefined, { ...deps, resolveProxy })).toBe(
      '0xcafe'
    );
    expect(net.urls()).toEqual(['https://ccipgatewayprobe.onion/0x']);
  });

  test('falls through to the next gateway when the onion one is refused', async () => {
    const { net, deps } = gateways(answer('0xcafe'));
    const resolveProxy = jest.fn(async () => 'DIRECT');

    expect(
      await ccipReadFetch(TX, '0x', [ONION, 'https://clearnet.example/{data}'], undefined, {
        ...deps,
        resolveProxy,
      })
    ).toBe('0xcafe');
    expect(net.urls()).toEqual(['https://clearnet.example/0x']);
  });
});
