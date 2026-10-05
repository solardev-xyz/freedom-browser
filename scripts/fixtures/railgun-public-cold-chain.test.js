/** Fixture interception tests only; mocked contexts are never native authorities. */
const W = '../../src/main/';
function setup() {
  jest.resetModules();
  const signal = new AbortController();
  const transport = {
    createWalletTorTransport: () => {
      throw Error('live fallback');
    },
  };
  jest.doMock(W + 'networks/privacy-context', () => ({
    getPrivacyContext: () => ({
      signal: signal.signal,
      subject: {
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role: 'protocol-rpc',
        operation: null,
      },
    }),
  }));
  jest.doMock(W + 'networks/wallet-tor-transport', () => transport);
  jest.doMock(W + 'networks/network-registry', () => ({}));
  jest.doMock(W + 'settings-store', () => ({}));
  jest.doMock(W + 'tor-manager', () => ({}));
  jest.doMock('./railgun-shield-offline-deployment', () => ({
    createOfflineShieldDeployment: () => ({ request: () => null }),
  }));
  const { install, URL } = require('./railgun-public-cold-chain');
  const fixture = install({
    chain: { latest: 5, finalized: 5, logs: [], headers: [] },
    bytecodes: '/public-fixture',
    phase: 'restore',
    mode: 'acknowledged',
  });
  const instance = transport.createWalletTorTransport();
  const handle = {};
  const options = {
    signal: signal.signal,
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '12345678-1234-4123-8123-123456789abc',
      method: 'eth_chainId',
      params: [],
    }),
  };
  return {
    fixture,
    instance,
    handle,
    options,
    signal,
    URL,
    sticky: require('./railgun-native-assertions'),
  };
}
afterEach(() => {
  for (const name of [
    'networks/privacy-context',
    'networks/wallet-tor-transport',
    'networks/network-registry',
    'settings-store',
    'tor-manager',
  ])
    jest.dontMock(W + name);
  jest.dontMock('./railgun-shield-offline-deployment');
});
test('cold synthetic chain is exact and context abort revokes its group', async () => {
  const s = setup();
  const result = await s.instance.request(s.handle, s.URL, s.options);
  expect(JSON.parse(result.body).result).toBe('0xaa36a7');
  s.signal.abort();
  expect(s.fixture.snapshot().revokedGroups).toBe(1);
  await s.fixture.close();
  expect(s.fixture.snapshot().closes).toBe(1);
  s.sticky.assertEmpty();
});
test.each(['url', 'method', 'params', 'extra', 'numeric-id', 'malformed-id'])(
  'wrong %s sticks even when host catches request refusal',
  async (mode) => {
    const s = setup();
    let url = s.URL;
    const call = JSON.parse(s.options.body);
    if (mode === 'url') url = 'https://other.invalid';
    if (mode === 'method') call.method = 'eth_sendRawTransaction';
    if (mode === 'params') call.params = [1];
    if (mode === 'extra') call.authority = true;
    if (mode === 'numeric-id') call.id = 1;
    if (mode === 'malformed-id') call.id = 'not-a-uuid';
    s.options.body = JSON.stringify(call);
    await expect(s.instance.request(s.handle, url, s.options)).rejects.toThrow();
    await s.fixture.close();
    expect(s.fixture.snapshot().unexpected).toBe(1);
    expect(() => s.sticky.assertEmpty()).toThrow();
  }
);

function realClientSetup({ wrongReply = false, publicOwner } = {}) {
  jest.resetModules();
  jest.dontMock(W + 'networks/privacy-context');
  const transport = {};
  const tor = {};
  jest.doMock(W + 'networks/wallet-tor-transport', () => transport);
  jest.doMock(W + 'networks/network-registry', () => ({}));
  jest.doMock(W + 'settings-store', () => ({}));
  jest.doMock(W + 'tor-manager', () => tor);
  jest.doMock('./railgun-shield-offline-deployment', () => ({
    createOfflineShieldDeployment: () => ({ request: () => null }),
  }));
  const { install } = require('./railgun-public-cold-chain');
  const fixture = install({
    chain: { latest: 5, finalized: 5, logs: [], headers: [] },
    bytecodes: '/public-fixture',
    phase: publicOwner ? 'setup' : 'restore',
    mode: 'acknowledged',
  });
  if (publicOwner) fixture.setOwner(publicOwner);
  const calls = [],
    replies = [];
  const factory = transport.createWalletTorTransport;
  transport.createWalletTorTransport = () => {
    const instance = factory(),
      request = instance.request;
    instance.request = async (...args) => {
      calls.push(JSON.parse(args[2].body));
      const result = await request(...args);
      const body = JSON.parse(result.body);
      replies.push(body);
      if (wrongReply)
        result.body = Buffer.from(JSON.stringify({ ...body, id: body.id + '-wrong' }));
      return result;
    };
    return instance;
  };
  const { createPrivacyScope } = require(W + 'networks/privacy-context');
  const scope = createPrivacyScope({
    profileId: 'public-cold-real-rpc-unit',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: publicOwner ? 'public-address' : 'private-account',
    principal: publicOwner ?? 'railgun:0',
    ...(publicOwner ? {} : { protocol: 'railgun', deployment: 'sepolia' }),
    chainId: 11155111,
    role: publicOwner ? 'transaction-rpc' : 'protocol-rpc',
  });
  const client = require(W + 'networks/private-rpc').createPrivateRpc(
    handle,
    publicOwner ? 'transaction-rpc' : 'protocol-rpc'
  );
  return { fixture, tor, calls, replies, scope, client, handle };
}

test('real RPC client passes hidden chain UUID and request UUID through stable retained endpoint', async () => {
  const s = realClientSetup();
  try {
    const endpoint = s.tor.getWalletSocksEndpoint();
    expect(s.tor.getWalletSocksEndpoint()).toBe(endpoint);
    const pins = require(W + 'wallet/railgun-shield-pins.json');
    const result = await s.client.request(
      'eth_getLogs',
      [{ address: pins.proxy, fromBlock: '0x0', toBlock: '0x5' }],
      Array.isArray
    );
    expect(result.result).toEqual([]);
    expect(s.calls.map((v) => v.method)).toEqual(['eth_chainId', 'eth_getLogs']);
    expect(s.calls[0].id).not.toBe(s.calls[1].id);
    for (let i = 0; i < s.calls.length; i++) {
      expect(s.calls[i].id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(s.replies[i].id).toBe(s.calls[i].id);
    }
    require('./railgun-native-assertions').assertEmpty();
  } finally {
    s.scope.close();
    await s.fixture.close();
  }
});

test('real client refuses changed echoed UUID; no subsequent method is admitted', async () => {
  const s = realClientSetup({ wrongReply: true });
  try {
    await expect(s.client.request('eth_getLogs', [], Array.isArray)).rejects.toMatchObject({
      code: 'PRIVATE_RPC_INVALID',
    });
    expect(s.calls.map((v) => v.method)).toEqual(['eth_chainId']);
  } finally {
    s.scope.close();
    await s.fixture.close();
  }
});

test('real client detects old allocating-endpoint regression before any transport admission', async () => {
  const s = realClientSetup();
  try {
    const endpoint = s.tor.getWalletSocksEndpoint();
    s.tor.getWalletSocksEndpoint = () => Object.freeze({ signal: endpoint.signal });
    await expect(s.client.request('eth_getLogs', [], Array.isArray)).rejects.toMatchObject({
      code: 'PRIVACY_REQUEST_ABORTED',
    });
    expect(s.calls).toEqual([]);
    expect(s.fixture.snapshot().creates).toBe(0);
  } finally {
    s.scope.close();
    await s.fixture.close();
  }
});

test('preloaded real transport refuses installation before factory replacement or construction', () => {
  jest.resetModules();
  jest.dontMock(W + 'networks/wallet-tor-transport');
  jest.dontMock(W + 'networks/privacy-context');
  const transport = require(W + 'networks/wallet-tor-transport');
  expect(require.cache[require.resolve(W + 'networks/wallet-tor-transport')]).toBeDefined();
  const factory = jest.spyOn(transport, 'createWalletTorTransport');
  try {
    const { install } = require('./railgun-public-cold-chain');
    expect(() =>
      install({ chain: {}, bytecodes: '/not-opened', phase: 'restore', mode: 'acknowledged' })
    ).toThrow('Install cold transport before consumers');
    expect(transport.createWalletTorTransport).toBe(factory);
    expect(factory).not.toHaveBeenCalled();
    expect(() => require('./railgun-native-assertions').assertEmpty()).toThrow();
  } finally {
    factory.mockRestore();
  }
});

test.each(['lowercase', 'checksummed'])(
  'real transaction network retains %s owner address on nonce/code/balance wire',
  async (form) => {
    const owner = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
    const checksum = require('ethers').getAddress(owner);
    expect(checksum).not.toBe(owner);
    const address = form === 'checksummed' ? checksum : owner;
    const s = realClientSetup({ publicOwner: owner });
    try {
      const network = require(
        W + 'wallet/private-transaction-network'
      ).getPrivateTransactionNetwork(s.handle);
      network.assertSigner(address);
      for (const [method, expected] of [
        ['eth_getTransactionCount', '0x0'],
        ['eth_getCode', '0x'],
        ['eth_getBalance', '0xde0b6b3a7640000'],
      ]) {
        const response = await network.request(11155111, method, [address, 'pending']);
        expect(response.result).toBe(expected);
        expect(s.calls.at(-1).params).toEqual([address, 'pending']);
      }
      expect(s.calls.map((call) => call.method)).toEqual([
        'eth_chainId',
        'eth_getTransactionCount',
        'eth_getCode',
        'eth_getBalance',
      ]);
      const activity = s.fixture.snapshot();
      expect(activity.attempted.transaction).toEqual({
        eth_chainId: 1,
        eth_getTransactionCount: 1,
        eth_getCode: 1,
        eth_getBalance: 1,
      });
      expect(activity.validated.transaction).toEqual(activity.attempted.transaction);
      expect(activity.unexpected).toBe(0);
      expect(activity.sends).toBe(0);
      require('./railgun-native-assertions').assertEmpty();
    } finally {
      s.scope.close();
      await s.fixture.close();
    }
  }
);

test.each([
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb9226',
  '0xg39fd6e51aad88f6f4ce6ab8827279cfffb92266',
])('real RPC route rejects a different or malformed nonce owner %s', async (address) => {
  const s = realClientSetup({ publicOwner: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' });
  try {
    await expect(
      s.client.request('eth_getTransactionCount', [address, 'pending'], (value) => value === '0x0')
    ).rejects.toThrow();
    const activity = s.fixture.snapshot();
    expect(activity.attempted.transaction).toEqual({ eth_chainId: 1, eth_getTransactionCount: 1 });
    expect(activity.validated.transaction).toEqual({ eth_chainId: 1 });
    expect(activity.unexpected).toBe(1);
    expect(activity.sends).toBe(0);
    expect(() => require('./railgun-native-assertions').assertEmpty()).toThrow();
  } finally {
    s.scope.close();
    await s.fixture.close();
  }
});
