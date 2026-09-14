jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
const mockEndpoint = { signal: new AbortController().signal };
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: jest.fn(() => true), loadSettings: () => ({ walletTorBalanceReads: true }) }));
jest.mock('./network-registry', () => ({ getNetwork: jest.fn(), getEndpoints: jest.fn(), getEndpointSources: jest.fn() }));
jest.mock('./wallet-tor-transport', () => ({ createWalletTorTransport: () => ({ request: mockRequest }) }));
const mockRequest = jest.fn();
const registry = require('./network-registry');
const settings = require('../settings-store');
const { requestPrivateBalance } = require('./private-balance-router');
const { createPrivacyScope } = require('./privacy-context');
const address = `0x${'a'.repeat(40)}`;
let scope, handle;
const request = (method = 'eth_getBalance', params = [address, 'latest'], context = handle) =>
  requestPrivateBalance(11155111, method, params, { privacyContext: context, includeTrust: true });

beforeEach(() => {
  jest.clearAllMocks();
  settings.isWalletTorExperimentAvailable.mockReturnValue(true);
  scope = createPrivacyScope({ profileId: 'one', signal: new AbortController().signal });
  handle = scope.getContext({ kind: 'public-address', principal: address, chainId: 11155111, role: 'balance-rpc' });
  registry.getNetwork.mockReturnValue({ access: { readOrder: ['myotis', 'colibri', 'quorum', 'direct'] } });
  registry.getEndpoints.mockReturnValue(['https://rpc.example']);
  registry.getEndpointSources.mockReturnValue([{ keyed: false, coverage: { '11155111': 'https://rpc.example' } }]);
  mockRequest.mockImplementation(async (_handle, _url, options) => {
    const { id, method } = JSON.parse(options.body);
    return { status: 200, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0xaa36a7' : '0x1' })) };
  });
});
afterEach(() => scope.close());

test('checks chain and sends only this account through authenticated transport, with accurate trust evidence', async () => {
  const result = await request();
  expect(result).toMatchObject({ result: '0x1', source: 'direct', verified: false,
    trust: { method: 'direct', level: 'unverified', quorum: { achieved: false } },
    privacy: { circuitIsolation: 'unqualified' }, observedAt: expect.any(String) });
  expect(mockRequest).toHaveBeenCalledTimes(2);
  expect(mockRequest.mock.calls.every(([context]) => context === handle)).toBe(true);
});

test.each([
  ['eth_getBalance', [`0x${'b'.repeat(40)}`, 'latest']],
  ['eth_call', [{ to: address, data: `0x70a08231${'0'.repeat(24)}${'b'.repeat(40)}` }, 'latest']],
  ['eth_call', [{ to: address, data: '0x313ce567', from: address }, 'latest']],
  ['eth_sendRawTransaction', ['0x01']],
  ['eth_getBalance', [[address, address], 'latest']],
])('refuses mixed-account/batch and non-balance input %s', async (method, params) => {
  await expect(request(method, params)).rejects.toMatchObject({ code: 'PRIVATE_BALANCE_REQUEST_REFUSED' });
  expect(mockRequest).not.toHaveBeenCalled();
});

test('refuses unsupported protection, chain policy, gate and keyed sources before I/O', async () => {
  const strict = scope.getContext({ kind: 'public-address', principal: address, chainId: 11155111, role: 'balance-rpc' }, { correctness: 'quorum' });
  await expect(request(undefined, undefined, strict)).rejects.toMatchObject({ code: 'UNSUPPORTED_PRIVACY_REQUIREMENTS' });
  registry.getNetwork.mockReturnValue({ access: { readOrder: ['quorum', 'myotis'] } });
  await expect(request()).rejects.toMatchObject({ code: 'PRIVATE_SOURCE_UNAVAILABLE' });
  registry.getNetwork.mockReturnValue({});
  registry.getEndpointSources.mockReturnValue([{ keyed: true, coverage: { '11155111': 'https://rpc.example' } }]);
  await expect(request()).rejects.toMatchObject({ code: 'PRIVATE_SOURCE_UNAVAILABLE' });
  settings.isWalletTorExperimentAvailable.mockReturnValue(false);
  await expect(request()).rejects.toMatchObject({ code: 'PRIVACY_TRANSPORT_UNAVAILABLE' });
  expect(mockRequest).not.toHaveBeenCalled();
});

test('wrong chain stops before the account-bearing read', async () => {
  mockRequest.mockImplementation(async (_h, _u, options) => ({ status: 200,
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result: '0x1' })) }));
  await expect(request()).rejects.toMatchObject({ code: 'PRIVATE_CHAIN_MISMATCH' });
  expect(mockRequest).toHaveBeenCalledTimes(1);
});

test('invalid RPC responses and server errors cannot leak diagnostics or trigger fallback', async () => {
  mockRequest.mockResolvedValue({ status: 200, body: Buffer.from(JSON.stringify({ error: { message: address } })) });
  await expect(request()).rejects.toMatchObject({ code: 'PRIVATE_RPC_INVALID', message: 'Invalid private RPC response' });
  expect(mockRequest).toHaveBeenCalledTimes(1);
  mockRequest.mockImplementation(async (_h, _u, options) => ({ status: 200,
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result: `0x${'f'.repeat(67)}` })) }));
  await expect(request()).rejects.toMatchObject({ code: 'PRIVATE_CHAIN_MISMATCH' });
});

test('revocation during the chain check prevents the balance request', async () => {
  mockRequest.mockImplementation(async () => { scope.close(); return { status: 200, body: Buffer.from('{}') }; });
  await expect(request()).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  expect(mockRequest).toHaveBeenCalledTimes(1);
});
