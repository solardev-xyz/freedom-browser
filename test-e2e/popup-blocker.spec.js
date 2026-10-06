// Popup blocker for tab webviews (#442), in real Chromium.
//
// Chrome's blocker lives in the `chrome/` layer Electron doesn't ship, so
// Freedom gates `setWindowOpenHandler` itself (src/main/popup-blocker.js): a
// new tab needs trusted input on the page within 5 s — consumed, so one click
// opens one tab — or the site's "Always allow pop-ups". A blocked popup shows
// the address-bar "Pop-up blocked" icon (popup-blocker-ui.js), whose popover
// can open it anyway or allow the site for good.
//
// Real input goes to the guest's own webContents (`sendInputEvent`), which is
// what Chromium marks trusted and what the main-process gesture tracker sees.
// `executeJavaScript` without its gesture flag is a script with no gesture.

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');
const { evalInWebview } = require('./permission-fixtures');

const SITE = `bzz://${SAMPLE_BZZ_HASH}`;
const PAGE_URL = `${SITE}/`;
const POPUP_A = `${SITE}/popup-a.html`;
const POPUP_B = `${SITE}/popup-b.html`;
// A page that calls window.open while it loads, with no input of its own.
const OPENS_ON_LOAD = `${SITE}/opens-on-load.html`;
const SHOT_DIR = process.env.TMPDIR || '/tmp';

const PAGE_BODY = [
  '<!doctype html><title>popup fixture</title>',
  '<style>a, button { display: block; font-size: 24px; margin: 16px; }</style>',
  `<a id="blank" target="_blank" href="${POPUP_A}">open A in a new tab</a>`,
  // One real click, two window.open calls: one gesture buys one popup.
  `<button id="two" onclick="window.open('${POPUP_A}'); window.open('${POPUP_B}')">two</button>`,
  // A plain same-tab link to a page that opens a popup on load.
  `<a id="next" href="${OPENS_ON_LOAD}">next page</a>`,
  '<div id="out">ready</div>',
  // Room to scroll, for the touch-scroll case.
  '<div style="height:4000px"></div>',
].join('\n');

const tabs = (window) => window.locator('[data-test="tab"]');
const icon = (window) => window.locator('[data-test="popup-blocked-indicator"]');
const popover = (window) => window.locator('[data-test="popup-blocked-popover"]');

const guestUrls = (electronApp) =>
  electronApp.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((wc) => wc.getType() === 'webview')
      .map((wc) => wc.getURL())
  );

async function seedFixtures(electronApp) {
  await electronApp.evaluate(
    (_e, { fixtures }) => {
      for (const [url, body] of fixtures) {
        globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture(url, { body });
      }
    },
    {
      fixtures: [
        [PAGE_URL, PAGE_BODY],
        [POPUP_A, '<!doctype html><title>popup A</title><p id="who">popup A'],
        [POPUP_B, '<!doctype html><title>popup B</title><p id="who">popup B'],
        [
          OPENS_ON_LOAD,
          '<!doctype html><title>opens on load</title><p id="who">next</p>' +
            `<script>window.open(${JSON.stringify(POPUP_A)});</script>`,
        ],
      ],
    }
  );
}

async function gotoFixture(window, electronApp) {
  await seedFixtures(electronApp);
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(SITE);
  await input.press('Enter');
  await expect
    .poll(() => evalInWebview(window, "document.getElementById('out')?.textContent || null"), {
      timeout: 10_000,
    })
    .toBe('ready');
}

// A real click on the fixture guest: trusted, and seen by the gesture tracker.
async function realClick(window, electronApp, id) {
  const box = await evalInWebview(
    window,
    `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
      return { x: Math.round(r.left + 10), y: Math.round(r.top + r.height / 2) }; })()`
  );
  expect(box).not.toBeNull();
  await electronApp.evaluate(
    ({ webContents }, { x, y, url }) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === url);
      if (!guest) throw new Error('fixture guest not found');
      guest.sendInputEvent({ type: 'mouseMove', x, y });
      guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    },
    { ...box, url: PAGE_URL }
  );
}

// A touch on the fixture guest through CDP's Input.dispatchTouchEvent, which
// runs Chromium's real gesture detector: no moves is a tap; a long drag turns
// into a scroll (gestureScrollBegin before the touchEnd).
async function realTouch(electronApp, moves) {
  await electronApp.evaluate(
    async ({ webContents }, { url, moves }) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === url);
      if (!guest) throw new Error('fixture guest not found');
      guest.debugger.attach('1.3');
      try {
        const touch = (type, touchPoints) =>
          guest.debugger.sendCommand('Input.dispatchTouchEvent', { type, touchPoints });
        await touch('touchStart', [{ x: 200, y: 300 }]);
        for (const [x, y] of moves) await touch('touchMove', [{ x, y }]);
        await touch('touchEnd', []);
      } finally {
        guest.debugger.detach();
      }
    },
    { url: PAGE_URL, moves }
  );
}

// A script with no user gesture.
const scriptOpen = (window, url) =>
  evalInWebview(window, `window.open(${JSON.stringify(url)}); 'ok'`);

// Chrome clicks as DOM events: right after a guest attaches, Chromium can route
// pointer events at chrome coordinates into the guest surface (see
// permission-fixtures.js `answerPrompt`). These specs are about the blocker,
// not compositor input routing.
const clickChrome = async (locator) => {
  await expect(locator).toBeVisible();
  await locator.dispatchEvent('click');
};

// Open a private window via the real File-menu item and return its chrome
// page (same shape as permissions.spec.js / private-windows.spec.js).
async function openPrivateWindow(electronApp) {
  const known = new Set(
    electronApp
      .windows()
      .map((page) => page.url())
      .filter((url) => url.includes('privatePartition=private-'))
  );
  await electronApp.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('new-private-window');
    if (!item) throw new Error('New Private Window menu item not found');
    item.click();
  });
  let page;
  await expect
    .poll(
      () => {
        page = electronApp
          .windows()
          .find((p) => p.url().includes('privatePartition=private-') && !known.has(p.url()));
        return !!page;
      },
      { message: 'Waiting for the private chrome window', timeout: 15_000 }
    )
    .toBe(true);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-test="address-input"]', { state: 'visible' });
  return page;
}

async function closePrivateWindows(electronApp) {
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      if (win.webContents.getURL().includes('privatePartition=private-')) win.close();
    }
  });
}

test('a real click on target=_blank opens a tab; one click opens one popup', async ({
  window,
  electronApp,
}) => {
  await gotoFixture(window, electronApp);
  await expect(tabs(window)).toHaveCount(1);

  await realClick(window, electronApp, 'blank');
  await expect(tabs(window)).toHaveCount(2);
  await expect.poll(() => guestUrls(electronApp), { timeout: 10_000 }).toContain(POPUP_A);
  await expect(icon(window)).toBeHidden();

  // Back on the opener: one click whose handler calls window.open twice.
  await tabs(window).first().click();
  await expect(tabs(window).first()).toHaveAttribute('class', /(^|\s)active(\s|$)/);
  await realClick(window, electronApp, 'two');
  await expect(tabs(window)).toHaveCount(3);
  await window.waitForTimeout(1_000);
  await expect(tabs(window)).toHaveCount(3);
  // The second one was blocked; its opener tab shows the icon.
  await tabs(window).first().click();
  await expect(icon(window)).toBeVisible();
  await clickChrome(icon(window));
  await expect(popover(window)).toBeVisible();
  await expect(popover(window).locator('[data-test="popup-blocked-open"]')).toHaveText([
    `Open ${POPUP_B}`,
  ]);
});

test('a script-only window.open is blocked, shows the icon, and "Open" opens it', async ({
  window,
  electronApp,
}) => {
  await gotoFixture(window, electronApp);
  await scriptOpen(window, POPUP_B);
  // A scripted target=_blank click is the same popup, and is blocked too.
  await evalInWebview(window, "document.getElementById('blank').click(); 'ok'");
  await window.waitForTimeout(1_000);
  await expect(tabs(window)).toHaveCount(1);
  expect(await guestUrls(electronApp)).not.toContain(POPUP_B);

  await expect(icon(window)).toBeVisible();
  await expect(icon(window)).toHaveAttribute('aria-label', '2 pop-ups blocked');
  await clickChrome(icon(window));
  await expect(popover(window)).toBeVisible();
  const openButtons = popover(window).locator('[data-test="popup-blocked-open"]');
  await expect(openButtons).toHaveText([`Open ${POPUP_B}`, `Open ${POPUP_A}`]);
  await expect(popover(window)).toContainText(SITE);
  await window.screenshot({ path: `${SHOT_DIR}/popup-blocked-popover.png` });

  await clickChrome(openButtons.first());
  await expect(tabs(window)).toHaveCount(2);
  await expect.poll(() => guestUrls(electronApp), { timeout: 10_000 }).toContain(POPUP_B);
  // It opened in the foreground, as an allowed popup would have.
  await expect(tabs(window).nth(1)).toHaveAttribute('class', /(^|\s)active(\s|$)/);
  await expect(icon(window)).toBeHidden();

  // The opener still lists the one it did not open…
  await tabs(window).first().click();
  await expect(icon(window)).toBeVisible();
  await expect(icon(window)).toHaveAttribute('aria-label', 'Pop-up blocked');
  // …until its page navigates.
  await evalInWebview(window, 'location.reload(); "ok"');
  await expect(icon(window)).toBeHidden({ timeout: 10_000 });
});

test('"Always allow" survives a restart and is removed in Settings > Privacy and security > Site Permissions', async ({
  window,
  electronApp,
  relaunchApp,
}) => {
  await gotoFixture(window, electronApp);
  await scriptOpen(window, POPUP_A);
  await expect(icon(window)).toBeVisible();
  await clickChrome(icon(window));
  await clickChrome(window.locator('[data-test="popup-blocked-allow"]'));
  await expect(window.locator('[data-test="popup-blocked-allowed"]')).toBeVisible();
  await window.screenshot({ path: `${SHOT_DIR}/popup-blocked-allowed.png` });

  // It is a site permission like any other: the permission indicator shows it.
  await expect(window.locator('[data-test="permission-indicator"]')).toBeVisible();

  // Allowed right away, without a gesture.
  await scriptOpen(window, POPUP_B);
  await expect(tabs(window)).toHaveCount(2);

  // Restart on the same profile.
  await electronApp.close();
  const app = await relaunchApp();
  const win = await app.firstWindow();
  await win.waitForSelector('[data-test="address-input"]', { state: 'visible' });
  // Whatever tabs were restored, work from a fresh one.
  await win.locator('[data-test="new-tab-btn"]').click();
  const before = await tabs(win).count();
  await gotoFixture(win, app);
  await scriptOpen(win, POPUP_A);
  await expect(tabs(win)).toHaveCount(before + 1);
  await expect(icon(win)).toBeHidden();

  // Settings > Privacy and security > Site Permissions lists it; Remove revokes it.
  await tabs(win)
    .nth(before - 1)
    .click();
  const input = win.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://settings/permissions');
  await input.press('Enter');
  const readView = () =>
    evalInWebview(win, "document.querySelector('#permissions-view')?.textContent || null");
  await expect.poll(readView, { timeout: 10_000 }).toContain(SITE);
  expect(await readView()).toContain('Pop-ups');
  await win.screenshot({ path: `${SHOT_DIR}/popup-settings-listed.png` });
  await evalInWebview(
    win,
    `document.querySelector('#permissions-view button[data-action="revoke"][data-permission="popups"]').click(); 'ok'`
  );
  await expect.poll(readView, { timeout: 5_000 }).toContain('No saved permissions');

  // Blocked again.
  await gotoFixture(win, app);
  const count = await tabs(win).count();
  await scriptOpen(win, POPUP_B);
  await win.waitForTimeout(1_000);
  await expect(tabs(win)).toHaveCount(count);
  await expect(icon(win)).toBeVisible();
});

test('a private window allows pop-ups for its own session only', async ({
  window,
  electronApp,
}) => {
  const priv = await openPrivateWindow(electronApp);
  await gotoFixture(priv, electronApp);
  await scriptOpen(priv, POPUP_A);
  await expect(icon(priv)).toBeVisible();
  await clickChrome(icon(priv));
  await clickChrome(priv.locator('[data-test="popup-blocked-allow"]'));
  await expect(priv.locator('[data-test="popup-blocked-allowed"]')).toBeVisible();
  await scriptOpen(priv, POPUP_B);
  await expect(tabs(priv)).toHaveCount(2);

  // Nothing reached the profile's store, so a normal window still blocks.
  const stored = () =>
    electronApp.evaluate(({ app }) => {
      const fs = process.getBuiltinModule('fs');
      const path = process.getBuiltinModule('path');
      const file = path.join(app.getPath('userData'), 'permissions.json');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    });
  expect(await stored()).not.toContain('popups');
  await gotoFixture(window, electronApp);
  await scriptOpen(window, POPUP_A);
  await window.waitForTimeout(1_000);
  await expect(tabs(window)).toHaveCount(1);
  await expect(icon(window)).toBeVisible();

  // And it goes with the private window: a new one blocks again.
  await closePrivateWindows(electronApp);
  const priv2 = await openPrivateWindow(electronApp);
  await gotoFixture(priv2, electronApp);
  await scriptOpen(priv2, POPUP_A);
  await priv2.waitForTimeout(1_000);
  await expect(tabs(priv2)).toHaveCount(1);
  await expect(icon(priv2)).toBeVisible();
  await closePrivateWindows(electronApp);
});

// Chromium's activation does not survive a cross-document navigation: the
// click that followed a same-tab link must not pay for a popup the next page
// opens on load.
test('a click that navigated the tab does not pay for a popup the next page opens', async ({
  window,
  electronApp,
}) => {
  await gotoFixture(window, electronApp);
  await realClick(window, electronApp, 'next');
  await expect
    .poll(() => evalInWebview(window, "document.getElementById('who')?.textContent || null"), {
      timeout: 10_000,
    })
    .toBe('next');
  await expect(icon(window)).toBeVisible();
  await expect(tabs(window)).toHaveCount(1);
  expect(await guestUrls(electronApp)).not.toContain(POPUP_A);
  await window.screenshot({ path: `${SHOT_DIR}/popup-blocked-after-navigation.png` });
});

// A touch that becomes a scroll ends in pointercancel in Chromium and grants
// no activation, though the browser still sees a touchEnd; a tap does.
test('a touch scroll does not arm a popup; a touch tap does', async ({ window, electronApp }) => {
  await gotoFixture(window, electronApp);

  await realTouch(electronApp, [
    [200, 280],
    [200, 240],
    [200, 180],
    [200, 120],
  ]);
  await expect.poll(() => evalInWebview(window, 'scrollY'), { timeout: 5_000 }).toBeGreaterThan(0);
  await scriptOpen(window, POPUP_A);
  await expect(icon(window)).toBeVisible();
  await expect(tabs(window)).toHaveCount(1);

  await realTouch(electronApp, []);
  await scriptOpen(window, POPUP_B);
  await expect(tabs(window)).toHaveCount(2);
  await expect.poll(() => guestUrls(electronApp), { timeout: 10_000 }).toContain(POPUP_B);
});
