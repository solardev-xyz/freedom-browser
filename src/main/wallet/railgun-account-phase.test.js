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
test('recovery excludes every compute phase until observed-drain release, even after revocation', () => {
  const { value, controller } = enrollment();
  const recovery = claimRailgunAccountPhase(value, 'recovery');
  try {
    for (const phase of ['wallet', 'txid', 'recovery'])
      expect(() => claimRailgunAccountPhase(value, phase)).toThrow();
    controller.abort();
    const cold = enrollment().value;
    expect(() => claimRailgunAccountPhase(cold, 'wallet')).toThrow();
    recovery.release();
    const next = claimRailgunAccountPhase(cold, 'wallet');
    next.release();
  } finally {
    recovery.release();
  }
});

test('handoff reserves the account across drained wallet and TXID gaps without permitting overlap', () => {
  const { value } = enrollment('/handoff/full');
  const wallet = claimRailgunAccountPhase(value, 'wallet');
  const handoff = wallet.reserveHandoff();
  try {
    expect(() => wallet.reserveHandoff()).toThrow();
    expect(() => claimRailgunAccountPhase(value, 'txid', handoff.token)).toThrow();
    wallet.release();
    handoff.assertCurrent();
    for (const phase of ['wallet', 'txid', 'recovery'])
      expect(() => claimRailgunAccountPhase(value, phase)).toThrow();
    expect(() => claimRailgunAccountPhase(value, 'txid', { ...handoff.token })).toThrow();
    expect(() => claimRailgunAccountPhase(value, 'recovery', handoff.token)).toThrow();
    const txid = claimRailgunAccountPhase(value, 'txid', handoff.token);
    txid.assertCurrent();
    expect(() => txid.reserveHandoff()).toThrow();
    txid.release();
    expect(() => claimRailgunAccountPhase(value, 'wallet')).toThrow();
    const reopened = claimRailgunAccountPhase(value, 'wallet', handoff.token);
    handoff.release();
    expect(() => handoff.assertCurrent()).toThrow();
    reopened.assertCurrent();
    expect(() => claimRailgunAccountPhase(value, 'txid')).toThrow();
    reopened.release();
    expect(() => claimRailgunAccountPhase(value, 'wallet', handoff.token)).toThrow();
    const ordinary = claimRailgunAccountPhase(value, 'wallet');
    ordinary.release();
  } finally {
    wallet.release();
    handoff.release();
  }
});
test('handoff cancellation retains directory exclusion until explicit cleanup release', () => {
  const first = enrollment('/handoff/cancel'),
    cold = enrollment('/handoff/cancel');
  const wallet = claimRailgunAccountPhase(first.value, 'wallet'),
    handoff = wallet.reserveHandoff();
  wallet.release();
  first.controller.abort();
  try {
    expect(() => handoff.assertCurrent()).toThrow();
    expect(() => claimRailgunAccountPhase(first.value, 'txid', handoff.token)).toThrow();
    expect(() => claimRailgunAccountPhase(cold.value, 'wallet')).toThrow();
    expect(() => claimRailgunAccountPhase(cold.value, 'txid', handoff.token)).toThrow();
  } finally {
    handoff.release();
  }
  const reopened = claimRailgunAccountPhase(cold.value, 'wallet');
  reopened.release();
});
test('only a current wallet can reserve and a stale handoff cannot unlock its successor', () => {
  const { value } = enrollment('/handoff/stale');
  const txid = claimRailgunAccountPhase(value, 'txid');
  expect(() => txid.reserveHandoff()).toThrow();
  txid.release();
  const wallet = claimRailgunAccountPhase(value, 'wallet'),
    first = wallet.reserveHandoff();
  first.release();
  const next = wallet.reserveHandoff();
  first.release();
  next.assertCurrent();
  wallet.release();
  expect(() => wallet.reserveHandoff()).toThrow();
  expect(() => claimRailgunAccountPhase(value, 'txid')).toThrow();
  next.release();
});
test('handoff scope does not block unrelated accounts or release an active phase', () => {
  const a = enrollment('/handoff/a').value,
    b = enrollment('/handoff/b').value;
  const wallet = claimRailgunAccountPhase(a, 'wallet'),
    handoff = wallet.reserveHandoff();
  const unrelated = claimRailgunAccountPhase(b, 'txid');
  handoff.release();
  wallet.assertCurrent();
  unrelated.assertCurrent();
  expect(() => claimRailgunAccountPhase(a, 'txid')).toThrow();
  wallet.release();
  unrelated.release();
});
