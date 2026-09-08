jest.mock('./logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('./radicle-embedded', () => ({
  status: jest.fn(),
  listRepos: jest.fn(),
  buildRepoMeta: jest.fn(),
  treeAt: jest.fn(),
  blobAt: jest.fn(),
  readmeAt: jest.fn(),
  commits: jest.fn(),
  commit: jest.fn(),
  remotes: jest.fn(),
  repoStats: jest.fn(),
  issues: jest.fn(),
  issue: jest.fn(),
  patches: jest.fn(),
  patch: jest.fn(),
  repoInfo: jest.fn(),
}));
jest.mock('./radicle-manager', () => ({
  isDisabledForProfile: jest.fn(() => false),
}));
jest.mock('./webrequest-dispatcher', () => ({
  registerWebRequestHandler: jest.fn(),
}));

const embedded = require('./radicle-embedded');
const { isDisabledForProfile } = require('./radicle-manager');
const {
  handleRadicleApiRequest,
  registerRadicleApiProtocol,
  guardRadicleApiRequest,
  serveRepoApi,
  decodeRepoApiPath,
} = require('./radicle-api-protocol');

const INTERNAL_PAGE = 'file:///app/src/renderer/pages/rad-browser.html';

const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const REVISION = '0123456789abcdef0123456789abcdef01234567';

describe('radapi protocol', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDisabledForProfile.mockReturnValue(false);
    embedded.status.mockResolvedValue({
      version: '0.1.0',
      connectedPeers: 3,
    });
    embedded.listRepos.mockResolvedValue(Array.from({ length: 7 }, (_, index) => ({ index })));
    embedded.repoInfo.mockResolvedValue({ visibility: { type: 'public' } });
  });

  test('serves the root health check required by the repository viewer', async () => {
    const response = await handleRadicleApiRequest(new Request('radapi://local/'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ version: '0.1.0', mode: 'embedded' });
    expect(embedded.status).toHaveBeenCalledTimes(1);
  });

  test('serves node health HEAD requests without a body', async () => {
    const response = await handleRadicleApiRequest(
      new Request('radapi://local/', { method: 'HEAD' })
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('');
  });

  test('serves the node stats shape used by the Nodes panel', async () => {
    const response = await handleRadicleApiRequest(new Request('radapi://local/api/v1/stats'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repos: { total: 7 },
      peers: { connected: 3 },
    });
  });

  test('gates every endpoint on the active profile node mode', async () => {
    isDisabledForProfile.mockReturnValue(true);
    const response = await handleRadicleApiRequest(new Request('radapi://local/api/v1/stats'));
    expect(response.status).toBe(403);
    expect(embedded.status).not.toHaveBeenCalled();
  });

  // Chromium never sends `Origin` to a custom scheme's protocol.handle, so
  // the old Origin check could not fire; a referrer, when there is one,
  // does arrive and must name the internal viewer.
  test('rejects a request referred by a page that is not the internal viewer', async () => {
    const denied = await handleRadicleApiRequest(
      new Request('radapi://local/', { referrer: 'https://hostile.example/' })
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('serves the internal viewer, with or without a referrer', async () => {
    const referred = await handleRadicleApiRequest(
      new Request('radapi://local/', { referrer: INTERNAL_PAGE })
    );
    expect(referred.status).toBe(200);

    // Chromium suppresses referrers from `file:` origins, so the viewer's
    // own fetches arrive with none — the frame guard covers that case.
    const unreferred = await handleRadicleApiRequest(new Request('radapi://local/'));
    expect(unreferred.status).toBe(200);
    expect(unreferred.headers.get('access-control-allow-origin')).toBeNull();
  });

  describe('frame guard', () => {
    const request = (frameUrl, url = 'radapi://local/api/v1/repos') => ({
      url,
      frame: frameUrl === null ? null : { url: frameUrl },
    });

    test('passes requests from the internal repository viewer', () => {
      expect(guardRadicleApiRequest(request(INTERNAL_PAGE))).toBeNull();
      expect(
        guardRadicleApiRequest(request(`${INTERNAL_PAGE}?rid=z3gq&base=radapi%3A%2F%2Flocal`))
      ).toBeNull();
    });

    // The demonstrated leak: node-level endpoints and private-repo reads
    // were readable by any page that asked.
    test.each([
      ['a hostile web page', 'https://hostile.example/attack.html'],
      ['a dweb page', 'bzz://somehash/index.html'],
      ['another internal page', 'file:///app/src/renderer/pages/settings.html'],
      ['a file path merely ending in the viewer name', 'file:///tmp/rad-browser.html'],
      ['no frame at all', null],
      ['a frame with no URL', undefined],
    ])('cancels a radapi request from %s', (_label, frameUrl) => {
      expect(guardRadicleApiRequest(request(frameUrl))).toEqual({ cancel: true });
    });

    test('cancels a top-level navigation to a node-level endpoint', () => {
      expect(
        guardRadicleApiRequest(request('https://hostile.example/', 'radapi://local/api/v1/repos'))
      ).toEqual({ cancel: true });
    });

    test('ignores requests for every other scheme', () => {
      expect(guardRadicleApiRequest(request('https://example.com/', 'https://example.com/x'))).toBeNull();
      expect(guardRadicleApiRequest(request('https://example.com/', 'rad://z3gq/tree'))).toBeNull();
    });
  });

  test('serves the local repository collection in viewer metadata shape', async () => {
    embedded.listRepos.mockResolvedValueOnce([{ rid: RID }]);
    embedded.buildRepoMeta.mockResolvedValueOnce({ rid: RID, payloads: {} });
    const response = await handleRadicleApiRequest(
      new Request('radapi://local/api/v1/repos?show=all')
    );
    await expect(response.json()).resolves.toEqual([{ rid: RID, payloads: {} }]);
    expect(embedded.buildRepoMeta).toHaveBeenCalledWith(RID);
  });

  test('routes repository metadata through the embedded serving core', async () => {
    embedded.buildRepoMeta.mockResolvedValue({ rid: RID });

    const response = await handleRadicleApiRequest(
      new Request(`radapi://local/api/v1/repos/${RID}`)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ rid: RID });
    expect(embedded.buildRepoMeta).toHaveBeenCalledWith(RID);
  });

  test('preserves status and headers but strips bodies from HEAD responses', async () => {
    embedded.buildRepoMeta.mockResolvedValue({ rid: RID });

    const response = await handleRadicleApiRequest(
      new Request(`radapi://local/api/v1/repos/${RID}`, { method: 'HEAD' })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(response.text()).resolves.toBe('');
  });

  test('serves filtered issue and patch reads', async () => {
    embedded.issues.mockResolvedValue([
      { id: 'open', state: { status: 'open' } },
      { id: 'closed', state: { status: 'closed' } },
    ]);
    embedded.patch.mockResolvedValue({ id: 'abc123' });

    const issues = await serveRepoApi(RID, '/issues', { search: '?status=open' });
    await expect(issues.json()).resolves.toEqual([{ id: 'open', state: { status: 'open' } }]);
    const patch = await serveRepoApi(RID, '/patches/abc123');
    await expect(patch.json()).resolves.toEqual({ id: 'abc123' });
    expect(embedded.patch).toHaveBeenCalledWith(RID, 'abc123');
  });

  test('pins tree, blob, and readme reads to the requested commit', async () => {
    embedded.treeAt.mockResolvedValue({ entries: [], lastCommit: { id: REVISION } });
    embedded.blobAt.mockResolvedValue({ name: 'README.md', content: 'old' });
    embedded.readmeAt.mockResolvedValue({ name: 'README.md', content: 'old' });

    const tree = await serveRepoApi(RID, `/tree/${REVISION}/src`);
    const blob = await serveRepoApi(RID, `/blob/${REVISION}/README.md`);
    const readme = await serveRepoApi(RID, `/readme/${REVISION}`);

    expect(tree.status).toBe(200);
    expect(blob.status).toBe(200);
    expect(readme.status).toBe(200);
    expect(embedded.treeAt).toHaveBeenCalledWith(RID, REVISION, 'src');
    expect(embedded.blobAt).toHaveBeenCalledWith(RID, REVISION, 'README.md');
    expect(embedded.readmeAt).toHaveBeenCalledWith(RID, REVISION);
  });

  test('serves signed remotes and revision-scoped repository stats', async () => {
    embedded.remotes.mockResolvedValue([
      { id: 'z6MkDelegate', delegate: true, heads: { main: REVISION } },
    ]);
    embedded.repoStats.mockResolvedValue({ commits: 42, branches: 3, contributors: 5 });

    const remotes = await serveRepoApi(RID, '/remotes');
    const stats = await serveRepoApi(RID, `/stats/tree/${REVISION}`);

    await expect(remotes.json()).resolves.toEqual([
      { id: 'z6MkDelegate', delegate: true, heads: { main: REVISION } },
    ]);
    await expect(stats.json()).resolves.toEqual({ commits: 42, branches: 3, contributors: 5 });
    expect(embedded.remotes).toHaveBeenCalledWith(RID);
    expect(embedded.repoStats).toHaveBeenCalledWith(RID, REVISION);
  });

  test('serves paginated commit history and structured commit diffs', async () => {
    embedded.commits.mockResolvedValue([{ id: REVISION, summary: 'head' }]);
    embedded.commit.mockResolvedValue({
      commit: { id: REVISION, summary: 'head' },
      diff: { stats: { insertions: 2, deletions: 1 }, files: [] },
    });

    const history = await serveRepoApi(RID, '/commits', {
      search: `?parent=${REVISION}&page=2&perPage=5`,
    });
    const detail = await serveRepoApi(RID, `/commits/${REVISION}`);

    await expect(history.json()).resolves.toEqual([{ id: REVISION, summary: 'head' }]);
    await expect(detail.json()).resolves.toEqual({
      commit: { id: REVISION, summary: 'head' },
      diff: { stats: { insertions: 2, deletions: 1 }, files: [] },
    });
    expect(embedded.commits).toHaveBeenCalledWith(RID, REVISION, 2, 5);
    expect(embedded.commit).toHaveBeenCalledWith(RID, REVISION);
  });

  test('bounds commit pagination before crossing the native boundary', async () => {
    embedded.commits.mockResolvedValue([]);
    await serveRepoApi(RID, '/commits', {
      search: `?parent=${REVISION}&page=9999999999&perPage=9999999999`,
    });
    expect(embedded.commits).toHaveBeenCalledWith(RID, REVISION, 1_000_000, 100);
  });

  test.each([
    ['/commits', ''],
    ['/commits', '?parent=main'],
    ['/commits/main', ''],
  ])('rejects invalid commit revisions in %s%s', async (apiPath, search) => {
    const response = await serveRepoApi(RID, apiPath, { search });
    expect(response.status).toBe(400);
    expect(embedded.commits).not.toHaveBeenCalled();
    expect(embedded.commit).not.toHaveBeenCalled();
  });

  test.each([
    '/tree/main/src',
    '/tree/0123456/src',
    '/blob/HEAD/README.md',
    '/readme/main',
    '/stats/tree/main',
  ])('rejects non-object-id revisions in %s', async (apiPath) => {
    const response = await serveRepoApi(RID, apiPath);
    expect(response.status).toBe(400);
    expect(embedded.treeAt).not.toHaveBeenCalled();
    expect(embedded.blobAt).not.toHaveBeenCalled();
    expect(embedded.readmeAt).not.toHaveBeenCalled();
    expect(embedded.repoStats).not.toHaveBeenCalled();
  });

  test('does not expose private repositories through the public repo API', async () => {
    embedded.repoInfo.mockResolvedValueOnce({ visibility: { type: 'private' } });
    const response = await serveRepoApi(RID, '/issues');
    expect(response.status).toBe(403);
    expect(embedded.issues).not.toHaveBeenCalled();
  });

  test.each([
    '/tree/main/..%2F..%2Fsecret',
    '/blob/main/%2e%2e',
    '/issues/%5csecret',
    '/patches/a%00b',
  ])('rejects encoded traversal and separator tricks in %s', async (apiPath) => {
    const response = await serveRepoApi(RID, apiPath);
    expect(response.status).toBe(400);
    expect(embedded.treeAt).not.toHaveBeenCalled();
    expect(embedded.blobAt).not.toHaveBeenCalled();
  });

  // The viewer builds these paths (rad-browser.js encodePathSegments). A
  // legitimately-named file has to survive the round trip: raw `%` makes the
  // decode throw (400) and `#`/`?` never even reach here — they truncate the
  // request URL in the renderer.
  test.each([
    ['100%.md', '100%25.md'],
    ['notes#1.md', 'notes%231.md'],
    ['a?b.txt', 'a%3Fb.txt'],
    ['ünïcode.rs', '%C3%BCn%C3%AFcode.rs'],
  ])('accepts %s when the viewer encodes it as %s', (name, encoded) => {
    expect(decodeRepoApiPath(`/blob/${REVISION}/${encoded}`)).toEqual([
      'blob',
      REVISION,
      name,
    ]);
  });

  test('rejects the unencoded form the viewer used to send', () => {
    expect(decodeRepoApiPath(`/blob/${REVISION}/100%.md`)).toBeNull();
  });

  test('registers the request handler on the target session', async () => {
    const targetSession = { protocol: { handle: jest.fn() } };
    registerRadicleApiProtocol(targetSession);

    expect(targetSession.protocol.handle).toHaveBeenCalledWith('radapi', expect.any(Function));
    const handler = targetSession.protocol.handle.mock.calls[0][1];
    const response = await handler(new Request('radapi://local/'));
    expect(response.status).toBe(200);
  });

  // PRIVATE MODE GUARD: a read that errs writes the RID and the repo path
  // to the persistent main.log. `rad:` already registers per session with
  // the private-log context; `radapi:` must too, and the shared log site
  // must redact — otherwise a private window leaves a history-grade trace.
  test('redacts the RID, path and error text for a private-session registration', async () => {
    const log = require('./logger');
    embedded.treeAt.mockRejectedValue(new Error(`tree read failed for ${RID}:/secret/plans.md`));
    const privateSession = { protocol: { handle: jest.fn() } };
    registerRadicleApiProtocol(privateSession, { privatePartition: 'private-abc' });
    const handler = privateSession.protocol.handle.mock.calls[0][1];

    const response = await handler(
      new Request(`radapi://local/api/v1/repos/${encodeURIComponent(RID)}/tree/${REVISION}/secret`)
    );

    expect(response.status).toBe(500);
    const warnings = log.warn.mock.calls.filter((call) => call[0] === '[radapi]');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual(['[radapi]', '<private>', '<private>', '→', '<private>']);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(RID);
  });

  test('logs the RID and path normally outside a private session', async () => {
    const log = require('./logger');
    embedded.treeAt.mockRejectedValue(new Error('tree read failed'));
    const defaultSession = { protocol: { handle: jest.fn() } };
    registerRadicleApiProtocol(defaultSession);
    const handler = defaultSession.protocol.handle.mock.calls[0][1];

    await handler(
      new Request(`radapi://local/api/v1/repos/${encodeURIComponent(RID)}/tree/${REVISION}/src`)
    );

    const warnings = log.warn.mock.calls.filter((call) => call[0] === '[radapi]');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual(['[radapi]', RID, `/tree/${REVISION}/src`, '→', 'tree read failed']);
  });

  // The dispatcher's registry is process-wide and rejects a duplicate
  // name, so the guard must be installed once however many sessions
  // (default plus one per private window) register the protocol.
  test('installs the frame guard once, for every session the dispatcher serves', () => {
    jest.isolateModules(() => {
      const dispatcher = require('./webrequest-dispatcher');
      const fresh = require('./radicle-api-protocol');
      fresh.registerRadicleApiProtocol({ protocol: { handle: jest.fn() } });
      fresh.registerRadicleApiProtocol({ protocol: { handle: jest.fn() } });

      expect(dispatcher.registerWebRequestHandler).toHaveBeenCalledTimes(1);
      expect(dispatcher.registerWebRequestHandler).toHaveBeenCalledWith(
        'onBeforeRequest',
        'radapi-guard',
        fresh.guardRadicleApiRequest
      );
    });
  });
});
