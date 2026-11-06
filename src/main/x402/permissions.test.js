const path = require('path');
const fs = require('fs');
const os = require('os');

jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
}));

const { app } = require('electron');
const {
  grant,
  getPermission,
  tryConsume,
  charge,
  refund,
  chargeStands,
  capUpdateRequest,
  revoke,
  revokeAllForOrigin,
  updatePermission,
  getAllPermissions,
  _resetCache,
} = require('./permissions');

let tmpDir;

const BASE = 8453;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ORIGIN = 'https://api.example.com';
const TEN_USDC = '10000000'; // 10 * 10^6 atomic units
const ONE_USDC = '1000000';
const WINDOW_30_DAYS = 30 * 24 * 60 * 60;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-perms-'));
  app.getPath.mockReturnValue(tmpDir);
  _resetCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// === grant ===============================================================

describe('grant', () => {
  test('persists a cap and round-trips it through getPermission', () => {
    const record = grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    expect(record).toMatchObject({
      origin: ORIGIN,
      chainId: BASE,
      asset: USDC,
      capAmount: TEN_USDC,
      spentAmount: '0',
    });
    expect(record.expiresAt).toBeGreaterThan(record.createdAt);

    expect(getPermission(ORIGIN, BASE, USDC)).toMatchObject({
      capAmount: TEN_USDC,
      spentAmount: '0',
    });
  });

  test('replacing an existing cap resets spent to zero', () => {
    grant(ORIGIN, BASE, USDC, ONE_USDC, WINDOW_30_DAYS);
    expect(tryConsume(ORIGIN, BASE, USDC, '500000')).toBe(true);
    expect(getPermission(ORIGIN, BASE, USDC).spentAmount).toBe('500000');

    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    expect(getPermission(ORIGIN, BASE, USDC).spentAmount).toBe('0');
  });

  test('rejects non-digit cap or non-positive window', () => {
    expect(() => grant(ORIGIN, BASE, USDC, 'ten dollars', WINDOW_30_DAYS))
      .toThrow(/digit string/);
    expect(() => grant(ORIGIN, BASE, USDC, TEN_USDC, 0))
      .toThrow(/positive/);
    expect(() => grant(ORIGIN, BASE, USDC, TEN_USDC, -1))
      .toThrow(/positive/);
  });

  test('normalises the origin (different cases / trailing slash share a record)', () => {
    grant('https://API.Example.COM/', BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    expect(getPermission('https://api.example.com', BASE, USDC)).not.toBeNull();
  });

  test('isolates caps across (chainId, asset) pairs on the same origin', () => {
    const OTHER_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    grant(ORIGIN, BASE, OTHER_TOKEN, ONE_USDC, WINDOW_30_DAYS);

    expect(getPermission(ORIGIN, BASE, USDC).capAmount).toBe(TEN_USDC);
    expect(getPermission(ORIGIN, BASE, OTHER_TOKEN).capAmount).toBe(ONE_USDC);
  });
});

// === tryConsume ==========================================================

describe('tryConsume', () => {
  test('returns false when no permission exists', () => {
    expect(tryConsume(ORIGIN, BASE, USDC, ONE_USDC)).toBe(false);
  });

  test('returns true and bumps spent when within cap', () => {
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    expect(tryConsume(ORIGIN, BASE, USDC, ONE_USDC)).toBe(true);
    expect(getPermission(ORIGIN, BASE, USDC).spentAmount).toBe(ONE_USDC);
  });

  test('multiple consumes accumulate against the same cap', () => {
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    expect(tryConsume(ORIGIN, BASE, USDC, '3000000')).toBe(true);
    expect(tryConsume(ORIGIN, BASE, USDC, '4000000')).toBe(true);
    expect(getPermission(ORIGIN, BASE, USDC).spentAmount).toBe('7000000');
  });

  test('refuses the consume that would push spent over cap (no partial bump)', () => {
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    expect(tryConsume(ORIGIN, BASE, USDC, '9000000')).toBe(true);
    expect(tryConsume(ORIGIN, BASE, USDC, '2000000')).toBe(false);
    // Spent stayed at 9; the rejected attempt didn't sneak through.
    expect(getPermission(ORIGIN, BASE, USDC).spentAmount).toBe('9000000');
  });

  test('handles bigint-sized amounts that overflow Number', () => {
    const HUGE_CAP = (2n ** 64n).toString(); // bigger than Number.MAX_SAFE_INTEGER
    grant(ORIGIN, BASE, USDC, HUGE_CAP, WINDOW_30_DAYS);
    expect(tryConsume(ORIGIN, BASE, USDC, (2n ** 60n).toString())).toBe(true);
    expect(getPermission(ORIGIN, BASE, USDC).spentAmount)
      .toBe((2n ** 60n).toString());
  });

  test('rejects non-digit amounts', () => {
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    expect(tryConsume(ORIGIN, BASE, USDC, '1.5')).toBe(false);
    expect(tryConsume(ORIGIN, BASE, USDC, '-5')).toBe(false);
    expect(tryConsume(ORIGIN, BASE, USDC, '')).toBe(false);
  });

  test('returns false for an expired cap and does not bump spent', () => {
    const realNow = Date.now;
    Date.now = jest.fn(() => realNow());
    try {
      grant(ORIGIN, BASE, USDC, TEN_USDC, 1); // 1-second window
      // Jump 2 seconds ahead — cap has expired.
      Date.now.mockReturnValue(realNow() + 2000);
      expect(tryConsume(ORIGIN, BASE, USDC, ONE_USDC)).toBe(false);
      expect(getPermission(ORIGIN, BASE, USDC)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

// === revoke + getAllPermissions ==========================================

describe('revoke', () => {
  test('drops a single cap; other caps for the same origin survive', () => {
    const OTHER_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    grant(ORIGIN, BASE, OTHER_TOKEN, ONE_USDC, WINDOW_30_DAYS);

    revoke(ORIGIN, BASE, USDC);

    expect(getPermission(ORIGIN, BASE, USDC)).toBeNull();
    expect(getPermission(ORIGIN, BASE, OTHER_TOKEN)).not.toBeNull();
  });

  test('idempotent — revoking an absent cap is a no-op', () => {
    expect(() => revoke(ORIGIN, BASE, USDC)).not.toThrow();
  });
});

describe('revokeAllForOrigin', () => {
  test('drops every cap for one origin and leaves other origins alone', () => {
    const OTHER_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    grant(ORIGIN, BASE, OTHER_TOKEN, ONE_USDC, WINDOW_30_DAYS);
    grant('https://other.example/', BASE, USDC, ONE_USDC, WINDOW_30_DAYS);

    revokeAllForOrigin(ORIGIN);

    expect(getPermission(ORIGIN, BASE, USDC)).toBeNull();
    expect(getPermission(ORIGIN, BASE, OTHER_TOKEN)).toBeNull();
    expect(getPermission('https://other.example', BASE, USDC)).not.toBeNull();
  });

  test('idempotent', () => {
    expect(() => revokeAllForOrigin(ORIGIN)).not.toThrow();
  });
});

describe('updatePermission', () => {
  test('patches the cap amount without resetting spent', () => {
    grant(ORIGIN, BASE, USDC, ONE_USDC, WINDOW_30_DAYS);
    tryConsume(ORIGIN, BASE, USDC, '500000');

    const updated = updatePermission(ORIGIN, BASE, USDC, { capAmount: TEN_USDC });
    expect(updated.capAmount).toBe(TEN_USDC);
    expect(updated.spentAmount).toBe('500000');
    expect(getPermission(ORIGIN, BASE, USDC).spentAmount).toBe('500000');
  });

  test('patches the window — expiresAt is recomputed from createdAt', () => {
    const granted = grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);

    const updated = updatePermission(ORIGIN, BASE, USDC, { windowSeconds: 7 * 24 * 60 * 60 });
    expect(updated.expiresAt).toBe(granted.createdAt + 7 * 24 * 60 * 60);
  });

  test('throws when patching a non-existent record', () => {
    expect(() => updatePermission(ORIGIN, BASE, USDC, { capAmount: TEN_USDC }))
      .toThrow(/no permission/);
  });

  test('validates the patch payload', () => {
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    expect(() => updatePermission(ORIGIN, BASE, USDC, { capAmount: 'bad' }))
      .toThrow(/digit string/);
    expect(() => updatePermission(ORIGIN, BASE, USDC, { windowSeconds: 0 }))
      .toThrow(/positive/);
  });
});

describe('getAllPermissions', () => {
  test('returns active caps with their origin / chainId / asset annotated', () => {
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    grant('https://other.example/', 1, USDC, ONE_USDC, WINDOW_30_DAYS);

    const all = getAllPermissions();
    expect(all).toHaveLength(2);
    expect(all).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: ORIGIN, chainId: BASE, asset: USDC, capAmount: TEN_USDC }),
      expect.objectContaining({ origin: 'https://other.example', chainId: 1, capAmount: ONE_USDC }),
    ]));
  });

  test('skips expired caps', () => {
    const realNow = Date.now;
    Date.now = jest.fn(() => realNow());
    try {
      grant(ORIGIN, BASE, USDC, TEN_USDC, 1);
      grant('https://other.example/', BASE, USDC, ONE_USDC, WINDOW_30_DAYS);
      Date.now.mockReturnValue(realNow() + 2000);
      expect(getAllPermissions()).toHaveLength(1);
      expect(getAllPermissions()[0].origin).toBe('https://other.example');
    } finally {
      Date.now = realNow;
    }
  });
});

// === which grant a cap is ================================================

// A cap's `createdAt` is in whole seconds, so a cap revoked and granted
// again within one second has the same one. A charge and an edit's
// binding name the grant's generation instead (#1028 review).
describe('a cap granted again within one second is another cap', () => {
  let realNow;
  beforeEach(() => {
    realNow = Date.now;
    const fixed = realNow();
    Date.now = () => fixed;
  });
  afterEach(() => {
    Date.now = realNow;
  });

  test("an old charge doesn't stand against it, and isn't given back to it", () => {
    const first = grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    const taken = charge(ORIGIN, BASE, USDC, TEN_USDC);
    expect(chargeStands(taken)).toBe(true);

    revoke(ORIGIN, BASE, USDC);
    const second = grant(ORIGIN, BASE, USDC, '1', WINDOW_30_DAYS);
    expect(second.createdAt).toBe(first.createdAt);
    expect(chargeStands(taken)).toBe(false);

    // The new cap has its own charge; the old one's refund doesn't touch it.
    expect(charge(ORIGIN, BASE, USDC, '1')).not.toBeNull();
    expect(refund(taken)).toBe(false);
    expect(getPermission(ORIGIN, BASE, USDC).spentAmount).toBe('1');
  });

  test('so is one granted over it without a revoke', () => {
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    const taken = charge(ORIGIN, BASE, USDC, ONE_USDC);
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    expect(chargeStands(taken)).toBe(false);
    expect(refund(taken)).toBe(false);
  });

  test('an edit of the amount or the window is the same cap: its charges stand', () => {
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    const taken = charge(ORIGIN, BASE, USDC, ONE_USDC);
    updatePermission(ORIGIN, BASE, USDC, { capAmount: '2000000', windowSeconds: 3600 });
    expect(chargeStands(taken)).toBe(true);
    expect(refund(taken)).toBe(true);
    expect(getPermission(ORIGIN, BASE, USDC).spentAmount).toBe('0');
  });

  test('a charge naming no generation, or another, stands against nothing', () => {
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    const taken = charge(ORIGIN, BASE, USDC, ONE_USDC);
    for (const generation of [undefined, null, '1', taken.generation + 1, taken.generation - 1]) {
      expect(chargeStands({ ...taken, generation })).toBe(false);
      expect(refund({ ...taken, generation })).toBe(false);
    }
    expect(getPermission(ORIGIN, BASE, USDC).spentAmount).toBe(ONE_USDC);
  });

  test("an edit's binding tells the old cap from the new", () => {
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    const before = capUpdateRequest(1, { origin: ORIGIN, chainId: BASE, asset: USDC, capAmount: ONE_USDC });
    revoke(ORIGIN, BASE, USDC);
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    const after = capUpdateRequest(1, { origin: ORIGIN, chainId: BASE, asset: USDC, capAmount: ONE_USDC });
    const { generation: a, ...restBefore } = before.current;
    const { generation: b, ...restAfter } = after.current;
    expect(restAfter).toEqual(restBefore);
    expect(Number.isSafeInteger(a) && Number.isSafeInteger(b) && a !== b).toBe(true);

    // An edit keeps it.
    updatePermission(ORIGIN, BASE, USDC, { capAmount: ONE_USDC });
    expect(capUpdateRequest(1, { origin: ORIGIN, chainId: BASE, asset: USDC, capAmount: TEN_USDC }).current)
      .toMatchObject({ capAmount: ONE_USDC, generation: b });
  });

  test('the generation is not written to the file, and a fresh read gives the cap a new one', () => {
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    const taken = charge(ORIGIN, BASE, USDC, ONE_USDC);
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'x402-permissions.json'), 'utf-8'));
    expect(onDisk).toEqual({
      [ORIGIN]: {
        [`${BASE}:${USDC}`]: {
          capAmount: TEN_USDC,
          spentAmount: ONE_USDC,
          createdAt: expect.any(Number),
          expiresAt: expect.any(Number),
        },
      },
    });
    _resetCache();
    expect(getPermission(ORIGIN, BASE, USDC).spentAmount).toBe(ONE_USDC);
    const again = charge(ORIGIN, BASE, USDC, ONE_USDC);
    expect(again.generation).not.toBe(taken.generation);
    expect(chargeStands(taken)).toBe(false);
    expect(chargeStands(again)).toBe(true);
  });
});

// === persistence ==========================================================

describe('persistence', () => {
  test('survives a cache reset (re-reads from disk)', () => {
    grant(ORIGIN, BASE, USDC, TEN_USDC, WINDOW_30_DAYS);
    _resetCache();
    expect(getPermission(ORIGIN, BASE, USDC)).not.toBeNull();
  });

  test('compacts already-expired records on load so the file does not bloat over sessions', () => {
    const realNow = Date.now;
    Date.now = jest.fn(() => realNow());
    try {
      grant(ORIGIN, BASE, USDC, TEN_USDC, 1); // expires in 1s
      grant('https://other.example/', BASE, USDC, ONE_USDC, WINDOW_30_DAYS);
      Date.now.mockReturnValue(realNow() + 2000);

      // Force a fresh read from disk — load() must drop the expired
      // entry instead of carrying it forward into the new session.
      _resetCache();
      expect(getAllPermissions().map((p) => p.origin)).toEqual(['https://other.example']);
    } finally {
      Date.now = realNow;
    }
  });
});
