// Real-network E2E for Tor windows (#473): without FREEDOM_TEST_MODE, with
// the bundled Arti, opening a Tor window turns Tor on and starts it, a Tor
// window's page really leaves through Tor, and with Tor stopped a page load
// doesn't go out directly: it starts Tor again and opens once it's connected.
//
// test-e2e/tor-window.spec.js checks the routing in the harness, where http(s)
// is stubbed; this one asks the Tor Project's own check service.

const { test, expect, HAS_ARTI_BINARY, ARTI_BINARY_PATH } = require('../live-fixtures');

const CHECK_URL = 'https://check.torproject.org/api/ip';
const TOR_START_TIMEOUT_MS = 180_000;

async function openTorWindow(electronApp) {
  const known = new Set(electronApp.windows().map((page) => page.url()));
  await expect
    .poll(() =>
      electronApp.evaluate(({ Menu }) =>
        Boolean(Menu.getApplicationMenu()?.getMenuItemById('new-tor-window'))
      )
    )
    .toBe(true);
  await electronApp.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().getMenuItemById('new-tor-window').click()
  );
  let page;
  await expect
    .poll(() => {
      page = electronApp
        .windows()
        .find(
          (candidate) => candidate.url().includes('torWindow=1') && !known.has(candidate.url())
        );
      return Boolean(page);
    })
    .toBe(true);
  await page.waitForSelector('[data-test="tor-badge"]', { state: 'visible' });
  return page;
}

const findTorTab = `webContents
  .getAllWebContents()
  .find((wc) => wc.getType() === 'webview' && wc.hostWebContents?.getURL().includes('torWindow=1'))`;

// Load `url` in the Tor window's tab and report what came of it.
const loadInTorWindow = (electronApp, url) =>
  electronApp.evaluate(
    async ({ webContents }, { target, find }) => {
      const guest = new Function('webContents', `return ${find};`)(webContents);
      if (!guest) return { error: 'no Tor window tab' };
      try {
        await guest.loadURL(target);
        return { body: await guest.executeJavaScript('document.body.innerText') };
      } catch (err) {
        return { error: String(err?.message || err) };
      }
    },
    { target: url, find: findTorTab }
  );

// What the Tor window's tab shows now.
const torTabNow = (electronApp) =>
  electronApp.evaluate(async ({ webContents }, find) => {
    const guest = new Function('webContents', `return ${find};`)(webContents);
    if (!guest) return { url: null };
    return {
      url: guest.getURL(),
      body: await guest.executeJavaScript('document.body.innerText').catch(() => ''),
    };
  }, findTorTab);

test.describe('Tor window, live', () => {
  test.skip(
    !HAS_ARTI_BINARY,
    `No bundled Arti at ${ARTI_BINARY_PATH}; run \`npm run arti:fetch\` first.`
  );

  test('pages leave through Tor; with Tor stopped, a load starts it again', async ({
    window,
    electronApp,
  }) => {
    test.setTimeout(2 * TOR_START_TIMEOUT_MS + 120_000);
    await window.evaluate(() =>
      window.electronAPI.saveSettings({ enableTorIntegration: false, startTorAtLaunch: false })
    );

    // Opening the window turns Tor on and starts it.
    const page = await openTorWindow(electronApp);
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.electronAPI.getSettings())).enableTorIntegration
      )
      .toBe(true);
    await expect(page.locator('#tor-badge-state')).toHaveText('connected', {
      timeout: TOR_START_TIMEOUT_MS,
    });

    // A freshly bootstrapped Arti can drop its first connection or two
    // (ERR_CONNECTION_CLOSED, seen on a cold state directory), so retry.
    let viaTor;
    await expect
      .poll(
        async () => {
          viaTor = await loadInTorWindow(electronApp, CHECK_URL);
          return viaTor.error || 'loaded';
        },
        { timeout: 60_000, intervals: [3_000, 5_000] }
      )
      .toBe('loaded');
    expect(JSON.parse(viaTor.body)).toMatchObject({ IsTor: true });

    // Stopped: the window keeps pointing at Arti's port, so the load doesn't
    // go out. The gate cancels it before it reaches the proxy, and Chromium
    // reports nothing for that; loadURL settles on the tab's next failure
    // instead, which is the waiting notice being replaced once Tor is back
    // (ERR_ABORTED). A proxy failure would do too. Anything but a load.
    await page.evaluate(() => window.tor.stop());
    await expect(page.locator('#tor-badge-state')).toHaveText('not running', { timeout: 30_000 });
    const stopped = await loadInTorWindow(electronApp, CHECK_URL);
    expect(stopped.body || '').not.toContain('IsTor');
    expect(stopped.error).toMatch(
      /ERR_(ABORTED|FAILED|BLOCKED_BY_CLIENT|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|CONNECTION_REFUSED)/
    );

    // That load started Tor again, and the page opens once it's connected.
    await expect(page.locator('#tor-badge-state')).toHaveText('connected', {
      timeout: TOR_START_TIMEOUT_MS,
    });
    let resumed;
    await expect
      .poll(
        async () => {
          resumed = await torTabNow(electronApp);
          return resumed.url;
        },
        { timeout: 60_000 }
      )
      .toBe(CHECK_URL);
    await expect
      .poll(async () => (await torTabNow(electronApp)).body, { timeout: 30_000 })
      .toContain('IsTor');
    expect(JSON.parse((await torTabNow(electronApp)).body)).toMatchObject({ IsTor: true });
  });
});
