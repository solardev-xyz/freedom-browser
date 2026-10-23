const { Wallet, TypedDataEncoder, verifyTypedData } = require('ethers');

// Anvil/Hardhat-default test key — well-known, never funded on mainnet.
const TEST_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_ADDRESS = new Wallet(TEST_PRIVATE_KEY).address;

const mockIdentity = {
  isUnlocked: jest.fn(),
  exportPrivateKey: jest.fn(),
};
const mockResetVaultAutoLockTimer = jest.fn();

// The identity core's signing, simulated with ethers and the test key
// (test/helpers/simulated-vault-core.js); mockIdentity drives the lock.
const mockCore = { calls: [] };
jest.mock('../core/vault-backend', () => ({
  vaultBackend: require('../../../test/helpers/simulated-vault-core').simulatedVaultBackend(
    mockIdentity,
    mockCore
  ),
}));
const mockGetWalletRecord = jest.fn(() => null);
jest.mock('../identity-manager', () => ({
  getWalletRecord: (...args) => mockGetWalletRecord(...args),
  isHardwareWalletIndex: (index) => Number.isInteger(index) && index >= 1000000,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
// A Ledger or phone account: the device signs with its own key (another
// well-known test key), and the test records when it is asked.
const DEVICE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const mockDevice = { signTypedData: jest.fn() };
const mockDeviceBackend = () => ({
  getAddress: async () => new (require('ethers').Wallet)(DEVICE_KEY).address,
  signTransaction: jest.fn(),
  signMessage: jest.fn(),
  signTypedData: (...args) => mockDevice.signTypedData(...args),
});
jest.mock('../wallet/ledger/signer', () => ({ createLedgerBackend: () => mockDeviceBackend() }));
jest.mock('../wallet/remote/signer', () => ({ createRemoteBackend: () => mockDeviceBackend() }));
jest.mock('../vault-timer', () => ({
  resetVaultAutoLockTimer: mockResetVaultAutoLockTimer,
}));

const {
  createX402Client,
  V1_NETWORKS,
} = require('./client');

beforeEach(() => {
  mockGetWalletRecord.mockReset().mockReturnValue(null);
  mockIdentity.isUnlocked.mockReturnValue(true);
  mockIdentity.exportPrivateKey.mockReturnValue(TEST_PRIVATE_KEY);
  mockResetVaultAutoLockTimer.mockClear();
  mockCore.calls = [];
});

describe('createX402Client', () => {
  test('rejects when the vault is locked', async () => {
    mockIdentity.isUnlocked.mockReturnValue(false);
    await expect(createX402Client(0)).rejects.toThrow(/locked/i);
  });

  test('exposes the signer address on the client so callers can stamp from_address', async () => {
    const client = await createX402Client(0);
    expect(client.address).toBe(TEST_ADDRESS);
    expect(mockCore.calls).toContainEqual(['keys.addresses', [0]]);
  });

  test('payment signing throws if the vault re-locks after client construction', async () => {
    const client = await createX402Client(0);
    mockResetVaultAutoLockTimer.mockClear(); // ignore the construction reset
    mockIdentity.isUnlocked.mockReturnValue(false);
    await expect(client.createPaymentPayload({
      x402Version: 2,
      resource: 'https://api.example/article',
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:8453',
          amount: '10000',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
          maxTimeoutSeconds: 60,
          resource: 'https://api.example/article',
          extra: { name: 'USD Coin', version: '2' },
        },
      ],
    })).rejects.toThrow(/locked/i);
    expect(mockResetVaultAutoLockTimer).not.toHaveBeenCalled();
  });

  test('returns an x402Client with V2 and V1 schemes wired', async () => {
    const client = await createX402Client(0);

    // selectPaymentRequirements returns the picked accepts[] entry; assert
    // on its scheme + network to prove the right scheme was matched, not
    // just any non-falsy value.
    const v2Pick = client.selectPaymentRequirements(2, [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '10000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        maxTimeoutSeconds: 60,
        resource: 'https://api.example/article',
        extra: { name: 'USD Coin', version: '2' },
      },
    ]);
    expect(v2Pick).toMatchObject({ scheme: 'exact', network: 'eip155:8453' });

    const v1Pick = client.selectPaymentRequirements(1, [
      {
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: '10000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        maxTimeoutSeconds: 60,
        resource: 'https://api.example/article',
        extra: { name: 'USD Coin', version: '2' },
      },
    ]);
    expect(v1Pick).toMatchObject({ scheme: 'exact', network: 'base' });
  });

  test('V1_NETWORKS covers Base / Ethereum', () => {
    // Asset-allowlist parity: a V1 server on any of these networks must
    // be reachable. Base Sepolia was previously included but was dropped
    // along with the Sepolia builtin chain/token entries — a V1 paywall
    // on sepolia wouldn't have a known asset anyway.
    expect(V1_NETWORKS).toEqual(expect.arrayContaining(['base', 'ethereum']));
  });

  test('produces a verifiable V2 payment payload end-to-end (Base / USDC)', async () => {
    const client = await createX402Client(0);

    // Shape of the parsed `PAYMENT-REQUIRED` header for a Base USDC 402.
    const paymentRequired = {
      x402Version: 2,
      resource: 'https://api.example/article',
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:8453',
          amount: '10000',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
          maxTimeoutSeconds: 60,
          resource: 'https://api.example/article',
          extra: { name: 'USD Coin', version: '2' },
        },
      ],
    };

    const result = await client.createPaymentPayload(paymentRequired);

    expect(result.x402Version).toBe(2);
    expect(result.payload.authorization).toMatchObject({
      from: TEST_ADDRESS,
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: '10000',
    });
    expect(result.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);

    // Recover the signer from the EIP-3009 typed data — the asset
    // allowlist in WP3 will rely on this signature pointing back at the
    // user's wallet, not some other address the server tried to slip in.
    const { authorization, signature } = result.payload;
    const recovered = verifyTypedData(
      {
        name: 'USD Coin',
        version: '2',
        chainId: 8453,
        verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      },
      {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature,
    );
    expect(recovered).toBe(TEST_ADDRESS);

    // freedom-core #88: the authorization, as approved, was hashed by the
    // core with typed_data.hash, and that hash passed as expected_hash.
    const signs = mockCore.calls.filter(([method]) => method === 'sign.typed_data');
    expect(signs).toHaveLength(1);
    const [, , data, expectedHash] = signs[0];
    expect(mockCore.calls).toContainEqual(['typed_data.hash', data]);
    expect(expectedHash).toBe(TypedDataEncoder.hash(data.domain, data.types, data.message));
  });
});

// Review of #799 (round 1): a payment from a Ledger or phone account is
// typed data main builds, with no confirmed hash. The core hashes and checks
// it before the device is asked, and a refusal leaves the device untouched.
describe.each([
  ['ledger', { index: 1000000, name: 'My Stax', type: 'ledger' }],
  ['phone', { index: 1000001, name: 'My Phone', type: 'remote' }],
])('createX402Client on a %s account', (_device, record) => {
  const { vaultBackend } = require('../core/vault-backend');
  const { withoutDomainType } = require('../wallet/signing-utils');
  const deviceWallet = new Wallet(DEVICE_KEY);
  const paymentRequired = {
    x402Version: 2,
    resource: 'https://api.example/article',
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '10000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        maxTimeoutSeconds: 60,
        resource: 'https://api.example/article',
        extra: { name: 'USD Coin', version: '2' },
      },
    ],
  };

  beforeEach(() => {
    mockGetWalletRecord.mockReturnValue({ ...record, address: deviceWallet.address });
    mockDevice.signTypedData.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('the core hashes the authorization before the device signs it', async () => {
    let hashedFirst;
    mockDevice.signTypedData.mockImplementation(async ({ domain, types, message }) => {
      hashedFirst = mockCore.calls.filter(([method]) => method === 'typed_data.hash').length === 1;
      return deviceWallet.signTypedData(domain, withoutDomainType(types), message);
    });
    const client = await createX402Client(record.index);
    expect(client.address).toBe(deviceWallet.address);
    const result = await client.createPaymentPayload(paymentRequired);

    expect(hashedFirst).toBe(true);
    expect(mockDevice.signTypedData).toHaveBeenCalledTimes(1);
    const [[signed]] = mockDevice.signTypedData.mock.calls;
    const [[, hashed]] = mockCore.calls.filter(([method]) => method === 'typed_data.hash');
    expect(hashed.message).toMatchObject({ from: deviceWallet.address, value: '10000' });
    expect(TypedDataEncoder.hash(hashed.domain, hashed.types, hashed.message)).toBe(
      TypedDataEncoder.hash(signed.domain, withoutDomainType(signed.types), signed.message)
    );
    // Nothing of the vault's: no key, no vault signature.
    expect(mockCore.calls.filter(([method]) => method === 'sign.typed_data')).toEqual([]);
    expect(result.payload.authorization).toMatchObject({ from: deviceWallet.address, value: '10000' });
  });

  test('an authorization the core refuses never reaches the device', async () => {
    jest.spyOn(vaultBackend, 'typedDataHash').mockRejectedValueOnce(
      Object.assign(new Error('invalid typed data'), { code: 'invalid_argument' })
    );
    const client = await createX402Client(record.index);
    await expect(client.createPaymentPayload(paymentRequired)).rejects.toThrow('invalid typed data');
    expect(mockDevice.signTypedData).not.toHaveBeenCalled();
  });
});
