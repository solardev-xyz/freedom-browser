/** Genuine RPC restrictions composed with real loopback SOCKS/TLS. Registry,
 * managed endpoint and fixture CA are test seams, never wallet/chain authority.
 * API tripwires are not an OS-wide egress or Tor-circuit isolation claim. */
const net = require('net');
const tls = require('tls');
const https = require('https');
const dns = require('dns');
const { listen, proxy } = require('../../../test/helpers/tor-socks-fixture');
const mockCertificate = require('../../../test/helpers/tor-tls-fixture');
let mockEndpoint, mockUrl, mockTransport;
const mockFactory = jest.fn();
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('./network-registry', () => ({
  getNetwork: () => ({ quorum: { timeoutMs: 10000 } }),
  getEndpoints: () => [mockUrl],
  getEndpointSources: () => [{ keyed: false, coverage: { 11155111: mockUrl } }],
}));
jest.mock('./wallet-tor-transport', () => ({
  createWalletTorTransport: (...args) => {
    mockFactory(...args);
    mockTransport = jest.requireActual('./wallet-tor-transport').createWalletTorTransport({
      getEndpoint: () => mockEndpoint,
      ca: mockCertificate.cert,
    });
    return mockTransport;
  },
}));
const URL = 'https://rpc.example.test/reviewed/path';
function gate() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function bounded(promise, label, milliseconds = 2500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(label)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
let rpc, scope, lifetime, server, socks, seen, grants, originalHandle;
let httpCreated, connects, dnsAttempts, tlsCalls, response;
let arrive, constructed;
let assignedRequests, closedRequests, transportSockets, closedSockets;
function handle(operation = 'derived') {
  return scope.getContext({
    kind: 'public-address',
    principal: '0x' + '1'.repeat(40),
    chainId: 11155111,
    role: 'transaction-rpc',
    operation,
  });
}
function restrict() {
  const original = rpc.createPrivateRpc(originalHandle, 'transaction-rpc');
  const grant = rpc.createPrivateRpcDestinationConstraint({
    observation: rpc.getPrivateRpcDestination(original, originalHandle),
    signal: lifetime.signal,
    deadline: performance.now() + 60000,
  });
  grants.push(grant);
  return grant;
}
function derive(grant) {
  return rpc.createPrivateRpc(handle(), 'transaction-rpc', {
    destinationConstraint: grant.constraint,
  });
}
function target(args) {
  if (Array.isArray(args[0])) return target(args[0]);
  if (args[0] && typeof args[0] === 'object')
    return { host: args[0].host, port: Number(args[0].port) };
  return { host: args[1], port: Number(args[0]) };
}
beforeEach(async () => {
  jest.resetModules();
  lifetime = scope = socks = undefined;
  mockFactory.mockClear();
  mockTransport = undefined;
  mockUrl = URL;
  seen = [];
  grants = [];
  httpCreated = [];
  connects = [];
  dnsAttempts = [];
  tlsCalls = [];
  assignedRequests = new Set();
  closedRequests = new Set();
  transportSockets = new Set();
  closedSockets = new Set();
  arrive = gate();
  constructed = gate();
  response = (wire, res) =>
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: wire.id,
        result: wire.method === 'eth_chainId' ? '0xaa36a7' : '0x1',
      })
    );
  server = https.createServer(mockCertificate, (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const wire = JSON.parse(body);
      seen.push({ path: req.url, headers: req.headers, wire });
      if (seen.filter((v) => v.wire.method === 'eth_blockNumber').length === 2) arrive.resolve();
      response(wire, res);
    });
  });
  const port = await listen(server);
  socks = await proxy(port);
  mockEndpoint = socks.endpoint;
  const actualConnect = net.Socket.prototype.connect;
  jest.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (...args) {
    const destination = target(args);
    connects.push(destination);
    if (destination.host !== '127.0.0.1' || ![socks.endpoint.port, port].includes(destination.port))
      throw Error('DIRECT_SOCKET_TRIPWIRE');
    const result = Reflect.apply(actualConnect, this, args);
    if (destination.port === socks.endpoint.port) transportSockets.add(this);
    this.once('close', () => {
      closedSockets.add(this);
    });
    return result;
  });
  const actualLookup = dns.lookup;
  jest.spyOn(dns, 'lookup').mockImplementation(function (...args) {
    // Node's server.listen may look up its literal loopback bind address.
    if (args[0] === '127.0.0.1') return Reflect.apply(actualLookup, this, args);
    dnsAttempts.push(args[0]);
    throw Error('DNS_TRIPWIRE');
  });
  const actualTls = tls.connect;
  jest.spyOn(tls, 'connect').mockImplementation(function (options, ...rest) {
    tlsCalls.push(options);
    if (
      !(options.socket instanceof net.Socket) ||
      options.rejectUnauthorized !== true ||
      options.servername !== 'rpc.example.test'
    )
      throw Error('TLS_DIRECT_TRIPWIRE');
    return Reflect.apply(actualTls, this, [options, ...rest]);
  });
  const actualRequest = https.request;
  jest.spyOn(https, 'request').mockImplementation(function (...args) {
    const req = Reflect.apply(actualRequest, this, args);
    httpCreated.push(req);
    if (req.socket) assignedRequests.add(req);
    req.once('socket', () => assignedRequests.add(req));
    req.once('close', () => {
      closedRequests.add(req);
    });
    if (httpCreated.length === 9) constructed.resolve(); // ready + eight admitted methods
    return req;
  });
  lifetime = new AbortController();
  scope = require('./privacy-context').createPrivacyScope({
    profileId: 'rpc-real-transport-fixture',
    signal: lifetime.signal,
  });
  originalHandle = handle('reviewed');
  rpc = require('./private-rpc');
});
afterEach(async () => {
  const errors = [];
  async function clean(run) {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const grant of grants) await clean(() => grant.close());
  await clean(() => lifetime?.abort());
  await clean(() => scope?.close());
  await clean(() => mockTransport?.close());
  await clean(() => mockTransport && bounded(mockTransport.closed, 'REAL_TRANSPORT_DRAIN_TIMEOUT'));
  await clean(() => socks?.close());
  await clean(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  jest.restoreAllMocks();
  if (errors.length) throw errors[0];
});
function noTargetLeak() {
  expect(dnsAttempts).toEqual([]);
  expect(connects.every((v) => v.host === '127.0.0.1')).toBe(true);
  expect(tlsCalls.every((v) => v.socket && v.rejectUnauthorized === true)).toBe(true);
}
test('genuine reviewed path crosses SOCKS and verified TLS with one hidden chain check', async () => {
  const grant = restrict(),
    client = derive(grant);
  expect(mockFactory).not.toHaveBeenCalled();
  expect(socks.records).toHaveLength(0);
  expect(seen).toHaveLength(0);
  const result = await client.request('eth_blockNumber', [], (v) => v === '0x1');
  expect(result).toMatchObject({
    result: '0x1',
    verified: false,
    source: 'direct',
    privacy: {
      mode: 'tor-experimental',
      transport: 'authenticated-socks',
      circuitIsolation: 'unqualified',
    },
  });
  await client.request('eth_blockNumber', [], (v) => v === '0x1');
  expect(seen.map((v) => v.wire.method)).toEqual([
    'eth_chainId',
    'eth_blockNumber',
    'eth_blockNumber',
  ]);
  expect(seen.map((v) => v.path)).toEqual(Array(3).fill('/reviewed/path'));
  expect(mockFactory).toHaveBeenCalledTimes(1);
  expect(socks.records).toHaveLength(1);
  expect(tlsCalls).toHaveLength(1);
  expect(socks.records[0]).toMatchObject({
    greeting: [5, 1, 2],
    user: '<torS0X>0',
    addressType: 3,
    hostname: 'rpc.example.test',
    port: 443,
  });
  expect(socks.records[0].token).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(seen)).not.toContain(socks.records[0].token);
  noTargetLeak();
});
test.each(['https://rpc.example.test/unreviewed/path', 'https://other.example.test/reviewed/path'])(
  'new constrained client refuses registry replacement %s before any connection',
  async (url) => {
    const grant = restrict();
    mockUrl = url;
    expect(() => derive(grant)).toThrow(
      expect.objectContaining({ code: 'PRIVATE_RPC_DESTINATION_REFUSED' })
    );
    expect(mockFactory).not.toHaveBeenCalled();
    expect(connects).toEqual([]);
    expect(seen).toEqual([]);
    expect(socks.records).toEqual([]);
    expect(grant.signal.aborted).toBe(false);
    mockUrl = URL;
    await derive(grant).request('eth_blockNumber', [], (v) => v === '0x1');
    expect(seen).toHaveLength(2);
    noTargetLeak();
  }
);
test('already derived client keeps reviewed path after registry edit, while replacement refuses', async () => {
  const grant = restrict(),
    client = derive(grant);
  mockUrl = 'https://rpc.example.test/unreviewed/path';
  expect(() => derive(grant)).toThrow(
    expect.objectContaining({ code: 'PRIVATE_RPC_DESTINATION_REFUSED' })
  );
  await client.request('eth_blockNumber', [], (v) => v === '0x1');
  expect(seen.map((v) => v.path)).toEqual(['/reviewed/path', '/reviewed/path']);
  noTargetLeak();
});
test('replaced managed endpoint object prevents a primed client admitting more HTTP', async () => {
  const client = derive(restrict());
  await client.ready();
  const prior = seen.length,
    connections = connects.length;
  mockEndpoint = Object.freeze({ ...socks.endpoint, generation: 2 });
  await expect(client.request('eth_blockNumber', [], () => true)).rejects.toMatchObject({
    code: 'PRIVATE_RPC_DESTINATION_REFUSED',
  });
  expect(seen).toHaveLength(prior);
  expect(connects).toHaveLength(connections);
  noTargetLeak();
});
test.each(['constraint', 'scope', 'endpoint'])(
  '%s revocation cancels two occupied and six real Agent queued RPCs',
  async (reason) => {
    const grant = restrict(),
      client = derive(grant);
    await client.ready();
    response = () => {};
    const first = Array.from({ length: 2 }, () =>
      client.request('eth_blockNumber', [], () => true)
    );
    const firstSettled = Promise.allSettled(first);
    await bounded(arrive.promise, 'OCCUPIED_RPC_ADMISSION_TIMEOUT');
    const remaining = Array.from({ length: 6 }, () =>
      client.request('eth_blockNumber', [], () => true)
    );
    const settled = Promise.allSettled([...first, ...remaining]);
    void firstSettled;
    await bounded(constructed.promise, 'QUEUED_RPC_ADMISSION_TIMEOUT');
    expect(seen).toHaveLength(3);
    expect(httpCreated).toHaveLength(9);
    const agent = httpCreated[1].agent;
    expect(httpCreated.slice(1).every((req) => req.agent === agent)).toBe(true);
    expect(Object.values(agent.sockets).reduce((n, v) => n + v.length, 0)).toBe(2);
    expect(Object.values(agent.requests).reduce((n, v) => n + v.length, 0)).toBe(6);
    if (reason === 'constraint') grant.close();
    else if (reason === 'scope') scope?.close();
    else socks.controller.abort();
    const results = await bounded(settled, 'RPC_REVOCATION_DID_NOT_DRAIN', 1500);
    expect(results.map((v) => v.status)).toEqual(Array(8).fill('rejected'));
    expect(results.map((v) => v.reason.code)).toEqual(Array(8).fill('PRIVACY_REQUEST_ABORTED'));
    await expect(client.request('eth_blockNumber', [], () => true)).rejects.toThrow();
    expect(seen).toHaveLength(3);
    mockTransport.close();
    await bounded(mockTransport.closed, 'TRANSPORT_CLOSE_NOT_OBSERVED');
    // Never-assigned Agent queue entries need not emit close (transport's
    // explicit logical-abort path); assigned requests and sockets must do so.
    expect(assignedRequests.size).toBeGreaterThanOrEqual(3);
    expect([...assignedRequests].every((req) => closedRequests.has(req))).toBe(true);
    expect(httpCreated.every((req) => req.destroyed)).toBe(true);
    expect(transportSockets.size).toBe(2);
    expect(tlsCalls).toHaveLength(2);
    expect([...transportSockets].every((socket) => closedSockets.has(socket))).toBe(true);
    noTargetLeak();
  }
);
test('genuine constrained RPC refuses failed SOCKS authentication without TLS HTTP or fallback', async () => {
  await socks?.close();
  socks = await proxy(server.address().port, 'auth-failure');
  mockEndpoint = socks.endpoint;
  const client = derive(restrict());
  await expect(client.request('eth_blockNumber', [], () => true)).rejects.toMatchObject({
    code: 'TOR_REQUEST_FAILED',
  });
  expect(socks.records).toHaveLength(1);
  expect(seen).toEqual([]);
  expect(tlsCalls).toEqual([]);
  noTargetLeak();
});
test('DNS and direct-connect tripwires reject actual target API attempts before original calls', () => {
  expect(() => dns.lookup('rpc.example.test', () => {})).toThrow('DNS_TRIPWIRE');
  const socket = new net.Socket();
  try {
    expect(() => socket.connect(443, 'rpc.example.test')).toThrow('DIRECT_SOCKET_TRIPWIRE');
  } finally {
    socket.destroy();
  }
  expect(dnsAttempts).toEqual(['rpc.example.test']);
  expect(connects).toEqual([{ host: 'rpc.example.test', port: 443 }]);
  expect(seen).toEqual([]);
  expect(socks.records).toEqual([]);
});
