// An `.onion` address in a normal window while Tor isn't running (#1248).
// Checked in the running app:
//
//   - the session's `.onion` request doesn't go out: the gate holds it back,
//     and the tab shows the error page's Tor notice with the address still in
//     the address bar;
//   - a page that sends the tab to an `.onion` address doesn't start Tor or
//     turn it on: the notice asks;
//   - the notice's Start Tor button, and an `.onion` address typed into the
//     address bar, turn Tor on in Settings and start it, and the tab waits.
//
// The harness records those starts instead of spawning Arti, so Tor stays not
// running here; test-e2e/live/tor-onion.spec.js opens a real onion
// service once Tor is up.

const { test, expect } = require('./fixtures');

const ONION = `http://freedomonionprobe${'a'.repeat(39)}.onion/`;

// The normal window's tab: the guest webContents whose host is not a private
// or Tor window.
const normalGuest = (electronApp, script) =>
  electronApp.evaluate(async ({ webContents }, code) => {
    const guest = webContents
      .getAllWebContents()
      .find(
        (wc) => wc.getType() === 'webview' && !wc.hostWebContents?.getURL().includes('Partition')
      );
    if (!guest) return { missing: true };
    return new Function('guest', `return (async () => { ${code} })();`)(guest);
  }, script);

async function navigateTo(page, value) {
  const input = page.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(value);
  await input.press('Enter');
}

const torStarts = (electronApp) =>
  electronApp.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.torWindowStarts());
const torSetting = async (window) =>
  (await window.evaluate(() => window.electronAPI.getSettings())).enableTorIntegration === true;
const tabUrl = (electronApp) => normalGuest(electronApp, 'return guest.getURL();');
const tabTitle = (electronApp) => normalGuest(electronApp, 'return guest.getTitle();');

test('an .onion address waits for Tor, and only the user turns Tor on', async ({
  electronApp,
  window,
}) => {
  await expect
    .poll(() => electronApp.evaluate(() => Boolean(globalThis.__FREEDOM_TEST_HARNESS__)))
    .toBe(true);
  await electronApp.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.recordTorWindowStarts());
  expect(await torSetting(window)).toBe(false);

  // A page sends the tab to an .onion address: held back, nothing started.
  await navigateTo(window, 'https://example.com/');
  await expect.poll(() => tabUrl(electronApp)).toBe('https://example.com/');
  await normalGuest(
    electronApp,
    `guest.executeJavaScript(${JSON.stringify(`location.href = ${JSON.stringify(ONION)}`)}); return true;`
  );
  await expect
    .poll(() => tabUrl(electronApp))
    .toMatch(/\/pages\/error\.html\?error=tor_off&url=http%3A%2F%2Ffreedomonionprobe/);
  await expect(window.locator('[data-test="address-input"]')).toHaveValue(ONION);
  await expect.poll(() => tabTitle(electronApp)).toBe('This site needs Tor');
  expect(await torStarts(electronApp)).toBe(0);
  expect(await torSetting(window)).toBe(false);

  // A typed clearnet address the server redirects to an .onion address: held
  // back on the redirect's target, nothing started, the notice asks.
  const redirected = `http://freedomonionprobe${'c'.repeat(39)}.onion/`;
  await electronApp.evaluate(
    (_electron, location) =>
      globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture('https://redirect.example/', {
        status: 302,
        headers: { Location: location },
      }),
    redirected
  );
  await navigateTo(window, 'https://redirect.example/');
  await expect
    .poll(() => tabUrl(electronApp))
    .toMatch(/\/pages\/error\.html\?error=tor_off&url=http%3A%2F%2Ffreedomonionprobec/);
  await expect(window.locator('[data-test="address-input"]')).toHaveValue(redirected);
  expect(await torStarts(electronApp)).toBe(0);
  expect(await torSetting(window)).toBe(false);

  // The notice's Start Tor button turns Tor on and starts it; the tab waits.
  await normalGuest(
    electronApp,
    'return guest.executeJavaScript("document.getElementById(\'start-tor-btn\').click(); true");'
  );
  await expect.poll(() => torSetting(window)).toBe(true);
  await expect.poll(() => torStarts(electronApp)).toBeGreaterThan(0);
  await expect.poll(() => tabTitle(electronApp)).toBe('Waiting for Tor');

  // Typed into the address bar with Tor off: the chrome turns it on and starts
  // it, and the tab waits on the notice for that address.
  await window.evaluate(() => window.electronAPI.saveSettings({ enableTorIntegration: false }));
  await expect.poll(() => torSetting(window)).toBe(false);
  const before = await torStarts(electronApp);
  const typed = `http://freedomonionprobe${'b'.repeat(39)}.onion/`;
  await navigateTo(window, typed);
  await expect.poll(() => torSetting(window)).toBe(true);
  await expect.poll(() => torStarts(electronApp)).toBeGreaterThan(before);
  await expect
    .poll(() => tabUrl(electronApp))
    .toMatch(/\/pages\/error\.html\?error=tor_starting&url=http%3A%2F%2Ffreedomonionprobe/);
  await expect(window.locator('[data-test="address-input"]')).toHaveValue(typed);
  await expect.poll(() => tabTitle(electronApp)).toBe('Waiting for Tor');

  // With Tor on, a page's .onion link starts it too, without asking.
  const afterTyped = await torStarts(electronApp);
  await navigateTo(window, 'https://example.com/');
  await expect.poll(() => tabUrl(electronApp)).toBe('https://example.com/');
  await normalGuest(
    electronApp,
    `guest.executeJavaScript(${JSON.stringify(`location.href = ${JSON.stringify(ONION)}`)}); return true;`
  );
  await expect
    .poll(() => tabUrl(electronApp))
    .toMatch(/\/pages\/error\.html\?error=tor_starting&url=http%3A%2F%2Ffreedomonionprobe/);
  await expect.poll(() => torStarts(electronApp)).toBeGreaterThan(afterTyped);
});
