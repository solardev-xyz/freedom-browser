/**
 * Main's holds against its caps for a Ledger's auto-pays in flight
 * (cap-holds.js; freedom-core design 0016, LDG-3's PR 9): checked and held
 * in one step against the mirror's room less the holds counted; let go at
 * once when no signature left main, and otherwise only once the mirror
 * accounts for the spend (the same cap's rise, each rise claimed once) or
 * another cap takes the key.
 */

const mockCaps = new Map();
jest.mock('./caps', () => ({
  getPermission: (origin, chainId, asset) => {
    const cap = mockCaps.get(`${origin} ${chainId} ${asset.toLowerCase()}`);
    return cap ? { ...cap, origin } : null;
  },
}));

const { holdIfCovered, releaseHold, awaitSpend, heldAmount, _resetForTests } = require('./cap-holds');

const ORIGIN = 'https://paid.example';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const OTHER = '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0';
const CREATED = 1_762_000_000;

const entry = (amount, asset = USDC, network = 'eip155:8453') => ({
  scheme: 'exact',
  network,
  amount,
  asset,
  payTo: `0x${'42'.repeat(20)}`,
});

function cap(capAmount, spentAmount = '0', { asset = USDC, chainId = 8453, createdAt = CREATED } = {}) {
  mockCaps.set(`${ORIGIN} ${chainId} ${asset}`, { chainId, asset, capAmount, spentAmount, createdAt });
}

const spend = (spentAmount) => {
  mockCaps.get(`${ORIGIN} 8453 ${USDC}`).spentAmount = spentAmount;
};
const held = () => heldAmount(ORIGIN, 8453, USDC);
const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  mockCaps.clear();
  _resetForTests();
});

describe('taking a hold', () => {
  test("held within the mirror's room; a second hold past what is left is refused", () => {
    cap('15000');
    expect(holdIfCovered(ORIGIN, entry('10000'))).toMatchObject({ amount: 10000n, baseline: 0n, createdAt: CREATED });
    expect(held()).toBe(10000n);
    expect(holdIfCovered(ORIGIN, entry('10000'))).toBeNull();
    // What is left still covers a smaller one.
    expect(holdIfCovered(ORIGIN, entry('5000'))).not.toBeNull();
    expect(holdIfCovered(ORIGIN, entry('1'))).toBeNull();
    expect(held()).toBe(15000n);
  });

  test("the mirror's spend counts as well as the holds", () => {
    cap('25000', '10000');
    expect(holdIfCovered(ORIGIN, entry('10000'))).toMatchObject({ baseline: 10000n });
    expect(holdIfCovered(ORIGIN, entry('10000'))).toBeNull();
  });

  test('each cap is counted alone: another asset or chain has its own room', () => {
    cap('10000');
    cap('10000', '0', { asset: OTHER });
    cap('10000', '0', { chainId: 100 });
    expect(holdIfCovered(ORIGIN, entry('10000'))).not.toBeNull();
    expect(holdIfCovered(ORIGIN, entry('10000', OTHER))).not.toBeNull();
    expect(holdIfCovered(ORIGIN, entry('10000', USDC, 'eip155:100'))).not.toBeNull();
    expect(holdIfCovered(ORIGIN, entry('1'))).toBeNull();
  });

  test('no cap, or an entry no cap can key on (a version 1 network), is never held', () => {
    expect(holdIfCovered(ORIGIN, entry('1'))).toBeNull();
    cap('10000');
    expect(holdIfCovered(ORIGIN, { ...entry('1'), network: 'base' })).toBeNull();
    expect(held()).toBe(0n);
  });
});

describe('letting go at once: no signature left main', () => {
  test('frees its room; letting go twice is harmless', () => {
    cap('10000');
    const hold = holdIfCovered(ORIGIN, entry('10000'));
    releaseHold(hold);
    releaseHold(hold);
    releaseHold(null);
    expect(held()).toBe(0n);
    expect(holdIfCovered(ORIGIN, entry('10000'))).not.toBeNull();
    expect(holdIfCovered(ORIGIN, entry('10000'))).toBeNull();
  });
});

describe('awaiting the spend: a signature may have left main', () => {
  test('a read that lands with the cap unchanged keeps the hold; a later read showing the spend lets it go', async () => {
    cap('15000');
    const hold = holdIfCovered(ORIGIN, entry('10000'));

    awaitSpend(hold, Promise.resolve());
    await tick();
    expect(held()).toBe(10000n);
    expect(holdIfCovered(ORIGIN, entry('10000'))).toBeNull();

    // A read that failed is no evidence either.
    awaitSpend(hold, Promise.reject(new Error('no core')));
    await tick();
    expect(held()).toBe(10000n);

    // A rise short of the amount isn't it.
    spend('9999');
    expect(held()).toBe(10000n);
    // The mirror's next refresh shows the spend: checked at the next look.
    spend('10000');
    expect(held()).toBe(0n);
    expect(holdIfCovered(ORIGIN, entry('5000'))).not.toBeNull();
    expect(holdIfCovered(ORIGIN, entry('1'))).toBeNull();
  });

  test('two holds against one rise: only one is let go; the next rise lets go the other', async () => {
    cap('25000');
    const first = holdIfCovered(ORIGIN, entry('10000'));
    const second = holdIfCovered(ORIGIN, entry('10000'));
    awaitSpend(first, Promise.resolve());
    awaitSpend(second, Promise.resolve());
    await tick();

    spend('10000');
    expect(held()).toBe(10000n);
    expect(first.released).toBe(true);
    expect(second.released).toBe(false);

    spend('20000');
    expect(held()).toBe(0n);
  });

  test('a rise that came before the hold was taken is no evidence: it was in the baseline', async () => {
    cap('25000', '10000');
    const hold = holdIfCovered(ORIGIN, entry('10000'));
    awaitSpend(hold, Promise.resolve());
    await tick();
    expect(held()).toBe(10000n);
    spend('20000');
    expect(held()).toBe(0n);
  });

  test('a hold still in flight is never let go by a rise: only one awaiting its spend', () => {
    cap('25000');
    const inFlight = holdIfCovered(ORIGIN, entry('10000'));
    spend('10000');
    expect(held()).toBe(10000n);
    expect(inFlight.released).toBe(false);
  });

  test('another cap under the key (granted again: another createdAt) lets the hold go', async () => {
    cap('15000');
    const hold = holdIfCovered(ORIGIN, entry('10000'));
    awaitSpend(hold, Promise.resolve());
    await tick();
    expect(held()).toBe(10000n);

    cap('15000', '0', { createdAt: CREATED + 30 });
    expect(held()).toBe(0n);
    expect(holdIfCovered(ORIGIN, entry('10000'))).not.toBeNull();
  });

  test('a cap gone from the mirror covers nothing: its hold waits, inert, for another cap', async () => {
    cap('15000');
    const hold = holdIfCovered(ORIGIN, entry('10000'));
    awaitSpend(hold, Promise.resolve());
    await tick();

    mockCaps.clear();
    expect(held()).toBe(10000n);
    expect(holdIfCovered(ORIGIN, entry('1'))).toBeNull();

    // Back unchanged (a read that had failed): the hold still counts.
    cap('15000');
    expect(holdIfCovered(ORIGIN, entry('10000'))).toBeNull();
    // Revoked, and a new cap granted: a fresh start.
    cap('15000', '0', { createdAt: CREATED + 60 });
    expect(holdIfCovered(ORIGIN, entry('10000'))).not.toBeNull();
    expect(hold.released).toBe(true);
  });
});
