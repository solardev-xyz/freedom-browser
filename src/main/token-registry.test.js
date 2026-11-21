// Unit tests for the token registry. `fs` is mocked (mockFiles maps a
// basename to its JSON string; an absent entry simulates ENOENT), writes
// land there through lib/atomic-file.js's mock (set-b-files.test.js tests
// them on disk; the fs mock has no writeFileSync, so an in-place write would
// throw), and `electron` auto-resolves to the shared __mocks__/electron.js.
// The module's init-once cache is reset by re-requiring it per test.

const mockFiles = {};
const mockWriteFileAtomicSync = jest.fn((...args) => {
  mockFiles[require('path').basename(args[0])] = args[1];
  return { durable: true };
});
jest.mock('fs', () => ({
  readFileSync: (filePath) => {
    const name = require('path').basename(filePath);
    if (!(name in mockFiles)) {
      throw Object.assign(new Error(`ENOENT: ${name}`), { code: 'ENOENT' });
    }
    return mockFiles[name];
  },
}));
jest.mock('./lib/atomic-file', () => ({
  writeFileAtomicSync: (...args) => mockWriteFileAtomicSync(...args),
}));

const BUILTIN_TOKENS = {
  '1:native': { chainId: 1, address: null, symbol: 'ETH', name: 'Ether', decimals: 18, builtin: true },
  '1:0xusdc': { chainId: 1, address: '0xusdc', symbol: 'USDC', name: 'USD Coin', decimals: 6, builtin: true },
  '100:native': { chainId: 100, address: null, symbol: 'xDAI', name: 'xDAI', decimals: 18, builtin: true },
};

let registry;
function reload({ custom } = {}) {
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  mockFiles['tokens.json'] = JSON.stringify(BUILTIN_TOKENS);
  if (custom !== undefined) mockFiles['custom-tokens.json'] = JSON.stringify(custom);
  mockWriteFileAtomicSync.mockClear();
  jest.resetModules();
  registry = require('./token-registry');
}

beforeEach(() => reload());

describe('getTokens', () => {
  test('returns all tokens when no chainId is given', () => {
    expect(Object.keys(registry.getTokens()).sort()).toEqual(['100:native', '1:0xusdc', '1:native']);
  });

  test('filters by chainId', () => {
    expect(Object.keys(registry.getTokens(1)).sort()).toEqual(['1:0xusdc', '1:native']);
    expect(Object.keys(registry.getTokens(100))).toEqual(['100:native']);
  });

  test('custom tokens merge over builtin', () => {
    reload({ custom: { '8453:0xabc': { chainId: 8453, address: '0xabc', symbol: 'DEGEN', decimals: 18 } } });
    expect(registry.getToken('8453:0xabc').symbol).toBe('DEGEN');
  });

  test('returns an empty object for a chain with no tokens', () => {
    expect(registry.getTokens(999)).toEqual({});
  });
});

describe('getToken / getTokenKey', () => {
  test('getToken returns a token or null', () => {
    expect(registry.getToken('1:native').symbol).toBe('ETH');
    expect(registry.getToken('nope')).toBeNull();
  });

  test('getTokenKey distinguishes an address from the native asset', () => {
    expect(registry.getTokenKey(1, '0xabc')).toBe('1:0xabc');
    expect(registry.getTokenKey(1, null)).toBe('1:native');
  });
});

describe('addCustomToken', () => {
  test('persists a new token and makes it queryable', () => {
    const res = registry.addCustomToken({ chainId: 8453, address: '0xabc', symbol: 'DEGEN', decimals: 18 });
    expect(res).toMatchObject({ success: true, key: '8453:0xabc' });
    expect(registry.getToken('8453:0xabc').builtin).toBe(false);
  });

  test('rejects a token missing chainId or symbol', () => {
    expect(registry.addCustomToken({ symbol: 'X' }).success).toBe(false);
    expect(registry.addCustomToken({ chainId: 1 }).success).toBe(false);
  });

  test('rejects overriding a builtin token', () => {
    expect(registry.addCustomToken({ chainId: 1, address: null, symbol: 'FAKE' }).success).toBe(false);
  });

  test('reports failure when the custom-tokens file cannot be written', () => {
    mockWriteFileAtomicSync.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const res = registry.addCustomToken({ chainId: 8453, address: '0xabc', symbol: 'DEGEN', decimals: 18 });
    expect(res.success).toBe(false);
  });
});

describe('removeCustomToken', () => {
  test('removes a custom token', () => {
    registry.addCustomToken({ chainId: 8453, address: '0xabc', symbol: 'DEGEN', decimals: 18 });
    expect(registry.removeCustomToken('8453:0xabc').success).toBe(true);
    expect(registry.getToken('8453:0xabc')).toBeNull();
  });

  test('rejects removing a builtin or unknown token', () => {
    expect(registry.removeCustomToken('1:native').success).toBe(false);
    expect(registry.removeCustomToken('nope:nope').success).toBe(false);
  });
});
