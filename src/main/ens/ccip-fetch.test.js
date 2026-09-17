const { ccipReadFetch, CCIP_TIMEOUT_MS, CCIP_MAX_RESPONSE_BYTES } = require('./ccip-fetch');

const UR = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
const TX = { to: UR };
const originalFetch = global.fetch;

const jsonResponse = (data) => new Response(JSON.stringify({ data }));

const CHUNK_BYTES = 64 * 1024;
// Far more body than the cap allows, but finite: a regression that drops the
// cap must fail the pull-count assertion rather than hang the suite forever.
const OVERSIZED_CHUNKS = Math.ceil((CCIP_MAX_RESPONSE_BYTES * 4) / CHUNK_BYTES);
const oversizedResponse = (pulls) =>
  new Response(
    new ReadableStream({
      pull(controller) {
        if (pulls.count >= OVERSIZED_CHUNKS) {
          controller.close();
          return;
        }
        pulls.count += 1;
        controller.enqueue(new Uint8Array(CHUNK_BYTES));
      },
    })
  );

afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

test('substitutes the template and returns the gateway hex', async () => {
  global.fetch = jest.fn(async () => jsonResponse('0xcafe'));

  expect(await ccipReadFetch(TX, '0xbeef', ['https://gw.example/{sender}/{data}'])).toBe('0xcafe');

  const [url, init] = global.fetch.mock.calls[0];
  expect(url).toBe(`https://gw.example/${UR.toLowerCase()}/0xbeef`);
  expect(init.method).toBe('GET');
  expect(init.redirect).toBe('error');
});

test('POSTs the sender and data when the template has no {data}', async () => {
  global.fetch = jest.fn(async () => jsonResponse('0xcafe'));

  await ccipReadFetch(TX, '0xbeef', ['https://gw.example/lookup']);

  const [, init] = global.fetch.mock.calls[0];
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body)).toEqual({ sender: UR.toLowerCase(), data: '0xbeef' });
});

test('tries the next gateway when one fails, and rejects once all are exhausted', async () => {
  global.fetch = jest
    .fn()
    .mockRejectedValueOnce(new Error('ECONNREFUSED'))
    .mockResolvedValueOnce(new Response('', { status: 500 }))
    .mockResolvedValueOnce(jsonResponse('0xcafe'));

  expect(
    await ccipReadFetch(TX, '0x', [
      'https://a.example/{data}',
      'https://b.example/{data}',
      'https://c.example/{data}',
    ])
  ).toBe('0xcafe');

  global.fetch = jest.fn().mockResolvedValue(new Response('', { status: 502 }));
  await expect(ccipReadFetch(TX, '0x', ['https://a.example/{data}'])).rejects.toThrow(
    'CCIP gateways unavailable'
  );
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
])('refuses unsafe gateway %s without fetching it', async (url) => {
  global.fetch = jest.fn();

  await expect(ccipReadFetch(TX, '0x', [url])).rejects.toThrow('CCIP gateways unavailable');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('cancelling a resolution aborts its request and prevents subsequent gateways', async () => {
  const controller = new AbortController();
  global.fetch = jest.fn(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      })
  );
  const pending = ccipReadFetch(
    TX,
    '0x',
    ['https://a.example/', 'https://b.example/'],
    controller.signal
  );
  const assertion = expect(pending).rejects.toThrow('CCIP gateways unavailable');
  controller.abort();
  await assertion;
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true);
});

// The bounds this helper exists for. ethers' inherited implementation has
// neither: a 300s FetchRequest default and no response-size cap, for URLs an
// OffchainLookup revert — not us — chose.
test(`aborts a gateway that does not answer within ${CCIP_TIMEOUT_MS}ms`, async () => {
  jest.useFakeTimers();
  let aborted = null;
  global.fetch = jest.fn(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = init.signal.reason;
          reject(new Error('aborted'));
        });
      })
  );

  const pending = ccipReadFetch(TX, '0x', ['https://stalls.example/{data}']);
  const assertion = expect(pending).rejects.toThrow('CCIP gateways unavailable');

  await jest.advanceTimersByTimeAsync(CCIP_TIMEOUT_MS - 1);
  expect(aborted).toBeNull();
  await jest.advanceTimersByTimeAsync(1);

  await assertion;
  expect(aborted).toBeTruthy();
});

test('rejects an over-large body declared up front, without reading it', async () => {
  const body = jest.fn();
  global.fetch = jest.fn(async () => {
    const response = jsonResponse('0xcafe');
    Object.defineProperty(response, 'body', { get: () => ({ cancel: body }) });
    response.headers.set('content-length', String(CCIP_MAX_RESPONSE_BYTES + 1));
    return response;
  });

  await expect(ccipReadFetch(TX, '0x', ['https://huge.example/{data}'])).rejects.toThrow(
    'CCIP gateways unavailable'
  );
  expect(body).toHaveBeenCalled();
});

test('stops reading a body that outgrows the cap mid-stream', async () => {
  const pulls = { count: 0 };
  global.fetch = jest.fn(async () => oversizedResponse(pulls));

  await expect(ccipReadFetch(TX, '0x', ['https://endless.example/{data}'])).rejects.toThrow(
    'CCIP gateways unavailable'
  );
  // Cancelled as soon as the cap was crossed — not drained to the end.
  expect(pulls.count).toBeLessThanOrEqual(CCIP_MAX_RESPONSE_BYTES / CHUNK_BYTES + 2);
  expect(pulls.count).toBeLessThan(OVERSIZED_CHUNKS);
});
