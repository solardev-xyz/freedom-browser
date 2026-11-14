const mockProviderSend = jest.fn();
const mockIpcHandle = jest.fn();

const mockWebContentsFromId = jest.fn();
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp/test-user-data') },
  ipcMain: { handle: mockIpcHandle },
  webContents: { fromId: (...args) => mockWebContentsFromId(...args) },
  BrowserWindow: {
    getAllWindows: jest.fn(() => [
      { webContents: { isDestroyed: jest.fn(() => false), send: mockProviderSend } },
    ]),
  },
}));

// The private-window guard is covered through the real classifier and
// permission store in radicle-provider-private.test.js; here every sender
// counts as a known public window.
jest.mock('../private/private-sender', () => ({ isPrivateSender: () => false }));

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../radicle-embedded', () => ({
  listRepos: jest.fn(async () => [
    {
      rid: 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5',
      name: 'heartwood',
      description: 'hw',
    },
  ]),
  listSeededRepos: jest.fn(async () => [
    {
      rid: 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5',
      name: 'heartwood',
      description: 'hw',
    },
  ]),
}));

const mockSeedFetchStatus = {
  rid: 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5',
  state: 'fetching',
  inStorage: false,
  seedersKnown: 7,
  attemptCount: 0,
  recentAttempts: [],
  lastError: null,
  startedAt: 1,
  finishedAt: null,
};

jest.mock('../radicle-manager', () => ({
  // The add-on: no service generation, so no write refusal (plan B10).
  activeRadicleIdentity: jest.fn(() => null),
  radicleWriteRefusal: jest.fn(() => null),
  isDisabledForProfile: jest.fn(() => false),
  getCurrentStatus: jest.fn(() => ({ status: 'running', error: null })),
  getConnections: jest.fn(async () => ({ success: true, count: 3 })),
  seedRepository: jest.fn(async () => ({ success: true, status: mockSeedFetchStatus })),
  unseedRepository: jest.fn(async () => ({ success: true })),
  refetchRepository: jest.fn(async () => ({ success: true, status: mockSeedFetchStatus })),
  getSeedFetchStatus: jest.fn(() => ({ success: true, status: mockSeedFetchStatus })),
  unsubscribeSeedStatus: jest.fn(),
  validateAndNormalizeRid: jest.fn((rid) => {
    const m = /^(?:rad:)?(z[1-9A-HJ-NP-Za-km-z]{20,60})$/.exec(rid ?? '');
    return m ? `rad:${m[1]}` : null;
  }),
  runRad: jest.fn(),
  STATUS: { STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', ERROR: 'error' },
}));

jest.mock('./cob-service', () => {
  class CobValidationError extends Error {
    constructor(reason, message) {
      super(message);
      this.reason = reason;
    }
  }
  // A write the running node can't make (plan B10, `needs_vault`).
  class CobAdmissionError extends Error {
    constructor(reason, message) {
      super(message);
      this.reason = reason;
    }
  }
  // A write the service took and didn't confirm (plan B11, `outcome_unknown`).
  class CobOutcomeUnknownError extends Error {
    constructor() {
      super('The Radicle node stopped before confirming this write; it may have been recorded.');
      this.reason = 'outcome_unknown';
    }
  }
  return {
    createIssue: jest.fn(async () => ({ id: 'a'.repeat(40) })),
    commentIssue: jest.fn(async () => ({ id: 'b'.repeat(40) })),
    editIssueState: jest.fn(async () => ({ id: 'c'.repeat(40), state: 'closed' })),
    commentPatch: jest.fn(async () => ({ id: 'd'.repeat(40) })),
    getIdentity: jest.fn(async () => ({ did: 'did:key:z6MkTest', nid: 'z6MkTest', alias: 'me' })),
    CobValidationError,
    CobAdmissionError,
    CobOutcomeUnknownError,
    OUTCOME_UNKNOWN_MESSAGE:
      'The Radicle node stopped before confirming this write; it may have been recorded.',
    LIMITS: { maxTitleBytes: 200, maxBodyBytes: 65536 },
  };
});

jest.mock('./radicle-permissions', () => ({
  getPermission: jest.fn(() => ({ origin: 'test', signing: false })),
  hasSigningGrant: jest.fn(() => false),
  getAutoApprove: jest.fn(() => false),
  updateLastUsed: jest.fn(),
  revokePermission: jest.fn(() => true),
  // The identity core's judgement of a rule-answered write (R-6).
  admitAutoWrite: jest.fn(async () => ({ covered: true })),
}));

const {
  executeRadicleMethod,
  executeRadicleForPage,
  setSeedStatusSink,
  registerRadicleProviderIpc,
} = require('./radicle-provider-ipc');
const manager = require('../radicle-manager');
const cob = require('./cob-service');
const permissions = require('./radicle-permissions');

const ORIGIN = 'bzz://canopyref';
// The renderer showed the per-write prompt and the user approved.
const USER_APPROVED = { approval: 'user' };
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';

beforeEach(() => {
  jest.clearAllMocks();
  manager.isDisabledForProfile.mockReturnValue(false);
  manager.getCurrentStatus.mockReturnValue({ status: 'running', error: null });
  permissions.getPermission.mockReturnValue({ origin: ORIGIN, signing: false });
  permissions.hasSigningGrant.mockReturnValue(false);
  permissions.getAutoApprove.mockReturnValue(false);
  permissions.admitAutoWrite.mockResolvedValue({ covered: true });
});

// PRQ-8b: a site's seed statuses go to main's page requests, which send
// them to the site's pages; no chrome window hears them.
test('a site\'s pushed seed progress goes to main\'s sink, never to the chrome windows', async () => {
  const sink = jest.fn();
  setSeedStatusSink(sink);
  try {
    manager.seedRepository.mockImplementationOnce(async (_rid, onStatus) => {
      onStatus(mockSeedFetchStatus);
      return { success: true, status: mockSeedFetchStatus };
    });
    expect(await executeRadicleForPage('radicle_seed', { rid: RID }, ORIGIN)).toEqual({
      result: { rid: RID, seeded: true, status: mockSeedFetchStatus },
    });
    expect(sink).toHaveBeenCalledWith(ORIGIN, mockSeedFetchStatus);
    expect(mockProviderSend).not.toHaveBeenCalled();
    // The site's own disconnect removes the origin's broadcaster.
    await executeRadicleForPage('radicle_disconnect', {}, ORIGIN);
    expect(manager.unsubscribeSeedStatus).toHaveBeenCalledWith(expect.any(Function));
  } finally {
    setSeedStatusSink(null);
  }
});

// PRQ-8c: every window.radicle method is main's. Custody, the prompts and
// the rules are the page dispatcher's (page-radicle-seed.test.js,
// page-radicle-sign.test.js); the provider registers no chrome route.
test('the provider registers no chrome route, only its alias channels', () => {
  registerRadicleProviderIpc();
  expect(mockIpcHandle.mock.calls.map(([channel]) => channel).sort()).toEqual(['radicle:get-alias', 'radicle:set-alias']);
});

const expectProviderError = async (promise, code, reason) => {
  const err = await promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (e) => e
  );
  expect(err.code).toBe(code);
  if (reason) expect(err.data?.reason).toBe(reason);
  return err;
};

describe('dispatch and gating', () => {
  test('unknown method → 4200', async () => {
    await expectProviderError(executeRadicleMethod('radicle_nope', {}, ORIGIN), 4200);
  });

  test('missing origin → 4100', async () => {
    await expectProviderError(executeRadicleMethod('radicle_getCapabilities', {}, null), 4100);
  });

  test('profile disabled → 4900 for every method', async () => {
    manager.isDisabledForProfile.mockReturnValue(true);
    await expectProviderError(
      executeRadicleMethod('radicle_getCapabilities', {}, ORIGIN),
      4900,
      'profile-disabled'
    );
  });

  test('connection-tier method without permission → 4100 not_connected', async () => {
    permissions.getPermission.mockReturnValue(null);
    await expectProviderError(
      executeRadicleMethod('radicle_seed', { rid: RID }, ORIGIN),
      4100,
      'not_connected'
    );
  });

  test('signing-tier method without signing grant → 4100 signing_not_granted', async () => {
    await expectProviderError(
      executeRadicleMethod(
        'radicle_createIssue',
        { rid: RID, title: 't', description: 'd' },
        ORIGIN
      ),
      4100,
      'signing_not_granted'
    );
    expect(cob.createIssue).not.toHaveBeenCalled();
  });

  test('node stopped → 4900 for node-dependent methods', async () => {
    manager.getCurrentStatus.mockReturnValue({ status: 'stopped', error: null });
    await expectProviderError(
      executeRadicleMethod('radicle_seed', { rid: RID }, ORIGIN),
      4900,
      'node-stopped'
    );
  });

  test('getNodeStatus works while node is stopped (reports state)', async () => {
    manager.getCurrentStatus.mockReturnValue({ status: 'stopped', error: null });
    const result = await executeRadicleMethod('radicle_getNodeStatus', {}, ORIGIN);
    expect(result).toEqual({ running: false, status: 'stopped' });
  });

  // The core takes a last use only from the page (design 0012, APB-3).
  test('updates lastUsed for permissioned methods, under the page', async () => {
    const page = { origin: ORIGIN, top_origin: ORIGIN, frame: 1, navigation: 2, agent: false };
    await executeRadicleMethod('radicle_seed', { rid: RID }, ORIGIN, { pageContext: () => page });
    expect(permissions.updateLastUsed).toHaveBeenCalledWith(ORIGIN, { page });
    permissions.updateLastUsed.mockClear();
    await executeRadicleMethod('radicle_seed', { rid: RID }, ORIGIN);
    expect(permissions.updateLastUsed).not.toHaveBeenCalled();
  });
});

describe('radicle_getCapabilities', () => {
  test('reports canUseNode true when connected and running', async () => {
    const caps = await executeRadicleMethod('radicle_getCapabilities', {}, ORIGIN);
    expect(caps).toEqual({
      specVersion: '0.2',
      canUseNode: true,
      reason: null,
      writes: ['issue', 'issueComment', 'issueState', 'patchComment'],
    });
  });

  test('reports not-connected without permission (no error)', async () => {
    permissions.getPermission.mockReturnValue(null);
    const caps = await executeRadicleMethod('radicle_getCapabilities', {}, ORIGIN);
    expect(caps.canUseNode).toBe(false);
    expect(caps.reason).toBe('not-connected');
  });

  test('reports node-stopped when connected but node down', async () => {
    manager.getCurrentStatus.mockReturnValue({ status: 'stopped', error: null });
    const caps = await executeRadicleMethod('radicle_getCapabilities', {}, ORIGIN);
    expect(caps.reason).toBe('node-stopped');
  });
});

describe('node actions', () => {
  test('radicle_seed validates rid', async () => {
    await expectProviderError(
      executeRadicleMethod('radicle_seed', { rid: 'nope' }, ORIGIN),
      -32602,
      'invalid_rid'
    );
    expect(manager.seedRepository).not.toHaveBeenCalled();
  });

  test('radicle_seed happy path returns initial fetch status', async () => {
    const result = await executeRadicleMethod('radicle_seed', { rid: RID }, ORIGIN);
    expect(result).toEqual({ rid: RID, seeded: true, status: mockSeedFetchStatus });
    expect(manager.seedRepository).toHaveBeenCalledWith(RID);
  });

  test('radicle_seed forwards native progress to the provider event callback', async () => {
    const onSeedStatus = jest.fn();
    manager.seedRepository.mockImplementationOnce(async (_rid, onStatus) => {
      onStatus(mockSeedFetchStatus);
      return { success: true, status: mockSeedFetchStatus };
    });

    await executeRadicleMethod('radicle_seed', { rid: RID }, ORIGIN, { onSeedStatus });

    expect(manager.seedRepository).toHaveBeenCalledWith(RID, onSeedStatus);
    expect(onSeedStatus).toHaveBeenCalledWith(mockSeedFetchStatus);
  });

  test('radicle_getSeedStatus returns tracker status', async () => {
    const result = await executeRadicleMethod('radicle_getSeedStatus', { rid: RID }, ORIGIN);
    expect(result).toEqual(mockSeedFetchStatus);
    expect(manager.getSeedFetchStatus).toHaveBeenCalledWith(RID);
  });

  test('radicle_getSeedStatus reattaches pushed progress after reload', async () => {
    const onSeedStatus = jest.fn();
    await executeRadicleMethod(
      'radicle_getSeedStatus',
      { rid: RID },
      ORIGIN,
      { onSeedStatus }
    );
    expect(manager.getSeedFetchStatus).toHaveBeenCalledWith(RID, onSeedStatus);
  });

  test('radicle_disconnect revokes the origin grant, works while node stopped', async () => {
    manager.getCurrentStatus.mockReturnValue({ status: 'stopped', error: null });
    const result = await executeRadicleMethod('radicle_disconnect', {}, ORIGIN);
    expect(result).toEqual({ connected: false });
    // Main's own revoke without the page; the page's own under it.
    expect(permissions.revokePermission).toHaveBeenCalledWith(ORIGIN, {});
    const page = { origin: ORIGIN, top_origin: ORIGIN, frame: 1, navigation: 2, agent: false };
    await executeRadicleMethod('radicle_disconnect', {}, ORIGIN, { pageContext: () => page });
    expect(permissions.revokePermission).toHaveBeenLastCalledWith(ORIGIN, { page });
  });

  test('radicle_getSeedStatus validates rid', async () => {
    await expectProviderError(
      executeRadicleMethod('radicle_getSeedStatus', { rid: 'nope' }, ORIGIN),
      -32602,
      'invalid_rid'
    );
    expect(manager.getSeedFetchStatus).not.toHaveBeenCalled();
  });

  test('radicle_seed maps backend failure to -32603', async () => {
    manager.seedRepository.mockResolvedValue({
      success: false,
      error: { message: 'Repository not found on the network' },
    });
    const err = await expectProviderError(
      executeRadicleMethod('radicle_seed', { rid: RID }, ORIGIN),
      -32603,
      'seed_failed'
    );
    expect(err.message).toContain('not found');
  });

  test('radicle_unseed and radicle_sync happy paths', async () => {
    await expect(executeRadicleMethod('radicle_unseed', { rid: RID }, ORIGIN)).resolves.toEqual({
      rid: RID,
      seeded: false,
    });
    // sync is the non-blocking retry path: restart fetch, report status
    await expect(executeRadicleMethod('radicle_sync', { rid: RID }, ORIGIN)).resolves.toEqual({
      rid: RID,
      status: mockSeedFetchStatus,
    });
    expect(manager.refetchRepository).toHaveBeenCalledWith(RID);
  });

  // sync holds only the connection grant, so it must not become a second,
  // promptless route to seeding: the native fetch writes the policy.
  test('radicle_sync surfaces an unseeded repo as not_seeded, never as a seed', async () => {
    manager.refetchRepository.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_SEEDED', message: 'Repository is not seeded — seed it before syncing' },
    });
    const err = await executeRadicleMethod('radicle_sync', { rid: RID }, ORIGIN).catch((e) => e);
    expect(err).toMatchObject({ code: -32602, data: { reason: 'not_seeded' } });
    expect(manager.seedRepository).not.toHaveBeenCalled();
  });

  test('radicle_listSeededRepos reads native seeding policies', async () => {
    const repos = await executeRadicleMethod('radicle_listSeededRepos', {}, ORIGIN);
    expect(repos).toEqual([{ rid: RID, name: 'heartwood', description: 'hw' }]);
  });
});

describe('signing tier', () => {
  beforeEach(() => {
    permissions.hasSigningGrant.mockReturnValue(true);
  });

  test('radicle_getIdentity returns identity', async () => {
    const identity = await executeRadicleMethod('radicle_getIdentity', {}, ORIGIN);
    expect(identity.did).toBe('did:key:z6MkTest');
    expect(identity.alias).toBe('me');
  });

  test('radicle_createIssue passes params through', async () => {
    const result = await executeRadicleMethod(
      'radicle_createIssue',
      { rid: RID, title: 'Bug', description: 'Details', labels: ['bug'] },
      ORIGIN,
      USER_APPROVED
    );
    expect(result.id).toMatch(/^a+$/);
    expect(cob.createIssue).toHaveBeenCalledWith({
      rid: RID,
      title: 'Bug',
      description: 'Details',
      labels: ['bug'],
    });
  });

  test('cob validation errors map to -32602 with reason', async () => {
    cob.createIssue.mockRejectedValue(new cob.CobValidationError('invalid_title', 'bad title'));
    await expectProviderError(
      executeRadicleMethod('radicle_createIssue', { rid: RID }, ORIGIN, USER_APPROVED),
      -32602,
      'invalid_title'
    );
  });

  test('cob backend errors map to -32603 with reason', async () => {
    cob.commentIssue.mockRejectedValue(
      Object.assign(new Error('repo missing'), { reason: 'repo_not_found' })
    );
    await expectProviderError(
      executeRadicleMethod(
        'radicle_commentIssue',
        { rid: RID, issueId: 'ab12cd', body: 'hi' },
        ORIGIN,
        USER_APPROVED
      ),
      -32603,
      'repo_not_found'
    );
  });

  test('radicle_editIssueState and radicle_commentPatch dispatch', async () => {
    await executeRadicleMethod(
      'radicle_editIssueState',
      { rid: RID, issueId: 'ab12cd', state: 'closed' },
      ORIGIN,
      USER_APPROVED
    );
    expect(cob.editIssueState).toHaveBeenCalled();
    await executeRadicleMethod(
      'radicle_commentPatch',
      { rid: RID, patchId: 'ab12cd', body: 'lgtm' },
      ORIGIN,
      USER_APPROVED
    );
    expect(cob.commentPatch).toHaveBeenCalled();
  });

  test('getNodeStatus: alias at connection tier, nid only with signing grant', async () => {
    const withGrant = await executeRadicleMethod('radicle_getNodeStatus', {}, ORIGIN);
    expect(withGrant.nid).toBe('z6MkTest');
    expect(withGrant.alias).toBe('me');
    expect(withGrant.peers).toBe(3);

    permissions.hasSigningGrant.mockReturnValue(false);
    const withoutGrant = await executeRadicleMethod('radicle_getNodeStatus', {}, ORIGIN);
    expect(withoutGrant.nid).toBeUndefined();
    expect(withoutGrant.alias).toBe('me');
  });
});

describe('signed write approval (R-6)', () => {
  const PAGE = Object.freeze({ origin: ORIGIN, top_origin: ORIGIN, frame: 3, navigation: 7, agent: false });
  const write = (approval) =>
    executeRadicleMethod(
      'radicle_commentIssue',
      { rid: RID, issueId: 'ab12cd', body: 'hi' },
      ORIGIN,
      { ...(approval ? { approval } : {}), pageContext: () => PAGE }
    );
  const ruleOn = () => permissions.getAutoApprove.mockImplementation((_origin, type) => type === 'signing');

  beforeEach(() => {
    permissions.hasSigningGrant.mockReturnValue(true);
    cob.commentIssue.mockImplementation(async () => ({ id: 'b'.repeat(40) }));
  });

  test('without the "always allow writes" rule an automatic write is refused', async () => {
    for (const approval of ['auto', undefined, 'something']) {
      await expectProviderError(write(approval), 4100, 'approval_required');
    }
    expect(cob.commentIssue).not.toHaveBeenCalled();
    expect(permissions.admitAutoWrite).not.toHaveBeenCalled();
    await write('user');
    expect(cob.commentIssue).toHaveBeenCalledTimes(1);
  });

  // freedom-core design 0012, "A page's Radicle write" (cored 0.16.0): the
  // identity core judges a rule-answered write and counts it in R-6
  // (`approval.radicle_write`), under the page, for its own key.
  test("a rule-answered write is the core's to judge, under the request's PageContext; covered, it is written", async () => {
    ruleOn();
    await expect(write('auto')).resolves.toEqual({ id: 'b'.repeat(40) });
    expect(permissions.admitAutoWrite).toHaveBeenCalledTimes(1);
    expect(permissions.admitAutoWrite).toHaveBeenCalledWith(ORIGIN, { page: PAGE });
    // Asked before the write.
    expect(permissions.admitAutoWrite.mock.invocationCallOrder[0]).toBeLessThan(cob.commentIssue.mock.invocationCallOrder[0]);
    // A write the user approves on its prompt isn't asked about, nor counted.
    await write('user');
    expect(permissions.admitAutoWrite).toHaveBeenCalledTimes(1);
    expect(cob.commentIssue).toHaveBeenCalledTimes(2);
  });

  test.each([
    // Past R-6: the dispatcher asks the user instead (page-radicle.js).
    ['rate_limited', 'auto_write_limit', "This site has used up its automatic writes for now; this one needs the user's approval"],
    ['no_rule', 'approval_required', "This write needs the user's approval"],
    ['custody', 'agent_custody', 'A page in Agent custody needs approval for this action'],
  ])("the core's %s is today's %s refusal, with nothing written", async (reason, refusal, message) => {
    ruleOn();
    permissions.admitAutoWrite.mockResolvedValue({ covered: false, reason });
    const err = await expectProviderError(write('auto'), 4100, refusal);
    expect(err.message).toBe(message);
    expect(cob.commentIssue).not.toHaveBeenCalled();
  });

  test('not_moved, an answer with no known reason, no core to ask, or no page: an internal error, with nothing written', async () => {
    ruleOn();
    const notMoved = Object.assign(new Error('the radicle store has not moved'), { code: 'not_moved', data: { store: 'radicle' } });
    for (const answer of [
      () => Promise.reject(notMoved),
      () => Promise.reject(Object.assign(new Error('core unavailable'), { code: 'core_unavailable' })),
      () => Promise.resolve({ covered: false, reason: 'something_else' }),
      () => Promise.resolve({ covered: false }),
      () => Promise.resolve(null),
    ]) {
      permissions.admitAutoWrite.mockImplementationOnce(answer);
      const err = await expectProviderError(write('auto'), -32603);
      expect(err).toEqual({ code: -32603, message: 'Internal error' });
    }
    // A rule-answered write without its page is never asked about.
    permissions.admitAutoWrite.mockClear();
    await expectProviderError(
      executeRadicleMethod('radicle_commentIssue', { rid: RID, issueId: 'ab12cd', body: 'hi' }, ORIGIN, { approval: 'auto' }),
      -32603
    );
    expect(permissions.admitAutoWrite).not.toHaveBeenCalled();
    expect(cob.commentIssue).not.toHaveBeenCalled();
  });

  test("asked last: a write main refuses first (no connection, no signing grant, the node stopped) is never counted", async () => {
    ruleOn();
    permissions.getPermission.mockReturnValueOnce(null);
    await expectProviderError(write('auto'), 4100, 'not_connected');
    permissions.hasSigningGrant.mockReturnValueOnce(false);
    await expectProviderError(write('auto'), 4100, 'signing_not_granted');
    manager.getCurrentStatus.mockReturnValueOnce({ status: 'stopped', error: null });
    await expectProviderError(write('auto'), 4900, 'node-stopped');
    expect(permissions.admitAutoWrite).not.toHaveBeenCalled();
    expect(cob.commentIssue).not.toHaveBeenCalled();
  });

  test('disconnecting is the revoke, under the page; the core forgets the count with it', async () => {
    const page = { ...PAGE };
    await expect(executeRadicleMethod('radicle_disconnect', {}, ORIGIN, { pageContext: () => page })).resolves.toEqual({
      connected: false,
    });
    expect(permissions.revokePermission).toHaveBeenCalledWith(ORIGIN, { page });
    expect(permissions.admitAutoWrite).not.toHaveBeenCalled();
  });

  test('identity disclosure is not a write and needs no approval', async () => {
    await expect(executeRadicleMethod('radicle_getIdentity', {}, ORIGIN)).resolves.toMatchObject({
      did: 'did:key:z6MkTest',
    });
  });

  // Plan B10 (freedom-core design 0008, `needs_vault`).
  test('a node running with a throwaway key: every write is refused before the core counts it, and nothing is sent', async () => {
    const message = "Radicle is running with a throwaway key and can't publish. Restart Radicle once your identity is set up.";
    manager.radicleWriteRefusal.mockReturnValue({ reason: 'needs_vault', message });
    ruleOn();
    try {
      for (let i = 0; i < 6; i += 1) {
        const err = await expectProviderError(write('auto'), 4900, 'needs_vault');
        expect(err.message).toBe(message);
      }
      await expectProviderError(write('user'), 4900, 'needs_vault');
      expect(cob.commentIssue).not.toHaveBeenCalled();
      await expect(executeRadicleMethod('radicle_getIdentity', {}, ORIGIN)).resolves.toMatchObject({
        did: 'did:key:z6MkTest',
      });
    } finally {
      manager.radicleWriteRefusal.mockReturnValue(null);
    }
    // None of them was asked of the core, so none was counted in R-6.
    expect(permissions.admitAutoWrite).not.toHaveBeenCalled();
    // The node restarted with the derived key: the core is asked, and writes go.
    for (let i = 0; i < 5; i += 1) await write('auto');
    expect(permissions.admitAutoWrite).toHaveBeenCalledTimes(5);
    expect(cob.commentIssue).toHaveBeenCalledTimes(5);
  });

  test("cob-service's admission refusal is the provider's 4900 with its reason", async () => {
    cob.commentIssue.mockRejectedValueOnce(new cob.CobAdmissionError('needs_vault', 'throwaway key'));
    const err = await expectProviderError(write('user'), 4900, 'needs_vault');
    expect(err.message).toBe('throwaway key');
  });

  // A write the service took and didn't confirm (plan B11; freedom-core
  // design 0008, Writes): -32603 with the design's text, called once.
  test("cob-service's outcome-unknown error is -32603 with the design's text, the write made once", async () => {
    cob.commentIssue.mockRejectedValueOnce(new cob.CobOutcomeUnknownError());
    const err = await expectProviderError(write('user'), -32603, 'outcome_unknown');
    expect(err.message).toBe(
      'The Radicle node stopped before confirming this write; it may have been recorded.'
    );
    expect(cob.commentIssue).toHaveBeenCalledTimes(1);
  });

  test("the manager's unseed with its outcome unknown is the same answer", async () => {
    manager.unseedRepository.mockResolvedValueOnce({
      success: false,
      error: { code: 'OUTCOME_UNKNOWN', message: 'unused', details: { rid: RID } },
    });
    const err = await expectProviderError(
      executeRadicleMethod('radicle_unseed', { rid: RID }, ORIGIN),
      -32603,
      'outcome_unknown'
    );
    expect(err.message).toBe(
      'The Radicle node stopped before confirming this write; it may have been recorded.'
    );
    expect(manager.unseedRepository).toHaveBeenCalledTimes(1);
  });
});

// freedom-core design 0011, PRQ-8a: a forged chrome origin refused. The
// chrome's route refuses every method main's page dispatcher serves, for any
// site it names, before anything runs: no grant read, no use recorded, no
// node call, no revocation.
describe('main\'s page path (0011 PRQ-8)', () => {
  test('main\'s page path answers { result } or { error }, an add-on failure with its fixed text only', async () => {
    expect(await executeRadicleForPage('radicle_getCapabilities', {}, ORIGIN)).toEqual({
      result: expect.objectContaining({ canUseNode: true, reason: null }),
    });
    permissions.getPermission.mockReturnValue(null);
    expect(await executeRadicleForPage('radicle_listSeededRepos', {}, ORIGIN)).toEqual({
      error: { code: 4100, message: 'Origin not connected', data: { reason: 'not_connected' } },
    });
    permissions.getPermission.mockReturnValue({ origin: ORIGIN, signing: false });
    manager.getConnections.mockRejectedValueOnce(new Error("failed to open '/home/alice/.radicle/storage': denied"));
    expect(await executeRadicleForPage('radicle_getNodeStatus', {}, ORIGIN)).toEqual({
      error: { code: -32603, message: 'Internal error' },
    });
  });
});
