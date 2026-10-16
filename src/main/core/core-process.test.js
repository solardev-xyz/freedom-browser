const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '0.0.0-test',
    getPath: () => '/nonexistent/appData',
  },
}));
jest.mock('../logger', () => mockLog);
jest.mock('../profile-paths', () => ({ getIdentityDataDir: () => '/nonexistent/data' }));
jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  }),
}));

describe('core-process', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FREEDOM_CORE = '1';
    process.env.FREEDOM_CORED_PATH = '/nonexistent/freedom-cored';
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  test('a core that gives up is logged once, by the client', async () => {
    const { startCore, getCoreClient } = require('./core-process');
    await expect(startCore()).resolves.toBeNull();
    expect(getCoreClient().state).toBe('failed');
    const lines = mockLog.error.mock.calls.map((call) => call[0]);
    expect(lines).toEqual(['[Core] spawn failed', '[Core] giving up']);
    expect(mockLog.error).toHaveBeenCalledWith('[Core] spawn failed', {
      code: 'ENOENT',
      path: '/nonexistent/freedom-cored',
    });
  });
});
