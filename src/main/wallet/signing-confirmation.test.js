const {
  CONFIRMATION_TTL_MS,
  MAX_OUTSTANDING,
  KINDS,
  NOT_CONFIRMED,
  issueMainConfirmation,
  consumeConfirmation,
  discardConfirmation,
  _reset,
  _setNow,
  _outstandingCount,
} = require('./signing-confirmation');

// The core's approval tokens, simulated (test/helpers/simulated-approvals.js);
// the real core's in signing-confirmation.integration.test.js.
const mockCore = require('../../../test/helpers/simulated-approvals').simulatedApprovals();
jest.mock('../core/vault-backend', () => ({ vaultBackend: { approval: mockCore.approval } }));
jest.mock('../identity-manager', () => ({
  getWalletRecord: (index) => (index === 9 ? { index, type: 'safe', address: '0x' + 'AA'.repeat(20) } : null),
}));

const TX = Object.freeze({
  chainId: 100,
  to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  value: '1000000000000000',
  data: '0x095ea7b3' + '00'.repeat(64),
  gasLimit: '21000',
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
  // A dApp payment's site; a wallet send ignores it.
  origin: 'https://app.example',
});

const TYPED_DATA = Object.freeze({
  domain: { name: 'Permit', chainId: 100, verifyingContract: '0x' + '11'.repeat(20) },
  types: { Permit: [{ name: 'value', type: 'uint256' }] },
  primaryType: 'Permit',
  message: { value: '1' },
});

const PAYMENT = Object.freeze({
  webContentsId: 42,
  detectionId: 'req-9100',
  url: 'https://api.example/article',
  acceptIndex: 0,
  accept: {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '10000',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  },
  grant: null,
});

function refusal(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a refusal');
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a refusal');
}

// x402's two kinds stay main's, minted and spent in JS (design 0012: until
// X402-1 can spend a payment, and X402-2 replaces the cap edit's token).
describe("signing-confirmation: main's own kinds (x402)", () => {
  let clock;

  beforeEach(() => {
    _reset();
    mockCore.reset();
    clock = 1_000_000;
    _setNow(() => clock);
  });

  afterAll(() => _reset());

  test('a token pays exactly the payment it was issued for, once, and never asks the core', () => {
    const { token, expiresAt } = issueMainConfirmation(KINDS.X402_PAYMENT, 3, PAYMENT);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBe(clock + CONFIRMATION_TTL_MS);
    expect(() => consumeConfirmation(token, KINDS.X402_PAYMENT, 3, { ...PAYMENT })).not.toThrow();
    expect(refusal(() => consumeConfirmation(token, KINDS.X402_PAYMENT, 3, PAYMENT)).message).toMatch(/already used/);
    expect(mockCore.calls).toEqual([]);
  });

  test('a mismatched presentation also burns the token (no retry to probe)', () => {
    const { token } = issueMainConfirmation(KINDS.X402_PAYMENT, 3, PAYMENT);
    expect(refusal(() => consumeConfirmation(token, KINDS.X402_PAYMENT, 4, PAYMENT)).message).toMatch(/differs/);
    expect(refusal(() => consumeConfirmation(token, KINDS.X402_PAYMENT, 3, PAYMENT)).message).toMatch(/already used/);
  });

  test('expiry refuses; just inside the lifetime still pays', () => {
    const stale = issueMainConfirmation(KINDS.X402_PAYMENT, 3, PAYMENT);
    clock += CONFIRMATION_TTL_MS;
    expect(refusal(() => consumeConfirmation(stale.token, KINDS.X402_PAYMENT, 3, PAYMENT)).message).toMatch(/expired/);
    const fresh = issueMainConfirmation(KINDS.X402_PAYMENT, 3, PAYMENT);
    clock += CONFIRMATION_TTL_MS - 1;
    expect(() => consumeConfirmation(fresh.token, KINDS.X402_PAYMENT, 3, PAYMENT)).not.toThrow();
  });

  test('no token, an empty token or an unknown token refuses; a core kind is never spent here', () => {
    for (const token of [undefined, '', 'f'.repeat(64)]) {
      expect(refusal(() => consumeConfirmation(token, KINDS.X402_PAYMENT, 3, PAYMENT)).code).toBe(NOT_CONFIRMED);
    }
    expect(refusal(() => consumeConfirmation('a'.repeat(64), KINDS.WALLET_SEND, 3, TX)).message).toMatch(
      /identity core spends/
    );
  });

  test('a discarded token no longer pays', async () => {
    const { token } = issueMainConfirmation(KINDS.X402_PAYMENT, 3, PAYMENT);
    await discardConfirmation(token);
    expect(refusal(() => consumeConfirmation(token, KINDS.X402_PAYMENT, 3, PAYMENT)).message).toMatch(/already used/);
  });

  describe('x402 payments bind the detection, the entry, the account and the grant', () => {
    const ACCEPT = Object.freeze({
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      maxTimeoutSeconds: 60,
      extra: { name: 'USD Coin', version: '2' },
    });
    const PAYMENT = Object.freeze({
      webContentsId: 42,
      detectionId: 'req-9100',
      url: 'https://api.example/article',
      acceptIndex: 0,
      accept: ACCEPT,
      grant: null,
    });

    test('the payment as confirmed signs, once', () => {
      const { token } = issueMainConfirmation(KINDS.X402_PAYMENT, 0, PAYMENT);
      expect(() => consumeConfirmation(token, KINDS.X402_PAYMENT, 0, {
        ...PAYMENT,
        // Key order and an absent grant are not differences.
        accept: { ...ACCEPT, extra: { version: '2', name: 'USD Coin' } },
        grant: undefined,
      })).not.toThrow();
      expect(refusal(() => consumeConfirmation(token, KINDS.X402_PAYMENT, 0, PAYMENT)).message)
        .toMatch(/unknown or already used/);
    });

    const changes = {
      'another tab': { webContentsId: 43 },
      'another detection on the same tab': { detectionId: 'req-9101' },
      'another URL': { url: 'https://api.example/other' },
      'another entry index': { acceptIndex: 1 },
      'another scheme': { accept: { ...ACCEPT, scheme: 'upto' } },
      'another network': { accept: { ...ACCEPT, network: 'eip155:1' } },
      'another asset': { accept: { ...ACCEPT, asset: '0x' + '22'.repeat(20) } },
      'another amount': { accept: { ...ACCEPT, amount: '10001' } },
      'another payee': { accept: { ...ACCEPT, payTo: '0x' + '33'.repeat(20) } },
      'any other field of the entry': { accept: { ...ACCEPT, extra: { name: 'USD Coin', version: '1' } } },
      'a grant added': { grant: { capAmount: '10000000', windowSeconds: 2592000 } },
    };
    for (const [name, change] of Object.entries(changes)) {
      test(name, () => {
        const { token } = issueMainConfirmation(KINDS.X402_PAYMENT, 0, PAYMENT);
        expect(refusal(() => consumeConfirmation(token, KINDS.X402_PAYMENT, 0, { ...PAYMENT, ...change })).code)
          .toBe(NOT_CONFIRMED);
      });
    }

    test('the account', () => {
      const { token } = issueMainConfirmation(KINDS.X402_PAYMENT, 0, PAYMENT);
      expect(refusal(() => consumeConfirmation(token, KINDS.X402_PAYMENT, 1, PAYMENT)).code)
        .toBe(NOT_CONFIRMED);
    });

    test("the grant's cap and window, and its removal", () => {
      const GRANTED = { ...PAYMENT, grant: { capAmount: '10000000', windowSeconds: 2592000 } };
      for (const grant of [
        { capAmount: '1000000000', windowSeconds: 2592000 },
        { capAmount: '10000000', windowSeconds: 31536000 },
        null,
      ]) {
        const { token } = issueMainConfirmation(KINDS.X402_PAYMENT, 0, GRANTED);
        expect(refusal(() => consumeConfirmation(token, KINDS.X402_PAYMENT, 0, { ...GRANTED, grant })).code)
          .toBe(NOT_CONFIRMED);
      }
    });

    test('a V1 entry binds maxAmountRequired as its amount', () => {
      const V1 = { ...PAYMENT, accept: { scheme: 'exact', network: 'base', maxAmountRequired: '10000', asset: ACCEPT.asset, payTo: ACCEPT.payTo } };
      const { token } = issueMainConfirmation(KINDS.X402_PAYMENT, 0, V1);
      expect(refusal(() => consumeConfirmation(token, KINDS.X402_PAYMENT, 0, {
        ...V1,
        accept: { ...V1.accept, maxAmountRequired: '20000' },
      })).code).toBe(NOT_CONFIRMED);
    });

    test('no other kind spends it, and it spends no other kind', () => {
      const { token } = issueMainConfirmation(KINDS.X402_PAYMENT, 0, PAYMENT);
      expect(refusal(() => consumeConfirmation(token, KINDS.SIGN_TYPED_DATA, 0, PAYMENT)).code)
        .toBe(NOT_CONFIRMED);
      // The core's kinds are never minted here.
      expect(() => issueMainConfirmation(KINDS.SIGN_MESSAGE, 0, 'pay')).toThrow(/main's own/);
    });

    test('a malformed payment is not issued a token', () => {
      for (const [change, message] of [
        [{ accept: undefined }, /Payment option/],
        [{ accept: { ...ACCEPT, scheme: '' } }, /scheme/],
        [{ accept: { ...ACCEPT, amount: undefined } }, /amount/],
        [{ accept: { ...ACCEPT, amount: 'lots' } }, /amount/],
        [{ accept: { ...ACCEPT, payTo: 7 } }, /payTo/],
        [{ webContentsId: -1 }, /tab/],
        [{ webContentsId: '42' }, /tab/],
        [{ detectionId: '' }, /detection/],
        [{ detectionId: 'req 1' }, /detection/],
        [{ url: '' }, /url/],
        [{ acceptIndex: 0.5 }, /payment option/],
        [{ grant: 'all of it' }, /grant/],
      ]) {
        expect(() => issueMainConfirmation(KINDS.X402_PAYMENT, 0, { ...PAYMENT, ...change })).toThrow(message);
      }
      expect(_outstandingCount()).toBe(0);
    });

    test('a discarded token no longer spends', () => {
      const { token } = issueMainConfirmation(KINDS.X402_PAYMENT, 0, PAYMENT);
      discardConfirmation(token);
      expect(refusal(() => consumeConfirmation(token, KINDS.X402_PAYMENT, 0, PAYMENT)).message)
        .toMatch(/unknown or already used/);
      expect(() => discardConfirmation(undefined)).not.toThrow();
    });
  });

  // #1023: an edit of an auto-pay cap binds the window it was confirmed
  // in, the cap's key, the cap as main held it, and the change.
  describe('x402 cap edits bind the window, the cap and the change', () => {
    const EDIT = Object.freeze({
      window: 1,
      origin: 'https://pay.example',
      chainId: 8453,
      asset: '0xabc',
      current: Object.freeze({ capAmount: '10000000', createdAt: 1000, expiresAt: 87400, generation: 7 }),
      capAmount: '20000000',
      windowSeconds: undefined,
    });

    test('the edit as confirmed applies, once', () => {
      const { token } = issueMainConfirmation(KINDS.X402_CAP_UPDATE, null, EDIT);
      // Another spelling of the same site is not a difference.
      expect(() => consumeConfirmation(token, KINDS.X402_CAP_UPDATE, null, {
        ...EDIT,
        origin: 'https://pay.example/settings',
      })).not.toThrow();
      expect(refusal(() => consumeConfirmation(token, KINDS.X402_CAP_UPDATE, null, EDIT)).message)
        .toMatch(/unknown or already used/);
    });

    const changes = {
      'another window': { window: 2 },
      'another site': { origin: 'https://other.example' },
      'another chain': { chainId: 100 },
      'another asset': { asset: '0xdef' },
      'another amount': { capAmount: '30000000' },
      'a window added': { windowSeconds: 86400 },
      'the cap granted again': { current: { ...EDIT.current, createdAt: 2000, generation: 8 } },
      // Revoked and granted again within one second: only the generation tells.
      'the cap granted again in the same second': { current: { ...EDIT.current, generation: 8 } },
      'the cap edited meanwhile': { current: { ...EDIT.current, capAmount: '15000000' } },
      'its window moved meanwhile': { current: { ...EDIT.current, expiresAt: 99999 } },
    };
    for (const [name, change] of Object.entries(changes)) {
      test(name, () => {
        const { token } = issueMainConfirmation(KINDS.X402_CAP_UPDATE, null, EDIT);
        expect(refusal(() => consumeConfirmation(token, KINDS.X402_CAP_UPDATE, null, { ...EDIT, ...change })).code)
          .toBe(NOT_CONFIRMED);
      });
    }

    test('no other kind spends it', () => {
      const { token } = issueMainConfirmation(KINDS.X402_CAP_UPDATE, null, EDIT);
      expect(refusal(() => consumeConfirmation(token, KINDS.X402_PAYMENT, null, EDIT)).code)
        .toBe(NOT_CONFIRMED);
    });

    test('a malformed edit is not issued a token', () => {
      for (const [change, message] of [
        [{ window: undefined }, /window/],
        [{ window: -1 }, /window/],
        [{ origin: '' }, /site/],
        [{ chainId: 0 }, /chainId/],
        [{ asset: '' }, /asset/],
        [{ current: null }, /No such auto-pay cap/],
        [{ current: { ...EDIT.current, createdAt: 'then' } }, /auto-pay cap/],
        [{ current: { ...EDIT.current, generation: undefined } }, /auto-pay cap/],
        [{ current: { ...EDIT.current, generation: 0 } }, /auto-pay cap/],
        [{ current: { ...EDIT.current, generation: '7' } }, /auto-pay cap/],
        [{ capAmount: undefined }, /Nothing to change/],
        [{ capAmount: '1.5' }, /cap/],
        [{ capAmount: 5 }, /cap/],
        [{ windowSeconds: 0 }, /window/],
        [{ windowSeconds: '86400' }, /window/],
      ]) {
        expect(() => issueMainConfirmation(KINDS.X402_CAP_UPDATE, null, { ...EDIT, ...change })).toThrow(message);
      }
      expect(_outstandingCount()).toBe(0);
    });
  });

  test('outstanding tokens are capped (oldest dropped) and expired ones pruned', () => {
    const first = issueMainConfirmation(KINDS.X402_PAYMENT, 3, PAYMENT);
    for (let i = 1; i < MAX_OUTSTANDING; i++) issueMainConfirmation(KINDS.X402_PAYMENT, 3, PAYMENT);
    expect(_outstandingCount()).toBe(MAX_OUTSTANDING);
    issueMainConfirmation(KINDS.X402_PAYMENT, 3, PAYMENT);
    expect(_outstandingCount()).toBe(MAX_OUTSTANDING);
    expect(refusal(() => consumeConfirmation(first.token, KINDS.X402_PAYMENT, 3, PAYMENT)).code).toBe(NOT_CONFIRMED);
    clock += CONFIRMATION_TTL_MS;
    issueMainConfirmation(KINDS.X402_PAYMENT, 3, PAYMENT);
    expect(_outstandingCount()).toBe(1);
  });
});

// The core's kinds (freedom-core design 0012, APB-1): main mints, spends and
// burns them through the identity core, a spy on whose calls checks the
// caller and the request in the core's form.
describe("signing-confirmation: the core's kinds", () => {
  const sc = require('./signing-confirmation');
  const HANDLE = 'c'.repeat(64);
  const PAGE = Object.freeze({ origin: 'https://app.example', top_origin: 'https://app.example', frame: 1, navigation: 2, agent: false });
  const WIRE = Object.freeze({
    type: 2,
    chain_id: '100',
    gas_limit: '21000',
    to: TX.to,
    value: '1000000000000000',
    data: TX.data,
    max_fee_per_gas: '2000000000',
    max_priority_fee_per_gas: '1000000000',
  });

  beforeEach(() => {
    sc._reset();
    mockCore.reset();
  });

  test('a request in the form the core binds it: the sign.* parameters but the key', () => {
    expect(sc.corePayload(KINDS.WALLET_SEND, 3, TX)).toEqual({ account: 3, payload: { tx: WIRE } });
    expect(sc.corePayload(KINDS.DAPP_SEND, 3, TX)).toEqual({ account: 3, payload: { tx: WIRE } });
    expect(sc.corePayload(KINDS.EXECUTOR_SEND, 1, { ...TX, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined, gasPrice: '7' }))
      .toEqual({ account: 1, payload: { tx: { type: 0, chain_id: '100', gas_limit: '21000', to: TX.to, value: WIRE.value, data: TX.data, gas_price: '7' } } });
    // A message's bytes, its text and hex alike.
    expect(sc.corePayload(KINDS.SIGN_MESSAGE, 0, 'hi')).toEqual({ account: 0, payload: { message: '0x6869' } });
    expect(sc.corePayload(KINDS.SIGN_MESSAGE, 0, '0x6869')).toEqual({ account: 0, payload: { message: '0x6869' } });
    // Typed data with what the core is told beside it for its view.
    const typed = sc.corePayload(KINDS.SIGN_TYPED_DATA, 0, JSON.stringify(TYPED_DATA), { chainId: 100 });
    expect(typed.payload).toMatchObject({ primary_type: 'Permit', chain_id: '100' });
    expect(typed.payload.typed_data).toEqual({ domain: TYPED_DATA.domain, types: TYPED_DATA.types, message: TYPED_DATA.message });
    // A Safe's address from its record, in lowercase.
    expect(sc.corePayload(KINDS.SAFE_SEND, 9, { tx: { to: TX.to, value: 5 }, chainId: 100 })).toEqual({
      account: 9,
      payload: { safe: '0x' + 'aa'.repeat(20), chain_id: '100', tx: { to: TX.to.toLowerCase(), value: '5', data: '0x' } },
    });
    expect(sc.corePayload(KINDS.SAFE_MESSAGE, 9, { method: 'personal_sign', params: ['0x68'] }).payload).toEqual({
      safe: '0x' + 'aa'.repeat(20),
      chain_id: '100',
      method: 'personal_sign',
      params: ['0x68'],
    });
    expect(() => sc.corePayload(KINDS.SAFE_SEND, 8, { tx: { to: TX.to }, chainId: 100 })).toThrow(/Unknown Safe/);
    const intent = { intentId: 'intent-0001', chainId: 100, sender: '0x' + 'BB'.repeat(20), nonce: 7 };
    expect(sc.corePayload(KINDS.INTENT_CLOSE, null, { ...intent, hashes: ['0x' + 'AB'.repeat(32)] })).toEqual({
      payload: { intent_id: 'intent-0001', chain_id: '100', sender: '0x' + 'bb'.repeat(20), nonce: '7', hashes: ['0x' + 'ab'.repeat(32)] },
    });
    expect(sc.corePayload(KINDS.INTENT_REPLACE, 2, { ...intent, ...TX })).toEqual({
      account: 2,
      payload: { intent_id: 'intent-0001', sender: '0x' + 'bb'.repeat(20), tx: { ...WIRE, nonce: '7' } },
    });
    // Main's own checks first, in today's words.
    expect(() => sc.corePayload(KINDS.DAPP_SEND, 3, { ...TX, origin: undefined })).toThrow(/needs the site/);
    expect(() => sc.corePayload(KINDS.WALLET_SEND, 3, { ...TX, gasLimit: 'lots' })).toThrow(/gasLimit/);
    expect(() => sc.corePayload(KINDS.X402_PAYMENT, 3, PAYMENT)).toThrow(/Not a core confirmation kind/);
  });

  test("a wallet kind is minted by the core from main itself, with the fee's acknowledgement and a phone's send", async () => {
    const { token, expiresAt } = await sc.issueConfirmation(KINDS.WALLET_SEND, 3, TX, { feeAcknowledged: true, phone: true });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(mockCore.calls).toEqual([
      {
        method: 'approval.issue',
        params: { kind: 'wallet-send', account: 3, payload: { tx: WIRE }, fee_ack: true, phone: true },
        page: null,
      },
    ]);
    await expect(sc.issueConfirmation(KINDS.SIGN_MESSAGE, 0, 'hi')).rejects.toThrow(/issued for its page/);
    await expect(sc.issueConfirmation(KINDS.SAFE_SEND, 9, { tx: { to: TX.to }, chainId: 100, origin: 'https://app.example' })).rejects.toThrow(
      /issued for its page/
    );
    await expect(sc.issueConfirmation(KINDS.WALLET_SEND, 3, { ...TX, chainId: 0 })).rejects.toThrow(/chainId/);
    expect(mockCore.calls).toHaveLength(1);
  });

  test("a page kind is minted under `page` with the document's PageContext and the prompt's handle", async () => {
    const confirmation = await sc.issuePageConfirmation(KINDS.DAPP_SEND, 3, TX, { handle: HANDLE, context: PAGE });
    expect(confirmation).toEqual({ token: expect.any(String), kind: 'dapp-send', account: 3, payload: { tx: WIRE }, handle: HANDLE, page: PAGE });
    expect(mockCore.calls[0]).toEqual({
      method: 'approval.issue',
      params: { kind: 'dapp-send', account: 3, payload: { tx: WIRE }, handle: HANDLE },
      page: PAGE,
    });
    expect(sc.signingAuthorization(confirmation)).toEqual({
      authorization: { token: confirmation.token, kind: 'dapp-send', handle: HANDLE },
      page: PAGE,
    });
    const typed = await sc.issuePageConfirmation(KINDS.SIGN_TYPED_DATA, 0, TYPED_DATA, { handle: HANDLE, context: PAGE }, { chainId: 100 });
    expect(typed.hash).toMatch(/^0x[0-9a-f]{64}$/);
    for (const page of [null, {}, { handle: HANDLE }, { handle: 'xyz', context: PAGE }, { handle: HANDLE, context: { ...PAGE, origin: '' } }]) {
      await expect(sc.issuePageConfirmation(KINDS.SIGN_MESSAGE, 0, '0x68', page)).rejects.toThrow(/needs its/);
    }
    await expect(sc.issuePageConfirmation(KINDS.WALLET_SEND, 0, TX, { handle: HANDLE, context: PAGE })).rejects.toThrow(
      /Not a page confirmation kind/
    );
    expect(mockCore.calls).toHaveLength(2);
  });

  test("a send's token names its kind at the signature; an intent-replace names its intent, a message neither (cored 0.15.0)", async () => {
    for (const kind of [KINDS.WALLET_SEND, KINDS.EXECUTOR_SEND]) {
      const { token } = await sc.issueConfirmation(kind, 3, TX);
      expect(sc.signingAuthorization(sc.confirmationFor(token, kind, 3, TX))).toEqual({ authorization: { token, kind }, page: null });
    }
    const replace = { token: 'f'.repeat(64), kind: KINDS.INTENT_REPLACE, payload: {}, intent: { id: 'intent-0001' } };
    expect(sc.signingAuthorization(replace)).toEqual({ authorization: { token: replace.token, intent: { id: 'intent-0001' } }, page: null });
    const message = await sc.issuePageConfirmation(KINDS.SIGN_MESSAGE, 0, '0x68', { handle: HANDLE, context: PAGE });
    expect(sc.signingAuthorization(message)).toEqual({ authorization: { token: message.token, handle: HANDLE }, page: PAGE });
  });

  test("the core's refusals in today's words; its fee check asks again with its verdict", async () => {
    const { token } = await sc.issueConfirmation(KINDS.INTENT_RESEND, null, {
      intentId: 'intent-0001',
      chainId: 100,
      sender: '0x' + 'bb'.repeat(20),
      nonce: 7,
      hash: '0x' + 'ab'.repeat(32),
    });
    const spend = (payload) => sc.spendConfirmation({ token, kind: KINDS.INTENT_RESEND, payload });
    const err = await rejection(spend({ intent_id: 'intent-0002' }));
    expect(err).toMatchObject({ code: NOT_CONFIRMED, message: 'Signing was not confirmed: request differs from what was confirmed' });
    expect((await rejection(spend({}))).message).toBe('Signing was not confirmed: unknown or already used confirmation');
    await expect(sc.spendConfirmation({ kind: KINDS.INTENT_RESEND })).rejects.toThrow(/no confirmation token/);

    const verdict = { max_cost: '42', comparable: true, ratio: '12.5', above: true, one_endpoint: false, basis: 'header', auto_approve: false };
    const issue = jest
      .spyOn(mockCore.approval, 'issue')
      .mockRejectedValueOnce(Object.assign(new Error('fee'), { code: 'not_authorized', data: { reason: 'fee_check', fee_check: verdict } }));
    const asked = await rejection(sc.issueConfirmation(KINDS.WALLET_SEND, 3, TX));
    expect(asked).toMatchObject({
      code: 'FEE_CHECK_ASK_AGAIN',
      feeCheck: { maxCost: '42', comparable: true, ratio: '12.5', above: true, oneEndpoint: false, basis: 'header', autoApprove: false },
    });
    issue.mockRestore();
  });

  test('a token is burnt once its request has ended, whatever became of it', async () => {
    const { token } = await sc.issueConfirmation(KINDS.WALLET_SEND, 3, TX);
    await expect(sc.withConfirmation(token, async () => 'done')).resolves.toBe('done');
    expect(mockCore.outstanding()).toBe(0);
    const again = await sc.issueConfirmation(KINDS.WALLET_SEND, 3, TX);
    await expect(sc.withConfirmation(again.token, async () => {
      throw new Error('nonce');
    })).rejects.toThrow('nonce');
    expect(mockCore.outstanding()).toBe(0);
    // A token the chrome presented for a request main can't read is burnt.
    const bad = await sc.issueConfirmation(KINDS.WALLET_SEND, 3, TX);
    expect(() => sc.confirmationFor(bad.token, KINDS.WALLET_SEND, 3, { ...TX, chainId: 0 })).toThrow(/not confirmed: Invalid chainId/);
    await Promise.resolve();
    expect(mockCore.outstanding()).toBe(0);
  });

  test("a Safe's send is spent through the core, and its Safe approval ended until APB-1c", async () => {
    const request = { tx: { to: TX.to, value: '5', data: '0x' }, chainId: 100 };
    const { token } = await sc.issueConfirmation(KINDS.SAFE_SEND, 9, request);
    await expect(sc.spendSafeConfirmation(sc.confirmationFor(token, KINDS.SAFE_SEND, 9, request))).resolves.toEqual({ bound: true });
    expect(mockCore.calls.map((call) => call.method)).toEqual(['approval.issue', 'approval.spend', 'approval.end']);
    expect(mockCore.openSafeApprovals()).toBe(0);
  });
});

// A site's standing rule (freedom-core design 0012, APB-1b): `approval.check`
// under the page, in the core's forms, and what main does with the core's
// `rule` reply to an "Always allow" send.
describe("signing-confirmation: a site's standing rule", () => {
  const sc = require('./signing-confirmation');
  const PAGE = Object.freeze({ origin: 'https://app.example', top_origin: 'https://app.example', frame: 1, navigation: 2, agent: false });

  beforeEach(() => {
    mockCore.reset();
  });

  test("approval.check gets the request in the core's form, under the page", async () => {
    mockCore.setStanding(() => ({ covered: true }));
    const send = { to: TX.to, value: '1000', data: TX.data, chainId: 100, gasLimit: '21000', gasPrice: '7' };
    await expect(sc.checkStanding(PAGE, { kind: 'transaction', account: 0, accountType: 'remote', payload: send, paused: false })).resolves.toEqual({
      covered: true,
      reason: null,
    });
    await sc.checkStanding(PAGE, { kind: 'message', account: 2, accountType: 'ledger', payload: 'hi' });
    await sc.checkStanding(PAGE, {
      kind: 'typed_data',
      account: 0,
      accountType: 'mnemonic',
      payload: { domain: { chainId: 100 }, types: { Mail: [{ name: 'body', type: 'string' }] }, primaryType: 'Mail', message: { body: 'x' } },
      chainId: 100,
    });
    // A send without main's D12 reading reads as paused.
    await sc.checkStanding(PAGE, { kind: 'transaction', account: 1, accountType: 'safe', payload: send });
    expect(mockCore.calls.map(({ method, params, page }) => [method, params, page])).toEqual([
      [
        'approval.check',
        {
          request: {
            kind: 'transaction',
            account: 0,
            account_kind: 'phone',
            tx: { type: 0, chain_id: '100', gas_limit: '21000', to: TX.to, value: '1000', data: TX.data, gas_price: '7' },
          },
          chain_id: 100,
          paused: false,
        },
        PAGE,
      ],
      ['approval.check', { request: { kind: 'message', account: 2, account_kind: 'ledger', message: '0x6869' } }, PAGE],
      [
        'approval.check',
        {
          request: {
            kind: 'typed_data',
            account: 0,
            account_kind: 'vault',
            typed_data: { domain: { chainId: 100 }, types: { Mail: [{ name: 'body', type: 'string' }] }, message: { body: 'x' } },
            primary_type: 'Mail',
          },
          chain_id: 100,
        },
        PAGE,
      ],
      ['approval.check', expect.objectContaining({ paused: true, request: expect.objectContaining({ account_kind: 'safe' }) }), PAGE],
    ]);
  });

  test('not covered: the core says so, the call fails, or the request is one the core cannot judge (unasked)', async () => {
    mockCore.setStanding(() => ({ covered: false, reason: 'paused' }));
    const message = { kind: 'message', account: 0, accountType: 'mnemonic', payload: 'hi' };
    await expect(sc.checkStanding(PAGE, message)).resolves.toEqual({ covered: false, reason: 'paused' });
    const check = jest.spyOn(mockCore.approval, 'check').mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'unavailable' }));
    await expect(sc.checkStanding(PAGE, message)).resolves.toEqual({ covered: false, reason: 'unavailable' });
    check.mockRestore();
    mockCore.calls.length = 0;
    await expect(sc.checkStanding(PAGE, { ...message, accountType: 'hardware' })).resolves.toEqual({ covered: false, reason: 'invalid' });
    await expect(sc.checkStanding(PAGE, { ...message, kind: 'other' })).resolves.toEqual({ covered: false, reason: 'invalid' });
    await expect(sc.checkStanding(null, message)).resolves.toEqual({ covered: false, reason: 'no_page' });
    expect(mockCore.calls).toEqual([]);
  });

  test('"Always allow": main writes the rule on the core\'s `not_moved`, or for a device\'s send, and on nothing else', () => {
    expect(sc.mainWritesRule(true, { added: false, reason: 'not_moved' })).toBe(true);
    expect(sc.mainWritesRule(false, undefined)).toBe(true);
    for (const reply of [{ added: true }, { added: false, reason: 'not_exposed' }, { added: false }, null, undefined]) {
      expect(sc.mainWritesRule(true, reply)).toBe(false);
    }
  });

  test("a standing refusal keeps the core's reason, in today's words", () => {
    const err = sc.confirmationError(Object.assign(new Error('x'), { code: 'not_authorized', data: { reason: 'no_rule' } }));
    expect(err).toMatchObject({ code: NOT_CONFIRMED, reason: 'no_rule' });
    expect(err.message).toBe("Signing was not confirmed: this request is not covered by the site's auto-approve rules");
  });
});
