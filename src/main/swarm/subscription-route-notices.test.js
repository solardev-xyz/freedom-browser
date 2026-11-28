/**
 * Question 4's surfaces in main (freedom-core design 0015, Messaging; SWM-7's
 * PR 7.5): the notice, once per site per session, and the Nodes panel's and
 * Settings' line, from the subscription registry's own route test (its real
 * `checkRoute`, with the session's `resolveProxy` scripted).
 */

jest.mock('electron', () => ({}), { virtual: true });

const IPC = require('../../shared/ipc-channels');
const registry = require('./subscription-registry');
const {
  TEXTS,
  MAX_SITE_CHARS,
  displaySite,
  createSubscriptionRouteNotices,
} = require('./subscription-route-notices');

const REMOTE = 'https://ant.example:1633';
const LOOPBACK_EXTERNAL = 'http://127.0.0.1:1633';
const BUNDLED = 'http://127.0.0.1:11633';
const ONION = 'http://abcdefghijklmnop.onion';
const ARTI = '127.0.0.1:19150';
const PROXY = 'PROXY proxy.example:8080';

const TOR_NOTICE = (site) =>
  `Live messages from ${site} are off while Tor is on: they would go around it to your external Swarm node`;
const PROXY_NOTICE = (site) =>
  `Live messages from ${site} are off while your proxy is on: they would go around it to your external Swarm node`;
const TOR_LINES = {
  panel: 'Live messages are off while Tor is on: they would go around it to your external node',
  settings: 'Live messages are off while Tor is on: they would go around it to your external node.',
};
const PROXY_LINES = {
  panel: 'Live messages are off while your proxy is on: they would go around it to your external node',
  settings: 'Live messages are off while your proxy is on: they would go around it to your external node.',
};
const ONION_NOTICE = (site) =>
  `Live messages from ${site} are off: your external Swarm node is an .onion address, and they can't go through Tor`;
const ONION_LINES = {
  panel: "Live messages are off: your external node is an .onion address, and they can't go through Tor",
  settings: "Live messages are off: your external node is an .onion address, and they can't go through Tor.",
};
const NO_LINES = { panel: null, settings: null };

function fakeWindow() {
  return { webContents: { send: jest.fn() }, isDestroyed: () => false };
}

// What was sent on a channel; a route push's revision checked apart (revisions()).
const sent = (win, channel) =>
  win.webContents.send.mock.calls
    .filter(([name]) => name === channel)
    .map(([, payload]) => {
      if (channel !== IPC.SWARM_MESSAGES_ROUTE) return payload;
      const { revision: _revision, ...lines } = payload;
      return lines;
    });
const revisions = (win) =>
  win.webContents.send.mock.calls.filter(([name]) => name === IPC.SWARM_MESSAGES_ROUTE).map(([, p]) => p.revision);

let world;

/** One browser session's notices, over the real registry's route test. */
function session({ windows = world.windows, focused = () => world.windows[0] ?? null } = {}) {
  return createSubscriptionRouteNotices({
    checkRoute: (url) => registry.checkRoute(url),
    nodeUrl: () => world.node,
    noticeWindow: focused,
    chromeWindows: () => windows,
  });
}

beforeEach(() => {
  registry._reset();
  world = { node: REMOTE, proxy: 'DIRECT', tor: null, windows: [fakeWindow(), fakeWindow()] };
  world.resolveProxy = jest.fn(async () => world.proxy);
  registry.configure({
    openSocket: jest.fn(),
    deliver: jest.fn(),
    route: {
      nodeUrl: () => world.node,
      resolveProxy: (url) => world.resolveProxy(url),
      torEndpoint: () => world.tor,
    },
  });
});

describe('the notice: once per site per browser session', () => {
  test('a refused subscription: shown once for the site, in the window the user is in', () => {
    const notices = session();
    notices.onRefused({ origin: 'myapp.eth', via: 'proxy', ended: false });
    notices.onRefused({ origin: 'myapp.eth', via: 'proxy', ended: false });
    expect(sent(world.windows[0], IPC.SWARM_MESSAGES_NOTICE)).toEqual([
      { site: 'myapp.eth', text: PROXY_NOTICE('myapp.eth') },
    ]);
    // Only the window the user is in.
    expect(sent(world.windows[1], IPC.SWARM_MESSAGES_NOTICE)).toEqual([]);
  });

  test('an ended subscription: shown once for the site, and not again for its refusals', () => {
    const notices = session();
    notices.onRefused({ origin: 'myapp.eth', via: 'tor', ended: true });
    notices.onRefused({ origin: 'myapp.eth', via: 'tor', ended: true });
    notices.onRefused({ origin: 'myapp.eth', via: 'tor', ended: false });
    expect(sent(world.windows[0], IPC.SWARM_MESSAGES_NOTICE)).toEqual([
      { site: 'myapp.eth', text: TOR_NOTICE('myapp.eth') },
    ]);
  });

  test('each site is told once', () => {
    const notices = session();
    notices.onRefused({ origin: 'a.eth', via: 'proxy', ended: false });
    notices.onRefused({ origin: 'https://b.example', via: 'proxy', ended: true });
    notices.onRefused({ origin: 'a.eth', via: 'proxy', ended: true });
    notices.onRefused({ origin: 'https://b.example', via: 'proxy', ended: false });
    expect(sent(world.windows[0], IPC.SWARM_MESSAGES_NOTICE).map(({ site }) => site)).toEqual([
      'a.eth',
      'https://b.example',
    ]);
  });

  test('a new session tells each site again, once', () => {
    session().onRefused({ origin: 'myapp.eth', via: 'proxy', ended: false });
    const next = session();
    next.onRefused({ origin: 'myapp.eth', via: 'proxy', ended: true });
    next.onRefused({ origin: 'myapp.eth', via: 'proxy', ended: false });
    expect(sent(world.windows[0], IPC.SWARM_MESSAGES_NOTICE)).toEqual([
      { site: 'myapp.eth', text: PROXY_NOTICE('myapp.eth') },
      { site: 'myapp.eth', text: PROXY_NOTICE('myapp.eth') },
    ]);
  });

  test('no window to show it in: the site is told at its next refusal', () => {
    let target = null;
    const notices = session({ focused: () => target });
    notices.onRefused({ origin: 'myapp.eth', via: 'proxy', ended: false });
    target = { webContents: { send: jest.fn() }, isDestroyed: () => true };
    notices.onRefused({ origin: 'myapp.eth', via: 'proxy', ended: false });
    expect(target.webContents.send).not.toHaveBeenCalled();
    target = world.windows[1];
    notices.onRefused({ origin: 'myapp.eth', via: 'proxy', ended: false });
    notices.onRefused({ origin: 'myapp.eth', via: 'proxy', ended: false });
    expect(sent(world.windows[1], IPC.SWARM_MESSAGES_NOTICE)).toHaveLength(1);
  });

  test('a window that fails to take it, or a lookup that throws, tells nobody and stops nothing', () => {
    const broken = { webContents: { send: jest.fn(() => { throw new Error('gone'); }) }, isDestroyed: () => false };
    const notices = session({ focused: () => broken });
    expect(() => notices.onRefused({ origin: 'myapp.eth', via: 'proxy', ended: false })).not.toThrow();
    const throwing = session({ focused: () => { throw new Error('no windows'); } });
    expect(() => throwing.onRefused({ origin: 'myapp.eth', via: 'proxy', ended: false })).not.toThrow();
  });

  test('an event with no site shows nothing', () => {
    const notices = session();
    for (const origin of [undefined, null, '', 7]) notices.onRefused({ origin, via: 'proxy', ended: false });
    notices.onRefused(undefined);
    expect(world.windows[0].webContents.send).not.toHaveBeenCalled();
  });

  test('the wording: Tor for Arti, "your proxy" for any other, and an onion node with neither', () => {
    expect(TEXTS.notice('myapp.eth', 'tor')).toBe(TOR_NOTICE('myapp.eth'));
    expect(TEXTS.notice('myapp.eth', 'proxy')).toBe(PROXY_NOTICE('myapp.eth'));
    // Anything but Arti is a proxy.
    expect(TEXTS.notice('myapp.eth', undefined)).toBe(PROXY_NOTICE('myapp.eth'));
    expect({ panel: TEXTS.panel('tor'), settings: TEXTS.settings('tor') }).toEqual(TOR_LINES);
    expect({ panel: TEXTS.panel('proxy'), settings: TEXTS.settings('proxy') }).toEqual(PROXY_LINES);
    // An onion node with no Tor route: Tor isn't said to be on.
    expect(TEXTS.notice('myapp.eth', 'onion')).toBe(ONION_NOTICE('myapp.eth'));
    expect({ panel: TEXTS.panel('onion'), settings: TEXTS.settings('onion') }).toEqual(ONION_LINES);
    for (const text of [TEXTS.notice('a.eth', 'onion'), TEXTS.panel('onion'), TEXTS.settings('onion')]) {
      expect(text).not.toMatch(/Tor is on|your proxy/);
    }
  });

  test('an onion node refused with Tor off: its notice says so, not that Tor is on', async () => {
    Object.assign(world, { node: ONION, proxy: 'DIRECT', tor: null });
    const refusal = await registry.checkRoute(ONION);
    expect(refusal).toEqual({ reason: 'proxy-or-tor', via: 'onion' });
    const notices = session();
    notices.onRefused({ origin: 'myapp.eth', via: refusal.via, ended: false });
    expect(sent(world.windows[0], IPC.SWARM_MESSAGES_NOTICE)).toEqual([
      { site: 'myapp.eth', text: ONION_NOTICE('myapp.eth') },
    ]);
  });

  test("a site's key is shown as it is, without control or format characters, and cut short when long", () => {
    expect(displaySite('myapp.eth')).toBe('myapp.eth');
    const bzz = `bzz://${'ab'.repeat(32)}`;
    expect(displaySite(bzz)).toBe(bzz);
    const override = String.fromCharCode(0x202e);
    const zeroWidth = String.fromCharCode(0x200b);
    const newline = String.fromCharCode(10);
    expect(displaySite(`evil${override}hte.${zeroWidth}x${newline}`)).toBe('evilhte.x');
    const long = `https://${'a'.repeat(300)}.example`;
    const shown = displaySite(long);
    expect([...shown]).toHaveLength(MAX_SITE_CHARS);
    expect(shown.endsWith('…')).toBe(true);
    expect(long.startsWith(shown.slice(0, -1))).toBe(true);
    const notices = session();
    notices.onRefused({ origin: `a${override}b.eth`, via: 'proxy', ended: false });
    expect(sent(world.windows[0], IPC.SWARM_MESSAGES_NOTICE)).toEqual([
      { site: `a${override}b.eth`, text: PROXY_NOTICE('ab.eth') },
    ]);
  });
});

describe('the Nodes panel and Settings line: while the node in use is refused', () => {
  test.each([
    ['a remote external node behind a proxy', REMOTE, PROXY, null, PROXY_LINES],
    ["a remote external node behind Arti's endpoint", REMOTE, `SOCKS5 ${ARTI}; DIRECT`, ARTI, TOR_LINES],
    ['a remote external node behind another SOCKS proxy, with Tor on', REMOTE, 'SOCKS5 10.0.0.1:1080', ARTI, PROXY_LINES],
    // An onion node: worded from main's Tor state, its route never asked
    // (Codex round 2 on #1382). Tor on: the socket would go around it.
    ["an onion node while Arti runs", ONION, `SOCKS5 ${ARTI}`, ARTI, TOR_LINES],
    ['an onion node while Arti runs, whatever the session says', ONION, 'DIRECT', ARTI, TOR_LINES],
    // Tor off: never said to be on, whatever proxy is set.
    ['an onion node with Tor off', ONION, 'DIRECT', null, ONION_LINES],
    ['an onion node behind another proxy, Tor off', ONION, PROXY, null, ONION_LINES],
    ['a remote external node reached directly, with Tor on', REMOTE, 'DIRECT', ARTI, NO_LINES],
    ['a remote external node reached directly', REMOTE, 'DIRECT', null, NO_LINES],
  ])('%s', async (_case, node, proxy, tor, lines) => {
    Object.assign(world, { node, proxy, tor });
    expect(await session().refresh()).toMatchObject(lines);
  });

  test.each([
    ['an external node on loopback', LOOPBACK_EXTERNAL],
    ['an external node at localhost', 'http://localhost:1633'],
    ['the bundled node', BUNDLED],
  ])('never for %s, with a proxy and Tor on: its proxy is never asked', async (_case, node) => {
    Object.assign(world, { node, proxy: `SOCKS5 ${ARTI}`, tor: ARTI });
    expect(await session().refresh()).toMatchObject(NO_LINES);
    expect(world.resolveProxy).not.toHaveBeenCalled();
  });

  test('no node in use: no line', async () => {
    world.node = null;
    world.proxy = PROXY;
    expect(await session().refresh()).toMatchObject(NO_LINES);
  });

  test("a proxy that can't be resolved: the line says so, as the refusal does (fail closed)", async () => {
    world.resolveProxy = jest.fn(async () => {
      throw new Error('resolver gone');
    });
    expect(await session().refresh()).toMatchObject(PROXY_LINES);
  });

  test('a route test that throws says nothing', async () => {
    const notices = createSubscriptionRouteNotices({
      checkRoute: async () => {
        throw new Error('broken');
      },
      nodeUrl: () => REMOTE,
      noticeWindow: () => null,
      chromeWindows: () => world.windows,
    });
    expect(await notices.refresh()).toMatchObject(NO_LINES);
  });

  test('pushed to every browser window when it changes, and only then', async () => {
    const notices = session();
    world.proxy = PROXY;
    await notices.refresh();
    await notices.refresh();
    for (const win of world.windows) {
      expect(sent(win, IPC.SWARM_MESSAGES_ROUTE)).toEqual([PROXY_LINES]);
    }
  });

  test('it follows Tor, the proxy and the node, each change pushed', async () => {
    const notices = session();
    const pushes = () => sent(world.windows[0], IPC.SWARM_MESSAGES_ROUTE);
    expect(await notices.refresh()).toMatchObject(NO_LINES);

    // A proxy comes on (a system or PAC proxy: read at the next poll).
    world.proxy = PROXY;
    expect(await notices.refresh()).toMatchObject(PROXY_LINES);

    // Tor takes over the route: Arti's endpoint is what's in the way.
    world.tor = ARTI;
    world.proxy = `SOCKS5 ${ARTI}`;
    expect(await notices.refresh()).toMatchObject(TOR_LINES);

    // The node moves to loopback: nothing goes around anything.
    world.node = LOOPBACK_EXTERNAL;
    expect(await notices.refresh()).toMatchObject(NO_LINES);

    // Back to the remote node, which Tor's PAC sends DIRECT.
    world.node = REMOTE;
    world.proxy = 'DIRECT';
    expect(await notices.refresh()).toMatchObject(NO_LINES);

    // The bundled node, with a proxy on.
    world.node = BUNDLED;
    world.proxy = PROXY;
    expect(await notices.refresh()).toMatchObject(NO_LINES);

    // An onion node through Tor, then with Tor off.
    world.node = ONION;
    world.proxy = `SOCKS5 ${ARTI}`;
    expect(await notices.refresh()).toMatchObject(TOR_LINES);
    world.tor = null;
    world.proxy = 'DIRECT';
    expect(await notices.refresh()).toMatchObject(ONION_LINES);

    expect(pushes()).toEqual([NO_LINES, PROXY_LINES, TOR_LINES, NO_LINES, TOR_LINES, ONION_LINES]);
  });

  test('each read settles with its own revision; one a newer read settled past pushes nothing', async () => {
    let answer;
    world.resolveProxy = jest
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
      .mockImplementation(async () => 'DIRECT');
    const notices = session();
    const older = notices.refresh();
    await Promise.resolve();
    expect(await notices.refresh()).toEqual({ ...NO_LINES, revision: 2 });
    answer(PROXY);
    // The older read answers its own lines and revision: a surface that
    // applied revision 2 drops it (ant-ui.js), and main pushes nothing for it.
    expect(await older).toEqual({ ...PROXY_LINES, revision: 1 });
    expect(sent(world.windows[0], IPC.SWARM_MESSAGES_ROUTE)).toEqual([NO_LINES]);
    expect(revisions(world.windows[0])).toEqual([2]);
  });

  test('reads arriving faster than the route test still each settle (Codex round 3 on #1382)', async () => {
    const answers = [];
    world.resolveProxy = jest.fn(() => new Promise((resolve) => answers.push(resolve)));
    const notices = session();
    const reads = [];
    // Every read is overtaken by the next before it settles, as a 5 s poll
    // over a route test slower than 5 s would do.
    for (let i = 0; i < 6; i += 1) {
      reads.push(notices.refresh());
      await Promise.resolve();
      if (i > 0) answers[i - 1](i % 2 ? PROXY : 'DIRECT');
      await Promise.resolve();
    }
    answers[5]('DIRECT');
    const settled = await Promise.all(reads);
    expect(settled.map((read) => read.revision)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(settled.map(({ revision: _r, ...lines }) => lines)).toEqual([
      PROXY_LINES,
      NO_LINES,
      PROXY_LINES,
      NO_LINES,
      PROXY_LINES,
      NO_LINES,
    ]);
    // Pushed in revision order, each a change.
    const pushed = revisions(world.windows[0]);
    expect([...pushed].sort((x, y) => x - y)).toEqual(pushed);
    expect(sent(world.windows[0], IPC.SWARM_MESSAGES_ROUTE).at(-1)).toEqual(NO_LINES);
  });

  test('a window that fails to take the push stops none of the others', async () => {
    const broken = { webContents: { send: jest.fn(() => { throw new Error('gone'); }) }, isDestroyed: () => false };
    const destroyed = { webContents: { send: jest.fn() }, isDestroyed: () => true };
    const notices = session({ windows: [broken, destroyed, world.windows[0]] });
    world.proxy = PROXY;
    await notices.refresh();
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
    expect(sent(world.windows[0], IPC.SWARM_MESSAGES_ROUTE)).toEqual([PROXY_LINES]);
  });

  test("the line never reports a refusal as a site's", async () => {
    const onRefused = jest.fn();
    registry.configure({ onRefused });
    world.proxy = PROXY;
    await session().refresh();
    expect(onRefused).not.toHaveBeenCalled();
  });
});
