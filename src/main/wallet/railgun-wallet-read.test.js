const { keccak256, concat, toBeHex } = require('ethers');
const { normalizeRailgunWalletRead: normalize } = require('./railgun-wallet-read');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const contract = '0x' + '1'.repeat(40);
function fixture(type = 0) {
  const tokenData = {
    tokenType: type,
    tokenAddress: contract,
    tokenSubID: toBeHex(type ? 42 : 0, 32),
  };
  const tokenHash =
    type === 0
      ? toBeHex(BigInt(contract), 32)
      : toBeHex(
          BigInt(
            keccak256(
              concat([toBeHex(type, 32), toBeHex(BigInt(contract), 32), tokenData.tokenSubID])
            )
          ) % FIELD,
          32
        );
  const note = {
    tree: 0,
    position: 0,
    txid: '0x' + '2'.repeat(64),
    hash: toBeHex(123, 32),
    tokenHash,
    tokenData,
    value: type === 1 ? '1' : '1000',
    spentTxid: false,
    memoText: 'must not leave the runtime',
    random: 'must not leave the runtime',
  };
  return {
    result: { instanceId: '0zk1' + 'q'.repeat(123), received: [note], sent: [] },
    coverage: { expectedReceived: [{ tree: 0, position: 0 }], expectedSent: [] },
  };
}
test.each([0, 1, 2])(
  'validates token type %s and copies only bounded immutable read data',
  (type) => {
    const { result, coverage } = fixture(type),
      read = normalize(result, coverage);
    expect(read.received[0].asset.__type).toBe(['erc20', 'erc721', 'erc1155'][type]);
    expect(read.received[0].amount).toBe(type === 1 ? 1n : 1000n);
    expect(read.received[0].memoText).toBeUndefined();
    expect(read.received[0].random).toBeUndefined();
    expect(Object.isFrozen(read.received[0].asset)).toBe(true);
    result.received[0].value = '999';
    expect(read.received[0].amount).toBe(type === 1 ? 1n : 1000n);
  }
);
test.each([
  'missing',
  'duplicate',
  'position',
  'negative',
  'overflow',
  'noncanonical',
  'token',
  'sub-id',
  'hash',
  'spent',
  'instance',
])('rejects %s projection', (mode) => {
  const { result, coverage } = fixture(),
    note = result.received[0];
  if (mode === 'missing') result.received = [];
  if (mode === 'duplicate') result.received.push(note);
  if (mode === 'position') note.position = 1;
  if (mode === 'negative') note.value = '-1';
  if (mode === 'overflow') note.value = (1n << 120n).toString();
  if (mode === 'noncanonical') note.value = '01';
  if (mode === 'token') note.tokenData.tokenAddress = '0x' + '3'.repeat(40);
  if (mode === 'sub-id') note.tokenData.tokenSubID = toBeHex(1, 32);
  if (mode === 'hash') note.hash = toBeHex(FIELD, 32);
  if (mode === 'spent') note.spentTxid = null;
  if (mode === 'instance') result.instanceId = '0x' + '1'.repeat(40);
  expect(() => normalize(result, coverage)).toThrow();
});
test('requires the same token and commitment projection for self-transfers', () => {
  const { result, coverage } = fixture();
  result.sent = [{ ...result.received[0] }];
  coverage.expectedSent = [...coverage.expectedReceived];
  expect(normalize(result, coverage).sent).toHaveLength(1);
  result.sent[0].value = '999';
  expect(() => normalize(result, coverage)).toThrow();
});
test('ERC721 quantities other than one are refused', () => {
  const { result, coverage } = fixture(1);
  result.received[0].value = '2';
  expect(() => normalize(result, coverage)).toThrow();
});

test('accepts the largest protocol uint120 value without numeric rounding', () => {
  const { result, coverage } = fixture();
  const maximum = (1n << 120n) - 1n;
  result.received[0].value = maximum.toString();
  expect(normalize(result, coverage).received[0].amount).toBe(maximum);
});
