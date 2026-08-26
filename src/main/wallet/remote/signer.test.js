/**
 * The fake phone answers with a real (well-known test) key, so every
 * assertion exercises actual cryptographic round-trips: the JSON-RPC
 * request shapes the backend publishes, and the recover-and-compare
 * verification of what comes back.
 */

const { Wallet, verifyMessage } = require('ethers');

// Anvil/Hardhat-default test keys — well-known, never funded on mainnet.
const TEST_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const OTHER_PRIVATE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const phoneWallet = new Wallet(TEST_PRIVATE_KEY);
const strangerWallet = new Wallet(OTHER_PRIVATE_KEY);

const RECORD = {
  index: 4,
  name: 'My Phone',
  address: phoneWallet.address,
  type: 'remote',
};

const mockRequestRemoteSignature = jest.fn();
jest.mock('./bridge', () => ({
  requestRemoteSignature: (...args) => mockRequestRemoteSignature(...args),
}));

// Chain registry (pulls in electron via the network registry) and RPC
// config — only consulted to build the EIP-3085 chain descriptor.
jest.mock('../chains', () => ({
  getChain: jest.fn((chainId) =>
    chainId === 100
      ? {
          chainId: 100,
          name: 'Gnosis Chain',
          nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
          blockExplorer: 'https://gnosisscan.io',
        }
      : null),
}));
jest.mock('../rpc-manager', () => ({
  // The localhost entry must never reach the phone.
  getEffectiveRpcUrls: jest.fn(() => ['https://rpc.gnosischain.com', 'http://127.0.0.1:8545']),
}));

const { createRemoteBackend } = require('./signer');

const backend = createRemoteBackend(RECORD);

beforeEach(() => {
  mockRequestRemoteSignature.mockReset();
});

describe('getAddress', () => {
  test('serves the stored address without a phone round-trip', async () => {
    await expect(backend.getAddress()).resolves.toBe(phoneWallet.address);
    expect(mockRequestRemoteSignature).not.toHaveBeenCalled();
  });
});

describe('signTransaction', () => {
  test('is unsupported — phones only expose eth_sendTransaction', async () => {
    await expect(backend.signTransaction({ to: '0x1', chainId: 1 })).rejects.toMatchObject({
      code: 'REMOTE_UNSUPPORTED',
    });
    expect(mockRequestRemoteSignature).not.toHaveBeenCalled();
  });
});

describe('signMessage', () => {
  test('publishes personal_sign over the message bytes and returns a verified signature', async () => {
    const message = Buffer.from('hello freedom', 'utf8');
    mockRequestRemoteSignature.mockImplementation(async ({ method, params }) => {
      expect(method).toBe('personal_sign');
      expect(params).toEqual(['0x' + message.toString('hex'), phoneWallet.address]);
      return phoneWallet.signMessage(message);
    });

    const signature = await backend.signMessage(message);
    expect(mockRequestRemoteSignature).toHaveBeenCalledWith(
      expect.objectContaining({ walletIndex: 4, address: phoneWallet.address }),
    );
    // Round-trip: the returned signature really recovers to the account.
    expect(verifyMessage(message, signature)).toBe(phoneWallet.address);
  });

  test('utf8 string messages sign over their bytes', async () => {
    mockRequestRemoteSignature.mockImplementation(async ({ params }) => {
      expect(params[0]).toBe('0x' + Buffer.from('plain text', 'utf8').toString('hex'));
      return phoneWallet.signMessage('plain text');
    });
    await expect(backend.signMessage('plain text')).resolves.toMatch(/^0x/);
  });

  test('rejects a signature from a different account with REMOTE_WRONG_ACCOUNT', async () => {
    mockRequestRemoteSignature.mockImplementation(async () => strangerWallet.signMessage('hello'));
    await expect(backend.signMessage('hello')).rejects.toMatchObject({
      code: 'REMOTE_WRONG_ACCOUNT',
    });
  });

  test('rejects malformed responses with REMOTE_BAD_RESPONSE', async () => {
    mockRequestRemoteSignature.mockResolvedValue('not-a-signature');
    await expect(backend.signMessage('hello')).rejects.toMatchObject({
      code: 'REMOTE_BAD_RESPONSE',
    });
  });
});

const TYPED_DATA = {
  domain: { name: 'Freedom Test', version: '1', chainId: 100 },
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
    ],
    Payment: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
  message: { to: strangerWallet.address, amount: '1000' },
};

const strippedTypes = { Payment: TYPED_DATA.types.Payment };

describe('signTypedData', () => {
  test('publishes eth_signTypedData_v4 with the full wire payload and verifies the signature', async () => {
    mockRequestRemoteSignature.mockImplementation(async ({ method, params }) => {
      expect(method).toBe('eth_signTypedData_v4');
      expect(params[0]).toBe(phoneWallet.address);
      const payload = JSON.parse(params[1]);
      // Wire shape: EIP712Domain restored into types, explicit primaryType.
      expect(payload.primaryType).toBe('Payment');
      expect(payload.types.EIP712Domain).toBeDefined();
      // getPayload normalizes quantities to hex on the wire.
      expect(payload.domain).toEqual({ ...TYPED_DATA.domain, chainId: '0x64' });
      return phoneWallet.signTypedData(TYPED_DATA.domain, strippedTypes, TYPED_DATA.message);
    });

    const signature = await backend.signTypedData(TYPED_DATA);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/i);
  });

  test('accepts ethers-style payloads without EIP712Domain in types', async () => {
    mockRequestRemoteSignature.mockImplementation(async ({ params }) => {
      expect(JSON.parse(params[1]).types.EIP712Domain).toBeDefined();
      return phoneWallet.signTypedData(TYPED_DATA.domain, strippedTypes, TYPED_DATA.message);
    });
    await expect(
      backend.signTypedData({ domain: TYPED_DATA.domain, types: strippedTypes, message: TYPED_DATA.message }),
    ).resolves.toMatch(/^0x/);
  });

  test('rejects a typed-data signature from a different account', async () => {
    mockRequestRemoteSignature.mockImplementation(async () =>
      strangerWallet.signTypedData(TYPED_DATA.domain, strippedTypes, TYPED_DATA.message));
    await expect(backend.signTypedData(TYPED_DATA)).rejects.toMatchObject({
      code: 'REMOTE_WRONG_ACCOUNT',
    });
  });
});

describe('sendTransaction', () => {
  const TX = { to: strangerWallet.address, value: '1500000000000000', data: '0xabcdef', chainId: 100 };
  const HASH = '0x' + 'ab'.repeat(32);

  test('publishes eth_sendTransaction with hex quantities and returns the phone-reported hash', async () => {
    mockRequestRemoteSignature.mockImplementation(async ({ method, params, chain }) => {
      expect(method).toBe('eth_sendTransaction');
      expect(params).toEqual([
        {
          from: phoneWallet.address,
          to: TX.to,
          value: '0x5543df729c000',
          chainId: '0x64',
          data: '0xabcdef',
        },
      ]);
      // EIP-3085 descriptor for the pre-flight chain switch: public
      // https endpoints only — the localhost RPC must not leak.
      expect(chain).toEqual({
        chainId: '0x64',
        chainName: 'Gnosis Chain',
        nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
        blockExplorerUrls: ['https://gnosisscan.io'],
        rpcUrls: ['https://rpc.gnosischain.com'],
      });
      return HASH;
    });

    await expect(backend.sendTransaction(TX)).resolves.toBe(HASH);
  });

  test('unknown chains still ship a minimal descriptor (chainId only)', async () => {
    mockRequestRemoteSignature.mockImplementation(async ({ chain }) => {
      expect(chain).toEqual({ chainId: '0x539' });
      return HASH;
    });
    await expect(backend.sendTransaction({ to: TX.to, chainId: 1337 })).resolves.toBe(HASH);
  });

  test('omits value/data defaults and rejects malformed hashes with REMOTE_BAD_RESPONSE', async () => {
    mockRequestRemoteSignature.mockImplementation(async ({ params }) => {
      expect(params[0].value).toBe('0x0');
      expect(params[0].data).toBeUndefined();
      return 'not-a-hash';
    });
    await expect(backend.sendTransaction({ to: TX.to, chainId: 100 })).rejects.toMatchObject({
      code: 'REMOTE_BAD_RESPONSE',
    });
  });
});
