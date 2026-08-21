const IPC = require('../../shared/ipc-channels');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../../test/helpers/main-process-test-utils');

// Flush the promise chain grantWithOsGate rides on.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeFakeSession() {
  const session = {
    requestHandler: null,
    checkHandler: null,
    setPermissionRequestHandler: jest.fn((handler) => {
      session.requestHandler = handler;
    }),
    setPermissionCheckHandler: jest.fn((handler) => {
      session.checkHandler = handler;
    }),
  };
  return session;
}

let nextHostId = 1;

function makeHost() {
  const host = {
    id: nextHostId++,
    send: jest.fn(),
    destroyed: false,
    destroyedCallbacks: [],
    once: jest.fn((event, cb) => {
      if (event === 'destroyed') host.destroyedCallbacks.push(cb);
    }),
    isDestroyed: () => host.destroyed,
    destroy() {
      host.destroyed = true;
      for (const cb of host.destroyedCallbacks) cb();
    },
  };
  return host;
}

let nextGuestId = 100;

// Fake requesting webContents (webview guest): EventEmitter semantics for
// the did-navigate/destroyed lifecycle hooks the manager installs.
function makeGuest(url, host) {
  const { EventEmitter } = require('events');
  const guest = new EventEmitter();
  guest.id = nextGuestId++;
  guest.hostWebContents = host;
  guest.currentUrl = url;
  guest.destroyed = false;
  guest.getURL = () => guest.currentUrl;
  guest.isDestroyed = () => guest.destroyed;
  guest.navigate = (nextUrl) => {
    guest.currentUrl = nextUrl || guest.currentUrl;
    guest.emit('did-navigate');
  };
  guest.destroy = () => {
    guest.destroyed = true;
    guest.emit('destroyed');
  };
  return guest;
}

describe('permissions-manager', () => {
  let userDataDir;
  let ctx;
  let session;
  let systemPreferences;

  const load = (options = {}) => {
    systemPreferences = {
      askForMediaAccess: jest.fn(() => Promise.resolve(true)),
      ...(options.systemPreferences || {}),
    };
    ctx = loadMainModule(require.resolve('./permissions-manager'), {
      userDataDir,
      electronOverrides: { systemPreferences },
    });
    session = makeFakeSession();
    ctx.mod.installPermissionHandlers(session);
    ctx.mod.registerPermissionsIpc();
    return ctx;
  };

  // Ask for a permission; returns the callback mock. Pass `guest` to
  // issue several requests from the same tab.
  const request = (
    permission,
    { url = 'https://example.com/page', host, guest, details = {} } = {}
  ) => {
    const callback = jest.fn();
    const wc = guest || makeGuest(url, host);
    session.requestHandler(wc, permission, callback, { requestingUrl: url, ...details });
    return callback;
  };

  // The last prompt payload sent to a host window.
  const lastPrompt = (host) => {
    const calls = host.send.mock.calls.filter(([ch]) => ch === IPC.PERMISSIONS_PROMPT_REQUEST);
    return calls.length ? calls[calls.length - 1][1] : null;
  };

  const promptCount = (host) =>
    host.send.mock.calls.filter(([ch]) => ch === IPC.PERMISSIONS_PROMPT_REQUEST).length;

  const cancelPayloads = (host) =>
    host.send.mock.calls.filter(([ch]) => ch === IPC.PERMISSIONS_PROMPT_CANCEL).map(([, p]) => p);

  const respond = (response) => ctx.ipcMain.invoke(IPC.PERMISSIONS_PROMPT_RESPONSE, response);

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
    nextHostId = 1;
    nextGuestId = 100;
  });

  afterEach(() => {
    removeTempUserDataDir(userDataDir);
  });

  test('pointerLock and fullscreen stay auto-allowed', () => {
    load();
    const host = makeHost();
    expect(request('pointerLock', { host })).toHaveBeenCalledWith(true);
    expect(request('fullscreen', { host })).toHaveBeenCalledWith(true);
    expect(host.send).not.toHaveBeenCalled();
  });

  test('clipboard writes are auto-allowed without a prompt (reads still prompt)', () => {
    load();
    const host = makeHost();
    expect(request('clipboard-sanitized-write', { host })).toHaveBeenCalledWith(true);
    expect(host.send).not.toHaveBeenCalled();
    expect(
      session.checkHandler(null, 'clipboard-sanitized-write', 'https://example.com', {
        requestingUrl: 'https://example.com/page',
      })
    ).toBe(true);

    // Reading remains a prompted permission.
    expect(request('clipboard-read', { host })).not.toHaveBeenCalled();
    expect(host.send).toHaveBeenCalledWith(
      IPC.PERMISSIONS_PROMPT_REQUEST,
      expect.objectContaining({ keys: ['clipboard-read'] })
    );
  });

  test('non-promptable permissions (hid, display-capture, unknown) are denied without a prompt', () => {
    load();
    const host = makeHost();
    for (const permission of ['hid', 'display-capture', 'openExternal', 'unknown']) {
      expect(request(permission, { host })).toHaveBeenCalledWith(false);
    }
    expect(host.send).not.toHaveBeenCalled();
  });

  test('requests without a usable site origin are denied', () => {
    load();
    const host = makeHost();
    const callback = jest.fn();
    session.requestHandler(
      makeGuest('file:///pages/settings.html', host),
      'notifications',
      callback,
      { requestingUrl: 'file:///pages/settings.html' }
    );
    expect(callback).toHaveBeenCalledWith(false);
    expect(host.send).not.toHaveBeenCalled();
  });

  test('no stored decision → prompt goes to the requesting window with the requester identity', () => {
    load();
    const host = makeHost();
    const guest = makeGuest('https://example.com/page', host);
    const callback = request('notifications', { host, guest });

    expect(callback).not.toHaveBeenCalled();
    const prompt = lastPrompt(host);
    expect(prompt).toMatchObject({
      origin: 'https://example.com',
      permission: 'notifications',
      keys: ['notifications'],
      guestId: guest.id,
    });
    expect(typeof prompt.id).toBe('number');
  });

  test('allow + remember persists and later requests skip the prompt', async () => {
    load();
    const host = makeHost();
    const callback = request('notifications', { host });
    const prompt = lastPrompt(host);

    await respond({ id: prompt.id, decision: 'allow', remember: true });
    await flush();
    expect(callback).toHaveBeenCalledWith(true);

    // Persisted to the store…
    expect(ctx.mod.getDecisionsForOrigin('https://example.com')).toEqual({
      notifications: { decision: 'allow', remembered: true },
    });

    // …and the next request grants silently.
    host.send.mockClear();
    const second = request('notifications', { host });
    await flush();
    expect(second).toHaveBeenCalledWith(true);
    expect(host.send).not.toHaveBeenCalled();
  });

  test('deny + remember persists and later requests are denied silently', async () => {
    load();
    const host = makeHost();
    const callback = request('geolocation', { host });
    await respond({ id: lastPrompt(host).id, decision: 'deny', remember: true });
    expect(callback).toHaveBeenCalledWith(false);

    host.send.mockClear();
    const second = request('geolocation', { host });
    expect(second).toHaveBeenCalledWith(false);
    expect(host.send).not.toHaveBeenCalled();
  });

  test('unremembered decisions apply for the session only', async () => {
    load();
    const host = makeHost();
    const callback = request('notifications', { host });
    await respond({ id: lastPrompt(host).id, decision: 'allow', remember: false });
    await flush();
    expect(callback).toHaveBeenCalledWith(true);

    // Nothing persisted…
    const storeCtx = loadMainModule(require.resolve('./permissions-store'), { userDataDir });
    expect(storeCtx.mod.getAllDecisions()).toEqual({});

    // …but a reload of the manager module (fresh session state, same
    // profile dir) must re-prompt — session decisions don't survive.
    load();
    const freshHost = makeHost();
    const again = request('notifications', { host: freshHost });
    expect(again).not.toHaveBeenCalled();
    expect(lastPrompt(freshHost)).not.toBeNull();
  });

  test('session-only allow is honored within the same run', async () => {
    load();
    const host = makeHost();
    request('notifications', { host });
    await respond({ id: lastPrompt(host).id, decision: 'allow', remember: false });
    await flush();

    host.send.mockClear();
    const second = request('notifications', { host });
    await flush();
    expect(second).toHaveBeenCalledWith(true);
    expect(host.send).not.toHaveBeenCalled();
  });

  test('dismiss denies once and records nothing', async () => {
    load();
    const host = makeHost();
    const callback = request('notifications', { host });
    await respond({ id: lastPrompt(host).id, decision: 'dismiss' });
    expect(callback).toHaveBeenCalledWith(false);

    // The very next request prompts again.
    host.send.mockClear();
    const second = request('notifications', { host });
    expect(second).not.toHaveBeenCalled();
    expect(lastPrompt(host)).not.toBeNull();
  });

  test('one prompt at a time per tab; the queue advances on response', async () => {
    load();
    const host = makeHost();
    const guest = makeGuest('https://one.example/page', host);
    const first = request('notifications', { host, guest, url: 'https://one.example/page' });
    const second = request('geolocation', { host, guest, url: 'https://one.example/page' });

    // Only the first prompt is on screen.
    expect(promptCount(host)).toBe(1);
    const prompt1 = lastPrompt(host);
    expect(prompt1.keys).toEqual(['notifications']);

    await respond({ id: prompt1.id, decision: 'allow', remember: false });
    await flush();
    expect(first).toHaveBeenCalledWith(true);

    const prompt2 = lastPrompt(host);
    expect(prompt2.keys).toEqual(['geolocation']);
    await respond({ id: prompt2.id, decision: 'deny', remember: false });
    expect(second).toHaveBeenCalledWith(false);
  });

  test('identical origin+permission requests from the same tab coalesce onto one prompt', async () => {
    load();
    const host = makeHost();
    const guest = makeGuest('https://example.com/page', host);
    const first = request('notifications', { host, guest });
    const second = request('notifications', { host, guest });

    expect(promptCount(host)).toBe(1);

    await respond({ id: lastPrompt(host).id, decision: 'allow', remember: false });
    await flush();
    expect(first).toHaveBeenCalledWith(true);
    expect(second).toHaveBeenCalledWith(true);
  });

  test('same-origin requests from different tabs stay separate prompts with their own guestId', () => {
    load();
    const host = makeHost();
    const guestA = makeGuest('https://example.com/page', host);
    const guestB = makeGuest('https://example.com/other', host);
    request('notifications', { host, guest: guestA });
    request('notifications', { host, guest: guestB });

    const prompts = host.send.mock.calls
      .filter(([ch]) => ch === IPC.PERMISSIONS_PROMPT_REQUEST)
      .map(([, payload]) => payload);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].guestId).toBe(guestA.id);
    expect(prompts[1].guestId).toBe(guestB.id);
    expect(prompts[0].id).not.toBe(prompts[1].id);
  });

  test('destroying the window denies everything still pending', () => {
    load();
    const host = makeHost();
    const guest = makeGuest('https://example.com/page', host);
    const active = request('notifications', { host, guest });
    const queued = request('geolocation', { host, guest });

    host.destroy();
    expect(active).toHaveBeenCalledWith(false);
    expect(queued).toHaveBeenCalledWith(false);
  });

  test('requesting document navigation invalidates its prompted and queued requests', async () => {
    load();
    const host = makeHost();
    const guest = makeGuest('https://example.com/page', host);
    const prompted = request('notifications', { host, guest });
    const queued = request('geolocation', { host, guest });
    const promptedId = lastPrompt(host).id;

    guest.navigate('https://example.com/elsewhere');

    // Both requests are denied once, nothing recorded…
    expect(prompted).toHaveBeenCalledWith(false);
    expect(queued).toHaveBeenCalledWith(false);
    expect(ctx.mod.getDecisionsForOrigin('https://example.com')).toEqual({});

    // …the renderer is told to withdraw the on-screen prompt…
    expect(cancelPayloads(host)).toEqual([{ id: promptedId }]);

    // …and a late answer for the stale prompt is a no-op.
    expect(await respond({ id: promptedId, decision: 'allow', remember: true })).toBe(false);
    expect(ctx.mod.getDecisionsForOrigin('https://example.com')).toEqual({});

    // The new document can prompt afresh.
    host.send.mockClear();
    const again = request('notifications', { host, guest });
    expect(again).not.toHaveBeenCalled();
    expect(lastPrompt(host)).not.toBeNull();
  });

  test('destroying the requesting webContents cleans up its pending requests', async () => {
    load();
    const host = makeHost();
    const guest = makeGuest('https://example.com/page', host);
    const prompted = request('notifications', { host, guest });
    const queued = request('geolocation', { host, guest });
    const promptedId = lastPrompt(host).id;

    guest.destroy();

    expect(prompted).toHaveBeenCalledWith(false);
    expect(queued).toHaveBeenCalledWith(false);
    expect(cancelPayloads(host)).toEqual([{ id: promptedId }]);
    expect(await respond({ id: promptedId, decision: 'allow', remember: true })).toBe(false);

    // Other tabs are unaffected.
    host.send.mockClear();
    const other = request('notifications', { host });
    expect(other).not.toHaveBeenCalled();
    expect(lastPrompt(host)).not.toBeNull();
  });

  test("another tab's navigation does not dismiss a background tab's pending request", async () => {
    load();
    const host = makeHost();
    const requester = makeGuest('https://example.com/page', host);
    const otherTab = makeGuest('https://other.example/page', host);

    const callback = request('notifications', { host, guest: requester });
    const promptId = lastPrompt(host).id;
    expect(lastPrompt(host).guestId).toBe(requester.id);

    // The user navigates a DIFFERENT tab (e.g. the active one, or any
    // tab that isn't the requester). Even one with its own pending
    // prompt state must not touch the requester's request.
    request('geolocation', { host, guest: otherTab });
    otherTab.navigate('https://other.example/next');

    expect(callback).not.toHaveBeenCalled();
    expect(cancelPayloads(host)).not.toContainEqual({ id: promptId });

    // The requester's prompt is still answerable.
    await respond({ id: promptId, decision: 'allow', remember: false });
    await flush();
    expect(callback).toHaveBeenCalledWith(true);
  });

  test('media requests split by mediaTypes and store per-device decisions', async () => {
    load();
    const host = makeHost();

    const cameraOnly = request('media', { host, details: { mediaTypes: ['video'] } });
    expect(lastPrompt(host).keys).toEqual(['camera']);
    await respond({ id: lastPrompt(host).id, decision: 'allow', remember: true });
    await flush();
    expect(cameraOnly).toHaveBeenCalledWith(true);

    const both = request('media', { host, details: { mediaTypes: ['video', 'audio'] } });
    // Camera is already allowed, but the mic half is undecided → prompt.
    expect(lastPrompt(host).keys).toEqual(['camera', 'microphone']);
    await respond({ id: lastPrompt(host).id, decision: 'allow', remember: true });
    await flush();
    expect(both).toHaveBeenCalledWith(true);

    expect(ctx.mod.getDecisionsForOrigin('https://example.com')).toEqual({
      camera: { decision: 'allow', remembered: true },
      microphone: { decision: 'allow', remembered: true },
    });
  });

  test('media request with no camera/mic mediaTypes is denied', () => {
    load();
    const host = makeHost();
    const callback = request('media', { host, details: { mediaTypes: [] } });
    expect(callback).toHaveBeenCalledWith(false);
    expect(host.send).not.toHaveBeenCalled();
  });

  test('macOS: OS-level media denial fails the grant and notifies the window', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      load({
        systemPreferences: { askForMediaAccess: jest.fn(() => Promise.resolve(false)) },
      });
      const host = makeHost();
      const callback = request('media', { host, details: { mediaTypes: ['audio'] } });
      await respond({ id: lastPrompt(host).id, decision: 'allow', remember: true });
      await flush();

      expect(systemPreferences.askForMediaAccess).toHaveBeenCalledWith('microphone');
      expect(callback).toHaveBeenCalledWith(false);
      const osDenied = host.send.mock.calls.find(([ch]) => ch === IPC.PERMISSIONS_OS_DENIED);
      expect(osDenied[1]).toEqual({
        origin: 'https://example.com',
        permissions: ['microphone'],
      });
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  test('check handler: only recorded allows pass; media checks use mediaType', async () => {
    load();
    const host = makeHost();

    // Undecided → false (deny-by-default for synchronous checks).
    expect(
      session.checkHandler(null, 'notifications', 'https://example.com', {
        requestingUrl: 'https://example.com/page',
      })
    ).toBe(false);

    request('notifications', { host });
    await respond({ id: lastPrompt(host).id, decision: 'allow', remember: true });
    await flush();

    expect(
      session.checkHandler(null, 'notifications', 'https://example.com', {
        requestingUrl: 'https://example.com/page',
      })
    ).toBe(true);
    expect(session.checkHandler(null, 'pointerLock', 'https://example.com', {})).toBe(true);
    expect(session.checkHandler(null, 'hid', 'https://example.com', {})).toBe(false);

    // Media check: camera allowed, mic not.
    request('media', { host, details: { mediaTypes: ['video'] } });
    await respond({ id: lastPrompt(host).id, decision: 'allow', remember: true });
    await flush();
    const details = (mediaType) => ({ requestingUrl: 'https://example.com/x', mediaType });
    expect(session.checkHandler(null, 'media', 'https://example.com', details('video'))).toBe(true);
    expect(session.checkHandler(null, 'media', 'https://example.com', details('audio'))).toBe(
      false
    );
    // No concrete device type → both must be allowed.
    expect(session.checkHandler(null, 'media', 'https://example.com', details(undefined))).toBe(
      false
    );
  });

  test('revoke IPC clears stored and session decisions', async () => {
    load();
    const host = makeHost();

    request('notifications', { host });
    await respond({ id: lastPrompt(host).id, decision: 'allow', remember: true });
    await flush();
    request('geolocation', { host });
    await respond({ id: lastPrompt(host).id, decision: 'allow', remember: false });
    await flush();

    expect(await ctx.ipcMain.invoke(IPC.PERMISSIONS_GET_FOR_ORIGIN, 'https://example.com')).toEqual(
      {
        notifications: { decision: 'allow', remembered: true },
        geolocation: { decision: 'allow', remembered: false },
      }
    );

    await ctx.ipcMain.invoke(IPC.PERMISSIONS_REVOKE, 'https://example.com', 'notifications');
    expect(await ctx.ipcMain.invoke(IPC.PERMISSIONS_GET_FOR_ORIGIN, 'https://example.com')).toEqual(
      {
        geolocation: { decision: 'allow', remembered: false },
      }
    );

    await ctx.ipcMain.invoke(IPC.PERMISSIONS_REVOKE_ORIGIN, 'https://example.com');
    expect(await ctx.ipcMain.invoke(IPC.PERMISSIONS_GET_FOR_ORIGIN, 'https://example.com')).toEqual(
      {}
    );

    // Revoked session grant prompts again.
    host.send.mockClear();
    const again = request('geolocation', { host });
    expect(again).not.toHaveBeenCalled();
    expect(lastPrompt(host)).not.toBeNull();
  });

  test('revoke-all clears every origin', async () => {
    load();
    const host = makeHost();
    request('notifications', { host });
    await respond({ id: lastPrompt(host).id, decision: 'allow', remember: true });
    await flush();

    await ctx.ipcMain.invoke(IPC.PERMISSIONS_REVOKE_ALL);
    expect(await ctx.ipcMain.invoke(IPC.PERMISSIONS_GET_ALL)).toEqual({});
  });

  test('null-origin documents (data:, about:srcdoc) are denied without a prompt', () => {
    load();
    const host = makeHost();
    for (const url of [
      'data:text/html,<script>x</script>',
      'about:srcdoc',
      'not a parseable url at all',
    ]) {
      const callback = request('notifications', { url, host });
      expect(callback).toHaveBeenCalledWith(false);
    }
    expect(promptCount(host)).toBe(0);
  });

  test('host destroyed-listener is disarmed when its last guest goes away', () => {
    load();
    const host = makeHost();
    host.removeListener = jest.fn();
    const guest = makeGuest('https://example.com/page', host);
    request('notifications', { host, guest });
    expect(host.once).toHaveBeenCalledTimes(1);

    guest.destroy();
    expect(host.removeListener).toHaveBeenCalledWith('destroyed', host.destroyedCallbacks[0]);

    // A fresh prompt cycle re-arms exactly one listener.
    const guest2 = makeGuest('https://example.com/other', host);
    request('notifications', { host, guest: guest2 });
    expect(host.once).toHaveBeenCalledTimes(2);
  });

  test('bzz name-host and raw-hash origins stay distinct', async () => {
    load();
    const host = makeHost();
    const hash = 'a'.repeat(64);

    request('notifications', { host, url: 'bzz://myapp.eth/index.html' });
    expect(lastPrompt(host).origin).toBe('myapp.eth');
    await respond({ id: lastPrompt(host).id, decision: 'allow', remember: true });
    await flush();

    // Same site served by raw hash is a different origin → prompts.
    host.send.mockClear();
    const viaHash = request('notifications', { host, url: `bzz://${hash}/index.html` });
    expect(viaHash).not.toHaveBeenCalled();
    expect(lastPrompt(host).origin).toBe(`bzz://${hash}`);
  });
});

// PRIVATE MODE GUARD coverage: decisions made in private windows are
// session-only — never persisted (remember included), scoped to the
// window's partition, dropped by clearPrivateDecisions on window close.
describe('permissions-manager private windows', () => {
  const PARTITION = 'private-test-partition';

  let userDataDir;
  let ctx;
  let normalSession;
  let privateSession;
  let log;

  const load = () => {
    log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    ctx = loadMainModule(require.resolve('./permissions-manager'), {
      userDataDir,
      electronOverrides: {
        systemPreferences: { askForMediaAccess: jest.fn(() => Promise.resolve(true)) },
      },
      extraMocks: {
        [require.resolve('../logger')]: () => log,
      },
    });
    normalSession = makeFakeSession();
    privateSession = makeFakeSession();
    ctx.mod.installPermissionHandlers(normalSession);
    ctx.mod.installPermissionHandlers(privateSession, { privatePartition: PARTITION });
    ctx.mod.registerPermissionsIpc();
    return ctx;
  };

  const requestOn = (session, permission, host, url = 'https://example.com/page', guest) => {
    const callback = jest.fn();
    session.requestHandler(guest || makeGuest(url, host), permission, callback, {
      requestingUrl: url,
    });
    return callback;
  };

  const lastPrompt = (host) => {
    const calls = host.send.mock.calls.filter(([ch]) => ch === IPC.PERMISSIONS_PROMPT_REQUEST);
    return calls.length ? calls[calls.length - 1][1] : null;
  };

  const respond = (response) => ctx.ipcMain.invoke(IPC.PERMISSIONS_PROMPT_RESPONSE, response);

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
    nextHostId = 1;
    nextGuestId = 100;
  });

  afterEach(() => {
    removeTempUserDataDir(userDataDir);
  });

  test('allow with "remember" in a private window is never persisted', async () => {
    load();
    const host = makeHost();
    const callback = requestOn(privateSession, 'notifications', host);
    await respond({ id: lastPrompt(host).id, decision: 'allow', remember: true });
    await flush();
    expect(callback).toHaveBeenCalledWith(true);

    // Nothing lands in permissions.json…
    const storeCtx = loadMainModule(require.resolve('./permissions-store'), { userDataDir });
    expect(storeCtx.mod.getAllDecisions()).toEqual({});
  });

  // PRIVATE MODE GUARD (permission logging): log.info lands in the
  // persistent <userData>/logs/main.log, which outlives the window — an
  // origin a private tab prompted for must not be recorded there, least of
  // all on a line that also labels it as private browsing.
  test('a private prompt answer never writes the origin to the persistent log', async () => {
    load();
    const host = makeHost();
    const url = 'https://secret-private.example/page';

    requestOn(privateSession, 'notifications', host, url);
    await respond({ id: lastPrompt(host).id, decision: 'allow', remember: true });
    await flush();

    // A dismissal takes the other logging branch.
    requestOn(privateSession, 'geolocation', host, url);
    await respond({ id: lastPrompt(host).id, decision: 'dismiss' });
    await flush();

    const lines = log.info.mock.calls.map((call) => call.join(' '));
    // The decisions are still traced...
    expect(lines.some((line) => line.includes('allow notifications'))).toBe(true);
    expect(lines.some((line) => line.includes('dismissed geolocation'))).toBe(true);
    // ...without the origin.
    expect(lines.join('\n')).not.toContain('secret-private.example');

    // Normal windows keep the diagnostic origin.
    const normalHost = makeHost();
    requestOn(normalSession, 'notifications', normalHost, 'https://public.example/page');
    await respond({ id: lastPrompt(normalHost).id, decision: 'allow', remember: false });
    await flush();
    expect(log.info.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
      'public.example'
    );
  });

  test('a private decision applies silently within the window but not to normal windows', async () => {
    load();
    const host = makeHost();
    requestOn(privateSession, 'notifications', host);
    await respond({ id: lastPrompt(host).id, decision: 'allow', remember: true });
    await flush();

    // Same private session: silent grant, no second prompt.
    host.send.mockClear();
    const second = requestOn(privateSession, 'notifications', host);
    await flush();
    expect(second).toHaveBeenCalledWith(true);
    expect(host.send).not.toHaveBeenCalled();

    // Check handler agrees per session.
    expect(
      privateSession.checkHandler(null, 'notifications', 'https://example.com', {
        requestingUrl: 'https://example.com/page',
      })
    ).toBe(true);
    expect(
      normalSession.checkHandler(null, 'notifications', 'https://example.com', {
        requestingUrl: 'https://example.com/page',
      })
    ).toBe(false);

    // A normal window still prompts for the same origin+permission.
    const normalHost = makeHost();
    const normalCallback = requestOn(normalSession, 'notifications', normalHost);
    expect(normalCallback).not.toHaveBeenCalled();
    expect(lastPrompt(normalHost)).not.toBeNull();
  });

  test('normal-window session decisions do not leak into private windows', async () => {
    load();
    const normalHost = makeHost();
    requestOn(normalSession, 'notifications', normalHost);
    await respond({ id: lastPrompt(normalHost).id, decision: 'allow', remember: false });
    await flush();

    // The private window must re-prompt.
    const privateHost = makeHost();
    const callback = requestOn(privateSession, 'notifications', privateHost);
    expect(callback).not.toHaveBeenCalled();
    expect(lastPrompt(privateHost)).not.toBeNull();
  });

  test('persisted profile decisions apply inside private windows (inheritance)', async () => {
    load();
    const normalHost = makeHost();
    const normalCallback = requestOn(normalSession, 'notifications', normalHost);
    await respond({ id: lastPrompt(normalHost).id, decision: 'allow', remember: true });
    await flush();
    expect(normalCallback).toHaveBeenCalledWith(true);

    const privateHost = makeHost();
    const callback = requestOn(privateSession, 'notifications', privateHost);
    await flush();
    expect(callback).toHaveBeenCalledWith(true);
    expect(lastPrompt(privateHost)).toBeNull();
  });

  // The per-guest binding (prompt tied to the requesting tab + its
  // document generation) must hold for private sessions too: an answer
  // that lands after the requesting document navigated is denied once and
  // records nothing — not even a partition-scoped decision.
  test('a stale answer in a private window is denied and records nothing', async () => {
    load();
    const host = makeHost();
    const guest = makeGuest('https://example.com/page', host);
    const callback = requestOn(
      privateSession,
      'notifications',
      host,
      'https://example.com/page',
      guest
    );
    const prompt = lastPrompt(host);
    expect(prompt).not.toBeNull();

    guest.navigate('https://other.example/');
    expect(callback).toHaveBeenCalledWith(false);

    expect(await respond({ id: prompt.id, decision: 'allow', remember: true })).toBe(false);
    await flush();

    // Nothing was recorded for the partition — the next ask prompts again.
    host.send.mockClear();
    const again = requestOn(privateSession, 'notifications', host);
    expect(again).not.toHaveBeenCalled();
    expect(lastPrompt(host)).not.toBeNull();
  });

  // Inheritance-on-read is right when the user has NOT answered inside the
  // private window. Once they have, that answer is the more specific and
  // more recent expression of intent and must win — otherwise a normal
  // window persisting "allow" later silently overrides a "deny" the user
  // gave in a still-open private window. Chromium gives an explicit
  // incognito decision precedence within incognito for the same reason.
  test('an explicit private answer outranks a profile decision made afterwards', async () => {
    load();

    // The user denies inside the private window.
    const privateHost = makeHost();
    const denied = requestOn(privateSession, 'notifications', privateHost);
    await respond({ id: lastPrompt(privateHost).id, decision: 'deny', remember: true });
    await flush();
    expect(denied).toHaveBeenCalledWith(false);

    // Later, a normal window persists "allow" for the SAME origin.
    const normalHost = makeHost();
    const normalCallback = requestOn(normalSession, 'notifications', normalHost);
    await respond({ id: lastPrompt(normalHost).id, decision: 'allow', remember: true });
    await flush();
    expect(normalCallback).toHaveBeenCalledWith(true);

    // The still-open private window keeps denying — silently, no re-prompt.
    privateHost.send.mockClear();
    const again = requestOn(privateSession, 'notifications', privateHost);
    expect(again).toHaveBeenCalledWith(false);
    expect(privateHost.send).not.toHaveBeenCalled();
    expect(
      privateSession.checkHandler(null, 'notifications', 'https://example.com', {
        requestingUrl: 'https://example.com/page',
      })
    ).toBe(false);

    // …and the normal window is unaffected: the profile decision still holds.
    expect(
      normalSession.checkHandler(null, 'notifications', 'https://example.com', {
        requestingUrl: 'https://example.com/page',
      })
    ).toBe(true);
  });

  // A removal, unlike a stored deny, carries no decision that could override
  // a live private grant — so "revoke" has to remove the private tier too,
  // or an open private window keeps granting until it closes.
  describe('revoking also clears live private-window decisions', () => {
    const grantInPrivateWindow = async (host) => {
      requestOn(privateSession, 'notifications', host);
      await respond({ id: lastPrompt(host).id, decision: 'allow', remember: true });
      await flush();
      expect(
        privateSession.checkHandler(null, 'notifications', 'https://example.com', {
          requestingUrl: 'https://example.com/page',
        })
      ).toBe(true);
    };

    const expectRevoked = (host) => {
      expect(
        privateSession.checkHandler(null, 'notifications', 'https://example.com', {
          requestingUrl: 'https://example.com/page',
        })
      ).toBe(false);
      // Re-prompts rather than silently allowing.
      host.send.mockClear();
      const again = requestOn(privateSession, 'notifications', host);
      expect(again).not.toHaveBeenCalled();
      expect(lastPrompt(host)).not.toBeNull();
    };

    test('revokeDecision', async () => {
      load();
      const host = makeHost();
      await grantInPrivateWindow(host);
      expect(ctx.mod.revokeDecision('https://example.com', 'notifications')).toBe(true);
      expectRevoked(host);
    });

    test('revokeOrigin', async () => {
      load();
      const host = makeHost();
      await grantInPrivateWindow(host);
      expect(ctx.mod.revokeOrigin('https://example.com')).toBe(true);
      expectRevoked(host);
    });

    test('revokeAll', async () => {
      load();
      const host = makeHost();
      await grantInPrivateWindow(host);
      expect(ctx.mod.revokeAll()).toBe(true);
      expectRevoked(host);
    });

    test('a revoke that matches a different origin leaves the private grant alone', async () => {
      load();
      const host = makeHost();
      await grantInPrivateWindow(host);
      expect(ctx.mod.revokeOrigin('https://unrelated.example')).toBe(false);
      expect(
        privateSession.checkHandler(null, 'notifications', 'https://example.com', {
          requestingUrl: 'https://example.com/page',
        })
      ).toBe(true);
    });
  });

  test('clearPrivateDecisions drops the window decisions (close semantics)', async () => {
    load();
    const host = makeHost();
    requestOn(privateSession, 'notifications', host);
    await respond({ id: lastPrompt(host).id, decision: 'deny', remember: true });
    await flush();

    // Denied silently while the window lives…
    host.send.mockClear();
    const denied = requestOn(privateSession, 'notifications', host);
    expect(denied).toHaveBeenCalledWith(false);
    expect(host.send).not.toHaveBeenCalled();

    // …and forgotten once the window closes.
    expect(ctx.mod.clearPrivateDecisions(PARTITION)).toBe(true);
    const again = requestOn(privateSession, 'notifications', host);
    expect(again).not.toHaveBeenCalled();
    expect(lastPrompt(host)).not.toBeNull();
  });
});
