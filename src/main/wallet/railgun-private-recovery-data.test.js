const {
  normalizeRailgunPrivateRecoveryInput: input,
  normalizeRailgunPrivateRecoveryResult: result,
} = require('./railgun-private-recovery-data');
const {
  createRailgunPartialCapsuleData,
  createRailgunLegacyCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
const { matchRailgunPrivateProvedTransaction } = require('./railgun-private-intent');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
function fixture(kind = 'railgun-token-unshield') {
  const f =
    kind === 'railgun-partial-unshield'
      ? createRailgunPartialCapsuleData()
      : createRailgunLegacyCapsuleData(kind);
  f.owned.read.received[0].hash = f.capsule.noteHash;
  Object.assign(f.owned.ownedPoi[0], { hash: f.capsule.noteHash, type: 'Shield' });
  // Structural test proof only, never cryptographic validity.
  f.inner.proof = { a: { x: 1, y: 2 }, b: { x: [3, 4], y: [5, 6] }, c: { x: 7, y: 8 } };
  const transaction = { ...f.capsule.preparation.transaction, data: f.encode() };
  const proof = {
    status: 'proved',
    transaction,
    transactionDigest: matchRailgunPrivateProvedTransaction(
      f.capsule.preparation.transaction,
      transaction,
      f.capsule.preparation.expected
    ).digest,
    independentlyVerified: false,
  };
  return {
    ...f,
    proof,
    privateRecovery: {
      capsule: f.capsule,
      signature: { R8: [hex(1), hex(2)], S: hex(3) },
      proverArchive: '/prover.asar',
      artifactDirectory: '/artifacts',
    },
    context: { ...f.owned, capsule: f.capsule, walletId: f.capsule.walletId },
  };
}
test.each(
  ['railgun-private-transfer', 'railgun-token-unshield', 'railgun-partial-unshield'].flatMap(
    (kind) => ['Shield', 'Transact'].map((source) => [kind, source])
  )
)('%s from %s preserves original signed root while binding the current note', (kind, source) => {
  const f = fixture(kind);
  f.owned.ownedPoi[0].type = source;
  f.owned.trees[0].root = hex(1234);
  const normalized = input(f.privateRecovery, { walletId: f.capsule.walletId });
  expect(normalized).toEqual(f.privateRecovery);
  expect(Object.isFrozen(normalized.capsule.pathElements)).toBe(true);
  expect(Object.isFrozen(normalized.signature.R8)).toBe(true);
  expect(result(f.proof, f.context)).toEqual(f.proof);
  expect(normalized.capsule.preparation.expected.merkleRoot).toBe(hex(1));
  f.privateRecovery.signature.R8[0] = hex(9);
  expect(normalized.signature.R8[0]).toBe(hex(1));
});
test.each([
  'wallet',
  'missing-note',
  'duplicate-note',
  'spent',
  'hash',
  'owned-hash',
  'nullifier',
  'amount',
  'token',
  'position',
  'missing-tree',
  'duplicate-tree',
  'claimed-verification',
  'refused',
  'digest',
  'ciphertext',
  'signature-shape',
  'unknown-option',
])('refuses %s substitution', (mode) => {
  const f = fixture('railgun-partial-unshield');
  if (mode === 'wallet') f.context.walletId = '2'.repeat(64);
  if (mode === 'missing-note') f.owned.read.received = [];
  if (mode === 'duplicate-note') f.owned.read.received.push({ ...f.owned.read.received[0] });
  if (mode === 'spent') f.owned.read.received[0].spentTxid = hex(9);
  if (mode === 'hash') f.owned.read.received[0].hash = hex(9);
  if (mode === 'owned-hash') f.owned.ownedPoi[0].hash = hex(9);
  if (mode === 'nullifier') f.owned.ownedPoi[0].nullifier = hex(9);
  if (mode === 'amount') f.owned.read.received[0].amount = 1001n;
  if (mode === 'token') f.owned.read.received[0].asset.contract = '0x' + '12'.repeat(20);
  if (mode === 'position') f.owned.trees[0].length = 1;
  if (mode === 'missing-tree') f.context.trees = [];
  if (mode === 'duplicate-tree') f.owned.trees.push({ ...f.owned.trees[0] });
  if (mode === 'claimed-verification') f.proof.independentlyVerified = true;
  if (mode === 'refused') f.proof = { status: 'refused' };
  if (mode === 'digest') f.proof.transactionDigest = '0'.repeat(64);
  if (mode === 'ciphertext') {
    f.inner.boundParams.commitmentCiphertext[0].memo = '0x11';
    f.proof.transaction.data = f.encode();
  }
  if (mode === 'signature-shape') f.privateRecovery.signature.extra = true;
  if (mode === 'unknown-option') f.privateRecovery.signAgain = true;
  if (['signature-shape', 'unknown-option'].includes(mode))
    expect(() => input(f.privateRecovery, { walletId: f.capsule.walletId })).toThrow();
  else expect(() => result(f.proof, f.context)).toThrow();
});
test.each(['getter', 'proxy', 'symbol', 'array-property'])(
  'input %s never invokes a getter or accepts hidden state',
  (mode) => {
    const f = fixture(),
      accessed = jest.fn();
    if (mode === 'getter')
      Object.defineProperty(f.privateRecovery.signature, 'S', { get: accessed });
    if (mode === 'proxy') f.privateRecovery = new Proxy(f.privateRecovery, { get: accessed });
    if (mode === 'symbol') f.privateRecovery[Symbol('extra')] = true;
    if (mode === 'array-property') f.privateRecovery.signature.R8.extra = true;
    expect(() => input(f.privateRecovery, { walletId: f.capsule.walletId })).toThrow();
    expect(accessed).not.toHaveBeenCalled();
  }
);
