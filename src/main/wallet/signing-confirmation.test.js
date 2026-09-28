const {
  CONFIRMATION_TTL_MS,
  MAX_OUTSTANDING,
  KINDS,
  NOT_CONFIRMED,
  issueConfirmation,
  consumeConfirmation,
  _reset,
  _setNow,
  _outstandingCount,
} = require('./signing-confirmation');

const TX = Object.freeze({
  chainId: 100,
  to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  value: '1000000000000000',
  data: '0x095ea7b3' + '00'.repeat(64),
  gasLimit: '21000',
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
});

const TYPED_DATA = Object.freeze({
  domain: { name: 'Permit', chainId: 100, verifyingContract: '0x' + '11'.repeat(20) },
  types: { Permit: [{ name: 'value', type: 'uint256' }] },
  primaryType: 'Permit',
  message: { value: '1' },
});

function refusal(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a refusal');
}

describe('signing-confirmation', () => {
  let clock;

  beforeEach(() => {
    _reset();
    clock = 1_000_000;
    _setNow(() => clock);
  });

  afterAll(() => _reset());

  test('a token signs exactly the request it was issued for, once', () => {
    const { token, expiresAt } = issueConfirmation(KINDS.DAPP_SEND, 3, TX);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBe(clock + CONFIRMATION_TTL_MS);

    expect(() => consumeConfirmation(token, KINDS.DAPP_SEND, 3, { ...TX })).not.toThrow();
  });

  test('reuse refuses: a token is burnt by its first presentation', () => {
    const { token } = issueConfirmation(KINDS.DAPP_SEND, 3, TX);
    consumeConfirmation(token, KINDS.DAPP_SEND, 3, TX);

    const err = refusal(() => consumeConfirmation(token, KINDS.DAPP_SEND, 3, TX));
    expect(err.code).toBe(NOT_CONFIRMED);
    expect(err.message).toMatch(/unknown or already used/);
  });

  test('a mismatched presentation also burns the token (no retry to probe)', () => {
    const { token } = issueConfirmation(KINDS.DAPP_SEND, 3, TX);
    expect(refusal(() => consumeConfirmation(token, KINDS.DAPP_SEND, 3, { ...TX, value: '1' })).code)
      .toBe(NOT_CONFIRMED);

    expect(refusal(() => consumeConfirmation(token, KINDS.DAPP_SEND, 3, TX)).message)
      .toMatch(/unknown or already used/);
  });

  test('expiry refuses', () => {
    const { token } = issueConfirmation(KINDS.DAPP_SEND, 3, TX);
    clock += CONFIRMATION_TTL_MS;

    const err = refusal(() => consumeConfirmation(token, KINDS.DAPP_SEND, 3, TX));
    expect(err.code).toBe(NOT_CONFIRMED);
    expect(err.message).toMatch(/expired/);
  });

  test('just inside the lifetime still signs', () => {
    const { token } = issueConfirmation(KINDS.DAPP_SEND, 3, TX);
    clock += CONFIRMATION_TTL_MS - 1;
    expect(() => consumeConfirmation(token, KINDS.DAPP_SEND, 3, TX)).not.toThrow();
  });

  test('no token, an empty token or an unknown token refuses', () => {
    for (const token of [undefined, null, '', 'f'.repeat(64), 42]) {
      expect(refusal(() => consumeConfirmation(token, KINDS.DAPP_SEND, 3, TX)).code)
        .toBe(NOT_CONFIRMED);
    }
  });

  describe('every bound transaction field refuses on mismatch', () => {
    const changes = {
      chainId: 1,
      to: '0x' + '22'.repeat(20),
      value: '1000000000000001',
      data: '0xa9059cbb' + '00'.repeat(64),
      gasLimit: '21001',
      maxFeePerGas: '2000000001',
      maxPriorityFeePerGas: '1000000001',
      gasPrice: '1',
    };
    for (const [field, value] of Object.entries(changes)) {
      test(field, () => {
        const { token } = issueConfirmation(KINDS.DAPP_SEND, 3, TX);
        const err = refusal(() =>
          consumeConfirmation(token, KINDS.DAPP_SEND, 3, { ...TX, [field]: value }));
        expect(err.code).toBe(NOT_CONFIRMED);
        expect(err.message).toMatch(/differs from what was confirmed/);
      });
    }

    test('a gas field dropped after confirming', () => {
      const { token } = issueConfirmation(KINDS.DAPP_SEND, 3, TX);
      const { maxPriorityFeePerGas: _dropped, ...rest } = TX;
      expect(refusal(() => consumeConfirmation(token, KINDS.DAPP_SEND, 3, rest)).code)
        .toBe(NOT_CONFIRMED);
    });

    test('the signing account (from)', () => {
      const { token } = issueConfirmation(KINDS.DAPP_SEND, 3, TX);
      expect(refusal(() => consumeConfirmation(token, KINDS.DAPP_SEND, 4, TX)).code)
        .toBe(NOT_CONFIRMED);
    });

    test('the confirmation kind (a dApp-send token cannot authorise a wallet send)', () => {
      const { token } = issueConfirmation(KINDS.DAPP_SEND, 3, TX);
      expect(refusal(() => consumeConfirmation(token, KINDS.WALLET_SEND, 3, TX)).code)
        .toBe(NOT_CONFIRMED);
    });
  });

  test('equivalent encodings of the same transaction match', () => {
    const { token } = issueConfirmation(KINDS.WALLET_SEND, 0, TX);
    expect(() =>
      consumeConfirmation(token, KINDS.WALLET_SEND, 0, {
        ...TX,
        to: TX.to.toLowerCase(),
        value: '0x' + BigInt(TX.value).toString(16),
        data: TX.data.toUpperCase().replace('0X', '0x'),
        gasLimit: 21000,
      })
    ).not.toThrow();
  });

  test('value and data default the same way at issue and at use', () => {
    const { token } = issueConfirmation(KINDS.WALLET_SEND, 0, { chainId: 1, to: TX.to, gasLimit: '21000', gasPrice: '1' });
    expect(() =>
      consumeConfirmation(token, KINDS.WALLET_SEND, 0, {
        chainId: 1, to: TX.to, value: '0', data: '0x', gasLimit: '21000', gasPrice: '1',
      })
    ).not.toThrow();
  });

  describe('messages and typed data bind their content hash', () => {
    test('personal_sign: the exact message', () => {
      const ok = issueConfirmation(KINDS.SIGN_MESSAGE, 0, '0x68656c6c6f');
      expect(() => consumeConfirmation(ok.token, KINDS.SIGN_MESSAGE, 0, '0x68656c6c6f')).not.toThrow();

      const other = issueConfirmation(KINDS.SIGN_MESSAGE, 0, '0x68656c6c6f');
      expect(refusal(() => consumeConfirmation(other.token, KINDS.SIGN_MESSAGE, 0, '0x68656c6c70')).code)
        .toBe(NOT_CONFIRMED);
    });

    test('typed data: key order does not matter, content does', () => {
      const ok = issueConfirmation(KINDS.SIGN_TYPED_DATA, 0, TYPED_DATA);
      const reordered = {
        message: TYPED_DATA.message,
        primaryType: TYPED_DATA.primaryType,
        types: TYPED_DATA.types,
        domain: { verifyingContract: TYPED_DATA.domain.verifyingContract, chainId: 100, name: 'Permit' },
      };
      expect(() => consumeConfirmation(ok.token, KINDS.SIGN_TYPED_DATA, 0, reordered)).not.toThrow();

      const other = issueConfirmation(KINDS.SIGN_TYPED_DATA, 0, TYPED_DATA);
      expect(refusal(() => consumeConfirmation(other.token, KINDS.SIGN_TYPED_DATA, 0, {
        ...TYPED_DATA,
        domain: { ...TYPED_DATA.domain, chainId: 1 },
      })).code).toBe(NOT_CONFIRMED);
    });

    test('a message token cannot sign typed data carrying the same string', () => {
      const { token } = issueConfirmation(KINDS.SIGN_MESSAGE, 0, 'hello');
      expect(refusal(() => consumeConfirmation(token, KINDS.SIGN_TYPED_DATA, 0, 'hello')).code)
        .toBe(NOT_CONFIRMED);
    });
  });

  describe('Safe requests', () => {
    const SAFE_TX = { tx: { to: TX.to, value: '5', data: '0x' }, chainId: 100 };

    test('safe-send binds the Safe, chain, to, value and data', () => {
      const ok = issueConfirmation(KINDS.SAFE_SEND, 7, SAFE_TX);
      expect(() => consumeConfirmation(ok.token, KINDS.SAFE_SEND, 7, SAFE_TX)).not.toThrow();

      for (const changed of [
        [8, SAFE_TX],
        [7, { ...SAFE_TX, chainId: 1 }],
        [7, { ...SAFE_TX, tx: { ...SAFE_TX.tx, to: '0x' + '33'.repeat(20) } }],
        [7, { ...SAFE_TX, tx: { ...SAFE_TX.tx, value: '6' } }],
        [7, { ...SAFE_TX, tx: { ...SAFE_TX.tx, data: '0x01' } }],
      ]) {
        const { token } = issueConfirmation(KINDS.SAFE_SEND, 7, SAFE_TX);
        expect(refusal(() => consumeConfirmation(token, KINDS.SAFE_SEND, ...changed)).code)
          .toBe(NOT_CONFIRMED);
      }
    });

    test('safe-message binds the method and params', () => {
      const request = { method: 'personal_sign', params: ['0xdead', '0xsafe'] };
      const ok = issueConfirmation(KINDS.SAFE_MESSAGE, 7, request);
      expect(() => consumeConfirmation(ok.token, KINDS.SAFE_MESSAGE, 7, request)).not.toThrow();

      const other = issueConfirmation(KINDS.SAFE_MESSAGE, 7, request);
      expect(refusal(() => consumeConfirmation(other.token, KINDS.SAFE_MESSAGE, 7, {
        ...request,
        params: ['0xbeef', '0xsafe'],
      })).code).toBe(NOT_CONFIRMED);
    });
  });

  test('malformed requests are not issued a token', () => {
    expect(() => issueConfirmation(KINDS.DAPP_SEND, 3, { ...TX, gasLimit: 'lots' })).toThrow(/gasLimit/);
    expect(() => issueConfirmation(KINDS.DAPP_SEND, 3, { ...TX, chainId: 0 })).toThrow(/chainId/);
    expect(() => issueConfirmation(KINDS.DAPP_SEND, 3, { ...TX, data: 'nothex' })).toThrow(/data/);
    expect(() => issueConfirmation(KINDS.DAPP_SEND, -1, TX)).toThrow(/wallet index/);
    expect(() => issueConfirmation(KINDS.SIGN_MESSAGE, 0, '')).toThrow(/Message/);
    expect(() => issueConfirmation('export-everything', 0, TX)).toThrow(/Unknown/);
    expect(_outstandingCount()).toBe(0);
  });

  test('outstanding tokens are capped (oldest dropped) and expired ones pruned', () => {
    const first = issueConfirmation(KINDS.DAPP_SEND, 3, TX);
    for (let i = 1; i < MAX_OUTSTANDING; i++) issueConfirmation(KINDS.DAPP_SEND, 3, TX);
    expect(_outstandingCount()).toBe(MAX_OUTSTANDING);

    issueConfirmation(KINDS.DAPP_SEND, 3, TX);
    expect(_outstandingCount()).toBe(MAX_OUTSTANDING);
    expect(refusal(() => consumeConfirmation(first.token, KINDS.DAPP_SEND, 3, TX)).code)
      .toBe(NOT_CONFIRMED);

    clock += CONFIRMATION_TTL_MS;
    issueConfirmation(KINDS.DAPP_SEND, 3, TX);
    expect(_outstandingCount()).toBe(1);
  });
});
