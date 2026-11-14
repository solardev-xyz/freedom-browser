// Tor windows (#473), the chrome's side: what a Tor window won't open, and
// what its badge says.

describe('tor-window (renderer)', () => {
  const originalWindow = global.window;
  let mod;

  beforeAll(async () => {
    jest.resetModules();
    global.window = {
      location: { href: 'file:///app/index.html' },
      internalPages: { routable: { tor: 'tor.html' } },
    };
    mod = await import('./tor-window.js');
  });

  afterAll(() => {
    global.window = originalWindow;
  });

  test('names and dweb addresses are kept out, typed or behind view-source:', () => {
    for (const target of [
      'vitalik.eth',
      'swarm.eth/path?x=1',
      'meinhard.box',
      'domain.tez',
      'bzz://abc123',
      'ipfs://bafybeigdyrzt/site',
      'ipns://k51qzi5uqu5d',
      'rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5',
      'web3://0x1234/app',
      'ens://vitalik.eth',
      'BZZ://ABC',
      'view-source:bzz://abc',
      'view-source:vitalik.eth',
    ]) {
      expect({ target, blocked: mod.isTorBlockedTarget(target) }).toEqual({
        target,
        blocked: true,
      });
    }
  });

  test("the web and Freedom's own pages still open", () => {
    for (const target of [
      'https://check.torproject.org/',
      'http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/',
      'example.com',
      'search words',
      'freedom://settings',
      'view-source:https://example.com/',
      '',
    ]) {
      expect({ target, blocked: mod.isTorBlockedTarget(target) }).toEqual({
        target,
        blocked: false,
      });
    }
    expect(mod.isTorBlockedTarget(undefined)).toBe(false);
  });

  test('the notice is the Tor page with its #blocked section', () => {
    expect(mod.torBlockedPageUrl()).toBe('file:///app/pages/tor.html#blocked');
  });

  test("the badge reads Tor's state, and offers nothing: Tor starts by itself", () => {
    expect(mod.torBadgeView({ status: 'running' })).toEqual({ label: 'connected', tone: 'on' });
    expect(mod.torBadgeView({ status: 'starting' })).toEqual({
      label: 'connecting…',
      tone: 'pending',
    });
    expect(mod.torBadgeView({ status: 'stopping' })).toEqual({
      label: 'stopping…',
      tone: 'pending',
    });
    expect(mod.torBadgeView({ status: 'error', error: 'boom' })).toEqual({
      label: 'not connected',
      tone: 'off',
    });
    // Before main has turned Tor on for the window, too.
    expect(
      mod.torBadgeView({
        status: 'stopped',
        error: 'Tor integration is disabled. Enable it in Settings > Advanced',
      })
    ).toEqual({ label: 'not running', tone: 'off' });
    expect(mod.torBadgeView()).toEqual({ label: 'not running', tone: 'off' });
  });

  test("the badge follows Tor's status updates", () => {
    let onStatus;
    const badge = { dataset: {} };
    const badgeState = { textContent: '', closest: () => badge };
    mod.initTorWindowBadge({
      badgeState,
      tor: {
        onStatusUpdate: (fn) => {
          onStatus = fn;
        },
      },
    });

    onStatus({ status: 'starting' });
    expect(badgeState.textContent).toBe('connecting…');
    expect(badge.dataset.tone).toBe('pending');

    onStatus({ status: 'running' });
    expect(badgeState.textContent).toBe('connected');
    expect(badge.dataset.tone).toBe('on');
  });
});
