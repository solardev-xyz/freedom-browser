const { AbiCoder, Interface, keccak256 } = require('ethers');
const { TRANSACT_ABI, BOUND_PARAMS } = require('./railgun-private-policy');
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

const {
  normalizeRailgunRelayDraftCapsule: normalize,
  digestRailgunRelayDraftCapsule: digest,
} = require('./railgun-relay-capsule');
function draft() {
  return {
    schema: 'railgun-relay-unsigned-draft-v1',
    walletId: '11'.repeat(32),
    engineSha256: '22'.repeat(32),
    selection: { tree: 0, position: 7 },
    noteHash: hex(12),
    pathElements: Array.from({ length: 16 }, (_, i) => hex(i + 1)),
    intent: fixture().build(),
  };
}
test('unpersisted detached draft has reproducible domain-separated digest and no grants', () => {
  const value = draft(),
    result = normalize(value);
  expect(normalize(result.data)).toEqual(result);
  expect(digest(value)).toBe(result.digest);
  expect(result.digest).not.toBe(
    require('./railgun-relay-intent').normalizeRailgunRelayUnsignedIntent(value.intent).digest
  );
  for (const [key, claim] of Object.entries(result))
    if (!['data', 'digest'].includes(key)) expect(claim).toBe(false);
  expect(Object.isFrozen(value.pathElements)).toBe(false);
  value.pathElements[0] = hex(33);
  value.intent.context.self.masterPublicKey = '9';
  expect(value.pathElements[0]).toBe(hex(33));
  expect(value.intent.context.self.masterPublicKey).toBe('9');
  expect(result.data.pathElements[0]).toBe(hex(1));
  expect(result.data.intent.context.self.masterPublicKey).toBe('7');
  expect(Object.isFrozen(result.data.pathElements)).toBe(true);
  expect(() =>
    require('./railgun-private-capsule').normalizeRailgunPrivateCapsule(result.data)
  ).toThrow();
});
test.each([
  [
    'version',
    (v) => {
      v.schema = 'railgun-private-capsule-v1';
    },
  ],
  [
    'wallet',
    (v) => {
      v.walletId = '33'.repeat(32);
    },
  ],
  [
    'tree',
    (v) => {
      v.selection.tree = 1;
    },
  ],
  [
    'position',
    (v) => {
      v.selection.position = 65536;
    },
  ],
  [
    'field',
    (v) => {
      v.noteHash = hex(FIELD);
    },
  ],
  [
    'path field',
    (v) => {
      v.pathElements[1] = hex(FIELD);
    },
  ],
  [
    'short path',
    (v) => {
      v.pathElements.pop();
    },
  ],
  [
    'hole',
    (v) => {
      delete v.pathElements[3];
    },
  ],
  [
    'extra array key',
    (v) => {
      v.pathElements.extra = 1;
    },
  ],
  [
    'extra secret',
    (v) => {
      v.witness = 'not accepted';
    },
  ],
  [
    'bad intent',
    (v) => {
      v.intent.context.feeAmount = '99';
    },
  ],
])('refuses %s', (_name, change) => {
  const value = draft();
  change(value);
  expect(() => normalize(value)).toThrow(
    expect.objectContaining({ code: 'RAILGUN_RELAY_DRAFT_CAPSULE_REFUSED' })
  );
});
test.each(['position', 'note', 'path', 'engine'])(
  'structural %s changes digest, not a membership/runtime-authentication claim',
  (kind) => {
    const value = draft(),
      before = digest(value);
    if (kind === 'position') value.selection.position++;
    if (kind === 'note') value.noteHash = hex(13);
    if (kind === 'path') value.pathElements[0] = hex(22);
    if (kind === 'engine') value.engineSha256 = '44'.repeat(32);
    const result = normalize(value);
    expect(result.digest).not.toBe(before);
    expect(result.merklePathVerified).toBe(false);
    expect(result.engineAuthenticated).toBe(false);
  }
);
test('path proxy/getter/custom prototype is rejected without invoking it', () => {
  let calls = 0;
  const value = draft();
  value.pathElements = new Proxy(value.pathElements, {
    get() {
      calls++;
      throw Error('secret');
    },
    ownKeys() {
      calls++;
      return [];
    },
  });
  expect(() => normalize(value)).toThrow();
  expect(calls).toBe(0);
  const getter = draft();
  Object.defineProperty(getter.pathElements, '0', {
    enumerable: true,
    get() {
      calls++;
      return hex(1);
    },
  });
  expect(() => normalize(getter)).toThrow();
  expect(calls).toBe(0);
  const custom = draft();
  Object.setPrototypeOf(custom.pathElements, Object.create(Array.prototype));
  expect(() => normalize(custom)).toThrow();
});
