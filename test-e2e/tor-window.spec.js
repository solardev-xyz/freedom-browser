// Tor windows (#473): a private window whose every request goes through
// Arti. Checked in the running app, through Chromium's own proxy resolution
// for the window's session rather than our config objects:
//
//   - the window opens with its own chrome, badge and start page;
//   - its session sends everything to Arti's SOCKS5 port, loopback included,
//     and keeps doing so with Tor not running (fail closed), while a normal
//     window's session stays DIRECT;
//   - WebRTC can't send UDP outside the proxy;
//   - names and Swarm/IPFS addresses don't open: the chrome shows the Tor
//     page's notice, and the session's own scheme handlers answer with one;
//   - opening the window, and a page load in it while Tor isn't running,
//     start Tor, turning it on in Settings (off in the harness profile).
//
// The harness records those starts instead of spawning Arti, so Tor stays
// not running here; test-e2e/live/tor-window.spec.js runs the real thing.

const fs = require('fs');
const { test, expect } = require('./fixtures');

async function openTorWindow(electronApp) {
  const known = new Set(electronApp.windows().map((page) => page.url()));
  // The application menu is built during bootstrap, after the first window.
  await expect
    .poll(() =>
      electronApp.evaluate(({ Menu }) =>
        Boolean(Menu.getApplicationMenu()?.getMenuItemById('new-tor-window'))
      )
    )
    .toBe(true);
  await electronApp.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('new-tor-window');
    if (!item) throw new Error('New Tor Window menu item not found');
    item.click();
  });
  let page;
  await expect
    .poll(
      () => {
        page = electronApp
          .windows()
          .find(
            (candidate) => candidate.url().includes('torWindow=1') && !known.has(candidate.url())
          );
        return Boolean(page);
      },
      { message: 'Waiting for the Tor window', timeout: 15_000 }
    )
    .toBe(true);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-test="address-input"]', { state: 'visible' });
  return page;
}

// The Tor window's tab: the guest webContents whose host is that window.
const torGuest = (electronApp, script) =>
  electronApp.evaluate(async ({ webContents }, code) => {
    const guest = webContents
      .getAllWebContents()
      .find(
        (wc) => wc.getType() === 'webview' && wc.hostWebContents?.getURL().includes('torWindow=1')
      );
    if (!guest) return { missing: true };
    return new Function('guest', `return (async () => { ${code} })();`)(guest);
  }, script);

// A page script: WebRTC from a blank frame the page makes itself (which the
// preload's removal doesn't reach) gathers ICE candidates against
// `iceServers`, and resolves with them once gathering ends.
const blankFrameRtc = (iceServers) => `new Promise(async (resolve) => {
  const frame = document.body.appendChild(document.createElement('iframe'));
  const PC = frame.contentWindow.RTCPeerConnection;
  if (!PC) return resolve('no RTCPeerConnection in the frame');
  const found = [];
  const pc = new PC({ iceServers: ${JSON.stringify(iceServers)} });
  pc.createDataChannel('probe');
  pc.onicecandidate = (event) =>
    event.candidate ? found.push(event.candidate.candidate) : resolve(found);
  await pc.setLocalDescription(await pc.createOffer());
  setTimeout(() => resolve(found), 10000);
})`;

async function navigateTo(page, value) {
  const input = page.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(value);
  await input.press('Enter');
}

const torWindowStarts = (electronApp) =>
  electronApp.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.torWindowStarts());

test('a Tor window routes everything through Tor and keeps names and dweb out', async ({
  electronApp,
  window,
}) => {
  await expect
    .poll(() => electronApp.evaluate(() => Boolean(globalThis.__FREEDOM_TEST_HARNESS__)))
    .toBe(true);
  await electronApp.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.recordTorWindowStarts());
  expect(
    (await window.evaluate(() => window.electronAPI.getSettings())).enableTorIntegration
  ).not.toBe(true);

  const page = await openTorWindow(electronApp);

  // Its own chrome: private and Tor, and the Tor badge with Tor's state.
  await expect(page.locator('body')).toHaveClass(/private-window/);
  await expect(page.locator('body')).toHaveClass(/tor-window/);
  await expect(page.locator('[data-test="private-badge"]')).toBeHidden();
  await expect(page.locator('[data-test="tor-badge"]')).toBeVisible();
  await expect(page.locator('#tor-badge-state')).toHaveText('not running');

  // Opening it turned Tor on in Settings and started it.
  await expect.poll(() => torWindowStarts(electronApp)).toBe(1);
  expect((await window.evaluate(() => window.electronAPI.getSettings())).enableTorIntegration).toBe(
    true
  );

  // The start page is the Tor page.
  await expect
    .poll(() => torGuest(electronApp, 'return guest.getURL();'))
    .toMatch(/\/pages\/tor\.html$/);

  // Chromium resolves every URL on the window's session to SOCKS5, loopback
  // included, with Tor not running. A normal window stays DIRECT.
  const routes = await torGuest(
    electronApp,
    `return {
      web: await guest.session.resolveProxy('https://example.com/'),
      onion: await guest.session.resolveProxy('http://example.onion/'),
      loopback: await guest.session.resolveProxy('http://127.0.0.1:8080/'),
      rtc: guest.getWebRTCIPHandlingPolicy(),
    };`
  );
  expect(routes.web).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/);
  expect(routes.onion).toBe(routes.web);
  expect(routes.loopback).toBe(routes.web);
  expect(routes.rtc).toBe('disable_non_proxied_udp');

  // No WebRTC in the page. A blank frame the page makes itself is not covered:
  // Electron doesn't run the preload in a new frame's initial empty document,
  // and this Chromium has no switch or CSP directive (`webrtc 'block'`, probed
  // 2026-11-13) that turns WebRTC off. A normal window's tab still has it.
  const rtc = await torGuest(
    electronApp,
    `return guest.executeJavaScript('({ page: typeof RTCPeerConnection, legacy: typeof webkitRTCPeerConnection })');`
  );
  expect(rtc).toEqual({ page: 'undefined', legacy: 'undefined' });
  const normalRtc = await electronApp.evaluate(async ({ webContents }) => {
    const tab = webContents
      .getAllWebContents()
      .find(
        (wc) =>
          wc.getType() === 'webview' && !wc.hostWebContents?.getURL().includes('privatePartition')
      );
    return tab ? tab.executeJavaScript('typeof RTCPeerConnection') : 'no normal tab';
  });
  expect(normalRtc).toBe('function');

  // What keeps the IP address in, blank frame included, is the policy: it's
  // set on the whole tab. A blank frame's WebRTC learns no address at all; with
  // the policy switched off by hand, the same probe learns the machine's own
  // (host candidates; a STUN server would add the public one). No network
  // needed: the host candidates come from the machine's interfaces.
  const candidates = (policy) =>
    torGuest(
      electronApp,
      `const before = guest.getWebRTCIPHandlingPolicy();
       ${policy ? `guest.setWebRTCIPHandlingPolicy('${policy}');` : ''}
       try {
         return await guest.executeJavaScript(${JSON.stringify(blankFrameRtc([]))});
       } finally {
         guest.setWebRTCIPHandlingPolicy(before);
       }`
    );
  expect(await candidates()).toEqual([]);
  expect((await candidates('default')).length).toBeGreaterThan(0);
  expect(await torGuest(electronApp, 'return guest.getWebRTCIPHandlingPolicy();')).toBe(
    'disable_non_proxied_udp'
  );

  // A page's TURN server name isn't looked up outside Tor either: it goes to
  // the SOCKS port with the connection, while a normal window looks it up.
  // Chromium's net log records the lookup either way, network or not. Still
  // open (#1247): a `.local` name goes out as an mDNS query, and with DNS
  // over HTTPS on, any name is looked up at the DNS provider.
  const netLogFile = test.info().outputPath('tor-window-netlog.json');
  const turnHost = (tag) => `freedom-turn-probe-${tag}-${Date.now().toString(36)}.example.com`;
  const torTurn = turnHost('tor');
  const normalTurn = turnHost('normal');
  const turnServer = (host) => [
    { urls: `turn:${host}:443?transport=tcp`, username: 'u', credential: 'p' },
  ];
  await electronApp.evaluate(({ netLog }, file) => netLog.startLogging(file), netLogFile);
  await torGuest(
    electronApp,
    `return guest.executeJavaScript(${JSON.stringify(blankFrameRtc(turnServer(torTurn)))});`
  );
  await electronApp.evaluate(
    async ({ webContents }, script) => {
      const tab = webContents
        .getAllWebContents()
        .find(
          (wc) =>
            wc.getType() === 'webview' && !wc.hostWebContents?.getURL().includes('privatePartition')
        );
      return tab.executeJavaScript(script);
    },
    blankFrameRtc(turnServer(normalTurn))
  );
  await electronApp.evaluate(({ netLog }) => netLog.stopLogging());
  const netLog = JSON.parse(fs.readFileSync(netLogFile, 'utf8'));
  const lookups = (host) =>
    netLog.events.filter(
      (event) =>
        event.type === netLog.constants.logEventTypes.HOST_RESOLVER_MANAGER_JOB &&
        JSON.stringify(event.params || {}).includes(host)
    ).length;
  expect(lookups(normalTurn)).toBeGreaterThan(0);
  expect(lookups(torTurn)).toBe(0);

  const normal = await electronApp.evaluate(({ session }) =>
    session.defaultSession.resolveProxy('https://example.com/')
  );
  expect(normal).toBe('DIRECT');

  // A typed name opens the Tor page's notice instead of being looked up.
  await navigateTo(page, 'vitalik.eth');
  await expect
    .poll(() => torGuest(electronApp, 'return guest.getURL();'))
    .toMatch(/\/pages\/tor\.html#blocked$/);
  expect(
    await torGuest(
      electronApp,
      `return guest.executeJavaScript("getComputedStyle(document.getElementById('blocked')).display");`
    )
  ).toBe('block');

  // With Tor not running, the gate cancels the window's web requests: they
  // can't reach whatever listens on the port its proxy points at.
  const gated = await torGuest(
    electronApp,
    `try { await guest.loadURL('https://example.com/'); return 'loaded'; }
     catch (err) { return String(err.message); }`
  );
  // The harness serves https from its own protocol handler, which reports a
  // request the gate cancelled as ERR_FAILED rather than the network stack's
  // ERR_BLOCKED_BY_CLIENT. With the gate open the same load succeeds (checked
  // by hand on 2026-11-13), so a failure here is the gate.
  expect(gated).not.toBe('loaded');
  expect(gated).toMatch(/ERR_(BLOCKED_BY_CLIENT|FAILED)/);
  // A page load held back while Tor isn't running starts it again.
  await expect.poll(() => torWindowStarts(electronApp)).toBe(2);

  // A web address typed into the bar is not kept out: it goes to the session,
  // where the gate holds it back while Tor isn't running, and the tab shows
  // the Tor page's "waiting for Tor" notice instead of seeming to ignore the
  // address.
  await navigateTo(page, 'https://example.com/');
  await expect
    .poll(() => torGuest(electronApp, 'return guest.getURL();'))
    .toMatch(/\/pages\/tor\.html#offline$/);

  // A bare Swarm reference opens the notice, before any probe starts.
  await navigateTo(page, 'a'.repeat(64));
  await expect
    .poll(() => torGuest(electronApp, 'return guest.getURL();'))
    .toMatch(/\/pages\/tor\.html#blocked$/);

  // A dweb address that reaches the session anyway gets main's notice page.
  const blocked = await torGuest(
    electronApp,
    `await guest.loadURL('bzz://abcdef0123/').catch(() => {});
     return guest.executeJavaScript('document.body.innerText');`
  );
  expect(blocked).toContain('Not available in a Tor window');
});
