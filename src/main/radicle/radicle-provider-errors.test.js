/**
 * #1073: window.radicle replies never carry the Radicle add-on's own error
 * text. libradicle's text for a repository that isn't stored names its
 * storage path, `<radicle home>/storage/<rid>`, under the user's profile,
 * and its storage, git and io errors can name files there too. Each reply
 * gets a fixed text for its category, as `rad:` does (#1050), with its code
 * and data.reason unchanged, and the add-on's text goes to the log only,
 * through redactForLog.
 *
 * Runs the real IPC handler, the real private-window registry (only the
 * window lookup is faked), the real fail-closed sender check, the real log
 * context and the real cob-service; the add-on, the node manager and the
 * permission store are mocks.
 */
const mockHandlers = new Map();
const mockSend = jest.fn();
const mockFixture =
  require('../../../test/helpers/private-window-fixture').createPrivateWindowFixture();

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp/radicle-provider-errors-test' },
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
jest.mock('../radicle-embedded', () => ({
  listSeededRepos: jest.fn(async () => []),
  identity: jest.fn(async () => ({ did: 'did:key:z6MkTest', nid: 'z6MkTest', alias: 'me' })),
  createIssue: jest.fn(async () => ({ id: 'a'.repeat(40) })),
  commentIssue: jest.fn(async () => ({ id: 'b'.repeat(40) })),
  editIssueState: jest.fn(async () => ({ id: 'c'.repeat(40), state: 'closed' })),
  commentPatch: jest.fn(async () => ({ id: 'd'.repeat(40) })),
}));
jest.mock('../radicle-manager', () => ({
  isDisabledForProfile: jest.fn(() => false),
  getCurrentStatus: jest.fn(() => ({ status: 'running', error: null })),
  getConnections: jest.fn(async () => ({ success: true, count: 3 })),
  seedRepository: jest.fn(),
  unseedRepository: jest.fn(async () => ({ success: true })),
  refetchRepository: jest.fn(),
  getSeedFetchStatus: jest.fn(),
  unsubscribeSeedStatus: jest.fn(),
  validateAndNormalizeRid: jest.fn((rid) => (/^rad:z\w{20,60}$/.test(rid ?? '') ? rid : null)),
  getNodeAlias: jest.fn(),
  setNodeAlias: jest.fn(),
  STATUS: { STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', ERROR: 'error' },
}));
jest.mock('./radicle-permissions', () => ({
  getPermission: jest.fn(),
  hasSigningGrant: jest.fn(() => true),
  getAutoApprove: jest.fn(() => false),
  updateLastUsed: jest.fn(),
  revokePermission: jest.fn(() => true),
}));

const IPC = require('../../shared/ipc-channels');
const log = require('../logger');
const embedded = require('../radicle-embedded');
const manager = require('../radicle-manager');
const permissions = require('./radicle-permissions');
const cob = require('./cob-service');
const privateWindows = require('../private/private-windows');
const {
  registerRadicleProviderIpc,
  executeRadicleForPage,
  setSeedStatusSink,
} = require('./radicle-provider-ipc');
const { RADICLE_PAGE_METHODS } = require('../page/page-radicle');

registerRadicleProviderIpc();

const ORIGIN = 'https://forge.example';
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const RID_Z = RID.slice('rad:'.length);
const ISSUE = 'a'.repeat(40);
const PATCH = 'b'.repeat(40);

const publicChrome = mockFixture.publicSender();
const privateChrome = mockFixture.privateSender(privateWindows);
// The renderer reports the user's per-write approval, so no approval rule
// is in play and each request reaches its backend.
const META = { webContentsId: 9, approval: 'user' };
// A method main's page dispatcher serves (freedom-core design 0011, PRQ-8)
// runs on main's page path, under the attested key, and its replies follow
// the same rule; the chrome's route refuses it. The rest run on the
// chrome's route.
const execute = (sender, method, params = {}) =>
  RADICLE_PAGE_METHODS.includes(method)
    ? executeRadicleForPage(method, params, ORIGIN)
    : mockHandlers.get(IPC.RADICLE_PROVIDER_EXECUTE)(sender === undefined ? {} : { sender }, {
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

// A Radicle home of each kind, under a profile directory: its label, the
// home, its separator, and the detector that must find it.
const HOMES = [
  ['a Unix home', '/home/alice/.config/Freedom/profiles/default/radicle', '/', UNIX_PATH],
  [
    'a Windows drive',
    'C:\\Users\\alice\\AppData\\Roaming\\Freedom\\profiles\\default\\radicle',
    '\\',
    DRIVE_PATH,
  ],
  [
    'a UNC share',
    '\\\\fileserver\\homes\\alice\\Freedom\\profiles\\default\\radicle',
    '\\',
    UNC_PATH,
  ],
  [
    'a \\\\?\\ path',
    '\\\\?\\C:\\Users\\alice\\AppData\\Roaming\\Freedom\\profiles\\default\\radicle',
    '\\',
    VERBATIM_PATH,
  ],
];

// libradicle's texts, naming the home.
const TEXTS = {
  // A repository that isn't stored.
  missing: (home, sep) =>
    `failed to resolve path '${[home, 'storage', RID_Z].join(sep)}': ` +
    'No such file or directory; class=Os (2); code=NotFound (-3)',
  // A storage error.
  storage: (home, sep) =>
    `failed to open '${[home, 'storage', RID_Z, 'objects', 'pack'].join(sep)}': ` +
    'Permission denied; class=Os (2)',
  // A git error.
  git: (home, sep) =>
    'corrupted loose reference file: ' +
    `${[home, 'storage', RID_Z, 'refs', 'heads', 'main'].join(sep)}; class=Reference (4)`,
  // A COB write whose announce failed after a storage error.
  announce: (home, sep) =>
    `announce refs failed: failed to lock '${[home, 'node', 'node.db'].join(sep)}'`,
  // An io error of the process's own.
  io: (home, sep) =>
    `EACCES: permission denied, open '${[home, 'storage', RID_Z, 'HEAD'].join(sep)}'`,
};

const NOT_FOUND = 'not found';
const READ_FAILED = 'the read failed';
const WRITE_FAILED = 'the write failed';
const FETCH_FAILED = 'the fetch failed';
const INTERNAL = 'Internal error';
// rad:'s missing test, which picks the not-found text.
const MISSING = /not found|does not exist|NotFound/i;
const category = (text, failed) => (MISSING.test(text) ? NOT_FOUND : failed);
// cob-service's reason, decided on the add-on's text, as before.
const cobReason = (text) => {
  if (/announce refs failed/i.test(text)) return 'announce_failed';
  return /not found/i.test(text) ? 'repo_not_found' : 'native_failed';
};

const COB_WRITES = [
  ['radicle_createIssue', 'createIssue', { rid: RID, title: 'Bug', description: 'Steps' }],
  ['radicle_commentIssue', 'commentIssue', { rid: RID, issueId: ISSUE, body: 'Same here' }],
  ['radicle_editIssueState', 'editIssueState', { rid: RID, issueId: ISSUE, state: 'closed' }],
  ['radicle_commentPatch', 'commentPatch', { rid: RID, patchId: PATCH, body: 'LGTM' }],
];

const failedStatus = (text) => ({
  rid: RID,
  state: 'failed',
  inStorage: false,
  seedersKnown: 2,
  attemptCount: 1,
  recentAttempts: [
    { nid: 'z6MkPeerOne', ok: false, error: text, at: 1 },
    { nid: 'z6MkPeerTwo', ok: true, at: 2 },
  ],
  progress: { phase: 'failed', reason: text },
  lastError: text,
  startedAt: 1,
  finishedAt: 3,
});
const publicStatus = (text) => {
  const fixed = category(text, FETCH_FAILED);
  return {
    ...failedStatus(text),
    recentAttempts: [
      { nid: 'z6MkPeerOne', ok: false, error: fixed, at: 1 },
      { nid: 'z6MkPeerTwo', ok: true, at: 2 },
    ],
    progress: { phase: 'failed', reason: fixed },
    lastError: fixed,
  };
};

// Each reply path: what fails, how, and the reply it must give. `fail`
// sets the backend up to fail with `text`; `want` is the whole reply.
const PATHS = [
  {
    label: 'radicle_listSeededRepos',
    method: 'radicle_listSeededRepos',
    texts: ['missing', 'storage', 'git'],
    fail: (text) => embedded.listSeededRepos.mockRejectedValueOnce(new Error(text)),
    want: (text) => ({ error: { code: -32603, message: category(text, READ_FAILED) } }),
  },
  ...COB_WRITES.map(([method, call, params]) => ({
    label: `${method} (wrapCobError)`,
    method,
    params,
    texts: ['missing', 'storage', 'git', 'announce'],
    fail: (text) => embedded[call].mockRejectedValueOnce(new Error(text)),
    want: (text) => ({
      error: {
        code: -32603,
        message: category(text, WRITE_FAILED),
        data: { reason: cobReason(text) },
      },
    }),
  })),
  {
    label: 'radicle_getIdentity (wrapCobError)',
    method: 'radicle_getIdentity',
    texts: ['missing', 'storage'],
    fail: (text) => embedded.identity.mockRejectedValueOnce(new Error(text)),
    want: (text) => ({
      error: {
        code: -32603,
        message: category(text, READ_FAILED),
        data: { reason: cobReason(text) },
      },
    }),
  },
  {
    label: 'radicle_unseed (the manager passes on the add-on text)',
    method: 'radicle_unseed',
    params: { rid: RID },
    texts: ['missing', 'storage'],
    fail: (text) =>
      manager.unseedRepository.mockResolvedValueOnce({
        success: false,
        error: { code: 'UNSEED_FAILED', message: text, details: { rid: RID } },
      }),
    want: (text) => ({
      error: {
        code: -32603,
        message: category(text, WRITE_FAILED),
        data: { reason: 'unseed_failed' },
      },
    }),
  },
  ...[
    ['radicle_seed', 'seedRepository', 'seed_failed', WRITE_FAILED],
    ['radicle_sync', 'refetchRepository', 'sync_failed', WRITE_FAILED],
    ['radicle_getSeedStatus', 'getSeedFetchStatus', 'status_failed', READ_FAILED],
  ].map(([method, call, reason, failed]) => ({
    label: `${method} (a manager failure that isn't its own text)`,
    method,
    params: { rid: RID },
    texts: ['missing', 'storage'],
    fail: (text) =>
      manager[call].mockResolvedValueOnce({
        success: false,
        error: { code: 'NATIVE_FAILED', message: text },
      }),
    want: (text) => ({
      error: { code: -32603, message: category(text, failed), data: { reason } },
    }),
  })),
  ...[
    ['radicle_seed', 'seedRepository', (status) => ({ rid: RID, seeded: true, status })],
    ['radicle_sync', 'refetchRepository', (status) => ({ rid: RID, status })],
    ['radicle_getSeedStatus', 'getSeedFetchStatus', (status) => status],
  ].map(([method, call, shape]) => ({
    label: `${method}'s seed status`,
    method,
    // The tracker logs a fetch's failure (seed-status.js), not the provider.
    logged: false,
    params: { rid: RID },
    texts: ['missing', 'storage', 'git'],
    fail: (text) =>
      manager[call].mockResolvedValueOnce({ success: true, status: failedStatus(text) }),
    want: (text) => ({ result: shape(publicStatus(text)) }),
  })),
  {
    label: 'the catch-all (an io error from the permission store)',
    method: 'radicle_getNodeStatus',
    texts: ['io'],
    fail: (text) =>
      permissions.updateLastUsed.mockImplementationOnce(() => {
        throw Object.assign(new Error(text), { code: 'EACCES' });
      }),
    want: () => ({ error: { code: -32603, message: INTERNAL } }),
  },
  {
    label: 'the catch-all (an add-on error from getConnections)',
    method: 'radicle_getNodeStatus',
    texts: ['missing', 'storage'],
    fail: (text) => manager.getConnections.mockRejectedValueOnce(new Error(text)),
    want: (text) => ({ error: { code: -32603, message: category(text, INTERNAL) } }),
  },
  {
    // An error with a string code is passed on by handleCobWrite as it is.
    label: 'the catch-all (a COB error with a string code)',
    method: 'radicle_createIssue',
    params: COB_WRITES[0][2],
    texts: ['missing', 'io'],
    fail: (text) =>
      embedded.createIssue.mockRejectedValueOnce(Object.assign(new Error(text), { code: 'EIO' })),
    want: (text) => ({ error: { code: -32603, message: category(text, INTERNAL) } }),
  },
];

const CASES = HOMES.flatMap(([homeLabel, home, sep, detector]) =>
  PATHS.flatMap((row) =>
    row.texts.map((kind) => ({
      ...row,
      kind,
      homeLabel,
      home,
      detector,
      text: TEXTS[kind](home, sep),
    }))
  )
);

// No value may name the home, raw or JSON-escaped, or any absolute path.
function expectNoPath(value, home) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  expect(text).not.toContain(home);
  expect(text).not.toContain(JSON.stringify(home).slice(1, -1));
  for (const absolute of ABSOLUTE_PATHS) expect(absolute.test(text)).toBe(false);
}

const loggedLines = () => [...log.warn.mock.calls, ...log.error.mock.calls];

beforeEach(() => {
  jest.clearAllMocks();
  mockFixture.lookup.mode = 'registry';
  cob.clearIdentityCache();
  permissions.getPermission.mockReturnValue({ origin: ORIGIN, signing: true });
  manager.getCurrentStatus.mockReturnValue({ status: 'running', error: null });
});

describe('add-on error texts (#1073)', () => {
  test.each(
    HOMES.flatMap(([homeLabel, home, sep, detector]) =>
      Object.entries(TEXTS).map(([kind, build]) => ({ kind, homeLabel, home, sep, detector, build }))
    )
  )('the $kind text names $homeLabel', ({ home, sep, detector, build }) => {
    const text = build(home, sep);
    expect(text).toContain(home);
    expect(detector.test(text)).toBe(true);
  });

  test.each(CASES)(
    '$label: the $kind text under $homeLabel gets a fixed text, with its code',
    async ({ method, params, fail, want, text, home, logged = true }) => {
      fail(text);
      const reply = await execute(publicChrome, method, params);
      expect(reply).toEqual(want(text));
      expectNoPath(reply, home);
      if (reply.error) expectNoPath(reply.error.message, home);
      // A normal window's log keeps the add-on's text.
      expect(loggedLines().some((args) => args.includes(text))).toBe(logged);
    }
  );

  test.each(HOMES)(
    'a seedStatus event under %s carries the fixed texts',
    async (_label, home, sep) => {
      const text = TEXTS.storage(home, sep);
      manager.seedRepository.mockImplementationOnce(async (_rid, onStatus) => {
        onStatus(failedStatus(text));
        return { success: true, status: failedStatus(text) };
      });
      // A site's seed statuses go to main's page requests (PRQ-8b), which
      // send them to the site's pages.
      const sink = jest.fn();
      setSeedStatusSink(sink);
      await execute(publicChrome, 'radicle_seed', { rid: RID });
      expect(sink).toHaveBeenCalledWith(ORIGIN, publicStatus(text));
      for (const [, payload] of sink.mock.calls) expectNoPath(payload, home);
      expect(mockSend).not.toHaveBeenCalledWith(IPC.RADICLE_PROVIDER_EVENT, expect.anything());
      await execute(publicChrome, 'radicle_disconnect');
      setSeedStatusSink(null);
    }
  );

  test('a peer that failed mid-fetch gets the fixed text in progress too', async () => {
    const [, home, sep] = HOMES[1];
    const text = TEXTS.git(home, sep);
    manager.getSeedFetchStatus.mockResolvedValueOnce({
      success: true,
      status: {
        ...failedStatus(text),
        state: 'fetching',
        lastError: null,
        progress: { phase: 'peer-failed', nid: 'z6MkPeerOne', index: 0, total: 2, reason: text },
      },
    });
    const reply = await execute(publicChrome, 'radicle_getSeedStatus', { rid: RID });
    expect(reply.result.state).toBe('fetching');
    expect(reply.result.lastError).toBeNull();
    expect(reply.result.progress).toEqual({
      phase: 'peer-failed',
      nid: 'z6MkPeerOne',
      index: 0,
      total: 2,
      reason: FETCH_FAILED,
    });
    expectNoPath(reply, home);
  });

  test("the manager's own texts are kept", async () => {
    manager.seedRepository.mockResolvedValueOnce({
      success: false,
      error: { code: 'RADICLE_NOT_RUNNING', message: 'Radicle node is not running' },
    });
    await expect(execute(publicChrome, 'radicle_seed', { rid: RID })).resolves.toEqual({
      error: {
        code: -32603,
        message: 'Radicle node is not running',
        data: { reason: 'seed_failed' },
      },
    });
    manager.refetchRepository.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_SEEDED', message: 'Repository is not seeded — seed it before syncing' },
    });
    await expect(execute(publicChrome, 'radicle_sync', { rid: RID })).resolves.toEqual({
      error: {
        code: -32602,
        message: 'Repository is not seeded — seed it before syncing',
        data: { reason: 'not_seeded' },
      },
    });
    manager.unseedRepository.mockResolvedValueOnce({
      success: false,
      error: { code: 'INVALID_RID', message: 'Invalid Radicle Repository ID' },
    });
    await expect(execute(publicChrome, 'radicle_unseed', { rid: RID })).resolves.toEqual({
      error: {
        code: -32603,
        message: 'Invalid Radicle Repository ID',
        data: { reason: 'unseed_failed' },
      },
    });
  });

  test("cob-service's validation texts are kept", async () => {
    await expect(
      execute(publicChrome, 'radicle_createIssue', { rid: RID, title: '', description: 'x' })
    ).resolves.toEqual({
      error: {
        code: -32602,
        message: 'title must be a non-empty string',
        data: { reason: 'invalid_title' },
      },
    });
  });

  const TOO_LARGE = 'repository data too large to serve here';
  const CANCELLED = 'request cancelled';
  test.each([
    ["libradicle's size bound", '41943040 bytes is over the limit of 33554432', TOO_LARGE],
    ["libradicle's depth bound", 'the tree is nested deeper than 64 levels', TOO_LARGE],
    ['a cancelled call', 'cancelled', CANCELLED],
    ["an older add-on's cancel", 'clone cancelled', CANCELLED],
    [
      'a failure naming a cancelled directory',
      "failed to open '/home/alice/cancelled/radicle/storage': Permission denied",
      null,
    ],
    [
      'a failure quoting a bound',
      "failed to read '/home/alice/2 bytes is over the limit of 1': Input/output error",
      null,
    ],
  ])('%s gets its category, with its code', async (_label, text, fixed) => {
    embedded.listSeededRepos.mockRejectedValueOnce(new Error(text));
    await expect(execute(publicChrome, 'radicle_listSeededRepos')).resolves.toEqual({
      error: { code: -32603, message: fixed || READ_FAILED },
    });
    embedded.commentPatch.mockRejectedValueOnce(new Error(text));
    await expect(execute(publicChrome, 'radicle_commentPatch', COB_WRITES[3][2])).resolves.toEqual({
      error: { code: -32603, message: fixed || WRITE_FAILED, data: { reason: 'native_failed' } },
    });
    manager.getSeedFetchStatus.mockResolvedValueOnce({ success: true, status: failedStatus(text) });
    const reply = await execute(publicChrome, 'radicle_getSeedStatus', { rid: RID });
    expect(reply.result.lastError).toBe(fixed || FETCH_FAILED);
  });
});

// The log sites a private window's request can reach. Reads only: they are
// what every branch lets a private window make.
const LOG_SITES = [
  {
    label: 'radicle_listSeededRepos',
    method: 'radicle_listSeededRepos',
    fail: (text) => embedded.listSeededRepos.mockRejectedValueOnce(new Error(text)),
  },
  {
    label: 'radicle_getIdentity',
    method: 'radicle_getIdentity',
    fail: (text) => embedded.identity.mockRejectedValueOnce(new Error(text)),
  },
  {
    label: 'radicle_getSeedStatus',
    method: 'radicle_getSeedStatus',
    params: { rid: RID },
    fail: (text) =>
      manager.getSeedFetchStatus.mockResolvedValueOnce({
        success: false,
        error: { code: 'NATIVE_FAILED', message: text },
      }),
  },
  {
    label: "getNodeStatus's identity lookup",
    method: 'radicle_getNodeStatus',
    fail: (text) => embedded.identity.mockRejectedValueOnce(new Error(text)),
  },
  {
    label: 'the catch-all',
    method: 'radicle_getNodeStatus',
    fail: (text) => manager.getConnections.mockRejectedValueOnce(new Error(text)),
  },
];

describe('private senders (#1073)', () => {
  const [, home, sep] = HOMES[0];
  const text = TEXTS.storage(home, sep);
  // Each line the request logged with the add-on's text in it, or with
  // <private> where that text would be.
  const lines = () =>
    loggedLines().filter((args) => args.includes(text) || args.includes('<private>'));

  // A private window's request never reaches main's page path (main's
  // attestation refuses it, PRQ-2), so these are the chrome route's.
  test.each(LOG_SITES.filter((site) => !RADICLE_PAGE_METHODS.includes(site.method)))(
    '$label: a private window logs <private>, a normal one the detail',
    async ({ method, params, fail }) => {
      fail(text);
      const privateReply = await execute(privateChrome, method, params);
      expect(lines().length).toBeGreaterThan(0);
      for (const args of loggedLines()) expectNoPath(args, home);
      expect(lines().every((args) => args.includes('<private>'))).toBe(true);

      jest.clearAllMocks();
      cob.clearIdentityCache();
      fail(text);
      const publicReply = await execute(publicChrome, method, params);
      expect(lines().length).toBeGreaterThan(0);
      expect(lines().every((args) => args.includes(text))).toBe(true);
      // The reply is the same either way.
      expect(privateReply).toEqual(publicReply);
      expectNoPath(privateReply, home);
    }
  );

  // A sender main can't place in a known public window counts as private.
  test.each([
    ['no sender', undefined],
    ['a sender with no window', { id: 77, isDestroyed: () => false }],
    ['a destroyed sender', { isDestroyed: () => true }],
  ])('%s logs <private>', async (_label, sender) => {
    cob.clearIdentityCache();
    embedded.identity.mockRejectedValueOnce(new Error(text));
    await execute(sender, 'radicle_getIdentity');
    expect(lines()).toEqual([['[radicle-provider] radicle_getIdentity failed:', '<private>']]);
  });

  test.each(['null', 'throw'])(
    'a public sender whose window lookup gives %s logs <private>',
    async (mode) => {
      mockFixture.lookup.mode = mode;
      cob.clearIdentityCache();
      embedded.identity.mockRejectedValueOnce(new Error(text));
      await execute(publicChrome, 'radicle_getIdentity');
      expect(lines()).toEqual([
        ['[radicle-provider] radicle_getIdentity failed:', '<private>'],
      ]);
    }
  );
});
