'use strict';

const { DomainChain } = require('./chain');
const { ABI, ADDRESSES, parseName, ZeroAddress } = require('./contracts');

test('reads only through the injected chain-data route and rejects unknown code', async () => {
  const request = jest.fn(async method => method === 'eth_getBlockByNumber'
    ? { number: '0x100', hash: `0x${'1'.repeat(64)}`, timestamp: '0x1000' } : '0x');
  const chain = new DomainChain({ request });
  const snapshot = await chain.snapshot();
  await expect(chain.checkCode('resolver', snapshot)).rejects.toMatchObject({ code: 'DOMAIN_UNSUPPORTED' });
  expect(request).toHaveBeenLastCalledWith('eth_getCode', [ADDRESSES.resolver, '0x100']);
});
test('receipt confirmation requires its block to remain canonical', async () => {
  const request = jest.fn(async method => method === 'eth_getTransactionReceipt'
    ? { blockNumber: '0x100', blockHash: 'old-block' } : { hash: 'replacement-block' });
  expect(await new DomainChain({ request }).receipt(`0x${'1'.repeat(64)}`)).toBeNull();
});
test('a lagging latest block cannot verify state from before a mined transaction', async () => {
  const receipt = { blockNumber: '0x101', blockHash: 'mined-block' };
  const request = jest.fn(async (method, [tag]) => method === 'eth_call' ? ABI.nft.encodeFunctionResult('commitments', [4108n])
    : tag === 'latest' ? { number: '0x100', hash: 'older-block', timestamp: '0x1000' }
      : { number: '0x101', hash: 'mined-block', timestamp: '0x100c' });
  const chain = new DomainChain({ request });
  const snapshot = await chain.snapshot(receipt);
  expect(snapshot).toEqual({ tag: '0x101', hash: 'mined-block', timestamp: 4108 });
  expect(await chain.call('gwei', 'commitments', [`0x${'1'.repeat(64)}`], snapshot)).toEqual([4108n]);
  expect(request).toHaveBeenCalledWith('eth_getBlockByNumber', ['0x101', false]);
  expect(request).toHaveBeenLastCalledWith('eth_call', [expect.any(Object), '0x101']);
});
test.each([
  { number: '0x100', hash: 'older-block', timestamp: '0x1000' },
  { number: '0x101', hash: 'replacement-block', timestamp: '0x100c' },
])('an insufficient or replaced confirmation snapshot is rejected', async block => {
  const request = jest.fn(async () => block);
  await expect(new DomainChain({ request }).snapshot({ blockNumber: '0x101', blockHash: 'mined-block' }))
    .rejects.toMatchObject({ code: 'DOMAIN_CHAIN_BEHIND' });
});
test('a newer snapshot remains current instead of freezing at the receipt block', async () => {
  const request = jest.fn(async () => ({ number: '0x102', hash: 'new-block', timestamp: '0x1018' }));
  expect(await new DomainChain({ request }).snapshot({ blockNumber: '0x101', blockHash: 'mined-block' }))
    .toMatchObject({ tag: '0x102', timestamp: 4120 });
  expect(request).toHaveBeenCalledTimes(1);
});
test('ENS registrant and record manager are distinct authorities', async () => {
  const parsed = parseName('freedom.eth');
  const registrant = '0x0000000000000000000000000000000000000001';
  const manager = '0x0000000000000000000000000000000000000002';
  const request = jest.fn(async (method, params) => {
    if (method === 'eth_getBlockByNumber') return { number: '0x100', hash: 'block', timestamp: '0x1000' };
    const tx = params[0];
    const role = Object.keys(ADDRESSES).find(key => ADDRESSES[key].toLowerCase() === tx.to.toLowerCase());
    const abi = ABI[role];
    const call = abi.parseTransaction({ data: tx.data });
    const values = {
      'ensRegistry.getState': [[1n, 1000000n, ZeroAddress, BigInt(parsed.tokenId), BigInt(parsed.tokenId)]],
      'ensRegistrar.isAvailable': [false],
      'registry.owner': [manager], 'registry.resolver': [ADDRESSES.resolver],
      'base.ownerOf': [registrant], 'base.nameExpires': [1000000n], 'controller.available': [false],
      'resolver.contenthash': ['0x'], 'resolver.addr': [ZeroAddress],
    };
    return abi.encodeFunctionResult(call.name, values[`${role}.${call.name}`]);
  });
  const state = await new DomainChain({ request }).inspect(parsed);
  expect(state.owner).toBe(registrant);
  expect(state.recordOwner).toBe(manager);
  expect(state.manager).toBe(manager);
  expect(request.mock.calls.filter(([method]) => method === 'eth_call').every(([, params]) => params[1] === '0x100')).toBe(true);
});
test('network errors are not interpreted as missing tokens or available names', async () => {
  const request = jest.fn(async method => {
    if (method === 'eth_getBlockByNumber') return { number: '0x100', hash: 'block', timestamp: '0x1000' };
    throw new Error('RPC unavailable');
  });
  await expect(new DomainChain({ request }).inspect(parseName('freedom.wei'))).rejects.toThrow('RPC unavailable');
});

describe('ENSv2 ownership and resolver inspection', () => {
  function fixture(resolver = ADDRESSES.ensPublicResolver, name = 'freedom.eth') {
    const parsed = parseName(name);
    const chain = new DomainChain({ request: jest.fn(async () => '0x01') });
    chain.snapshot = jest.fn(async () => ({ tag: '0x100', hash: 'block', timestamp: 1000 }));
    chain.call = jest.fn(async (role, method) => {
      if (method === 'getState') return [{ status: 2n, expiry: 1000000n, latestOwner: ADDRESSES.usdc, tokenId: BigInt(parsed.tokenId), resource: 42n }];
      if (method === 'isAvailable') return [false];
      if (method === 'getResolver') return [resolver];
      if (method === 'verifyContract') return [ADDRESSES.ensResolverImpl];
      if (method === 'contenthash') return ['0x'];
      if (method === 'addr(bytes32)') return [ZeroAddress];
      throw new Error(`Unexpected legacy read: ${role}.${method}`);
    });
    return { chain, parsed };
  }
  test('v2 registry owner and expiry replace legacy registrar authority', async () => {
    const { chain, parsed } = fixture();
    expect(await chain.inspect(parsed)).toMatchObject({ ensVersion: 2, owner: ADDRESSES.usdc, expiry: '1000000', registryResource: '42' });
    expect(chain.call.mock.calls.some(([role]) => role === 'base' || role === 'registry')).toBe(false);
  });
  test('an explicit factory rejection permits renewal inspection without inventing empty records', async () => {
    const resolver = ADDRESSES.resolver;
    const { chain, parsed } = fixture(resolver);
    const call = chain.call.getMockImplementation();
    chain.call.mockImplementation(async (...args) => {
      if (args[1] === 'verifyContract') throw Object.assign(new Error('reverted'), { data: ABI.ensFactory.encodeErrorResult('VerificationFailed', [resolver]) });
      return call(...args);
    });
    expect(await chain.inspect(parsed)).toMatchObject({ active: true, supportedResolver: false, resolverRole: null, records: {} });
    chain.call.mockImplementation(async (...args) => {
      if (args[1] === 'verifyContract') throw new Error('RPC offline');
      return call(...args);
    });
    await expect(chain.inspect(parsed)).rejects.toThrow('RPC offline');
  });
  test('permissioned records support ENS labels longer than DNS’s 63-byte default', async () => {
    const { chain, parsed } = fixture(ADDRESSES.usdc, `${'a'.repeat(64)}.eth`);
    chain.callAt = jest.fn(async (_role, _to, _method, [name, data]) => {
      expect(name.slice(0, 4)).toBe('0x40');
      const decoded = ABI.resolver.parseTransaction({ data });
      return [ABI.resolver.encodeFunctionResult(decoded.name, [decoded.name === 'addr' ? ZeroAddress : '0x'])];
    });
    expect(await chain.inspect(parsed)).toMatchObject({ supportedResolver: true, records: { contenthash: '0x', address: ZeroAddress } });
  });
});
