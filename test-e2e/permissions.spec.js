// Site permission prompts — a page requests notification permission, the
// chrome shows the anchored prompt, and the decision matrix behaves:
// Allow + remember persists across reload (permissions.json), Block is
// honored silently on re-request, and Esc dismisses as a deny-once.
//
// Driven against the harness's stubbed bzz:// protocol so no network is
// involved; notification requests inside the webview flow through the real
// session permission handlers in src/main/permissions/permissions-manager.js.

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');

const FIXTURE_BODY = [
  '<!doctype html><title>permission fixture</title>',
  '<button id="ask">ask</button><div id="out">none</div>',
  '<script>',
  "  document.getElementById('ask').addEventListener('click', () => {",
  '    Notification.requestPermission().then((result) => {',
  "      document.getElementById('out').textContent = result;",
  '    });',
  '  });',
  '</script>',
].join('\n');

// Run a script inside the active webview and return its result.
async function evalInWebview(window, script) {
  return window.evaluate(async (code) => {
    const wv = document.querySelector('webview:not(.hidden)');
    if (!wv || typeof wv.executeJavaScript !== 'function') return null;
    try {
      return await wv.executeJavaScript(code);
    } catch {
      return null;
    }
  }, script);
}

const readOut = (window) =>
  evalInWebview(window, "document.getElementById('out')?.textContent || null");

// Same as evalInWebview, but targets a webview by index so a spec can
// drive a BACKGROUND tab (whose webview carries `.hidden`).
async function evalInWebviewAt(window, index, script) {
  return window.evaluate(
    async ({ code, i }) => {
      const wv = document.querySelectorAll('webview')[i];
      if (!wv || typeof wv.executeJavaScript !== 'function') return null;
      try {
        return await wv.executeJavaScript(code);
      } catch {
        return null;
      }
    },
    { code: script, i: index }
  );
}

async function navigateToFixture(window, harness) {
  await harness.setContentFixture(`bzz://${SAMPLE_BZZ_HASH}/`, { body: FIXTURE_BODY });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(`bzz://${SAMPLE_BZZ_HASH}`);
  await input.press('Enter');

  await expect
    .poll(() => readOut(window), {
      message: 'Waiting for the permission fixture page to load',
      timeout: 10_000,
    })
    .toBe('none');
}

const clickAsk = (window) =>
  evalInWebview(window, "document.getElementById('ask').click(); true");

// Answer the prompt via a DOM click event instead of a synthesized mouse
// click. Right after the guest <webview> attaches (which is exactly when a
// page requests a permission), Chromium's browser-side input routing can
// still send pointer events at the prompt's coordinates into the guest
// surface instead of the chrome renderer, silently swallowing the click
// even though DOM hit-testing resolves the button. These specs verify the
// decision matrix, not compositor input routing, so deliver the click as
// a DOM event directly.
async function answerPrompt(window, action) {
  const button = window.locator(`[data-test="permission-${action}"]`);
  await expect(button).toBeVisible();
  await button.dispatchEvent('click');
}

test('notification request → prompt → Allow with remember persists across reload', async ({
  window,
  harness,
}) => {
  await navigateToFixture(window, harness);

  const prompt = window.locator('[data-test="permission-prompt"]');
  await expect(prompt).toBeHidden();

  await clickAsk(window);
  await expect(prompt).toBeVisible();

  // The prompt names the requesting origin and defaults to remembering.
  await expect(window.locator('[data-test="permission-prompt-origin"]')).toHaveText(
    `bzz://${SAMPLE_BZZ_HASH}`
  );
  await expect(window.locator('[data-test="permission-remember"]')).toBeChecked();

  await answerPrompt(window, 'allow');
  await expect(prompt).toBeHidden();
  await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('granted');

  // Granted permissions surface the address-bar indicator.
  await expect(window.locator('[data-test="permission-indicator"]')).toBeVisible();

  // Reload the page: the remembered decision applies without a prompt —
  // Notification.permission reports granted via the check handler.
  await window.locator('#reload-btn').click();
  await expect
    .poll(() => readOut(window), {
      message: 'Waiting for the fixture to reload',
      timeout: 10_000,
    })
    .toBe('none');

  await expect
    .poll(() => evalInWebview(window, 'Notification.permission'), { timeout: 5_000 })
    .toBe('granted');
  await expect(prompt).toBeHidden();

  // And a fresh request is granted silently.
  await clickAsk(window);
  await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('granted');
  await expect(prompt).toBeHidden();
});

test('Block with remember denies silently on the next request', async ({ window, harness }) => {
  await navigateToFixture(window, harness);

  const prompt = window.locator('[data-test="permission-prompt"]');
  await clickAsk(window);
  await expect(prompt).toBeVisible();

  await answerPrompt(window, 'block');
  await expect(prompt).toBeHidden();
  await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('denied');

  // Re-request: no prompt, denied from the stored decision.
  await evalInWebview(window, "document.getElementById('out').textContent = 'none'; true");
  await clickAsk(window);
  await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('denied');
  await expect(prompt).toBeHidden();
});

test('Settings > Site Permissions lists remembered decisions and revoke-all clears them', async ({
  window,
  harness,
}) => {
  await navigateToFixture(window, harness);
  await clickAsk(window);
  await answerPrompt(window, 'allow');
  await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('granted');

  // Land on the Site Permissions section of freedom://settings.
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://settings/permissions');
  await input.press('Enter');

  const readView = () =>
    evalInWebview(window, "document.querySelector('#permissions-view')?.textContent || null");

  await expect
    .poll(readView, {
      message: 'Waiting for the Site Permissions section to list the origin',
      timeout: 10_000,
    })
    .toContain(`bzz://${SAMPLE_BZZ_HASH}`);
  expect(await readView()).toContain('Notifications');

  await evalInWebview(
    window,
    "document.querySelector('#permissions-view button[data-action=\"revoke-all\"]').click(); true"
  );
  await expect
    .poll(readView, { timeout: 5_000 })
    .toContain('No stored site permissions');
});

test('Escape dismisses the prompt as deny-once and the site can ask again', async ({
  window,
  harness,
}) => {
  await navigateToFixture(window, harness);

  const prompt = window.locator('[data-test="permission-prompt"]');
  await clickAsk(window);
  await expect(prompt).toBeVisible();

  await window.keyboard.press('Escape');
  await expect(prompt).toBeHidden();
  await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('denied');

  // Nothing was remembered — the next request prompts again.
  await clickAsk(window);
  await expect(prompt).toBeVisible();
});

test('clicking a background tab surfaces its held prompt instead of dismissing it', async ({
  window,
  harness,
}) => {
  await navigateToFixture(window, harness);

  const prompt = window.locator('[data-test="permission-prompt"]');
  const fixtureTab = window.locator('[data-test="tab"][data-tab-id="1"]');

  // Push the fixture tab into the background.
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="tab"][data-tab-id="2"]')).toHaveClass(/active/);

  // The background page asks for notifications: the prompt is held, not
  // shown under the unrelated active tab.
  await evalInWebviewAt(window, 0, "document.getElementById('ask').click(); true");
  await window.waitForTimeout(500);
  await expect(prompt).toBeHidden();

  // Clicking the requesting tab in the strip surfaces the held prompt —
  // and that same click must not click-away/deny it.
  await fixtureTab.click();
  await expect(prompt).toBeVisible();
  await expect(window.locator('[data-test="permission-prompt-origin"]')).toHaveText(
    `bzz://${SAMPLE_BZZ_HASH}`
  );

  // The page is still waiting: no decision was delivered by the click.
  await window.waitForTimeout(500);
  expect(await readOut(window)).toBe('none');
  await expect(prompt).toBeVisible();

  // And the surfaced prompt is still answerable.
  await answerPrompt(window, 'allow');
  await expect(prompt).toBeHidden();
  await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('granted');
});
