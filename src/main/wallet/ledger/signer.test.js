/**
 * The fake device signs with a real (well-known test) key, so every
 * assertion verifies actual cryptographic round-trips: what the backend
 * hands to hw-app-eth, and that the reassembled signature recovers to
 * the device address.
 */

const {
  Wallet,
  Transaction,
  Signature,
  TypedDataEncoder,
  verifyMessage,
  verifyTypedData,
  hashMessage,
} = require('ethers');

// Anvil/Hardhat-default test key — well-known, never funded on mainnet.
const TEST_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const deviceWallet = new Wallet(TEST_PRIVATE_KEY);

const RECORD = {
  index: 2,
  name: 'My Stax',
  address: deviceWallet.address,
  type: 'ledger',
  path: "44'/60'/0'/0/0",
};

/** Split an ethers Signature into the {r, s, v} shape hw-app-eth returns. */
function toDeviceSig(signature, { vAsHexString = false } = {}) {
  const sig = Signature.from(signature);
  return {
    r: sig.r.slice(2),
    s: sig.s.slice(2),
    v: vAsHexString ? sig.v.toString(16) : sig.v,
  };
}

// Fake hw-app-eth instance backed by the test key.
const mockEth = {
  getAddress: jest.fn(),
  signTransaction: jest.fn(),
  signPersonalMessage: jest.fn(),
  signEIP712Message: jest.fn(),
  signEIP712HashedMessage: jest.fn(),
};

jest.mock('./transport', () => ({
  withEthApp: (task) => task(mockEth),
}));

const { createLedgerBackend } = require('./signer');

beforeEach(() => {
  mockEth.getAddress.mockReset().mockResolvedValue({ address: deviceWallet.address });
  mockEth.signTransaction.mockReset();
  mockEth.signPersonalMessage.mockReset();
  mockEth.signEIP712Message.mockReset();
  mockEth.signEIP712HashedMessage.mockReset();
});

describe('createLedgerBackend / signTransaction', () => {
  const TX = {
    to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    value: '1000',
    gasLimit: '21000',
    maxFeePerGas: '2000000000',
    maxPriorityFeePerGas: '1000000000',
    nonce: 7,
    chainId: 8453,
    type: 2,
  };

  test('sends the unsigned serialization to the device and reassembles a valid signed tx', async () => {
    mockEth.signTransaction.mockImplementation(async (path, rawHex) => {
      expect(path).toBe(RECORD.path);
      // The device signs exactly what ethers considers the unsigned tx.
      expect('0x' + rawHex).toBe(Transaction.from(TX).unsignedSerialized);
      const signed = Transaction.from(await deviceWallet.signTransaction(TX));
      return toDeviceSig(signed.signature, { vAsHexString: true });
    });

    const backend = createLedgerBackend(RECORD);
    const signedTx = await backend.signTransaction(TX);

    const parsed = Transaction.from(signedTx);
    expect(parsed.from).toBe(deviceWallet.address);
    expect(parsed.nonce).toBe(7);
    expect(parsed.chainId).toBe(8453n);
  });

  test('refuses to sign when the attached device derives a different address', async () => {
    mockEth.getAddress.mockResolvedValue({ address: '0x0000000000000000000000000000000000000bad' });

    const backend = createLedgerBackend(RECORD);
    await expect(backend.signTransaction(TX)).rejects.toMatchObject({ code: 'LEDGER_WRONG_DEVICE' });
    expect(mockEth.signTransaction).not.toHaveBeenCalled();
  });

  test('surfaces on-device rejection with its stable code', async () => {
    const rejection = new Error('denied');
    rejection.statusCode = 0x6985;
    mockEth.signTransaction.mockRejectedValue(rejection);

    const backend = createLedgerBackend(RECORD);
    // withEthApp is mocked pass-through here, so the raw APDU error
    // surfaces; in production the transport queue maps it. Assert the
    // status code is preserved for that mapping.
    await expect(backend.signTransaction(TX)).rejects.toMatchObject({ statusCode: 0x6985 });
  });
});

describe('createLedgerBackend / signMessage', () => {
  beforeEach(() => {
    mockEth.signPersonalMessage.mockImplementation(async (path, messageHex) => {
      expect(path).toBe(RECORD.path);
      const bytes = Buffer.from(messageHex, 'hex');
      const sig = deviceWallet.signingKey.sign(hashMessage(bytes));
      return toDeviceSig(sig);
    });
  });

  test('signs UTF-8 string messages (EIP-191)', async () => {
    const backend = createLedgerBackend(RECORD);
    const signature = await backend.signMessage('hello freedom');
    expect(verifyMessage('hello freedom', signature)).toBe(deviceWallet.address);
  });

  test('signs raw bytes (pre-normalized 0x-hex dApp messages)', async () => {
    const backend = createLedgerBackend(RECORD);
    const bytes = Buffer.from('fffefd00010203deadbeef', 'hex');
    const signature = await backend.signMessage(bytes);
    expect(verifyMessage(bytes, signature)).toBe(deviceWallet.address);
  });

  test.each(['0x', '', Buffer.alloc(0)])('refuses empty message (%p) before device call', async (emptyMessage) => {
    const backend = createLedgerBackend(RECORD);
    await expect(backend.signMessage(emptyMessage)).rejects.toMatchObject({
      code: 'LEDGER_EMPTY_MESSAGE',
      message: 'Ledger cannot sign an empty message.',
    });
    expect(mockEth.getAddress).not.toHaveBeenCalled();
    expect(mockEth.signPersonalMessage).not.toHaveBeenCalled();
  });
});

describe('createLedgerBackend / signTypedData', () => {
  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: 8453,
    verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
  };
  const message = {
    from: deviceWallet.address,
    to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    value: 10000n,
  };

  function deviceTypedSig() {
    const sig = deviceWallet.signingKey.sign(TypedDataEncoder.hash(domain, types, message));
    return toDeviceSig(sig);
  }

  test('passes the full payload (EIP712Domain + primaryType) to the device', async () => {
    mockEth.signEIP712Message.mockImplementation(async (path, payload) => {
      expect(path).toBe(RECORD.path);
      expect(payload.primaryType).toBe('TransferWithAuthorization');
      expect(payload.types.EIP712Domain).toEqual([
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ]);
      return deviceTypedSig();
    });

    const backend = createLedgerBackend(RECORD);
    // ethers-style payload: no EIP712Domain in types, no primaryType —
    // the backend must fill both in for the device.
    const signature = await backend.signTypedData({ domain, types, message });
    expect(verifyTypedData(domain, types, message, signature)).toBe(deviceWallet.address);
  });

  test('falls back to hashed-message signing on apps without full EIP-712 support', async () => {
    const noFullSupport = new Error('INS not supported');
    noFullSupport.statusCode = 0x6d00;
    mockEth.signEIP712Message.mockRejectedValue(noFullSupport);
    mockEth.signEIP712HashedMessage.mockImplementation(async (path, domainSeparatorHex, structHashHex) => {
      expect('0x' + domainSeparatorHex).toBe(TypedDataEncoder.hashDomain(domain));
      expect('0x' + structHashHex).toBe(TypedDataEncoder.from(types).hash(message));
      return deviceTypedSig();
    });

    const backend = createLedgerBackend(RECORD);
    const signature = await backend.signTypedData({ domain, types, primaryType: 'TransferWithAuthorization', message });
    expect(verifyTypedData(domain, types, message, signature)).toBe(deviceWallet.address);
    expect(mockEth.signEIP712HashedMessage).toHaveBeenCalledTimes(1);
  });

  test('non-fallback device errors propagate', async () => {
    const rejection = new Error('denied');
    rejection.statusCode = 0x6985;
    mockEth.signEIP712Message.mockRejectedValue(rejection);

    const backend = createLedgerBackend(RECORD);
    await expect(backend.signTypedData({ domain, types, message })).rejects.toMatchObject({ statusCode: 0x6985 });
    expect(mockEth.signEIP712HashedMessage).not.toHaveBeenCalled();
  });
});
