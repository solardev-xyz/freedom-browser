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
// A second connected origin, for the seed-status subscription test.
const WATCHED = 'https://watched.example';
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const AN_HOUR_AGO = Date.now() - 60 * 60 * 1000;
const storePath = path.join(mockUserDataDir, 'radicle-permissions.json');
// Existing grants, last used an hour ago: a read that recorded its use
// would rewrite them.
const grant = (origin) => ({
  origin,
  connectedAt: AN_HOUR_AGO,
  lastUsed: AN_HOUR_AGO,
  signing: true,
  autoApprove: { node: false, signing: false },
});
fs.writeFileSync(
  storePath,
  JSON.stringify({ [ORIGIN]: grant(ORIGIN), [WATCHED]: grant(WATCHED) }, null, 2)
);

const IPC = require('../../shared/ipc-channels');
const manager = require('../radicle-manager');
const cob = require('./cob-service');
const privateWindows = require('../private/private-windows');
const { registerRadicleProviderIpc, executeRadicleForPage } = require('./radicle-provider-ipc');
const {
  registerRadiclePermissionsIpc,
  grantPermission,
  GRANT_REFUSED,
  NODE_RULE_REFUSED,
} = require('./radicle-permissions');
const { RADICLE_PAGE_METHODS } = require('../page/page-radicle');

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
// A method main's page dispatcher serves (freedom-core design 0011, PRQ-8)
// never comes from a private window: main's attestation refuses one, and
// the chrome's route refuses the method for every sender, first. From PRQ-8b
// that is seeding too: of the lasting changes, only the signed writes are
// still on the chrome's route.
const PAGE_REQUEST_ONLY = {
  error: {
    code: 4100,
    message: 'The origin is not authorized for this operation',
    data: { reason: 'page_request_only' },
  },
};
const MUTATORS = {
  radicle_seed: { rid: RID },
  radicle_unseed: { rid: RID },
  radicle_sync: { rid: RID },
  radicle_createIssue: { rid: RID, title: 'Bug', description: 'Steps' },
  radicle_commentIssue: { rid: RID, issueId: 'a'.repeat(40), body: 'Same here' },
  radicle_editIssueState: { rid: RID, issueId: 'a'.repeat(40), state: 'closed' },
  radicle_commentPatch: { rid: RID, patchId: 'b'.repeat(40), body: 'LGTM' },
};
// What the chrome's route answers a private window's lasting change.
const refusalOf = (method) => (RADICLE_PAGE_METHODS.includes(method) ? PAGE_REQUEST_ONLY : REFUSED);
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
      refusalOf(method)
    );
  }
  // Disconnecting is main's (PRQ-8a): the chrome's route refuses it.
  await expect(
    execute(privateChrome, { method: 'radicle_disconnect', params: {}, origin: ORIGIN })
  ).resolves.toEqual(PAGE_REQUEST_ONLY);
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
      ).resolves.toEqual(refusalOf(method));
    }
  }
  // A known public window whose lookup finds nothing, or throws.
  for (const mode of ['null', 'throw']) {
    mockFixture.lookup.mode = mode;
    for (const method of ['radicle_seed', 'radicle_sync', 'radicle_commentPatch']) {
      await expect(
        execute(publicChrome, { method, params: MUTATORS[method], origin: ORIGIN })
      ).resolves.toEqual(refusalOf(method));
    }
  }
  expect(backendCalls()).toBe(0);
  expect(storeBytes()).toBe(before);
});

test('reads a private window may make answer without recording their use', async () => {
  const before = storeBytes();
  const privateChrome = mockFixture.privateSender(privateWindows);

  // The seed status (PRQ-8b), the node's status and the seeded repositories
  // (PRQ-8a) are main's: the chrome's route refuses them.
  const status = await execute(privateChrome, {
    method: 'radicle_getSeedStatus',
    params: { rid: RID },
    origin: ORIGIN,
  });
  expect(status).toEqual(PAGE_REQUEST_ONLY);
  expect(manager.getSeedFetchStatus).not.toHaveBeenCalled();
  const node = await execute(privateChrome, { method: 'radicle_getNodeStatus', origin: ORIGIN });
  expect(node).toEqual(PAGE_REQUEST_ONLY);
  const seeded = await execute(privateChrome, {
    method: 'radicle_listSeededRepos',
    origin: ORIGIN,
  });
  expect(seeded).toEqual(PAGE_REQUEST_ONLY);

  // The grant's lastUsed is still an hour old: nothing was written.
  expect(storeBytes()).toBe(before);
});

test('grants and use records from a private window are refused', async () => {
  const before = storeBytes();
  const event = { sender: mockFixture.privateSender(privateWindows) };
  const other = 'https://other.example';

  // The chrome's connection grant is refused for every sender (PRQ-8a).
  expect(() => mockHandlers.get(IPC.RADICLE_GRANT_PERMISSION)(event, other)).toThrow(GRANT_REFUSED);
  expect(mockHandlers.get(IPC.RADICLE_GRANT_SIGNING)(event, ORIGIN)).toBe(false);
  expect(mockHandlers.get(IPC.RADICLE_SET_AUTO_APPROVE)(event, ORIGIN, 'signing', true)).toBe(false);
  // The node rule is never turned on from the chrome (PRQ-8b), for any sender.
  expect(() => mockHandlers.get(IPC.RADICLE_SET_AUTO_APPROVE)(event, ORIGIN, 'node', true)).toThrow(
    NODE_RULE_REFUSED
  );
  expect(mockHandlers.get(IPC.RADICLE_UPDATE_LAST_USED)(event, ORIGIN)).toBe(false);
  // Unclassifiable senders too.
  expect(() => mockHandlers.get(IPC.RADICLE_GRANT_PERMISSION)({}, other)).toThrow(GRANT_REFUSED);
  expect(storeBytes()).toBe(before);
});

// R-9 review 3: a private seed-status read during an active fetch must
// leave nothing behind. From PRQ-8b the chrome's route refuses it, so it
// subscribes nothing and makes no broadcaster; main's page path, which a
// private window never reaches, subscribes the site as before.
test('a private seed-status read subscribes nothing and leaves no broadcaster', async () => {
  // The manager during an active fetch: a callback passed in is kept.
  const listeners = new Set();
  manager.getSeedFetchStatus.mockImplementation((_rid, onStatus) => {
    if (onStatus) listeners.add(onStatus);
    return { success: true, status: mockStatus };
  });
  manager.unsubscribeSeedStatus.mockImplementation((onStatus) => listeners.delete(onStatus));
  const privateChrome = mockFixture.privateSender(privateWindows);

  await expect(
    execute(privateChrome, {
      method: 'radicle_getSeedStatus',
      params: { rid: RID },
      origin: WATCHED,
    })
  ).resolves.toEqual(PAGE_REQUEST_ONLY);
  expect(manager.getSeedFetchStatus).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
  // The origin's disconnect finds no broadcaster to unsubscribe.
  await executeRadicleForPage('radicle_disconnect', {}, WATCHED);
  expect(manager.unsubscribeSeedStatus).not.toHaveBeenCalled();

  // The same read through main's page path subscribes, as before.
  expect(grantPermission(WATCHED)).toMatchObject({ origin: WATCHED });
  await executeRadicleForPage('radicle_getSeedStatus', { rid: RID }, WATCHED);
  expect(manager.getSeedFetchStatus.mock.calls[0]).toEqual([RID, expect.any(Function)]);
  expect(listeners.size).toBe(1);
  manager.getSeedFetchStatus.mockImplementation(() => ({ success: true, status: mockStatus }));
  manager.unsubscribeSeedStatus.mockImplementation(() => {});
});

// Last: these write the store.
test('the same calls from a known public window still run and record their use', async () => {
  const publicChrome = mockFixture.publicSender();

  // Seeding is main's (PRQ-8b): a page's request through main's page path.
  const status = await executeRadicleForPage('radicle_getSeedStatus', { rid: RID }, ORIGIN);
  expect(status).toEqual({ result: mockStatus });
  expect(JSON.parse(storeBytes())[ORIGIN].lastUsed).toBeGreaterThan(AN_HOUR_AGO);

  const seeded = await executeRadicleForPage('radicle_seed', { rid: RID }, ORIGIN);
  expect(seeded.result).toMatchObject({ rid: RID, seeded: true });
  expect(manager.seedRepository).toHaveBeenCalledTimes(1);

  // The chrome's connection grant is refused from a public window too
  // (PRQ-8a): main writes a connection, from its own prompt.
  expect(() =>
    mockHandlers.get(IPC.RADICLE_GRANT_PERMISSION)({ sender: publicChrome }, 'https://other.example')
  ).toThrow(GRANT_REFUSED);
  expect(JSON.parse(storeBytes())['https://other.example']).toBeUndefined();
});
