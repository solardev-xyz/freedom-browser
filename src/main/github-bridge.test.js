const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter: MockEventEmitter } = require('events');

const mockDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-github-bridge-'));
const mockTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-github-import-'));
const mockHandlers = new Map();
const mockIpcMain = { handle: jest.fn((channel, fn) => mockHandlers.set(channel, fn)) };

const mockExecFile = jest.fn((command, args, options, callback) => {
  const cb = typeof options === 'function' ? options : callback;
  let stdout = '';
  if (command === 'git' && args[0] === '--version') stdout = 'git version 2.50.0\n';
  if (command === 'git' && args[0] === 'symbolic-ref') stdout = 'main\n';
  cb(null, { stdout, stderr: '' });
});

const mockEmbedded = {
  isAvailable: jest.fn(() => true),
  listRepos: jest.fn(async () => []),
  importRepo: jest.fn(async () => ({ rid: 'rad:z6mkt4nativeimport123' })),
};

jest.mock('electron', () => ({ ipcMain: mockIpcMain }));
jest.mock('child_process', () => ({ execFile: mockExecFile }));
jest.mock('./radicle-manager', () => ({
  getRadicleDataPath: jest.fn(() => mockDataDir),
  getCurrentStatus: jest.fn(() => ({ status: 'running', error: null })),
  isDisabledForProfile: jest.fn(() => false),
  STATUS: { RUNNING: 'running' },
}));
jest.mock('./radicle-embedded', () => mockEmbedded);
jest.mock('./profile-paths', () => ({
  createProfileTempDir: jest.fn(() =>
    require('fs').mkdtempSync(require('path').join(mockTempRoot, 'run-'))
  ),
}));
jest.mock('https', () => ({
  request: jest.fn((_url, _opts, callback) => {
    const response = new MockEventEmitter();
    response.statusCode = 200;
    response.resume = jest.fn();
    queueMicrotask(() => callback(response));
    return Object.assign(new MockEventEmitter(), { end: jest.fn(), destroy: jest.fn() });
  }),
  get: jest.fn((_url, _opts, callback) => {
    const response = new MockEventEmitter();
    queueMicrotask(() => {
      callback(response);
      response.emit('data', JSON.stringify({ description: 'Native project' }));
      response.emit('end');
    });
    return Object.assign(new MockEventEmitter(), { destroy: jest.fn() });
  }),
}));

const IPC = require('../shared/ipc-channels');
const { registerGithubBridgeIpc, validateGitHubUrl, cleanupTempDirs } = require('./github-bridge');

beforeAll(() => registerGithubBridgeIpc());
afterEach(() => jest.clearAllMocks());
afterAll(() => {
  cleanupTempDirs();
  fs.rmSync(mockDataDir, { recursive: true, force: true });
  fs.rmSync(mockTempRoot, { recursive: true, force: true });
});

test('validates GitHub URLs and shorthand', () => {
  expect(validateGitHubUrl('https://github.com/openai/project')).toMatchObject({
    valid: true, owner: 'openai', repo: 'project',
  });
  expect(validateGitHubUrl('openai/project')).toMatchObject({ valid: true });
  expect(validateGitHubUrl('not a repo')).toMatchObject({ valid: false });
});

test('native addon is the only Radicle import prerequisite', async () => {
  await expect(mockHandlers.get(IPC.GITHUB_BRIDGE_CHECK_PREREQUISITES)()).resolves.toMatchObject({
    success: true,
    gitVersion: 'git version 2.50.0',
  });
});

test('detects native repositories by the persisted source description', async () => {
  mockEmbedded.listRepos.mockResolvedValueOnce([
    { rid: 'rad:z6mkt4existing123', description: 'Imported from github.com/openai/project' },
  ]);
  await expect(
    mockHandlers.get(IPC.GITHUB_BRIDGE_CHECK_EXISTING)(null, 'https://github.com/openai/project')
  ).resolves.toMatchObject({ success: true, bridged: true, rid: 'z6mkt4existing123' });
});

test('imports a GitHub checkout directly through libradicle', async () => {
  const sender = { isDestroyed: () => false, send: jest.fn() };
  await expect(
    mockHandlers.get(IPC.GITHUB_BRIDGE_IMPORT)(
      { sender },
      'https://github.com/openai/native-project'
    )
  ).resolves.toEqual({
    success: true,
    rid: 'z6mkt4nativeimport123',
    name: 'native-project',
    owner: 'openai',
    description: 'Native project',
  });
  expect(mockEmbedded.importRepo).toHaveBeenCalledWith(
    expect.stringContaining('native-project'),
    'native-project',
    'Native project',
    'main'
  );
});

test('does not report success or persist a bridge when native import returns an invalid RID', async () => {
  mockEmbedded.importRepo.mockResolvedValueOnce({ rid: 'not-a-radicle-id' });
  const sender = { isDestroyed: () => false, send: jest.fn() };
  await expect(
    mockHandlers.get(IPC.GITHUB_BRIDGE_IMPORT)(
      { sender },
      'https://github.com/openai/invalid-native-project'
    )
  ).resolves.toMatchObject({
    success: false,
    error: { code: 'IMPORT_FAILED' },
  });
  expect(sender.send).not.toHaveBeenCalledWith(
    IPC.GITHUB_BRIDGE_PROGRESS,
    expect.objectContaining({ step: 'success' })
  );
});
