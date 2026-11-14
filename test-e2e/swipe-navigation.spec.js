// Two-finger swipe between pages on macOS (#980), end to end: trackpad-style
// wheel events sent into the tab reach the preload, which reports a swipe
// past the page's edge; the chrome shows the arrow and goes back as soon as
// the swipe has gone far enough.
//
// `sendInputEvent` makes trusted, precise (trackpad-style) wheel events, and
// Electron's sign is the reverse of the DOM's: a positive `deltaX` here is a
// DOM `deltaX` < 0, a scroll toward the page's left edge, which is Back
// (probed on Electron 45). Its events carry no gesture phases, which is fine:
// the preload does not use them (pages never see them).
//
// macOS only: the feature is. It also follows System Settings > Trackpad >
// "Swipe between pages", so the spec skips on a Mac where that is off.

const { test, expect } = require('./fixtures');

const FIRST_HASH = 'd'.repeat(64);
const SECOND_HASH = 'e'.repeat(64);
const THIRD_HASH = 'f'.repeat(64);
const page = (title, extra = '') =>
  `<!doctype html><title>${title}</title><body style="margin:0;height:600px">` +
  `<p id="label">${title}</p>${extra}</body>`;

async function open(window, harness, hash, body, label) {
  await harness.setContentFixture(`bzz://${hash}/`, { body });
  const address = window.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(`bzz://${hash}/`);
  await address.press('Enter');
  await expect.poll(() => activeLabel(window), { timeout: 10_000 }).toBe(label);
}

function activeLabel(window) {
  return window.evaluate(async () => {
    const wv = document.querySelector('webview:not(.hidden)');
    try {
      return await wv.executeJavaScript("document.getElementById('label')?.textContent ?? null");
    } catch {
      return null;
    }
  });
}

// Swipe in the active tab: `steps` wheel events of `deltaX` (Electron's sign),
// 16 ms apart, as a trackpad sends them.
async function swipe(electronApp, window, { deltaX, steps }) {
  const id = await window.evaluate(() =>
    document.querySelector('webview:not(.hidden)').getWebContentsId()
  );
  await electronApp.evaluate(
    async ({ webContents }, { id, deltaX, steps }) => {
      const guest = webContents.fromId(id);
      for (let i = 0; i < steps; i += 1) {
        guest.sendInputEvent({
          type: 'mouseWheel',
          x: 200,
          y: 200,
          deltaX,
          deltaY: 0,
          hasPreciseScrollingDeltas: true,
          canScroll: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
    },
    { id, deltaX, steps }
  );
}

test.describe('two-finger swipe between pages (#980)', () => {
  test.skip(process.platform !== 'darwin', 'macOS only');

  test.beforeEach(async ({ electronApp }) => {
    const setting = await electronApp.evaluate(({ systemPreferences }) =>
      systemPreferences.getUserDefault('AppleEnableSwipeNavigateWithScrolls', 'string')
    );
    test.skip(setting === '0', 'Swipe between pages is off on this Mac');
  });

  test('swiping past the left edge goes back while the scroll still runs', async ({
    electronApp,
    window,
    harness,
  }) => {
    await open(window, harness, FIRST_HASH, page('first page'), 'first page');
    await open(window, harness, SECOND_HASH, page('second page'), 'second page');
    await expect(window.locator('#back-btn')).toBeEnabled();

    // The arrow is filled in only for the moment it navigates, so record
    // what it showed.
    await window.evaluate(() => {
      const arrow = document.getElementById('swipe-nav-indicator');
      window.swipeArrowStates = [];
      new MutationObserver(() =>
        window.swipeArrowStates.push({ hidden: arrow.hidden, className: arrow.className })
      ).observe(arrow, { attributes: true, attributeFilter: ['class', 'hidden'] });
    });

    // A scroll that goes on long after it is far enough (8 × 30 px past the
    // edge), as when macOS's momentum carries on after the fingers lift: it
    // goes back without waiting for that scroll to end.
    let swipeEnded = false;
    const swiping = swipe(electronApp, window, { deltaX: 30, steps: 90 }).then(() => {
      swipeEnded = true;
    });
    await expect
      .poll(() => activeLabel(window), { timeout: 10_000, intervals: [50] })
      .toBe('first page');
    expect(swipeEnded).toBe(false);
    await swiping;

    const states = await window.evaluate(() => window.swipeArrowStates);
    expect(states.some((state) => !state.hidden)).toBe(true);
    expect(states.some((state) => state.className.includes('swipe-nav-indicator--ready'))).toBe(
      true
    );
    await expect(window.locator('[data-test="swipe-nav-indicator"]')).toBeHidden();
  });

  test('the rest of that scroll does not go back a second time', async ({
    electronApp,
    window,
    harness,
  }) => {
    await open(window, harness, FIRST_HASH, page('first page'), 'first page');
    await open(window, harness, SECOND_HASH, page('second page'), 'second page');
    await open(window, harness, THIRD_HASH, page('third page'), 'third page');

    // Far past the edge of the page it goes back to as well.
    await swipe(electronApp, window, { deltaX: 30, steps: 90 });
    await window.waitForTimeout(800);
    expect(await activeLabel(window)).toBe('second page');

    // Once that scroll is over, the next swipe is a swipe again.
    await swipe(electronApp, window, { deltaX: 30, steps: 20 });
    await expect.poll(() => activeLabel(window), { timeout: 10_000 }).toBe('first page');
  });

  test('a short swipe stays on the page', async ({ electronApp, window, harness }) => {
    await open(window, harness, FIRST_HASH, page('first page'), 'first page');
    await open(window, harness, SECOND_HASH, page('second page'), 'second page');

    await swipe(electronApp, window, { deltaX: 10, steps: 5 });
    await expect(window.locator('[data-test="swipe-nav-indicator"]')).toBeHidden({
      timeout: 5_000,
    });
    // Past the end of the gesture: nothing navigated.
    await window.waitForTimeout(500);
    expect(await activeLabel(window)).toBe('second page');
  });

  test('a page that can still scroll sideways keeps the swipe', async ({
    electronApp,
    window,
    harness,
  }) => {
    await open(window, harness, FIRST_HASH, page('first page'), 'first page');
    const wide =
      '<div style="width:5000px;height:10px"></div>' +
      '<script>addEventListener("load", () => scrollTo(1000, 0))</script>';
    await open(window, harness, SECOND_HASH, page('second page', wide), 'second page');
    await expect
      .poll(() =>
        window.evaluate(() =>
          document.querySelector('webview:not(.hidden)').executeJavaScript('scrollX')
        )
      )
      .toBe(1000);

    await swipe(electronApp, window, { deltaX: 30, steps: 20 });
    await window.waitForTimeout(500);
    expect(await activeLabel(window)).toBe('second page');
    await expect(window.locator('[data-test="swipe-nav-indicator"]')).toBeHidden();
    // The page scrolled instead.
    const scrollX = await window.evaluate(() =>
      document.querySelector('webview:not(.hidden)').executeJavaScript('scrollX')
    );
    expect(scrollX).toBeLessThan(1000);
  });

  test('nor does it when the page it goes back to is busy loading', async ({
    electronApp,
    window,
    harness,
  }) => {
    // The page's startup holds its main thread, so it hears nothing of the
    // scroll for a while and then gets all of it at once.
    const busy =
      '<script>const until = performance.now() + 900; while (performance.now() < until);</script>';
    await open(window, harness, FIRST_HASH, page('first page'), 'first page');
    await open(window, harness, SECOND_HASH, page('second page', busy), 'second page');
    await open(window, harness, THIRD_HASH, page('third page'), 'third page');

    await swipe(electronApp, window, { deltaX: 30, steps: 90 });
    await window.waitForTimeout(1500);
    expect(await activeLabel(window)).toBe('second page');
  });

  // Swipe over the page and check it stayed and scrolled `expression` down.
  async function expectPageKeepsSwipe(electronApp, window, expression) {
    const before = await guestEval(window, expression);
    await swipe(electronApp, window, { deltaX: 30, steps: 20 });
    await window.waitForTimeout(500);
    expect(await activeLabel(window)).toBe('second page');
    await expect(window.locator('[data-test="swipe-nav-indicator"]')).toBeHidden();
    expect(await guestEval(window, expression)).toBeLessThan(before);
  }

  const guestEval = (window, expression) =>
    window.evaluate(
      (source) => document.querySelector('webview:not(.hidden)').executeJavaScript(source),
      expression
    );

  test('a body that scrolls on its own keeps the swipe', async ({
    electronApp,
    window,
    harness,
  }) => {
    await open(window, harness, FIRST_HASH, page('first page'), 'first page');
    const body =
      '<!doctype html><title>second page</title>' +
      '<style>html{overflow:hidden;height:100%}body{margin:0;height:100%;overflow-x:auto}</style>' +
      '<body><p id="label">second page</p><div style="width:5000px;height:10px"></div>' +
      '<script>addEventListener("load", () => { document.body.scrollLeft = 1000; })</script></body>';
    await open(window, harness, SECOND_HASH, body, 'second page');
    await expect.poll(() => guestEval(window, 'document.body.scrollLeft')).toBe(1000);
    await expectPageKeepsSwipe(electronApp, window, 'document.body.scrollLeft');
  });

  test('a carousel inside a closed shadow root keeps the swipe', async ({
    electronApp,
    window,
    harness,
  }) => {
    await open(window, harness, FIRST_HASH, page('first page'), 'first page');
    const carousel =
      '<x-carousel style="display:block;position:absolute;left:0;top:100px;width:600px;height:200px"></x-carousel>' +
      '<script>customElements.define("x-carousel", class extends HTMLElement {' +
      ' constructor() { super(); const root = this.attachShadow({ mode: "closed" });' +
      ' root.innerHTML = \'<div style="width:600px;height:200px;overflow-x:auto">' +
      '<div style="width:5000px;height:180px"></div></div>\';' +
      ' window.carousel = root.firstElementChild; window.carousel.scrollLeft = 1000; } });</script>';
    await open(window, harness, SECOND_HASH, page('second page', carousel), 'second page');
    await expect.poll(() => guestEval(window, 'window.carousel.scrollLeft')).toBe(1000);
    await expectPageKeepsSwipe(electronApp, window, 'window.carousel.scrollLeft');
  });

  // Layouts whose scroll origin or scroller is easy to get wrong; each starts
  // where the page can still scroll left, so a Back swipe must stay the page's.
  const keeps = [
    [
      'a reversed flex row at its start',
      '<div id="row" style="display:flex;flex-direction:row-reverse;overflow-x:auto;' +
        'position:absolute;left:0;top:100px;width:600px;height:200px">' +
        '<div style="flex:none;width:5000px;height:180px"></div></div>',
      "document.getElementById('row').scrollLeft",
    ],
    [
      'a flex column wrapping in reverse at its start',
      '<div id="cols" style="display:flex;flex-direction:column;flex-wrap:wrap-reverse;' +
        'overflow-x:auto;position:absolute;left:0;top:100px;width:600px;height:200px">' +
        '<div style="flex:none;width:300px;height:180px"></div>'.repeat(20) +
        '</div>',
      "document.getElementById('cols').scrollLeft",
    ],
    [
      'an RTL body under an LTR <html>',
      '<style>body{direction:rtl}</style><div style="width:5000px;height:10px"></div>',
      'document.scrollingElement.scrollLeft',
    ],
    [
      'a body that scrolls itself under <html> clipping only vertically',
      '<style>html{overflow-y:clip;height:100%}body{height:100%;overflow-x:auto}</style>' +
        '<div style="width:5000px;height:10px"></div>' +
        '<script>addEventListener("load", () => { document.body.scrollLeft = 1000; })</script>',
      'document.body.scrollLeft',
    ],
  ];
  for (const [label, extra, expression] of keeps) {
    test(`${label} keeps the swipe`, async ({ electronApp, window, harness }) => {
      await open(window, harness, FIRST_HASH, page('first page'), 'first page');
      await open(window, harness, SECOND_HASH, page('second page', extra), 'second page');
      await expectPageKeepsSwipe(electronApp, window, expression);
    });
  }
});
