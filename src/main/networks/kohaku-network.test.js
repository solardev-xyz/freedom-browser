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
let mockAvailable, mockEndpoint, mockCertificate;
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
