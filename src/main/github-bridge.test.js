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
  prepareRadicleDataDir: jest.fn(async () => mockDataDir),
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

// Security scan S-4 (#636): a dot-only owner/repo would make the import's
// repoDir = path.join(clonePath, repo) resolve to the temp clone dir or its
// parent. '.git' is stripped after the match, so 'x/..git' leaves '.'.
const DOT_ONLY_INPUTS = [
  'https://github.com/x/.',
  'https://github.com/x/..',
  'https://github.com/x/...',
  'https://github.com/x/..git',
  'https://github.com/x/...git',
  'https://github.com/x/../',
  'https://github.com/./repo',
  'https://github.com/../repo',
  'x/.',
  'x/..',
  'x/...',
  'x/..git',
  '../repo',
];

test.each(DOT_ONLY_INPUTS)('rejects dot-only owner/repo names: %s', (input) => {
  expect(validateGitHubUrl(input)).toMatchObject({
    valid: false,
    error: { code: 'INVALID_URL_FORMAT' },
  });
});

test('still accepts names that merely contain dots', () => {
  expect(validateGitHubUrl('https://github.com/x/.github')).toMatchObject({
    valid: true, repo: '.github',
  });
  expect(validateGitHubUrl('x/a..b.git')).toMatchObject({ valid: true, repo: 'a..b' });
  expect(validateGitHubUrl('x/.hidden')).toMatchObject({ valid: true, repo: '.hidden' });
});

test.each(DOT_ONLY_INPUTS.filter((input) => input.startsWith('https://')))(
  'import and bridge check refuse dot-only names before cloning: %s',
  async (input) => {
    const sender = { isDestroyed: () => false, send: jest.fn() };
    await expect(
      mockHandlers.get(IPC.GITHUB_BRIDGE_IMPORT)({ sender }, input)
    ).resolves.toMatchObject({ success: false, error: { code: 'INVALID_URL_FORMAT' } });
    await expect(
      mockHandlers.get(IPC.GITHUB_BRIDGE_CHECK_EXISTING)(null, input)
    ).resolves.toMatchObject({ success: false, error: { code: 'INVALID_URL_FORMAT' } });
    expect(mockExecFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['clone']),
      expect.anything(),
      expect.anything()
    );
    expect(mockEmbedded.importRepo).not.toHaveBeenCalled();
  }
);

test('bridge check keeps a repo named .git instead of stripping it to empty', async () => {
  expect(validateGitHubUrl('https://github.com/x/.git')).toMatchObject({
    valid: true, owner: 'x', repo: '.git',
  });
  mockEmbedded.listRepos.mockResolvedValueOnce([
    { rid: 'rad:z6mkt4unrelated123', description: 'Imported from github.com/x/other' },
  ]);
  await expect(
    mockHandlers.get(IPC.GITHUB_BRIDGE_CHECK_EXISTING)(null, 'https://github.com/x/.git')
  ).resolves.toEqual({ success: true, bridged: false });
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
  // The clone's temp dir is removed (asynchronously, #513) before the import
  // resolves.
  expect(fs.readdirSync(mockTempRoot)).toEqual([]);
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
