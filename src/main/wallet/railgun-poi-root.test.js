let mockEndpoint, mockAvailable;
const mockRequest = jest.fn(),
  mockClients = [];
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: jest.fn(() => {
    const client = { request: mockRequest, close: jest.fn() };
    mockClients.push(client);
    return client;
  }),
}));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => mockAvailable }));
// Use genuine opaque context handles so owner cancellation and child isolation
// exercise the real capability lifetime; only the Tor endpoint/I/O are mocked.
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createWalletTorTransport } = require('../networks/wallet-tor-transport');
const {
  createRailgunPoiRootSource: create,
  MAX_AGE_MS,
  ACQUIRE_TIMEOUT_MS,
  MAX_ACQUIRE_MS,
} = require('./railgun-poi-root');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
const subject = {
  kind: 'private-account',
  principal: 'railgun:0',
  protocol: 'railgun',
  deployment: 'sepolia',
  chainId: 11155111,
  role: 'poi',
  operation: 'poi:' + 'a'.repeat(64),
};
let scope, handle, parentController, endpointController, current, sources, work, gates;
const reply = (options, result = true) => ({
  status: 200,
  body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result })),
});
const open = (options = { handle, root: hex(9) }) => {
  const source = create(options);
  sources.push(source);
  return source;
};
const acquire = (source, options) => {
  const pending = source.acquire(options);
  pending.catch(() => {});
  work.push(pending);
  return pending;
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  const gate = { promise, resolve, reject };
  gates.push(gate);
  return gate;
};
const refusal = { code: 'RAILGUN_POI_ROOT_REFUSED', message: 'Railgun POI root unavailable' };
const expectSanitizedError = (error, code = refusal.code) => {
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ ...refusal, code });
  expect(Object.keys(error)).toEqual(['code']);
  expect(error.cause).toBeUndefined();
  expect(error.message).not.toContain(hex(9));
};
const expectSanitized = (operation) => {
  let failure;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expectSanitizedError(failure);
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockClients.length = 0;
  sources = [];
  work = [];
  gates = [];
  current = mockAvailable = true;
  parentController = new AbortController();
  endpointController = new AbortController();
  mockEndpoint = { signal: endpointController.signal };
  scope = createPrivacyScope({
    profileId: 'root-unit',
    signal: parentController.signal,
    isCurrent: () => current,
  });
  handle = scope.getContext(subject);
  mockRequest.mockImplementation(async (_handle, _url, options) => reply(options));
});
afterEach(async () => {
  for (const source of sources) source.close();
  for (const gate of gates) gate.resolve();
  await Promise.allSettled(work);
  await Promise.all(sources.map((source) => source.closed));
  scope.close();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('one fixed root request uses a separate operation context and grants service acceptance only', async () => {
  const source = open(),
    result = await acquire(source);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  const [child, url, options] = mockRequest.mock.calls[0];
  expect(url).toBe('https://ppoi.fdi.network');
  expect(child).not.toBe(handle);
  const childContext = getPrivacyContext(child),
    parentContext = getPrivacyContext(handle);
  expect(childContext.subject).toEqual(subject);
  expect(childContext.profileId).toBe(parentContext.profileId);
  expect(childContext.isolationToken).not.toBe(parentContext.isolationToken);
  expect(childContext.requirements).toEqual(parentContext.requirements);
  expect(Object.keys(options).sort()).toEqual(['body', 'headers', 'method', 'signal', 'timeoutMs']);
  expect(options).toMatchObject({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    timeoutMs: 15000,
  });
  expect(options.signal).toBe(source.signal);
  const request = JSON.parse(options.body);
  expect(request).toEqual({
    jsonrpc: '2.0',
    id: expect.any(String),
    method: 'ppoi_validate_poi_merkleroots',
    params: {
      chainType: '0',
      chainID: '11155111',
      txidVersion: 'V2_PoseidonMerkle',
      listKey: REQUIRED_LIST,
      poiMerkleroots: [hex(9)],
    },
  });
  expect(request.id.length).toBeGreaterThan(0);
  expect(result.observation).toEqual({
    listKey: REQUIRED_LIST,
    root: hex(9),
    accepted: true,
    observedAt: expect.any(String),
    trust: 'unverified-service',
    membershipVerified: false,
    disclosureEnabled: false,
    spendingEnabled: false,
  });
  expect(Number.isFinite(Date.parse(result.observation.observedAt))).toBe(true);
  expect(source.assertResult(result.receipt)).toBe(result.observation);
  expect(Object.isFrozen(source)).toBe(true);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.receipt)).toBe(true);
  expect(Object.keys(result.receipt)).toEqual([]);
  expect(Object.isFrozen(result.observation)).toBe(true);
  expect(Object.keys(source).sort()).toEqual([
    'acquire',
    'assertResult',
    'close',
    'closed',
    'signal',
  ]);
  source.close();
  await source.closed;
  expect(() => getPrivacyContext(child)).toThrow();
  expect(() => getPrivacyContext(handle)).not.toThrow();
  expectSanitized(() => source.assertResult(result.receipt));
});

test.each([0n, FIELD - 1n])(
  'accepts exact field boundary %s without rewriting the root',
  async (n) => {
    const source = open({ handle, root: hex(n) });
    expect((await acquire(source)).observation.root).toBe(hex(n));
  }
);
test.each([
  '',
  '0'.repeat(63),
  '0'.repeat(65),
  '0x' + hex(9),
  'A'.repeat(64),
  'g'.repeat(64),
  hex(FIELD),
  hex(FIELD + 1n),
  'f'.repeat(64),
  null,
  9,
  [hex(9)],
])('rejects invalid root %p before constructing transport', (root) => {
  expectSanitized(() => open({ handle, root }));
  expect(createWalletTorTransport).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
});
test.each([
  'missing-root',
  'missing-handle',
  'notes',
  'url',
  'list',
  'array',
  'null',
  'forged-handle',
])('rejects factory %s shape before constructing transport', (fault) => {
  let value = { handle, root: hex(9) };
  if (fault === 'missing-root') delete value.root;
  if (fault === 'missing-handle') delete value.handle;
  if (fault === 'notes') value.notes = [];
  if (fault === 'url') value.url = 'https://example.invalid';
  if (fault === 'list') value.listKey = REQUIRED_LIST;
  if (fault === 'array') value = [];
  if (fault === 'null') value = null;
  if (fault === 'forged-handle') value.handle = {};
  expectSanitized(() => open(value));
  expect(createWalletTorTransport).not.toHaveBeenCalled();
});
test.each([
  ['kind', 'service'],
  ['principal', 'railgun:01'],
  ['principal', 'railgun:-1'],
  ['principal', 'railgun:65536'],
  ['principal', 'wallet:0'],
  ['protocol', 'other'],
  ['deployment', 'mainnet'],
  ['chainId', 1],
  ['role', 'public-services'],
  ['operation', 'poi:' + 'A'.repeat(64)],
  ['operation', 'poi:' + 'a'.repeat(63)],
  ['operation', 'proof:' + 'a'.repeat(64)],
  ['operation', undefined],
])('refuses subject %s=%p before transport', (key, value) => {
  const other = scope.getContext({ ...subject, [key]: value });
  expectSanitized(() => open({ handle: other, root: hex(9) }));
  expect(createWalletTorTransport).not.toHaveBeenCalled();
});
test('accepts the highest enrolled account index', async () => {
  const source = open({
    handle: scope.getContext({ ...subject, principal: 'railgun:65535' }),
    root: hex(9),
  });
  await acquire(source);
  expect(getPrivacyContext(mockRequest.mock.calls[0][0]).subject.principal).toBe('railgun:65535');
});
test.each([
  { content: 'pir' },
  { correctness: 'proof' },
  { correctness: 'quorum' },
  { maxAgeMs: 0 },
  { maxAgeMs: 60000 },
])('refuses stronger/nondefault requirements %p without downgrading', (requirements) => {
  const other = scope.getContext(subject, requirements);
  expectSanitized(() => open({ handle: other, root: hex(9) }));
  expect(createWalletTorTransport).not.toHaveBeenCalled();
});
test.each(['feature', 'endpoint', 'endpoint-aborted', 'owner-aborted', 'generation'])(
  'refuses unavailable %s at construction',
  (fault) => {
    if (fault === 'feature') mockAvailable = false;
    if (fault === 'endpoint') mockEndpoint = undefined;
    if (fault === 'endpoint-aborted') endpointController.abort();
    if (fault === 'owner-aborted') parentController.abort();
    if (fault === 'generation') current = false;
    expectSanitized(() => open());
    expect(createWalletTorTransport).not.toHaveBeenCalled();
  }
);
test('copies the root selection before asynchronous transport work', async () => {
  const input = { handle, root: hex(9) },
    source = open(input);
  input.root = hex(10);
  expect((await acquire(source)).observation.root).toBe(hex(9));
});

test.each([1, 45000])('accepts bounded acquisition timeout %s', async (timeoutMs) => {
  await acquire(open(), { timeoutMs });
  expect(mockRequest.mock.calls[0][2].timeoutMs).toBe(timeoutMs);
});
test.each([0, -1, 0.5, 45001, NaN, Infinity, '15000', null])(
  'rejects timeout %p before I/O',
  async (timeoutMs) => {
    const source = open();
    await expect(acquire(source, { timeoutMs })).rejects.toMatchObject(refusal);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(source.signal.aborted).toBe(false);
  }
);
test.each([
  { root: hex(10) },
  { signal: null },
  { method: 'other' },
  { timeoutMs: 1, extra: true },
  [],
  null,
])('rejects acquisition argument %p before I/O', async (options) => {
  await expect(acquire(open(), options)).rejects.toMatchObject(refusal);
  expect(mockRequest).not.toHaveBeenCalled();
});
test.each([
  'false',
  'null',
  'string',
  'array',
  'object',
  'http',
  'id',
  'version',
  'extra',
  'error',
  'missing',
  'json',
  'oversized',
  'nonbuffer',
  'transport',
])(
  '%s response closes source, distinguishes rejection and invalidates prior receipt',
  async (fault) => {
    const source = open(),
      first = await acquire(source);
    mockRequest.mockImplementationOnce(async (_h, _u, options) => {
      if (fault === 'transport') throw Error('sensitive remote response');
      const response = reply(options),
        body = JSON.parse(response.body);
      if (fault === 'false') body.result = false;
      if (fault === 'null') body.result = null;
      if (fault === 'string') body.result = 'true';
      if (fault === 'array') body.result = [true];
      if (fault === 'object') body.result = { accepted: true };
      if (fault === 'http') response.status = 302;
      if (fault === 'id') body.id = 'another-request';
      if (fault === 'version') body.jsonrpc = '1.0';
      if (fault === 'extra') body.extra = true;
      if (fault === 'error') body.error = { message: 'sensitive remote response' };
      if (fault === 'missing') delete body.result;
      response.body =
        fault === 'json'
          ? Buffer.from('{')
          : fault === 'oversized'
            ? Buffer.alloc(4097)
            : fault === 'nonbuffer'
              ? JSON.stringify(body)
              : Buffer.from(JSON.stringify(body));
      return response;
    });
    const error = await acquire(source).catch((error) => error);
    expectSanitizedError(error, fault === 'false' ? 'RAILGUN_POI_ROOT_REJECTED' : refusal.code);
    await source.closed;
    expect(source.signal.aborted).toBe(true);
    expect(mockClients[0].close).toHaveBeenCalledTimes(1);
    expectSanitized(() => source.assertResult(first.receipt));
    await expect(acquire(source)).rejects.toMatchObject(refusal);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  }
);
test.each([
  'http',
  'id',
  'version',
  'extra',
  'rpc-error',
  'expired-before-parse',
  'expired-after-parse',
  'revoked',
])('false with %s is unavailable, not a validated Boolean rejection', async (fault) => {
  let now = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  mockRequest.mockImplementationOnce(async (_h, _u, options) => {
    const response = reply(options, false),
      body = JSON.parse(response.body);
    if (fault === 'http') response.status = 500;
    if (fault === 'id') body.id = 'wrong-request';
    if (fault === 'version') body.jsonrpc = '1.0';
    if (fault === 'extra') body.extra = hex(9);
    if (fault === 'rpc-error') body.error = { code: 'RAILGUN_POI_ROOT_REJECTED', message: hex(9) };
    response.body = Buffer.from(JSON.stringify(body));
    if (fault === 'expired-before-parse') now += ACQUIRE_TIMEOUT_MS;
    if (fault === 'expired-after-parse') {
      const text = response.body.toString();
      response.body.toString = () => {
        now += ACQUIRE_TIMEOUT_MS;
        return text;
      };
    }
    if (fault === 'revoked') parentController.abort();
    return response;
  });
  const source = open();
  expectSanitizedError(await acquire(source).catch((error) => error));
  await source.closed;
  expect(source.signal.aborted).toBe(true);
});
test('transport cannot spoof the locally classified rejection code or expose its root', async () => {
  mockRequest.mockRejectedValueOnce(
    Object.assign(Error('remote ' + hex(9)), {
      code: 'RAILGUN_POI_ROOT_REJECTED',
      cause: { root: hex(9) },
    })
  );
  const source = open();
  expectSanitizedError(await acquire(source).catch((error) => error));
  await source.closed;
  expect(source.signal.aborted).toBe(true);
});
test('transport construction errors are sanitized without querying', () => {
  createWalletTorTransport.mockImplementationOnce(() => {
    throw Object.assign(Error(hex(9)), { code: 'RAILGUN_POI_ROOT_REJECTED' });
  });
  expectSanitized(() => open());
  expect(mockRequest).not.toHaveBeenCalled();
  expect(() => getPrivacyContext(handle)).not.toThrow();
});
test('receipts cannot be forged, cloned or transplanted between sources for the same root', async () => {
  const a = open(),
    b = open(),
    result = await acquire(a),
    other = await acquire(b);
  for (const value of [{}, { ...result.receipt }, result.observation, other.receipt, null])
    expectSanitized(() => a.assertResult(value));
  expect(b.assertResult(other.receipt)).toBe(other.observation);
});
test('busy acquisition excludes overlap and invalidates the previous sequence immediately', async () => {
  const source = open(),
    first = await acquire(source),
    gate = deferred();
  mockRequest.mockImplementationOnce(async (_h, _u, options) => {
    await gate.promise;
    return reply(options);
  });
  const pending = acquire(source);
  expectSanitized(() => source.assertResult(first.receipt));
  await expect(acquire(source)).rejects.toMatchObject(refusal);
  expect(mockRequest).toHaveBeenCalledTimes(2);
  expect(source.signal.aborted).toBe(false);
  gate.resolve();
  const second = await pending;
  expectSanitized(() => source.assertResult(first.receipt));
  expect(source.assertResult(second.receipt)).toBe(second.observation);
  expect(JSON.parse(mockRequest.mock.calls[0][2].body).id).not.toBe(
    JSON.parse(mockRequest.mock.calls[1][2].body).id
  );
});

test('freshness includes acquisition latency and applies a strict remaining margin', async () => {
  let now = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  mockRequest.mockImplementationOnce(async (_h, _u, options) => {
    now += 20000;
    return reply(options);
  });
  const source = open(),
    result = await acquire(source, { timeoutMs: 45000 });
  expect(source.assertResult(result.receipt, 39999)).toBe(result.observation);
  expectSanitized(() => source.assertResult(result.receipt, 40000));
  now = 1000 + MAX_AGE_MS - 1;
  expect(source.assertResult(result.receipt)).toBe(result.observation);
  now++;
  expectSanitized(() => source.assertResult(result.receipt));
});
test.each([-1, 0.5, NaN, Infinity, 60000, '1', null])(
  'rejects invalid margin %p',
  async (margin) => {
    const source = open(),
      result = await acquire(source);
    expectSanitized(() => source.assertResult(result.receipt, margin));
  }
);
test.each(['equal-deadline', 'past-deadline', 'regression'])(
  'refuses %s before issuing a receipt even without timer dispatch',
  async (fault) => {
    let now = 1000;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    mockRequest.mockImplementationOnce(async (_h, _u, options) => {
      now = fault === 'regression' ? 999 : 1000 + (fault === 'equal-deadline' ? 15000 : 15001);
      return reply(options);
    });
    const source = open();
    await expect(acquire(source)).rejects.toMatchObject(refusal);
    expect(source.signal.aborted).toBe(true);
    await source.closed;
  }
);
test('receipt assertion rejects monotonic clock regression', async () => {
  const clock = jest.spyOn(performance, 'now').mockReturnValue(1000);
  const source = open(),
    result = await acquire(source);
  clock.mockReturnValue(999);
  expectSanitized(() => source.assertResult(result.receipt));
});
test.each(['close', 'owner', 'endpoint-abort', 'endpoint-replacement', 'generation'])(
  '%s revokes issued evidence',
  async (fault) => {
    const source = open(),
      result = await acquire(source);
    if (fault === 'close') source.close();
    if (fault === 'owner') parentController.abort();
    if (fault === 'endpoint-abort') endpointController.abort();
    if (fault === 'endpoint-replacement') mockEndpoint = { signal: new AbortController().signal };
    if (fault === 'generation') current = false;
    expectSanitized(() => source.assertResult(result.receipt));
    await expect(acquire(source)).rejects.toMatchObject(refusal);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  }
);
test.each(['close', 'owner', 'endpoint', 'timeout', 'late-rejection'])(
  '%s revokes immediately but closed/acquire wait for ignored-signal transport drain',
  async (fault) => {
    const source = open(),
      first = await acquire(source),
      gate = deferred();
    mockRequest.mockImplementationOnce(async (_h, _u, options) => {
      await gate.promise;
      return reply(options);
    });
    let acquired = false,
      closed = false;
    const pending = acquire(source).catch((error) => {
      acquired = true;
      return error;
    });
    source.closed.then(() => {
      closed = true;
    });
    if (fault === 'owner') parentController.abort();
    else if (fault === 'endpoint') endpointController.abort();
    else if (fault === 'timeout') jest.advanceTimersByTime(ACQUIRE_TIMEOUT_MS);
    else source.close();
    await Promise.resolve();
    expect(source.signal.aborted).toBe(true);
    expect(mockClients[0].close).toHaveBeenCalledTimes(1);
    expectSanitized(() => source.assertResult(first.receipt));
    expect(acquired).toBe(false);
    expect(closed).toBe(false);
    await expect(acquire(source)).rejects.toMatchObject(refusal);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    if (fault === 'late-rejection') gate.reject(Error('private transport failure'));
    else gate.resolve();
    expect(await pending).toMatchObject(refusal);
    await source.closed;
    expect(closed).toBe(true);
    source.close();
    expect(mockClients[0].close).toHaveBeenCalledTimes(1);
  }
);
test('endpoint replacement during I/O closes and drains before rejecting its response', async () => {
  const source = open(),
    gate = deferred();
  mockRequest.mockImplementationOnce(async (_h, _u, options) => {
    await gate.promise;
    return reply(options);
  });
  const pending = acquire(source);
  mockEndpoint = { signal: new AbortController().signal };
  gate.resolve();
  await expect(pending).rejects.toMatchObject(refusal);
  await source.closed;
  expect(source.signal.aborted).toBe(true);
});
test('successful acquisition clears its timer and idle close settles once', async () => {
  const source = open();
  await acquire(source);
  jest.advanceTimersByTime(MAX_ACQUIRE_MS);
  expect(source.signal.aborted).toBe(false);
  source.close();
  source.close();
  await source.closed;
  expect(mockClients[0].close).toHaveBeenCalledTimes(1);
});
