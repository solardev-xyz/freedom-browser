/**
 * R-9: nothing a private window does through the Radicle provider may
 * outlive it. Runs the real private-window registry (only the window lookup
 * is faked), the real fail-closed sender check, and the real permission
 * store on disk; the node and COB backends are mocks.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radicle-private-'));
const mockHandlers = new Map();
const mockFixture =
  require('../../../test/helpers/private-window-fixture').createPrivateWindowFixture();

jest.mock('electron', () => ({
  app: { getPath: () => mockUserDataDir },
  ipcMain: { handle: (channel, fn) => mockHandlers.set(channel, fn) },
  webContents: { fromId: () => undefined },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: (contents) => mockFixture.fromWebContents(contents),
  },
  session: { fromPartition: () => mockFixture.fromPartition() },
}));
jest.mock('../windows/mainWindow', () => ({
  createMainWindow: () => mockFixture.createMainWindow(),
}));
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../radicle-embedded', () => ({ listSeededRepos: jest.fn(async () => []) }));

const mockStatus = { rid: 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5', state: 'fetched' };
jest.mock('../radicle-manager', () => ({
  isDisabledForProfile: jest.fn(() => false),
  getCurrentStatus: jest.fn(() => ({ status: 'running', error: null })),
  getConnections: jest.fn(async () => ({ success: true, count: 3 })),
  seedRepository: jest.fn(async () => ({ success: true, status: mockStatus })),
  unseedRepository: jest.fn(async () => ({ success: true })),
  refetchRepository: jest.fn(async () => ({ success: true, status: mockStatus })),
  getSeedFetchStatus: jest.fn(() => ({ success: true, status: mockStatus })),
  unsubscribeSeedStatus: jest.fn(),
  validateAndNormalizeRid: jest.fn((rid) => (/^rad:z\w{20,60}$/.test(rid ?? '') ? rid : null)),
  getNodeAlias: jest.fn(),
  setNodeAlias: jest.fn(),
  STATUS: { STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', ERROR: 'error' },
}));
jest.mock('./cob-service', () => ({
  createIssue: jest.fn(async () => ({ id: 'a'.repeat(40) })),
  commentIssue: jest.fn(async () => ({ id: 'b'.repeat(40) })),
  editIssueState: jest.fn(async () => ({ id: 'c'.repeat(40), state: 'closed' })),
  commentPatch: jest.fn(async () => ({ id: 'd'.repeat(40) })),
  getIdentity: jest.fn(async () => ({ did: 'did:key:z6MkTest', nid: 'z6MkTest', alias: 'me' })),
  clearIdentityCache: jest.fn(),
  CobValidationError: class CobValidationError extends Error {},
}));

const ORIGIN = 'https://forge.example';
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const AN_HOUR_AGO = Date.now() - 60 * 60 * 1000;
const storePath = path.join(mockUserDataDir, 'radicle-permissions.json');
// An existing grant, last used an hour ago: a read that recorded its use
// would rewrite it.
fs.writeFileSync(
  storePath,
  JSON.stringify(
    {
      [ORIGIN]: {
        origin: ORIGIN,
        connectedAt: AN_HOUR_AGO,
        lastUsed: AN_HOUR_AGO,
        signing: true,
        autoApprove: { node: false, signing: false },
      },
    },
    null,
    2
  )
);

const IPC = require('../../shared/ipc-channels');
const manager = require('../radicle-manager');
const cob = require('./cob-service');
const privateWindows = require('../private/private-windows');
const { registerRadicleProviderIpc } = require('./radicle-provider-ipc');
const { registerRadiclePermissionsIpc } = require('./radicle-permissions');

registerRadicleProviderIpc();
registerRadiclePermissionsIpc();
const execute = (sender, request) =>
  mockHandlers.get(IPC.RADICLE_PROVIDER_EXECUTE)(sender === undefined ? {} : { sender }, request);

const storeBytes = () => fs.readFileSync(storePath, 'utf8');
const REFUSED = {
  error: {
    code: 4100,
    message: 'Not available in private windows',
    data: { reason: 'private_window' },
  },
};
const MUTATORS = {
  radicle_seed: { rid: RID },
  radicle_unseed: { rid: RID },
  radicle_sync: { rid: RID },
  radicle_disconnect: {},
  radicle_createIssue: { rid: RID, title: 'Bug', description: 'Steps' },
  radicle_commentIssue: { rid: RID, issueId: 'a'.repeat(40), body: 'Same here' },
  radicle_editIssueState: { rid: RID, issueId: 'a'.repeat(40), state: 'closed' },
  radicle_commentPatch: { rid: RID, patchId: 'b'.repeat(40), body: 'LGTM' },
};
const backendCalls = () =>
  [
    manager.seedRepository,
    manager.unseedRepository,
    manager.refetchRepository,
    cob.createIssue,
    cob.commentIssue,
    cob.editIssueState,
    cob.commentPatch,
  ].reduce((total, fn) => total + fn.mock.calls.length, 0);

afterAll(() => {
  fs.rmSync(mockUserDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFixture.lookup.mode = 'registry';
});

test('every lasting change from a private window is refused before the backend', async () => {
  const before = storeBytes();
  const privateChrome = mockFixture.privateSender(privateWindows);

  for (const [method, params] of Object.entries(MUTATORS)) {
    // Even with the renderer reporting the user approved it.
    const meta = { webContentsId: 9, approval: 'user' };
    await expect(execute(privateChrome, { method, params, origin: ORIGIN, meta })).resolves.toEqual(
      REFUSED
    );
  }
  expect(backendCalls()).toBe(0);
  expect(manager.unsubscribeSeedStatus).not.toHaveBeenCalled();
  // The grant is still there (disconnect was refused) and the store is
  // byte for byte what it was.
  expect(storeBytes()).toBe(before);
});

test('a sender main cannot classify is refused the same way', async () => {
  const before = storeBytes();
  const publicChrome = mockFixture.publicSender();
  const senders = [
    undefined, // no sender at all
    { id: 5, isDestroyed: () => false }, // no window main can find
    { isDestroyed: () => true },
    { hostWebContents: { isDestroyed: () => true } },
  ];
  for (const sender of senders) {
    for (const method of ['radicle_seed', 'radicle_createIssue']) {
      await expect(
        execute(sender, { method, params: MUTATORS[method], origin: ORIGIN })
      ).resolves.toEqual(REFUSED);
    }
  }
  // A known public window whose lookup finds nothing, or throws.
  for (const mode of ['null', 'throw']) {
    mockFixture.lookup.mode = mode;
    for (const method of ['radicle_seed', 'radicle_sync', 'radicle_commentPatch']) {
      await expect(
        execute(publicChrome, { method, params: MUTATORS[method], origin: ORIGIN })
      ).resolves.toEqual(REFUSED);
    }
  }
  expect(backendCalls()).toBe(0);
  expect(storeBytes()).toBe(before);
});

test('reads a private window may make answer without recording their use', async () => {
  const before = storeBytes();
  const privateChrome = mockFixture.privateSender(privateWindows);

  const status = await execute(privateChrome, {
    method: 'radicle_getSeedStatus',
    params: { rid: RID },
    origin: ORIGIN,
  });
  expect(status).toEqual({ result: mockStatus });
  const node = await execute(privateChrome, { method: 'radicle_getNodeStatus', origin: ORIGIN });
  expect(node.result).toMatchObject({ running: true });
  const seeded = await execute(privateChrome, {
    method: 'radicle_listSeededRepos',
    origin: ORIGIN,
  });
  expect(seeded).toEqual({ result: [] });

  // The grant's lastUsed is still an hour old: nothing was written.
  expect(storeBytes()).toBe(before);
});

test('grants and use records from a private window are refused', async () => {
  const before = storeBytes();
  const event = { sender: mockFixture.privateSender(privateWindows) };
  const other = 'https://other.example';

  expect(mockHandlers.get(IPC.RADICLE_GRANT_PERMISSION)(event, other)).toBeNull();
  expect(mockHandlers.get(IPC.RADICLE_GRANT_SIGNING)(event, ORIGIN)).toBe(false);
  expect(mockHandlers.get(IPC.RADICLE_SET_AUTO_APPROVE)(event, ORIGIN, 'node', true)).toBe(false);
  expect(mockHandlers.get(IPC.RADICLE_UPDATE_LAST_USED)(event, ORIGIN)).toBe(false);
  // Unclassifiable senders too.
  expect(mockHandlers.get(IPC.RADICLE_GRANT_PERMISSION)({}, other)).toBeNull();
  expect(storeBytes()).toBe(before);
});

// Last: these write the store.
test('the same calls from a known public window still run and record their use', async () => {
  const publicChrome = mockFixture.publicSender();

  const status = await execute(publicChrome, {
    method: 'radicle_getSeedStatus',
    params: { rid: RID },
    origin: ORIGIN,
  });
  expect(status).toEqual({ result: mockStatus });
  expect(JSON.parse(storeBytes())[ORIGIN].lastUsed).toBeGreaterThan(AN_HOUR_AGO);

  const seeded = await execute(publicChrome, {
    method: 'radicle_seed',
    params: { rid: RID },
    origin: ORIGIN,
    meta: { webContentsId: 9, approval: 'user' },
  });
  expect(seeded.result).toMatchObject({ rid: RID, seeded: true });
  expect(manager.seedRepository).toHaveBeenCalledTimes(1);

  const granted = await mockHandlers.get(IPC.RADICLE_GRANT_PERMISSION)(
    { sender: publicChrome },
    'https://other.example'
  );
  expect(granted).toMatchObject({ origin: 'https://other.example' });
});
