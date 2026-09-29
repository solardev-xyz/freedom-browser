const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Wallet } = require('ethers');
const {
  startAntChainBridge,
  antShrinksLogScanOn,
  rankLogScanError,
  antErrorReply,
  LOG_SCAN_ERROR_RANK,
} = require('./ant-chain-bridge');

function post(url, body, headers = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) })
        );
      }
    );
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}
const rpc = (method = 'eth_getBalance', params = ['0xabc', 'latest']) => ({
  jsonrpc: '2.0',
  id: 7,
  method,
  params,
});
let bridge, router, log;
beforeEach(async () => {
  router = {
    request: jest.fn().mockResolvedValue({ result: '0x12', source: 'myotis' }),
    broadcastRawTransaction: jest.fn().mockResolvedValue({ result: '0xhash', source: 'direct' }),
  };
  log = { info: jest.fn(), warn: jest.fn() };
  bridge = await startAntChainBridge({ router, log });
});
afterEach(async () => {
  await bridge.close();
});

test('routes exact Gnosis requests and unwraps result without promoting trust', async () => {
  const response = await post(bridge.url, rpc());
  expect(response).toEqual({ status: 200, body: { jsonrpc: '2.0', id: 7, result: '0x12' } });
  expect(router.request).toHaveBeenCalledWith(100, 'eth_getBalance', ['0xabc', 'latest'], {
    signal: expect.any(AbortSignal),
    background: true,
  });
  router.request.mockResolvedValue({ result: [], source: 'direct', verified: false });
  expect(
    (await post(bridge.url, rpc('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2' }]))).body.result
  ).toEqual([]);
  expect(log.info).toHaveBeenLastCalledWith('[Ant chain] eth_getLogs via direct');
});

test.each(
  [
    ['wrong token', {}, 'POST', true],
    ['origin', { origin: 'https://evil.example' }],
    ['null origin', { origin: 'null' }],
    ['fetch metadata', { 'sec-fetch-site': 'same-origin' }],
    ['rebound host', { host: 'evil.example' }],
    ['preflight', {}, 'OPTIONS'],
    ['form', { 'content-type': 'text/plain' }],
  ].map(([name, headers, method = 'POST', wrongToken = false]) => [
    name,
    headers,
    method,
    wrongToken,
  ])
)('refuses %s before routing', async (_name, headers, method, wrongToken) => {
  const result = await post(wrongToken ? bridge.url + '0' : bridge.url, rpc(), headers, method);
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(router.request).not.toHaveBeenCalled();
});

test.each([
  ['{', -32700],
  [[rpc()], -32600],
  [{ ...rpc(), id: undefined }, -32600],
  [rpc('personal_sign'), -32601],
  [rpc('eth_sendTransaction'), -32601],
  [rpc('eth_sendRawTransaction', ['0x12']), -32601],
  [' '.repeat(256 * 1024 + 1), -32600],
])('rejects unsupported or malformed requests', async (body, code) => {
  expect((await post(bridge.url, body)).body.error.code).toBe(code);
  expect(router.request).not.toHaveBeenCalled();
  expect(router.broadcastRawTransaction).not.toHaveBeenCalled();
});

test('coverage failure stays an error, never an empty log result', async () => {
  router.request.mockRejectedValue(
    Object.assign(new Error('failed at https://rpc.example/key-123 upstream'), { code: -32000 })
  );
  const response = await post(bridge.url, rpc('eth_getLogs', [{}]));
  expect(response.body.error.code).toBe(-32000);
  expect(response.body).not.toHaveProperty('result');
  expect(JSON.stringify(response)).not.toContain('key-123');
  expect(response.body.error.message).toBe('Chain request failed: failed at [url] upstream');
  expect(log.warn.mock.calls.join()).not.toContain('upstream');
  expect(router.request).toHaveBeenCalledTimes(1);
});

const antShrinks = antShrinksLogScanOn;

test('range-limit and timeout failures keep wording Ant shrinks its log scan on', async () => {
  router.request.mockRejectedValue(
    Object.assign(new Error('query exceeds max block range 50000'), { code: -32005 })
  );
  const ranged = await post(bridge.url, rpc('eth_getLogs', [{}]));
  expect(ranged.body.error.code).toBe(-32005);
  expect(antShrinks(ranged.body.error.message)).toBe(true);

  // Router exhaustion after a direct per-URL client timeout.
  router.request.mockRejectedValue(
    new Error('All chain sources failed for eth_getLogs (direct: RPC query timeout after 60000ms)')
  );
  const exhausted = await post(bridge.url, rpc('eth_getLogs', [{}]));
  expect(exhausted.body.error.code).toBe(-32002);
  expect(antShrinks(exhausted.body.error.message)).toBe(true);

  // The bridge's own deadline.
  await bridge.close();
  bridge = await startAntChainBridge({ router, log, timeoutMs: 30 });
  router.request.mockImplementation(
    (_c, _m, _p, { signal }) =>
      new Promise((resolve) => signal.addEventListener('abort', () => resolve({ result: [] })))
  );
  const timedOut = await post(bridge.url, rpc('eth_getLogs', [{}]));
  expect(antShrinks(timedOut.body.error.message)).toBe(true);
});

test('Ant reads are background work and wide log scans get a longer direct budget', async () => {
  await post(bridge.url, rpc('eth_getLogs', [{}]));
  expect(router.request).toHaveBeenLastCalledWith(100, 'eth_getLogs', [{}], {
    signal: expect.any(AbortSignal),
    background: true,
    directTimeoutMs: 60000,
    rankError: rankLogScanError,
  });
  // Other reads are not ranked: Ant does not adapt them to the error.
  await post(bridge.url, rpc('eth_blockNumber', []));
  expect(router.request).toHaveBeenLastCalledWith(100, 'eth_blockNumber', [], {
    signal: expect.any(AbortSignal),
    background: true,
  });
});

// The router keeps the most useful error by this rank: range-limit (depends
// on the query, final) > timeout > possible range cap > endpoint-dependent.
test.each([
  ['range limit', { code: -32005, message: 'query exceeds max block range 50000' }, 'REQUEST'],
  [
    'too many results',
    { code: -32005, message: 'query returned more than 10000 results' },
    'REQUEST',
  ],
  ['response size', { code: -32008, message: 'Log response size exceeded' }, 'REQUEST'],
  [
    'client timeout',
    { message: 'RPC query timeout after 5000ms', failureKind: 'timeout' },
    'TIMEOUT',
  ],
  ['upstream timeout reply', { code: -32000, message: 'query timeout exceeded' }, 'TIMEOUT'],
  [
    'source deadline',
    { message: 'Colibri exceeded its 5000ms interactive deadline', failureKind: 'timeout' },
    'TIMEOUT',
  ],
  ['abort', { name: 'AbortError', message: 'This operation was aborted' }, 'TIMEOUT'],
  [
    'method not found',
    { code: -32601, message: 'the method eth_getLogs does not exist/is not available' },
    'ENDPOINT',
  ],
  ['internal error', { code: -32603, message: 'internal error' }, 'ENDPOINT'],
  ['rate limit with a -32005 code', { code: -32005, message: 'rate limit exceeded' }, 'ENDPOINT'],
  [
    'daily quota',
    { code: -32005, message: 'daily request count exceeded, request rate limited' },
    'ENDPOINT',
  ],
  [
    'Infura project throttle',
    { code: -32005, message: 'project ID request rate exceeded' },
    'ENDPOINT',
  ],
  // Coded replies matching Ant's needles without naming a throttle or the
  // query's size: possibly a range cap, kept over endpoint failures (R3-F1).
  ['EIP-1474 limit exceeded', { code: -32005, message: 'limit exceeded' }, 'HINT'],
  ['a coded needle-only reply', { code: -32000, message: 'more than allowed' }, 'HINT'],
  ['log count cap', { code: -32005, message: 'query exceeds limit of 10000 logs' }, 'HINT'],
  [
    'ranges over N blocks',
    { code: -32000, message: 'ranges over 10000 blocks are not supported' },
    'HINT',
  ],
  [
    'result count cap',
    { code: -32005, message: 'logs matched by query exceeds limit of 10000' },
    'REQUEST',
  ],
  [
    'Alchemy response size',
    {
      code: -32602,
      message:
        'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range',
    },
    'REQUEST',
  ],
  ['Ankr range cap', { code: -32602, message: 'block range is too wide' }, 'REQUEST'],
  ['range limit exceeded', { code: -32005, message: 'Block range limit exceeded' }, 'REQUEST'],
  [
    'QuickNode range cap',
    { code: -32602, message: 'eth_getLogs is limited to a 10,000 range' },
    'REQUEST',
  ],
  [
    'QuickNode blocks range cap',
    { code: -32602, message: 'eth_getLogs is limited to a 10,000 blocks range' },
    'REQUEST',
  ],
  [
    'reth behind head',
    {
      code: -32000,
      message: 'block range extends beyond current head block: requested 0x2000, head 0x1000',
    },
    'ENDPOINT',
  ],
  [
    'Erigon still syncing',
    {
      code: -32000,
      message:
        'requested block range [4096, 8192] is beyond latest executed block 4000 (node is still syncing)',
    },
    'ENDPOINT',
  ],
  ['invalid range params', { code: -32602, message: 'invalid block range params' }, 'HINT'],
  ['coded, no needle', { code: -32000, message: 'header not found' }, 'ENDPOINT'],
  ['HTTP 429', { message: 'HTTP 429' }, 'ENDPOINT'],
  ['HTTP 503', { message: 'HTTP 503' }, 'ENDPOINT'],
  ['transport', { name: 'TypeError', message: 'fetch failed' }, 'ENDPOINT'],
  // No JSON-RPC code: not an endpoint's answer about the query, even if a
  // needle ("limit") happens to appear.
  [
    'source text with a needle',
    { message: 'Myotis has too many reads queued; limit reached' },
    'ENDPOINT',
  ],
])('ranks %s as %s', (_name, fields, rank) => {
  expect(rankLogScanError(Object.assign(new Error(fields.message), fields))).toBe(
    LOG_SCAN_ERROR_RANK[rank]
  );
});

test('a timeout reaches Ant worded so it halves its window', () => {
  const deadline = Object.assign(new Error('Myotis gave up after 5000ms'), {
    failureKind: 'timeout',
  });
  const reply = antErrorReply('eth_getLogs', deadline);
  expect(reply).toMatchObject({ code: -32002 });
  expect(antShrinksLogScanOn(reply.message)).toBe(true);
  // Untouched for methods Ant does not adapt.
  expect(antErrorReply('eth_call', deadline).message).toBe(
    'Chain request failed: Myotis gave up after 5000ms'
  );
});

test('an endpoint-dependent failure reaches Ant without wording it would halve on', () => {
  for (const error of [
    Object.assign(new Error('rate limit exceeded'), { code: -32005 }),
    Object.assign(new Error('project ID request rate exceeded'), { code: -32005 }),
    new Error('All chain sources failed for eth_getLogs (direct: limit exceeded)'),
  ]) {
    const reply = antErrorReply('eth_getLogs', error);
    expect(antShrinksLogScanOn(reply.message)).toBe(false);
    expect(reply.code).toBe(Number.isSafeInteger(error.code) ? error.code : -32002);
  }
  // A coded reply not positively identified as a throttle may be a range cap
  // worded outside the REQUEST list: it keeps its text, so Ant still halves.
  for (const message of [
    'query exceeds limit of 10000 logs',
    'limit exceeded',
    'Request exceeds defined limit',
    'Exceeded max log count',
    'backend response too large',
  ]) {
    const reply = antErrorReply('eth_getLogs', Object.assign(new Error(message), { code: -32005 }));
    expect(reply.message).toBe(`Chain request failed: ${message}`);
    expect(antShrinksLogScanOn(reply.message)).toBe(true);
  }
  // A range limit and methods Ant does not adapt keep their text.
  const range = Object.assign(new Error('query exceeds max block range 50000'), { code: -32005 });
  expect(antErrorReply('eth_getLogs', range).message).toContain('max block range 50000');
  const throttle = Object.assign(new Error('rate limit exceeded'), { code: -32005 });
  expect(antErrorReply('eth_call', throttle).message).toBe(
    'Chain request failed: rate limit exceeded'
  );
});

test("Ant's shrink needles match v0.5.45 is_range_limit_error", () => {
  expect(antShrinksLogScanOn('Query Timeout')).toBe(true);
  expect(antShrinksLogScanOn('Log response size exceeded')).toBe(true);
  expect(antShrinksLogScanOn('the method eth_getLogs does not exist/is not available')).toBe(false);
  expect(antShrinksLogScanOn(undefined)).toBe(false);
});

test('preserves revert code and hex data', async () => {
  router.request.mockRejectedValue(Object.assign(new Error('revert'), { code: 3, data: '0xabcd' }));
  expect((await post(bridge.url, rpc('eth_call', [{}]))).body.error).toEqual({
    code: 3,
    message: 'Execution reverted',
    data: '0xabcd',
  });
});

test('light mode only broadcasts signed Gnosis transactions, once', async () => {
  await bridge.close();
  bridge = await startAntChainBridge({ router, log, allowBroadcast: true });
  const wallet = Wallet.createRandom();
  const base = { to: wallet.address, value: 0, nonce: 0, gasLimit: 21000, gasPrice: 1 };
  for (const chainId of [1, 0]) {
    const raw = await wallet.signTransaction({ ...base, chainId });
    expect((await post(bridge.url, rpc('eth_sendRawTransaction', [raw]))).body.error.code).toBe(
      -32602
    );
  }
  const raw = await wallet.signTransaction({ ...base, chainId: 100 });
  expect((await post(bridge.url, rpc('eth_sendRawTransaction', [raw]))).body.result).toBe('0xhash');
  expect(router.broadcastRawTransaction).toHaveBeenCalledTimes(1);
  expect(router.broadcastRawTransaction).toHaveBeenCalledWith(100, raw, {
    signal: expect.any(AbortSignal),
  });
  expect(JSON.stringify(log.info.mock.calls)).not.toContain(raw);
});

test('stop revokes the capability and aborts pending routing', async () => {
  let entered;
  const began = new Promise((resolve) => {
    entered = resolve;
  });
  router.request.mockImplementation(
    (_chain, _method, _params, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
        entered();
      })
  );
  const response = post(bridge.url, rpc()).catch(() => null);
  await began;
  await bridge.close();
  expect(await response).toBeNull();
  await expect(post(bridge.url, rpc())).rejects.toThrow();
});

test('deadline aborts routing and frees no capacity until work settles', async () => {
  await bridge.close();
  bridge = await startAntChainBridge({ router, log, timeoutMs: 30 });
  let signal;
  router.request.mockImplementation((_c, _m, _p, options) => {
    signal = options.signal;
    return new Promise((resolve) =>
      signal.addEventListener('abort', () => resolve({ result: null }))
    );
  });
  const response = await post(bridge.url, rpc());
  expect(response.body.error.code).toBe(-32002);
  expect(signal.aborted).toBe(true);
});

test('buffers split child log tokens and truncates oversized lines', () => {
  const stream = new EventEmitter();
  const write = jest.fn();
  const token = bridge.url.split('/').pop();
  bridge.pipeLog(stream, write);
  stream.emit('data', `failed http://127.0.0.1/ant-chain/${token.slice(0, 20)}`);
  stream.emit('data', token.slice(20) + '\n');
  stream.emit('data', 'panic: ' + 'a'.repeat(65537));
  stream.emit('data', token + '\nclean\n');
  expect(write.mock.calls[0]).toEqual(['failed http://127.0.0.1/ant-chain/[redacted]']);
  const long = write.mock.calls[1][0];
  expect(long.startsWith('panic: aaa')).toBe(true);
  expect(long).toMatch(/… \[truncated \d+ chars\]$/);
  expect(long.length).toBeLessThan(65536 + 100);
  expect(long).not.toContain(token.slice(0, 8));
  expect(write.mock.calls[2]).toEqual(['clean']);
  expect(write).toHaveBeenCalledTimes(3);
});

test('a capability straddling the truncation point is redacted, never partially logged', () => {
  const token = bridge.url.split('/').pop();
  for (const offset of [1, 10, 32, 63]) {
    const stream = new EventEmitter();
    const write = jest.fn();
    bridge.pipeLog(stream, write);
    // Two capabilities: one early (shrinks on redaction), one across the cut.
    const prefix = token + 'b'.repeat(65536 - token.length - offset);
    stream.emit('data', prefix + token + 'c'.repeat(200));
    stream.emit('end');
    const [[out]] = write.mock.calls;
    for (let n = 8; n <= token.length; n += 8) expect(out).not.toContain(token.slice(0, n));
    expect(out).toContain('[redacted]');
  }
});

test('bounds simultaneous requests including work still settling', async () => {
  let count = 0;
  let entered;
  const began = new Promise((resolve) => {
    entered = resolve;
  });
  router.request.mockImplementation(
    (_c, _m, _p, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('stopped')));
        if (++count === 8) entered();
      })
  );
  const pending = Array.from({ length: 8 }, () => post(bridge.url, rpc()).catch(() => null));
  await began;
  expect((await post(bridge.url, rpc())).status).toBe(503);
  expect(router.request).toHaveBeenCalledTimes(8);
  await bridge.close();
  await Promise.all(pending);
});

test('restart uses a fresh capability and rejects the previous one', async () => {
  const oldPath = new URL(bridge.url).pathname;
  await bridge.close();
  bridge = await startAntChainBridge({ router, log });
  expect(new URL(bridge.url).pathname).not.toBe(oldPath);
  const oldCapabilityAtNewPort = new URL(oldPath, bridge.url).href;
  expect((await post(oldCapabilityAtNewPort, rpc())).status).toBe(403);
  expect(router.request).not.toHaveBeenCalled();
});

test('oversized and missing answers fail instead of producing partial data', async () => {
  router.request.mockResolvedValue({ result: 'x'.repeat(16 * 1024 * 1024) });
  expect((await post(bridge.url, rpc())).body.error.code).toBe(-32002);
  router.request.mockResolvedValue({ source: 'direct' });
  expect((await post(bridge.url, rpc())).body.error.code).toBe(-32002);
});

test('uncertain broadcasts and real RPC rejections are never retried by the bridge', async () => {
  await bridge.close();
  bridge = await startAntChainBridge({ router, log, allowBroadcast: true });
  const wallet = Wallet.createRandom();
  const raw = await wallet.signTransaction({
    to: wallet.address,
    nonce: 0,
    value: 0,
    chainId: 100,
    gasLimit: 21000,
    gasPrice: 1,
  });
  for (const code of ['MYOTIS_BROADCAST_UNCERTAIN', -32000]) {
    router.broadcastRawTransaction.mockRejectedValue(
      Object.assign(new Error('private details'), { code })
    );
    const response = await post(bridge.url, rpc('eth_sendRawTransaction', [raw]));
    expect(response.body).not.toHaveProperty('result');
    expect(response.body.error.code).toBe(typeof code === 'number' ? code : -32002);
    if (typeof code === 'string') expect(response.body.error.message).toContain('uncertain');
  }
  expect(router.broadcastRawTransaction).toHaveBeenCalledTimes(2);
});
