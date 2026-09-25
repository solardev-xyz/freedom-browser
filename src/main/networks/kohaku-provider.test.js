jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => mockEnabled }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('./network-registry', () => ({ getNetwork: () => ({}), getEndpoints: () => ['https://rpc.example'], getEndpointSources: () => [{ keyed: false, coverage: { '11155111': 'https://rpc.example' } }] }));
jest.mock('./wallet-tor-transport', () => ({ createWalletTorTransport: () => ({ request: mockRequest }) }));
const mockRequest = jest.fn();
let mockEndpoint, mockEnabled;
const { createPrivacyScope } = require('./privacy-context');
const { createPrivateRpc } = require('./private-rpc');
const { createKohakuProvider } = require('./kohaku-provider');
const target = `0x${'1'.repeat(40)}`;
const event = `0x${'a'.repeat(64)}`;
const txHash = `0x${'b'.repeat(64)}`;
const blockHash = `0x${'c'.repeat(64)}`;
const subject = { kind: 'private-account', principal: 'account-fixture', protocol: 'ppv2-fixture', deployment: 'sepolia-fixture', chainId: 11155111, role: 'protocol-rpc' };
const filter = () => ({ address: target, topics: [[event]], fromBlock: '0x1', toBlock: '0x2' });
let scope, handle, provider, contracts, results, requests, hook;
beforeEach(() => {
  mockEnabled = true; mockRequest.mockClear();
  mockEndpoint = { signal: new AbortController().signal };
  scope = createPrivacyScope({ profileId: 'provider-fixture', signal: new AbortController().signal });
  handle = scope.getContext(subject);
  contracts = [{ address: target, selectors: ['0x12345678'], eventTopics: [event] }];
  provider = createKohakuProvider({ handle, contracts });
  results = { eth_chainId: '0xaa36a7', eth_blockNumber: '0x2', eth_call: '0x1234', eth_getCode: '0x6000', eth_getLogs: [
    { address: target, topics: [event], data: '0x', blockNumber: '0x1', blockHash, transactionHash: txHash, logIndex: '0x0', removed: false },
  ] };
  requests = []; hook = null;
  mockRequest.mockImplementation(async (context, _url, options) => {
    expect(context).toBe(handle);
    const call = JSON.parse(options.body); requests.push(call);
    if (hook) await hook(call);
    return { status: 200, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: results[call.method] })) };
  });
});
afterEach(() => scope.close());

test('read calls and full raw log metadata use the private context, with no verification upgrade', async () => {
  expect(await provider.getChainId()).toBe(11155111n);
  expect(await provider.getBlockNumber()).toBe(2n);
  expect(await provider.getCode(target)).toBe('0x6000');
  expect(await provider.call({ to: target, data: '0x12345678' })).toBe('0x1234');
  expect(await provider.request({ method: 'eth_getLogs', params: [filter()] })).toEqual(results.eth_getLogs);
  expect(provider).toMatchObject({ verified: false, trust: { level: 'unverified' } });
  expect(requests.map((call) => call.method)).toEqual(['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call', 'eth_getLogs']);
  expect(provider._internal.request).toBe(provider.request);
});

test('signing, broadcast, receipts, balances and nonce queries are outside this read capability', async () => {
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign', 'eth_getTransactionReceipt', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getStorageAt']) {
    await expect(provider.request({ method, params: [] })).rejects.toMatchObject({ code: 'PRIVATE_SDK_RPC_REFUSED' });
  }
  await expect(provider.waitForTransaction(txHash)).rejects.toMatchObject({ code: 'PRIVATE_SDK_RPC_REFUSED' });
  expect(mockRequest).not.toHaveBeenCalled();
});

test('contract, selector, event, indexed-account filters and broad scans are refused before log egress', async () => {
  const invalidFilters = [
    { ...filter(), address: `0x${'2'.repeat(40)}` }, { ...filter(), topics: [] }, { ...filter(), topics: [null] },
    { ...filter(), topics: [[txHash]] }, { ...filter(), topics: [[event], txHash] },
    { ...filter(), fromBlock: '0x0', toBlock: '0x1388' }, { ...filter(), fromBlock: '0x3' },
    { ...filter(), blockHash }, { ...filter(), address: [target] },
  ];
  for (const query of invalidFilters) await expect(provider.request({ method: 'eth_getLogs', params: [query] })).rejects.toMatchObject({ code: 'PRIVATE_SDK_RPC_REFUSED' });
  for (const call of [{ to: target, data: '0x11111111' }, { to: target, data: '0x12345678', from: target }, { to: txHash, data: '0x12345678' }]) {
    await expect(provider.call(call)).rejects.toMatchObject({ code: 'PRIVATE_SDK_RPC_REFUSED' });
  }
  expect(mockRequest).not.toHaveBeenCalled();
});

test('latest is converted to a concrete bounded range; caller mutation cannot alter the sent filter', async () => {
  const query = { ...filter(), toBlock: 'latest' };
  hook = async (call) => {
    if (call.method === 'eth_chainId') { query.address = `0x${'2'.repeat(40)}`; query.topics[0][0] = txHash; query.fromBlock = '0x0'; }
  };
  await provider.request({ method: 'eth_getLogs', params: [query] });
  expect(requests.at(-1)).toMatchObject({ method: 'eth_getLogs', params: [filter()] });
  contracts[0].selectors.push('0x11111111');
  await expect(provider.call({ to: target, data: '0x11111111' })).rejects.toMatchObject({ code: 'PRIVATE_SDK_RPC_REFUSED' });
});

test.each(['address', 'topic', 'range', 'removed', 'hash', 'size'])('invalid log response %s never reaches the SDK', async (change) => {
  const log = results.eth_getLogs[0];
  if (change === 'address') log.address = `0x${'2'.repeat(40)}`;
  if (change === 'topic') log.topics = [txHash];
  if (change === 'range') log.blockNumber = '0x3';
  if (change === 'removed') log.removed = true;
  if (change === 'hash') log.transactionHash = '0x1';
  if (change === 'size') results.eth_getLogs = Array(2049).fill(log);
  await expect(provider.request({ method: 'eth_getLogs', params: [filter()] })).rejects.toMatchObject({ code: 'PRIVATE_RPC_INVALID' });
});

test('scope, gate, chain and transport lifetime checks remain enforced', async () => {
  expect(() => createPrivateRpc(handle, 'balance-rpc')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PRIVACY_REQUIREMENTS' }));
  const publicHandle = scope.getContext({ kind: 'public-address', principal: target, chainId: 11155111, role: 'protocol-rpc' });
  expect(() => createKohakuProvider({ handle: publicHandle, contracts })).toThrow(expect.objectContaining({ code: 'PRIVATE_SDK_UNAVAILABLE' }));
  mockEnabled = false;
  expect(() => createKohakuProvider({ handle, contracts })).toThrow(expect.objectContaining({ code: 'PRIVACY_TRANSPORT_UNAVAILABLE' }));
  mockEnabled = true; results.eth_chainId = '0x1';
  await expect(provider.getBlockNumber()).rejects.toMatchObject({ code: 'PRIVATE_CHAIN_MISMATCH' });
  expect(requests.map((call) => call.method)).toEqual(['eth_chainId']);
  provider = createKohakuProvider({ handle, contracts });
  mockEndpoint = { signal: new AbortController().signal };
  await expect(provider.getBlockNumber()).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
});

test('lock or caller cancellation discards a response that arrives after revocation', async () => {
  const controller = new AbortController();
  provider = createKohakuProvider({ handle, contracts, signal: controller.signal });
  hook = async () => controller.abort();
  await expect(provider.getBlockNumber()).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  provider = createKohakuProvider({ handle, contracts }); hook = async () => scope.close();
  await expect(provider.getBlockNumber()).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
});
