const mockEnrollments = new WeakSet();
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => mockEnrollments.has(v),
}));
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
function enrollment(directory = '/fixture/account') {
  const controller = new AbortController();
  const value = { directory, signal: controller.signal, getContext: jest.fn() };
  mockEnrollments.add(value);
  return { value, controller };
}
test('wallet and TXID phases exclude one another until explicit observed-drain release', () => {
  const { value, controller } = enrollment();
  const first = claimRailgunAccountPhase(value, 'wallet');
  try {
    first.assertCurrent();
    expect(() => claimRailgunAccountPhase(value, 'txid')).toThrow();
    controller.abort();
    expect(() => first.assertCurrent()).toThrow();
    const reopened = enrollment().value;
    expect(() => claimRailgunAccountPhase(reopened, 'txid')).toThrow();
    first.release();
    const next = claimRailgunAccountPhase(reopened, 'txid');
    try {
      first.release();
      next.assertCurrent();
      expect(() => claimRailgunAccountPhase(reopened, 'wallet')).toThrow();
    } finally {
      next.release();
    }
  } finally {
    first.release();
  }
});
test('claims are account-local and forged enrollments or unsupported phases refuse', () => {
  const a = enrollment('/fixture/a').value,
    b = enrollment('/fixture/b').value;
  const first = claimRailgunAccountPhase(a, 'wallet'),
    second = claimRailgunAccountPhase(b, 'txid');
  try {
    first.assertCurrent();
    second.assertCurrent();
    expect(() => claimRailgunAccountPhase({ ...a }, 'txid')).toThrow();
    expect(() => claimRailgunAccountPhase(a, 'source')).toThrow();
  } finally {
    first.release();
    second.release();
  }
});
