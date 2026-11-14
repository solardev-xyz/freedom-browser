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

const { useSimulatedGrantCore, testPage } = require('../../../test/helpers/simulated-grant-core');

// Must require after mocks are set up
const {
  getPermission,
  grantPermission,
  revokePermission,
  getAllPermissions,
  updateLastUsed,
  getAutoApprove,
  setAutoApprove,
  grantMessaging,
  revokeMessaging,
  hasMessagingGrant,
  onRevoke,
  registerSwarmPermissionsIpc,
} = require('./swarm-permissions');

// The identity core writes swarm-permissions.json (freedom-core design
// 0012, APB-3): the store reads the core's records and sends each change
// to it, a page's under `page` for its own key.
let core;
const page = (origin) => ({ page: testPage(origin) });

beforeEach(async () => {
  core = await useSimulatedGrantCore();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('swarm-permissions', () => {
  describe('CRUD', () => {
    test('getPermission returns null for unknown origin', async () => {
      expect(getPermission('unknown.eth')).toBeNull();
    });

    test('grantPermission creates entry with correct schema', async () => {
      const perm = await grantPermission('myapp.eth', page('myapp.eth'));
      expect(perm).toEqual({
        origin: 'myapp.eth',
        connectedAt: expect.any(Number),
        lastUsed: expect.any(Number),
        autoApprove: { publish: false, feeds: false, signing: false, messaging: false },
      });
    });

    test('supports signing auto-approve separately from feeds', async () => {
      await grantPermission('myapp.eth', page('myapp.eth'));

      expect(getAutoApprove('myapp.eth', 'feeds')).toBe(false);
      expect(getAutoApprove('myapp.eth', 'signing')).toBe(false);

      expect(await setAutoApprove('myapp.eth', 'signing', true, page('myapp.eth'))).toBe(true);
      expect(getAutoApprove('myapp.eth', 'feeds')).toBe(false);
      expect(getAutoApprove('myapp.eth', 'signing')).toBe(true);
    });

    test('messaging grant requires connection and persists on the entry', async () => {
      expect(await grantMessaging('myapp.eth', page('myapp.eth'))).toBe(false);
      expect(hasMessagingGrant('myapp.eth')).toBe(false);

      await grantPermission('myapp.eth', page('myapp.eth'));
      expect(hasMessagingGrant('myapp.eth')).toBe(false);

      expect(await grantMessaging('myapp.eth', page('myapp.eth'))).toBe(true);
      expect(hasMessagingGrant('myapp.eth')).toBe(true);
      expect(getPermission('myapp.eth').messaging.grantedAt).toEqual(expect.any(Number));

      await revokePermission('myapp.eth');
      expect(hasMessagingGrant('myapp.eth')).toBe(false);
    });

    test('revocation notifies the registered revoke listener', async () => {
      const listener = jest.fn();
      const secondListener = jest.fn();
      onRevoke(listener);
      onRevoke(secondListener);
      await grantPermission('myapp.eth', page('myapp.eth'));

      await revokePermission('myapp.eth');
      expect(listener).toHaveBeenCalledWith('myapp.eth');
      expect(secondListener).toHaveBeenCalledWith('myapp.eth');

      listener.mockClear();
      await revokePermission('myapp.eth');
      expect(listener).not.toHaveBeenCalled();
      onRevoke(null);
    });

    test('messaging revocation cancels live resources without dropping the base grant', async () => {
      const listener = jest.fn();
      onRevoke(listener);
      await grantPermission('myapp.eth', page('myapp.eth'));
      await grantMessaging('myapp.eth', page('myapp.eth'));

      expect(await revokeMessaging('myapp.eth')).toBe(true);
      expect(listener).toHaveBeenCalledWith('myapp.eth');
      expect(getPermission('myapp.eth')).not.toBeNull();
      expect(hasMessagingGrant('myapp.eth')).toBe(false);
      onRevoke(null);
    });

    test('supports messaging auto-approve as a distinct type', async () => {
      await grantPermission('myapp.eth', page('myapp.eth'));
      expect(getAutoApprove('myapp.eth', 'messaging')).toBe(false);
      expect(await setAutoApprove('myapp.eth', 'messaging', true, page('myapp.eth'))).toBe(true);
      expect(getAutoApprove('myapp.eth', 'messaging')).toBe(true);
      expect(getAutoApprove('myapp.eth', 'publish')).toBe(false);
    });

    test('getPermission returns entry after grant', async () => {
      await grantPermission('myapp.eth', page('myapp.eth'));
      const perm = getPermission('myapp.eth');
      expect(perm).not.toBeNull();
      expect(perm.origin).toBe('myapp.eth');
    });

    test('grantPermission normalizes origin', async () => {
      await grantPermission('bzz://ABC123/path', page('bzz://ABC123'));
      expect(getPermission('bzz://ABC123')).not.toBeNull();
      expect(getPermission('bzz://ABC123')?.origin).toBe('bzz://ABC123');
    });

    test('revokePermission removes entry', async () => {
      await grantPermission('myapp.eth', page('myapp.eth'));
      expect(await revokePermission('myapp.eth')).toBe(true);
      expect(getPermission('myapp.eth')).toBeNull();
    });

    test('revokePermission returns false for unknown origin', async () => {
      expect(await revokePermission('unknown.eth')).toBe(false);
    });

    test('getAllPermissions returns sorted by lastUsed desc', async () => {
      const realDateNow = Date.now;
      let mockTime = 1000;
      Date.now = () => mockTime;
      try {
        await grantPermission('first.eth', page('first.eth'));
        mockTime = 2000;
        await grantPermission('second.eth', page('second.eth'));
        const sorted = getAllPermissions();
        expect(sorted).toHaveLength(2);
        expect(sorted[0].origin).toBe('second.eth');
        expect(sorted[1].origin).toBe('first.eth');
      } finally {
        Date.now = realDateNow;
      }
    });

    test('updateLastUsed updates timestamp', async () => {
      await grantPermission('myapp.eth', page('myapp.eth'));
      const original = getPermission('myapp.eth').lastUsed;
      // Small delay to ensure different timestamp
      const result = await updateLastUsed('myapp.eth', page('myapp.eth'));
      expect(result).toBe(true);
      expect(getPermission('myapp.eth').lastUsed).toBeGreaterThanOrEqual(original);
    });

    test('updateLastUsed returns false for unknown origin', async () => {
      expect(await updateLastUsed('unknown.eth', page('unknown.eth'))).toBe(false);
    });
  });

  describe('through the identity core', () => {
    test('a page writes its own key, under page', async () => {
      await grantPermission('myapp.eth', page('myapp.eth'));
      await setAutoApprove('myapp.eth', 'publish', true, page('myapp.eth'));
      await grantMessaging('myapp.eth', page('myapp.eth'));
      await updateLastUsed('myapp.eth', page('myapp.eth'));
      expect(core.calls.map(({ method, params, caller }) => [method, params, caller])).toEqual([
        ['approval.grant', { store: 'swarm', change: { op: 'connect' } }, 'page'],
        ['approval.grant', { store: 'swarm', change: { op: 'flag', flag: 'publish' } }, 'page'],
        ['approval.grant', { store: 'swarm', change: { op: 'messaging' } }, 'page'],
        ['approval.touch', { store: 'swarm' }, 'page'],
      ]);
      await expect(grantPermission('other.eth', page('myapp.eth'))).rejects.toThrow(
        'A page changes only its own Swarm grant'
      );
    });

    test("a manifest's projection is main's own (shell), naming the key", async () => {
      await grantPermission('myapp.eth', { source: 'manifest' });
      await setAutoApprove('myapp.eth', 'feeds', true, { source: 'manifest' });
      await grantMessaging('myapp.eth', { source: 'manifest' });
      await revokeMessaging('myapp.eth', { source: 'manifest' });
      await setAutoApprove('myapp.eth', 'feeds', false, { source: 'manifest' });
      await revokePermission('myapp.eth', { source: 'manifest' });
      expect(core.calls.map(({ method, params, caller }) => [method, params, caller])).toEqual([
        ['approval.grant', { store: 'swarm', change: { op: 'connect', key: 'myapp.eth' } }, 'shell'],
        ['approval.grant', { store: 'swarm', change: { op: 'flag', flag: 'feeds', key: 'myapp.eth' } }, 'shell'],
        ['approval.grant', { store: 'swarm', change: { op: 'messaging', key: 'myapp.eth' } }, 'shell'],
        ['approval.revoke', { store: 'swarm', key: 'myapp.eth', what: 'messaging' }, 'shell'],
        ['approval.revoke', { store: 'swarm', key: 'myapp.eth', what: { flag: 'feeds' } }, 'shell'],
        ['approval.revoke', { store: 'swarm', key: 'myapp.eth', what: 'grant' }, 'shell'],
      ]);
    });

    test("the chrome's changes only narrow; a widening needs a page or a manifest", async () => {
      await grantPermission('myapp.eth', page('myapp.eth'));
      await grantMessaging('myapp.eth', page('myapp.eth'));
      core.calls.length = 0;
      await expect(grantPermission('myapp.eth')).rejects.toThrow('A Swarm grant is written only from its prompt or a manifest');
      await expect(setAutoApprove('myapp.eth', 'publish', true)).rejects.toThrow('A Swarm grant');
      await expect(grantMessaging('myapp.eth')).rejects.toThrow('A Swarm grant');
      expect(core.calls).toEqual([]);
      expect(await setAutoApprove('myapp.eth', 'publish', false)).toBe(true);
      expect(await revokeMessaging('myapp.eth')).toBe(true);
      expect(await revokePermission('myapp.eth')).toBe(true);
      expect(core.calls.map(({ method, caller }) => [method, caller])).toEqual([
        ['approval.revoke', 'chrome'],
        ['approval.revoke', 'chrome'],
        ['approval.revoke', 'chrome'],
      ]);
    });

    test('a last use is only a page\'s', async () => {
      await grantPermission('myapp.eth', page('myapp.eth'));
      core.calls.length = 0;
      expect(await updateLastUsed('myapp.eth')).toBe(false);
      expect(core.calls).toEqual([]);
    });

    test('reads are the core\'s records, as main last read them', async () => {
      core = await useSimulatedGrantCore({
        swarm: {
          'seeded.eth': {
            origin: 'seeded.eth',
            connectedAt: 1,
            lastUsed: 2,
            autoApprove: { publish: true, feeds: false, signing: false, messaging: false },
            messaging: { grantedAt: 3 },
          },
        },
      });
      expect(getAutoApprove('seeded.eth', 'publish')).toBe(true);
      expect(hasMessagingGrant('seeded.eth')).toBe(true);
      // A copy: changing it changes nothing main reads.
      getPermission('seeded.eth').autoApprove.publish = false;
      expect(getAutoApprove('seeded.eth', 'publish')).toBe(true);
    });

    test('a widening the core could not save is not applied, and rejects', async () => {
      core.failNext('approval.grant', Object.assign(new Error('The permission file could not be written'), {
        code: 'storage',
        data: { store: 'swarm', applied: false },
      }));
      await expect(grantPermission('myapp.eth', page('myapp.eth'))).rejects.toMatchObject({ code: 'storage' });
      expect(getPermission('myapp.eth')).toBeNull();
    });

    test('a narrowing the core could not save stands', async () => {
      await grantPermission('myapp.eth', page('myapp.eth'));
      core.failNext('approval.revoke', Object.assign(new Error('The permission file could not be written'), {
        code: 'storage',
        data: { store: 'swarm', applied: true },
      }));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await revokePermission('myapp.eth')).toBe(true);
      expect(getPermission('myapp.eth')).toBeNull();
      warn.mockRestore();
    });
  });

  describe('IPC handlers', () => {
    beforeAll(() => {
      registerSwarmPermissionsIpc();
    });

    test('registers the grant channels', () => {
      expect(ipcHandlers['swarm:get-permission']).toBeDefined();
      expect(ipcHandlers['swarm:grant-permission']).toBeDefined();
      expect(ipcHandlers['swarm:revoke-permission']).toBeDefined();
      expect(ipcHandlers['swarm:get-all-permissions']).toBeDefined();
      // Main marks a site used and reads its rules itself, for a page's
      // request it serves (freedom-core design 0011, PRQ-9).
      expect(ipcHandlers['swarm:update-last-used']).toBeUndefined();
      expect(ipcHandlers['swarm:get-auto-approve']).toBeUndefined();
    });

    test('get-permission handler works', async () => {
      await grantPermission('ipc-test.eth', page('ipc-test.eth'));
      const result = ipcHandlers['swarm:get-permission']({}, 'ipc-test.eth');
      expect(result).not.toBeNull();
      expect(result.origin).toBe('ipc-test.eth');
    });
  });
});
