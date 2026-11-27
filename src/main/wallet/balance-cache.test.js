const fs = require('fs');
const os = require('os');
const path = require('path');

const ADDRESS = '0xf1f61666be8555e3d39d46c43b12ee829f8a97a1';
const CHECKSUM_XBZZ_KEY = '100:0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da';
const NORMALIZED_XBZZ_KEY = '100:0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';
const XDAI_KEY = '100:native';

let userData;

function cacheFile() {
  return path.join(userData, 'balance-cache.json');
}

function writeCacheFile(contents) {
  fs.writeFileSync(cacheFile(), JSON.stringify(contents));
}

function readCacheFile() {
  return JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
}

function loadBalanceCache() {
  jest.resetModules();
  jest.doMock('electron', () => ({
    app: { getPath: () => userData },
    ipcMain: { handle: jest.fn() },
  }));
  return require('./balance-cache');
}

const xbzz = (formatted) => ({ formatted, symbol: 'xBZZ', raw: '1', decimals: 16 });

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-balance-cache-'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.dontMock('electron');
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('balance cache token keys (#104)', () => {
  test('a version-2 cache keeps its balances under normalized keys and is rewritten as version 3', () => {
    writeCacheFile({
      version: 2,
      balances: {
        [ADDRESS]: {
          updatedAt: 1000,
          [XDAI_KEY]: { formatted: '0.5', symbol: 'xDAI', raw: '5', decimals: 18 },
          [CHECKSUM_XBZZ_KEY]: xbzz('1.0'),
        },
      },
    });
    const cache = loadBalanceCache();

    const balances = cache.getBalancesFromCache(ADDRESS);

    expect(balances[NORMALIZED_XBZZ_KEY]).toEqual(xbzz('1.0'));
    expect(balances).not.toHaveProperty(CHECKSUM_XBZZ_KEY);
    expect(balances[XDAI_KEY].formatted).toBe('0.5');
    expect(readCacheFile()).toEqual({
      version: 3,
      balances: {
        [ADDRESS]: {
          updatedAt: 1000,
          [XDAI_KEY]: { formatted: '0.5', symbol: 'xDAI', raw: '5', decimals: 18 },
          [NORMALIZED_XBZZ_KEY]: xbzz('1.0'),
        },
      },
    });
  });

  test('where a version-2 cache holds both spellings, the normalized (newer) entry wins', () => {
    for (const order of ['legacy-first', 'normalized-first']) {
      const entries =
        order === 'legacy-first'
          ? [
              [CHECKSUM_XBZZ_KEY, xbzz('9.0')],
              [NORMALIZED_XBZZ_KEY, xbzz('1.0')],
            ]
          : [
              [NORMALIZED_XBZZ_KEY, xbzz('1.0')],
              [CHECKSUM_XBZZ_KEY, xbzz('9.0')],
            ];
      writeCacheFile({
        version: 2,
        balances: { [ADDRESS]: { updatedAt: 1000, ...Object.fromEntries(entries) } },
      });
      const cache = loadBalanceCache();

      const balances = cache.getBalancesFromCache(ADDRESS);

      expect(balances[NORMALIZED_XBZZ_KEY].formatted).toBe('1.0');
      expect(balances).not.toHaveProperty(CHECKSUM_XBZZ_KEY);
    }
  });

  test('a version-3 cache loads as it is', () => {
    writeCacheFile({
      version: 3,
      balances: { [ADDRESS]: { updatedAt: 1000, [NORMALIZED_XBZZ_KEY]: xbzz('2.0') } },
    });
    const cache = loadBalanceCache();

    expect(cache.getBalancesFromCache(ADDRESS)[NORMALIZED_XBZZ_KEY].formatted).toBe('2.0');
  });

  test('a cache from before version 2 is still discarded', () => {
    writeCacheFile({ version: 1, balances: { [ADDRESS]: { updatedAt: 1000, xbzz: xbzz('3.0') } } });
    const cache = loadBalanceCache();

    expect(cache.getBalancesFromCache(ADDRESS)).toBeNull();
  });

  test('new balances are stored under normalized keys whatever spelling they arrive with', () => {
    const cache = loadBalanceCache();

    cache.setCachedBalances(ADDRESS, {
      lastUpdated: 'now',
      [CHECKSUM_XBZZ_KEY]: xbzz('4.0'),
      [XDAI_KEY]: { error: 'rpc down' },
    });

    const stored = readCacheFile();
    expect(stored.version).toBe(3);
    expect(Object.keys(stored.balances[ADDRESS]).sort()).toEqual(
      ['updatedAt', NORMALIZED_XBZZ_KEY].sort()
    );
    expect(stored.balances[ADDRESS][NORMALIZED_XBZZ_KEY]).toEqual(xbzz('4.0'));
  });
});
