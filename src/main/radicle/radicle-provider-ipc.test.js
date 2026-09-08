const mockProviderSend = jest.fn();
const mockIpcHandle = jest.fn();

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp/test-user-data') },
  ipcMain: { handle: mockIpcHandle },
  BrowserWindow: {
    getAllWindows: jest.fn(() => [
      { webContents: { isDestroyed: jest.fn(() => false), send: mockProviderSend } },
    ]),
  },
}));

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
  return {
    createIssue: jest.fn(async () => ({ id: 'a'.repeat(40) })),
    commentIssue: jest.fn(async () => ({ id: 'b'.repeat(40) })),
    editIssueState: jest.fn(async () => ({ id: 'c'.repeat(40), state: 'closed' })),
    commentPatch: jest.fn(async () => ({ id: 'd'.repeat(40) })),
    getIdentity: jest.fn(async () => ({ did: 'did:key:z6MkTest', nid: 'z6MkTest', alias: 'me' })),
    CobValidationError,
    LIMITS: { maxTitleBytes: 200, maxBodyBytes: 65536 },
  };
});

jest.mock('./radicle-permissions', () => ({
  getPermission: jest.fn(() => ({ origin: 'test', signing: false })),
  hasSigningGrant: jest.fn(() => false),
  updateLastUsed: jest.fn(),
  revokePermission: jest.fn(() => true),
}));

const { executeRadicleMethod, registerRadicleProviderIpc } = require('./radicle-provider-ipc');
const manager = require('../radicle-manager');
const cob = require('./cob-service');
const permissions = require('./radicle-permissions');

const ORIGIN = 'bzz://canopyref';
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';

beforeEach(() => {
  jest.clearAllMocks();
  manager.isDisabledForProfile.mockReturnValue(false);
  manager.getCurrentStatus.mockReturnValue({ status: 'running', error: null });
  permissions.getPermission.mockReturnValue({ origin: ORIGIN, signing: false });
  permissions.hasSigningGrant.mockReturnValue(false);
});

test('provider IPC broadcasts pushed seed progress with origin routing metadata', async () => {
  registerRadicleProviderIpc();
  const executeHandler = mockIpcHandle.mock.calls.find(
    ([channel]) => channel === 'radicle:provider-execute'
  )[1];
  manager.seedRepository.mockImplementationOnce(async (_rid, onStatus) => {
    onStatus(mockSeedFetchStatus);
    return { success: true, status: mockSeedFetchStatus };
  });

  await executeHandler({}, {
    method: 'radicle_seed',
    params: { rid: RID },
    origin: ORIGIN,
  });

  expect(mockProviderSend).toHaveBeenCalledWith('radicle:providerEvent', {
    event: 'seedStatus',
    origin: ORIGIN,
    data: mockSeedFetchStatus,
  });

  await executeHandler({}, {
    method: 'radicle_disconnect',
    params: {},
    origin: ORIGIN,
  });
  expect(manager.unsubscribeSeedStatus).toHaveBeenCalledWith(expect.any(Function));
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

  test('updates lastUsed for permissioned methods', async () => {
    await executeRadicleMethod('radicle_seed', { rid: RID }, ORIGIN);
    expect(permissions.updateLastUsed).toHaveBeenCalledWith(ORIGIN);
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
    expect(permissions.revokePermission).toHaveBeenCalledWith(ORIGIN);
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
      ORIGIN
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
      executeRadicleMethod('radicle_createIssue', { rid: RID }, ORIGIN),
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
        ORIGIN
      ),
      -32603,
      'repo_not_found'
    );
  });

  test('radicle_editIssueState and radicle_commentPatch dispatch', async () => {
    await executeRadicleMethod(
      'radicle_editIssueState',
      { rid: RID, issueId: 'ab12cd', state: 'closed' },
      ORIGIN
    );
    expect(cob.editIssueState).toHaveBeenCalled();
    await executeRadicleMethod(
      'radicle_commentPatch',
      { rid: RID, patchId: 'ab12cd', body: 'lgtm' },
      ORIGIN
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
