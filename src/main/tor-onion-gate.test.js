const { isOnionUrl, onionNoticeUrl, isOnionNotice, makeOnionGate } = require('./tor-onion-gate');

const ONION = 'http://exampleonionaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.onion/';

describe('.onion addresses outside Tor windows (#1248)', () => {
  test('matches onion hosts the way the PAC does', () => {
    for (const url of [
      ONION,
      'https://sub.example.onion:8443/path?q=1',
      'ws://chat.example.onion/socket',
      'wss://example.onion./',
      'HTTP://EXAMPLE.ONION/',
    ]) {
      expect({ url, onion: isOnionUrl(url) }).toEqual({ url, onion: true });
    }
    for (const url of [
      'https://example.com/',
      'https://onion.example.com/',
      'https://example.com/x.onion',
      'file:///app/pages/x.onion',
      'bzz://example.onion/',
      'not a url',
      undefined,
    ]) {
      expect({ url, onion: isOnionUrl(url) }).toEqual({ url, onion: false });
    }
  });

  test("the gate holds an .onion request back until the session's route is live", () => {
    const normal = { name: 'default' };
    const torWindow = { name: 'tor' };
    let live = false;
    const onHeldBack = jest.fn();
    const gate = makeOnionGate({
      isTorSession: (s) => s === torWindow,
      isRouteLive: (s) => s === normal && live,
      onHeldBack,
    });
    const ask = (url, resourceType = 'mainFrame', session = normal) =>
      gate({ url, resourceType, webContentsId: 7 }, { session });

    expect(ask(ONION)).toEqual({ cancel: true });
    expect(onHeldBack).toHaveBeenCalledWith({
      url: ONION,
      resourceType: 'mainFrame',
      webContentsId: 7,
    });
    // A subresource or a socket is refused, and starts nothing.
    expect(ask(`${ONION}logo.png`, 'image')).toEqual({ cancel: true });
    expect(ask('wss://example.onion/ws', 'webSocket')).toEqual({ cancel: true });
    expect(onHeldBack).toHaveBeenCalledTimes(1);

    // Everything else is not its business, nor a Tor window (its own gate).
    expect(ask('https://example.com/')).toBeNull();
    expect(ask(ONION, 'mainFrame', torWindow)).toBeNull();

    live = true;
    expect(ask(ONION)).toBeNull();
    expect(onHeldBack).toHaveBeenCalledTimes(1);
  });

  test('the gate keeps a request cancelled if showing the notice fails', () => {
    const gate = makeOnionGate({
      isTorSession: () => false,
      isRouteLive: () => false,
      onHeldBack: () => {
        throw new Error('boom');
      },
    });
    expect(gate({ url: ONION, resourceType: 'mainFrame' }, { session: {} })).toEqual({
      cancel: true,
    });
  });

  test('the notice is the error page, naming the address, in either state', () => {
    const waiting = onionNoticeUrl(ONION, 'waiting');
    const ask = onionNoticeUrl(ONION, 'ask');
    expect(waiting).toMatch(
      /^file:\/\/.*\/src\/renderer\/pages\/error\.html\?error=tor_starting&url=/
    );
    expect(ask).toMatch(/\?error=tor_off&url=/);
    expect(new URL(ask).searchParams.get('url')).toBe(ONION);

    expect(isOnionNotice(waiting, ONION)).toBe(true);
    expect(isOnionNotice(ask, ONION)).toBe(true);
    expect(isOnionNotice(ask, 'http://other.onion/')).toBe(false);
    const otherError = new URL(ask);
    otherError.searchParams.set('error', 'ERR_FAILED');
    expect(isOnionNotice(otherError.toString(), ONION)).toBe(false);
    expect(
      isOnionNotice(
        `https://evil.example/renderer/pages/error.html?error=tor_off&url=${ONION}`,
        ONION
      )
    ).toBe(false);
    expect(isOnionNotice(undefined, ONION)).toBe(false);
  });
});

describe('a held-back .onion page load (#1248)', () => {
  const { EventEmitter } = require('events');
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  // A normal window's tab (id 51), with Tor's side mocked: Tor on or off in
  // Settings, and whether `.onion` is routed through a running Tor yet.
  const setup = ({ torOn = false } = {}) => {
    jest.resetModules();
    const host = { isDestroyed: () => false };
    const window = { id: 'window' };
    const guest = Object.assign(new EventEmitter(), {
      id: 51,
      hostWebContents: host,
      session: { name: 'default' },
      isDestroyed: () => false,
      loadURL: jest.fn(() => Promise.resolve()),
    });
    const tor = {
      on: torOn,
      live: false,
      ensureTorForOnion: jest.fn(() => tor.on),
      isOnionRouteLive: jest.fn(() => tor.live),
    };
    jest.doMock('electron', () => ({
      BrowserWindow: { fromWebContents: (wc) => (wc === host ? window : null) },
      webContents: { fromId: (id) => (id === 51 ? guest : null) },
    }));
    jest.doMock('./tor-manager', () => tor);
    const gate = require('./tor-onion-gate');
    const held = require('./tor-held-loads');
    held.trackTabNavigation(guest);
    const navigate = (url) => guest.emit('did-start-navigation', { url, isMainFrame: true });
    const heldBack = (url, method = 'GET') => {
      navigate(url);
      gate.notifyOnionHeldBack({ webContentsId: 51, url, method });
    };
    const loads = () => guest.loadURL.mock.calls.map(([url]) => url);
    return { gate, resume: held.resumeHeldLoads, window, guest, tor, navigate, heldBack, loads };
  };

  test('Tor on in Settings: starts it, waits, and opens the page once it is connected', async () => {
    const { gate, resume, window, tor, navigate, heldBack, loads } = setup({ torOn: true });
    const WAITING = gate.onionNoticeUrl(ONION, 'waiting');

    heldBack(ONION);
    await tick();
    expect(tor.ensureTorForOnion).toHaveBeenCalledWith({ promptWindow: window });
    expect(loads()).toEqual([WAITING]);
    navigate(WAITING);

    resume();
    expect(loads()).toEqual([WAITING]);
    tor.live = true;
    resume();
    resume();
    expect(loads()).toEqual([WAITING, ONION]);
  });

  test('Tor off: the notice asks, and the page opens once the user has started Tor', async () => {
    const { gate, resume, tor, navigate, heldBack, loads } = setup();
    const ASK = gate.onionNoticeUrl(ONION, 'ask');

    heldBack(ONION);
    await tick();
    expect(loads()).toEqual([ASK]);
    navigate(ASK);

    // The Start Tor button (IPC.TOR_START_FOR_ONION) turned it on; it connects.
    tor.on = true;
    tor.live = true;
    resume();
    expect(loads()).toEqual([ASK, ONION]);
  });

  test('a page the server redirects to an .onion address gets the notice', async () => {
    const { gate, guest, navigate, loads } = setup();
    navigate('https://redirect.example/');
    guest.emit('did-redirect-navigation', { url: ONION, isMainFrame: true });
    gate.notifyOnionHeldBack({ webContentsId: 51, url: ONION, method: 'GET' });
    await tick();
    expect(loads()).toEqual([gate.onionNoticeUrl(ONION, 'ask')]);
  });

  test('a tab sent elsewhere keeps its page, and a form is never sent again', async () => {
    const { gate, resume, tor, navigate, heldBack, loads } = setup({ torOn: true });
    const WAITING = gate.onionNoticeUrl(ONION, 'waiting');

    heldBack(ONION);
    await tick();
    navigate(WAITING);
    navigate('https://example.com/');
    tor.live = true;
    resume();
    expect(loads()).toEqual([WAITING]);

    tor.live = false;
    heldBack(`${ONION}submit`, 'POST');
    await tick();
    const formNotice = gate.onionNoticeUrl(`${ONION}submit`, 'waiting');
    navigate(formNotice);
    tor.live = true;
    resume();
    expect(loads()).toEqual([WAITING, formNotice]);
  });

  test('another address’s notice is not this one’s', async () => {
    const { gate, resume, tor, navigate, heldBack, loads } = setup({ torOn: true });
    heldBack(ONION);
    await tick();
    navigate(gate.onionNoticeUrl('http://other.onion/', 'waiting'));
    tor.live = true;
    resume();
    expect(loads()).toEqual([gate.onionNoticeUrl(ONION, 'waiting')]);
  });
});
