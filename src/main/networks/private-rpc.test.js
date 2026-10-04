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
