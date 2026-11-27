/**
 * Main's rebuild of a Ledger payment's x402 authorization
 * (ledger-authorization.js; freedom-core design 0016, "x402 from a Ledger
 * account", L5; LDG-3's PR 3), held to the installed `@x402/evm` itself:
 * each form is what the package hands its signer, member for member, and a
 * signature over main's rebuild is the package's payload signature. The
 * pinned core's vectors are `ledger-authorization.vectors.test.js`.
 *
 * The account is the abandon-12 phrase's first (freedom-core's `keys.json`),
 * the clock and nonce those of the core's vectors.
 */

const { TypedDataEncoder, Wallet } = require('ethers');
const { x402EvmBuild } = require('../../../test/helpers/x402-evm-reference');
const {
  FORMS,
  REFUSALS,
  V1_NETWORKS,
  rebuildLedgerAuthorization,
  checkLedgerAuthorization,
  nonceOf,
  sameJson,
} = require('./ledger-authorization');

const PRIVATE_KEY = '0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727';
const ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const NOW_S = 1762000000;
const NONCE_HEX = '0b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186';
const BYTES32_NONCE = `0x${NONCE_HEX}`;
const PERMIT2_NONCE = BigInt(BYTES32_NONCE).toString();
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x209693bc6afc0c5328ba36faf03c514ef312287c';

const V2_EIP3009 = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '10000',
  asset: USDC_BASE,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: 'USD Coin', version: '2' },
};
const V1_EIP3009 = {
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '10000',
  resource: 'https://paid.example/a',
  description: '',
  mimeType: '',
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  asset: USDC_BASE,
  extra: { name: 'USD Coin', version: '2' },
};
const V2_PERMIT2 = {
  ...V2_EIP3009,
  extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' },
};

const FORM_CASES = [
  { form: FORMS.EIP3009, x402Version: 2, accept: V2_EIP3009 },
  { form: FORMS.EIP3009_V1, x402Version: 1, accept: V1_EIP3009 },
  { form: FORMS.PERMIT2, x402Version: 2, accept: V2_PERMIT2 },
];

const formNonce = (form) => (form === FORMS.PERMIT2 ? PERMIT2_NONCE : BYTES32_NONCE);

function inputFor({ form, x402Version, accept }, overrides = {}) {
  return { x402Version, accept, from: ADDRESS, nowS: NOW_S, nonce: formNonce(form), ...overrides };
}

function rebuilt(input) {
  const result = rebuildLedgerAuthorization(input);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

const typesOf = (typedData) => typedData.types;
const hashOf = (typedData) =>
  TypedDataEncoder.hash(typedData.domain, typesOf(typedData), typedData.message);

/** A copy as JSON.parse would give it, every object's members in reverse order. */
function reversedMembers(value) {
  if (Array.isArray(value)) return value.map(reversedMembers);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, member]) => [key, reversedMembers(member)])
  );
}

const clone = (value) => JSON.parse(JSON.stringify(value));

describe('rebuildLedgerAuthorization: the three forms, as @x402/evm builds them', () => {
  // The core's vectors' typed data and hashes (vectors/ledger.json's x402
  // cases at cored-v0.30.0), written out so this suite runs without them.
  test.each([
    [FORMS.EIP3009, '0xe28566b186983d6bb74303dae1356b36ed590ba11d4fa6d6bf87a26a2c86f57d'],
    [FORMS.EIP3009_V1, '0x1dc3557131ea5e3bf6cf6751d96b9da78111f0f591beeb51fc145dfb461b6a98'],
    [FORMS.PERMIT2, '0x95200399f633afc74771c14c3403316242f83fbb5992ba14a7f16bebfc19036f'],
  ])('%s hashes as the core vectors record it', (form, hash) => {
    const c = FORM_CASES.find((entry) => entry.form === form);
    const result = rebuilt(inputFor(c));
    expect(result.form).toBe(form);
    expect(hashOf(result.typedData)).toBe(hash);
  });

  test('EIP-3009, version 2: validAfter 0, the deadline now_s + maxTimeoutSeconds', () => {
    expect(rebuilt(inputFor(FORM_CASES[0])).typedData).toEqual({
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE },
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
        from: ADDRESS,
        to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        value: '10000',
        validAfter: '0',
        validBefore: '1762000060',
        nonce: BYTES32_NONCE,
      },
    });
  });

  test('EIP-3009, version 1: maxAmountRequired, validAfter ten minutes back', () => {
    const { message, domain } = rebuilt(inputFor(FORM_CASES[1])).typedData;
    expect(domain.chainId).toBe(8453);
    expect(message.value).toBe('10000');
    expect(message.validAfter).toBe('1761999400');
    expect(message.validBefore).toBe('1762000060');
  });

  test("Permit2: Permit2's domain, x402's proxy as the spender, a uint256 nonce", () => {
    expect(rebuilt(inputFor(FORM_CASES[2])).typedData).toEqual({
      domain: {
        name: 'Permit2',
        chainId: 8453,
        verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      },
      types: {
        PermitWitnessTransferFrom: [
          { name: 'permitted', type: 'TokenPermissions' },
          { name: 'spender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'witness', type: 'Witness' },
        ],
        TokenPermissions: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        Witness: [
          { name: 'to', type: 'address' },
          { name: 'validAfter', type: 'uint256' },
        ],
      },
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: { token: USDC_BASE, amount: '10000' },
        spender: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
        nonce: PERMIT2_NONCE,
        deadline: '1762000060',
        witness: { to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', validAfter: '0' },
      },
    });
  });

  // Each variant the package routes differently or writes differently,
  // against the installed package itself, member order included.
  const VARIANTS = [
    ['EIP-3009, version 2', FORM_CASES[0]],
    ['EIP-3009, version 1 (base)', FORM_CASES[1]],
    ['Permit2', FORM_CASES[2]],
    [
      'EIP-3009, version 1 (ethereum)',
      {
        form: FORMS.EIP3009_V1,
        x402Version: 1,
        accept: {
          ...V1_EIP3009,
          network: 'ethereum',
          asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        },
      },
    ],
    [
      'version 1 ignores assetTransferMethod',
      {
        form: FORMS.EIP3009_V1,
        x402Version: 1,
        accept: { ...V1_EIP3009, extra: { ...V1_EIP3009.extra, assetTransferMethod: 'permit2' } },
      },
    ],
    [
      'another transfer method is EIP-3009',
      {
        form: FORMS.EIP3009,
        x402Version: 2,
        accept: { ...V2_EIP3009, extra: { ...V2_EIP3009.extra, assetTransferMethod: 'eip2612' } },
      },
    ],
    [
      'Permit2 needs no name or version, nor a 20 s window',
      {
        form: FORMS.PERMIT2,
        x402Version: 2,
        accept: { ...V2_EIP3009, maxTimeoutSeconds: 5, extra: { assetTransferMethod: 'permit2' } },
      },
    ],
    [
      'leading zeros in the amount',
      { form: FORMS.EIP3009, x402Version: 2, accept: { ...V2_EIP3009, amount: '0010000' } },
    ],
    [
      'leading zeros in a Permit2 amount',
      { form: FORMS.PERMIT2, x402Version: 2, accept: { ...V2_PERMIT2, amount: '0010000' } },
    ],
    [
      'a zero amount',
      { form: FORMS.EIP3009, x402Version: 2, accept: { ...V2_EIP3009, amount: '0' } },
    ],
    [
      'a lowercase asset',
      {
        form: FORMS.EIP3009,
        x402Version: 2,
        accept: { ...V2_EIP3009, asset: USDC_BASE.toLowerCase() },
      },
    ],
    [
      'an uppercase payTo',
      {
        form: FORMS.EIP3009,
        x402Version: 2,
        accept: { ...V2_EIP3009, payTo: `0x${PAY_TO.slice(2).toUpperCase()}` },
      },
    ],
    [
      '18 decimals on another chain',
      {
        form: FORMS.EIP3009,
        x402Version: 2,
        accept: {
          ...V2_EIP3009,
          network: 'eip155:4326',
          amount: '1000000000000000000',
          asset: '0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7',
          extra: { name: 'MegaUSD', version: '1' },
        },
      },
    ],
    [
      'a non-ASCII domain name',
      {
        form: FORMS.EIP3009,
        x402Version: 2,
        accept: { ...V2_EIP3009, extra: { name: 'Dólar Ⓢ', version: '2' } },
      },
    ],
    [
      'the largest amount',
      {
        form: FORMS.PERMIT2,
        x402Version: 2,
        accept: { ...V2_PERMIT2, amount: (2n ** 256n - 1n).toString() },
      },
    ],
  ];

  test.each(VARIANTS)('%s: what @x402/evm hands its signer', async (_name, c) => {
    const reference = await x402EvmBuild({
      x402Version: c.x402Version,
      accept: c.accept,
      address: ADDRESS,
      nowS: NOW_S,
      nonceHex: NONCE_HEX,
    });
    const result = rebuilt(inputFor(c));
    expect(result.form).toBe(c.form);
    expect(JSON.stringify(result.typedData)).toBe(JSON.stringify(reference.typedData));
    expect(sameJson(result.typedData, reference.typedData)).toBe(true);
  });

  test.each(VARIANTS)(
    "%s: a signature over main's rebuild is the package's payload's",
    async (_name, c) => {
      const wallet = new Wallet(PRIVATE_KEY);
      const reference = await x402EvmBuild({
        x402Version: c.x402Version,
        accept: c.accept,
        address: ADDRESS,
        nowS: NOW_S,
        nonceHex: NONCE_HEX,
        sign: (typedData) =>
          wallet.signTypedData(typedData.domain, typedData.types, typedData.message),
      });
      const { typedData } = rebuilt(inputFor(c));
      const signature = await wallet.signTypedData(
        typedData.domain,
        typedData.types,
        typedData.message
      );
      const inner = reference.payload.payload;
      expect(inner.signature).toBe(signature);
      // The payload's authorization is the message's, but for the amount's
      // text, which the payload keeps as the entry writes it.
      const { message } = typedData;
      if (c.form === FORMS.PERMIT2) {
        const authorization = inner.permit2Authorization;
        expect(authorization.from).toBe(ADDRESS);
        expect(BigInt(authorization.permitted.amount)).toBe(BigInt(message.permitted.amount));
        expect({ ...authorization.permitted, amount: message.permitted.amount }).toEqual(
          message.permitted
        );
        expect(authorization.spender).toBe(message.spender);
        expect(authorization.nonce).toBe(message.nonce);
        expect(authorization.deadline).toBe(message.deadline);
        expect(authorization.witness).toEqual(message.witness);
      } else {
        const authorization = inner.authorization;
        expect(BigInt(authorization.value)).toBe(BigInt(message.value));
        expect({ ...authorization, value: message.value }).toEqual(message);
      }
    }
  );

  test("the version-1 networks are the package's chains for them", async () => {
    for (const [network, chainId] of Object.entries(V1_NETWORKS)) {
      const reference = await x402EvmBuild({
        x402Version: 1,
        accept: { ...V1_EIP3009, network },
        address: ADDRESS,
        nowS: NOW_S,
        nonceHex: NONCE_HEX,
      });
      expect(reference.typedData.domain.chainId).toBe(chainId);
    }
  });

  test('version 1 at now_s 600 has validAfter 0', () => {
    const { typedData } = rebuilt(inputFor(FORM_CASES[1], { nowS: 600 }));
    expect(typedData.message.validAfter).toBe('0');
    expect(typedData.message.validBefore).toBe('660');
  });

  test('a fresh, deeply frozen copy each call', () => {
    const first = rebuilt(inputFor(FORM_CASES[2])).typedData;
    const second = rebuilt(inputFor(FORM_CASES[2])).typedData;
    expect(first).not.toBe(second);
    expect(first.types).not.toBe(second.types);
    expect(first).toEqual(second);
    for (const value of [
      first,
      first.domain,
      first.types,
      first.types.Witness,
      first.types.Witness[0],
      first.message,
      first.message.permitted,
      first.message.witness,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });
});

describe('rebuildLedgerAuthorization: what it refuses, with its reason', () => {
  const [v2, v1, permit2] = FORM_CASES;
  const withAccept = (c, accept) => inputFor(c, { accept });
  const UNSAFE = 2 ** 53;

  test.each([
    ['x402Version 3', inputFor(v2, { x402Version: 3 }), REFUSALS.VERSION],
    ['x402Version as text', inputFor(v2, { x402Version: '2' }), REFUSALS.VERSION],
    ['no input', undefined, REFUSALS.VERSION],
    ['no accept entry', inputFor(v2, { accept: undefined }), REFUSALS.ACCEPT],
    ['an accept entry that is an array', inputFor(v2, { accept: [V2_EIP3009] }), REFUSALS.ACCEPT],
    [
      'an accept entry with a prototype',
      inputFor(v2, { accept: Object.create(V2_EIP3009) }),
      REFUSALS.ACCEPT,
    ],
    ['another scheme', withAccept(v2, { ...V2_EIP3009, scheme: 'upto' }), REFUSALS.SCHEME],
    [
      'a padded chain',
      withAccept(v2, { ...V2_EIP3009, network: 'eip155:08453' }),
      REFUSALS.NETWORK,
    ],
    ['chain 0', withAccept(v2, { ...V2_EIP3009, network: 'eip155:0' }), REFUSALS.NETWORK],
    [
      'a chain past 2^53',
      withAccept(v2, { ...V2_EIP3009, network: 'eip155:9007199254740993' }),
      REFUSALS.NETWORK,
    ],
    [
      'a non-EVM network',
      withAccept(v2, { ...V2_EIP3009, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }),
      REFUSALS.NETWORK,
    ],
    [
      'a version-1 name in version 2',
      withAccept(v2, { ...V2_EIP3009, network: 'base' }),
      REFUSALS.NETWORK,
    ],
    [
      'a version-1 network the client does not register',
      withAccept(v1, { ...V1_EIP3009, network: 'polygon' }),
      REFUSALS.NETWORK,
    ],
    [
      'an inherited name as a version-1 network',
      withAccept(v1, { ...V1_EIP3009, network: 'constructor' }),
      REFUSALS.NETWORK,
    ],
    [
      'a CAIP-2 network in version 1',
      withAccept(v1, { ...V1_EIP3009, network: 'eip155:8453' }),
      REFUSALS.NETWORK,
    ],
    ['a hex amount', withAccept(v2, { ...V2_EIP3009, amount: '0x10' }), REFUSALS.AMOUNT],
    ['a fractional amount', withAccept(v2, { ...V2_EIP3009, amount: '0.5' }), REFUSALS.AMOUNT],
    ['a negative amount', withAccept(v2, { ...V2_EIP3009, amount: '-1' }), REFUSALS.AMOUNT],
    ['an empty amount', withAccept(v2, { ...V2_EIP3009, amount: '' }), REFUSALS.AMOUNT],
    ['an amount as a number', withAccept(v2, { ...V2_EIP3009, amount: 10000 }), REFUSALS.AMOUNT],
    [
      'an amount of 2^256',
      withAccept(permit2, { ...V2_PERMIT2, amount: (2n ** 256n).toString() }),
      REFUSALS.AMOUNT,
    ],
    [
      'version 2 reads amount, not maxAmountRequired',
      withAccept(v2, { ...V1_EIP3009, network: 'eip155:8453' }),
      REFUSALS.AMOUNT,
    ],
    [
      'version 1 reads maxAmountRequired, not amount',
      withAccept(v1, { ...V2_EIP3009, network: 'base' }),
      REFUSALS.AMOUNT,
    ],
    [
      'an asset with 0X',
      withAccept(v2, { ...V2_EIP3009, asset: `0X${USDC_BASE.slice(2)}` }),
      REFUSALS.ASSET,
    ],
    [
      'an asset without 0x',
      withAccept(v2, { ...V2_EIP3009, asset: USDC_BASE.slice(2) }),
      REFUSALS.ASSET,
    ],
    [
      'an asset with a wrong checksum',
      withAccept(v2, { ...V2_EIP3009, asset: USDC_BASE.replace('fCD', 'FCD') }),
      REFUSALS.ASSET,
    ],
    ['a short payTo', withAccept(v2, { ...V2_EIP3009, payTo: '0x1234' }), REFUSALS.PAY_TO],
    [
      'an ICAP payTo',
      withAccept(v2, { ...V2_EIP3009, payTo: 'XE7338O073KYGTWWZN0F2WZ0R8PX5ZPPZS' }),
      REFUSALS.PAY_TO,
    ],
    [
      'a fractional timeout',
      withAccept(v2, { ...V2_EIP3009, maxTimeoutSeconds: 60.5 }),
      REFUSALS.TIMEOUT,
    ],
    [
      'a zero timeout',
      withAccept(permit2, { ...V2_PERMIT2, maxTimeoutSeconds: 0 }),
      REFUSALS.TIMEOUT,
    ],
    [
      'a timeout as text',
      withAccept(v2, { ...V2_EIP3009, maxTimeoutSeconds: '60' }),
      REFUSALS.TIMEOUT,
    ],
    [
      'a timeout of 2^53',
      withAccept(v2, { ...V2_EIP3009, maxTimeoutSeconds: UNSAFE }),
      REFUSALS.TIMEOUT,
    ],
    ['a deadline at 2^53', inputFor(permit2, { nowS: UNSAFE - 60 }), REFUSALS.TIMEOUT],
    [
      'EIP-3009 without a version',
      withAccept(v2, { ...V2_EIP3009, extra: { name: 'USD Coin' } }),
      REFUSALS.DOMAIN,
    ],
    [
      'EIP-3009 with an empty name',
      withAccept(v2, { ...V2_EIP3009, extra: { name: '', version: '2' } }),
      REFUSALS.DOMAIN,
    ],
    [
      'EIP-3009 with a numeric name',
      withAccept(v2, { ...V2_EIP3009, extra: { name: 5, version: '2' } }),
      REFUSALS.DOMAIN,
    ],
    [
      'EIP-3009 with a numeric version',
      withAccept(v1, { ...V1_EIP3009, extra: { name: 'USD Coin', version: 2 } }),
      REFUSALS.DOMAIN,
    ],
    ['EIP-3009 with extra null', withAccept(v2, { ...V2_EIP3009, extra: null }), REFUSALS.DOMAIN],
    [
      'EIP-3009 with no extra',
      withAccept(v1, { ...V1_EIP3009, extra: undefined }),
      REFUSALS.DOMAIN,
    ],
    ['an account that is no address', inputFor(v2, { from: '0x9858' }), REFUSALS.FROM],
    [
      'an account with a wrong checksum',
      inputFor(v2, { from: ADDRESS.replace('EfFD', 'EFFD') }),
      REFUSALS.FROM,
    ],
    ['a fractional now_s', inputFor(v2, { nowS: NOW_S + 0.5 }), REFUSALS.CLOCK],
    ['a negative now_s', inputFor(permit2, { nowS: -1 }), REFUSALS.CLOCK],
    ['now_s as text', inputFor(v2, { nowS: String(NOW_S) }), REFUSALS.CLOCK],
    ['version 1 before 600', inputFor(v1, { nowS: 599 }), REFUSALS.CLOCK],
    [
      'an uppercase bytes32 nonce',
      inputFor(v2, { nonce: BYTES32_NONCE.toUpperCase().replace('0X', '0x') }),
      REFUSALS.NONCE,
    ],
    ['a bytes32 nonce without 0x', inputFor(v1, { nonce: NONCE_HEX }), REFUSALS.NONCE],
    ['a 31-byte nonce', inputFor(v2, { nonce: BYTES32_NONCE.slice(0, -2) }), REFUSALS.NONCE],
    ["Permit2's nonce for EIP-3009", inputFor(v2, { nonce: PERMIT2_NONCE }), REFUSALS.NONCE],
    ["EIP-3009's nonce for Permit2", inputFor(permit2, { nonce: BYTES32_NONCE }), REFUSALS.NONCE],
    [
      'a Permit2 nonce with a leading zero',
      inputFor(permit2, { nonce: `0${PERMIT2_NONCE}` }),
      REFUSALS.NONCE,
    ],
    [
      'a Permit2 nonce of 2^256',
      inputFor(permit2, { nonce: (2n ** 256n).toString() }),
      REFUSALS.NONCE,
    ],
    ['a Permit2 nonce of 79 digits', inputFor(permit2, { nonce: '1'.repeat(79) }), REFUSALS.NONCE],
    ['a Permit2 nonce as a number', inputFor(permit2, { nonce: 5 }), REFUSALS.NONCE],
    ['no nonce', inputFor(v2, { nonce: null }), REFUSALS.NONCE],
  ])('%s', (_name, input, reason) => {
    expect(rebuildLedgerAuthorization(input)).toEqual({ ok: false, reason });
    expect(checkLedgerAuthorization(input && { ...input, authorization: {} })).toEqual({
      accepted: false,
      reason,
    });
  });

  test("Permit2's nonce bounds: 0 and 2^256 - 1", () => {
    for (const nonce of ['0', (2n ** 256n - 1n).toString()]) {
      expect(rebuilt(inputFor(permit2, { nonce })).typedData.message.nonce).toBe(nonce);
    }
  });

  test('no member an entry inherits is read', () => {
    const extra = Object.assign(Object.create({ name: 'USD Coin', version: '2' }), {});
    expect(rebuildLedgerAuthorization(withAccept(v2, { ...V2_EIP3009, extra }))).toEqual({
      ok: false,
      reason: REFUSALS.DOMAIN,
    });
  });
});

describe("checkLedgerAuthorization: the core typed data against main's rebuild, as JSON values", () => {
  test.each(FORM_CASES)(
    "$form: the core typed data, members in any order, gives main's own copy",
    (c) => {
      const authorization = reversedMembers(clone(rebuilt(inputFor(c)).typedData));
      const result = checkLedgerAuthorization({ ...inputFor(c), authorization });
      expect(result.accepted).toBe(true);
      expect(result.form).toBe(c.form);
      expect(result.typedData).toEqual(authorization);
      expect(result.typedData).not.toBe(authorization);
      expect(Object.isFrozen(result.typedData.message)).toBe(true);
      // As sign-flow will read the nonce: from the core's own typed data.
      expect(nonceOf(authorization)).toBe(formNonce(c.form));
      expect(
        checkLedgerAuthorization({
          ...inputFor(c, { nonce: nonceOf(authorization) }),
          authorization,
        }).accepted
      ).toBe(true);
    }
  );

  // The other form's schema for the same accept entry: each form's honest
  // typed data presented for each other form's entry.
  const PAIRS = FORM_CASES.flatMap((c) =>
    FORM_CASES.filter((other) => other !== c).map((other) => [c.form, other.form, c, other])
  );
  test.each(PAIRS)("%s's entry refuses %s's schema", (_form, _other, c, other) => {
    const authorization = clone(rebuilt(inputFor(other)).typedData);
    expect(checkLedgerAuthorization({ ...inputFor(c), authorization })).toEqual({
      accepted: false,
      reason: REFUSALS.MISMATCH,
    });
    // Its nonce read from it, as sign-flow will: refused all the same.
    const read = checkLedgerAuthorization({
      ...inputFor(c, { nonce: nonceOf(authorization) }),
      authorization,
    });
    expect(read.accepted).toBe(false);
    expect([REFUSALS.MISMATCH, REFUSALS.NONCE]).toContain(read.reason);
  });

  const [v2, , permit2] = FORM_CASES;
  const changed = (c, change) => {
    const typedData = clone(rebuilt(inputFor(c)).typedData);
    change(typedData);
    return typedData;
  };
  test.each([
    [
      'EIP712Domain in the types',
      v2,
      (t) => {
        t.types.EIP712Domain = [{ name: 'name', type: 'string' }];
      },
    ],
    [
      'the chain as text',
      v2,
      (t) => {
        t.domain.chainId = '8453';
      },
    ],
    [
      'the chain one more',
      permit2,
      (t) => {
        t.domain.chainId += 1;
      },
    ],
    [
      'a salt in the domain',
      v2,
      (t) => {
        t.domain.salt = `0x${'00'.repeat(32)}`;
      },
    ],
    [
      'a member added at the top',
      v2,
      (t) => {
        t.extra = 1;
      },
    ],
    [
      'a member added to the message',
      permit2,
      (t) => {
        t.message.permitted.extra = '1';
      },
    ],
    [
      'a member dropped from the message',
      v2,
      (t) => {
        delete t.message.validAfter;
      },
    ],
    [
      'a member set to undefined',
      v2,
      (t) => {
        t.message.validAfter = undefined;
      },
    ],
    [
      'the type fields swapped',
      v2,
      (t) => {
        const f = t.types.TransferWithAuthorization;
        [f[0], f[1]] = [f[1], f[0]];
      },
    ],
    [
      'a type field with another member',
      permit2,
      (t) => {
        t.types.Witness[0].extra = 'x';
      },
    ],
    [
      'the value as a number',
      v2,
      (t) => {
        t.message.value = 10000;
      },
    ],
    [
      'the deadline as a number',
      permit2,
      (t) => {
        t.message.deadline = 1762000060;
      },
    ],
    [
      'the nonce in uppercase',
      v2,
      (t) => {
        t.message.nonce = t.message.nonce.toUpperCase().replace('0X', '0x');
      },
    ],
    [
      'the recipient in lowercase',
      v2,
      (t) => {
        t.message.to = t.message.to.toLowerCase();
      },
    ],
    [
      'the spender in lowercase',
      permit2,
      (t) => {
        t.message.spender = t.message.spender.toLowerCase();
      },
    ],
    [
      'a time one second later',
      v2,
      (t) => {
        t.message.validBefore = '1762000061';
      },
    ],
    [
      'an array for the message',
      v2,
      (t) => {
        t.message = Object.values(t.message);
      },
    ],
  ])('refuses %s', (_name, c, change) => {
    expect(checkLedgerAuthorization({ ...inputFor(c), authorization: changed(c, change) })).toEqual(
      {
        accepted: false,
        reason: REFUSALS.MISMATCH,
      }
    );
  });

  test.each([
    ['nothing', undefined],
    ['null', null],
    ['an array', []],
    ['an empty object', {}],
    ['its JSON text', JSON.stringify(rebuilt(inputFor(v2)).typedData)],
    ['an object with a __proto__ member', JSON.parse('{"__proto__": {"domain": {}}}')],
  ])('refuses %s for the authorization', (_name, authorization) => {
    expect(checkLedgerAuthorization({ ...inputFor(v2), authorization })).toEqual({
      accepted: false,
      reason: REFUSALS.MISMATCH,
    });
  });
});

describe('nonceOf and sameJson', () => {
  test("nonceOf reads only the message's own nonce text", () => {
    expect(nonceOf({ message: { nonce: BYTES32_NONCE } })).toBe(BYTES32_NONCE);
    expect(nonceOf({ message: { nonce: 5 } })).toBe(null);
    expect(nonceOf({ message: {} })).toBe(null);
    expect(nonceOf({ message: Object.create({ nonce: BYTES32_NONCE }) })).toBe(null);
    expect(nonceOf({ message: [BYTES32_NONCE] })).toBe(null);
    expect(nonceOf(null)).toBe(null);
    expect(nonceOf(undefined)).toBe(null);
    expect(nonceOf(JSON.stringify({ message: { nonce: BYTES32_NONCE } }))).toBe(null);
  });

  test('sameJson: members in any order, arrays in order, no coercion', () => {
    expect(
      sameJson(
        { a: [1, 'x', null, true], b: { c: '1' } },
        { b: { c: '1' }, a: [1, 'x', null, true] }
      )
    ).toBe(true);
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameJson({ a: 1 }, { a: '1' })).toBe(false);
    expect(sameJson({ a: '1' }, { a: 1 })).toBe(false);
    expect(sameJson({ a: null }, { a: undefined })).toBe(false);
    expect(sameJson({ a: null }, {})).toBe(false);
    expect(sameJson({}, { a: undefined })).toBe(false);
    expect(sameJson({ a: {} }, { a: [] })).toBe(false);
    expect(sameJson({ a: [] }, { a: {} })).toBe(false);
    expect(sameJson({ a: true }, { a: 1 })).toBe(false);
    expect(sameJson({ a: {} }, { a: new Date(0) })).toBe(false);
    expect(sameJson([1], { 0: 1, length: 1 })).toBe(false);
  });
});
