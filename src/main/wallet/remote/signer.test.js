/**
 * The fake phone answers with a real (well-known test) key, so every
 * assertion exercises actual cryptographic round-trips: the identity core
 * job each method opens (./bridge.js `requestPhoneJob`, mocked here), and
 * the recover-and-compare verification of what comes back.
 */

const { Wallet, TypedDataEncoder, recoverAddress, verifyMessage } = require('ethers');

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

const mockRequestPhoneJob = jest.fn();
jest.mock('./bridge', () => ({
  requestPhoneJob: (...args) => mockRequestPhoneJob(...args),
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
  // The localhost entry must never reach the phone, nor a keyed provider's
  // URL, which carries the user's API key (#1040).
  getEffectiveRpcUrls: jest.fn(() => [
    'https://rpc.gnosischain.com',
    'https://gnosis-mainnet.g.alchemy.com/v2/user-api-key',
    'http://127.0.0.1:8545',
  ]),
  getKeylessRpcUrls: jest.fn(() => ['https://rpc.gnosischain.com', 'http://127.0.0.1:8545']),
}));

const { createRemoteBackend } = require('./signer');

const backend = createRemoteBackend(RECORD);

beforeEach(() => {
  mockRequestPhoneJob.mockReset();
});

describe('getAddress', () => {
  test('serves the stored address without a phone round-trip', async () => {
    await expect(backend.getAddress()).resolves.toBe(phoneWallet.address);
    expect(mockRequestPhoneJob).not.toHaveBeenCalled();
  });
});

describe('signTransaction', () => {
  test('is unsupported — phones only expose eth_sendTransaction', async () => {
    await expect(backend.signTransaction({ to: '0x1', chainId: 1 })).rejects.toMatchObject({
      code: 'REMOTE_UNSUPPORTED',
    });
    expect(mockRequestPhoneJob).not.toHaveBeenCalled();
  });
});

describe('signMessage', () => {
  test('opens a core message job over the message bytes and returns a verified signature', async () => {
    const message = Buffer.from('hello freedom', 'utf8');
    mockRequestPhoneJob.mockImplementation(async () => phoneWallet.signMessage(message));

    const signature = await backend.signMessage(message);
    // No job from the factory: main's own, with no authorization and no page.
    expect(mockRequestPhoneJob).toHaveBeenCalledWith({
      walletIndex: 4,
      address: phoneWallet.address,
      method: 'message',
      payload: { message: '0x' + message.toString('hex') },
      page: null,
    });
    // Round-trip: the returned signature really recovers to the account.
    expect(verifyMessage(message, signature)).toBe(phoneWallet.address);
  });

  test('utf8 string messages sign over their bytes', async () => {
    mockRequestPhoneJob.mockImplementation(async ({ payload }) => {
      expect(payload).toEqual({ message: '0x' + Buffer.from('plain text', 'utf8').toString('hex') });
      return phoneWallet.signMessage('plain text');
    });
    await expect(backend.signMessage('plain text')).resolves.toMatch(/^0x/);
  });

  test("the payload a token bound goes to the core as it is, never rebuilt from the bytes", async () => {
    const bound = { message: 'hello' };
    mockRequestPhoneJob.mockImplementation(async () => phoneWallet.signMessage('hello'));
    await backend.signMessage('hello', { payload: bound });
    expect(mockRequestPhoneJob.mock.calls[0][0].payload).toBe(bound);
  });

  test('rejects a signature from a different account with REMOTE_WRONG_ACCOUNT', async () => {
    mockRequestPhoneJob.mockImplementation(async () => strangerWallet.signMessage('hello'));
    await expect(backend.signMessage('hello')).rejects.toMatchObject({
      code: 'REMOTE_WRONG_ACCOUNT',
    });
  });

  test('rejects malformed responses with REMOTE_BAD_RESPONSE', async () => {
    mockRequestPhoneJob.mockResolvedValue('not-a-signature');
    await expect(backend.signMessage('hello')).rejects.toMatchObject({
      code: 'REMOTE_BAD_RESPONSE',
    });
  });
});

describe("the factory's job: what the core checks the request under", () => {
  const PAGE = { origin: 'https://app.example', frame: 1 };

  test.each([
    ['a confirmation token', { token: 't-1', kind: 'message', handle: 'h-1' }],
    ['a safe-view token', { safe: 's-1' }],
    ['a standing rule', { standing: 'r-1' }],
  ])('%s and the page go to the core as `authorization` and `page`', async (_name, authorization) => {
    mockRequestPhoneJob.mockImplementation(async () => phoneWallet.signMessage('hello'));
    await backend.signMessage('hello', { authorization, page: PAGE, payload: { message: 'hello' } });
    expect(mockRequestPhoneJob).toHaveBeenCalledWith({
      walletIndex: 4,
      address: phoneWallet.address,
      method: 'message',
      payload: { message: 'hello' },
      authorization,
      page: PAGE,
    });
  });

  test("the caller's last check goes to the bridge as `beforeRelay`, and the signer never runs it", async () => {
    const beforeSign = jest.fn(async () => {});
    mockRequestPhoneJob.mockImplementation(async () => phoneWallet.signMessage('hello'));
    await backend.signMessage('hello', { beforeSign });
    expect(mockRequestPhoneJob.mock.calls[0][0].beforeRelay).toBe(beforeSign);
    expect(beforeSign).not.toHaveBeenCalled();
  });

  test('the same for typed data and a send', async () => {
    const beforeSign = jest.fn(async () => {});
    const job = { authorization: { standing: 'r-1' }, page: PAGE, beforeSign };
    mockRequestPhoneJob.mockImplementation(async () =>
      phoneWallet.signTypedData(TYPED_DATA.domain, strippedTypes, TYPED_DATA.message));
    await backend.signTypedData(TYPED_DATA, { digest: DIGEST, job: { ...job, payload: {} } });
    expect(mockRequestPhoneJob.mock.calls[0][0]).toMatchObject({
      authorization: { standing: 'r-1' },
      page: PAGE,
      beforeRelay: beforeSign,
    });

    mockRequestPhoneJob.mockReset();
    mockRequestPhoneJob.mockResolvedValue({ hash: '0x' + 'ab'.repeat(32), outcome: 'verified', job: 'j-1' });
    await backend.sendTransaction({ chainId: 100 }, { ...job, payload: { tx: {} } });
    expect(mockRequestPhoneJob.mock.calls[0][0]).toMatchObject({
      authorization: { standing: 'r-1' },
      page: PAGE,
      beforeRelay: beforeSign,
    });
    expect(beforeSign).not.toHaveBeenCalled();
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
// The hash the user confirmed: what the phone's signature must recover over.
const DIGEST = TypedDataEncoder.hash(TYPED_DATA.domain, strippedTypes, TYPED_DATA.message);

describe('signTypedData', () => {
  test("opens a core typed-data job with the confirmed hash as `expected_hash`, and recovers over it", async () => {
    const bound = { typed_data: { primary_type: 'Payment' }, primary_type: 'Payment', chain_id: 100 };
    mockRequestPhoneJob.mockImplementation(async () =>
      phoneWallet.signTypedData(TYPED_DATA.domain, strippedTypes, TYPED_DATA.message));

    const signature = await backend.signTypedData(TYPED_DATA, { digest: DIGEST, job: { payload: bound } });
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(mockRequestPhoneJob).toHaveBeenCalledWith({
      walletIndex: 4,
      address: phoneWallet.address,
      method: 'typed_data',
      payload: { ...bound, expected_hash: DIGEST },
      page: null,
    });
    expect(recoverAddress(DIGEST, signature)).toBe(phoneWallet.address);
  });

  test('a signature over another hash than the one confirmed is from no account of ours', async () => {
    const other = { ...TYPED_DATA.message, amount: '1001' };
    mockRequestPhoneJob.mockImplementation(async () =>
      phoneWallet.signTypedData(TYPED_DATA.domain, strippedTypes, other));
    await expect(backend.signTypedData(TYPED_DATA, { digest: DIGEST })).rejects.toMatchObject({
      code: 'REMOTE_WRONG_ACCOUNT',
    });
  });

  test('with no hash to recover over, the phone is never asked', async () => {
    await expect(backend.signTypedData(TYPED_DATA)).rejects.toMatchObject({
      code: 'REMOTE_UNSUPPORTED',
    });
    await expect(backend.signTypedData(TYPED_DATA, { digest: null })).rejects.toMatchObject({
      code: 'REMOTE_UNSUPPORTED',
    });
    expect(mockRequestPhoneJob).not.toHaveBeenCalled();
  });

  test('rejects a typed-data signature from a different account', async () => {
    mockRequestPhoneJob.mockImplementation(async () =>
      strangerWallet.signTypedData(TYPED_DATA.domain, strippedTypes, TYPED_DATA.message));
    await expect(backend.signTypedData(TYPED_DATA, { digest: DIGEST })).rejects.toMatchObject({
      code: 'REMOTE_WRONG_ACCOUNT',
    });
  });
});

describe('sendTransaction', () => {
  const TX = { to: strangerWallet.address, value: '1500000000000000', data: '0xabcdef', chainId: 100 };
  const HASH = '0x' + 'ab'.repeat(32);
  const BOUND = { tx: { to: TX.to, value: '0x5543df729c000', data: '0xabcdef', chain_id: 100 } };

  test("opens a core transaction job with the bound payload, and returns the core's reply as it is", async () => {
    const reply = { hash: HASH, outcome: 'unverified', job: 'j-7', durable: false };
    mockRequestPhoneJob.mockResolvedValue(reply);

    await expect(backend.sendTransaction(TX, { payload: BOUND })).resolves.toBe(reply);
    expect(mockRequestPhoneJob).toHaveBeenCalledWith({
      walletIndex: 4,
      address: phoneWallet.address,
      method: 'transaction',
      payload: BOUND,
      page: null,
      // EIP-3085 descriptor for the pre-flight chain switch: public
      // https endpoints only — neither the localhost RPC nor the keyed
      // provider's URL may leak.
      chain: {
        chainId: '0x64',
        chainName: 'Gnosis Chain',
        nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
        blockExplorerUrls: ['https://gnosisscan.io'],
        rpcUrls: ['https://rpc.gnosischain.com'],
      },
    });
  });

  test.each([
    [{ hash: HASH, outcome: 'verified', job: 'j-1', rule: { added: true } }],
    [{ hash: HASH, outcome: 'unknown', job: 'j-2', durable: false }],
  ])('the core\'s judgement %p comes back untouched', async (reply) => {
    mockRequestPhoneJob.mockResolvedValue(reply);
    await expect(backend.sendTransaction(TX, { payload: BOUND })).resolves.toEqual(reply);
  });

  test('unknown chains still ship a minimal descriptor (chainId only)', async () => {
    mockRequestPhoneJob.mockImplementation(async ({ chain }) => {
      expect(chain).toEqual({ chainId: '0x539' });
      return { hash: HASH, outcome: 'verified', job: 'j-1' };
    });
    await expect(backend.sendTransaction({ to: TX.to, chainId: 1337 })).resolves.toMatchObject({
      hash: HASH,
    });
  });

  // The phone answered, so it may have sent the payment: a reply with no
  // hash leaves the outcome unknown, not failed.
  test.each([
    ['not-a-hash'],
    [null],
    [undefined],
    [HASH],
    [{ hash: 'not-a-hash', outcome: 'verified' }],
    [{ hash: '0x' + 'ab'.repeat(31), outcome: 'verified' }],
    [{ outcome: 'unknown' }],
  ])('an unreadable reply (%p) is an unknown outcome', async (answer) => {
    mockRequestPhoneJob.mockResolvedValue(answer);
    await expect(backend.sendTransaction(TX, { payload: BOUND })).rejects.toMatchObject({
      code: 'REMOTE_OUTCOME_UNKNOWN',
      message: expect.stringMatching(/couldn't be read.*unknown whether this payment was sent/),
    });
  });

  test("the core's refusal passes through as it is", async () => {
    const refused = Object.assign(new Error('another transaction'), {
      code: 'REMOTE_WRONG_TRANSACTION',
      phoneSent: true,
    });
    mockRequestPhoneJob.mockRejectedValue(refused);
    await expect(backend.sendTransaction(TX, { payload: BOUND })).rejects.toBe(refused);
  });
});

describe("what the phone's answer shows about the record (#1078)", () => {
  const onAddressCheck = jest.fn();
  const reporting = createRemoteBackend(RECORD, { onAddressCheck });

  beforeEach(() => {
    onAddressCheck.mockReset();
  });

  test('a signature as the account, message or typed data, reports a match', async () => {
    mockRequestPhoneJob.mockImplementation(async () => phoneWallet.signMessage('hello'));
    await reporting.signMessage('hello');
    expect(onAddressCheck).toHaveBeenLastCalledWith(true);

    mockRequestPhoneJob.mockImplementation(async () =>
      phoneWallet.signTypedData(TYPED_DATA.domain, strippedTypes, TYPED_DATA.message));
    await reporting.signTypedData(TYPED_DATA, { digest: DIGEST });
    expect(onAddressCheck).toHaveBeenLastCalledWith(true);
    expect(onAddressCheck).toHaveBeenCalledTimes(2);
  });

  test('a signature from another account reports a mismatch, and is refused', async () => {
    mockRequestPhoneJob.mockImplementation(async () => strangerWallet.signMessage('hello'));
    await expect(reporting.signMessage('hello')).rejects.toMatchObject({ code: 'REMOTE_WRONG_ACCOUNT' });
    expect(onAddressCheck).toHaveBeenCalledWith(false);

    onAddressCheck.mockReset();
    mockRequestPhoneJob.mockImplementation(async () =>
      strangerWallet.signTypedData(TYPED_DATA.domain, strippedTypes, TYPED_DATA.message));
    await expect(reporting.signTypedData(TYPED_DATA, { digest: DIGEST })).rejects.toMatchObject({
      code: 'REMOTE_WRONG_ACCOUNT',
    });
    expect(onAddressCheck).toHaveBeenCalledWith(false);
  });

  test("the phone's own refusal of the account (EIP-1193 4100), or the core's, reports a mismatch", async () => {
    mockRequestPhoneJob.mockRejectedValue(
      Object.assign(new Error('Unauthorized'), { code: 'REMOTE_WRONG_ACCOUNT' })
    );
    await expect(reporting.signMessage('hello')).rejects.toMatchObject({ code: 'REMOTE_WRONG_ACCOUNT' });
    expect(onAddressCheck).toHaveBeenCalledWith(false);

    onAddressCheck.mockReset();
    await expect(reporting.signTypedData(TYPED_DATA, { digest: DIGEST })).rejects.toMatchObject({
      code: 'REMOTE_WRONG_ACCOUNT',
    });
    expect(onAddressCheck).toHaveBeenCalledWith(false);
  });

  test('no answer, or a malformed one, reports nothing', async () => {
    mockRequestPhoneJob.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'REMOTE_TIMEOUT' }));
    await expect(reporting.signMessage('hello')).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' });
    mockRequestPhoneJob.mockResolvedValue('not-a-signature');
    await expect(reporting.signMessage('hello')).rejects.toMatchObject({ code: 'REMOTE_BAD_RESPONSE' });
    expect(onAddressCheck).not.toHaveBeenCalled();
  });

  test('a failure to keep the result does not fail the signature', async () => {
    onAddressCheck.mockImplementation(() => {
      throw new Error('disk full');
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockRequestPhoneJob.mockImplementation(async () => phoneWallet.signMessage('hello'));
    await expect(reporting.signMessage('hello')).resolves.toMatch(/^0x/);
    console.warn.mockRestore();
  });
});
