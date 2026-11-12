const fs = require('fs');
const os = require('os');
const path = require('path');

const { ownerWallet } = require('./__tests__/helpers/test-owners');

const OWNERS = [ownerWallet(0).address, ownerWallet(2).address, ownerWallet(4).address];
const SAFE_ADDRESS = '0x41aD4887971f90BB3fE4d83eCa65177281283261';
const SAFE_TX_HASH = '0x' + 'cd'.repeat(32);
const TX_HASH = '0x' + 'ab'.repeat(32);

let mockTmpDir;
jest.mock('electron', () => ({
  app: { getPath: () => mockTmpDir },
}));

// Records as vault-meta stores them: `deployed` holds the stored marks,
// which the record seam filters as identity-manager's does (#1066).
const mockWalletRecords = {
  0: { index: 0, name: 'Main Wallet', address: OWNERS[0], type: 'mnemonic' },
  2: { index: 2, name: 'My Stax', address: OWNERS[1], type: 'ledger' },
  4: { index: 4, name: 'My Phone', address: OWNERS[2], type: 'remote' },
  5: {
    index: 5,
    name: 'Joint',
    address: SAFE_ADDRESS,
    type: 'safe',
    owners: [0, 2, 4],
    threshold: 2,
    saltNonce: '7508',
    deployed: { 100: { verified: true } },
  },
  6: {
    index: 6,
    name: 'Fresh',
    address: SAFE_ADDRESS.replace('41', '42'),
    type: 'safe',
    owners: [0, 2],
    threshold: 1,
    saltNonce: '9',
    deployed: {},
  },
  // Marked deployed by a release before #1066, on one endpoint's answer.
  7: {
    index: 7,
    name: 'Old mark',
    address: SAFE_ADDRESS.replace('41', '43'),
    type: 'safe',
    owners: [0, 2],
    threshold: 1,
    saltNonce: '11',
    deployed: { 100: true },
  },
};
const mockIsVaultUnlocked = jest.fn(async () => true);
jest.mock('../../identity-manager', () => {
  const { verifiedDeployments } = jest.requireActual('./deployed-mark');
  return {
    getWalletRecord: (index) => {
      const record = mockWalletRecords[index];
      if (!record) return null;
      return record.type === 'safe'
        ? { ...record, deployed: verifiedDeployments(record.deployed) }
        : record;
    },
    isVaultUnlocked: (...args) => mockIsVaultUnlocked(...args),
    WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
  };
});

const builtResult = {
  safeAddress: SAFE_ADDRESS,
  deployed: true,
  safeTxData: { to: OWNERS[2], value: '1000', data: '0x', nonce: 3 },
  safeTxHash: SAFE_TX_HASH,
  typedData: { domain: {}, types: {}, message: {} },
};
const signatureOf = (index) => ({
  signer: OWNERS[index === 0 ? 0 : index === 2 ? 1 : 2],
  data: '0x' + 'ee'.repeat(65),
});

const mockBuildSafeTransaction = jest.fn(async () => builtResult);
const mockCollectOwnerSignature = jest.fn(async ({ ownerIndex }) => signatureOf(ownerIndex));
const mockExecTransaction = jest.fn(async () => ({
  hash: TX_HASH,
  explorerUrl: `https://gnosisscan.io/tx/${TX_HASH}`,
  recorded: true,
}));
const mockWithdrawExecutionSite = jest.fn(async () => true);
jest.mock('./safe-executor', () => ({
  buildSafeTransaction: (...args) => mockBuildSafeTransaction(...args),
  collectOwnerSignature: (...args) => mockCollectOwnerSignature(...args),
  execTransaction: (...args) => mockExecTransaction(...args),
  withdrawExecutionSite: (...args) => mockWithdrawExecutionSite(...args),
  pickDefaultExecutor: jest.requireActual('./safe-executor').pickDefaultExecutor,
}));

const flushMicrotasks = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

// Chain reads (the Safe nonce guard).
const mockRpcRequest = jest.fn(async () => '0x3'); // == pending nonce → executable
jest.mock('../provider-manager', () => ({
  getEip1193Provider: () => ({ request: (...args) => mockRpcRequest(...args) }),
}));

const {
  startSafeSend,
  signSafePending,
  executeSafePending,
  getSafeSendState,
  getAllSafeSendStates,
  cancelSafeSend,
  onSafeSendSettled,
  guardSiteSafeSend,
} = require('./safe-transactions');
const { getPending, setPending, clearPending } = require('./pending-store');

const DISPLAY = {
  toAddress: OWNERS[2],
  asset: null,
  amount: '1000',
  symbol: 'xDAI',
  decimals: 18,
  formattedAmount: '0.000000000000001',
};
const TX = { to: OWNERS[2], value: '1000', data: '0x' };

const start = (safeIndex = 5, chainId = 100) =>
  startSafeSend({ safeIndex, tx: TX, display: DISPLAY, chainId });

beforeEach(() => {
  mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-pending-'));
  jest.clearAllMocks();
  mockIsVaultUnlocked.mockResolvedValue(true);
  mockRpcRequest.mockResolvedValue('0x3');
  for (const index of [5, 6, 7]) clearPending(index);
});

afterEach(() => {
  fs.rmSync(mockTmpDir, { recursive: true, force: true });
});

describe('startSafeSend', () => {
  test('builds, persists, silently signs the mnemonic owner only, never executes', async () => {
    const state = await start();

    expect(mockBuildSafeTransaction).toHaveBeenCalledWith({
      chainId: 100,
      // owners resolved to ADDRESSES for the executor layer
      safe: { ...mockWalletRecords[5], deployed: { 100: true }, owners: OWNERS },
      tx: TX,
    });
    // only the free (mnemonic) owner was asked — devices are never cold-called
    expect(mockCollectOwnerSignature).toHaveBeenCalledTimes(1);
    expect(mockCollectOwnerSignature).toHaveBeenCalledWith({ typedData: builtResult.typedData, ownerIndex: 0 });
    expect(mockExecTransaction).not.toHaveBeenCalled();

    expect(state).toMatchObject({
      safeIndex: 5,
      chainId: 100,
      safeTxHash: SAFE_TX_HASH,
      threshold: 2,
      collected: 1,
      status: 'awaiting',
      display: DISPLAY,
      executorIndex: 0,
      owners: [
        { index: 0, type: 'mnemonic', signed: true },
        { index: 2, type: 'ledger', signed: false },
        { index: 4, type: 'remote', signed: false },
      ].map((owner) => expect.objectContaining(owner)),
    });
    expect(getPending(5).signatures).toEqual([signatureOf(0)]);
  });

  test('a locked vault skips the silent signing entirely', async () => {
    mockIsVaultUnlocked.mockResolvedValue(false);
    const state = await start();
    expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
    expect(state.collected).toBe(0);
  });

  test('an auto-sign failure degrades the owner to a manual row instead of failing', async () => {
    mockCollectOwnerSignature.mockRejectedValueOnce(new Error('Vault is locked'));
    const state = await start();
    expect(state.collected).toBe(0);
    expect(state.status).toBe('awaiting');
  });

  test('refuses a second pending transaction (typed code)', async () => {
    await start();
    await expect(start()).rejects.toMatchObject({ code: 'SAFE_PENDING_EXISTS' });
  });

  test('refuses safes not yet deployed and non-safe accounts', async () => {
    await expect(start(6)).rejects.toThrow(/activate/i);
    await expect(start(0)).rejects.toThrow(/not a Safe/i);
  });

  test('refuses a Safe whose deployed mark no verified check wrote (#1066)', async () => {
    // Pending until getSafeStatus's verified read marks it again.
    await expect(start(7)).rejects.toThrow(/activate/i);
    expect(mockBuildSafeTransaction).not.toHaveBeenCalled();
    expect(getPending(7)).toBeNull();
  });

  test('refuses a send composed on a chain the Safe does not live on', async () => {
    // Executing mainnet calldata on Gnosis would spend the wrong native
    // token (or CALL a codeless address, burning the Safe nonce for nothing)
    // while the review screen said "Ethereum".
    await expect(start(5, 1)).rejects.toThrow(/only send on Gnosis/i);
    // A caller that forgets the chain entirely is refused too, rather than
    // silently defaulting back to the deployment chain.
    await expect(startSafeSend({ safeIndex: 5, tx: TX, display: DISPLAY }))
      .rejects.toThrow(/only send on Gnosis/i);
    expect(mockBuildSafeTransaction).not.toHaveBeenCalled();
    expect(getPending(5)).toBeNull();
  });
});

describe('signSafePending', () => {
  test('signs exactly the requested owner and persists it', async () => {
    await start(); // collected: owner 0
    mockCollectOwnerSignature.mockClear();

    const state = await signSafePending(5, 2);

    expect(mockCollectOwnerSignature).toHaveBeenCalledWith({ typedData: builtResult.typedData, ownerIndex: 2 });
    expect(state.collected).toBe(2);
    expect(state.owners.find((o) => o.index === 2).signed).toBe(true);
    expect(getPending(5).signatures).toHaveLength(2);
    expect(mockExecTransaction).not.toHaveBeenCalled(); // execution is a separate step
  });

  test('is idempotent for an already-signed owner', async () => {
    await start();
    mockCollectOwnerSignature.mockClear();
    const state = await signSafePending(5, 0);
    expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
    expect(state.collected).toBe(1);
  });

  test('a device failure leaves the pending transaction intact', async () => {
    await start();
    mockCollectOwnerSignature.mockRejectedValueOnce(
      Object.assign(new Error('Ledger not connected'), { code: 'LEDGER_NOT_CONNECTED' })
    );

    await expect(signSafePending(5, 2)).rejects.toMatchObject({ code: 'LEDGER_NOT_CONNECTED' });
    expect(getPending(5).signatures).toHaveLength(1); // owner 0's survives
    expect(getSafeSendState(5).status).toBe('awaiting'); // guard released
  });

  test('refuses concurrent steps (SAFE_BUSY) and exposes the signing status', async () => {
    await start();
    let resolveSign;
    mockCollectOwnerSignature.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSign = resolve))
    );

    const inFlight = signSafePending(5, 2);
    await new Promise((resolve) => setImmediate(resolve));

    await expect(signSafePending(5, 4)).rejects.toMatchObject({ code: 'SAFE_BUSY' });
    expect(() => cancelSafeSend(5)).toThrow(/current step/i);

    resolveSign(signatureOf(2));
    await inFlight;
    expect(getSafeSendState(5).status).toBe('awaiting');
  });

  test('drops a signature whose transaction was replaced mid-ceremony', async () => {
    await start();
    mockCollectOwnerSignature.mockImplementationOnce(async ({ ownerIndex }) => {
      // While the device ceremony runs, the pending entry disappears
      // (simulates a discard path that bypassed the guard).
      clearPending(5);
      return signatureOf(ownerIndex);
    });

    await expect(signSafePending(5, 2)).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    expect(getPending(5)).toBeNull();
  });
});

describe('executeSafePending', () => {
  async function readyPending() {
    await start();
    await signSafePending(5, 2);
  }

  test('refuses a SafeTx of a Safe whose deployed mark no verified check wrote (#1066)', async () => {
    // Saved while a release before #1066 trusted the old mark, fully signed.
    setPending(7, {
      chainId: 100,
      safeAddress: mockWalletRecords[7].address,
      safeTxData: { ...builtResult.safeTxData, nonce: 3 },
      safeTxHash: SAFE_TX_HASH,
      typedData: builtResult.typedData,
      threshold: 1,
      display: DISPLAY,
      signatures: [signatureOf(0)],
      createdAt: Date.now(),
    });

    await expect(executeSafePending(7)).rejects.toThrow(/activate/i);
    expect(mockExecTransaction).not.toHaveBeenCalled();
    // Nothing is lost: it executes once a verified check marks the Safe.
    expect(getPending(7).signatures).toEqual([signatureOf(0)]);
    mockWalletRecords[7].deployed = { 100: { verified: true } };
    try {
      await expect(executeSafePending(7)).resolves.toMatchObject({ status: 'executed' });
      expect(mockExecTransaction).toHaveBeenCalledTimes(1);
    } finally {
      mockWalletRecords[7].deployed = { 100: true };
    }
  });

  test('executes at threshold with recording, clears pending, returns the result', async () => {
    await readyPending();

    const state = await executeSafePending(5);

    expect(mockExecTransaction).toHaveBeenCalledWith({
      chainId: 100,
      safeAddress: SAFE_ADDRESS,
      safeTxData: builtResult.safeTxData,
      signatures: [signatureOf(0), signatureOf(2)],
      executorIndex: 0,
      // no fee confirmation: the executor's fee is judged as it is signed
      feeConfirmation: null,
      record: {
        kind: 'safe-send',
        fromAddress: SAFE_ADDRESS,
        toAddress: DISPLAY.toAddress,
        asset: null,
        amount: '1000',
        metadata: { safeAddress: SAFE_ADDRESS, safeTxHash: SAFE_TX_HASH },
      },
      // The wallet's own SafeTx: no site, so no request's guard.
      guardCommit: null,
    });
    expect(state.status).toBe('executed');
    expect(state.executed).toEqual({ hash: TX_HASH, explorerUrl: `https://gnosisscan.io/tx/${TX_HASH}` });
    expect(getPending(5)).toBeNull();
    expect(getSafeSendState(5)).toBeNull();
  });

  test('refuses below the threshold', async () => {
    await start(); // 1 of 2
    await expect(executeSafePending(5)).rejects.toThrow(/not enough signatures/i);
    expect(mockExecTransaction).not.toHaveBeenCalled();
  });

  test('a moved Safe nonce flips the transaction to a terminal superseded state', async () => {
    await readyPending();
    mockRpcRequest.mockResolvedValue('0x4'); // chain nonce > SafeTx nonce 3

    const state = await executeSafePending(5);

    expect(state.status).toBe('superseded');
    expect(mockExecTransaction).not.toHaveBeenCalled();
    // persisted: the board renders it terminal without another chain read
    expect(getSafeSendState(5).status).toBe('superseded');
    await expect(signSafePending(5, 4)).rejects.toThrow(/discard/i);
    // discard is the way out
    cancelSafeSend(5);
    expect(getSafeSendState(5)).toBeNull();
  });

  test("maps the executor's empty wallet to SAFE_NEEDS_FUNDS, signatures intact", async () => {
    await readyPending();
    mockExecTransaction.mockRejectedValueOnce(new Error('Insufficient funds for transaction'));

    await expect(executeSafePending(5)).rejects.toMatchObject({ code: 'SAFE_NEEDS_FUNDS' });
    expect(getPending(5).signatures).toHaveLength(2);
  });

  test('a failed broadcast keeps everything for a retry', async () => {
    await readyPending();
    mockExecTransaction.mockRejectedValueOnce(new Error('RPC down'));

    await expect(executeSafePending(5)).rejects.toThrow('RPC down');
    expect(getPending(5).signatures).toHaveLength(2);

    const state = await executeSafePending(5); // retry, no re-signing
    expect(state.status).toBe('executed');
    expect(mockCollectOwnerSignature).toHaveBeenCalledTimes(2); // from setup only
  });
});

// A board's step names the SafeTx it showed (approvals/safe-boards.js,
// Codex round 1 on #1214): another one pending is refused, nothing done.
describe('a step naming its SafeTx', () => {
  const OTHER = '0x' + 'ee'.repeat(32);

  test('the SafeTx named: signed, swept, executed, discarded as without a name', async () => {
    await start();
    mockCollectOwnerSignature.mockClear();
    await expect(signSafePending(5, undefined, { safeTxHash: SAFE_TX_HASH })).resolves.toMatchObject({ collected: 1 });
    await expect(signSafePending(5, 2, { safeTxHash: SAFE_TX_HASH })).resolves.toMatchObject({ collected: 2 });
    await expect(executeSafePending(5, { safeTxHash: SAFE_TX_HASH })).resolves.toMatchObject({ status: 'executed' });
    await start();
    cancelSafeSend(5, { safeTxHash: SAFE_TX_HASH });
    expect(getPending(5)).toBeNull();
  });

  test('another SafeTx pending: no ceremony, no sweep, no chain read, no execution, no discard', async () => {
    await start();
    await signSafePending(5, 2);
    mockCollectOwnerSignature.mockClear();
    mockRpcRequest.mockClear();
    await expect(signSafePending(5, 4, { safeTxHash: OTHER })).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    await expect(signSafePending(5, undefined, { safeTxHash: OTHER })).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
    await expect(executeSafePending(5, { safeTxHash: OTHER })).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    expect(mockRpcRequest).not.toHaveBeenCalled();
    expect(mockExecTransaction).not.toHaveBeenCalled();
    expect(() => cancelSafeSend(5, { safeTxHash: OTHER })).toThrow(expect.objectContaining({ code: 'SAFE_DISCARDED' }));
    expect(getPending(5).signatures).toHaveLength(2);
    // Not busy after a refusal: the SafeTx named executes.
    await expect(executeSafePending(5, { safeTxHash: SAFE_TX_HASH })).resolves.toMatchObject({ status: 'executed' });
  });

  test('none pending: a named discard is refused', () => {
    expect(() => cancelSafeSend(5, { safeTxHash: SAFE_TX_HASH })).toThrow(expect.objectContaining({ code: 'SAFE_DISCARDED' }));
    expect(() => cancelSafeSend(5)).not.toThrow();
  });
});

describe('getSafeSendState / cancelSafeSend', () => {
  test('null when nothing is pending; cancel clears', async () => {
    expect(getSafeSendState(5)).toBeNull();
    await start();
    expect(getSafeSendState(5)).not.toBeNull();
    cancelSafeSend(5);
    expect(getSafeSendState(5)).toBeNull();
  });
});

// freedom-core design 0011, PRQ-5b: a page's Safe send waits on main's own
// record of its SafeTx's outcome, whichever screen executed or discarded it.
describe('onSafeSendSettled', () => {
  test('hears an execution with its hash, and a discard; not a failure, a supersession or a stopped listener', async () => {
    const heard = [];
    const stop = onSafeSendSettled((event) => heard.push(event));
    // A listener that throws changes nothing for the others.
    const stopThrowing = onSafeSendSettled(() => {
      throw new Error('listener failed');
    });
    await start();
    await signSafePending(5, 2);
    mockExecTransaction.mockRejectedValueOnce(new Error('RPC down'));
    await expect(executeSafePending(5)).rejects.toThrow('RPC down');
    expect(heard).toEqual([]);
    await executeSafePending(5);
    expect(heard).toEqual([{ safeIndex: 5, safeTxHash: SAFE_TX_HASH, outcome: 'executed', hash: TX_HASH }]);

    await start();
    await signSafePending(5, 2);
    mockRpcRequest.mockResolvedValue('0x4');
    await executeSafePending(5);
    expect(heard).toHaveLength(1);
    cancelSafeSend(5);
    expect(heard.at(-1)).toEqual({ safeIndex: 5, safeTxHash: SAFE_TX_HASH, outcome: 'discarded' });
    // Nothing pending: nothing to hear.
    cancelSafeSend(5);
    expect(heard).toHaveLength(2);

    stop();
    stopThrowing();
    await start();
    cancelSafeSend(5);
    expect(heard).toHaveLength(2);
  });
});

// freedom-core design 0011, PRQ-5b, "After a waiting signature or send": a
// site's SafeTx is checked again before each step that can execute it, a
// parked one included. Whenever its site no longer holds it, it isn't
// executed for the site, and stays pending as the wallet's own.
describe("a site's SafeTx at its execution", () => {
  const SITE = 'https://app.example';
  const startForSite = () =>
    startSafeSend({ safeIndex: 5, tx: TX, display: { ...DISPLAY, site: SITE }, chainId: 100 });

  test("past its request's guard it executes for the site, the guard running the execution itself", async () => {
    await startForSite();
    await signSafePending(5, 2);
    const guard = jest.fn(async (execute) => execute());
    const stop = guardSiteSafeSend(SAFE_TX_HASH, guard);
    try {
      const state = await executeSafePending(5);
      expect(state.status).toBe('executed');
      expect(guard).toHaveBeenCalledTimes(1);
      expect(mockExecTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ record: expect.objectContaining({ origin: SITE }) })
      );
    } finally {
      stop();
    }
  });

  test.each([
    ['its request refuses it (its name moved, or its page is gone)', true],
    ['its request has ended, or main restarted: no guard', false],
  ])("when %s: not executed, and kept as the wallet's own, with no site", async (_name, guarded) => {
    await startForSite();
    await signSafePending(5, 2);
    const refusing = jest.fn(async () => {
      throw Object.assign(new Error('withdrawn'), { code: 'SAFE_SITE_WITHDRAWN' });
    });
    const stop = guarded ? guardSiteSafeSend(SAFE_TX_HASH, refusing) : () => {};
    const heard = [];
    const stopHearing = onSafeSendSettled((event) => heard.push(event));
    try {
      await expect(executeSafePending(5)).rejects.toMatchObject({ code: 'SAFE_SITE_WITHDRAWN' });
      expect(mockExecTransaction).not.toHaveBeenCalled();
      expect(heard).toEqual([]);
      // Still pending, its signatures kept, its site gone.
      const pending = getPending(5);
      expect(pending.signatures).toHaveLength(2);
      expect(pending.display).toEqual(DISPLAY);
      expect(getSafeSendState(5).display.site).toBeUndefined();
      // The user executes it as the wallet's: no guard, no site recorded.
      const state = await executeSafePending(5);
      expect(state.status).toBe('executed');
      expect(refusing).toHaveBeenCalledTimes(guarded ? 1 : 0);
      expect(mockExecTransaction.mock.calls[0][0].record.origin).toBeUndefined();
    } finally {
      stop();
      stopHearing();
    }
  });

  test("the wallet's own SafeTx needs no guard", async () => {
    await start();
    await signSafePending(5, 2);
    await expect(executeSafePending(5)).resolves.toMatchObject({ status: 'executed' });
    expect(mockExecTransaction.mock.calls[0][0].guardCommit).toBeNull();
  });

  // Codex round 2 on #1191: the execution waits on the executor's quote, the
  // site's turn and its signer, so the guard runs again at its last step.
  // The executor here runs as safe-executor does: a held quote, a held
  // signature, then the guard it was given, which commits.
  function pipelinedExecutor() {
    const quote = deferred();
    const signature = deferred();
    const committed = [];
    mockExecTransaction.mockImplementationOnce(async ({ guardCommit }) => {
      await quote.promise;
      await signature.promise;
      const commit = async () => committed.push('commit');
      await (guardCommit ? guardCommit(commit) : commit());
      return { hash: TX_HASH, explorerUrl: `https://gnosisscan.io/tx/${TX_HASH}` };
    });
    return { quote, signature, committed };
  }

  test('a site that stops holding its SafeTx during the quote and the signature: nothing committed, kept as the wallet\'s', async () => {
    await startForSite();
    await signSafePending(5, 2);
    let holds = true;
    const guard = jest.fn(async (effect) => {
      if (!holds) throw Object.assign(new Error('withdrawn'), { code: 'SAFE_SITE_WITHDRAWN' });
      return effect();
    });
    const stop = guardSiteSafeSend(SAFE_TX_HASH, guard);
    const executor = pipelinedExecutor();
    try {
      const executing = executeSafePending(5);
      await flushMicrotasks();
      // Past the guard before the execution; now at the executor's quote.
      expect(guard).toHaveBeenCalledTimes(1);
      executor.quote.resolve();
      await flushMicrotasks();
      holds = false; // the name moves while the executor signs
      executor.signature.resolve();
      await expect(executing).rejects.toMatchObject({ code: 'SAFE_SITE_WITHDRAWN' });
      expect(guard).toHaveBeenCalledTimes(2);
      expect(executor.committed).toEqual([]);
      expect(getPending(5).display).toEqual(DISPLAY);
      expect(getPending(5).signatures).toHaveLength(2);
      expect(mockWithdrawExecutionSite).toHaveBeenCalledWith(100, SAFE_TX_HASH);
    } finally {
      stop();
    }
  });

  test('a site that holds throughout: the guard commits after the signature, and it executes for the site', async () => {
    await startForSite();
    await signSafePending(5, 2);
    const guard = jest.fn(async (effect) => effect());
    const stop = guardSiteSafeSend(SAFE_TX_HASH, guard);
    const executor = pipelinedExecutor();
    try {
      const executing = executeSafePending(5);
      executor.quote.resolve();
      executor.signature.resolve();
      await expect(executing).resolves.toMatchObject({ status: 'executed' });
      expect(guard).toHaveBeenCalledTimes(2);
      expect(executor.committed).toEqual(['commit']);
    } finally {
      stop();
    }
  });

  // Codex round 3 on #1191: the held execution's intent loses its site first,
  // durably, and only then the pending SafeTx; a failed rewrite changes
  // neither, and a crash between the two is finished by the next attempt.
  test("the held execution's site goes first: the pending SafeTx still names it while the records are rewritten", async () => {
    await startForSite();
    await signSafePending(5, 2);
    let siteDuringRewrite;
    mockWithdrawExecutionSite.mockImplementationOnce(async () => {
      siteDuringRewrite = getPending(5).display.site;
      return true;
    });
    await expect(executeSafePending(5)).rejects.toMatchObject({ code: 'SAFE_SITE_WITHDRAWN' });
    expect(mockWithdrawExecutionSite).toHaveBeenCalledTimes(1);
    expect(siteDuringRewrite).toBe(SITE);
    expect(getPending(5).display).toEqual(DISPLAY);
  });

  test("a rewrite that fails changes neither record, says it isn't the wallet's yet, and the next attempt finishes", async () => {
    await startForSite();
    await signSafePending(5, 2);
    mockWithdrawExecutionSite.mockRejectedValueOnce(new Error('disk full'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = await executeSafePending(5).catch((err) => err);
    expect(failed).toMatchObject({ code: 'SAFE_SITE_WITHDRAWING' });
    expect(failed.message).not.toMatch(/your wallet's own/);
    expect(getPending(5).display.site).toBe(SITE);
    expect(getPending(5).signatures).toHaveLength(2);
    expect(mockExecTransaction).not.toHaveBeenCalled();
    // The next attempt, with no guard: the withdrawal again, then the site.
    await expect(executeSafePending(5)).rejects.toMatchObject({ code: 'SAFE_SITE_WITHDRAWN' });
    expect(mockWithdrawExecutionSite).toHaveBeenCalledTimes(2);
    expect(getPending(5).display).toEqual(DISPLAY);
    expect(mockExecTransaction).not.toHaveBeenCalled();
    console.warn.mockRestore();
  });

  test('a crash after the held execution lost its site: the next attempt repeats the no-op withdrawal, then takes the site', async () => {
    await startForSite();
    await signSafePending(5, 2);
    // As main finds it after the crash: the pending SafeTx still names the
    // site, and its held execution has none any more.
    mockWithdrawExecutionSite.mockResolvedValueOnce(false);
    await expect(executeSafePending(5)).rejects.toMatchObject({ code: 'SAFE_SITE_WITHDRAWN' });
    expect(mockWithdrawExecutionSite).toHaveBeenCalledWith(100, SAFE_TX_HASH);
    expect(getPending(5).display).toEqual(DISPLAY);
    // Now the wallet's: it executes, with no site recorded.
    await expect(executeSafePending(5)).resolves.toMatchObject({ status: 'executed' });
    expect(mockExecTransaction.mock.calls[0][0].record.origin).toBeUndefined();
  });

  test('a crash before either record changed: the next attempt withdraws both', async () => {
    await startForSite();
    await signSafePending(5, 2);
    // Nothing changed: no guard after the restart, and both still name the site.
    await expect(executeSafePending(5)).rejects.toMatchObject({ code: 'SAFE_SITE_WITHDRAWN' });
    expect(mockWithdrawExecutionSite).toHaveBeenCalledTimes(1);
    expect(getPending(5).display).toEqual(DISPLAY);
  });

  test('not sent after its commit, then withdrawn: the held execution loses its site too, its signatures kept', async () => {
    await startForSite();
    await signSafePending(5, 2);
    const stop = guardSiteSafeSend(SAFE_TX_HASH, async (effect) => effect());
    // The first attempt commits its execution, under the site, and is not sent.
    mockExecTransaction.mockImplementationOnce(async ({ guardCommit }) => {
      await guardCommit(async () => {});
      throw Object.assign(new Error('Myotis is not ready'), { outcome: 'not_sent' });
    });
    await expect(executeSafePending(5)).rejects.toThrow('Myotis is not ready');
    expect(getPending(5).display.site).toBe(SITE);
    expect(mockWithdrawExecutionSite).not.toHaveBeenCalled();
    // The page goes: no guard is left, and the retry is the wallet's.
    stop();
    await expect(executeSafePending(5)).rejects.toMatchObject({ code: 'SAFE_SITE_WITHDRAWN' });
    expect(mockWithdrawExecutionSite).toHaveBeenCalledWith(100, SAFE_TX_HASH);
    expect(getPending(5).display).toEqual(DISPLAY);
    expect(getPending(5).signatures).toHaveLength(2);
  });
});

describe('getAllSafeSendStates', () => {
  test('lists every pending SafeTx, oldest first', async () => {
    expect(getAllSafeSendStates()).toEqual([]);
    await start();
    const states = getAllSafeSendStates();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ safeIndex: 5, collected: 1, threshold: 2 });
  });
});
