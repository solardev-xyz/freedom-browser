// Standalone real source/private-RPC composition; storage ledger and transport
// are explicit simulated boundaries. Does not qualify real node acceptance.
let mockEndpoint, mockUrls, mockSources;
const mockRequest = jest.fn(),
  mockRelease = jest.fn(),
  mockFactory = jest.fn();
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('../networks/network-registry', () => ({
  getNetwork: () => ({}),
  getEndpoints: () => mockUrls,
  getEndpointSources: () => mockSources,
}));
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: (...args) => mockFactory(...args),
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const {
  createPrivateRpc,
  getPrivateRpcDestination,
  getPrivateRpcDestinationDetails,
} = require('../networks/private-rpc');
const { emptyPublicState } = require('./railgun-public-records');
const { createHash } = require('crypto');
const {
  createRailgunScanSource,
  getRailgunScanSourceDestination: destination,
  assertRailgunScanSourceDestination: assertDestination,
} = require('./railgun-scan-source');
const originalUrl = 'https://rpc.example:8443/private-source-path';
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const block = (n) => ({ number: '0x' + n.toString(16), hash: hash(n + 1), parentHash: hash(n) });
let scope, tor, handle, opened;
function select(url = originalUrl) {
  mockUrls = [url];
  mockSources = [{ keyed: false, coverage: { 11155111: url } }];
}
function context(principal = 'source-fixture', owner = scope) {
  return owner.getContext({
    kind: 'private-account',
    principal,
    protocol: 'railgun',
    chainId: 11155111,
    deployment: 'sepolia',
    role: 'protocol-rpc',
  });
}
function open(sourceHandle = handle) {
  const controller = new AbortController();
  let staged;
  const ledger = {
    signal: controller.signal,
    identity: jest.fn(() => 'b'.repeat(64)),
    stage: jest.fn(async (_range, logs) => {
      staged = logs;
      return { ledgerId: 'b'.repeat(64), ledgerSha256: 'c'.repeat(64) };
    }),
    visit: jest.fn(async (_reference, visitor) => {
      for (const value of staged) await visitor(value);
      return { count: staged.length };
    }),
    visitThrough: jest.fn(),
    retain: jest.fn(),
    close: jest.fn(() => controller.abort()),
  };
  const projectRange = jest.fn(async ({ range }, { visit }) => {
    await visit(() => {});
    return emptyPublicState(range.storeId);
  });
  const source = createRailgunScanSource({ handle: sourceHandle, ledger, projectRange });
  const value = { source, ledger, projectRange, controller, handle: sourceHandle };
  opened.push(value);
  return value;
}
const range = () => ({
  from: 0,
  to: 10,
  previousHash: hash(0),
  anchor: { number: 100, hash: hash(101) },
  storeId: 'a'.repeat(64),
});
beforeEach(() => {
  jest.clearAllMocks();
  select();
  opened = [];
  tor = new AbortController();
  mockEndpoint = { signal: tor.signal };
  scope = createPrivacyScope({
    profileId: 'source-destination-fixture',
    signal: new AbortController().signal,
  });
  handle = context();
  mockFactory.mockImplementation(() => ({ request: mockRequest, release: mockRelease }));
  mockRequest.mockImplementation(async (_handle, _url, options) => {
    const wire = JSON.parse(options.body);
    const result =
      wire.method === 'eth_chainId'
        ? '0xaa36a7'
        : wire.method === 'eth_getLogs'
          ? []
          : block(wire.params[0] === 'finalized' ? 100 : Number(BigInt(wire.params[0])));
    return {
      status: 200,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result })),
    };
  });
});
afterEach(() => {
  opened.forEach(({ source }) => source.close());
  scope.close();
  tor.abort();
});
test('source destination get/assert disclose only an opaque identity and perform zero acquisition/planner/storage/chain-ID work', () => {
  const { source, ledger, projectRange } = open();
  const observation = destination(source, handle);
  expect(destination(source, handle)).toBe(observation);
  expect(() => assertDestination(source, handle, observation)).not.toThrow();
  expect(Object.isFrozen(observation)).toBe(true);
  expect(Object.keys(observation)).toEqual([]);
  expect(JSON.stringify(observation)).toBe('{}');
  expect(getPrivateRpcDestinationDetails(observation)).toMatchObject({
    url: originalUrl,
    role: 'protocol-rpc',
    chainId: 11155111,
  });
  expect(mockFactory).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
  expect(projectRange).not.toHaveBeenCalled();
  for (const method of ['stage', 'visit', 'visitThrough', 'retain', 'close'])
    expect(ledger[method]).not.toHaveBeenCalled();
});
test('copied source/destination or wrong exact handle refuses without revoking genuine source', () => {
  const { source } = open();
  const observation = destination(source, handle);
  for (const fake of [{}, { ...source }, Object.create(source)]) {
    expect(() => destination(fake, handle)).toThrow();
    expect(() => assertDestination(fake, handle, observation)).toThrow();
  }
  for (const fake of [
    {},
    { ...observation },
    Object.create(observation),
    JSON.parse(JSON.stringify(observation)),
  ])
    expect(() => assertDestination(source, handle, fake)).toThrow();
  const otherScope = createPrivacyScope({
    profileId: 'source-destination-fixture',
    signal: new AbortController().signal,
  });
  try {
    const sameSubjectDifferentHandle = context('source-fixture', otherScope);
    expect(() => destination(source, sameSubjectDifferentHandle)).toThrow();
    expect(() => assertDestination(source, sameSubjectDifferentHandle, observation)).toThrow();
    expect(() => destination(source, context('other-account'))).toThrow();
    expect(() => destination(source, {})).toThrow();
    expect(() => assertDestination(source, handle, observation)).not.toThrow();
    expect(source.signal.aborted).toBe(false);
  } finally {
    otherScope.close();
  }
  expect(mockRequest).not.toHaveBeenCalled();
});
test('same URL and same handle do not let a second genuine source reuse the first destination observation', () => {
  const first = open(),
    second = open();
  const observation = destination(first.source, handle);
  const other = destination(second.source, handle);
  expect(other).not.toBe(observation);
  expect(getPrivateRpcDestinationDetails(other)).toEqual(
    getPrivateRpcDestinationDetails(observation)
  );
  expect(() => assertDestination(second.source, handle, observation)).toThrow();
  expect(() => assertDestination(first.source, handle, other)).toThrow();
  expect(first.source.signal.aborted).toBe(false);
  expect(second.source.signal.aborted).toBe(false);
  expect(mockRequest).not.toHaveBeenCalled();
});
test('registry replacement retains original source client/path through actual RPC admission and host-only provenance stays unchanged', async () => {
  const first = open();
  const observation = destination(first.source, handle);
  select('https://rpc.example:8443/replacement-source-path');
  expect(() => assertDestination(first.source, handle, observation)).not.toThrow();
  const result = await first.source.acquire(range());
  expect(mockRequest.mock.calls.every(([, url]) => url === originalUrl)).toBe(true);
  expect(
    mockRequest.mock.calls.filter(
      ([, , options]) => JSON.parse(options.body).method === 'eth_chainId'
    )
  ).toHaveLength(1);
  const expectedProviders = createHash('sha256')
    .update(JSON.stringify(['rpc.example:8443']))
    .digest('hex');
  expect(result.plan.source.providersSha256).toBe(expectedProviders);
  const second = open();
  const replacement = destination(second.source, handle);
  expect(getPrivateRpcDestinationDetails(replacement).url).toBe(
    'https://rpc.example:8443/replacement-source-path'
  );
  expect(() => assertDestination(second.source, handle, observation)).toThrow();
  expect(() => assertDestination(first.source, handle, observation)).not.toThrow();
});
test.each(['source', 'ledger', 'context', 'tor-abort', 'tor-replacement'])(
  'source destination invalidates on %s without fetching a replacement',
  (boundary) => {
    const value = open();
    const observation = destination(value.source, handle);
    if (boundary === 'source') value.source.close();
    if (boundary === 'ledger') value.controller.abort();
    if (boundary === 'context') scope.close();
    if (boundary === 'tor-abort') tor.abort();
    if (boundary === 'tor-replacement') mockEndpoint = { signal: new AbortController().signal };
    for (const run of [
      () => destination(value.source, handle),
      () => assertDestination(value.source, handle, observation),
    ]) {
      let error;
      try {
        run();
      } catch (failure) {
        error = failure;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('private-source-path');
    }
    expect(() => getPrivateRpcDestinationDetails(observation)).toThrow();
    expect(mockRequest).not.toHaveBeenCalled();
  }
);

test('Tor object replacement without old signal abort cannot substitute a later genuine same-handle client for the retained source', () => {
  const value = open();
  const original = destination(value.source, handle);
  const oldEndpoint = mockEndpoint;
  mockEndpoint = { signal: new AbortController().signal };
  select('https://rpc.example:8443/new-tor-client-path');
  const laterClient = createPrivateRpc(handle, 'protocol-rpc');
  const later = getPrivateRpcDestination(laterClient, handle);
  expect(oldEndpoint.signal.aborted).toBe(false);
  expect(value.source.signal.aborted).toBe(false);
  expect(laterClient.signal.aborted).toBe(false);
  expect(getPrivateRpcDestinationDetails(later).url).toBe(
    'https://rpc.example:8443/new-tor-client-path'
  );
  expect(() => destination(value.source, handle)).toThrow();
  expect(() => assertDestination(value.source, handle, original)).toThrow();
  expect(() => assertDestination(value.source, handle, later)).toThrow();
  expect(() => getPrivateRpcDestinationDetails(original)).toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
  expect(value.projectRange).not.toHaveBeenCalled();
});
