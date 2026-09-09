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

  // #284: one rule for which removals are destructive. "Remove site" discards
  // every decision for an origin and cannot be undone here, so it is red;
  // the per-permission "Remove" beneath it is one prompt away from coming
  // back, so it is plain. Before this they were the other way round from
  // "Remove all", inside the same card.
  expect(
    await evalInWebview(
      window,
      `[...document.querySelectorAll('#permissions-view button[data-action]')]
        .map((btn) => ({ action: btn.dataset.action, cls: btn.className, label: btn.textContent.trim() }))`
    )
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: 'revoke-origin', cls: 'btn danger', label: 'Remove site' }),
      expect.objectContaining({ action: 'revoke', cls: 'btn', label: 'Remove' }),
    ])
  );

  // #272: the section-level action sits next to the `<h2>`, outside the
  // rendered list — so it is one button across every render, and it is the
  // heading's own row that centres it.
  expect(
    await evalInWebview(
      window,
      `(() => {
        const button = document.getElementById('permissions-revoke-all');
        const header = button.closest('.section-header');
        const title = header?.querySelector('h2.section-title');
        return {
          insideView: !!document.getElementById('permissions-view').contains(button),
          beside: header?.contains(title) === true,
          disabled: button.disabled,
          centred:
            Math.abs(
              (button.getBoundingClientRect().top + button.getBoundingClientRect().bottom) / 2 -
                (title.getBoundingClientRect().top + title.getBoundingClientRect().bottom) / 2
            ) < 2,
        };
      })()`
    )
  ).toEqual({ insideView: false, beside: true, disabled: false, centred: true });

  await evalInWebview(window, "document.getElementById('permissions-revoke-all').click(); true");
  await expect.poll(readView, { timeout: 5_000 }).toContain('No saved permissions');
  // The empty state is the only copy left, and the action it labels is off.
  const emptyState = (await readView()).replace(/\s+/g, ' ').trim();
  expect(emptyState).toBe(
    'No saved permissions Sites you allow or block with “Remember for this site” appear here.'
  );
  await expect
    .poll(() => evalInWebview(window, "document.getElementById('permissions-revoke-all').disabled"))
    .toBe(true);
});

// #272 sibling: the button moved out of `#permissions-view`, so a render it
// no longer contains cannot take it away. A read that fails after a
// successful one used to leave a live red "Remove all" beside the error
// card — offering to wipe state the page just said it cannot read.
test('a failed permissions re-read disables Remove all beside the error', async ({
  window,
  electronApp,
}) => {
  // One saved decision, then a read that throws — no fixture page needed.
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__permReadFails = false;
    ipcMain.removeHandler('permissions:get-all');
    ipcMain.handle('permissions:get-all', () => {
      if (globalThis.__permReadFails) throw new Error('permissions.json is unreadable');
      return { 'https://example.test': { notifications: 'allow' } };
    });
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://settings/permissions');
  await input.press('Enter');

  const revokeAllState = () =>
    evalInWebview(
      window,
      `(() => {
         const button = document.getElementById('permissions-revoke-all');
         if (!button) return null;
         return {
           disabled: button.disabled,
           view: document.getElementById('permissions-view').textContent.replace(/\\s+/g, ' ').trim(),
         };
       })()`
    );

  await expect
    .poll(revokeAllState, {
      message: 'Waiting for the saved decision to render',
      timeout: 10_000,
    })
    .toMatchObject({ disabled: false });

  // A re-sync into the section — the same path a hashchange takes.
  await electronApp.evaluate(() => {
    globalThis.__permReadFails = true;
  });
  await evalInWebview(
    window,
    "location.hash = '#appearance'; location.hash = '#permissions'; true"
  );

  await expect
    .poll(revokeAllState, { message: 'Waiting for the load-error card', timeout: 10_000 })
    .toMatchObject({ disabled: true });
  expect((await revokeAllState()).view).toContain('Could not load site permissions');
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

// #306, permission-prompt sibling: a modal <dialog> (here the bookmark
// editor) is the top layer — everything behind it, including a prompt the
// page raised in the meantime, is inert and un-answerable. So the prompt's
// Escape handler has to stand down while one is up: consuming the press
// (`preventDefault()`) cancels the dialog's own close request outright, so
// the editor stayed open AND the un-answerable prompt was dismissed as a
// deny-once, on a press the user aimed at the editor. Same for a click
// landing inside the dialog — it is not a click-away from the prompt.
test.describe('with the bookmarks bar pinned', () => {
  test.use({ seedSettings: { showBookmarkBar: true } });

  const editorState = (window) =>
    window.evaluate(() => ({
      dialogOpen: !!document.getElementById('add-bookmark-modal')?.open,
      promptShown: !!document.getElementById('permission-prompt')?.hidden === false,
    }));

  async function openBookmarkEditor(window) {
    await window.evaluate(async () => {
      for (const existing of await window.electronAPI.getBookmarks()) {
        await window.electronAPI.removeBookmark(existing.target);
      }
      await window.electronAPI.addBookmark({
        label: 'One',
        target: 'https://one.example/freedom-e2e',
      });
    });
    await window.reload();
    await window.waitForSelector('[data-test="address-input"]');
    await expect(window.locator('[data-test="bookmark-item"]')).toHaveCount(1);
  }

  test('a prompt raised behind the bookmark editor leaves the editor its Escape', async ({
    window,
    harness,
  }) => {
    await openBookmarkEditor(window);
    await navigateToFixture(window, harness);

    const prompt = window.locator('[data-test="permission-prompt"]');

    // Right-click a bookmark → Edit… puts the modal editor up.
    await window.locator('[data-test="bookmark-item"]').first().click({ button: 'right' });
    await window.locator('.context-menu-item[data-action="edit"]').click();
    await expect.poll(() => editorState(window)).toMatchObject({ dialogOpen: true });

    // The page asks for a permission while the editor is up — the prompt
    // renders behind the dialog's top layer, inert.
    await clickAsk(window);
    await expect.poll(() => editorState(window)).toMatchObject({ promptShown: true });

    // Typing in the editor's own fields must not click-away/deny it either.
    await window.locator('#bookmark-label').click();
    await window.waitForTimeout(300);
    expect(await readOut(window)).toBe('none');

    // One Escape: the editor closes, the prompt survives unanswered.
    await window.keyboard.press('Escape');
    await expect.poll(() => editorState(window)).toMatchObject({ dialogOpen: false });
    expect(await editorState(window)).toMatchObject({ promptShown: true });
    expect(await readOut(window)).toBe('none');

    // And now that it is the innermost surface, it is answerable again —
    // by Escape (deny-once) as well as by its buttons.
    await window.keyboard.press('Escape');
    await expect(prompt).toBeHidden();
    await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('denied');
  });
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
