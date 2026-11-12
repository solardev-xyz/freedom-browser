/**
 * #1073: the private log context redacts nothing by itself. Each log line a
 * window.radicle request reaches has to pass the add-on's text, and the RID
 * it names, through redactForLog. These lines sit below the provider, in
 * radicle-manager, the seed-status tracker and the add-on wrapper. Most log
 * a failure and swallow it, so the provider's own redacted catch never runs:
 * `radicle_getNodeStatus` answers with success after its repository count
 * failed. Every method that reaches these lines is main's now (freedom-core
 * design 0011, PRQ-8a and 8b): the chrome's route refuses it for any sender
 * before the manager, and a private window never reaches main's page path,
 * so a private window reaches none of them; each line still redacts in any
 * private log context.
 *
 * Runs main's real page path (executeRadicleForPage), radicle-manager,
 * seed-status tracker, cob-service and log context. The add-on and the
 * permission store are mocks.
 */
const mockHandlers = new Map();
const mockSend = jest.fn();
const mockFixture =
  require('../../../test/helpers/private-window-fixture').createPrivateWindowFixture();
const mockDataDir = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'radicle-manager-logs-')
);

jest.mock('electron', () => ({
  app: { getPath: () => mockDataDir },
  ipcMain: { handle: (channel, fn) => mockHandlers.set(channel, fn) },
  webContents: { fromId: () => undefined },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: mockSend } }],
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
jest.mock('../profile-paths', () => ({
  getRadicleDataDir: () => mockDataDir,
  prepareRadicleDataDir: async () => mockDataDir,
}));
jest.mock('../profile-resolver', () => ({
  getActiveProfile: () => ({ metadata: { nodes: {} } }),
}));
jest.mock('../service-registry', () => ({
  updateService: jest.fn(),
  setStatusMessage: jest.fn(),
  clearService: jest.fn(),
  MODE: { EMBEDDED: 'embedded', DISABLED: 'disabled' },
}));
jest.mock('../radicle-embedded', () => ({
  isAvailable: jest.fn(() => true),
  isStarted: jest.fn(() => false),
  start: jest.fn(async () => ({ did: 'did:key:z6MkTest' })),
  shutdown: jest.fn(async () => ({ ok: true })),
  connectSeeds: jest.fn(async () => ({ connected: 1, target: 1, targetReached: true })),
  cloneRepo: jest.fn(async () => ({ ok: true })),
  cloneRepoWithProgress: jest.fn(async () => ({ ok: true })),
  cancelClone: jest.fn(async () => ({ cancelled: true })),
  unseedRepo: jest.fn(async () => ({ unseeded: true })),
  repoInfo: jest.fn(async () => ({ rid: 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5' })),
  seeders: jest.fn(async () => ({ seeding: 2 })),
  status: jest.fn(async () => ({ connectedPeers: 3 })),
  listRepos: jest.fn(async () => []),
  listSeededRepos: jest.fn(async () => []),
  identity: jest.fn(async () => ({ did: 'did:key:z6MkTest', nid: 'z6MkTest', alias: 'me' })),
  getVersion: jest.fn(() => '0.8.0'),
}));
// The home's gate (radicled-gate.js) stays out of it: a development build
// without freedom-radicled, which goes on ungated.
jest.mock('./radicled-gate', () => ({
  takeRadicleGate: async () => null,
  withRadicleGate: async (_home, fn) => fn({ gated: false, held: () => false }),
  switchedHomeRefusal: () => null,
}));
jest.mock('./radicle-permissions', () => ({
  getPermission: jest.fn(),
  hasSigningGrant: jest.fn(() => true),
  getAutoApprove: jest.fn(() => false),
  updateLastUsed: jest.fn(),
  revokePermission: jest.fn(() => true),
}));

const fs = require('fs');
const log = require('../logger');
const embedded = require('../radicle-embedded');
const manager = require('../radicle-manager');
const seedStatus = require('./seed-status');
const permissions = require('./radicle-permissions');
const cob = require('./cob-service');
const { runWithPrivateLogContext } = require('../private/private-log-context');
const {
  registerRadicleProviderIpc,
  executeRadicleForPage,
  setSeedStatusSink,
} = require('./radicle-provider-ipc');

registerRadicleProviderIpc();
// A site's seed statuses go to main's page requests (PRQ-8b): here a sink
// that fails whenever a window send would, as the chrome's relay did.
setSeedStatusSink((_origin, status) => mockSend('status', status));

const ORIGIN = 'https://forge.example';
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const RID_Z = RID.slice('rad:'.length);

// Every window.radicle method is main's (freedom-core design 0011, PRQ-8,
// src/main/page/page-radicle.js): a page's request runs on main's page path,
// under the attested key. A private window never reaches it (main's
// attestation refuses one), and the chrome has no route (PRQ-8c).
const pageExecute = (method, params = {}) => executeRadicleForPage(method, params, ORIGIN);

// Absolute paths of each kind, as #1050's tests find them.
const UNIX_PATH = /(?:^|[\s'"(=:,])\/(?!\/)[^\s'"/]/;
const DRIVE_PATH = /\b[A-Za-z]:[\\/]/;
const UNC_PATH = /(?:^|[\s'"(=:,])\\\\[^\\?\s]/;
const VERBATIM_PATH = /\\\\\?\\/;
const ABSOLUTE_PATHS = [UNIX_PATH, DRIVE_PATH, UNC_PATH, VERBATIM_PATH];

// A Radicle home of each kind, under a profile directory, and its separator.
const HOMES = [
  ['a Unix home', '/home/alice/.config/Freedom/profiles/default/radicle', '/'],
  [
    'a Windows drive',
    'C:\\Users\\alice\\AppData\\Roaming\\Freedom\\profiles\\default\\radicle',
    '\\',
  ],
  ['a UNC share', '\\\\fileserver\\homes\\alice\\Freedom\\profiles\\default\\radicle', '\\'],
  [
    'a \\\\?\\ path',
    '\\\\?\\C:\\Users\\alice\\AppData\\Roaming\\Freedom\\profiles\\default\\radicle',
    '\\',
  ],
];

// libradicle's storage error, naming the home and the repository.
const storageError = (home, sep) =>
  `failed to open '${[home, 'storage', RID_Z, 'objects', 'pack'].join(sep)}': ` +
  'Permission denied; class=Os (2)';

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// A fetch that stays in flight until the test finishes it.
let finishClone = null;
async function startPendingFetch() {
  embedded.cloneRepoWithProgress.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishClone = () => resolve({ ok: true });
      })
  );
  await manager.seedRepository(RID);
}
async function finishPendingFetch() {
  finishClone?.();
  finishClone = null;
  await settle();
}

// A window's send that fails with `text`.
const failSend = (text) =>
  mockSend.mockImplementation(() => {
    throw new Error(text);
  });

// Each log line: what fails, the request that reaches it, the same call
// made straight to the manager, and the line with `rid` and `text` in it.
const LINES = [
  {
    label: 'radicle-manager: the repository count (getConnections)',
    method: 'radicle_getNodeStatus',
    fail: (text) => embedded.listRepos.mockRejectedValueOnce(new Error(text)),
    direct: () => manager.getConnections(),
    line: (_rid, text) => ['[Radicle] Could not read seeded repository count:', text],
  },
  {
    label: 'radicle-manager: the seeding policies (isSeeded)',
    method: 'radicle_sync',
    params: { rid: RID },
    fail: (text) => embedded.listSeededRepos.mockRejectedValueOnce(new Error(text)),
    direct: () => manager.refetchRepository(RID),
    line: (rid, text) => [`[Radicle] Could not read seeding policies for ${rid}:`, text],
  },
  {
    label: 'radicle-manager: the clone cancel (unseed during a fetch)',
    method: 'radicle_unseed',
    params: { rid: RID },
    before: startPendingFetch,
    fail: (text) => embedded.cancelClone.mockRejectedValueOnce(new Error(text)),
    direct: () => manager.unseedRepository(RID),
    after: finishPendingFetch,
    line: (rid, text) => [`[Radicle] Could not request clone cancellation for ${rid}:`, text],
  },
  {
    label: 'radicle-manager: the final unseed (unseed during a fetch)',
    method: 'radicle_unseed',
    params: { rid: RID },
    before: startPendingFetch,
    // The first unseed is the immediate one, the second the final one.
    fail: (text) =>
      embedded.unseedRepo
        .mockResolvedValueOnce({ unseeded: true })
        .mockRejectedValueOnce(new Error(text)),
    direct: () => manager.unseedRepository(RID),
    after: finishPendingFetch,
    line: (rid, text) => [`[Radicle] Final unseed failed for ${rid}:`, text],
  },
  {
    label: 'radicle-manager: the node info broadcast (unseed)',
    method: 'radicle_unseed',
    params: { rid: RID },
    fail: failSend,
    direct: () => manager.unseedRepository(RID),
    line: (_rid, text) => ['[Radicle] Could not publish node info:', text],
  },
  {
    label: 'seed-status: the fetch (seed)',
    method: 'radicle_seed',
    params: { rid: RID },
    fail: (text) => embedded.cloneRepoWithProgress.mockRejectedValueOnce(new Error(text)),
    direct: () => manager.seedRepository(RID, () => {}),
    line: (rid, text) => [`[seed-status] ${rid} fetch failed: ${text}`],
  },
  {
    label: 'seed-status: the seed count after a fetch (seed)',
    method: 'radicle_seed',
    params: { rid: RID },
    fail: (text) => embedded.seeders.mockRejectedValueOnce(new Error(text)),
    direct: () => manager.seedRepository(RID, () => {}),
    line: (rid, text) => [`[seed-status] seed count failed for ${rid}: ${text}`],
  },
  {
    label: 'seed-status: a status listener (seed)',
    method: 'radicle_seed',
    params: { rid: RID },
    fail: failSend,
    direct: () => manager.seedRepository(RID, (status) => mockSend('status', status)),
    line: (rid, text) => [`[seed-status] listener failed for ${rid}: ${text}`],
  },
  {
    label: 'seed-status: a new subscriber (getSeedStatus during a fetch)',
    method: 'radicle_getSeedStatus',
    params: { rid: RID },
    before: startPendingFetch,
    fail: failSend,
    direct: () => manager.getSeedFetchStatus(RID, (status) => mockSend('status', status)),
    after: finishPendingFetch,
    line: (rid, text) => [`[seed-status] listener failed for ${rid}: ${text}`],
  },
];

const CASES = LINES.flatMap((entry) =>
  HOMES.map(([home, path, sep]) => ({ ...entry, home, path, text: storageError(path, sep) }))
);

const loggedLines = () => [
  ...log.debug.mock.calls,
  ...log.info.mock.calls,
  ...log.warn.mock.calls,
  ...log.error.mock.calls,
];

// No logged line may name the home, raw or JSON-escaped, the repository,
// or any absolute path.
function expectNothingPrivateLogged(home) {
  const lines = loggedLines();
  expect(lines.length).toBeGreaterThan(0);
  for (const args of lines) {
    const text = JSON.stringify(args);
    expect(args.join(' ')).not.toContain(home);
    expect(text).not.toContain(JSON.stringify(home).slice(1, -1));
    expect(text).not.toContain(RID_Z);
    for (const absolute of ABSOLUTE_PATHS) expect(absolute.test(args.join(' '))).toBe(false);
  }
}

// Run one case: start what must already be running, set the failure up,
// make the call, and let what it started finish. A fetch started before
// the call is not the call's: it finishes with a working send, so the lines
// it logs in its own context are not counted against the call.
async function run({ before, fail, after, text }, call) {
  if (before) await before();
  jest.clearAllMocks();
  fail(text);
  const result = await call();
  await settle();
  mockSend.mockReset();
  if (after) await after();
  return result;
}

beforeAll(async () => {
  // A seed status carries its times; a fixed clock lets two replies compare.
  jest.spyOn(Date, 'now').mockReturnValue(1000);
  // The core has started and reported no pending node recovery.
  require('../core/node-identity-guard').setStartupRecovery(null);
  await manager.startRadicle();
  await settle();
});

afterAll(() => {
  fs.rmSync(mockDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockReset();
  mockFixture.lookup.mode = 'registry';
  seedStatus._reset();
  cob.clearIdentityCache();
  permissions.getPermission.mockReturnValue({ origin: ORIGIN, signing: true });
});

afterEach(async () => {
  await finishPendingFetch();
});

describe('the manager and tracker lines, in any private log context (#1073)', () => {
  test.each(CASES)('$label, under $home', async (entry) => {
    await run(entry, () => runWithPrivateLogContext(true, entry.direct));
    expect(loggedLines()).toContainEqual(entry.line('<private>', '<private>'));
    expectNothingPrivateLogged(entry.path);

    jest.clearAllMocks();
    mockSend.mockReset();
    seedStatus._reset();
    await run(entry, () => runWithPrivateLogContext(false, entry.direct));
    expect(loggedLines()).toContainEqual(entry.line(RID, entry.text));
  });
});

describe('the manager and tracker lines, through window.radicle (#1073)', () => {
  // Every method that reaches these lines is main's (freedom-core design
  // 0011, PRQ-8): a page's request runs on main's page path, which a private
  // window never reaches, and the chrome has no route (PRQ-8c). Through that
  // path, each line logs the detail, and <private> in a private log context.
  test.each(CASES)('$label, under $home: main\'s page path logs the detail, and <private> in a private log context', async (entry) => {
    const privateReply = await run(entry, () =>
      runWithPrivateLogContext(true, () => pageExecute(entry.method, entry.params))
    );
    expect(loggedLines()).toContainEqual(entry.line('<private>', '<private>'));
    expectNothingPrivateLogged(entry.path);

    jest.clearAllMocks();
    mockSend.mockReset();
    seedStatus._reset();
    cob.clearIdentityCache();
    const publicReply = await run(entry, () => pageExecute(entry.method, entry.params));
    expect(loggedLines()).toContainEqual(entry.line(RID, entry.text));
    // The reply is the same either way.
    expect(privateReply).toEqual(publicReply);
  });

  test('a node-status read answers with success after its repository count failed', async () => {
    const text = storageError(HOMES[0][1], '/');
    embedded.listRepos.mockRejectedValueOnce(new Error(text));
    await expect(pageExecute('radicle_getNodeStatus')).resolves.toEqual({
      result: { running: true, status: 'running', peers: 3, alias: 'me', nid: 'z6MkTest' },
    });
    expect(loggedLines()).toEqual([['[Radicle] Could not read seeded repository count:', text]]);
  });

  test('the provider registers no route for the chrome', () => {
    expect(mockHandlers.has('radicle:provider-execute')).toBe(false);
  });
});

