const { ownerWallet } = require('./__tests__/helpers/test-owners');

const OWNERS = [ownerWallet(0).address, ownerWallet(2).address, ownerWallet(4).address];
const SAFE_ADDRESS = '0x41aD4887971f90BB3fE4d83eCa65177281283261';
const OTHER_ADDRESS = '0x000000000000000000000000000000000000dEaD';

// Records as vault-meta stores them: `deployed` holds the stored marks,
// which the record seam filters as identity-manager's does (#1066), and
// markSafeDeployed writes the verified mark.
const mockWalletRecords = {
  0: { index: 0, name: 'Main Wallet', address: OWNERS[0], type: 'mnemonic' },
  2: { index: 2, name: 'My Stax', address: OWNERS[1], type: 'ledger' },
  4: { index: 4, name: 'My Phone', address: OWNERS[2], type: 'remote' },
  5: {
    index: 5,
    name: 'Joint',
    address: SAFE_ADDRESS,
    type: 'safe',
    owners: [0, 2],
    threshold: 1,
    saltNonce: '7508',
    deployed: {},
  },
};

const mockAddSafeWallet = jest.fn(async (name, params) => ({ index: 9, name, type: 'safe', ...params }));
const mockMarkSafeDeployed = jest.fn(async (index, chainId) => {
  const { verifiedDeployedMark } = jest.requireActual('./deployed-mark');
  const record = mockWalletRecords[index];
  record.deployed = { ...record.deployed, [chainId]: verifiedDeployedMark() };
});
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
    addSafeWallet: (...args) => mockAddSafeWallet(...args),
    markSafeDeployed: (...args) => mockMarkSafeDeployed(...args),
    WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
  };
});

const mockPredictSafeAddress = jest.fn(async () => SAFE_ADDRESS);
const mockBuildDeploymentTransaction = jest.fn(async () => ({
  safeAddress: SAFE_ADDRESS,
  to: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  value: '0',
  data: '0xdeadbeef',
}));
const mockDeploySafe = jest.fn(async () => ({ safeAddress: SAFE_ADDRESS, tx: { hash: '0x' + 'ab'.repeat(32) } }));
jest.mock('./safe-executor', () => ({
  predictSafeAddress: (...args) => mockPredictSafeAddress(...args),
  buildDeploymentTransaction: (...args) => mockBuildDeploymentTransaction(...args),
  deploySafe: (...args) => mockDeploySafe(...args),
  pickDefaultExecutor: jest.requireActual('./safe-executor').pickDefaultExecutor,
}));

const mockEstimateGas = jest.fn(async () => ({ gasLimit: '300000' }));
const mockGetGasPrices = jest.fn(async () => ({
  type: 'eip1559',
  maxFeePerGas: '2000000000', // cost = 300000 * 2 gwei = 0.0006 ether
  maxPriorityFeePerGas: '1000000000',
}));
// A receipt a verified source gave, unless a test says otherwise.
const mockWaitForTransaction = jest.fn(async () => ({ status: 'confirmed', verified: true }));
jest.mock('../transaction-service', () => ({
  estimateGas: (...args) => mockEstimateGas(...args),
  getGasPrices: (...args) => mockGetGasPrices(...args),
  // the pure fee-shape mapper stays real so its behaviour is under test
  toFeeFields: jest.requireActual('../transaction-service').toFeeFields,
  waitForTransaction: (...args) => mockWaitForTransaction(...args),
}));

// Raw chain reads: eth_getBalance.
const mockRpcRequest = jest.fn();
jest.mock('../provider-manager', () => ({
  getEip1193Provider: () => ({ request: (...args) => mockRpcRequest(...args) }),
}));

// Deployment truth: eth_getCode through the core's chain router, with its
// label.
const mockChainRequest = jest.fn();
jest.mock('../../networks/chain-data', () => ({
  request: (...args) => mockChainRequest(...args),
}));

const {
  DEPLOY_CHAIN_ID,
  createSafeAccount,
  getSafeRecord,
  getSafeStatus,
  activateSafe,
  isMarkedDeployed,
} = require('./safe-service');

const DEPLOY_COST = 300000n * 2000000000n; // gasLimit × maxFeePerGas

function stubChainState({ code = '0x', balance = 0n, verified = true } = {}) {
  mockRpcRequest.mockImplementation(async ({ method }) => {
    if (method === 'eth_getBalance') return '0x' + balance.toString(16);
    throw new Error(`unexpected rpc ${method}`);
  });
  mockChainRequest.mockImplementation(async (chainId, method) => {
    if (method === 'eth_getCode') {
      return { result: code, source: verified ? 'colibri' : 'direct', verified };
    }
    throw new Error(`unexpected chain read ${method}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWalletRecords[5].deployed = {};
  stubChainState();
});

/**
 * eth_getCode answers in order, one per read (the last one repeats), each
 * `{ code, verified }`.
 */
function stubCodeReads(answers, { balance = DEPLOY_COST * 2n } = {}) {
  stubChainState({ balance });
  const queue = [...answers];
  mockChainRequest.mockImplementation(async (chainId, method) => {
    if (method !== 'eth_getCode') throw new Error(`unexpected chain read ${method}`);
    const { code, verified } = queue.length > 1 ? queue.shift() : queue[0];
    return { result: code, source: verified ? 'myotis' : 'direct', verified };
  });
}

describe('createSafeAccount', () => {
  test('predicts the address from resolved owner addresses and stores the record', async () => {
    const wallet = await createSafeAccount({ name: 'Joint', ownerIndexes: [0, 2], threshold: 1 });

    const predictArgs = mockPredictSafeAddress.mock.calls[0][0];
    expect(predictArgs.owners).toEqual([OWNERS[0], OWNERS[1]]);
    expect(predictArgs.threshold).toBe(1);
    expect(predictArgs.chainId).toBe(DEPLOY_CHAIN_ID);
    expect(predictArgs.saltNonce).toMatch(/^\d+$/);

    const [name, stored] = mockAddSafeWallet.mock.calls[0];
    expect(name).toBe('Joint');
    expect(stored).toEqual({
      address: SAFE_ADDRESS,
      owners: [0, 2],
      threshold: 1,
      saltNonce: predictArgs.saltNonce,
    });
    expect(wallet.type).toBe('safe');
  });

  test('generates a fresh salt per account', async () => {
    await createSafeAccount({ name: 'A', ownerIndexes: [0, 2], threshold: 1 });
    await createSafeAccount({ name: 'B', ownerIndexes: [0, 2], threshold: 1 });
    const [saltA, saltB] = mockPredictSafeAddress.mock.calls.map(([args]) => args.saltNonce);
    expect(saltA).not.toBe(saltB);
  });

  test('rejects owners without a known address', async () => {
    mockWalletRecords[7] = { index: 7, name: 'Locked', address: null, type: 'mnemonic' };
    await expect(
      createSafeAccount({ name: 'Bad', ownerIndexes: [0, 7], threshold: 1 })
    ).rejects.toThrow(/Locked.*no address/i);
    delete mockWalletRecords[7];
  });
});

describe('getSafeStatus', () => {
  test('undeployed with a funded executor: no blocking state', async () => {
    stubChainState({ code: '0x', balance: DEPLOY_COST * 2n });

    const status = await getSafeStatus(5);

    expect(status).toEqual({
      deployed: false,
      chainId: DEPLOY_CHAIN_ID,
      executorIndex: 0,
      executorAddress: OWNERS[0],
      executorBalance: (DEPLOY_COST * 2n).toString(),
      estimatedCost: DEPLOY_COST.toString(),
      needsFunds: false,
    });
    // gas was estimated against the real deployment calldata
    expect(mockEstimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ from: OWNERS[0], data: '0xdeadbeef', chainId: DEPLOY_CHAIN_ID })
    );
  });

  test('undeployed with a broke executor: needsFunds blocks', async () => {
    stubChainState({ code: '0x', balance: DEPLOY_COST - 1n });
    const status = await getSafeStatus(5);
    expect(status.needsFunds).toBe(true);
  });

  test('verified code on chain marks the record deployed (self-heal) and skips the quote', async () => {
    stubChainState({ code: '0x60806040' });

    const status = await getSafeStatus(5);

    expect(status.deployed).toBe(true);
    expect(status.needsFunds).toBe(false);
    expect(status.estimatedCost).toBeNull();
    expect(mockChainRequest).toHaveBeenCalledWith(DEPLOY_CHAIN_ID, 'eth_getCode', [
      SAFE_ADDRESS,
      'latest',
    ]);
    expect(mockMarkSafeDeployed).toHaveBeenCalledWith(5, DEPLOY_CHAIN_ID);
    expect(mockEstimateGas).not.toHaveBeenCalled();
  });

  test('unverified code marks nothing, and the next check asks again (#1066)', async () => {
    stubChainState({ code: '0x60806040', verified: false });

    await expect(getSafeStatus(5)).rejects.toMatchObject({
      code: 'SAFE_UNVERIFIED',
      message: /couldn't verify/,
    });
    expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
    // not offered for activation either: the Safe may be deployed
    expect(mockBuildDeploymentTransaction).not.toHaveBeenCalled();
    expect(mockEstimateGas).not.toHaveBeenCalled();

    // A label other than `true` is no verification either.
    mockChainRequest.mockResolvedValueOnce({ result: '0x60806040', source: 'direct' });
    await expect(getSafeStatus(5)).rejects.toMatchObject({ code: 'SAFE_UNVERIFIED' });
    expect(mockMarkSafeDeployed).not.toHaveBeenCalled();

    // Later a verified source answers, and that read marks it.
    stubChainState({ code: '0x60806040', verified: true });
    const status = await getSafeStatus(5);
    expect(status.deployed).toBe(true);
    expect(mockMarkSafeDeployed).toHaveBeenCalledWith(5, DEPLOY_CHAIN_ID);
    expect(mockChainRequest).toHaveBeenCalledTimes(3);
  });

  test('an unverified "no code" answer leaves the Safe undeployed and offers activation', async () => {
    stubChainState({ code: '0x', verified: false, balance: DEPLOY_COST * 2n });
    const status = await getSafeStatus(5);
    expect(status.deployed).toBe(false);
    expect(status.needsFunds).toBe(false);
    expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
  });

  test('a deployment to another address than the record\'s is not quoted (#1066)', async () => {
    stubChainState({ code: '0x', balance: DEPLOY_COST * 2n });
    mockBuildDeploymentTransaction.mockResolvedValueOnce({
      safeAddress: OTHER_ADDRESS,
      to: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
      value: '0',
      data: '0xdeadbeef',
    });
    await expect(getSafeStatus(5)).rejects.toMatchObject({ code: 'SAFE_ADDRESS_MISMATCH' });
    expect(mockEstimateGas).not.toHaveBeenCalled();
  });

  test('record already marked deployed skips the chain read entirely', async () => {
    mockWalletRecords[5].deployed = { [DEPLOY_CHAIN_ID]: { verified: true } };
    const status = await getSafeStatus(5);
    expect(status.deployed).toBe(true);
    expect(mockRpcRequest).not.toHaveBeenCalled();
    expect(mockChainRequest).not.toHaveBeenCalled();
  });

  test('a deployed mark of a release before #1066 is read again, and only a verified read accepts it', async () => {
    // One endpoint's eth_getCode answer was enough to store this bare mark.
    mockWalletRecords[5].deployed = { [DEPLOY_CHAIN_ID]: true };
    expect(isMarkedDeployed(getSafeRecord(5))).toBe(false);

    // The chain is asked again; unverified code doesn't make it deployed.
    stubChainState({ code: '0x60806040', verified: false });
    await expect(getSafeStatus(5)).rejects.toMatchObject({ code: 'SAFE_UNVERIFIED' });
    expect(mockChainRequest).toHaveBeenCalledWith(DEPLOY_CHAIN_ID, 'eth_getCode', [
      SAFE_ADDRESS,
      'latest',
    ]);
    expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
    // Still pending, and the record is kept as it was.
    expect(mockWalletRecords[5].deployed).toEqual({ [DEPLOY_CHAIN_ID]: true });
    expect(isMarkedDeployed(getSafeRecord(5))).toBe(false);

    // A verified read marks it, and later checks need no read.
    stubChainState({ code: '0x60806040', verified: true });
    await expect(getSafeStatus(5)).resolves.toMatchObject({ deployed: true });
    expect(mockWalletRecords[5].deployed).toEqual({ [DEPLOY_CHAIN_ID]: { verified: true } });
    expect(isMarkedDeployed(getSafeRecord(5))).toBe(true);
    mockChainRequest.mockClear();
    await expect(getSafeStatus(5)).resolves.toMatchObject({ deployed: true });
    expect(mockChainRequest).not.toHaveBeenCalled();
  });

  test('a deployed mark of a release before #1066 with no code behind it offers activation', async () => {
    mockWalletRecords[5].deployed = { [DEPLOY_CHAIN_ID]: true };
    stubChainState({ code: '0x', balance: DEPLOY_COST * 2n });
    const status = await getSafeStatus(5);
    expect(status).toMatchObject({ deployed: false, needsFunds: false });
    expect(status.estimatedCost).toBe(DEPLOY_COST.toString());
    expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
  });

  test('a safe with no local gas-paying owner reports executorIndex null', async () => {
    mockWalletRecords[6] = { ...mockWalletRecords[5], index: 6, owners: [2, 4] };
    const status = await getSafeStatus(6);
    expect(status.executorIndex).toBeNull();
    expect(status.needsFunds).toBe(true);
    delete mockWalletRecords[6];
  });

  test('rejects non-safe accounts', async () => {
    await expect(getSafeStatus(0)).rejects.toThrow(/not a Safe/i);
  });
});

describe('activateSafe', () => {
  test('deploys with frozen init params, waits for confirmation, marks deployed', async () => {
    stubChainState({ code: '0x', balance: DEPLOY_COST * 2n });

    const result = await activateSafe(5);

    expect(mockDeploySafe).toHaveBeenCalledWith({
      owners: [OWNERS[0], OWNERS[1]],
      threshold: 1,
      saltNonce: '7508',
      chainId: DEPLOY_CHAIN_ID,
      executorIndex: 0,
      // no fee confirmation: the executor's fee is judged as it is signed
      feeConfirmation: null,
      // the quoted deployment is reused — no second protocol-kit build
      deployment: await mockBuildDeploymentTransaction.mock.results[0].value,
      // the deploy lands in payment history
      record: {
        kind: 'safe-deploy',
        toAddress: SAFE_ADDRESS,
        amount: '0',
        metadata: { safeAddress: SAFE_ADDRESS },
      },
    });
    expect(mockBuildDeploymentTransaction).toHaveBeenCalledTimes(1);
    expect(mockWaitForTransaction).toHaveBeenCalledWith('0x' + 'ab'.repeat(32), DEPLOY_CHAIN_ID);
    expect(mockMarkSafeDeployed).toHaveBeenCalledWith(5, DEPLOY_CHAIN_ID);
    expect(result).toEqual({ safeAddress: SAFE_ADDRESS, hash: '0x' + 'ab'.repeat(32) });
  });

  test('blocks with SAFE_NEEDS_FUNDS when the executor cannot pay', async () => {
    stubChainState({ code: '0x', balance: 0n });

    await expect(activateSafe(5)).rejects.toMatchObject({ code: 'SAFE_NEEDS_FUNDS' });
    expect(mockDeploySafe).not.toHaveBeenCalled();
  });

  test('is a no-op when already deployed', async () => {
    stubChainState({ code: '0x60806040' });
    const result = await activateSafe(5);
    expect(result).toEqual({ safeAddress: SAFE_ADDRESS, alreadyDeployed: true });
    expect(mockDeploySafe).not.toHaveBeenCalled();
  });

  test('refuses, with nothing sent, a deployment to another address than the record\'s (#1066)', async () => {
    stubChainState({ code: '0x', balance: DEPLOY_COST * 2n });
    // e.g. a record whose address came from a wrong proxyCreationCode()
    // answer before #1066: the init params now derive another address.
    mockBuildDeploymentTransaction.mockResolvedValueOnce({
      safeAddress: OTHER_ADDRESS,
      to: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
      value: '0',
      data: '0xdeadbeef',
    });

    await expect(activateSafe(5)).rejects.toMatchObject({
      code: 'SAFE_ADDRESS_MISMATCH',
      message: new RegExp(`${SAFE_ADDRESS}.*${OTHER_ADDRESS}`),
    });
    expect(mockDeploySafe).not.toHaveBeenCalled();
    expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
  });

  test('neither deploys nor marks on unverified code at the address (#1066)', async () => {
    stubChainState({ code: '0x60806040', verified: false, balance: DEPLOY_COST * 2n });
    await expect(activateSafe(5)).rejects.toMatchObject({ code: 'SAFE_UNVERIFIED' });
    expect(mockDeploySafe).not.toHaveBeenCalled();
    expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
  });

  test('does not mark deployed when the deploy tx fails', async () => {
    stubChainState({ code: '0x', balance: DEPLOY_COST * 2n });
    mockWaitForTransaction.mockResolvedValueOnce({ status: 'failed' });

    await expect(activateSafe(5)).rejects.toThrow(/failed/i);
    expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
  });

  test('re-reads a deployed mark of a release before #1066, and refuses while unverified', async () => {
    mockWalletRecords[5].deployed = { [DEPLOY_CHAIN_ID]: true };
    stubChainState({ code: '0x60806040', verified: false, balance: DEPLOY_COST * 2n });
    await expect(activateSafe(5)).rejects.toMatchObject({ code: 'SAFE_UNVERIFIED' });
    expect(mockChainRequest).toHaveBeenCalledWith(DEPLOY_CHAIN_ID, 'eth_getCode', [
      SAFE_ADDRESS,
      'latest',
    ]);
    expect(mockDeploySafe).not.toHaveBeenCalled();
    expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
  });

  test('an unverified receipt marks nothing, and the Safe stays pending (#1066)', async () => {
    // The receipt came from one endpoint, and no verified source sees the
    // Safe's code yet: a dishonest broadcaster's receipt looks like this.
    stubCodeReads([{ code: '0x', verified: true }]);
    mockWaitForTransaction.mockResolvedValueOnce({ status: 'confirmed', verified: false });

    await expect(activateSafe(5)).rejects.toMatchObject({
      code: 'SAFE_UNVERIFIED',
      message: /sent the activation, but couldn't verify/,
    });
    expect(mockDeploySafe).toHaveBeenCalledTimes(1);
    expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
    // The verified read after the receipt is what was asked.
    expect(mockChainRequest).toHaveBeenCalledTimes(2);
    expect(isMarkedDeployed(getSafeRecord(5))).toBe(false);

    // Neither does a receipt with no label, or code no verified source confirms.
    for (const [receipt, code] of [
      [{ status: 'confirmed' }, { code: '0x', verified: true }],
      [{ status: 'confirmed', verified: false }, { code: '0x60806040', verified: false }],
      [{ status: 'confirmed', verified: 'true' }, { code: '0x60806040' }],
    ]) {
      jest.clearAllMocks();
      stubCodeReads([{ code: '0x', verified: true }, code]);
      mockWaitForTransaction.mockResolvedValueOnce(receipt);
      await expect(activateSafe(5)).rejects.toMatchObject({ code: 'SAFE_UNVERIFIED' });
      expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
    }

    // The next status check reads again, and a verified read marks it.
    stubCodeReads([{ code: '0x60806040', verified: true }]);
    await expect(getSafeStatus(5)).resolves.toMatchObject({ deployed: true });
    expect(mockMarkSafeDeployed).toHaveBeenCalledWith(5, DEPLOY_CHAIN_ID);
  });

  test('a failed verification read after an unverified receipt leaves the Safe pending', async () => {
    stubCodeReads([{ code: '0x', verified: true }]);
    mockChainRequest
      .mockResolvedValueOnce({ result: '0x', source: 'myotis', verified: true })
      .mockRejectedValueOnce(new Error('No chain source left for eth_getCode'));
    mockWaitForTransaction.mockResolvedValueOnce({ status: 'confirmed', verified: false });
    await expect(activateSafe(5)).rejects.toMatchObject({ code: 'SAFE_UNVERIFIED' });
    expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
  });

  test('an unverified receipt with a verified read of the code marks deployed', async () => {
    stubCodeReads([
      { code: '0x', verified: true },
      { code: '0x60806040', verified: true },
    ]);
    mockWaitForTransaction.mockResolvedValueOnce({ status: 'confirmed', verified: false });

    const result = await activateSafe(5);

    expect(result).toEqual({ safeAddress: SAFE_ADDRESS, hash: '0x' + 'ab'.repeat(32) });
    expect(mockChainRequest).toHaveBeenCalledTimes(2);
    expect(mockMarkSafeDeployed).toHaveBeenCalledWith(5, DEPLOY_CHAIN_ID);
    expect(isMarkedDeployed(getSafeRecord(5))).toBe(true);
  });

  test('a verified receipt marks deployed with no further read', async () => {
    stubCodeReads([{ code: '0x', verified: true }]);

    await activateSafe(5);

    expect(mockChainRequest).toHaveBeenCalledTimes(1); // the status read only
    expect(mockMarkSafeDeployed).toHaveBeenCalledWith(5, DEPLOY_CHAIN_ID);
    expect(mockWalletRecords[5].deployed).toEqual({ [DEPLOY_CHAIN_ID]: { verified: true } });
  });
});

describe('isMarkedDeployed', () => {
  test('accepts only a verified mark as the record seam exposes it', () => {
    expect(isMarkedDeployed({ deployed: { [DEPLOY_CHAIN_ID]: true } })).toBe(true);
    expect(isMarkedDeployed({ deployed: { [DEPLOY_CHAIN_ID]: true } }, 8453)).toBe(false);
    expect(isMarkedDeployed({ deployed: {} })).toBe(false);
    expect(isMarkedDeployed({})).toBe(false);
    expect(isMarkedDeployed({ deployed: { [DEPLOY_CHAIN_ID]: 'true' } })).toBe(false);
  });
});
