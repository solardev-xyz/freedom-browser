// freedom://publish's text area: Cmd+Enter (macOS) / Ctrl+Enter (Windows,
// Linux) publishes like the Publish button (#720). Plain Enter still types a
// newline, an empty text area publishes nothing, and a second press while the
// first publish is still running does not start another.
//
// Driven by real key presses in the real page; only the main-process publish
// and readiness handlers are stubbed, so the test can hold a publish open.

const { test, expect } = require('./fixtures');

const REFERENCE = 'ab'.repeat(32);

async function openPublishPage(window, electronApp) {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://publish');
  await input.press('Enter');
  let page;
  await expect
    .poll(() => {
      page = electronApp.windows().find((p) => p.url().includes('/pages/publish.html'));
      return Boolean(page);
    })
    .toBe(true);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

// Readiness answers only once released, so a publish can be held in flight
// while the text area is still on screen. Every swarm:publish-data call is
// recorded.
async function stubPublish(electronApp, reference) {
  await electronApp.evaluate(({ ipcMain }, ref) => {
    const state = { calls: [], releases: [] };
    globalThis.__publishShortcut = state;
    ipcMain.removeHandler('swarm:setup-get-state');
    ipcMain.handle(
      'swarm:setup-get-state',
      () =>
        new Promise((resolve) => state.releases.push(() => resolve({ readiness: { ok: true } })))
    );
    ipcMain.removeHandler('swarm:publish-data');
    ipcMain.handle('swarm:publish-data', (_event, data) => {
      state.calls.push(data);
      return { success: true, reference: ref, bzzUrl: `bzz://${ref}/` };
    });
  }, reference);
}

const publishCalls = (electronApp) =>
  electronApp.evaluate(() => globalThis.__publishShortcut.calls);
const pendingReadiness = (electronApp) =>
  electronApp.evaluate(() => globalThis.__publishShortcut.releases.length);
const releaseReadiness = (electronApp) =>
  electronApp.evaluate(() => {
    const { releases } = globalThis.__publishShortcut;
    while (releases.length) releases.shift()();
  });

const CHORD = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter';
const OTHER = process.platform === 'darwin' ? 'Control+Enter' : 'Meta+Enter';

test.describe('freedom://publish text shortcut (#720)', () => {
  test('the shortcut publishes like the button, once, and plain Enter types a newline', async ({
    electronApp,
    window,
  }) => {
    await stubPublish(electronApp, REFERENCE);
    const page = await openPublishPage(window, electronApp);
    await page.click('#publish-text-btn');
    const area = page.locator('#publish-text-area');
    await expect(area).toBeFocused();

    // The button names the shortcut in its tooltip.
    await expect(page.locator('#publish-text-submit')).toHaveAttribute(
      'title',
      process.platform === 'darwin' ? 'Publish (⌘↩)' : 'Publish (Ctrl+Enter)'
    );

    // Empty: nothing starts.
    await area.press(CHORD);
    expect(await pendingReadiness(electronApp)).toBe(0);

    // Plain Enter, Shift+Enter and the other platform's chord edit the text.
    await area.pressSequentially('hello');
    await area.press('Enter');
    await area.pressSequentially('world');
    await area.press('Shift+Enter');
    await area.press(OTHER);
    await area.pressSequentially('!');
    expect(await pendingReadiness(electronApp)).toBe(0);
    const typed = await area.inputValue();
    expect(typed).toBe('hello\nworld\n!');

    // The shortcut starts a publish; pressing it again, or clicking Publish,
    // while that one is still running starts nothing more.
    await area.press(CHORD);
    await expect.poll(() => pendingReadiness(electronApp)).toBe(1);
    await area.press(CHORD);
    await page.click('#publish-text-submit');
    expect(await pendingReadiness(electronApp)).toBe(1);
    await expect(area).toHaveValue(typed);

    await releaseReadiness(electronApp);
    await expect(page.locator('#publish-result')).toBeVisible();
    await expect(page.locator('#publish-result-ref')).toHaveText(REFERENCE);
    expect(await publishCalls(electronApp)).toEqual([typed]);
    await page.screenshot({ path: test.info().outputPath('published.png') });

    // Once it has finished, the next text publishes again.
    await page.click('#publish-another');
    await page.click('#publish-text-btn');
    await area.fill('second');
    await area.press(CHORD);
    await expect.poll(() => pendingReadiness(electronApp)).toBe(1);
    await releaseReadiness(electronApp);
    await expect(page.locator('#publish-result')).toBeVisible();
    expect(await publishCalls(electronApp)).toEqual([typed, 'second']);
  });
});
