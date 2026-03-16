const ipcHandlers = {};
jest.mock('electron', () => ({
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

const mockGetPermission = jest.fn();
jest.mock('./swarm-permissions', () => ({
  getPermission: mockGetPermission,
}));

const mockGetBeeApiUrl = jest.fn();
jest.mock('../service-registry', () => ({
  getBeeApiUrl: mockGetBeeApiUrl,
}));

// Mock global fetch for pre-flight checks
global.fetch = jest.fn();

const { registerSwarmProviderIpc, executeSwarmMethod, checkSwarmPreFlight, LIMITS } = require('./swarm-provider-ipc');

registerSwarmProviderIpc();

async function invokeProvider(method, params, origin) {
  const handler = ipcHandlers['swarm:provider-execute'];
  return handler({}, { method, params, origin });
}

describe('swarm-provider-ipc', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('registers swarm:provider-execute handler', () => {
    expect(ipcHandlers['swarm:provider-execute']).toBeDefined();
  });

  describe('method dispatch', () => {
    test('unknown method returns 4200', async () => {
      const result = await invokeProvider('swarm_unknownMethod', {}, 'test.eth');
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(4200);
      expect(result.error.message).toContain('Unknown method');
    });

    test('missing method returns -32602', async () => {
      const result = await invokeProvider(null, {}, 'test.eth');
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32602);
    });

    test('empty string method returns -32602', async () => {
      const result = await invokeProvider('', {}, 'test.eth');
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32602);
    });
  });

  describe('swarm_requestAccess', () => {
    test('returns connected for authorized origin', async () => {
      mockGetPermission.mockReturnValue({ origin: 'myapp.eth', connectedAt: 1, lastUsed: 1, autoPublish: false });
      const result = await invokeProvider('swarm_requestAccess', {}, 'myapp.eth');
      expect(result.result).toEqual({
        connected: true,
        origin: 'myapp.eth',
        capabilities: ['publish'],
      });
    });

    test('returns 4100 for unauthorized origin', async () => {
      mockGetPermission.mockReturnValue(null);
      const result = await invokeProvider('swarm_requestAccess', {}, 'unknown.eth');
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(4100);
    });
  });

  describe('swarm_getCapabilities', () => {
    test('returns full capabilities when node is ready', async () => {
      mockGetPermission.mockReturnValue({ origin: 'myapp.eth' });
      mockGetBeeApiUrl.mockReturnValue('http://127.0.0.1:1633');
      global.fetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ beeMode: 'light' }) })      // /node
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ready' }) })         // /readiness
        .mockResolvedValueOnce({ ok: true, json: async () => ({ stamps: [{ usable: true }] }) }); // /stamps

      const result = await invokeProvider('swarm_getCapabilities', {}, 'myapp.eth');
      expect(result.result).toEqual({
        canPublish: true,
        reason: null,
        limits: {
          maxDataBytes: LIMITS.maxDataBytes,
          maxFilesBytes: LIMITS.maxFilesBytes,
          maxFileCount: LIMITS.maxFileCount,
        },
      });
    });

    test('returns canPublish false when node is stopped', async () => {
      mockGetPermission.mockReturnValue({ origin: 'myapp.eth' });
      mockGetBeeApiUrl.mockReturnValue(null);

      const result = await invokeProvider('swarm_getCapabilities', {}, 'myapp.eth');
      expect(result.result.canPublish).toBe(false);
      expect(result.result.reason).toBe('node-stopped');
    });

    test('returns canPublish false in ultra-light mode', async () => {
      mockGetPermission.mockReturnValue({ origin: 'myapp.eth' });
      mockGetBeeApiUrl.mockReturnValue('http://127.0.0.1:1633');
      global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ beeMode: 'ultra-light' }) });

      const result = await invokeProvider('swarm_getCapabilities', {}, 'myapp.eth');
      expect(result.result.canPublish).toBe(false);
      expect(result.result.reason).toBe('ultra-light-mode');
    });

    test('returns canPublish false with no usable stamps', async () => {
      mockGetPermission.mockReturnValue({ origin: 'myapp.eth' });
      mockGetBeeApiUrl.mockReturnValue('http://127.0.0.1:1633');
      global.fetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ beeMode: 'light' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ready' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ stamps: [] }) });

      const result = await invokeProvider('swarm_getCapabilities', {}, 'myapp.eth');
      expect(result.result.canPublish).toBe(false);
      expect(result.result.reason).toBe('no-usable-stamps');
    });

    test('returns not-connected when origin has no permission', async () => {
      mockGetPermission.mockReturnValue(null);
      mockGetBeeApiUrl.mockReturnValue('http://127.0.0.1:1633');
      global.fetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ beeMode: 'light' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ready' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ stamps: [{ usable: true }] }) });

      const result = await invokeProvider('swarm_getCapabilities', {}, 'unknown.eth');
      expect(result.result.canPublish).toBe(false);
      expect(result.result.reason).toBe('not-connected');
    });

    test('always includes limits', async () => {
      mockGetPermission.mockReturnValue(null);
      mockGetBeeApiUrl.mockReturnValue(null);

      const result = await invokeProvider('swarm_getCapabilities', {}, 'test.eth');
      expect(result.result.limits).toEqual({
        maxDataBytes: LIMITS.maxDataBytes,
        maxFilesBytes: LIMITS.maxFilesBytes,
        maxFileCount: LIMITS.maxFileCount,
      });
    });
  });

  describe('stubbed methods', () => {
    test('swarm_publishData returns 4200 not yet implemented', async () => {
      mockGetPermission.mockReturnValue({ origin: 'myapp.eth' });
      const result = await invokeProvider('swarm_publishData', {}, 'myapp.eth');
      expect(result.error.code).toBe(4200);
      expect(result.error.message).toContain('not yet implemented');
    });

    test('swarm_publishFiles returns 4200 not yet implemented', async () => {
      mockGetPermission.mockReturnValue({ origin: 'myapp.eth' });
      const result = await invokeProvider('swarm_publishFiles', {}, 'myapp.eth');
      expect(result.error.code).toBe(4200);
    });

    test('swarm_getUploadStatus returns 4200 not yet implemented', async () => {
      mockGetPermission.mockReturnValue({ origin: 'myapp.eth' });
      const result = await invokeProvider('swarm_getUploadStatus', {}, 'myapp.eth');
      expect(result.error.code).toBe(4200);
    });

    test('stubbed methods require permission', async () => {
      mockGetPermission.mockReturnValue(null);
      const result = await invokeProvider('swarm_publishData', {}, 'unauthorized.eth');
      expect(result.error.code).toBe(4100);
    });
  });

  describe('checkSwarmPreFlight', () => {
    test('returns ok when all checks pass', async () => {
      mockGetBeeApiUrl.mockReturnValue('http://127.0.0.1:1633');
      global.fetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ beeMode: 'light' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ready' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ stamps: [{ usable: true }] }) });

      const result = await checkSwarmPreFlight();
      expect(result).toEqual({ ok: true });
    });

    test('returns node-stopped when no Bee URL', async () => {
      mockGetBeeApiUrl.mockReturnValue(null);
      const result = await checkSwarmPreFlight();
      expect(result).toEqual({ ok: false, reason: 'node-stopped' });
    });

    test('handles fetch errors gracefully', async () => {
      mockGetBeeApiUrl.mockReturnValue('http://127.0.0.1:1633');
      global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await checkSwarmPreFlight();
      expect(result).toEqual({ ok: false, reason: 'node-stopped' });
    });
  });
});
