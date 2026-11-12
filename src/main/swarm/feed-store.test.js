const path = require('path');
const fs = require('fs');
const os = require('os');

// Mock electron with IPC capture
const ipcHandlers = {};
jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler;
    },
    removeHandler: () => {},
  },
}));

jest.mock('electron-log', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

const mockGetDerivedKeys = jest.fn();
const mockGetPublisherKey = jest.fn();
const mockGetDerivedWallets = jest.fn();

jest.mock('../identity-manager', () => ({
  // Owner lookups use addresses only (keys.addresses in the core); the mocks
  // keep the old derived-key shapes as their source.
  getBeeWalletAddress: async () => mockGetDerivedKeys()?.beeWallet?.address ?? null,
  getPublisherAddress: async (index) => (await mockGetPublisherKey(index)).address,
  getDerivedWallets: (...args) => mockGetDerivedWallets(...args),
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger' },
}));

const { app } = require('electron');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-store-test-'));
  app.getPath.mockReturnValue(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const IPC = require('../../shared/ipc-channels');

const {
  getOriginEntry,
  setOriginEntry,
  allocatePublisherKeyIndex,
  getOriginIdentityState,
  getOriginIdentityStateWithOwners,
  previewAppScopedIdentity,
  createAppScopedIdentity,
  createAppScopedIdentityAt,
  ensureAntWalletIdentity,
  activateIdentity,
  getFeed,
  setFeed,
  updateFeedReference,
  getAllFeeds,
  getAllOriginEntries,
  isIdentitySharedWithOtherOrigins,
  getEthereumWalletIdentityReferences,
  hasIdentityMode,
  hasFeedGrant,
  grantFeedAccess,
  revokeFeedAccess,
  onManifestMutation,
  registerFeedStoreIpc,
  _resetCache,
} = require('./feed-store');

beforeEach(() => {
  _resetCache();
  mockGetDerivedKeys.mockReturnValue({
    beeWallet: {
      address: '0xBee0000000000000000000000000000000000000',
      privateKey: '0xbeekey',
    },
  });
  mockGetPublisherKey.mockImplementation(async (index) => ({
    address: `0xPublisher${index}`,
    privateKey: `0xpublisher${index}`,
  }));
  mockGetDerivedWallets.mockResolvedValue([
    { index: 0, name: 'Main Wallet', address: '0xWallet000000000000000000000000000000000000' },
    { index: 2, name: 'Trading Wallet', address: '0xWallet222222222222222222222222222222222222' },
  ]);
});

function getFeedsFilePath() {
  return path.join(tmpDir, 'swarm-feeds.json');
}

function readFeedsFile() {
  return JSON.parse(fs.readFileSync(getFeedsFilePath(), 'utf-8'));
}

const UNAVAILABLE = "Ethereum wallet publisher identities aren't available";

/**
 * Stores an identity in the removed ethereum-wallet mode (#89) the way an
 * older build wrote it: the browser can no longer create one.
 */
function storeWalletIdentity(origin, walletIndex, { active = true, feeds = {} } = {}) {
  const store = fs.existsSync(getFeedsFilePath())
    ? readFeedsFile()
    : { version: 2, nextPublisherKeyIndex: 0, origins: {} };
  const id = `ethereum-wallet:${walletIndex}`;
  const entry = store.origins[origin] || {
    activeIdentityId: null,
    identities: {},
    feedGranted: true,
    grantedAt: 1,
    feeds: {},
  };
  entry.identities[id] = {
    id,
    mode: 'ethereum-wallet',
    publisherKeyIndex: null,
    walletIndex,
    label: `Ethereum wallet ${walletIndex + 1}`,
    createdAt: 2,
    lastUsedAt: null,
  };
  if (active || !entry.activeIdentityId) entry.activeIdentityId = id;
  Object.assign(entry.feeds, feeds);
  store.origins[origin] = entry;
  fs.writeFileSync(getFeedsFilePath(), JSON.stringify(store));
  _resetCache();
}

describe('feed-store', () => {
  describe('origin entries', () => {
    test('getOriginEntry returns null for unknown origin', () => {
      expect(getOriginEntry('unknown.eth')).toBeNull();
    });

    test('setOriginEntry creates entry with app-scoped mode', () => {
      const entry = setOriginEntry('myapp.eth', {
        identityMode: 'app-scoped',
        publisherKeyIndex: 0,
      });
      expect(entry.identityMode).toBe('app-scoped');
      expect(entry.publisherKeyIndex).toBe(0);
      expect(entry.activeIdentityId).toBe('app-scoped:0');
      expect(entry.identities['app-scoped:0']).toMatchObject({
        mode: 'app-scoped',
        publisherKeyIndex: 0,
      });
      expect(entry.grantedAt).toEqual(expect.any(Number));
      expect(entry.feeds).toEqual({});
    });

    test('setOriginEntry creates entry with bee-wallet mode', () => {
      const entry = setOriginEntry('myapp.eth', {
        identityMode: 'bee-wallet',
      });
      expect(entry.identityMode).toBe('bee-wallet');
      expect(entry.publisherKeyIndex).toBeNull();
      expect(entry.activeIdentityId).toBe('bee-wallet');
    });

    // #89: the ethereum-wallet mode is gone; nothing creates it.
    test('setOriginEntry refuses the removed ethereum-wallet mode', () => {
      expect(() => setOriginEntry('myapp.eth', { identityMode: 'ethereum-wallet', walletIndex: 2 }))
        .toThrow(UNAVAILABLE);
      expect(getOriginEntry('myapp.eth')).toBeNull();
    });

    test('getOriginEntry returns entry after set', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      const entry = getOriginEntry('myapp.eth');
      expect(entry).not.toBeNull();
      expect(entry.identityMode).toBe('app-scoped');
    });

    test('setOriginEntry preserves existing feeds on update', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      setFeed('myapp.eth', 'blog', {
        topic: 'abc',
        owner: 'def',
        manifestReference: '123',
      });
      // Update identity mode (shouldn't happen in practice, but tests preservation)
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      expect(getFeed('myapp.eth', 'blog')).not.toBeNull();
    });

    test('setOriginEntry normalizes origin', () => {
      setOriginEntry('bzz://ABC123/path', { identityMode: 'bee-wallet' });
      expect(getOriginEntry('bzz://ABC123')).not.toBeNull();
    });
  });

  describe('publisher key index allocation', () => {
    test('allocates indices sequentially starting from 0', () => {
      expect(allocatePublisherKeyIndex()).toBe(0);
      expect(allocatePublisherKeyIndex()).toBe(1);
      expect(allocatePublisherKeyIndex()).toBe(2);
    });

    test('indices persist across cache reset', () => {
      allocatePublisherKeyIndex(); // 0
      allocatePublisherKeyIndex(); // 1
      _resetCache();
      expect(allocatePublisherKeyIndex()).toBe(2);
    });
  });

  describe('identity management', () => {
    test('getOriginIdentityState lists identities for an origin', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });

      const state = getOriginIdentityState('myapp.eth');

      expect(state.origin).toBe('myapp.eth');
      expect(state.activeIdentityId).toBe('app-scoped:0');
      expect(state.identities).toHaveLength(1);
      expect(state.identities[0]).toMatchObject({
        id: 'app-scoped:0',
        mode: 'app-scoped',
      });
    });

    test('createAppScopedIdentity adds and activates a new identity without dropping old identities', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });

      const entry = createAppScopedIdentity('myapp.eth', { label: '  Testing identity  ' });

      expect(entry.activeIdentityId).toBe('app-scoped:1');
      expect(entry.identities['app-scoped:0']).toBeDefined();
      expect(entry.identities['app-scoped:1']).toMatchObject({
        mode: 'app-scoped',
        publisherKeyIndex: 1,
        label: 'Testing identity',
      });
      expect(allocatePublisherKeyIndex()).toBe(2);
    });

    test('ensureAntWalletIdentity can add Bee wallet without activating it', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });

      const entry = ensureAntWalletIdentity('myapp.eth');

      expect(entry.activeIdentityId).toBe('app-scoped:0');
      expect(entry.identities['bee-wallet']).toMatchObject({
        mode: 'bee-wallet',
        publisherKeyIndex: null,
      });
    });

    test('ensureAntWalletIdentity can activate Bee wallet identity', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });

      const entry = ensureAntWalletIdentity('myapp.eth', { activate: true });

      expect(entry.activeIdentityId).toBe('bee-wallet');
      expect(entry.identityMode).toBe('bee-wallet');
      expect(entry.publisherKeyIndex).toBeNull();
    });

    test('wallet accounts are not offered as publisher identities', async () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });

      const state = await getOriginIdentityStateWithOwners('myapp.eth');

      expect(state.identities.map((identity) => identity.mode)).toEqual(['app-scoped', 'bee-wallet']);
      expect(mockGetDerivedWallets).not.toHaveBeenCalled();
    });

    // #89: a stored identity in the removed mode loads, so its origin keeps
    // its record (and no default key is picked for it), but it is reported
    // as unavailable and can't be activated again.
    test('a stored ethereum-wallet identity loads, unavailable', async () => {
      storeWalletIdentity('myapp.eth', 2, {
        feeds: { blog: { topic: 'a', owner: '0xWallet2', manifestReference: 'c', identityId: 'ethereum-wallet:2' } },
      });

      expect(hasIdentityMode('myapp.eth')).toBe(true);
      expect(getOriginEntry('myapp.eth')).toMatchObject({
        activeIdentityId: 'ethereum-wallet:2',
        identityMode: 'ethereum-wallet',
        walletIndex: 2,
      });
      const state = await getOriginIdentityStateWithOwners('myapp.eth');
      expect(state.identities.find((identity) => identity.id === 'ethereum-wallet:2')).toMatchObject({
        label: 'Trading Wallet',
        owner: '0xWallet222222222222222222222222222222222222',
        stored: true,
        unavailable: true,
      });
      // The other identities stay usable.
      expect(state.identities.find((identity) => identity.id === 'bee-wallet').unavailable).toBeUndefined();
    });

    // Review of #792 (round 1): the shared grant refuses it too, whoever
    // asks (the feed prompt or a manifest's projection), and keeps it.
    test('feed access is never granted to a stored ethereum-wallet identity', () => {
      storeWalletIdentity('myapp.eth', 2);
      revokeFeedAccess('myapp.eth');
      for (const source of ['user', 'manifest']) {
        expect(() => grantFeedAccess('myapp.eth', { source })).toThrow(UNAVAILABLE);
      }
      expect(hasFeedGrant('myapp.eth')).toBe(false);
      _resetCache();
      expect(hasFeedGrant('myapp.eth')).toBe(false);
      expect(getOriginEntry('myapp.eth').activeIdentityId).toBe('ethereum-wallet:2');

      // Once the user switches identity, the grant works.
      createAppScopedIdentity('myapp.eth', { activate: true });
      grantFeedAccess('myapp.eth');
      expect(hasFeedGrant('myapp.eth')).toBe(true);
    });

    test('reports which identities other sites share (SW-1)', async () => {
      mockGetDerivedWallets.mockResolvedValue([
        { index: 0, name: 'Main Wallet', address: '0xWallet000000000000000000000000000000000000', type: 'mnemonic' },
      ]);
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 4 });
      setOriginEntry('other.eth', { identityMode: 'app-scoped', publisherKeyIndex: 5 });

      const own = getOriginEntry('myapp.eth').identities['app-scoped:4'];
      expect(isIdentitySharedWithOtherOrigins('myapp.eth', own)).toBe(false);
      // The Ant wallet and Ethereum wallet accounts are shared by nature.
      expect(isIdentitySharedWithOtherOrigins('myapp.eth', { mode: 'bee-wallet' })).toBe(true);
      expect(
        isIdentitySharedWithOtherOrigins('myapp.eth', { mode: 'ethereum-wallet', walletIndex: 0 })
      ).toBe(true);
      expect(isIdentitySharedWithOtherOrigins('myapp.eth', null)).toBe(true);

      // A publisher key another origin also holds is shared.
      setOriginEntry('copycat.eth', { identityMode: 'app-scoped', publisherKeyIndex: 4 });
      expect(isIdentitySharedWithOtherOrigins('myapp.eth', own)).toBe(true);

      const state = await getOriginIdentityStateWithOwners('other.eth');
      const shared = Object.fromEntries(state.identities.map((i) => [i.id, i.shared]));
      expect(shared).toEqual({ 'app-scoped:5': false, 'bee-wallet': true });
      await expect(previewAppScopedIdentity('other.eth')).resolves.toMatchObject({ shared: false });
    });

    test('a stored ethereum-wallet identity is never activated', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      storeWalletIdentity('myapp.eth', 2, { active: false });

      expect(() => activateIdentity('myapp.eth', 'ethereum-wallet:2')).toThrow(UNAVAILABLE);
      expect(getOriginEntry('myapp.eth').activeIdentityId).toBe('app-scoped:0');
    });

    test('getEthereumWalletIdentityReferences lists active and feed-pinned identities', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      storeWalletIdentity('myapp.eth', 2);
      setFeed('myapp.eth', 'blog', { topic: 'a', owner: 'b', manifestReference: 'c' });

      setOriginEntry('other.eth', { identityMode: 'app-scoped', publisherKeyIndex: 1 });
      storeWalletIdentity('other.eth', 2, { active: false });
      setFeed('other.eth', 'archive', {
        topic: 'd',
        owner: 'e',
        manifestReference: 'f',
        identityId: 'ethereum-wallet:2',
      });

      setOriginEntry('unused.eth', { identityMode: 'app-scoped', publisherKeyIndex: 2 });
      storeWalletIdentity('unused.eth', 2, { active: false });

      expect(getEthereumWalletIdentityReferences(2)).toEqual([
        {
          origin: 'myapp.eth',
          identityId: 'ethereum-wallet:2',
          active: true,
          feedNames: ['blog'],
          feedCount: 1,
        },
        {
          origin: 'other.eth',
          identityId: 'ethereum-wallet:2',
          active: false,
          feedNames: ['archive'],
          feedCount: 1,
        },
      ]);
    });

    test('getEthereumWalletIdentityReferences returns empty list for unreferenced wallet', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });

      expect(getEthereumWalletIdentityReferences(2)).toEqual([]);
    });

    test('activateIdentity switches active identity without retagging existing feeds', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      setFeed('myapp.eth', 'blog', { topic: 'a', owner: 'b', manifestReference: 'c' });
      createAppScopedIdentity('myapp.eth');

      const entry = activateIdentity('myapp.eth', 'app-scoped:0');

      expect(entry.activeIdentityId).toBe('app-scoped:0');
      expect(getFeed('myapp.eth', 'blog').identityId).toBe('app-scoped:0');
    });

    test('activateIdentity rejects unknown identities', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });

      expect(() => activateIdentity('myapp.eth', 'missing')).toThrow('Publisher identity not found');
    });
  });

  describe('feed entries', () => {
    beforeEach(() => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
    });

    test('getFeed returns null for unknown feed', () => {
      expect(getFeed('myapp.eth', 'unknown')).toBeNull();
    });

    test('getFeed returns null for unknown origin', () => {
      expect(getFeed('unknown.eth', 'blog')).toBeNull();
    });

    test('setFeed creates feed entry', () => {
      const feed = setFeed('myapp.eth', 'blog', {
        topic: 'abc123',
        owner: 'def456',
        manifestReference: '789abc',
      });
      expect(feed.topic).toBe('abc123');
      expect(feed.owner).toBe('def456');
      expect(feed.manifestReference).toBe('789abc');
      expect(feed.identityId).toBe('app-scoped:0');
      expect(feed.createdAt).toEqual(expect.any(Number));
      expect(feed.lastUpdated).toBeNull();
      expect(feed.lastReference).toBeNull();
    });

    test('setFeed is idempotent — preserves createdAt', () => {
      const realDateNow = Date.now;
      Date.now = () => 1000;
      try {
        setFeed('myapp.eth', 'blog', {
          topic: 'abc',
          owner: 'def',
          manifestReference: '123',
        });
        Date.now = () => 2000;
        setFeed('myapp.eth', 'blog', {
          topic: 'abc',
          owner: 'def',
          manifestReference: '123',
        });
        const feed = getFeed('myapp.eth', 'blog');
        expect(feed.createdAt).toBe(1000);
      } finally {
        Date.now = realDateNow;
      }
    });

    test('setFeed throws for unknown origin', () => {
      expect(() => setFeed('unknown.eth', 'blog', {
        topic: 'abc',
        owner: 'def',
        manifestReference: '123',
      })).toThrow('No origin entry');
    });

    test('getFeed returns entry after set', () => {
      setFeed('myapp.eth', 'blog', {
        topic: 'abc',
        owner: 'def',
        manifestReference: '123',
      });
      const feed = getFeed('myapp.eth', 'blog');
      expect(feed).not.toBeNull();
      expect(feed.topic).toBe('abc');
    });

    test('updateFeedReference updates lastReference and lastUpdated', () => {
      setFeed('myapp.eth', 'blog', {
        topic: 'abc',
        owner: 'def',
        manifestReference: '123',
      });
      updateFeedReference('myapp.eth', 'blog', 'newref456');
      const feed = getFeed('myapp.eth', 'blog');
      expect(feed.lastReference).toBe('newref456');
      expect(feed.lastUpdated).toEqual(expect.any(Number));
    });

    test('updateFeedReference throws for unknown feed', () => {
      expect(() => updateFeedReference('myapp.eth', 'unknown', 'ref')).toThrow('not found');
    });

    test('getAllFeeds returns all feeds for origin', () => {
      setFeed('myapp.eth', 'blog', { topic: 'a', owner: 'b', manifestReference: 'c' });
      setFeed('myapp.eth', 'profile', { topic: 'd', owner: 'e', manifestReference: 'f' });
      const feeds = getAllFeeds('myapp.eth');
      expect(Object.keys(feeds)).toHaveLength(2);
      expect(feeds.blog).toBeDefined();
      expect(feeds.profile).toBeDefined();
    });

    test('getAllFeeds returns empty object for unknown origin', () => {
      expect(getAllFeeds('unknown.eth')).toEqual({});
    });
  });

  describe('persistence', () => {
    test('data survives cache reset', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      setFeed('myapp.eth', 'blog', { topic: 'a', owner: 'b', manifestReference: 'c' });
      _resetCache();
      const feed = getFeed('myapp.eth', 'blog');
      expect(feed).not.toBeNull();
      expect(feed.topic).toBe('a');
    });

    test('mutating returned origin entry does not corrupt cache', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      setFeed('myapp.eth', 'blog', { topic: 'a', owner: 'b', manifestReference: 'c' });

      const entry = getOriginEntry('myapp.eth');
      // Mutate the returned object at every level
      entry.identityMode = 'corrupted';
      entry.identities['app-scoped:0'].mode = 'corrupted';
      entry.feeds.blog.owner = 'corrupted';
      entry.feeds.newFeed = { topic: 'injected' };

      // Cache should be unaffected
      const fresh = getOriginEntry('myapp.eth');
      expect(fresh.identityMode).toBe('app-scoped');
      expect(fresh.identities['app-scoped:0'].mode).toBe('app-scoped');
      expect(fresh.feeds.blog.owner).toBe('b');
      expect(fresh.feeds.newFeed).toBeUndefined();
    });

    test('writes to disk', () => {
      setOriginEntry('myapp.eth', { identityMode: 'bee-wallet' });
      const filePath = getFeedsFilePath();
      expect(fs.existsSync(filePath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data.version).toBe(2);
      expect(data.origins['myapp.eth']).toBeDefined();
      expect(data.origins['myapp.eth'].activeIdentityId).toBe('bee-wallet');
    });
  });

  describe('store migration', () => {
    test('migrates v1 app-scoped origin entries to v2 identities', () => {
      fs.writeFileSync(getFeedsFilePath(), JSON.stringify({
        version: 1,
        nextPublisherKeyIndex: 7,
        origins: {
          'myapp.eth': {
            identityMode: 'app-scoped',
            publisherKeyIndex: 3,
            feedGranted: true,
            grantedAt: 1234,
            feeds: {
              blog: {
                topic: 'topic',
                owner: 'owner',
                manifestReference: 'manifest',
                createdAt: 1300,
                lastUpdated: 1400,
                lastReference: 'reference',
              },
            },
          },
        },
      }), 'utf-8');

      const entry = getOriginEntry('myapp.eth');
      expect(entry.identityMode).toBe('app-scoped');
      expect(entry.publisherKeyIndex).toBe(3);
      expect(entry.activeIdentityId).toBe('app-scoped:3');
      expect(entry.identities['app-scoped:3']).toMatchObject({
        id: 'app-scoped:3',
        mode: 'app-scoped',
        publisherKeyIndex: 3,
        label: 'App-scoped identity 4',
        createdAt: 1234,
      });
      expect(entry.feeds.blog.identityId).toBe('app-scoped:3');

      const persisted = readFeedsFile();
      expect(persisted.version).toBe(2);
      expect(persisted.nextPublisherKeyIndex).toBe(7);
      expect(persisted.origins['myapp.eth'].feeds.blog.identityId).toBe('app-scoped:3');
      expect(fs.existsSync(path.join(tmpDir, 'swarm-feeds.v1-backup.json'))).toBe(true);
    });

    test('migrates v1 bee-wallet origin entries to v2 identities', () => {
      fs.writeFileSync(getFeedsFilePath(), JSON.stringify({
        version: 1,
        nextPublisherKeyIndex: 2,
        origins: {
          'beeapp.eth': {
            identityMode: 'bee-wallet',
            feedGranted: false,
            grantedAt: 2345,
            feeds: {},
          },
        },
      }), 'utf-8');

      const entry = getOriginEntry('beeapp.eth');
      expect(entry.identityMode).toBe('bee-wallet');
      expect(entry.publisherKeyIndex).toBeNull();
      expect(entry.activeIdentityId).toBe('bee-wallet');
      expect(entry.identities['bee-wallet']).toMatchObject({
        id: 'bee-wallet',
        mode: 'bee-wallet',
        publisherKeyIndex: null,
        label: 'Bee wallet identity',
      });
    });

    test('preserves missing version files instead of overwriting them', () => {
      fs.writeFileSync(getFeedsFilePath(), JSON.stringify({
        nextPublisherKeyIndex: 99,
        origins: {
          'myapp.eth': {
            identityMode: 'app-scoped',
            publisherKeyIndex: 0,
          },
        },
      }), 'utf-8');

      expect(getOriginEntry('myapp.eth')).toBeNull();
      const persisted = readFeedsFile();
      expect(persisted.version).toBeUndefined();
      expect(persisted.nextPublisherKeyIndex).toBe(99);
      expect(fs.existsSync(path.join(tmpDir, 'swarm-feeds.unsupported.json'))).toBe(true);
    });

    test('preserves unknown version files instead of overwriting them', () => {
      fs.writeFileSync(getFeedsFilePath(), JSON.stringify({
        version: 999,
        nextPublisherKeyIndex: 99,
        origins: {},
      }), 'utf-8');

      expect(getAllOriginEntries()).toEqual([]);
      const persisted = readFeedsFile();
      expect(persisted.version).toBe(999);
      expect(persisted.nextPublisherKeyIndex).toBe(99);
      expect(fs.existsSync(path.join(tmpDir, 'swarm-feeds.unsupported.json'))).toBe(true);
    });

    test('skips invalid v1 entries while migrating valid entries', () => {
      fs.writeFileSync(getFeedsFilePath(), JSON.stringify({
        version: 1,
        nextPublisherKeyIndex: 4,
        origins: {
          'valid.eth': {
            identityMode: 'app-scoped',
            publisherKeyIndex: 2,
            feedGranted: true,
            grantedAt: 1234,
            feeds: {},
          },
          'bad.eth': {
            identityMode: 'missing-mode',
            feedGranted: true,
            feeds: {},
          },
        },
      }), 'utf-8');

      expect(getOriginEntry('valid.eth')?.activeIdentityId).toBe('app-scoped:2');
      expect(getOriginEntry('bad.eth')).toBeNull();
      expect(readFeedsFile().origins['valid.eth']).toBeDefined();
      expect(readFeedsFile().origins['bad.eth']).toBeUndefined();
    });
  });

  describe('hasIdentityMode', () => {
    test('returns false for unknown origin', () => {
      expect(hasIdentityMode('unknown.eth')).toBe(false);
    });

    test('returns true after identity set', () => {
      setOriginEntry('myapp.eth', { identityMode: 'bee-wallet' });
      expect(hasIdentityMode('myapp.eth')).toBe(true);
    });
  });

  describe('feed grant lifecycle', () => {
    test('hasFeedGrant returns false for unknown origin', () => {
      expect(hasFeedGrant('unknown.eth')).toBe(false);
    });

    test('hasFeedGrant returns false after setOriginEntry without feedGranted', () => {
      setOriginEntry('myapp.eth', { identityMode: 'bee-wallet' });
      expect(hasFeedGrant('myapp.eth')).toBe(false);
    });

    test('hasFeedGrant returns true after setOriginEntry with feedGranted', () => {
      setOriginEntry('myapp.eth', { identityMode: 'bee-wallet', feedGranted: true });
      expect(hasFeedGrant('myapp.eth')).toBe(true);
    });

    test('grantFeedAccess sets feedGranted to true', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0 });
      expect(hasFeedGrant('myapp.eth')).toBe(false);
      grantFeedAccess('myapp.eth');
      expect(hasFeedGrant('myapp.eth')).toBe(true);
    });

    test('revokeFeedAccess clears feedGranted but preserves identity', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0, feedGranted: true });
      setFeed('myapp.eth', 'blog', { topic: 'a', owner: 'b', manifestReference: 'c' });

      revokeFeedAccess('myapp.eth');

      expect(hasFeedGrant('myapp.eth')).toBe(false);
      // Identity metadata preserved
      expect(hasIdentityMode('myapp.eth')).toBe(true);
      const entry = getOriginEntry('myapp.eth');
      expect(entry.identityMode).toBe('app-scoped');
      expect(entry.publisherKeyIndex).toBe(0);
      // Feeds preserved
      expect(getFeed('myapp.eth', 'blog')).not.toBeNull();
    });

    test('re-granting after revoke uses same identity', () => {
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 5, feedGranted: true });
      revokeFeedAccess('myapp.eth');
      grantFeedAccess('myapp.eth');

      const entry = getOriginEntry('myapp.eth');
      expect(entry.feedGranted).toBe(true);
      expect(entry.publisherKeyIndex).toBe(5); // Same key, not re-allocated
    });

    test('feedGranted survives cache reset', () => {
      setOriginEntry('myapp.eth', { identityMode: 'bee-wallet', feedGranted: true });
      _resetCache();
      expect(hasFeedGrant('myapp.eth')).toBe(true);
    });
  });

  // A permission manifest can own the feed grant and the publisher identity
  // of an origin. When the user changes either by hand, that ownership has to
  // be detached or the manifest record keeps claiming the flag and re-asserts
  // it on the next projection.
  describe('manifest ownership detach', () => {
    let mutations;

    beforeEach(() => {
      mutations = [];
      onManifestMutation((origin, projection) => mutations.push([origin, projection]));
      setOriginEntry('myapp.eth', { identityMode: 'app-scoped', publisherKeyIndex: 0, feedGranted: true });
      mutations.length = 0;
    });

    afterEach(() => {
      onManifestMutation(null);
    });

    test('a user revoking feed access detaches manifest ownership of the grant', () => {
      revokeFeedAccess('myapp.eth');
      expect(mutations).toEqual([['myapp.eth', 'feedGrant']]);
    });

    test('a manifest projecting the feed grant reports no user mutation', () => {
      revokeFeedAccess('myapp.eth', { source: 'manifest' });
      grantFeedAccess('myapp.eth', { source: 'manifest' });
      createAppScopedIdentity('myapp.eth', { activate: true, source: 'manifest' });
      expect(mutations).toEqual([]);
    });

    test('a user switching the publisher identity detaches manifest ownership of it', () => {
      createAppScopedIdentity('myapp.eth');
      expect(mutations).toEqual([['myapp.eth', 'identity']]);

      mutations.length = 0;
      activateIdentity('myapp.eth', 'app-scoped:0');
      expect(mutations).toEqual([['myapp.eth', 'identity']]);
    });

    test('re-activating the identity that is already active detaches nothing', () => {
      const entry = getOriginEntry('myapp.eth');
      activateIdentity('myapp.eth', entry.activeIdentityId);
      expect(mutations).toEqual([]);
    });

    test('a renderer cannot pass itself off as the manifest over IPC', async () => {
      registerFeedStoreIpc();
      await ipcHandlers[IPC.SWARM_CREATE_APP_SCOPED_IDENTITY]({}, 'myapp.eth', { source: 'manifest' });
      expect(mutations).toEqual([['myapp.eth', 'identity']]);
    });

    test('an unknown origin never reports a mutation', () => {
      revokeFeedAccess('nothing-here.eth');
      grantFeedAccess('nothing-here.eth');
      expect(mutations).toEqual([]);
    });
  });

  describe('IPC handlers', () => {
    beforeAll(() => {
      registerFeedStoreIpc();
    });

    test('registers expected channels', () => {
      expect(ipcHandlers[IPC.SWARM_HAS_FEED_IDENTITY]).toBeDefined();
      expect(ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]).toBeDefined();
      expect(ipcHandlers[IPC.SWARM_GET_ORIGIN_IDENTITIES]).toBeDefined();
      expect(ipcHandlers[IPC.SWARM_CREATE_APP_SCOPED_IDENTITY]).toBeDefined();
      expect(ipcHandlers[IPC.SWARM_ENSURE_ANT_WALLET_IDENTITY]).toBeDefined();
      expect(ipcHandlers[IPC.SWARM_ACTIVATE_FEED_IDENTITY]).toBeDefined();
      // #89: the request that made an ethereum-wallet identity is gone.
      expect(IPC.SWARM_ENSURE_ETHEREUM_WALLET_IDENTITY).toBeUndefined();
      expect(ipcHandlers['swarm:ensure-ethereum-wallet-identity']).toBeUndefined();
      // A feed prompt's new identity is previewed and its grant read by main
      // (page/page-swarm.js): the chrome's old route to them is gone (PRQ-9).
      expect(ipcHandlers['swarm:preview-app-scoped-identity']).toBeUndefined();
      expect(ipcHandlers['swarm:has-feed-grant']).toBeUndefined();
    });

    test('has-feed-identity returns false for unknown origin', () => {
      _resetCache();
      const result = ipcHandlers[IPC.SWARM_HAS_FEED_IDENTITY]({}, 'unknown.eth');
      expect(result).toBe(false);
    });

    // freedom-core design 0011, PRQ-7d: the chrome's feed grant is refused,
    // for every site and mode, with nothing written. Main grants feed access
    // from its own feed prompt (page/page-swarm-feeds.test.js covers the
    // grant, #89's refusal included).
    test('set-feed-identity is refused for every site and mode, writing nothing', async () => {
      _resetCache();
      setOriginEntry('ipc-revoked.eth', { identityMode: 'app-scoped', feedGranted: true });
      await ipcHandlers[IPC.SWARM_REVOKE_FEED_ACCESS]({}, 'ipc-revoked.eth');
      for (const origin of ['ipc-new.eth', 'ipc-revoked.eth']) {
        for (const mode of ['app-scoped', 'bee-wallet', 'ethereum-wallet', 'invalid']) {
          expect(() => ipcHandlers[IPC.SWARM_SET_FEED_IDENTITY]({}, origin, mode)).toThrow(
            'Swarm feed access is granted only from its own prompt'
          );
        }
      }
      expect(getOriginEntry('ipc-new.eth')).toBeNull();
      expect(hasFeedGrant('ipc-revoked.eth')).toBe(false);
    });

    test('has-feed-identity returns true after identity set', async () => {
      _resetCache();
      setOriginEntry('ipc-test2.eth', { identityMode: 'bee-wallet', feedGranted: true });
      const result = ipcHandlers[IPC.SWARM_HAS_FEED_IDENTITY]({}, 'ipc-test2.eth');
      expect(result).toBe(true);
    });

    test('revoke-feed-access clears feed grant', async () => {
      _resetCache();
      setOriginEntry('ipc-revoke.eth', { identityMode: 'bee-wallet', feedGranted: true });
      expect(hasFeedGrant('ipc-revoke.eth')).toBe(true);
      await ipcHandlers[IPC.SWARM_REVOKE_FEED_ACCESS]({}, 'ipc-revoke.eth');
      expect(hasFeedGrant('ipc-revoke.eth')).toBe(false);
      // Identity preserved
      expect(hasIdentityMode('ipc-revoke.eth')).toBe(true);
    });

    test('identity management IPC creates, ensures, and activates identities', async () => {
      _resetCache();
      setOriginEntry('ipc-manage.eth', { identityMode: 'app-scoped', feedGranted: true });

      const withNewIdentity = await ipcHandlers[IPC.SWARM_CREATE_APP_SCOPED_IDENTITY]({}, 'ipc-manage.eth', {
        label: 'Second identity',
      });
      expect(withNewIdentity.activeIdentityId).toBe('app-scoped:1');
      expect(withNewIdentity.identities.find((identity) => identity.id === 'app-scoped:1')).toMatchObject({
        label: 'Second identity',
        owner: '0xPublisher1',
        stored: true,
      });

      const withBeeIdentity = await ipcHandlers[IPC.SWARM_ENSURE_ANT_WALLET_IDENTITY]({}, 'ipc-manage.eth');
      expect(withBeeIdentity.activeIdentityId).toBe('app-scoped:1');
      expect(withBeeIdentity.identities.find((identity) => identity.id === 'bee-wallet')).toMatchObject({
        owner: '0xBee0000000000000000000000000000000000000',
        stored: true,
      });

      const switched = await ipcHandlers[IPC.SWARM_ACTIVATE_FEED_IDENTITY]({}, 'ipc-manage.eth', 'bee-wallet');
      expect(switched.activeIdentityId).toBe('bee-wallet');
      expect(switched.identityMode).toBe('bee-wallet');

      // A stored ethereum-wallet identity (#89) is listed, unavailable, and
      // activating it fails.
      storeWalletIdentity('ipc-manage.eth', 2, { active: false });
      await expect(ipcHandlers[IPC.SWARM_ACTIVATE_FEED_IDENTITY]({}, 'ipc-manage.eth', 'ethereum-wallet:2'))
        .rejects.toThrow(UNAVAILABLE);

      const state = await ipcHandlers[IPC.SWARM_GET_ORIGIN_IDENTITIES]({}, 'ipc-manage.eth');
      expect(state.activeIdentityId).toBe('bee-wallet');
      // Oldest first: the stored identity predates the others.
      expect(state.identities.map((identity) => [identity.id, !!identity.unavailable])).toEqual([
        ['ethereum-wallet:2', true],
        ['app-scoped:0', false],
        ['app-scoped:1', false],
        ['bee-wallet', false],
      ]);
    });

    // freedom-core design 0011, PRQ-7d (Codex round 1 on #1201): main
    // creates the new identity a feed prompt showed on exactly its key.
    test('createAppScopedIdentityAt takes exactly the key it names, or throws with nothing written', async () => {
      _resetCache();
      const preview = await previewAppScopedIdentity('at.eth');
      expect(preview.publisherKeyIndex).toBe(0);
      // Another site takes that key first.
      createAppScopedIdentity('other.eth', { activate: true });
      expect(() => createAppScopedIdentityAt('at.eth', preview.publisherKeyIndex, { activate: true })).toThrow(
        expect.objectContaining({ code: 'identity_taken' })
      );
      expect(getOriginEntry('at.eth')).toBeNull();
      // The key now next is taken as named.
      const entry = createAppScopedIdentityAt('at.eth', 1, { activate: true });
      expect(entry).toMatchObject({ activeIdentityId: 'app-scoped:1', publisherKeyIndex: 1 });
    });

    test('previewAppScopedIdentity does not allocate or persist until approval', async () => {
      _resetCache();

      const preview = await previewAppScopedIdentity('preview.eth');

      expect(preview).toMatchObject({
        id: 'app-scoped:0',
        mode: 'app-scoped',
        publisherKeyIndex: 0,
        owner: '0xPublisher0',
        stored: false,
        preview: true,
      });
      expect(getOriginEntry('preview.eth')).toBeNull();
      expect(allocatePublisherKeyIndex()).toBe(0);
    });

    test('get-origin-identities includes Bee wallet as an available identity', async () => {
      _resetCache();
      setOriginEntry('ipc-available.eth', { identityMode: 'app-scoped', feedGranted: true });

      const state = await ipcHandlers[IPC.SWARM_GET_ORIGIN_IDENTITIES]({}, 'ipc-available.eth');
      const beeIdentity = state.identities.find((identity) => identity.id === 'bee-wallet');

      expect(beeIdentity).toMatchObject({
        mode: 'bee-wallet',
        owner: '0xBee0000000000000000000000000000000000000',
        stored: false,
      });
    });

    test('get-origin-identities offers no wallet account (#89)', async () => {
      _resetCache();
      setOriginEntry('ipc-wallets.eth', { identityMode: 'app-scoped', feedGranted: true });

      const state = await ipcHandlers[IPC.SWARM_GET_ORIGIN_IDENTITIES]({}, 'ipc-wallets.eth');

      expect(state.identities.filter((identity) => identity.mode === 'ethereum-wallet')).toEqual([]);
    });

    test('get-origin-identities requires unlocked vault for owner inspection', async () => {
      _resetCache();
      setOriginEntry('ipc-locked.eth', { identityMode: 'app-scoped', feedGranted: true });
      mockGetDerivedKeys.mockReturnValue(null);

      await expect(ipcHandlers[IPC.SWARM_GET_ORIGIN_IDENTITIES]({}, 'ipc-locked.eth'))
        .rejects.toThrow('Vault must be unlocked');
    });
  });
});
