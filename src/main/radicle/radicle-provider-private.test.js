/**
 * R-9: nothing a private window does through the Radicle provider may
 * outlive it. From freedom-core design 0011's PRQ-8 every window.radicle
 * request is main's, which refuses a private window's, and the chrome has
 * no route left; what a chrome can still reach is the permission store's
 * channels. Runs the real private-window registry (only the window lookup
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
  // The add-on: no service generation, so no write refusal (plan B10).
  activeRadicleIdentity: jest.fn(() => null),
  radicleWriteRefusal: jest.fn(() => null),
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
  CobAdmissionError: class CobAdmissionError extends Error {},
  CobOutcomeUnknownError: class CobOutcomeUnknownError extends Error {},
  OUTCOME_UNKNOWN_MESSAGE:
    'The Radicle node stopped before confirming this write; it may have been recorded.',
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
  GRANT_REFUSED,
  NODE_RULE_REFUSED,
  SIGNING_GRANT_REFUSED,
  SIGNING_RULE_REFUSED,
} = require('./radicle-permissions');

registerRadicleProviderIpc();
registerRadiclePermissionsIpc();

const storeBytes = () => fs.readFileSync(storePath, 'utf8');
const backendCalls = () =>
  [
    manager.seedRepository,
    manager.unseedRepository,
    manager.refetchRepository,
    manager.getSeedFetchStatus,
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

// Every window.radicle method is main's (freedom-core design 0011, PRQ-8): a
// page's request reaches main through main's own attestation, which refuses
// a private window's, and the chrome has no route left to forward one
// (PRQ-8c). So nothing a private window's page asks reaches the backend.
test('the provider registers no route a private window, or any chrome, could forward a request on', () => {
  expect(mockHandlers.has('radicle:provider-execute')).toBe(false);
  expect([...mockHandlers.keys()].filter((channel) => channel.startsWith('radicle:')).sort()).toEqual([
    IPC.RADICLE_GET_ALIAS,
    IPC.RADICLE_GET_ALL_PERMISSIONS,
    IPC.RADICLE_GET_AUTO_APPROVE,
    IPC.RADICLE_GET_PERMISSION,
    IPC.RADICLE_GRANT_PERMISSION,
    IPC.RADICLE_GRANT_SIGNING,
    IPC.RADICLE_HAS_SIGNING_GRANT,
    IPC.RADICLE_REVOKE_PERMISSION,
    IPC.RADICLE_SET_ALIAS,
    IPC.RADICLE_SET_AUTO_APPROVE,
    IPC.RADICLE_UPDATE_LAST_USED,
  ].sort());
  expect(backendCalls()).toBe(0);
});

test('grants, rules and use records from a private window are refused; from any sender, a grant or a rule turned on is', async () => {
  const before = storeBytes();
  const privateEvent = { sender: mockFixture.privateSender(privateWindows) };
  const publicEvent = { sender: mockFixture.publicSender() };
  const other = 'https://other.example';
  for (const event of [privateEvent, publicEvent, {}]) {
    expect(() => mockHandlers.get(IPC.RADICLE_GRANT_PERMISSION)(event, other)).toThrow(GRANT_REFUSED);
    expect(() => mockHandlers.get(IPC.RADICLE_GRANT_SIGNING)(event, ORIGIN)).toThrow(SIGNING_GRANT_REFUSED);
    expect(() => mockHandlers.get(IPC.RADICLE_SET_AUTO_APPROVE)(event, ORIGIN, 'node', true)).toThrow(NODE_RULE_REFUSED);
    expect(() => mockHandlers.get(IPC.RADICLE_SET_AUTO_APPROVE)(event, ORIGIN, 'signing', true)).toThrow(
      SIGNING_RULE_REFUSED
    );
  }
  // A private (or unclassifiable) sender records nothing, not even a rule
  // turned off or a use.
  for (const event of [privateEvent, {}]) {
    expect(mockHandlers.get(IPC.RADICLE_SET_AUTO_APPROVE)(event, ORIGIN, 'signing', false)).toBe(false);
    expect(mockHandlers.get(IPC.RADICLE_UPDATE_LAST_USED)(event, ORIGIN)).toBe(false);
  }
  expect(storeBytes()).toBe(before);
});

// Last: these write the store.
test('main\'s page path runs a public page\'s requests and records their use', async () => {
  const status = await executeRadicleForPage('radicle_getSeedStatus', { rid: RID }, ORIGIN);
  expect(status).toEqual({ result: mockStatus });
  expect(JSON.parse(storeBytes())[ORIGIN].lastUsed).toBeGreaterThan(AN_HOUR_AGO);
  const seeded = await executeRadicleForPage('radicle_seed', { rid: RID }, ORIGIN);
  expect(seeded.result).toMatchObject({ rid: RID, seeded: true });
  expect(manager.seedRepository).toHaveBeenCalledTimes(1);
  // A public sender may still turn a rule off, and revoke.
  expect(mockHandlers.get(IPC.RADICLE_SET_AUTO_APPROVE)({ sender: mockFixture.publicSender() }, ORIGIN, 'signing', false)).toBe(true);
  expect(mockHandlers.get(IPC.RADICLE_REVOKE_PERMISSION)({ sender: mockFixture.publicSender() }, WATCHED)).toBe(true);
  expect(JSON.parse(storeBytes())[WATCHED]).toBeUndefined();
});
