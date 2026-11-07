/**
 * The phone account check (#1078): the fake phone answers with real
 * (well-known test) keys, so each case is a real recover-and-compare over
 * the challenge main built.
 */

const { Wallet, getBytes } = require('ethers');

// Anvil/Hardhat-default test keys — well-known, never funded on mainnet.
const phoneWallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const strangerWallet = new Wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

const mockRequestRemoteSignature = jest.fn();
jest.mock('./bridge', () => ({
  requestRemoteSignature: (...args) => mockRequestRemoteSignature(...args),
}));

const { proveRemoteAccount, buildAccountChallenge } = require('./account-proof');

/** The phone signs whatever it is sent, with `wallet`. */
const signsWith = (wallet) => async ({ params }) => wallet.signMessage(getBytes(params[0]));

const challengeOf = (job) => Buffer.from(job.params[0].slice(2), 'hex').toString('utf8');

beforeEach(() => {
  mockRequestRemoteSignature.mockReset();
});

describe('proveRemoteAccount', () => {
  test('a phone that signs as the account proves it', async () => {
    mockRequestRemoteSignature.mockImplementation(signsWith(phoneWallet));

    await expect(proveRemoteAccount(phoneWallet.address, 1000001)).resolves.toBe(true);

    const [job] = mockRequestRemoteSignature.mock.calls[0];
    expect(job).toMatchObject({
      walletIndex: 1000001,
      address: phoneWallet.address,
      method: 'personal_sign',
      purpose: 'account-check',
    });
    expect(job.params[1]).toBe(phoneWallet.address);
    expect(challengeOf(job)).toContain(phoneWallet.address);
  });

  test('each check carries a fresh nonce', async () => {
    mockRequestRemoteSignature.mockImplementation(signsWith(phoneWallet));

    await proveRemoteAccount(phoneWallet.address);
    await proveRemoteAccount(phoneWallet.address);

    const nonces = mockRequestRemoteSignature.mock.calls.map(([job]) => {
      const match = challengeOf(job).match(/Nonce: ([0-9a-f]{64})$/);
      expect(match).not.toBeNull();
      return match[1];
    });
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  test('a signature from another account does not', async () => {
    mockRequestRemoteSignature.mockImplementation(signsWith(strangerWallet));
    await expect(proveRemoteAccount(phoneWallet.address)).resolves.toBe(false);
  });

  test("the account's signature over another message does not (an earlier check replayed)", async () => {
    const earlier = await phoneWallet.signMessage(buildAccountChallenge(phoneWallet.address, 'ab'.repeat(32)));
    mockRequestRemoteSignature.mockResolvedValue(earlier);
    await expect(proveRemoteAccount(phoneWallet.address)).resolves.toBe(false);
  });

  test('a phone that says the account is not its own (EIP-1193 4100) does not', async () => {
    mockRequestRemoteSignature.mockRejectedValue(
      Object.assign(new Error('Unauthorized'), { code: 'REMOTE_WRONG_ACCOUNT' })
    );
    await expect(proveRemoteAccount(phoneWallet.address)).resolves.toBe(false);
  });

  test.each([
    ['no answer in time', 'REMOTE_TIMEOUT'],
    ['the user cancels', 'REMOTE_USER_CANCELLED'],
    ['a rejection on the phone', 'REMOTE_USER_REJECTED'],
    ['no window for the QR', 'REMOTE_NO_UI'],
  ])('%s proves nothing either way', async (_label, code) => {
    mockRequestRemoteSignature.mockRejectedValue(Object.assign(new Error(code), { code }));
    await expect(proveRemoteAccount(phoneWallet.address)).rejects.toMatchObject({ code });
  });

  test('a malformed answer proves nothing either way', async () => {
    mockRequestRemoteSignature.mockResolvedValue('0x1234');
    await expect(proveRemoteAccount(phoneWallet.address)).rejects.toMatchObject({
      code: 'REMOTE_BAD_RESPONSE',
    });
  });
});

describe('buildAccountChallenge', () => {
  test('says what it is for, names the account and carries the nonce', () => {
    const text = buildAccountChallenge(phoneWallet.address.toLowerCase(), 'cd'.repeat(32));
    expect(text).toBe(
      [
        'Freedom: confirm that this phone holds the account',
        phoneWallet.address,
        '',
        'Signing this only adds or checks the account in your Freedom wallet. It sends nothing and costs nothing.',
        '',
        `Nonce: ${'cd'.repeat(32)}`,
      ].join('\n')
    );
  });
});
