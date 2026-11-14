const { Wallet, Transaction, TypedDataEncoder, verifyMessage, verifyTypedData, getBytes } = require('ethers');

// Anvil/Hardhat-default test key — well-known, never funded on mainnet.
const TEST_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const testWallet = new Wallet(TEST_PRIVATE_KEY);

const mockIdentity = {
  isUnlocked: jest.fn(),
  exportPrivateKey: jest.fn(),
};
const mockResetVaultAutoLockTimer = jest.fn();

const mockGetWalletRecord = jest.fn();
const mockRecordRemoteAddressCheck = jest.fn();
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

// The identity core's signing (freedom-core design 0002), simulated with
// ethers and the test key: the real core matches ethers byte for byte
// (freedom-core's vectors/signing.json). mockIdentity drives the lock and
// the key; mockCore records every call.
const mockCore = { calls: [] };
jest.mock('../core/vault-backend', () => ({
  vaultBackend: require('../../../test/helpers/simulated-vault-core').simulatedVaultBackend(
    mockIdentity,
    mockCore
  ),
}));
const coreCalls = (method) => mockCore.calls.filter(([name]) => name === method);
const mockRecordLedgerAddressCheck = jest.fn();
jest.mock('../identity-manager', () => ({
  getWalletRecord: (...args) => mockGetWalletRecord(...args),
  recordLedgerAddressCheck: (...args) => mockRecordLedgerAddressCheck(...args),
  recordRemoteAddressCheck: (...args) => mockRecordRemoteAddressCheck(...args),
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
  mockCore.calls = [];
});

describe('getSigner (vault-backed)', () => {
  test('rejects an invalid wallet index up front', () => {
    expect(() => getSigner(-1)).toThrow('Invalid wallet index');
    expect(() => getSigner('0')).toThrow('Invalid wallet index');
  });

  test('getAddress resolves the address for the wallet index', async () => {
    const signer = getSigner(0);
    await expect(signer.getAddress()).resolves.toBe(testWallet.address);
    expect(coreCalls('keys.addresses')).toEqual([['keys.addresses', [0]]]);
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

  test('getAddress memoizes: repeated calls ask the core once', async () => {
    const signer = getSigner(0);
    await signer.getAddress();
    await signer.getAddress();
    expect(coreCalls('keys.addresses')).toHaveLength(1);
  });

  test('the core gets a key reference and wire-form inputs, never a key', async () => {
    const signer = getSigner(0);
    await signer.signTransaction({
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: 1000n,
      gasLimit: 21000,
      gasPrice: '7',
      nonce: 3,
      chainId: 100,
      type: 0,
    });
    const [, key, tx] = coreCalls('sign.transaction')[0];
    expect(key).toEqual({ kind: 'account', index: 0 });
    expect(tx).toEqual({
      type: 0,
      chain_id: '100',
      nonce: '3',
      gas_limit: '21000',
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: '1000',
      data: '0x',
      gas_price: '7',
    });
  });

  test('x402-style BigInt and byte values reach the core as strings and hex', async () => {
    const signer = getSigner(0);
    const types = {
      TransferWithAuthorization: [
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };
    const domain = { name: 'USD Coin', version: '2', chainId: 8453n };
    const message = { value: 10000n, nonce: new Uint8Array(32).fill(0x42) };
    const signature = await signer.signTypedData({ domain, types, primaryType: 'TransferWithAuthorization', message });
    const [, , data] = coreCalls('sign.typed_data')[0];
    expect(data.domain.chainId).toBe('8453');
    expect(data.message).toEqual({ value: '10000', nonce: '0x' + '42'.repeat(32) });
    expect(verifyTypedData(domain, types, message, signature)).toBe(testWallet.address);
  });

  test('a lock right after the core signs does not discard the signature', async () => {
    const signer = getSigner(0);
    // The simulated core locks the vault as soon as it has signed (its
    // first key use is the address lookup, the second the signature).
    let uses = 0;
    mockIdentity.exportPrivateKey.mockImplementation(() => {
      uses += 1;
      if (uses === 2) queueMicrotask(() => mockIdentity.isUnlocked.mockReturnValue(false));
      return TEST_PRIVATE_KEY;
    });
    await expect(signer.signMessage('just in time')).resolves.toBe(
      await testWallet.signMessage('just in time')
    );
  });

  test('a diamond-shaped type graph is refused before any backend walks it', async () => {
    // 40 levels: ethers' TypedDataEncoder would visit 2^40 paths.
    const types = {};
    for (let level = 0; level < 40; level += 1) {
      types[`T${level}`] = [
        { name: 'a', type: `A${level}` },
        { name: 'b', type: `B${level}` },
      ];
      types[`A${level}`] = [{ name: 'x', type: `T${level + 1}` }];
      types[`B${level}`] = [{ name: 'x', type: `T${level + 1}` }];
    }
    types.T40 = [{ name: 'v', type: 'uint8' }];
    const started = Date.now();
    await expect(getSigner(0).signTypedData({ domain: {}, types, message: {} })).rejects.toThrow(
      'too many nested types'
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(mockCore.calls).toEqual([]);
  });

  test('the type-graph guard is linear on malformed type text', async () => {
    // Many '[' then a newline: an unanchored /\[.*$/ would rescan from each.
    const type = 'Inner' + '['.repeat(200000) + '\nx';
    const types = { Outer: [{ name: 'f', type }], Inner: [{ name: 'v', type: 'uint8' }] };
    const { assertBoundedTypeGraph } = require('./signing-utils');
    const started = Date.now();
    assertBoundedTypeGraph(types);
    expect(Date.now() - started).toBeLessThan(100);
  });

  test('the type-graph guard refuses non-string field types without coercing them', () => {
    // A nested array would be stringified level by level: quadratic.
    let type = 'x'.repeat(1000);
    for (let level = 0; level < 2000; level += 1) type = [type, 1];
    const types = { Outer: [{ name: 'f', type }] };
    const { assertBoundedTypeGraph } = require('./signing-utils');
    const started = Date.now();
    expect(() => assertBoundedTypeGraph(types)).toThrow('field types must be strings');
    expect(Date.now() - started).toBeLessThan(100);
    for (const bad of [undefined, null, 7, {}]) {
      expect(() => assertBoundedTypeGraph({ M: [{ name: 'f', type: bad }] })).toThrow(
        'field types must be strings'
      );
    }
  });

  test('the type-graph guard bounds its work before scanning shared field arrays', () => {
    const { assertBoundedTypeGraph } = require('./signing-utils');
    // A structured clone keeps aliases: 16,000 types sharing one 16,000-field
    // array is a small message but 256 million field visits.
    const shared = Array.from({ length: 16000 }, (_, i) => ({ name: `f${i}`, type: 'uint8' }));
    const types = Object.fromEntries(Array.from({ length: 16000 }, (_, i) => [`T${i}`, shared]));
    const started = Date.now();
    expect(() => assertBoundedTypeGraph(structuredClone(types))).toThrow('too many');
    expect(Date.now() - started).toBeLessThan(1000);
    // Below the type cap, the shared array still counts once per type.
    const few = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`T${i}`, shared.slice(0, 6)]));
    expect(() => assertBoundedTypeGraph(few)).toThrow('too many fields');
    // The core's limits themselves are accepted.
    const atLimit = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`T${i}`, shared.slice(0, 256)]));
    expect(() => assertBoundedTypeGraph(atLimit)).not.toThrow();
    // EIP712Domain is stripped before the core sees it, so it isn't counted:
    // 256 message types, and 1,024 message fields, each plus the domain.
    const domain = [{ name: 'name', type: 'string' }];
    const maxTypes = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`T${i}`, shared.slice(0, 1)]));
    expect(() => assertBoundedTypeGraph({ ...maxTypes, EIP712Domain: domain })).not.toThrow();
    expect(() => assertBoundedTypeGraph({ ...atLimit, EIP712Domain: domain })).not.toThrow();
  });

  test('a field named __proto__ reaches the core as data', () => {
    // (ethers' own Wallet.signTypedData drops it; the core's encoder keeps
    // it, so the conversion must too.)
    const { toCoreTypedData } = require('./signing-utils');
    const types = { M: [{ name: '__proto__', type: 'uint256' }] };
    const message = JSON.parse('{"__proto__": "7"}');
    const data = toCoreTypedData({ domain: { name: 'x' }, types, message });
    expect(Object.getOwnPropertyNames(data.message)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(data.message, '__proto__').value).toBe('7');
    expect(JSON.stringify(data.message)).toBe('{"__proto__":"7"}');
  });

  test('a 0x message must be well-formed hex', async () => {
    const signer = getSigner(0);
    await expect(signer.signMessage('0xzz')).rejects.toThrow('Invalid hex message');
    await expect(signer.signMessage('0x123')).rejects.toThrow('Invalid hex message');
    expect(coreCalls('sign.message')).toHaveLength(0);
  });

  test('a transaction from another address is refused before the core signs', async () => {
    const signer = getSigner(0);
    await expect(
      signer.signTransaction({ from: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', chainId: 1, gasLimit: 21000, type: 0 })
    ).rejects.toThrow('transaction from address mismatch');
    expect(coreCalls('sign.transaction')).toHaveLength(0);
  });

  // freedom-core #88: the core signs only the digest passed as
  // expected_hash. A dApp's request passes the hash the user confirmed; a
  // request changed after that (here, by calling the signer with other
  // data, as a test hook) is refused by the core, and nothing is signed.
  test('typed data is signed only over the confirmed hash', async () => {
    const signer = getSigner(0);
    const typed = { domain: { name: 'D' }, types: { M: [{ name: 'v', type: 'uint8' }] }, message: { v: 1 } };
    const confirmed = TypedDataEncoder.hash(typed.domain, typed.types, typed.message);
    const signature = await signer.signTypedData(typed, { expectedHash: confirmed });
    expect(verifyTypedData(typed.domain, typed.types, typed.message, signature)).toBe(testWallet.address);
    expect(coreCalls('sign.typed_data').map(([, , , hash]) => hash)).toEqual([confirmed]);
    // No second hash: the confirmed one is the digest.
    expect(coreCalls('typed_data.hash')).toEqual([]);

    mockCore.calls = [];
    const altered = { ...typed, message: { v: 2 } };
    await expect(signer.signTypedData(altered, { expectedHash: confirmed })).rejects.toThrow(
      'not the confirmed one'
    );
    expect(coreCalls('sign.typed_data').map(([, , , hash]) => hash)).toEqual([confirmed]);
  });

  // freedom-core design 0012, APB-1c: a Safe's vault owner presents the Safe
  // approval as `{ safe }`, under the caller it was recorded for; a device
  // owner signs as before.
  test("a Safe owner's signature presents its Safe approval, under its holder", async () => {
    const typed = { domain: { name: 'D' }, types: { M: [{ name: 'v', type: 'uint8' }] }, message: { v: 1 } };
    const page = { origin: 'https://app.example', top_origin: 'https://app.example', frame: 1, navigation: 2, agent: false };
    for (const holder of [null, page]) {
      const id = mockCore.approvals.openSafeApproval({ page: holder });
      mockCore.approvals.calls.length = 0;
      await getSigner(0, { safe: { id, page: holder } }).signTypedData(typed);
      expect(mockCore.approvals.calls.at(-1)).toMatchObject({
        method: 'sign.typed_data',
        params: { authorization: { safe: id } },
        page: holder,
      });
      // Presented by another holder: refused before the key.
      await expect(
        getSigner(0, { safe: { id, page: holder ? null : page } }).signTypedData(typed)
      ).rejects.toThrow(/differs from what was confirmed/);
    }
  });

  // #88: a primaryType that isn't the inferred root is warned about, and
  // approving signs as ethers does: over the inferred root.
  test.each([
    ['another declared type', { Person: [{ name: 'n', type: 'string' }], Mail: [{ name: 'p', type: 'Person' }] }, 'Person', { p: { n: 'x' } }],
    ['true, beside a struct named true', { true: [{ name: 'v', type: 'uint8' }] }, true, { v: 1 }],
    ['false, beside a struct named false', { false: [{ name: 'v', type: 'uint8' }] }, false, { v: 1 }],
    ['null, beside a struct named null', { null: [{ name: 'v', type: 'uint8' }] }, null, { v: 1 }],
  ])('approving a primaryType mismatch (%s) signs over the inferred root', async (_label, types, primaryType, message) => {
    const domain = { name: 'D', chainId: 1 };
    const hash = TypedDataEncoder.hash(domain, types, message);
    const signature = await getSigner(0).signTypedData({ domain, types, primaryType, message }, { expectedHash: hash });
    expect(signature).toBe(await testWallet.signTypedData(domain, types, message));
  });

  // Main's own typed data (SafeTx, SafeMessage, x402) has no prompt of
  // its own: the core hashes it with typed_data.hash right before signing,
  // and the signature passes that hash (#88).
  test("main's own typed data is hashed by the core, and that hash passed", async () => {
    const signer = getSigner(0);
    const typed = { domain: { chainId: 100 }, types: { M: [{ name: 'v', type: 'uint256' }] }, message: { v: 7n } };
    await signer.signTypedData(typed);
    const [[, hashed]] = coreCalls('typed_data.hash');
    expect(hashed).toEqual({ domain: { chainId: 100 }, types: typed.types, message: { v: '7' } });
    const [[, , signed, expectedHash]] = coreCalls('sign.typed_data');
    expect(signed).toEqual(hashed);
    expect(expectedHash).toBe(TypedDataEncoder.hash(typed.domain, typed.types, typed.message));
  });

  // The real shapes main builds: a SafeTx (as safe-executor's
  // hashSafeTransaction) and a SafeMessage (as safe-messages'), each signed
  // by a vault owner the way collectOwnerSignature asks for it.
  test.each([
    [
      'SafeTx',
      () => {
        const { generateTypedData } = require('@safe-global/protocol-kit');
        return JSON.parse(
          JSON.stringify(
            generateTypedData({
              safeAddress: '0x1234567890AbcdEF1234567890aBcdef12345678',
              safeVersion: '1.4.1',
              chainId: 100n,
              data: {
                to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
                value: '5',
                data: '0x',
                operation: 0,
                safeTxGas: '0',
                baseGas: '0',
                gasPrice: '0',
                gasToken: '0x0000000000000000000000000000000000000000',
                refundReceiver: '0x0000000000000000000000000000000000000000',
                nonce: 3,
              },
            }),
            (_key, v) => (typeof v === 'bigint' ? Number(v) : v)
          )
        );
      },
    ],
    [
      'SafeMessage',
      () => {
        const { getEip712MessageTypes } = require('@safe-global/protocol-kit');
        return {
          types: getEip712MessageTypes('1.4.1'),
          domain: { chainId: 100, verifyingContract: '0x1234567890AbcdEF1234567890aBcdef12345678' },
          primaryType: 'SafeMessage',
          message: { message: '0x' + '5e'.repeat(32) },
        };
      },
    ],
  ])('a vault owner signature over a %s passes its own hash', async (_label, build) => {
    const typedData = build();
    const signature = await getSigner(0).signTypedData(typedData);
    const types = { ...typedData.types };
    delete types.EIP712Domain;
    const hash = TypedDataEncoder.hash(typedData.domain, types, typedData.message);
    const [[, , , expectedHash]] = coreCalls('sign.typed_data');
    expect(expectedHash).toBe(hash);
    expect(coreCalls('typed_data.hash')).toHaveLength(1);
    expect(verifyTypedData(typedData.domain, types, typedData.message, signature)).toBe(testWallet.address);
  });

  test('a core result for another key or another request is refused', async () => {
    const signer = getSigner(0);
    await signer.getAddress();
    // The core (simulated) signs with a different key from now on.
    mockIdentity.exportPrivateKey.mockReturnValue('0x' + '11'.repeat(32));
    await expect(signer.signMessage('hi')).rejects.toThrow('does not match');
    await expect(
      signer.signTypedData({ domain: {}, types: { M: [{ name: 'v', type: 'uint8' }] }, message: { v: 1 } })
    ).rejects.toThrow('does not match');
    await expect(
      signer.signTransaction({ chainId: 1, gasLimit: 21000, gasPrice: 1, type: 0, nonce: 0 })
    ).rejects.toThrow('does not match');
    expect(mockResetVaultAutoLockTimer).not.toHaveBeenCalledTimes(4);
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
    expect(coreCalls('keys.addresses')).toEqual([['keys.addresses', [3]]]);
  });
});

// A site's standing rule (freedom-core design 0012, APB-1b): the page's
// signature presents `{ standing }` under its PageContext, and the core
// judges it; a flagged dApp send's `rule` reply reaches the dispatcher.
describe('getSigner: a standing rule, and "Always allow"', () => {
  const PAGE = Object.freeze({ origin: 'https://app.example', top_origin: 'https://app.example', frame: 1, navigation: 2, agent: false });
  const approvals = () => mockCore.approvals;
  const signed = (method) => approvals().calls.filter((call) => call.method === method).at(-1);
  const TYPED = {
    domain: { name: 'Permit', chainId: 100, verifyingContract: '0x' + '11'.repeat(20) },
    types: { Permit: [{ name: 'value', type: 'uint256' }] },
    primaryType: 'Permit',
    message: { value: '1' },
  };

  beforeEach(() => {
    mockCore.approvals?.reset();
  });

  test('a rule\'s signature goes under its page with `{ standing }`, its typed data viewed on the page\'s chain', async () => {
    approvals().setStanding(() => ({ covered: true }));
    const signer = getSigner(0, { page: PAGE, standing: {}, chainId: 100 });
    const signature = await signer.signMessage('hello');
    expect(verifyMessage('hello', signature)).toBe(testWallet.address);
    expect(signed('sign.message')).toMatchObject({ page: PAGE, params: { authorization: { standing: {} } } });
    const hash = TypedDataEncoder.hash(TYPED.domain, TYPED.types, TYPED.message);
    await signer.signTypedData(TYPED, { expectedHash: hash });
    expect(signed('sign.typed_data')).toMatchObject({
      page: PAGE,
      params: { primary_type: 'Permit', chain_id: '100', authorization: { standing: {} } },
    });
    // A send's pause rides with it.
    await getSigner(0, { page: PAGE, standing: { paused: false } }).signTransaction({
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: '0',
      data: '0x095ea7b3',
      gasLimit: '50000',
      gasPrice: '7',
      nonce: 1,
      chainId: 100,
      type: 0,
    });
    expect(signed('sign.transaction')).toMatchObject({ page: PAGE, params: { authorization: { standing: { paused: false } } } });
  });

  test('a rule the core refuses is a confirmation refused, with its reason; no page, no rule', async () => {
    approvals().setStanding(() => ({ covered: false, reason: 'custody' }));
    const refused = await getSigner(0, { page: PAGE, standing: {} })
      .signMessage('hello')
      .catch((err) => err);
    expect(refused).toMatchObject({ code: 'SIGNING_NOT_CONFIRMED', reason: 'custody' });
    expect(refused.message).toBe('Signing was not confirmed: the agent holds this tab');
    // `{ standing }` without a page is never sent: a rule answers only a page.
    await getSigner(0, { standing: {} }).signMessage('hello');
    expect(signed('sign.message')).toMatchObject({ page: null, params: { account: 0 } });
    expect(signed('sign.message').params).not.toHaveProperty('authorization');
  });

  test('a flagged dApp send: the core\'s `rule` reply reaches `onRule` once signed', async () => {
    const confirmations = require('./signing-confirmation');
    const send = {
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: '0',
      data: '0x095ea7b3',
      gasLimit: '50000',
      gasPrice: '7',
      chainId: 100,
      origin: PAGE.origin,
    };
    const page = { handle: 'c'.repeat(64), context: PAGE };
    const heard = [];
    for (const remember of [true, false]) {
      const confirmation = await confirmations.issuePageConfirmation('dapp-send', 0, send, page, { remember });
      await getSigner(0, { confirmation, onRule: (rule) => heard.push(rule) }).signTransaction({ ...send, nonce: 1, type: 0 });
    }
    expect(heard).toEqual([{ added: false, reason: 'not_moved' }, null]);
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
    expect(mockCreateLedgerBackend).toHaveBeenCalledWith(LEDGER_RECORD, {
      onAddressCheck: expect.any(Function),
    });
    expect(mockCore.calls).toEqual([]);
  });

  test('what the device says about the record is kept on the record (#1065)', () => {
    getSigner(2);
    const [, { onAddressCheck }] = mockCreateLedgerBackend.mock.calls[0];
    onAddressCheck(false);
    expect(mockRecordLedgerAddressCheck).toHaveBeenCalledWith(2, false);
    onAddressCheck(true);
    expect(mockRecordLedgerAddressCheck).toHaveBeenLastCalledWith(2, true);
  });

  test('factory-level normalization applies to ledger backends too', async () => {
    const signer = getSigner(2);

    // 0x-hex message reaches the backend as raw bytes
    await signer.signMessage('0x48656c6c6f');
    expect(mockLedgerBackend.signMessage).toHaveBeenCalledWith(Buffer.from('Hello', 'utf8'));

    // JSON-string typed data reaches the backend parsed
    const typed = { domain: { name: 'D' }, types: { M: [{ name: 'v', type: 'uint8' }] }, message: { v: 1 } };
    await signer.signTypedData(JSON.stringify(typed));
    // With the core's hash, for the backend to recover the signature over.
    expect(mockLedgerBackend.signTypedData).toHaveBeenCalledWith(typed, {
      expectedHash: undefined,
      digest: TypedDataEncoder.hash(typed.domain, typed.types, typed.message),
    });
  });

  // freedom-core #88: a device signs what it shows, so main checks the
  // request's hash against the confirmed one before the device sees it.
  test('a device signs typed data only when it hashes to the confirmed digest', async () => {
    const signer = getSigner(2);
    const typed = { domain: { name: 'D' }, types: { M: [{ name: 'v', type: 'uint8' }] }, message: { v: 1 } };
    const hash = TypedDataEncoder.hash(typed.domain, typed.types, typed.message);
    await signer.signTypedData(typed, { expectedHash: hash });
    expect(mockLedgerBackend.signTypedData).toHaveBeenCalledWith(typed, { expectedHash: hash, digest: hash });
    mockLedgerBackend.signTypedData.mockClear();
    const altered = { ...typed, message: { v: 2 } };
    await expect(signer.signTypedData(altered, { expectedHash: hash })).rejects.toThrow(
      'changed after it was confirmed'
    );
    expect(mockLedgerBackend.signTypedData).not.toHaveBeenCalled();
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
    expect(mockCore.calls).toEqual([]);
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
    expect(mockCreateRemoteBackend).toHaveBeenCalledWith(REMOTE_RECORD, {
      onAddressCheck: expect.any(Function),
    });
    expect(mockIdentity.isUnlocked).not.toHaveBeenCalled();
    expect(mockIdentity.exportPrivateKey).not.toHaveBeenCalled();
  });

  test("keeps what the phone's answer showed on the record (#1078)", () => {
    getSigner(4);
    const [, { onAddressCheck }] = mockCreateRemoteBackend.mock.calls[0];

    onAddressCheck(true);
    expect(mockRecordRemoteAddressCheck).toHaveBeenLastCalledWith(4, true);
    onAddressCheck(false);
    expect(mockRecordRemoteAddressCheck).toHaveBeenLastCalledWith(4, false);
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

// Review of #799 (round 1): main's own typed data (a Safe owner's SafeTx or
// SafeMessage, an x402 payment) comes with no confirmed hash, and a device
// signs it with ethers' encoder. The core still hashes and checks it first,
// as it does a dApp's, and nothing reaches the device when it refuses.
describe("getSigner: main's own typed data on a device", () => {
  const { generateTypedData, getEip712MessageTypes } = require('@safe-global/protocol-kit');
  const { vaultBackend } = require('../core/vault-backend');
  const SAFE = '0x41aD4887971f90BB3fE4d83eCa65177281283261';
  const ZERO = '0x0000000000000000000000000000000000000000';
  const jsonSafe = (value) =>
    JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? Number(v) : v)));
  const PAYLOADS = {
    // As safe-executor's hashSafeTransaction builds it.
    SafeTx: () =>
      jsonSafe(
        generateTypedData({
          safeAddress: SAFE,
          safeVersion: '1.4.1',
          chainId: 100n,
          data: {
            to: SAFE, value: '1000', data: '0x', operation: 0, safeTxGas: '0', baseGas: '0',
            gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO, nonce: 0,
          },
        })
      ),
    // As safe-messages' startSafeMessage builds it.
    SafeMessage: () => ({
      types: getEip712MessageTypes('1.4.1'),
      domain: { chainId: 100, verifyingContract: SAFE },
      primaryType: 'SafeMessage',
      message: { message: '0x' + '22'.repeat(32) },
    }),
    // An x402 (EIP-3009) payment authorization, as @x402/evm builds it.
    TransferWithAuthorization: () => ({
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        value: '10000', validAfter: '0', validBefore: '1900000000', nonce: '0x' + '33'.repeat(32),
      },
    }),
  };
  const DEVICES = {
    ledger: [{ index: 1000000, name: 'My Stax', address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', type: 'ledger' }, mockLedgerBackend],
    phone: [{ index: 1000001, name: 'My Phone', address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', type: 'remote' }, mockRemoteBackend],
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each(Object.keys(DEVICES))('on a %s', (device) => {
    const [record, backend] = DEVICES[device];

    beforeEach(() => {
      mockGetWalletRecord.mockReturnValue(record);
      backend.signTypedData.mockReset();
    });

    test.each(Object.keys(PAYLOADS))('%s: the core hashes it before the device is asked', async (primaryType) => {
      const typed = PAYLOADS[primaryType]();
      let hashedFirst;
      backend.signTypedData.mockImplementation(async () => {
        hashedFirst = coreCalls('typed_data.hash').length === 1;
        return '0xsig712';
      });
      await expect(getSigner(record.index).signTypedData(typed)).resolves.toBe('0xsig712');
      expect(hashedFirst).toBe(true);
      const [[, hashed]] = coreCalls('typed_data.hash');
      expect(hashed).toEqual({
        domain: typed.domain,
        types: { [primaryType]: typed.types[primaryType] },
        message: typed.message,
      });
      // With the core's hash, for the backend to recover the signature over.
      expect(backend.signTypedData).toHaveBeenCalledWith(typed, {
        expectedHash: undefined,
        digest: TypedDataEncoder.hash(typed.domain, { [primaryType]: typed.types[primaryType] }, typed.message),
      });
      // Nothing of the vault's: no key, no vault signature.
      expect(coreCalls('sign.typed_data')).toEqual([]);
    });

    test.each(Object.keys(PAYLOADS))('%s: data the core refuses never reaches the device', async (primaryType) => {
      jest.spyOn(vaultBackend, 'typedDataHash').mockRejectedValueOnce(
        Object.assign(new Error('invalid typed data'), { code: 'invalid_argument' })
      );
      await expect(getSigner(record.index).signTypedData(PAYLOADS[primaryType]())).rejects.toThrow(
        'invalid typed data'
      );
      expect(backend.signTypedData).not.toHaveBeenCalled();
    });
  });
});

// The caller's last check (`beforeSign`, design 0012: a page's standing
// rule, read again): awaited after every other wait of a signer the core
// doesn't judge, right before the device is asked or the core signs.
describe("getSigner: the caller's last check, right before the signature", () => {
  const { vaultBackend } = require('../core/vault-backend');
  const PAGE = Object.freeze({ origin: 'https://app.example', top_origin: 'https://app.example', frame: 1, navigation: 2, agent: false });
  const TYPED = {
    domain: { name: 'Permit', chainId: 100, verifyingContract: '0x' + '11'.repeat(20) },
    types: { Permit: [{ name: 'value', type: 'uint256' }] },
    primaryType: 'Permit',
    message: { value: '1' },
  };
  const HASH = TypedDataEncoder.hash(TYPED.domain, TYPED.types, TYPED.message);
  const TX = {
    to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    value: '0',
    data: '0x095ea7b3',
    gasLimit: '50000',
    gasPrice: '7',
    nonce: 1,
    chainId: 100,
    type: 0,
  };
  const DEVICES = {
    ledger: [{ index: 1000000, name: 'My Stax', address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', type: 'ledger' }, mockLedgerBackend],
    phone: [{ index: 1000001, name: 'My Phone', address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', type: 'remote' }, mockRemoteBackend],
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each(Object.keys(DEVICES))('on a %s', (device) => {
    const [record, backend] = DEVICES[device];
    let order;
    let refusal;
    const beforeSign = jest.fn(async () => {
      order.push('check');
      if (refusal) throw refusal;
    });
    const authorized = () => ({ page: PAGE, standing: {}, chainId: 100, beforeSign });

    beforeEach(() => {
      order = [];
      refusal = null;
      beforeSign.mockClear();
      mockGetWalletRecord.mockReturnValue(record);
      for (const method of ['signTransaction', 'signMessage', 'signTypedData', 'sendTransaction']) {
        backend[method]?.mockReset().mockImplementation(async () => {
          order.push(method);
          return '0xsig';
        });
      }
    });

    test('typed data: the check waits for the core\'s hash and is the last step before the device', async () => {
      const hashed = deferred();
      const real = vaultBackend.typedDataHash.bind(vaultBackend);
      jest.spyOn(vaultBackend, 'typedDataHash').mockImplementationOnce(async (data) => {
        order.push('hash');
        await hashed.promise;
        return real(data);
      });
      const signing = getSigner(record.index, authorized()).signTypedData(TYPED, { expectedHash: HASH });
      await tick();
      expect(beforeSign).not.toHaveBeenCalled();
      expect(backend.signTypedData).not.toHaveBeenCalled();
      hashed.resolve();
      await expect(signing).resolves.toBe('0xsig');
      expect(order).toEqual(['hash', 'check', 'signTypedData']);
    });

    test('typed data: a check that refuses after the hash: the device is never asked, the refusal is the caller\'s', async () => {
      refusal = Object.assign(new Error('rule gone'), { code: 'STANDING_WITHDRAWN' });
      await expect(getSigner(record.index, authorized()).signTypedData(TYPED, { expectedHash: HASH })).rejects.toBe(refusal);
      expect(backend.signTypedData).not.toHaveBeenCalled();
    });

    test('typed data that changed after its confirmation fails before the check', async () => {
      await expect(
        getSigner(record.index, authorized()).signTypedData(TYPED, { expectedHash: '0x' + '00'.repeat(32) })
      ).rejects.toThrow('The typed data changed after it was confirmed');
      expect(beforeSign).not.toHaveBeenCalled();
      expect(backend.signTypedData).not.toHaveBeenCalled();
    });

    test('a message, a transaction and a phone\'s send: the check right before the device, and its refusal stops it', async () => {
      const signer = getSigner(record.index, authorized());
      await signer.signMessage('hello');
      await signer.signTransaction(TX);
      if (signer.sendTransaction) await signer.sendTransaction(TX);
      expect(order).toEqual(['check', 'signMessage', 'check', 'signTransaction', ...(signer.sendTransaction ? ['check', 'sendTransaction'] : [])]);
      refusal = new Error('custody');
      order = [];
      await expect(signer.signMessage('hello')).rejects.toBe(refusal);
      await expect(signer.signTransaction(TX)).rejects.toBe(refusal);
      if (signer.sendTransaction) await expect(signer.sendTransaction(TX)).rejects.toBe(refusal);
      expect(order.filter((step) => step !== 'check')).toEqual([]);
    });
  });

  // Codex on #1246: a token the Agent's decision minted (design 0012) is
  // spent by the core under the PageContext main read as the signer was
  // built; main reads the decision again (its tab, its document, its name)
  // as the signer's last step, after the signer's own waits, on any
  // account, the vault's included.
  describe("the Agent's token, which the core spends under the PageContext main read as the signer was built", () => {
    const confirmations = require('./signing-confirmation');
    const AGENT = Object.freeze({ ...PAGE, agent: true });
    const handle = 'd'.repeat(64);
    const SEND = { to: TX.to, value: TX.value, data: TX.data, gasLimit: TX.gasLimit, gasPrice: TX.gasPrice, chainId: 100, origin: AGENT.origin };
    const mint = (kind, index, payload, options) =>
      confirmations.issuePageConfirmation(kind, index, payload, { handle, context: AGENT }, options);
    const approvals = () => mockCore.approvals;
    const count = (method) => approvals().calls.filter((call) => call.method === method).length;

    beforeEach(() => {
      confirmations._reset();
      mockCore.approvals?.reset();
    });

    test.each([
      ['a message', 'sign-message', 'hello', {}, (signer) => signer.signMessage('hello'), 'sign.message'],
      ['typed data', 'sign-typed-data', TYPED, { chainId: 100 }, (signer, minted) => signer.signTypedData(TYPED, { expectedHash: minted.hash }), 'sign.typed_data'],
      ['a send', 'dapp-send', SEND, {}, (signer) => signer.signTransaction({ ...TX, from: testWallet.address }), 'sign.transaction'],
    ])("on a vault, %s: the check after the address, right before the core signs; a refusal there: the core never asked, the token unspent", async (_label, kind, payload, options, sign, method) => {
      mockCore.calls = [];
      const order = [];
      const beforeSign = jest.fn(async () => {
        order.push(['check', coreCalls('keys.addresses').length, coreCalls(method).length]);
      });
      const minted = await mint(kind, 0, payload, options);
      await sign(getSigner(0, { confirmation: { ...minted, page: AGENT }, beforeSign }), minted);
      // The address resolved, the core not yet asked, when the check ran.
      expect(order).toEqual([['check', 1, 0]]);
      expect(coreCalls(method)).toHaveLength(1);
      expect(approvals().outstanding()).toBe(0);
      const refusal = new Error('Signing was not confirmed: the Agent no longer holds this tab');
      const again = await mint(kind, 0, payload, options);
      await expect(sign(getSigner(0, { confirmation: { ...again, page: AGENT }, beforeSign: async () => { throw refusal; } }), again)).rejects.toBe(refusal);
      expect(coreCalls(method)).toHaveLength(1);
      // Never presented: the caller burns it.
      expect(approvals().outstanding()).toBe(1);
    });

    test.each(Object.keys(DEVICES))('on a %s: the check after the core\'s hash and the token\'s spend, right before the device; a refusal there: the device never asked', async (device) => {
      const [record, backend] = DEVICES[device];
      mockGetWalletRecord.mockReturnValue(record);
      const order = [];
      let refusal = null;
      const beforeSign = jest.fn(async () => {
        order.push(['check', count('approval.spend')]);
        if (refusal) throw refusal;
      });
      for (const method of ['signTransaction', 'signMessage', 'signTypedData', 'sendTransaction']) {
        backend[method]?.mockReset().mockImplementation(async () => {
          order.push([method]);
          return '0xsig';
        });
      }
      const typed = await mint('sign-typed-data', record.index, TYPED, { chainId: 100 });
      await getSigner(record.index, { confirmation: { ...typed, page: AGENT }, beforeSign }).signTypedData(TYPED, { expectedHash: typed.hash });
      const message = await mint('sign-message', record.index, 'hello');
      await getSigner(record.index, { confirmation: { ...message, page: AGENT }, beforeSign }).signMessage('hello');
      const send = await mint('dapp-send', record.index, SEND, { phone: device === 'phone' });
      const sender = getSigner(record.index, { confirmation: { ...send, page: AGENT }, beforeSign });
      await (sender.sendTransaction ? sender.sendTransaction(TX) : sender.signTransaction(TX));
      const sent = sender.sendTransaction ? 'sendTransaction' : 'signTransaction';
      expect(order).toEqual([['check', 1], ['signTypedData'], ['check', 2], ['signMessage'], ['check', 3], [sent]]);
      refusal = new Error('Signing was not confirmed: the Agent no longer holds this tab');
      order.length = 0;
      const refusedTyped = await mint('sign-typed-data', record.index, TYPED, { chainId: 100 });
      await expect(
        getSigner(record.index, { confirmation: { ...refusedTyped, page: AGENT }, beforeSign }).signTypedData(TYPED, { expectedHash: refusedTyped.hash })
      ).rejects.toBe(refusal);
      const refusedSend = await mint('dapp-send', record.index, SEND, { phone: device === 'phone' });
      const refusedSender = getSigner(record.index, { confirmation: { ...refusedSend, page: AGENT }, beforeSign });
      await expect(refusedSender.sendTransaction ? refusedSender.sendTransaction(TX) : refusedSender.signTransaction(TX)).rejects.toBe(refusal);
      // Spent through the core, then refused: no device asked.
      expect(order).toEqual([['check', 4], ['check', 5]]);
    });
  });

  test("a vault's own signature (no authorization, as a Safe owner's): the check after the core's hash, right before the core signs", async () => {
    const order = [];
    let refusal = null;
    const beforeSign = jest.fn(async () => {
      order.push(['check', coreCalls('typed_data.hash').length, coreCalls('sign.typed_data').length]);
      if (refusal) throw refusal;
    });
    const signer = getSigner(0, { beforeSign });
    const signature = await signer.signTypedData(TYPED);
    expect(verifyTypedData(TYPED.domain, TYPED.types, TYPED.message, signature)).toBe(testWallet.address);
    // Hashed by the core, not yet signed, when the check ran.
    expect(order).toEqual([['check', 1, 0]]);
    expect(coreCalls('sign.typed_data')).toHaveLength(1);
    refusal = Object.assign(new Error('rule gone'), { code: 'STANDING_WITHDRAWN' });
    await expect(signer.signTypedData(TYPED)).rejects.toBe(refusal);
    await expect(signer.signMessage('hello')).rejects.toBe(refusal);
    await expect(signer.signTransaction({ ...TX, from: testWallet.address })).rejects.toBe(refusal);
    expect(coreCalls('sign.typed_data')).toHaveLength(1);
    expect(coreCalls('sign.message')).toEqual([]);
    expect(coreCalls('sign.transaction')).toEqual([]);
  });

  test("a standing rule's vault signature: the check after the address, right before the core signs", async () => {
    mockCore.approvals?.reset();
    mockCore.approvals.setStanding(() => ({ covered: true }));
    const order = [];
    const beforeSign = jest.fn(async () => {
      order.push(['check', coreCalls('keys.addresses').length, coreCalls('sign.typed_data').length]);
    });
    await getSigner(0, { page: PAGE, standing: {}, chainId: 100, beforeSign }).signTypedData(TYPED, { expectedHash: HASH });
    expect(order).toEqual([['check', 1, 0]]);
    expect(coreCalls('sign.typed_data')).toHaveLength(1);
    // A refusal there: the core is never asked to sign.
    const refusal = new Error('custody');
    await expect(
      getSigner(0, { page: PAGE, standing: { paused: false }, beforeSign: async () => { throw refusal; } }).signTransaction({
        ...TX,
        from: testWallet.address,
      })
    ).rejects.toBe(refusal);
    expect(coreCalls('sign.transaction')).toEqual([]);
  });
});
