const { Interface } = require('ethers');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const { normalizeRailgunRelayUnsignedIntent } = require('./railgun-relay-intent');
const { matchRailgunRelayProvedTransaction: match } = require('./railgun-relay-transaction');
const {
  createRailgunRelayUnsignedData,
} = require('../../../scripts/fixtures/railgun-relay-unsigned-data');
const abi = new Interface([TRANSACT_ABI]);
const BASE = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const hex = (value) => '0x' + BigInt(value).toString(16).padStart(64, '0');
const refused = expect.objectContaining({ code: 'RAILGUN_RELAY_TRANSACTION_REFUSED' });
function fixture() {
  const source = createRailgunRelayUnsignedData();
  const intent = source.build();
  // Public dummy coordinates exercise binding only, never real verification.
  source.inner.proof = {
    a: { x: 1n, y: 2n },
    b: { x: [3n, 4n], y: [5n, 6n] },
    c: { x: 7n, y: 8n },
  };
  return {
    ...source,
    intent,
    transaction: () => ({
      ...intent.transaction,
      data: abi.encodeFunctionData('transact', [[source.inner]]),
    }),
  };
}
test('only proof bytes may change; output is detached and grants no verification', () => {
  const f = fixture(),
    transaction = f.transaction(),
    result = match(f.intent, transaction);
  expect(result).toEqual({
    transaction,
    intentDigest: normalizeRailgunRelayUnsignedIntent(f.intent).digest,
    expectedHash: f.intent.expectedHash,
    proofVerified: false,
  });
  expect(Object.isFrozen(result.transaction)).toBe(true);
  transaction.value = '1';
  expect(result.transaction.value).toBe('0');
  // Even zero coordinates may match structurally; actual C verification is required.
  expect(match(f.intent, f.intent.transaction).proofVerified).toBe(false);
});
test('coordinates use the curve base field, not the smaller scalar field', () => {
  const f = fixture();
  f.inner.proof.a.x = BASE - 1n;
  expect(match(f.intent, f.transaction()).proofVerified).toBe(false);
  f.inner.proof.a.x = BASE;
  expect(() => match(f.intent, f.transaction())).toThrow(refused);
});
test('refuses dirty high bits that the ABI decoder masks from a narrow integer', () => {
  const f = fixture(),
    transaction = f.transaction(),
    bytes = Buffer.from(transaction.data.slice(2), 'hex');
  const offset = (position) =>
    Number(BigInt('0x' + bytes.subarray(position, position + 32).toString('hex')));
  const array = 4 + offset(4),
    tuple = array + 32 + offset(array + 32),
    bound = tuple + offset(tuple + 11 * 32);
  // proof occupies eight words, followed by root and the three dynamic offsets.
  bytes[bound] = 0x80;
  transaction.data = '0x' + bytes.toString('hex');
  const [[decoded]] = abi.decodeFunctionData('transact', transaction.data);
  expect(decoded.boundParams.treeNumber).toBe(0n);
  expect(transaction.data.length).toBe(f.intent.transaction.data.length);
  expect(() => match(f.intent, transaction)).toThrow(refused);
});
test.each([
  [
    'root',
    (f) => {
      f.inner.merkleRoot = hex(99);
    },
  ],
  [
    'nullifier',
    (f) => {
      f.inner.nullifiers[0] = hex(99);
    },
  ],
  [
    'fee output',
    (f) => {
      f.inner.commitments[0] = hex(99);
    },
  ],
  [
    'self output',
    (f) => {
      f.inner.commitments[1] = hex(99);
    },
  ],
  [
    'output order',
    (f) => {
      f.inner.commitments.reverse();
    },
  ],
  [
    'tree',
    (f) => {
      f.bound.treeNumber = 1;
    },
  ],
  [
    'minimum gas',
    (f) => {
      f.bound.minGasPrice = 2;
    },
  ],
  [
    'chain',
    (f) => {
      f.bound.chainID = 1;
    },
  ],
  [
    'adapt address',
    (f) => {
      f.bound.adaptContract = '0x' + '1'.repeat(40);
    },
  ],
  [
    'adapt parameters',
    (f) => {
      f.bound.adaptParams = hex(1);
    },
  ],
  [
    'ciphertext',
    (f) => {
      f.bound.commitmentCiphertext[0].ciphertext[0] = hex(99);
    },
  ],
  [
    'annotation',
    (f) => {
      f.bound.commitmentCiphertext[1].annotationData = '0x2233';
    },
  ],
  [
    'sender key',
    (f) => {
      f.bound.commitmentCiphertext[0].blindedSenderViewingKey = hex(99);
    },
  ],
  [
    'receiver key',
    (f) => {
      f.bound.commitmentCiphertext[1].blindedReceiverViewingKey = hex(99);
    },
  ],
  [
    'unshield value',
    (f) => {
      f.inner.unshieldPreimage.value = 1;
    },
  ],
  [
    'unshield token',
    (f) => {
      f.inner.unshieldPreimage.token.tokenAddress = '0x' + '2'.repeat(40);
    },
  ],
])('refuses changed %s even with unchanged calldata length', (_name, mutate) => {
  const f = fixture();
  mutate(f);
  const transaction = f.transaction();
  expect(transaction.data.length).toBe(f.intent.transaction.data.length);
  expect(() => match(f.intent, transaction)).toThrow(refused);
});
test.each(['chainId', 'to', 'value', 'data'])('refuses outer %s substitution', (key) => {
  const f = fixture(),
    transaction = f.transaction();
  transaction[key] = key === 'chainId' ? 1 : key === 'data' ? transaction.data + '00' : 'bad';
  expect(() => match(f.intent, transaction)).toThrow(refused);
});
test('refuses getters, proxy traps and caller authority fields without evaluating them', () => {
  const f = fixture(),
    getter = jest.fn();
  const transaction = f.transaction();
  Object.defineProperty(transaction, 'value', { enumerable: true, get: getter });
  expect(() => match(f.intent, transaction)).toThrow(refused);
  expect(getter).not.toHaveBeenCalled();
  const trap = jest.fn();
  expect(() => match(f.intent, new Proxy(f.transaction(), { getPrototypeOf: trap }))).toThrow(
    refused
  );
  expect(trap).not.toHaveBeenCalled();
  expect(() => match(f.intent, { ...f.transaction(), proofVerified: true })).toThrow(refused);
});
test('refuses a signed/nonzero-proof source and a different original intent', () => {
  const f = fixture();
  expect(() => match({ ...f.intent, transaction: f.transaction() }, f.transaction())).toThrow(
    refused
  );
  const other = createRailgunRelayUnsignedData();
  other.inner.merkleRoot = hex(98);
  other.expected.merkleRoot = hex(98);
  const otherIntent = other.build();
  expect(normalizeRailgunRelayUnsignedIntent(otherIntent).data).toEqual(otherIntent);
  expect(() => match(otherIntent, f.transaction())).toThrow(refused);
});
