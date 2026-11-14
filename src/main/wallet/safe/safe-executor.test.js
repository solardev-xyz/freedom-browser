const {
  AbiCoder,
  TypedDataEncoder,
  Interface,
  dataLength,
  getAddress,
  keccak256,
  verifyTypedData,
} = require('ethers');

const {
  createStubChain,
  canonicalAddresses,
  PROXY_CREATION_CODE_RESPONSE,
} = require('./__tests__/helpers/stub-chain');
const { PROXY_FACTORY_1_4_1_RUNTIME } = require('./__tests__/helpers/proxy-factory-code');
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
const mockHeldIntentFor = jest.fn(async () => null);

jest.mock('../signers', () => ({
  getSigner: (...args) => mockGetSigner(...args),
}));
jest.mock('../transaction-service', () => ({
  estimateGas: (...args) => mockEstimateGas(...args),
  getGasPrices: (...args) => mockGetGasPrices(...args),
  // the pure fee-shape mapper stays real so its behaviour is under test
  toFeeFields: jest.requireActual('../transaction-service').toFeeFields,
  namesOwnFees: jest.requireActual('../transaction-service').namesOwnFees,
  signAndSendTransaction: (...args) => mockSignAndSendTransaction(...args),
  heldIntentFor: (...args) => mockHeldIntentFor(...args),
}));
// The fee check at confirmation (design 0005, A): by default the executor's
// fee is like today's and goes ahead; tests give other verdicts.
const FEE_LIKE_TODAYS = {
  maxCost: '300000000000000',
  comparable: true,
  ratio: '1',
  above: false,
  oneEndpoint: false,
  basis: 'header',
  autoApprove: true,
};
const mockCheckAtApproval = jest.fn(async () => FEE_LIKE_TODAYS);
jest.mock('../fee-check', () => ({
  ...jest.requireActual('../fee-check'),
  checkAtApproval: (...args) => mockCheckAtApproval(...args),
}));
const mockSignAndRecord = jest.fn(async () => ({ hash: '0x' + 'bb'.repeat(32), recorded: true }));
jest.mock('../tx-recorder', () => ({
  signAndRecord: (...args) => mockSignAndRecord(...args),
}));
jest.mock('../../identity-manager', () => ({
  getWalletRecord: (index) => mockWalletRecords[index] || null,
  isHardwareWalletIndex: () => false,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
// The real signer seam (../signers), for the device owners' tests at the
// end: its Ledger and phone backends sign with the owners' test keys and
// record when they are asked, and the core is the simulated one.
const mockCore = { calls: [] };
const mockDeviceAsked = jest.fn();
const mockDeviceBackend = (record) => {
  const owner = require('./__tests__/helpers/test-owners').createTestSigner(record.index);
  return {
    ...owner,
    signMessage: jest.fn(),
    signTypedData: async (typed) => {
      mockDeviceAsked(record.index, mockCore.calls.filter(([method]) => method === 'typed_data.hash').length);
      return owner.signTypedData(typed);
    },
  };
};
jest.mock('../ledger/signer', () => ({ createLedgerBackend: (record) => mockDeviceBackend(record) }));
jest.mock('../remote/signer', () => ({ createRemoteBackend: (record) => mockDeviceBackend(record) }));
jest.mock('../../core/vault-backend', () => ({
  vaultBackend: require('../../../../test/helpers/simulated-vault-core').simulatedVaultBackend(
    {
      isUnlocked: () => true,
      exportPrivateKey: () => require('./__tests__/helpers/test-owners').OWNER_KEYS[0],
    },
    mockCore
  ),
}));
jest.mock('../provider-manager', () => ({
  getEip1193Provider: () => {
    throw new Error('unit tests must inject a provider');
  },
}));

const {
  SAFE_VERSION,
  pinnedSafeDeployment,
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

// INIT's address, as protocol-kit 8.0.11 predicts it against the recorded
// proxyCreationCode() answer of the factory on Gnosis.
const INIT_ADDRESS = '0xA6866927D91a760eDe6cf12fB88Ed97BD6ED2dC9';

// What a lying endpoint answers for proxyCreationCode(): the real code
// with one byte changed, which moves every CREATE2 address computed from it.
const LYING_PROXY_CODE = (() => {
  const [code] = AbiCoder.defaultAbiCoder().decode(['bytes'], PROXY_CREATION_CODE_RESPONSE);
  return code.slice(0, -2) + (code.endsWith('00') ? '01' : '00');
})();
const lyingGnosis = () => createStubChain({ chainId: 100, proxyCreationCode: LYING_PROXY_CODE });

/**
 * The executor and protocol-kit in a module registry of their own:
 * protocol-kit keeps the first proxyCreationCode() answer it gets for the
 * process, so a lie must be the first answer it sees to be taken.
 */
function freshModules() {
  let modules;
  jest.isolateModules(() => {
    modules = {
      executor: require('./safe-executor'),
      Safe: require('@safe-global/protocol-kit').default,
    };
  });
  return modules;
}

async function protocolKitPrediction(Safe, provider, { owners, threshold, saltNonce } = INIT) {
  const kit = await Safe.init({
    provider,
    predictedSafe: {
      safeAccountConfig: { owners, threshold },
      safeDeploymentConfig: { saltNonce, safeVersion: SAFE_VERSION },
    },
  });
  return { address: getAddress(await kit.getAddress()), kit };
}

beforeEach(() => {
  mockGetSigner.mockClear();
  mockEstimateGas.mockClear();
  mockGetGasPrices.mockClear();
  mockSignAndSendTransaction.mockClear();
  mockSignAndRecord.mockClear();
  mockHeldIntentFor.mockReset().mockResolvedValue(null);
  mockCheckAtApproval.mockReset().mockResolvedValue(FEE_LIKE_TODAYS);
});

describe('predictSafeAddress', () => {
  test('is deterministic and checksummed', async () => {
    const a = await predictSafeAddress({ ...INIT, chainId: 100, provider: gnosis() });
    const b = await predictSafeAddress({ ...INIT, chainId: 100, provider: gnosis() });
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(a).toBe(b);
  });

  test('matches protocol-kit against the honest factory answer', async () => {
    const { executor, Safe } = freshModules();
    const ours = await executor.predictSafeAddress({ ...INIT, chainId: 100 });
    expect(ours).toBe(INIT_ADDRESS);
    expect((await protocolKitPrediction(Safe, gnosis())).address).toBe(ours);

    const oneOfTwo = { owners: OWNERS.slice(0, 2), threshold: 1, saltNonce: '20260709' };
    expect(await executor.predictSafeAddress({ ...oneOfTwo, chainId: 100 })).toBe(
      (await protocolKitPrediction(Safe, gnosis(), oneOfTwo)).address
    );
  });

  test('a lying proxyCreationCode() answer cannot move the address (#1066)', async () => {
    const { executor, Safe } = freshModules();
    // The lie is the first answer this registry's protocol-kit sees, and
    // it takes it: its own prediction moves.
    const fooled = await protocolKitPrediction(Safe, lyingGnosis());
    expect(fooled.address).not.toBe(INIT_ADDRESS);

    // Ours rests on the pinned code alone.
    const provider = lyingGnosis();
    expect(await executor.predictSafeAddress({ ...INIT, chainId: 100, provider })).toBe(
      INIT_ADDRESS
    );
    const deployment = await executor.buildDeploymentTransaction({ ...INIT, chainId: 100, provider });
    expect(deployment.safeAddress).toBe(INIT_ADDRESS);

    // The record's own address still signs: the lie can't make it look
    // tampered with, give the SafeTx another address, or hide the
    // deployed Safe (and with it its nonce).
    const built = await executor.buildSafeTransaction({
      chainId: 100,
      safe: { ...INIT, address: INIT_ADDRESS },
      tx: { to: OWNERS[0], value: '1', data: '0x' },
      provider: createStubChain({
        chainId: 100,
        proxyCreationCode: LYING_PROXY_CODE,
        deployedSafes: { [INIT_ADDRESS]: { nonce: 5, threshold: 2, owners: OWNERS } },
      }),
    });
    expect(built.safeAddress).toBe(INIT_ADDRESS);
    expect(built.typedData.domain.verifyingContract).toBe(INIT_ADDRESS);
    expect(built.deployed).toBe(true);
    expect(built.safeTxData.nonce).toBe(5);
  });

  test('refuses a chain with no pinned deployment, and asks no RPC there', async () => {
    const request = jest.fn();
    await expect(
      predictSafeAddress({ ...INIT, chainId: 8453, provider: { request } })
    ).rejects.toMatchObject({ code: 'SAFE_UNSUPPORTED', message: /chain 8453/ });
    await expect(
      buildDeploymentTransaction({ ...INIT, chainId: 8453, provider: { request } })
    ).rejects.toMatchObject({ code: 'SAFE_UNSUPPORTED' });
    await expect(
      buildSafeTransaction({
        chainId: 8453,
        safe: INIT,
        tx: { to: OWNERS[0], value: '1' },
        provider: { request },
      })
    ).rejects.toMatchObject({ code: 'SAFE_UNSUPPORTED' });
    expect(request).not.toHaveBeenCalled();
  });

  test('refuses a Safe version with no pinned deployment', () => {
    expect(() => pinnedSafeDeployment(100, '1.3.0')).toThrow(
      expect.objectContaining({ code: 'SAFE_UNSUPPORTED' })
    );
    expect(() => pinnedSafeDeployment(100, 'toString')).toThrow(
      expect.objectContaining({ code: 'SAFE_UNSUPPORTED' })
    );
    expect(pinnedSafeDeployment(100, SAFE_VERSION).factory).toBe(
      '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67'
    );
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

describe('the pinned Safe 1.4.1 deployment on Gnosis', () => {
  const pinned = () => pinnedSafeDeployment(100);

  test('is the canonical factory, SafeL2 singleton and fallback handler of safe-deployments', () => {
    const entries = {
      factory: deployments.getProxyFactoryDeployment({ version: SAFE_VERSION }),
      singleton: deployments.getSafeL2SingletonDeployment({ version: SAFE_VERSION }),
      fallbackHandler: deployments.getFallbackHandlerDeployment({ version: SAFE_VERSION }),
    };
    for (const [name, entry] of Object.entries(entries)) {
      expect(pinned()[name]).toBe(getAddress(entry.deployments.canonical.address));
      expect([entry.networkAddresses['100']].flat()).toContain(entry.deployments.canonical.address);
    }
  });

  test('pins the factory proxy code: 486 bytes, keccak256 0x1856…af5f', () => {
    expect(dataLength(pinned().proxyCreationCode)).toBe(486);
    expect(keccak256(pinned().proxyCreationCode)).toBe(pinned().proxyCreationCodeHash);
    expect(pinned().proxyCreationCodeHash).toBe(
      '0x1856e0ee08399d74e0ea0b03adca210aeade6f748969ac023cdcb4dd62dcaf5f'
    );
  });

  test('the proxy code is the one in the factory whose code hash safe-deployments lists', () => {
    const factory = deployments.getProxyFactoryDeployment({ version: SAFE_VERSION });
    expect(keccak256(PROXY_FACTORY_1_4_1_RUNTIME)).toBe(factory.deployments.canonical.codeHash);
    const code = pinned().proxyCreationCode.slice(2);
    expect(PROXY_FACTORY_1_4_1_RUNTIME.split(code)).toHaveLength(2);
  });

  test('is what the recorded proxyCreationCode() answer of the factory on Gnosis decodes to', () => {
    const [code] = AbiCoder.defaultAbiCoder().decode(['bytes'], PROXY_CREATION_CODE_RESPONSE);
    expect(code).toBe(pinned().proxyCreationCode);
  });
});

describe('buildDeploymentTransaction', () => {
  test('is byte for byte the deployment protocol-kit builds against the honest factory', async () => {
    const { Safe } = freshModules();
    const { kit } = await protocolKitPrediction(Safe, gnosis());
    const fromProtocolKit = await kit.createSafeDeploymentTransaction();
    const ours = await buildDeploymentTransaction({ ...INIT, chainId: 100 });
    expect(ours).toEqual({
      safeAddress: INIT_ADDRESS,
      to: getAddress(fromProtocolKit.to),
      value: String(fromProtocolKit.value),
      data: fromProtocolKit.data,
    });
  });

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

  test("a vault owner's signer carries the Safe approval; none without one", async () => {
    const approval = { id: 'b2'.repeat(16), page: { origin: 'https://app.example', frame: 1, navigation: 2 } };
    await collectOwnerSignature({ typedData, ownerIndex: 0, approval });
    expect(mockGetSigner).toHaveBeenLastCalledWith(0, { safe: approval });
    await collectOwnerSignature({ typedData, ownerIndex: 0 });
    expect(mockGetSigner).toHaveBeenLastCalledWith(0, {});
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

  // Review of #799 (round 1): a SafeTx is main's own typed data, with no
  // confirmed hash. Through the real signer seam, a Ledger or phone owner
  // signs it only after the core has hashed and checked it.
  describe.each([
    ['Ledger', 2],
    ['phone', 4],
  ])('a %s owner, through the real signer', (_device, ownerIndex) => {
    const { vaultBackend } = require('../../core/vault-backend');

    beforeEach(() => {
      mockCore.calls = [];
      mockDeviceAsked.mockClear();
      mockGetSigner.mockImplementationOnce((index) => jest.requireActual('../signers').getSigner(index));
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('the core hashes the SafeTx before the device signs it', async () => {
      const signature = await collectOwnerSignature({ typedData, ownerIndex });
      expect(signature.signer).toBe(ownerWallet(ownerIndex).address);
      expect(mockDeviceAsked).toHaveBeenCalledWith(ownerIndex, 1);
      const [[, hashed]] = mockCore.calls.filter(([method]) => method === 'typed_data.hash');
      expect(TypedDataEncoder.hash(hashed.domain, hashed.types, hashed.message)).toBe(
        TypedDataEncoder.hash(typedData.domain, withoutDomainType(typedData.types), typedData.message)
      );
      expect(mockCore.calls.filter(([method]) => method === 'sign.typed_data')).toEqual([]);
    });

    test('a SafeTx the core refuses never reaches the device', async () => {
      jest.spyOn(vaultBackend, 'typedDataHash').mockRejectedValueOnce(
        Object.assign(new Error('invalid typed data'), { code: 'invalid_argument' })
      );
      await expect(collectOwnerSignature({ typedData, ownerIndex })).rejects.toThrow('invalid typed data');
      expect(mockDeviceAsked).not.toHaveBeenCalled();
    });
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
  // The Safe approval main holds for the SafeTx (design 0012, APB-1c): the
  // wallet's, which the executor's signature presents under `shell`.
  const WALLET_APPROVAL = Object.freeze({ id: 'a1'.repeat(16), page: null });
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
    approval: WALLET_APPROVAL,
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
      approval: WALLET_APPROVAL,
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
    const [params, signer, context, options] = mockSignAndRecord.mock.calls[0];
    expect(params).toMatchObject({ to: built.safeAddress, value: '0', chainId: 100 });
    await expect(signer.getAddress()).resolves.toBe(OWNERS[0]);
    expect(context).toEqual({
      kind: 'safe-send',
      fromAddress: built.safeAddress,
      toAddress: OWNERS[2],
      amount: '1000',
      metadata: { safeAddress: built.safeAddress, executor: OWNERS[0] },
    });
    // The key is main's own argument, apart from the display context. With
    // no site, there is no site's turn to leave.
    expect(options).toEqual({
      intentKey: `safe-exec:100:${built.safeTxHash.toLowerCase()}`,
      onCommitted: null,
      guardCommit: null,
    });
  });

  // D12: a dApp's Safe transaction takes its site's turn until committed,
  // like the site's other payments (auto-approve-pause.js).
  test("a dApp's Safe transaction takes its site's turn until it is committed", async () => {
    const { takeSiteTurn, transactionAutoApprovePaused } = require('../auto-approve-pause');
    const { built, signatures } = await buildSignedTx();
    let committed;
    mockSignAndRecord.mockImplementationOnce(async (_params, _signer, _context, options) => {
      // Before its commit the site's turn is taken; the hook leaves it.
      await expect(transactionAutoApprovePaused('https://swap.example')).resolves.toBe(true);
      committed = options.onCommitted;
      return { hash: '0x' + 'bb'.repeat(32) };
    });
    await execTransaction({
      chainId: 100,
      safeAddress: built.safeAddress,
      safeTxData: built.safeTxData,
      signatures,
      executorIndex: 0,
      approval: WALLET_APPROVAL,
      record: { kind: 'safe-send', origin: 'https://swap.example', metadata: {} },
    });
    expect(committed).toEqual(expect.any(Function));
    // Settled: the turn is free for the site's next send.
    const leave = await takeSiteTurn('https://swap.example');
    leave();
  });

  test('the intent key is the SafeTx hash every owner signed', async () => {
    const { built, signatures } = await buildSignedTx();
    await execTransaction({
      chainId: 100,
      safeAddress: built.safeAddress,
      safeTxData: built.safeTxData,
      signatures,
      executorIndex: 0,
    approval: WALLET_APPROVAL,
    });
    const [, , options] = mockSignAndSendTransaction.mock.calls[0];
    expect(options).toEqual({ intentKey: `safe-exec:100:${built.safeTxHash.toLowerCase()}`, guardCommit: null });
    expect(mockHeldIntentFor).toHaveBeenCalledWith(options.intentKey);
  });

  // freedom-core design 0011, PRQ-5b: a site's SafeTx's request guards its
  // execution's last step (Codex round 2 on #1191).
  test("a site's guard goes with the execution to its commit, or to a held execution's handoff", async () => {
    const { built, signatures } = await buildSignedTx();
    const guardCommit = jest.fn();
    await execTransaction({
      chainId: 100,
      safeAddress: built.safeAddress,
      safeTxData: built.safeTxData,
      signatures,
      executorIndex: 0,
      approval: WALLET_APPROVAL,
      record: { kind: 'safe-send', fromAddress: built.safeAddress, origin: 'https://app.example' },
      guardCommit,
    });
    expect(mockSignAndRecord.mock.calls.at(-1)[3]).toMatchObject({ guardCommit });
    await execTransaction({
      chainId: 100,
      safeAddress: built.safeAddress,
      safeTxData: built.safeTxData,
      signatures,
      executorIndex: 0,
      approval: WALLET_APPROVAL,
      guardCommit,
    });
    expect(mockSignAndSendTransaction.mock.calls.at(-1)[2]).toMatchObject({ guardCommit });
  });

  test('"Try again" on a held execution sends it again without a new quote', async () => {
    const { built, signatures } = await buildSignedTx();
    mockHeldIntentFor.mockResolvedValue({ intentId: 'held-intent-1', state: 'held' });
    await execTransaction({
      chainId: 100,
      safeAddress: built.safeAddress,
      safeTxData: built.safeTxData,
      signatures,
      executorIndex: 0,
    approval: WALLET_APPROVAL,
    });
    expect(mockEstimateGas).not.toHaveBeenCalled();
    expect(mockGetGasPrices).not.toHaveBeenCalled();
    const [params, , options] = mockSignAndSendTransaction.mock.calls[0];
    expect(params).toEqual({
      to: built.safeAddress,
      value: '0',
      data: expect.stringMatching(/^0x/),
      chainId: 100,
    });
    expect(options.intentKey).toBe(`safe-exec:100:${built.safeTxHash.toLowerCase()}`);
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
    approval: WALLET_APPROVAL,
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

    const [params, signer, options] = mockSignAndSendTransaction.mock.calls[0];
    const factory = deployments.getProxyFactoryDeployment({ version: SAFE_VERSION }).defaultAddress;
    expect(params.to).toBe(factory);
    expect(params.value).toBe('0');
    await expect(signer.getAddress()).resolves.toBe(OWNERS[0]);
    expect(options).toEqual({ intentKey: `safe-deploy:100:${predicted.toLowerCase()}`, guardCommit: null });
  });
});

// Design 0005, A: main judges the executor's fee as it signs, against the
// same reference as every other confirmation. Within the threshold, with a
// reference that permits it, the execution goes ahead without the user;
// any other stops before signing, and is signed only with the fee the user
// then confirms.
describe("the fee check on the executor's fee", () => {
  const { issueConfirmation } = require('../signing-confirmation');
  const { FEE_CHECK_NEEDS_CONFIRMATION } = require('../fee-check');

  // The executor's signature presents its confirmation to the (simulated)
  // core, which spends it there (design 0012, APB-1).
  beforeEach(() => {
    const { coreCheckedSigner } = require('../../../../test/helpers/simulated-approvals');
    const { buildTransaction } = require('../signing-utils');
    mockGetSigner.mockImplementation((index, authorized) =>
      coreCheckedSigner(mockCore.approvals, createTestSigner(index), index, authorized)
    );
    signedCount = 0;
    mockSignAndSendTransaction.mockImplementation(async (params, signer) => {
      await signer.signTransaction(buildTransaction({ ...params, nonce: 0 }));
      signedCount += 1;
      return { hash: '0x' + 'aa'.repeat(32) };
    });
  });
  let signedCount = 0;

  afterEach(() => {
    mockGetSigner.mockImplementation(createTestSigner);
    mockSignAndSendTransaction.mockImplementation(async () => ({ hash: '0x' + 'aa'.repeat(32) }));
  });

  async function signedExecution(extra = {}) {
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
    // The wallet's Safe approval for it, open in the (simulated) core.
    const approval = { id: mockCore.approvals.openSafeApproval(), page: null };
    return {
      built,
      approval,
      execute: (options = {}) =>
        execTransaction({
          chainId: 100,
          safeAddress: built.safeAddress,
          safeTxData: built.safeTxData,
          signatures,
          executorIndex: 0,
          approval,
          ...extra,
          ...options,
        }),
    };
  }

  // The stop: nothing signed, the verdict and the transaction offered.
  async function stopped(run) {
    const error = await run().then(
      () => null,
      (err) => err
    );
    expect(error).toMatchObject({ code: FEE_CHECK_NEEDS_CONFIRMATION });
    expect(mockSignAndSendTransaction).not.toHaveBeenCalled();
    expect(mockSignAndRecord).not.toHaveBeenCalled();
    return error;
  }

  test('a fee like today\'s is judged as it is signed, and goes ahead', async () => {
    const { built, execute } = await signedExecution();
    await execute();
    const [params] = mockSignAndSendTransaction.mock.calls[0];
    expect(mockCheckAtApproval).toHaveBeenCalledTimes(1);
    expect(mockCheckAtApproval).toHaveBeenCalledWith({
      to: built.safeAddress,
      value: '0',
      data: params.data,
      gasLimit: '150000',
      maxFeePerGas: '2000000000',
      maxPriorityFeePerGas: '1000000000',
      chainId: 100,
    });
  });

  test.each([
    ['above the threshold', { ratio: '20', above: true }],
    ["couldn't compare", { comparable: false, ratio: null, basis: null }],
    ["one endpoint's word", { oneEndpoint: true }],
  ])('%s: it stops before signing, with the fee it would pay', async (_name, verdict) => {
    const judged = { ...FEE_LIKE_TODAYS, ...verdict, autoApprove: false };
    mockCheckAtApproval.mockResolvedValue(judged);
    const { built, execute } = await signedExecution({
      record: { kind: 'safe-send', metadata: {} },
    });
    const error = await stopped(execute);
    expect(error.feeCheck).toEqual(judged);
    expect(error.offer).toEqual({
      executorIndex: 0,
      chainId: 100,
      to: built.safeAddress,
      value: '0',
      data: expect.stringMatching(/^0x/),
      gasLimit: '150000',
      maxFeePerGas: '2000000000',
      maxPriorityFeePerGas: '1000000000',
    });
  });

  // Design 0012, APB-1c: the executor presents the SafeTx's Safe approval
  // while the fee check allows it, or the 'executor-send' token the user
  // confirmed; never neither.
  test("the executor presents the SafeTx's Safe approval, which its signature ends", async () => {
    const { execute, approval } = await signedExecution();
    await execute();
    expect(mockGetSigner).toHaveBeenCalledWith(0, { safe: approval });
    const signed = mockCore.approvals.calls.filter((call) => call.method === 'sign.transaction');
    expect(signed.at(-1)).toMatchObject({ params: { authorization: { safe: approval.id } }, page: null });
    expect(mockCore.approvals.isSafeApprovalOpen(approval.id)).toBe(false);
  });

  test('with no Safe approval held, the fee is asked as an executor-send, nothing signed', async () => {
    const { execute } = await signedExecution();
    const { offer } = await stopped(() => execute({ approval: null }));
    expect(offer).toMatchObject({ executorIndex: 0, value: '0', gasLimit: '150000' });
    // Confirmed: the executor-send token signs, the approval not presented.
    const { executorIndex, ...payload } = offer;
    const { token } = await issueConfirmation('executor-send', executorIndex, payload);
    await execute({
      approval: null,
      feeConfirmation: {
        confirmation: token,
        gasLimit: offer.gasLimit,
        fees: { maxFeePerGas: offer.maxFeePerGas, maxPriorityFeePerGas: offer.maxPriorityFeePerGas },
      },
    });
    expect(signedCount).toBe(1);
  });

  test("the core's own fee check, or an approval it no longer knows, asks the fee; another refusal is the error", async () => {
    for (const reason of ['fee_check', 'unknown_token']) {
      mockSignAndSendTransaction.mockClear();
      const { execute, approval } = await signedExecution();
      mockCore.approvals.setExecutorRefusal(reason === 'fee_check' ? 'fee_check' : null);
      if (reason === 'unknown_token') await mockCore.approvals.approval.end(approval.id);
      const error = await execute().then(
        () => null,
        (err) => err
      );
      expect(error).toMatchObject({ code: FEE_CHECK_NEEDS_CONFIRMATION, offer: expect.objectContaining({ executorIndex: 0 }) });
      expect(signedCount).toBe(0);
    }
    mockCore.approvals.setExecutorRefusal(null);
    const { execute } = await signedExecution();
    const other = { id: mockCore.approvals.openSafeApproval({ page: { origin: 'https://app.example', frame: 1, navigation: 1 } }), page: null };
    await expect(execute({ approval: other })).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED', reason: 'mismatch' });
  });

  test('the fee the user confirmed is signed exactly, without a new quote or check', async () => {
    mockCheckAtApproval.mockResolvedValue({ ...FEE_LIKE_TODAYS, ratio: '20', above: true, autoApprove: false });
    const { execute } = await signedExecution();
    const { offer } = await stopped(execute);
    mockEstimateGas.mockClear();
    mockGetGasPrices.mockClear();
    mockCheckAtApproval.mockClear();

    const { executorIndex, ...payload } = offer;
    const { token } = await issueConfirmation('executor-send', executorIndex, payload);
    await execute({
      feeConfirmation: {
        confirmation: token,
        gasLimit: offer.gasLimit,
        fees: { maxFeePerGas: offer.maxFeePerGas, maxPriorityFeePerGas: offer.maxPriorityFeePerGas },
      },
    });
    expect(mockEstimateGas).not.toHaveBeenCalled();
    expect(mockGetGasPrices).not.toHaveBeenCalled();
    expect(mockCheckAtApproval).not.toHaveBeenCalled();
    const [params] = mockSignAndSendTransaction.mock.calls[0];
    expect(params).toEqual({ ...payload });
  });

  test('a confirmation of other fees, or one already spent, signs nothing', async () => {
    mockCheckAtApproval.mockResolvedValue({ ...FEE_LIKE_TODAYS, comparable: false, autoApprove: false });
    const { execute } = await signedExecution();
    const { offer } = await stopped(execute);
    const { executorIndex, ...payload } = offer;
    const fees = { maxFeePerGas: offer.maxFeePerGas, maxPriorityFeePerGas: offer.maxPriorityFeePerGas };

    // Confirmed at one fee, sent with a higher one.
    const shown = (await issueConfirmation('executor-send', executorIndex, payload)).token;
    await expect(
      execute({
        feeConfirmation: {
          confirmation: shown,
          gasLimit: offer.gasLimit,
          fees: { ...fees, maxFeePerGas: '90000000000' },
        },
      })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    // Confirmed for another executor.
    const other = (await issueConfirmation('executor-send', 2, payload)).token;
    await expect(
      execute({ feeConfirmation: { confirmation: other, gasLimit: offer.gasLimit, fees } })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    // Refused by the core at the executor's signature: nothing signed.
    expect(signedCount).toBe(0);

    // Spent once, then refused.
    const once = (await issueConfirmation('executor-send', executorIndex, payload)).token;
    const confirmed = { confirmation: once, gasLimit: offer.gasLimit, fees };
    await execute({ feeConfirmation: confirmed });
    await expect(execute({ feeConfirmation: confirmed })).rejects.toMatchObject({
      code: 'SIGNING_NOT_CONFIRMED',
    });
    expect(signedCount).toBe(1);
  });

  test("a wallet-send token on the executor's route is refused before any signature, and burnt", async () => {
    mockCheckAtApproval.mockResolvedValue({ ...FEE_LIKE_TODAYS, comparable: false, autoApprove: false });
    const { execute } = await signedExecution();
    const { offer } = await stopped(execute);
    const { executorIndex, ...payload } = offer;
    const fees = { maxFeePerGas: offer.maxFeePerGas, maxPriorityFeePerGas: offer.maxPriorityFeePerGas };
    // The same account and transaction, minted as the wallet's own send: the
    // core would read its kind from the token, so main checks it first.
    const { token } = await issueConfirmation('wallet-send', executorIndex, payload);
    mockCore.approvals.calls.length = 0;
    await expect(
      execute({ feeConfirmation: { confirmation: token, gasLimit: offer.gasLimit, fees } })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED', message: expect.stringMatching(/request differs/) });
    expect(signedCount).toBe(0);
    expect(mockSignAndSendTransaction).not.toHaveBeenCalled();
    // Nothing asked of the core but the burn (the route's own burn of the
    // token it held follows, a no-op).
    expect(mockCore.approvals.calls.length).toBeGreaterThan(0);
    for (const call of mockCore.approvals.calls) {
      expect(call).toMatchObject({ method: 'approval.discard', params: { token } });
    }
    expect(mockCore.approvals.outstanding()).toBe(0);
  });

  test('a confirmation of no fee signs nothing: it would be given today\'s', async () => {
    mockCheckAtApproval.mockResolvedValue({ ...FEE_LIKE_TODAYS, comparable: false, autoApprove: false });
    const { execute } = await signedExecution();
    const { offer } = await stopped(execute);
    const { executorIndex, maxFeePerGas: _max, maxPriorityFeePerGas: _tip, ...payload } = offer;
    const { token } = await issueConfirmation('executor-send', executorIndex, payload);
    await expect(
      execute({ feeConfirmation: { confirmation: token, gasLimit: offer.gasLimit, fees: {} } })
    ).rejects.toMatchObject({ code: 'FEE_NOT_SHOWN' });
    expect(mockSignAndSendTransaction).not.toHaveBeenCalled();
  });

  test('a held execution sent again signs nothing new, so it is not judged', async () => {
    mockCheckAtApproval.mockResolvedValue({ ...FEE_LIKE_TODAYS, above: true, autoApprove: false });
    mockHeldIntentFor.mockResolvedValue({ intentId: 'held-intent-1', state: 'held' });
    const { execute } = await signedExecution();
    await execute();
    expect(mockCheckAtApproval).not.toHaveBeenCalled();
    expect(mockSignAndSendTransaction).toHaveBeenCalledTimes(1);
  });

  test("an activation's fee is judged the same way", async () => {
    mockCheckAtApproval.mockResolvedValue({ ...FEE_LIKE_TODAYS, comparable: false, autoApprove: false });
    const deploy = (options = {}) =>
      deploySafe({ ...INIT, chainId: 100, executorIndex: 0, provider: gnosis(), ...options });
    const { offer } = await stopped(deploy);
    const factory = deployments.getProxyFactoryDeployment({ version: SAFE_VERSION }).defaultAddress;
    expect(offer).toMatchObject({ executorIndex: 0, chainId: 100, to: factory, value: '0' });

    const { executorIndex, ...payload } = offer;
    const { token } = await issueConfirmation('executor-send', executorIndex, payload);
    await deploy({
      feeConfirmation: {
        confirmation: token,
        gasLimit: offer.gasLimit,
        fees: { maxFeePerGas: offer.maxFeePerGas, maxPriorityFeePerGas: offer.maxPriorityFeePerGas },
      },
    });
    const [params] = mockSignAndSendTransaction.mock.calls[0];
    expect(params).toEqual(payload);
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
