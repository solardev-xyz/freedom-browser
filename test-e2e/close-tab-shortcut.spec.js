// Cmd/Ctrl+W closes the active tab, never the whole window (#97).
//
// The File menu used to carry that chord twice: the explicit Close Tab item,
// and `{ role: 'close' }`, whose implicit default accelerator is the same
// chord and never appears in the menu template. macOS's NSMenu resolves a key
// equivalent to the first matching row (Close Tab) and hid the collision;
// Windows and Linux hand the chord to the role, so Ctrl+W closed the window
// with every tab in it.
//
// Two assertions, because neither alone covers the bug:
//
//   1. Ownership, read off the *real* application menu in the main process.
//      `MenuItem#accelerator` resolves a role's implicit default, so this sees
//      what the template cannot. Runs on all three platforms.
//
//   2. A real X11 Ctrl+W keypress on Linux, via xdotool. Playwright's
//      `keyboard.press()` dispatches through CDP into the renderer, where the
//      chrome's own keydown fallback (tabs.js) answers it — it never reaches
//      the native menu accelerator, so it closes the active tab with or
//      without this fix (the same reason shortcuts.spec.js drives its chords
//      through that fallback on purpose). Only a real key event exercises the
//      path that actually broke.

const { execFileSync } = require('child_process');
const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');
const { normalizeAccelerator } = require('../src/shared/shortcuts');

const PAGE_A = `bzz://${SAMPLE_BZZ_HASH}/`;
const PAGE_B = `bzz://${'b'.repeat(64)}/`;

const CLOSE_TAB_CHORD = normalizeAccelerator('CmdOrCtrl+W', process.platform);

const hasXdotool = (() => {
  try {
    execFileSync('xdotool', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const xdotool = (args) => execFileSync('xdotool', args, { encoding: 'utf-8' }).trim();

// Every item of the live application menu, flattened, with the accelerator
// Electron actually registered for it (explicit or role-implied).
async function readMenuBindings(electronApp) {
  let bindings = null;
  await expect
    .poll(
      async () => {
        bindings = await electronApp.evaluate(({ Menu }) => {
          const menu = Menu.getApplicationMenu();
          if (!menu) return null;
          const out = [];
          const walk = (items, trail) => {
            for (const item of items) {
              if (item.type === 'separator') continue;
              const path = [...trail, item.label || item.role || '(unnamed)'];
              out.push({
                id: item.id || null,
                role: item.role || null,
                label: item.label || null,
                path: path.join(' > '),
                accelerator: item.accelerator || null,
                enabled: item.enabled !== false,
              });
              if (item.submenu && Array.isArray(item.submenu.items)) {
                walk(item.submenu.items, path);
              }
            }
          };
          walk(menu.items, []);
          return out;
        });
        // Two settling steps to wait out: Electron installs its own default
        // menu at startup and the app's template replaces it a moment later,
        // then the tab items are enabled once a window exists
        // (updateTabMenuItems). Read the menu only once both have happened, so
        // a half-built menu can't read as "nothing owns this chord".
        return (
          Array.isArray(bindings) &&
          bindings.some((item) => item.id === 'close-tab' && item.enabled)
        );
      },
      { message: "Waiting for the app's own application menu to be built", timeout: 30_000 }
    )
    .toBe(true);
  return bindings;
}

// The app's own top-level window on the current X display, found by the
// Electron main process's pid so a second app on the same display (or another
// worker's) can never be keyed by mistake.
function findAppWindowId(pid) {
  let candidates;
  try {
    // `xdotool search` exits non-zero when nothing matches yet.
    candidates = xdotool(['search', '--onlyvisible', '--pid', String(pid)])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }

  for (const id of candidates) {
    // Chromium parks unnamed helper windows on the display too; the browser
    // window is the one carrying a name.
    let name;
    try {
      name = xdotool(['getwindowname', id]);
    } catch {
      continue;
    }
    if (name) return { id, name };
  }
  return null;
}

test('Cmd/Ctrl+W is owned by Close Tab alone in the built application menu', async ({
  electronApp,
}) => {
  const bindings = await readMenuBindings(electronApp);

  // Guards the guard: if Electron stopped surfacing a role's implicit
  // accelerator here, the ownership assertion below would pass against the
  // exact bug it exists to catch.
  expect(bindings.some((item) => item.role && item.accelerator)).toBe(true);

  const owners = bindings.filter(
    (item) =>
      item.enabled && normalizeAccelerator(item.accelerator, process.platform) === CLOSE_TAB_CHORD
  );
  expect(owners.map((item) => item.path)).toEqual(['File > Close Tab']);
  expect(owners[0].id).toBe('close-tab');

  // Close Window is still there — it just advertises and registers no chord.
  const closeWindow = bindings.find((item) => item.id === 'close-window');
  expect(closeWindow).toEqual(
    expect.objectContaining({ label: 'Close Window', accelerator: null, role: null })
  );
});

test('a real Ctrl+W keypress closes the active tab and leaves the window open', async ({
  window,
  electronApp,
  harness,
}) => {
  test.skip(
    process.platform !== 'linux',
    'X11 key injection is Linux-only; the menu-ownership test above covers the other platforms'
  );
  test.skip(!process.env.DISPLAY, 'needs an X display — run under xvfb-run');
  test.skip(!hasXdotool, 'xdotool is not installed (CI installs it for this spec)');

  await harness.setContentFixture(PAGE_A, {
    body: '<!doctype html><title>Page A</title><p>a</p>',
  });
  await harness.setContentFixture(PAGE_B, {
    body: '<!doctype html><title>Page B</title><p>b</p>',
  });

  const tabs = window.locator('[data-test="tab"]');
  const input = window.locator('[data-test="address-input"]');
  await expect(tabs).toHaveCount(1);

  // Both tabs land on a real page, and the keypress goes to the focused guest
  // — the state a user is in when they hit Ctrl+W. It also matters for what
  // this test proves: with focus in the chrome (a tab on the new-tab page),
  // the renderer's own keydown fallback in tabs.js answers Ctrl+W and closes
  // the tab whether or not the menu collision exists, so the bug would be
  // invisible. A guest never calls preventDefault on it, so the key returns
  // to the browser process and the menu accelerator decides — which is the
  // path that closed the whole window.
  await input.click();
  await input.fill(PAGE_A);
  await input.press('Enter');

  // A second tab, so closing a tab is observably different from closing the
  // window. New tabs open active, so tab 2 is the one Ctrl+W must close.
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(tabs).toHaveCount(2);
  await input.click();
  await input.fill(PAGE_B);
  await input.press('Enter');
  await expect(window.locator('[data-test="tab"].active')).toHaveAttribute('data-tab-id', '2');

  // Hand the keyboard to the page, the way a click on any page content does.
  await window.evaluate(() => document.querySelector('webview:not(.hidden)')?.focus());
  await expect
    .poll(() => window.evaluate(() => document.activeElement?.tagName), {
      message: 'Waiting for the guest page to take keyboard focus',
    })
    .toBe('WEBVIEW');

  const pid = electronApp.process().pid;
  let target = null;
  await expect
    .poll(
      () => {
        target = findAppWindowId(pid);
        return Boolean(target);
      },
      { message: `Waiting for an X window owned by the app (pid ${pid})`, timeout: 15_000 }
    )
    .toBe(true);

  // `windowactivate` needs a window manager (_NET_ACTIVE_WINDOW); xvfb has
  // none, so set the input focus directly.
  xdotool(['windowfocus', '--sync', target.id]);
  // The Close Tab menu item only acts when a main window has focus, so prove
  // the activation landed rather than letting a lost focus read as a pass.
  await expect
    .poll(
      () => electronApp.evaluate(({ BrowserWindow }) => Boolean(BrowserWindow.getFocusedWindow())),
      { message: `Waiting for X window ${target.id} (${target.name}) to take focus` }
    )
    .toBe(true);

  xdotool(['key', '--clearmodifiers', 'ctrl+w']);

  // Exactly one tab closes — the active one — and the window survives.
  await expect(tabs).toHaveCount(1);
  await expect(window.locator('[data-test="tab"]')).toHaveAttribute('data-tab-id', '1');
  expect(
    await electronApp.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length
    )
  ).toBe(1);
});
