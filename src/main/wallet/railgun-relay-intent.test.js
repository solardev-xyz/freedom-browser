const { AbiCoder, Interface, keccak256 } = require('ethers');
const {
  TRANSACT_ABI,
  BOUND_PARAMS,
  validateRailgunPrivateTransaction,
} = require('./railgun-private-policy');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const ZERO = '0x' + '0'.repeat(40),
  abi = new Interface([TRANSACT_ABI]);
function fixture() {
  const peer = '0zk1' + 'q'.repeat(123),
    self = '0zk1' + 'p'.repeat(123);
  const fields = {
    fees: { [pins.wrappedNative]: '0xde0b6b3a7640000' },
    feeExpiration: 1,
    feesID: 'unsigned-test',
    railgunAddress: peer,
    availableWallets: 1,
    version: '8.0.0',
    relayAdapt: pins.relayAdapt,
    requiredPOIListKeys: [],
    reliability: -1,
  };
  const context = {
    walletId: '11'.repeat(32),
    self: { address: self, masterPublicKey: '7', viewingPublicKey: '02'.repeat(32) },
    peer: { address: peer, masterPublicKey: '8', viewingPublicKey: '03'.repeat(32) },
    quote: {
      data: Buffer.from(JSON.stringify(fields)).toString('hex'),
      signature: '04'.repeat(64),
    },
    gas: { transactionType: 0, gasEstimate: '84', gasPrice: '1', minGasPrice: '1' },
    inputAmount: '700',
    feeAmount: '100',
    selfAmount: '600',
    feeCap: '100',
  };
  const cipher = (n) => ({
    ciphertext: [hex(n), hex(n + 1), hex(n + 2), hex(n + 3)],
    blindedSenderViewingKey: hex(n + 4),
    blindedReceiverViewingKey: hex(n + 5),
    annotationData: '0x1122',
    memo: '0x',
  });
  const bound = {
    treeNumber: 0,
    minGasPrice: 1,
    unshield: 0,
    chainID: pins.chainId,
    adaptContract: ZERO,
    adaptParams: hex(0),
    commitmentCiphertext: [cipher(10), cipher(20)],
  };
  const inner = {
    proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } },
    merkleRoot: hex(7),
    nullifiers: [hex(8)],
    commitments: [hex(9), hex(10)],
    boundParams: bound,
    unshieldPreimage: {
      npk: hex(0),
      token: { tokenType: 0, tokenAddress: ZERO, tokenSubID: 0 },
      value: 0,
    },
  };
  const expected = {
    kind: 'railgun-relay-self-transfer',
    tree: 0,
    merkleRoot: hex(7),
    nullifier: hex(8),
    feeCommitment: hex(9),
    selfCommitment: hex(10),
    boundParamsHash: '',
  };
  const build = () => {
    expected.boundParamsHash = hex(
      BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bound]))) % FIELD
    );
    return {
      transaction: {
        chainId: pins.chainId,
        to: pins.proxy,
        value: '0',
        data: abi.encodeFunctionData('transact', [[inner]]),
      },
      expected: { ...expected },
      expectedHash: hex(11),
      context: JSON.parse(JSON.stringify(context)),
    };
  };
  return { context, inner, bound, expected, build };
}

const { normalizeRailgunRelayUnsignedIntent: normalize } = require('./railgun-relay-intent');
const refused = { code: 'RAILGUN_RELAY_UNSIGNED_DATA_REFUSED' };
test('canonical data is detached, reproducible and explicitly unreviewed/unauthenticated', () => {
  const input = fixture().build(),
    result = normalize(input);
  expect(result.data).toEqual(input);
  expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(normalize(result.data)).toEqual(result);
  for (const [key, value] of Object.entries(result))
    if (!['data', 'digest'].includes(key)) expect(value).toBe(false);
  expect(Object.isFrozen(input.context.self)).toBe(false);
  input.context.self.masterPublicKey = '9';
  input.expected.tree = 9;
  expect(input.context.self.masterPublicKey).toBe('9');
  expect(result.data.context.self.masterPublicKey).toBe('7');
  expect(result.data.expected.tree).toBe(0);
  expect(Object.isFrozen(result.data.context.quote)).toBe(true);
  expect(() =>
    validateRailgunPrivateTransaction(result.data.transaction, result.data.expected)
  ).toThrow();
  expect(() =>
    require('./railgun-private-intent').validateRailgunPrivateSigningIntent(
      result.data.transaction,
      result.data.expected
    )
  ).toThrow();
});
test.each([
  [
    'proof',
    (f) => {
      f.inner.proof.a.x = 1;
    },
  ],
  [
    'root',
    (f) => {
      f.inner.merkleRoot = hex(22);
    },
  ],
  [
    'nullifier',
    (f) => {
      f.inner.nullifiers = [hex(22)];
    },
  ],
  [
    'extra input',
    (f) => {
      f.inner.nullifiers.push(hex(22));
    },
  ],
  [
    'commitment order',
    (f) => {
      f.inner.commitments.reverse();
    },
  ],
  [
    'extra output',
    (f) => {
      f.inner.commitments.push(hex(22));
    },
  ],
  [
    'ciphertext count',
    (f) => {
      f.bound.commitmentCiphertext.pop();
    },
  ],
  [
    'adapt',
    (f) => {
      f.bound.adaptContract = pins.relayAdapt;
    },
  ],
  [
    'chain',
    (f) => {
      f.bound.chainID = 1;
    },
  ],
  [
    'tree',
    (f) => {
      f.bound.treeNumber = 1;
    },
  ],
  [
    'gas mismatch',
    (f) => {
      f.bound.minGasPrice = 2;
    },
  ],
  [
    'unshield',
    (f) => {
      f.bound.unshield = 1;
    },
  ],
  [
    'preimage',
    (f) => {
      f.inner.unshieldPreimage.value = 1;
    },
  ],
  [
    'memo',
    (f) => {
      f.bound.commitmentCiphertext[0].memo = '0x11';
    },
  ],
  [
    'missing annotation',
    (f) => {
      f.bound.commitmentCiphertext[0].annotationData = '0x';
    },
  ],
  [
    'oversize annotation',
    (f) => {
      f.bound.commitmentCiphertext[0].annotationData = '0x' + '11'.repeat(257);
    },
  ],
  [
    'empty blinded key',
    (f) => {
      f.bound.commitmentCiphertext[0].blindedReceiverViewingKey = hex(0);
    },
  ],
])('refuses %s even after recomputing bound hash', (_name, change) => {
  const f = fixture();
  change(f);
  expect(() => normalize(f.build())).toThrow(expect.objectContaining(refused));
});
test.each([
  [
    'cap',
    (v) => {
      v.context.feeCap = '99';
    },
  ],
  [
    'fee',
    (v) => {
      v.context.feeAmount = '99';
      v.context.selfAmount = '601';
    },
  ],
  [
    'conservation',
    (v) => {
      v.context.selfAmount = '601';
    },
  ],
  [
    'zero remainder',
    (v) => {
      v.context.selfAmount = '0';
    },
  ],
  [
    'maximum',
    (v) => {
      v.context.inputAmount = '10000000000000001';
    },
  ],
  [
    'noncanonical decimal',
    (v) => {
      v.context.inputAmount = '0700';
    },
  ],
  [
    'quote peer',
    (v) => {
      v.context.peer.address = v.context.self.address;
    },
  ],
  [
    'expected hash field',
    (v) => {
      v.expectedHash = hex(FIELD);
    },
  ],
  [
    'expected hash spelling',
    (v) => {
      v.expectedHash = '0x1';
    },
  ],
  [
    'old kind',
    (v) => {
      v.expected.kind = 'railgun-private-transfer';
    },
  ],
  [
    'extra authority',
    (v) => {
      v.signingEnabled = true;
    },
  ],
  [
    'trailing calldata',
    (v) => {
      v.transaction.data += '00';
    },
  ],
  [
    'calldata case',
    (v) => {
      v.transaction.data = v.transaction.data.toUpperCase();
    },
  ],
  [
    'wrong selector',
    (v) => {
      v.transaction.data = '0x00000000' + v.transaction.data.slice(10);
    },
  ],
])('refuses malformed contextual %s', (_name, change) => {
  const v = fixture().build();
  change(v);
  expect(() => normalize(v)).toThrow(expect.objectContaining(refused));
});
test('uint48 maximum matches deployed uint72 encoding, next value refuses', () => {
  const f = fixture(),
    max = (1n << 48n) - 1n;
  f.context.gas = {
    transactionType: 0,
    gasEstimate: '1',
    gasPrice: String(max),
    minGasPrice: String(max),
  };
  f.context.inputAmount = '10000000000000000';
  f.context.feeAmount = String(max);
  f.context.feeCap = String(max);
  f.context.selfAmount = String(10000000000000000n - max);
  f.bound.minGasPrice = max;
  expect(normalize(f.build()).data.context.gas.minGasPrice).toBe(String(max));
  f.context.gas.gasPrice = String(max + 1n);
  f.context.gas.minGasPrice = String(max + 1n);
  f.bound.minGasPrice = max + 1n;
  expect(() => normalize(f.build())).toThrow(expect.objectContaining(refused));
});
test('bound ciphertext mutation requires recomputed hash; structural validity is not decryption', () => {
  const f = fixture(),
    before = f.build();
  f.bound.commitmentCiphertext.reverse();
  const changed = f.build();
  expect(() => normalize({ ...changed, expected: before.expected })).toThrow();
  expect(normalize(changed).digest).not.toBe(normalize(before).digest);
  expect(normalize(changed).recipientsVerified).toBe(false);
});
test.each(['quote', 'identity', 'expectedHash'])(
  'changed unverified %s is digest-bound, never authenticated',
  (kind) => {
    const input = fixture().build(),
      first = normalize(input);
    if (kind === 'quote') input.context.quote.signature = '05'.repeat(64);
    if (kind === 'identity') input.context.peer.masterPublicKey = '9';
    if (kind === 'expectedHash') input.expectedHash = hex(12);
    const next = normalize(input);
    expect(next.digest).not.toBe(first.digest);
    expect(next.signatureVerified).toBe(false);
    expect(next.identityAuthenticated).toBe(false);
    expect(next.expectedHashVerified).toBe(false);
  }
);
test('rejects proxy/accessor/prototype/symbol inputs without invoking caller code or leaking it', () => {
  let calls = 0;
  const input = fixture().build();
  const proxy = new Proxy(input, {
    getPrototypeOf() {
      calls++;
      throw Error('secret');
    },
    ownKeys() {
      calls++;
      throw Error('secret');
    },
    get() {
      calls++;
      throw Error('secret');
    },
  });
  expect(() => normalize(proxy)).toThrow(expect.objectContaining(refused));
  expect(calls).toBe(0);
  Object.defineProperty(input.context.peer, 'masterPublicKey', {
    enumerable: true,
    get() {
      calls++;
      return '7';
    },
  });
  expect(() => normalize(input)).toThrow(expect.objectContaining(refused));
  expect(calls).toBe(0);
  const other = fixture().build();
  Object.setPrototypeOf(other.expected, null);
  expect(() => normalize(other)).toThrow();
  const symbol = fixture().build();
  symbol.context[Symbol('hidden')] = 1;
  expect(() => normalize(symbol)).toThrow();
});

test('context entry detaches and freezes all inputs before any later await', () => {
  const { normalizeRailgunRelayUnsignedContext: context } = require('./railgun-relay-intent');
  const input = fixture().context;
  const result = context(input);
  expect(result).toEqual(input);
  expect(context(result)).toEqual(result);
  expect(Object.isFrozen(input.self)).toBe(false);
  input.self.masterPublicKey = '9';
  input.gas.gasEstimate = '1';
  input.quote.signature = 'ff'.repeat(64);
  expect(input.self.masterPublicKey).toBe('9');
  expect(input.gas.gasEstimate).toBe('1');
  expect(input.quote.signature).toBe('ff'.repeat(64));
  expect(result.self.masterPublicKey).toBe('7');
  expect(result.gas.gasEstimate).toBe('84');
  expect(result.quote.signature).toBe('04'.repeat(64));
  for (const value of [result, result.self, result.peer, result.gas, result.quote])
    expect(Object.isFrozen(value)).toBe(true);
  expect(Object.keys(result).sort()).toEqual(
    [
      'walletId',
      'self',
      'peer',
      'quote',
      'gas',
      'inputAmount',
      'feeAmount',
      'selfAmount',
      'feeCap',
    ].sort()
  );
});
test('context entry refuses proxies, accessors and unknown fields without invoking code', () => {
  const { normalizeRailgunRelayUnsignedContext: context } = require('./railgun-relay-intent');
  let calls = 0;
  const input = fixture().context;
  const proxy = new Proxy(input, {
    getPrototypeOf() {
      calls++;
      return Object.prototype;
    },
    get() {
      calls++;
    },
  });
  expect(() => context(proxy)).toThrow(expect.objectContaining(refused));
  const accessor = fixture().context;
  Object.defineProperty(accessor.self, 'masterPublicKey', {
    enumerable: true,
    get() {
      calls++;
      return '7';
    },
  });
  expect(() => context(accessor)).toThrow(expect.objectContaining(refused));
  expect(calls).toBe(0);
  const extra = fixture().context;
  extra.reviewedPreparation = true;
  expect(() => context(extra)).toThrow(expect.objectContaining(refused));
});
