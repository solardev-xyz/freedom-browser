// The bridge map lives in the Radicle home, which a legacy profile may still be
// carrying over asynchronously (profile-paths.js). These pin that the map is
// only read/written once that home is ready (#517 R1-F1).
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-bridge-map-'));
const mockHandlers = new Map();
let mockPrepare;

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn((channel, fn) => mockHandlers.set(channel, fn)) },
}));
jest.mock('./radicle-manager', () => ({
  getCurrentStatus: jest.fn(() => ({ status: 'running', error: null })),
  isDisabledForProfile: jest.fn(() => false),
  STATUS: { RUNNING: 'running' },
}));
jest.mock('./radicle-embedded', () => ({
  isAvailable: jest.fn(() => true),
  listRepos: jest.fn(async () => []),
}));
jest.mock('./profile-paths', () => ({
  createProfileTempDir: jest.fn(),
  prepareRadicleDataDir: jest.fn(() => mockPrepare()),
}));

const IPC = require('../shared/ipc-channels');
const embedded = require('./radicle-embedded');
let registerGithubBridgeIpc;

const mapPath = path.join(mockDataDir, 'github-bridge-map.json');
const check = (url) => mockHandlers.get(IPC.GITHUB_BRIDGE_CHECK_EXISTING)(null, url);

// Fresh module per test so the once-per-session map cache starts empty.
beforeEach(() => {
  jest.isolateModules(() => {
    ({ registerGithubBridgeIpc } = require('./github-bridge'));
  });
  registerGithubBridgeIpc();
});
afterAll(() => fs.rmSync(mockDataDir, { recursive: true, force: true }));

test('a lookup during the carry-over sees the migrated map, not an empty one', async () => {
  let finishMigration;
  const ready = new Promise((resolve) => {
    finishMigration = () => resolve(mockDataDir);
  });
  mockPrepare = () => ready;
  const pending = check('https://github.com/a/zero');
  await new Promise((resolve) => setImmediate(resolve));
  // The copy lands (map now present in the home), then preparation resolves.
  fs.writeFileSync(mapPath, JSON.stringify({ 'a/zero': 'z6mkt4zero' }));
  finishMigration();
  await expect(pending).resolves.toMatchObject({ bridged: true, rid: 'z6mkt4zero' });
  fs.rmSync(mapPath);
});

test('a failed Radicle-home preparation is not latched as an empty map', async () => {
  mockPrepare = async () => {
    throw new Error('migration failed');
  };
  await expect(check('https://github.com/a/one')).resolves.toMatchObject({ bridged: false });
  // Nothing was written while the home was unavailable.
  expect(fs.existsSync(mapPath)).toBe(false);

  mockPrepare = async () => mockDataDir;
  fs.writeFileSync(mapPath, JSON.stringify({ 'a/one': 'z6mkt4one' }));
  // Same module instance: the earlier failure must not have cached anything.
  await expect(check('https://github.com/a/one')).resolves.toMatchObject({
    bridged: true,
    rid: 'z6mkt4one',
  });
});

test('reads and writes wait for the Radicle home instead of racing its carry-over', async () => {
  let finishMigration;
  const ready = new Promise((resolve) => {
    finishMigration = () => resolve(mockDataDir);
  });
  mockPrepare = () => ready;
  embedded.listRepos.mockResolvedValueOnce([
    { rid: 'rad:z6mkt4two', description: 'Imported from github.com/a/two' },
  ]);

  // The lookup misses, finds the repo by description, and has to persist —
  // neither may touch the home before it is ready.
  const pending = check('https://github.com/a/two');
  await new Promise((resolve) => setImmediate(resolve));
  const before = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  expect(before).toEqual({ 'a/one': 'z6mkt4one' });

  finishMigration();
  await expect(pending).resolves.toMatchObject({ bridged: true, rid: 'z6mkt4two' });
  expect(JSON.parse(fs.readFileSync(mapPath, 'utf8'))).toEqual({
    'a/one': 'z6mkt4one',
    'a/two': 'z6mkt4two',
  });
});
