const { Wallet, Transaction, verifyMessage, verifyTypedData, getBytes } = require('ethers');

// Anvil/Hardhat-default test key — well-known, never funded on mainnet.
const TEST_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const testWallet = new Wallet(TEST_PRIVATE_KEY);

const mockIdentity = {
  isUnlocked: jest.fn(),
  exportPrivateKey: jest.fn(),
};
const mockResetVaultAutoLockTimer = jest.fn();

const mockGetWalletRecord = jest.fn();
const mockLedgerBackend = {
  getAddress: jest.fn(),
  signTransaction: jest.fn(),
  signMessage: jest.fn(),
  signTypedData: jest.fn(),
};
const mockCreateLedgerBackend = jest.fn(() => mockLedgerBackend);
const mockRemoteBackend = {
  getAddress: jest.fn(),
  signTransaction: jest.fn(),
  signMessage: jest.fn(),
  signTypedData: jest.fn(),
  sendTransaction: jest.fn(),
};
const mockCreateRemoteBackend = jest.fn(() => mockRemoteBackend);

jest.mock('../identity-manager', () => ({
  loadIdentityModule: jest.fn(async () => mockIdentity),
  getWalletRecord: (...args) => mockGetWalletRecord(...args),
  // Mirrors identity-manager's HARDWARE_INDEX_BASE (inlined: jest.mock
  // factories may not close over out-of-scope constants).
  isHardwareWalletIndex: (index) => Number.isInteger(index) && index >= 1000000,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
jest.mock('../vault-timer', () => ({
  resetVaultAutoLockTimer: mockResetVaultAutoLockTimer,
}));
jest.mock('./ledger/signer', () => ({
  createLedgerBackend: (...args) => mockCreateLedgerBackend(...args),
}));
jest.mock('./remote/signer', () => ({
  createRemoteBackend: (...args) => mockCreateRemoteBackend(...args),
}));

const { getSigner } = require('./signers');

beforeEach(() => {
  mockIdentity.isUnlocked.mockReset().mockReturnValue(true);
  mockIdentity.exportPrivateKey.mockReset().mockReturnValue(TEST_PRIVATE_KEY);
  mockGetWalletRecord.mockReset().mockReturnValue({ index: 0, name: 'Main Wallet', type: 'mnemonic' });
  mockResetVaultAutoLockTimer.mockClear();
});

describe('getSigner (vault-backed)', () => {
  test('rejects an invalid wallet index up front', () => {
    expect(() => getSigner(-1)).toThrow('Invalid wallet index');
    expect(() => getSigner('0')).toThrow('Invalid wallet index');
  });

  test('getAddress resolves the address for the wallet index', async () => {
    const signer = getSigner(0);
    await expect(signer.getAddress()).resolves.toBe(testWallet.address);
    expect(mockIdentity.exportPrivateKey).toHaveBeenCalledWith(0);
  });

  test('signMessage matches ethers Wallet.signMessage for plain text', async () => {
    const signer = getSigner(0);
    const signature = await signer.signMessage('hello freedom');
    expect(signature).toBe(await testWallet.signMessage('hello freedom'));
    expect(verifyMessage('hello freedom', signature)).toBe(testWallet.address);
  });

  test.each([
    ['hex-encoded text', '0x48656c6c6f'],
    ['binary data that is not valid UTF-8', '0xfffefd00010203deadbeef'],
    ['a 32-byte hash', '0x' + 'ab'.repeat(32)],
  ])('signMessage treats 0x-hex input as raw bytes: %s', async (_label, hexMessage) => {
    const signer = getSigner(0);
    const signature = await signer.signMessage(hexMessage);
    expect(signature).toBe(await testWallet.signMessage(getBytes(hexMessage)));
    expect(verifyMessage(getBytes(hexMessage), signature)).toBe(testWallet.address);
  });

  test('signTypedData accepts a full EIP-712 payload including EIP712Domain in types', async () => {
    const signer = getSigner(0);
    const domain = { name: 'Test', version: '1', chainId: 1 };
    const types = {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      Mail: [
        { name: 'contents', type: 'string' },
      ],
    };
    const message = { contents: 'gm' };

    const signature = await signer.signTypedData({ domain, types, primaryType: 'Mail', message });
    expect(verifyTypedData(domain, { Mail: types.Mail }, message, signature)).toBe(testWallet.address);

    // dApps also send the payload as a JSON string (eth_signTypedData_v4)
    const fromJson = await signer.signTypedData(JSON.stringify({ domain, types, primaryType: 'Mail', message }));
    expect(fromJson).toBe(signature);
  });

  test('getAddress memoizes: repeated calls borrow the vault key once', async () => {
    const signer = getSigner(0);
    await signer.getAddress();
    await signer.getAddress();
    expect(mockIdentity.exportPrivateKey).toHaveBeenCalledTimes(1);
  });

  test('signTransaction returns a serialized signed tx recoverable to the wallet', async () => {
    const signer = getSigner(0);
    const signedTx = await signer.signTransaction({
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: '1000',
      gasLimit: '21000',
      maxFeePerGas: '2000000000',
      maxPriorityFeePerGas: '1000000000',
      nonce: 7,
      chainId: 8453,
      type: 2,
    });

    const parsed = Transaction.from(signedTx);
    expect(parsed.from).toBe(testWallet.address);
    expect(parsed.nonce).toBe(7);
    expect(parsed.chainId).toBe(8453n);
    expect(parsed.to).toBe('0x209693Bc6afc0C5328bA36FaF03C514EF312287C');
  });

  test('every method rejects when the vault is locked', async () => {
    mockIdentity.isUnlocked.mockReturnValue(false);
    const signer = getSigner(0);
    await expect(signer.getAddress()).rejects.toThrow(/locked/i);
    await expect(signer.signMessage('x')).rejects.toThrow(/locked/i);
    await expect(signer.signTypedData({ domain: {}, types: {}, message: {} })).rejects.toThrow(/locked/i);
    await expect(signer.signTransaction({ chainId: 1 })).rejects.toThrow(/locked/i);
    expect(mockResetVaultAutoLockTimer).not.toHaveBeenCalled();
  });

  test('successful signing resets the vault auto-lock timer', async () => {
    const signer = getSigner(0);
    await signer.signMessage('keep the vault alive');
    expect(mockResetVaultAutoLockTimer).toHaveBeenCalledTimes(1);
  });

  test('an unknown wallet record falls through to the vault backend', async () => {
    mockGetWalletRecord.mockReturnValue(null);
    const signer = getSigner(3);
    await expect(signer.getAddress()).resolves.toBe(testWallet.address);
    expect(mockIdentity.exportPrivateKey).toHaveBeenCalledWith(3);
  });
});

describe('getSigner (ledger-backed dispatch)', () => {
  const LEDGER_RECORD = {
    index: 2,
    name: 'My Stax',
    address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    type: 'ledger',
    path: "44'/60'/0'/0/0",
  };

  beforeEach(() => {
    mockGetWalletRecord.mockReturnValue(LEDGER_RECORD);
    mockLedgerBackend.getAddress.mockReset().mockResolvedValue(LEDGER_RECORD.address);
    mockLedgerBackend.signTransaction.mockReset().mockResolvedValue('0xsignedtx');
    mockLedgerBackend.signMessage.mockReset().mockResolvedValue('0xsig');
    mockLedgerBackend.signTypedData.mockReset().mockResolvedValue('0xsig712');
    mockCreateLedgerBackend.mockClear();
  });

  test('routes to the ledger backend built from the wallet record, never the vault', async () => {
    const signer = getSigner(2);
    await expect(signer.getAddress()).resolves.toBe(LEDGER_RECORD.address);
    await expect(signer.signTransaction({ chainId: 1 })).resolves.toBe('0xsignedtx');
    expect(mockCreateLedgerBackend).toHaveBeenCalledWith(LEDGER_RECORD);
    expect(mockIdentity.isUnlocked).not.toHaveBeenCalled();
    expect(mockIdentity.exportPrivateKey).not.toHaveBeenCalled();
  });

  test('factory-level normalization applies to ledger backends too', async () => {
    const signer = getSigner(2);

    // 0x-hex message reaches the backend as raw bytes
    await signer.signMessage('0x48656c6c6f');
    expect(mockLedgerBackend.signMessage).toHaveBeenCalledWith(Buffer.from('Hello', 'utf8'));

    // JSON-string typed data reaches the backend parsed
    await signer.signTypedData('{"domain":{},"types":{},"message":{}}');
    expect(mockLedgerBackend.signTypedData).toHaveBeenCalledWith({ domain: {}, types: {}, message: {} });
  });

  test('vault and ledger signers do not advertise the sendTransaction capability', () => {
    expect(getSigner(2).sendTransaction).toBeUndefined();
    mockGetWalletRecord.mockReturnValue({ index: 0, name: 'Main Wallet', type: 'mnemonic' });
    expect(getSigner(0).sendTransaction).toBeUndefined();
  });

  test('a deleted hardware account fails loudly instead of falling through to the vault', () => {
    // Deleting a Ledger leaves no record, so the type check can't fire.
    // A stale reference to its index (dApp permission, publisher identity)
    // must not reach the vault backend, which would derive and sign with a
    // phantom mnemonic key at that index.
    mockGetWalletRecord.mockReturnValue(null);
    expect(() => getSigner(1000000)).toThrow('Device account no longer exists');
    expect(mockIdentity.exportPrivateKey).not.toHaveBeenCalled();
    expect(mockCreateLedgerBackend).not.toHaveBeenCalled();
  });
});

describe('getSigner (safe records)', () => {
  test('throws: a Safe is an account, not a signer', () => {
    mockGetWalletRecord.mockReturnValue({
      index: 5,
      name: 'Joint account',
      address: '0x41aD4887971f90BB3fE4d83eCa65177281283261',
      type: 'safe',
    });
    expect(() => getSigner(5)).toThrow(/Safe account.*cannot sign directly/i);
    expect(mockIdentity.exportPrivateKey).not.toHaveBeenCalled();
  });
});

describe('getSigner (remote-backed dispatch)', () => {
  const REMOTE_RECORD = {
    index: 4,
    name: 'My Phone',
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    type: 'remote',
  };

  beforeEach(() => {
    mockGetWalletRecord.mockReturnValue(REMOTE_RECORD);
    mockRemoteBackend.getAddress.mockReset().mockResolvedValue(REMOTE_RECORD.address);
    mockRemoteBackend.signMessage.mockReset().mockResolvedValue('0xsig');
    mockRemoteBackend.sendTransaction.mockReset().mockResolvedValue('0xhash');
    mockCreateRemoteBackend.mockClear();
  });

  test('routes to the remote backend built from the wallet record, never the vault', async () => {
    const signer = getSigner(4);
    await expect(signer.getAddress()).resolves.toBe(REMOTE_RECORD.address);
    expect(mockCreateRemoteBackend).toHaveBeenCalledWith(REMOTE_RECORD);
    expect(mockIdentity.isUnlocked).not.toHaveBeenCalled();
    expect(mockIdentity.exportPrivateKey).not.toHaveBeenCalled();
  });

  test('advertises the backend sendTransaction capability', async () => {
    const signer = getSigner(4);
    await expect(signer.sendTransaction({ to: '0x1', chainId: 100 })).resolves.toBe('0xhash');
    expect(mockRemoteBackend.sendTransaction).toHaveBeenCalledWith({ to: '0x1', chainId: 100 });
  });

  test('factory-level normalization applies to remote backends too', async () => {
    const signer = getSigner(4);
    await signer.signMessage('0x48656c6c6f');
    expect(mockRemoteBackend.signMessage).toHaveBeenCalledWith(Buffer.from('Hello', 'utf8'));
  });
});
