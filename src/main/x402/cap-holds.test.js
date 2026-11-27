/**
 * Main's holds against its caps for a Ledger's auto-pays in flight
 * (cap-holds.js; freedom-core design 0016, LDG-3's PR 9): checked and held
 * in one step against the mirror's room less the holds already counted,
 * let go at once or once a mirror read lands.
 */

const mockCaps = new Map();
jest.mock('./caps', () => ({
  getPermission: (origin, chainId, asset) => {
    const cap = mockCaps.get(`${origin} ${chainId} ${asset.toLowerCase()}`);
    return cap ? { ...cap, origin } : null;
  },
}));

const { holdIfCovered, releaseHold, releaseHoldWhen, heldAmount, _resetForTests } = require('./cap-holds');

const ORIGIN = 'https://paid.example';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const OTHER = '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0';

const entry = (amount, asset = USDC, network = 'eip155:8453') => ({
  scheme: 'exact',
  network,
  amount,
  asset,
  payTo: `0x${'42'.repeat(20)}`,
});

function cap(capAmount, spentAmount = '0', asset = USDC, chainId = 8453) {
  mockCaps.set(`${ORIGIN} ${chainId} ${asset}`, { chainId, asset, capAmount, spentAmount });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  mockCaps.clear();
  _resetForTests();
});

test("held within the mirror's room; a second hold past what is left is refused", () => {
  cap('15000');
  const first = holdIfCovered(ORIGIN, entry('10000'));
  expect(first).toMatchObject({ amount: 10000n, released: false });
  expect(heldAmount(ORIGIN, 8453, USDC)).toBe(10000n);
  expect(holdIfCovered(ORIGIN, entry('10000'))).toBeNull();
  // What is left still covers a smaller one.
  expect(holdIfCovered(ORIGIN, entry('5000'))).not.toBeNull();
  expect(holdIfCovered(ORIGIN, entry('1'))).toBeNull();
  expect(heldAmount(ORIGIN, 8453, USDC)).toBe(15000n);
});

test("the mirror's spend counts as well as the holds", () => {
  cap('25000', '10000');
  expect(holdIfCovered(ORIGIN, entry('10000'))).not.toBeNull();
  expect(holdIfCovered(ORIGIN, entry('10000'))).toBeNull();
});

test('each cap is counted alone: another asset or chain has its own room', () => {
  cap('10000');
  cap('10000', '0', OTHER);
  cap('10000', '0', USDC, 100);
  expect(holdIfCovered(ORIGIN, entry('10000'))).not.toBeNull();
  expect(holdIfCovered(ORIGIN, entry('10000', OTHER))).not.toBeNull();
  expect(holdIfCovered(ORIGIN, entry('10000', USDC, 'eip155:100'))).not.toBeNull();
  expect(holdIfCovered(ORIGIN, entry('1'))).toBeNull();
});

test('no cap, or an entry no cap can key on (a version 1 network), is never held', () => {
  expect(holdIfCovered(ORIGIN, entry('1'))).toBeNull();
  cap('10000');
  expect(holdIfCovered(ORIGIN, { ...entry('1'), network: 'base' })).toBeNull();
  expect(heldAmount(ORIGIN, 8453, USDC)).toBe(0n);
});

test('a hold let go frees its room; letting go twice is harmless', () => {
  cap('10000');
  const hold = holdIfCovered(ORIGIN, entry('10000'));
  releaseHold(hold);
  releaseHold(hold);
  releaseHold(null);
  expect(heldAmount(ORIGIN, 8453, USDC)).toBe(0n);
  expect(holdIfCovered(ORIGIN, entry('10000'))).not.toBeNull();
  expect(holdIfCovered(ORIGIN, entry('10000'))).toBeNull();
});

test.each([
  ['lands', (deferred) => deferred.resolve()],
  ['fails', (deferred) => deferred.reject(new Error('no core'))],
])('a hold let go once the mirror read %s, and not before', async (_what, settle) => {
  cap('10000');
  const hold = holdIfCovered(ORIGIN, entry('10000'));
  const deferred = {};
  const read = new Promise((resolve, reject) => Object.assign(deferred, { resolve, reject }));

  releaseHoldWhen(hold, read);
  await tick();
  expect(heldAmount(ORIGIN, 8453, USDC)).toBe(10000n);

  settle(deferred);
  await tick();
  expect(heldAmount(ORIGIN, 8453, USDC)).toBe(0n);
});
