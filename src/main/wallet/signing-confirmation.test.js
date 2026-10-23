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
  // A dApp payment's site; a wallet send ignores it.
  origin: 'https://app.example',
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

  // A dApp payment is recorded under its site, which "Always allow"'s pause
  // reads (D12), so its confirmation binds the site as a permission key.
  // Review of #788, round 2: a dApp payment without a site would be outside
  // every site's pause, so its confirmation can't be issued or spent.
  test('codex r2: a dapp-send confirmation without a site is refused', () => {
    for (const origin of [undefined, null, '', '   ', 42]) {
      expect(() => issueConfirmation(KINDS.DAPP_SEND, 3, { ...TX, origin })).toThrow(
        'A dApp payment needs the site it is for'
      );
    }
    const token = issueConfirmation(KINDS.DAPP_SEND, 3, TX).token;
    const err = refusal(() =>
      consumeConfirmation(token, KINDS.DAPP_SEND, 3, { ...TX, origin: '' })
    );
    expect(err.code).toBe(NOT_CONFIRMED);
    expect(err.message).toContain('A dApp payment needs the site it is for');
  });

  test('a dapp-send binds the site it is for; a wallet-send has none', () => {
    const SITE = 'https://swap.example';
    const issue = (origin) => issueConfirmation(KINDS.DAPP_SEND, 3, { ...TX, origin }).token;
    const use = (token, origin) =>
      consumeConfirmation(token, KINDS.DAPP_SEND, 3, { ...TX, origin });

    expect(() => use(issue(SITE), `${SITE}/trade?x=1`)).not.toThrow();
    expect(refusal(() => use(issue(SITE), 'https://other.example')).code).toBe(NOT_CONFIRMED);
    expect(refusal(() => use(issue(SITE), undefined)).code).toBe(NOT_CONFIRMED);

    const wallet = issueConfirmation(KINDS.WALLET_SEND, 3, { ...TX, origin: SITE }).token;
    expect(() =>
      consumeConfirmation(wallet, KINDS.WALLET_SEND, 3, { ...TX, origin: 'https://other.example' })
    ).not.toThrow();
  });

  // Review of #788, round 3: a dApp's SafeTx binds its site; the wallet's
  // own has none.
  test('codex r3: a safe-send binds its site if it has one', () => {
    const SITE = 'https://swap.example';
    const SAFE = { tx: { to: TX.to, value: '0', data: '0x' }, chainId: 100 };
    const issue = (origin) =>
      issueConfirmation(KINDS.SAFE_SEND, 2, { ...SAFE, ...(origin && { origin }) }).token;
    const use = (token, origin) =>
      consumeConfirmation(token, KINDS.SAFE_SEND, 2, { ...SAFE, ...(origin && { origin }) });

    expect(() => use(issue(SITE), `${SITE}/swap`)).not.toThrow();
    expect(() => use(issue(undefined), undefined)).not.toThrow();
    for (const [issued, used] of [
      [SITE, 'https://other.example'],
      [undefined, SITE],
      [SITE, undefined],
    ]) {
      expect(refusal(() => use(issue(issued), used)).code).toBe(NOT_CONFIRMED);
    }
    expect(() => issueConfirmation(KINDS.SAFE_SEND, 2, { ...SAFE, origin: '' })).toThrow(
      'A dApp payment needs the site it is for'
    );
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

    // freedom-core #88: the core's hash of the data, bound with it.
    const HASH = '0x' + 'ab'.repeat(32);

    test('typed data: key order does not matter, content does', () => {
      const ok = issueConfirmation(KINDS.SIGN_TYPED_DATA, 0, TYPED_DATA, { hash: HASH });
      const reordered = {
        message: TYPED_DATA.message,
        primaryType: TYPED_DATA.primaryType,
        types: TYPED_DATA.types,
        domain: { verifyingContract: TYPED_DATA.domain.verifyingContract, chainId: 100, name: 'Permit' },
      };
      expect(consumeConfirmation(ok.token, KINDS.SIGN_TYPED_DATA, 0, reordered)).toEqual({ hash: HASH });

      const other = issueConfirmation(KINDS.SIGN_TYPED_DATA, 0, TYPED_DATA, { hash: HASH });
      expect(refusal(() => consumeConfirmation(other.token, KINDS.SIGN_TYPED_DATA, 0, {
        ...TYPED_DATA,
        domain: { ...TYPED_DATA.domain, chainId: 1 },
      })).code).toBe(NOT_CONFIRMED);
    });

    test('a typed-data token carries the confirmed hash, and needs one', () => {
      const upper = '0x' + 'AB'.repeat(32);
      const { token } = issueConfirmation(KINDS.SIGN_TYPED_DATA, 0, TYPED_DATA, { hash: upper });
      expect(consumeConfirmation(token, KINDS.SIGN_TYPED_DATA, 0, TYPED_DATA)).toEqual({ hash: HASH });
      for (const bound of [undefined, {}, { hash: '0x12' }, { hash: 'ab'.repeat(32) }]) {
        expect(() => issueConfirmation(KINDS.SIGN_TYPED_DATA, 0, TYPED_DATA, bound)).toThrow(
          'Invalid typed data hash'
        );
      }
      // Other kinds bind nothing more.
      const message = issueConfirmation(KINDS.SIGN_MESSAGE, 0, 'hello', { hash: HASH });
      expect(consumeConfirmation(message.token, KINDS.SIGN_MESSAGE, 0, 'hello')).toEqual({});
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

  // freedom-core design 0005, "State history" (#94): closing by hand binds
  // the intent and every hash it has, in order: the revision the user saw.
  test('an intent-close binds the intent and each of its hashes, in order', () => {
    const CLOSE = {
      intentId: '7b0c6c1e-0c62-4a6e-9a49-0d6a3f6d1a07',
      chainId: 100,
      sender: '0x' + 'AB'.repeat(20),
      nonce: 7,
      hashes: ['0x' + 'A1'.repeat(32), '0x' + 'b2'.repeat(32)],
    };
    const lower = {
      ...CLOSE,
      sender: CLOSE.sender.toLowerCase(),
      hashes: CLOSE.hashes.map((h) => h.toLowerCase()),
    };
    const ok = issueConfirmation(KINDS.INTENT_CLOSE, null, CLOSE);
    expect(() => consumeConfirmation(ok.token, KINDS.INTENT_CLOSE, null, lower)).not.toThrow();

    for (const changed of [
      { hashes: [CLOSE.hashes[0]] },
      { hashes: [...CLOSE.hashes].reverse() },
      { hashes: [...CLOSE.hashes, '0x' + 'c3'.repeat(32)] },
      { nonce: 8 },
      { chainId: 1 },
      { intentId: '7b0c6c1e-0c62-4a6e-9a49-0d6a3f6d1a08' },
      { sender: '0x' + 'cd'.repeat(20) },
    ]) {
      const { token } = issueConfirmation(KINDS.INTENT_CLOSE, null, CLOSE);
      expect(
        refusal(() =>
          consumeConfirmation(token, KINDS.INTENT_CLOSE, null, { ...CLOSE, ...changed })
        ).code
      ).toBe(NOT_CONFIRMED);
    }
    // Not a confirmation of a resend of the same intent.
    const resend = issueConfirmation(KINDS.INTENT_RESEND, null, {
      ...CLOSE,
      hash: CLOSE.hashes[1],
    });
    expect(
      refusal(() => consumeConfirmation(resend.token, KINDS.INTENT_CLOSE, null, CLOSE)).code
    ).toBe(NOT_CONFIRMED);

    for (const hashes of [[], undefined, ['0x12'], Array(65).fill(CLOSE.hashes[0])]) {
      expect(() => issueConfirmation(KINDS.INTENT_CLOSE, null, { ...CLOSE, hashes })).toThrow(
        /hash/i
      );
    }
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
