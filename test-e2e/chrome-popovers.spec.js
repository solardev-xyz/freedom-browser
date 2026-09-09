// Chrome popovers scroll internally; the browser chrome never scrolls (#324).
//
// With every node enabled the Nodes menu is ~650 px tall. In a 1200x600 window
// its bottom landed at 734 px: the chrome document itself grew a scrollbar, the
// toolbar could be scrolled away and the last section (Tor) was cut off, because
// no dropdown had a height bound and the chrome had no `overflow` rule. Chrome's
// model is the opposite, and it is one rule for every popover in the frame —
// hence the hamburger menu and its Profiles flyout here too, not just the menu
// the bug was reported against.
//
// The Tor section's label is asserted here as well: it reads "Tor", like every
// other bare product name in that menu (#323).

const { test, expect } = require('./fixtures');

// All six nodes on, so the Nodes menu renders every section — the state the
// overflow was reported in.
test.use({
  seedSettings: {
    startAntAtLaunch: true,
    startIpfsAtLaunch: true,
    startMyotisAtLaunch: true,
    startMyotisGnosisAtLaunch: true,
    startRadicleAtLaunch: true,
    enableTorIntegration: true,
  },
});

// Resize the real BrowserWindow and wait until the renderer sees it. Content
// size, not window size, so `innerHeight` is exactly what we asked for.
const setWindowSize = async (electronApp, window, width, height) => {
  await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
    },
    { width, height }
  );
  await expect
    .poll(() => window.evaluate(() => window.innerHeight), {
      message: `Waiting for the window to be ${width}x${height}`,
    })
    .toBe(height);
};

// Everything the two halves of the fix are about, read off one popover.
const popoverState = (window, selector) =>
  window.evaluate((sel) => {
    const el = document.querySelector(sel);
    const rect = el.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      innerHeight: window.innerHeight,
      insideViewport: rect.bottom <= window.innerHeight,
      overflowY: getComputedStyle(el).overflowY,
      scrollable: el.scrollHeight - el.clientHeight > 1,
      // The chrome document must be exactly as tall as the window: no
      // overflowing element may ever scroll the toolbar away.
      docScrollHeight: document.documentElement.scrollHeight,
    };
  }, selector);

// Scroll `selector` to its end and report whether `itemSelector`'s row is then
// fully inside both the popover's box and the window — "the last item is
// reachable by scrolling the menu".
const scrollToItem = (window, selector, itemSelector) =>
  window.evaluate(
    ({ sel, item }) => {
      const el = document.querySelector(sel);
      el.scrollTop = el.scrollHeight;
      const target = document.querySelector(item);
      const menu = el.getBoundingClientRect();
      const row = target.getBoundingClientRect();
      return {
        label: target.textContent.trim().split('\n')[0].trim(),
        insideMenu: row.top >= menu.top - 1 && row.bottom <= menu.bottom + 1,
        insideViewport: row.bottom <= window.innerHeight && row.top >= 0,
        scrolledBy: Math.round(el.scrollTop),
      };
    },
    { sel: selector, item: itemSelector }
  );

test('the Nodes menu scrolls inside itself instead of scrolling the chrome', async ({
  window,
  electronApp,
}) => {
  await setWindowSize(electronApp, window, 1200, 600);

  await window.locator('#bee-menu-button').click();
  await expect(window.locator('#bee-menu-dropdown')).toHaveClass(/open/);

  const state = await popoverState(window, '#bee-menu-dropdown');
  expect(state.insideViewport).toBe(true);
  expect(state.docScrollHeight).toBe(state.innerHeight);
  // Taller than the window, so it is genuinely the bounded case: the menu is
  // its own scroller.
  expect(state.overflowY).toBe('auto');
  expect(state.scrollable).toBe(true);

  // The section that used to be cut off, reachable by scrolling the menu —
  // labelled "Tor", not "Tor (.onion)" (#323).
  const tor = await scrollToItem(window, '#bee-menu-dropdown', '#tor-toggle-btn');
  expect(tor.label).toBe('Tor');
  expect(tor.insideMenu).toBe(true);
  expect(tor.insideViewport).toBe(true);
  expect(tor.scrolledBy).toBeGreaterThan(0);

  // Scrolling the menu to its end still has not moved the chrome.
  await expect.poll(() => window.evaluate(() => document.documentElement.scrollTop)).toBe(0);
});

test('the hamburger menu and its Profiles flyout stay inside the window', async ({
  window,
  electronApp,
}) => {
  await setWindowSize(electronApp, window, 1200, 600);

  await window.locator('#menu-button').click();
  await expect(window.locator('#menu-dropdown')).toHaveClass(/open/);

  const at600 = await popoverState(window, '#menu-dropdown');
  expect(at600.insideViewport).toBe(true);
  expect(at600.docScrollHeight).toBe(at600.innerHeight);
  expect(at600.overflowY).toBe('auto');

  const last600 = await scrollToItem(window, '#menu-dropdown', '#check-updates-btn');
  expect(last600.insideMenu).toBe(true);
  expect(last600.insideViewport).toBe(true);

  // The Profiles flyout hangs off the left of a menu that is now a scroll
  // container: it must still render outside that box, not be clipped by it.
  await window.locator('#profile-menu-btn').click();
  await expect(window.locator('#profile-menu')).toBeVisible();
  const flyout = await window.evaluate(() => {
    const el = document.getElementById('profile-menu');
    const row = document.getElementById('profile-menu-wrap').getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      // Anchored to the Profiles row, as `right: 100%` used to express.
      anchoredToRow: Math.abs(rect.right - row.left) <= 1,
      insideViewport: rect.bottom <= window.innerHeight && rect.left >= 0,
      overflowY: getComputedStyle(el).overflowY,
    };
  });
  expect(flyout.width).toBeGreaterThan(200);
  expect(flyout.anchoredToRow).toBe(true);
  expect(flyout.insideViewport).toBe(true);
  expect(flyout.overflowY).toBe('auto');

  // Shrink the window until the hamburger genuinely overflows: same rule, the
  // menu scrolls and the chrome does not.
  await window.keyboard.press('Escape'); // flyout
  await window.keyboard.press('Escape'); // menu
  await setWindowSize(electronApp, window, 1200, 420);
  await window.locator('#menu-button').click();
  await expect(window.locator('#menu-dropdown')).toHaveClass(/open/);

  const at420 = await popoverState(window, '#menu-dropdown');
  expect(at420.insideViewport).toBe(true);
  expect(at420.scrollable).toBe(true);
  expect(at420.docScrollHeight).toBe(at420.innerHeight);

  const last420 = await scrollToItem(window, '#menu-dropdown', '#check-updates-btn');
  expect(last420.insideMenu).toBe(true);
  expect(last420.insideViewport).toBe(true);
  expect(last420.scrolledBy).toBeGreaterThan(0);
});

test('a menu left open while the window shrinks re-bounds itself', async ({
  window,
  electronApp,
}) => {
  await setWindowSize(electronApp, window, 1200, 800);

  await window.locator('#bee-menu-button').click();
  await expect(window.locator('#bee-menu-dropdown')).toHaveClass(/open/);
  expect((await popoverState(window, '#bee-menu-dropdown')).insideViewport).toBe(true);

  await setWindowSize(electronApp, window, 1200, 500);
  await expect
    .poll(() => popoverState(window, '#bee-menu-dropdown').then((s) => s.insideViewport), {
      message: 'Waiting for the open menu to re-bound to the smaller window',
    })
    .toBe(true);

  const shrunk = await popoverState(window, '#bee-menu-dropdown');
  expect(shrunk.docScrollHeight).toBe(shrunk.innerHeight);
  expect(shrunk.scrollable).toBe(true);
});

test('a window too short for the minimum height still shows the whole box (#328)', async ({
  window,
  electronApp,
}) => {
  // The bound has a 96 px floor, so a scroll of two or three rows beats a
  // sliver. In a window with less room than that under the menu's anchor the
  // floor has to yield: scrolling moves the content *inside* the box, so a box
  // whose own bottom edge is off-screen has a tail nothing can reach.
  await setWindowSize(electronApp, window, 1000, 140);

  await window.locator('#bee-menu-button').click();
  await expect(window.locator('#bee-menu-dropdown')).toHaveClass(/open/);

  const state = await popoverState(window, '#bee-menu-dropdown');
  expect(state.insideViewport).toBe(true);
  expect(state.docScrollHeight).toBe(state.innerHeight);
  // Genuinely the case the floor used to win: the menu is anchored at ~87 px,
  // leaving well under 96 px of room below it.
  expect(state.bottom - state.top).toBeLessThan(96);
  expect(state.scrollable).toBe(true);
});

test('a context menu raised at the bottom edge opens upwards', async ({
  window,
  electronApp,
  harness,
}) => {
  const PAGE = 'bzz://' + 'c'.repeat(64) + '/';
  await harness.setContentFixture(PAGE, {
    body: '<!doctype html><title>Context</title><p>right-click me</p>',
  });
  await setWindowSize(electronApp, window, 1200, 600);

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(PAGE);
  await input.press('Enter');
  await expect(input).toHaveValue(PAGE);

  // A guest that has been clicked once routes right-clicks through the real
  // hit-test path (see tabs.spec.js's wakeGuest).
  const spot = await window.evaluate(() => {
    const rect = document.querySelector('webview:not(.hidden)').getBoundingClientRect();
    // 40 px above the viewport's bottom edge: too little room for the ~200 px
    // menu below the pointer, and far enough from the edge that the old
    // "clamp to the bottom" behaviour is distinguishable from a real flip.
    return { x: Math.round(rect.x + 40), y: Math.round(rect.bottom - 40) };
  });
  await window.mouse.click(spot.x, spot.y);
  await window.waitForTimeout(150);
  await window.mouse.click(spot.x, spot.y, { button: 'right' });

  const menu = window.locator('#page-context-menu');
  await expect(menu).toBeVisible();

  // The page menu is shown at the raw pointer position first and placed in the
  // next animation frame (its visible groups were only just switched, so its
  // height is not final until then) — so poll rather than read once.
  const placement = () =>
    window.evaluate((y) => {
      const el = document.getElementById('page-context-menu');
      const rect = el.getBoundingClientRect();
      return {
        insideViewport: rect.bottom <= window.innerHeight && rect.top >= 0,
        // Chrome flips the menu up when there is no room below the pointer.
        flippedAboveThePointer: rect.bottom <= y + 1,
        docScrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
      };
    }, spot.y);

  await expect
    .poll(() => placement().then((p) => p.insideViewport), {
      message: 'Waiting for the context menu to be placed inside the viewport',
    })
    .toBe(true);

  const placed = await placement();
  expect(placed.flippedAboveThePointer).toBe(true);
  expect(placed.docScrollHeight).toBe(placed.innerHeight);
});

// Every row of a bounded, scrolling popover is still a working menu item:
// nothing (the backdrop, the scrollbar, the Profiles flyout, the clipped box
// itself) sits between the pointer and the row, and the keyboard reaches it.
//
// `rows` walks the menu row by row, scrolling each one into view inside the
// menu first — the point of the bound is that an item off the bottom is
// reachable by scrolling, so "reachable" has to be measured after that scroll,
// not from the initial screenful.
const sweepRows = (window, menuSelector) =>
  window.evaluate((sel) => {
    const menu = document.querySelector(sel);
    const rows = [...menu.querySelectorAll('button')].filter(
      (el) => el.getBoundingClientRect().height > 0
    );
    const out = [];
    for (const row of rows) {
      // Centre the row in the menu's box by hand rather than with
      // `scrollIntoView`, so the scroll has definitely landed before the
      // hit-test reads back.
      const box = menu.getBoundingClientRect();
      let rect = row.getBoundingClientRect();
      menu.scrollTop += rect.top - box.top - (menu.clientHeight - rect.height) / 2;
      rect = row.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      // A node whose binary is missing is deliberately inert
      // (`.bee-toggle.disabled` etc. in services.css) — it has nothing to
      // swallow. Recorded rather than silently dropped.
      const inert =
        row.disabled === true || window.getComputedStyle(row).pointerEvents === 'none';
      out.push({
        id: row.id || row.className,
        inert,
        insideViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
        // The row's centre belongs to the row: `elementFromPoint` respects
        // stacking and clipping, so this is the same test the click will make.
        reachable: inert || row === hit || row.contains(hit),
        hit: hit ? `${hit.tagName}#${hit.id}.${hit.className}` : 'null',
      });
    }
    menu.scrollTop = 0;
    return out;
  }, menuSelector);

// Focus a row and press Enter, with the menu's own handlers held off: what is
// under test is that the keypress reaches the row as a click, not what each of
// a dozen rows then does (toggling a node, opening a window, printing).
const activatesOnEnter = async (window, menuSelector, rowId) => {
  await window.evaluate(
    ({ sel, id }) => {
      const menu = document.querySelector(sel);
      window.__enterTarget = null;
      window.__enterTrap = (event) => {
        window.__enterTarget = event.target?.closest?.('button')?.id || event.target?.id || '';
        event.preventDefault();
        event.stopPropagation();
      };
      menu.addEventListener('click', window.__enterTrap, true);
      document.getElementById(id).focus();
    },
    { sel: menuSelector, id: rowId }
  );
  await window.keyboard.press('Enter');
  const target = await window.evaluate((sel) => {
    document.querySelector(sel).removeEventListener('click', window.__enterTrap, true);
    return window.__enterTarget;
  }, menuSelector);
  return target;
};

test('every row of the bounded hamburger and Nodes menus still takes a click and Enter', async ({
  window,
  electronApp,
}) => {
  // Short enough that both menus are genuinely bounded and scrolling — the
  // state where a swallowed click would actually be the bound's fault.
  await setWindowSize(electronApp, window, 1200, 420);

  await window.locator('#menu-button').click();
  await expect(window.locator('#menu-dropdown')).toHaveClass(/open/);
  expect((await popoverState(window, '#menu-dropdown')).scrollable).toBe(true);
  const hamburger = await sweepRows(window, '#menu-dropdown');
  expect(hamburger.filter((row) => !row.inert).length).toBeGreaterThan(8);
  expect(hamburger.filter((row) => !row.reachable || !row.insideViewport)).toEqual([]);
  expect(await activatesOnEnter(window, '#menu-dropdown', 'downloads-btn')).toBe('downloads-btn');
  await window.keyboard.press('Escape');

  await window.locator('#bee-menu-button').click();
  await expect(window.locator('#bee-menu-dropdown')).toHaveClass(/open/);
  expect((await popoverState(window, '#bee-menu-dropdown')).scrollable).toBe(true);
  const nodes = await sweepRows(window, '#bee-menu-dropdown');
  expect(nodes.length).toBeGreaterThan(5);
  expect(nodes.filter((row) => !row.reachable || !row.insideViewport)).toEqual([]);
  // Enter on the first row this build actually leaves interactive — which
  // node that is depends on the binaries present, so it is read off the sweep
  // rather than named.
  const liveNodeRow = nodes.find((row) => !row.inert && row.id);
  expect(liveNodeRow).toBeDefined();
  expect(await activatesOnEnter(window, '#bee-menu-dropdown', liveNodeRow.id)).toBe(
    liveNodeRow.id
  );
});

// #328: an Electron `<webview>` guest taking the keyboard fires a window
// `blur` in the embedder even though the window is still the active one, and
// every tab activation hands the page focus (#304). The guest's ack lands
// asynchronously — tens of milliseconds later, i.e. after the user has already
// opened a menu — and closing on that blur tore the menu down under the
// pointer, so the click that was on its way landed on the page instead.
test('a webview guest taking focus does not close the menu under the pointer', async ({
  window,
}) => {
  await window.locator('#menu-button').click();
  await expect(window.locator('#menu-dropdown')).toHaveClass(/open/);

  // Exactly what a late tab-activation focus does, from the chrome's side.
  await window.evaluate(() => document.querySelector('webview:not(.hidden)')?.focus());
  await expect
    .poll(() => window.evaluate(() => document.activeElement?.tagName))
    .toBe('WEBVIEW');

  // The window never went anywhere, so the menu is still up...
  await expect(window.locator('#menu-dropdown')).toHaveClass(/open/);
  await expect(window.locator('#menu-backdrop')).not.toHaveClass(/hidden/);

  // ...and its rows still do their job.
  const tabs = window.locator('[data-test="tab"]');
  const before = await tabs.count();
  await window.locator('#downloads-btn').click();
  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const wv = document.querySelector('webview.active, webview:not(.hidden)');
          return wv?.getURL?.() || wv?.getAttribute?.('src') || '';
        }),
      { timeout: 10_000 }
    )
    .toMatch(/pages\/downloads\.html/);
  await expect(tabs).toHaveCount(before + 1);
});
