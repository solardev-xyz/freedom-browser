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
