let mockEndpoint, mockUrls, mockSources;
const mockRequest = jest.fn(),
  mockRelease = jest.fn(),
  mockFactory = jest.fn();
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('./network-registry', () => ({
  getNetwork: () => ({}),
  getEndpoints: () => mockUrls,
  getEndpointSources: () => mockSources,
}));
jest.mock('./wallet-tor-transport', () => ({
  createWalletTorTransport: (...args) => mockFactory(...args),
}));
const { createPrivacyScope } = require('./privacy-context');
const {
  createPrivateRpc,
  getPrivateRpcDestination: destination,
  assertPrivateRpcDestination: assertDestination,
  getPrivateRpcDestinationDetails: details,
} = require('./private-rpc');
let scope, handle, tor;
const originalUrl = 'https://rpc.example:8443/private-path-fixture';
function select(url = originalUrl) {
  mockUrls = [url];
  mockSources = [{ keyed: false, coverage: { 11155111: url } }];
}
function context(principal = '0x' + '1'.repeat(40)) {
  return scope.getContext({
    kind: 'public-address',
    principal,
    chainId: 11155111,
    role: 'transaction-rpc',
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  select();
  tor = new AbortController();
  mockEndpoint = { signal: tor.signal };
  scope = createPrivacyScope({
    profileId: 'rpc-destination-fixture',
    signal: new AbortController().signal,
  });
  handle = context();
  mockFactory.mockImplementation(() => ({ request: mockRequest, release: mockRelease }));
  mockRequest.mockImplementation(async (_handle, _url, options) => {
    const wire = JSON.parse(options.body);
    return {
      status: 200,
      body: Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: wire.id,
          result: wire.method === 'eth_chainId' ? '0xaa36a7' : '0x1',
        })
      ),
    };
  });
});
afterEach(() => {
  scope.close();
  tor.abort();
  jest.useRealTimers();
});
test('destination get/assert have zero transport and chain-ID work and expose no enumerable destination', () => {
  const client = createPrivateRpc(handle, 'transaction-rpc');
  const observed = destination(client, handle);
  expect(Object.isFrozen(observed)).toBe(true);
  expect(destination(client, handle)).toBe(observed);
  expect(() => assertDestination(client, handle, observed)).not.toThrow();
  expect(JSON.stringify(observed)).not.toContain('rpc.example');
  expect(JSON.stringify({ ...observed })).not.toContain('private-path-fixture');
  expect(mockFactory).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
});
test('copied observations, forged clients and unrelated handles cannot borrow genuine destination identity', () => {
  const client = createPrivateRpc(handle, 'transaction-rpc');
  const observed = destination(client, handle);
  for (const forged of [
    {},
    { ...observed },
    JSON.parse(JSON.stringify(observed)),
    Object.create(observed),
  ]) {
    expect(() => assertDestination(client, handle, forged)).toThrow();
  }
  for (const forgedClient of [{}, { ...client }, Object.create(client)]) {
    expect(() => destination(forgedClient, handle)).toThrow();
    expect(() => assertDestination(forgedClient, handle, observed)).toThrow();
  }
  expect(() => destination(client, {})).toThrow();
  expect(() => assertDestination(client, context('0x' + '2'.repeat(40)), observed)).toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
test('a distinct same-URL client cannot replace an observed client, even for the same handle', () => {
  const first = createPrivateRpc(handle, 'transaction-rpc');
  const observed = destination(first, handle);
  const second = createPrivateRpc(handle, 'transaction-rpc');
  expect(destination(second, handle)).not.toBe(observed);
  expect(() => assertDestination(second, handle, observed)).toThrow();
  expect(() => assertDestination(first, handle, destination(second, handle))).toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
test('registry replacement preserves the originally reviewed client and dispatch destination', async () => {
  const client = createPrivateRpc(handle, 'transaction-rpc');
  const observed = destination(client, handle);
  select('https://rpc.example:8443/replacement-path-fixture');
  expect(() => assertDestination(client, handle, observed)).not.toThrow();
  await client.request('eth_blockNumber', [], (value) => value === '0x1');
  expect(mockRequest.mock.calls.map(([, url]) => url)).toEqual([originalUrl, originalUrl]);
  expect(mockRequest.mock.calls.map(([, , options]) => JSON.parse(options.body).method)).toEqual([
    'eth_chainId',
    'eth_blockNumber',
  ]);
  const replacement = createPrivateRpc(handle, 'transaction-rpc');
  expect(() => assertDestination(replacement, handle, observed)).toThrow();
});

test('only public chain metadata extends setup within the original request timeout', async () => {
  const client = createPrivateRpc(handle, 'transaction-rpc');
  for (const method of [
    'eth_getBlockByNumber',
    'eth_call',
    'eth_estimateGas',
    'eth_sendRawTransaction',
    'eth_getTransactionCount',
  ])
    await client.request(method, [], () => true);
  expect(mockRequest.mock.calls.map(([, , options]) => JSON.parse(options.body).method)).toEqual([
    'eth_chainId',
    'eth_getBlockByNumber',
    'eth_call',
    'eth_estimateGas',
    'eth_sendRawTransaction',
    'eth_getTransactionCount',
  ]);
  for (const [, , options] of mockRequest.mock.calls) {
    const method = JSON.parse(options.body).method;
    if (['eth_chainId', 'eth_getBlockByNumber'].includes(method))
      expect(options.connectTimeoutMs).toBe(options.timeoutMs);
    else expect(Object.hasOwn(options, 'connectTimeoutMs')).toBe(false);
  }
});
test.each(['context', 'tor-abort', 'tor-replacement', 'caller'])(
  'destination identity is revoked by %s without dispatch',
  (boundary) => {
    const caller = new AbortController();
    const client = createPrivateRpc(handle, 'transaction-rpc', { signal: caller.signal });
    const observed = destination(client, handle);
    if (boundary === 'context') scope.close();
    if (boundary === 'tor-abort') tor.abort();
    if (boundary === 'tor-replacement') mockEndpoint = { signal: new AbortController().signal };
    if (boundary === 'caller') caller.abort();
    expect(() => destination(client, handle)).toThrow();
    expect(() => assertDestination(client, handle, observed)).toThrow();
    expect(mockRequest).not.toHaveBeenCalled();
  }
);
test('transport release remains nonterminal; context revocation ends destination identity', async () => {
  const client = createPrivateRpc(handle, 'transaction-rpc');
  const observed = destination(client, handle);
  await client.ready();
  mockRequest.mockClear();
  client.release();
  expect(mockRelease).toHaveBeenCalledWith(handle);
  expect(() => assertDestination(client, handle, observed)).not.toThrow();
  await client.request('eth_blockNumber', [], () => true);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  scope.close();
  expect(() => assertDestination(client, handle, observed)).toThrow();
});

test('only guarded trusted-main details reveal the effective full path/port and no account identity', () => {
  select('https://RPC.example:8443/a/../private%2Fpath');
  const client = createPrivateRpc(handle, 'transaction-rpc');
  const observed = destination(client, handle);
  expect(Object.keys(observed)).toEqual([]);
  expect(JSON.stringify(observed)).toBe('{}');
  expect(details(observed)).toEqual({
    version: 1,
    url: 'https://rpc.example:8443/private%2Fpath',
    chainId: 11155111,
    role: 'transaction-rpc',
    transport: 'tor-experimental',
  });
  expect(Object.isFrozen(details(observed))).toBe(true);
  select('https://rpc.example:8443/other-path');
  const other = createPrivateRpc(handle, 'transaction-rpc');
  expect(details(destination(other, handle)).url).not.toBe(details(observed).url);
  for (const copied of [
    {},
    { ...observed },
    JSON.parse(JSON.stringify(observed)),
    Object.create(observed),
    details(observed),
  ])
    expect(() => details(copied)).toThrow();
  scope.close();
  expect(() => details(observed)).toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
test('destination failures never expose retained URL/path or caller-supplied error text', () => {
  const client = createPrivateRpc(handle, 'transaction-rpc');
  const observed = destination(client, handle);
  scope.close();
  for (const run of [
    () => destination(client, handle),
    () => assertDestination(client, handle, observed),
    () => details(observed),
  ]) {
    let failure;
    try {
      run();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'PRIVATE_RPC_DESTINATION_REFUSED' });
    expect(String(failure)).not.toContain('rpc.example');
    expect(String(failure)).not.toContain('private-path-fixture');
  }
});

test('protocol RPC destination retains its own role without exposing a private-account principal', () => {
  const protocolHandle = scope.getContext({
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'protocol-rpc',
  });
  const client = createPrivateRpc(protocolHandle, 'protocol-rpc');
  const observed = destination(client, protocolHandle);
  expect(details(observed)).toMatchObject({
    role: 'protocol-rpc',
    chainId: 11155111,
    url: originalUrl,
  });
  expect(JSON.stringify(details(observed))).not.toContain('railgun:0');
  expect(() => assertDestination(client, handle, observed)).toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});

const { createPrivateRpcDestinationConstraint: constrain } = require('./private-rpc');
function restriction(client = createPrivateRpc(handle, 'transaction-rpc'), owner = handle) {
  return constrain({
    observation: destination(client, owner),
    signal: new AbortController().signal,
    deadline: performance.now() + 60000,
  });
}
test('genuine destination constraint is frozen, opaque and performs zero transport work', async () => {
  const grant = restriction();
  expect(Object.keys(grant).sort()).toEqual(['close', 'constraint', 'signal']);
  expect(Object.isFrozen(grant)).toBe(true);
  expect(Object.isFrozen(grant.constraint)).toBe(true);
  expect(JSON.stringify(grant)).not.toMatch(/rpc.example|private-path|11155111/);
  expect(mockRequest).not.toHaveBeenCalled();
  const derived = createPrivateRpc(context(), 'transaction-rpc', {
    destinationConstraint: grant.constraint,
  });
  await derived.ready();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockRequest.mock.calls[0][1]).toBe(originalUrl);
  grant.close();
  grant.close();
  expect(derived.signal.aborted).toBe(true);
  await expect(derived.ready()).rejects.toThrow();
  expect(mockRequest).toHaveBeenCalledTimes(1);
});
test.each(['https://other.example/rpc', 'https://rpc.example:8443/another-path'])(
  'new client refuses reviewed endpoint replacement %s before hidden chain-ID',
  (url) => {
    const grant = restriction();
    select(url);
    expect(() =>
      createPrivateRpc(handle, 'transaction-rpc', { destinationConstraint: grant.constraint })
    ).toThrow();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(grant.signal.aborted).toBe(false);
    select();
    expect(() =>
      createPrivateRpc(handle, 'transaction-rpc', { destinationConstraint: grant.constraint })
    ).not.toThrow();
  }
);
test('constraint compares normalized URLs and already-pinned derived clients retain the reviewed URL', async () => {
  const grant = restriction();
  select('https://RPC.EXAMPLE:8443/private-path-fixture');
  const derived = createPrivateRpc(handle, 'transaction-rpc', {
    destinationConstraint: grant.constraint,
  });
  select('https://different.example/private');
  await derived.request('eth_blockNumber', [], () => true);
  expect(mockRequest.mock.calls.every(([, url]) => new URL(url).href === originalUrl)).toBe(true);
});
test.each([null, {}, Object.freeze({}), new Proxy({}, {})])(
  'forged constraint refuses without affecting genuine token: %p',
  (fake) => {
    const grant = restriction();
    expect(() =>
      createPrivateRpc(handle, 'transaction-rpc', { destinationConstraint: fake })
    ).toThrow();
    expect(() =>
      createPrivateRpc(handle, 'transaction-rpc', { destinationConstraint: grant.constraint })
    ).not.toThrow();
    expect(mockRequest).not.toHaveBeenCalled();
  }
);
test('copied observation cannot mint a restriction or revoke its genuine source', () => {
  const original = createPrivateRpc(handle, 'transaction-rpc');
  const observed = destination(original, handle);
  for (const observation of [{}, { ...observed }, Object.create(observed)])
    expect(() =>
      constrain({
        observation,
        signal: new AbortController().signal,
        deadline: performance.now() + 1000,
      })
    ).toThrow();
  expect(() => assertDestination(original, handle, observed)).not.toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
test.each([0, -1, NaN, Infinity, '1000', null])(
  'invalid deadline %p refuses without network',
  (deadline) => {
    const original = createPrivateRpc(handle, 'transaction-rpc');
    expect(() =>
      constrain({
        observation: destination(original, handle),
        signal: new AbortController().signal,
        deadline,
      })
    ).toThrow();
    expect(mockRequest).not.toHaveBeenCalled();
  }
);
test('deadline is bounded to 900000 milliseconds and never renewed by reads', async () => {
  jest.useFakeTimers();
  const original = createPrivateRpc(handle, 'transaction-rpc');
  const observation = destination(original, handle);
  expect(() =>
    constrain({
      observation,
      signal: new AbortController().signal,
      deadline: performance.now() + 900001,
    })
  ).toThrow();
  const grant = constrain({
    observation,
    signal: new AbortController().signal,
    deadline: performance.now() + 900000,
  });
  const derived = createPrivateRpc(handle, 'transaction-rpc', {
    destinationConstraint: grant.constraint,
  });
  jest.advanceTimersByTime(899999);
  derived.assertActive();
  jest.advanceTimersByTime(1);
  expect(grant.signal.aborted).toBe(true);
  expect(derived.signal.aborted).toBe(true);
  await expect(derived.ready()).rejects.toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
test('lazy expiry before timer dispatch closes derived clients and admits zero RPC', async () => {
  let now = 100;
  const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    const grant = restriction();
    const derived = createPrivateRpc(handle, 'transaction-rpc', {
      destinationConstraint: grant.constraint,
    });
    now += 60000;
    await expect(derived.ready()).rejects.toThrow();
    expect(grant.signal.aborted).toBe(true);
    expect(derived.signal.aborted).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});
test.each(['caller', 'original-context', 'original-client', 'tor-replacement'])(
  '%s invalidates original observation currency and all restricted clients',
  async (boundary) => {
    const originalOwner = createPrivacyScope({
      profileId: 'rpc-destination-fixture',
      signal: new AbortController().signal,
    });
    const originalHandle = originalOwner.getContext({
      kind: 'public-address',
      principal: '0x' + '1'.repeat(40),
      chainId: 11155111,
      role: 'transaction-rpc',
    });
    const originalAbort = new AbortController(),
      caller = new AbortController();
    const original = createPrivateRpc(originalHandle, 'transaction-rpc', {
      signal: originalAbort.signal,
    });
    const grant = constrain({
      observation: destination(original, originalHandle),
      signal: caller.signal,
      deadline: performance.now() + 60000,
    });
    const derived = createPrivateRpc(handle, 'transaction-rpc', {
      destinationConstraint: grant.constraint,
    });
    try {
      if (boundary === 'caller') caller.abort();
      if (boundary === 'original-context') originalOwner.close();
      if (boundary === 'original-client') originalAbort.abort();
      if (boundary === 'tor-replacement') mockEndpoint = { signal: new AbortController().signal };
      await expect(derived.ready()).rejects.toThrow();
      expect(grant.signal.aborted).toBe(true);
      expect(derived.signal.aborted).toBe(true);
      expect(mockRequest).not.toHaveBeenCalled();
    } finally {
      originalOwner.close();
      grant.close();
    }
  }
);
test('wrong profile, principal and role refuse without revoking the owner constraint', () => {
  const grant = restriction();
  const foreign = createPrivacyScope({
    profileId: 'other-profile',
    signal: new AbortController().signal,
  });
  try {
    const wrong = foreign.getContext({
      kind: 'public-address',
      principal: '0x' + '1'.repeat(40),
      chainId: 11155111,
      role: 'transaction-rpc',
    });
    for (const h of [wrong, context('0x' + '2'.repeat(40))])
      expect(() =>
        createPrivateRpc(h, 'transaction-rpc', { destinationConstraint: grant.constraint })
      ).toThrow();
    expect(() =>
      createPrivateRpc(handle, 'protocol-rpc', { destinationConstraint: grant.constraint })
    ).toThrow();
    expect(grant.signal.aborted).toBe(false);
    expect(mockRequest).not.toHaveBeenCalled();
  } finally {
    foreign.close();
  }
});
test('protocol operation labels may differ while account identity must match', async () => {
  const subject = {
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'protocol-rpc',
  };
  const originalHandle = scope.getContext({ ...subject, operation: 'preview' });
  const original = createPrivateRpc(originalHandle, 'protocol-rpc');
  const grant = restriction(original, originalHandle);
  const derived = createPrivateRpc(
    scope.getContext({ ...subject, operation: 'shield-preflight' }),
    'protocol-rpc',
    { destinationConstraint: grant.constraint }
  );
  await derived.ready();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(() =>
    createPrivateRpc(scope.getContext({ ...subject, principal: 'railgun:1' }), 'protocol-rpc', {
      destinationConstraint: grant.constraint,
    })
  ).toThrow();
});
test('request serialization revocation cannot admit the next method after a successful chain check', async () => {
  const grant = restriction();
  const derived = createPrivateRpc(handle, 'transaction-rpc', {
    destinationConstraint: grant.constraint,
  });
  await derived.ready();
  mockRequest.mockClear();
  const params = {
    toJSON() {
      grant.close();
      return [];
    },
  };
  await expect(derived.request('eth_blockNumber', params, () => true)).rejects.toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
test('transport-factory reentrant revocation blocks hidden chain-ID admission', async () => {
  let local, grant, owner;
  jest.isolateModules(() => {
    const rpc = require('./private-rpc');
    owner = require('./privacy-context').createPrivacyScope({
      profileId: 'isolated-constraint',
      signal: new AbortController().signal,
    });
    const h = owner.getContext({
      kind: 'public-address',
      principal: '0x' + '1'.repeat(40),
      chainId: 11155111,
      role: 'transaction-rpc',
    });
    const original = rpc.createPrivateRpc(h, 'transaction-rpc');
    grant = rpc.createPrivateRpcDestinationConstraint({
      observation: rpc.getPrivateRpcDestination(original, h),
      signal: new AbortController().signal,
      deadline: performance.now() + 60000,
    });
    local = rpc.createPrivateRpc(h, 'transaction-rpc', { destinationConstraint: grant.constraint });
  });
  mockFactory.mockImplementationOnce(() => {
    grant.close();
    return { request: mockRequest };
  });
  try {
    await expect(local.ready()).rejects.toThrow();
    expect(mockFactory).toHaveBeenCalledTimes(1);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(local.signal.aborted).toBe(true);
  } finally {
    owner.close();
  }
});
test('cancellation after admitted chain response forbids the subsequent requested method', async () => {
  const grant = restriction();
  const derived = createPrivateRpc(handle, 'transaction-rpc', {
    destinationConstraint: grant.constraint,
  });
  const normal = mockRequest.getMockImplementation();
  mockRequest.mockImplementationOnce(async (...args) => {
    const result = await normal(...args);
    grant.close();
    return result;
  });
  await expect(derived.request('eth_blockNumber', [], () => true)).rejects.toThrow();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mockRequest.mock.calls[0][2].body).method).toBe('eth_chainId');
});

test.each([null, false, {}, new Proxy({}, {})])(
  'constraint rejects invalid signal %p before queries',
  (signal) => {
    const original = createPrivateRpc(handle, 'transaction-rpc');
    expect(() =>
      constrain({
        observation: destination(original, handle),
        signal,
        deadline: performance.now() + 1000,
      })
    ).toThrow();
    expect(mockRequest).not.toHaveBeenCalled();
  }
);
test('constraint exact options refuse extra fields, accessors and pre-aborted lifetime', () => {
  const original = createPrivateRpc(handle, 'transaction-rpc');
  const caller = new AbortController();
  const options = {
    observation: destination(original, handle),
    signal: caller.signal,
    deadline: performance.now() + 1000,
  };
  expect(() => constrain({ ...options, url: originalUrl })).toThrow();
  const getter = jest.fn(() => options.observation);
  expect(() =>
    constrain(
      Object.defineProperty({ signal: caller.signal, deadline: options.deadline }, 'observation', {
        get: getter,
        enumerable: true,
      })
    )
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  caller.abort();
  expect(() => constrain(options)).toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
test('constraint close restores original and caller abort listener baselines', () => {
  const { getEventListeners } = require('events');
  const original = createPrivateRpc(handle, 'transaction-rpc');
  const caller = new AbortController();
  const baseline = [caller.signal, original.signal].map(
    (signal) => getEventListeners(signal, 'abort').length
  );
  const grant = constrain({
    observation: destination(original, handle),
    signal: caller.signal,
    deadline: performance.now() + 1000,
  });
  expect(
    [caller.signal, original.signal].map((signal) => getEventListeners(signal, 'abort').length)
  ).toEqual(baseline.map((n) => n + 1));
  grant.close();
  grant.close();
  expect(
    [caller.signal, original.signal].map((signal) => getEventListeners(signal, 'abort').length)
  ).toEqual(baseline);
});
test('nonterminal original RPC release does not revoke its constraint', async () => {
  const original = createPrivateRpc(handle, 'transaction-rpc');
  const grant = restriction(original);
  original.release();
  const derived = createPrivateRpc(handle, 'transaction-rpc', {
    destinationConstraint: grant.constraint,
  });
  await derived.ready();
  expect(grant.signal.aborted).toBe(false);
});
test('expiry inside original lazy currentness cannot admit a hidden chain-ID', async () => {
  let now = 100,
    expire = false;
  const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
  const originalOwner = createPrivacyScope({
    profileId: 'rpc-destination-fixture',
    signal: scope.signal,
    isCurrent: () => {
      if (expire) now = 2000;
      return true;
    },
  });
  try {
    const originalHandle = originalOwner.getContext({
      kind: 'public-address',
      principal: '0x' + '1'.repeat(40),
      chainId: 11155111,
      role: 'transaction-rpc',
    });
    const original = createPrivateRpc(originalHandle, 'transaction-rpc');
    const grant = constrain({
      observation: destination(original, originalHandle),
      signal: scope.signal,
      deadline: 1000,
    });
    const derived = createPrivateRpc(handle, 'transaction-rpc', {
      destinationConstraint: grant.constraint,
    });
    expire = true;
    await expect(derived.ready()).rejects.toThrow();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(grant.signal.aborted).toBe(true);
  } finally {
    originalOwner.close();
    clock.mockRestore();
  }
});

test('expiry while a response is admitted rejects after response drain without a retry', async () => {
  jest.useFakeTimers();
  const original = createPrivateRpc(handle, 'transaction-rpc');
  const grant = constrain({
    observation: destination(original, handle),
    signal: scope.signal,
    deadline: performance.now() + 1000,
  });
  const derived = createPrivateRpc(handle, 'transaction-rpc', {
    destinationConstraint: grant.constraint,
  });
  await derived.ready();
  let release, entered;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const admitted = new Promise((resolve) => {
    entered = resolve;
  });
  const normal = mockRequest.getMockImplementation();
  mockRequest.mockImplementationOnce(async (...args) => {
    const reply = await normal(...args);
    entered();
    await held; // Deliberately ignores cancellation to test logical response drain.
    return reply;
  });
  let settled = false;
  const pending = derived
    .request('eth_blockNumber', [], () => true)
    .then(
      () => {
        settled = true;
        return 'unexpected-success';
      },
      () => {
        settled = true;
        return 'refused';
      }
    );
  try {
    await admitted;
    jest.advanceTimersByTime(1000);
    expect(grant.signal.aborted).toBe(true);
    expect(derived.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mockRequest).toHaveBeenCalledTimes(2); // Hidden chain-ID + one admitted method.
    release();
    expect(await pending).toBe('refused');
    await expect(derived.request('eth_blockNumber', [], () => true)).rejects.toThrow();
    expect(mockRequest).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await pending;
    grant.close();
  }
});

// One request's admission deadline: data that can only refuse, checked on
// entry and again as the last gate before transport admission.
describe('per-request admission deadline', () => {
  let now, clock;
  const expired = { code: 'PRIVATE_RPC_ADMISSION_EXPIRED' };
  const methods = () =>
    mockRequest.mock.calls.map(([, , options]) => JSON.parse(options.body).method);
  const ask = (client, deadline, params = []) =>
    client.request('eth_blockNumber', params, () => true, undefined, {
      admissionDeadline: deadline,
    });
  beforeEach(() => {
    now = 1000;
    clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => clock.mockRestore());
  test('admits one millisecond before the deadline and refuses at it', async () => {
    const client = createPrivateRpc(handle, 'transaction-rpc');
    await client.ready();
    mockRequest.mockClear();
    await expect(ask(client, 1001)).resolves.toMatchObject({ result: '0x1' });
    await expect(ask(client, 1000)).rejects.toMatchObject(expired);
    expect(methods()).toEqual(['eth_blockNumber']);
  });
  test('a deadline passed on entry sends no hidden chain-ID', async () => {
    const client = createPrivateRpc(handle, 'transaction-rpc');
    await expect(ask(client, 1000)).rejects.toMatchObject(expired);
    expect(mockRequest).not.toHaveBeenCalled();
  });
  test('serialization that crosses it after every activity check admits nothing and revokes nothing', async () => {
    const client = createPrivateRpc(handle, 'transaction-rpc');
    await client.ready();
    mockRequest.mockClear();
    const params = {
      toJSON() {
        now = 2000;
        return [];
      },
    };
    await expect(ask(client, 2000, params)).rejects.toMatchObject(expired);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(client.signal.aborted).toBe(false);
    await expect(client.request('eth_blockNumber', [], () => true)).resolves.toMatchObject({
      result: '0x1',
    });
  });
  test('a deadline crossed after the awaited, already settled chain check is refused', async () => {
    let cross = false;
    const owner = createPrivacyScope({
      profileId: 'rpc-destination-fixture',
      signal: scope.signal,
      isCurrent: () => {
        if (cross) now = 1500;
        return true;
      },
    });
    try {
      const local = owner.getContext({
        kind: 'public-address',
        principal: '0x' + '1'.repeat(40),
        chainId: 11155111,
        role: 'transaction-rpc',
      });
      const client = createPrivateRpc(local, 'transaction-rpc');
      await client.ready();
      mockRequest.mockClear();
      const pending = ask(client, 1500);
      // Runs after the entry check, while ready() awaits the settled check.
      cross = true;
      await expect(pending).rejects.toMatchObject(expired);
      expect(mockRequest).not.toHaveBeenCalled();
    } finally {
      owner.close();
    }
  });
  test('a deadline crossed while the shared chain check is in flight sends only the chain check', async () => {
    const client = createPrivateRpc(handle, 'transaction-rpc');
    const normal = mockRequest.getMockImplementation();
    mockRequest.mockImplementationOnce(async (...args) => {
      now = 1500;
      return normal(...args);
    });
    await expect(ask(client, 1500)).rejects.toMatchObject(expired);
    expect(methods()).toEqual(['eth_chainId']);
    expect(client.signal.aborted).toBe(false);
  });
  test('a chain check over 10 s cannot admit a raw send after its admission deadline', async () => {
    const client = createPrivateRpc(handle, 'transaction-rpc');
    const normal = mockRequest.getMockImplementation();
    mockRequest.mockImplementationOnce(async (...args) => {
      expect(args[2].connectTimeoutMs).toBe(30000);
      now += 11000;
      return normal(...args);
    });
    await expect(
      client.request('eth_sendRawTransaction', ['0x00'], () => true, undefined, {
        admissionDeadline: now + 10000,
      })
    ).rejects.toMatchObject(expired);
    expect(methods()).toEqual(['eth_chainId']);
    expect(client.signal.aborted).toBe(false);
  });
  test('a request admitted before it is not cut short by a reply after it', async () => {
    const client = createPrivateRpc(handle, 'transaction-rpc');
    await client.ready();
    const normal = mockRequest.getMockImplementation();
    mockRequest.mockImplementationOnce(async (...args) => {
      now = 5000;
      return normal(...args);
    });
    await expect(ask(client, 1001)).resolves.toMatchObject({ result: '0x1' });
  });
  const getter = jest.fn(() => 2000);
  test.each([
    ['NaN', { admissionDeadline: NaN }],
    ['Infinity', { admissionDeadline: Infinity }],
    ['a string', { admissionDeadline: '2000' }],
    ['null', null],
    ['an extra field', { admissionDeadline: 2000, signal: null }],
    ['the bare deadline key', { deadline: 2000 }],
    [
      'an accessor',
      Object.defineProperty({}, 'admissionDeadline', { enumerable: true, get: getter }),
    ],
    ['a proxy', new Proxy({ admissionDeadline: 2000 }, {})],
    ['an inherited prototype', Object.assign(Object.create({}), { admissionDeadline: 2000 })],
  ])('%s refuses before any transport work', async (_name, admission) => {
    const client = createPrivateRpc(handle, 'transaction-rpc');
    await expect(
      client.request('eth_blockNumber', [], () => true, undefined, admission)
    ).rejects.toMatchObject({ code: 'PRIVATE_RPC_ADMISSION_INVALID' });
    expect(getter).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });
  test('it is never combined with a read budget', async () => {
    const client = createPrivateRpc(handle, 'transaction-rpc');
    await expect(
      client.request('eth_blockNumber', [], () => true, Object.freeze({}), {
        admissionDeadline: 2000,
      })
    ).rejects.toMatchObject({ code: 'PRIVATE_RPC_ADMISSION_INVALID' });
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
