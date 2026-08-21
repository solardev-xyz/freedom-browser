const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ipcHandlers = {};
jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  ipcMain: { handle: (channel, handler) => { ipcHandlers[channel] = handler; } },
}));

const mockPermissionState = {};
jest.mock('./swarm-permissions', () => ({
  getPermission: jest.fn((origin) => mockPermissionState[origin] || null),
  grantPermission: jest.fn((origin) => {
    mockPermissionState[origin] = { origin, autoApprove: {} };
    return mockPermissionState[origin];
  }),
  revokePermission: jest.fn((origin) => { delete mockPermissionState[origin]; }),
  getAutoApprove: jest.fn((origin, type) => mockPermissionState[origin]?.autoApprove?.[type] === true),
  setAutoApprove: jest.fn((origin, type, enabled) => {
    mockPermissionState[origin].autoApprove[type] = enabled;
    return true;
  }),
  hasMessagingGrant: jest.fn((origin) => mockPermissionState[origin]?.messaging === true),
  grantMessaging: jest.fn((origin) => { mockPermissionState[origin].messaging = true; }),
  revokeMessaging: jest.fn((origin) => { delete mockPermissionState[origin].messaging; }),
  onManifestMutation: jest.fn(),
}));

const mockFeedState = {};
jest.mock('./feed-store', () => ({
  hasIdentityMode: jest.fn((origin) => mockFeedState[origin]?.identity === true),
  createAppScopedIdentity: jest.fn((origin) => {
    mockFeedState[origin] = { ...(mockFeedState[origin] || {}), identity: true };
  }),
  hasFeedGrant: jest.fn((origin) => mockFeedState[origin]?.granted === true),
  grantFeedAccess: jest.fn((origin) => {
    mockFeedState[origin] = { ...(mockFeedState[origin] || {}), granted: true };
  }),
  revokeFeedAccess: jest.fn((origin) => {
    mockFeedState[origin] = { ...(mockFeedState[origin] || {}), granted: false };
  }),
  onManifestMutation: jest.fn(),
}));

jest.mock('./bzz-protocol', () => ({ handleBzzRequest: jest.fn() }));

const { app } = require('electron');
const {
  BODY_IDLE_TIMEOUT_MS,
  validateManifest,
  discover,
  checkManifest,
  decideManifest,
  detachManaged,
  disconnect,
  getRecord,
  useIndividual,
  registerPermissionManifestIpc,
  _resetForTests,
} = require('./permission-manifests');
const { handleBzzRequest: mockHandleBzzRequest } = require('./bzz-protocol');
const mockFeeds = require('./feed-store');

let tempDir;

function manifest(capabilities) {
  return {
    schema: 'freedom-manifest/1',
    name: 'Test app',
    description: 'Exercises manifests',
    capabilities: { swarm: capabilities },
  };
}

function responseFor(value, status = 200) {
  return new Response(status === 200 ? JSON.stringify(value) : '', {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// A 200 whose body dies partway through: bee restart, dropped socket. The
// headers already landed, so only the read fails.
function severedResponse(prefix = '{"schema":"freedom-mani') {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix));
      controller.error(new Error('socket hang up'));
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-manifests-'));
  app.getPath.mockReturnValue(tempDir);
  for (const key of Object.keys(mockPermissionState)) delete mockPermissionState[key];
  for (const key of Object.keys(mockFeedState)) delete mockFeedState[key];
  _resetForTests();
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('permission manifests', () => {
  test('strictly validates schema, fields, and display text', () => {
    expect(validateManifest(manifest({ publish: { why: 'Publish releases' } })).capabilities)
      .toEqual({ publish: { why: 'Publish releases' } });
    expect(() => validateManifest({ ...manifest({}), extra: true })).toThrow('unknown field');
    expect(() => validateManifest(manifest({}))).toThrow('must not be empty');
    expect(() => validateManifest(manifest({ publish: { why: 'safe\u202Ehidden' } }))).toThrow('invalid reason');
  });

  test('distinguishes absence, transient failure, and a valid manifest', async () => {
    await expect(discover('bzz://app.eth/', async () => responseFor({}, 404)))
      .resolves.toEqual({ status: 'absent' });
    await expect(discover('bzz://app.eth/', async () => responseFor({}, 503)))
      .resolves.toEqual({ status: 'unresolved' });
    const result = await discover(
      'bzz://app.eth/',
      async () => responseFor(manifest({ publish: { why: 'Publish releases' } }))
    );
    expect(result).toMatchObject({ status: 'found', manifest: { name: 'Test app' } });
  });

  test('rejects non-JSON and streams no more than 8 KiB', async () => {
    await expect(discover('bzz://app.eth/', async () => new Response('not json')))
      .resolves.toMatchObject({ status: 'invalid' });
    await expect(discover('bzz://app.eth/', async () => new Response('x'.repeat(8193))))
      .resolves.toMatchObject({ status: 'invalid', error: 'manifest exceeds 8 KiB' });
  });

  test('treats a body severed mid-stream as transient, not as a bad manifest', async () => {
    await expect(discover('bzz://app.eth/', async () => severedResponse()))
      .resolves.toMatchObject({ status: 'unresolved' });
  });

  test('aborts a body that stalls after the headers instead of hanging the origin', async () => {
    jest.useFakeTimers();
    try {
      let cancelled = false;
      // 200 OK, one chunk, then a half-open socket: no more bytes, no end.
      // The fetch attempt timer is long gone by now (it is cleared once the
      // headers arrive), so only the read's own deadline can end this.
      const stalled = new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"schema":"freedom-mani'));
        },
        cancel() { cancelled = true; },
      }), { status: 200, headers: { 'content-type': 'application/json' } });

      const discovery = discover('bzz://app.eth/', async () => stalled);
      await jest.advanceTimersByTimeAsync(BODY_IDLE_TIMEOUT_MS + 1_000);

      // Transient, so the caller backs off and keeps existing authority —
      // never `invalid`, which would prune it.
      await expect(discovery).resolves.toMatchObject({ status: 'unresolved' });
      expect(cancelled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('keeps reading a slow but still-arriving body', async () => {
    jest.useFakeTimers();
    try {
      const body = JSON.stringify(manifest({ publish: { why: 'Publish releases' } }));
      let controller;
      const trickled = new Response(new ReadableStream({
        start(streamController) {
          controller = streamController;
          controller.enqueue(new TextEncoder().encode(body.slice(0, 10)));
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });

      const discovery = discover('bzz://app.eth/', async () => trickled);
      // Each chunk lands inside the window and restarts it, so a transfer
      // that is merely slow must survive well past a single deadline.
      for (let offset = 10; offset < body.length; offset += 10) {
        await jest.advanceTimersByTimeAsync(BODY_IDLE_TIMEOUT_MS - 1_000);
        controller.enqueue(new TextEncoder().encode(body.slice(offset, offset + 10)));
      }
      controller.close();
      await jest.advanceTimersByTimeAsync(0);

      await expect(discovery).resolves.toMatchObject({ status: 'found' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('projects an allow decision and creates identity metadata before the feed grant', async () => {
    const fetchManifest = async () => responseFor(manifest({
      feeds: { why: 'Update the app feed' },
      signing: { why: 'Sign app updates' },
    }));
    const check = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest });

    expect(check.kind).toBe('consent');
    expect(check.model.createsIdentity).toBe(true);
    expect(decideManifest(check.token, 'allow')).toEqual({ allowed: true, mode: 'allow' });
    expect(mockPermissionState['app.eth'].autoApprove).toMatchObject({ feeds: true, signing: true });
    expect(mockFeedState['app.eth']).toEqual({ identity: true, granted: true });
    expect(getRecord('app.eth').managed.feedGrant).toEqual(['feeds', 'signing']);
  });

  test('persists individual approvals without batch flags', async () => {
    const check = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({ messaging: { why: 'Receive updates' } })) });

    decideManifest(check.token, 'individual');
    expect(mockPermissionState['app.eth']).toBeDefined();
    expect(mockPermissionState['app.eth'].messaging).toBeUndefined();
    expect(getRecord('app.eth').acknowledged.messaging.decision).toBe('individual');
    expect(getRecord('app.eth').detached.connection).toBe(true);
  });

  test('does not persist a rejected first-contact observation', async () => {
    const check = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({ publish: { why: 'Publish releases' } })) });
    decideManifest(check.token, 'deny');
    expect(getRecord('app.eth')).toBeNull();
    expect(mockPermissionState['app.eth']).toBeUndefined();
  });

  test('silently acknowledges a complete existing user-owned projection', async () => {
    mockPermissionState['app.eth'] = { origin: 'app.eth', autoApprove: { publish: true } };
    const check = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({ publish: { why: 'Publish releases' } })) });

    expect(check).toEqual({ kind: 'ready' });
    expect(getRecord('app.eth').acknowledged.publish).toMatchObject({
      decision: 'individual',
      source: 'existing-grant',
    });
    expect(getRecord('app.eth').managed).toEqual({});
  });

  test('replays a completed token result and ignores wording-only redeploys', async () => {
    const first = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({ publish: { why: 'First wording' } })) });
    const decision = decideManifest(first.token, 'allow');
    expect(decideManifest(first.token, 'allow')).toEqual(decision);

    const wordingOnly = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({ publish: { why: 'New wording' } })) });
    expect(wordingOnly).toEqual({ kind: 'ready' });
    expect(getRecord('app.eth').acknowledged.publish.whyShown).toBe('First wording');
  });

  test('a receipt attests the bytes whose wording the sheet actually showed', async () => {
    const request = { origin: 'app.eth', committedUrl: 'bzz://app.eth/', eager: true };
    const shown = manifest({ publish: { why: 'First wording' } });
    const consent = await checkManifest(request, { fetchManifest: async () => responseFor(shown) });

    // A wording-only redeploy re-checked by a sibling tab while the sheet is
    // still open: same capabilities, so the token stays valid, but
    // `observed.rawHash` moves on without a revision bump.
    await checkManifest(request, {
      fetchManifest: async () => responseFor(manifest({ publish: { why: 'New wording' } })),
    });
    decideManifest(consent.token, 'allow');

    const record = getRecord('app.eth');
    const receipt = record.receipts.at(-1);
    expect(receipt.rows[0].whyShown).toBe('First wording');
    // Receipt hash and receipt wording come from the same manifest — it must
    // not attest text that is not in the bytes it hashes.
    expect(receipt.rawHash).toBe(crypto.createHash('sha256').update(JSON.stringify(shown)).digest('hex'));
    expect(record.observed.rawHash).not.toBe(receipt.rawHash);
  });

  test('re-reads the store after discovery rather than saving a pre-await snapshot', async () => {
    const request = { origin: 'app.eth', committedUrl: 'bzz://app.eth/', eager: true };
    const fetchManifest = async () => responseFor(manifest({ publish: { why: 'Publish releases' } }));
    const first = await checkManifest(request, { fetchManifest });
    decideManifest(first.token, 'allow');

    // A concurrent operation on another origin fails its atomic write while
    // discovery is in flight, which drops the module's in-memory store. The
    // no-mutation branch must not serialize the snapshot it read before the
    // await — that writes `null` over the whole store.
    const recheck = await checkManifest(request, {
      fetchManifest: async () => {
        const blocked = path.join(tempDir, 'swarm-manifest-grants.json.tmp');
        fs.mkdirSync(blocked);
        expect(() => disconnect('other.eth')).toThrow();
        fs.rmSync(blocked, { recursive: true });
        return fetchManifest();
      },
    });

    expect(recheck).toEqual({ kind: 'ready' });
    expect(getRecord('app.eth')).not.toBeNull();
    expect(getRecord('app.eth').acknowledged.publish.decision).toBe('managed');
    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, 'swarm-manifest-grants.json'), 'utf8'));
    expect(Object.keys(onDisk.records)).toEqual(['app.eth']);
  });

  test('manifest-sourced feed projections never report themselves as user mutations', async () => {
    registerPermissionManifestIpc();
    // Both stores that hold projected state report user mutations, so a
    // hand-made change detaches manifest ownership.
    expect(mockFeeds.onManifestMutation).toHaveBeenCalledWith(detachManaged);

    const check = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({ feeds: { why: 'Update feed' } })) });
    decideManifest(check.token, 'allow');

    expect(mockFeeds.grantFeedAccess).toHaveBeenCalledWith('app.eth', { source: 'manifest' });
    expect(mockFeeds.createAppScopedIdentity).toHaveBeenCalledWith('app.eth', { activate: true, source: 'manifest' });
    expect(mockFeeds.revokeFeedAccess).not.toHaveBeenCalled();

    disconnect('app.eth');
    expect(mockFeeds.revokeFeedAccess).toHaveBeenCalledWith('app.eth', { source: 'manifest' });
  });

  test('settings downgrade removes managed flags but keeps the base connection', async () => {
    const check = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({ publish: { why: 'Publish releases' } })) });
    decideManifest(check.token, 'allow');

    expect(useIndividual('app.eth', 'publish')).toBe(true);
    expect(mockPermissionState['app.eth']).toBeDefined();
    expect(mockPermissionState['app.eth'].autoApprove.publish).toBe(false);
    expect(getRecord('app.eth').acknowledged.publish.decision).toBe('individual');
  });

  test('manual toggles detach provenance so a later diff cannot resurrect them', async () => {
    const first = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({ publish: { why: 'Publish releases' } })) });
    decideManifest(first.token, 'allow');
    mockPermissionState['app.eth'].autoApprove.publish = false;
    detachManaged('app.eth', 'autoApprove.publish');

    const changed = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({
      publish: { why: 'Publish releases' },
      messaging: { why: 'Receive updates' },
    })) });
    decideManifest(changed.token, 'allow');
    expect(mockPermissionState['app.eth'].autoApprove.publish).toBe(false);
    expect(getRecord('app.eth').detached['autoApprove.publish']).toBe(true);
  });

  test('rejects an opaque decision token after a newer manifest was observed', async () => {
    const oldCheck = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({ publish: { why: 'Old reason' } })) });
    await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({
      publish: { why: 'Old reason' },
      feeds: { why: 'Update feed' },
    })) });

    expect(() => decideManifest(oldCheck.token, 'allow')).toThrow('stale');
  });

  test('recovers a truncated primary store from the journaled backup', async () => {
    const check = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({ publish: { why: 'Publish releases' } })) });
    decideManifest(check.token, 'allow');
    fs.writeFileSync(path.join(tempDir, 'swarm-manifest-grants.json'), '{truncated', 'utf8');
    _resetForTests();

    expect(getRecord('app.eth').acknowledged.publish.decision).toBe('managed');
    expect(mockPermissionState['app.eth'].autoApprove.publish).toBe(true);
  });

  test('a definitive disappearance prunes managed authority but preserves identity metadata', async () => {
    const first = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({ feeds: { why: 'Update feed' } })) });
    decideManifest(first.token, 'allow');

    const result = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: false,
    }, { fetchManifest: async () => responseFor({}, 404) });
    expect(result).toMatchObject({ kind: 'legacy', pruned: true });
    expect(mockPermissionState['app.eth']).toBeUndefined();
    expect(mockFeedState['app.eth']).toEqual({ identity: true, granted: false });
    expect(getRecord('app.eth')).toBeNull();
  });

  test('applies removals before a mixed-diff rejection and never applies the addition', async () => {
    const initial = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({
      publish: { why: 'Publish releases' },
      feeds: { why: 'Update feed' },
    })) });
    decideManifest(initial.token, 'allow');

    const update = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: false,
    }, { fetchManifest: async () => responseFor(manifest({
      feeds: { why: 'Update feed' },
      messaging: { why: 'Receive updates' },
    })) });

    expect(mockPermissionState['app.eth'].autoApprove.publish).toBe(false);
    expect(mockPermissionState['app.eth'].autoApprove.feeds).toBe(true);
    decideManifest(update.token, 'deny');
    expect(mockPermissionState['app.eth'].messaging).toBeUndefined();
    expect(getRecord('app.eth').acknowledged.publish).toBeUndefined();
  });

  test('keeps managed grants during transient discovery failure', async () => {
    const initial = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({ publish: { why: 'Publish releases' } })) });
    decideManifest(initial.token, 'allow');

    const result = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: false,
    }, { fetchManifest: async () => responseFor({}, 503) });
    expect(result).toMatchObject({ kind: 'unresolved', retryAt: expect.any(Number) });
    expect(mockPermissionState['app.eth'].autoApprove.publish).toBe(true);
    expect(getRecord('app.eth')).not.toBeNull();
  });

  test('keeps managed grants when the manifest body dies mid-stream', async () => {
    const initial = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: true,
    }, { fetchManifest: async () => responseFor(manifest({
      publish: { why: 'Publish releases' },
      feeds: { why: 'Update feed' },
    })) });
    decideManifest(initial.token, 'allow');
    expect(mockFeedState['app.eth'].granted).toBe(true);

    const result = await checkManifest({
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      eager: false,
    }, { fetchManifest: async () => severedResponse() });

    expect(result).toMatchObject({ kind: 'unresolved', retryAt: expect.any(Number) });
    expect(mockPermissionState['app.eth'].autoApprove.publish).toBe(true);
    expect(mockPermissionState['app.eth'].autoApprove.feeds).toBe(true);
    expect(mockFeedState['app.eth'].granted).toBe(true);
    expect(getRecord('app.eth')).not.toBeNull();
  });

  test('backs off unresolved discovery across rapid committed navigations', async () => {
    const realNow = Date.now;
    let now = 10_000;
    Date.now = () => now;
    try {
      const fetchManifest = jest.fn().mockResolvedValue(responseFor({}, 503));
      const first = await checkManifest({
        origin: 'app.eth',
        committedUrl: 'bzz://app.eth/',
        eager: true,
      }, { fetchManifest });
      const second = await checkManifest({
        origin: 'app.eth',
        committedUrl: 'bzz://app.eth/',
        eager: true,
      }, { fetchManifest });

      expect(fetchManifest).toHaveBeenCalledTimes(1);
      expect(second).toMatchObject({ kind: 'legacy', reason: 'unresolved-backoff', retryAt: first.retryAt });

      now = first.retryAt;
      await checkManifest({
        origin: 'app.eth',
        committedUrl: 'bzz://app.eth/',
        eager: true,
      }, { fetchManifest });
      expect(fetchManifest).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });

  test('serializes concurrent manifest IPC checks for the same origin', async () => {
    registerPermissionManifestIpc();
    let releaseFirst;
    mockHandleBzzRequest
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValue(responseFor(manifest({ publish: { why: 'Publish releases' } })));

    const first = ipcHandlers['swarm:manifest-check']({}, {
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      navigationKey: 'tab-1:1',
      eager: true,
    });
    await Promise.resolve();
    const second = ipcHandlers['swarm:manifest-check']({}, {
      origin: 'app.eth',
      committedUrl: 'bzz://app.eth/',
      navigationKey: 'tab-2:1',
      eager: true,
    });
    await Promise.resolve();

    expect(mockHandleBzzRequest).toHaveBeenCalledTimes(1);
    releaseFirst(responseFor(manifest({ publish: { why: 'Publish releases' } })));
    await first;
    await second;
    expect(mockHandleBzzRequest).toHaveBeenCalledTimes(2);
  });

  test('two tabs of one app share a single consent instead of two stale-able tokens', async () => {
    const fetchManifest = async () => responseFor(manifest({ publish: { why: 'Publish releases' } }));
    const request = { origin: 'app.eth', committedUrl: 'bzz://app.eth/', eager: true };
    const tabA = await checkManifest(request, { fetchManifest });
    const tabB = await checkManifest(request, { fetchManifest });

    expect(tabA.kind).toBe('consent');
    expect(tabB.kind).toBe('consent');
    expect(tabB.token).toBe(tabA.token);

    // One sheet, one answer: the second tab's decide replays that answer
    // rather than tripping the revision guard the first decision bumped.
    const decision = decideManifest(tabA.token, 'allow');
    expect(decision).toEqual({ allowed: true, mode: 'allow' });
    expect(decideManifest(tabB.token, 'allow')).toEqual(decision);
    expect(mockPermissionState['app.eth'].autoApprove.publish).toBe(true);
    expect(getRecord('app.eth').receipts).toHaveLength(1);
  });

  test('a coalescing second tab refreshes the shared consent TTL', async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 0, 1) });
    try {
      const fetchManifest = async () => responseFor(manifest({ publish: { why: 'Publish releases' } }));
      const request = { origin: 'app.eth', committedUrl: 'bzz://app.eth/', eager: true };
      const tabA = await checkManifest(request, { fetchManifest });
      // Second tab arrives 4.5 min into the 5 min TTL and reuses the token.
      jest.advanceTimersByTime(4.5 * 60 * 1000);
      const tabB = await checkManifest(request, { fetchManifest });
      expect(tabB.token).toBe(tabA.token);
      // Past the ORIGINAL 5 min expiry but within the refreshed window: the
      // reused token must still decide (without the refresh it would throw).
      jest.advanceTimersByTime(1 * 60 * 1000);
      expect(decideManifest(tabB.token, 'allow')).toEqual({ allowed: true, mode: 'allow' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('a shared first-contact denial drops the observation for both tabs', async () => {
    const fetchManifest = async () => responseFor(manifest({ messaging: { why: 'Receive updates' } }));
    const request = { origin: 'app.eth', committedUrl: 'bzz://app.eth/', eager: true };
    const tabA = await checkManifest(request, { fetchManifest });
    const tabB = await checkManifest(request, { fetchManifest });

    const decision = decideManifest(tabA.token, 'deny');
    expect(decision).toEqual({ allowed: false, mode: 'deny' });
    expect(decideManifest(tabB.token, 'deny')).toEqual(decision);
    expect(getRecord('app.eth')).toBeNull();
    expect(mockPermissionState['app.eth']).toBeUndefined();
  });

  test('a changed manifest still invalidates the outstanding consent', async () => {
    const request = { origin: 'app.eth', committedUrl: 'bzz://app.eth/', eager: true };
    const tabA = await checkManifest(request, {
      fetchManifest: async () => responseFor(manifest({ publish: { why: 'Publish releases' } })),
    });
    const tabB = await checkManifest(request, {
      fetchManifest: async () => responseFor(manifest({
        publish: { why: 'Publish releases' },
        messaging: { why: 'Receive updates' },
      })),
    });

    expect(tabB.token).not.toBe(tabA.token);
    expect(() => decideManifest(tabA.token, 'allow')).toThrow('stale');
  });
});
