const { createVaughanBackend, toEip1193Tx } = require('./signer');

const mockRpcRequest = jest.fn();

jest.mock('./transport', () => ({
  rpcRequest: (...args) => mockRpcRequest(...args),
}));

describe('createVaughanBackend', () => {
  const record = {
    index: 1000001,
    name: 'Vaughan 1',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    type: 'vaughan',
  };

  beforeEach(() => {
    mockRpcRequest.mockReset();
  });

  test('getAddress verifies the connected account matches the record', async () => {
    mockRpcRequest.mockResolvedValueOnce([record.address]);
    const backend = createVaughanBackend(record);
    await expect(backend.getAddress()).resolves.toBe(record.address);
    expect(mockRpcRequest).toHaveBeenCalledWith('eth_accounts', []);
  });

  test('signMessage requests personal_sign with normalized hex when input is bytes', async () => {
    mockRpcRequest
      .mockResolvedValueOnce([record.address]) // eth_accounts
      .mockResolvedValueOnce('0xsig'); // personal_sign
    const backend = createVaughanBackend(record);
    await expect(backend.signMessage(Buffer.from('Hello', 'utf8'))).resolves.toBe('0xsig');
    expect(mockRpcRequest).toHaveBeenNthCalledWith(1, 'eth_accounts', []);
    expect(mockRpcRequest).toHaveBeenNthCalledWith(
      2,
      'personal_sign',
      ['0x48656c6c6f', record.address],
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
  });

  test('signTransaction maps ethers fields and calls vaughan_signTransaction', async () => {
    mockRpcRequest.mockResolvedValueOnce([record.address]).mockResolvedValueOnce('0xsignedtx');
    const backend = createVaughanBackend(record);
    const raw = await backend.signTransaction({
      to: '0x0000000000000000000000000000000000000001',
      value: 1n,
      gasLimit: 21000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      nonce: 7,
      chainId: 943,
      data: '0x',
    });
    expect(raw).toBe('0xsignedtx');
    expect(mockRpcRequest).toHaveBeenNthCalledWith(
      2,
      'vaughan_signTransaction',
      [
        {
          from: record.address,
          to: '0x0000000000000000000000000000000000000001',
          data: '0x',
          value: '0x1',
          gas: '0x5208',
          maxFeePerGas: '0x2',
          maxPriorityFeePerGas: '0x1',
          nonce: '0x7',
          chainId: '0x3af',
        },
      ],
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
  });

  test('signTypedData forwards eth_signTypedData_v4 with full payload', async () => {
    const typedData = {
      domain: { name: 'Test', version: '1', chainId: 1 },
      types: { EIP712Domain: [], Mail: [{ name: 'contents', type: 'string' }] },
      primaryType: 'Mail',
      message: { contents: 'hi' },
    };
    mockRpcRequest.mockResolvedValueOnce([record.address]).mockResolvedValueOnce('0x712sig');
    const backend = createVaughanBackend(record);
    await expect(backend.signTypedData(typedData)).resolves.toBe('0x712sig');
    expect(mockRpcRequest).toHaveBeenNthCalledWith(
      2,
      'eth_signTypedData_v4',
      [record.address, typedData],
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
  });

  test('rejects when provider account does not match record address', async () => {
    mockRpcRequest.mockResolvedValueOnce(['0x0000000000000000000000000000000000000000']);
    const backend = createVaughanBackend(record);
    await expect(backend.signMessage('hello')).rejects.toMatchObject({
      code: 'VAUGHAN_UNAUTHORIZED',
    });
  });

  test('mismatch message points at account switching, not origin rejection', async () => {
    mockRpcRequest.mockResolvedValueOnce(['0x0000000000000000000000000000000000000000']);
    const backend = createVaughanBackend(record);
    await expect(backend.getAddress()).rejects.toMatchObject({
      code: 'VAUGHAN_UNAUTHORIZED',
      message: expect.stringContaining('active account differs'),
    });
  });

  test('empty eth_accounts maps to NOT_CONNECTED (locked or grant expired)', async () => {
    mockRpcRequest.mockResolvedValueOnce([]);
    const backend = createVaughanBackend(record);
    await expect(backend.getAddress()).rejects.toMatchObject({
      code: 'VAUGHAN_NOT_CONNECTED',
      message: expect.stringContaining('locked or this site was disconnected'),
    });
  });
});

describe('mapVaughanError', () => {
  const { mapVaughanError } = require('./errors');

  test('keeps the server detail for EIP-1193 errors', () => {
    const err = new Error('wallet is locked; unlock it first');
    err.eip1193Code = 4100;
    const mapped = mapVaughanError(err);
    expect(mapped.code).toBe('VAUGHAN_UNAUTHORIZED');
    expect(mapped.message).toBe('wallet is locked; unlock it first');
  });

  test('falls back to the generic message when the server sent none', () => {
    const err = new Error('');
    err.eip1193Code = 4100;
    const mapped = mapVaughanError(err);
    expect(mapped.code).toBe('VAUGHAN_UNAUTHORIZED');
    expect(mapped.message).toBe('Vaughan rejected this account or origin.');
  });
});

describe('toEip1193Tx', () => {
  test('omits null to (contract creation) and undefined quantities', () => {
    expect(
      toEip1193Tx(
        {
          to: null,
          data: '0x60806040',
          value: 0n,
        },
        '0xabc'
      )
    ).toEqual({
      from: '0xabc',
      data: '0x60806040',
      value: '0x0',
    });
  });
});
