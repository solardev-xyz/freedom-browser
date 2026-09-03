const { TypedDataEncoder, Interface, verifyTypedData } = require('ethers');

const { createStubChain, canonicalAddresses } = require('./__tests__/helpers/stub-chain');
const { ownerWallet, createTestSigner } = require('./__tests__/helpers/test-owners');
const { withoutDomainType } = require('../signing-utils');
const deployments = require('@safe-global/safe-deployments');
const { calculateSafeTransactionHash } = require('@safe-global/protocol-kit');

const OWNERS = [ownerWallet(0).address, ownerWallet(2).address, ownerWallet(4).address];

const mockWalletRecords = {
  0: { index: 0, name: 'Main Wallet', address: OWNERS[0], type: 'mnemonic' },
  2: { index: 2, name: 'My Stax', address: OWNERS[1], type: 'ledger' },
  4: { index: 4, name: 'My Phone', address: OWNERS[2], type: 'remote' },
};

// Wrapped in jest.fn so tests can count calls and override single owners.
const mockGetSigner = jest.fn(createTestSigner);

const mockEstimateGas = jest.fn(async () => ({ gasLimit: '150000' }));
const mockGetGasPrices = jest.fn(async () => ({
  type: 'eip1559',
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
}));
const mockSignAndSendTransaction = jest.fn(async () => ({ hash: '0x' + 'aa'.repeat(32) }));

jest.mock('../signers', () => ({
  getSigner: (...args) => mockGetSigner(...args),
}));
jest.mock('../transaction-service', () => ({
  estimateGas: (...args) => mockEstimateGas(...args),
  getGasPrices: (...args) => mockGetGasPrices(...args),
  // the pure fee-shape mapper stays real so its behaviour is under test
  toFeeFields: jest.requireActual('../transaction-service').toFeeFields,
  signAndSendTransaction: (...args) => mockSignAndSendTransaction(...args),
}));
const mockSignAndRecord = jest.fn(async () => ({ hash: '0x' + 'bb'.repeat(32), recorded: true }));
jest.mock('../tx-recorder', () => ({
  signAndRecord: (...args) => mockSignAndRecord(...args),
}));
jest.mock('../../identity-manager', () => ({
  getWalletRecord: (index) => mockWalletRecords[index] || null,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
jest.mock('../provider-manager', () => ({
  getEip1193Provider: () => {
    throw new Error('unit tests must inject a provider');
  },
}));

const {
  SAFE_VERSION,
  predictSafeAddress,
  buildDeploymentTransaction,
  buildSafeTransaction,
  collectOwnerSignature,
  execTransaction,
  deploySafe,
  pickDefaultExecutor,
} = require('./safe-executor');

jest.setTimeout(20000);

const INIT = { owners: OWNERS, threshold: 2, saltNonce: '7508' };
const gnosis = () => createStubChain({ chainId: 100 });

beforeEach(() => {
  mockGetSigner.mockClear();
  mockEstimateGas.mockClear();
  mockGetGasPrices.mockClear();
  mockSignAndSendTransaction.mockClear();
  mockSignAndRecord.mockClear();
});

describe('predictSafeAddress', () => {
  test('is deterministic and checksummed', async () => {
    const a = await predictSafeAddress({ ...INIT, chainId: 100, provider: gnosis() });
    const b = await predictSafeAddress({ ...INIT, chainId: 100, provider: gnosis() });
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(a).toBe(b);
  });

  test('same init params produce the same address on different chains (CREATE2 parity)', async () => {
    const onGnosis = await predictSafeAddress({ ...INIT, chainId: 100, provider: gnosis() });
    const onBase = await predictSafeAddress({
      ...INIT,
      chainId: 8453,
      provider: createStubChain({ chainId: 8453 }),
    });
    expect(onBase).toBe(onGnosis);
  });

  test('saltNonce and owner set both change the address', async () => {
    const base = await predictSafeAddress({ ...INIT, chainId: 100, provider: gnosis() });
    const otherSalt = await predictSafeAddress({
      ...INIT,
      saltNonce: '9999',
      chainId: 100,
      provider: gnosis(),
    });
    const otherOwners = await predictSafeAddress({
      ...INIT,
      owners: OWNERS.slice(0, 2),
      chainId: 100,
      provider: gnosis(),
    });
    expect(otherSalt).not.toBe(base);
    expect(otherOwners).not.toBe(base);
  });
});

describe('buildDeploymentTransaction', () => {
  test('targets the canonical SafeProxyFactory from the deployments registry', async () => {
    const tx = await buildDeploymentTransaction({ ...INIT, chainId: 100, provider: gnosis() });
    const factory = deployments.getProxyFactoryDeployment({ version: SAFE_VERSION }).defaultAddress;
    expect(tx.to).toBe(factory);
    expect(canonicalAddresses()).toContain(tx.to);
    expect(tx.value).toBe('0');
    expect(tx.data.length).toBeGreaterThan(10);
    expect(tx.safeAddress).toBe(await predictSafeAddress({ ...INIT, chainId: 100, provider: gnosis() }));
  });
});

describe('buildSafeTransaction', () => {
  const TX = { to: OWNERS[0], value: '1000', data: '0x' };

  test('counterfactual safe: nonce 0, predicted address, not deployed', async () => {
    const built = await buildSafeTransaction({
      chainId: 100,
      safe: INIT,
      tx: TX,
      provider: gnosis(),
    });
    const predicted = await predictSafeAddress({ ...INIT, chainId: 100, provider: gnosis() });
    expect(built.safeAddress).toBe(predicted);
    expect(built.deployed).toBe(false);
    expect(built.safeTxData.nonce).toBe(0);
    expect(built.safeTxData.to).toBe(TX.to);
    expect(built.safeTxData.value).toBe(TX.value);
    expect(built.safeTxData.operation).toBe(0);
  });

  test('deployed safe: nonce comes from the chain', async () => {
    const address = await predictSafeAddress({ ...INIT, chainId: 100, provider: gnosis() });
    const provider = createStubChain({
      chainId: 100,
      deployedSafes: { [address]: { nonce: 5, threshold: 2, owners: OWNERS } },
    });
    const built = await buildSafeTransaction({ chainId: 100, safe: INIT, tx: TX, provider });
    expect(built.deployed).toBe(true);
    expect(built.safeTxData.nonce).toBe(5);
  });

  test('safeTxHash matches protocol-kit and ethers independently (vector check)', async () => {
    const built = await buildSafeTransaction({
      chainId: 100,
      safe: INIT,
      tx: TX,
      provider: gnosis(),
    });
    const fromProtocolKit = calculateSafeTransactionHash(
      built.safeAddress,
      built.safeTxData,
      SAFE_VERSION,
      100n
    );
    const types = withoutDomainType(built.typedData.types);
    const fromEthers = TypedDataEncoder.hash(built.typedData.domain, types, built.typedData.message);
    expect(built.safeTxHash).toBe(fromProtocolKit);
    expect(built.safeTxHash).toBe(fromEthers);
    expect(built.typedData.primaryType).toBe('SafeTx');
  });

  test('the whole result is JSON-serializable (IPC / persistence)', async () => {
    const built = await buildSafeTransaction({
      chainId: 100,
      safe: INIT,
      tx: TX,
      provider: gnosis(),
    });
    const roundTripped = JSON.parse(JSON.stringify(built));
    expect(roundTripped).toEqual(built);
  });
});

describe('collectOwnerSignature', () => {
  let typedData;

  beforeAll(async () => {
    const built = await buildSafeTransaction({
      chainId: 100,
      safe: INIT,
      tx: { to: OWNERS[0], value: '1000', data: '0x' },
      provider: gnosis(),
    });
    typedData = built.typedData;
  });

  test('returns a recover-verified signature for the owner', async () => {
    const signature = await collectOwnerSignature({ typedData, ownerIndex: 2 });
    expect(signature.signer).toBe(OWNERS[1]);
    const types = withoutDomainType(typedData.types);
    expect(verifyTypedData(typedData.domain, types, typedData.message, signature.data)).toBe(
      OWNERS[1]
    );
  });

  test('rejects a signature that does not recover to the owner address', async () => {
    // A compromised device returns a signature from the wrong key.
    mockGetSigner.mockImplementationOnce(() => ({
      getAddress: async () => OWNERS[0],
      signTypedData: async ({ domain, types, message }) =>
        ownerWallet(2).signTypedData(domain, withoutDomainType(types), message),
    }));
    await expect(collectOwnerSignature({ typedData, ownerIndex: 0 })).rejects.toThrow(
      /signature.*does not match/i
    );
  });

  test('propagates signer errors (device rejection)', async () => {
    mockGetSigner.mockImplementationOnce(() => ({
      getAddress: async () => OWNERS[0],
      signTypedData: async () => {
        throw new Error('Rejected on device');
      },
    }));
    await expect(collectOwnerSignature({ typedData, ownerIndex: 0 })).rejects.toThrow(
      'Rejected on device'
    );
  });
});

describe('execTransaction', () => {
  const EXEC_INTERFACE = new Interface([
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  ]);

  async function buildSignedTx() {
    const address = await predictSafeAddress({ ...INIT, chainId: 100, provider: gnosis() });
    const provider = createStubChain({
      chainId: 100,
      deployedSafes: { [address]: { nonce: 0, threshold: 2, owners: OWNERS } },
    });
    const built = await buildSafeTransaction({
      chainId: 100,
      safe: INIT,
      tx: { to: OWNERS[2], value: '1000', data: '0x' },
      provider,
    });
    const signatures = [
      await collectOwnerSignature({ typedData: built.typedData, ownerIndex: 0 }),
      await collectOwnerSignature({ typedData: built.typedData, ownerIndex: 2 }),
    ];
    return { built, signatures, provider };
  }

  test('submits execTransaction calldata through the executor signer', async () => {
    const { built, signatures } = await buildSignedTx();
    const result = await execTransaction({
      chainId: 100,
      safeAddress: built.safeAddress,
      safeTxData: built.safeTxData,
      signatures,
      executorIndex: 0,
    });

    expect(result.hash).toBe('0x' + 'aa'.repeat(32));
    expect(mockSignAndSendTransaction).toHaveBeenCalledTimes(1);
    const [params, signer] = mockSignAndSendTransaction.mock.calls[0];
    expect(params).toMatchObject({
      to: built.safeAddress,
      value: '0',
      chainId: 100,
      gasLimit: '150000',
      maxFeePerGas: '2000000000',
      maxPriorityFeePerGas: '1000000000',
    });
    await expect(signer.getAddress()).resolves.toBe(OWNERS[0]);

    // calldata is a well-formed execTransaction embedding both signatures
    const decoded = EXEC_INTERFACE.decodeFunctionData('execTransaction', params.data);
    expect(decoded.to).toBe(OWNERS[2]);
    expect(decoded.value).toBe(1000n);
    // two 65-byte signatures, sorted and concatenated
    expect(decoded.signatures.length).toBe(2 + 65 * 2 * 2);

    // gas was estimated for the executor on the real calldata
    expect(mockEstimateGas).toHaveBeenCalledWith({
      from: OWNERS[0],
      to: built.safeAddress,
      value: '0',
      data: params.data,
      chainId: 100,
    });
  });

  test('a record context routes through tx-recorder with from = safe and the executor stamped in', async () => {
    const { built, signatures } = await buildSignedTx();
    const result = await execTransaction({
      chainId: 100,
      safeAddress: built.safeAddress,
      safeTxData: built.safeTxData,
      signatures,
      executorIndex: 0,
      record: {
        kind: 'safe-send',
        fromAddress: built.safeAddress,
        toAddress: OWNERS[2],
        amount: '1000',
        metadata: { safeAddress: built.safeAddress },
      },
    });

    expect(result.hash).toBe('0x' + 'bb'.repeat(32));
    expect(mockSignAndSendTransaction).not.toHaveBeenCalled();
    const [params, signer, context] = mockSignAndRecord.mock.calls[0];
    expect(params).toMatchObject({ to: built.safeAddress, value: '0', chainId: 100 });
    await expect(signer.getAddress()).resolves.toBe(OWNERS[0]);
    expect(context).toEqual({
      kind: 'safe-send',
      fromAddress: built.safeAddress,
      toAddress: OWNERS[2],
      amount: '1000',
      metadata: { safeAddress: built.safeAddress, executor: OWNERS[0] },
    });
  });

  test('falls back to legacy gas pricing when the chain has no EIP-1559 data', async () => {
    mockGetGasPrices.mockResolvedValueOnce({ type: 'legacy', gasPrice: '5000000000' });
    const { built, signatures } = await buildSignedTx();
    await execTransaction({
      chainId: 100,
      safeAddress: built.safeAddress,
      safeTxData: built.safeTxData,
      signatures,
      executorIndex: 0,
    });
    const [params] = mockSignAndSendTransaction.mock.calls[0];
    expect(params.gasPrice).toBe('5000000000');
    expect(params.maxFeePerGas).toBeUndefined();
  });
});

describe('deploySafe', () => {
  test('sends the canonical factory deployment through the executor and returns the address', async () => {
    const { safeAddress, tx } = await deploySafe({
      ...INIT,
      chainId: 100,
      executorIndex: 0,
      provider: gnosis(),
    });
    const predicted = await predictSafeAddress({ ...INIT, chainId: 100, provider: gnosis() });
    expect(safeAddress).toBe(predicted);
    expect(tx.hash).toBe('0x' + 'aa'.repeat(32));

    const [params, signer] = mockSignAndSendTransaction.mock.calls[0];
    const factory = deployments.getProxyFactoryDeployment({ version: SAFE_VERSION }).defaultAddress;
    expect(params.to).toBe(factory);
    expect(params.value).toBe('0');
    await expect(signer.getAddress()).resolves.toBe(OWNERS[0]);
  });
});

describe('pickDefaultExecutor', () => {
  test('picks the first mnemonic owner regardless of list order', () => {
    expect(pickDefaultExecutor([2, 0, 4])).toBe(0);
  });

  test('throws when no owner can pay gas locally', () => {
    expect(() => pickDefaultExecutor([2, 4])).toThrow(/executor/i);
  });
});
