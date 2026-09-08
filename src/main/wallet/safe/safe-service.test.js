const { ownerWallet } = require('./__tests__/helpers/test-owners');

const OWNERS = [ownerWallet(0).address, ownerWallet(2).address, ownerWallet(4).address];
const SAFE_ADDRESS = '0x41aD4887971f90BB3fE4d83eCa65177281283261';

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
const mockMarkSafeDeployed = jest.fn(async () => {});
jest.mock('../../identity-manager', () => ({
  getWalletRecord: (index) => mockWalletRecords[index] || null,
  addSafeWallet: (...args) => mockAddSafeWallet(...args),
  markSafeDeployed: (...args) => mockMarkSafeDeployed(...args),
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));

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
const mockWaitForTransaction = jest.fn(async () => ({ status: 'confirmed' }));
jest.mock('../transaction-service', () => ({
  estimateGas: (...args) => mockEstimateGas(...args),
  getGasPrices: (...args) => mockGetGasPrices(...args),
  // the pure fee-shape mapper stays real so its behaviour is under test
  toFeeFields: jest.requireActual('../transaction-service').toFeeFields,
  waitForTransaction: (...args) => mockWaitForTransaction(...args),
}));

// Raw chain reads: eth_getCode (deployment truth) + eth_getBalance.
const mockRpcRequest = jest.fn();
jest.mock('../provider-manager', () => ({
  getEip1193Provider: () => ({ request: (...args) => mockRpcRequest(...args) }),
}));

const {
  DEPLOY_CHAIN_ID,
  createSafeAccount,
  getSafeStatus,
  activateSafe,
} = require('./safe-service');

const DEPLOY_COST = 300000n * 2000000000n; // gasLimit × maxFeePerGas

function stubChainState({ code = '0x', balance = 0n } = {}) {
  mockRpcRequest.mockImplementation(async ({ method }) => {
    if (method === 'eth_getCode') return code;
    if (method === 'eth_getBalance') return '0x' + balance.toString(16);
    throw new Error(`unexpected rpc ${method}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  stubChainState();
});

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

  test('code on chain marks the record deployed (self-heal) and skips the quote', async () => {
    stubChainState({ code: '0x60806040' });

    const status = await getSafeStatus(5);

    expect(status.deployed).toBe(true);
    expect(status.needsFunds).toBe(false);
    expect(status.estimatedCost).toBeNull();
    expect(mockMarkSafeDeployed).toHaveBeenCalledWith(5, DEPLOY_CHAIN_ID);
    expect(mockEstimateGas).not.toHaveBeenCalled();
  });

  test('record already marked deployed skips the chain read entirely', async () => {
    mockWalletRecords[5].deployed = { [DEPLOY_CHAIN_ID]: true };
    const status = await getSafeStatus(5);
    expect(status.deployed).toBe(true);
    expect(mockRpcRequest).not.toHaveBeenCalled();
    mockWalletRecords[5].deployed = {};
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

  test('does not mark deployed when the deploy tx fails', async () => {
    stubChainState({ code: '0x', balance: DEPLOY_COST * 2n });
    mockWaitForTransaction.mockResolvedValueOnce({ status: 'failed' });

    await expect(activateSafe(5)).rejects.toThrow(/failed/i);
    expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
  });
});
