jest.mock('./railgun-private-intent', () => ({
  validateRailgunPrivateSigningIntent: jest.fn(),
  matchRailgunPrivateProvedTransaction: jest.fn(),
}));
const {
  validateRailgunPrivateSigningIntent,
  matchRailgunPrivateProvedTransaction,
} = require('./railgun-private-intent');
const {
  normalizeRailgunSpendSignature,
  normalizeRailgunSpendKeyRequest,
  normalizeRailgunPrivateVerification,
} = require('./railgun-private-results');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let signed, verified, payload;
beforeEach(() => {
  validateRailgunPrivateSigningIntent.mockReturnValue({ digest: hex(1) });
  matchRailgunPrivateProvedTransaction.mockReturnValue({ digest: hex(2) });
  payload = { transaction: {}, expected: {}, expectedHash: hex(3), intent: {} };
  const guards = { attempts: 0, canaries: 1, hooks: ['test.hook'] };
  signed = {
    signature: { R8: [hex(4), hex(5)], S: hex(6) },
    message: hex(3),
    transactionDigest: hex(1),
    guards,
    inventory: require('./railgun-engine-manifest.json').inventory.sha256,
  };
  verified = {
    verified: true,
    transactionDigest: hex(2),
    guards: structuredClone(guards),
    proverSha256: require('./railgun-prover-manifest.json').sha256,
  };
});
test('returns deeply frozen data copies without operation authority', () => {
  const a = normalizeRailgunSpendSignature(signed, payload),
    b = normalizeRailgunPrivateVerification(verified, payload);
  signed.signature.R8[0] = hex(10);
  expect(a.signature.R8[0]).toBe(hex(4));
  expect([a, a.signature, a.signature.R8, b].every(Object.isFrozen)).toBe(true);
  expect(Object.keys(a)).toEqual(['signature', 'message', 'transactionDigest']);
  expect(b).toEqual({ verified: true, transactionDigest: hex(2) });
});
test.each([
  (v) => {
    v.extra = true;
  },
  (v) => {
    v.signature.extra = true;
  },
  (v) => {
    v.signature.R8 = [hex(4)];
  },
  (v) => {
    v.signature.R8[0] = '0x' + 'ff'.repeat(32);
  },
  (v) => {
    v.signature.S =
      hex(2736030358979909402780800718157159386076813972158567259200215660948447373041n);
  },
  (v) => {
    v.signature.S = '0x01';
  },
  (v) => {
    v.message = hex(0);
  },
  (v) => {
    v.transactionDigest = hex(0);
  },
  (v) => {
    v.inventory = '0'.repeat(64);
  },
])('refuses malformed or substituted signatures %#', (change) => {
  change(signed);
  expect(() => normalizeRailgunSpendSignature(signed, payload)).toThrow();
});
test.each([
  (v) => {
    v.extra = true;
  },
  (v) => {
    v.verified = false;
  },
  (v) => {
    v.transactionDigest = hex(0);
  },
  (v) => {
    v.proverSha256 = '0'.repeat(64);
  },
])('refuses malformed or substituted verification %#', (change) => {
  change(verified);
  expect(() => normalizeRailgunPrivateVerification(verified, payload)).toThrow();
});
test.each([
  (v) => {
    v.attempts = 1;
  },
  (v) => {
    v.canaries = 0;
  },
  (v) => {
    v.hooks = ['x', 'x'];
    v.canaries = 2;
  },
  (v) => {
    v.hooks = [];
    v.canaries = 0;
  },
  (v) => {
    v.hooks = [3];
  },
  (v) => {
    v.extra = true;
  },
])('refuses bad guard evidence in either result %#', (change) => {
  change(signed.guards);
  change(verified.guards);
  expect(() => normalizeRailgunSpendSignature(signed, payload)).toThrow();
  expect(() => normalizeRailgunPrivateVerification(verified, payload)).toThrow();
});

test('validated signer key requests are immutable matching data, never signing authority', () => {
  const request = {
    id: 1,
    method: 'key',
    purpose: 'spending-sign',
    transactionDigest: hex(1),
    expectedHash: hex(3),
  };
  const result = normalizeRailgunSpendKeyRequest(request, payload);
  expect(result).toEqual({ transactionDigest: hex(1), expectedHash: hex(3) });
  expect(Object.isFrozen(result)).toBe(true);
});
test.each([
  ['id', 2],
  ['method', 'result'],
  ['purpose', 'viewing'],
  ['transactionDigest', hex(9)],
  ['expectedHash', hex(9)],
  ['extra', true],
])('signer request %s mismatch refuses before key release', (key, value) => {
  const request = {
    id: 1,
    method: 'key',
    purpose: 'spending-sign',
    transactionDigest: hex(1),
    expectedHash: hex(3),
    [key]: value,
  };
  expect(() => normalizeRailgunSpendKeyRequest(request, payload)).toThrow();
});
