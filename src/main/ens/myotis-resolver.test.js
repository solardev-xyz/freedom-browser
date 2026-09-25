const { ethers } = require('ethers');
const UR = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
const mockCall = jest.fn();
const mockEpoch = jest.fn(() => 0);
jest.mock('../myotis/myotis-manager', () => ({
  isReady: () => true,
  getAvailabilityEpoch: () => mockEpoch(),
  ethCall: (...args) => mockCall(...args),
}));
jest.mock('../ens-resolver', () => {
  const { ethers } = require('ethers');
  const address = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
  const abi = [
    'function resolve(bytes,bytes) view returns(bytes,address)',
    'function reverse(bytes,uint256) view returns(string,address,address)',
  ];
  return {
    universalResolverCall: async (provider, name, data) => {
      const [resolvedData] = await new ethers.Contract(address, abi, provider).resolve(
        ethers.dnsEncode(name),
        data,
        { enableCcipRead: true }
      );
      return { resolvedData };
    },
    universalResolverReverse: async (provider, addressBytes, _overrides, coinType) => {
      const [name] = await new ethers.Contract(address, abi, provider).reverse(
        addressBytes,
        coinType,
        { enableCcipRead: true }
      );
      return { name };
    },
    isResolverNotFoundError: (err) => err.data?.startsWith('0x77209fe8'),
  };
});
const { resolveRecord } = require('./myotis-resolver');
const abi = ethers.AbiCoder.defaultAbiCoder();
const address = '0x2222222222222222222222222222222222222222';
const offchain = new ethers.Interface([
  'error OffchainLookup(address sender,string[] urls,bytes callData,bytes4 callbackFunction,bytes extraData)',
]);
const gateway = jest.fn();
const originalFetch = global.fetch;
function offchainResult(sender = UR) {
  return {
    status: 'revert',
    dataHex: offchain.encodeErrorResult('OffchainLookup', [
      sender,
      ['https://ccip.example/{data}'],
      '0xbeef',
      '0x12345678',
      '0xdead',
    ]),
  };
}
function addressResult(multicoin = false) {
  return {
    status: 'ok',
    resultHex: abi.encode(
      ['bytes', 'address'],
      [abi.encode([multicoin ? 'bytes' : 'address'], [address]), UR]
    ),
  };
}
beforeEach(() => {
  mockCall.mockReset();
  mockEpoch.mockReset().mockReturnValue(0);
  gateway
    .mockReset()
    .mockImplementation(async () => new Response(JSON.stringify({ data: '0xcafe' })));
  global.fetch = gateway;
});
afterEach(() => {
  global.fetch = originalFetch;
});

test('calls the canonical Universal Resolver through the verified EVM, including chain-specific calldata', async () => {
  mockCall.mockResolvedValue(addressResult(true));
  expect(
    await resolveRecord({ method: 'addr', name: 'gregskril.com', coinType: 2147492101n })
  ).toMatchObject({
    status: 'ok',
    addressHex: address,
    verified: false,
    blockNumber: null,
  });
  const request = mockCall.mock.calls[0][0];
  expect(request.to.toLowerCase()).toBe(UR.toLowerCase());
  const [, data] = abi.decode(['bytes', 'bytes'], '0x' + request.data.slice(10));
  expect(data.slice(0, 10)).toBe('0xf1cb7e06');
  expect(BigInt('0x' + data.slice(74))).toBe(2147492101n);
});

test('handles multiple CCIP rounds and verifies gateway data with EVM callbacks', async () => {
  mockCall
    .mockResolvedValueOnce(offchainResult())
    .mockResolvedValueOnce(offchainResult())
    .mockResolvedValue(addressResult());
  expect((await resolveRecord({ method: 'addr', name: 'test.offchaindemo.eth' })).addressHex).toBe(
    address
  );
  expect(gateway).toHaveBeenCalledTimes(2);
  expect(mockCall).toHaveBeenCalledTimes(3);
  expect(mockCall.mock.calls[1][0].data).toBe(
    '0x12345678' + abi.encode(['bytes', 'bytes'], ['0xcafe', '0xdead']).slice(2)
  );
});

test('rejects a forged CCIP sender without fetching a gateway', async () => {
  mockCall.mockResolvedValue(offchainResult(address));
  await expect(resolveRecord({ method: 'addr', name: 'test.eth' })).rejects.toThrow();
  expect(gateway).not.toHaveBeenCalled();
});

test('bounds recursive CCIP lookups', async () => {
  mockCall.mockResolvedValue(offchainResult());
  await expect(resolveRecord({ method: 'addr', name: 'test.eth' })).rejects.toThrow();
  expect(gateway.mock.calls.length).toBeLessThanOrEqual(10);
});

test('does not accept a response across a node lifecycle change', async () => {
  mockCall.mockImplementation(async () => {
    mockEpoch.mockReturnValue(1);
    return addressResult();
  });
  await expect(resolveRecord({ method: 'addr', name: 'test.eth' })).rejects.toThrow(
    'availability changed'
  );
});

test('propagates unavailability and malformed responses instead of treating them as absent records', async () => {
  for (const result of [{ status: 'unavailable' }, { status: 'ok', resultHex: 'invalid' }]) {
    mockCall.mockResolvedValue(result);
    await expect(resolveRecord({ method: 'addr', name: 'test.eth' })).rejects.toThrow();
  }
});

test('requests the chain-specific primary name via UR.reverse', async () => {
  mockCall.mockResolvedValue({
    status: 'ok',
    resultHex: abi.encode(['string', 'address', 'address'], ['base.eth', UR, UR]),
  });
  expect(
    (await resolveRecord({ method: 'reverse', addressHex: address, coinType: 2147492101n })).name
  ).toBe('base.eth');
  const [, coinType] = abi.decode(
    ['bytes', 'uint256'],
    '0x' + mockCall.mock.calls[0][0].data.slice(10)
  );
  expect(coinType).toBe(2147492101n);
});

test('uses POST gateways and advances past invalid responses', async () => {
  const dataHex = offchain.encodeErrorResult('OffchainLookup', [
    UR,
    ['https://bad.example/query', 'https://good.example/query'],
    '0xbeef',
    '0x12345678',
    '0xdead',
  ]);
  mockCall.mockResolvedValueOnce({ status: 'revert', dataHex }).mockResolvedValue(addressResult());
  gateway.mockImplementationOnce(async () => new Response('{"data":"0xodd"}'));
  expect((await resolveRecord({ method: 'addr', name: 'test.eth' })).addressHex).toBe(address);
  expect(gateway.mock.calls[1][1]).toMatchObject({
    method: 'POST',
    body: JSON.stringify({ sender: UR.toLowerCase(), data: '0xbeef' }),
  });
});

test('rejects oversized gateway responses before executing a callback', async () => {
  mockCall.mockResolvedValue(offchainResult());
  gateway.mockImplementation(
    async () => new Response('large', { headers: { 'content-length': String(5 * 1024 * 1024) } })
  );
  await expect(resolveRecord({ method: 'addr', name: 'test.eth' })).rejects.toThrow();
  expect(mockCall).toHaveBeenCalledTimes(1);
});
