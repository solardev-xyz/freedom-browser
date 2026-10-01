jest.mock('electron', () => ({ app: { getPath: () => '/fixture/profile' } }));
jest.mock('fs', () => ({ existsSync: () => false, writeFileSync: jest.fn() }));
const fs = require('fs');
const cache = require('./balance-cache');

test('private observations retain timestamps and evidence independently of ordinary cache merges and profiles', () => {
  const snapshot = {
    privacyMode: 'tor-experimental',
    status: 'stale',
    lastUpdated: '2026-09-14T12:00:00Z',
    '11155111:native': {
      raw: '1',
      observedAt: '2026-09-14T12:00:00Z',
      stale: true,
      trust: { level: 'unverified' },
    },
  };
  cache.setPrivateBalances('profile-a', '0xABC', snapshot);
  cache.setCachedBalances('0xabc', {
    '11155111:native': { raw: '2', formatted: '2', symbol: 'ETH', decimals: 18 },
  });
  expect(cache.getPrivateBalances('profile-a', '0xabc')).toEqual(snapshot);
  expect(cache.getPrivateBalances('profile-b', '0xabc')).toBeNull();
  const persisted = JSON.parse(fs.writeFileSync.mock.calls.at(-1)[1]);
  expect(persisted.privateBalances[JSON.stringify(['profile-a', '0xabc'])]).toEqual(snapshot);
  cache.clearCache('0xABC');
  expect(cache.getPrivateBalances('profile-a', '0xabc')).toBeNull();
});
