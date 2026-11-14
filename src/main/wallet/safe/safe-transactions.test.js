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

// The identity core's `approval.end` (freedom-core design 0012): each call
// records what main still held then, so a test can check the order. And
// whether the core process that gave an approval has ended since.
const mockApprovalEnd = jest.fn(async () => ({}));
const mockProcessEnded = jest.fn(() => false);
jest.mock('../../core/vault-backend', () => ({
  vaultBackend: {
    approval: { end: (...args) => mockApprovalEnd(...args) },
    coreProcess: () => ({ process: 'core' }),
    coreProcessEnded: (...args) => mockProcessEnded(...args),
  },
}));

// Chain reads (the Safe nonce guard).
const mockRpcRequest = jest.fn(async () => '0x3'); // == pending nonce → executable
jest.mock('../provider-manager', () => ({
  getEip1193Provider: () => ({ request: (...args) => mockRpcRequest(...args) }),
}));

const {
  startSafeSend,
  reserveSafeSend,
  signSafePending,
  executeSafePending,
  getSafeSendState,
  getAllSafeSendStates,
  cancelSafeSend,
  onSafeSendSettled,
  guardSiteSafeSend,
} = require('./safe-transactions');
const { getPending, setPending, clearPending } = require('./pending-store');
const safeApprovals = require('./safe-approvals');

// A Safe approval as the core gives one at a `safe-send` spend: the
// wallet's (no page), or a page's with its PageContext.
const PAGE = Object.freeze({ origin: 'https://app.example', top_origin: 'https://app.example', frame: 3, navigation: 8, agent: false });
let approvalCount = 0;
const newApproval = (page = null) => ({ id: (++approvalCount).toString(16).padStart(32, '0'), page });
const endedIds = () => mockApprovalEnd.mock.calls.map(([id]) => id);

const DISPLAY = {
  toAddress: OWNERS[2],
  asset: null,
  amount: '1000',
  symbol: 'xDAI',
  decimals: 18,
  formattedAmount: '0.000000000000001',
};
const TX = { to: OWNERS[2], value: '1000', data: '0x' };

// A send as both routes start one: the Safe's SafeTx reserved before its
// token is spent, and held until it has started (or failed to).
const reserved = async (options) => {
  const reservation = reserveSafeSend(options.safeIndex);
  try {
    return await startSafeSend({ ...options, reservation });
  } finally {
    reservation.release();
  }
};

let lastApproval = null;
const start = (safeIndex = 5, chainId = 100, approval = newApproval()) => {
  lastApproval = approval;
  return reserved({ safeIndex, tx: TX, display: DISPLAY, chainId, approval });
};
const busy = () => Object.assign(new Error('Too many requests'), { code: 'busy' });

beforeEach(() => {
  mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-pending-'));
  jest.clearAllMocks();
  mockIsVaultUnlocked.mockResolvedValue(true);
  mockRpcRequest.mockResolvedValue('0x3');
  mockApprovalEnd.mockReset().mockResolvedValue({});
  mockProcessEnded.mockReset().mockReturnValue(false);
  for (const index of [5, 6, 7]) clearPending(index);
  safeApprovals._reset({ retryDelays: [0, 0] });
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
    // presenting the SafeTx's approval (design 0012)
    expect(mockCollectOwnerSignature).toHaveBeenCalledWith({
      typedData: builtResult.typedData,
      ownerIndex: 0,
      approval: lastApproval,
    });
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
    await expect(reserved({ safeIndex: 5, tx: TX, display: DISPLAY, approval: newApproval() }))
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

    expect(mockCollectOwnerSignature).toHaveBeenCalledWith({
      typedData: builtResult.typedData,
      ownerIndex: 2,
      approval: lastApproval,
    });
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
    await expect(cancelSafeSend(5)).rejects.toThrow(/current step/i);

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
      // The executor presents the SafeTx's approval (design 0012).
      approval: lastApproval,
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
    await cancelSafeSend(5);
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
    await cancelSafeSend(5, { safeTxHash: SAFE_TX_HASH });
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
    await expect(cancelSafeSend(5, { safeTxHash: OTHER })).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    expect(getPending(5).signatures).toHaveLength(2);
    // Not busy after a refusal: the SafeTx named executes.
    await expect(executeSafePending(5, { safeTxHash: SAFE_TX_HASH })).resolves.toMatchObject({ status: 'executed' });
  });

  test('none pending: a named discard is refused', async () => {
    await expect(cancelSafeSend(5, { safeTxHash: SAFE_TX_HASH })).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    await expect(cancelSafeSend(5)).resolves.toBeUndefined();
  });
});

describe('getSafeSendState / cancelSafeSend', () => {
  test('null when nothing is pending; cancel clears', async () => {
    expect(getSafeSendState(5)).toBeNull();
    await start();
    expect(getSafeSendState(5)).not.toBeNull();
    await cancelSafeSend(5);
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
    await cancelSafeSend(5);
    expect(heard.at(-1)).toEqual({ safeIndex: 5, safeTxHash: SAFE_TX_HASH, outcome: 'discarded' });
    // Nothing pending: nothing to hear.
    await cancelSafeSend(5);
    expect(heard).toHaveLength(2);

    stop();
    stopThrowing();
    await start();
    await cancelSafeSend(5);
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
    reserved({ safeIndex: 5, tx: TX, display: { ...DISPLAY, site: SITE }, chainId: 100, approval: newApproval(PAGE) });

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

// freedom-core design 0012, APB-1c: every signature of a SafeTx presents its
// Safe approval, and main ends it before each step that ends its effect.
describe("a SafeTx's Safe approval", () => {
  test('without one, nothing is built, and one given for no SafeTx is ended', async () => {
    await expect(startSafeSend({ safeIndex: 5, tx: TX, display: DISPLAY, chainId: 100 })).rejects.toThrow(/not confirmed/);
    expect(mockBuildSafeTransaction).not.toHaveBeenCalled();
    // Nor without the Safe's reservation, taken before its token was spent.
    const unreserved = newApproval();
    await expect(startSafeSend({ safeIndex: 5, tx: TX, display: DISPLAY, chainId: 100, approval: unreserved })).rejects.toThrow(
      /not reserved/
    );
    const other = reserveSafeSend(6);
    const second = newApproval();
    await expect(
      startSafeSend({ safeIndex: 5, tx: TX, display: DISPLAY, chainId: 100, approval: second, reservation: other })
    ).rejects.toThrow(/not reserved/);
    other.release();
    expect(mockBuildSafeTransaction).not.toHaveBeenCalled();
    expect(endedIds()).toEqual([unreserved.id, second.id]);
    mockApprovalEnd.mockClear();
    await start();
    const third = newApproval();
    await expect(start(6, 100, third)).rejects.toThrow(/activate/i);
    clearPending(5);
    safeApprovals._reset();
    mockBuildSafeTransaction.mockRejectedValueOnce(new Error('rpc down'));
    const fourth = newApproval();
    await expect(start(5, 100, fourth)).rejects.toThrow('rpc down');
    expect(endedIds()).toEqual([third.id, fourth.id]);
  });

  test("a page's is held with its PageContext, for its SafeTx only", async () => {
    const approval = newApproval(PAGE);
    await start(5, 100, approval);
    expect(safeApprovals.held('send', 5, SAFE_TX_HASH)).toEqual({ id: approval.id, page: PAGE });
    expect(safeApprovals.held('send', 5, '0x' + 'ee'.repeat(32))).toBeNull();
  });

  test('none held (a restart since): no free signature, an owner refused before any ceremony, until it is confirmed again', async () => {
    await start();
    safeApprovals._reset(); // main restarted: it holds none, as the core holds none
    mockCollectOwnerSignature.mockClear();
    await expect(signSafePending(5)).resolves.toMatchObject({ collected: 1 });
    await expect(signSafePending(5, 2)).rejects.toMatchObject({ code: 'SAFE_APPROVAL_NEEDED' });
    expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
    // A page's approval is never taken as a new confirmation: the wallet's only.
    const pageApproval = newApproval(PAGE);
    await expect(signSafePending(5, 2, { approval: pageApproval })).rejects.toThrow(/not confirmed/);
    expect(endedIds()).toEqual([pageApproval.id]);
    const fresh = newApproval();
    await expect(signSafePending(5, 2, { safeTxHash: SAFE_TX_HASH, approval: fresh })).resolves.toMatchObject({ collected: 2 });
    expect(mockCollectOwnerSignature).toHaveBeenCalledWith(expect.objectContaining({ ownerIndex: 2, approval: fresh }));
    expect(safeApprovals.held('send', 5, SAFE_TX_HASH)).toEqual(fresh);
  });

  test("a site's SafeTx its request still holds isn't confirmed again as the wallet's", async () => {
    await reserved({
      safeIndex: 5,
      tx: TX,
      display: { ...DISPLAY, site: 'https://app.example' },
      chainId: 100,
      approval: newApproval(PAGE),
    });
    const stop = guardSiteSafeSend(SAFE_TX_HASH, async (execute) => execute());
    try {
      safeApprovals._reset();
      const fresh = newApproval();
      await expect(signSafePending(5, 2, { approval: fresh })).rejects.toThrow(/still holds it/);
      expect(endedIds()).toEqual([fresh.id]);
    } finally {
      stop();
    }
    // Its request ended: it can be.
    await expect(signSafePending(5, 2, { approval: newApproval() })).resolves.toMatchObject({ collected: 2 });
  });

  test('one the core no longer knows is forgotten, and the owner asks for a new confirmation', async () => {
    await start();
    mockCollectOwnerSignature.mockRejectedValueOnce(
      Object.assign(new Error('Signing was not confirmed: unknown'), { code: 'SIGNING_NOT_CONFIRMED', reason: 'unknown_token' })
    );
    await expect(signSafePending(5, 2)).rejects.toMatchObject({ code: 'SAFE_APPROVAL_NEEDED' });
    expect(safeApprovals.held('send', 5, SAFE_TX_HASH)).toBeNull();
  });

  test('ended before its discard, the Safe held meanwhile', async () => {
    await start();
    const approval = lastApproval;
    mockApprovalEnd.mockImplementationOnce(async () => {
      expect(getPending(5)).not.toBeNull();
      await expect(signSafePending(5, 2)).rejects.toMatchObject({ code: 'SAFE_BUSY' });
      return {};
    });
    await cancelSafeSend(5);
    expect(mockApprovalEnd).toHaveBeenCalledWith(approval.id, null);
    expect(getPending(5)).toBeNull();
    expect(safeApprovals.held('send', 5, SAFE_TX_HASH)).toBeNull();
  });

  test("a page's ended under its page, before it is marked superseded", async () => {
    const approval = newApproval(PAGE);
    await start(5, 100, approval);
    await signSafePending(5, 2);
    mockRpcRequest.mockResolvedValue('0x4');
    mockApprovalEnd.mockImplementationOnce(async () => {
      expect(getPending(5).superseded).toBeFalsy();
      return {};
    });
    await expect(executeSafePending(5)).resolves.toMatchObject({ status: 'superseded' });
    expect(mockApprovalEnd).toHaveBeenCalledWith(approval.id, PAGE);
    expect(mockExecTransaction).not.toHaveBeenCalled();
  });

  test('ended once executed, before its entry is cleared; not after a failed execution', async () => {
    await start();
    const approval = lastApproval;
    await signSafePending(5, 2);
    mockExecTransaction.mockRejectedValueOnce(new Error('rpc down'));
    await expect(executeSafePending(5)).rejects.toThrow('rpc down');
    expect(mockApprovalEnd).not.toHaveBeenCalled();
    mockApprovalEnd.mockImplementationOnce(async () => {
      expect(getPending(5)).not.toBeNull();
      return {};
    });
    await expect(executeSafePending(5)).resolves.toMatchObject({ status: 'executed' });
    expect(endedIds()).toEqual([approval.id]);
    expect(getPending(5)).toBeNull();
  });

  test('with none held, the executor is given none (its fee is asked as an executor-send)', async () => {
    await start();
    await signSafePending(5, 2);
    safeApprovals._reset();
    await executeSafePending(5);
    expect(mockExecTransaction).toHaveBeenCalledWith(expect.objectContaining({ approval: null }));
  });
  // Review of #1245, round 1: a new send reserves the Safe's SafeTx before
  // its token is spent, so a second one is refused before it spends its own.
  test("a send's reservation: one per Safe, refused while a SafeTx is pending, given up by its own release only", async () => {
    const codeOf = (fn) => {
      try {
        fn();
      } catch (err) {
        return err.code;
      }
      return null;
    };
    const first = reserveSafeSend(5);
    expect(codeOf(() => reserveSafeSend(5))).toBe('SAFE_PENDING_EXISTS');
    // Another Safe's is its own.
    reserveSafeSend(6).release();
    const approval = newApproval();
    await startSafeSend({ safeIndex: 5, tx: TX, display: DISPLAY, chainId: 100, approval, reservation: first });
    first.release();
    // Pending now: refused as pending.
    expect(codeOf(() => reserveSafeSend(5))).toBe('SAFE_PENDING_EXISTS');
    expect(endedIds()).toEqual([]);
    expect(safeApprovals.held('send', 5, SAFE_TX_HASH)).toEqual(approval);
    // A release given again never gives up a later send's reservation.
    await cancelSafeSend(5);
    const next = reserveSafeSend(5);
    first.release();
    expect(codeOf(() => reserveSafeSend(5))).toBe('SAFE_PENDING_EXISTS');
    next.release();
    expect(codeOf(() => reserveSafeSend(5).release())).toBeNull();
  });

  // Review of #1245, round 1: a free signature's entry is checked again
  // after its await, so one cleared meanwhile isn't written back.
  test("a SafeTx cleared while a free signature is made (its Safe deleted) isn't written back", async () => {
    const signing = deferred();
    mockCollectOwnerSignature.mockImplementationOnce(() => signing.promise);
    const started = start();
    await flushMicrotasks();
    expect(getPending(5)).not.toBeNull();
    clearPending(5);
    signing.resolve(signatureOf(0));
    await started;
    expect(getPending(5)).toBeNull();
  });

  // Review of #1245, round 1: an end the core didn't confirm, while the
  // process that gave the approval still runs, is an error, and nothing
  // that waited on it happens.
  describe('an end that fails', () => {
    let heard;
    let stop;
    beforeEach(async () => {
      heard = [];
      stop = onSafeSendSettled((event) => heard.push(event));
      await start();
      await signSafePending(5, 2);
      mockApprovalEnd.mockRejectedValue(busy());
    });
    afterEach(() => stop());

    test('no discard, and not marked superseded: the SafeTx and its approval stay', async () => {
      const approval = lastApproval;
      await expect(cancelSafeSend(5)).rejects.toMatchObject({ code: 'SAFE_APPROVAL_END_FAILED' });
      expect(getPending(5)).not.toBeNull();
      expect(safeApprovals.held('send', 5, SAFE_TX_HASH)).toEqual(approval);
      mockRpcRequest.mockResolvedValueOnce('0x4');
      await expect(executeSafePending(5)).rejects.toMatchObject({ code: 'SAFE_APPROVAL_END_FAILED' });
      expect(getPending(5).superseded).toBeFalsy();
      expect(heard).toEqual([]);
      // The process that gave it has ended (a restart): its approval with it.
      mockProcessEnded.mockReturnValue(true);
      await cancelSafeSend(5);
      expect(getPending(5)).toBeNull();
      expect(heard).toEqual([expect.objectContaining({ outcome: 'discarded' })]);
    });

    test('executed: kept, marked so, and the next attempt finishes it without executing again', async () => {
      await expect(executeSafePending(5)).rejects.toMatchObject({ code: 'SAFE_APPROVAL_END_FAILED' });
      expect(mockExecTransaction).toHaveBeenCalledTimes(1);
      expect(getPending(5).executed).toEqual({ hash: TX_HASH, explorerUrl: `https://gnosisscan.io/tx/${TX_HASH}` });
      expect(heard).toEqual([]);
      mockApprovalEnd.mockReset().mockResolvedValue({});
      await expect(executeSafePending(5)).resolves.toMatchObject({ status: 'executed', executed: { hash: TX_HASH } });
      expect(mockExecTransaction).toHaveBeenCalledTimes(1);
      expect(getPending(5)).toBeNull();
      expect(heard).toEqual([expect.objectContaining({ outcome: 'executed', hash: TX_HASH })]);
    });

    test('executed, then discarded: its outcome is still the execution', async () => {
      await expect(executeSafePending(5)).rejects.toMatchObject({ code: 'SAFE_APPROVAL_END_FAILED' });
      mockApprovalEnd.mockReset().mockResolvedValue({});
      await cancelSafeSend(5);
      expect(getPending(5)).toBeNull();
      expect(heard).toEqual([expect.objectContaining({ outcome: 'executed', hash: TX_HASH })]);
    });
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
