/**
 * #1073: the private log context redacts nothing by itself. Each log line a
 * window.radicle request reaches has to pass the add-on's text, and the RID
 * it names, through redactForLog. These lines sit below the provider, in
 * radicle-manager, the seed-status tracker and the add-on wrapper. Most log
 * a failure and swallow it, so the provider's own redacted catch never runs:
 * `radicle_getNodeStatus` answers with success after its repository count
 * failed. On this branch R-9 refuses a private window's seed, sync and unseed
 * before the manager, and subscribes no listener for its getSeedStatus, so
 * the repository count is the one line a private window reaches; each line
 * still redacts in any private log context.
 *
 * Runs the real IPC handler, radicle-manager, seed-status tracker,
 * cob-service, private-window registry (only the window lookup is faked),
 * fail-closed sender check and log context. The add-on and the permission
 * store are mocks.
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
jest.mock('./radicle-permissions', () => ({
  getPermission: jest.fn(),
  hasSigningGrant: jest.fn(() => true),
  getAutoApprove: jest.fn(() => false),
  updateLastUsed: jest.fn(),
  revokePermission: jest.fn(() => true),
}));

const fs = require('fs');
const IPC = require('../../shared/ipc-channels');
const log = require('../logger');
const embedded = require('../radicle-embedded');
const manager = require('../radicle-manager');
const seedStatus = require('./seed-status');
const permissions = require('./radicle-permissions');
const cob = require('./cob-service');
const privateWindows = require('../private/private-windows');
const { runWithPrivateLogContext } = require('../private/private-log-context');
const { registerRadicleProviderIpc } = require('./radicle-provider-ipc');

registerRadicleProviderIpc();

const ORIGIN = 'https://forge.example';
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const RID_Z = RID.slice('rad:'.length);

const publicChrome = mockFixture.publicSender();
const privateChrome = mockFixture.privateSender(privateWindows);
const META = { webContentsId: 9, approval: 'user' };
const execute = (sender, method, params = {}) =>
  mockHandlers.get(IPC.RADICLE_PROVIDER_EXECUTE)(sender === undefined ? {} : { sender }, {
    method,
    params,
    origin: ORIGIN,
    meta: META,
  });

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

// R-9 refuses these for a private window before the manager.
const PRIVATE_REFUSED = new Set(['radicle_seed', 'radicle_sync', 'radicle_unseed']);
const REACHED = CASES.filter((entry) => entry.method === 'radicle_getNodeStatus');
const NOT_REACHED = CASES.filter((entry) => entry.method !== 'radicle_getNodeStatus');
// The add-on calls a seed, sync or unseed makes.
const SEED_CALLS = [
  'cloneRepoWithProgress',
  'cancelClone',
  'unseedRepo',
  'listSeededRepos',
  'seeders',
];

describe('the manager and tracker lines, through window.radicle (#1073)', () => {
  test.each(NOT_REACHED)(
    '$label, under $home: a private window never reaches it, a normal one logs the detail',
    async (entry) => {
      // Every window send fails, so a listener the request subscribed would
      // log. The add-on's failure is not set up: nothing reaches the add-on.
      if (entry.before) await entry.before();
      jest.clearAllMocks();
      failSend(entry.text);
      const privateReply = await execute(privateChrome, entry.method, entry.params);
      await settle();
      for (const call of SEED_CALLS) expect(embedded[call]).not.toHaveBeenCalled();
      mockSend.mockReset();
      // The fetch started before the request finishes in its own context.
      if (entry.after) await entry.after();
      if (PRIVATE_REFUSED.has(entry.method)) {
        expect(privateReply).toEqual({
          error: {
            code: 4100,
            message: 'Not available in private windows',
            data: { reason: 'private_window' },
          },
        });
      } else {
        expect(privateReply).toEqual({ result: expect.objectContaining({ rid: RID }) });
      }
      expect(loggedLines()).not.toContainEqual(entry.line('<private>', '<private>'));
      for (const args of loggedLines()) expect(JSON.stringify(args)).not.toContain(RID_Z);

      jest.clearAllMocks();
      mockSend.mockReset();
      seedStatus._reset();
      await run(entry, () => execute(publicChrome, entry.method, entry.params));
      expect(loggedLines()).toContainEqual(entry.line(RID, entry.text));
    }
  );

  test.each(REACHED)(
    '$label, under $home: a private window logs <private>, a normal one the detail',
    async (entry) => {
      const privateReply = await run(entry, () =>
        execute(privateChrome, entry.method, entry.params)
      );
      expect(loggedLines()).toContainEqual(entry.line('<private>', '<private>'));
      expectNothingPrivateLogged(entry.path);

      jest.clearAllMocks();
      mockSend.mockReset();
      seedStatus._reset();
      cob.clearIdentityCache();
      const publicReply = await run(entry, () =>
        execute(publicChrome, entry.method, entry.params)
      );
      expect(loggedLines()).toContainEqual(entry.line(RID, entry.text));
      // The reply is the same either way.
      expect(privateReply).toEqual(publicReply);
    }
  );

  test('a node-status read answers with success after its repository count failed', async () => {
    const text = storageError(HOMES[0][1], '/');
    embedded.listRepos.mockRejectedValueOnce(new Error(text));
    await expect(execute(privateChrome, 'radicle_getNodeStatus')).resolves.toEqual({
      result: { running: true, status: 'running', peers: 3, alias: 'me', nid: 'z6MkTest' },
    });
    expect(loggedLines()).toEqual([
      ['[Radicle] Could not read seeded repository count:', '<private>'],
    ]);
  });

  // A sender main can't place in a known public window counts as private.
  test.each([
    ['no sender', undefined],
    ['a sender with no window', { id: 77, isDestroyed: () => false }],
    ['a destroyed sender', { isDestroyed: () => true }],
  ])('a node-status read from %s logs <private>', async (_label, sender) => {
    embedded.listRepos.mockRejectedValueOnce(new Error(storageError(HOMES[0][1], '/')));
    await execute(sender, 'radicle_getNodeStatus');
    expect(loggedLines()).toEqual([
      ['[Radicle] Could not read seeded repository count:', '<private>'],
    ]);
  });
});
