const { Wallet, Transaction } = require('ethers');
const mockChainRequest = jest.fn();
const mockGetFeeQuote = jest.fn();
const mockBroadcastRawTransaction = jest.fn();
jest.mock('../networks/chain-data-router', () => ({
  request: (...args) => mockChainRequest(...args),
  getFeeQuote: (...args) => mockGetFeeQuote(...args),
  broadcastRawTransaction: (...args) => mockBroadcastRawTransaction(...args),
}));
const {
  estimateGas,
  getGasPrices,
  signAndSendTransaction,
  waitForTransaction,
} = require('./transaction-service');
jest.mock('./chains', () => ({
  getTxExplorerUrl: (chainId, hash) => `https://explorer.test/${chainId}/${hash}`,
}));

// Deterministic test key (not a real wallet)
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const testWallet = new Wallet(TEST_PRIVATE_KEY);
// A signer that signs locally with the test key — mirrors what the vault
// signer produces. Ledger signers implement the same interface.
const signer = {
  getAddress: async () => testWallet.address,
  signTransaction: (tx) => testWallet.signTransaction(tx),
};

describe('signAndSendTransaction (signer-based)', () => {
  let broadcastedRaw;
  beforeEach(() => {
    broadcastedRaw = null;
    mockChainRequest.mockReset().mockResolvedValue({ result: '0x5', source: 'direct' });
    mockGetFeeQuote.mockReset();
    mockBroadcastRawTransaction.mockReset().mockImplementation(async (_chainId, raw) => {
      broadcastedRaw = raw;
      return { result: Transaction.from(raw).hash, source: 'direct' };
    });
  });

  it('fetches the nonce for the signer address, signs, and broadcasts', async () => {
    const result = await signAndSendTransaction(
      {
        to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        value: '1000',
        gasLimit: '21000',
        maxFeePerGas: '2000000000',
        maxPriorityFeePerGas: '1000000000',
        chainId: 8453,
      },
      signer,
    );

    const parsed = Transaction.from(broadcastedRaw);
    expect(parsed.from).toBe(testWallet.address);
    expect(parsed.nonce).toBe(5);
    expect(parsed.chainId).toBe(8453n);

    expect(result).toMatchObject({
      hash: parsed.hash,
      nonce: 5,
      from: testWallet.address,
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: '1000',
      chainId: 8453,
      explorerUrl: `https://explorer.test/8453/${parsed.hash}`,
    });
  });

  it('populates EIP-1559 fees from the network when the caller supplies none', async () => {
    mockGetFeeQuote.mockResolvedValue({
      type: 'eip1559',
      maxFeePerGas: '5000000000',
      maxPriorityFeePerGas: '1000000000',
      source: 'myotis',
    });

    await signAndSendTransaction(
      {
        to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        value: '1000',
        gasLimit: '21000',
        chainId: 8453,
      },
      signer,
    );

    const parsed = Transaction.from(broadcastedRaw);
    expect(parsed.type).toBe(2);
    expect(parsed.maxFeePerGas).toBe(5_000_000_000n);
    expect(parsed.maxPriorityFeePerGas).toBe(1_000_000_000n);
  });

  it('falls back to the legacy gas price when the chain has no EIP-1559 fee data', async () => {
    mockGetFeeQuote.mockResolvedValue({
      type: 'legacy',
      gasPrice: '7000000000',
      source: 'colibri',
    });

    await signAndSendTransaction(
      { to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', value: '1', gasLimit: '21000', chainId: 100 },
      signer,
    );

    const parsed = Transaction.from(broadcastedRaw);
    expect(parsed.type).toBe(0);
    expect(parsed.gasPrice).toBe(7_000_000_000n);
  });

  it('refuses to sign when the network reports no usable gas price', async () => {
    const signTransaction = jest.fn();
    mockGetFeeQuote.mockResolvedValue({ type: 'legacy', gasPrice: '0', source: 'direct' });

    await expect(
      signAndSendTransaction(
        { to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', value: '1', gasLimit: '21000', chainId: 100 },
        { ...signer, signTransaction },
      ),
    ).rejects.toThrow('Unable to determine a gas price');

    // Critically: the device is never asked to confirm an unbroadcastable tx.
    expect(signTransaction).not.toHaveBeenCalled();
    expect(broadcastedRaw).toBeNull();
  });

  it('maps insufficient-funds broadcast errors to a friendly message', async () => {
    mockChainRequest.mockResolvedValue({ result: '0x0', source: 'direct' });
    mockBroadcastRawTransaction.mockRejectedValue(
      new Error('insufficient funds for gas * price + value')
    );

    await expect(
      signAndSendTransaction(
        { to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', value: '1', gasLimit: '21000', gasPrice: '7', chainId: 1 },
        signer,
      ),
    ).rejects.toThrow('Insufficient funds for transaction');
  });

  describe('signer sendTransaction capability (device broadcasts itself)', () => {
    // Remote (phone) signers cannot produce a raw signed tx: the phone
    // picks the nonce and broadcasts itself. Only intent fields go over.
    const hash = '0x' + 'cd'.repeat(32);
    const params = {
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: '1000',
      data: '0xabcdef',
      gasLimit: '21000',
      maxFeePerGas: '2000000000',
      maxPriorityFeePerGas: '1000000000',
      chainId: 8453,
    };
    let getTransaction;
    let broadcastingSigner;

    beforeEach(() => {
      getTransaction = jest.fn(async () => ({ from: testWallet.address }));
      mockChainRequest.mockImplementation(async (_chainId, method, args) => {
        if (method === 'eth_getTransactionByHash') {
          return { result: await getTransaction(...args), source: 'direct' };
        }
        return { result: '0x5', source: 'direct' };
      });
      broadcastingSigner = { ...signer, sendTransaction: jest.fn(async () => hash) };
    });

    it('prefers the capability over sign+broadcast and verifies the tx sender', async () => {
      const result = await signAndSendTransaction(params, broadcastingSigner);

      expect(broadcastingSigner.sendTransaction).toHaveBeenCalledWith({
        to: params.to,
        value: '1000',
        data: '0xabcdef',
        chainId: 8453,
      });
      expect(broadcastedRaw).toBeNull(); // never touched our provider's broadcast path
      expect(getTransaction).toHaveBeenCalledWith(hash);
      expect(mockGetFeeQuote).not.toHaveBeenCalled();
      expect(result).toEqual({
        hash,
        from: testWallet.address,
        to: params.to,
        value: '1000',
        chainId: 8453,
        explorerUrl: `https://explorer.test/8453/${hash}`,
      });
    });

    it('rejects with REMOTE_WRONG_ACCOUNT when the broadcast tx is from someone else', async () => {
      getTransaction.mockResolvedValue({ from: '0x' + '11'.repeat(20) });
      await expect(signAndSendTransaction(params, broadcastingSigner)).rejects.toMatchObject({
        code: 'REMOTE_WRONG_ACCOUNT',
      });
    });

    it('tolerates a tx not yet visible on our RPC (best-effort check)', async () => {
      getTransaction.mockResolvedValue(null);
      await expect(signAndSendTransaction(params, broadcastingSigner)).resolves.toMatchObject({ hash });
    });

    it('tolerates lookup failures (best-effort check)', async () => {
      getTransaction.mockRejectedValue(new Error('rpc down'));
      await expect(signAndSendTransaction(params, broadcastingSigner)).resolves.toMatchObject({ hash });
    });
  });

  it('passes device-backend errors through with their stable code intact', async () => {
    // LEDGER_*/REMOTE_* errors carry user-facing messages and codes the
    // approval UIs rely on; the generic rewrap must not swallow them —
    // e.g. a phone error mentioning "gas" must not become our local
    // gas-estimation message.
    const deviceError = Object.assign(new Error('intrinsic gas too low'), {
      code: 'REMOTE_UNKNOWN',
    });
    const rejectingSigner = {
      ...signer,
      signTransaction: async () => {
        throw deviceError;
      },
    };

    await expect(
      signAndSendTransaction(
        { to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', value: '1', gasLimit: '21000', gasPrice: '7', chainId: 1 },
        rejectingSigner,
      ),
    ).rejects.toBe(deviceError);
  });

  it('surfaces signer rejection (e.g. user declined on device) unchanged', async () => {
    const decliningSigner = {
      ...signer,
      signTransaction: async () => {
        throw new Error('User rejected on device');
      },
    };

    await expect(
      signAndSendTransaction(
        { to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', value: '1', gasLimit: '21000', gasPrice: '7', chainId: 1 },
        decliningSigner,
      ),
    ).rejects.toThrow(/User rejected on device/);
  });
});

describe('capability-aware transaction routing', () => {
  beforeEach(() => {
    mockChainRequest.mockReset();
    mockGetFeeQuote.mockReset();
    mockBroadcastRawTransaction.mockReset();
  });

  test('uses the configured chain source for gas estimation and fee data', async () => {
    mockChainRequest
      .mockResolvedValueOnce({ result: '0x5208', source: 'myotis' });
    mockGetFeeQuote.mockResolvedValue({
      type: 'eip1559',
      baseFee: '98',
      maxFeePerGas: '100',
      maxPriorityFeePerGas: '2',
      effectiveGasPrice: '100',
      source: 'myotis',
      verified: true,
    });

    await expect(
      estimateGas({ from: testWallet.address, to: testWallet.address, value: '0', chainId: 100 })
    ).resolves.toEqual({ gasLimit: '25200' });
    await expect(getGasPrices(100)).resolves.toMatchObject({
      type: 'eip1559',
      maxFeePerGas: '100',
      maxPriorityFeePerGas: '2',
    });
    expect(mockGetFeeQuote).toHaveBeenCalledWith(100);
  });

  test('signs locally and broadcasts the raw transaction through Myotis', async () => {
    mockChainRequest.mockResolvedValue({ result: '0x0', source: 'myotis' });
    mockBroadcastRawTransaction.mockImplementation(async (_chainId, raw) => ({
      result: Transaction.from(raw).hash,
      source: 'myotis',
    }));

    const result = await signAndSendTransaction(
      {
        to: testWallet.address,
        value: '1',
        gasLimit: '21000',
        maxFeePerGas: '100',
        maxPriorityFeePerGas: '2',
        chainId: 100,
      },
      signer
    );

    expect(mockBroadcastRawTransaction).toHaveBeenCalledWith(
      100,
      expect.stringMatching(/^0x/)
    );
    expect(result).toMatchObject({ chainId: 100, broadcastSource: 'myotis' });
    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  test('reports inconsistent fees as a fee error rather than a nonce error', async () => {
    mockChainRequest.mockResolvedValue({ result: '0x11b', source: 'direct' });

    await expect(
      signAndSendTransaction(
        {
          to: testWallet.address,
          value: '1',
          gasLimit: '25200',
          maxFeePerGas: '3727',
          maxPriorityFeePerGas: '1000000000',
          chainId: 100,
        },
        signer
      )
    ).rejects.toThrow('Transaction fee data is invalid. Please refresh and try again.');
    expect(mockBroadcastRawTransaction).not.toHaveBeenCalled();
  });

  test('still maps an actual nonce rejection to the nonce error', async () => {
    mockChainRequest.mockRejectedValue(new Error('nonce too low'));

    await expect(
      signAndSendTransaction(
        {
          to: testWallet.address,
          value: '1',
          gasLimit: '21000',
          gasPrice: '1',
          chainId: 100,
        },
        signer
      )
    ).rejects.toThrow('Transaction nonce error. Please try again.');
  });

  test('surfaces the locally computed hash when a broadcaster returns a mismatch', async () => {
    let localHash;
    mockChainRequest.mockResolvedValue({ result: '0x0', source: 'direct' });
    mockBroadcastRawTransaction.mockImplementation(async (_chainId, raw) => {
      localHash = Transaction.from(raw).hash;
      return { result: `0x${'11'.repeat(32)}`, source: 'direct' };
    });

    let failure;
    try {
      await signAndSendTransaction(
        {
          to: testWallet.address,
          value: '1',
          gasLimit: '21000',
          gasPrice: '1',
          chainId: 100,
        },
        signer
      );
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain(localHash);
  });

  test('keeps polling after a transient confirmation-head failure', async () => {
    jest.useFakeTimers();
    mockChainRequest
      .mockResolvedValueOnce({
        result: { status: '0x1', blockNumber: '0xa', gasUsed: '0x5208' },
        source: 'direct',
      })
      .mockRejectedValueOnce(new Error('temporary head failure'))
      .mockResolvedValueOnce({
        result: { status: '0x1', blockNumber: '0xa', gasUsed: '0x5208' },
        source: 'direct',
      })
      .mockResolvedValueOnce({ result: '0xb', source: 'direct' });

    const pending = waitForTransaction(`0x${'22'.repeat(32)}`, 100, 2);
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toMatchObject({ status: 'confirmed', blockNumber: 10 });
    jest.useRealTimers();
  });
});
