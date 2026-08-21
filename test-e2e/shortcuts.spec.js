// Shortcuts editor — remap "New Tab" through the Settings > Shortcuts
// recording flow, assert the new combo opens a tab (and the old one no
// longer does) without a restart, then restore defaults.
//
// The settings page lives inside a webview, so all page interaction goes
// through executeJavaScript (same pattern as downloads.spec.js). Chrome
// key presses use the renderer's window-level keydown fallback — synthetic
// CDP key events don't trigger native menu accelerators.

const { test, expect } = require('./fixtures');

// Run a script inside the active webview and return its result.
async function inSettingsPage(window, code) {
  return window.evaluate(async (script) => {
    const wv = document.querySelector('webview:not(.hidden)');
    if (!wv || typeof wv.executeJavaScript !== 'function') return null;
    try {
      return await wv.executeJavaScript(script);
    } catch {
      return null;
    }
  }, code);
}

async function openShortcutsSettings(window) {
  const address = window.locator('[data-test="address-input"]');
  await address.click();
  await address.fill('freedom://settings/shortcuts');
  await address.press('Enter');

  await expect
    .poll(
      () =>
        inSettingsPage(
          window,
          `document.querySelectorAll('#shortcuts-view [data-shortcut-id]').length`
        ),
      { message: 'Waiting for the Shortcuts settings list to render', timeout: 10_000 }
    )
    .toBeGreaterThan(0);
}

// Click a shortcut's binding button (recording mode), then synthesize the
// keydown the recorder should capture. Modifier choice follows the page's
// platform (Cmd on macOS, Ctrl elsewhere) to mirror a real user.
async function recordBinding(window, id, key, code) {
  const clicked = await inSettingsPage(
    window,
    `(() => {
       const row = document.querySelector('[data-shortcut-id="${id}"]');
       const btn = row && row.querySelector('[data-action="record"]');
       if (!btn) return false;
       btn.click();
       return true;
     })()`
  );
  expect(clicked).toBe(true);

  await inSettingsPage(
    window,
    `(() => {
       const isMac = navigator.platform.toLowerCase().includes('mac');
       window.dispatchEvent(
         new KeyboardEvent('keydown', {
           key: '${key}',
           code: '${code}',
           shiftKey: true,
           ctrlKey: !isMac,
           metaKey: isMac,
           bubbles: true,
           cancelable: true,
         })
       );
       return true;
     })()`
  );
}

const effectiveAccelerator = (window, id) =>
  inSettingsPage(
    window,
    `window.freedomAPI.getShortcuts().then((s) => s.entries.find((e) => e.id === '${id}').accelerator)`
  );

test('remapping New Tab applies live and restores cleanly', async ({ window }) => {
  await openShortcutsSettings(window);

  const tabs = window.locator('[data-test="tab"]');
  const initialTabs = await tabs.count();

  // Record Cmd/Ctrl+Shift+U for New Tab.
  await recordBinding(window, 'tab.new', 'U', 'KeyU');
  await expect
    .poll(() => effectiveAccelerator(window, 'tab.new'), {
      message: 'Waiting for the override to persist',
    })
    .toMatch(/^(Ctrl|Shift)\+.*U$/);

  // The new combo opens a tab (chrome-focused renderer fallback)…
  await window.locator('[data-test="address-input"]').click();
  await window.keyboard.press('ControlOrMeta+Shift+U');
  await expect(tabs).toHaveCount(initialTabs + 1);

  // …and the old default no longer does.
  await window.keyboard.press('ControlOrMeta+T');
  await window.waitForTimeout(500);
  await expect(tabs).toHaveCount(initialTabs + 1);

  // Back to the settings tab — the freshly opened tab is active now and
  // inSettingsPage talks to the active webview.
  await window.locator('[data-test="tab"][data-tab-id="1"]').click();
  await expect
    .poll(() => inSettingsPage(window, `!!document.getElementById('shortcuts-restore-defaults')`))
    .toBe(true);

  // Restore defaults re-arms Cmd/Ctrl+T without a restart.
  const restored = await inSettingsPage(
    window,
    `(() => { document.getElementById('shortcuts-restore-defaults').click(); return true; })()`
  );
  expect(restored).toBe(true);
  await expect
    .poll(() => effectiveAccelerator(window, 'tab.new'), {
      message: 'Waiting for defaults to be restored',
    })
    .toBe('CmdOrCtrl+T');

  await window.locator('[data-test="address-input"]').click();
  await window.keyboard.press('ControlOrMeta+T');
  await expect(tabs).toHaveCount(initialTabs + 2);
});

// New Private Window is a menu-context shortcut with a renderer keydown
// fallback (the menu bar is frameless/auto-hidden on Linux, so the
// accelerator never fires from chrome focus). The fallback must resolve
// through the registry like every other binding, or a remap is silently
// ignored and the stale default stays live.
test('remapping New Private Window rebinds the renderer fallback', async ({
  electronApp,
  window,
}) => {
  const privateWindowCount = () =>
    electronApp.windows().filter((page) => page.url().includes('privatePartition=private-')).length;

  await openShortcutsSettings(window);
  expect(privateWindowCount()).toBe(0);

  // Record Cmd/Ctrl+Shift+U for New Private Window.
  await recordBinding(window, 'window.newPrivate', 'U', 'KeyU');
  await expect
    .poll(() => effectiveAccelerator(window, 'window.newPrivate'), {
      message: 'Waiting for the override to persist',
    })
    .toMatch(/^(Ctrl|Cmd|Shift)\+.*U$/);

  // The new combo opens a private window…
  await window.locator('[data-test="address-input"]').click();
  await window.keyboard.press('ControlOrMeta+Shift+U');
  await expect
    .poll(privateWindowCount, {
      message: 'Waiting for the private window opened by the remapped combo',
      timeout: 15_000,
    })
    .toBe(1);

  // …and the old default no longer does.
  await window.locator('[data-test="address-input"]').click();
  await window.keyboard.press('ControlOrMeta+Shift+N');
  await window.waitForTimeout(1500);
  expect(privateWindowCount()).toBe(1);
});

test('conflicting combos warn with a swap offer instead of silently rebinding', async ({
  window,
}) => {
  await openShortcutsSettings(window);

  // Start recording on New Tab, then press Close Tab's combo
  // (Cmd/Ctrl+W, no Shift) so the preview reports a swappable conflict.
  const clicked = await inSettingsPage(
    window,
    `(() => {
       const row = document.querySelector('[data-shortcut-id="tab.new"]');
       const btn = row && row.querySelector('[data-action="record"]');
       if (!btn) return false;
       btn.click();
       return true;
     })()`
  );
  expect(clicked).toBe(true);
  await inSettingsPage(
    window,
    `(() => {
       const isMac = navigator.platform.toLowerCase().includes('mac');
       window.dispatchEvent(
         new KeyboardEvent('keydown', {
           key: 'w',
           code: 'KeyW',
           ctrlKey: !isMac,
           metaKey: isMac,
           bubbles: true,
           cancelable: true,
         })
       );
       return true;
     })()`
  );

  // The conflict prompt names Close Tab and offers a swap.
  await expect
    .poll(() =>
      inSettingsPage(
        window,
        `(() => {
           const conflict = document.querySelector('.shortcut-conflict');
           if (!conflict) return null;
           return {
             text: conflict.textContent,
             hasSwap: !!conflict.querySelector('[data-action="swap"]'),
           };
         })()`
      )
    )
    .toMatchObject({ hasSwap: true });

  // Cancel keeps both bindings unchanged.
  await inSettingsPage(
    window,
    `(() => { document.querySelector('[data-action="cancel-conflict"]').click(); return true; })()`
  );
  expect(await effectiveAccelerator(window, 'tab.new')).toBe('CmdOrCtrl+T');
  expect(await effectiveAccelerator(window, 'tab.close')).toBe('CmdOrCtrl+W');
});

test('search filters the shortcut list', async ({ window }) => {
  await openShortcutsSettings(window);

  const count = (code) => inSettingsPage(window, code);

  const total = await count(
    `document.querySelectorAll('#shortcuts-view .row[data-shortcut-id]').length`
  );
  expect(total).toBeGreaterThan(5);

  await inSettingsPage(
    window,
    `(() => {
       const input = document.getElementById('shortcut-search');
       input.value = 'find in page';
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`
  );

  await expect
    .poll(() => count(`document.querySelectorAll('#shortcuts-view .row[data-shortcut-id]').length`))
    .toBe(1);
  expect(
    await count(
      `document.querySelector('#shortcuts-view .row[data-shortcut-id]').dataset.shortcutId`
    )
  ).toBe('page.findInPage');
});
