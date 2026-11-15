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
// A fake Ledger, for the one test that runs the real Ledger backend.
const mockLedgerEth = { getAddress: jest.fn(), signTransaction: jest.fn() };
jest.mock('./ledger/transport', () => ({ withEthApp: (task) => task(mockLedgerEth) }));

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

  it('keeps sensitive domain calldata out of transaction errors and logs', async () => {
    const secret = 'private-registration-preimage-fixture';
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockBroadcastRawTransaction.mockRejectedValue(new Error(secret));
    try {
      await expect(signAndSendTransaction({
        to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', value: '0', gasLimit: '21000',
        maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', chainId: 1, redactErrors: true,
      }, signer)).rejects.toThrow('saved operation');
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
    } finally { errorLog.mockRestore(); }
  });

  it('distinguishes a local signing refusal from an uncertain broadcast without retaining its cause', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const refusingSigner = { ...signer, signTransaction: async () => { throw new Error('private-device-error-fixture'); } };
      await expect(signAndSendTransaction({
        to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', value: '0', gasLimit: '21000',
        maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', chainId: 1, redactErrors: true,
      }, refusingSigner)).rejects.toMatchObject({ code: 'DOMAIN_NOT_BROADCAST' });
      expect(mockBroadcastRawTransaction).not.toHaveBeenCalled();
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private-device-error-fixture');
    } finally { errorLog.mockRestore(); }
  });

  // freedom-core design 0011, PRQ-5b: a page's send checks its name and its
  // document again after the signer's wait, before the signed bytes are
  // recorded or sent.
  it("the caller's guard commits a signed transaction itself, or withdraws it with nothing recorded or sent", async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const params = {
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: '1000',
      gasLimit: '21000',
      maxFeePerGas: '2000000000',
      maxPriorityFeePerGas: '1000000000',
      chainId: 8453,
    };
    const onCommitted = jest.fn();
    const withdrawn = Object.assign(new Error('withdrawn'), { code: 'INTENT_WITHDRAWN', answer: { error: {} } });
    const refusing = jest.fn(async () => {
      throw withdrawn;
    });
    // Withdrawn after the signature: the very error, nothing in the records,
    // nothing broadcast, and the nonce free for the next.
    await expect(signAndSendTransaction(params, signer, { guardCommit: refusing, onCommitted })).rejects.toBe(withdrawn);
    expect(refusing).toHaveBeenCalledTimes(1);
    expect(mockBroadcastRawTransaction).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
    await mockIntentStore.ready;
    expect(mockIntentStore.held()).toEqual([]);
    // Let through: the guard commits, and the send goes on at the same nonce.
    const passing = jest.fn(async (commit) => commit());
    const result = await signAndSendTransaction(params, signer, { guardCommit: passing, onCommitted });
    expect(passing).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ nonce: 5 });
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(mockBroadcastRawTransaction).toHaveBeenCalledTimes(1);
    console.error.mockRestore();
  });

  // APB-1b: a device's signer refuses before it is asked when the
  // dispatcher's last check (`beforeSign`, signers.js) withdraws the
  // request: the caller hears that very error, with nothing recorded or
  // sent, a Ledger's nonce free for the next and a phone never asked.
  it("a device signer's own withdrawal before the device: the very error, nothing recorded or sent", async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const params = {
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: '1000',
      gasLimit: '21000',
      maxFeePerGas: '2000000000',
      maxPriorityFeePerGas: '1000000000',
      chainId: 8453,
    };
    const withdrawn = Object.assign(new Error('withdrawn'), { code: 'INTENT_WITHDRAWN', answer: { error: {} } });
    const ledger = { ...signer, signTransaction: jest.fn(async () => { throw withdrawn; }) };
    await expect(signAndSendTransaction(params, ledger)).rejects.toBe(withdrawn);
    expect(mockBroadcastRawTransaction).not.toHaveBeenCalled();
    await mockIntentStore.ready;
    expect(mockIntentStore.held()).toEqual([]);
    const phone = {
      getAddress: async () => '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      sendTransaction: jest.fn(async () => { throw withdrawn; }),
    };
    await expect(signAndSendTransaction(params, phone)).rejects.toBe(withdrawn);
    expect(mockBroadcastRawTransaction).not.toHaveBeenCalled();
    console.error.mockRestore();
  });

  // Codex round 2 on #1191: a keyed send (a Safe's execution) honours the
  // guard too: at its first commit, after the signer's wait, and at a held
  // intent's handoff, the last point before its bytes go out again.
  it('a keyed send: the guard at its first commit after a held signature, and at a resend\'s handoff', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const params = {
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: '0',
      gasLimit: '21000',
      maxFeePerGas: '2000000000',
      maxPriorityFeePerGas: '1000000000',
      chainId: 100,
    };
    const intentKey = `safe-exec:100:0x${'5e'.repeat(32)}`;
    const context = { kind: 'safe-send', origin: 'https://app.example' };
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const heldSigner = {
      getAddress: signer.getAddress,
      signTransaction: async (tx) => {
        await held;
        return signer.signTransaction(tx);
      },
    };
    let holds = true;
    const refusal = Object.assign(new Error('the site no longer holds it'), { code: 'SAFE_SITE_WITHDRAWN' });
    const guardCommit = jest.fn(async (effect) => {
      if (!holds) throw refusal;
      return effect();
    });
    // Its first commit: the guard runs after the signer's wait, and refuses.
    const sending = signAndSendTransaction(params, heldSigner, { intentKey, context, guardCommit });
    await new Promise((resolve) => setImmediate(resolve));
    expect(guardCommit).not.toHaveBeenCalled();
    holds = false;
    release();
    await expect(sending).rejects.toBe(refusal);
    await mockIntentStore.ready;
    expect(mockIntentStore.byKey(intentKey)).toBeNull();
    expect(mockBroadcastRawTransaction).not.toHaveBeenCalled();
    // Committed, then not sent: the intent is held under its key.
    holds = true;
    mockBroadcastRawTransaction.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Myotis is not ready'), { outcome: 'not_sent' });
    });
    await expect(signAndSendTransaction(params, signer, { intentKey, context, guardCommit })).rejects.toThrow();
    const intent = mockIntentStore.byKey(intentKey);
    expect(intent).toMatchObject({ context: { origin: 'https://app.example' } });
    const handoffs = mockIntentStore.get(intent.intentId).handoffs.length;
    // Sent again: the guard runs before the handoff, and refuses.
    holds = false;
    guardCommit.mockClear();
    await expect(signAndSendTransaction(params, signer, { intentKey, context, guardCommit })).rejects.toBe(refusal);
    expect(guardCommit).toHaveBeenCalledTimes(1);
    expect(mockIntentStore.get(intent.intentId).handoffs).toHaveLength(handoffs);
    expect(mockBroadcastRawTransaction).toHaveBeenCalledTimes(1);
    // Let through: the guard takes the handoff, and the same bytes go out.
    holds = true;
    const resent = await signAndSendTransaction(params, signer, { intentKey, context, guardCommit });
    expect(resent).toMatchObject({ resent: true, intentId: intent.intentId });
    expect(mockBroadcastRawTransaction).toHaveBeenCalledTimes(2);
    console.error.mockRestore();
    console.log.mockRestore();
  });

  // Codex round 3 on #1191: a held execution's resend checks at its handoff,
  // after the account's lock, not before waiting for it.
  it("a keyed resend waits for the account's lock first, then its guard checks and takes the handoff", async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const reservations = require('./nonce-reservations');
    const params = {
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: '0',
      gasLimit: '21000',
      maxFeePerGas: '2000000000',
      maxPriorityFeePerGas: '1000000000',
      chainId: 100,
    };
    const intentKey = `safe-exec:100:0x${'6f'.repeat(32)}`;
    const context = { kind: 'safe-send', origin: 'https://app.example' };
    // Committed under the site, then not sent: held under its key.
    mockBroadcastRawTransaction.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Myotis is not ready'), { outcome: 'not_sent' });
    });
    await expect(signAndSendTransaction(params, signer, { intentKey, context })).rejects.toThrow();
    const intent = mockIntentStore.byKey(intentKey);
    const handoffs = mockIntentStore.get(intent.intentId).handoffs.length;
    const broadcasts = mockBroadcastRawTransaction.mock.calls.length;
    // Another send of the executor account holds its lock.
    let releaseLock;
    let lockTaken;
    const taken = new Promise((resolve) => {
      lockTaken = resolve;
    });
    const holding = reservations.withAccountLock({ chainId: 100, sender: testWallet.address }, () => {
      lockTaken();
      return new Promise((resolve) => {
        releaseLock = resolve;
      });
    });
    await taken;
    // The site held when the execution started (its earlier check passed).
    let holds = true;
    const refusal = Object.assign(new Error('the site no longer holds it'), { code: 'SAFE_SITE_WITHDRAWN' });
    const guardCommit = jest.fn(async (effect) => {
      if (!holds) throw refusal;
      return effect();
    });
    const resending = signAndSendTransaction(params, signer, { intentKey, context, guardCommit });
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // Waiting for the lock: the guard hasn't checked yet.
    expect(guardCommit).not.toHaveBeenCalled();
    holds = false; // the site is withdrawn while the resend waits
    releaseLock();
    await holding;
    await expect(resending).rejects.toBe(refusal);
    expect(guardCommit).toHaveBeenCalledTimes(1);
    expect(mockIntentStore.get(intent.intentId).handoffs).toHaveLength(handoffs);
    expect(mockBroadcastRawTransaction).toHaveBeenCalledTimes(broadcasts);
    console.error.mockRestore();
    console.log.mockRestore();
  });

  it('a phone signs and broadcasts in one step: it has no guard point', async () => {
    const guardCommit = jest.fn();
    const phone = { sendTransaction: jest.fn(async () => ({ hash: '0xphone' })) };
    await signAndSendTransaction(
      { to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', value: '0', gasLimit: '21000', chainId: 100 },
      phone,
      { guardCommit }
    ).catch(() => {});
    expect(guardCommit).not.toHaveBeenCalled();
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

  it.each([
    ['a phone rejection', { code: 'REMOTE_USER_REJECTED', requestDelivered: true, otherAttemptDelivered: false }, 'DOMAIN_NOT_BROADCAST'],
    ['a phone rejection after an earlier attempt reached the phone', { code: 'REMOTE_USER_REJECTED', requestDelivered: true, otherAttemptDelivered: true }, 'DOMAIN_BROADCAST_UNKNOWN'],
    ['a wrong-account refusal after an earlier attempt reached the phone', { code: 'REMOTE_WRONG_ACCOUNT', requestDelivered: true, otherAttemptDelivered: true }, 'DOMAIN_BROADCAST_UNKNOWN'],
    ['a phone rejection with no attempt record', { code: 'REMOTE_USER_REJECTED', requestDelivered: true }, 'DOMAIN_BROADCAST_UNKNOWN'],
    ['no window for the QR', { code: 'REMOTE_NO_UI', requestDelivered: false }, 'DOMAIN_NOT_BROADCAST'],
    ['a timeout before the phone got the request', { code: 'REMOTE_TIMEOUT', requestDelivered: false }, 'DOMAIN_NOT_BROADCAST'],
    ['a cancel before the phone got the request', { code: 'REMOTE_USER_CANCELLED', requestDelivered: false }, 'DOMAIN_NOT_BROADCAST'],
    ['a timeout after the phone got the request', { code: 'REMOTE_TIMEOUT', requestDelivered: true }, 'DOMAIN_BROADCAST_UNKNOWN'],
    ['a cancel after the phone got the request', { code: 'REMOTE_USER_CANCELLED', requestDelivered: true }, 'DOMAIN_BROADCAST_UNKNOWN'],
    ['a bad phone response', { code: 'REMOTE_BAD_RESPONSE', requestDelivered: true }, 'DOMAIN_BROADCAST_UNKNOWN'],
    ['a busy identity core', { code: 'REMOTE_BUSY', requestDelivered: false }, 'DOMAIN_NOT_BROADCAST'],
    // The core saw a transaction the phone reported, and refused it.
    ['another transaction the phone sent, with no handshake', { code: 'REMOTE_WRONG_TRANSACTION', phoneSent: true, requestDelivered: false }, 'DOMAIN_BROADCAST_UNKNOWN'],
    ['another account the phone sent from', { code: 'REMOTE_WRONG_ACCOUNT', phoneSent: true, requestDelivered: true, otherAttemptDelivered: false }, 'DOMAIN_BROADCAST_UNKNOWN'],
    ['an uncoded failure', {}, 'DOMAIN_BROADCAST_UNKNOWN'],
  ])('classifies %s from a phone wallet', async (_label, fields, expected) => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const phone = { ...signer, sendTransaction: async () => { throw Object.assign(new Error('phone'), fields); } };
      await expect(signAndSendTransaction({
        to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', value: '0', chainId: 1, redactErrors: true,
      }, phone)).rejects.toMatchObject({ code: expected });
    } finally { errorLog.mockRestore(); }
  });

  describe('signer sendTransaction capability (device broadcasts itself)', () => {
    // Remote (phone) signers cannot produce a raw signed tx: the phone
    // picks the nonce and broadcasts itself. The identity core checks the
    // reported transaction (design 0012, PHN-2), and its verdict comes back
    // with the hash: main reads nothing of the transaction itself.
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
    let broadcastingSigner;
    const replies = (reply) => {
      broadcastingSigner = { ...signer, sendTransaction: jest.fn(async () => reply) };
    };

    beforeEach(() => {
      replies({ hash, outcome: 'verified', job: 'job-1' });
    });

    it("prefers the capability over sign+broadcast, and takes the core's verdict", async () => {
      const result = await signAndSendTransaction(params, broadcastingSigner);

      // The send, with the gas and fees main quoted, for the core's job.
      expect(broadcastingSigner.sendTransaction).toHaveBeenCalledWith({
        to: params.to,
        value: '1000',
        data: '0xabcdef',
        chainId: 8453,
        gasLimit: '21000',
        maxFeePerGas: '2000000000',
        maxPriorityFeePerGas: '1000000000',
        gasPrice: undefined,
      });
      expect(broadcastedRaw).toBeNull(); // never touched our provider's broadcast path
      // The core checks the transaction; main never looks it up.
      expect(mockChainRequest).not.toHaveBeenCalledWith(8453, 'eth_getTransactionByHash', expect.anything());
      expect(mockGetFeeQuote).not.toHaveBeenCalled();
      expect(result).toEqual({
        hash,
        from: testWallet.address,
        to: params.to,
        value: '1000',
        chainId: 8453,
        explorerUrl: `https://explorer.test/8453/${hash}`,
        phoneCheck: 'verified',
      });
    });

    // Not visible at the answer, or the core's read failed: the hash goes
    // back unverified, with the core's job, for tx-recorder to keep until
    // the core's `phone.checked`.
    it("reports an unverified payment with the core's job and when it was answered", async () => {
      replies({ hash, outcome: 'unverified', job: 'job-2' });
      const before = Date.now();
      const result = await signAndSendTransaction(params, broadcastingSigner);
      expect(result).toMatchObject({ hash, phoneCheck: 'unverified' });
      expect(result.phoneRecord).toEqual({ job: 'job-2', answeredAt: expect.any(Number) });
      expect(result.phoneRecord.answeredAt).toBeGreaterThanOrEqual(before);
    });

    it("reports a payment whose record the core couldn't save as unknown, still with its job", async () => {
      replies({ hash, outcome: 'unknown', job: 'job-3', durable: false });
      const result = await signAndSendTransaction(params, broadcastingSigner);
      expect(result).toMatchObject({ hash, phoneCheck: 'unknown' });
      expect(result.phoneRecord).toEqual({ job: 'job-3', answeredAt: expect.any(Number), durable: false });
    });

    it('an outcome it does not know is unknown, never verified', async () => {
      replies({ hash, outcome: 'confirmed', job: 'job-4' });
      const result = await signAndSendTransaction(params, broadcastingSigner);
      expect(result).toMatchObject({ hash, phoneCheck: 'unknown', phoneRecord: { job: 'job-4' } });
    });

    it('with no job to wait on, no record goes back', async () => {
      replies({ hash, outcome: 'unverified' });
      const result = await signAndSendTransaction(params, broadcastingSigner);
      expect(result).toMatchObject({ hash, phoneCheck: 'unverified' });
      expect(result).not.toHaveProperty('phoneRecord');
    });

    it('a legacy send passes its gas price', async () => {
      const legacy = { to: params.to, value: '1000', gasLimit: '21000', gasPrice: '7', chainId: 8453 };
      await signAndSendTransaction(legacy, broadcastingSigner);
      expect(broadcastingSigner.sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ gasLimit: '21000', gasPrice: '7' })
      );
    });

    // The core saw the reported transaction and refused it (another sender,
    // recipient, amount, data or chain): the phone sent something.
    it.each([['REMOTE_WRONG_TRANSACTION'], ['REMOTE_WRONG_ACCOUNT']])(
      "the core's %s passes through, and a redacted one is of unknown outcome, never \"not sent\"",
      async (code) => {
        const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const refused = () =>
            Object.assign(new Error('another transaction'), { code, phoneSent: true, requestDelivered: true });
          const phone = { ...signer, sendTransaction: async () => { throw refused(); } };
          await expect(signAndSendTransaction(params, phone)).rejects.toMatchObject({ code, phoneSent: true });
          await expect(
            signAndSendTransaction({ ...params, redactErrors: true }, phone)
          ).rejects.toMatchObject({ code: 'DOMAIN_BROADCAST_UNKNOWN' });
        } finally {
          errorLog.mockRestore();
        }
      }
    );
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

  it('broadcasts nothing when a Ledger answers with a signature from another key (#1063)', async () => {
    // The real Ledger backend over a fake device that holds the account's
    // address but answers with another key's signature.
    const { createLedgerBackend } = require('./ledger/signer');
    const otherKey = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    mockLedgerEth.getAddress.mockResolvedValue({ address: testWallet.address });
    mockLedgerEth.signTransaction.mockImplementation(async (_path, rawHex) => {
      const { signature } = Transaction.from(await otherKey.signTransaction(Transaction.from('0x' + rawHex)));
      return { r: signature.r.slice(2), s: signature.s.slice(2), v: signature.yParity.toString(16) };
    });
    const ledgerSigner = createLedgerBackend({ index: 1000000, address: testWallet.address, path: "44'/60'/0'/0/0" });

    await expect(
      signAndSendTransaction(
        {
          to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', value: '1', gasLimit: '21000',
          maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', chainId: 1,
        },
        ledgerSigner,
      ),
    ).rejects.toMatchObject({ code: 'LEDGER_BAD_SIGNATURE' });
    expect(mockLedgerEth.signTransaction).toHaveBeenCalledTimes(1);
    expect(mockBroadcastRawTransaction).not.toHaveBeenCalled();
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

  // #1066: a Safe's deployed mark is written on a receipt only when a
  // verified source gave it.
  test('a receipt carries whether the core labelled it verified', async () => {
    const receipt = { status: '0x1', blockNumber: '0x10', gasUsed: '0x5208' };
    for (const [answer, verified] of [
      [{ result: receipt, source: 'quorum', verified: true }, true],
      [{ result: receipt, source: 'direct', verified: false }, false],
      [{ result: receipt, source: 'direct' }, false],
      [{ result: { ...receipt, status: '0x0' }, source: 'colibri', verified: true }, true],
    ]) {
      mockChainRequest.mockReset();
      mockChainRequest.mockResolvedValueOnce(answer);
      await expect(getTransactionStatus(HASH, 1)).resolves.toMatchObject({
        status: answer.result.status === '0x1' ? 'confirmed' : 'failed',
        verified,
      });
    }
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
