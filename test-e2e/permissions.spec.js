// Site permission prompts — a page requests notification permission, the
// chrome shows the anchored prompt, and the decision matrix behaves:
// Allow + remember persists across reload (permissions.json), Block is
// honored silently on re-request, and Esc dismisses as a deny-once.
//
// Driven against the harness's stubbed bzz:// protocol so no network is
// involved; notification requests inside the webview flow through the real
// session permission handlers in src/main/permissions/permissions-manager.js.

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');
// The fixture pages and the helpers that drive them are shared with
// test-e2e/packaged/permissions.spec.js, which re-checks #361/#364 against a
// release artifact — see that file's header.
const {
  FIXTURE_BODY,
  GATED_FIXTURE_BODY,
  evalInWebview,
  readOut,
  clickAsk,
  answerPrompt,
  gotoPermissionFixture,
} = require('./permission-fixtures');

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

async function navigateToFixture(window, harness, body = FIXTURE_BODY) {
  await harness.setContentFixture(`bzz://${SAMPLE_BZZ_HASH}/`, { body });
  await gotoPermissionFixture(window);
}

// Open a private window via the real File-menu item and return its chrome
// page. Resolved by URL rather than via electronApp.waitForEvent('window'):
// webview guests surface as separate Playwright pages too, so the first
// 'window' event after the click can be the private start page's guest.
// (Same shape as test-e2e/private-windows.spec.js, which owns the feature.)
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

const resetOut = (page) =>
  evalInWebview(page, "document.getElementById('out').textContent = 'none'; true");

// Three prompts, three Escapes — the embargo (#364), driven in one window.
// Each dismissal is still a deny-once; the third records the run-scoped deny.
async function dismissThrice(page) {
  const prompt = page.locator('[data-test="permission-prompt"]');
  for (let i = 0; i < 3; i += 1) {
    await resetOut(page);
    await clickAsk(page);
    await expect(prompt).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(prompt).toBeHidden();
    await expect.poll(() => readOut(page), { timeout: 5_000 }).toBe('denied');
  }
}

// close() is asynchronous, so getAllWindows() still lists windows that are
// mid-teardown; reading webContents on one of those throws.
async function closePrivateWindows(electronApp) {
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      if (win.webContents.getURL().includes('privatePartition=private-')) win.close();
    }
  });
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

// #361 regression: the page consults navigator.permissions.query before it
// asks. An undecided permission must NOT read as "denied", or the page short-
// circuits and Freedom's prompt never fires. A recorded Block still reads as
// "denied" — that is what the boolean check handler is reserved for.
test('a page that gates on permissions.query still reaches the prompt, and Block still blocks it', async ({
  window,
  harness,
}) => {
  await navigateToFixture(window, harness, GATED_FIXTURE_BODY);

  const prompt = window.locator('[data-test="permission-prompt"]');
  // What the page's own gate last read…
  const readState = () =>
    evalInWebview(window, "document.getElementById('state')?.textContent || null");
  // …and a fresh read, for the state after a decision lands.
  const queryState = () =>
    evalInWebview(
      window,
      "navigator.permissions.query({ name: 'notifications' }).then((status) => status.state)"
    );

  // Before any decision: not "denied" (Electron cannot say "prompt", so the
  // undecided state reports as granted — either is fine, blocked is not).
  await expect.poll(readState, { timeout: 10_000 }).not.toBe('pending');
  expect(['granted', 'prompt']).toContain(await readState());
  expect(['granted', 'prompt']).toContain(await queryState());
  await expect(prompt).toBeHidden();

  // So the page goes on to ask, and Freedom's own anchored prompt appears.
  await clickAsk(window);
  await expect(prompt).toBeVisible();
  await expect(window.locator('[data-test="permission-prompt-origin"]')).toHaveText(
    `bzz://${SAMPLE_BZZ_HASH}`
  );

  // Block + remember: the page's own read now says denied.
  await expect(window.locator('[data-test="permission-remember"]')).toBeChecked();
  await answerPrompt(window, 'block');
  await expect(prompt).toBeHidden();
  await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('denied');
  await expect.poll(queryState, { timeout: 5_000 }).toBe('denied');
  await expect
    .poll(() => evalInWebview(window, 'Notification.permission'), { timeout: 5_000 })
    .toBe('denied');

  // …so the gate now short-circuits, and no prompt is raised.
  await evalInWebview(window, "document.getElementById('out').textContent = 'none'; true");
  await clickAsk(window);
  await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('blocked-without-asking');
  expect(await readState()).toBe('denied');
  await window.waitForTimeout(500);
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

// #364: dismissing is a deny-once, so a page can re-raise the prompt after
// every Escape and hold it up for as long as the tab is open. Chromium
// bounds that with an embargo after three dismissals; so does Freedom now.
// The two dismissals above stay a re-askable deny-once — this picks up at
// the third.
test('three dismissals embargo the site, and Remove from the popover lets it ask again', async ({
  window,
  harness,
}) => {
  await navigateToFixture(window, harness);

  const prompt = window.locator('[data-test="permission-prompt"]');
  const indicator = window.locator('[data-test="permission-indicator"]');

  // Three prompts, three Escapes. Each one is still a deny-once: the page
  // is told "denied" and is asked nothing — it just asks again.
  await dismissThrice(window);

  // The fourth request is auto-denied: no prompt at all, and the page's own
  // read of Notification.permission now says denied.
  await resetOut(window);
  await clickAsk(window);
  await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('denied');
  await window.waitForTimeout(500);
  await expect(prompt).toBeHidden();
  await expect
    .poll(() => evalInWebview(window, 'Notification.permission'), { timeout: 5_000 })
    .toBe('denied');

  // The embargo is visible in the chrome — an auto-block the user never
  // chose has to be discoverable, and the popover is where it is lifted.
  await expect(indicator).toBeVisible();
  await indicator.click();
  await expect(window.locator('#permission-popover')).toBeVisible();
  await expect(window.locator('.permission-popover-row-status')).toHaveText(
    'Blocked after repeated dismissals (this session)'
  );

  // Remove → the site can ask again, and the prompt comes back.
  await window.locator('.permission-popover-revoke').dispatchEvent('click');
  await expect(indicator).toBeHidden();
  await expect
    .poll(() => evalInWebview(window, 'Notification.permission'), { timeout: 5_000 })
    .toBe('granted');

  await resetOut(window);
  await clickAsk(window);
  await expect(prompt).toBeVisible();
});

// The embargo is a run-scoped decision, so it belongs to the window that
// made it: a normal window's embargo does not apply inside a private window
// (which reads its own partition tier), and a private window's own embargo
// applies nowhere else. The chrome has to say the same thing, in both
// directions — an indicator for a block that is not in force is a lie whose
// Remove clears the *other* scope's decision, and an in-force block with no
// indicator cannot be discovered or lifted at all.
test('the embargo, and its indicator, are scoped to the window that made it', async ({
  window,
  electronApp,
  harness,
}) => {
  await navigateToFixture(window, harness);
  await dismissThrice(window);
  await expect(window.locator('[data-test="permission-indicator"]')).toBeVisible();

  const priv = await openPrivateWindow(electronApp);
  await navigateToFixture(priv, harness);

  // The private window is not embargoed — the site still prompts there — so
  // its chrome shows nothing.
  await expect(priv.locator('[data-test="permission-indicator"]')).toBeHidden();
  const privPrompt = priv.locator('[data-test="permission-prompt"]');
  await clickAsk(priv);
  await expect(privPrompt).toBeVisible();
  await priv.keyboard.press('Escape');
  await expect(privPrompt).toBeHidden();

  // Two more dismissals embargo it inside the private window, and THERE the
  // indicator and its popover row appear.
  await resetOut(priv);
  await clickAsk(priv);
  await expect(privPrompt).toBeVisible();
  await priv.keyboard.press('Escape');
  await expect(privPrompt).toBeHidden();
  await resetOut(priv);
  await clickAsk(priv);
  await expect(privPrompt).toBeVisible();
  await priv.keyboard.press('Escape');
  await expect(privPrompt).toBeHidden();

  await resetOut(priv);
  await clickAsk(priv);
  await expect.poll(() => readOut(priv), { timeout: 5_000 }).toBe('denied');
  await priv.waitForTimeout(500);
  await expect(privPrompt).toBeHidden();

  const privIndicator = priv.locator('[data-test="permission-indicator"]');
  await expect(privIndicator).toBeVisible();
  await privIndicator.click();
  await expect(priv.locator('#permission-popover')).toBeVisible();
  await expect(priv.locator('.permission-popover-row-status')).toHaveText(
    'Blocked after repeated dismissals (this session)'
  );

  await closePrivateWindows(electronApp);
});

// #366: the popover's Remove lifts what that window listed, and nothing else.
// The revoke used to be scope-blind, so a Remove clicked inside a private
// window also cleared the normal profile's run-scoped decision for the same
// origin + key — the normal window's embargo simply disappeared, with no
// trace in the window the user was looking at — and a Remove in a normal
// window reached into every live private partition the same way.
test("the popover's Remove lifts only the asking window's decision", async ({
  window,
  electronApp,
  harness,
}) => {
  const indicator = window.locator('[data-test="permission-indicator"]');
  const prompt = window.locator('[data-test="permission-prompt"]');

  // Embargoed in a normal window…
  await navigateToFixture(window, harness);
  await dismissThrice(window);
  await expect(indicator).toBeVisible();

  // …and, independently, in a private one.
  const priv = await openPrivateWindow(electronApp);
  await navigateToFixture(priv, harness);
  await dismissThrice(priv);
  const privIndicator = priv.locator('[data-test="permission-indicator"]');
  const privPrompt = priv.locator('[data-test="permission-prompt"]');
  await expect(privIndicator).toBeVisible();

  // Remove in the PRIVATE window lifts the private embargo…
  await privIndicator.click();
  await expect(priv.locator('#permission-popover')).toBeVisible();
  await priv.locator('.permission-popover-revoke').dispatchEvent('click');
  await expect(privIndicator).toBeHidden();
  await resetOut(priv);
  await clickAsk(priv);
  await expect(privPrompt).toBeVisible();

  // …and leaves the normal window exactly as it was: the indicator is still
  // there, the popover still says why, and the site is still auto-denied
  // without a prompt. This is the regression #366 is about.
  await expect(indicator).toBeVisible();
  await indicator.click();
  await expect(window.locator('#permission-popover')).toBeVisible();
  await expect(window.locator('.permission-popover-row-status')).toHaveText(
    'Blocked after repeated dismissals (this session)'
  );
  await window.keyboard.press('Escape');
  await resetOut(window);
  await clickAsk(window);
  await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('denied');
  await window.waitForTimeout(500);
  await expect(prompt).toBeHidden();

  // Now the other direction, with a live private grant: Allow the prompt the
  // private window just got back.
  await priv.locator('[data-test="permission-allow"]').dispatchEvent('click');
  await expect(privPrompt).toBeHidden();
  await expect.poll(() => readOut(priv), { timeout: 5_000 }).toBe('granted');
  await expect(privIndicator).toBeVisible();

  // Remove in the NORMAL window lifts its own embargo — the site prompts
  // there again…
  await indicator.click();
  await expect(window.locator('#permission-popover')).toBeVisible();
  await window.locator('.permission-popover-revoke').dispatchEvent('click');
  await expect(indicator).toBeHidden();
  await resetOut(window);
  await clickAsk(window);
  await expect(prompt).toBeVisible();
  await window.keyboard.press('Escape');

  // …while the private window keeps its grant: indicator, popover row, and a
  // silent grant on the next ask (a private decision is never persisted, so
  // it reads as a session one).
  await expect(privIndicator).toBeVisible();
  await privIndicator.click();
  await expect(priv.locator('#permission-popover')).toBeVisible();
  await expect(priv.locator('.permission-popover-row-status')).toHaveText('Allowed (this session)');
  await priv.keyboard.press('Escape');
  await resetOut(priv);
  await clickAsk(priv);
  await expect.poll(() => readOut(priv), { timeout: 5_000 }).toBe('granted');
  await expect(privPrompt).toBeHidden();

  await closePrivateWindows(electronApp);
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
