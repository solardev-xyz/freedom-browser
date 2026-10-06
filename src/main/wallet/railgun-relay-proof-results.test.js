const {
  createRailgunRelayMainProofData,
} = require('../../../scripts/fixtures/railgun-relay-main-proof-data');
const data = require('./railgun-relay-proof-results');
// Canonical ABI and record decoders are real; proofs/signature are public
// synthetic values, not cryptographically verified by these main data tests.
test('signed result yields a detached canonical candidate without changing custody', () => {
  const f = createRailgunRelayMainProofData();
  const result = data.normalizeRailgunRelayProducedProof(f.proof, f.recordText);
  const text = data.createRailgunRelayReadyCandidate(f.recordText, f.proof);
  expect(JSON.parse(text).state).toBe('ready-local');
  expect(JSON.parse(text).signature).toEqual(f.record.signature);
  expect(f.record.state).toBe('signed');
  expect(Object.isFrozen(result.payload)).toBe(true);
  expect(
    data.normalizeRailgunRelayProofVerification(f.verification, f.recordText, f.proof)
  ).toEqual(f.verification);
  f.proof.transaction.data = '0x00';
  expect(result.transaction.data).not.toBe('0x00');
});
test.each([
  'recordDigest',
  'draftDigest',
  'historyDigest',
  'expectedHash',
  'transactionDigest',
  'payloadDigest',
  'locallyVerified',
  'independentlyVerified',
  'extra',
])('producer binding refuses altered %s', (key) => {
  const f = createRailgunRelayMainProofData();
  f.proof[key] = typeof f.proof[key] === 'boolean' ? !f.proof[key] : '0'.repeat(64);
  expect(() => data.normalizeRailgunRelayProducedProof(f.proof, f.recordText)).toThrow();
});
test.each([
  'engineSha256',
  'proverSha256',
  'transactionDigest',
  'payloadDigest',
  'recordDigest',
  'inputOwnershipVerified',
  'currentMembershipVerified',
  'authorityGranted',
  'transactionVerified',
  'prePoiVerified',
  'historicalEventSignatureVerified',
  'historicalMembershipPathVerified',
  'extra',
])('independent verification refuses altered %s', (key) => {
  const f = createRailgunRelayMainProofData();
  f.verification[key] =
    typeof f.verification[key] === 'boolean' ? !f.verification[key] : '0'.repeat(64);
  expect(() =>
    data.normalizeRailgunRelayProofVerification(f.verification, f.recordText, f.proof)
  ).toThrow();
});
test.each(['01x02', 'POI_3x3'])('C pins the exact %s verification key', (variant) => {
  const f = createRailgunRelayMainProofData();
  f.verification.artifactVkeys[variant] = '0'.repeat(64);
  expect(() =>
    data.normalizeRailgunRelayProofVerification(f.verification, f.recordText, f.proof)
  ).toThrow();
});
test('input state/cap/path and canonical bytes are bounded', () => {
  const f = createRailgunRelayMainProofData();
  expect(data.normalizeRailgunRelayProofInput(f.proofInput, f.record.walletId)).toEqual(
    f.proofInput
  );
  for (const changed of [
    { timeoutMs: 110001 },
    { timeoutMs: 0 },
    { artifactDirectory: 'relative' },
    { proverArchive: '/other.js' },
    { recordText: ' ' + f.recordText },
    { recordText: JSON.stringify({ ...f.record, state: 'held', signature: null }) },
  ])
    expect(() =>
      data.normalizeRailgunRelayProofInput({ ...f.proofInput, ...changed }, f.record.walletId)
    ).toThrow();
});
test('accessor/proxy nested input is refused without callbacks', () => {
  const f = createRailgunRelayMainProofData();
  let reads = 0;
  Object.defineProperty(f.proof.transaction, 'data', {
    get() {
      reads++;
      return '0x00';
    },
  });
  expect(() => data.normalizeRailgunRelayProducedProof(f.proof, f.recordText)).toThrow();
  expect(reads).toBe(0);
  f.proof.payload = new Proxy(f.proof.payload, {
    get() {
      reads++;
      throw Error('trap');
    },
  });
  expect(() => data.normalizeRailgunRelayProducedProof(f.proof, f.recordText)).toThrow();
  expect(reads).toBe(0);
});
