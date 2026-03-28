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

const { app } = require('electron');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-perms-test-'));
  app.getPath.mockReturnValue(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Must require after mocks are set up
const {
  getPermission,
  grantPermission,
  revokePermission,
  getAllPermissions,
  updateLastUsed,
  registerSwarmPermissionsIpc,
  _resetCache,
} = require('./swarm-permissions');

beforeEach(() => {
  _resetCache();
});

describe('swarm-permissions', () => {
  describe('CRUD', () => {
    test('getPermission returns null for unknown origin', () => {
      expect(getPermission('unknown.eth')).toBeNull();
    });

    test('grantPermission creates entry with correct schema', () => {
      const perm = grantPermission('myapp.eth');
      expect(perm).toEqual({
        origin: 'myapp.eth',
        connectedAt: expect.any(Number),
        lastUsed: expect.any(Number),
        autoApprove: { publish: false, feeds: false },
      });
    });

    test('getPermission returns entry after grant', () => {
      grantPermission('myapp.eth');
      const perm = getPermission('myapp.eth');
      expect(perm).not.toBeNull();
      expect(perm.origin).toBe('myapp.eth');
    });

    test('grantPermission normalizes origin', () => {
      grantPermission('bzz://ABC123/path');
      expect(getPermission('bzz://ABC123')).not.toBeNull();
      expect(getPermission('bzz://ABC123')?.origin).toBe('bzz://ABC123');
    });

    test('revokePermission removes entry', () => {
      grantPermission('myapp.eth');
      expect(revokePermission('myapp.eth')).toBe(true);
      expect(getPermission('myapp.eth')).toBeNull();
    });

    test('revokePermission returns false for unknown origin', () => {
      expect(revokePermission('unknown.eth')).toBe(false);
    });

    test('getAllPermissions returns sorted by lastUsed desc', () => {
      const realDateNow = Date.now;
      let mockTime = 1000;
      Date.now = () => mockTime;
      try {
        grantPermission('first.eth');
        mockTime = 2000;
        grantPermission('second.eth');
        const sorted = getAllPermissions();
        expect(sorted).toHaveLength(2);
        expect(sorted[0].origin).toBe('second.eth');
        expect(sorted[1].origin).toBe('first.eth');
      } finally {
        Date.now = realDateNow;
      }
    });

    test('updateLastUsed updates timestamp', () => {
      grantPermission('myapp.eth');
      const original = getPermission('myapp.eth').lastUsed;
      // Small delay to ensure different timestamp
      const result = updateLastUsed('myapp.eth');
      expect(result).toBe(true);
      expect(getPermission('myapp.eth').lastUsed).toBeGreaterThanOrEqual(original);
    });

    test('updateLastUsed returns false for unknown origin', () => {
      expect(updateLastUsed('unknown.eth')).toBe(false);
    });
  });

  describe('persistence', () => {
    test('data survives cache reset', () => {
      grantPermission('myapp.eth');
      _resetCache();
      const perm = getPermission('myapp.eth');
      expect(perm).not.toBeNull();
      expect(perm.origin).toBe('myapp.eth');
    });

    test('writes to disk', () => {
      grantPermission('myapp.eth');
      const filePath = path.join(tmpDir, 'swarm-permissions.json');
      expect(fs.existsSync(filePath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data['myapp.eth']).toBeDefined();
    });
  });

  describe('IPC handlers', () => {
    beforeAll(() => {
      registerSwarmPermissionsIpc();
    });

    test('registers all 5 channels', () => {
      expect(ipcHandlers['swarm:get-permission']).toBeDefined();
      expect(ipcHandlers['swarm:grant-permission']).toBeDefined();
      expect(ipcHandlers['swarm:revoke-permission']).toBeDefined();
      expect(ipcHandlers['swarm:get-all-permissions']).toBeDefined();
      expect(ipcHandlers['swarm:update-last-used']).toBeDefined();
    });

    test('get-permission handler works', () => {
      _resetCache();
      grantPermission('ipc-test.eth');
      const result = ipcHandlers['swarm:get-permission']({}, 'ipc-test.eth');
      expect(result).not.toBeNull();
      expect(result.origin).toBe('ipc-test.eth');
    });
  });
});
