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

  describe('typed data hw-app-eth would send wrongly (#1064)', () => {
    // hw-app-eth would drop the last byte of a 254-byte value.
    const blobTypes = { Blob: [{ name: 'data', type: 'bytes' }] };
    const blobMessage = { data: '0x' + 'ab'.repeat(254) };

    afterEach(() => {
      delete mockEth.transport;
    });

    test('is refused without sending any of it to the device', async () => {
      mockEth.transport = { deviceModel: { id: 'nanoX' } };
      const backend = createLedgerBackend(RECORD);

      await expect(
        backend.signTypedData({ domain, types: blobTypes, message: blobMessage })
      ).rejects.toMatchObject({
        code: 'LEDGER_TYPED_DATA_UNSUPPORTED',
        detail: 'message.data is 254 bytes',
      });
      expect(mockEth.signEIP712Message).not.toHaveBeenCalled();
      expect(mockEth.signEIP712HashedMessage).not.toHaveBeenCalled();
    });

    test('is still signed by hash on the original Nano S, which never reads it field by field', async () => {
      mockEth.transport = { deviceModel: { id: 'nanoS' } };
      const noFullSupport = new Error('INS not supported');
      noFullSupport.statusCode = 0x6d00;
      mockEth.signEIP712Message.mockRejectedValue(noFullSupport);
      mockEth.signEIP712HashedMessage.mockResolvedValue(
        toDeviceSig(
          deviceWallet.signingKey.sign(TypedDataEncoder.hash(domain, blobTypes, blobMessage))
        )
      );

      const backend = createLedgerBackend(RECORD);
      const signature = await backend.signTypedData({
        domain,
        types: blobTypes,
        message: blobMessage,
      });
      expect(verifyTypedData(domain, blobTypes, blobMessage, signature)).toBe(deviceWallet.address);
      expect(mockEth.signEIP712HashedMessage).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * #1063: the device's answer is never trusted. Each kind refuses, with
 * LEDGER_BAD_SIGNATURE and no result, a signature from another key, one
 * with the wrong `v`, and one over something other than what was asked.
 */
describe('createLedgerBackend / every signature is recovered against the account', () => {
  // Another well-known test key: the "wrong device" answers with it.
  const otherWallet = new Wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
  const BAD = { code: 'LEDGER_BAD_SIGNATURE', message: expect.stringMatching(/doesn't match this request/) };

  /** The same r/s with the other parity. */
  function flipV(deviceSig) {
    const v = typeof deviceSig.v === 'string' ? Number.parseInt(deviceSig.v, 16) : deviceSig.v;
    const flipped = v === 0 || v === 1 ? 1 - v : v % 2 === 0 ? v - 1 : v + 1;
    return {
      ...deviceSig,
      v: typeof deviceSig.v === 'string' ? flipped.toString(16).padStart(2, '0') : flipped,
    };
  }

  describe('transactions', () => {
    const TX_1559 = {
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: '1000',
      gasLimit: '21000',
      maxFeePerGas: '2000000000',
      maxPriorityFeePerGas: '1000000000',
      nonce: 7,
      chainId: 8453,
      type: 2,
    };
    const TX_LEGACY = {
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: '1000',
      gasLimit: '21000',
      gasPrice: '7',
      nonce: 3,
      chainId: 100,
      type: 0,
    };

    async function deviceTxSig(wallet, tx) {
      const signed = Transaction.from(await wallet.signTransaction(tx));
      return toDeviceSig(signed.signature, { vAsHexString: true });
    }

    test.each([
      ['type 2', TX_1559],
      ['legacy', TX_LEGACY],
    ])('%s: the honest signature passes and recovers to the account', async (_label, tx) => {
      mockEth.signTransaction.mockResolvedValue(await deviceTxSig(deviceWallet, tx));
      const raw = await createLedgerBackend(RECORD).signTransaction(tx);
      expect(Transaction.from(raw).from).toBe(deviceWallet.address);
    });

    test.each([
      ['type 2', TX_1559],
      ['legacy', TX_LEGACY],
    ])('%s: a signature from another key is refused', async (_label, tx) => {
      mockEth.signTransaction.mockResolvedValue(await deviceTxSig(otherWallet, tx));
      await expect(createLedgerBackend(RECORD).signTransaction(tx)).rejects.toMatchObject(BAD);
    });

    test.each([
      ['type 2', TX_1559],
      ['legacy', TX_LEGACY],
    ])('%s: the wrong v is refused', async (_label, tx) => {
      mockEth.signTransaction.mockResolvedValue(flipV(await deviceTxSig(deviceWallet, tx)));
      await expect(createLedgerBackend(RECORD).signTransaction(tx)).rejects.toMatchObject(BAD);
    });

    test('legacy: a v for another chain is refused', async () => {
      const sig = await deviceTxSig(deviceWallet, TX_LEGACY);
      const parity = (Number.parseInt(sig.v, 16) - 35) % 2;
      mockEth.signTransaction.mockResolvedValue({ ...sig, v: (1 * 2 + 35 + parity).toString(16) });
      await expect(createLedgerBackend(RECORD).signTransaction(TX_LEGACY)).rejects.toMatchObject(BAD);
    });

    test('a v that is no parity at all is refused', async () => {
      const sig = await deviceTxSig(deviceWallet, TX_1559);
      mockEth.signTransaction.mockResolvedValue({ ...sig, v: '05' });
      await expect(createLedgerBackend(RECORD).signTransaction(TX_1559)).rejects.toMatchObject(BAD);
    });

    test.each([
      ['type 2', TX_1559],
      ['legacy', TX_LEGACY],
    ])('%s: the account\'s signature over another transaction is refused', async (_label, tx) => {
      const other = { ...tx, value: '1000000000000000000' };
      mockEth.signTransaction.mockResolvedValue(await deviceTxSig(deviceWallet, other));
      await expect(createLedgerBackend(RECORD).signTransaction(tx)).rejects.toMatchObject(BAD);
    });
  });

  describe('personal messages', () => {
    const MESSAGE = 'Sign in to example.org';
    const deviceMessageSig = (wallet, message) =>
      toDeviceSig(wallet.signingKey.sign(hashMessage(message)));

    test('a signature from another key is refused', async () => {
      mockEth.signPersonalMessage.mockResolvedValue(deviceMessageSig(otherWallet, MESSAGE));
      await expect(createLedgerBackend(RECORD).signMessage(MESSAGE)).rejects.toMatchObject(BAD);
    });

    test('the wrong v is refused', async () => {
      mockEth.signPersonalMessage.mockResolvedValue(flipV(deviceMessageSig(deviceWallet, MESSAGE)));
      await expect(createLedgerBackend(RECORD).signMessage(MESSAGE)).rejects.toMatchObject(BAD);
    });

    test('the account\'s signature over another message is refused', async () => {
      mockEth.signPersonalMessage.mockResolvedValue(deviceMessageSig(deviceWallet, 'Send everything'));
      await expect(createLedgerBackend(RECORD).signMessage(MESSAGE)).rejects.toMatchObject(BAD);
    });

    test('a v that is no parity at all is refused', async () => {
      const sig = deviceMessageSig(deviceWallet, MESSAGE);
      mockEth.signPersonalMessage.mockResolvedValue({ ...sig, v: 5 });
      await expect(createLedgerBackend(RECORD).signMessage(MESSAGE)).rejects.toMatchObject(BAD);
    });

    test('an r that is no signature at all is refused', async () => {
      const sig = deviceMessageSig(deviceWallet, MESSAGE);
      mockEth.signPersonalMessage.mockResolvedValue({ ...sig, r: '00'.repeat(32) });
      await expect(createLedgerBackend(RECORD).signMessage(MESSAGE)).rejects.toMatchObject(BAD);
    });
  });

  describe('typed data', () => {
    const domain = { name: 'Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' };
    const types = { Mail: [{ name: 'contents', type: 'string' }] };
    const message = { contents: 'Hello, Bob!' };
    const deviceTypedSig = (wallet, msg = message) =>
      toDeviceSig(wallet.signingKey.sign(TypedDataEncoder.hash(domain, types, msg)));
    const cases = (answer) => [
      ['field by field', () => mockEth.signEIP712Message.mockResolvedValue(answer())],
      [
        'the hashed fallback',
        () => {
          const noFullSupport = Object.assign(new Error('INS not supported'), { statusCode: 0x6d00 });
          mockEth.signEIP712Message.mockRejectedValue(noFullSupport);
          mockEth.signEIP712HashedMessage.mockResolvedValue(answer());
        },
      ],
    ];

    test.each(cases(() => deviceTypedSig(otherWallet)))(
      '%s: a signature from another key is refused',
      async (_label, arrange) => {
        arrange();
        await expect(createLedgerBackend(RECORD).signTypedData({ domain, types, message }))
          .rejects.toMatchObject(BAD);
      }
    );

    test.each(cases(() => flipV(deviceTypedSig(deviceWallet))))(
      '%s: the wrong v is refused',
      async (_label, arrange) => {
        arrange();
        await expect(createLedgerBackend(RECORD).signTypedData({ domain, types, message }))
          .rejects.toMatchObject(BAD);
      }
    );

    test.each(cases(() => ({ ...deviceTypedSig(deviceWallet), v: 5 })))(
      '%s: a v that is no parity at all is refused',
      async (_label, arrange) => {
        arrange();
        await expect(createLedgerBackend(RECORD).signTypedData({ domain, types, message }))
          .rejects.toMatchObject(BAD);
      }
    );

    test.each(cases(() => deviceTypedSig(deviceWallet, { contents: 'Hello, Mallory!' })))(
      '%s: the account\'s signature over other typed data is refused',
      async (_label, arrange) => {
        arrange();
        await expect(createLedgerBackend(RECORD).signTypedData({ domain, types, message }))
          .rejects.toMatchObject(BAD);
      }
    );
  });
});

/**
 * #1065: a record added before main read addresses back from the device
 * is checked by the first device that signs for it, and can't sign until
 * one matches it.
 */
describe('createLedgerBackend / the device check is kept on the record', () => {
  const UNCHECKED = { ...RECORD, addressCheck: 'unchecked' };

  beforeEach(() => {
    mockEth.signPersonalMessage.mockImplementation(async (_path, messageHex) =>
      toDeviceSig(deviceWallet.signingKey.sign(hashMessage(Buffer.from(messageHex, 'hex')))));
  });

  test('a device that holds the address passes the check, and then signs', async () => {
    const onAddressCheck = jest.fn();
    const signature = await createLedgerBackend(UNCHECKED, { onAddressCheck }).signMessage('hi');
    expect(verifyMessage('hi', signature)).toBe(deviceWallet.address);
    expect(onAddressCheck).toHaveBeenCalledWith(true);
    expect(onAddressCheck.mock.invocationCallOrder[0])
      .toBeLessThan(mockEth.signPersonalMessage.mock.invocationCallOrder[0]);
  });

  test('a device that holds another address fails the check, and nothing is signed', async () => {
    mockEth.getAddress.mockResolvedValue({ address: '0x0000000000000000000000000000000000000bad' });
    const onAddressCheck = jest.fn();
    await expect(createLedgerBackend(UNCHECKED, { onAddressCheck }).signMessage('hi'))
      .rejects.toMatchObject({ code: 'LEDGER_WRONG_DEVICE' });
    expect(onAddressCheck).toHaveBeenCalledWith(false);
    expect(mockEth.signPersonalMessage).not.toHaveBeenCalled();
  });

  test('a failure to keep the check does not change the outcome', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const onAddressCheck = jest.fn(() => {
      throw new Error('disk full');
    });
    const signature = await createLedgerBackend(UNCHECKED, { onAddressCheck }).signMessage('hi');
    expect(verifyMessage('hi', signature)).toBe(deviceWallet.address);
  });
});
