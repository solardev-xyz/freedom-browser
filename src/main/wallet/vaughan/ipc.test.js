const { registerVaughanIpc } = require('./ipc');
const { SIGN_TIMEOUT_MS } = require('./signer');

const mockRpcRequest = jest.fn();
const mockHandlers = new Map();

jest.mock('./transport', () => ({
  rpcRequest: (...args) => mockRpcRequest(...args),
}));

jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, fn) => {
      mockHandlers.set(channel, fn);
    },
  },
}));

describe('registerVaughanIpc', () => {
  beforeEach(() => {
    mockHandlers.clear();
    mockRpcRequest.mockReset();
    registerVaughanIpc();
  });

  test('vaughan:get-accounts returns eth_requestAccounts results', async () => {
    mockRpcRequest.mockResolvedValueOnce(['0xAbc']);
    const handler = mockHandlers.get('vaughan:get-accounts');
    await expect(handler()).resolves.toEqual({ success: true, accounts: ['0xAbc'] });
    expect(mockRpcRequest).toHaveBeenCalledWith('eth_requestAccounts', [], { timeoutMs: SIGN_TIMEOUT_MS });
  });

  test('falls back to eth_accounts when eth_requestAccounts is unsupported', async () => {
    const unsupported = Object.assign(new Error('unsupported'), { eip1193Code: 4200 });
    mockRpcRequest.mockRejectedValueOnce(unsupported).mockResolvedValueOnce(['0xDef']);
    const handler = mockHandlers.get('vaughan:get-accounts');
    await expect(handler()).resolves.toEqual({ success: true, accounts: ['0xDef'] });
    expect(mockRpcRequest).toHaveBeenNthCalledWith(1, 'eth_requestAccounts', [], { timeoutMs: SIGN_TIMEOUT_MS });
    expect(mockRpcRequest).toHaveBeenNthCalledWith(2, 'eth_accounts', []);
  });

  test('maps transport failures to VAUGHAN_* codes', async () => {
    mockRpcRequest.mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    const handler = mockHandlers.get('vaughan:get-accounts');
    await expect(handler()).resolves.toMatchObject({
      success: false,
      code: 'VAUGHAN_DISCONNECTED',
    });
  });
});
