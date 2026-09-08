// Zoom shortcuts (#88) — the README documents Cmd/Ctrl +, - and 0, so both
// wired entry points are covered here against a real app:
//
//   1. the View-menu items, driven through the real application menu so the
//      main → preload → renderer round trip is exercised end to end, and
//   2. the renderer's window-level keydown fallback, which is the only path
//      on the Linux frameless setups where menu accelerators never arrive.
//
// Synthetic CDP key events cannot trigger native menu accelerators (see the
// note at the top of shortcuts.spec.js), so the menu half clicks the real
// MenuItem instead of pressing the key.

const { test, expect } = require('./fixtures');

// Zoom factor of the foreground webview, read from the chrome renderer.
const zoomFactor = (window) =>
  window.evaluate(() => {
    const wv = document.querySelector('webview:not(.hidden)');
    return wv && typeof wv.getZoomFactor === 'function' ? wv.getZoomFactor() : null;
  });

const setZoomFactor = (window, factor) =>
  window.evaluate((value) => {
    document.querySelector('webview:not(.hidden)')?.setZoomFactor(value);
  }, factor);

// Click a View-menu item by id in the main process.
const clickMenuItem = (electronApp, id) =>
  electronApp.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) return false;
    item.click();
    return true;
  }, id);

// Press a chord with chrome focused. Playwright's CDP key events reach the
// renderer without firing native menu accelerators, so this exercises the
// keydown fallback specifically (same approach as shortcuts.spec.js).
async function pressChord(window, key) {
  await window.locator('[data-test="address-input"]').click();
  await window.keyboard.press(`ControlOrMeta+${key}`);
}

// Two startup races have to be closed before any zoom assertion is stable:
//
//   - Electron installs its own default menu (which carries zoom *roles*)
//     until the app replaces it, so a menu read can land on the default one.
//   - Zoom resolves through the renderer's active tab, and a webview can be
//     attached and dom-ready a beat before initTabs() marks it active, so an
//     early click is silently dropped.
//
// Probing with Actual Size closes both: it is idempotent, so retrying until
// it lands cannot skew the factor the assertions then measure.
async function waitForZoomReady(window, electronApp) {
  await expect
    .poll(() => zoomFactor(window), {
      message: 'Waiting for the active webview to become zoomable',
      timeout: 15_000,
    })
    .toBeCloseTo(1, 2);

  // Detune first, and confirm the detune stuck — otherwise the probe below
  // could read an already-correct 1 and "pass" without proving anything.
  await expect
    .poll(
      async () => {
        await setZoomFactor(window, 1.5);
        return zoomFactor(window);
      },
      { message: 'Waiting for the webview to accept a zoom factor', timeout: 15_000 }
    )
    .toBeCloseTo(1.5, 2);

  await expect
    .poll(
      async () => {
        await clickMenuItem(electronApp, 'zoom-reset');
        return zoomFactor(window);
      },
      {
        message: 'Waiting for the View-menu zoom channel to reach the renderer',
        timeout: 15_000,
      }
    )
    .toBeCloseTo(1, 2);
}

test('the View menu exposes the zoom group with its registry accelerators', async ({
  window,
  electronApp,
}) => {
  await waitForZoomReady(window, electronApp);

  const items = await electronApp.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu().items.find((item) => item.label === 'View');
    if (!view?.submenu) return null;
    return view.submenu.items
      .filter((item) => ['zoom-in', 'zoom-out', 'zoom-reset'].includes(item.id))
      .map((item) => ({ id: item.id, label: item.label, accelerator: item.accelerator }));
  });

  expect(items).toEqual([
    { id: 'zoom-in', label: 'Zoom In', accelerator: 'CmdOrCtrl+=' },
    { id: 'zoom-out', label: 'Zoom Out', accelerator: 'CmdOrCtrl+-' },
    { id: 'zoom-reset', label: 'Actual Size', accelerator: 'CmdOrCtrl+0' },
  ]);
});

test('View-menu zoom items zoom the active webview and reset it', async ({
  window,
  electronApp,
}) => {
  await waitForZoomReady(window, electronApp);

  await clickMenuItem(electronApp, 'zoom-in');
  await expect.poll(() => zoomFactor(window)).toBeCloseTo(1.1, 2);

  await clickMenuItem(electronApp, 'zoom-in');
  await expect.poll(() => zoomFactor(window)).toBeCloseTo(1.2, 2);

  await clickMenuItem(electronApp, 'zoom-out');
  await expect.poll(() => zoomFactor(window)).toBeCloseTo(1.1, 2);

  await clickMenuItem(electronApp, 'zoom-reset');
  await expect.poll(() => zoomFactor(window)).toBeCloseTo(1, 2);
});

test('the renderer keydown fallback zooms when no menu accelerator arrives', async ({
  window,
  electronApp,
}) => {
  await waitForZoomReady(window, electronApp);

  await pressChord(window, 'Equal');
  await expect.poll(() => zoomFactor(window)).toBeCloseTo(1.1, 2);

  await pressChord(window, 'Minus');
  await expect.poll(() => zoomFactor(window)).toBeCloseTo(1, 2);

  await pressChord(window, 'Equal');
  await pressChord(window, 'Equal');
  await expect.poll(() => zoomFactor(window)).toBeCloseTo(1.2, 2);

  await pressChord(window, 'Digit0');
  await expect.poll(() => zoomFactor(window)).toBeCloseTo(1, 2);
});

test('the hamburger menu readout follows a zoom driven from the View menu', async ({
  window,
  electronApp,
}) => {
  await waitForZoomReady(window, electronApp);

  await clickMenuItem(electronApp, 'zoom-in');
  await expect.poll(() => zoomFactor(window)).toBeCloseTo(1.1, 2);

  await window.locator('#menu-button').click();
  await expect(window.locator('#zoom-level')).toHaveText('110%');

  await clickMenuItem(electronApp, 'zoom-reset');
  await expect(window.locator('#zoom-level')).toHaveText('100%');
});

// A remap recorded before the zoom entries existed — Cmd/Ctrl+0 was a free
// chord then — used to survive the upgrade and fire alongside the new
// page.zoomReset default: one press, two actions (the address bar took
// focus *and* the zoom reset). The settings store now applies the same
// conflict rule the interactive remap path does and reverts it on load.
test.describe('a stored remap that a newer zoom default has claimed', () => {
  test.use({
    seedSettings: {
      shortcutOverrides: {
        'view.focusAddressBar': process.platform === 'darwin' ? 'Cmd+0' : 'Ctrl+0',
      },
    },
  });

  test('is reverted on load, so one Cmd/Ctrl+0 press does exactly one thing', async ({
    window,
    electronApp,
  }) => {
    await waitForZoomReady(window, electronApp);

    // Detune, and confirm it stuck, so the reset below proves something.
    await expect
      .poll(
        async () => {
          await setZoomFactor(window, 1.5);
          return zoomFactor(window);
        },
        { message: 'Waiting for the webview to accept the detuned zoom', timeout: 15_000 }
      )
      .toBeCloseTo(1.5, 2);

    // Press with the address bar deliberately unfocused: were the stale
    // override still live, this same press would also focus it.
    await window.evaluate(() => document.activeElement?.blur?.());
    await window.keyboard.press('ControlOrMeta+Digit0');

    await expect.poll(() => zoomFactor(window)).toBeCloseTo(1, 2);
    expect(await window.evaluate(() => document.activeElement?.id || null)).not.toBe(
      'address-input'
    );

    // …and the reverted remap is really gone from the live settings.
    expect(
      await window.evaluate(() => window.electronAPI.getSettings().then((s) => s.shortcutOverrides))
    ).toEqual({});
  });
});
