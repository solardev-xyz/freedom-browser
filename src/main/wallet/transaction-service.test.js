const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet, Transaction } = require('ethers');
const mockChainRequest = jest.fn();
const mockGetFeeQuote = jest.fn();
const mockBroadcastRawTransaction = jest.fn();
jest.mock('../networks/chain-data', () => ({
  request: (...args) => mockChainRequest(...args),
  getFeeQuote: (...args) => mockGetFeeQuote(...args),
  broadcastRawTransaction: (...args) => mockBroadcastRawTransaction(...args),
  SOURCE_CAPABILITIES: {
    myotis: { unsupported: new Set() },
    colibri: { unsupported: new Set(['eth_getLogs']) },
    quorum: { unsupported: new Set() },
    direct: { unsupported: new Set() },
    blockscout: { unsupported: new Set(['eth_getTransactionReceipt', 'eth_getTransactionCount']) },
  },
}));
const {
  estimateGas,
  getGasPrices,
  signAndSendTransaction,
  waitForTransaction,
  getTransactionStatus,
} = require('./transaction-service');
jest.mock('./chains', () => ({
  getTxExplorerUrl: (chainId, hash) => `https://explorer.test/${chainId}/${hash}`,
}));
// Every send is an intent: each test gets its own records, in a temp dir.
let mockIntentStore;
jest.mock('./intent-store', () => ({
  ...jest.requireActual('./intent-store'),
  getIntentStore: () => mockIntentStore,
}));
const { createIntentStore } = require('./intent-store');
let intentDir;
beforeEach(() => {
  intentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-service-intents-'));
  mockIntentStore = createIntentStore({ filePath: path.join(intentDir, 'wallet-intents.jsonl') });
});
afterEach(() => {
  fs.rmSync(intentDir, { recursive: true, force: true });
});

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

  // #749: the router's quote already carries the headroom (a type-2 cap
  // derived from the block's base fee, or a buffered legacy gasPrice on a
  // chain without EIP-1559); resolveFeeParams signs it as quoted.
  it('signs a type-2 quote the router derived from the block base fee', async () => {
    mockGetFeeQuote.mockResolvedValue({
      type: 'eip1559',
      baseFee: '137164402',
      maxPriorityFeePerGas: '50000000',
      maxFeePerGas: '324328804',
      effectiveGasPrice: '187164402',
      source: 'colibri',
    });

    await signAndSendTransaction(
      { to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', value: '1', gasLimit: '21000', chainId: 1 },
      signer,
    );

    const parsed = Transaction.from(broadcastedRaw);
    expect(parsed.type).toBe(2);
    expect(parsed.gasPrice).toBeNull();
    expect(parsed.maxFeePerGas).toBe(324_328_804n);
    expect(parsed.maxPriorityFeePerGas).toBe(50_000_000n);
  });

  it('never downgrades an unusable type-2 quote to a legacy gas price', async () => {
    const signTransaction = jest.fn();
    // A type-2 quote whose tip exceeds its cap cannot be signed; the stray
    // gasPrice on it must not be signed instead.
    mockGetFeeQuote.mockResolvedValue({
      type: 'eip1559',
      maxFeePerGas: '100',
      maxPriorityFeePerGas: '1000',
      gasPrice: '137168303',
      source: 'colibri',
    });

    await expect(
      signAndSendTransaction(
        { to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', value: '1', gasLimit: '21000', chainId: 1 },
        { ...signer, signTransaction },
      ),
    ).rejects.toThrow('Unable to determine a gas price');
    expect(signTransaction).not.toHaveBeenCalled();
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
    // The drivers tag a refusal with its outcome (design 0005, "Outcome").
    mockBroadcastRawTransaction.mockRejectedValue(
      Object.assign(new Error('insufficient funds for gas * price + value'), {
        outcome: 'rejected',
      })
    );

    await expect(
      signAndSendTransaction(
        { to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', value: '1', gasLimit: '21000', gasPrice: '7', chainId: 1 },
        signer,
      ),
    ).rejects.toMatchObject({
      message: 'Insufficient funds for transaction',
      outcome: 'rejected',
      intentId: expect.any(String),
    });
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
      expect(mockChainRequest).toHaveBeenCalledWith(8453, 'eth_getTransactionByHash', [hash]);
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

describe('getTransactionStatus', () => {
  const HASH = `0x${'aa'.repeat(32)}`;
  const FROM = testWallet.address;

  beforeEach(() => {
    mockChainRequest.mockReset();
  });

  // Each read answers from `source`, unless the caller excluded it: then the
  // next source in [myotis, colibri, quorum, direct] that is left answers.
  function chain(answers, { sourceFor = () => 'direct' } = {}) {
    mockChainRequest.mockImplementation(async (_chainId, method, _params, opts = {}) => {
      const queue = answers[method];
      if (!queue || queue.length === 0) throw new Error(`unexpected ${method}`);
      const excluded = new Set(opts.excludeSources || []);
      const preferred = sourceFor(method);
      const source = excluded.has(preferred)
        ? ['myotis', 'colibri', 'quorum', 'direct'].find((s) => !excluded.has(s))
        : preferred;
      if (!source) throw new Error(`No chain source left for ${method}`);
      const next = queue.shift();
      const result = typeof next === 'function' ? next(source) : next;
      return { result, source };
    });
  }

  test('reports a transaction whose nonce another transaction took as dropped', async () => {
    chain({
      eth_getTransactionReceipt: [null, null],
      eth_getTransactionCount: ['0x1'],
    });

    await expect(getTransactionStatus(HASH, 1, { from: FROM, nonce: 0 })).resolves.toEqual({
      status: 'dropped',
      hash: HASH,
      nonce: 0,
    });
    expect(mockChainRequest).toHaveBeenCalledWith(
      1,
      'eth_getTransactionCount',
      [FROM, 'latest'],
      expect.objectContaining({ excludeSources: expect.arrayContaining(['myotis']) })
    );
  });

  test('stays pending while the sender\'s mined nonce has not reached it', async () => {
    chain({
      eth_getTransactionReceipt: [null],
      eth_getTransactionCount: ['0x3'],
    });

    await expect(getTransactionStatus(HASH, 1, { from: FROM, nonce: 3 })).resolves.toMatchObject({
      status: 'pending',
    });
  });

  test('is not dropped when it was this transaction that moved the nonce', async () => {
    // Mined between the first receipt lookup and the nonce read.
    chain({
      eth_getTransactionReceipt: [null, { status: '0x1', blockNumber: '0xa', gasUsed: '0x5208' }],
      eth_getTransactionCount: ['0x1'],
    });

    await expect(getTransactionStatus(HASH, 1, { from: FROM, nonce: 0 })).resolves.toMatchObject({
      status: 'pending',
    });
  });

  test('a source ahead of the receipt source never decides dropped (Myotis nonce, lagging receipts)', async () => {
    // The chain as each source sees it: Myotis has the block that mined this
    // transaction (nonce 1); quorum, which would answer receipts, does not
    // yet. Routed independently that reads as "nonce taken, no receipt".
    const view = {
      myotis: { count: '0x1', receipt: undefined },
      quorum: { count: '0x0', receipt: null },
    };
    chain(
      {
        eth_getTransactionReceipt: [null, (source) => view[source].receipt],
        eth_getTransactionCount: [(source) => view[source].count],
      },
      { sourceFor: (method) => (method === 'eth_getTransactionCount' ? 'myotis' : 'quorum') }
    );

    await expect(getTransactionStatus(HASH, 1, { from: FROM, nonce: 0 })).resolves.toMatchObject({
      status: 'pending',
    });
  });

  // Colibri traps on a receipt for a hash it has never seen instead of
  // answering null (colibri-stateless 3.0.2, mainnet prover). A nonce read it
  // answered would pin the re-check to it, which then always throws.
  test('a dropped transaction is decided on a Colibri chain (Colibri never answers the nonce)', async () => {
    const colibriTrap = (source) => {
      if (source === 'colibri') throw new Error('memory access out of bounds');
      return null;
    };
    chain(
      {
        eth_getTransactionReceipt: [null, colibriTrap],
        eth_getTransactionCount: ['0x1'],
      },
      { sourceFor: () => 'colibri' }
    );

    await expect(getTransactionStatus(HASH, 1, { from: FROM, nonce: 0 })).resolves.toMatchObject({
      status: 'dropped',
    });
    const nonceRead = mockChainRequest.mock.calls[1];
    expect(nonceRead[1]).toBe('eth_getTransactionCount');
    expect(nonceRead[3].excludeSources).toEqual(expect.arrayContaining(['myotis', 'colibri']));
    expect(mockChainRequest.mock.calls[2][3].excludeSources).toContain('colibri');
  });

  test('the receipt re-check is pinned to the source that answered the nonce', async () => {
    chain(
      {
        eth_getTransactionReceipt: [null, null],
        eth_getTransactionCount: ['0x1'],
      },
      { sourceFor: () => 'quorum' }
    );

    await expect(getTransactionStatus(HASH, 1, { from: FROM, nonce: 0 })).resolves.toMatchObject({
      status: 'dropped',
    });
    const recheck = mockChainRequest.mock.calls[2];
    expect(recheck[1]).toBe('eth_getTransactionReceipt');
    expect(new Set(recheck[3].excludeSources)).toEqual(
      new Set(['myotis', 'colibri', 'direct', 'blockscout'])
    );
  });

  test('a receipt answer from any other source does not decide dropped', async () => {
    // The pinned source is gone from the order; a router answering from
    // elsewhere anyway must not be trusted for a final status.
    mockChainRequest.mockImplementation(async (_chainId, method) => {
      if (method === 'eth_getTransactionCount') return { result: '0x1', source: 'quorum' };
      return { result: null, source: 'direct' };
    });

    await expect(getTransactionStatus(HASH, 1, { from: FROM, nonce: 0 })).resolves.toMatchObject({
      status: 'pending',
    });
  });

  test('without the sent nonce, a missing receipt is only ever pending', async () => {
    chain({ eth_getTransactionReceipt: [null] });

    await expect(getTransactionStatus(HASH, 1)).resolves.toMatchObject({ status: 'pending' });
    expect(mockChainRequest).toHaveBeenCalledTimes(1);
  });

  // R3-M1: Colibri traps (and retires its worker) on a hash it has no
  // receipt for, which is most of what a background sweep polls.
  test('a background sweep reads the receipt without Colibri', async () => {
    chain({ eth_getTransactionReceipt: [null] }, { sourceFor: () => 'colibri' });

    await expect(getTransactionStatus(HASH, 1, { sweep: true })).resolves.toMatchObject({
      status: 'pending',
    });
    expect(mockChainRequest).toHaveBeenCalledWith(
      1, 'eth_getTransactionReceipt', [HASH], { excludeSources: ['colibri'] }
    );
  });

  test('an interactive status read still lets Colibri answer the receipt', async () => {
    chain({ eth_getTransactionReceipt: [null] }, { sourceFor: () => 'colibri' });

    await getTransactionStatus(HASH, 1);
    expect(mockChainRequest).toHaveBeenCalledWith(1, 'eth_getTransactionReceipt', [HASH], undefined);
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

  test('a broadcaster naming another hash makes the send uncertain, with the local hash', async () => {
    let localHash;
    mockChainRequest.mockResolvedValue({ result: '0x0', source: 'direct' });
    mockBroadcastRawTransaction.mockImplementation(async (_chainId, raw) => {
      localHash = Transaction.from(raw).hash;
      return { result: `0x${'11'.repeat(32)}`, source: 'direct' };
    });

    const result = await signAndSendTransaction(
      {
        to: testWallet.address,
        value: '1',
        gasLimit: '21000',
        gasPrice: '1',
        chainId: 100,
      },
      signer
    );
    // It may have been sent: never an error, and never the broadcaster's hash.
    expect(result).toMatchObject({
      hash: localHash,
      outcome: 'uncertain',
      broadcastSource: 'direct',
    });
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
