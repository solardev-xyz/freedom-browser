jest.mock('../profile-resolver', () => ({ getActiveProfile: () => mockProfile }));
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => mockAvailable }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('./wallet-tor-transport', () => ({ createWalletTorTransport: () =>
  jest.requireActual('./wallet-tor-transport').createWalletTorTransport({ getEndpoint: () => mockEndpoint, ca: mockCertificate }) }));
const https = require('https');
const dns = require('dns');
const { listen, proxy } = require('../../../test/helpers/tor-socks-fixture');
const fixture = require('../../../test/helpers/tor-tls-fixture');
const { createPrivacyScope } = require('./privacy-context');
const { createKohakuNetwork } = require('./kohaku-network');
const { createKohakuNetworkRouter } = require('./kohaku-network-router');
let mockAvailable, mockEndpoint, mockCertificate, mockProfile;
let scope, server, socks, network;
const seen = [];
const origin = 'https://rpc.example.test';
function context(principal = 'a', role = 'asp') {
  return scope.getContext({ kind: 'private-account', principal, protocol: 'fixture', deployment: 'sepolia', chainId: 11155111, role });
}
beforeEach(async () => {
  mockAvailable = true; mockCertificate = fixture.cert; seen.length = 0;
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  server = https.createServer(fixture, (req, res) => {
    seen.push({ url: req.url, headers: req.headers, method: req.method });
    if (req.url === '/stall') return;
    if (req.url === '/redirect') { res.writeHead(302, { location: 'https://leak.example/' }); res.end(); return; }
    if (req.url === '/large') { res.end(Buffer.alloc(4 * 1024 * 1024 + 1)); return; }
    res.setHeader('content-type', 'application/json'); res.setHeader('set-cookie', 'id=tracking');
    res.end(JSON.stringify({ ok: true, success: true }));
  });
  socks = await proxy(await listen(server)); mockEndpoint = socks.endpoint;
  network = createKohakuNetwork({ handle: context(), endpoints: [{ url: `${origin}/`, methods: ['GET', 'POST'] }] });
});
afterEach(async () => {
  scope.close(); await socks.close(); server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve)); jest.restoreAllMocks();
});

test('fetch-compatible JSON responses use account-separated SOCKS with no ambient fetch, cookies or DNS', async () => {
  const ambient = jest.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('ambient fetch'); });
  const lookup = jest.spyOn(dns, 'lookup');
  const other = createKohakuNetwork({ handle: context('b'), endpoints: [{ url: `${origin}/`, methods: ['GET'] }] });
  const response = await network.fetch(new URL(`${origin}/tree`));
  expect(await response.json()).toEqual({ ok: true, success: true });
  expect(response.headers.get('set-cookie')).toBeNull();
  await network.fetch(`${origin}/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await other.fetch(new Request(`${origin}/tree`));
  expect(socks.records).toHaveLength(2);
  expect(new Set(socks.records.map((record) => record.token)).size).toBe(2);
  expect(ambient).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
  expect(seen.every(({ headers }) => !headers.cookie && !headers.authorization)).toBe(true);
});

test('capabilities bind endpoint, path, method and public pool scope before any I/O', async () => {
  const asp = createKohakuNetwork({ handle: context(), endpoints: [{ url: `${origin}/public/`, methods: ['GET'], poolScope: '123' }] });
  for (const [url, init] of [
    ['https://other.example/public/', {}], [`${origin}/private`, {}], [`${origin}/public/%2f..%2fprivate`, {}],
    [`${origin}/public/tree`, { method: 'POST', body: '{}' }], [`${origin}/public/tree`, { headers: { authorization: 'fixture' } }],
    [`${origin}/public/tree`, { headers: { 'x-pool-scope': '456' } }], [`${origin}/public/tree`, { credentials: 'include' }],
    [`${origin}/public/tree`, { redirect: 'follow' }], [`${origin}/public/tree`, { headers: { cookie: 'id=1' } }],
  ]) await expect(asp.fetch(url, init)).rejects.toMatchObject({ code: 'PRIVATE_SDK_REQUEST_REFUSED' });
  expect(socks.records).toHaveLength(0);
  await asp.fetch(`${origin}/public/tree`, { headers: { 'x-pool-scope': '123' } });
  expect(seen[0].headers['x-pool-scope']).toBe('123');
});

test('one SDK interface keeps ASP and relayer SOCKS identities separate even on the same origin', async () => {
  const groups = [
    { handle: context('a', 'asp'), endpoints: [{ url: `${origin}/asp/`, methods: ['GET'] }] },
    { handle: context('a', 'relayer'), endpoints: [{ url: `${origin}/quote`, methods: ['POST'] }] },
  ];
  const router = createKohakuNetworkRouter(groups);
  groups[1].endpoints[0].url = `${origin}/submit`;
  await router.fetch(`${origin}/asp/tree`);
  await router.fetch(`${origin}/quote`, { method: 'POST', body: '{}' });
  expect(socks.records).toHaveLength(2);
  expect(new Set(socks.records.map((record) => record.token)).size).toBe(2);
  for (const [url, init] of [[`${origin}/submit`, { method: 'POST' }], [`${origin}/asp/tree`, { method: 'POST' }],
    [`${origin}/quote`, {}], [`${origin}/asp/tree`, { headers: { authorization: 'fixture' } }]]) {
    await expect(router.fetch(url, init)).rejects.toMatchObject({ code: 'PRIVATE_SDK_REQUEST_REFUSED' });
  }
  expect(seen.map((record) => record.url)).toEqual(['/asp/tree', '/quote']);
  scope.close();
  await expect(router.fetch(`${origin}/asp/tree`)).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
});

test('role router rejects ambiguous paths, another account and duplicate roles before I/O', () => {
  const group = (principal, role, suffix) => ({ handle: context(principal, role), endpoints: [{ url: `${origin}${suffix}`, methods: ['GET'] }] });
  for (const groups of [
    [group('a', 'asp', '/'), group('a', 'relayer', '/quote')],
    [group('a', 'asp', '/asp/'), group('b', 'relayer', '/quote')],
    [group('a', 'asp', '/asp/'), group('a', 'asp', '/quote')],
  ]) expect(() => createKohakuNetworkRouter(groups)).toThrow();
  expect(socks.records).toHaveLength(0);
});

test('redirects and oversized bodies fail without fallback; Tor replacement revokes this capability', async () => {
  await expect(network.fetch(`${origin}/redirect`)).rejects.toMatchObject({ code: 'PRIVATE_REDIRECT_REFUSED' });
  await expect(network.fetch(`${origin}/large`)).rejects.toMatchObject({ code: 'PRIVATE_RESPONSE_TOO_LARGE' });
  await expect(network.fetch(`${origin}/request`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) }))
    .rejects.toMatchObject({ code: 'PRIVATE_REQUEST_TOO_LARGE' });
  mockEndpoint = { ...mockEndpoint, generation: 2 };
  await expect(network.fetch(`${origin}/tree`)).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  expect(seen.map(({ url }) => url)).toEqual(['/redirect', '/large']);
});

test('caller cancellation and vault lock abort an active SDK response', async () => {
  const controller = new AbortController();
  const pending = network.fetch(`${origin}/stall`, { signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  await socks.greeting; controller.abort(); await rejected;
  const locked = network.fetch(`${origin}/stall`);
  const lockedResult = expect(locked).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  scope.close(); await lockedResult;
});

test('the development gate and supported capability scope are required', () => {
  mockAvailable = false;
  expect(() => createKohakuNetwork({ handle: context(), endpoints: [{ url: origin, methods: ['GET'] }] }))
    .toThrow(expect.objectContaining({ code: 'PRIVATE_SDK_UNAVAILABLE' }));
  mockAvailable = true;
  expect(() => createKohakuNetwork({ handle: context('a', 'keystore'), endpoints: [{ url: origin, methods: ['GET'] }] }))
    .toThrow(expect.objectContaining({ code: 'PRIVATE_SDK_UNAVAILABLE' }));
});

// Optional, pinned upstream client compiled outside the app with the spike
// script. No protocol package or new dependency is installed in Freedom.
const upstreamClient = process.env.FREEDOM_KOHAKU_CLIENT_FIXTURE;
(upstreamClient ? test : test.skip)('current upstream relayer client consumes the host adapter over real SOCKS/TLS fixtures', async () => {
  const { RelayerClient } = require(upstreamClient);
  const relayer = createKohakuNetwork({ handle: context('a', 'relayer'), endpoints: [
    { url: `${origin}/status`, methods: ['GET'] }, { url: `${origin}/v1/tornadoWithdraw`, methods: ['POST'] },
  ] });
  const client = new RelayerClient({ network: relayer });
  expect(await client.getStatus('rpc.example.test')).toEqual({ ok: true, success: true });
  await client.withdraw(`${origin}/`, { proof: 'synthetic-local-fixture' });
  expect(seen.map(({ url }) => url)).toEqual(['/status', '/v1/tornadoWithdraw']);
});

const ppv2Http = process.env.FREEDOM_PP_V2_HTTP_FIXTURE;
(ppv2Http ? test : test.skip)('the pinned PPv2 PR HTTP adapter uses the host for JSON, binary and cancellation', async () => {
  const { KohakuHttpClient } = require(ppv2Http);
  const client = new KohakuHttpClient(network);
  const ambient = jest.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('ambient fetch'); });
  expect(await client.get(`${origin}/tree`)).toEqual({ ok: true, success: true });
  expect(await client.post(`${origin}/relay`, { fixture: true })).toEqual({ ok: true, success: true });
  expect(Buffer.from(await client.getBinary(`${origin}/artifact`)).toString()).toBe('{"ok":true,"success":true}');
  await expect(client.get(`${origin}/stall`, { timeout: 20 })).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  await expect(client.get(`${origin}/tree`, { headers: { authorization: 'fixture' } }))
    .rejects.toMatchObject({ code: 'PRIVATE_SDK_REQUEST_REFUSED' });
  expect(ambient).not.toHaveBeenCalled();
  expect(seen.map(({ url }) => url)).toEqual(['/tree', '/relay', '/artifact', '/stall']);
});


test('explicit direct relayer selection preserves Tor ASP routing and never falls back', async () => {
  const fs = require('fs'), path = require('path'), os = require('os');
  mockProfile = { id: 'direct', userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-route-')) };
  const direct = require('./direct-testnet-transport');
  fs.writeFileSync(path.join(mockProfile.userDataDir, direct.MARKER), JSON.stringify({ version: 1, chainId: 11155111,
    profileId: 'direct', disposable: true, relayerExposure: 'direct-ip' }));
  const mixedScope = createPrivacyScope({ profileId: require('crypto').createHash('sha256').update(JSON.stringify(['direct', mockProfile.userDataDir])).digest('hex'), signal: new AbortController().signal });
  const h = role => mixedScope.getContext({ kind: 'private-account', principal: 'ppv2:0', protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111, role });
  const request = jest.fn(async () => ({ status: 403, headers: {}, body: Buffer.from('{}') }));
  const close = jest.fn();
  jest.spyOn(direct, 'createDirectTestnetTransport').mockReturnValue({ request, close });
  try {
    const router = createKohakuNetworkRouter([
      { handle: h('asp'), endpoints: [{ url: `${origin}/asp/`, methods: ['GET'] }] },
      { handle: h('relayer'), endpoints: [{ url: `${origin}/relay/`, methods: ['GET', 'POST'] }], route: 'direct-sepolia-test' },
    ]);
    await router.fetch(`${origin}/asp/tree`);
    for (const suffix of ['details', 'quote', 'withdrawal']) expect((await router.fetch(`${origin}/relay/${suffix}`, { method: 'POST', body: '{}' })).status).toBe(403);
    expect(request).toHaveBeenCalledTimes(3); expect(seen.map(s => s.url)).toEqual(['/asp/tree']);
    request.mockRejectedValue(new Error('direct failure'));
    await expect(router.fetch(`${origin}/relay/quote`, { method: 'POST', body: '{}' })).rejects.toThrow('direct failure');
    expect(seen.map(s => s.url)).toEqual(['/asp/tree']);
    for (const role of ['asp', 'indexer', 'artifacts']) {
      const group = { handle: h(role), endpoints: [{ url: origin, methods: ['GET'] }], route: 'direct-sepolia-test' };
      expect(() => createKohakuNetwork(group)).toThrow(); expect(() => createKohakuNetworkRouter([group])).toThrow();
    }
    mockEndpoint = { ...mockEndpoint };
    await expect(router.fetch(`${origin}/relay/details`)).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  } finally { mixedScope.close(); }
  expect(close).toHaveBeenCalled();
});

test('a Tor relayer failure never constructs the direct transport', async () => {
  const direct = require('./direct-testnet-transport');
  const factory = jest.spyOn(direct, 'createDirectTestnetTransport');
  const relayer = createKohakuNetwork({ handle: context('a', 'relayer'), endpoints: [{ url: `${origin}/stall`, methods: ['GET'] }] });
  const controller = new AbortController();
  const pending = relayer.fetch(`${origin}/stall`, { signal: controller.signal });
  const rejection = expect(pending).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  await socks.greeting; controller.abort(); await rejection;
  expect(factory).not.toHaveBeenCalled();
});
