jest.mock('../logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
}));

const mockSignAndSendTransaction = jest.fn();
const mockWaitForTransaction = jest.fn();
const mockGetTransactionStatus = jest.fn();
jest.mock('./transaction-service', () => ({
  signAndSendTransaction: (...args) => mockSignAndSendTransaction(...args),
  waitForTransaction: (...args) => mockWaitForTransaction(...args),
  getTransactionStatus: (...args) => mockGetTransactionStatus(...args),
}));

const mockAppend = jest.fn();
const mockMarkConfirmed = jest.fn();
const mockMarkFailed = jest.fn();
const mockRepollPending = jest.fn();
jest.mock('../payment-history', () => ({
  append: (...args) => mockAppend(...args),
  repollPending: (...args) => mockRepollPending(...args),
  markConfirmed: (...args) => mockMarkConfirmed(...args),
  markFailed: (...args) => mockMarkFailed(...args),
  KINDS: { WALLET_SEND: 'wallet-send', DAPP_SEND: 'dapp-send' },
  STATUSES: { CONFIRMED: 'confirmed', FAILED: 'failed', PENDING: 'pending' },
}));

const { signAndRecord } = require('./tx-recorder');

const fakeSigner = { getAddress: async () => '0xfrom' };

describe('tx-recorder', () => {
  beforeEach(() => {
    mockSignAndSendTransaction.mockReset().mockResolvedValue({
      hash: '0xtx',
      from: '0xfrom',
    });
    mockWaitForTransaction.mockReset().mockResolvedValue({
      status: 'confirmed',
      gasUsed: '21000',
      effectiveGasPrice: '7',
    });
    mockAppend.mockReset().mockReturnValue({ id: 123 });
    mockMarkConfirmed.mockReset();
    mockMarkFailed.mockReset();
    mockRepollPending.mockReset().mockResolvedValue({ resolved: 0, stillPending: 0, errors: 0 });
  });

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  test('records the signing account and nonce so a dropped row can resolve', async () => {
    mockSignAndSendTransaction.mockResolvedValue({ hash: '0xtx', from: '0xsigner', nonce: 7 });

    await signAndRecord({ to: '0xsafe', value: '0', chainId: 1 }, fakeSigner, {
      kind: 'safe-send',
      fromAddress: '0xsafe',
      metadata: { safeAddress: '0xsafe' },
    });

    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({
      fromAddress: '0xsafe',
      metadata: { safeAddress: '0xsafe', txFrom: '0xsigner', txNonce: 7 },
    }));
  });

  test('sweeps pending rows once its own transaction is mined (#749 re-send)', async () => {
    await signAndRecord({ to: '0xr', value: '1', chainId: 1 }, fakeSigner, { kind: 'wallet-send' });
    await settle();

    expect(mockMarkConfirmed).toHaveBeenCalledWith(123, { gasUsed: '21000', gasPrice: '7' });
    expect(mockRepollPending).toHaveBeenCalledTimes(1);
    // The status fn it sweeps with is the one that can report 'dropped'.
    await mockRepollPending.mock.calls[0][0]('0xold', 1, { from: '0xfrom', nonce: 0 });
    expect(mockGetTransactionStatus).toHaveBeenCalledWith('0xold', 1, { from: '0xfrom', nonce: 0 });
  });

  test('sweeps after a confirmation timeout too, leaving the row to the sweep', async () => {
    mockWaitForTransaction.mockRejectedValue(new Error('Timed out'));

    await signAndRecord({ to: '0xr', value: '1', chainId: 1 }, fakeSigner, { kind: 'wallet-send' });
    await settle();

    expect(mockMarkConfirmed).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockRepollPending).toHaveBeenCalledTimes(1);
  });

  test('records user-visible ERC-20 recipient and amount from context', async () => {
    const result = await signAndRecord({
      to: '0xtoken',
      value: '0',
      chainId: 8453,
    }, fakeSigner, {
      kind: 'dapp-send',
      origin: 'https://app.example',
      asset: '0xtoken',
      toAddress: '0xrecipient',
      amount: '12345',
    });

    expect(result).toMatchObject({ hash: '0xtx', recorded: true, paymentId: 123 });
    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'dapp-send',
      chainId: 8453,
      txHash: '0xtx',
      fromAddress: '0xfrom',
      toAddress: '0xrecipient',
      asset: '0xtoken',
      amount: '12345',
      origin: 'https://app.example',
    }));
  });

  test('context.fromAddress overrides the signer address (Safe txs: from = safe, executor in metadata)', async () => {
    await signAndRecord({
      to: '0xsafe',
      value: '0',
      chainId: 100,
    }, fakeSigner, {
      kind: 'safe-send',
      fromAddress: '0xsafe',
      toAddress: '0xrecipient',
      amount: '1000',
      metadata: { safeAddress: '0xsafe', executor: '0xfrom' },
    });

    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'safe-send',
      fromAddress: '0xsafe',
      toAddress: '0xrecipient',
      metadata: { safeAddress: '0xsafe', executor: '0xfrom' },
    }));
  });

  test('surfaces recorded:false when the broadcast succeeds but history append fails', async () => {
    mockAppend.mockImplementationOnce(() => {
      throw new Error('db closed');
    });

    const result = await signAndRecord({
      to: '0xrecipient',
      value: '0x2a',
      chainId: 1,
    }, fakeSigner, {
      kind: 'wallet-send',
    });

    expect(result).toMatchObject({
      hash: '0xtx',
      recorded: false,
      recordError: 'db closed',
    });
    expect(mockWaitForTransaction).not.toHaveBeenCalled();
  });
});
