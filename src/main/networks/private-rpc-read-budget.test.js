let mockEndpoint, mockUrls;
const mockRequest = jest.fn(),
  mockFactory = jest.fn(),
  mockRelease = jest.fn();
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('./network-registry', () => ({
  getNetwork: () => ({}),
  getEndpoints: () => mockUrls,
  getEndpointSources: () => [{ keyed: false, coverage: { 11155111: mockUrls[0] } }],
}));
jest.mock('./wallet-tor-transport', () => ({
  createWalletTorTransport: (...args) => mockFactory(...args),
}));
const address = '0x' + '1'.repeat(40);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise(setImmediate);
let api, scope, handle, client, tor, caller, budgets;
const envelope = () => ({ headers: [{ tag: 'finalized', maxRequests: 4 }] });
function make(overrides = {}) {
  const options = {
    client,
    handle,
    destination: api.getPrivateRpcDestination(client, handle),
    signal: caller.signal,
    deadline: performance.now() + 12000,
    envelope: envelope(),
    ...overrides,
  };
  const value = api.createPrivateRpcReadBudget(options);
  budgets.push(value);
  return value;
}
const outcome = (value) => api.getPrivateRpcReadBudgetOutcome(value.budget);
const read = (value, tag = 'finalized', validate = () => true) =>
  client.request('eth_getBlockByNumber', [tag, false], validate, value.budget);
function reply(options, result) {
  const wire = JSON.parse(options.body);
  return {
    status: 200,
    body: Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: wire.id,
        result:
          result === undefined
            ? wire.method === 'eth_chainId'
              ? '0xaa36a7'
              : { number: '0x1' }
            : result,
      })
    ),
  };
}
const methods = () =>
  mockRequest.mock.calls.map(([, , options]) => JSON.parse(options.body).method);
beforeEach(() => {
  jest.resetModules();
  jest.resetAllMocks();
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  api = require('./private-rpc');
  tor = new AbortController();
  caller = new AbortController();
  mockEndpoint = { signal: tor.signal };
  mockUrls = ['https://rpc.example.test/retained-path'];
  scope = require('./privacy-context').createPrivacyScope({
    profileId: 'read-budget-fixture',
    signal: new AbortController().signal,
  });
  handle = scope.getContext({
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'protocol-rpc',
  });
  client = api.createPrivateRpc(handle, 'protocol-rpc');
  budgets = [];
  mockFactory.mockReturnValue({ request: mockRequest, release: mockRelease });
  mockRequest.mockImplementation(async (_handle, _url, options) => reply(options));
});
afterEach(async () => {
  for (const value of budgets) value.close();
  await Promise.all(budgets.map((value) => value.closed));
  scope.close();
  tor.abort();
  jest.useRealTimers();
});
test('opaque genuine budget, zero-work creation, frozen redacted outcome and idle close', async () => {
  const value = make();
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.budget)).toBe(true);
  expect(JSON.stringify(value.budget)).toBe('{}');
  expect(outcome(value)).toEqual({
    status: 'active',
    reason: null,
    fatal: false,
    failure: null,
    integrityFailure: false,
    pending: 0,
    admissions: { chainId: 0, headers: 0, eventHeaders: 0, logs: 0 },
  });
  expect(Object.isFrozen(outcome(value).admissions)).toBe(true);
  expect(mockFactory).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
  value.close();
  value.close();
  await value.closed;
  expect(outcome(value)).toMatchObject({
    status: 'closed',
    reason: 'completed',
    integrityFailure: false,
  });
  expect(JSON.stringify(outcome(value))).not.toMatch(/retained-path|11155111|railgun:0/);
});
test.each([
  ['forged client', { client: {} }],
  ['handle', { handle: {} }],
  ['destination', { destination: {} }],
  ['signal null', { signal: null }],
  ['signal false', { signal: false }],
  ['signal object', { signal: { aborted: false } }],
  ['deadline equal', { deadline: 0 }],
  ['deadline negative', { deadline: -1 }],
  ['deadline NaN', { deadline: NaN }],
  ['deadline infinite', { deadline: Infinity }],
  ['deadline too far', { deadline: 180001 }],
  ['extra', { authority: true }],
])('constructor refuses %s without networking', (_name, overrides) => {
  expect(() => make(overrides)).toThrow('Private RPC read budget unavailable');
  expect(mockRequest).not.toHaveBeenCalled();
});
test.each([
  null,
  [],
  {},
  { headers: [], extra: true },
  {
    headers: Array.from({ length: 6 }, (_, n) => ({ tag: '0x' + n.toString(16), maxRequests: 1 })),
  },
  { headers: [{ tag: 'latest', maxRequests: 1 }] },
  { headers: [{ tag: '0x01', maxRequests: 1 }] },
  { headers: [{ tag: '0xA', maxRequests: 1 }] },
  { headers: [{ tag: '0x20000000000000', maxRequests: 1 }] },
  { headers: [{ tag: 'finalized', maxRequests: 0 }] },
  { headers: [{ tag: 'finalized', maxRequests: 5 }] },
  { headers: [{ tag: 'finalized', maxRequests: 1.5 }] },
  { headers: [{ tag: 'finalized', maxRequests: 1, extra: true }] },
  {
    headers: [
      { tag: 'finalized', maxRequests: 1 },
      { tag: 'finalized', maxRequests: 2 },
    ],
  },
  { headers: [], logs: { address, fromBlock: '0x2', toBlock: '0x1' } },
  { headers: [], logs: { address: '0x' + 'A'.repeat(40), fromBlock: '0x0', toBlock: '0x1' } },
  { headers: [], logs: { address, fromBlock: '0x0', toBlock: '0x1', topics: [] } },
  { headers: [], eventHeaders: { fromBlock: '0x0', toBlock: '0x1', maxRequests: 513 } },
  { headers: [], eventHeaders: { fromBlock: '0x0', toBlock: '0x1', maxRequests: 0 } },
  { headers: [], eventHeaders: { fromBlock: '0x2', toBlock: '0x1', maxRequests: 1 } },
])('closed envelope rejects invalid case %#', (value) => {
  expect(() => make({ envelope: value })).toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
test('constructor refuses accessors without evaluating them', () => {
  const getter = jest.fn();
  const value = { headers: [] };
  Object.defineProperty(value, 'logs', { enumerable: true, get: getter });
  expect(() => make({ envelope: value })).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
test('safe integer boundary and maximum deadline/envelope are accepted', () => {
  make({
    deadline: 180000,
    envelope: {
      headers: [
        { tag: '0x1fffffffffffff', maxRequests: 4 },
        { tag: '0x0', maxRequests: 4 },
        { tag: '0x1', maxRequests: 4 },
        { tag: '0x2', maxRequests: 4 },
        { tag: 'finalized', maxRequests: 4 },
      ],
      eventHeaders: { fromBlock: '0x0', toBlock: '0x1fffffffffffff', maxRequests: 512 },
    },
  });
});
test('exact header quotas precede unique range quotas and count only actual admissions', async () => {
  const value = make({
    envelope: {
      headers: [{ tag: '0x1', maxRequests: 2 }],
      eventHeaders: { fromBlock: '0x1', toBlock: '0x3', maxRequests: 2 },
    },
  });
  for (const tag of ['0x1', '0x1', '0x1', '0x2']) await read(value, tag);
  expect(outcome(value).admissions).toEqual({ chainId: 1, headers: 2, eventHeaders: 2, logs: 0 });
  await expect(read(value, '0x3')).rejects.toThrow();
  expect(mockRequest).toHaveBeenCalledTimes(5);
  expect(outcome(value)).toMatchObject({ reason: 'admission-refused', integrityFailure: false });
});
test('event heights cannot be repeated even with remaining total allowance', async () => {
  const value = make({
    envelope: { headers: [], eventHeaders: { fromBlock: '0x0', toBlock: '0x5', maxRequests: 5 } },
  });
  await read(value, '0x2');
  await expect(read(value, '0x2')).rejects.toThrow();
  expect(methods()).toEqual(['eth_chainId', 'eth_getBlockByNumber']);
});
test('all 512 event admissions are bounded with one shared chain-ID', async () => {
  const value = make({
    envelope: {
      headers: [],
      eventHeaders: { fromBlock: '0x0', toBlock: '0x200', maxRequests: 512 },
    },
  });
  for (let n = 0; n < 512; n++) await read(value, '0x' + n.toString(16));
  await expect(read(value, '0x200')).rejects.toThrow();
  expect(outcome(value).admissions.eventHeaders).toBe(512);
  expect(mockRequest).toHaveBeenCalledTimes(513);
});
test('one exact logs request and immutable params/envelope across shared readiness', async () => {
  const hold = deferred();
  mockRequest.mockImplementation(async (_h, _u, options) => {
    await hold.promise;
    return reply(options);
  });
  const filter = { address, fromBlock: '0x0', toBlock: '0x2' };
  const config = { headers: [], logs: { ...filter } };
  const value = make({ envelope: config });
  const params = [filter];
  const work = client.request('eth_getLogs', params, () => true, value.budget);
  config.logs.toBlock = filter.toBlock = '0x9';
  params.push('secret');
  await flush();
  hold.resolve();
  await work;
  expect(JSON.parse(mockRequest.mock.calls[1][2].body).params).toEqual([
    { address, fromBlock: '0x0', toBlock: '0x2' },
  ]);
  await expect(
    client.request(
      'eth_getLogs',
      [{ address, fromBlock: '0x0', toBlock: '0x2' }],
      () => true,
      value.budget
    )
  ).rejects.toThrow();
  expect(outcome(value).admissions.logs).toBe(1);
});
test.each([
  ['eth_sendRawTransaction', ['secret']],
  ['eth_chainId', []],
  ['eth_getBlockByNumber', ['finalized', true]],
  ['eth_getBlockByNumber', ['0x01', false]],
  ['eth_getBlockByNumber', ['0x2', false]],
  ['eth_getBlockByNumber', ['finalized', false, 'secret']],
  ['eth_getLogs', [{ address, fromBlock: '0x0', toBlock: '0x1' }]],
])('out-of-envelope %s refuses before hidden chain query (%#)', async (method, params) => {
  const value = make();
  await expect(client.request(method, params, () => true, value.budget)).rejects.toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
  expect(outcome(value)).toMatchObject({ reason: 'admission-refused', integrityFailure: false });
});
test('forged/copied/cross-client budget cannot poison healthy operation', async () => {
  const value = make();
  const second = api.createPrivateRpc(handle, 'protocol-rpc');
  for (const token of [
    {},
    { ...value.budget },
    JSON.parse(JSON.stringify(value.budget)),
    Object.create(value.budget),
  ]) {
    await expect(
      client.request('eth_getBlockByNumber', ['finalized', false], () => true, token)
    ).rejects.toThrow();
    expect(() => api.getPrivateRpcReadBudgetOutcome(token)).toThrow();
  }
  await expect(
    second.request('eth_getBlockByNumber', ['finalized', false], () => true, value.budget)
  ).rejects.toThrow();
  expect(outcome(value)).toMatchObject({ status: 'active', integrityFailure: false });
  await read(value);
});
test('factory reentrancy: B joins before A cancels; no admission for either, no retry', async () => {
  const a = make(),
    b = make({ signal: new AbortController().signal });
  let bWork;
  mockFactory.mockImplementation(() => {
    bWork = read(b).catch((error) => error);
    caller.abort();
    return { request: mockRequest, release: mockRelease };
  });
  await expect(read(a)).rejects.toThrow();
  expect(await bWork).toBeInstanceOf(Error);
  await Promise.all([a.closed, b.closed]);
  expect(methods()).toEqual([]);
  expect(outcome(a)).toMatchObject({ integrityFailure: false, reason: 'cancelled' });
  expect(outcome(b)).toMatchObject({ integrityFailure: false, reason: 'shared-no-admission' });
  await expect(read(b)).rejects.toThrow();
  expect(methods()).toEqual([]);
});
test.each(['valid', 'malformed', 'wrong-chain'])(
  'transport reentrancy after chain admission: %s',
  async (mode) => {
    const a = make(),
      b = make({ signal: new AbortController().signal });
    let bWork;
    mockRequest.mockImplementation(async (_h, _u, options) => {
      if (JSON.parse(options.body).method === 'eth_chainId') {
        bWork = read(b).catch((error) => error);
        caller.abort();
        if (mode === 'malformed') return { status: 200, body: Buffer.from('invalid') };
        return reply(options, mode === 'wrong-chain' ? '0x1' : '0xaa36a7');
      }
      return reply(options);
    });
    await expect(read(a)).rejects.toThrow();
    const bResult = await bWork;
    expect(outcome(a).admissions.chainId).toBe(1);
    expect(outcome(b).admissions.chainId).toBe(0);
    if (mode === 'valid') {
      expect(bResult.result).toEqual({ number: '0x1' });
      expect(methods()).toEqual(['eth_chainId', 'eth_getBlockByNumber']);
      expect(outcome(a).integrityFailure).toBe(false);
      expect(outcome(b).integrityFailure).toBe(false);
    } else {
      expect(bResult).toBeInstanceOf(Error);
      expect(methods()).toEqual(['eth_chainId']);
      expect(outcome(a).integrityFailure).toBe(true);
      expect(outcome(b).integrityFailure).toBe(true);
      await expect(read(b)).rejects.toThrow();
      expect(mockRequest).toHaveBeenCalledTimes(1);
    }
  }
);
test.each(['false', 'throw', 'async-false'])(
  'validator cancels then %s: integrity wins',
  async (mode) => {
    const value = make();
    const validate = () => {
      caller.abort();
      if (mode === 'throw')
        throw Object.assign(new Error('secret'), { code: 'PRIVATE_RPC_READ_BUDGET_REFUSED' });
      return mode === 'async-false' ? Promise.resolve(false) : false;
    };
    await expect(read(value, 'finalized', validate)).rejects.toThrow(
      'Private RPC read budget unavailable'
    );
    await value.closed;
    expect(outcome(value)).toMatchObject({
      status: 'closed',
      reason: 'fatal',
      integrityFailure: true,
    });
  }
);
test('close waits deferred validator, with valid late result benign and no pooled release', async () => {
  const hold = deferred(),
    value = make();
  const validate = jest.fn(() => hold.promise);
  const work = read(value, 'finalized', validate).catch((error) => error);
  await flush();
  expect(validate).toHaveBeenCalledTimes(1);
  let drained = false;
  value.closed.then(() => {
    drained = true;
  });
  value.close();
  await flush();
  expect(drained).toBe(false);
  expect(outcome(value)).toMatchObject({ status: 'draining', pending: 1 });
  hold.resolve(true);
  expect(await work).toBeInstanceOf(Error);
  await value.closed;
  expect(drained).toBe(true);
  expect(outcome(value).integrityFailure).toBe(false);
  expect(mockRelease).not.toHaveBeenCalled();
});
test.each(['valid', 'malformed', 'reject'])(
  'local cancellation drains late transport %s',
  async (mode) => {
    await client.ready();
    mockRequest.mockClear();
    const hold = deferred(),
      value = make();
    mockRequest.mockImplementation(async (_h, _u, options) => {
      await hold.promise;
      if (mode === 'reject')
        throw Object.assign(Error('secret'), { code: 'PRIVATE_RPC_READ_BUDGET_REFUSED' });
      return mode === 'malformed' ? { status: 200, body: Buffer.from('{}') } : reply(options);
    });
    const work = read(value).catch((error) => error);
    await flush();
    caller.abort();
    expect(outcome(value)).toMatchObject({ status: 'draining', pending: 1 });
    hold.resolve();
    await work;
    await value.closed;
    expect(outcome(value)).toMatchObject({
      fatal: mode !== 'valid',
      failure: mode === 'valid' ? null : mode === 'reject' ? 'transport' : 'response',
      integrityFailure: mode === 'malformed',
    });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  }
);
test.each(['context', 'tor', 'replacement'])(
  'genuine %s revocation remains fatal/readable',
  async (kind) => {
    const value = make();
    if (kind === 'context') scope.close();
    if (kind === 'tor') tor.abort();
    if (kind === 'replacement') mockEndpoint = { signal: new AbortController().signal };
    expect(outcome(value)).toMatchObject({
      reason: 'fatal',
      fatal: true,
      failure: 'revoked',
      integrityFailure: false,
    });
    await value.closed;
    expect(outcome(value)).toMatchObject({
      status: 'closed',
      fatal: true,
      failure: 'revoked',
      integrityFailure: false,
    });
    expect(mockRequest).not.toHaveBeenCalled();
  }
);
test('idle expiry actively aborts and resolves closed', async () => {
  const value = make({ deadline: 10 });
  jest.advanceTimersByTime(10);
  await value.closed;
  expect(value.signal.aborted).toBe(true);
  expect(outcome(value)).toMatchObject({ reason: 'expired', integrityFailure: false });
});
test('deadline checked after chain await without timer dispatch; no method admission', async () => {
  const hold = deferred(),
    value = make({ deadline: 100 });
  mockRequest.mockImplementation(async (_h, _u, options) => {
    await hold.promise;
    return reply(options);
  });
  const work = read(value).catch((error) => error);
  await flush();
  const clock = jest.spyOn(performance, 'now').mockReturnValue(100);
  hold.resolve();
  await work;
  expect(methods()).toEqual(['eth_chainId']);
  await value.closed;
  clock.mockRestore();
  expect(outcome(value)).toMatchObject({ reason: 'expired', integrityFailure: false });
});
test('monotonic regression refuses even after creation time', async () => {
  const value = make();
  const clock = jest.spyOn(performance, 'now').mockReturnValue(50);
  expect(outcome(value).status).toBe('active');
  clock.mockReturnValue(49);
  await expect(read(value)).rejects.toThrow();
  clock.mockRestore();
  expect(outcome(value).reason).toBe('expired');
  expect(mockRequest).not.toHaveBeenCalled();
});
test('legacy three-argument request/ready retain behavior and shared startup', async () => {
  await Promise.all([client.ready(), client.request('eth_blockNumber', [], () => true)]);
  expect(methods()).toEqual(['eth_chainId', 'eth_blockNumber']);
  client.release();
  expect(mockRelease).toHaveBeenCalledWith(handle);
});

test('legacy dispatch begins in the invoking turn while shared entry is already installed', async () => {
  let second;
  mockRequest.mockImplementation(async (_h, _u, options) => {
    if (JSON.parse(options.body).method === 'eth_chainId') second = client.ready();
    return reply(options);
  });
  const first = client.ready();
  expect(methods()).toEqual(['eth_chainId']);
  await Promise.all([first, second]);
  expect(methods()).toEqual(['eth_chainId']);
});
test('factory synchronous expiry authenticates shared no-admission with zero sends', async () => {
  const a = make({ deadline: 10 }),
    b = make();
  let bWork, clock;
  mockFactory.mockImplementation(() => {
    bWork = read(b).catch((error) => error);
    clock = jest.spyOn(performance, 'now').mockReturnValue(10);
    return { request: mockRequest, release: mockRelease };
  });
  await expect(read(a)).rejects.toThrow();
  await bWork;
  clock.mockRestore();
  expect(outcome(a)).toMatchObject({ reason: 'expired', integrityFailure: false });
  expect(outcome(b)).toMatchObject({ reason: 'shared-no-admission', integrityFailure: false });
  expect(mockRequest).not.toHaveBeenCalled();
});
test('factory throwing after local cancel is real failure, not shared no-admission', async () => {
  const a = make(),
    b = make({ signal: new AbortController().signal });
  let bWork;
  mockFactory.mockImplementation(() => {
    bWork = read(b).catch((error) => error);
    caller.abort();
    throw Object.assign(Error('secret'), { code: 'PRIVATE_RPC_READ_BUDGET_REFUSED' });
  });
  await expect(read(a)).rejects.toThrow();
  await bWork;
  expect(outcome(a)).toMatchObject({ fatal: true, failure: 'transport', integrityFailure: false });
  expect(outcome(b)).toMatchObject({ fatal: true, failure: 'transport', integrityFailure: false });
  expect(mockRequest).not.toHaveBeenCalled();
});
test('transaction-rpc clients cannot mint protocol read budgets', () => {
  const otherHandle = scope.getContext({
    kind: 'public-address',
    principal: address,
    chainId: 11155111,
    role: 'transaction-rpc',
  });
  const other = api.createPrivateRpc(otherHandle, 'transaction-rpc');
  expect(() =>
    make({
      client: other,
      handle: otherHandle,
      destination: api.getPrivateRpcDestination(other, otherHandle),
    })
  ).toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
test.each(['options', 'envelope', 'headers', 'header', 'logs', 'range'])(
  'Proxy %s is rejected without executing traps',
  (where) => {
    const trap = jest.fn(() => {
      throw Error('Proxy trap must not execute');
    });
    const proxy = (value) =>
      new Proxy(value, {
        get: trap,
        ownKeys: trap,
        getPrototypeOf: trap,
        getOwnPropertyDescriptor: trap,
      });
    const config = envelope();
    if (where === 'envelope') {
      expect(() => make({ envelope: proxy(config) })).toThrow();
    } else if (where === 'options') {
      expect(() => api.createPrivateRpcReadBudget(proxy({}))).toThrow();
    } else {
      if (where === 'headers') config.headers = proxy(config.headers);
      if (where === 'header') config.headers[0] = proxy(config.headers[0]);
      if (where === 'logs') config.logs = proxy({ address, fromBlock: '0x0', toBlock: '0x1' });
      if (where === 'range')
        config.eventHeaders = proxy({ fromBlock: '0x0', toBlock: '0x1', maxRequests: 1 });
      expect(() => make({ envelope: config })).toThrow();
    }
    expect(trap).not.toHaveBeenCalled();
  }
);
test.each(['array-proxy', 'filter-proxy', 'accessor', 'sparse', 'extra'])(
  'malformed params %s terminate admission benignly without hooks/chain traffic',
  async (kind) => {
    const trap = jest.fn(() => {
      throw Error('secret');
    });
    const value = make({
      envelope: { headers: [], logs: { address, fromBlock: '0x0', toBlock: '0x1' } },
    });
    let params = [{ address, fromBlock: '0x0', toBlock: '0x1' }];
    if (kind === 'array-proxy') params = new Proxy(params, { getPrototypeOf: trap, get: trap });
    if (kind === 'filter-proxy')
      params[0] = new Proxy(params[0], { getPrototypeOf: trap, get: trap });
    if (kind === 'accessor') Object.defineProperty(params[0], 'address', { get: trap });
    if (kind === 'sparse') params = new Array(1);
    if (kind === 'extra') params.extra = true;
    await expect(client.request('eth_getLogs', params, () => true, value.budget)).rejects.toThrow();
    expect(trap).not.toHaveBeenCalled();
    expect(outcome(value)).toMatchObject({ reason: 'admission-refused', integrityFailure: false });
    expect(mockRequest).not.toHaveBeenCalled();
  }
);
test('admission refusal preserves client for a fresh healthy budget', async () => {
  const bad = make({ envelope: { headers: [{ tag: 'finalized', maxRequests: 1 }] } });
  await read(bad);
  await expect(read(bad)).rejects.toThrow();
  expect(outcome(bad)).toMatchObject({ reason: 'admission-refused', integrityFailure: false });
  const good = make();
  await read(good);
  expect(outcome(good).admissions).toEqual({ chainId: 0, headers: 1, eventHeaders: 0, logs: 0 });
  expect(mockRelease).not.toHaveBeenCalled();
});
test('two concurrent requests cannot overspend one header quota', async () => {
  const value = make({ envelope: { headers: [{ tag: 'finalized', maxRequests: 1 }] } });
  const results = await Promise.allSettled([read(value), read(value)]);
  expect(results.some((result) => result.status === 'rejected')).toBe(true);
  expect(methods()).toEqual(['eth_chainId', 'eth_getBlockByNumber']);
  expect(outcome(value)).toMatchObject({ reason: 'admission-refused', integrityFailure: false });
});
test('real lifetime loss while locally canceled validator drains overrides benign reason', async () => {
  const hold = deferred(),
    value = make();
  const work = read(value, 'finalized', () => hold.promise).catch((error) => error);
  await flush();
  caller.abort();
  tor.abort();
  expect(outcome(value)).toMatchObject({
    status: 'draining',
    reason: 'fatal',
    fatal: true,
    failure: 'revoked',
    integrityFailure: false,
  });
  hold.resolve(true);
  await work;
  await value.closed;
  expect(outcome(value)).toMatchObject({
    status: 'closed',
    reason: 'fatal',
    fatal: true,
    failure: 'revoked',
    integrityFailure: false,
  });
});

test('proxied signal is rejected without prototype/accessor traps', () => {
  const trap = jest.fn(() => {
    throw Error('secret');
  });
  const signal = new Proxy(caller.signal, { get: trap, getPrototypeOf: trap });
  expect(() => make({ signal })).toThrow();
  expect(trap).not.toHaveBeenCalled();
});
test.each(['wrong-id', 'http-error', 'error-envelope', 'missing-result', 'invalid-json'])(
  'late %s reply is fatal even after local cancellation',
  async (mode) => {
    await client.ready();
    mockRequest.mockClear();
    const value = make(),
      hold = deferred();
    mockRequest.mockImplementation(async (_h, _u, options) => {
      await hold.promise;
      const response = reply(options),
        data = JSON.parse(response.body);
      if (mode === 'wrong-id') data.id = 'other';
      if (mode === 'http-error') response.status = 500;
      if (mode === 'error-envelope') data.error = { code: -1, message: 'secret' };
      if (mode === 'missing-result') delete data.result;
      response.body = Buffer.from(mode === 'invalid-json' ? 'secret' : JSON.stringify(data));
      return response;
    });
    const work = read(value).catch((error) => error);
    await flush();
    caller.abort();
    hold.resolve();
    expect(String(await work)).toBe('Error: Private RPC read budget unavailable');
    await value.closed;
    expect(outcome(value)).toMatchObject({ integrityFailure: true, reason: 'fatal' });
  }
);
test('legacy-initiated bad shared chain still poisons every joined genuine budget', async () => {
  const value = make();
  let joined;
  mockRequest.mockImplementation(async (_h, _u, options) => {
    joined = read(value).catch((error) => error);
    caller.abort();
    return reply(options, '0x1');
  });
  await expect(client.ready()).rejects.toThrow();
  await joined;
  expect(outcome(value)).toMatchObject({ integrityFailure: true, admissions: { chainId: 0 } });
  expect(methods()).toEqual(['eth_chainId']);
});
test('deadline does not reset after sequential reads', async () => {
  const value = make({ deadline: 100 });
  await read(value);
  jest.advanceTimersByTime(99);
  await read(value);
  jest.advanceTimersByTime(1);
  await value.closed;
  await expect(read(value)).rejects.toThrow();
  expect(outcome(value)).toMatchObject({
    reason: 'expired',
    admissions: { chainId: 1, headers: 2 },
  });
});
test('close racing synchronously reentrant request keeps existing request tracked', async () => {
  const hold = deferred(),
    value = make();
  let reentrant;
  value.signal.addEventListener('abort', () => {
    reentrant = read(value).catch((error) => error);
  });
  mockRequest.mockImplementation(async (_h, _u, options) => {
    await hold.promise;
    return reply(options);
  });
  const work = read(value).catch((error) => error);
  value.close();
  expect(outcome(value)).toMatchObject({ pending: 1, status: 'draining' });
  expect(await reentrant).toBeInstanceOf(Error);
  hold.resolve();
  await work;
  await value.closed;
  expect(methods()).toEqual(['eth_chainId']);
  expect(outcome(value)).toMatchObject({ pending: 0, status: 'closed', integrityFailure: false });
});

test.each(['source', 'client', 'tor'])(
  '%s lifetime close during a pending method is fatal revoked, not corruption',
  async (kind) => {
    const clientLifetime = new AbortController();
    client = api.createPrivateRpc(handle, 'protocol-rpc', { signal: clientLifetime.signal });
    await client.ready();
    mockRequest.mockClear();
    const value = make(),
      hold = deferred(),
      validate = jest.fn(() => true);
    mockRequest.mockImplementation(async (_h, _u, options) => {
      await hold.promise;
      return reply(options);
    });
    const work = read(value, 'finalized', validate).catch((error) => error);
    await flush();
    if (kind === 'source') scope.close();
    if (kind === 'client') clientLifetime.abort();
    if (kind === 'tor') tor.abort();
    expect(outcome(value)).toMatchObject({
      status: 'draining',
      fatal: true,
      failure: 'revoked',
      integrityFailure: false,
    });
    value.close();
    caller.abort();
    hold.resolve();
    await work;
    await value.closed;
    expect(validate).toHaveBeenCalledTimes(1);
    expect(outcome(value)).toMatchObject({
      status: 'closed',
      reason: 'fatal',
      fatal: true,
      failure: 'revoked',
      integrityFailure: false,
    });
  }
);
test.each(['malformed', 'wrong-id', 'validator-false', 'transport'])(
  'revoked pending method then late %s upgrades authenticated category',
  async (mode) => {
    await client.ready();
    mockRequest.mockClear();
    const value = make(),
      hold = deferred();
    mockRequest.mockImplementation(async (_h, _u, options) => {
      await hold.promise;
      if (mode === 'transport')
        throw Object.assign(Error('secret'), { code: 'PRIVATE_RPC_INVALID' });
      if (mode === 'malformed') return { status: 200, body: Buffer.from('invalid') };
      const result = reply(options);
      if (mode === 'wrong-id')
        result.body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'wrong', result: {} }));
      return result;
    });
    const work = read(value, 'finalized', () => mode !== 'validator-false').catch((error) => error);
    await flush();
    scope.close();
    expect(outcome(value).failure).toBe('revoked');
    hold.resolve();
    expect(String(await work)).toBe('Error: Private RPC read budget unavailable');
    await value.closed;
    caller.abort();
    value.close();
    expect(outcome(value)).toMatchObject({
      status: 'closed',
      fatal: true,
      failure: mode === 'transport' ? 'transport' : 'response',
      integrityFailure: mode !== 'transport',
    });
  }
);
test.each(['budget', 'legacy'])(
  '%s-initiated shared chain: owner revoke then wrong chain upgrades every budget',
  async (starter) => {
    const a = make(),
      b = make({ signal: new AbortController().signal }),
      hold = deferred();
    mockRequest.mockImplementation(async (_h, _u, options) => {
      await hold.promise;
      return reply(options, '0x1');
    });
    const first = (starter === 'budget' ? read(a) : client.ready()).catch((error) => error);
    const second = read(b).catch((error) => error);
    scope.close();
    expect(outcome(b).failure).toBe('revoked');
    hold.resolve();
    await Promise.all([first, second]);
    await b.closed;
    expect(outcome(b)).toMatchObject({ fatal: true, failure: 'response', integrityFailure: true });
    if (starter === 'budget')
      expect(outcome(a)).toMatchObject({
        fatal: true,
        failure: 'response',
        integrityFailure: true,
      });
    expect(methods()).toEqual(['eth_chainId']);
  }
);
test('response beats transport beats revoked across concurrent pending replies', async () => {
  await client.ready();
  mockRequest.mockClear();
  const value = make(),
    holds = [deferred(), deferred()];
  let count = 0;
  mockRequest.mockImplementation(async (_h, _u, _options) => {
    const index = count++;
    await holds[index].promise;
    if (index === 0) throw Error('network');
    return { status: 200, body: Buffer.from('malformed') };
  });
  const first = read(value).catch((error) => error),
    second = read(value).catch((error) => error);
  await flush();
  scope.close();
  expect(outcome(value).failure).toBe('revoked');
  holds[0].resolve();
  await first;
  expect(outcome(value)).toMatchObject({
    status: 'draining',
    failure: 'transport',
    integrityFailure: false,
  });
  holds[1].resolve();
  await second;
  await value.closed;
  value.close();
  caller.abort();
  expect(outcome(value)).toMatchObject({
    status: 'closed',
    reason: 'fatal',
    failure: 'response',
    integrityFailure: true,
  });
});
test('legacy unbudgeted joiner shares authenticated no-admission; neither call retries', async () => {
  const value = make();
  let joined;
  mockFactory.mockImplementation(() => {
    joined = client.request('eth_blockNumber', [], () => true).catch((error) => error);
    caller.abort();
    return { request: mockRequest, release: mockRelease };
  });
  await expect(read(value)).rejects.toThrow('Private RPC read budget unavailable');
  expect(await joined).toMatchObject({ code: 'PRIVATE_RPC_READ_BUDGET_REFUSED' });
  expect(mockRequest).not.toHaveBeenCalled();
  expect(outcome(value)).toMatchObject({ fatal: false, failure: null, integrityFailure: false });
});
test('outcome accessor actively detects expiry and finalizes idle state without timer dispatch', async () => {
  const value = make({ deadline: 100 });
  let closed = false;
  value.closed.then(() => {
    closed = true;
  });
  const clock = jest.spyOn(performance, 'now').mockReturnValue(100);
  expect(value.signal.aborted).toBe(false);
  expect(outcome(value)).toMatchObject({
    status: 'closed',
    reason: 'expired',
    fatal: false,
    failure: null,
  });
  expect(value.signal.aborted).toBe(true);
  await value.closed;
  expect(closed).toBe(true);
  clock.mockRestore();
  expect(outcome(value).reason).toBe('expired');
});

// Retained from the positive and cold relay fixture host acceptance cases.
test('genuine provider identity and destination budget share one original chain handshake', async () => {
  const destination = api.getPrivateRpcDestination(client, handle);
  expect(api.assertPrivateRpcDestination(client, handle, destination)).toBe(destination);
  expect(api.getPrivateRpcDestinationDetails(destination).url).toBe(mockUrls[0]);
  expect(client.trust.queried).toEqual(['rpc.example.test']);
  expect(() => api.getPrivateRpcDestination({ ...client }, handle)).toThrow();
  const value = make({ envelope: { headers: [{ tag: 'finalized', maxRequests: 2 }] } });
  for (let i = 0; i < 2; i++) await read(value, 'finalized', (result) => result.number === '0x1');
  expect(methods()).toEqual(['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber']);
  expect(
    mockRequest.mock.calls.every(
      ([actualHandle, url]) => actualHandle === handle && url === mockUrls[0]
    )
  ).toBe(true);
  value.close();
  await value.closed;
  client.release();
});
