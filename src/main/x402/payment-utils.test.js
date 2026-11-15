const mockGetPermission = jest.fn();
jest.mock('./caps', () => ({
  getPermission: (...args) => mockGetPermission(...args),
}));

const {
  tupleFromAccept,
  coverageForAccept,
  findCoveringPermission,
} = require('./payment-utils');

// Lowercase canonical form — matches what `tupleFromAccept` emits and
// what the token-registry / balance-service / permissions store key on.
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const GNOSIS_USDCE = '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0';

beforeEach(() => {
  mockGetPermission.mockReset().mockReturnValue(null);
});

// === tupleFromAccept =====================================================

describe('tupleFromAccept', () => {
  test('extracts (chainId, asset, amount) from a V2 entry', () => {
    expect(tupleFromAccept({
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      asset: BASE_USDC,
    })).toEqual({ chainId: 8453, asset: BASE_USDC, amount: '10000' });
  });

  test('returns null for V1 string networks (we only auto-pay CAIP-2)', () => {
    // V1 uses bare network names like 'base'; our cap store is keyed
    // by chainId so we can't look up. Sign-path still works for V1 via
    // a different selection, but the auto-pay tuple is null.
    expect(tupleFromAccept({ network: 'base', maxAmountRequired: '10000', asset: BASE_USDC })).toBeNull();
    expect(tupleFromAccept({ network: 'ethereum', maxAmountRequired: '10000', asset: '0x' })).toBeNull();
  });

  test('returns null for missing or malformed network', () => {
    expect(tupleFromAccept({ amount: '10000', asset: BASE_USDC })).toBeNull();
    expect(tupleFromAccept({ network: '', amount: '10000', asset: BASE_USDC })).toBeNull();
    expect(tupleFromAccept({ network: 42, amount: '10000', asset: BASE_USDC })).toBeNull();
    expect(tupleFromAccept({ network: 'eip155:notanumber', amount: '10000', asset: BASE_USDC })).toBeNull();
  });

  test('returns null when amount is missing or non-string (zod-parsed V2 always has it; defense vs unparsed input)', () => {
    expect(tupleFromAccept({ network: 'eip155:8453', asset: BASE_USDC })).toBeNull();
    expect(tupleFromAccept({ network: 'eip155:8453', amount: 10000, asset: BASE_USDC })).toBeNull();
  });

  test('returns null for null/undefined input (defensive)', () => {
    expect(tupleFromAccept(null)).toBeNull();
    expect(tupleFromAccept(undefined)).toBeNull();
  });

  test('lowercases the asset address so downstream lookups key consistently', () => {
    // Real-world surface: the test rig sends Gnosis USDC.e with
    // EIP-55-checksummed casing, while tokens.json + balance-service
    // store the address lowercase. Without normalization, balance +
    // token-registry lookups silently miss.
    const result = tupleFromAccept({
      network: 'eip155:100',
      amount: '20000',
      asset: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0',
    });
    expect(result?.asset).toBe('0x2a22f9c3b484c3629090feed35f17ff8f88f76f0');
  });

  test('returns null when asset is missing or non-string', () => {
    expect(tupleFromAccept({ network: 'eip155:8453', amount: '10000' })).toBeNull();
    expect(tupleFromAccept({ network: 'eip155:8453', amount: '10000', asset: null })).toBeNull();
    expect(tupleFromAccept({ network: 'eip155:8453', amount: '10000', asset: 123 })).toBeNull();
  });
});

// === coverageForAccept ===================================================

describe('coverageForAccept', () => {
  const ORIGIN = 'https://api.example';
  const accept = {
    scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: BASE_USDC,
  };

  test('returns the full coverage shape with covers:true when the cap covers', () => {
    mockGetPermission.mockReturnValueOnce({
      capAmount: '20000', spentAmount: '5000', createdAt: 1, expiresAt: 9999999999,
    });
    const result = coverageForAccept(ORIGIN, accept);
    expect(result).toMatchObject({
      accept,
      tuple: { chainId: 8453, asset: BASE_USDC, amount: '10000' },
      remaining: 15000n,
      covers: true,
    });
    expect(result?.perm?.capAmount).toBe('20000');
  });

  test('reports covers:false WITHOUT collapsing to null when the cap is over-budget', () => {
    // This is the divergence from `findCoveringPermission`: the sidebar
    // needs to surface the existing-but-insufficient cap, so this helper
    // must keep the perm visible.
    mockGetPermission.mockReturnValueOnce({
      capAmount: '10000', spentAmount: '5000', createdAt: 1, expiresAt: 9999999999,
    });
    const result = coverageForAccept(ORIGIN, accept);
    expect(result?.covers).toBe(false);
    expect(result?.remaining).toBe(5000n);
    expect(result?.perm?.capAmount).toBe('10000');
  });

  test('returns null when no permission exists', () => {
    mockGetPermission.mockReturnValueOnce(null);
    expect(coverageForAccept(ORIGIN, accept)).toBeNull();
  });

  test('returns null for non-EIP-155 entries (V1 string networks)', () => {
    expect(coverageForAccept(ORIGIN, {
      network: 'base', maxAmountRequired: '10000', asset: BASE_USDC,
    })).toBeNull();
    expect(mockGetPermission).not.toHaveBeenCalled();
  });
});

// === findCoveringPermission ==============================================

describe('findCoveringPermission', () => {
  const baseAccept = {
    scheme: 'exact', network: 'eip155:8453', amount: '10000',
    asset: BASE_USDC, payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  };
  const gnosisAccept = {
    scheme: 'exact', network: 'eip155:100', amount: '20000',
    asset: GNOSIS_USDCE, payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  };
  const ORIGIN = 'https://api.example';

  function permFor(capAmount, spentAmount = '0') {
    return { capAmount, spentAmount, createdAt: 1, expiresAt: 9999999999 };
  }

  test('returns the first accepts[] entry whose cap covers (server order respected)', () => {
    // Both entries have caps; both cover. Server order wins.
    mockGetPermission.mockImplementation((origin, chainId) => {
      if (chainId === 8453) return permFor('100000');
      if (chainId === 100) return permFor('100000');
      return null;
    });

    const result = findCoveringPermission(ORIGIN, [baseAccept, gnosisAccept]);
    expect(result?.accept).toBe(baseAccept);
    expect(result?.tuple).toEqual({ chainId: 8453, asset: BASE_USDC, amount: '10000' });
    expect(result?.remaining).toBe(100000n);
  });

  test('skips an accept whose cap exists but is under-funded; picks the next covered entry', () => {
    // Base cap exhausted; Gnosis cap covers. Multi-accept lets us use Gnosis instead.
    mockGetPermission.mockImplementation((origin, chainId) => {
      if (chainId === 8453) return permFor('10000', '10000');  // 0 remaining
      if (chainId === 100) return permFor('100000');
      return null;
    });

    const result = findCoveringPermission(ORIGIN, [baseAccept, gnosisAccept]);
    expect(result?.accept).toBe(gnosisAccept);
    expect(result?.tuple.chainId).toBe(100);
  });

  test('skips an accept with no registered cap; picks the next covered entry', () => {
    mockGetPermission.mockImplementation((origin, chainId) => {
      if (chainId === 8453) return null;          // no Base cap
      if (chainId === 100) return permFor('100000');
      return null;
    });

    const result = findCoveringPermission(ORIGIN, [baseAccept, gnosisAccept]);
    expect(result?.accept).toBe(gnosisAccept);
  });

  test('keys on (chainId, asset): a cap on the right chain but wrong asset does NOT match', () => {
    // Cap exists for chain 8453 but only for USDT, not Base USDC.
    // findCoveringPermission must pass tuple.asset into getPermission;
    // a cap on a different asset of the same chain is not a match.
    const USDT_BASE = '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2';
    mockGetPermission.mockImplementation((origin, chainId, asset) => {
      if (chainId === 8453 && asset === USDT_BASE) return permFor('100000');
      return null;
    });
    expect(findCoveringPermission(ORIGIN, [baseAccept])).toBeNull();
    expect(mockGetPermission).toHaveBeenCalledWith(ORIGIN, 8453, BASE_USDC);
  });

  test('returns null when no accepts[] entry has a covering cap', () => {
    mockGetPermission.mockReturnValue(null);
    expect(findCoveringPermission(ORIGIN, [baseAccept, gnosisAccept])).toBeNull();
  });

  test('returns null when every accepts[] entry is non-EIP-155 (V1 string networks)', () => {
    const result = findCoveringPermission(ORIGIN, [
      { scheme: 'exact', network: 'base', maxAmountRequired: '10000', asset: BASE_USDC },
      { scheme: 'exact', network: 'ethereum', maxAmountRequired: '10000', asset: '0xeth' },
    ]);
    expect(result).toBeNull();
    // getPermission was never consulted — the tuple short-circuits before it.
    expect(mockGetPermission).not.toHaveBeenCalled();
  });

  test('returns null for empty or missing accepts', () => {
    expect(findCoveringPermission(ORIGIN, [])).toBeNull();
    expect(findCoveringPermission(ORIGIN, undefined)).toBeNull();
    expect(findCoveringPermission(ORIGIN, null)).toBeNull();
  });

  test('treats EXACTLY-equal headroom as covering (BigInt <= boundary)', () => {
    mockGetPermission.mockReturnValueOnce(permFor('10000', '0'));  // 10000 remaining == 10000 amount
    const result = findCoveringPermission(ORIGIN, [baseAccept]);
    expect(result?.accept).toBe(baseAccept);
    expect(result?.remaining).toBe(10000n);
  });

  test('treats one-under headroom as NOT covering', () => {
    mockGetPermission.mockReturnValueOnce(permFor('9999', '0'));   // 9999 remaining < 10000 amount
    expect(findCoveringPermission(ORIGIN, [baseAccept])).toBeNull();
  });
});
