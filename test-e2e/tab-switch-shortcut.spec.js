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
const hasSetxkbmap = (() => {
  try {
    execFileSync('setxkbmap', ['-query'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Give the app's X window the input focus (no window manager under xvfb).
async function focusAppWindow(electronApp) {
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
}

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

    await focusAppWindow(electronApp);

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

// Cmd/Ctrl+1…8 select a tab by position and Cmd/Ctrl+9 the last tab (#717),
// claimed in the browser process like Next/Previous, so they work from a
// focused page and leave the incoming page holding the keyboard.
const SELECT_MODIFIERS = [isMac ? 'meta' : 'control'];

test.describe('select tab by position (#717)', () => {
  test('Cmd/Ctrl+2 selects tab 2, +9 the last tab, +5 of three does nothing', async ({
    window,
    electronApp,
    harness,
  }) => {
    await openThreeTabs(window, harness);
    const seen = await pressSequence(window, electronApp, [
      { keyCode: '2', modifiers: SELECT_MODIFIERS, expected: '2' },
      { keyCode: '9', modifiers: SELECT_MODIFIERS, expected: '3' },
    ]);
    expect(seen).toEqual(['2', '3']);

    // Out of range: only three tabs. Nothing changes, and the page keeps the
    // keyboard.
    await pressOnActivePage(window, electronApp, '5', SELECT_MODIFIERS);
    // Then a real switch, so the out-of-range press provably went through
    // first and a late stray switch would show.
    await pressSequence(window, electronApp, [
      { keyCode: '1', modifiers: SELECT_MODIFIERS, expected: '1' },
    ]);
    await pressOnActivePage(window, electronApp, '5', SELECT_MODIFIERS);
    await window.waitForTimeout(300);
    expect(await activeTabId(window)).toBe('1');
    await expectPageFocused(window);
  });

  test('a page that cancels every keydown cannot block it', async ({
    window,
    electronApp,
    harness,
  }) => {
    await openThreeTabs(window, harness, {
      pageScript: '<script>addEventListener("keydown", (e) => e.preventDefault(), true);</script>',
    });
    await pressSequence(window, electronApp, [
      { keyCode: '3', modifiers: SELECT_MODIFIERS, expected: '3' },
      { keyCode: '2', modifiers: SELECT_MODIFIERS, expected: '2' },
    ]);
  });

  test('real X11 Ctrl+digit and Alt+digit presses select (Linux)', async ({
    window,
    electronApp,
    harness,
  }) => {
    test.skip(process.platform !== 'linux', 'X11 key injection is Linux-only');
    test.skip(!process.env.DISPLAY, 'needs an X display — run under xvfb-run');
    test.skip(!hasXdotool, 'xdotool is not installed (CI installs it for this spec)');

    await openThreeTabs(window, harness);
    await focusAppWindow(electronApp);

    for (const [key, expected] of [
      ['ctrl+2', '2'],
      ['ctrl+9', '3'],
      ['ctrl+5', '3'],
      ['ctrl+1', '1'],
      // Chrome on Linux also takes Alt+1…9.
      ['alt+3', '3'],
      ['alt+9', '3'],
      ['alt+2', '2'],
    ]) {
      xdotool(['key', '--clearmodifiers', key]);
      if (key === 'ctrl+5') await window.waitForTimeout(300);
      await expect
        .poll(() => activeTabId(window), { message: `Waiting for tab ${expected} after ${key}` })
        .toBe(expected);
      await expectPageFocused(window);
    }
  });

  // Layouts where a digit key types another shortcut's character. French
  // AZERTY's `6` key types `-`: Zoom Out's own binding, so that press zooms
  // out — from a focused page too, where Chromium reports the key to the menu
  // as VKEY_6 and the Ctrl+- accelerator never fires, so once the page has
  // declined it webview-preload.js reports it and tab-switch-keys.js sends the
  // zoom. Czech's `1` key types `+`, only Zoom In's `Plus` alias, so that
  // press stays Select Tab 1.
  test('real X11 presses on French and Czech layouts (Linux)', async ({
    window,
    electronApp,
    harness,
  }) => {
    test.skip(process.platform !== 'linux', 'X11 key injection is Linux-only');
    test.skip(!process.env.DISPLAY, 'needs an X display — run under xvfb-run');
    test.skip(!hasXdotool, 'xdotool is not installed (CI installs it for this spec)');
    test.skip(!hasSetxkbmap, 'setxkbmap is not installed (CI installs it for this spec)');

    await openThreeTabs(window, harness);
    await focusAppWindow(electronApp);
    const zoomFactor = () =>
      window.evaluate(() => document.querySelector('webview:not(.hidden)').getZoomFactor());

    try {
      execFileSync('setxkbmap', ['fr']);
      // The unshifted `6` key (keysym `minus` on fr), with the page focused.
      xdotool(['key', '--clearmodifiers', 'ctrl+minus']);
      await expect.poll(zoomFactor, { message: 'Waiting for Zoom Out' }).toBeCloseTo(0.9, 5);
      await window.waitForTimeout(300);
      expect(await zoomFactor()).toBeCloseTo(0.9, 5); // one press, one step
      expect(await activeTabId(window)).toBe('1');
      await expectPageFocused(window);
      // The other AZERTY digit keys still select: `é` is the `2` key.
      xdotool(['key', '--clearmodifiers', 'ctrl+eacute']);
      await expect.poll(() => activeTabId(window)).toBe('2');

      execFileSync('setxkbmap', ['cz']);
      // The unshifted `1` key (keysym `plus` on cz).
      xdotool(['key', '--clearmodifiers', 'ctrl+plus']);
      await expect.poll(() => activeTabId(window)).toBe('1');
      await window.waitForTimeout(300);
      // Tab 1 is still at the zoom it was left at: Zoom In did not fire too.
      expect(await zoomFactor()).toBeCloseTo(0.9, 5);
      await expectPageFocused(window);
    } finally {
      execFileSync('setxkbmap', ['us']);
    }
  });
});

// The AZERTY `6` press is Zoom Out's whether or not Select Tab 6 still sits on
// that key: Chromium hands the menu VKEY_6 either way, so the page-declined
// press is answered by tab-switch-keys.js all the same.
test.describe('AZERTY zoom out with Select Tab 6 remapped', () => {
  test.use({ seedSettings: { shortcutOverrides: { 'tab.select6': 'Ctrl+Shift+6' } } });

  test('real X11 Ctrl + the 6 key still zooms out from a focused page (Linux)', async ({
    window,
    electronApp,
    harness,
  }) => {
    test.skip(process.platform !== 'linux', 'X11 key injection is Linux-only');
    test.skip(!process.env.DISPLAY, 'needs an X display — run under xvfb-run');
    test.skip(!hasXdotool, 'xdotool is not installed (CI installs it for this spec)');
    test.skip(!hasSetxkbmap, 'setxkbmap is not installed (CI installs it for this spec)');

    await openThreeTabs(window, harness);
    await focusAppWindow(electronApp);
    const zoomFactor = () =>
      window.evaluate(() => document.querySelector('webview:not(.hidden)').getZoomFactor());

    try {
      execFileSync('setxkbmap', ['fr']);
      xdotool(['key', '--clearmodifiers', 'ctrl+minus']);
      await expect.poll(zoomFactor, { message: 'Waiting for Zoom Out' }).toBeCloseTo(0.9, 5);
      await window.waitForTimeout(300);
      expect(await zoomFactor()).toBeCloseTo(0.9, 5); // one press, one step
      expect(await activeTabId(window)).toBe('1');
      await expectPageFocused(window);
    } finally {
      execFileSync('setxkbmap', ['us']);
    }
  });
});

// Zoom, unlike tab switching, is the page's to override: on a US layout a
// page that cancels Ctrl+- / Ctrl+0 keeps it from zooming, and a digit-row
// zoom press on another layout must behave the same — reported to main only
// once the page has declined it, and never twice where the menu's own digit
// accelerator answers it (AZERTY `à` is the `0` key: VKEY_0, Ctrl+0).
test.describe('digit-row zoom presses on non-US layouts', () => {
  const CANCEL_CTRL =
    '<script>addEventListener("keydown", (e) => { if (window.cancelCtrl && e.ctrlKey) e.preventDefault(); }, true);</script>';
  const PRESSES = [
    // [layout, xdotool chord, zoom factor after the press from 1.2]
    ['fr', 'ctrl+minus', 1.1], // the `6` key: Zoom Out
    ['fr', 'ctrl+agrave', 1], // the `0` key: Actual Size, through the menu
    ['de', 'ctrl+shift+0', 1.3], // `=` is Shift+0: Zoom In's Shift+= alias
    ['us', 'ctrl+minus', 1.1],
  ];

  test('zoom once from a focused page, and a page that cancels the keydown keeps it (Linux)', async ({
    window,
    electronApp,
    harness,
  }) => {
    test.skip(process.platform !== 'linux', 'X11 key injection is Linux-only');
    test.skip(!process.env.DISPLAY, 'needs an X display — run under xvfb-run');
    test.skip(!hasXdotool, 'xdotool is not installed (CI installs it for this spec)');
    test.skip(!hasSetxkbmap, 'setxkbmap is not installed (CI installs it for this spec)');

    await openThreeTabs(window, harness, { pageScript: CANCEL_CTRL });
    await focusAppWindow(electronApp);
    const webview = () => 'document.querySelector("webview:not(.hidden)")';
    const zoomFactor = () => window.evaluate(`${webview()}.getZoomFactor()`);
    const setCancel = (on) =>
      window.evaluate(`${webview()}.executeJavaScript('window.cancelCtrl = ${on}')`);

    try {
      for (const cancel of [false, true]) {
        await setCancel(cancel);
        for (const [layout, chord, zoomed] of PRESSES) {
          await window.evaluate(`${webview()}.setZoomFactor(1.2)`);
          execFileSync('setxkbmap', [layout]);
          xdotool(['key', '--clearmodifiers', chord]);
          const expected = cancel ? 1.2 : zoomed;
          if (!cancel) {
            await expect
              .poll(zoomFactor, { message: `Waiting for ${layout} ${chord} to zoom` })
              .toBeCloseTo(expected, 5);
          }
          await window.waitForTimeout(400);
          // One press, one step — or none at all once the page cancelled it.
          expect(await zoomFactor(), `${layout} ${chord} cancel=${cancel}`).toBeCloseTo(
            expected,
            5
          );
          expect(await activeTabId(window)).toBe('1');
          await expectPageFocused(window);
        }
      }
    } finally {
      execFileSync('setxkbmap', ['us']);
    }
  });
});

// A keydown is dispatched only in the focused frame's window, so with focus in
// an iframe (an embedded editor, say) the main frame never sees the press; the
// iframe's own preload instance has to report it. Same rules as above: the
// frame that has the key can keep it by cancelling the keydown.
test.describe('digit-row zoom presses with focus in an iframe', () => {
  const IFRAME_EDITOR =
    '<iframe id="ed" srcdoc="<textarea id=t></textarea><script>addEventListener(&quot;keydown&quot;, (e) => { if (window.cancelCtrl && e.ctrlKey) e.preventDefault(); }, true);</script>"></iframe>';
  const PRESSES = [
    ['fr', 'ctrl+minus', 1.1], // the `6` key: Zoom Out
    ['de', 'ctrl+shift+0', 1.3], // `=` is Shift+0: Zoom In's Shift+= alias
  ];

  test('zoom once from a focused iframe, and an iframe that cancels the keydown keeps it (Linux)', async ({
    window,
    electronApp,
    harness,
  }) => {
    test.skip(process.platform !== 'linux', 'X11 key injection is Linux-only');
    test.skip(!process.env.DISPLAY, 'needs an X display — run under xvfb-run');
    test.skip(!hasXdotool, 'xdotool is not installed (CI installs it for this spec)');
    test.skip(!hasSetxkbmap, 'setxkbmap is not installed (CI installs it for this spec)');

    await openThreeTabs(window, harness, { pageScript: IFRAME_EDITOR });
    await focusAppWindow(electronApp);
    const webview = () => 'document.querySelector("webview:not(.hidden)")';
    const inFrame = (js) =>
      window.evaluate(
        `${webview()}.executeJavaScript(${JSON.stringify(
          `(() => { const w = document.getElementById('ed').contentWindow; ${js} })()`
        )})`
      );
    const zoomFactor = () => window.evaluate(`${webview()}.getZoomFactor()`);
    await expect.poll(() => inFrame("return Boolean(w.document.getElementById('t'));")).toBe(true);

    try {
      for (const cancel of [false, true]) {
        await inFrame(`w.cancelCtrl = ${cancel};`);
        for (const [layout, chord, zoomed] of PRESSES) {
          await window.evaluate(`${webview()}.setZoomFactor(1.2)`);
          await inFrame("w.document.getElementById('t').focus();");
          expect(await inFrame('return w.document.activeElement?.id || null;')).toBe('t');
          execFileSync('setxkbmap', [layout]);
          xdotool(['key', '--clearmodifiers', chord]);
          const expected = cancel ? 1.2 : zoomed;
          if (!cancel) {
            await expect
              .poll(zoomFactor, { message: `Waiting for ${layout} ${chord} to zoom` })
              .toBeCloseTo(expected, 5);
          }
          await window.waitForTimeout(400);
          expect(await zoomFactor(), `${layout} ${chord} cancel=${cancel}`).toBeCloseTo(
            expected,
            5
          );
          expect(await activeTabId(window)).toBe('1');
        }
      }
    } finally {
      execFileSync('setxkbmap', ['us']);
    }
  });
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
