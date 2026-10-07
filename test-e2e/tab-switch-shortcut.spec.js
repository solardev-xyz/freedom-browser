// Next Tab / Previous Tab must work on every press, not just the first (#556).
//
// A tab switch hands keyboard focus to the incoming tab's page (#304), so from
// the second press on the chord always starts in a guest. It used to reach the
// tab strip only by the guest declining the keydown and Chromium routing the
// unhandled event back to the application-menu accelerator — a route that on
// macOS let a rebound Cmd+Opt+Arrow switch exactly once. tab-switch-keys.js now
// claims the chord in the browser process (`before-input-event`), the way
// Chrome's PreHandleKeyboardEvent does, before any page sees it.
//
// Keys are delivered two ways, neither of them Playwright's `keyboard.press()`
// (that dispatches into the chrome renderer through CDP, where the chrome's own
// keydown fallback answers and the guest-focus path is never exercised):
//
//   - `webContents.sendInputEvent` on the focused tab page's own webContents,
//     from the main process. It enters at the same RenderWidgetHost the OS key
//     does, so `before-input-event` sees it, and runs on all three platforms.
//     A synthetic event carries no native OS event, so on macOS it can never
//     fall through to the native menu — exactly the route #556 says breaks —
//     which makes this the leg that pins the fix there.
//   - Real X11 key presses via xdotool on Linux, end to end through the OS.

const { execFileSync } = require('child_process');
const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');

const isMac = process.platform === 'darwin';
const PAGES = [`bzz://${SAMPLE_BZZ_HASH}/`, `bzz://${'b'.repeat(64)}/`, `bzz://${'c'.repeat(64)}/`];

// The #556 binding: Cmd+Opt+Arrow on macOS, its Ctrl+Alt twin elsewhere.
const CUSTOM = {
  'tab.next': isMac ? 'Cmd+Alt+Right' : 'Ctrl+Alt+Right',
  'tab.previous': isMac ? 'Cmd+Alt+Left' : 'Ctrl+Alt+Left',
};
const CUSTOM_MODIFIERS = isMac ? ['meta', 'alt'] : ['control', 'alt'];

const hasXdotool = (() => {
  try {
    execFileSync('xdotool', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const xdotool = (args) => execFileSync('xdotool', args, { encoding: 'utf-8' }).trim();

const activeTabId = (window) =>
  window.evaluate(() => document.querySelector('[data-test="tab"].active')?.dataset.tabId || null);

// Three tabs, each on a real page (not the new-tab page, where a switch
// focuses the address bar instead of the page), with tab 1 active and its page
// holding the keyboard — the state a user is in after clicking a tab.
async function openThreeTabs(window, harness, { pageScript = '' } = {}) {
  const input = window.locator('[data-test="address-input"]');
  for (let i = 0; i < PAGES.length; i++) {
    await harness.setContentFixture(PAGES[i], {
      body: `<!doctype html><title>Page ${i + 1}</title><p>page ${i + 1}</p>${pageScript}`,
    });
    if (i > 0) {
      await window.locator('[data-test="new-tab-btn"]').click();
      await expect(window.locator('[data-test="tab"]')).toHaveCount(i + 1);
    }
    await input.click();
    await input.fill(PAGES[i]);
    await input.press('Enter');
    await expect
      .poll(
        () =>
          window.evaluate(async () => {
            const wv = document.querySelector('webview:not(.hidden)');
            try {
              return await wv.executeJavaScript('document.title');
            } catch {
              return null;
            }
          }),
        { message: `Waiting for page ${i + 1} to load`, timeout: 15_000 }
      )
      .toBe(`Page ${i + 1}`);
  }
  await window.locator('[data-test="tab"][data-tab-id="1"]').click();
  await expect.poll(() => activeTabId(window)).toBe('1');
  await expectPageFocused(window);
}

const expectPageFocused = (window) =>
  expect
    .poll(() => window.evaluate(() => document.activeElement?.tagName), {
      message: 'Waiting for the active page to hold keyboard focus',
    })
    .toBe('WEBVIEW');

// Press a chord on the active tab's page from the main process: a key-down and
// key-up on the guest's own webContents.
async function pressOnActivePage(window, electronApp, keyCode, modifiers) {
  const guestId = await window.evaluate(() =>
    document.querySelector('webview:not(.hidden)').getWebContentsId()
  );
  await electronApp.evaluate(
    ({ webContents }, { id, keyCode: key, modifiers: mods }) => {
      const guest = webContents.fromId(id);
      guest.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods });
      guest.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods });
    },
    { id: guestId, keyCode, modifiers }
  );
}

// Press repeatedly, each time on whichever page the previous switch focused,
// and record where every press landed.
async function pressSequence(window, electronApp, presses) {
  const seen = [];
  for (const { keyCode, modifiers, expected } of presses) {
    await pressOnActivePage(window, electronApp, keyCode, modifiers);
    await expect
      .poll(() => activeTabId(window), { message: `Waiting for tab ${expected}` })
      .toBe(expected);
    await expectPageFocused(window);
    seen.push(await activeTabId(window));
  }
  return seen;
}

test.describe('a remapped Next/Previous Tab (#556)', () => {
  test.use({ seedSettings: { shortcutOverrides: CUSTOM } });

  test('switches on every press from the focused page, in both directions', async ({
    window,
    electronApp,
    harness,
  }) => {
    await openThreeTabs(window, harness);
    const next = { keyCode: 'Right', modifiers: CUSTOM_MODIFIERS };
    const prev = { keyCode: 'Left', modifiers: CUSTOM_MODIFIERS };
    const seen = await pressSequence(window, electronApp, [
      { ...next, expected: '2' },
      { ...next, expected: '3' },
      { ...next, expected: '1' },
      { ...prev, expected: '3' },
      { ...prev, expected: '2' },
    ]);
    expect(seen).toEqual(['2', '3', '1', '3', '2']);
  });

  test('switches on every real X11 key press (Linux)', async ({ window, electronApp, harness }) => {
    test.skip(process.platform !== 'linux', 'X11 key injection is Linux-only');
    test.skip(!process.env.DISPLAY, 'needs an X display — run under xvfb-run');
    test.skip(!hasXdotool, 'xdotool is not installed (CI installs it for this spec)');

    await openThreeTabs(window, harness);

    const pid = electronApp.process().pid;
    let target = null;
    await expect
      .poll(
        () => {
          try {
            const ids = xdotool(['search', '--onlyvisible', '--pid', String(pid)])
              .split('\n')
              .filter(Boolean);
            target = ids.find((id) => {
              try {
                return Boolean(xdotool(['getwindowname', id]));
              } catch {
                return false;
              }
            });
          } catch {
            target = null;
          }
          return Boolean(target);
        },
        { message: `Waiting for an X window owned by the app (pid ${pid})`, timeout: 15_000 }
      )
      .toBe(true);
    // No window manager under xvfb, so set the input focus directly.
    xdotool(['windowfocus', '--sync', target]);
    await expect
      .poll(() =>
        electronApp.evaluate(({ BrowserWindow }) => Boolean(BrowserWindow.getFocusedWindow()))
      )
      .toBe(true);

    for (const [key, expected] of [
      ['ctrl+alt+Right', '2'],
      ['ctrl+alt+Right', '3'],
      ['ctrl+alt+Right', '1'],
      ['ctrl+alt+Left', '3'],
      // The fixed aliases stay live next to a remap; Ctrl+Tab from a focused
      // page never reached the menu accelerator at all before the fix.
      ['ctrl+Tab', '1'],
      ['ctrl+Tab', '2'],
      ['ctrl+shift+Tab', '1'],
    ]) {
      xdotool(['key', '--clearmodifiers', key]);
      await expect
        .poll(() => activeTabId(window), { message: `Waiting for tab ${expected} after ${key}` })
        .toBe(expected);
      await expectPageFocused(window);
    }
  });
});

test('the default bindings and aliases switch on every press from the focused page', async ({
  window,
  electronApp,
  harness,
}) => {
  await openThreeTabs(window, harness);
  const seen = await pressSequence(window, electronApp, [
    { keyCode: 'PageDown', modifiers: ['control'], expected: '2' },
    { keyCode: 'PageDown', modifiers: ['control'], expected: '3' },
    { keyCode: 'Tab', modifiers: ['control'], expected: '1' },
    { keyCode: 'PageUp', modifiers: ['control'], expected: '3' },
    { keyCode: 'Tab', modifiers: ['control', 'shift'], expected: '2' },
  ]);
  expect(seen).toEqual(['2', '3', '1', '3', '2']);
});

// Chrome keeps tab switching out of the page's reach; so does Freedom now. A
// page that cancels every keydown used to keep the key from ever reaching the
// menu accelerator.
test('a page that cancels every keydown cannot hold the user on its tab', async ({
  window,
  electronApp,
  harness,
}) => {
  await openThreeTabs(window, harness, {
    pageScript: '<script>addEventListener("keydown", (e) => e.preventDefault(), true);</script>',
  });
  await pressSequence(window, electronApp, [
    { keyCode: 'PageDown', modifiers: ['control'], expected: '2' },
    { keyCode: 'PageDown', modifiers: ['control'], expected: '3' },
  ]);
});

// Settings > Shortcuts has to *receive* the chord it records — swapping Next
// and Previous means recording the chord that is live on the other row — so
// main lets it through while a recording is armed, and only then.
test('a Shortcuts recording captures the live Next Tab chord instead of switching', async ({
  window,
  electronApp,
  harness,
}) => {
  await harness.setContentFixture(PAGES[1], {
    body: '<!doctype html><title>Page 2</title><p>page 2</p>',
  });
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://settings/shortcuts');
  await input.press('Enter');

  const inSettings = (code) =>
    window.evaluate(async (script) => {
      const wv = document.querySelector('webview:not(.hidden)');
      try {
        return await wv.executeJavaScript(script);
      } catch {
        return null;
      }
    }, code);
  await expect
    .poll(() => inSettings(`!!document.querySelector('[data-shortcut-id="tab.moveRight"]')`), {
      message: 'Waiting for the Shortcuts settings list to render',
      timeout: 15_000,
    })
    .toBe(true);

  // A second tab, so a stray switch is observable.
  await window.locator('[data-test="new-tab-btn"]').click();
  await input.click();
  await input.fill(PAGES[1]);
  await input.press('Enter');
  await window.locator('[data-test="tab"][data-tab-id="1"]').click();
  await expect.poll(() => activeTabId(window)).toBe('1');
  await expect
    .poll(() => inSettings(`!!document.querySelector('[data-shortcut-id="tab.moveRight"]')`))
    .toBe(true);

  // Arm a recording on Move Tab Right and press Next Tab's live chord.
  expect(
    await inSettings(`(() => {
      const btn = document.querySelector('[data-shortcut-id="tab.moveRight"] [data-action="record"]');
      if (!btn) return false;
      btn.focus();
      btn.click();
      return true;
    })()`)
  ).toBe(true);
  // The arm is an IPC round trip; the next press must not race it.
  await window.waitForTimeout(300);
  await pressOnActivePage(window, electronApp, 'PageDown', ['control']);

  // The recorder got it — Next Tab already owns the chord, so it offers the
  // conflict — and the tab did not change.
  await expect
    .poll(() => inSettings(`!!document.querySelector('.shortcut-conflict')`), {
      message: 'Waiting for the recorder to report the conflict',
    })
    .toBe(true);
  expect(await activeTabId(window)).toBe('1');

  // Recording over: the same chord switches tabs again.
  expect(
    await inSettings(`(() => {
      const btn = document.querySelector('[data-action="cancel-conflict"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`)
  ).toBe(true);
  await window.waitForTimeout(300);
  await pressOnActivePage(window, electronApp, 'PageDown', ['control']);
  await expect.poll(() => activeTabId(window)).toBe('2');
});
