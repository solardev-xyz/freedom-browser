const {
  TOR_BLOCKED_SCHEMES,
  torBlockedPageHtml,
  blockDwebSchemes,
  applyTorWebRtcPolicy,
  makeTorWindowGate,
} = require('./tor-window');

const fakeSession = (handled = []) => {
  const handlers = new Map(handled.map((scheme) => [scheme, () => 'stub']));
  return {
    handlers,
    protocol: {
      isProtocolHandled: jest.fn((scheme) => handlers.has(scheme)),
      unhandle: jest.fn((scheme) => handlers.delete(scheme)),
      handle: jest.fn((scheme, handler) => handlers.set(scheme, handler)),
    },
  };
};

describe('Tor windows, main side (#473)', () => {
  test("every scheme served from the user's own nodes answers with the notice", async () => {
    expect(TOR_BLOCKED_SCHEMES).toEqual(['bzz', 'ipfs', 'ipns', 'rad', 'radapi', 'web3']);
    const session = fakeSession();
    blockDwebSchemes(session);
    for (const scheme of TOR_BLOCKED_SCHEMES) {
      const response = await session.handlers.get(scheme)({ url: `${scheme}://name.eth/` });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain('Not available in a Tor window');
    }
  });

  test('it replaces handlers already on the session (the test harness stubs)', () => {
    const session = fakeSession(['bzz', 'ipfs']);
    blockDwebSchemes(session);
    expect(session.protocol.unhandle).toHaveBeenCalledWith('bzz');
    expect(session.protocol.unhandle).toHaveBeenCalledWith('ipfs');
    expect(session.handlers.get('bzz')).not.toBe(undefined);
  });

  test('the notice escapes the address it names', () => {
    const html = torBlockedPageHtml('bzz://a"<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test("the gate holds a Tor window's network requests until its route is live", () => {
    const torSession = { tor: true };
    let live = false;
    const gate = makeTorWindowGate({
      isTorSession: (s) => s === torSession,
      isRouteLive: (s) => s === torSession && live,
    });
    const ask = (url, session = torSession) => gate({ url }, { session });

    for (const url of [
      'https://example.com/',
      'http://example.onion/',
      'wss://example.com/ws',
      'ws://x/',
    ]) {
      expect({ url, verdict: ask(url) }).toEqual({ url, verdict: { cancel: true } });
    }
    // Freedom's own pages and in-page data never leave the machine.
    for (const url of ['file:///app/pages/tor.html', 'data:text/plain,x', 'blob:https://a/b']) {
      expect({ url, verdict: ask(url) }).toEqual({ url, verdict: null });
    }
    // Other sessions are not its business.
    expect(ask('https://example.com/', { tor: false })).toBeNull();

    live = true;
    expect(ask('https://example.com/')).toBeNull();
  });

  test('WebRTC sends no UDP outside the proxy', () => {
    const contents = { setWebRTCIPHandlingPolicy: jest.fn() };
    applyTorWebRtcPolicy(contents);
    expect(contents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');
  });

  test('openTorWindow routes the session first, then starts Tor for the window', async () => {
    jest.resetModules();
    const window = { id: 7 };
    const createTorWindow = jest.fn(async (url, { routeThroughTor }) => {
      await routeThroughTor('private-x', { session: true });
      return window;
    });
    const registerTorWindowSession = jest.fn().mockResolvedValue(undefined);
    const ensureTorForTorWindow = jest.fn();
    jest.doMock('./private/private-windows', () => ({ createTorWindow }));
    jest.doMock('./tor-manager', () => ({ registerTorWindowSession, ensureTorForTorWindow }));
    const { openTorWindow } = require('./tor-window');

    await expect(openTorWindow('https://example.org/')).resolves.toBe(window);
    expect(registerTorWindowSession).toHaveBeenCalledWith('private-x', { session: true });
    expect(ensureTorForTorWindow).toHaveBeenCalledWith({ promptWindow: window });

    createTorWindow.mockResolvedValueOnce(null);
    ensureTorForTorWindow.mockClear();
    await expect(openTorWindow()).resolves.toBeNull();
    expect(ensureTorForTorWindow).not.toHaveBeenCalled();
  });
});

describe('a held-back page load (#473)', () => {
  const { EventEmitter } = require('events');
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  // A Tor window tab (id 41) in its window, with Tor's side mocked.
  const setup = ({ live = false } = {}) => {
    jest.resetModules();
    const host = { isDestroyed: () => false };
    const window = { id: 'tor-window' };
    const guest = Object.assign(new EventEmitter(), {
      id: 41,
      hostWebContents: host,
      session: { tor: true },
      isDestroyed: () => false,
      loadURL: jest.fn(() => Promise.resolve()),
    });
    const tor = {
      live,
      ensureTorForTorWindow: jest.fn(),
      isTorWindowRouteLive: jest.fn(() => tor.live),
    };
    jest.doMock('electron', () => ({
      BrowserWindow: { fromWebContents: (wc) => (wc === host ? window : null) },
      webContents: { fromId: (id) => (id === 41 ? guest : null) },
    }));
    jest.doMock('./tor-manager', () => tor);
    const mod = require('./tor-window');
    // The held-back flow itself lives in tor-held-loads.js (shared with the
    // `.onion` gate, #1248); a Tor window brings its policy to it.
    const held = require('./tor-held-loads');
    held.trackTabNavigation(guest);
    const navigate = (url, isMainFrame = true) =>
      guest.emit('did-start-navigation', { url, isMainFrame });
    // A navigation that starts, and that the gate holds back.
    const heldBack = (url, method = 'GET') => {
      navigate(url);
      mod.notifyHeldBack({ webContentsId: 41, url, method });
    };
    const loads = () => guest.loadURL.mock.calls.map(([url]) => url);
    const resume = held.resumeHeldLoads;
    return {
      mod,
      resume,
      window,
      guest,
      tor,
      navigate,
      heldBack,
      loads,
      NOTICE: mod.TOR_WAITING_PAGE_URL,
    };
  };

  test('the notice is the Tor page, from main', () => {
    const { NOTICE } = setup();
    expect(NOTICE).toMatch(/^file:\/\/.*\/src\/renderer\/pages\/tor\.html#offline$/);
  });

  test("starts Tor, and shows the notice while it's the tab's latest navigation", async () => {
    const { window, tor, navigate, heldBack, loads, NOTICE } = setup();

    heldBack('https://a.example/');
    await tick();
    expect(tor.ensureTorForTorWindow).toHaveBeenCalledWith({ promptWindow: window });
    expect(loads()).toEqual([NOTICE]);

    // The user moved on before the notice went up: none.
    heldBack('https://b.example/');
    navigate('https://c.example/');
    await tick();
    expect(loads()).toEqual([NOTICE]);

    // A subframe navigation is not the tab's.
    heldBack('https://d.example/');
    navigate('https://ad.example/', false);
    await tick();
    expect(loads()).toEqual([NOTICE, NOTICE]);
  });

  test('opens once Tor is connected, in a tab still waiting for it, once', async () => {
    const { resume, tor, navigate, heldBack, loads, NOTICE } = setup();
    heldBack('https://a.example/');
    await tick();
    navigate(NOTICE);

    // Told while this session isn't re-pointed yet: nothing happens.
    resume();
    expect(loads()).toEqual([NOTICE]);

    tor.live = true;
    resume();
    resume();
    expect(loads()).toEqual([NOTICE, 'https://a.example/']);
  });

  test('Tor up before the notice: the page opens, and no notice follows it', async () => {
    const { resume, tor, navigate, heldBack, loads } = setup();
    heldBack('https://a.example/');
    // Tor comes up in the same turn, before the notice would go up.
    tor.live = true;
    resume();
    navigate('https://a.example/');
    await tick();
    expect(loads()).toEqual(['https://a.example/']);
  });

  test('Tor up just after the notice was asked for: the page opens over it', async () => {
    const { resume, tor, heldBack, loads, NOTICE } = setup();
    heldBack('https://a.example/');
    await tick();
    // The notice's navigation hasn't started yet when Tor comes up.
    tor.live = true;
    resume();
    expect(loads()).toEqual([NOTICE, 'https://a.example/']);
  });

  test('a form held after a page replaces it, and neither is sent again by itself', async () => {
    const { resume, tor, navigate, heldBack, loads, NOTICE } = setup();
    heldBack('https://a.example/');
    await tick();
    navigate(NOTICE);
    // Back to a cached form, sent while Tor is still connecting.
    navigate('https://form.example/');
    heldBack('https://form.example/submit', 'POST');
    await tick();
    navigate(NOTICE);
    expect(loads()).toEqual([NOTICE, NOTICE]);

    tor.live = true;
    resume();
    expect(loads()).toEqual([NOTICE, NOTICE]);
  });

  test('a tab sent elsewhere since keeps its page', async () => {
    const { resume, tor, navigate, heldBack, loads, NOTICE } = setup();
    heldBack('https://a.example/');
    await tick();
    navigate(NOTICE);
    navigate('file:///app/src/renderer/pages/tor.html');
    tor.live = true;
    resume();
    expect(loads()).toEqual([NOTICE]);
  });
});
