jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => mockEnabled }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('./network-registry', () => ({
  getNetwork: () => ({}),
  getEndpoints: () => ['https://rpc.example'],
  getEndpointSources: () => [{ keyed: false, coverage: { 11155111: 'https://rpc.example' } }],
}));
jest.mock('./wallet-tor-transport', () => ({
  createWalletTorTransport: () => ({ request: mockRequest }),
}));
const mockRequest = jest.fn();
let mockEndpoint, mockEnabled;
const { createPrivacyScope, getPrivacyContext } = require('./privacy-context');
const { createPrivateRpc } = require('./private-rpc');
const { createKohakuProvider } = require('./kohaku-provider');
const target = `0x${'1'.repeat(40)}`;
const event = `0x${'a'.repeat(64)}`;
const txHash = `0x${'b'.repeat(64)}`;
const blockHash = `0x${'c'.repeat(64)}`;
const subject = {
  kind: 'private-account',
  principal: 'account-fixture',
  protocol: 'ppv2-fixture',
  deployment: 'sepolia-fixture',
  chainId: 11155111,
  role: 'protocol-rpc',
};
const filter = () => ({ address: target, topics: [[event]], fromBlock: '0x1', toBlock: '0x2' });
let scope, handle, provider, contracts, results, requests, hook;
beforeEach(() => {
  mockEnabled = true;
  mockRequest.mockClear();
  mockEndpoint = { signal: new AbortController().signal };
  scope = createPrivacyScope({
    profileId: 'provider-fixture',
    signal: new AbortController().signal,
  });
  handle = scope.getContext(subject);
  contracts = [{ address: target, selectors: ['0x12345678'], eventTopics: [event] }];
  provider = createKohakuProvider({ handle, contracts });
  results = {
    eth_chainId: '0xaa36a7',
    eth_blockNumber: '0x2',
    eth_call: '0x1234',
    eth_getCode: '0x6000',
    eth_getLogs: [
      {
        address: target,
        topics: [event],
        data: '0x',
        blockNumber: '0x1',
        blockHash,
        transactionHash: txHash,
        logIndex: '0x0',
        removed: false,
      },
    ],
  };
  requests = [];
  hook = null;
  mockRequest.mockImplementation(async (context, _url, options) => {
    expect(context).toBe(handle);
    const call = JSON.parse(options.body);
    requests.push(call);
    if (hook) await hook(call);
    return {
      status: 200,
      body: Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', id: call.id, result: results[call.method] })
      ),
    };
  });
});
afterEach(() => scope.close());

test('known contract deployment floors skip ancient windows and retain the inclusive boundary', async () => {
  const floors = [{ address: target, fromBlock: 2 }];
  provider = createKohakuProvider({ handle, contracts, logFloors: floors });
  floors[0].fromBlock = 100; // Snapshot the main grant before SDK work.
  const logs = (fromBlock, toBlock) =>
    provider.request({ method: 'eth_getLogs', params: [{ ...filter(), fromBlock, toBlock }] });
  expect(await logs('0x0', '0x1')).toEqual([]);
  expect(mockRequest).not.toHaveBeenCalled();
  results.eth_getLogs[0].blockNumber = '0x2';
  expect(await logs('0x1', '0x2')).toEqual(results.eth_getLogs);
  expect(requests.at(-1).params[0]).toMatchObject({ fromBlock: '0x2', toBlock: '0x2' });
  await logs('0x2', '0x2');
  results.eth_getLogs[0].blockNumber = '0x1';
  await expect(logs('0x1', '0x2')).rejects.toMatchObject({ code: 'PRIVATE_RPC_INVALID' });
  await expect(logs('0x0', '0x1388')).rejects.toMatchObject({ code: 'PRIVATE_SDK_RPC_REFUSED' });
  scope.close();
  await expect(logs('0x0', '0x1')).rejects.toThrow();
});

test('a pool floor does not truncate history of another granted contract', async () => {
  const pool = `0x${'2'.repeat(40)}`;
  provider = createKohakuProvider({
    handle,
    contracts: [...contracts, { ...contracts[0], address: pool }],
    logFloors: [{ address: pool, fromBlock: 100 }],
  });
  expect(await provider.request({ method: 'eth_getLogs', params: [filter()] })).toEqual(
    results.eth_getLogs
  );
  expect(requests.at(-1).params[0].fromBlock).toBe('0x1');
});

test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2'])(
  'refuses invalid deployment floor %s',
  (fromBlock) => {
    expect(() =>
      createKohakuProvider({ handle, contracts, logFloors: [{ address: target, fromBlock }] })
    ).toThrow();
  }
);

test('owner contract reads use the public-address connection while pool reads retain their private context', async () => {
  const owner = scope.getContext({
    kind: 'public-address',
    principal: `0x${'9'.repeat(40)}`,
    chainId: 11155111,
    role: 'transaction-rpc',
  });
  const pool = `0x${'2'.repeat(40)}`;
  const seen = [];
  mockRequest.mockImplementation(async (context, _url, options) => {
    const call = JSON.parse(options.body);
    seen.push({ context, call });
    return {
      status: 200,
      body: Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', id: call.id, result: results[call.method] })
      ),
    };
  });
  provider = createKohakuProvider({
    handle,
    contracts: [...contracts, { ...contracts[0], address: pool }],
    publicReadHandle: owner,
    publicContracts: [target],
  });
  await provider.call({ to: target, data: '0x12345678' });
  await provider.getCode(target);
  expect(seen.every(({ context }) => context === owner)).toBe(true);
  seen.length = 0;
  await provider._internal.request({
    method: 'eth_getLogs',
    params: [{ ...filter(), toBlock: 'latest' }],
  });
  expect(seen.every(({ context }) => context === handle)).toBe(true);
  await provider.call({ to: pool, data: '0x12345678' });
  expect(seen.at(-1).context).toBe(handle);
  const before = seen.length;
  await expect(
    provider.call({ to: pool, data: `0x12345678${'9'.repeat(40).padStart(64, '0')}` })
  ).rejects.toThrow();
  expect(seen).toHaveLength(before);
  expect(getPrivacyContext(owner).isolationToken).not.toBe(
    getPrivacyContext(handle).isolationToken
  );
  const foreign = createPrivacyScope({ profileId: 'other', signal: new AbortController().signal });
  expect(() =>
    createKohakuProvider({
      handle,
      contracts,
      publicReadHandle: foreign.getContext({
        kind: 'public-address',
        principal: target,
        chainId: 11155111,
        role: 'transaction-rpc',
      }),
      publicContracts: [target],
    })
  ).toThrow();
  foreign.close();
});

test('an explicit new read may recover from a failed chain check without retrying the failed request', async () => {
  let failed = false;
  hook = async (call) => {
    if (!failed && call.method === 'eth_chainId') {
      failed = true;
      throw new Error('Temporary failure');
    }
  };
  await expect(provider.getBlockNumber()).rejects.toThrow();
  expect(requests.map((call) => call.method)).toEqual(['eth_chainId']);
  expect(await provider.getBlockNumber()).toBe(2n);
  expect(requests.map((call) => call.method)).toEqual([
    'eth_chainId',
    'eth_chainId',
    'eth_blockNumber',
  ]);
});

test('read calls and full raw log metadata use the private context, with no verification upgrade', async () => {
  expect(await provider.getChainId()).toBe(11155111n);
  expect(await provider.getBlockNumber()).toBe(2n);
  expect(await provider.getCode(target)).toBe('0x6000');
  expect(await provider.call({ to: target, data: '0x12345678' })).toBe('0x1234');
  expect(await provider.request({ method: 'eth_getLogs', params: [filter()] })).toEqual(
    results.eth_getLogs
  );
  expect(provider).toMatchObject({ verified: false, trust: { level: 'unverified' } });
  expect(requests.map((call) => call.method)).toEqual([
    'eth_chainId',
    'eth_blockNumber',
    'eth_getCode',
    'eth_call',
    'eth_getLogs',
  ]);
  expect(provider._internal.request).toBe(provider.request);
});

test('signing, broadcast, receipts, balances and nonce queries are outside this read capability', async () => {
  for (const method of [
    'eth_sendRawTransaction',
    'eth_sendTransaction',
    'personal_sign',
    'eth_getTransactionReceipt',
    'eth_getBalance',
    'eth_getTransactionCount',
    'eth_getStorageAt',
  ]) {
    await expect(provider.request({ method, params: [] })).rejects.toMatchObject({
      code: 'PRIVATE_SDK_RPC_REFUSED',
    });
  }
  await expect(provider.waitForTransaction(txHash)).rejects.toMatchObject({
    code: 'PRIVATE_SDK_RPC_REFUSED',
  });
  expect(mockRequest).not.toHaveBeenCalled();
});

test('contract, selector, event, indexed-account filters and broad scans are refused before log egress', async () => {
  const invalidFilters = [
    { ...filter(), address: `0x${'2'.repeat(40)}` },
    { ...filter(), topics: [] },
    { ...filter(), topics: [null] },
    { ...filter(), topics: [[txHash]] },
    { ...filter(), topics: [[event], txHash] },
    { ...filter(), fromBlock: '0x0', toBlock: '0x1388' },
    { ...filter(), fromBlock: '0x3' },
    { ...filter(), blockHash },
    { ...filter(), address: [target] },
  ];
  for (const query of invalidFilters)
    await expect(
      provider.request({ method: 'eth_getLogs', params: [query] })
    ).rejects.toMatchObject({ code: 'PRIVATE_SDK_RPC_REFUSED' });
  for (const call of [
    { to: target, data: '0x11111111' },
    { to: target, data: '0x12345678', from: target },
    { to: txHash, data: '0x12345678' },
  ]) {
    await expect(provider.call(call)).rejects.toMatchObject({ code: 'PRIVATE_SDK_RPC_REFUSED' });
  }
  expect(mockRequest).not.toHaveBeenCalled();
});

test('latest is converted to a concrete bounded range; caller mutation cannot alter the sent filter', async () => {
  const query = { ...filter(), toBlock: 'latest' };
  hook = async (call) => {
    if (call.method === 'eth_chainId') {
      query.address = `0x${'2'.repeat(40)}`;
      query.topics[0][0] = txHash;
      query.fromBlock = '0x0';
    }
  };
  await provider.request({ method: 'eth_getLogs', params: [query] });
  expect(requests.at(-1)).toMatchObject({ method: 'eth_getLogs', params: [filter()] });
  contracts[0].selectors.push('0x11111111');
  await expect(provider.call({ to: target, data: '0x11111111' })).rejects.toMatchObject({
    code: 'PRIVATE_SDK_RPC_REFUSED',
  });
});

test.each(['address', 'topic', 'range', 'removed', 'hash', 'size'])(
  'invalid log response %s never reaches the SDK',
  async (change) => {
    const log = results.eth_getLogs[0];
    if (change === 'address') log.address = `0x${'2'.repeat(40)}`;
    if (change === 'topic') log.topics = [txHash];
    if (change === 'range') log.blockNumber = '0x3';
    if (change === 'removed') log.removed = true;
    if (change === 'hash') log.transactionHash = '0x1';
    if (change === 'size') results.eth_getLogs = Array(2049).fill(log);
    await expect(
      provider.request({ method: 'eth_getLogs', params: [filter()] })
    ).rejects.toMatchObject({ code: 'PRIVATE_RPC_INVALID' });
  }
);

test('scope, gate, chain and transport lifetime checks remain enforced', async () => {
  expect(() => createPrivateRpc(handle, 'balance-rpc')).toThrow(
    expect.objectContaining({ code: 'UNSUPPORTED_PRIVACY_REQUIREMENTS' })
  );
  const publicHandle = scope.getContext({
    kind: 'public-address',
    principal: target,
    chainId: 11155111,
    role: 'protocol-rpc',
  });
  expect(() => createKohakuProvider({ handle: publicHandle, contracts })).toThrow(
    expect.objectContaining({ code: 'PRIVATE_SDK_UNAVAILABLE' })
  );
  mockEnabled = false;
  expect(() => createKohakuProvider({ handle, contracts })).toThrow(
    expect.objectContaining({ code: 'PRIVACY_TRANSPORT_UNAVAILABLE' })
  );
  mockEnabled = true;
  results.eth_chainId = '0x1';
  await expect(provider.getBlockNumber()).rejects.toMatchObject({ code: 'PRIVATE_CHAIN_MISMATCH' });
  expect(requests.map((call) => call.method)).toEqual(['eth_chainId']);
  provider = createKohakuProvider({ handle, contracts });
  mockEndpoint = { signal: new AbortController().signal };
  await expect(provider.getBlockNumber()).rejects.toMatchObject({
    code: 'PRIVACY_REQUEST_ABORTED',
  });
});

test('lock or caller cancellation discards a response that arrives after revocation', async () => {
  const controller = new AbortController();
  provider = createKohakuProvider({ handle, contracts, signal: controller.signal });
  hook = async () => controller.abort();
  await expect(provider.getBlockNumber()).rejects.toMatchObject({
    code: 'PRIVACY_REQUEST_ABORTED',
  });
  provider = createKohakuProvider({ handle, contracts });
  hook = async () => scope.close();
  await expect(provider.getBlockNumber()).rejects.toMatchObject({
    code: 'PRIVACY_CONTEXT_REVOKED',
  });
});

test('only the finalized public block summary is granted, with no trust upgrade or receipt access', async () => {
  results.eth_getBlockByNumber = { number: '0x1', hash: blockHash, transactions: [txHash] };
  expect(
    await provider.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] })
  ).toEqual({ number: '0x1', hash: blockHash });
  expect(provider.verified).toBe(false);
  for (const params of [
    ['latest', false],
    ['0x1', false],
    ['finalized', true],
    ['finalized'],
    ['finalized', false, target],
  ]) {
    await expect(
      provider.request({ method: 'eth_getBlockByNumber', params })
    ).rejects.toMatchObject({ code: 'PRIVATE_SDK_RPC_REFUSED' });
  }
  expect(requests.filter((call) => call.method === 'eth_getBlockByNumber')).toHaveLength(1);
  results.eth_getBlockByNumber = null;
  expect(
    await provider.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] })
  ).toBeNull();
  results.eth_getBlockByNumber = { number: '0x1', hash: 'secret server failure' };
  await expect(
    provider.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] })
  ).rejects.toMatchObject({ code: 'PRIVATE_RPC_INVALID' });
});

const rpcFixture = process.env.FREEDOM_PP_V2_RPC_FIXTURE;
const statusFixture = process.env.FREEDOM_PP_V2_STATUS_FIXTURE;
(rpcFixture && statusFixture ? describe : describe.skip)(
  'pinned Kohaku compatibility patch',
  () => {
    test('actual adapter preserves finality, refuses malformed evidence and never downgrades errors', async () => {
      const { KohakuRpcInteractor } = require(rpcFixture);
      const adapter = new KohakuRpcInteractor(provider);
      results.eth_getBlockByNumber = { number: '0x1', hash: blockHash };
      expect(await adapter.getFinalizedBlockNumber()).toEqual({
        status: 'finalized',
        blockNumber: '0x1',
      });
      for (const value of [
        null,
        {},
        { number: '0x1', hash: '0x0' },
        { number: '-1', hash: blockHash },
      ]) {
        results.eth_getBlockByNumber = value;
        expect(await adapter.getFinalizedBlockNumber()).toEqual({
          status: 'unavailable',
          reason: 'Finalized block unavailable',
        });
      }
      for (const code of [-32601, -32602, 'PRIVACY_REQUEST_ABORTED', 'PRIVATE_SDK_RPC_REFUSED']) {
        const failed = new KohakuRpcInteractor({
          request: async () => {
            throw Object.assign(new Error('sensitive endpoint response'), { code });
          },
        });
        expect(await failed.getFinalizedBlockNumber()).toEqual({
          status: 'unavailable',
          reason: 'Finalized block unavailable',
        });
      }
      scope.close();
      expect((await adapter.getFinalizedBlockNumber()).status).toBe('unavailable');
    });

    test('pending exits retain value without spendability or invented ASP approval; reorg views reverse', () => {
      const status = require(statusFixture);
      expect(status.statusToReport('EXIT_PENDING')).toBe('unspendable');
      expect(status.isExcluded('EXIT_PENDING')).toBe(false);
      expect(status.isSpendable('EXIT_PENDING')).toBe(false);
      expect(status.statusLabel('EXIT_PENDING')).toBe('exit_pending');
      expect(status.labelStateFor('EXIT_PENDING')).toBe('unknown');
      expect(status.labelStateFor('EXITED')).toBe('unknown');
      expect(
        ['ACTIVE', 'EXIT_PENDING', 'ACTIVE', 'EXIT_PENDING', 'EXITED'].map(status.statusToReport)
      ).toEqual(['spendable', 'unspendable', 'spendable', 'unspendable', 'excluded']);
      expect(status.labelStateFor('REJECTED')).toBe('revoked');
      expect(() => status.statusToReport('FUTURE_UNKNOWN_STATE')).toThrow();
    });
  }
);

test('scan progress exposes counts only, and a failing observer cannot break reads', async () => {
  const progress = jest.fn(async () => {
    throw new Error('observer failed');
  });
  provider = createKohakuProvider({ handle, contracts, onScan: progress });
  await provider._internal.request({ method: 'eth_getLogs', params: [filter()] });
  expect(progress).toHaveBeenCalledWith({
    completedWindows: 1,
    scannedBlocks: Number(BigInt(filter().toBlock) - BigInt(filter().fromBlock) + 1n),
  });
  expect(Object.isFrozen(progress.mock.calls[0][0])).toBe(true);
});

test('bounded scans require audited floors and check the work grant before log transport', async () => {
  expect(() => createKohakuProvider({ handle, contracts, beforeScan: () => {} })).toThrow();
  const gate = jest.fn(() => {
    throw new Error('work limit');
  });
  provider = createKohakuProvider({
    handle,
    contracts,
    logFloors: [{ address: target, fromBlock: 0 }],
    beforeScan: gate,
  });
  const before = mockRequest.mock.calls.length;
  await expect(
    provider._internal.request({ method: 'eth_getLogs', params: [filter()] })
  ).rejects.toThrow('work limit');
  expect(gate).toHaveBeenCalledTimes(1);
  expect(
    mockRequest.mock.calls
      .slice(before)
      .some(([, , options]) => JSON.parse(options.body).method === 'eth_getLogs')
  ).toBe(false);
});

test('checkpoint replay preserves provider grants, work accounting and protocol-only routing', async () => {
  let encoded = null;
  const scanCacheStorage = {
    get: async () => encoded,
    update: async (change) => {
      encoded = change(encoded);
    },
  };
  const beforeScan = jest.fn(),
    onScan = jest.fn();
  hook = (call) => {
    if (call.method === 'eth_getBlockByNumber')
      results.eth_getBlockByNumber = {
        number: call.params[0] === 'finalized' ? '0x2' : call.params[0],
        hash: blockHash,
      };
  };
  provider = createKohakuProvider({
    handle,
    contracts,
    scanCacheStorage,
    beforeScan,
    onScan,
    logFloors: [{ address: target, fromBlock: 1 }],
  });
  const first = await provider.request({ method: 'eth_getLogs', params: [filter()] });
  first[0].data = '0x11';
  const restarted = createKohakuProvider({
    handle,
    contracts,
    scanCacheStorage,
    beforeScan,
    onScan,
    logFloors: [{ address: target, fromBlock: 1 }],
  });
  expect((await restarted.request({ method: 'eth_getLogs', params: [filter()] }))[0].data).toBe(
    '0x'
  );
  expect(requests.filter((r) => r.method === 'eth_getLogs')).toHaveLength(1);
  expect(beforeScan).toHaveBeenCalledTimes(2);
  expect(onScan).toHaveBeenCalledTimes(2);
  expect(onScan.mock.calls[1][0]).toEqual({ completedWindows: 1, scannedBlocks: 2 });
  await expect(
    restarted.request({
      method: 'eth_getLogs',
      params: [{ ...filter(), topics: [[event], txHash] }],
    })
  ).rejects.toMatchObject({ code: 'PRIVATE_SDK_RPC_REFUSED' });
  const bypass = createKohakuProvider({
    handle,
    contracts,
    scanCacheStorage,
    bypassScanCache: true,
  });
  await bypass.request({ method: 'eth_getLogs', params: [filter()] });
  expect(requests.filter((r) => r.method === 'eth_getLogs')).toHaveLength(2);
});
