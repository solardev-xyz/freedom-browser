// External protocol links (#406): a magnet:/mailto: link on a page raises the
// site-permission prompt, Allow hands the URL to the OS handler, Block does
// nothing, a remembered decision is honoured, a page cannot launch anything
// without a user gesture, and a URL typed into the address bar reaches its
// handler instead of the search provider.
//
// Launches are recorded by the test harness instead of reaching the OS
// (src/main/test-harness.js, `__FREEDOM_TEST_EXTERNAL_PROTOCOL__`); everything
// between the click and that call is the real path: Chromium's `openExternal`
// permission request, the session handler in permissions-manager.js and the
// renderer's anchored prompt.

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');
const { evalInWebview, answerPrompt } = require('./permission-fixtures');

const FIXTURE_URL = `bzz://${SAMPLE_BZZ_HASH}`;
const MAGNET = 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=freedom';
const MAILTO = 'mailto:someone@example.com?subject=hello';

const FIXTURE_BODY = [
  '<!doctype html><title>external protocol fixture</title>',
  '<style>a { display: block; font-size: 24px; margin: 16px; }</style>',
  `<a id="magnet" href="${MAGNET}">magnet link</a>`,
  `<a id="mailto" href="${MAILTO}">mailto link</a>`,
  `<a id="blank" target="_blank" rel="noopener noreferrer" href="${MAILTO}">mailto in a new tab</a>`,
  '<a id="msdt" href="ms-msdt:/id PCWDiagnostic">ms-msdt link</a>',
  '<div id="out">ready</div>',
].join('\n');

const opens = (electronApp) =>
  electronApp.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.externalOpens());

async function gotoFixture(window, electronApp) {
  await electronApp.evaluate(
    (_e, { url, body }) => globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture(url, { body }),
    { url: `${FIXTURE_URL}/`, body: FIXTURE_BODY }
  );
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(FIXTURE_URL);
  await input.press('Enter');
  await expect
    .poll(() => evalInWebview(window, "document.getElementById('out')?.textContent || null"), {
      message: 'Waiting for the external-protocol fixture to load',
      timeout: 10_000,
    })
    .toBe('ready');
}

// A real click on a link inside the guest: mouse events sent to the guest's
// own webContents, so Chromium sees user activation and the guest emits the
// `input-event`s the gesture check reads — a scripted `.click()` would not.
async function clickLink(window, electronApp, id) {
  const box = await evalInWebview(
    window,
    `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
      return { x: Math.round(r.left + 10), y: Math.round(r.top + r.height / 2) }; })()`
  );
  expect(box).not.toBeNull();
  await electronApp.evaluate(
    ({ webContents }, { x, y, prefix }) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith(prefix));
      if (!guest) throw new Error('fixture guest not found');
      guest.sendInputEvent({ type: 'mouseMove', x, y });
      guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    },
    { ...box, prefix: FIXTURE_URL }
  );
}

test('magnet: link → prompt → Allow opens it; a remembered allow opens without asking', async ({
  window,
  electronApp,
}) => {
  await gotoFixture(window, electronApp);
  const prompt = window.locator('[data-test="permission-prompt"]');

  await clickLink(window, electronApp, 'magnet');
  await expect(prompt).toBeVisible();
  await expect(window.locator('[data-test="permission-prompt-origin"]')).toHaveText(FIXTURE_URL);
  await expect(window.locator('#permission-prompt-action')).toHaveText(
    ' wants to open magnet: links in another app'
  );
  await window.screenshot({ path: '/tmp/ext-406-magnet-prompt.png' });
  expect(await opens(electronApp)).toEqual([]);

  await answerPrompt(window, 'allow');
  await expect(prompt).toBeHidden();
  await expect.poll(() => opens(electronApp), { timeout: 5_000 }).toEqual([MAGNET]);

  // The page never navigated away.
  expect(await evalInWebview(window, "document.getElementById('out').textContent")).toBe('ready');

  // Remembered (the checkbox defaults on): the next click opens silently.
  await clickLink(window, electronApp, 'magnet');
  await expect.poll(() => opens(electronApp), { timeout: 5_000 }).toEqual([MAGNET, MAGNET]);
  await expect(prompt).toBeHidden();

  // …and an allow for magnet: is not an allow for mailto:.
  await clickLink(window, electronApp, 'mailto');
  await expect(prompt).toBeVisible();
  await expect(window.locator('#permission-prompt-action')).toHaveText(
    ' wants to open mailto: links in another app'
  );
});

test('mailto: link → Block opens nothing, and the remembered block stays silent', async ({
  window,
  electronApp,
}) => {
  await gotoFixture(window, electronApp);
  const prompt = window.locator('[data-test="permission-prompt"]');

  await clickLink(window, electronApp, 'mailto');
  await expect(prompt).toBeVisible();
  await answerPrompt(window, 'block');
  await expect(prompt).toBeHidden();

  await clickLink(window, electronApp, 'mailto');
  // Give a wrongly-raised prompt time to appear before asserting it did not.
  await window.waitForTimeout(750);
  await expect(prompt).toBeHidden();
  expect(await opens(electronApp)).toEqual([]);
});

test('target="_blank" mailto: goes through the same prompt, not a new tab', async ({
  window,
  electronApp,
}) => {
  await gotoFixture(window, electronApp);
  const tabsBefore = await window.locator('webview').count();
  const prompt = window.locator('[data-test="permission-prompt"]');

  await clickLink(window, electronApp, 'blank');
  await expect(prompt).toBeVisible();
  await answerPrompt(window, 'allow');
  await expect.poll(() => opens(electronApp), { timeout: 5_000 }).toEqual([MAILTO]);
  expect(await window.locator('webview').count()).toBe(tabsBefore);
});

test('no prompt and no launch without a user gesture, or for a blocked scheme', async ({
  window,
  electronApp,
}) => {
  await gotoFixture(window, electronApp);
  const prompt = window.locator('[data-test="permission-prompt"]');

  // Scripted: what a page does on load.
  await evalInWebview(window, "location.href = 'mailto:auto@example.com'; true");
  await evalInWebview(window, "document.getElementById('magnet').click(); true");
  // Blocked scheme, clicked for real.
  await clickLink(window, electronApp, 'msdt');

  await window.waitForTimeout(750);
  await expect(prompt).toBeHidden();
  expect(await opens(electronApp)).toEqual([]);
});

test('a magnet: URL typed into the address bar opens in its handler instead of searching', async ({
  window,
  electronApp,
}) => {
  await gotoFixture(window, electronApp);
  await electronApp.evaluate(() =>
    globalThis.__FREEDOM_TEST_HARNESS__.setExternalHandler('magnet', 'Transmission')
  );

  const input = window.locator('[data-test="address-input"]');
  // No handler registered for mailto: here — main declines and nothing opens.
  await input.click();
  await input.fill(MAILTO);
  await input.press('Enter');
  await window.waitForTimeout(500);
  expect(await opens(electronApp)).toEqual([]);

  await input.click();
  await input.fill(MAGNET);
  await input.press('Enter');

  await expect.poll(() => opens(electronApp), { timeout: 5_000 }).toEqual([MAGNET]);
  // No prompt (the user typed it), the page stays, and the bar reverts to it.
  await expect(window.locator('[data-test="permission-prompt"]')).toBeHidden();
  expect(await evalInWebview(window, "document.getElementById('out').textContent")).toBe('ready');
  await expect(input).toHaveValue(new RegExp(`^${FIXTURE_URL}/?$`));

  // A page link to the same scheme still asks, and names the handler.
  await clickLink(window, electronApp, 'magnet');
  await expect(window.locator('#permission-prompt-action')).toHaveText(
    ' wants to open magnet: links in Transmission'
  );
  await window.screenshot({ path: '/tmp/ext-406-magnet-prompt-app.png' });
});
